"""Staff directory sync: Canopy owns the directory, Leafs get their ward's staff and push new people back.

- Identity across nodes is `staff_code` (doctor / nurse code, e.g. licence number), compared case-insensitively.
  Doctor and nurse roles (staff_role.staff_type) need one; other roles may stay local to a Leaf.
- Canopy -> Leaf: active staff of the Leaf's ward (staff_directory_unit) plus `all_units` staff, and the roles.
  The Leaf keeps them as `directory_managed` (read-only there) and deactivates managed people no longer listed.
- Leaf -> Canopy: people added on the Leaf with a code (`directory_pending`). If Canopy already has the code,
  Canopy's record wins ("merged") and comes back down; otherwise Canopy creates it for the Leaf's ward and flags
  it for review ("created"). A push Canopy cannot take is "rejected" with a reason the Leaf shows.
"""
from __future__ import annotations

import hashlib
import json
import time
from typing import Any

from psycopg import Connection
from psycopg.types.json import Jsonb

FIELDS = ("staff_code", "staff_name", "staff_role_id", "staff_role", "hospital_id", "personal_id", "email",
          "th_first_name", "th_last_name", "en_first_name", "en_last_name", "innovian_id", "entry_year")
CODED_TYPES = {"doctor", "nurse"}


def now_ms() -> int:
    return int(time.time() * 1000)


def norm_code(value: Any) -> str:
    return str(value or "").strip()


def role_types(database: Connection) -> dict[str, str]:
    return {row["id"]: row["staff_type"] for row in database.execute("SELECT id, staff_type FROM staff_role").fetchall()}


def needs_code(database: Connection, role_id: str | None) -> bool:
    return role_types(database).get(role_id or "", "other") in CODED_TYPES


def record(row: dict[str, Any]) -> dict[str, Any]:
    return {**{key: row.get(key) for key in FIELDS}, "profile_data": row.get("profile_data") or {},
            "is_active": int(row.get("is_active") or 0), "all_units": bool(row.get("all_units")),
            "directory_version": int(row.get("directory_version") or 0),
            # Staff PIN for medication approvals (app/staff_pin.py): hash only, newest pin_set_at wins.
            "pin_hash": row.get("pin_hash"), "pin_set_at": row.get("pin_set_at")}


def take_pin(database: Connection, staff_id: int, item: dict[str, Any]) -> None:
    """Adopt a synced PIN when it is newer than ours (a reset is a newer pin_set_at without a hash).
    Failure counts and locks stay local."""
    if item.get("pin_set_at") is None:
        return
    database.execute(
        """UPDATE staff_directory SET pin_hash=%s, pin_set_at=%s, pin_failed=0, pin_locked_until=NULL
           WHERE id=%s AND coalesce(pin_set_at, 0) < %s""",
        (item.get("pin_hash"), int(item["pin_set_at"]), staff_id, int(item["pin_set_at"])))


def roles(database: Connection) -> list[dict[str, Any]]:
    return [dict(row) for row in database.execute(
        "SELECT id, display_name, sort_order, staff_type, is_active, seniority FROM staff_role ORDER BY sort_order, id").fetchall()]


# ---------------------------------------------------------------- Canopy

def leaf_unit(database: Connection, leaf_id: str) -> dict[str, Any] | None:
    row = database.execute("SELECT unit_key, unit_name FROM canopy_leaf_unit WHERE leaf_id=%s", (leaf_id,)).fetchone()
    return dict(row) if row else None


def leaf_staff(database: Connection, leaf_id: str) -> dict[str, Any]:
    """The ward directory a Leaf receives, with a digest so an unchanged list is not sent again."""
    unit = leaf_unit(database, leaf_id)
    rows = database.execute(
        """SELECT * FROM staff_directory s
           WHERE s.is_active = 1 AND s.staff_code IS NOT NULL AND s.staff_code <> ''
             AND (s.all_units OR EXISTS (SELECT 1 FROM staff_directory_unit u WHERE u.staff_id = s.id AND u.unit_key = %s))
           ORDER BY lower(s.staff_code)""", ((unit or {}).get("unit_key") or "",)).fetchall()
    staff = [record(row) for row in rows]
    role_rows = roles(database)
    digest = hashlib.sha256(json.dumps([staff, role_rows], sort_keys=True, default=str).encode()).hexdigest()
    return {"unit": unit, "digest": digest, "roles": role_rows, "staff": staff}


def add_unit(database: Connection, staff_id: int, unit: dict[str, Any] | None) -> bool:
    if not unit:
        return False
    added = database.execute(
        """INSERT INTO staff_directory_unit (staff_id, unit_key, unit_name) VALUES (%s, %s, %s)
           ON CONFLICT DO NOTHING RETURNING staff_id""", (staff_id, unit["unit_key"], unit.get("unit_name"))).fetchone()
    return added is not None


def apply_leaf_change(database: Connection, leaf_id: str, unit: dict[str, Any] | None, change: dict[str, Any]) -> dict[str, Any]:
    """One person pushed by a Leaf -> {staff_code, status: created|merged|rejected, reason?, directory_version}."""
    code = norm_code(change.get("staff_code"))
    out = {"staff_code": code, "directory_version": int(change.get("directory_version") or 0)}
    if not code:
        return {**out, "status": "rejected", "reason": "staff code required"}
    role = database.execute("SELECT id, display_name FROM staff_role WHERE id=%s", (change.get("staff_role_id"),)).fetchone()
    if role is None:
        return {**out, "status": "rejected", "reason": f"unknown role '{change.get('staff_role_id')}'"}
    name = str(change.get("staff_name") or "").strip()
    if not name:
        return {**out, "status": "rejected", "reason": "name required"}
    current = now_ms()
    existing = database.execute("SELECT id FROM staff_directory WHERE lower(staff_code)=lower(%s)", (code,)).fetchone()
    if existing is None:
        same = database.execute("SELECT id, staff_code FROM staff_directory WHERE staff_name=%s AND staff_role=%s",
                                (name, role["display_name"])).fetchone()
        if same and norm_code(same["staff_code"]):
            return {**out, "status": "rejected",
                    "reason": f"{name} ({role['display_name']}) already has code {same['staff_code']} in Canopy"}
        if same:  # an uncoded Canopy entry for the same person takes the code
            database.execute("UPDATE staff_directory SET staff_code=%s, directory_version=%s, updated_at=%s WHERE id=%s",
                             (code, current, current, same["id"]))
            existing = same
    if existing is not None:
        take_pin(database, existing["id"], change)
        if add_unit(database, existing["id"], unit):
            database.execute("UPDATE staff_directory SET updated_at=%s WHERE id=%s", (current, existing["id"]))
        return {**out, "status": "merged"}
    values = {key: change.get(key) for key in FIELDS if key not in ("staff_role_id", "staff_role")}
    values.update(staff_code=code, staff_name=name, staff_role_id=role["id"], staff_role=role["display_name"])
    columns = list(values) + ["profile_data", "is_active", "used_count", "directory_version", "origin_leaf",
                              "needs_review", "created_at", "updated_at"]
    row = database.execute(
        f"INSERT INTO staff_directory ({', '.join(columns)}) VALUES ({', '.join(['%s'] * len(columns))}) RETURNING id",
        (*values.values(), Jsonb(change.get("profile_data") or {}), 1, 0, current, leaf_id, True, current, current)).fetchone()
    take_pin(database, row["id"], change)
    add_unit(database, row["id"], unit)
    return {**out, "status": "created"}


def exchange(database: Connection, leaf_id: str, changes: list[dict[str, Any]], held_digest: str | None) -> dict[str, Any]:
    unit = leaf_unit(database, leaf_id)
    results = []
    for change in changes:
        try:
            with database.transaction():
                results.append(apply_leaf_change(database, leaf_id, unit, change))
        except Exception as error:  # one bad record never blocks the rest
            results.append({"staff_code": norm_code(change.get("staff_code")), "status": "rejected",
                            "reason": f"{type(error).__name__}", "directory_version": int(change.get("directory_version") or 0)})
    directory = leaf_staff(database, leaf_id)
    unchanged = held_digest == directory["digest"]
    return {"unit": directory["unit"], "digest": directory["digest"], "roles": directory["roles"],
            "staff": None if unchanged else directory["staff"], "results": results}


# ---------------------------------------------------------------- Leaf

def pending(database: Connection) -> list[dict[str, Any]]:
    rows = database.execute(
        "SELECT * FROM staff_directory WHERE directory_pending=1 AND staff_code IS NOT NULL AND staff_code <> '' ORDER BY id").fetchall()
    return [record(row) for row in rows]


def _upsert_role(database: Connection, role: dict[str, Any]) -> None:
    database.execute(
        """INSERT INTO staff_role (id, display_name, sort_order, staff_type, is_active, seniority, updated_at)
           VALUES (%s, %s, %s, %s, %s, %s, %s)
           ON CONFLICT (id) DO UPDATE SET display_name=excluded.display_name, sort_order=excluded.sort_order,
             staff_type=excluded.staff_type, is_active=excluded.is_active,
             seniority=coalesce(%s, staff_role.seniority), updated_at=excluded.updated_at""",
        (role["id"], role["display_name"], role.get("sort_order"), role.get("staff_type") or "other",
         int(role.get("is_active", 1)), int(role.get("seniority") or 0), now_ms(), role.get("seniority")))


def apply_from_canopy(database: Connection, payload: dict[str, Any]) -> dict[str, Any]:
    """Results of the push, then Canopy's ward directory (when it changed). Returns counts for the sync status."""
    counts = {"pushed": len(payload.get("results") or []), "created": 0, "merged": 0, "rejected": 0,
              "received": 0, "inserted": 0, "updated": 0, "deactivated": 0, "conflicts": 0,
              "unchanged": payload.get("staff") is None}
    rejected = []
    for result in payload.get("results") or []:
        status = result.get("status")
        counts[status] = counts.get(status, 0) + 1
        if status in ("created", "merged"):
            database.execute(
                """UPDATE staff_directory SET directory_pending=0, sync_error=NULL
                   WHERE lower(staff_code)=lower(%s) AND directory_version <= %s""",
                (result.get("staff_code"), int(result.get("directory_version") or 0)))
        else:
            database.execute(
                "UPDATE staff_directory SET directory_pending=0, sync_error=%s WHERE lower(staff_code)=lower(%s)",
                (str(result.get("reason") or "rejected")[:300], result.get("staff_code")))
            rejected.append({"staff_code": result.get("staff_code"), "reason": result.get("reason")})
    for role in payload.get("roles") or []:
        try:
            with database.transaction():
                _upsert_role(database, role)
        except Exception:  # e.g. a display name clash with a local role
            counts["conflicts"] += 1
    staff = payload.get("staff")
    if staff is None:
        return {**counts, "rejected_items": rejected}
    counts["received"] = len(staff)
    current = now_ms()
    listed = set()
    for item in staff:
        code = norm_code(item.get("staff_code"))
        if not code:
            continue
        listed.add(code.lower())
        values = {key: item.get(key) for key in FIELDS}
        values.update(staff_code=code, is_active=int(item.get("is_active", 1)), all_units=bool(item.get("all_units")),
                      directory_version=int(item.get("directory_version") or 0))
        try:
            with database.transaction():
                row = database.execute("SELECT id FROM staff_directory WHERE lower(staff_code)=lower(%s)", (code,)).fetchone()
                if row is None:  # a local uncoded entry for the same person
                    row = database.execute(
                        """SELECT id FROM staff_directory WHERE staff_name=%s AND staff_role=%s
                           AND coalesce(staff_code, '') = ''""", (values["staff_name"], values["staff_role"])).fetchone()
                if row is not None:
                    assignments = ", ".join(f"{key}=%s" for key in values)
                    database.execute(
                        f"""UPDATE staff_directory SET {assignments}, profile_data=%s, directory_managed=1, directory_pending=0,
                              sync_error=NULL, updated_at=%s WHERE id=%s""",
                        (*values.values(), Jsonb(item.get("profile_data") or {}), current, row["id"]))
                    take_pin(database, row["id"], item)
                    counts["updated"] += 1
                else:
                    columns = list(values) + ["profile_data", "directory_managed", "directory_pending", "used_count",
                                              "created_at", "updated_at"]
                    row = database.execute(
                        f"INSERT INTO staff_directory ({', '.join(columns)}) VALUES ({', '.join(['%s'] * len(columns))}) RETURNING id",
                        (*values.values(), Jsonb(item.get("profile_data") or {}), 1, 0, 0, current, current)).fetchone()
                    take_pin(database, row["id"], item)
                    counts["inserted"] += 1
        except Exception:  # same name and role held locally by someone with another code
            counts["conflicts"] += 1
    gone = database.execute(
        """UPDATE staff_directory SET is_active=0, updated_at=%s
           WHERE directory_managed=1 AND is_active=1 AND NOT (lower(coalesce(staff_code, '')) = ANY(%s)) RETURNING id""",
        (current, sorted(listed))).fetchall()
    counts["deactivated"] = len(gone)
    return {**counts, "rejected_items": rejected}
