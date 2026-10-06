"""Canopy side of the Leaf Ward page, case handover and gateway device assignment.

Every call here is made BY a Leaf (outbound from behind NAT); Canopy answers and
queues anything a gateway must do in that gateway's desired configuration, which
the gateway collects on its next check-in.
"""
import time
from typing import Any

from fastapi import APIRouter, Depends, HTTPException
from psycopg import Connection, errors
from psycopg.types.json import Jsonb
from pydantic import BaseModel, Field

from ..database import connection
from .sync_ingest import DEVICE_FIELDS, require_sync_secret

router = APIRouter(prefix="/api/sync/v1", tags=["leaf-canopy-ward"], dependencies=[Depends(require_sync_secret)])
ONLINE_MS = 60_000


def now_ms() -> int:
    return int(time.time() * 1000)


# ---------------------------------------------------------------- ward exchange

class WardExchange(BaseModel):
    leaf_id: str = Field(min_length=1, max_length=120)
    hospital_id: str | None = None
    released_ack: list[int] = Field(default_factory=list, max_length=200)


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
               WHERE i.leaf_id = ANY(%s) AND i.status = 'ACTIVE'""", (leaf_ids,)).fetchall()
        by_leaf = {row["leaf_id"]: row for row in cases}
        released = database.execute(
            """SELECT id AS handover_id, from_case_id AS source_case_id, to_leaf_id, global_case_id::text
               FROM canopy_case_handover WHERE from_leaf_id=%s AND status IN ('claimed','imported')""",
            (payload.leaf_id,)).fetchall()
        handovers = database.execute(
            """SELECT id, global_case_id::text, from_leaf_id, to_leaf_id, to_case_id, status, created_at
               FROM canopy_case_handover WHERE (from_leaf_id = ANY(%s) OR to_leaf_id = ANY(%s)) AND created_at > %s
               ORDER BY created_at DESC LIMIT 20""", (leaf_ids, leaf_ids, current - 7 * 86_400_000)).fetchall()
        gateways = gateway_list(database)
    return {
        "unit": unit,
        "leaves": [{**leaf, "online": bool(leaf["last_seen"] and current - leaf["last_seen"] < ONLINE_MS),
                    "active_case": by_leaf.get(leaf["leaf_id"])} for leaf in leaves],
        "gateways": gateways,
        "released": released,
        "handovers": handovers,
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
            if index["status"] != "ACTIVE":
                raise HTTPException(409, f"only an active case can be taken over (status {index['status']})")
            export = database.execute(
                "SELECT export, revision FROM canopy_case_export WHERE global_case_id::text=%s",
                (payload.global_case_id,)).fetchone()
            if export is None:
                raise HTTPException(409, "Canopy has no complete copy of this case yet; wait for the Leaf to sync")
            moved = move_devices(database, index["leaf_id"], payload.leaf_id,
                                 f"handover {index['leaf_id']} -> {payload.leaf_id}") if payload.move_devices else []
            handover = database.execute(
                """INSERT INTO canopy_case_handover (global_case_id, from_leaf_id, from_case_id, to_leaf_id, status,
                       move_devices, moved_devices, requested_by, export_revision, created_at, updated_at)
                   VALUES (%s,%s,%s,%s,'claimed',%s,%s,%s,%s,%s,%s) RETURNING id""",
                (index["global_case_id"], index["leaf_id"], index["source_case_id"], payload.leaf_id,
                 payload.move_devices, Jsonb(moved), payload.actor, export["revision"], current, current)).fetchone()
            database.execute("UPDATE sync_case_index SET status='HANDED_OVER' WHERE global_case_id=%s",
                             (index["global_case_id"],))
    except errors.UniqueViolation:
        raise HTTPException(409, "this case is already being handed over") from None
    return {"handover_id": handover["id"], "from_leaf_id": index["leaf_id"], "export": export["export"],
            "export_age_sec": max(0, (current - export["revision"]) // 1000), "moved_devices": moved}


class HandoverResult(BaseModel):
    to_case_id: int | None = None
    reason: str | None = None


@router.post("/handover/{handover_id}/imported")
def handover_imported(handover_id: int, payload: HandoverResult, database: Connection = Depends(connection)) -> dict:
    database.execute(
        "UPDATE canopy_case_handover SET status='imported', to_case_id=%s, updated_at=%s WHERE id=%s AND status='claimed'",
        (payload.to_case_id, now_ms(), handover_id))
    database.commit()
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
    return {"ok": True, "cancelled": bool(row)}
