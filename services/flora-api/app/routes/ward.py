"""Leaf Ward page: what this workstation knows about its ward, local data first.

Everything here is served from the Leaf's own database, so the page works with no
network. The sync worker refreshes it from Canopy (`PUT /state`) and reports how each
sync step went (`PUT /sync-status`); "Sync now" only raises a flag the worker polls.
"""
import json
import logging
import os
import time
import urllib.error
import urllib.parse
import urllib.request
from typing import Any

from fastapi import APIRouter, Body, Depends, HTTPException
from fastapi.responses import JSONResponse
from psycopg import Connection
from psycopg.types.json import Jsonb

from .. import case_bindings, case_handover, stream_links
from ..account_config_sync import CANOPY_SYNC_URL, SYNC_SECRET
from ..database import connection
from .auth_leaf import now_ms, require_permission, service_only
from .canopy_inbox import inbox_public

router = APIRouter(prefix="/api/ward", tags=["ward"])
LEAF_ID = os.getenv("FLORA_LEAF_ID", "").strip()
log = logging.getLogger("flora.ward")
AUTO_SYNC_SECONDS = int(os.getenv("FLORA_SYNC_INTERVAL_SECONDS", "10"))
HABER_URL = os.getenv("FLORA_HABER_URL", "").rstrip("/")


def haber_adopted() -> list[str] | None:
    """Device-type codes this hospital downloaded (from the appliance); None if unavailable (show all)."""
    if not HABER_URL:
        return None
    import base64
    auth = "Basic " + base64.b64encode(
        f"{os.getenv('HABER_ADMIN_USERNAME', 'admin')}:{os.getenv('HABER_ADMIN_PASSWORD', 'admin')}".encode()).decode()
    try:
        request = urllib.request.Request(f"{HABER_URL}/api/haber/v1/adopted", headers={"authorization": auth})
        with urllib.request.urlopen(request, timeout=3) as response:
            return json.load(response).get("codes") or []
    except Exception:
        return None


def ward_state(database: Connection) -> dict[str, Any]:
    row = database.execute("SELECT payload, synced_at FROM leaf_ward_state WHERE id=1").fetchone()
    return {"payload": (row or {}).get("payload") or {}, "synced_at": (row or {}).get("synced_at")}


@router.get("/overview")
def overview(_: dict = Depends(require_permission("case.read")), database: Connection = Depends(connection)) -> dict:
    state = ward_state(database)
    payload = state["payload"]
    workstation = database.execute("SELECT * FROM workstation_context WHERE id=1").fetchone() or {}
    directory = database.execute("SELECT leaf_unit_key, leaf_unit_name FROM auth_directory_state WHERE id=1").fetchone() or {}
    cases = database.execute(
        """SELECT id, case_code, hn, admission_number, patient_display_name, status, start_time, discharge_time,
                  admission_source, handover_from_leaf_id, handover_to_leaf_id, bed_label
           FROM cases
           WHERE status <> 'archived' OR coalesce(archive_time, discharge_time, start_time) > %s
           ORDER BY (status = 'active') DESC, start_time DESC LIMIT 30""",
        (now_ms() - 48 * 3600 * 1000,),
    ).fetchall()
    admissions = database.execute(
        "SELECT * FROM canopy_admission_inbox WHERE status='pending' ORDER BY (header->>'scheduled_at')::bigint NULLS LAST, received_at"
    ).fetchall()
    status_rows = database.execute("SELECT * FROM leaf_sync_status ORDER BY component").fetchall()
    control = database.execute("SELECT requested_at FROM leaf_sync_control WHERE id=1").fetchone() or {}
    source = database.execute("SELECT * FROM leaf_device_source WHERE id=1").fetchone()
    last_ok = max((row["last_ok_at"] or 0 for row in status_rows), default=0) or None
    return {
        "leaf": {"id": LEAF_ID, "name": workstation.get("bed_name") or LEAF_ID},
        "ward": {
            "key": directory.get("leaf_unit_key") or (payload.get("unit") or {}).get("key"),
            "name": directory.get("leaf_unit_name") or (payload.get("unit") or {}).get("name")
                    or workstation.get("care_unit_name"),
        },
        "workstation": {key: workstation.get(key) for key in
                        ("hospital_name", "building_name", "care_unit_name", "room_name", "bed_name")},
        "cases": [{**row, "case_id": row.pop("id")} for row in cases],
        "admissions": [inbox_public(row) for row in admissions],
        "peers": [leaf for leaf in payload.get("leaves") or [] if leaf.get("leaf_id") != LEAF_ID],
        "gateways": payload.get("gateways") or [],
        # Beds this Leaf looks after, from Canopy (Topology → Physical); empty for a single-bed Leaf.
        "beds": payload.get("my_beds") or [],
        "handovers": payload.get("handovers") or [],
        # Transfer: cases offered to this Leaf (Receive) and cases of this Leaf waiting at another bed.
        "transfers_in": payload.get("transfers_in") or [],
        "transfers_out": payload.get("transfers_out") or [],
        "device_source": source,
        "adopted": haber_adopted(),   # device-type codes downloaded for this hospital (null = unavailable, show all)
        "gateway_links": [case_bindings.link_public(row) for row in
                          database.execute("SELECT * FROM leaf_gateway_link ORDER BY is_default DESC, id").fetchall()],
        "sync": {
            "auto_interval_sec": AUTO_SYNC_SECONDS,
            "requested_at": control.get("requested_at"),
            "ward_synced_at": state["synced_at"],
            "last_ok_at": last_ok,
            "components": status_rows,
        },
    }


@router.post("/sync")
def request_sync(_: dict = Depends(require_permission("case.read")), database: Connection = Depends(connection)) -> dict:
    current = now_ms()
    database.execute(
        """INSERT INTO leaf_sync_control (id, requested_at) VALUES (1, %s)
           ON CONFLICT (id) DO UPDATE SET requested_at = excluded.requested_at""",
        (current,),
    )
    database.commit()
    return {"requested_at": current}


# ---------------------------------------------------------------- sync worker only

@router.get("/sync-control")
def sync_control(_: dict = Depends(service_only), database: Connection = Depends(connection)) -> dict:
    row = database.execute("SELECT requested_at FROM leaf_sync_control WHERE id=1").fetchone() or {}
    return {"requested_at": row.get("requested_at") or 0}


@router.put("/sync-status")
def sync_status(payload: dict[str, Any], _: dict = Depends(service_only), database: Connection = Depends(connection)) -> dict:
    current = now_ms()
    for component, result in (payload.get("components") or {}).items():
        ok = bool(result.get("ok"))
        database.execute(
            """INSERT INTO leaf_sync_status (component, last_attempt_at, last_ok_at, last_error, detail)
               VALUES (%s, %s, %s, %s, %s)
               ON CONFLICT (component) DO UPDATE SET last_attempt_at=excluded.last_attempt_at,
                 last_ok_at=coalesce(excluded.last_ok_at, leaf_sync_status.last_ok_at),
                 last_error=excluded.last_error, detail=excluded.detail""",
            (component, current, current if ok else None, None if ok else str(result.get("error") or "")[:500],
             Jsonb(result.get("detail") or {})),
        )
    database.commit()
    return {"ok": True}


@router.put("/state")
def put_state(payload: dict[str, Any], _: dict = Depends(service_only), database: Connection = Depends(connection)) -> dict:
    current = now_ms()
    released = []
    with database.transaction():
        database.execute(
            """INSERT INTO leaf_ward_state (id, payload, synced_at) VALUES (1, %s, %s)
               ON CONFLICT (id) DO UPDATE SET payload=excluded.payload, synced_at=excluded.synced_at""",
            (Jsonb(payload), current),
        )
        # Cases another Leaf took over: lock them read-only here.
        for item in payload.get("released") or []:
            row = database.execute(
                """UPDATE cases SET status='archived', archive_time=coalesce(archive_time, %s),
                     handover_to_leaf_id=%s, handover_at=coalesce(handover_at, %s), updated_at=%s
                   WHERE id=%s AND status <> 'archived' RETURNING id""",
                (current, item.get("to_leaf_id"), current, current, int(item["source_case_id"])),
            ).fetchone()
            released.append(int(item["source_case_id"]))
            if row:
                case_bindings.release(database, row["id"], "archived", current)
                if item.get("kind") == "transfer":
                    # The booking went on with the case; this locked copy no longer reports it.
                    database.execute("UPDATE cases SET canopy_admission_id=NULL WHERE id=%s", (row["id"],))
                database.execute(
                    """INSERT INTO case_clinical_audit (case_id, action, before_json, after_json, actor_username, actor_role, created_at)
                       VALUES (%s, 'handover.released', NULL, %s, 'canopy-sync', 'integration', %s)""",
                    (row["id"], json.dumps(item), current),
                )
        # A transfer the ward desk offered: the patient leaves this bed, so its devices are free for the next one.
        for item in payload.get("transfers_out") or []:
            if item.get("initiated_from") != "canopy" or transfer_noted(database, item):
                continue
            case = database.execute("SELECT id FROM cases WHERE id=%s AND status='active'", (int(item["source_case_id"]),)).fetchone()
            if case:
                case_bindings.release(database, case["id"], "transferred", current)
                audit(database, case["id"], "transfer.offered", item, "canopy-sync", current)
        # Bed moves on this Leaf asked by the ward desk.
        moved = []
        for item in payload.get("bed_moves") or []:
            case = database.execute("SELECT id, bed_label FROM cases WHERE id=%s AND status='active' FOR UPDATE",
                                    (int(item["source_case_id"]),)).fetchone()
            label = str(item.get("to_bed_label") or "").strip()
            if case is None or not label or bed_taken(database, label, case["id"]):
                continue
            if (case["bed_label"] or "") != label:
                move_bed(database, case, label, f"canopy:{item.get('requested_by') or 'ward desk'}", current)
            moved.append(item["handover_id"])
    for handover_id in moved:
        try:
            canopy("POST", f"/api/sync/v1/handover/{handover_id}/bed-moved", {"leaf_id": LEAF_ID}, timeout=5)
        except HTTPException:
            pass  # applied here; Canopy hears it again on the next pass
    # Gateway links for the live stream: created / completed from the ward exchange (stream_links.py).
    try:
        with database.transaction():
            links = stream_links.ensure(database, payload, current)
        if links:
            log.info("gateway links: %s", ", ".join(links))
    except Exception as error:  # noqa: BLE001 - never fails the ward exchange
        log.warning("gateway links not updated: %s", error)
    return {"ok": True, "released": released}


def audit(database: Connection, case_id: int, action: str, after: Any, actor: str, current: int, before: Any = None) -> None:
    database.execute(
        """INSERT INTO case_clinical_audit (case_id, action, before_json, after_json, actor_username, actor_role, created_at)
           VALUES (%s, %s, %s, %s, %s, 'integration', %s)""",
        (case_id, action, None if before is None else json.dumps(before), json.dumps(after), actor, current))


def transfer_noted(database: Connection, item: dict[str, Any]) -> bool:
    return database.execute(
        "SELECT 1 FROM case_clinical_audit WHERE case_id=%s AND action='transfer.offered' AND after_json::jsonb->>'handover_id' = %s",
        (int(item["source_case_id"]), str(item["handover_id"]))).fetchone() is not None


def bed_taken(database: Connection, label: str, case_id: int | None = None) -> bool:
    """Another active case already lies on this bed of this Leaf."""
    return database.execute(
        """SELECT 1 FROM cases WHERE status='active' AND id IS DISTINCT FROM %s::bigint
             AND lower(trim(coalesce(bed_label,''))) = lower(trim(%s))""", (case_id, label)).fetchone() is not None


def move_bed(database: Connection, case: dict[str, Any], label: str, actor: str, current: int) -> None:
    database.execute("UPDATE cases SET bed_label=%s, updated_at=%s WHERE id=%s", (label, current, case["id"]))
    audit(database, case["id"], "case.bed_move", {"bed_label": label}, actor, current, before={"bed_label": case["bed_label"]})


@router.get("/cases/{case_id}/export")
def export_case(case_id: int, _: dict = Depends(service_only), database: Connection = Depends(connection)) -> dict:
    export = case_handover.export_case(database, case_id)
    if export is None:
        raise HTTPException(404, "case not found")
    return export


# ---------------------------------------------------------------- Canopy calls (Leaf -> Canopy only)

def canopy(method: str, path: str, body: dict[str, Any] | None = None, timeout: float = 15) -> dict[str, Any]:
    if not CANOPY_SYNC_URL or not SYNC_SECRET:
        raise HTTPException(503, "this Leaf is not connected to a Canopy")
    request = urllib.request.Request(
        f"{CANOPY_SYNC_URL}{path}", method=method,
        data=json.dumps(body).encode() if body is not None else None,
        headers={"Authorization": f"Bearer {SYNC_SECRET}", "Content-Type": "application/json", "Accept": "application/json"},
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return json.load(response)
    except urllib.error.HTTPError as error:
        detail = error.read().decode(errors="replace")
        try:
            detail = json.loads(detail).get("detail", detail)
        except ValueError:
            pass
        raise HTTPException(error.code if error.code in {400, 403, 404, 409} else 502, f"Canopy: {detail}") from None
    except (OSError, ValueError) as error:
        raise HTTPException(503, f"Canopy unreachable: {error}") from None


# ---------------------------------------------------------------- handover (take over a case from another Leaf)

@router.post("/handover")
def take_over(payload: dict[str, Any] = Body(...), actor: dict = Depends(require_permission("case.create")),
              database: Connection = Depends(connection)) -> dict:
    """Continue another Leaf's case here. Needs Canopy: it moves ownership and holds the full copy."""
    global_case_id = str(payload.get("global_case_id") or "").strip()
    if not global_case_id:
        raise HTTPException(400, "global_case_id required")
    # Receive of a Transfer: the bed here and the devices of that bed, checked before Canopy is asked.
    handover_id = payload.get("handover_id")
    bed_label = str(payload.get("bed_label") or "").strip() or None
    devices = None
    if payload.get("devices") is not None:
        try:
            devices = case_bindings.normalize(database, payload.get("devices"))
            case_bindings.check_clash(database, devices)
        except ValueError as error:
            raise HTTPException(400, str(error)) from None
        except case_bindings.DeviceInUse as clash:
            return JSONResponse(status_code=409, content=clash.body())
    if bed_label and bed_taken(database, bed_label):
        raise HTTPException(409, f"bed {bed_label} already has an active case on this workstation")
    claim = canopy("POST", "/api/sync/v1/handover/claim", {
        "leaf_id": os.getenv("FLORA_LEAF_ID", ""), "global_case_id": global_case_id,
        "move_devices": bool(payload.get("move_devices")), "actor": actor["username"],
        **({"handover_id": int(handover_id)} if handover_id is not None else {})})
    try:
        with database.transaction():
            database.execute("SELECT pg_advisory_xact_lock(6893, 1)")
            result = case_handover.import_case(
                database, claim["export"], from_leaf_id=claim["from_leaf_id"], global_case_id=global_case_id,
                actor=actor["username"], now=now_ms(), bed_label=bed_label or claim.get("to_bed_label"),
                keep_admission=bool(claim.get("transfer")))
            if devices:
                case_bindings.replace(database, result["case_id"], devices)
    except Exception as error:
        try:
            canopy("POST", f"/api/sync/v1/handover/{claim['handover_id']}/cancel", {"reason": str(error)[:300]})
        except HTTPException:
            pass
        if isinstance(error, HTTPException):
            raise
        raise HTTPException(500, f"import failed, handover cancelled: {error}") from None
    canopy("POST", f"/api/sync/v1/handover/{claim['handover_id']}/imported", {"to_case_id": result["case_id"]})
    return {**result, "handover_id": claim["handover_id"], "from_leaf_id": claim["from_leaf_id"],
            "moved_devices": claim.get("moved_devices") or [], "export_age_sec": claim.get("export_age_sec")}


# ---------------------------------------------------------------- transfer (no discharge; app/case_transfer.py)

@router.get("/transfer-targets")
def transfer_targets(_: dict = Depends(require_permission("case.read"))) -> dict:
    """Beds of this ward (with their Leaf and current case) a case can move to."""
    result = canopy("POST", "/api/sync/v1/transfer-targets", {"leaf_id": LEAF_ID}, timeout=5)
    return {**result, "leaf_id": LEAF_ID}


@router.post("/cases/{case_id}/transfer")
def transfer_case(case_id: int, payload: dict[str, Any] = Body(...), actor: dict = Depends(require_permission("case.discharge")),
                  database: Connection = Depends(connection)) -> dict:
    """Move this active case to another bed without discharging it. A bed of this Leaf: moved at once.
    A bed of another Leaf: offered there (Receive on that Leaf); this case stays open until then and its
    devices are released for the next patient."""
    to_leaf = str(payload.get("to_leaf_id") or "").strip() or None
    to_bed = payload.get("to_bed_location_id")
    label = str(payload.get("to_bed_label") or "").strip()
    current = now_ms()
    if to_leaf == LEAF_ID or (to_leaf is None and not isinstance(to_bed, int)):
        if not label:
            raise HTTPException(400, "choose a bed")
        with database.transaction():
            case = database.execute("SELECT id, bed_label, status FROM cases WHERE id=%s FOR UPDATE", (case_id,)).fetchone()
            if case is None or case["status"] != "active":
                raise HTTPException(409, "only an active case can move bed")
            if bed_taken(database, label, case_id):
                raise HTTPException(409, f"bed {label} already has an active case")
            move_bed(database, case, label, actor["username"], current)
        try:
            canopy("POST", "/api/sync/v1/cases/bed-move",
                   {"leaf_id": LEAF_ID, "source_case_id": case_id, "bed_label": label, "actor": actor["username"]}, timeout=5)
        except HTTPException:
            pass  # Canopy sees the bed in the next snapshot
        return {"kind": "bed_move", "case_id": case_id, "bed_label": label}
    case = database.execute("SELECT status FROM cases WHERE id=%s", (case_id,)).fetchone()
    if case is None or case["status"] != "active":
        raise HTTPException(409, "only an active case can be transferred")
    export = case_handover.export_case(database, case_id)
    result = canopy("POST", "/api/sync/v1/handover/offer", {
        "leaf_id": LEAF_ID, "source_case_id": case_id, "to_leaf_id": to_leaf,
        "to_bed_location_id": to_bed if isinstance(to_bed, int) else None, "to_bed_label": label or None,
        "note": payload.get("note"), "actor": actor["username"], "export": export}, timeout=30)
    with database.transaction():
        case_bindings.release(database, case_id, "transferred", current)
        audit(database, case_id, "transfer.offered", {**result, "source_case_id": case_id}, actor["username"], current)
    return {**result, "case_id": case_id}


@router.post("/cases/{case_id}/transfer/withdraw")
def withdraw_transfer(case_id: int, payload: dict[str, Any] = Body(...), actor: dict = Depends(require_permission("case.discharge")),
                      database: Connection = Depends(connection)) -> dict:
    """Cancel a transfer nobody received yet. The case's devices are bound again in Devices."""
    handover_id = payload.get("handover_id")
    if not isinstance(handover_id, int):
        raise HTTPException(400, "handover_id required")
    canopy("POST", f"/api/sync/v1/handover/{handover_id}/withdraw", {"leaf_id": LEAF_ID, "actor": actor["username"]})
    with database.transaction():
        audit(database, case_id, "transfer.withdrawn", {"handover_id": handover_id}, actor["username"], now_ms())
    return {"ok": True}


# ---------------------------------------------------------------- gateway setup wizard

def gateway_get(data_api_url: str, path: str, params: dict[str, Any] | None = None, timeout: float = 4) -> tuple[Any, float]:
    url = data_api_url.rstrip("/") + path + (("?" + urllib.parse.urlencode(params)) if params else "")
    started = time.monotonic()
    with urllib.request.urlopen(url, timeout=timeout) as response:
        return json.load(response), round((time.monotonic() - started) * 1000)


@router.post("/gateway/test")
def gateway_test(payload: dict[str, Any] = Body(...), _: dict = Depends(require_permission("config.manage"))) -> dict:
    """Step 2: can this Leaf reach the gateway's data-api on the LAN?"""
    url = str(payload.get("data_api_url") or "").strip()
    if not url.startswith(("http://", "https://")):
        raise HTTPException(400, "data_api_url must start with http:// or https://")
    try:
        health, latency = gateway_get(url, "/health")
        status, _ = gateway_get(url, "/api/devices/status")
    except Exception as error:
        return {"reachable": False, "error": f"{type(error).__name__}: {error}"}
    return {"reachable": True, "latency_ms": latency, "health": health, "devices": status.get("devices") or []}


@router.post("/gateway/assign")
def gateway_assign(payload: dict[str, Any] = Body(...), actor: dict = Depends(require_permission("config.manage"))) -> dict:
    """Step 3: ask Canopy to assign devices to this Leaf; the gateway applies it on its next check-in."""
    gateway_id = str(payload.get("gateway_id") or "").strip()
    if not gateway_id:
        raise HTTPException(400, "gateway_id required")
    return canopy("POST", f"/api/sync/v1/gateways/{urllib.parse.quote(gateway_id)}/assign", {
        "leaf_id": os.getenv("FLORA_LEAF_ID", ""), "device_ids": payload.get("device_ids") or [],
        "release_others": bool(payload.get("release_others", True)), "actor": actor["username"]})


@router.post("/gateway/verify")
def gateway_verify(payload: dict[str, Any] = Body(...), _: dict = Depends(require_permission("config.manage"))) -> dict:
    """Steps 3-4: which devices the gateway now serves to this Leaf, and their latest values."""
    url = str(payload.get("data_api_url") or "").strip()
    leaf_id = os.getenv("FLORA_LEAF_ID", "")
    end = now_ms()
    try:
        status, _ = gateway_get(url, "/api/devices/status", {"leaf_id": leaf_id})
        rows, _ = gateway_get(url, "/api/observations", {"from": end - 60_000, "to": end + 1, "leaf_id": leaf_id})
    except Exception as error:
        return {"reachable": False, "error": f"{type(error).__name__}: {error}"}
    latest: dict[str, dict[str, Any]] = {}
    for row in rows:
        latest[row["ivy_param"]] = {"value": row["value"], "unit": row.get("unit"), "device_id": row["device_id"],
                                    "system_ts": row["system_ts"]}
    return {"reachable": True, "devices": status.get("devices") or [], "latest": latest, "rows": len(rows)}


@router.put("/gateway/source")
def gateway_source(payload: dict[str, Any] = Body(...), actor: dict = Depends(require_permission("config.manage")),
                   database: Connection = Depends(connection)) -> dict:
    """Step 5: the device writer reads bedside data from this gateway from now on."""
    url = str(payload.get("data_api_url") or "").strip().rstrip("/")
    if not url.startswith(("http://", "https://")):
        raise HTTPException(400, "data_api_url must start with http:// or https://")
    row = database.execute(
        """INSERT INTO leaf_device_source (id, gateway_id, data_api_url, configured_by, configured_at)
           VALUES (1, %s, %s, %s, %s)
           ON CONFLICT (id) DO UPDATE SET gateway_id=excluded.gateway_id, data_api_url=excluded.data_api_url,
             configured_by=excluded.configured_by, configured_at=excluded.configured_at RETURNING *""",
        (payload.get("gateway_id"), url, actor["username"], now_ms()),
    ).fetchone()
    # The default gateway link follows the wizard (per-case bindings and the live stream use links).
    updated = database.execute(
        "UPDATE leaf_gateway_link SET gateway_id=%s, data_api_url=%s, updated_at=%s WHERE is_default RETURNING id",
        (row["gateway_id"], url, row["configured_at"])).fetchone()
    if updated is None:
        database.execute(
            """INSERT INTO leaf_gateway_link (gateway_id, label, data_api_url, is_default, created_at, updated_at)
               VALUES (%s, %s, %s, true, %s, %s)""",
            (row["gateway_id"], row["gateway_id"] or "Gateway", url, row["configured_at"], row["configured_at"]))
    database.commit()
    return {"device_source": row}


# ---------------------------------------------------------------- gateway links (several gateways; live stream)

LINK_FIELDS = ("gateway_id", "label", "data_api_url", "stream_url", "token")


def link_values(payload: dict[str, Any]) -> dict[str, Any]:
    values = {}
    for key in LINK_FIELDS:
        if key in payload:
            value = str(payload[key] or "").strip() or None
            values[key] = value.rstrip("/") if value and key.endswith("_url") else value
    if values.get("data_api_url") and not values["data_api_url"].startswith(("http://", "https://")):
        raise HTTPException(400, "data_api_url must start with http:// or https://")
    if values.get("stream_url") and not values["stream_url"].startswith(("ws://", "wss://")):
        raise HTTPException(400, "stream_url must start with ws:// or wss://")
    return values


def saved_link(database: Connection, link_id: int, is_default: Any, actor: dict) -> dict:
    if is_default or not database.execute("SELECT 1 FROM leaf_gateway_link WHERE is_default").fetchone():
        database.execute("UPDATE leaf_gateway_link SET is_default=false WHERE is_default AND id<>%s", (link_id,))
        database.execute("UPDATE leaf_gateway_link SET is_default=true WHERE id=%s", (link_id,))
    case_bindings.mirror_default(database, actor["username"])
    return case_bindings.link_public(database.execute("SELECT * FROM leaf_gateway_link WHERE id=%s", (link_id,)).fetchone())


@router.get("/gateway/links")
def gateway_links(_: dict = Depends(require_permission("case.read")), database: Connection = Depends(connection)) -> dict:
    rows = database.execute("SELECT * FROM leaf_gateway_link ORDER BY is_default DESC, id").fetchall()
    return {"links": [case_bindings.link_public(row) for row in rows]}


@router.post("/gateway/links")
def create_gateway_link(payload: dict[str, Any] = Body(...), actor: dict = Depends(require_permission("config.manage")),
                        database: Connection = Depends(connection)) -> dict:
    values = link_values(payload)
    if not values.get("data_api_url") and not values.get("stream_url"):
        raise HTTPException(400, "data_api_url or stream_url required")
    current = now_ms()
    with database.transaction():
        link_id = database.execute(
            f"""INSERT INTO leaf_gateway_link ({", ".join(values)}, created_at, updated_at)
                VALUES ({", ".join(["%s"] * len(values))}, %s, %s) RETURNING id""",
            (*values.values(), current, current)).fetchone()["id"]
        return {"link": saved_link(database, link_id, payload.get("is_default"), actor)}


@router.put("/gateway/links/{link_id}")
def update_gateway_link(link_id: int, payload: dict[str, Any] = Body(...),
                        actor: dict = Depends(require_permission("config.manage")),
                        database: Connection = Depends(connection)) -> dict:
    values = link_values(payload)
    with database.transaction():
        row = database.execute(
            f"""UPDATE leaf_gateway_link SET {"".join(f"{key}=%s, " for key in values)}updated_at=%s
                WHERE id=%s RETURNING id""", (*values.values(), now_ms(), link_id)).fetchone()
        if row is None:
            raise HTTPException(404, "gateway link not found")
        return {"link": saved_link(database, link_id, payload.get("is_default"), actor)}


@router.delete("/gateway/links/{link_id}")
def delete_gateway_link(link_id: int, actor: dict = Depends(require_permission("config.manage")),
                        database: Connection = Depends(connection)) -> dict:
    with database.transaction():
        database.execute("SELECT pg_advisory_xact_lock(6893, 1)")
        if database.execute("SELECT 1 FROM case_device_binding WHERE gateway_link_id=%s AND released_at IS NULL",
                            (link_id,)).fetchone():
            raise HTTPException(409, "active cases still record from this gateway")
        row = database.execute("DELETE FROM leaf_gateway_link WHERE id=%s RETURNING is_default", (link_id,)).fetchone()
        if row is None:
            raise HTTPException(404, "gateway link not found")
        if row["is_default"]:
            database.execute(
                "UPDATE leaf_gateway_link SET is_default=true WHERE id=(SELECT min(id) FROM leaf_gateway_link)")
            case_bindings.mirror_default(database, actor["username"])
    return {"ok": True, "deleted": link_id}


@router.get("/gateway/links/{link_id}/devices")
def gateway_link_devices(link_id: int, online_window_sec: int = 30, _: dict = Depends(require_permission("case.read")),
                         database: Connection = Depends(connection)) -> dict:
    """Devices this Leaf may bind on that gateway (its data-api /api/devices/status)."""
    link = database.execute("SELECT data_api_url FROM leaf_gateway_link WHERE id=%s", (link_id,)).fetchone()
    if link is None:
        raise HTTPException(404, "gateway link not found")
    if not link["data_api_url"]:
        return {"reachable": False, "error": "this gateway link has no data-api URL", "devices": []}
    try:
        status, latency = gateway_get(link["data_api_url"], "/api/devices/status", {"online_window_sec": online_window_sec})
    except Exception as error:
        return {"reachable": False, "error": f"{type(error).__name__}: {error}", "devices": []}
    status = status if isinstance(status, dict) else {"devices": status}
    # Instances assigned to this Leaf or to no Leaf (the stream-hub's rule).
    status["devices"] = [device for device in status.get("devices") or []
                         if not isinstance(device, dict) or device.get("leaf_id") in (None, "", LEAF_ID)]
    return {"reachable": True, "latency_ms": latency, **status}


# ---------------------------------------------------------------- Settings > Location from Canopy

@router.put("/beds/{bed_location_id}/devices")
def set_bed_devices(bed_location_id: int, payload: dict[str, Any] = Body(...), actor: dict = Depends(require_permission("config.manage")),
                    database: Connection = Depends(connection)) -> dict:
    """The devices fixed at one of this Leaf's beds, saved in Canopy; the bed board shows them after the next ward sync
    (asked for here at once)."""
    devices = [{key: item.get(key) for key in ("gateway_id", "device_id", "label", "device_type")}
               for item in payload.get("devices") or [] if isinstance(item, dict)]
    result = canopy("PUT", "/api/sync/v1/beds/devices", {"leaf_id": LEAF_ID, "bed_location_id": bed_location_id,
                                                       "devices": devices, "actor": actor["username"]})
    database.execute("""INSERT INTO leaf_sync_control (id, requested_at) VALUES (1, %s)
                        ON CONFLICT (id) DO UPDATE SET requested_at = excluded.requested_at""", (now_ms(),))
    database.commit()
    return result


@router.get("/locations")
def canopy_locations(_: dict = Depends(require_permission("config.manage"))) -> dict:
    """Canopy's location tree for the Location settings pickers (503 when Canopy is unreachable)."""
    result = canopy("POST", "/api/sync/v1/locations", {"leaf_id": os.getenv("FLORA_LEAF_ID", "")}, timeout=5)
    return {**result, "leaf_id": os.getenv("FLORA_LEAF_ID", "")}


@router.get("/locations/destinations")
def discharge_destinations(_: dict = Depends(require_permission("case.discharge"))) -> dict:
    """The location tree for the discharge dialog: Leaves of this ward (transfer) and the other wards."""
    result = canopy("POST", "/api/sync/v1/locations", {"leaf_id": os.getenv("FLORA_LEAF_ID", "")}, timeout=5)
    return {**result, "leaf_id": os.getenv("FLORA_LEAF_ID", "")}


@router.post("/locations/assign")
def assign_canopy_location(payload: dict[str, Any] = Body(...), actor: dict = Depends(require_permission("config.manage")),
                           database: Connection = Depends(connection)) -> dict:
    """Assign this Leaf to a Canopy bed and apply the location here at once (Canopy stays the source)."""
    bed_id = payload.get("bed_location_id")
    if not isinstance(bed_id, int):
        raise HTTPException(400, "bed_location_id required")
    context = database.execute("SELECT timezone, date_format, time_format FROM workstation_context WHERE id=1").fetchone() or {}
    result = canopy("POST", f"/api/sync/v1/leaves/{urllib.parse.quote(os.getenv('FLORA_LEAF_ID', ''))}/location", {
        "bed_location_id": bed_id, "timezone": context.get("timezone") or "Asia/Bangkok",
        "date_format": context.get("date_format") or "DD/MM/YYYY", "time_format": context.get("time_format") or "24h"})
    location = result["location"]
    database.execute(
        """UPDATE workstation_context SET hospital_name=%s, building_name=%s, care_unit_name=%s, room_name=%s,
             bed_name=%s, control_plane_version=%s, updated_at=%s WHERE id=1""",
        (location["hospitalName"], location["buildingName"], location["careUnitName"], location["roomName"],
         location["bedName"], result["version"], now_ms()))
    database.commit()
    return {**result, "applied": True, "by": actor["username"]}
