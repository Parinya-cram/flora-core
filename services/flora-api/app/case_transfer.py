"""Transfer (Canopy side): move a running case to another bed without discharging it.

- transfer: to a bed of another Leaf (room change). The source Leaf or the ward desk offers the case
  (canopy_case_handover status 'offered'); the destination Leaf presses Receive, which claims it and
  imports Canopy's newest full copy (the same machinery as Take over, case_handover.py). The chart
  continues and the case keeps its Canopy admission (OR session, forms, ward-desk requests).
- bed_move: to another bed of the same multi-bed Leaf (e.g. Recovery). A Leaf moves its own case at once;
  a move offered by the ward desk reaches the Leaf in the ward exchange and the Leaf applies it.

Discharge stays the way to leave for real: to another Leaf as a new case, or out of the ward.
"""
from __future__ import annotations

from typing import Any

from psycopg import Connection, errors

from . import directory, or_sessions


class TransferRefused(ValueError):
    pass


def ward_beds(database: Connection, leaf_ids: list[str]) -> list[dict[str, Any]]:
    """Beds served by these Leafs (assigned bed + further beds), with the case each holds now."""
    if not leaf_ids:
        return []
    rows = database.execute(
        """SELECT bed.id AS bed_location_id, bed.name AS bed_name, bed.code AS bed_code, room.name AS room_name,
                  to_jsonb(room) ->> 'room_type' AS room_type, served.leaf_id, served.is_primary,
                  coalesce(nullif(n.canopy_display_name,''), n.display_name, served.leaf_id) AS leaf_name
           FROM (SELECT leaf_id, bed_location_id, true AS is_primary FROM canopy_leaf_assignment WHERE leaf_id = ANY(%s)
                 UNION ALL
                 SELECT leaf_id, bed_location_id, false FROM canopy_leaf_bed WHERE leaf_id = ANY(%s)) served
           JOIN canopy_location bed ON bed.id = served.bed_location_id
           LEFT JOIN canopy_location room ON room.id = bed.parent_id
           LEFT JOIN sync_leaf_node n ON n.leaf_id = served.leaf_id
           ORDER BY room.name, bed.name""", (leaf_ids, leaf_ids)).fetchall()
    from .routes.or_schedule import bed_cases
    busy = bed_cases(database, [{"id": row["bed_location_id"], "leaf_id": row["leaf_id"]} for row in rows])
    return [{**row, "busy": busy.get(row["bed_location_id"])} for row in rows]


def bed_target(database: Connection, bed_location_id: int) -> dict[str, Any]:
    row = database.execute(
        """SELECT bed.id, bed.name, coalesce(assignment.leaf_id, leaf_bed.leaf_id) AS leaf_id
           FROM canopy_location bed
           LEFT JOIN canopy_leaf_assignment assignment ON assignment.bed_location_id = bed.id
           LEFT JOIN canopy_leaf_bed leaf_bed ON leaf_bed.bed_location_id = bed.id
           WHERE bed.id = %s AND bed.kind = 'bed'""", (bed_location_id,)).fetchone()
    if row is None:
        raise TransferRefused("unknown bed")
    if not row["leaf_id"]:
        raise TransferRefused(f"{row['name']} has no Leaf; assign a Leaf to the bed under Infrastructure first")
    return row


def _admission_id(database: Connection, index: dict[str, Any]) -> str | None:
    export = database.execute("SELECT export FROM canopy_case_export WHERE global_case_id=%s",
                              (index["global_case_id"],)).fetchone()
    case = ((export or {}).get("export") or {}).get("case") or (index.get("snapshot") or {}).get("case") or {}
    return str(case["canopy_admission_id"]) if case.get("canopy_admission_id") else None


def offer(database: Connection, index: dict[str, Any], *, to_leaf_id: str, to_bed_location_id: int | None,
          to_bed_label: str | None, actor: str | None, initiated_from: str, note: str | None = None) -> dict[str, Any]:
    """Offer an active case (a sync_case_index row, locked by the caller) to a bed. Raises TransferRefused."""
    if index["status"] != "ACTIVE":
        raise TransferRefused(f"only an active case can be transferred (status {index['status']})")
    kind = "bed_move" if to_leaf_id == index["leaf_id"] else "transfer"
    if kind == "transfer" and database.execute(
            "SELECT 1 FROM canopy_case_export WHERE global_case_id=%s", (index["global_case_id"],)).fetchone() is None:
        raise TransferRefused("Canopy has no complete copy of this case yet; wait for the Leaf to sync")
    if kind == "bed_move" and not (to_bed_label or "").strip():
        raise TransferRefused("choose another bed")
    current = directory.now_ms()
    admission_id = _admission_id(database, index)
    try:
        with database.transaction():
            row = database.execute(
                """INSERT INTO canopy_case_handover (global_case_id, from_leaf_id, from_case_id, to_leaf_id, status, kind,
                       initiated_from, to_bed_location_id, to_bed_label, admission_id, note, requested_by, created_at, updated_at)
                   VALUES (%s,%s,%s,%s,'offered',%s,%s,%s,%s,%s,%s,%s,%s,%s) RETURNING *""",
                (index["global_case_id"], index["leaf_id"], index["source_case_id"], to_leaf_id, kind, initiated_from,
                 to_bed_location_id, (to_bed_label or "").strip() or None, admission_id, note, actor, current, current)).fetchone()
    except errors.UniqueViolation:
        raise TransferRefused("this case is already being moved") from None
    if admission_id:
        or_sessions.record_event(database, admission_id, "transfer_requested", actor=actor, source=initiated_from,
                                 leaf_id=index["leaf_id"], location_id=to_bed_location_id,
                                 detail={"to_leaf_id": to_leaf_id, "to_bed": row["to_bed_label"], "kind": kind})
    return row


def withdraw(database: Connection, handover_id: int, *, leaf_id: str | None = None, actor: str | None = None) -> dict[str, Any] | None:
    """Cancel an offer nobody received yet (leaf_id: only the source or destination Leaf may)."""
    row = database.execute(
        """UPDATE canopy_case_handover SET status='cancelled', updated_at=%s
           WHERE id=%s AND status='offered' AND (%s::text IS NULL OR from_leaf_id=%s OR to_leaf_id=%s) RETURNING *""",
        (directory.now_ms(), handover_id, leaf_id, leaf_id, leaf_id)).fetchone()
    if row and row["admission_id"]:
        or_sessions.record_event(database, row["admission_id"], "transfer_cancelled", actor=actor,
                                 source="leaf" if leaf_id else "canopy", leaf_id=row["from_leaf_id"])
    return row


def _move_admission(database: Connection, row: dict[str, Any], *, to_leaf_id: str) -> None:
    """The case's booking follows it: the destination Leaf owns it, the source becomes the previous Leaf."""
    if not row.get("admission_id"):
        return
    admission = database.execute("SELECT * FROM canopy_admission WHERE id::text=%s FOR UPDATE", (row["admission_id"],)).fetchone()
    if admission is None:
        return
    current = directory.now_ms()
    bed = row.get("to_bed_location_id") or (or_sessions._leaf_bed(database, to_leaf_id) if row["kind"] == "transfer" else None)
    journey = or_sessions._has_journey(database)
    if row["kind"] == "transfer":
        database.execute("UPDATE canopy_admission SET claimed_leaf_id=%s, updated_at=%s WHERE id=%s",
                         (to_leaf_id, current, admission["id"]))
        if journey:
            database.execute(
                """UPDATE canopy_admission SET current_leaf_id=%s, handed_from_leaf_id=%s,
                     current_bed_location_id=coalesce(%s, current_bed_location_id) WHERE id=%s""",
                (to_leaf_id, row["from_leaf_id"], bed, admission["id"]))
    elif journey and bed:
        database.execute("UPDATE canopy_admission SET current_bed_location_id=%s, updated_at=%s WHERE id=%s",
                         (bed, current, admission["id"]))
    if not journey:
        return
    from_bed = admission.get("current_bed_location_id")
    or_sessions.record_event(database, admission["id"], "transferred_room" if row["kind"] == "transfer" else "bed_moved",
                             actor=row.get("requested_by"), source="leaf", leaf_id=to_leaf_id, location_id=bed,
                             detail={"from_leaf_id": row["from_leaf_id"], "to_bed": row.get("to_bed_label")})
    or_sessions.movement(database, admission, "moved", at=current, from_location=from_bed, to_location=bed,
                         note=f"Transfer to {row.get('to_bed_label') or to_leaf_id} (case continues)")


def on_imported(database: Connection, row: dict[str, Any]) -> None:
    """The destination received an offered transfer and imported the case (not at claim: a failed import
    cancels the handover and the booking must stay with the source)."""
    if row.get("kind") == "transfer":
        _move_admission(database, row, to_leaf_id=row["to_leaf_id"])


def bed_moved(database: Connection, handover_id: int, leaf_id: str) -> dict[str, Any] | None:
    """The Leaf applied a bed move the ward desk offered."""
    row = database.execute(
        """UPDATE canopy_case_handover SET status='released', updated_at=%s
           WHERE id=%s AND kind='bed_move' AND status='offered' AND from_leaf_id=%s RETURNING *""",
        (directory.now_ms(), handover_id, leaf_id)).fetchone()
    if row:
        _move_admission(database, row, to_leaf_id=leaf_id)
    return row


def record_leaf_bed_move(database: Connection, index: dict[str, Any], bed_label: str, actor: str | None) -> None:
    """A Leaf moved its own case to another of its beds: keep the booking's bed (and the twin) in step."""
    beds = [bed for bed in ward_beds(database, [index["leaf_id"]])
            if bed_label.strip().lower() in ((bed["bed_name"] or "").strip().lower(), (bed["bed_code"] or "").strip().lower())]
    row = {"admission_id": _admission_id(database, index), "kind": "bed_move", "from_leaf_id": index["leaf_id"],
           "to_bed_location_id": beds[0]["bed_location_id"] if beds else None, "to_bed_label": bed_label, "requested_by": actor}
    _move_admission(database, row, to_leaf_id=index["leaf_id"])
