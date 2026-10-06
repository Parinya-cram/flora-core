"""HL7 v2 admissions from an interface engine (Scope-Life HL7 gateway).

The gateway acknowledges the HIS over MLLP and then POSTs every message to its
"EMR webhook" as JSON segments (or raw HL7). Canopy turns scheduling and order
messages into admissions that the ward's Leafs list under "Prepared patients":

  SIU^S12, ORM^O01 (NW) .......... create (configurable: create_on) or update
  ADT^A01 ........................ create only when listed in create_on
  SIU^S13 / S14 .................. update time, room (AIL-3) -> ward / bed
  SIU^S15 / S16 / S26, ORM CA/DC . cancel while still pending
  ADT^A08 / A31 .................. refresh demographics of pending admissions

Field positions follow the gateway's API reference: in the JSON form `fields`
excludes the segment name, so fields[n] is HL7 field n+1, except MSH where
fields[n] is MSH-(n+2).
"""
import secrets
import time
import urllib.error
import urllib.parse
import urllib.request
import base64
import json
import ssl
import uuid
from typing import Any

from psycopg import Connection
from psycopg.types.json import Jsonb

ADMISSION_SOURCE = "hl7"
DEFAULT_CREATE_ON = ["SIU^S12", "ORM^O01"]
CANCEL_SIU = {"S15", "S16", "S26"}


def now_ms() -> int:
    return int(time.time() * 1000)


# --- message model -----------------------------------------------------------

class Message:
    def __init__(self, segments: list[tuple[str, list[str]]]):
        self.segments = segments

    @classmethod
    def from_payload(cls, payload: dict[str, Any]) -> "Message":
        if isinstance(payload.get("segments"), list):
            segments = []
            for item in payload["segments"]:
                if isinstance(item, dict) and item.get("segment"):
                    segments.append((str(item["segment"]), [str(value or "") for value in item.get("fields") or []]))
            return cls(segments)
        raw = payload.get("raw") or payload.get("message") or ""
        if isinstance(raw, str) and raw.startswith("MSH"):
            segments = []
            for line in raw.replace("\r\n", "\r").replace("\n", "\r").split("\r"):
                if not line.strip():
                    continue
                name, _, rest = line.partition("|")
                if name == "MSH":
                    # MSH-1 is the separator itself; keep the same layout as the JSON form.
                    segments.append((name, rest.split("|")))
                else:
                    segments.append((name, rest.split("|")))
            return cls(segments)
        raise ValueError("payload has neither segments nor raw HL7")

    def segment(self, name: str) -> list[str] | None:
        return next((fields for segment, fields in self.segments if segment == name), None)

    def field(self, name: str, number: int) -> str:
        fields = self.segment(name)
        if fields is None:
            return ""
        index = number - 2 if name == "MSH" else number - 1
        return fields[index] if 0 <= index < len(fields) else ""

    def component(self, name: str, number: int, part: int = 1) -> str:
        parts = self.field(name, number).split("~")[0].split("^")
        return parts[part - 1].strip() if 0 < part <= len(parts) else ""

    @property
    def message_type(self) -> str:
        parts = self.field("MSH", 9).split("^")
        return "^".join(part for part in parts[:2] if part)

    @property
    def trigger(self) -> str:
        parts = self.field("MSH", 9).split("^")
        return parts[1] if len(parts) > 1 else self.field("EVN", 1)

    @property
    def control_id(self) -> str:
        return self.field("MSH", 10)


def hl7_date(value: str) -> str | None:
    digits = "".join(ch for ch in (value or "") if ch.isdigit())
    return f"{digits[:4]}-{digits[4:6]}-{digits[6:8]}" if len(digits) >= 8 else None


def hl7_time_ms(value: str) -> int | None:
    digits = "".join(ch for ch in (value or "") if ch.isdigit())
    if len(digits) < 8:
        return None
    from datetime import datetime
    from zoneinfo import ZoneInfo
    try:
        moment = datetime.strptime((digits + "000000")[:14], "%Y%m%d%H%M%S").replace(tzinfo=ZoneInfo("Asia/Bangkok"))
    except ValueError:
        return None
    return int(moment.timestamp() * 1000)


def patient_from(message: Message) -> dict[str, Any]:
    family, given = message.component("PID", 5, 1), message.component("PID", 5, 2)
    name = " ".join(part for part in (given, family) if part) or family or given
    sex = message.component("PID", 8).upper()
    return {
        "patient_name": name or None,
        "sex": {"M": "M", "F": "F"}.get(sex, sex or None),
        "dob": hl7_date(message.component("PID", 7)),
        "age_text": None, "weight_kg": None, "height_cm": None,
    }


def location_codes(message: Message) -> list[str]:
    """Candidate location codes, most specific first: AIL-3, then PV1-3 point of care."""
    codes = []
    for name, number in (("AIL", 3), ("PV1", 3)):
        code = message.component(name, number, 1)
        if code:
            codes.append(code.upper())
    return list(dict.fromkeys(codes))


def visit_number(message: Message) -> str | None:
    # Spec position PV1-19; some senders put it in PV1-17 (gateway known limitation K-3).
    return message.component("PV1", 19) or None


# --- settings ------------------------------------------------------------------

def settings(database: Connection) -> dict[str, Any]:
    row = database.execute("SELECT * FROM canopy_hl7_interface WHERE id=1").fetchone()
    if row is None:
        database.execute(
            "INSERT INTO canopy_hl7_interface(id,webhook_token,updated_at) VALUES (1,%s,%s) ON CONFLICT DO NOTHING",
            (secrets.token_urlsafe(32), now_ms()),
        )
        row = database.execute("SELECT * FROM canopy_hl7_interface WHERE id=1").fetchone()
    return dict(row)


def public_settings(row: dict[str, Any], base_url: str = "") -> dict[str, Any]:
    return {
        "enabled": row["enabled"], "gatewayUrl": row["gateway_url"], "basicUsername": row["basic_username"],
        "hasBasicPassword": bool(row["basic_password"]), "hasBearerToken": bool(row["bearer_token"]),
        "verifyTls": row["verify_tls"], "defaultUnitKey": row["default_unit_key"],
        "createOn": list(row["create_on"] or []),
        "webhookPath": f"/api/integrations/hl7/webhook/{row['webhook_token']}",
        "webhookUrl": f"{base_url.rstrip('/')}/api/integrations/hl7/webhook/{row['webhook_token']}" if base_url else None,
        "updatedAt": row["updated_at"], "updatedBy": row["updated_by"],
    }


def resolve_location(database: Connection, message: Message, config: dict[str, Any]) -> tuple[str | None, str | None, str | None]:
    """(unit_key, target_leaf_id, matched_code) for the message's location."""
    for code in location_codes(message):
        row = database.execute("SELECT * FROM canopy_hl7_location_map WHERE code=%s", (code,)).fetchone()
        if row:
            return row["unit_key"], row["target_leaf_id"], code
    if config.get("default_unit_key"):
        return config["default_unit_key"], None, None
    return None, None, None


# --- applying messages ------------------------------------------------------------

def _find(database: Connection, *, external_ref: str | None, mrn: str) -> dict[str, Any] | None:
    if external_ref:
        row = database.execute(
            "SELECT * FROM canopy_admission WHERE source=%s AND external_ref=%s FOR UPDATE",
            (ADMISSION_SOURCE, external_ref),
        ).fetchone()
        if row:
            return row
    # Same patient booked and ordered separately: join the open admission of the day.
    return database.execute(
        """SELECT * FROM canopy_admission
           WHERE source=%s AND hn=%s AND status='pending'
             AND coalesce(scheduled_at, created_at) > %s
           ORDER BY created_at DESC LIMIT 1 FOR UPDATE""",
        (ADMISSION_SOURCE, mrn, now_ms() - 36 * 3600 * 1000),
    ).fetchone()


def _upsert(database: Connection, existing: dict[str, Any] | None, *, create: bool, unit_key: str | None,
            target_leaf_id: str | None, mrn: str, fields: dict[str, Any]) -> tuple[str | None, str]:
    current = now_ms()
    if existing is None:
        if not create:
            return None, "ignored: no open admission for this patient"
        if not unit_key:
            raise LookupError("unrouted")
        admission_id = uuid.uuid4()
        database.execute(
            """INSERT INTO canopy_admission(id,unit_key,target_leaf_id,hn,admission_number,patient,admission,
                     scheduled_at,note,created_by,created_at,updated_at,source,external_ref,accession_number,appointment_id)
               VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,'hl7-interface',%s,%s,%s,%s,%s,%s)""",
            (admission_id, unit_key, target_leaf_id, mrn, fields.get("admission_number"),
             Jsonb(fields.get("patient") or {}), Jsonb(fields.get("admission") or {}), fields.get("scheduled_at"),
             fields.get("note"), current, current, ADMISSION_SOURCE, fields.get("external_ref"),
             fields.get("accession_number"), fields.get("appointment_id")),
        )
        return str(admission_id), "created"
    if existing["status"] != "pending":
        return str(existing["id"]), f"ignored: admission already {existing['status']}"
    patient = {**(existing["patient"] or {}), **{k: v for k, v in (fields.get("patient") or {}).items() if v}}
    details = {**(existing["admission"] or {}), **{k: v for k, v in (fields.get("admission") or {}).items() if v}}
    database.execute(
        """UPDATE canopy_admission SET patient=%s, admission=%s,
             unit_key=coalesce(%s,unit_key), target_leaf_id=CASE WHEN %s::text IS NULL THEN target_leaf_id ELSE %s END,
             scheduled_at=coalesce(%s,scheduled_at), admission_number=coalesce(%s,admission_number),
             accession_number=coalesce(%s,accession_number), appointment_id=coalesce(%s,appointment_id),
             external_ref=coalesce(external_ref,%s), updated_at=%s
           WHERE id=%s""",
        (Jsonb(patient), Jsonb(details), unit_key, target_leaf_id, target_leaf_id, fields.get("scheduled_at"),
         fields.get("admission_number"), fields.get("accession_number"), fields.get("appointment_id"),
         fields.get("external_ref"), current, existing["id"]),
    )
    return str(existing["id"]), "updated"


def apply(database: Connection, message: Message, config: dict[str, Any]) -> dict[str, Any]:
    """Apply one message. Returns {status, action, admission_id, mrn, location_code}."""
    kind, trigger = message.message_type.split("^")[0], message.trigger
    mrn = message.component("PID", 3, 1)
    create_on = set(config.get("create_on") or DEFAULT_CREATE_ON)
    result: dict[str, Any] = {"mrn": mrn or None, "location_code": (location_codes(message) or [None])[0]}
    if not mrn:
        return {**result, "status": "ignored", "action": "no PID-3 MRN"}

    if kind == "ADT" and trigger in {"A08", "A31"}:
        rows = database.execute(
            "SELECT id, patient FROM canopy_admission WHERE hn=%s AND status='pending' FOR UPDATE", (mrn,)
        ).fetchall()
        patient = {k: v for k, v in patient_from(message).items() if v}
        for row in rows:
            database.execute("UPDATE canopy_admission SET patient=%s,updated_at=%s WHERE id=%s",
                             (Jsonb({**(row["patient"] or {}), **patient}), now_ms(), row["id"]))
        return {**result, "status": "applied" if rows else "ignored",
                "action": f"demographics updated on {len(rows)} admission(s)"}

    unit_key, target_leaf_id, _ = resolve_location(database, message, config)
    fields: dict[str, Any] = {"patient": patient_from(message), "admission_number": visit_number(message)}

    if kind == "SIU":
        appointment = message.component("SCH", 1) or message.component("SCH", 2)
        # Filler status: SCH-25, else the resource status (AIL-12 / AIG-14), which senders also fill.
        status = (message.field("SCH", 25) or message.field("AIL", 12) or message.field("AIG", 14)).strip()
        fields.update({
            "external_ref": f"appt:{appointment}" if appointment else None, "appointment_id": appointment or None,
            "scheduled_at": hl7_time_ms(message.component("SCH", 11, 4)),
            "admission": {"operation": message.component("SCH", 8, 2) or message.component("SCH", 8, 1) or None,
                          "diagnosis": message.component("SCH", 7, 2) or None,
                          "surgeon": message.component("AIP", 3, 2) or None},
            "note": f"HL7 appointment {appointment} · {status}".strip(" ·"),
        })
        existing = _find(database, external_ref=fields["external_ref"], mrn=mrn)
        if trigger in CANCEL_SIU or status.lower() in {"cancelled", "dis-continued", "noshow", "deleted"}:
            return {**result, **_cancel(database, existing, f"SIU^{trigger} {status}")}
        create = f"SIU^{trigger}" in create_on
        return {**result, **_apply_upsert(database, existing, create, unit_key, target_leaf_id, mrn, fields,
                                          moved=trigger == "S14")}

    if kind == "ORM":
        control = message.field("ORC", 1).strip().upper()
        accession = message.field("OBR", 3) or message.field("ORC", 3)
        fields.update({
            "external_ref": f"acc:{accession}" if accession else None, "accession_number": accession or None,
            "scheduled_at": hl7_time_ms(message.field("OBR", 7)) or hl7_time_ms(message.field("ORC", 9)),
            "admission": {"operation": message.component("OBR", 4, 2) or message.component("OBR", 4, 1) or None},
        })
        existing = _find(database, external_ref=fields["external_ref"], mrn=mrn)
        if control in {"CA", "DC"}:
            return {**result, **_cancel(database, existing, f"ORM {control}")}
        return {**result, **_apply_upsert(database, existing, "ORM^O01" in create_on, unit_key, target_leaf_id, mrn, fields)}

    if kind == "ADT" and trigger == "A01":
        visit = visit_number(message)
        fields.update({"external_ref": f"visit:{visit}" if visit else None,
                       "scheduled_at": hl7_time_ms(message.field("PV1", 44)) or hl7_time_ms(message.field("EVN", 2))})
        existing = _find(database, external_ref=fields["external_ref"], mrn=mrn)
        return {**result, **_apply_upsert(database, existing, "ADT^A01" in create_on, unit_key, target_leaf_id, mrn, fields)}

    return {**result, "status": "ignored", "action": f"{message.message_type} is not used for admissions"}


def _apply_upsert(database, existing, create, unit_key, target_leaf_id, mrn, fields, moved=False) -> dict[str, Any]:
    try:
        admission_id, action = _upsert(database, existing, create=create, unit_key=unit_key,
                                       target_leaf_id=target_leaf_id if (moved or existing is None) else None,
                                       mrn=mrn, fields=fields)
    except LookupError:
        return {"status": "unrouted", "action": "location not mapped to a ward and no default ward set"}
    status = "ignored" if action.startswith("ignored") else "applied"
    return {"status": status, "action": action, "admission_id": admission_id}


def _cancel(database, existing, reason: str) -> dict[str, Any]:
    if existing is None:
        return {"status": "ignored", "action": f"{reason}: no open admission"}
    if existing["status"] != "pending":
        return {"status": "ignored", "action": f"{reason}: admission already {existing['status']}",
                "admission_id": str(existing["id"])}
    database.execute("UPDATE canopy_admission SET status='cancelled',note=coalesce(note,'') || %s,updated_at=%s WHERE id=%s",
                     (f" · cancelled by HL7 ({reason})", now_ms(), existing["id"]))
    return {"status": "applied", "action": f"cancelled ({reason})", "admission_id": str(existing["id"])}


def record(database: Connection, payload: dict[str, Any], message: Message | None, outcome: dict[str, Any],
           message_id: int | None = None) -> int:
    values = (message.message_type if message else payload.get("message_type"),
              message.control_id if message else payload.get("control_id"),
              outcome.get("mrn"), outcome.get("location_code"), outcome["status"], outcome.get("action"),
              outcome.get("admission_id"), outcome.get("error"))
    if message_id:
        database.execute(
            """UPDATE canopy_hl7_message SET message_type=%s,control_id=%s,mrn=%s,location_code=%s,status=%s,
                 action=%s,admission_id=%s,error=%s WHERE id=%s""", (*values, message_id))
        return message_id
    return database.execute(
        """INSERT INTO canopy_hl7_message(received_at,message_type,control_id,mrn,location_code,status,action,
                 admission_id,error,payload) VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s) RETURNING id""",
        (now_ms(), *values, Jsonb(payload)),
    ).fetchone()["id"]


def process(database: Connection, payload: dict[str, Any], config: dict[str, Any], message_id: int | None = None) -> dict[str, Any]:
    try:
        message = Message.from_payload(payload)
    except ValueError as error:
        outcome = {"status": "error", "error": str(error)}
        return {**outcome, "id": record(database, payload, None, outcome, message_id)}
    try:
        with database.transaction():
            outcome = apply(database, message, config)
    except Exception as error:  # keep the message for reprocessing
        outcome = {"status": "error", "error": f"{type(error).__name__}: {error}"}
    return {**outcome, "id": record(database, payload, message, outcome, message_id)}


# --- calling the gateway ---------------------------------------------------------------

def _context(config: dict[str, Any]) -> ssl.SSLContext | None:
    if config["gateway_url"].lower().startswith("https") and not config.get("verify_tls", True):
        context = ssl.create_default_context()
        context.check_hostname = False
        context.verify_mode = ssl.CERT_NONE
        return context
    return None


def gateway_get(config: dict[str, Any], path: str, *, basic: bool = False, timeout: float = 6) -> tuple[int, Any]:
    if not config.get("gateway_url"):
        raise ValueError("HL7 gateway URL is not configured")
    headers = {"Accept": "application/json"}
    if basic and config.get("basic_username"):
        token = base64.b64encode(f"{config['basic_username']}:{config['basic_password']}".encode()).decode()
        headers["Authorization"] = f"Basic {token}"
    request = urllib.request.Request(f"{config['gateway_url'].rstrip('/')}{path}", headers=headers)
    try:
        with urllib.request.urlopen(request, timeout=timeout, context=_context(config)) as response:
            return response.status, json.load(response)
    except urllib.error.HTTPError as error:
        try:
            body = json.load(error)
        except (ValueError, OSError):
            body = None
        return error.code, body


def lookup_patient(config: dict[str, Any], mrn: str) -> dict[str, Any] | None:
    """GET /api/patients/:mrn (HTTP Basic) → patient fields for the admit form."""
    status, body = gateway_get(config, f"/api/patients/{urllib.parse.quote(mrn.strip(), safe='')}", basic=True)
    if status in {401, 403}:
        raise PermissionError("the HL7 gateway rejected the Basic credentials")
    if status == 404 or (status == 200 and isinstance(body, dict) and not body.get("found")):
        return None
    if status != 200 or not isinstance(body, dict):
        raise RuntimeError(f"HL7 gateway returned {status}")
    patient = body.get("patient") or {}
    given, family = str(patient.get("first_name") or "").strip(), str(patient.get("last_name") or "").strip()
    return {
        "hn": str(patient.get("mrn") or mrn), "patient_name": " ".join(p for p in (given, family) if p) or None,
        "sex": patient.get("sex") or None, "dob": hl7_date(str(patient.get("dob") or "")),
        "pv1": body.get("pv1"),
    }
