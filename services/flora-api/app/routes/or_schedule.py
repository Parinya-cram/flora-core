"""Canopy → OR schedule: book patients into OR rooms (room × time grid), the day list and status board,
and the OR master data (room types, OR types, equipment). See app/or_journey.py.

A session is a Canopy admission with booking fields, so pre-op forms, Leaf delivery and HL7 keep working.
Writes live under /api/fleet/admissions (the ward desk's write area) and /api/fleet/control (master data).
"""
from __future__ import annotations

import re
import uuid
from typing import Any, Literal

from fastapi import APIRouter, Body, Depends, HTTPException, Query
from psycopg import Connection
from psycopg.types.json import Jsonb
from pydantic import BaseModel, Field

from .. import case_transfer, directory, or_journey, staff_sync
from ..or_sessions import record_event
from ..database import connection
from .canopy_admissions import DetailsInput, PatientInput, _allowed
from .canopy_preferences import require_canopy_permission
from .canopy_users import ward_scope

router = APIRouter(tags=["or schedule"])
booker = require_canopy_permission("or.schedule")
mover = require_canopy_permission("or.journey")
master = require_canopy_permission("config.manage")
CODE = re.compile(r"^[a-z][a-z0-9_]{0,39}\Z")
POSITIONS = ["Supine", "Prone", "Lateral", "Lithotomy", "Sitting / beach chair", "Trendelenburg", "Reverse Trendelenburg"]
TECHNIQUES = ["GA", "LA", "MAC", "Spinal", "Epidural", "CSE", "Regional block", "Sedation"]


class SessionDetails(DetailsInput):
    position: str | None = Field(default=None, max_length=60)
    source_ward: str | None = Field(default=None, max_length=120)
    post_op_ward: str | None = Field(default=None, max_length=120)
    emergency: bool = False


class SessionInput(BaseModel):
    room_location_id: int
    scheduled_at: int = Field(gt=0)
    duration_min: int = Field(default=or_journey.DEFAULT_DURATION_MIN, ge=5, le=1440)
    hn: str = Field(min_length=1, max_length=128)
    admission_number: str | None = Field(default=None, max_length=80)
    patient: PatientInput
    admission: SessionDetails = Field(default_factory=SessionDetails)
    or_type_code: str | None = Field(default=None, max_length=40)
    equipment: list[str] = Field(default_factory=list, max_length=60)
    team: list[dict[str, Any]] = Field(default_factory=list, max_length=30)
    note: str | None = Field(default=None, max_length=2000)


class SlotInput(BaseModel):
    room_location_id: int | None = None
    scheduled_at: int | None = Field(default=None, gt=0)
    duration_min: int | None = Field(default=None, ge=5, le=1440)


# ---------------------------------------------------------------- helpers

def room_row(database: Connection, room_id: int) -> dict[str, Any]:
    row = database.execute(
        """SELECT room.id, room.name, room.room_type, room.or_type_code, unit.id::text AS unit_key, unit.name AS unit_name
           FROM canopy_location room JOIN canopy_location unit ON unit.id = room.parent_id AND unit.kind = 'care_unit'
           WHERE room.id = %s AND room.kind = 'room'""", (room_id,)).fetchone()
    if row is None:
        raise HTTPException(400, "unknown room")
    return row


SESSION_SELECT = """
    SELECT a.*, room.name AS room_name, unit.name AS unit_name, bed.name AS bed_name,
           coalesce(nullif(leaf.canopy_display_name,''), leaf.display_name) AS current_leaf_name
    FROM canopy_admission a
    LEFT JOIN canopy_location room ON room.id = a.room_location_id
    LEFT JOIN canopy_location unit ON unit.id::text = a.unit_key
    LEFT JOIN canopy_location bed ON bed.id = a.current_bed_location_id
    LEFT JOIN sync_leaf_node leaf ON leaf.leaf_id = coalesce(a.current_leaf_id, a.claimed_leaf_id, a.target_leaf_id)"""


def public(row: dict[str, Any], staff_names: dict[str, str] | None = None) -> dict[str, Any]:
    values = row.get("form_values") or {}
    team = [{**member, "name": member.get("name") or (staff_names or {}).get(str(member.get("staff_code") or "").lower())}
            for member in row.get("team") or []]
    return {
        "id": str(row["id"]), "unitKey": row["unit_key"], "unitName": row.get("unit_name"),
        "roomId": row.get("room_location_id"), "roomName": row.get("room_name"),
        "scheduledAt": row.get("scheduled_at"), "durationMin": or_journey.snap_duration(row.get("duration_min")),
        "hn": row["hn"], "admissionNumber": row.get("admission_number"), "patient": row.get("patient") or {},
        "admission": row.get("admission") or {}, "orTypeCode": row.get("or_type_code"),
        "equipment": row.get("equipment") or [], "team": team, "note": row.get("note"),
        "journeyState": row["journey_state"], "stateLabel": or_journey.LABEL.get(row["journey_state"]),
        "status": row["status"], "caseStatus": row.get("case_status"), "source": row.get("source") or "canopy",
        "bedName": row.get("bed_name"), "leafName": row.get("current_leaf_name"),
        "movedInAt": row.get("moved_in_at"), "movedOutAt": row.get("moved_out_at"), "dischargedAt": row.get("discharged_at"),
        "dischargeDestination": row.get("discharge_destination"),
        "targetLeafId": row.get("target_leaf_id"), "bedId": row.get("current_bed_location_id"),
        "moveInRequestedAt": row.get("move_in_requested_at"), "moveInRequestedBy": row.get("move_in_requested_by"),
        "moveOutRequestedAt": row.get("move_out_requested_at"), "dischargeRequestedAt": row.get("discharge_requested_at"),
        "recoveryInAt": row.get("recovery_in_at"), "dischargeNote": row.get("discharge_note"),
        "billingMode": row.get("billing_mode") or "combined",
        "orGlobalCaseId": str(row["or_global_case_id"]) if row.get("or_global_case_id") else None,
        "globalCaseId": str(row["global_case_id"]) if row.get("global_case_id") else None,
        "preopFilled": any(value not in (None, "", [], {}) for value in values.values()),
        "updatedAt": row.get("updated_at"), "updatedBy": row.get("updated_by") or row.get("created_by"),
    }


def staff_name_map(database: Connection, rows: list[dict[str, Any]]) -> dict[str, str]:
    codes = sorted({code for row in rows for code in or_journey.team_codes(row)})
    if not codes:
        return {}
    found = database.execute("SELECT lower(staff_code) AS code, staff_name FROM staff_directory WHERE lower(staff_code) = ANY(%s)",
                             (codes,)).fetchall()
    return {row["code"]: row["staff_name"] for row in found}


def load(database: Connection, session_id: str, scope: list[str] | None, lock: bool = False) -> dict[str, Any]:
    try:
        uuid.UUID(session_id)
    except ValueError:
        raise HTTPException(404, "session not found") from None
    if lock:
        database.execute("SELECT 1 FROM canopy_admission WHERE id=%s FOR UPDATE", (session_id,))
    row = database.execute(f"{SESSION_SELECT} WHERE a.id=%s", (session_id,)).fetchone()
    if row is None:
        raise HTTPException(404, "session not found")
    _allowed(scope, row["unit_key"])
    return row


def one(database: Connection, session_id: str, scope: list[str] | None) -> dict[str, Any]:
    row = load(database, session_id, scope)
    return public(row, staff_name_map(database, [row]))


def check_codes(database: Connection, or_type: str | None, equipment: list[str]) -> list[str]:
    if or_type and not database.execute("SELECT 1 FROM canopy_or_type WHERE code=%s", (or_type,)).fetchone():
        raise HTTPException(400, f"unknown OR type '{or_type}'")
    clean = list(dict.fromkeys(code.strip() for code in equipment if code.strip()))
    known = {row["code"] for row in database.execute("SELECT code FROM canopy_or_equipment WHERE code = ANY(%s)", (clean,)).fetchall()}
    unknown = [code for code in clean if code not in known]
    if unknown:
        raise HTTPException(400, f"unknown equipment: {', '.join(unknown)}")
    return clean


# A bed's Leaf: the Leaf assigned to it, or the Leaf that serves it as a further bed (canopy_leaf_bed).
BED_LEAF_JOIN = """LEFT JOIN canopy_leaf_assignment assignment ON assignment.bed_location_id = bed.id
           LEFT JOIN canopy_leaf_bed leaf_bed ON leaf_bed.bed_location_id = bed.id"""


def bed_cases(database: Connection, beds: list[dict[str, Any]]) -> dict[int, dict[str, Any]]:
    """Newest active case per bed id. A Leaf serving one bed: any active case. A Leaf serving several beds:
    the case goes to the bed whose name or code matches its bed_label, else to the Leaf's primary bed."""
    leaf_ids = list({bed["leaf_id"] for bed in beds if bed.get("leaf_id")})
    if not leaf_ids:
        return {}
    served: dict[str, list[dict[str, Any]]] = {}
    for row in database.execute(
            """SELECT a.leaf_id, a.bed_location_id AS bed_id, true AS is_primary, b.name, b.code
               FROM canopy_leaf_assignment a JOIN canopy_location b ON b.id = a.bed_location_id WHERE a.leaf_id = ANY(%s)
               UNION ALL
               SELECT lb.leaf_id, lb.bed_location_id, false, b.name, b.code
               FROM canopy_leaf_bed lb JOIN canopy_location b ON b.id = lb.bed_location_id WHERE lb.leaf_id = ANY(%s)""",
            (leaf_ids, leaf_ids)).fetchall():
        served.setdefault(row["leaf_id"], []).append(row)
    result: dict[int, dict[str, Any]] = {}
    for case in database.execute(
            """SELECT leaf_id, hn, case_code, snapshot->'case'->>'bed_label' AS bed_label FROM sync_case_index
               WHERE status = 'ACTIVE' AND leaf_id = ANY(%s) ORDER BY start_time DESC NULLS LAST""", (leaf_ids,)).fetchall():
        own = served.get(case["leaf_id"]) or []
        if len(own) > 1:
            label = (case["bed_label"] or "").strip().lower()
            match = [bed for bed in own if label and label in ((bed["name"] or "").strip().lower(), (bed["code"] or "").strip().lower())]
            match = match or [bed for bed in own if bed["is_primary"]]
            bed_ids = [bed["bed_id"] for bed in match[:1]]
        else:
            bed_ids = [bed["id"] for bed in beds if bed.get("leaf_id") == case["leaf_id"]]
        for bed_id in bed_ids:
            result.setdefault(bed_id, {"leaf_id": case["leaf_id"], "hn": case["hn"], "case_code": case["case_code"]})
    return result


def day_conflicts(database: Connection, session: dict[str, Any]) -> list[dict[str, Any]]:
    window = or_journey.span(session)
    if not window:
        return []
    rows = database.execute(
        """SELECT id, room_location_id, scheduled_at, duration_min, team, journey_state, hn FROM canopy_admission
           WHERE scheduled_at < %s AND scheduled_at > %s - 86400000 AND journey_state = ANY(%s)""",
        (window[1], window[0], list(or_journey.OPEN_STATES))).fetchall()
    found = or_journey.conflicts([*[r for r in rows if str(r["id"]) != str(session["id"])], session]).get(str(session["id"]), [])
    return found


# ---------------------------------------------------------------- read

@router.get("/api/fleet/admissions/or/options")
def options(scope: list[str] | None = Depends(ward_scope), database: Connection = Depends(connection)) -> dict[str, Any]:
    wards = [ward for ward in directory.ward_options(database)["rows"] if scope is None or ward["key"] in scope]
    return {
        "wards": wards,
        "orTypes": [dict(row) for row in database.execute("SELECT * FROM canopy_or_type ORDER BY sort_order, name").fetchall()],
        "equipment": [dict(row) for row in database.execute("SELECT * FROM canopy_or_equipment ORDER BY group_name NULLS LAST, sort_order, name").fetchall()],
        "roles": staff_sync.roles(database), "positions": POSITIONS, "techniques": TECHNIQUES,
        "slotMinutes": or_journey.SLOT_MIN, "stateLabels": or_journey.LABEL,
    }


@router.get("/api/fleet/admissions/or/day")
def day(from_ts: int = Query(alias="from", gt=0), to_ts: int = Query(alias="to", gt=0), unit_key: str = Query(min_length=1),
        scope: list[str] | None = Depends(ward_scope), database: Connection = Depends(connection)) -> dict[str, Any]:
    """Rooms of a ward (OR rooms first) with their beds / Leafs, the sessions in [from, to), the ward's sessions
    without a room or time, and overlap warnings."""
    _allowed(scope, unit_key)
    rooms = database.execute(
        """SELECT room.id, room.name, room.room_type, room.or_type_code, room.sort_order, room.zone
           FROM canopy_location room WHERE room.parent_id::text = %s AND room.kind = 'room' AND room.is_active
           ORDER BY CASE room.room_type WHEN 'or' THEN 0 WHEN 'recovery' THEN 1 ELSE 2 END, room.sort_order, room.name""",
        (unit_key,)).fetchall()
    beds = database.execute(
        f"""SELECT bed.id, bed.name, bed.parent_id, coalesce(assignment.leaf_id, leaf_bed.leaf_id) AS leaf_id,
                  coalesce(nullif(leaf.canopy_display_name,''), leaf.display_name) AS leaf_name
           FROM canopy_location bed
           {BED_LEAF_JOIN}
           LEFT JOIN sync_leaf_node leaf ON leaf.leaf_id = coalesce(assignment.leaf_id, leaf_bed.leaf_id)
           WHERE bed.kind = 'bed' AND bed.is_active AND bed.parent_id = ANY(%s) ORDER BY bed.sort_order, bed.name""",
        ([room["id"] for room in rooms],)).fetchall()
    sessions = database.execute(
        f"""{SESSION_SELECT} WHERE a.unit_key = %s AND a.scheduled_at >= %s AND a.scheduled_at < %s
            ORDER BY a.scheduled_at, a.created_at""", (unit_key, from_ts, to_ts)).fetchall()
    unscheduled = database.execute(
        f"""{SESSION_SELECT} WHERE a.unit_key = %s AND a.journey_state = 'booked'
              AND (a.room_location_id IS NULL OR a.scheduled_at IS NULL) ORDER BY a.created_at DESC LIMIT 200""",
        (unit_key,)).fetchall()
    names = staff_name_map(database, [*sessions, *unscheduled])
    # Overlaps also count sessions in other wards (a surgeon booked twice) within the day.
    others = database.execute(
        """SELECT id, room_location_id, scheduled_at, duration_min, team, journey_state FROM canopy_admission
           WHERE unit_key <> %s AND scheduled_at >= %s - 86400000 AND scheduled_at < %s""", (unit_key, from_ts, to_ts)).fetchall()
    warn = or_journey.conflicts([*sessions, *others])
    busy = bed_cases(database, beds)
    return {
        "rooms": [{**dict(room), "beds": [{**dict(bed), "active_case": busy.get(bed["id"])}
                                          for bed in beds if bed["parent_id"] == room["id"]]} for room in rooms],
        "sessions": [{**public(row, names), "conflicts": warn.get(str(row["id"]), [])} for row in sessions],
        "unscheduled": [public(row, names) for row in unscheduled],
        "now": directory.now_ms(),
    }


@router.get("/api/fleet/admissions/or/sessions/{session_id}")
def get_session(session_id: str, scope: list[str] | None = Depends(ward_scope),
                database: Connection = Depends(connection)) -> dict[str, Any]:
    row = load(database, session_id, scope)
    events = database.execute(
        """SELECT e.event, e.at, e.source, e.actor, e.detail, e.leaf_id, loc.name AS location_name
           FROM canopy_session_event e LEFT JOIN canopy_location loc ON loc.id = e.location_id
           WHERE e.admission_id = %s ORDER BY e.id""", (session_id,)).fetchall()  # the order things happened
    return {"row": {**public(row, staff_name_map(database, [row])), "conflicts": day_conflicts(database, row)},
            "events": [dict(event) for event in events]}


# ---------------------------------------------------------------- booking

def booking_values(database: Connection, payload: SessionInput) -> tuple[dict[str, Any], dict[str, Any]]:
    room = room_row(database, payload.room_location_id)
    values = {
        "unit_key": room["unit_key"], "room_location_id": room["id"], "hn": payload.hn.strip(),
        "admission_number": (payload.admission_number or "").strip() or None,
        "patient": Jsonb(payload.patient.model_dump()), "admission": Jsonb(payload.admission.model_dump()),
        "scheduled_at": or_journey.snap(payload.scheduled_at), "duration_min": or_journey.snap_duration(payload.duration_min),
        "or_type_code": payload.or_type_code or room.get("or_type_code"),
        "equipment": Jsonb(check_codes(database, payload.or_type_code, payload.equipment)),
        "team": Jsonb(or_journey.normalize_team(payload.team)), "note": payload.note,
    }
    return values, room


@router.post("/api/fleet/admissions/or/sessions")
def create_session(payload: SessionInput, user: dict = Depends(booker), scope: list[str] | None = Depends(ward_scope),
                   database: Connection = Depends(connection)) -> dict[str, Any]:
    values, room = booking_values(database, payload)
    _allowed(scope, room["unit_key"])
    current = directory.now_ms()
    session_id = uuid.uuid4()
    with database.transaction():
        columns = list(values) + ["id", "journey_state", "created_by", "updated_by", "created_at", "updated_at"]
        database.execute(
            f"INSERT INTO canopy_admission ({', '.join(columns)}) VALUES ({', '.join(['%s'] * len(columns))})",
            (*values.values(), session_id, "booked", user["username"], user["username"], current, current))
        record_event(database, session_id, "booked", actor=user["username"], location_id=room["id"],
                     detail={"scheduled_at": values["scheduled_at"], "duration_min": values["duration_min"]})
    row = load(database, str(session_id), scope)
    return {"row": {**public(row, staff_name_map(database, [row])), "conflicts": day_conflicts(database, row)}}


@router.put("/api/fleet/admissions/or/sessions/{session_id}")
def update_session(session_id: str, payload: SessionInput, user: dict = Depends(booker),
                   scope: list[str] | None = Depends(ward_scope), database: Connection = Depends(connection)) -> dict[str, Any]:
    values, room = booking_values(database, payload)
    _allowed(scope, room["unit_key"])
    with database.transaction():
        row = load(database, session_id, scope, lock=True)
        if row["journey_state"] not in or_journey.OPEN_STATES:
            raise HTTPException(409, f"the session is {or_journey.LABEL[row['journey_state']]}; it cannot be changed")
        if row["status"] != "pending":
            # The Leaf runs the case: patient and procedure are edited there; the booking (team, equipment, time) stays here.
            for key in ("hn", "admission_number", "patient", "admission"):
                values.pop(key)
        if row["status"] != "pending" and room["id"] != row["room_location_id"]:
            raise HTTPException(409, "the patient is already in a room; move them with the journey actions")
        database.execute(f"UPDATE canopy_admission SET {', '.join(f'{key}=%s' for key in values)}, updated_by=%s, updated_at=%s WHERE id=%s",
                         (*values.values(), user["username"], directory.now_ms(), session_id))
        record_event(database, session_id, "updated", actor=user["username"], location_id=room["id"],
                     detail={"scheduled_at": values["scheduled_at"], "duration_min": values["duration_min"]})
    row = load(database, session_id, scope)
    return {"row": {**public(row, staff_name_map(database, [row])), "conflicts": day_conflicts(database, row)}}


@router.put("/api/fleet/admissions/or/sessions/{session_id}/slot")
def move_slot(session_id: str, payload: SlotInput, user: dict = Depends(booker),
              scope: list[str] | None = Depends(ward_scope), database: Connection = Depends(connection)) -> dict[str, Any]:
    """Drag on the grid: another room and/or start time, or a longer / shorter booking (overrun)."""
    with database.transaction():
        row = load(database, session_id, scope, lock=True)
        if row["journey_state"] not in or_journey.OPEN_STATES:
            raise HTTPException(409, f"the session is {or_journey.LABEL[row['journey_state']]}; it cannot be moved")
        changes: dict[str, Any] = {}
        if payload.room_location_id is not None and payload.room_location_id != row["room_location_id"]:
            if row["journey_state"] not in ("booked", "assigned"):
                raise HTTPException(409, "the patient is already in a room; move them with the journey actions")
            room = room_row(database, payload.room_location_id)
            if room["unit_key"] != row["unit_key"]:
                raise HTTPException(400, "the room is in another ward")
            changes["room_location_id"] = room["id"]
        if payload.scheduled_at is not None:
            if row["journey_state"] not in ("booked", "assigned"):
                raise HTTPException(409, "the case has started; only its duration can change")
            changes["scheduled_at"] = or_journey.snap(payload.scheduled_at)
        if payload.duration_min is not None:
            changes["duration_min"] = or_journey.snap_duration(payload.duration_min)
        if changes:
            database.execute(f"UPDATE canopy_admission SET {', '.join(f'{key}=%s' for key in changes)}, updated_by=%s, updated_at=%s WHERE id=%s",
                             (*changes.values(), user["username"], directory.now_ms(), session_id))
            record_event(database, session_id, "rescheduled", actor=user["username"],
                         location_id=changes.get("room_location_id", row["room_location_id"]), detail=changes)
    row = load(database, session_id, scope)
    return {"row": {**public(row, staff_name_map(database, [row])), "conflicts": day_conflicts(database, row)}}


@router.post("/api/fleet/admissions/or/sessions/{session_id}/close")
def close_session(session_id: str, payload: dict = Body(default={}), user: dict = Depends(booker),
                  scope: list[str] | None = Depends(ward_scope), database: Connection = Depends(connection)) -> dict[str, Any]:
    """Before the patient arrives: cancelled, postponed, no_show or miscreate (booked by mistake), with a reason.
    The admission is withdrawn from the Leaf."""
    state = str(payload.get("state") or "cancelled")
    if state not in or_journey.CLOSED_STATES:
        raise HTTPException(400, f"state is one of {', '.join(or_journey.CLOSED_STATES)}")
    with database.transaction():
        row = load(database, session_id, scope, lock=True)
        # Still before arrival on the board. A case a Leaf opened without moving in through the schedule
        # (status 'started', journey still booked/assigned) can be closed too; that case stays on its Leaf.
        if row["status"] not in ("pending", "started", "cancelled"):
            raise HTTPException(409, "this session cannot be closed here")
        try:
            or_journey.check_transition(row["journey_state"], state)
        except or_journey.TransitionError as error:
            raise HTTPException(409, str(error)) from None
        database.execute(
            """UPDATE canopy_admission SET journey_state=%s, status='cancelled', target_leaf_id=NULL, current_bed_location_id=NULL,
                 move_in_requested_at=NULL, updated_by=%s, updated_at=%s WHERE id=%s""",
            (state, user["username"], directory.now_ms(), session_id))
        record_event(database, session_id, state, actor=user["username"],
                     detail={"reason": str(payload.get("reason") or "")[:300], "scheduled_at": row["scheduled_at"]})
    return {"row": one(database, session_id, scope)}


@router.post("/api/fleet/admissions/or/sessions/{session_id}/cancel")
def cancel_session(session_id: str, payload: dict = Body(default={}), user: dict = Depends(booker),
                   scope: list[str] | None = Depends(ward_scope), database: Connection = Depends(connection)) -> dict[str, Any]:
    return close_session(session_id, {**payload, "state": "cancelled"}, user, scope, database)


@router.post("/api/fleet/admissions/or/sessions/{session_id}/restore")
def restore_session(session_id: str, user: dict = Depends(booker), scope: list[str] | None = Depends(ward_scope),
                    database: Connection = Depends(connection)) -> dict[str, Any]:
    with database.transaction():
        row = load(database, session_id, scope, lock=True)
        if row["journey_state"] not in or_journey.CLOSED_STATES:
            raise HTTPException(409, "only a cancelled, postponed, no-show or miscreated session can be booked again")
        database.execute(
            """UPDATE canopy_admission SET journey_state='booked',
                 status=CASE WHEN claimed_leaf_id IS NULL THEN 'pending' ELSE status END, updated_by=%s, updated_at=%s WHERE id=%s""",
            (user["username"], directory.now_ms(), session_id))
        record_event(database, session_id, "restored", actor=user["username"])
    return {"row": one(database, session_id, scope)}


# ---------------------------------------------------------------- journey (ward desk)

class AssignInput(BaseModel):
    bed_location_id: int


@router.post("/api/fleet/admissions/or/sessions/{session_id}/assign")
def assign_bed(session_id: str, payload: AssignInput, user: dict = Depends(mover), scope: list[str] | None = Depends(ward_scope),
               database: Connection = Depends(connection)) -> dict[str, Any]:
    """Receive the patient: assign an OR bed. Its Leaf then lists the patient as waiting to move in."""
    with database.transaction():
        row = load(database, session_id, scope, lock=True)
        if row["journey_state"] not in ("booked", "assigned"):
            raise HTTPException(409, f"the session is {or_journey.LABEL[row['journey_state']]}; a bed is assigned before the patient moves in")
        bed = database.execute(
            f"""SELECT bed.id, bed.name, room.id AS room_id, room.room_type, room.parent_id::text AS unit_key,
                      coalesce(assignment.leaf_id, leaf_bed.leaf_id) AS leaf_id
               FROM canopy_location bed JOIN canopy_location room ON room.id = bed.parent_id
               {BED_LEAF_JOIN}
               WHERE bed.id = %s AND bed.kind = 'bed'""", (payload.bed_location_id,)).fetchone()
        if bed is None or bed["unit_key"] != row["unit_key"]:
            raise HTTPException(400, "the bed is not in this ward")
        if not bed["leaf_id"]:
            raise HTTPException(409, f"{bed['name']} has no Leaf; assign a Leaf to the bed under Infrastructure first")
        if bed["room_type"] == "recovery":
            raise HTTPException(409, "this is a recovery bed; the patient goes there after the OR")
        database.execute(
            """UPDATE canopy_admission SET journey_state='assigned', target_leaf_id=%s, current_bed_location_id=%s, room_location_id=%s,
                 updated_by=%s, updated_at=%s WHERE id=%s""",
            (bed["leaf_id"], bed["id"], bed["room_id"], user["username"], directory.now_ms(), session_id))
        record_event(database, session_id, "assigned", actor=user["username"], location_id=bed["id"], leaf_id=bed["leaf_id"])
    busy = bed_cases(database, [bed]).get(bed["id"])
    return {"row": one(database, session_id, scope),
            "warning": f"{bed['name']} still has an active case (HN {busy['hn']}); it must move out first" if busy else None}


@router.post("/api/fleet/admissions/or/sessions/{session_id}/unassign")
def unassign_bed(session_id: str, user: dict = Depends(mover), scope: list[str] | None = Depends(ward_scope),
                 database: Connection = Depends(connection)) -> dict[str, Any]:
    with database.transaction():
        row = load(database, session_id, scope, lock=True)
        if row["journey_state"] != "assigned" or row["status"] != "pending":
            raise HTTPException(409, "only a waiting patient can be unassigned")
        database.execute(
            """UPDATE canopy_admission SET journey_state='booked', target_leaf_id=NULL, current_bed_location_id=NULL,
                 move_in_requested_at=NULL, updated_by=%s, updated_at=%s WHERE id=%s""", (user["username"], directory.now_ms(), session_id))
        record_event(database, session_id, "unassigned", actor=user["username"])
    return {"row": one(database, session_id, scope)}


@router.post("/api/fleet/admissions/or/sessions/{session_id}/move-in")
def request_move_in(session_id: str, user: dict = Depends(mover), scope: list[str] | None = Depends(ward_scope),
                    database: Connection = Depends(connection)) -> dict[str, Any]:
    """Patient move in, pressed at the ward desk: the bed's Leaf starts the case at its next sync."""
    with database.transaction():
        row = load(database, session_id, scope, lock=True)
        if row["journey_state"] not in ("assigned", "assigned_recovery") or not row["target_leaf_id"]:
            raise HTTPException(409, "assign a bed first")
        current = directory.now_ms()
        database.execute("UPDATE canopy_admission SET move_in_requested_at=%s, move_in_requested_by=%s, updated_at=%s WHERE id=%s",
                         (current, user["username"], current, session_id))
        record_event(database, session_id, "move_in_requested", actor=user["username"], location_id=row["current_bed_location_id"],
                     leaf_id=row["target_leaf_id"])
    return {"row": one(database, session_id, scope)}


class TransferInput(BaseModel):
    # One bill for OR + Recovery in Canopy billing, or two separate bills.
    billing_mode: Literal["combined", "separate"] | None = None


@router.post("/api/fleet/admissions/or/sessions/{session_id}/move-out")
def request_move_out(session_id: str, payload: TransferInput | None = None, user: dict = Depends(mover),
                     scope: list[str] | None = Depends(ward_scope), database: Connection = Depends(connection)) -> dict[str, Any]:
    """Transfer to Recovery, pressed at the ward desk: the room's Leaf closes its case (Anesthesia Report);
    the recovery bed's Leaf starts a new Post-Anesthesia case later."""
    with database.transaction():
        row = load(database, session_id, scope, lock=True)
        in_or_room = row["journey_state"] == "in_or" or (row["journey_state"] == "in_recovery" and database.execute(
            """SELECT 1 FROM canopy_location bed JOIN canopy_location room ON room.id = bed.parent_id
               WHERE bed.id = %s AND room.room_type = 'or'""", (row["current_bed_location_id"],)).fetchone() is not None)
        if not in_or_room:
            raise HTTPException(409, "only a patient in the OR room can be transferred to recovery")
        current = directory.now_ms()
        billing_mode = payload.billing_mode if payload else None
        database.execute(
            """UPDATE canopy_admission SET move_out_requested_at=%s, move_out_requested_by=%s,
                 billing_mode=coalesce(%s, billing_mode), updated_at=%s WHERE id=%s""",
            (current, user["username"], billing_mode, current, session_id))
        record_event(database, session_id, "transfer_requested", actor=user["username"], leaf_id=row["current_leaf_id"],
                     location_id=row["current_bed_location_id"], detail={"billing_mode": billing_mode} if billing_mode else None)
    return {"row": one(database, session_id, scope)}


@router.post("/api/fleet/admissions/or/sessions/{session_id}/billing-mode")
def set_billing_mode(session_id: str, payload: TransferInput, user: dict = Depends(mover),
                     scope: list[str] | None = Depends(ward_scope), database: Connection = Depends(connection)) -> dict[str, Any]:
    """Combine the OR and Recovery billing orders into one bill, or keep them separate (any time)."""
    if payload.billing_mode is None:
        raise HTTPException(400, "billing_mode is combined or separate")
    with database.transaction():
        load(database, session_id, scope, lock=True)
        database.execute("UPDATE canopy_admission SET billing_mode=%s, updated_by=%s, updated_at=%s WHERE id=%s",
                         (payload.billing_mode, user["username"], directory.now_ms(), session_id))
        record_event(database, session_id, "billing_mode", actor=user["username"], detail={"billing_mode": payload.billing_mode})
    return {"row": one(database, session_id, scope)}


@router.post("/api/fleet/admissions/or/sessions/{session_id}/assign-recovery")
def assign_recovery(session_id: str, payload: AssignInput, user: dict = Depends(mover), scope: list[str] | None = Depends(ward_scope),
                    database: Connection = Depends(connection)) -> dict[str, Any]:
    """After the OR: a recovery bed. Its Leaf lists the patient; receiving the transfer starts a new
    (Post-Anesthesia) case there."""
    with database.transaction():
        row = load(database, session_id, scope, lock=True)
        if row["journey_state"] not in ("awaiting_recovery", "assigned_recovery"):
            raise HTTPException(409, "the patient has not moved out of the OR room yet")
        bed = database.execute(
            f"""SELECT bed.id, bed.name, room.room_type, room.parent_id::text AS unit_key,
                      coalesce(assignment.leaf_id, leaf_bed.leaf_id) AS leaf_id
               FROM canopy_location bed JOIN canopy_location room ON room.id = bed.parent_id
               {BED_LEAF_JOIN}
               WHERE bed.id = %s AND bed.kind = 'bed'""", (payload.bed_location_id,)).fetchone()
        if bed is None or bed["unit_key"] != row["unit_key"]:
            raise HTTPException(400, "the bed is not in this ward")
        if bed["room_type"] == "or":
            raise HTTPException(409, "this is an OR room bed; choose a recovery bed")
        if not bed["leaf_id"]:
            raise HTTPException(409, f"{bed['name']} has no Leaf; assign a Leaf to the bed under Infrastructure first")
        database.execute(
            """UPDATE canopy_admission SET journey_state='assigned_recovery', target_leaf_id=%s, current_bed_location_id=%s,
                 updated_by=%s, updated_at=%s WHERE id=%s""", (bed["leaf_id"], bed["id"], user["username"], directory.now_ms(), session_id))
        record_event(database, session_id, "assigned_recovery", actor=user["username"], location_id=bed["id"], leaf_id=bed["leaf_id"])
    busy = bed_cases(database, [bed]).get(bed["id"])
    return {"row": one(database, session_id, scope),
            "warning": f"{bed['name']} still has an active case (HN {busy['hn']})" if busy else None}


def session_case(database: Connection, row: dict[str, Any]) -> dict[str, Any] | None:
    """The active Leaf case of an OR session (the Leaf running it now)."""
    if not row.get("claimed_leaf_id") or not row.get("global_case_id"):
        return None
    return database.execute(
        # No row lock: the ward desk may only read the index; the open-handover unique index stops a double offer.
        "SELECT * FROM sync_case_index WHERE global_case_id=%s AND leaf_id=%s AND status='ACTIVE'",
        (row["global_case_id"], row["claimed_leaf_id"])).fetchone()


@router.get("/api/fleet/admissions/or/sessions/{session_id}/transfer")
def transfer_options(session_id: str, user: dict = Depends(mover), scope: list[str] | None = Depends(ward_scope),
                     database: Connection = Depends(connection)) -> dict[str, Any]:
    """Transfer without discharge: the beds of this ward and the transfer waiting for Receive, if any."""
    row = load(database, session_id, scope)
    case = session_case(database, row)
    leaf_ids = [item["leaf_id"] for item in database.execute(
        "SELECT leaf_id FROM canopy_leaf_unit WHERE unit_key=%s", (row["unit_key"],)).fetchall()]
    pending = database.execute(
        """SELECT id AS handover_id, kind, to_leaf_id, to_bed_label, initiated_from, requested_by, created_at
           FROM canopy_case_handover WHERE global_case_id=%s AND status='offered'""",
        (case["global_case_id"],)).fetchone() if case else None
    return {"case": {"leaf_id": case["leaf_id"], "bed_label": (case["snapshot"].get("case") or {}).get("bed_label")} if case else None,
            "pending": pending, "beds": case_transfer.ward_beds(database, list({*leaf_ids, *([case["leaf_id"]] if case else [])}))}


@router.post("/api/fleet/admissions/or/sessions/{session_id}/transfer")
def request_transfer(session_id: str, payload: AssignInput, user: dict = Depends(mover), scope: list[str] | None = Depends(ward_scope),
                     database: Connection = Depends(connection)) -> dict[str, Any]:
    """Move the running case to another bed without discharging it: another room's Leaf receives it
    (Receive on that Leaf), or the same multi-bed Leaf (Recovery) moves it to the bed at its next sync."""
    with database.transaction():
        row = load(database, session_id, scope, lock=True)
        if row["journey_state"] not in ("in_or", "in_recovery"):
            raise HTTPException(409, "only a patient in a room or recovery bed can be transferred")
        case = session_case(database, row)
        if case is None:
            raise HTTPException(409, "Canopy has not seen this patient's case yet; wait for the Leaf to sync")
        try:
            bed = case_transfer.bed_target(database, payload.bed_location_id)
            offer = case_transfer.offer(database, case, to_leaf_id=bed["leaf_id"], to_bed_location_id=bed["id"],
                                        to_bed_label=bed["name"], actor=user["username"], initiated_from="canopy")
        except case_transfer.TransferRefused as error:
            raise HTTPException(409, str(error)) from None
    busy = bed_cases(database, [{"id": bed["id"], "leaf_id": bed["leaf_id"]}]).get(bed["id"])
    return {"row": one(database, session_id, scope), "handover_id": offer["id"], "kind": offer["kind"],
            "warning": f"{bed['name']} still has an active case (HN {busy['hn']})" if busy and busy["hn"] != case["hn"] else None}


@router.post("/api/fleet/admissions/or/sessions/{session_id}/transfer/withdraw")
def withdraw_transfer(session_id: str, user: dict = Depends(mover), scope: list[str] | None = Depends(ward_scope),
                      database: Connection = Depends(connection)) -> dict[str, Any]:
    with database.transaction():
        row = load(database, session_id, scope, lock=True)
        case = session_case(database, row)
        pending = database.execute(
            "SELECT id FROM canopy_case_handover WHERE global_case_id=%s AND status='offered'",
            (case["global_case_id"],)).fetchone() if case else None
        if pending is None or case_transfer.withdraw(database, pending["id"], actor=user["username"]) is None:
            raise HTTPException(409, "no transfer is waiting for this patient")
    return {"row": one(database, session_id, scope)}


class DischargeInput(BaseModel):
    destination: str = Field(min_length=1, max_length=120)
    note: str | None = Field(default=None, max_length=500)


@router.post("/api/fleet/admissions/or/sessions/{session_id}/discharge")
def request_discharge(session_id: str, payload: DischargeInput, user: dict = Depends(mover),
                      scope: list[str] | None = Depends(ward_scope), database: Connection = Depends(connection)) -> dict[str, Any]:
    """Out of the OR ward (to ICU, IPD, home ...), pressed at the ward desk: the Leaf discharges the case.
    A patient waiting for recovery (no Leaf has the case) is discharged here directly."""
    with database.transaction():
        row = load(database, session_id, scope, lock=True)
        current = directory.now_ms()
        if row["journey_state"] in ("awaiting_recovery", "assigned_recovery"):
            database.execute(
                """UPDATE canopy_admission SET journey_state='discharged', discharged_at=%s, discharge_destination=%s, discharge_note=%s,
                     target_leaf_id=NULL, updated_by=%s, updated_at=%s WHERE id=%s""",
                (current, payload.destination.strip(), payload.note, user["username"], current, session_id))
            record_event(database, session_id, "discharged", actor=user["username"], detail={"destination": payload.destination})
        elif row["journey_state"] in ("in_or", "in_recovery"):
            database.execute(
                """UPDATE canopy_admission SET discharge_requested_at=%s, discharge_requested_by=%s, discharge_destination=%s,
                     discharge_note=%s, updated_at=%s WHERE id=%s""",
                (current, user["username"], payload.destination.strip(), payload.note, current, session_id))
            record_event(database, session_id, "discharge_requested", actor=user["username"], leaf_id=row["current_leaf_id"],
                         detail={"destination": payload.destination})
        else:
            raise HTTPException(409, f"the session is {or_journey.LABEL[row['journey_state']]}")
    return {"row": one(database, session_id, scope)}


# ---------------------------------------------------------------- master data

@router.put("/api/fleet/control/or/rooms/{room_id}")
def save_room(room_id: int, payload: dict = Body(...), _: dict = Depends(master), database: Connection = Depends(connection)) -> dict:
    room_type = payload.get("room_type") or None
    if room_type not in (None, "or", "recovery", "other"):
        raise HTTPException(400, "room_type is or, recovery or other")
    or_type = payload.get("or_type_code") or None
    if or_type and not database.execute("SELECT 1 FROM canopy_or_type WHERE code=%s", (or_type,)).fetchone():
        raise HTTPException(400, f"unknown OR type '{or_type}'")
    row = database.execute(
        """UPDATE canopy_location SET room_type=%s, or_type_code=%s, updated_at=%s WHERE id=%s AND kind='room'
           RETURNING id, name, room_type, or_type_code""", (room_type, or_type if room_type == "or" else None, directory.now_ms(), room_id)).fetchone()
    if row is None:
        raise HTTPException(404, "room not found")
    return dict(row)


def save_code_row(database: Connection, table: str, code: str, payload: dict[str, Any], extra: tuple[str, ...] = ()) -> dict:
    if not CODE.match(code):
        raise HTTPException(400, "code: lowercase letters, digits and _ (starting with a letter)")
    name = str(payload.get("name") or "").strip()
    if not name:
        raise HTTPException(400, "name required")
    columns = {"name": name[:120], "sort_order": int(payload.get("sort_order") or 100), "is_active": bool(payload.get("is_active", True)),
               **{key: (str(payload.get(key) or "").strip() or None) for key in extra}, "updated_at": directory.now_ms()}
    database.execute(
        f"""INSERT INTO {table} (code, {', '.join(columns)}) VALUES (%s, {', '.join(['%s'] * len(columns))})
            ON CONFLICT (code) DO UPDATE SET {', '.join(f'{key}=excluded.{key}' for key in columns)}""",
        (code, *columns.values()))
    return dict(database.execute(f"SELECT * FROM {table} WHERE code=%s", (code,)).fetchone())


@router.put("/api/fleet/control/or/types/{code}")
def save_or_type(code: str, payload: dict = Body(...), _: dict = Depends(master), database: Connection = Depends(connection)) -> dict:
    return save_code_row(database, "canopy_or_type", code, payload)


@router.put("/api/fleet/control/or/equipment/{code}")
def save_equipment(code: str, payload: dict = Body(...), _: dict = Depends(master), database: Connection = Depends(connection)) -> dict:
    return save_code_row(database, "canopy_or_equipment", code, payload, ("group_name",))
