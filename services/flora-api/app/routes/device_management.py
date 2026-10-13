"""Devices at Canopy: the medical device and gateway registry, grouped by ward, with the
hourly activity and on/off events gateways send through Haber.

- sync mode:   POST /api/sync/v1/gateways/{id}/activity              (Haber relay, sync secret)
- canopy mode: GET  /api/fleet/device-management                     (registry by ward, last 24 h)
               GET  /api/fleet/device-management/devices/{id}        (detail: hours, events, link options)
               GET  /api/fleet/device-management/gateways/{id}       (detail: hours, devices, events)
               writes under /api/fleet/control/device-management     (Canopy administrators)
"""
from __future__ import annotations

from typing import Any, Literal

from fastapi import APIRouter, Depends, HTTPException, Query
from psycopg import Connection, errors
from psycopg.types.json import Jsonb
from pydantic import BaseModel, Field

from .. import device_registry, device_types, directory
from ..database import connection
from .auth_canopy import read_token
from .fleet_control import require_admin
from .fleet_read import _haber_overview, fleet_scope
from .sync_ingest import require_sync_secret

sync_router = APIRouter(prefix="/api/sync/v1", tags=["leaf-canopy-sync"])
fleet_router = APIRouter(prefix="/api/fleet/device-management", tags=["canopy-devices"],
                         dependencies=[Depends(read_token)])
control_router = APIRouter(prefix="/api/fleet/control/device-management", tags=["canopy-devices"],
                           dependencies=[Depends(require_admin)])

HOUR_MS = 3_600_000
GATEWAY_UNIT = """coalesce(g.unit_id, (SELECT u.id FROM canopy_location u WHERE u.kind='care_unit'
                    AND lower(u.name)=lower(g.site->>'unit') ORDER BY u.id LIMIT 1))"""


# ------------------------------------------------------------------ ingest (sync mode)

class ActivityHour(BaseModel):
    subject: Literal["gateway", "device"]
    device_id: str = Field(default="", max_length=120)
    hour_start: int = Field(ge=0)
    samples_ok: int = Field(default=0, ge=0)
    samples_down: int = Field(default=0, ge=0)
    samples_stopped: int = Field(default=0, ge=0)
    online_seconds: int = Field(default=0, ge=0, le=3600)
    observations: int = Field(default=0, ge=0)
    first_data_ts: int | None = None
    last_data_ts: int | None = None
    power_on: int = Field(default=0, ge=0)
    power_off: int = Field(default=0, ge=0)
    complete: bool = False
    version: int = Field(ge=1)


class DeviceEvent(BaseModel):
    id: int
    device_id: str = Field(max_length=120)
    event_type: Literal["power_on", "power_off", "data_resumed", "data_stopped"]
    basis: Literal["connection", "data"]
    occurred_at: int
    detail: str | None = Field(default=None, max_length=500)


class ActivityBatch(BaseModel):
    hours: list[ActivityHour] = Field(default_factory=list, max_length=1000)
    events: list[DeviceEvent] = Field(default_factory=list, max_length=2000)


@sync_router.post("/gateways/{gateway_id}/activity", dependencies=[Depends(require_sync_secret)])
def store_device_activity(gateway_id: str, payload: ActivityBatch,
                          database: Connection = Depends(connection)) -> dict[str, Any]:
    return device_registry.store_activity(database, gateway_id, [h.model_dump() for h in payload.hours],
                                          [e.model_dump() for e in payload.events], directory.now_ms())


# ------------------------------------------------------------------ helpers

def _connection_status(last_seen_at: int | None, now: int) -> str:
    if not last_seen_at:
        return "pending"
    age = now - int(last_seen_at)
    return "online" if age <= 90_000 else "delayed" if age <= 600_000 else "offline"


def _hour_cell(row: dict[str, Any]) -> float | None:
    """Share of the hour the device was sending data; -1 = disabled the whole hour; None = no samples."""
    live = row["samples_ok"] + row["samples_down"]
    if live:
        return round(row["samples_ok"] / live, 3)
    return -1 if row["samples_stopped"] else None


def _device_state(device: dict[str, Any], gateway_status: str | None) -> str:
    if not device.get("gateway_id"):
        return "unlinked"
    if not device.get("reported"):
        return "not_reported"
    if device.get("enabled") is False:
        return "disabled"
    if gateway_status in (None, "pending", "offline"):
        return "unknown"
    if device.get("last_event_type") in device_registry.OFF_EVENTS:
        return "off"
    if device.get("last_event_type") in device_registry.ON_EVENTS:
        return "on"
    last = device.get("_last_hour")
    if last is None:
        return "unknown"
    return "on" if last["samples_ok"] else "off"


def _units(database: Connection) -> dict[int, dict[str, Any]]:
    return {row["id"]: row for row in database.execute(
        """SELECT unit.id, unit.name, unit.is_demo, building.name AS building_name, unit.sort_order
           FROM canopy_location unit LEFT JOIN canopy_location building ON building.id=unit.parent_id
           WHERE unit.kind='care_unit' AND unit.is_active ORDER BY unit.sort_order, unit.name""").fetchall()}


def _devices(database: Connection, where: str, params: tuple) -> list[dict[str, Any]]:
    return [dict(row) for row in database.execute(
        f"""SELECT d.*, gd.enabled, gd.leaf_id, gd.parser_status, gd.pod, gd.label AS gateway_label,
                   gd.device_type AS reported_type, (gd.device_id IS NOT NULL) AS reported,
                   coalesce(nullif(leaf.canopy_display_name,''), leaf.display_name) AS leaf_name
            FROM canopy_medical_device d
            LEFT JOIN canopy_gateway_device gd ON gd.gateway_id=d.gateway_id AND gd.device_id=d.gateway_device_id
            LEFT JOIN sync_leaf_node leaf ON leaf.leaf_id=gd.leaf_id
            WHERE {where} ORDER BY d.display_name, d.id""", params).fetchall()]


def _gateways(database: Connection, where: str = "TRUE", params: tuple = ()) -> list[dict[str, Any]]:
    return [dict(row) for row in database.execute(
        f"""SELECT g.gateway_id, g.display_name, g.registry_status, g.serial_number, g.asset_tag, g.registry_notes,
                   g.registered_at, g.registered_by, g.version, g.first_seen_at, g.last_seen_at, g.site,
                   g.license, g.data_api_url, {GATEWAY_UNIT} AS unit_id,
                   (SELECT count(*) FROM canopy_gateway_device gd WHERE gd.gateway_id=g.gateway_id) AS reported_devices,
                   (SELECT count(*) FROM canopy_gateway_device gd WHERE gd.gateway_id=g.gateway_id AND gd.enabled)
                     AS enabled_devices
            FROM canopy_gateway g WHERE {where} ORDER BY coalesce(g.display_name, g.gateway_id)""", params).fetchall()]


def _hours(database: Connection, since: int, gateway_id: str | None = None, subject: str | None = None,
           device_id: str | None = None) -> list[dict[str, Any]]:
    conditions, params = ["hour_start >= %s"], [since]
    for column, value in (("gateway_id", gateway_id), ("subject", subject), ("device_id", device_id)):
        if value is not None:
            conditions.append(f"{column}=%s")
            params.append(value)
    return database.execute(
        f"""SELECT gateway_id, subject, device_id, hour_start, samples_ok, samples_down, samples_stopped,
                   online_seconds, observations, power_on, power_off, complete
            FROM canopy_device_activity_hour WHERE {' AND '.join(conditions)} ORDER BY hour_start""",
        tuple(params)).fetchall()


def _series(rows: list[dict[str, Any]], start: int, count: int) -> list[float | None]:
    cells: list[float | None] = [None] * count
    for row in rows:
        index = (int(row["hour_start"]) - start) // HOUR_MS
        if 0 <= index < count:
            cells[index] = _hour_cell(row)
    return cells


def _uptime(rows: list[dict[str, Any]]) -> float | None:
    ok = sum(row["samples_ok"] for row in rows)
    live = ok + sum(row["samples_down"] for row in rows)
    return round(ok / live, 4) if live else None


def _ward(units: dict[int, dict[str, Any]], unit_id: int | None) -> dict[str, Any]:
    unit = units.get(unit_id) if unit_id is not None else None
    return {"unit_key": str(unit_id) if unit else None, "unit_name": unit["name"] if unit else None}


# ------------------------------------------------------------------ reads

@fleet_router.get("")
def device_management(scope: list[str] | None = Depends(fleet_scope),
                      database: Connection = Depends(connection)) -> dict[str, Any]:
    """Every ward the viewer may see, with its gateways and devices and the last 24 hours."""
    now = directory.now_ms()
    start = now - now % HOUR_MS - 23 * HOUR_MS
    units = _units(database)
    devices = _devices(database, "(%s::text[] IS NULL OR d.unit_id::text = ANY(%s))", (scope, scope))
    gateways = _gateways(database)
    gateway_status = {g["gateway_id"]: _connection_status(g["last_seen_at"], now) for g in gateways}
    hours = _hours(database, start)
    by_device: dict[tuple[str, str], list[dict[str, Any]]] = {}
    by_gateway: dict[str, list[dict[str, Any]]] = {}
    for row in hours:
        if row["subject"] == "device":
            by_device.setdefault((row["gateway_id"], row["device_id"]), []).append(row)
        else:
            by_gateway.setdefault(row["gateway_id"], []).append(row)

    device_rows = []
    for device in devices:
        rows = by_device.get((device["gateway_id"], device["gateway_device_id"]), []) if device["gateway_id"] else []
        device["_last_hour"] = rows[-1] if rows else None
        state = _device_state(device, gateway_status.get(device["gateway_id"] or ""))
        device.pop("_last_hour")
        device_rows.append({**device, **_ward(units, device["unit_id"]), "state": state,
                            "hours": _series(rows, start, 24), "uptime_24h": _uptime(rows),
                            "observations_24h": sum(row["observations"] for row in rows)})

    visible_gateways = {d["gateway_id"] for d in device_rows if d["gateway_id"]}
    gateway_rows = []
    for gateway in gateways:
        in_ward = scope is None or (gateway["unit_id"] is not None and str(gateway["unit_id"]) in scope)
        if not in_ward and gateway["gateway_id"] not in visible_gateways:
            continue
        rows = by_gateway.get(gateway["gateway_id"], [])
        gateway_rows.append({**gateway, **_ward(units, gateway["unit_id"]), "in_ward": in_ward,
                             "connection_status": gateway_status[gateway["gateway_id"]],
                             "hours": _series(rows, start, 24), "uptime_24h": _uptime(rows),
                             "max_devices": (gateway["license"] or {}).get("max_devices")})

    wards = [{"key": str(unit_id), "name": unit["name"], "building_name": unit["building_name"], "is_demo": unit["is_demo"]}
             for unit_id, unit in units.items()
             if (scope is None and not unit["is_demo"]) or (scope is not None and str(unit_id) in scope)]
    return {"server_time": now, "hours_start": start, "wards": wards, "gateways": gateway_rows,
            "devices": device_rows}


@fleet_router.get("/devices/{device_pk}")
def device_detail(device_pk: int, days: int = Query(default=7, ge=1, le=90),
                  scope: list[str] | None = Depends(fleet_scope),
                  database: Connection = Depends(connection)) -> dict[str, Any]:
    rows = _devices(database, "d.id=%s", (device_pk,))
    if not rows:
        raise HTTPException(404, "device not found")
    device = rows[0]
    if scope is not None and (device["unit_id"] is None or str(device["unit_id"]) not in scope):
        raise HTTPException(403, "this device is not in your ward")
    now = directory.now_ms()
    start = now - now % HOUR_MS - (days * 24 - 1) * HOUR_MS
    hours, events, reported = [], [], None
    if device["gateway_id"]:
        hours = _hours(database, start, device["gateway_id"], "device", device["gateway_device_id"])
        events = database.execute(
            """SELECT event_id, event_type, basis, occurred_at, detail FROM canopy_device_event
               WHERE gateway_id=%s AND device_id=%s ORDER BY occurred_at DESC LIMIT 200""",
            (device["gateway_id"], device["gateway_device_id"])).fetchall()
        reported = database.execute(
            "SELECT * FROM canopy_gateway_device WHERE gateway_id=%s AND device_id=%s",
            (device["gateway_id"], device["gateway_device_id"])).fetchone()
    gateway = _gateways(database, "g.gateway_id=%s", (device["gateway_id"],))[0] if device["gateway_id"] else None
    units = _units(database)
    device["_last_hour"] = hours[-1] if hours else None
    state = _device_state(device, _connection_status(gateway["last_seen_at"], now) if gateway else None)
    device.pop("_last_hour")
    return {"device": {**device, **_ward(units, device["unit_id"]), "state": state}, "hours_start": start,
            "hours": hours, "uptime": _uptime(hours), "events": events, "reported": reported,
            "gateway": {**gateway, **_ward(units, gateway["unit_id"]),
                        "connection_status": _connection_status(gateway["last_seen_at"], now)} if gateway else None}


@fleet_router.get("/gateways/{gateway_id}")
def gateway_detail(gateway_id: str, days: int = Query(default=7, ge=1, le=90),
                   scope: list[str] | None = Depends(fleet_scope),
                   database: Connection = Depends(connection)) -> dict[str, Any]:
    rows = _gateways(database, "g.gateway_id=%s", (gateway_id,))
    if not rows:
        raise HTTPException(404, "gateway not found")
    gateway, now, units = rows[0], directory.now_ms(), _units(database)
    devices = _devices(database, "d.gateway_id=%s AND (%s::text[] IS NULL OR d.unit_id::text = ANY(%s))",
                       (gateway_id, scope, scope))
    if scope is not None and not devices and (gateway["unit_id"] is None or str(gateway["unit_id"]) not in scope):
        raise HTTPException(403, "this gateway is not in your ward")
    start = now - now % HOUR_MS - (days * 24 - 1) * HOUR_MS
    hours = _hours(database, start, gateway_id, "gateway")
    visible = [d["gateway_device_id"] for d in devices]
    events = database.execute(
        """SELECT event.*, device.display_name FROM canopy_device_event event
           LEFT JOIN canopy_medical_device device ON device.gateway_id=event.gateway_id
                                                 AND device.gateway_device_id=event.device_id
           WHERE event.gateway_id=%s AND (%s::text[] IS NULL OR event.device_id = ANY(%s))
           ORDER BY event.occurred_at DESC LIMIT 200""",
        (gateway_id, None if scope is None else visible, visible)).fetchall()
    # Devices the gateway reports, for linking registry rows (admins).
    reported = database.execute(
        """SELECT gd.device_id, gd.label, gd.device_type, gd.serial_number, gd.asset_tag, gd.enabled, gd.leaf_id,
                  d.id AS registry_id, d.display_name AS registry_name
           FROM canopy_gateway_device gd
           LEFT JOIN canopy_medical_device d ON d.gateway_id=gd.gateway_id AND d.gateway_device_id=gd.device_id
           WHERE gd.gateway_id=%s ORDER BY gd.device_id""", (gateway_id,)).fetchall() if scope is None else []
    return {"gateway": {**gateway, **_ward(units, gateway["unit_id"]),
                        "connection_status": _connection_status(gateway["last_seen_at"], now)},
            "hours_start": start, "hours": hours, "uptime": _uptime(hours),
            "devices": [{**d, **_ward(units, d["unit_id"])} for d in devices], "events": events,
            "reported": reported}


@fleet_router.get("/link-options")
def link_options(database: Connection = Depends(connection)) -> dict[str, Any]:
    """Every device a gateway reports, and which registry row (if any) it is linked to."""
    rows = database.execute(
        """SELECT gd.gateway_id, coalesce(g.display_name, g.site->>'display_name', gd.gateway_id) AS gateway_name,
                  gd.device_id, gd.label, gd.device_type, gd.serial_number, gd.asset_tag,
                  d.id AS registry_id, d.display_name AS registry_name
           FROM canopy_gateway_device gd JOIN canopy_gateway g USING (gateway_id)
           LEFT JOIN canopy_medical_device d ON d.gateway_id=gd.gateway_id AND d.gateway_device_id=gd.device_id
           ORDER BY gd.gateway_id, gd.device_id""").fetchall()
    return {"rows": rows}


# ------------------------------------------------------------------ writes (administrators)

class DeviceInput(BaseModel):
    display_name: str = Field(min_length=1, max_length=200)
    category: str | None = Field(default=None, max_length=60)
    device_type: str | None = Field(default=None, max_length=80)
    manufacturer: str | None = Field(default=None, max_length=120)
    model: str | None = Field(default=None, max_length=120)
    serial_number: str | None = Field(default=None, max_length=120)
    asset_tag: str | None = Field(default=None, max_length=120)
    unit_id: int | None = None
    location: str | None = Field(default=None, max_length=200)
    status: Literal["in_service", "maintenance", "out_of_service", "retired"] = "in_service"
    acquired_at: int | None = None
    warranty_until: int | None = None
    last_pm_at: int | None = None
    next_pm_at: int | None = None
    vendor_contact: str | None = Field(default=None, max_length=300)
    notes: str | None = Field(default=None, max_length=4000)


DEVICE_COLUMNS = tuple(DeviceInput.model_fields)


def _clean(payload: BaseModel) -> dict[str, Any]:
    values = payload.model_dump()
    return {key: (value.strip() or None) if isinstance(value, str) else value for key, value in values.items()}


def _check_unit(database: Connection, unit_id: int | None) -> None:
    if unit_id is not None and not database.execute(
            "SELECT 1 FROM canopy_location WHERE id=%s AND kind='care_unit'", (unit_id,)).fetchone():
        raise HTTPException(404, "ward not found")


@control_router.post("/devices")
def create_device(payload: DeviceInput, user: dict[str, Any] = Depends(read_token),
                  database: Connection = Depends(connection)) -> dict[str, Any]:
    values, now = _clean(payload), directory.now_ms()
    _check_unit(database, values["unit_id"])
    try:
        row = database.execute(
            f"""INSERT INTO canopy_medical_device ({', '.join(DEVICE_COLUMNS)}, registry_status, created_at, created_by,
                    updated_at, updated_by)
                VALUES ({', '.join(['%s'] * len(DEVICE_COLUMNS))}, 'registered', %s, %s, %s, %s) RETURNING id""",
            (*(values[c] for c in DEVICE_COLUMNS), now, user.get("username"), now, user.get("username"))).fetchone()
    except errors.UniqueViolation:
        raise HTTPException(409, "another device already has this asset tag") from None
    return {"ok": True, "id": row["id"]}


@control_router.put("/devices/{device_pk}")
def update_device(device_pk: int, payload: DeviceInput, user: dict[str, Any] = Depends(read_token),
                  database: Connection = Depends(connection)) -> dict[str, Any]:
    """Saving a device an administrator has reviewed also marks it registered."""
    values = _clean(payload)
    _check_unit(database, values["unit_id"])
    try:
        row = database.execute(
            f"""UPDATE canopy_medical_device SET {', '.join(f'{c}=%s' for c in DEVICE_COLUMNS)},
                    registry_status='registered', updated_at=%s, updated_by=%s WHERE id=%s RETURNING id""",
            (*(values[c] for c in DEVICE_COLUMNS), directory.now_ms(), user.get("username"), device_pk)).fetchone()
    except errors.UniqueViolation:
        raise HTTPException(409, "another device already has this asset tag") from None
    if not row:
        raise HTTPException(404, "device not found")
    return {"ok": True, "id": device_pk}


class LinkInput(BaseModel):
    gateway_id: str | None = Field(default=None, max_length=120)
    gateway_device_id: str | None = Field(default=None, max_length=120)


@control_router.put("/devices/{device_pk}/link")
def link_device(device_pk: int, payload: LinkInput, user: dict[str, Any] = Depends(read_token),
                database: Connection = Depends(connection)) -> dict[str, Any]:
    """Attach a registry device to the device a gateway reports (both empty = unlink).
    A row the gateway added automatically for that device is merged away."""
    if (payload.gateway_id is None) != (payload.gateway_device_id is None):
        raise HTTPException(422, "gateway_id and gateway_device_id go together")
    now = directory.now_ms()
    with database.transaction():
        if payload.gateway_id:
            other = database.execute(
                "SELECT id, registry_status FROM canopy_medical_device WHERE gateway_id=%s AND gateway_device_id=%s "
                "AND id<>%s FOR UPDATE", (payload.gateway_id, payload.gateway_device_id, device_pk)).fetchone()
            if other and other["registry_status"] != "auto":
                raise HTTPException(409, "that gateway device is already linked to another registered device")
            if other:
                database.execute("DELETE FROM canopy_medical_device WHERE id=%s", (other["id"],))
        row = database.execute(
            """UPDATE canopy_medical_device SET gateway_id=%s, gateway_device_id=%s, last_event_type=NULL,
                   last_event_at=NULL, updated_at=%s, updated_by=%s WHERE id=%s RETURNING id""",
            (payload.gateway_id, payload.gateway_device_id, now, user.get("username"), device_pk)).fetchone()
        if not row:
            raise HTTPException(404, "device not found")
        if payload.gateway_id:
            last = database.execute(
                """SELECT event_type, occurred_at FROM canopy_device_event WHERE gateway_id=%s AND device_id=%s
                   ORDER BY occurred_at DESC LIMIT 1""", (payload.gateway_id, payload.gateway_device_id)).fetchone()
            if last:
                database.execute("UPDATE canopy_medical_device SET last_event_type=%s, last_event_at=%s WHERE id=%s",
                                 (last["event_type"], last["occurred_at"], device_pk))
    return {"ok": True}


@control_router.delete("/devices/{device_pk}")
def delete_device(device_pk: int, database: Connection = Depends(connection)) -> dict[str, Any]:
    """Removes a registry entry. A device its gateway still reports comes back as 'auto' at the
    next check-in; retire it (status) to keep its history instead."""
    row = database.execute("DELETE FROM canopy_medical_device WHERE id=%s RETURNING id", (device_pk,)).fetchone()
    if not row:
        raise HTTPException(404, "device not found")
    return {"ok": True}


class GatewayRegistryInput(BaseModel):
    display_name: str | None = Field(default=None, max_length=200)
    serial_number: str | None = Field(default=None, max_length=120)
    asset_tag: str | None = Field(default=None, max_length=120)
    registry_notes: str | None = Field(default=None, max_length=4000)
    registry_status: Literal["registered", "retired"] = "registered"
    unit_id: int | None = None


class GatewayCreateInput(GatewayRegistryInput):
    gateway_id: str = Field(min_length=3, max_length=120, pattern=r"^[A-Za-z0-9_.-]+$")


@control_router.put("/gateways/{gateway_id}")
def update_gateway(gateway_id: str, payload: GatewayRegistryInput, user: dict[str, Any] = Depends(read_token),
                   database: Connection = Depends(connection)) -> dict[str, Any]:
    """Registry details of a gateway; saving an automatically added gateway registers it."""
    values = _clean(payload)
    _check_unit(database, values["unit_id"])
    row = database.execute(
        """UPDATE canopy_gateway SET display_name=%s, serial_number=%s, asset_tag=%s, registry_notes=%s,
               registry_status=%s, unit_id=%s,
               registered_at=CASE WHEN registry_status='auto' THEN %s ELSE coalesce(registered_at, %s) END,
               registered_by=CASE WHEN registry_status='auto' THEN %s ELSE coalesce(registered_by, %s) END
           WHERE gateway_id=%s RETURNING gateway_id""",
        (values["display_name"], values["serial_number"], values["asset_tag"], values["registry_notes"],
         values["registry_status"], values["unit_id"], directory.now_ms(), directory.now_ms(),
         user.get("username"), user.get("username"), gateway_id)).fetchone()
    if not row:
        raise HTTPException(404, "gateway not found")
    return {"ok": True}


@control_router.post("/gateways")
def register_gateway(payload: GatewayCreateInput, user: dict[str, Any] = Depends(read_token),
                     database: Connection = Depends(connection)) -> dict[str, Any]:
    """Pre-register a gateway before it is installed; it links up at its first check-in."""
    values, now = _clean(payload), directory.now_ms()
    _check_unit(database, values["unit_id"])
    row = database.execute(
        """INSERT INTO canopy_gateway (gateway_id, site, license, first_seen_at, last_seen_at, config_changed_at,
               display_name, serial_number, asset_tag, registry_notes, registry_status, unit_id, registered_at,
               registered_by)
           VALUES (%s,'{}'::jsonb,'{}'::jsonb,0,0,0,%s,%s,%s,%s,'registered',%s,%s,%s)
           ON CONFLICT (gateway_id) DO NOTHING RETURNING gateway_id""",
        (payload.gateway_id, values["display_name"], values["serial_number"], values["asset_tag"],
         values["registry_notes"], values["unit_id"], now, user.get("username"))).fetchone()
    if not row:
        raise HTTPException(409, "a gateway with this id already exists")
    return {"ok": True, "gateway_id": payload.gateway_id}


# ------------------------------------------------------------------ device types

def _release_catalog() -> tuple[list[dict[str, Any]], list[str], str | None]:
    """Types every gateway receives from the approved Root release (via Haber), and the parsers available."""
    overview, error = _haber_overview()
    catalog = (overview or {}).get("catalog") or {}
    types = (overview or {}).get("gateway_catalog") or catalog.get("device_types") or []
    parsers = sorted({parser for image in catalog.get("images") or [] for parser in image.get("parsers") or []}
                     | {item.get("parser") for item in types if item.get("parser")})
    return [{key: item.get(key) for key in ("code", "label", "category", "protocol", "controller", "parser",
                                             "manufacturer", "model", "description", "default_options",
                                             "connection_defaults", "version")} for item in types], parsers, error


@fleet_router.get("/device-types")
def list_device_types(database: Connection = Depends(connection)) -> dict[str, Any]:
    release, parsers, error = _release_catalog()
    usage = {row["device_type"]: row["n"] for row in database.execute(
        "SELECT device_type, count(*) AS n FROM canopy_gateway_device GROUP BY device_type").fetchall()}
    return {"release_types": [{**item, "in_use": usage.get(item["code"], 0)} for item in release],
            "hospital_types": [{**row, "in_use": usage.get(row["code"], 0)} for row in device_types.list_types(database)],
            "parsers": parsers, "controllers": list(device_types.CONTROLLERS), "haber_error": error}


class DeviceTypeInput(BaseModel):
    label: str = Field(min_length=1, max_length=200)
    category: str = Field(default="device", min_length=1, max_length=60)
    manufacturer: str | None = Field(default=None, max_length=120)
    model: str | None = Field(default=None, max_length=120)
    description: str | None = Field(default=None, max_length=2000)
    protocol: str = Field(min_length=1, max_length=60)
    controller: Literal["serial", "socket", "feeder", "webhook"]
    parser: str = Field(min_length=1, max_length=60)
    default_options: dict[str, Any] = Field(default_factory=dict)
    connection_defaults: dict[str, Any] = Field(default_factory=dict)
    enabled: bool = True


class DeviceTypeCreate(DeviceTypeInput):
    code: str = Field(min_length=1, max_length=64)


def _checked_type(payload: DeviceTypeInput) -> dict[str, Any]:
    values = _clean(payload)
    release, parsers, _ = _release_catalog()
    if parsers and values["parser"] not in parsers:
        raise HTTPException(422, f"parser '{values['parser']}' is not in the gateway parser image ({', '.join(parsers)})")
    try:
        values["connection_defaults"] = device_types.clean_connection_defaults(values["controller"],
                                                                              values["connection_defaults"])
    except ValueError as error:
        raise HTTPException(422, str(error)) from None
    values["_release_codes"] = {item["code"] for item in release}
    return values


TYPE_COLUMNS = ("label", "category", "manufacturer", "model", "description", "protocol", "controller", "parser",
                "default_options", "connection_defaults", "enabled")


@control_router.post("/device-types")
def create_device_type(payload: DeviceTypeCreate, user: dict[str, Any] = Depends(read_token),
                       database: Connection = Depends(connection)) -> dict[str, Any]:
    code = payload.code.strip().lower().replace(" ", "-")
    if not device_types.CODE.match(code):
        raise HTTPException(422, "code: lowercase letters, digits, . _ - (max 64), starting with a letter or digit")
    values, now = _checked_type(payload), directory.now_ms()
    if code in values["_release_codes"]:
        raise HTTPException(409, f"'{code}' is a Flora Root type; choose another code")
    row = database.execute(
        f"""INSERT INTO canopy_device_type (code, {', '.join(TYPE_COLUMNS)}, created_at, created_by, updated_at, updated_by)
            VALUES (%s, {', '.join(['%s'] * len(TYPE_COLUMNS))}, %s, %s, %s, %s)
            ON CONFLICT (code) DO NOTHING RETURNING code""",
        (code, *(Jsonb(values[c]) if c in ("default_options", "connection_defaults") else values[c] for c in TYPE_COLUMNS),
         now, user.get("username"), now, user.get("username"))).fetchone()
    if not row:
        raise HTTPException(409, f"device type '{code}' already exists")
    return {"ok": True, "code": code}


@control_router.put("/device-types/{code}")
def update_device_type(code: str, payload: DeviceTypeInput, user: dict[str, Any] = Depends(read_token),
                       database: Connection = Depends(connection)) -> dict[str, Any]:
    values = _checked_type(payload)
    row = database.execute(
        f"""UPDATE canopy_device_type SET {', '.join(f'{c}=%s' for c in TYPE_COLUMNS)}, updated_at=%s, updated_by=%s
            WHERE code=%s RETURNING code""",
        (*(Jsonb(values[c]) if c in ("default_options", "connection_defaults") else values[c] for c in TYPE_COLUMNS),
         directory.now_ms(), user.get("username"), code)).fetchone()
    if not row:
        raise HTTPException(404, "device type not found")
    return {"ok": True, "code": code}


@control_router.delete("/device-types/{code}")
def delete_device_type(code: str, database: Connection = Depends(connection)) -> dict[str, Any]:
    """Only a type no gateway uses can be deleted; disable it otherwise (gateways keep their copy)."""
    used = database.execute("SELECT count(*) AS n FROM canopy_gateway_device WHERE device_type=%s", (code,)).fetchone()["n"]
    if used:
        raise HTTPException(409, f"{used} gateway device(s) use this type; disable it instead")
    row = database.execute("DELETE FROM canopy_device_type WHERE code=%s RETURNING code", (code,)).fetchone()
    if not row:
        raise HTTPException(404, "device type not found")
    return {"ok": True}
