"""Canopy → Digital twin: an isometric map of care units → rooms (zones) → beds with live patient
status and patient journeys.

GET  /api/fleet/twin                     map: buildings, units, rooms, beds, occupants, waiting, journeys, KPIs
GET  /api/fleet/twin/journey?hn=…        one patient's journey (all sources), oldest first
PUT  /api/fleet/control/twin/layout      admins save map placement of units and rooms
POST /api/fleet/control/twin/movements   record a move (bed / room / zone) not known from other data

A journey is assembled from what Canopy already holds — admissions (canopy_admission), cases started
and discharged on Leafs (sync_case_index), handovers (canopy_case_handover), ER form times (arrival,
triage zone) — plus recorded movements (canopy_patient_movement). On the map patients are shown by
initials and a masked HN; names appear only in the detail panel, for users who may see that ward.
"""
from __future__ import annotations

import time
from typing import Any, Literal

from fastapi import APIRouter, Depends, HTTPException, Query
from psycopg import Connection
from pydantic import BaseModel, Field

from ..database import connection
from .auth_canopy import read_token
from .fleet_control import require_admin
from .fleet_read import _patient_name, fleet_scope

router = APIRouter(prefix="/api/fleet/twin", tags=["canopy-twin"], dependencies=[Depends(read_token)])
control_router = APIRouter(prefix="/api/fleet/control/twin", tags=["canopy-twin"], dependencies=[Depends(require_admin)])

DAY_MS = 86_400_000
TRIAGE_COLOR = {"1": "red", "2": "pink", "3": "yellow", "4": "green", "5": "white"}
DONE_HANDOVER = {"completed", "done", "cancelled", "failed", "rejected"}


def now_ms() -> int:
    return int(time.time() * 1000)


def _patient(snapshot: dict[str, Any]) -> dict[str, Any]:
    patient = snapshot.get("patient") if isinstance(snapshot.get("patient"), dict) else {}
    return patient.get("row") if isinstance(patient.get("row"), dict) else patient


def _initials(name: str) -> str:
    parts = [part for part in name.replace("HN", "").split() if part and not part[0].isdigit()]
    return "".join(part[0] for part in parts[:2]).upper() or "•"


def _mask(hn: str | None) -> str:
    hn = str(hn or "")
    return ("•" * max(0, len(hn) - 4) + hn[-4:]) if hn else "—"


def _form(snapshot: dict[str, Any], form_id: str) -> dict[str, Any]:
    forms = snapshot.get("workflow_forms") if isinstance(snapshot.get("workflow_forms"), dict) else {}
    record = forms.get(form_id) if isinstance(forms.get(form_id), dict) else {}
    return record.get("data") if isinstance(record.get("data"), dict) else {}


def _iso_ms(value: Any) -> int | None:
    """Form date-times are ISO text in local time; turn them into epoch ms (best effort)."""
    if not value:
        return None
    from datetime import datetime
    try:
        return int(datetime.fromisoformat(str(value).replace("Z", "+00:00")).timestamp() * 1000)
    except ValueError:
        return None


def _locations(database: Connection, scope: list[str] | None) -> dict[str, Any]:
    units = database.execute(
        """SELECT unit.id, unit.name, unit.layout, unit.sort_order, unit.parent_id AS building_id
           FROM canopy_location unit
           WHERE unit.kind='care_unit' AND unit.is_active
             AND ((%s::text[] IS NULL AND NOT unit.is_demo) OR unit.id::text = ANY(%s))
           ORDER BY unit.sort_order, unit.name""", (scope, scope)).fetchall()
    unit_ids = [unit["id"] for unit in units]
    rooms = database.execute(
        "SELECT id, parent_id, name, zone, layout FROM canopy_location WHERE kind='room' AND is_active AND parent_id=ANY(%s) "
        "ORDER BY sort_order, name", (unit_ids,)).fetchall()
    beds = database.execute(
        "SELECT id, parent_id, name FROM canopy_location WHERE kind='bed' AND is_active AND parent_id=ANY(%s) ORDER BY sort_order, name",
        ([room["id"] for room in rooms],)).fetchall()
    buildings = database.execute(
        "SELECT id, name FROM canopy_location WHERE id=ANY(%s) ORDER BY sort_order, name",
        (list({unit["building_id"] for unit in units if unit["building_id"]}),)).fetchall()
    return {"units": units, "rooms": rooms, "beds": beds, "buildings": buildings}


def _leaf_beds(database: Connection) -> tuple[dict[str, int], dict[int, str]]:
    """Leaf → primary bed, and bed → Leaf (primary and extra beds)."""
    primary = {row["leaf_id"]: row["bed_location_id"] for row in
               database.execute("SELECT leaf_id, bed_location_id FROM canopy_leaf_assignment").fetchall()}
    by_bed = {bed: leaf for leaf, bed in primary.items()}
    for row in database.execute("SELECT leaf_id, bed_location_id FROM canopy_leaf_bed").fetchall():
        by_bed[row["bed_location_id"]] = row["leaf_id"]
    return primary, by_bed


def _journey(database: Connection, hn: str, since: int, primary: dict[str, int], rooms_by_zone: dict[tuple[int, str], int],
             bed_unit: dict[int, int]) -> list[dict[str, Any]]:
    steps: list[dict[str, Any]] = []
    for row in database.execute(
            "SELECT unit_key, created_at, claimed_at, status FROM canopy_admission WHERE hn=%s AND created_at>=%s", (hn, since)).fetchall():
        steps.append({"at": row["created_at"], "kind": "admission", "label": "Admission prepared",
                      "unit_id": int(row["unit_key"]) if str(row["unit_key"]).isdigit() else None, "location_id": None})
    for row in database.execute(
            """SELECT global_case_id, leaf_id, start_time, discharge_time, status, snapshot FROM sync_case_index
               WHERE hn=%s AND coalesce(discharge_time, start_time, 0) >= %s ORDER BY start_time""", (hn, since)).fetchall():
        bed = primary.get(row["leaf_id"])
        triage = _form(row["snapshot"] or {}, "er_triage")
        arrival = _iso_ms(triage.get("arrival_at"))
        if arrival:
            steps.append({"at": arrival, "kind": "arrived", "label": "Arrived at ER", "unit_id": bed_unit.get(bed), "location_id": None})
        triaged = _iso_ms(triage.get("triaged_at"))
        if triaged:
            # Form zone codes (acute_pink, fast_track …) match room zone names (Acute (Pink), Fast track …) by first word.
            zone = str(triage.get("assigned_zone") or "")
            room = next((room_id for (unit, zone_name), room_id in rooms_by_zone.items()
                         if unit == bed_unit.get(bed) and zone_name.lower().replace(" ", "_").startswith(zone.split("_")[0])), None)
            steps.append({"at": triaged, "kind": "triaged", "label": f"Triage level {triage.get('triage_level') or '—'}",
                          "unit_id": bed_unit.get(bed), "location_id": room})
        if row["start_time"]:
            steps.append({"at": row["start_time"], "kind": "case_started", "label": "Care started", "unit_id": bed_unit.get(bed),
                          "location_id": bed, "global_case_id": str(row["global_case_id"])})
        if row["discharge_time"] and row["status"] != "ACTIVE":
            steps.append({"at": row["discharge_time"], "kind": "discharged", "label": "Discharged from unit",
                          "unit_id": bed_unit.get(bed), "location_id": bed, "global_case_id": str(row["global_case_id"])})
    for row in database.execute(
            """SELECT h.created_at, h.status, h.to_leaf_id FROM canopy_case_handover h
               JOIN sync_case_index c ON c.global_case_id=h.global_case_id WHERE c.hn=%s AND h.created_at>=%s""", (hn, since)).fetchall():
        bed = primary.get(row["to_leaf_id"])
        steps.append({"at": row["created_at"], "kind": "handover", "label": f"Handover ({row['status']})",
                      "unit_id": bed_unit.get(bed), "location_id": bed})
    for row in database.execute(
            """SELECT m.moved_at, m.event, m.zone, m.note, m.to_location_id FROM canopy_patient_movement m
               WHERE m.hn=%s AND m.moved_at>=%s""", (hn, since)).fetchall():
        steps.append({"at": row["moved_at"], "kind": row["event"], "label": row["note"] or row["event"].capitalize(),
                      "unit_id": bed_unit.get(row["to_location_id"]), "location_id": row["to_location_id"], "zone": row["zone"]})
    return sorted(steps, key=lambda step: step["at"] or 0)


@router.get("")
def twin(scope: list[str] | None = Depends(fleet_scope), database: Connection = Depends(connection)) -> dict[str, Any]:
    now = now_ms()
    places = _locations(database, scope)
    primary, leaf_by_bed = _leaf_beds(database)
    room_unit = {room["id"]: room["parent_id"] for room in places["rooms"]}
    bed_unit = {bed["id"]: room_unit.get(bed["parent_id"]) for bed in places["beds"]}
    bed_unit |= {room["id"]: room["parent_id"] for room in places["rooms"]}
    rooms_by_zone = {(room["parent_id"], room["zone"]): room["id"] for room in places["rooms"] if room["zone"]}

    leaves = {row["leaf_id"]: row for row in database.execute(
        """SELECT leaf_id, coalesce(nullif(canopy_display_name,''), display_name) AS name,
                  CASE WHEN last_seen_at >= now() - interval '90 seconds' THEN 'online'
                       WHEN last_seen_at >= now() - interval '10 minutes' THEN 'delayed' ELSE 'offline' END AS status
           FROM sync_leaf_node""").fetchall()}
    active = database.execute(
        "SELECT global_case_id, leaf_id, hn, start_time, snapshot FROM sync_case_index WHERE upper(status)='ACTIVE'").fetchall()
    moves = {str(row["global_case_id"]): row["to_location_id"] for row in database.execute(
        """SELECT DISTINCT ON (global_case_id) global_case_id, to_location_id FROM canopy_patient_movement
           WHERE global_case_id IS NOT NULL ORDER BY global_case_id, moved_at DESC""").fetchall()}
    pending_handover = {str(row["global_case_id"]) for row in database.execute(
        "SELECT global_case_id, status FROM canopy_case_handover").fetchall() if str(row["status"]).lower() not in DONE_HANDOVER}

    occupant_by_bed: dict[int, dict[str, Any]] = {}
    patients: list[dict[str, Any]] = []
    for case in active:
        bed = moves.get(str(case["global_case_id"])) or primary.get(case["leaf_id"])
        if bed not in bed_unit:
            continue
        snapshot = case["snapshot"] or {}
        name = _patient_name(_patient(snapshot), case["hn"])
        triage = _form(snapshot, "er_triage")
        level = str(triage.get("triage_level") or "")
        status = "transfer" if str(case["global_case_id"]) in pending_handover else "in_care"
        occupant = {"global_case_id": str(case["global_case_id"]), "hn": case["hn"], "hn_masked": _mask(case["hn"]),
                    "name": name, "initials": _initials(name), "started_at": case["start_time"], "status": status,
                    "triage_level": level or None, "triage_color": TRIAGE_COLOR.get(level), "leaf_id": case["leaf_id"],
                    "bed_id": bed, "unit_id": bed_unit.get(bed)}
        occupant_by_bed.setdefault(bed, occupant)
        patients.append(occupant)

    waiting = database.execute(
        """SELECT id, unit_key, hn, patient, scheduled_at, created_at FROM canopy_admission
           WHERE status='pending' AND ((%s::text[] IS NULL) OR unit_key = ANY(%s)) ORDER BY created_at""", (scope, scope)).fetchall()
    waiting_by_unit: dict[str, list[dict[str, Any]]] = {}
    for row in waiting:
        name = _patient_name(row["patient"] or {}, row["hn"])
        waiting_by_unit.setdefault(row["unit_key"], []).append(
            {"id": str(row["id"]), "hn_masked": _mask(row["hn"]), "initials": _initials(name), "name": name,
             "waiting_since": row["created_at"], "scheduled_at": row["scheduled_at"]})

    beds_by_room: dict[int, list[dict[str, Any]]] = {}
    for bed in places["beds"]:
        leaf_id = leaf_by_bed.get(bed["id"])
        leaf = leaves.get(leaf_id) if leaf_id else None
        beds_by_room.setdefault(bed["parent_id"], []).append({
            "id": bed["id"], "name": bed["name"],
            "leaf": {"id": leaf_id, "name": leaf["name"], "status": leaf["status"]} if leaf else None,
            "occupant": occupant_by_bed.get(bed["id"])})
    units_out = []
    for unit in places["units"]:
        rooms = [{"id": room["id"], "name": room["name"], "zone": room["zone"], "layout": room["layout"],
                  "beds": beds_by_room.get(room["id"], [])} for room in places["rooms"] if room["parent_id"] == unit["id"]]
        beds = [bed for room in rooms for bed in room["beds"]]
        unit_patients = [p for p in patients if p["unit_id"] == unit["id"]]
        stays = [now - p["started_at"] for p in unit_patients if p["started_at"]]
        units_out.append({
            "id": unit["id"], "key": str(unit["id"]), "name": unit["name"], "building_id": unit["building_id"],
            "layout": unit["layout"], "rooms": rooms,
            "kpi": {"beds": len(beds), "occupied": sum(1 for bed in beds if bed["occupant"]),
                    "patients": len(unit_patients), "waiting": len(waiting_by_unit.get(str(unit["id"]), [])),
                    "transfer": sum(1 for p in unit_patients if p["status"] == "transfer"),
                    "critical": sum(1 for p in unit_patients if p["triage_level"] in ("1", "2")),
                    "avg_stay_ms": int(sum(stays) / len(stays)) if stays else None},
            "waiting": waiting_by_unit.get(str(unit["id"]), []),
        })

    since = now - DAY_MS
    journeys = []
    for patient in patients[:60]:
        steps = [step for step in _journey(database, patient["hn"], since, primary, rooms_by_zone, bed_unit)
                 if step.get("location_id") or step.get("unit_id")]
        if len(steps) > 1:
            journeys.append({"global_case_id": patient["global_case_id"], "initials": patient["initials"],
                             "hn_masked": patient["hn_masked"], "steps": steps})
    return {"server_time": now, "buildings": places["buildings"], "units": units_out, "journeys": journeys,
            "totals": {"patients": len(patients), "beds": sum(u["kpi"]["beds"] for u in units_out),
                       "occupied": sum(u["kpi"]["occupied"] for u in units_out),
                       "waiting": sum(u["kpi"]["waiting"] for u in units_out),
                       "transfer": sum(u["kpi"]["transfer"] for u in units_out),
                       "critical": sum(u["kpi"]["critical"] for u in units_out)}}


@router.get("/journey")
def journey(hn: str = Query(min_length=1, max_length=40), days: int = Query(default=30, ge=1, le=365),
            scope: list[str] | None = Depends(fleet_scope), database: Connection = Depends(connection)) -> dict[str, Any]:
    places = _locations(database, None)
    primary, _ = _leaf_beds(database)
    room_unit = {room["id"]: room["parent_id"] for room in places["rooms"]}
    bed_unit = {bed["id"]: room_unit.get(bed["parent_id"]) for bed in places["beds"]} | room_unit
    rooms_by_zone = {(room["parent_id"], room["zone"]): room["id"] for room in places["rooms"] if room["zone"]}
    steps = _journey(database, hn, now_ms() - days * DAY_MS, primary, rooms_by_zone, bed_unit)
    if scope is not None and not any(str(step.get("unit_id")) in scope for step in steps):
        raise HTTPException(403, "this patient has not been in your ward")
    names = {location["id"]: location["name"] for location in [*places["units"], *places["rooms"], *places["beds"]]}
    return {"hn": hn, "steps": [{**step, "unit_name": names.get(step.get("unit_id")),
                                 "location_name": names.get(step.get("location_id"))} for step in steps]}


class LayoutItem(BaseModel):
    location_id: int
    x: float = Field(ge=-500, le=500)
    y: float = Field(ge=-500, le=500)
    w: float = Field(ge=1, le=200)
    h: float = Field(ge=1, le=200)


class LayoutInput(BaseModel):
    items: list[LayoutItem] = Field(default_factory=list, max_length=500)
    reset: list[int] = Field(default_factory=list, max_length=500)


@control_router.put("/layout")
def save_layout(payload: LayoutInput, database: Connection = Depends(connection)) -> dict[str, Any]:
    with database.transaction():
        for item in payload.items:
            database.execute(
                "UPDATE canopy_location SET layout=%s::jsonb WHERE id=%s AND kind IN ('care_unit','room')",
                (f'{{"x":{item.x},"y":{item.y},"w":{item.w},"h":{item.h}}}', item.location_id))
        if payload.reset:
            database.execute("UPDATE canopy_location SET layout=NULL WHERE id=ANY(%s)", (payload.reset,))
    return {"ok": True, "saved": len(payload.items), "reset": len(payload.reset)}


class MovementInput(BaseModel):
    hn: str = Field(min_length=1, max_length=40)
    global_case_id: str | None = None
    to_location_id: int
    from_location_id: int | None = None
    event: Literal["arrived", "triaged", "moved", "transferred", "admitted", "discharged"] = "moved"
    zone: str | None = Field(default=None, max_length=80)
    note: str | None = Field(default=None, max_length=300)
    moved_at: int | None = None


@control_router.post("/movements")
def record_movement(payload: MovementInput, user: dict[str, Any] = Depends(read_token),
                    database: Connection = Depends(connection)) -> dict[str, Any]:
    if not database.execute("SELECT 1 FROM canopy_location WHERE id=%s", (payload.to_location_id,)).fetchone():
        raise HTTPException(404, "location not found")
    current = now_ms()
    row = database.execute(
        """INSERT INTO canopy_patient_movement (hn, global_case_id, from_location_id, to_location_id, zone, event, moved_at,
               source, note, created_by, created_at)
           VALUES (%s,%s,%s,%s,%s,%s,%s,'canopy',%s,%s,%s) RETURNING id""",
        (payload.hn, payload.global_case_id, payload.from_location_id, payload.to_location_id, payload.zone, payload.event,
         payload.moved_at or current, payload.note, user.get("username"), current)).fetchone()
    return {"ok": True, "id": row["id"]}
