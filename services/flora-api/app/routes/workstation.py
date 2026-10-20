from fastapi import APIRouter, Body, Depends, HTTPException
from psycopg import Connection
from zoneinfo import available_timezones

from ..clinical import text
from ..database import connection
from .auth_leaf import current_user, now_ms, require_permission, service_only

router = APIRouter(prefix="/api/workstation", tags=["workstation"])


def response(row: dict) -> dict:
    return {
        "hospitalName": row["hospital_name"],
        "buildingName": row["building_name"],
        "careUnitName": row["care_unit_name"],
        "roomName": row["room_name"],
        "bedName": row["bed_name"],
        "timezone": row["timezone"],
        "dateFormat": row["date_format"],
        "timeFormat": row["time_format"],
        "updatedAt": row["updated_at"],
        "controlPlaneVersion": row.get("control_plane_version") or 0,
    }


@router.get("/context")
def context(database: Connection = Depends(connection)) -> dict:
    row = database.execute("SELECT * FROM workstation_context WHERE id=1").fetchone()
    return response(row)


@router.get("/hospital-profile")
def get_hospital_profile(database: Connection = Depends(connection)) -> dict:
    """The hospital's name and logo received from Canopy (empty until one is set there)."""
    from .. import hospital_profile

    return hospital_profile.leaf_get(database)


@router.put("/hospital-profile")
def put_hospital_profile(payload: dict = Body(...), _: dict = Depends(service_only), database: Connection = Depends(connection)) -> dict:
    """Called by the sync worker with the profile of the ward exchange."""
    from .. import hospital_profile

    return hospital_profile.leaf_put(database, payload)


@router.put("/context/control-plane")
def apply_control_plane_context(
    payload: dict = Body(...),
    user: dict = Depends(current_user),
    database: Connection = Depends(connection),
) -> dict:
    if "integration.ingest" not in user.get("_permissions", []):
        raise HTTPException(403, "integration.ingest permission required")
    values = {
        "hospital_name": text(payload.get("hospitalName")),
        "building_name": text(payload.get("buildingName")),
        "care_unit_name": text(payload.get("careUnitName")),
        "room_name": text(payload.get("roomName")),
        "bed_name": text(payload.get("bedName")),
        "timezone": text(payload.get("timezone")) or "Asia/Bangkok",
        "date_format": text(payload.get("dateFormat")) or "DD/MM/YYYY",
        "time_format": text(payload.get("timeFormat")) or "24h",
        "control_plane_version": int(payload.get("controlPlaneVersion") or 0),
    }
    if any(not values[key] for key in ("hospital_name", "building_name", "care_unit_name", "room_name", "bed_name")):
        raise HTTPException(400, "all workstation location fields are required")
    if values["date_format"] not in {"DD/MM/YYYY", "MM/DD/YYYY", "YYYY-MM-DD"}:
        raise HTTPException(400, "invalid date format")
    if values["time_format"] not in {"24h", "12h"}:
        raise HTTPException(400, "invalid time format")
    if values["timezone"] not in available_timezones():
        raise HTTPException(400, "invalid IANA timezone")
    current = database.execute("SELECT control_plane_version FROM workstation_context WHERE id=1").fetchone()
    if current and int(current.get("control_plane_version") or 0) > values["control_plane_version"]:
        return response(database.execute("SELECT * FROM workstation_context WHERE id=1").fetchone())
    row = database.execute(
        """UPDATE workstation_context SET hospital_name=%s,building_name=%s,care_unit_name=%s,
           room_name=%s,bed_name=%s,timezone=%s,date_format=%s,time_format=%s,
           updated_at=%s,control_plane_version=%s WHERE id=1 RETURNING *""",
        (
            values["hospital_name"], values["building_name"], values["care_unit_name"],
            values["room_name"], values["bed_name"], values["timezone"], values["date_format"],
            values["time_format"], now_ms(), values["control_plane_version"],
        ),
    ).fetchone()
    database.commit()
    return response(row)


@router.put("/context")
def update_context(
    payload: dict = Body(...),
    _: dict = Depends(require_permission("config.manage")),
    database: Connection = Depends(connection),
) -> dict:
    values = {
        "hospital_name": text(payload.get("hospitalName")),
        "building_name": text(payload.get("buildingName")),
        "care_unit_name": text(payload.get("careUnitName")),
        "room_name": text(payload.get("roomName")),
        "bed_name": text(payload.get("bedName")),
        "timezone": text(payload.get("timezone")) or "Asia/Bangkok",
        "date_format": text(payload.get("dateFormat")) or "DD/MM/YYYY",
        "time_format": text(payload.get("timeFormat")) or "24h",
    }
    if any(not values[key] for key in ("hospital_name", "building_name", "care_unit_name", "room_name", "bed_name")):
        raise HTTPException(400, "all workstation location fields are required")
    if values["date_format"] not in {"DD/MM/YYYY", "MM/DD/YYYY", "YYYY-MM-DD"}:
        raise HTTPException(400, "invalid date format")
    if values["time_format"] not in {"24h", "12h"}:
        raise HTTPException(400, "invalid time format")
    if values["timezone"] not in available_timezones():
        raise HTTPException(400, "invalid IANA timezone")
    row = database.execute(
        """UPDATE workstation_context SET hospital_name=%s,building_name=%s,care_unit_name=%s,
           room_name=%s,bed_name=%s,timezone=%s,date_format=%s,time_format=%s,updated_at=%s WHERE id=1 RETURNING *""",
        (
            values["hospital_name"],
            values["building_name"],
            values["care_unit_name"],
            values["room_name"],
            values["bed_name"],
            values["timezone"],
            values["date_format"],
            values["time_format"],
            now_ms(),
        ),
    ).fetchone()
    database.commit()
    return response(row)
