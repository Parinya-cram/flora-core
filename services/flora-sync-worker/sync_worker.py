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
# Sync protocol of this worker (sent with every batch; Canopy answers with its own).
PROTOCOL_VERSION = 2
SOFTWARE_VERSION = os.getenv("FLORA_VERSION", "0.1.0").strip() or "0.1.0"
CAPABILITIES = ["case_snapshot", "durable_sync", "case_forms"]
# Cases looked at per pass (/api/leaf-sync/cases): every active case, then never-sent / newly archived ones, then
# IDLE_PER_CYCLE open cases in turn. Batches stay under Canopy's 500 messages and its 50 MB request limit.
PLAN_LIMIT = int(os.getenv("FLORA_SYNC_PLAN_LIMIT", "100"))
IDLE_PER_CYCLE = int(os.getenv("FLORA_SYNC_IDLE_PER_CYCLE", "10"))
BATCH_MESSAGES = 100
BATCH_BYTES = 8 * 1024 * 1024
# Handovers whose old case this Leaf has locked; acknowledged on the next ward exchange.
RELEASED_ACK: list[int] = []
# Workflow Studio: digest of the ward's workflow set last stored on the Leaf.
LAST_WORKFLOWS_DIGEST = ""
# The hospital's name and logo last stored on the Leaf (sent again after a restart: harmless).
LAST_PROFILE_DIGEST = ""
# Staff directory: digest of the ward list last applied on the Leaf (Canopy omits an unchanged list).
LAST_STAFF_DIGEST: str | None = None
# Workflow forms (case_forms): Canopy changes applied on the Leaf, confirmed in the next exchange (re-sent after a
# restart, which is harmless: applying them again changes nothing).
CASE_FORM_ACKS: list[dict[str, Any]] = []
CASE_FORM_ROUNDS = 5  # exchanges per pass while the Leaf has more forms to send


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


class ProtocolRefused(RuntimeError):
    """Canopy turned this Leaf away (426): its sync protocol is older than Canopy takes. Flora Leaf needs an update."""


def check_refused(response: httpx.Response) -> None:
    """Raise ProtocolRefused with Canopy's reason when it refuses this Leaf's protocol (shown on the Ward page)."""
    if response.status_code != 426:
        return
    try:
        detail = response.json().get("detail")
    except ValueError:
        detail = None
    message = detail.get("message") if isinstance(detail, dict) else str(detail or "")
    raise ProtocolRefused(message or f"Canopy refused sync protocol {PROTOCOL_VERSION}: update Flora Leaf")


DAY_MS = 24 * 60 * 60 * 1000
# A closed (discharged or archived) case goes to Canopy whole, up to this many days back from its end, so Canopy's copy
# holds its full record; an open case carries the latest 24 hours (Canopy's live viewer).
FINAL_HISTORY_DAYS = max(1, int(os.getenv("FLORA_SYNC_FINAL_HISTORY_DAYS", "31") or 31))


def build_snapshot(client: httpx.Client, case: dict[str, Any], case_forms_active: bool = False) -> dict[str, Any]:
    case_id = case["case_id"]
    now_ms = time.time_ns() // 1_000_000
    start_ms = int(case.get("start_time") or now_ms)
    # `to` is exclusive: include the discharge minute, or the current minute of an active
    # case, so entries made in that minute sync on this pass rather than the next one.
    last_minute = int(case["discharge_time"]) if case.get("discharge_time") else (now_ms // 60_000) * 60_000
    end_ms = last_minute + 60_000
    closed = bool(case.get("discharge_time")) or str(case.get("status") or "") in {"discharged", "archived"}
    from_ms = max(start_ms, end_ms - (FINAL_HISTORY_DAYS if closed else 1) * DAY_MS)
    events_limit = 5000 if closed else 1000
    paths = {
        "patient": f"/api/case/{case_id}/patient",
        "allergies": f"/api/case/{case_id}/allergies",
        "diagnosis": f"/api/case/{case_id}/diagnosis",
        "procedures": f"/api/case/{case_id}/procedures",
        "staff": f"/api/case/{case_id}/staff",
        "forms": f"/api/case/{case_id}/detail-draft",
        "vitals": f"/api/case/{case_id}/vitals?from={from_ms}&to={end_ms}",
        "events": f"/api/case/{case_id}/events?from={from_ms}&to={end_ms}&limit={events_limit}",
        "timeline": f"/api/case/{case_id}/timeline/effective?from={from_ms}&to={end_ms}",
        "io_runs": f"/api/case/{case_id}/io/runs?from={from_ms}&to={end_ms}",
        "io_events": f"/api/case/{case_id}/io/events?from={from_ms}&to={end_ms}",
        "io_summary": f"/api/case/{case_id}/io/summary?from={from_ms}&to={end_ms}&bucket=1",
        "workflow": f"/api/case/{case_id}/workflow-snapshot",
        "workflow_forms": f"/api/case/{case_id}/workflow-forms",
        "billing": f"/api/case/{case_id}/billing",
        "scores": f"/api/case/{case_id}/scores?from={from_ms}&to={end_ms}",
    }
    # complete: the snapshot holds the case from its start (else only its latest part, see FINAL_HISTORY_DAYS).
    snapshot: dict[str, Any] = {"case": case, "window": {"from": from_ms, "to": end_ms, "complete": from_ms <= start_ms}}
    if case_forms_active:
        # Workflow forms reach Form Studio through the case form exchange, not through this snapshot.
        snapshot["case_forms_channel"] = True
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


def post_batch(client: httpx.Client, workstation: dict[str, Any], messages: list[dict[str, Any]]) -> dict[str, Any]:
    response = client.post(
        f"{CANOPY_SYNC_API}/api/sync/v1/batch",
        headers={"Authorization": f"Bearer {SYNC_SECRET}"},
        json={
            "leaf_id": LEAF_ID,
            "hospital_id": HOSPITAL_ID,
            "display_name": DISPLAY_NAME,
            "software_version": SOFTWARE_VERSION,
            "protocol_version": PROTOCOL_VERSION,
            "capabilities": CAPABILITIES,
            "observed_location": workstation,
            "applied_config_version": int(workstation.get("controlPlaneVersion") or 0),
            "messages": messages,
        },
    )
    check_refused(response)
    response.raise_for_status()
    return response.json()


def batches(items: list[tuple[dict[str, Any], dict[str, Any]]]) -> list[list[tuple[dict[str, Any], dict[str, Any]]]]:
    """Messages in batches Canopy accepts: at most BATCH_MESSAGES each and about BATCH_BYTES of JSON."""
    out: list[list[tuple[dict[str, Any], dict[str, Any]]]] = [[]]
    size = 0
    for item in items:
        length = len(json.dumps(item[0], default=str))
        if out[-1] and (len(out[-1]) >= BATCH_MESSAGES or size + length > BATCH_BYTES):
            out.append([])
            size = 0
        out[-1].append(item)
        size += length
    return out


def synchronize() -> dict[str, Any]:
    """Send the case snapshots Canopy does not have yet. The Leaf keeps what Canopy took (/api/leaf-sync): a restart
    resumes where it stopped, a discharged case is checked again however long ago it was discharged, a case that cannot
    be read is reported and skipped (it no longer blocks the others), and batches stay within Canopy's limits."""
    with httpx.Client(timeout=30) as client:
        workstation = get_json(client, "/api/workstation/context")
        plan = get_json(client, f"/api/leaf-sync/cases?limit={PLAN_LIMIT}&idle={IDLE_PER_CYCLE}")
        case_forms_active = bool((plan.get("state") or {}).get("case_forms.active"))
        results: dict[int, dict[str, Any]] = {}
        items: list[tuple[dict[str, Any], dict[str, Any]]] = []  # (message, what to record once Canopy took it)
        for planned in plan.get("cases") or []:
            case = {key: value for key, value in planned.items() if key not in {"sent_digest", "export_digest"}}
            case_id = int(case["case_id"])
            results[case_id] = {"case_id": case_id, "checked": True}
            try:
                message, digest = make_message(build_snapshot(client, case, case_forms_active))
                if planned.get("sent_digest") != digest:
                    items.append((message, {"case_id": case_id, "sent_digest": digest}))
                if str(case.get("status") or "").upper() == "ACTIVE":
                    export = get_json(client, f"/api/ward/cases/{case_id}/export")
                    export_digest = hashlib.sha256(json.dumps(export, sort_keys=True, default=str).encode()).hexdigest()
                    if planned.get("export_digest") != export_digest:
                        items.append(({
                            "message_id": str(uuid.uuid5(uuid.NAMESPACE_URL, f"flora:{LEAF_ID}:export:{case_id}:{export_digest}")),
                            "entity_type": "case_export", "entity_id": str(case_id), "operation": "upsert",
                            "revision": time.time_ns() // 1_000_000,
                            "occurred_at": datetime.now(timezone.utc).isoformat(), "payload": export,
                        }, {"case_id": case_id, "export_digest": export_digest}))
            except Exception as error:  # this case only: the others are still sent
                results[case_id]["error"] = f"{type(error).__name__}: {error}"
                print(f"sync leaf={LEAF_ID} case={case_id} skipped: {type(error).__name__}: {error}", flush=True)
        sent, accepted, duplicates, failure = 0, 0, 0, None
        result: dict[str, Any] | None = None
        for batch in batches(items):
            try:
                result = post_batch(client, workstation, [message for message, _ in batch])
            except Exception as error:  # Canopy unreachable or refused: the rest waits for the next pass
                failure = error
                break
            sent += len(batch)
            accepted += int(result.get("accepted") or 0)
            duplicates += int(result.get("duplicates") or 0)
            for _, record in batch:
                results[record["case_id"]].update({key: value for key, value in record.items() if key != "case_id"})
        stored = client.put(f"{LEAF_API}/api/leaf-sync/cases", headers={"X-FLORA-Service-Secret": LEAF_SERVICE_SECRET},
                            json={"results": list(results.values())})
        stored.raise_for_status()
        if failure is not None:
            raise failure
        if result is not None:
            configuration = result.get("configuration")
            desired_version = int(result.get("desired_config_version") or 0)
            applied_version = int(workstation.get("controlPlaneVersion") or 0)
            if configuration and desired_version > applied_version:
                apply_configuration(client, configuration)
                print(f"config applied leaf={LEAF_ID} version={desired_version}", flush=True)
        errors = sum(1 for item in results.values() if item.get("error"))
        if sent or errors:
            print(f"sync leaf={LEAF_ID} checked={len(results)} sent={sent} accepted={accepted} duplicates={duplicates} "
                  f"skipped={errors}", flush=True)
        return {"checked": len(results), "sent": sent, "accepted": accepted, "skipped": errors}


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


def synchronize_staff() -> dict[str, Any]:
    """Push staff added on this Leaf (with their doctor / nurse code), then cache this ward's staff from Canopy."""
    global LAST_STAFF_DIGEST
    with httpx.Client(timeout=20) as client:
        try:
            pending = get_json(client, "/api/case/staff/sync/pending").get("staff", [])
        except httpx.HTTPStatusError as error:
            if error.response.status_code == 404:  # a Leaf API without staff sync
                return {"skipped": "leaf has no staff sync"}
            raise
        response = client.post(
            f"{CANOPY_SYNC_API}/api/sync/v1/staff",
            headers={"Authorization": f"Bearer {SYNC_SECRET}"},
            json={"leaf_id": LEAF_ID, "digest": LAST_STAFF_DIGEST, "changes": pending},
        )
        if response.status_code == 404:  # a Canopy without staff sync
            return {"skipped": "canopy has no staff sync"}
        response.raise_for_status()
        exchange = response.json()
        applied = client.put(f"{LEAF_API}/api/case/staff/sync/apply",
                             headers={"X-FLORA-Service-Secret": LEAF_SERVICE_SECRET}, json=exchange)
        if applied.status_code == 404:  # a Leaf API without staff sync
            return {"skipped": "leaf has no staff sync"}
        applied.raise_for_status()
        result = applied.json()
        LAST_STAFF_DIGEST = exchange.get("digest")
        if pending or not result.get("unchanged"):
            print(f"staff leaf={LEAF_ID} pushed={len(pending)} received={result.get('received')} "
                  f"created={result.get('created')} merged={result.get('merged')} rejected={result.get('rejected')} "
                  f"deactivated={result.get('deactivated')}", flush=True)
        return {**result, "unit": (exchange.get("unit") or {}).get("unit_name"), "synced_at": time.time_ns() // 1_000_000}


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
            # When the outbox was built: archived cases up to then have now reached Canopy.
            json={**exchange, "outbox_built_at": outbox.get("built_at")},
        )
        applied.raise_for_status()
        result = applied.json()
        if result.get("updated_forms") or result.get("withdrawn") or exchange.get("conflicts"):
            print(f"admissions leaf={LEAF_ID} pending={len(exchange.get('pending', []))} "
                  f"forms_from_canopy={result.get('updated_forms')} withdrawn={result.get('withdrawn')} "
                  f"conflicts={exchange.get('conflicts')}", flush=True)



def synchronize_case_forms() -> dict[str, Any]:
    """Workflow forms both ways, field by field: the Leaf's changed forms go up and come back with a receipt each
    (shown on the form); Canopy's changes (amendments with a reason, forms filled for the admission) come down. Files
    of file / image fields go up when Canopy asks for them. The Leaf pages its outbox; this repeats while it has more."""
    global CASE_FORM_ACKS
    totals = {"sent": 0, "received": 0, "applied": 0, "files": 0, "problems": 0}
    with httpx.Client(timeout=30) as client:
        for _ in range(CASE_FORM_ROUNDS):
            try:
                outbox = get_json(client, "/api/case/workflow-forms-sync/outbox")
            except httpx.HTTPStatusError as error:
                if error.response.status_code == 404:  # a Leaf API without the exchange
                    return {"skipped": "leaf has no case form exchange"}
                raise
            if not outbox.get("forms") and not outbox.get("cases") and not CASE_FORM_ACKS:
                break
            response = client.post(
                f"{CANOPY_SYNC_API}/api/sync/v1/case-forms",
                headers={"Authorization": f"Bearer {SYNC_SECRET}"},
                json={"leaf_id": LEAF_ID, "hospital_id": HOSPITAL_ID, "forms": outbox.get("forms") or [],
                      "cases": outbox.get("cases") or [], "acks": CASE_FORM_ACKS, "protocol_version": PROTOCOL_VERSION},
            )
            check_refused(response)
            if response.status_code == 404:  # a Canopy without the exchange
                return {"skipped": "canopy has no case form exchange"}
            response.raise_for_status()
            exchange = response.json()
            CASE_FORM_ACKS = []
            for sha in exchange.get("need_files") or []:
                stored = client.get(f"{LEAF_API}/api/case/workflow-forms-sync/files/{sha}",
                                    headers={"X-FLORA-Service-Secret": LEAF_SERVICE_SECRET})
                if stored.status_code == 404:
                    continue
                stored.raise_for_status()
                sent = client.put(f"{CANOPY_SYNC_API}/api/sync/v1/case-forms/files/{sha}", params={"leaf_id": LEAF_ID},
                                  headers={"Authorization": f"Bearer {SYNC_SECRET}",
                                           "Content-Type": stored.headers.get("content-type") or "application/octet-stream"},
                                  content=stored.content)
                if sent.status_code < 300:
                    totals["files"] += 1
            applied = client.put(f"{LEAF_API}/api/case/workflow-forms-sync/inbox",
                                 headers={"X-FLORA-Service-Secret": LEAF_SERVICE_SECRET},
                                 json={"receipts": exchange.get("receipts") or [], "inbound": exchange.get("inbound") or []})
            applied.raise_for_status()
            result = applied.json()
            CASE_FORM_ACKS = result.get("acks") or []
            set_state(client, "case_forms.active", True)  # both sides speak it: snapshots stop carrying forms
            totals["sent"] += len(outbox.get("forms") or [])
            totals["received"] += len(exchange.get("inbound") or [])
            totals["applied"] += int(result.get("applied") or 0)
            totals["problems"] += sum(1 for r in exchange.get("receipts") or [] if r.get("state") in {"not_stored", "kept_as_draft"})
            if not outbox.get("more"):
                break
    if totals["sent"] or totals["received"] or totals["files"] or totals["problems"]:
        print(f"case forms leaf={LEAF_ID} sent={totals['sent']} received={totals['received']} applied={totals['applied']} "
              f"files={totals['files']} not_stored_or_draft={totals['problems']}", flush=True)
    return totals


def synchronize_case_documents() -> dict[str, Any]:
    """Documents attached to cases on this Leaf (0092): the details of each are sent to Canopy, and the file itself (as
    it is, not base64) only when Canopy does not have it yet; a removal sends the details again, never the file."""
    sent, failed, files = 0, 0, 0
    auth = {"Authorization": f"Bearer {SYNC_SECRET}"}
    with httpx.Client(timeout=120) as client:
        try:
            outbox = get_json(client, "/api/case-documents/outbox?limit=20")
        except httpx.HTTPStatusError as error:
            if error.response.status_code == 404:  # a Leaf API without case documents
                return {"skipped": "leaf has no case documents"}
            raise
        for document in outbox.get("documents") or []:
            details = {"leaf_id": LEAF_ID, "hospital_id": HOSPITAL_ID, "protocol_version": PROTOCOL_VERSION, "case_id": document["case_id"],
                       "global_case_id": document.get("handover_global_case_id"), "hn": document.get("hn"), "document_id": document["id"],
                       "title": document["title"], "pages": document["pages"], "bytes": document["bytes"], "sha256": document["sha256"],
                       "created_at": document["created_at"], "created_by": document.get("created_by"), "removed_at": document.get("removed_at"),
                       "removed_by": document.get("removed_by"), "removed_reason": document.get("removed_reason")}
            response = client.put(f"{CANOPY_SYNC_API}/api/sync/v1/case-documents", headers=auth, json=details)
            check_refused(response)
            if response.status_code == 404:  # a Canopy without case documents
                return {"skipped": "canopy has no case documents"}
            if response.status_code < 400 and response.json().get("needs_content"):
                content = client.get(f"{LEAF_API}/api/case-documents/{document['id']}/file", headers={"X-FLORA-Service-Secret": LEAF_SERVICE_SECRET})
                content.raise_for_status()
                response = client.put(f"{CANOPY_SYNC_API}/api/sync/v1/case-documents/{LEAF_ID}/{document['id']}/content",
                                      headers={**auth, "Content-Type": "application/pdf"}, content=content.content)
                files += 1
            outcome = {} if response.status_code < 400 else {"error": f"Canopy refused it ({response.status_code}): {response.text[:200]}"}
            client.put(f"{LEAF_API}/api/case-documents/{document['id']}/synced", headers={"X-FLORA-Service-Secret": LEAF_SERVICE_SECRET},
                       json=outcome).raise_for_status()
            sent, failed = sent + (0 if outcome else 1), failed + (1 if outcome else 0)
    if sent or failed:
        print(f"case documents leaf={LEAF_ID} sent={sent} files={files} failed={failed}", flush=True)
    return {"sent": sent, "files": files, "failed": failed}


def set_state(client: httpx.Client, key: str, value: Any) -> None:
    """A worker setting kept in the Leaf database (/api/leaf-sync/state), so it survives a restart."""
    response = client.put(f"{LEAF_API}/api/leaf-sync/state/{key}", headers={"X-FLORA-Service-Secret": LEAF_SERVICE_SECRET},
                          json=value)
    response.raise_for_status()


def synchronize_ward() -> dict[str, Any]:
    """Ward peers, registered gateways and released handovers for the Leaf Ward page."""
    global RELEASED_ACK, LAST_WORKFLOWS_DIGEST, LAST_PROFILE_DIGEST
    with httpx.Client(timeout=20) as client:
        response = client.post(
            f"{CANOPY_SYNC_API}/api/sync/v1/ward",
            headers={"Authorization": f"Bearer {SYNC_SECRET}"},
            json={"leaf_id": LEAF_ID, "hospital_id": HOSPITAL_ID, "released_ack": RELEASED_ACK, "protocol_version": PROTOCOL_VERSION},
        )
        check_refused(response)
        response.raise_for_status()
        ward = response.json()
        RELEASED_ACK = []
        profile = ward.pop("hospital_profile", None)
        if isinstance(profile, dict):
            digest = hashlib.sha256(json.dumps(profile, sort_keys=True, default=str).encode()).hexdigest()
            if digest != LAST_PROFILE_DIGEST:
                stored = client.put(f"{LEAF_API}/api/workstation/hospital-profile",
                                    headers={"X-FLORA-Service-Secret": LEAF_SERVICE_SECRET}, json=profile)
                if stored.status_code != 404:  # a Leaf API without the hospital profile
                    stored.raise_for_status()
                    LAST_PROFILE_DIGEST = digest
        workflows = ward.pop("workflows", None)
        if isinstance(workflows, dict):
            digest = hashlib.sha256(json.dumps(workflows, sort_keys=True, default=str).encode()).hexdigest()
            if digest != LAST_WORKFLOWS_DIGEST:
                stored = client.put(f"{LEAF_API}/api/case/workflows/state",
                                    headers={"X-FLORA-Service-Secret": LEAF_SERVICE_SECRET}, json=workflows)
                if stored.status_code != 404:  # a Leaf API without Workflow Studio
                    stored.raise_for_status()
                    LAST_WORKFLOWS_DIGEST = digest
                    print(f"workflows leaf={LEAF_ID} version={workflows.get('version')} "
                          f"items={len(workflows.get('items') or [])}", flush=True)
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
    ("staff", synchronize_staff, "staff sync failed"),
    ("admissions", synchronize_admissions, "admission sync failed"),
    ("case_forms", synchronize_case_forms, "case form sync failed"),
    ("case_documents", synchronize_case_documents, "case document sync failed"),
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
