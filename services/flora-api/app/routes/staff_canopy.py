"""Canopy: the hospital staff directory (doctors, nurses, ...) that Leafs receive by ward (app/staff_sync.py).

Reads need a Canopy session; writes need staff.manage and live under /api/fleet/control (Canopy's write area).
"""
from __future__ import annotations

import re
from typing import Any

from fastapi import APIRouter, Body, Depends, HTTPException, Query
from psycopg import Connection
from psycopg.types.json import Jsonb

from .. import directory, staff_sync
from ..database import connection
from .auth_canopy import read_token
from .canopy_preferences import require_canopy_permission

router = APIRouter(tags=["staff"])
manager = require_canopy_permission("staff.manage")
ROLE_ID = re.compile(r"^[A-Za-z][A-Za-z0-9_]{1,40}\Z")


def text(value: Any) -> str | None:
    value = str(value).strip() if value is not None else ""
    return value or None


def public(row: dict[str, Any], units: dict[int, list[dict[str, str]]]) -> dict[str, Any]:
    return {**{key: row.get(key) for key in staff_sync.FIELDS}, "id": row["id"], "is_active": int(row["is_active"] or 0),
            "all_units": bool(row["all_units"]), "units": units.get(row["id"], []), "origin_leaf": row.get("origin_leaf"),
            "needs_review": bool(row.get("needs_review")), "profile_data": row.get("profile_data") or {},
            "updated_at": row.get("updated_at"), "created_at": row.get("created_at")}


def unit_map(database: Connection, ids: list[int]) -> dict[int, list[dict[str, str]]]:
    out: dict[int, list[dict[str, str]]] = {}
    for row in database.execute("SELECT staff_id, unit_key, unit_name FROM staff_directory_unit WHERE staff_id = ANY(%s) ORDER BY unit_name",
                                (ids,)).fetchall():
        out.setdefault(row["staff_id"], []).append({"key": row["unit_key"], "name": row["unit_name"]})
    return out


def one(database: Connection, staff_id: int) -> dict[str, Any]:
    row = database.execute("SELECT * FROM staff_directory WHERE id=%s", (staff_id,)).fetchone()
    if row is None:
        raise HTTPException(404, "staff not found")
    return public(row, unit_map(database, [staff_id]))


@router.get("/api/fleet/staff", dependencies=[Depends(read_token)])
def list_staff(q: str = "", unit: str = "", role_id: str = "", review: bool = False, include_inactive: bool = False,
               limit: int = Query(500, ge=1, le=5000), database: Connection = Depends(connection)) -> dict[str, Any]:
    like = f"%{q.strip()}%"
    rows = database.execute(
        """SELECT * FROM staff_directory s
           WHERE (%s OR s.is_active = 1) AND (NOT %s OR s.needs_review)
             AND (%s = '' OR s.staff_role_id = %s)
             AND (%s = '' OR s.all_units OR EXISTS (SELECT 1 FROM staff_directory_unit u WHERE u.staff_id = s.id AND u.unit_key = %s))
             AND (%s = '' OR s.staff_name ILIKE %s OR coalesce(s.staff_code, '') ILIKE %s OR coalesce(s.hospital_id, '') ILIKE %s
                  OR concat_ws(' ', s.th_first_name, s.th_last_name, s.en_first_name, s.en_last_name) ILIKE %s)
           ORDER BY s.needs_review DESC, s.is_active DESC, s.staff_name LIMIT %s""",
        (include_inactive, review, role_id, role_id, unit, unit, q.strip(), like, like, like, like, limit)).fetchall()
    units = unit_map(database, [row["id"] for row in rows])
    totals = database.execute(
        """SELECT count(*) FILTER (WHERE is_active=1) AS active, count(*) FILTER (WHERE needs_review AND is_active=1) AS review,
                  count(*) FILTER (WHERE is_active=1 AND coalesce(staff_code,'')='') AS no_code FROM staff_directory""").fetchone()
    return {"rows": [public(row, units) for row in rows], "totals": totals}


@router.get("/api/fleet/staff/options", dependencies=[Depends(read_token)])
def options(database: Connection = Depends(connection)) -> dict[str, Any]:
    return {"roles": staff_sync.roles(database), "wards": directory.ward_options(database)["rows"]}


def values_from(database: Connection, payload: dict[str, Any], old: dict[str, Any] | None = None) -> dict[str, Any]:
    old = old or {}
    get = lambda key: payload.get(key, old.get(key))  # noqa: E731
    role = database.execute("SELECT id, display_name, staff_type FROM staff_role WHERE id=%s",
                            (get("staff_role_id") or get("role_id"),)).fetchone()
    if role is None:
        raise HTTPException(400, "valid staff role required")
    values = {key: text(get(key)) for key in ("staff_code", "hospital_id", "personal_id", "email", "th_first_name",
                                              "th_last_name", "en_first_name", "en_last_name", "innovian_id")}
    values["email"] = values["email"].lower() if values["email"] else None
    name = text(payload.get("staff_name", payload.get("name", old.get("staff_name"))))
    name = name or " ".join(filter(None, (values["th_first_name"], values["th_last_name"]))) \
        or " ".join(filter(None, (values["en_first_name"], values["en_last_name"])))
    if not name:
        raise HTTPException(400, "name required")
    if not values["staff_code"] and role["staff_type"] in staff_sync.CODED_TYPES:
        raise HTTPException(400, f"staff code required for {role['display_name']} (doctor or nurse code)")
    if values["staff_code"]:
        clash = database.execute("SELECT id, staff_name FROM staff_directory WHERE lower(staff_code)=lower(%s) AND id IS DISTINCT FROM %s",
                                 (values["staff_code"], old.get("id"))).fetchone()
        if clash:
            raise HTTPException(409, f"staff code {values['staff_code']} is already used by {clash['staff_name']}")
    entry = get("entry_year")
    values.update(staff_name=name, staff_role_id=role["id"], staff_role=role["display_name"],
                  entry_year=int(entry) if str(entry or "").isdigit() else None,
                  is_active=1 if int(get("is_active") if get("is_active") is not None else 1) else 0,
                  all_units=bool(get("all_units")))
    return values


def save_units(database: Connection, staff_id: int, keys: list[str] | None) -> None:
    if keys is None:
        return
    names = {row["key"]: row["name"] for row in directory.ward_options(database)["rows"]}
    unknown = sorted(set(keys) - set(names))
    if unknown:
        raise HTTPException(400, f"unknown wards: {', '.join(unknown)}")
    database.execute("DELETE FROM staff_directory_unit WHERE staff_id=%s", (staff_id,))
    for key in dict.fromkeys(keys):
        database.execute("INSERT INTO staff_directory_unit (staff_id, unit_key, unit_name) VALUES (%s, %s, %s)", (staff_id, key, names[key]))


def write(database: Connection, staff_id: int | None, payload: dict[str, Any]) -> int:
    old = database.execute("SELECT * FROM staff_directory WHERE id=%s", (staff_id,)).fetchone() if staff_id else None
    if staff_id and old is None:
        raise HTTPException(404, "staff not found")
    values = values_from(database, payload, old)
    current = staff_sync.now_ms()
    values.update(directory_version=current, updated_at=current)
    if "needs_review" in payload:
        values["needs_review"] = bool(payload["needs_review"])
    if old:
        database.execute(f"UPDATE staff_directory SET {', '.join(f'{key}=%s' for key in values)} WHERE id=%s",
                         (*values.values(), staff_id))
    else:
        columns = list(values) + ["profile_data", "used_count", "created_at"]
        staff_id = database.execute(
            f"INSERT INTO staff_directory ({', '.join(columns)}) VALUES ({', '.join(['%s'] * len(columns))}) RETURNING id",
            (*values.values(), Jsonb({}), 0, current)).fetchone()["id"]
    unit_keys = payload.get("unit_keys")
    save_units(database, staff_id, [str(key) for key in unit_keys] if isinstance(unit_keys, list) else None)
    return staff_id


@router.post("/api/fleet/control/staff")
def create(payload: dict = Body(...), _: dict = Depends(manager), database: Connection = Depends(connection)) -> dict:
    with database.transaction():
        staff_id = write(database, None, payload)
    return one(database, staff_id)


@router.put("/api/fleet/control/staff/{staff_id}")
def save(staff_id: int, payload: dict = Body(...), _: dict = Depends(manager), database: Connection = Depends(connection)) -> dict:
    with database.transaction():
        write(database, staff_id, payload)
    return one(database, staff_id)


@router.post("/api/fleet/control/staff/{staff_id}/reviewed")
def reviewed(staff_id: int, _: dict = Depends(manager), database: Connection = Depends(connection)) -> dict:
    if not database.execute("UPDATE staff_directory SET needs_review=false WHERE id=%s RETURNING id", (staff_id,)).fetchone():
        raise HTTPException(404, "staff not found")
    return one(database, staff_id)


@router.post("/api/fleet/control/staff/import")
def import_rows(payload: dict = Body(...), _: dict = Depends(manager), database: Connection = Depends(connection)) -> dict:
    """rows: [{staff_code, role (id or name), name | th/en names, hospital_id?, email?, wards (names or keys, ';')?}].
    A known staff code updates that person; others are created. Each row is reported."""
    rows = payload.get("rows") if isinstance(payload.get("rows"), list) else []
    if len(rows) > 5000:
        raise HTTPException(400, "at most 5000 rows")
    role_by = {}
    for role in staff_sync.roles(database):
        role_by[role["id"].lower()] = role["id"]
        role_by[str(role["display_name"]).lower()] = role["id"]
    wards = directory.ward_options(database)["rows"]
    ward_by = {**{w["key"]: w["key"] for w in wards}, **{str(w["name"]).lower(): w["key"] for w in wards}}
    report = []
    for index, raw in enumerate(rows, 1):
        try:
            if not isinstance(raw, dict):
                raise HTTPException(400, "row must be an object")
            item = {str(key).strip().lower(): value for key, value in raw.items()}
            item["staff_role_id"] = role_by.get(str(item.get("role") or item.get("staff_role_id") or "").strip().lower())
            ward_text = str(item.get("wards") or "").strip()
            if ward_text.lower() in {"all", "*", "ทุก ward"}:
                item["all_units"] = True
            elif ward_text:
                keys = [ward_by.get(part.strip().lower()) for part in re.split(r"[;|]", ward_text) if part.strip()]
                if None in keys:
                    raise HTTPException(400, f"unknown ward in '{ward_text}'")
                item["unit_keys"] = keys
            code = text(item.get("staff_code"))
            existing = database.execute("SELECT id FROM staff_directory WHERE lower(staff_code)=lower(%s)", (code,)).fetchone() if code else None
            with database.transaction():
                write(database, existing["id"] if existing else None, item)
            report.append({"row": index, "staff_code": code, "status": "updated" if existing else "created"})
        except HTTPException as error:
            report.append({"row": index, "staff_code": text((raw or {}).get("staff_code")) if isinstance(raw, dict) else None,
                           "status": "error", "error": str(error.detail)})
    return {"rows": report, "created": sum(r["status"] == "created" for r in report),
            "updated": sum(r["status"] == "updated" for r in report), "errors": sum(r["status"] == "error" for r in report)}


@router.put("/api/fleet/control/staff-roles/{role_id}")
def save_role(role_id: str, payload: dict = Body(...), _: dict = Depends(manager), database: Connection = Depends(connection)) -> dict:
    if not ROLE_ID.match(role_id):
        raise HTTPException(400, "role id: letters, digits and _ (2-41), starting with a letter")
    name = text(payload.get("display_name"))
    if not name:
        raise HTTPException(400, "display name required")
    staff_type = payload.get("staff_type") or "other"
    if staff_type not in ("doctor", "nurse", "other"):
        raise HTTPException(400, "staff_type is doctor, nurse or other")
    current = staff_sync.now_ms()
    with database.transaction():
        database.execute(
            """INSERT INTO staff_role (id, display_name, sort_order, staff_type, is_active, updated_at) VALUES (%s,%s,%s,%s,%s,%s)
               ON CONFLICT (id) DO UPDATE SET display_name=excluded.display_name, sort_order=excluded.sort_order,
                 staff_type=excluded.staff_type, is_active=excluded.is_active, updated_at=excluded.updated_at""",
            (role_id, name, int(payload.get("sort_order") or 100), staff_type, 1 if payload.get("is_active", 1) else 0, current))
        database.execute("UPDATE staff_directory SET staff_role=%s WHERE staff_role_id=%s AND staff_role IS DISTINCT FROM %s",
                         (name, role_id, name))
    return {"roles": staff_sync.roles(database)}
