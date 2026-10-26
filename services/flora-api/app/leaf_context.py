"""What a Leaf is doing now, for AI Studio boards that follow one Leaf (0099-ai-studio-board-leaf.sql).

`context()` returns the Leaf, its current case(s) — a recovery Leaf may serve several beds — with
the milestones read from the case's chart events (patient in, anaesthesia start, incision, end of
surgery, end of anaesthesia, patient out), and the next cases booked for its room(s) in the OR
schedule, so a board can show "no patient, next case at 13:30" between cases.
"""
from __future__ import annotations

import re
import time
from typing import Any

from psycopg import Connection

# Chart event titles (case-insensitive) for each milestone; the first match in time wins.
MILESTONES: dict[str, re.Pattern[str]] = {
    "patient_in": re.compile(r"^(patient in|move in|moved in)$", re.I),
    "anesthesia_start": re.compile(r"^(start anaesthesia|start anesthesia|anaesthesia start|anesthesia start|induction)$", re.I),
    "incision": re.compile(r"^(incision|skin incision|start surgery|surgery start)$", re.I),
    "surgery_end": re.compile(r"^(end of surgery|surgery end|end surgery)$", re.I),
    "anesthesia_end": re.compile(r"^(end anaesthesia|end anesthesia|anaesthesia end|anesthesia end|end of anaesthesia|end of anesthesia)$", re.I),
    "patient_out": re.compile(r"^(patient out|move out|moved out)$", re.I),
}
NEXT_CASES = 3
LOOKBACK_MS = 12 * 3600 * 1000   # a booking that is late still counts as "next"


def milestones(snapshot: dict[str, Any]) -> dict[str, int | None]:
    events = sorted(((snapshot.get("events") or {}).get("rows") or []), key=lambda row: row.get("event_ts") or 0)
    found: dict[str, int | None] = {key: None for key in MILESTONES}
    for event in events:
        title = str(event.get("title") or "").strip()
        for key, pattern in MILESTONES.items():
            if found[key] is None and pattern.match(title) and event.get("event_ts"):
                found[key] = int(event["event_ts"])
    return found


def _people(admission: dict[str, Any]) -> dict[str, Any]:
    return {"operation": admission.get("operation"), "diagnosis": admission.get("diagnosis"),
            "surgeon": admission.get("surgeon"), "anaesthetist": admission.get("anaesthetist"),
            "asa_status": admission.get("asa_status"), "emergency": bool(admission.get("emergency"))}


def context(database: Connection, leaf_id: str) -> dict[str, Any] | None:
    leaf = database.execute(
        """SELECT leaf.leaf_id, coalesce(nullif(leaf.canopy_display_name,''), leaf.display_name) AS name, leaf.last_seen_at,
                  bed.id AS bed_id, bed.name AS bed_name, room.id AS room_id, room.name AS room_name,
                  unit.id::text AS unit_key, unit.name AS unit_name
           FROM sync_leaf_node leaf
           LEFT JOIN canopy_leaf_assignment a ON a.leaf_id = leaf.leaf_id
           LEFT JOIN canopy_location bed ON bed.id = a.bed_location_id
           LEFT JOIN canopy_location room ON room.id = bed.parent_id
           LEFT JOIN canopy_location unit ON unit.id = room.parent_id
           WHERE leaf.leaf_id = %s""", (leaf_id,)).fetchone()
    if not leaf:
        return None
    cases = []
    for row in database.execute(
            """SELECT global_case_id, case_code, hn, start_time, snapshot FROM sync_case_index
               WHERE leaf_id = %s AND upper(status) = 'ACTIVE' ORDER BY start_time DESC NULLS LAST""", (leaf_id,)).fetchall():
        snapshot = row["snapshot"] or {}
        patient = (snapshot.get("patient") or {}).get("row") or {}
        case = snapshot.get("case") or {}
        booking = database.execute(
            """SELECT admission, scheduled_at, duration_min FROM canopy_admission
               WHERE global_case_id = %s OR or_global_case_id = %s ORDER BY updated_at DESC LIMIT 1""",
            (row["global_case_id"], row["global_case_id"])).fetchone()
        cases.append({
            "global_case_id": str(row["global_case_id"]), "case_code": row["case_code"], "hn": row["hn"],
            "an": patient.get("an") or case.get("admission_number"), "patient_name": patient.get("patient_name"),
            "bed_label": case.get("bed_label"), "start_time": row["start_time"], "milestones": milestones(snapshot),
            **(_people(booking["admission"] or {}) if booking else {}),
            "scheduled_at": booking["scheduled_at"] if booking else None, "duration_min": booking["duration_min"] if booking else None,
        })
    # The rooms this Leaf serves (its primary bed's room and the rooms of further beds it serves).
    rooms = [row["room_id"] for row in database.execute(
        """SELECT DISTINCT bed.parent_id AS room_id FROM canopy_location bed
           WHERE bed.id IN (SELECT bed_location_id FROM canopy_leaf_assignment WHERE leaf_id = %s
                            UNION SELECT bed_location_id FROM canopy_leaf_bed WHERE leaf_id = %s)""", (leaf_id, leaf_id)).fetchall()]
    upcoming = []
    if rooms:
        now = int(time.time() * 1000)
        for row in database.execute(
                """SELECT a.id, a.scheduled_at, a.duration_min, a.hn, a.patient, a.admission, a.journey_state, room.name AS room_name
                   FROM canopy_admission a LEFT JOIN canopy_location room ON room.id = a.room_location_id
                   WHERE a.room_location_id = ANY(%s) AND a.journey_state IN ('booked', 'assigned')
                     AND a.scheduled_at >= %s ORDER BY a.scheduled_at LIMIT %s""",
                (rooms, now - LOOKBACK_MS, NEXT_CASES)).fetchall():
            upcoming.append({"id": str(row["id"]), "scheduled_at": row["scheduled_at"], "duration_min": row["duration_min"],
                             "hn": row["hn"], "patient_name": (row["patient"] or {}).get("patient_name"),
                             "room_name": row["room_name"], "journey_state": row["journey_state"], **_people(row["admission"] or {})})
    return {"leaf": {"leaf_id": leaf["leaf_id"], "name": leaf["name"], "bed_name": leaf["bed_name"], "room_name": leaf["room_name"],
                     "unit_key": leaf["unit_key"], "unit_name": leaf["unit_name"],
                     "last_seen_at": leaf["last_seen_at"].isoformat() if leaf["last_seen_at"] else None},
            "cases": cases, "next": upcoming, "server_time": int(time.time() * 1000)}
