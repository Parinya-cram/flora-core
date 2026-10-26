"""Leaf side of Canopy admissions: the "Prepared patients" inbox and form sync.

The sync worker pulls `outbox` (forms of cases started from a Canopy admission)
and pushes `inbox` (admissions this Leaf may start, plus form changes made in
Canopy, e.g. pre-op filled on a tablet).
"""
import json
from typing import Any

from fastapi import HTTPException, APIRouter, Depends
from psycopg import Connection
from psycopg.types.json import Jsonb

from .. import form_sync, record_link
from ..clinical import case_audit
from ..database import connection
from . import leaf_sync
from .auth_leaf import now_ms, require_permission, service_only

router = APIRouter(prefix="/api/case", tags=["canopy admissions"])
SYNC_ACTOR = {"username": "canopy-sync", "role": "integration"}


def inbox_public(row: dict[str, Any]) -> dict[str, Any]:
    header = row.get("header") or {}
    values = row.get("form_values") or {}
    return {
        "id": str(row["id"]),
        "hn": header.get("hn"),
        "admissionNumber": header.get("admission_number"),
        "patient": header.get("patient") or {},
        "admission": header.get("admission") or {},
        "unitName": header.get("unit_name"),
        "targetLeafId": header.get("target_leaf_id"),
        "scheduledAt": header.get("scheduled_at"),
        # OR schedule: the room / bed the ward desk assigned, the booked team, a pending move-in request.
        "orSession": header.get("or_session"),
        "note": header.get("note"),
        "createdBy": header.get("created_by"),
        "formFieldCount": len([value for value in values.values() if value not in (None, "", [], {})]),
        "preopFilled": any(key.startswith("preop") and value not in (None, "", [], {}) for key, value in values.items()),
    }


@router.get("/canopy-admissions")
def canopy_admissions(_: dict = Depends(require_permission("case.read")), database: Connection = Depends(connection)) -> dict:
    rows = database.execute(
        "SELECT * FROM canopy_admission_inbox WHERE status='pending' ORDER BY (header->>'scheduled_at')::bigint NULLS LAST, received_at"
    ).fetchall()
    return {"rows": [inbox_public(row) for row in rows]}


OUTBOX_CASES = 400  # Canopy takes at most 500 per exchange


def _metadata(raw: Any) -> dict[str, Any]:
    if isinstance(raw, str):
        try:
            raw = json.loads(raw)
        except ValueError:
            return {}
    return raw if isinstance(raw, dict) else {}


@router.get("/canopy-sync/outbox")
def outbox(_: dict = Depends(service_only), database: Connection = Depends(connection)) -> dict:
    """Forms of cases started from Canopy admissions: open cases, and archived ones until an exchange after their
    archiving went through (however long Canopy was unreachable). `built_at` comes back with the inbox call."""
    built_at = now_ms()
    synced = (leaf_sync.state(database).get("admissions.synced_at") or 0)
    cases = database.execute(
        """SELECT c.id, c.canopy_admission_id, c.status, c.case_code, c.start_time, c.discharge_time,
                  to_jsonb(c) ->> 'discharge_reason' AS discharge_reason, to_jsonb(c) ->> 'discharge_destination' AS discharge_destination,
                  to_jsonb(c) ->> 'discharge_note' AS discharge_note, to_jsonb(c) ->> 'or_stage' AS or_stage,
                  (to_jsonb(c) -> 'admission_metadata') AS admission_metadata,
                  d.form_draft_json, d.field_versions
           FROM cases c LEFT JOIN case_detail d ON d.case_id=c.id
           WHERE c.canopy_admission_id IS NOT NULL
             AND (c.status<>'archived' OR coalesce(c.archive_time, 0) >= %s)
           ORDER BY (c.status='active') DESC, (c.status<>'archived') DESC, c.id DESC
           LIMIT %s""",
        (int(synced) if isinstance(synced, (int, float)) else 0, OUTBOX_CASES),
    ).fetchall()
    claims = database.execute(
        "SELECT id, case_id FROM canopy_admission_inbox WHERE status='claimed' AND NOT claim_acknowledged ORDER BY updated_at LIMIT %s",
        (OUTBOX_CASES,),
    ).fetchall()
    return {
        "cases": [{
            "admission_id": str(row["canopy_admission_id"]), "case_id": row["id"], "status": row["status"],
            "case_code": row["case_code"], "start_time": row["start_time"], "discharge_time": row["discharge_time"],
            "discharge_reason": row["discharge_reason"], "discharge_destination": row["discharge_destination"],
            "discharge_note": row["discharge_note"], "or_stage": row["or_stage"],
            "billing_mode": _metadata(row["admission_metadata"]).get("transfer_billing_mode"),
            "values": form_sync.parse(row["form_draft_json"]), "versions": row["field_versions"] or {},
        } for row in cases],
        "claims": [{"admission_id": str(row["id"]), "case_id": row["case_id"]} for row in claims],
        "built_at": built_at,
    }


@router.put("/canopy-sync/inbox")
def inbox(payload: dict[str, Any], _: dict = Depends(service_only), database: Connection = Depends(connection)) -> dict:
    current = now_ms()
    pending = [item for item in payload.get("pending") or [] if isinstance(item, dict) and item.get("id")]
    received, updated_forms = 0, 0
    with database.transaction():
        for item in pending:
            existing = database.execute(
                "SELECT * FROM canopy_admission_inbox WHERE id=%s FOR UPDATE", (item["id"],)
            ).fetchone()
            if existing and existing["status"] == "claimed":
                continue
            values, versions = item.get("form_values") or {}, item.get("form_versions") or {}
            database.execute(
                """INSERT INTO canopy_admission_inbox(id,header,form_values,form_versions,status,received_at,updated_at)
                   VALUES (%s,%s,%s,%s,'pending',%s,%s)
                   ON CONFLICT(id) DO UPDATE SET header=excluded.header,form_values=excluded.form_values,
                     form_versions=excluded.form_versions,status='pending',updated_at=excluded.updated_at""",
                (item["id"], Jsonb(item.get("header") or {}), Jsonb(values), Jsonb(versions), current, current),
            )
            received += 1
        # Cancelled in Canopy, or started at another Leaf of the ward.
        withdrawn = database.execute(
            """UPDATE canopy_admission_inbox SET status='withdrawn',updated_at=%s
               WHERE status='pending' AND NOT (id::text = ANY(%s)) RETURNING id""",
            (current, [str(item["id"]) for item in pending]),
        ).fetchall()
        for admission_id in payload.get("acknowledged") or []:
            database.execute(
                "UPDATE canopy_admission_inbox SET claim_acknowledged=true,updated_at=%s WHERE id::text=%s",
                (current, str(admission_id)),
            )
        # Form changes made in Canopy for cases running here.
        for item in payload.get("linked") or []:
            case = database.execute(
                "SELECT id,status FROM cases WHERE canopy_admission_id::text=%s", (str(item.get("admission_id")),)
            ).fetchone()
            if case is None or case["status"] == "archived":
                continue
            row = database.execute(
                "SELECT form_draft_json,field_versions FROM case_detail WHERE case_id=%s FOR UPDATE", (case["id"],)
            ).fetchone()
            old = form_sync.parse(row and row["form_draft_json"])
            values, versions, changed = form_sync.merge(
                old, (row or {}).get("field_versions") or {}, item.get("values") or {}, item.get("versions") or {})
            if not changed and row and versions == (row.get("field_versions") or {}):
                continue
            database.execute(
                """INSERT INTO case_detail(case_id,created_at,updated_at,form_draft_json,field_versions) VALUES (%s,%s,%s,%s,%s)
                   ON CONFLICT(case_id) DO UPDATE SET updated_at=excluded.updated_at,form_draft_json=excluded.form_draft_json,
                     field_versions=excluded.field_versions""",
                (case["id"], current, current, json.dumps(values), Jsonb(versions)),
            )
            if changed:
                case_audit(database, case["id"], "form.draft.canopy", old, values, SYNC_ACTOR)
                updated_forms += 1
                record_link.record_to_forms(database, case["id"], record_link.changed_record_keys((row or {}).get("field_versions"), versions))
        # Archived cases included in the outbox this exchange was built from have now reached Canopy.
        if isinstance(payload.get("outbox_built_at"), int):
            leaf_sync.set_state(database, "admissions.synced_at", payload["outbox_built_at"])
    started = auto_move_in(database, pending)
    requested = run_requests(database, payload.get("linked") or [])
    return {"ok": True, "received": received, "withdrawn": [str(row["id"]) for row in withdrawn],
            "updated_forms": updated_forms, "moved_in": started, "requests": requested}


def run_requests(database: Connection, linked: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Move out / discharge pressed at the Canopy ward desk for the case running here."""
    from .or_leaf import discharge_from_canopy, move_out_case
    results = []
    for item in linked:
        requests = item.get("requests") or {}
        if not requests:
            continue
        case = database.execute(
            "SELECT id, status, to_jsonb(cases) ->> 'or_stage' AS or_stage FROM cases WHERE canopy_admission_id::text=%s AND status='active'",
            (str(item.get("admission_id")),)).fetchone()
        if case is None:
            continue
        try:
            if requests.get("move_out") and case["or_stage"] in ("or", "or_recovery"):
                request = requests["move_out"]
                move_out_case(database, case["id"], {"username": str(request.get("by") or "canopy"), "role": "integration", "id": None},
                              int(request.get("at") or now_ms()))
                results.append({"admission_id": str(item["admission_id"]), "done": "move_out"})
            elif requests.get("discharge"):
                discharge_from_canopy(database, case["id"], requests["discharge"])
                results.append({"admission_id": str(item["admission_id"]), "done": "discharge"})
        except HTTPException as error:
            results.append({"admission_id": str(item["admission_id"]), "failed": str(error.detail)})
    return results


def auto_move_in(database: Connection, pending: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """The ward desk pressed Move in for a patient assigned to this bed: start the case now (at the requested
    time). Other active cases on this Leaf (other beds) do not hold it back."""
    from .cases_lifecycle import StartCase, start_case
    results = []
    for item in pending:
        session = (item.get("header") or {}).get("or_session") or {}
        requested = session.get("move_in_requested_at")
        if not requested:
            continue
        row = database.execute("SELECT status FROM canopy_admission_inbox WHERE id=%s", (item["id"],)).fetchone()
        if not row or row["status"] != "pending":
            continue
        actor = {"username": str(session.get("move_in_requested_by") or "canopy"), "role": "integration", "id": None}
        if session.get("stage") == "recovery":
            from .or_leaf import recovery_move_in
            try:
                result = recovery_move_in(database, str(item["id"]), actor, int(requested))
                results.append({"admission_id": str(item["id"]), "started": True, "case_id": result["case_id"]})
            except HTTPException as error:
                results.append({"admission_id": str(item["id"]), "started": False, "reason": str(error.detail)})
            continue
        try:
            response = start_case(StartCase(start_time=int(requested), admission_source="prepared",
                                            canopy_admission_id=str(item["id"]), overlap_policy="exclude"), actor, database)
        except HTTPException as error:
            results.append({"admission_id": str(item["id"]), "started": False, "reason": str(error.detail)})
            continue
        ok = isinstance(response, dict) and response.get("ok")
        results.append({"admission_id": str(item["id"]), "started": bool(ok), **({"case_id": response["case_id"]} if ok else {})})
    return results
