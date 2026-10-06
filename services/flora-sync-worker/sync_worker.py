import hashlib
import json
import os
import time
import uuid
from datetime import datetime, timezone
from typing import Any

import httpx


LEAF_API = os.getenv("FLORA_LEAF_API_URL", "http://flora-leaf-api:8000").rstrip("/")
CANOPY_SYNC_API = os.getenv("FLORA_CANOPY_SYNC_URL", "http://flora-sync-api:8000").rstrip("/")
SYNC_SECRET = os.environ["FLORA_SYNC_SHARED_SECRET"]
LEAF_SERVICE_SECRET = os.environ["FLORA_LEAF_SERVICE_SECRET"]
LEAF_ID = os.getenv("FLORA_LEAF_ID", "leaf-dev-01").strip()
HOSPITAL_ID = os.getenv("FLORA_HOSPITAL_ID", "hospital-dev").strip()
DISPLAY_NAME = os.getenv("FLORA_LEAF_NAME", LEAF_ID).strip()
INTERVAL_SECONDS = max(2, int(os.getenv("FLORA_SYNC_INTERVAL_SECONDS", "10")))
# Discharged cases keep syncing this long so documentation finished after discharge reaches Canopy.
RECENT_MS = max(0, int(float(os.getenv("FLORA_SYNC_RECENT_HOURS", "24")) * 3_600_000))
LAST_DIGEST: dict[str, str] = {}
# Full raw export of active cases, so another Leaf can take a case over (handover).
LAST_EXPORT_DIGEST: dict[str, str] = {}
# Handovers whose old case this Leaf has locked; acknowledged on the next ward exchange.
RELEASED_ACK: list[int] = []
PREVIOUS_ACTIVE_IDS: set[str] = set()
INITIAL_SYNC_COMPLETE = False


def get_json(client: httpx.Client, path: str) -> Any:
    response = client.get(f"{LEAF_API}{path}", headers={"X-FLORA-Service-Secret": LEAF_SERVICE_SECRET})
    response.raise_for_status()
    return response.json()


def apply_configuration(client: httpx.Client, configuration: dict[str, Any]) -> None:
    location = configuration.get("location") or {}
    response = client.put(
        f"{LEAF_API}/api/workstation/context/control-plane",
        headers={"X-FLORA-Service-Secret": LEAF_SERVICE_SECRET},
        json={
            **location,
            "timezone": configuration.get("timezone") or "Asia/Bangkok",
            "dateFormat": configuration.get("dateFormat") or "DD/MM/YYYY",
            "timeFormat": configuration.get("timeFormat") or "24h",
            "controlPlaneVersion": int(configuration.get("version") or 0),
        },
    )
    response.raise_for_status()


def build_snapshot(client: httpx.Client, case: dict[str, Any]) -> dict[str, Any]:
    case_id = case["case_id"]
    now_ms = time.time_ns() // 1_000_000
    start_ms = int(case.get("start_time") or now_ms)
    # `to` is exclusive: include the discharge minute, or the current minute of an active
    # case, so entries made in that minute sync on this pass rather than the next one.
    last_minute = int(case["discharge_time"]) if case.get("discharge_time") else (now_ms // 60_000) * 60_000
    end_ms = last_minute + 60_000
    # The live viewer follows the latest 24 hours; older readings remain in Leaf.
    from_ms = max(start_ms, end_ms - 24 * 60 * 60 * 1000)
    paths = {
        "patient": f"/api/case/{case_id}/patient",
        "allergies": f"/api/case/{case_id}/allergies",
        "diagnosis": f"/api/case/{case_id}/diagnosis",
        "procedures": f"/api/case/{case_id}/procedures",
        "staff": f"/api/case/{case_id}/staff",
        "forms": f"/api/case/{case_id}/detail-draft",
        "vitals": f"/api/case/{case_id}/vitals?from={from_ms}&to={end_ms}",
        "events": f"/api/case/{case_id}/events?from={from_ms}&to={end_ms}&limit=1000",
        "timeline": f"/api/case/{case_id}/timeline/effective?from={from_ms}&to={end_ms}",
        "io_runs": f"/api/case/{case_id}/io/runs?from={from_ms}&to={end_ms}",
        "io_events": f"/api/case/{case_id}/io/events?from={from_ms}&to={end_ms}",
        "io_summary": f"/api/case/{case_id}/io/summary?from={from_ms}&to={end_ms}&bucket=1",
    }
    snapshot: dict[str, Any] = {"case": case, "window": {"from": from_ms, "to": end_ms}}
    for key, path in paths.items():
        try:
            snapshot[key] = get_json(client, path)
        except httpx.HTTPStatusError as error:
            if error.response.status_code != 404:
                raise
            snapshot[key] = None
    return snapshot


def make_message(snapshot: dict[str, Any]) -> tuple[dict[str, Any], str]:
    canonical = json.dumps(snapshot, sort_keys=True, separators=(",", ":"), default=str)
    digest = hashlib.sha256(canonical.encode("utf-8")).hexdigest()
    case_id = str(snapshot["case"]["case_id"])
    # Snapshot time: increases with every snapshot, so Canopy's "newest wins" check is meaningful.
    revision = time.time_ns() // 1_000_000
    message_id = uuid.uuid5(uuid.NAMESPACE_URL, f"flora:{LEAF_ID}:case:{case_id}:{digest}")
    return {
        "message_id": str(message_id),
        "entity_type": "case_snapshot",
        "entity_id": case_id,
        "operation": "upsert",
        "revision": revision,
        "occurred_at": datetime.now(timezone.utc).isoformat(),
        "payload": snapshot,
    }, digest


def synchronize() -> None:
    global INITIAL_SYNC_COMPLETE, PREVIOUS_ACTIVE_IDS
    with httpx.Client(timeout=20) as client:
        workstation = get_json(client, "/api/workstation/context")
        cases = get_json(client, "/api/case/list?limit=500").get("rows", [])
        active_ids = {
            str(case["case_id"])
            for case in cases
            if str(case.get("status") or "").upper() == "ACTIVE"
        }
        recent_after = time.time_ns() // 1_000_000 - RECENT_MS
        # After the first full pass: active cases, cases that just left active, cases never
        # sent (e.g. started and discharged while Canopy was unreachable), and recently
        # discharged cases that may still be edited.
        candidates = cases if not INITIAL_SYNC_COMPLETE else [
            case for case in cases
            if str(case["case_id"]) in active_ids | PREVIOUS_ACTIVE_IDS
            or str(case["case_id"]) not in LAST_DIGEST
            or int(case.get("discharge_time") or 0) >= recent_after
        ]
        pending: list[tuple[dict[str, Any], str, str]] = []
        exports: list[tuple[dict[str, Any], str, str]] = []
        for case in candidates:
            message, digest = make_message(build_snapshot(client, case))
            case_id = str(case["case_id"])
            if LAST_DIGEST.get(case_id) != digest:
                pending.append((message, digest, case_id))
            if case_id in active_ids:
                export = get_json(client, f"/api/ward/cases/{case_id}/export")
                export_digest = hashlib.sha256(json.dumps(export, sort_keys=True, default=str).encode()).hexdigest()
                if LAST_EXPORT_DIGEST.get(case_id) != export_digest:
                    exports.append(({
                        "message_id": str(uuid.uuid5(uuid.NAMESPACE_URL, f"flora:{LEAF_ID}:export:{case_id}:{export_digest}")),
                        "entity_type": "case_export", "entity_id": case_id, "operation": "upsert",
                        "revision": time.time_ns() // 1_000_000,
                        "occurred_at": datetime.now(timezone.utc).isoformat(), "payload": export,
                    }, export_digest, case_id))
        messages = [message for message, _, _ in pending] + [message for message, _, _ in exports]
        response = client.post(
            f"{CANOPY_SYNC_API}/api/sync/v1/batch",
            headers={"Authorization": f"Bearer {SYNC_SECRET}"},
            json={
                "leaf_id": LEAF_ID,
                "hospital_id": HOSPITAL_ID,
                "display_name": DISPLAY_NAME,
                "software_version": "0.1.0",
                "observed_location": workstation,
                "applied_config_version": int(workstation.get("controlPlaneVersion") or 0),
                "messages": messages,
            },
        )
        response.raise_for_status()
        result = response.json()
        configuration = result.get("configuration")
        desired_version = int(result.get("desired_config_version") or 0)
        applied_version = int(workstation.get("controlPlaneVersion") or 0)
        if configuration and desired_version > applied_version:
            apply_configuration(client, configuration)
            print(f"config applied leaf={LEAF_ID} version={desired_version}", flush=True)
        for _, digest, case_id in pending:
            LAST_DIGEST[case_id] = digest
        for _, digest, case_id in exports:
            LAST_EXPORT_DIGEST[case_id] = digest
        PREVIOUS_ACTIVE_IDS = active_ids
        INITIAL_SYNC_COMPLETE = True
        print(f"sync leaf={LEAF_ID} cases={len(pending)} exports={len(exports)} accepted={result['accepted']} "
              f"duplicates={result['duplicates']}", flush=True)
        return {"cases": len(pending), "exports": len(exports), "accepted": result["accepted"]}


def synchronize_directory() -> None:
    """Push user changes made on this Leaf, then cache this ward's users from Canopy."""
    with httpx.Client(timeout=20) as client:
        pending = get_json(client, "/api/auth/directory/pending").get("users", [])
        response = client.post(
            f"{CANOPY_SYNC_API}/api/sync/v1/directory",
            headers={"Authorization": f"Bearer {SYNC_SECRET}"},
            json={"leaf_id": LEAF_ID, "changes": pending},
        )
        response.raise_for_status()
        directory = response.json()
        applied = client.put(
            f"{LEAF_API}/api/auth/directory",
            headers={"X-FLORA-Service-Secret": LEAF_SERVICE_SECRET},
            json=directory,
        )
        applied.raise_for_status()
        result = applied.json()
        if pending or result.get("removed") or result.get("failed") or directory.get("failed"):
            print(
                f"directory leaf={LEAF_ID} pushed={len(pending)} users={len(directory.get('users', []))} "
                f"removed={result.get('removed')} failed={result.get('failed') or directory.get('failed')}",
                flush=True,
            )


def synchronize_admissions() -> None:
    """Exchange Canopy admissions: push form changes of cases started from them, then
    receive admissions this Leaf may start and form edits made in Canopy (tablet)."""
    with httpx.Client(timeout=20) as client:
        outbox = get_json(client, "/api/case/canopy-sync/outbox")
        response = client.post(
            f"{CANOPY_SYNC_API}/api/sync/v1/admissions",
            headers={"Authorization": f"Bearer {SYNC_SECRET}"},
            json={"leaf_id": LEAF_ID, "hospital_id": HOSPITAL_ID, **outbox},
        )
        response.raise_for_status()
        exchange = response.json()
        applied = client.put(
            f"{LEAF_API}/api/case/canopy-sync/inbox",
            headers={"X-FLORA-Service-Secret": LEAF_SERVICE_SECRET},
            json=exchange,
        )
        applied.raise_for_status()
        result = applied.json()
        if result.get("updated_forms") or result.get("withdrawn") or exchange.get("conflicts"):
            print(f"admissions leaf={LEAF_ID} pending={len(exchange.get('pending', []))} "
                  f"forms_from_canopy={result.get('updated_forms')} withdrawn={result.get('withdrawn')} "
                  f"conflicts={exchange.get('conflicts')}", flush=True)



def synchronize_ward() -> dict[str, Any]:
    """Ward peers, registered gateways and released handovers for the Leaf Ward page."""
    global RELEASED_ACK
    with httpx.Client(timeout=20) as client:
        response = client.post(
            f"{CANOPY_SYNC_API}/api/sync/v1/ward",
            headers={"Authorization": f"Bearer {SYNC_SECRET}"},
            json={"leaf_id": LEAF_ID, "hospital_id": HOSPITAL_ID, "released_ack": RELEASED_ACK},
        )
        response.raise_for_status()
        ward = response.json()
        RELEASED_ACK = []
        applied = client.put(f"{LEAF_API}/api/ward/state", headers={"X-FLORA-Service-Secret": LEAF_SERVICE_SECRET}, json=ward)
        applied.raise_for_status()
        locked = set(applied.json().get("released") or [])
        RELEASED_ACK = [item["handover_id"] for item in ward.get("released") or [] if int(item["source_case_id"]) in locked]
        if ward.get("released"):
            print(f"ward leaf={LEAF_ID} released={sorted(locked)} (handed over)", flush=True)
        return {"peers": len(ward.get("leaves") or []), "gateways": len(ward.get("gateways") or []),
                "released": len(ward.get("released") or [])}


def leaf(method: str, path: str, **kwargs: Any) -> Any:
    response = httpx.request(method, f"{LEAF_API}{path}", headers={"X-FLORA-Service-Secret": LEAF_SERVICE_SECRET},
                             timeout=5, **kwargs)
    response.raise_for_status()
    return response.json()


STEPS = (
    ("ward", synchronize_ward, "ward sync failed"),
    ("cases", synchronize, "sync failed"),
    ("directory", synchronize_directory, "directory sync failed"),
    ("admissions", synchronize_admissions, "admission sync failed"),
)


def run_cycle() -> None:
    components: dict[str, dict[str, Any]] = {}
    for name, step, label in STEPS:
        try:
            components[name] = {"ok": True, "detail": step() or {}}
        except Exception as error:
            print(f"{label}: {type(error).__name__}: {error}", flush=True)
            components[name] = {"ok": False, "error": f"{type(error).__name__}: {error}"}
    try:
        leaf("PUT", "/api/ward/sync-status", json={"components": components})
    except Exception as error:
        print(f"status report failed: {type(error).__name__}: {error}", flush=True)


# Automatic sync every INTERVAL_SECONDS; "Sync now" on the Ward page runs a cycle at once.
last_cycle = 0.0
last_request = 0
while True:
    try:
        requested = int(leaf("GET", "/api/ward/sync-control").get("requested_at") or 0)
    except Exception:
        requested = 0
    if requested > last_request or time.monotonic() - last_cycle >= INTERVAL_SECONDS:
        last_request = max(last_request, requested)
        last_cycle = time.monotonic()
        run_cycle()
    time.sleep(1)
