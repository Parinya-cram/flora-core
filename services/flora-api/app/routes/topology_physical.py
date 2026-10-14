"""Canopy → Topology → Physical: Care unit → Room (zone) → Bed.

Each bed shows the Leaf that serves it (one Leaf may serve one bed or several), the gateways
connected to that Leaf, and the devices fixed at the bed. Devices that are not fixed at a bed
(mobile / shared biomed, e.g. IPD or ER non-trauma) are shown only through their gateway link,
under the Leaf → gateway; they are never placed on a bed by guesswork.
"""
from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends
from psycopg import Connection

from ..database import connection
from .auth_canopy import read_token
from .fleet_read import fleet_scope, gateway_rows

router = APIRouter(prefix="/api/fleet/topology", tags=["canopy-fleet"], dependencies=[Depends(read_token)])


def _gateway_device_state(device: dict[str, Any]) -> str:
    if not device.get("enabled"):
        return "disabled"
    return "online" if device.get("parser_status") == "running" else "offline"


@router.get("/physical")
def physical_topology(scope: list[str] | None = Depends(fleet_scope),
                      database: Connection = Depends(connection)) -> dict[str, Any]:
    units = database.execute(
        """SELECT unit.id, unit.name, unit.is_demo, building.name AS building_name
           FROM canopy_location unit LEFT JOIN canopy_location building ON building.id=unit.parent_id
           WHERE unit.kind='care_unit' AND unit.is_active
             AND ((%s::text[] IS NULL AND NOT unit.is_demo) OR unit.id::text = ANY(%s))
           ORDER BY unit.sort_order, unit.name""", (scope, scope)).fetchall()
    unit_ids = [unit["id"] for unit in units]
    rooms = database.execute(
        """SELECT id, parent_id, name, zone FROM canopy_location
           WHERE kind='room' AND is_active AND parent_id=ANY(%s) ORDER BY sort_order, name""", (unit_ids,)).fetchall()
    beds = database.execute(
        """SELECT id, parent_id, name FROM canopy_location
           WHERE kind='bed' AND is_active AND parent_id=ANY(%s) ORDER BY sort_order, name""",
        ([room["id"] for room in rooms],)).fetchall()
    bed_ids = {bed["id"] for bed in beds}

    # Leafs and the beds they serve (primary assignment plus extra beds).
    leaf_rows = database.execute(
        """SELECT leaf.leaf_id, coalesce(nullif(leaf.canopy_display_name,''), leaf.display_name) AS display_name,
                  leaf.software_version, leaf.last_seen_at, a.bed_location_id AS primary_bed_id,
                  CASE WHEN leaf.last_seen_at >= now() - interval '90 seconds' THEN 'online'
                       WHEN leaf.last_seen_at >= now() - interval '10 minutes' THEN 'delayed' ELSE 'offline' END AS connection_status,
                  (SELECT count(*) FROM sync_case_index c WHERE c.leaf_id=leaf.leaf_id AND upper(c.status)='ACTIVE') AS active_cases
           FROM canopy_leaf_assignment a JOIN sync_leaf_node leaf ON leaf.leaf_id=a.leaf_id
           WHERE a.bed_location_id=ANY(%s)""", (list(bed_ids),)).fetchall()
    leaves: dict[str, dict[str, Any]] = {row["leaf_id"]: {**row, "bed_ids": [row["primary_bed_id"]], "gateways": [],
                                                         "devices": []} for row in leaf_rows}
    for extra in database.execute("SELECT leaf_id, bed_location_id FROM canopy_leaf_bed WHERE leaf_id=ANY(%s)",
                                  (list(leaves),)).fetchall():
        if extra["bed_location_id"] in bed_ids:
            leaves[extra["leaf_id"]]["bed_ids"].append(extra["bed_location_id"])
    leaf_by_bed = {bed: leaf_id for leaf_id, leaf in leaves.items() for bed in leaf["bed_ids"]}

    # Registry devices (fixed at a bed or linked to a gateway device).
    registry = database.execute(
        """SELECT id, display_name, category, device_type, bed_id, unit_id, gateway_id, gateway_device_id, status,
                  registry_status, last_event_type, last_event_at, asset_tag
           FROM canopy_medical_device WHERE unit_id=ANY(%s) OR bed_id=ANY(%s) OR gateway_id IS NOT NULL""",
        (unit_ids, list(bed_ids))).fetchall()
    by_link = {(row["gateway_id"], row["gateway_device_id"]): row for row in registry if row["gateway_id"]}

    def item(registered: dict[str, Any] | None, gateway: dict[str, Any] | None, device: dict[str, Any] | None,
             source: str) -> dict[str, Any]:
        return {
            "key": f"r{registered['id']}" if registered else f"g{gateway['gateway_id']}/{device['device_id']}",
            "label": (registered or {}).get("display_name") or (device or {}).get("label") or (device or {}).get("device_id"),
            "device_type": (device or {}).get("device_type") or (registered or {}).get("device_type"),
            "category": (registered or {}).get("category"),
            "source": source,                              # gateway | bed | both
            "registry_id": (registered or {}).get("id"),
            "asset_tag": (registered or {}).get("asset_tag"),
            "bed_id": (registered or {}).get("bed_id"),
            "gateway_id": gateway["gateway_id"] if gateway else (registered or {}).get("gateway_id"),
            "gateway_device_id": device["device_id"] if device else (registered or {}).get("gateway_device_id"),
            "state": _gateway_device_state(device) if device else "not_connected",
            "status": (registered or {}).get("status"),
            "last_event_type": (registered or {}).get("last_event_type"),
        }

    bed_devices: dict[int, list[dict[str, Any]]] = {}
    gateways_out: dict[str, dict[str, Any]] = {}
    placed: set[int] = set()
    for gateway in gateway_rows(database, None):
        for device in gateway["devices"]:
            registered = by_link.get((gateway["gateway_id"], device["device_id"]))
            fixed_bed = registered["bed_id"] if registered and registered["bed_id"] in bed_ids else None
            leaf = leaves.get(device.get("leaf_id") or "")
            if fixed_bed is None and leaf is None:
                continue
            gateways_out.setdefault(gateway["gateway_id"], {
                "gateway_id": gateway["gateway_id"],
                "name": (gateway.get("site") or {}).get("display_name") or gateway["gateway_id"],
                "connection_status": gateway["connection_status"],
            })
            if leaf is not None and gateway["gateway_id"] not in leaf["gateways"]:
                leaf["gateways"].append(gateway["gateway_id"])
            if fixed_bed is not None:   # fixed device: at its bed, still showing its gateway link
                bed_devices.setdefault(fixed_bed, []).append(item(registered, gateway, device, "both"))
                placed.add(registered["id"])
            else:                       # mobile / shared: only through Leaf → gateway
                leaf["devices"].append(item(registered, gateway, device, "gateway"))
                if registered:
                    placed.add(registered["id"])
    for registered in registry:         # fixed at a bed but not (or not yet) connected through a gateway
        if registered["bed_id"] in bed_ids and registered["id"] not in placed:
            bed_devices.setdefault(registered["bed_id"], []).append(item(registered, None, None, "bed"))

    rooms_by_unit: dict[int, list[dict[str, Any]]] = {}
    beds_by_room: dict[int, list[dict[str, Any]]] = {}
    for bed in beds:
        beds_by_room.setdefault(bed["parent_id"], []).append(
            {"id": bed["id"], "name": bed["name"], "leaf_id": leaf_by_bed.get(bed["id"]), "devices": bed_devices.get(bed["id"], [])})
    for room in rooms:
        rooms_by_unit.setdefault(room["parent_id"], []).append(
            {"id": room["id"], "name": room["name"], "zone": room["zone"], "beds": beds_by_room.get(room["id"], [])})
    return {
        "units": [{"key": str(unit["id"]), "name": unit["name"], "building_name": unit["building_name"],
                   "rooms": rooms_by_unit.get(unit["id"], [])} for unit in units],
        "leaves": leaves,
        "gateways": gateways_out,
    }
