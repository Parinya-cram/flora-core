"""Leaf Ward page: what this workstation knows about its ward, local data first.

Everything here is served from the Leaf's own database, so the page works with no
network. The sync worker refreshes it from Canopy (`PUT /state`) and reports how each
sync step went (`PUT /sync-status`); "Sync now" only raises a flag the worker polls.
"""
import json
import os
import time
import urllib.error
import urllib.parse
import urllib.request
from typing import Any

from fastapi import APIRouter, Body, Depends, HTTPException
from psycopg import Connection
from psycopg.types.json import Jsonb

from .. import case_handover
from ..account_config_sync import CANOPY_SYNC_URL, SYNC_SECRET
from ..database import connection
from .auth_leaf import now_ms, require_permission, service_only
from .canopy_inbox import inbox_public

router = APIRouter(prefix="/api/ward", tags=["ward"])
LEAF_ID = os.getenv("FLORA_LEAF_ID", "").strip()
AUTO_SYNC_SECONDS = int(os.getenv("FLORA_SYNC_INTERVAL_SECONDS", "10"))


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
                  admission_source, handover_from_leaf_id, handover_to_leaf_id
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
        "handovers": payload.get("handovers") or [],
        "device_source": source,
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
                database.execute(
                    """INSERT INTO case_clinical_audit (case_id, action, before_json, after_json, actor_username, actor_role, created_at)
                       VALUES (%s, 'handover.released', NULL, %s, 'canopy-sync', 'integration', %s)""",
                    (row["id"], json.dumps(item), current),
                )
    return {"ok": True, "released": released}


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
    if database.execute("SELECT 1 FROM cases WHERE status='active' LIMIT 1").fetchone():
        raise HTTPException(409, "discharge the active case on this Leaf first")
    claim = canopy("POST", "/api/sync/v1/handover/claim", {
        "leaf_id": os.getenv("FLORA_LEAF_ID", ""), "global_case_id": global_case_id,
        "move_devices": bool(payload.get("move_devices")), "actor": actor["username"]})
    try:
        with database.transaction():
            database.execute("SELECT pg_advisory_xact_lock(6893, 1)")
            if database.execute("SELECT 1 FROM cases WHERE status='active' LIMIT 1").fetchone():
                raise HTTPException(409, "discharge the active case on this Leaf first")
            result = case_handover.import_case(
                database, claim["export"], from_leaf_id=claim["from_leaf_id"], global_case_id=global_case_id,
                actor=actor["username"], now=now_ms())
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
    database.commit()
    return {"device_source": row}
