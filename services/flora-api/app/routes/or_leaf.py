"""Leaf: the OR-ward journey of a case started from an OR-schedule booking.

- In the OR room (or_stage 'or'): **Move out** closes the case here without discharging the patient
  (reason moved_out; drips keep running). The room is free for the next patient; Canopy holds the case
  until a recovery bed's Leaf moves the patient in.
- In recovery (or_stage 'recovery'): **Move in** takes the case over from the OR room's Leaf (same chart,
  start time kept) and **Discharge** ends the OR-ward stay with a destination.
Both can also be requested from the Canopy ward desk; the request arrives with the admission exchange.
"""
from __future__ import annotations

import os
from typing import Any

from fastapi import APIRouter, Body, Depends, HTTPException
from psycopg import Connection

from .. import case_handover
from ..database import connection
from .auth_leaf import now_ms, require_permission
from .cases_read import floor_minute

router = APIRouter(prefix="/api/case", tags=["or journey"])


def session_header(database: Connection, admission_id: Any) -> dict[str, Any]:
    if not admission_id:
        return {}
    row = database.execute("SELECT header FROM canopy_admission_inbox WHERE id::text=%s", (str(admission_id),)).fetchone()
    return ((row or {}).get("header") or {}).get("or_session") or {}


@router.get("/{case_id}/or-session")
def or_session(case_id: int, _: dict = Depends(require_permission("case.read")), database: Connection = Depends(connection)) -> dict:
    case = database.execute("SELECT id, status, canopy_admission_id, to_jsonb(cases) ->> 'or_stage' AS or_stage FROM cases WHERE id=%s",
                            (case_id,)).fetchone()
    if case is None:
        raise HTTPException(404, "case not found")
    session = session_header(database, case["canopy_admission_id"])
    return {"stage": case["or_stage"], "room_name": session.get("room_name"), "bed_name": session.get("bed_name")}


def move_out_case(database: Connection, case_id: int, actor: dict[str, Any], at: int | None = None,
                  record_event: bool = True) -> dict[str, Any]:
    """Patient out of the OR room: Patient Out on the timeline, the case closes here (moved_out)."""
    from .cases_lifecycle import editable_case
    from .clinical_write import write_event
    end = floor_minute(at) if at else now_ms()
    with database.transaction():
        case = editable_case(database, case_id)
        if case["status"] != "active":
            raise HTTPException(409, "the case is not active")
        if case.get("or_stage") not in ("or", "or_recovery"):
            raise HTTPException(409, "only a case in an OR room moves out; discharge it instead")
        if end < case["start_time"]:
            raise HTTPException(400, "move-out time is before the case started")
        if record_event:  # False when the nurse just recorded Patient Out on the chart
            write_event(database, case_id, {"title": "Patient Out", "event_ts": end, "event_type": "event",
                                            "detail": "Moved out of the OR room (to recovery)"}, actor)
        # Not a discharge: infusions keep running and continue on the recovery bed's Leaf.
        database.execute(
            """UPDATE cases SET status='discharged', discharge_time=%s, discharge_reason='moved_out', updated_at=%s WHERE id=%s""",
            (end, now_ms(), case_id))
    return {"ok": True, "case_id": case_id, "moved_out_at": end}


@router.post("/{case_id}/move-out")
def move_out(case_id: int, payload: dict = Body(default={}), actor: dict = Depends(require_permission("case.discharge")),
             database: Connection = Depends(connection)) -> dict:
    at = payload.get("at")
    return move_out_case(database, case_id, actor, int(at) if at else None, payload.get("record_event", True) is not False)


@router.post("/{case_id}/recover-here")
def recover_here(case_id: int, payload: dict = Body(default={}), actor: dict = Depends(require_permission("case.chart")),
                 database: Connection = Depends(connection)) -> dict:
    """Start Recovery recorded in the OR room and the patient recovers there: the case stays on this Leaf
    (Canopy shows Recovery). It can still move out to a recovery room later."""
    from ..clinical import case_audit
    from .cases_lifecycle import editable_case
    with database.transaction():
        case = editable_case(database, case_id)
        if case["status"] != "active" or case.get("or_stage") != "or":
            raise HTTPException(409, "only an active case in an OR room")
        database.execute("UPDATE cases SET or_stage='or_recovery', updated_at=%s WHERE id=%s", (now_ms(), case_id))
        case_audit(database, case_id, "or.recover_in_room", {"or_stage": "or"},
                   {"or_stage": "or_recovery", "at": payload.get("at")}, actor)
    return {"ok": True, "case_id": case_id, "stage": "or_recovery"}


def recovery_move_in(database: Connection, admission_id: str, actor: dict[str, Any], at: int | None = None) -> dict[str, Any]:
    """Patient in to this recovery bed: take the case over from the OR room's Leaf through Canopy."""
    from .clinical_write import write_event
    from .ward import canopy
    inbox = database.execute("SELECT * FROM canopy_admission_inbox WHERE id::text=%s", (admission_id,)).fetchone()
    session = ((inbox or {}).get("header") or {}).get("or_session") or {}
    if inbox is None or inbox["status"] != "pending" or session.get("stage") != "recovery" or not session.get("global_case_id"):
        raise HTTPException(409, "this patient is not waiting for this recovery bed")
    if database.execute("SELECT 1 FROM cases WHERE status='active' LIMIT 1").fetchone():
        raise HTTPException(409, "discharge the active case on this Leaf first")
    claim = canopy("POST", "/api/sync/v1/handover/claim", {
        "leaf_id": os.getenv("FLORA_LEAF_ID", ""), "global_case_id": session["global_case_id"], "move_devices": False,
        "actor": actor["username"], "admission_id": admission_id})
    current = now_ms()
    try:
        with database.transaction():
            database.execute("SELECT pg_advisory_xact_lock(6893, 1)")
            if database.execute("SELECT 1 FROM cases WHERE status='active' LIMIT 1").fetchone():
                raise HTTPException(409, "discharge the active case on this Leaf first")
            result = case_handover.import_case(database, claim["export"], from_leaf_id=claim["from_leaf_id"],
                                               global_case_id=session["global_case_id"], actor=actor["username"], now=current)
            case_id = result["case_id"]
            # The same case continues: still linked to its booking (pre-op forms keep syncing), now in recovery.
            database.execute(
                """UPDATE cases SET canopy_admission_id=%s, or_stage='recovery', discharge_time=NULL, discharge_reason=NULL
                   WHERE id=%s""", (inbox["id"], case_id))
            write_event(database, case_id, {"title": "Start Recovery", "event_ts": floor_minute(at) if at else current,
                                            "event_type": "event", "detail": " · ".join(filter(None, [session.get("room_name"), session.get("bed_name")])) or None},
                        actor)
            database.execute(
                "UPDATE canopy_admission_inbox SET status='claimed', case_id=%s, claim_acknowledged=true, updated_at=%s WHERE id=%s",
                (case_id, current, inbox["id"]))
    except Exception as error:
        try:
            canopy("POST", f"/api/sync/v1/handover/{claim['handover_id']}/cancel", {"reason": str(error)[:300]})
        except HTTPException:
            pass
        if isinstance(error, HTTPException):
            raise
        raise HTTPException(500, f"import failed, move-in cancelled: {error}") from None
    canopy("POST", f"/api/sync/v1/handover/{claim['handover_id']}/imported", {"to_case_id": result["case_id"]})
    return {"ok": True, "case_id": result["case_id"], "handover_id": claim["handover_id"]}


@router.post("/or-recovery/{admission_id}/move-in")
def move_in_recovery(admission_id: str, actor: dict = Depends(require_permission("case.create")),
                     database: Connection = Depends(connection)) -> dict:
    return recovery_move_in(database, admission_id, actor)


def discharge_from_canopy(database: Connection, case_id: int, request: dict[str, Any]) -> bool:
    """Discharge out of the OR ward pressed at the Canopy ward desk."""
    from .cases_lifecycle import Discharge, discharge
    actor = {"username": str(request.get("by") or "canopy"), "role": "integration", "id": None}
    discharge(Discharge(case_id=case_id, discharge_time=int(request.get("at") or now_ms()),
                        destination=request.get("destination"), destination_note=request.get("note")), actor, database)
    return True

