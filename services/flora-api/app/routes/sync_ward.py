"""Canopy side of the Leaf Ward page, case handover and gateway device assignment.

Every call here is made BY a Leaf (outbound from behind NAT); Canopy answers and
queues anything a gateway must do in that gateway's desired configuration, which
the gateway collects on its next check-in.
"""
import time
import uuid
from typing import Any

from fastapi import APIRouter, Depends, HTTPException
from psycopg import Connection, errors
from psycopg.types.json import Jsonb
from pydantic import BaseModel, Field

from .. import case_transfer, hospital_profile, workflows
from ..database import connection
from .sync_ingest import DEVICE_FIELDS, require_protocol, require_sync_secret

router = APIRouter(prefix="/api/sync/v1", tags=["leaf-canopy-ward"], dependencies=[Depends(require_sync_secret)])
ONLINE_MS = 60_000


def now_ms() -> int:
    return int(time.time() * 1000)


@router.get("/leaves")
def leaves(database: Connection = Depends(connection)) -> dict[str, Any]:
    """The hospital's Leaf nodes (id, name, hospital, last-seen ms). Lets Haber build its
    overview/usage without reading canopy-db directly (so Haber can run as its own stack)."""
    rows = database.execute(
        """SELECT n.leaf_id, coalesce(nullif(n.canopy_display_name, ''), n.display_name) AS name, n.hospital_id,
                  extract(epoch FROM n.last_seen_at)*1000 AS last_seen,
                  u.unit_key AS ward_key, u.unit_name AS ward, room.name AS room, bed.name AS bed
           FROM sync_leaf_node n
           LEFT JOIN canopy_leaf_unit u ON u.leaf_id = n.leaf_id
           LEFT JOIN canopy_leaf_assignment a ON a.leaf_id = n.leaf_id
           LEFT JOIN canopy_location bed ON bed.id = a.bed_location_id
           LEFT JOIN canopy_location room ON room.id = bed.parent_id
           ORDER BY n.leaf_id""").fetchall()
    # Ward / room / bed let Root's topology draw Canopy -> ward -> bed (Leaf) -> gateway -> device.
    return {"leaves": [{"leaf_id": r["leaf_id"], "name": r["name"], "hospital_id": r["hospital_id"],
                        "last_seen": int(r["last_seen"] or 0), "ward_key": r["ward_key"], "ward": r["ward"],
                        "room": r["room"], "bed": r["bed"]} for r in rows]}


# ---------------------------------------------------------------- ward exchange

class WardExchange(BaseModel):
    leaf_id: str = Field(min_length=1, max_length=120)
    hospital_id: str | None = None
    released_ack: list[int] = Field(default_factory=list, max_length=200)
    protocol_version: int = Field(default=1, ge=1, le=1000)


def ward_leaf_ids(database: Connection, leaf_id: str, hospital_id: str | None) -> tuple[dict[str, Any] | None, list[str]]:
    """Leaves of the same care unit; without a unit assignment, the whole hospital."""
    unit = database.execute("SELECT unit_key, unit_name FROM canopy_leaf_unit WHERE leaf_id=%s", (leaf_id,)).fetchone()
    if unit:
        rows = database.execute("SELECT leaf_id FROM canopy_leaf_unit WHERE unit_key=%s", (unit["unit_key"],)).fetchall()
        return {"key": unit["unit_key"], "name": unit["unit_name"]}, [row["leaf_id"] for row in rows]
    rows = database.execute(
        "SELECT leaf_id FROM sync_leaf_node WHERE hospital_id = coalesce(%s, (SELECT hospital_id FROM sync_leaf_node WHERE leaf_id=%s))",
        (hospital_id, leaf_id)).fetchall()
    return None, [row["leaf_id"] for row in rows]


@router.post("/ward")
def ward(payload: WardExchange, database: Connection = Depends(connection)) -> dict[str, Any]:
    require_protocol(database, payload.leaf_id, payload.protocol_version)
    current = now_ms()
    with database.transaction():
        if payload.released_ack:
            database.execute(
                """UPDATE canopy_case_handover SET status='released', updated_at=%s
                   WHERE from_leaf_id=%s AND id = ANY(%s) AND status IN ('claimed','imported')""",
                (current, payload.leaf_id, payload.released_ack))
        unit, leaf_ids = ward_leaf_ids(database, payload.leaf_id, payload.hospital_id)
        leaves = database.execute(
            """SELECT n.leaf_id, coalesce(nullif(n.canopy_display_name,''), n.display_name) AS name,
                      (extract(epoch FROM n.last_seen_at) * 1000)::bigint AS last_seen,
                      n.metadata->'observed_location' AS location
               FROM sync_leaf_node n WHERE n.leaf_id = ANY(%s) ORDER BY 2""", (leaf_ids,)).fetchall()
        cases = database.execute(
            """SELECT i.global_case_id::text, i.leaf_id, i.source_case_id, i.case_code, i.hn, i.status, i.start_time,
                      i.snapshot->'patient'->'row'->>'name' AS patient_name,
                      i.snapshot->'case'->>'admission_number' AS admission_number,
                      (extract(epoch FROM i.last_synced_at) * 1000)::bigint AS synced_at,
                      e.revision AS export_revision
               FROM sync_case_index i LEFT JOIN canopy_case_export e ON e.global_case_id = i.global_case_id
               WHERE i.leaf_id = ANY(%s) AND i.status = 'ACTIVE'
               ORDER BY i.start_time DESC NULLS LAST""", (leaf_ids,)).fetchall()
        # A Leaf may hold several active cases (beds); active_case stays the newest for older Leaves.
        by_leaf: dict[str, list] = {}
        for row in cases:
            by_leaf.setdefault(row["leaf_id"], []).append(row)
        released = database.execute(
            """SELECT id AS handover_id, from_case_id AS source_case_id, to_leaf_id, global_case_id::text, kind
               FROM canopy_case_handover WHERE from_leaf_id=%s AND status IN ('claimed','imported')""",
            (payload.leaf_id,)).fetchall()
        # Transfers waiting for Receive (to this Leaf), offered from this Leaf, and ward-desk bed moves for it.
        offers = database.execute(
            """SELECT h.id AS handover_id, h.kind, h.global_case_id::text, h.from_leaf_id, h.from_case_id AS source_case_id,
                      h.to_leaf_id, h.to_bed_location_id, h.to_bed_label, h.initiated_from, h.requested_by, h.note, h.created_at,
                      i.hn, i.snapshot->'patient'->'row'->>'name' AS patient_name,
                      i.snapshot->'case'->>'admission_number' AS admission_number,
                      i.snapshot->'case'->>'bed_label' AS from_bed_label,
                      coalesce(nullif(n.canopy_display_name,''), n.display_name, h.from_leaf_id) AS from_leaf_name,
                      coalesce(nullif(t.canopy_display_name,''), t.display_name, h.to_leaf_id) AS to_leaf_name
               FROM canopy_case_handover h
               LEFT JOIN sync_case_index i ON i.global_case_id = h.global_case_id
               LEFT JOIN sync_leaf_node n ON n.leaf_id = h.from_leaf_id
               LEFT JOIN sync_leaf_node t ON t.leaf_id = h.to_leaf_id
               WHERE h.status = 'offered' AND (h.to_leaf_id = %s OR h.from_leaf_id = %s)
               ORDER BY h.created_at""", (payload.leaf_id, payload.leaf_id)).fetchall()
        handovers = database.execute(
            """SELECT id, global_case_id::text, from_leaf_id, to_leaf_id, to_case_id, status, created_at
               FROM canopy_case_handover WHERE (from_leaf_id = ANY(%s) OR to_leaf_id = ANY(%s)) AND created_at > %s
               ORDER BY created_at DESC LIMIT 20""", (leaf_ids, leaf_ids, current - 7 * 86_400_000)).fetchall()
        gateways = gateway_list(database)
        my_beds = case_transfer.leaf_beds(database, payload.leaf_id)
    return {
        "unit": unit,
        "leaves": [{**leaf, "online": bool(leaf["last_seen"] and current - leaf["last_seen"] < ONLINE_MS),
                    "active_case": (by_leaf.get(leaf["leaf_id"]) or [None])[0],
                    "active_cases": by_leaf.get(leaf["leaf_id"]) or []} for leaf in leaves],
        "gateways": gateways,
        "released": released,
        "handovers": handovers,
        "transfers_in": [row for row in offers if row["kind"] == "transfer" and row["to_leaf_id"] == payload.leaf_id],
        "transfers_out": [row for row in offers if row["kind"] == "transfer" and row["from_leaf_id"] == payload.leaf_id],
        "bed_moves": [row for row in offers if row["kind"] == "bed_move" and row["from_leaf_id"] == payload.leaf_id],
        # The beds this Leaf looks after and the devices at each (one session per bed).
        "my_beds": my_beds,
        # Workflow Studio: published workflows of this ward and their pinned Form Studio forms.
        "workflows": workflows.leaf_delivery(database, unit["key"] if unit else None),
        # The hospital's name and logo for printed reports and forms (hospital_profile.py).
        "hospital_profile": hospital_profile.delivery(database),
        "server_ts": current,
    }


def gateway_list(database: Connection) -> list[dict[str, Any]]:
    current = now_ms()
    rows = database.execute(
        """SELECT gateway_id, version, data_api_url, site, last_seen_at, desired_version, applied_version,
                  desired_source FROM canopy_gateway WHERE last_seen_at > 0 ORDER BY gateway_id""").fetchall()
    devices = database.execute(
        """SELECT gateway_id, device_id, leaf_id, device_type, label, enabled, pod, parser_status
           FROM canopy_gateway_device ORDER BY gateway_id, device_id""").fetchall()
    grouped: dict[str, list[dict[str, Any]]] = {}
    for device in devices:
        grouped.setdefault(device["gateway_id"], []).append(device)
    return [{
        "gateway_id": row["gateway_id"], "version": row["version"], "data_api_url": row["data_api_url"],
        "site_name": (row["site"] or {}).get("display_name") or row["gateway_id"],
        "site": {key: (row["site"] or {}).get(key) for key in ("hospital", "building", "floor", "unit", "room")},
        "last_seen": row["last_seen_at"], "online": current - (row["last_seen_at"] or 0) < ONLINE_MS,
        "config_pending": (row["desired_version"] or 0) > (row["applied_version"] or 0),
        "desired_version": row["desired_version"], "applied_version": row["applied_version"],
        "devices": grouped.get(row["gateway_id"], []),
    } for row in rows]


# ---------------------------------------------------------------- gateway device assignment

def current_config(database: Connection, gateway_id: str) -> dict[str, Any]:
    """Configuration to change a gateway's devices.

    Gateways apply `site` and `devices` independently, and a `devices` list is the full set
    (devices not listed are deleted). So the result always holds the complete device list —
    from a still-pending desired config if it has one, else as last reported — and carries a
    pending `site` along unchanged. Without a pending site it has no `site` key at all."""
    row = database.execute(
        "SELECT desired_config, desired_version, applied_version FROM canopy_gateway WHERE gateway_id=%s FOR UPDATE",
        (gateway_id,)).fetchone()
    if row is None:
        raise HTTPException(404, f"gateway {gateway_id} is not registered in Canopy")
    pending = row["desired_config"] if row["desired_config"] and (row["desired_version"] or 0) > (row["applied_version"] or 0) else {}
    config: dict[str, Any] = {}
    if "site" in pending:
        config["site"] = pending["site"]
    if "devices" in pending:
        config["devices"] = [dict(device) for device in pending["devices"] or []]
    else:
        devices = database.execute(
            f"SELECT device_id, {', '.join(DEVICE_FIELDS)} FROM canopy_gateway_device WHERE gateway_id=%s ORDER BY device_id",
            (gateway_id,)).fetchall()
        config["devices"] = [dict(device) for device in devices]
    return config


def queue_config(database: Connection, gateway_id: str, config: dict[str, Any], source: str) -> int:
    version = now_ms()
    database.execute(
        "UPDATE canopy_gateway SET desired_config=%s, desired_version=%s, desired_source=%s WHERE gateway_id=%s",
        (Jsonb(config), version, source, gateway_id))
    return version


def move_devices(database: Connection, from_leaf: str, to_leaf: str, source: str) -> list[dict[str, Any]]:
    moved = []
    # Check each gateway's effective config, not only what it last reported: a change queued
    # moments ago (e.g. the previous handover) may not have been reported back yet.
    for row in database.execute("SELECT gateway_id FROM canopy_gateway ORDER BY gateway_id").fetchall():
        config = current_config(database, row["gateway_id"])
        changed = [device["device_id"] for device in config["devices"] if device.get("leaf_id") == from_leaf]
        if not changed:
            continue
        for device in config["devices"]:
            if device.get("leaf_id") == from_leaf:
                device["leaf_id"] = to_leaf
        version = queue_config(database, row["gateway_id"], config, source)
        moved.append({"gateway_id": row["gateway_id"], "device_ids": changed, "desired_version": version})
    return moved


class Assignment(BaseModel):
    leaf_id: str = Field(min_length=1, max_length=120)
    device_ids: list[str] = Field(default_factory=list, max_length=200)
    release_others: bool = True
    actor: str | None = None


@router.post("/gateways/{gateway_id}/assign")
def assign_devices(gateway_id: str, payload: Assignment, database: Connection = Depends(connection)) -> dict[str, Any]:
    with database.transaction():
        config = current_config(database, gateway_id)
        known = {device["device_id"] for device in config["devices"]}
        unknown = sorted(set(payload.device_ids) - known)
        if unknown:
            raise HTTPException(400, f"not devices of {gateway_id}: {', '.join(unknown)}")
        for device in config["devices"]:
            if device["device_id"] in payload.device_ids:
                device["leaf_id"] = payload.leaf_id
            elif payload.release_others and device.get("leaf_id") == payload.leaf_id:
                device["leaf_id"] = None
        version = queue_config(database, gateway_id, config,
                               f"leaf {payload.leaf_id} wizard by {payload.actor or 'unknown'}")
    return {"gateway_id": gateway_id, "desired_version": version,
            "assigned": payload.device_ids, "note": "applied on the gateway's next check-in"}


# ---------------------------------------------------------------- case handover

class HandoverClaim(BaseModel):
    leaf_id: str = Field(min_length=1, max_length=120)
    global_case_id: str
    move_devices: bool = False
    actor: str | None = None
    # OR ward: a recovery bed's Leaf moving in a case that moved out of the OR room.
    admission_id: str | None = None
    # Receive of an offered transfer (case_transfer.py).
    handover_id: int | None = None


@router.post("/handover/claim")
def claim_handover(payload: HandoverClaim, database: Connection = Depends(connection)) -> dict[str, Any]:
    current = now_ms()
    try:
        with database.transaction():
            index = database.execute(
                "SELECT * FROM sync_case_index WHERE global_case_id::text=%s FOR UPDATE", (payload.global_case_id,)).fetchone()
            if index is None:
                raise HTTPException(404, "case not known to Canopy")
            if index["leaf_id"] == payload.leaf_id:
                raise HTTPException(409, "this Leaf already owns the case")
            offered = None
            if payload.handover_id is not None:
                offered = database.execute(
                    """SELECT * FROM canopy_case_handover WHERE id=%s AND global_case_id=%s AND kind='transfer' FOR UPDATE""",
                    (payload.handover_id, index["global_case_id"])).fetchone()
                if offered is None or offered["status"] != "offered":
                    raise HTTPException(409, "this transfer was withdrawn or already received")
                if offered["to_leaf_id"] != payload.leaf_id:
                    raise HTTPException(409, "this transfer is for another workstation")
            if index["status"] != "ACTIVE" and not payload.admission_id:
                raise HTTPException(409, f"only an active case can be taken over (status {index['status']})")
            export = database.execute(
                "SELECT export, revision FROM canopy_case_export WHERE global_case_id::text=%s",
                (payload.global_case_id,)).fetchone()
            if export is None:
                raise HTTPException(409, "Canopy has no complete copy of this case yet; wait for the Leaf to sync")
            if payload.admission_id:
                from .. import or_sessions
                try:
                    or_sessions.recovery_claim(database, payload.admission_id, payload.leaf_id, index, export["export"])
                except ValueError as error:
                    raise HTTPException(409, str(error)) from None
            moved = move_devices(database, index["leaf_id"], payload.leaf_id,
                                 f"handover {index['leaf_id']} -> {payload.leaf_id}") if payload.move_devices else []
            if offered is not None:
                handover = database.execute(
                    """UPDATE canopy_case_handover SET status='claimed', export_revision=%s, updated_at=%s
                       WHERE id=%s RETURNING id, to_bed_label, admission_id""",
                    (export["revision"], current, offered["id"])).fetchone()
            else:
                handover = database.execute(
                    """INSERT INTO canopy_case_handover (global_case_id, from_leaf_id, from_case_id, to_leaf_id, status,
                           move_devices, moved_devices, requested_by, export_revision, created_at, updated_at)
                       VALUES (%s,%s,%s,%s,'claimed',%s,%s,%s,%s,%s,%s) RETURNING id, to_bed_label, admission_id""",
                    (index["global_case_id"], index["leaf_id"], index["source_case_id"], payload.leaf_id,
                     payload.move_devices, Jsonb(moved), payload.actor, export["revision"], current, current)).fetchone()
            database.execute("UPDATE sync_case_index SET status='HANDED_OVER' WHERE global_case_id=%s",
                             (index["global_case_id"],))
    except errors.UniqueViolation:
        raise HTTPException(409, "this case is already being handed over") from None
    return {"handover_id": handover["id"], "from_leaf_id": index["leaf_id"], "export": export["export"],
            "export_age_sec": max(0, (current - export["revision"]) // 1000), "moved_devices": moved,
            "transfer": offered is not None, "to_bed_label": handover["to_bed_label"]}


class HandoverResult(BaseModel):
    to_case_id: int | None = None
    reason: str | None = None


@router.post("/handover/{handover_id}/imported")
def handover_imported(handover_id: int, payload: HandoverResult, database: Connection = Depends(connection)) -> dict:
    with database.transaction():
        row = database.execute(
            "UPDATE canopy_case_handover SET status='imported', to_case_id=%s, updated_at=%s WHERE id=%s AND status='claimed' RETURNING *",
            (payload.to_case_id, now_ms(), handover_id)).fetchone()
        if row:
            case_transfer.on_imported(database, row)
    return {"ok": True}


@router.post("/handover/{handover_id}/cancel")
def handover_cancel(handover_id: int, payload: HandoverResult, database: Connection = Depends(connection)) -> dict:
    with database.transaction():
        row = database.execute(
            "UPDATE canopy_case_handover SET status='cancelled', updated_at=%s WHERE id=%s AND status='claimed' RETURNING *",
            (now_ms(), handover_id)).fetchone()
        if row:
            database.execute("UPDATE sync_case_index SET status='ACTIVE' WHERE global_case_id=%s AND status='HANDED_OVER'",
                             (row["global_case_id"],))
            if row["move_devices"]:
                move_devices(database, row["to_leaf_id"], row["from_leaf_id"], f"handover {handover_id} cancelled")
            if row["kind"] == "transfer":
                # A failed Receive: the offer stands again, so the destination can retry.
                database.execute("UPDATE canopy_case_handover SET status='offered', updated_at=%s WHERE id=%s",
                                 (now_ms(), handover_id))
            else:
                from .. import or_sessions
                or_sessions.recovery_cancel(database, row)
    return {"ok": True, "cancelled": bool(row)}


# ---------------------------------------------------------------- transfer (case_transfer.py)

class TransferTargets(BaseModel):
    leaf_id: str = Field(min_length=1, max_length=120)
    hospital_id: str | None = None


@router.post("/transfer-targets")
def transfer_targets(payload: TransferTargets, database: Connection = Depends(connection)) -> dict[str, Any]:
    """Beds of this ward a case can be transferred to, with their Leaf and current case."""
    _, leaf_ids = ward_leaf_ids(database, payload.leaf_id, payload.hospital_id)
    return {"beds": case_transfer.ward_beds(database, list({*leaf_ids, payload.leaf_id}))}


class TransferOffer(BaseModel):
    leaf_id: str = Field(min_length=1, max_length=120)
    source_case_id: int
    to_leaf_id: str | None = Field(default=None, max_length=120)
    to_bed_location_id: int | None = None
    to_bed_label: str | None = Field(default=None, max_length=60)
    note: str | None = Field(default=None, max_length=500)
    actor: str | None = None
    # The source's newest full copy, so Receive does not miss what was charted since the last sync.
    export: dict[str, Any] | None = None


def _index(database: Connection, leaf_id: str, source_case_id: Any) -> dict[str, Any]:
    index = database.execute(
        "SELECT * FROM sync_case_index WHERE leaf_id=%s AND source_case_id=%s FOR UPDATE",
        (leaf_id, str(source_case_id))).fetchone()
    if index is None:
        raise HTTPException(409, "Canopy does not know this case yet; wait for the next sync")
    return index


@router.post("/handover/offer")
def offer_transfer(payload: TransferOffer, database: Connection = Depends(connection)) -> dict[str, Any]:
    current = now_ms()
    with database.transaction():
        index = _index(database, payload.leaf_id, payload.source_case_id)
        if payload.export:
            database.execute(
                """INSERT INTO canopy_case_export (global_case_id, leaf_id, source_case_id, revision, export, updated_at)
                   VALUES (%s,%s,%s,%s,%s,%s)
                   ON CONFLICT (global_case_id) DO UPDATE SET revision=excluded.revision, export=excluded.export,
                     updated_at=excluded.updated_at WHERE excluded.revision > canopy_case_export.revision""",
                (index["global_case_id"], payload.leaf_id, str(payload.source_case_id), current, Jsonb(payload.export), current))
        to_leaf, bed_label = payload.to_leaf_id, payload.to_bed_label
        try:
            if payload.to_bed_location_id is not None:
                bed = case_transfer.bed_target(database, payload.to_bed_location_id)
                to_leaf, bed_label = bed["leaf_id"], bed_label or bed["name"]
            if not to_leaf:
                raise case_transfer.TransferRefused("choose a bed or workstation")
            if database.execute("SELECT 1 FROM sync_leaf_node WHERE leaf_id=%s", (to_leaf,)).fetchone() is None:
                raise case_transfer.TransferRefused(f"unknown workstation {to_leaf}")
            row = case_transfer.offer(database, index, to_leaf_id=to_leaf, to_bed_location_id=payload.to_bed_location_id,
                                      to_bed_label=bed_label, actor=payload.actor, initiated_from="leaf", note=payload.note)
        except case_transfer.TransferRefused as error:
            raise HTTPException(409, str(error)) from None
    return {"handover_id": row["id"], "kind": row["kind"], "to_leaf_id": row["to_leaf_id"], "to_bed_label": row["to_bed_label"]}


class LeafOnly(BaseModel):
    leaf_id: str = Field(min_length=1, max_length=120)
    actor: str | None = None


@router.post("/handover/{handover_id}/withdraw")
def withdraw_transfer(handover_id: int, payload: LeafOnly, database: Connection = Depends(connection)) -> dict[str, Any]:
    with database.transaction():
        row = case_transfer.withdraw(database, handover_id, leaf_id=payload.leaf_id, actor=payload.actor)
    if row is None:
        raise HTTPException(409, "this transfer was already received or withdrawn")
    return {"ok": True}


@router.post("/handover/{handover_id}/bed-moved")
def bed_moved(handover_id: int, payload: LeafOnly, database: Connection = Depends(connection)) -> dict[str, Any]:
    with database.transaction():
        row = case_transfer.bed_moved(database, handover_id, payload.leaf_id)
    return {"ok": True, "applied": bool(row)}


class LeafBedMove(BaseModel):
    leaf_id: str = Field(min_length=1, max_length=120)
    source_case_id: int
    bed_label: str = Field(min_length=1, max_length=60)
    actor: str | None = None


@router.post("/cases/bed-move")
def leaf_bed_move(payload: LeafBedMove, database: Connection = Depends(connection)) -> dict[str, Any]:
    """A Leaf moved its own case to another of its beds (best effort: the snapshot carries it anyway)."""
    with database.transaction():
        index = database.execute("SELECT * FROM sync_case_index WHERE leaf_id=%s AND source_case_id=%s",
                                 (payload.leaf_id, str(payload.source_case_id))).fetchone()
        if index:
            case_transfer.record_leaf_bed_move(database, index, payload.bed_label, payload.actor)
    return {"ok": True, "known": bool(index)}


# ---------------------------------------------------------------- Leaf picks its bed (Settings > Location)

class LocationQuery(BaseModel):
    leaf_id: str = Field(min_length=1, max_length=120)


@router.post("/locations")
def locations(payload: LocationQuery, database: Connection = Depends(connection)) -> dict[str, Any]:
    """Canopy's active location tree and which Leaf sits at which bed."""
    rows = database.execute(
        """SELECT id, parent_id, kind, code, name FROM canopy_location
           WHERE is_active ORDER BY sort_order, lower(name)""").fetchall()
    assignments = database.execute(
        """SELECT a.leaf_id, a.bed_location_id, coalesce(nullif(n.canopy_display_name,''), n.display_name) AS leaf_name
           FROM canopy_leaf_assignment a LEFT JOIN sync_leaf_node n ON n.leaf_id = a.leaf_id
           ORDER BY a.leaf_id""").fetchall()
    leaves = database.execute(
        """SELECT leaf_id, coalesce(nullif(canopy_display_name,''), display_name) AS name FROM sync_leaf_node ORDER BY leaf_id""").fetchall()
    current = next((row["bed_location_id"] for row in assignments if row["leaf_id"] == payload.leaf_id), None)
    return {"locations": rows, "assignments": assignments, "leaves": leaves, "current_bed_id": current}


class LocationAssign(BaseModel):
    bed_location_id: int
    timezone: str = "Asia/Bangkok"
    date_format: str = "DD/MM/YYYY"
    time_format: str = "24h"


@router.post("/leaves/{leaf_id}/location")
def assign_location(leaf_id: str, payload: LocationAssign, database: Connection = Depends(connection)) -> dict[str, Any]:
    from .fleet_control import write_assignment  # same assignment an administrator makes in Canopy

    with database.transaction():
        row = write_assignment(database, leaf_id, payload.bed_location_id, {
            "timezone": payload.timezone, "date_format": payload.date_format, "time_format": payload.time_format})
    return {"leaf_id": leaf_id, "bed_location_id": payload.bed_location_id,
            "location": row["desired_config"]["location"], "version": row["desired_version"]}


class JourneyQuery(BaseModel):
    leaf_id: str = Field(min_length=1, max_length=120)
    case_id: str = Field(min_length=1, max_length=40)
    admission_number: str = Field(default="", max_length=80)


@router.post("/journey")
def patient_journey(payload: JourneyQuery, database: Connection = Depends(connection)) -> dict[str, Any]:
    """The earlier (and other) cases of the same AN, e.g. OR → Recovery → ICU, with their medications."""
    from .. import patient_journey as journey
    return {"cases": journey.journey(database, payload.admission_number, payload.leaf_id, payload.case_id)}


# ---------------------------------------------------------------- Central Charting on a Leaf

class CentralQuery(BaseModel):
    leaf_id: str = Field(min_length=1, max_length=120)
    limit_points: int = Field(default=30, ge=12, le=120)


def _leaf_ward(database: Connection, leaf_id: str) -> list[str]:
    """A Leaf sees the Central Charting of its own ward only (none when it has no ward)."""
    row = database.execute("SELECT unit_key FROM canopy_leaf_unit WHERE leaf_id=%s", (leaf_id,)).fetchone()
    if row is None or not row["unit_key"]:
        raise HTTPException(404, "this Leaf is not assigned to a ward in Canopy")
    return [str(row["unit_key"])]


@router.post("/central/overview")
def central_overview(payload: CentralQuery, database: Connection = Depends(connection)) -> dict[str, Any]:
    """Canopy's Central Charting overview (`/api/fleet/icu-overview`) for the Leafs of this Leaf's ward."""
    from .fleet_read import icu_overview
    return icu_overview(limit_points=payload.limit_points, scope=_leaf_ward(database, payload.leaf_id), database=database)


@router.post("/central/cases/{global_case_id}/snapshot")
def central_snapshot(global_case_id: uuid.UUID, payload: CentralQuery, database: Connection = Depends(connection)) -> dict:
    """One chart of the Central Charting view, limited to this Leaf's ward."""
    from .fleet_read import case_snapshot
    return case_snapshot(global_case_id, scope=_leaf_ward(database, payload.leaf_id), database=database)
