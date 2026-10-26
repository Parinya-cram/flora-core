"""Leaf: the OR-ward journey of a case started from an OR-schedule booking.

- In the OR room (or_stage 'or'): **Transfer to Recovery** closes the case here (reason transferred): its
  chart ends and prints as the Anesthesia Report; running infusions stop on this chart at the transfer time
  (the recovery chart shows them under Patient Journey). The room is free for the next patient.
- In recovery: **Receive transfer** starts a new case for the same booking (or_stage 'recovery', the
  Post-Anesthesia chart) and **Discharge** ends the OR-ward stay with a destination.
- billing_mode chosen at transfer: Canopy shows the OR and Recovery billing orders as one bill ('combined')
  or as two ('separate').
Both can also be requested from the Canopy ward desk; the request arrives with the admission exchange.
"""
from __future__ import annotations

import os
from typing import Any

from fastapi import APIRouter, Body, Depends, HTTPException
from psycopg import Connection

from .. import case_bindings, case_handover
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
                  record_event: bool = True, billing_mode: str | None = None, note: str | None = None) -> dict[str, Any]:
    """Transfer to Recovery: Patient Out on the timeline and the OR case closes here (transferred)."""
    from .cases_lifecycle import editable_case, stop_drips
    from .clinical_write import write_event
    if billing_mode not in (None, "combined", "separate"):
        raise HTTPException(400, "billing_mode is combined or separate")
    end = floor_minute(at) if at else now_ms()
    with database.transaction():
        case = editable_case(database, case_id)
        if case["status"] != "active":
            raise HTTPException(409, "the case is not active")
        if case.get("or_stage") not in ("or", "or_recovery"):
            raise HTTPException(409, "only a case in an OR room is transferred to recovery; discharge it instead")
        if end < case["start_time"]:
            raise HTTPException(400, "transfer time is before the case started")
        if record_event:  # False when the nurse just recorded Patient Out on the chart
            write_event(database, case_id, {"title": "Patient Out", "event_ts": end, "event_type": "event",
                                            "detail": "Transfer to recovery"}, actor)
        # The Anesthesia Report ends here: infusions stop on this chart at the transfer time and are
        # restarted on the recovery chart (its Patient Journey lists what was running).
        stopped = stop_drips(database, case_id, end, actor)
        database.execute(
            """UPDATE cases SET status='discharged', discharge_time=%s, discharge_reason='transferred',
                 discharge_destination='recovery', discharge_note=%s, updated_at=%s WHERE id=%s""",
            (end, (note or "").strip()[:500] or None, now_ms(), case_id))
        if billing_mode:
            database.execute(
                """UPDATE cases SET admission_metadata = coalesce(admission_metadata::text, '{}')::jsonb
                     || jsonb_build_object('transfer_billing_mode', %s::text) WHERE id=%s""", (billing_mode, case_id))
        case_bindings.release(database, case_id, "discharged")
    return {"ok": True, "case_id": case_id, "moved_out_at": end, "stopped_drips": stopped}


@router.post("/{case_id}/move-out")
def move_out(case_id: int, payload: dict = Body(default={}), actor: dict = Depends(require_permission("case.discharge")),
             database: Connection = Depends(connection)) -> dict:
    at = payload.get("at")
    return move_out_case(database, case_id, actor, int(at) if at else None, payload.get("record_event", True) is not False,
                         payload.get("billing_mode"), payload.get("note"))


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
    """Receive the transfer on this recovery bed: a new case (the Post-Anesthesia chart) starts for the
    booking. The OR room's case stays closed on its own Leaf (the Anesthesia Report)."""
    from .cases_lifecycle import StartCase, start_case
    inbox = database.execute("SELECT * FROM canopy_admission_inbox WHERE id::text=%s", (admission_id,)).fetchone()
    session = ((inbox or {}).get("header") or {}).get("or_session") or {}
    if inbox is None or inbox["status"] != "pending" or session.get("stage") != "recovery":
        raise HTTPException(409, "this patient is not waiting for this recovery bed")
    response = start_case(StartCase(start_time=int(at or now_ms()), admission_source="prepared",
                                    canopy_admission_id=admission_id, overlap_policy="exclude"), actor, database)
    if not (isinstance(response, dict) and response.get("ok")):
        raise HTTPException(409, "the recovery case could not start")
    return {"ok": True, "case_id": response["case_id"]}


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

