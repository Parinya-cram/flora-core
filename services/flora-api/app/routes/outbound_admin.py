"""Outbound interface settings for Canopy admins: destinations, test send and the message log."""
import uuid
from typing import Any, Literal

from fastapi import APIRouter, Depends, HTTPException, Query
from psycopg import Connection
from psycopg.types.json import Jsonb
from pydantic import BaseModel, Field

from .. import directory, phi_mask
from ..database import connection
from ..outbound import messages, transport, worker
from .fleet_control import require_admin

router = APIRouter(prefix="/api/fleet/control/integrations/outbound", tags=["outbound interface"],
                   dependencies=[Depends(require_admin)])

SECRETS = ("password", "bearer_token", "client_key")


class DocumentFeed(BaseModel):
    enabled: bool = False
    timing: Literal["delay", "daily"] = "delay"
    delay_seconds: int = Field(default=60, ge=0, le=7 * 86400)
    daily_at: str = Field(default="00:00", pattern=r"^([01]\d|2[0-3]):[0-5]\d$")
    pdf: bool = True


class VitalsFeed(BaseModel):
    enabled: bool = False
    interval_minutes: int = Field(default=5, ge=1, le=1440)  # one candle per parameter per period; 1 minute at most


class Feeds(BaseModel):
    vitals: VitalsFeed = Field(default_factory=VitalsFeed)
    form: DocumentFeed = Field(default_factory=DocumentFeed)
    discharge: DocumentFeed = Field(default_factory=DocumentFeed)


class DestinationInput(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    enabled: bool = False
    format: Literal["hl7v2", "fhir"] = "hl7v2"
    hl7_version: str = Field(default="2.5.1", max_length=10)
    host: str = Field(default="", max_length=255)
    port: int | None = Field(default=None, ge=1, le=65535)
    url: str = Field(default="", max_length=500)
    auth_type: Literal["none", "basic", "bearer"] = "none"
    username: str = Field(default="", max_length=200)
    password: str | None = Field(default=None, max_length=500)       # None keeps the stored value
    bearer_token: str | None = Field(default=None, max_length=2000)
    verify_tls: bool = True
    tls: bool = False                                                  # MLLP over TLS
    ca_cert: str = Field(default="", max_length=20000)                 # PEM; empty = system CAs
    client_cert: str = Field(default="", max_length=20000)             # PEM, for mutual TLS
    client_key: str | None = Field(default=None, max_length=20000)     # PEM; None keeps the stored key
    identity: Literal["full", "masked"] = "full"
    unit_keys: list[str] = Field(default_factory=lambda: ["*"])
    sending_application: str = Field(default="FLORA", max_length=60)
    sending_facility: str = Field(default="", max_length=60)
    receiving_application: str = Field(default="", max_length=60)
    receiving_facility: str = Field(default="", max_length=60)
    feeds: Feeds = Field(default_factory=Feeds)


class TestInput(BaseModel):
    kind: Literal["vitals", "form", "discharge"] = "form"
    case_id: str | None = None


def public(row: dict[str, Any]) -> dict[str, Any]:
    out = {key: value for key, value in row.items() if key not in SECRETS}
    out["id"] = str(row["id"])
    out["has_password"] = bool(row.get("password"))
    out["has_bearer_token"] = bool(row.get("bearer_token"))
    out["has_client_key"] = bool(row.get("client_key"))
    return out


def _get(database: Connection, destination_id: str) -> dict[str, Any]:
    try:
        uuid.UUID(destination_id)
    except ValueError:
        raise HTTPException(status_code=404, detail="destination not found") from None
    row = database.execute("SELECT * FROM canopy_outbound_destination WHERE id=%s", (destination_id,)).fetchone()
    if row is None:
        raise HTTPException(status_code=404, detail="destination not found")
    return row


def _validate(database: Connection, payload: DestinationInput, current: dict[str, Any] | None = None) -> list[str]:
    keys = [key for key in dict.fromkeys(k.strip() for k in payload.unit_keys) if key] or ["*"]
    if "*" in keys:
        keys = ["*"]
    else:
        known = {ward["key"] for ward in directory.ward_options(database)["rows"]}
        unknown = [key for key in keys if key not in known]
        if unknown:
            raise HTTPException(status_code=400, detail=f"unknown ward {', '.join(unknown)}")
    if payload.format == "hl7v2" and payload.enabled and not (payload.host and payload.port):
        raise HTTPException(status_code=400, detail="an HL7 destination needs a host and port")
    if payload.format == "hl7v2" and payload.tls:
        key = (current or {}).get("client_key", "") if payload.client_key is None else payload.client_key.strip()
        if bool(payload.client_cert.strip()) != bool(key):
            raise HTTPException(status_code=400, detail="mutual TLS needs both the client certificate and its key")
        try:  # reject PEMs that do not load now rather than at the first send
            transport.tls_context({"ca_cert": payload.ca_cert.strip(), "verify_tls": payload.verify_tls,
                                   "client_cert": payload.client_cert.strip(), "client_key": key})
        except transport.SendError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from None
    if payload.format == "fhir" and payload.enabled and not payload.url.startswith(("http://", "https://")):
        raise HTTPException(status_code=400, detail="a FHIR destination needs an http(s) URL")
    return keys


@router.get("")
def overview(database: Connection = Depends(connection)) -> dict[str, Any]:
    counts = {str(row["destination_id"]): row for row in database.execute(
        """SELECT destination_id,
                  count(*) FILTER (WHERE status IN ('pending','error')) AS queued,
                  count(*) FILTER (WHERE status='sent' AND sent_at > (extract(epoch FROM now())*1000)::bigint - 86400000) AS sent_24h,
                  count(*) FILTER (WHERE status='failed' AND created_at > (extract(epoch FROM now())*1000)::bigint - 86400000) AS failed_24h,
                  max(sent_at) AS last_sent_at
           FROM canopy_outbound_message GROUP BY destination_id""").fetchall()}
    rows = []
    for row in worker.destinations(database, enabled_only=False):
        stats = counts.get(str(row["id"]), {})
        rows.append({**public(row), "queued": stats.get("queued", 0), "sent_24h": stats.get("sent_24h", 0),
                     "failed_24h": stats.get("failed_24h", 0), "last_sent_at": stats.get("last_sent_at")})
    return {"rows": rows, "wards": directory.ward_options(database)["rows"]}


@router.post("")
def create(payload: DestinationInput, user: dict = Depends(require_admin),
           database: Connection = Depends(connection)) -> dict[str, Any]:
    keys = _validate(database, payload)
    now = worker.now_ms()
    row = database.execute(
        """INSERT INTO canopy_outbound_destination
             (id, name, enabled, format, hl7_version, host, port, url, auth_type, username, password, bearer_token,
              verify_tls, identity, unit_keys, sending_application, sending_facility, receiving_application,
              receiving_facility, feeds, created_at, updated_at, updated_by, tls, ca_cert, client_cert, client_key)
           VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s) RETURNING *""",
        (uuid.uuid4(), payload.name.strip(), payload.enabled, payload.format, payload.hl7_version, payload.host.strip(),
         payload.port, payload.url.strip(), payload.auth_type, payload.username.strip(), payload.password or "",
         (payload.bearer_token or "").strip(), payload.verify_tls, payload.identity, keys,
         payload.sending_application.strip(), payload.sending_facility.strip(), payload.receiving_application.strip(),
         payload.receiving_facility.strip(), Jsonb(payload.feeds.model_dump()), now, now, user.get("username"),
         payload.tls, payload.ca_cert.strip(), payload.client_cert.strip(), (payload.client_key or "").strip())).fetchone()
    return public(row)


@router.put("/{destination_id}")
def update(destination_id: str, payload: DestinationInput, user: dict = Depends(require_admin),
           database: Connection = Depends(connection)) -> dict[str, Any]:
    current = _get(database, destination_id)
    keys = _validate(database, payload, current)
    row = database.execute(
        """UPDATE canopy_outbound_destination SET name=%s, enabled=%s, format=%s, hl7_version=%s, host=%s, port=%s,
             url=%s, auth_type=%s, username=%s, password=%s, bearer_token=%s, verify_tls=%s, identity=%s, unit_keys=%s,
             sending_application=%s, sending_facility=%s, receiving_application=%s, receiving_facility=%s, feeds=%s,
             tls=%s, ca_cert=%s, client_cert=%s, client_key=%s, updated_at=%s, updated_by=%s WHERE id=%s RETURNING *""",
        (payload.name.strip(), payload.enabled, payload.format, payload.hl7_version, payload.host.strip(), payload.port,
         payload.url.strip(), payload.auth_type, payload.username.strip(),
         current["password"] if payload.password is None else payload.password,
         current["bearer_token"] if payload.bearer_token is None else payload.bearer_token.strip(),
         payload.verify_tls, payload.identity, keys, payload.sending_application.strip(),
         payload.sending_facility.strip(), payload.receiving_application.strip(), payload.receiving_facility.strip(),
         Jsonb(payload.feeds.model_dump()), payload.tls, payload.ca_cert.strip(), payload.client_cert.strip(),
         current["client_key"] if payload.client_key is None else payload.client_key.strip(),
         worker.now_ms(), user.get("username"), destination_id)).fetchone()
    return public(row)


@router.delete("/{destination_id}")
def delete(destination_id: str, database: Connection = Depends(connection)) -> dict[str, Any]:
    _get(database, destination_id)
    database.execute("DELETE FROM canopy_outbound_destination WHERE id=%s", (destination_id,))
    return {"ok": True}


@router.get("/{destination_id}/cases")
def test_cases(destination_id: str, database: Connection = Depends(connection)) -> dict[str, Any]:
    """Recent cases in the destination's wards, to pick one for a test send."""
    destination = _get(database, destination_id)
    rows = database.execute(
        """SELECT c.global_case_id, c.case_code, c.status, c.start_time, u.unit_key, u.unit_name,
                  coalesce(nullif(l.canopy_display_name,''),l.display_name) AS leaf_name
           FROM sync_case_index c JOIN sync_leaf_node l ON l.leaf_id=c.leaf_id
           LEFT JOIN canopy_leaf_unit u ON u.leaf_id=c.leaf_id
           ORDER BY (upper(c.status)='ACTIVE') DESC, c.last_synced_at DESC LIMIT 200""").fetchall()
    cases = [phi_mask.mask({"case_id": str(r["global_case_id"]), "case_code": r["case_code"], "status": r["status"],
                            "start_time": r["start_time"], "ward": r["unit_name"], "bed": r["leaf_name"]})
             for r in rows if worker.serves(destination, r["unit_key"])]
    return {"rows": cases[:50]}


@router.post("/{destination_id}/test")
def test_send(destination_id: str, payload: TestInput, database: Connection = Depends(connection)) -> dict[str, Any]:
    """Send one message now (logged as kind 'test'), whether or not the destination is enabled."""
    destination = _get(database, destination_id)
    case_id = payload.case_id
    if not case_id:
        # The most recent case in its wards (for vitals, the most recent one that has vitals).
        found = database.execute(
            """SELECT c.global_case_id, u.unit_key FROM sync_case_index c
               LEFT JOIN canopy_leaf_unit u ON u.leaf_id=c.leaf_id
               ORDER BY (%s AND jsonb_array_length(coalesce(c.snapshot->'vitals'->'rows','[]'))=0),
                        (upper(c.status)='ACTIVE') DESC, c.last_synced_at DESC LIMIT 200""",
            (payload.kind == "vitals",)).fetchall()
        case_id = next((str(r["global_case_id"]) for r in found if worker.serves(destination, r["unit_key"])), None)
        if case_id is None:
            raise HTTPException(status_code=400, detail="no case in this destination's wards")
    now = worker.now_ms()
    start = end = None
    if payload.kind == "vitals":
        period = max(1, int(worker.feed(destination, "vitals").get("interval_minutes") or 5)) * 60_000
        end = (now - worker.LAG_MS) // 60_000 * 60_000
        # A test uses the case's latest recorded vitals, even when the monitor is not sending now.
        case = worker.load_case(database, case_id)
        minutes = [r["ts_minute"] for r in messages.rows(((case or {}).get("snapshot") or {}).get("vitals"))
                   if isinstance(r.get("ts_minute"), (int, float))]
        if minutes:
            end = min(end, int(max(minutes)) + 60_000)
        start = end - period
    row = database.execute(
        """INSERT INTO canopy_outbound_message
             (destination_id, kind, case_id, period_start, period_end, status, due_at, next_attempt_at, created_at)
           VALUES (%s,'test',%s,%s,%s,'pending',%s,%s,%s) RETURNING *""",
        (destination_id, case_id, start, end, now, now + 10**12, now)).fetchone()  # never picked up by the worker
    # In one transaction, so the worker never sees the row between the send and marking it a test.
    with database.transaction():
        result = worker.send_row(database, {**row, "kind": payload.kind}, destination)
        database.execute("UPDATE canopy_outbound_message SET kind='test', "
                         "status=CASE WHEN status='error' THEN 'failed' ELSE status END WHERE id=%s", (row["id"],))
    return {**result, "message": message(str(row["id"]), database)}


@router.get("/messages")
def messages_log(destination_id: str | None = None, status: str | None = None, kind: str | None = None,
                 limit: int = Query(default=100, ge=1, le=500),
                 database: Connection = Depends(connection)) -> dict[str, Any]:
    where, params = ["true"], []
    for column, value in (("destination_id", destination_id), ("status", status), ("kind", kind)):
        if value:
            where.append(f"m.{column}=%s")
            params.append(value)
    rows = database.execute(
        f"""SELECT m.id, m.destination_id, d.name AS destination_name, m.kind, m.case_id, m.period_start, m.period_end,
                   m.status, m.due_at, m.attempts, m.next_attempt_at, m.control_id, m.message_type, m.error,
                   m.created_at, m.sent_at, c.case_code, c.hn
            FROM canopy_outbound_message m
            JOIN canopy_outbound_destination d ON d.id=m.destination_id
            LEFT JOIN sync_case_index c ON c.global_case_id=m.case_id
            WHERE {' AND '.join(where)} ORDER BY m.id DESC LIMIT %s""", (*params, limit)).fetchall()
    return {"rows": [phi_mask.mask({**row, "id": str(row["id"]), "destination_id": str(row["destination_id"]),
                                    "case_id": str(row["case_id"]) if row["case_id"] else None}) for row in rows]}


@router.get("/messages/{message_id}")
def message(message_id: str, database: Connection = Depends(connection)) -> dict[str, Any]:
    if not message_id.isdigit():
        raise HTTPException(status_code=404, detail="message not found")
    row = database.execute(
        """SELECT m.*, d.name AS destination_name, d.identity FROM canopy_outbound_message m
           JOIN canopy_outbound_destination d ON d.id=m.destination_id WHERE m.id=%s""", (int(message_id),)).fetchone()
    if row is None:
        raise HTTPException(status_code=404, detail="message not found")
    return {**row, "id": str(row["id"]), "destination_id": str(row["destination_id"]),
            "case_id": str(row["case_id"]) if row["case_id"] else None}


@router.post("/messages/{message_id}/resend")
def resend(message_id: str, database: Connection = Depends(connection)) -> dict[str, Any]:
    row = message(message_id, database)
    if row["kind"] == "test":
        raise HTTPException(status_code=400, detail="send a new test instead")
    now = worker.now_ms()
    if row["status"] in ("pending", "error", "failed"):
        database.execute("UPDATE canopy_outbound_message SET status='pending', attempts=0, next_attempt_at=%s, error=NULL "
                         "WHERE id=%s", (now, int(message_id)))
    else:
        database.execute(
            """INSERT INTO canopy_outbound_message
                 (destination_id, kind, case_id, period_start, period_end, due_at, next_attempt_at, created_at)
               VALUES (%s,%s,%s,%s,%s,%s,%s,%s)
               ON CONFLICT (destination_id, kind, case_id) WHERE status IN ('pending','error') AND kind IN ('form','discharge')
               DO UPDATE SET next_attempt_at=EXCLUDED.next_attempt_at, due_at=EXCLUDED.due_at""",
            (row["destination_id"], row["kind"], row["case_id"], row["period_start"], row["period_end"], now, now, now))
    return {"ok": True}


@router.post("/messages/{message_id}/cancel")
def cancel(message_id: str, database: Connection = Depends(connection)) -> dict[str, Any]:
    message(message_id, database)
    database.execute("UPDATE canopy_outbound_message SET status='cancelled' WHERE id=%s AND status IN ('pending','error')",
                     (int(message_id),))
    return {"ok": True}
