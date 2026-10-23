"""OR sessions in the database: the journey log and what Leafs report (shared by the Canopy and sync APIs).

The Leaf learns its OR session through the admission exchange (`or_session` in the admission header):
room, bed, team and a pending move-in request from the ward desk. It reports back by claiming the
admission (the patient moved in: the case started) and by the case status (discharged).

OR → Recovery is a **Transfer**: the OR room's case closes (discharge_reason 'transferred'; its chart is
the Anesthesia Report) and the recovery bed's Leaf starts a new case for the same booking (the
Post-Anesthesia chart). or_global_case_id keeps the OR case; billing_mode says whether Canopy shows the
two billing orders as one bill.
"""
from __future__ import annotations

from typing import Any

from psycopg import Connection
from psycopg.types.json import Jsonb

from . import directory


def record_event(database: Connection, admission_id: Any, event: str, *, actor: str | None, location_id: int | None = None,
                 leaf_id: str | None = None, source: str = "canopy", detail: dict[str, Any] | None = None,
                 at: int | None = None) -> None:
    if database.execute("SELECT to_regclass('canopy_session_event') AS t").fetchone()["t"] is None:
        return
    current = directory.now_ms()
    database.execute(
        """INSERT INTO canopy_session_event (admission_id, event, location_id, leaf_id, at, source, actor, detail, created_at)
           VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s)""",
        (admission_id, event, location_id, leaf_id, at or current, source, actor, Jsonb(detail or {}), current))


def leaf_header(database: Connection, row: dict[str, Any]) -> dict[str, Any] | None:
    """What a Leaf needs about the OR session of an admission it may start (None for a plain admission)."""
    if not row.get("room_location_id") and row.get("journey_state") != "assigned_recovery":
        return None
    names = database.execute(
        "SELECT (SELECT name FROM canopy_location WHERE id=%s) AS room, (SELECT name FROM canopy_location WHERE id=%s) AS bed",
        (row.get("room_location_id"), row.get("current_bed_location_id"))).fetchone()
    recovery = row.get("journey_state") == "assigned_recovery"
    return {"room_name": names["room"], "bed_name": names["bed"], "journey_state": row.get("journey_state"),
            "stage": "recovery" if recovery else "or",
            # A new Post-Anesthesia case starts on the recovery bed (older Leafs took the OR case over instead).
            **({"transfer": True, "billing_mode": row.get("billing_mode") or "combined"} if recovery else {}),
            **({"global_case_id": str(row["global_case_id"])} if recovery and row.get("global_case_id") else {}),
            "duration_min": row.get("duration_min"), "or_type_code": row.get("or_type_code"),
            "equipment": row.get("equipment") or [], "team": row.get("team") or [],
            "move_in_requested_at": row.get("move_in_requested_at"), "move_in_requested_by": row.get("move_in_requested_by")}


def on_leaf_claim(database: Connection, admission_id: str, leaf_id: str, case: dict[str, Any] | None) -> None:
    """The Leaf started the case of this admission: the patient moved in to the OR room."""
    row = database.execute(
        "SELECT id, journey_state, current_bed_location_id FROM canopy_admission WHERE id::text=%s",
        (admission_id,)).fetchone() if _has_journey(database) else None
    if row is None or row["journey_state"] not in ("booked", "assigned"):
        return
    at = int((case or {}).get("start_time") or directory.now_ms())
    database.execute(
        """UPDATE canopy_admission SET journey_state='in_or', moved_in_at=%s, current_leaf_id=%s,
             move_in_requested_at=NULL, updated_at=%s WHERE id=%s""", (at, leaf_id, directory.now_ms(), row["id"]))
    record_event(database, row["id"], "moved_in", actor=None, source="leaf", leaf_id=leaf_id,
                 location_id=row["current_bed_location_id"], at=at)
    full = database.execute("SELECT hn, global_case_id FROM canopy_admission WHERE id=%s", (row["id"],)).fetchone()
    movement(database, {**row, **full}, "moved", to_location=row["current_bed_location_id"], at=at, note="Moved in to the OR room")


def on_leaf_case(database: Connection, admission_id: str, leaf_id: str, case: dict[str, Any]) -> None:
    """Case status from the Leaf: moved out of the OR room (→ Recovery, room free), or discharged out of the OR ward."""
    if not _has_journey(database):
        return
    row = database.execute(
        "SELECT id, hn, journey_state, current_bed_location_id, global_case_id, moved_in_at FROM canopy_admission WHERE id::text=%s",
        (admission_id,)).fetchone()
    if row is None:
        return
    current = directory.now_ms()
    if case.get("status") == "active":
        # Start Recovery recorded in the OR room and the patient recovers there.
        if case.get("or_stage") == "or_recovery" and row["journey_state"] == "in_or":
            database.execute("UPDATE canopy_admission SET journey_state='in_recovery', recovery_in_at=%s, updated_at=%s WHERE id=%s",
                             (current, current, row["id"]))
            record_event(database, row["id"], "recovery_in_room", actor=None, source="leaf", leaf_id=leaf_id,
                         location_id=row["current_bed_location_id"], at=current)
        return
    if case.get("status") not in ("discharged", "archived"):
        return
    at = int(case.get("discharge_time") or directory.now_ms())
    if case.get("discharge_reason") in ("moved_out", "transferred"):
        transfer = case.get("discharge_reason") == "transferred"
        at = max(at, int(row.get("moved_in_at") or 0))  # the chart's minute may round below the move-in report
        if row["journey_state"] in ("in_or", "in_recovery"):
            billing_mode = case.get("billing_mode") if case.get("billing_mode") in ("combined", "separate") else None
            database.execute(
                """UPDATE canopy_admission SET journey_state='awaiting_recovery', moved_out_at=%s, current_leaf_id=NULL,
                     current_bed_location_id=NULL, target_leaf_id=NULL, move_out_requested_at=NULL,
                     or_global_case_id=CASE WHEN %s THEN global_case_id ELSE or_global_case_id END,
                     billing_mode=coalesce(%s, billing_mode), updated_at=%s WHERE id=%s""",
                (at, transfer, billing_mode, current, row["id"]))
            record_event(database, row["id"], "transferred_out" if transfer else "moved_out", actor=None, source="leaf",
                         leaf_id=leaf_id, location_id=row["current_bed_location_id"], at=at,
                         detail={"billing_mode": billing_mode} if transfer and billing_mode else None)
            movement(database, row, "moved", from_location=row["current_bed_location_id"], at=at,
                     note="Transferred out of the OR room" if transfer else "Moved out of the OR room")
        return
    if row["journey_state"] in ("in_or", "in_recovery"):
        database.execute(
            """UPDATE canopy_admission SET journey_state='discharged', discharged_at=%s, discharge_destination=coalesce(%s, discharge_destination),
                 discharge_note=coalesce(%s, discharge_note), discharge_requested_at=NULL, updated_at=%s WHERE id=%s""",
            (at, case.get("discharge_destination"), case.get("discharge_note"), current, row["id"]))
        record_event(database, row["id"], "discharged", actor=None, source="leaf", leaf_id=leaf_id,
                     location_id=row["current_bed_location_id"], at=at, detail={"destination": case.get("discharge_destination")})
        movement(database, row, "discharged", from_location=row["current_bed_location_id"], at=at,
                 note=f"Out of the OR ward to {case.get('discharge_destination')}" if case.get("discharge_destination") else "Out of the OR ward")


def is_previous_leaf(database: Connection, admission_id: str, leaf_id: str) -> bool:
    """The OR room's Leaf after the case moved on: its reports of the closed case change nothing."""
    if not _has_journey(database):
        return False
    row = database.execute("SELECT handed_from_leaf_id FROM canopy_admission WHERE id::text=%s", (admission_id,)).fetchone()
    return bool(row and row["handed_from_leaf_id"] == leaf_id)


def transfer_claim(database: Connection, row: dict[str, Any], leaf_id: str, case: dict[str, Any] | None) -> bool:
    """The recovery bed's Leaf started the Post-Anesthesia case of a transferred patient: the booking now
    belongs to that Leaf (the OR room's Leaf becomes the previous one). False when this is not that case."""
    if not _has_journey(database) or row.get("journey_state") != "assigned_recovery" or row.get("target_leaf_id") != leaf_id:
        return False
    at = int((case or {}).get("start_time") or directory.now_ms())
    current = directory.now_ms()
    database.execute(
        """UPDATE canopy_admission SET status='started', journey_state='in_recovery', recovery_in_at=%s, claimed_leaf_id=%s,
             current_leaf_id=%s, handed_from_leaf_id=%s, or_global_case_id=coalesce(or_global_case_id, global_case_id),
             move_in_requested_at=NULL, updated_at=%s WHERE id=%s""",
        (at, leaf_id, leaf_id, row.get("claimed_leaf_id"), current, row["id"]))
    record_event(database, row["id"], "transferred_in", actor=None, source="leaf", leaf_id=leaf_id,
                 location_id=row.get("current_bed_location_id"), at=at)
    movement(database, row, "moved", to_location=row.get("current_bed_location_id"), at=at,
             note="Transferred in to recovery (new case)")
    return True


def recovery_claim(database: Connection, admission_id: str, to_leaf_id: str, index: dict[str, Any], export: dict[str, Any]) -> None:
    """A recovery bed's Leaf takes over the moved-out case (handover claim). Raises ValueError when it may not."""
    row = database.execute("SELECT * FROM canopy_admission WHERE id::text=%s FOR UPDATE", (admission_id,)).fetchone()
    if row is None or str(row.get("global_case_id")) != str(index["global_case_id"]):
        raise ValueError("this booking is not the case being moved")
    if row["journey_state"] != "assigned_recovery" or row["target_leaf_id"] != to_leaf_id:
        raise ValueError("the patient is not assigned to this recovery bed")
    if ((export.get("case") or {}).get("status") or "active") == "active":
        raise ValueError("the OR room has not sent its final copy yet; try again in a moment")
    current = directory.now_ms()
    database.execute(
        """UPDATE canopy_admission SET journey_state='in_recovery', recovery_in_at=%s, claimed_leaf_id=%s, current_leaf_id=%s,
             handed_from_leaf_id=%s, move_in_requested_at=NULL, updated_at=%s WHERE id=%s""",
        (current, to_leaf_id, to_leaf_id, index["leaf_id"], current, row["id"]))
    record_event(database, row["id"], "moved_in_recovery", actor=None, source="leaf", leaf_id=to_leaf_id,
                 location_id=row["current_bed_location_id"], at=current)
    movement(database, row, "moved", to_location=row["current_bed_location_id"], at=current, note="Moved in to recovery")


def leaf_requests(row: dict[str, Any]) -> dict[str, Any]:
    """Ward-desk requests for the Leaf running this admission's case."""
    out: dict[str, Any] = {}
    if row.get("move_out_requested_at") and row.get("journey_state") in ("in_or", "in_recovery"):
        out["move_out"] = {"at": row["move_out_requested_at"], "by": row.get("move_out_requested_by")}
    if row.get("discharge_requested_at") and row.get("journey_state") in ("in_or", "in_recovery"):
        out["discharge"] = {"at": row["discharge_requested_at"], "by": row.get("discharge_requested_by"),
                            "destination": row.get("discharge_destination"), "note": row.get("discharge_note")}
    return out


def movement(database: Connection, row: dict[str, Any], event: str, *, at: int, from_location: int | None = None,
             to_location: int | None = None, note: str | None = None) -> None:
    """Also show the move on the Digital twin (patient journeys)."""
    try:
        with database.transaction():
            database.execute(
                """INSERT INTO canopy_patient_movement (hn, global_case_id, from_location_id, to_location_id, event, moved_at,
                       source, note, created_at) VALUES (%s,%s,%s,%s,%s,%s,'or_schedule',%s,%s)""",
                (row["hn"], row.get("global_case_id"), from_location, to_location, event, at, note, directory.now_ms()))
    except Exception:  # the twin is optional (migration 0088)
        pass


def _has_journey(database: Connection) -> bool:
    return database.execute(
        "SELECT 1 FROM information_schema.columns WHERE table_name='canopy_admission' AND column_name='journey_state'").fetchone() is not None


def recovery_cancel(database: Connection, handover: dict[str, Any]) -> None:
    """The recovery bed's import failed and the handover was cancelled: the patient waits for recovery again."""
    if not _has_journey(database):
        return
    row = database.execute(
        """SELECT id, handed_from_leaf_id FROM canopy_admission WHERE global_case_id=%s AND journey_state='in_recovery'
           AND claimed_leaf_id=%s FOR UPDATE""", (handover["global_case_id"], handover["to_leaf_id"])).fetchone()
    if row is None:
        return
    current = directory.now_ms()
    database.execute(
        """UPDATE canopy_admission SET journey_state='assigned_recovery', claimed_leaf_id=%s, handed_from_leaf_id=NULL,
             recovery_in_at=NULL, current_leaf_id=NULL, updated_at=%s WHERE id=%s""", (row["handed_from_leaf_id"], current, row["id"]))
    # The moved-out case is closed at the OR room's Leaf, not active.
    database.execute("UPDATE sync_case_index SET status='DISCHARGED' WHERE global_case_id=%s", (handover["global_case_id"],))
    record_event(database, row["id"], "recovery_move_in_failed", actor=None, source="leaf", leaf_id=handover["to_leaf_id"])


class ReopenRefused(ValueError):
    pass


def reopen(database: Connection, admission_id: str, leaf_id: str) -> str:
    """The Leaf cancelled the discharge or transfer of this admission's case: the patient is back on that Leaf.
    Refused once the recovery bed received the transfer or another Leaf runs the case. "ok" | "unchanged"."""
    if not _has_journey(database):
        return "unchanged"
    row = database.execute("SELECT * FROM canopy_admission WHERE id::text=%s FOR UPDATE", (admission_id,)).fetchone()
    if row is None:
        return "unchanged"
    if row.get("claimed_leaf_id") != leaf_id:
        if row.get("handed_from_leaf_id") == leaf_id:
            raise ReopenRefused("the recovery bed has already received this patient")
        raise ReopenRefused("another workstation runs this case")
    state = row["journey_state"]
    if state in ("in_or", "in_recovery"):
        return "unchanged"
    back = "in_recovery" if row.get("recovery_in_at") else "in_or"
    current = directory.now_ms()
    if state in ("awaiting_recovery", "assigned_recovery") and row.get("source") == LEAF_TRANSFER:
        # Made by transfer_out for a case without a Canopy admission: the transfer simply goes away.
        database.execute("UPDATE canopy_admission SET status='cancelled', journey_state='cancelled', target_leaf_id=NULL, updated_at=%s WHERE id=%s",
                         (current, row["id"]))
        record_event(database, row["id"], "transfer_cancelled", actor=None, source="leaf", leaf_id=leaf_id, at=current)
        return "ok"
    if state in ("awaiting_recovery", "assigned_recovery"):
        # The transfer cleared the room's bed; take it from the transfer event.
        last = database.execute(
            """SELECT location_id FROM canopy_session_event WHERE admission_id=%s AND event IN ('transferred_out','moved_out')
               ORDER BY at DESC, created_at DESC LIMIT 1""", (row["id"],)).fetchone() \
            if database.execute("SELECT to_regclass('canopy_session_event') AS t").fetchone()["t"] else None
        bed = (last or {}).get("location_id")
        database.execute(
            """UPDATE canopy_admission SET journey_state=%s, current_leaf_id=%s, current_bed_location_id=coalesce(%s, current_bed_location_id),
                 moved_out_at=NULL, target_leaf_id=NULL,
                 or_global_case_id=CASE WHEN or_global_case_id=global_case_id THEN NULL ELSE or_global_case_id END,
                 updated_at=%s WHERE id=%s""", (back, leaf_id, bed, current, row["id"]))
        record_event(database, row["id"], "transfer_cancelled", actor=None, source="leaf", leaf_id=leaf_id, location_id=bed, at=current)
        movement(database, row, "moved", to_location=bed, at=current, note="Transfer cancelled: back in the room")
        return "ok"
    if state == "discharged":
        database.execute(
            """UPDATE canopy_admission SET journey_state=%s, discharged_at=NULL, discharge_destination=NULL, discharge_note=NULL,
                 current_leaf_id=%s, updated_at=%s WHERE id=%s""", (back, leaf_id, current, row["id"]))
        record_event(database, row["id"], "discharge_cancelled", actor=None, source="leaf", leaf_id=leaf_id,
                     location_id=row.get("current_bed_location_id"), at=current)
        movement(database, row, "moved", to_location=row.get("current_bed_location_id"), at=current, note="Discharge cancelled")
        return "ok"
    raise ReopenRefused(f"the OR session is {state}")


LEAF_TRANSFER = "leaf_transfer"


def _leaf_bed(database: Connection, leaf_id: str) -> int | None:
    for table in ("canopy_leaf_assignment", "canopy_leaf_bed"):
        if database.execute("SELECT to_regclass(%s) AS t", (table,)).fetchone()["t"] is None:
            continue
        row = database.execute(f"SELECT bed_location_id FROM {table} WHERE leaf_id=%s LIMIT 1", (leaf_id,)).fetchone()
        if row:
            return row["bed_location_id"]
    return None


def transfer_out(database: Connection, leaf_id: str, transfer: dict[str, Any]) -> str:
    """Discharge to another Leaf (e.g. a recovery bed) chosen at the bedside: that Leaf sees the patient under
    Receive transfer and starts a new case for them. The admission of the case moves on; a case started without
    a Canopy admission gets one (source leaf_transfer). Returns the admission id; raises ReopenRefused."""
    to_leaf = str(transfer.get("to_leaf_id") or "")
    if not to_leaf or to_leaf == leaf_id:
        raise ReopenRefused("choose another workstation")
    if database.execute("SELECT 1 FROM sync_leaf_node WHERE leaf_id=%s", (to_leaf,)).fetchone() is None:
        raise ReopenRefused(f"unknown workstation {to_leaf}")
    current = directory.now_ms()
    at = int(transfer.get("at") or current)
    billing_mode = transfer.get("billing_mode") if transfer.get("billing_mode") in ("combined", "separate") else "combined"
    bed = _leaf_bed(database, to_leaf)
    row = database.execute("SELECT * FROM canopy_admission WHERE id::text=%s FOR UPDATE",
                           (str(transfer.get("admission_id") or ""),)).fetchone() if transfer.get("admission_id") else None
    if row is not None:
        if row.get("claimed_leaf_id") != leaf_id:
            raise ReopenRefused("another workstation runs this case")
        database.execute(
            """UPDATE canopy_admission SET journey_state='assigned_recovery', target_leaf_id=%s, moved_out_at=%s,
                 current_leaf_id=NULL, current_bed_location_id=%s, move_out_requested_at=NULL,
                 or_global_case_id=coalesce(%s::uuid, global_case_id), billing_mode=%s, updated_at=%s WHERE id=%s""",
            (to_leaf, at, bed, transfer.get("global_case_id"), billing_mode, current, row["id"]))
        admission_id = row["id"]
        from_bed = row.get("current_bed_location_id")
    else:
        patient = transfer.get("patient") or {}
        unit = directory.leaf_unit(database, to_leaf) or directory.leaf_unit(database, leaf_id) or {}
        admission_id = database.execute(
            """INSERT INTO canopy_admission (id, unit_key, target_leaf_id, hn, admission_number, patient, status, claimed_leaf_id,
                   leaf_case_id, global_case_id, case_status, claimed_at, created_by, created_at, updated_at, source,
                   journey_state, current_bed_location_id, moved_out_at, or_global_case_id, billing_mode)
               VALUES (gen_random_uuid(), %s, %s, %s, %s, %s, 'started', %s, %s, %s::uuid, 'discharged', %s, %s, %s, %s, %s,
                       'assigned_recovery', %s, %s, %s::uuid, %s) RETURNING id""",
            (unit.get("key") or "transfer", to_leaf, transfer.get("hn"), transfer.get("admission_number"), Jsonb(patient), leaf_id, transfer.get("case_id"),
             transfer.get("global_case_id"), current, f"leaf:{leaf_id}", current, current, LEAF_TRANSFER,
             bed, at, transfer.get("global_case_id"), billing_mode)).fetchone()["id"]
        from_bed = _leaf_bed(database, leaf_id)
    record_event(database, admission_id, "transferred_out", actor=transfer.get("by"), source="leaf", leaf_id=leaf_id,
                 location_id=from_bed, at=at, detail={"to_leaf_id": to_leaf, "billing_mode": billing_mode})
    return str(admission_id)
