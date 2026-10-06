"""User directory shared by Canopy and Leafs.

Canopy is the hospital-wide directory. Each Leaf keeps a local copy of the users
that may work in its ward (ward members plus all-ward users) so bedside sign-in
keeps working offline. Both sides may edit; every identity change stamps
`directory_version` (epoch ms) and the newest version wins.

Records are matched by username: database ids differ on every node.
"""
import os
import re
import secrets
import time
from typing import Any

from fastapi import HTTPException
from psycopg import Connection

API_MODE = os.getenv("FLORA_API_MODE", "leaf").strip().lower()
PIN_PATTERN = re.compile(r"\d{4,8}")


def now_ms() -> int:
    return int(time.time() * 1000)


def is_leaf() -> bool:
    return API_MODE == "leaf"


def user_units(database: Connection, user_id: int) -> list[dict[str, str]]:
    rows = database.execute(
        "SELECT unit_key,unit_name FROM auth_user_unit WHERE user_id=%s ORDER BY unit_name,unit_key",
        (user_id,),
    ).fetchall()
    return [{"key": row["unit_key"], "name": row["unit_name"]} for row in rows]


def has_all_units(row: dict[str, Any]) -> bool:
    return bool(row.get("all_units")) or "system_admin" in (row.get("_role_codes") or [])


def touch(database: Connection, user_id: int, version: int | None = None) -> int:
    """Stamp an identity change so it wins over older copies on other nodes."""
    stamp = version or now_ms()
    if is_leaf():
        database.execute(
            "UPDATE auth_user SET directory_version=%s,directory_pending=1 WHERE id=%s", (stamp, user_id)
        )
    else:
        database.execute("UPDATE auth_user SET directory_version=%s WHERE id=%s", (stamp, user_id))
    return stamp


# --- wards -----------------------------------------------------------------

def ward_options(database: Connection) -> dict[str, Any]:
    """Every ward a user can be assigned to, from this node's point of view."""
    if is_leaf():
        state = database.execute("SELECT * FROM auth_directory_state WHERE id=1").fetchone()
        units = (state or {}).get("units") or []
        return {
            "rows": [
                {"key": str(unit.get("key")), "name": unit.get("name") or "",
                 "buildingName": unit.get("buildingName")}
                for unit in units if unit.get("key")
            ],
            "leafUnitKey": (state or {}).get("leaf_unit_key"),
        }
    rows = database.execute(
        """SELECT unit.id::text AS key, unit.name, building.name AS building_name,
                  hospital.name AS hospital_name,
                  (SELECT count(*) FROM canopy_leaf_unit lu WHERE lu.unit_key=unit.id::text) AS leaf_count
           FROM canopy_location unit
           LEFT JOIN canopy_location building ON building.id=unit.parent_id
           LEFT JOIN canopy_location hospital ON hospital.id=building.parent_id
           WHERE unit.kind='care_unit' AND unit.is_active
           ORDER BY hospital.name NULLS FIRST, building.name NULLS FIRST, unit.sort_order, unit.name"""
    ).fetchall()
    return {
        "rows": [
            {"key": row["key"], "name": row["name"], "buildingName": row["building_name"],
             "hospitalName": row["hospital_name"], "leafCount": int(row["leaf_count"] or 0)}
            for row in rows
        ],
        "leafUnitKey": None,
    }


def set_units(database: Connection, user_id: int, all_units: bool, unit_keys: list[str]) -> list[dict[str, str]]:
    options = {row["key"]: row["name"] for row in ward_options(database)["rows"]}
    keys = list(dict.fromkeys(str(key).strip() for key in unit_keys if str(key).strip()))
    unknown = [key for key in keys if key not in options]
    if unknown:
        raise HTTPException(status_code=400, detail=f"unknown ward: {', '.join(unknown)}")
    current = now_ms()
    database.execute("UPDATE auth_user SET all_units=%s WHERE id=%s", (1 if all_units else 0, user_id))
    database.execute("DELETE FROM auth_user_unit WHERE user_id=%s", (user_id,))
    for key in keys:
        database.execute(
            "INSERT INTO auth_user_unit(user_id,unit_key,unit_name,created_at) VALUES (%s,%s,%s,%s)",
            (user_id, key, options[key], current),
        )
    touch(database, user_id, current)
    return user_units(database, user_id)


# --- admin PIN -------------------------------------------------------------

def _pin_hash(pin: str, salt_hex: str) -> str:
    import hashlib
    return hashlib.scrypt(pin.encode("utf-8"), salt=bytes.fromhex(salt_hex), n=2**14, r=8, p=1, dklen=64).hex()


def _pin_matches(pin: str, row: dict[str, Any]) -> bool:
    import hmac
    if not row.get("admin_pin_salt") or not row.get("admin_pin_hash"):
        return False
    try:
        return hmac.compare_digest(_pin_hash(pin, row["admin_pin_salt"]), row["admin_pin_hash"])
    except (TypeError, ValueError):
        return False


def _pin_holders(database: Connection) -> list[dict[str, Any]]:
    return database.execute(
        """SELECT DISTINCT account.id, account.username, account.name, account.role,
                  account.admin_pin_salt, account.admin_pin_hash
           FROM auth_user account
           JOIN auth_user_role assignment ON assignment.user_id=account.id
           JOIN auth_role_permission permission ON permission.role_code=assignment.role_code
           WHERE account.is_active=1 AND account.admin_pin_hash IS NOT NULL
             AND permission.permission_code='account.manage'"""
    ).fetchall()


def set_admin_pin(database: Connection, user_id: int, pin: str | None) -> None:
    if pin is None or pin == "":
        database.execute("UPDATE auth_user SET admin_pin_salt=NULL,admin_pin_hash=NULL WHERE id=%s", (user_id,))
        touch(database, user_id)
        return
    if PIN_PATTERN.fullmatch(pin) is None:
        raise HTTPException(status_code=400, detail="PIN must be 4-8 digits")
    # Leafs identify the approving administrator by PIN alone, so PINs must be unique.
    if any(holder["id"] != user_id and _pin_matches(pin, holder) for holder in _pin_holders(database)):
        raise HTTPException(status_code=409, detail="choose a different PIN")
    salt = secrets.token_hex(16)
    database.execute(
        "UPDATE auth_user SET admin_pin_salt=%s,admin_pin_hash=%s WHERE id=%s",
        (salt, _pin_hash(pin, salt), user_id),
    )
    touch(database, user_id)


def approve_with_pin(database: Connection, pin: str | None) -> dict[str, Any]:
    """Return the administrator whose PIN was supplied, or reject the change."""
    if not pin:
        raise HTTPException(status_code=403, detail="admin PIN required")
    if PIN_PATTERN.fullmatch(pin):
        for holder in _pin_holders(database):
            if _pin_matches(pin, holder):
                return dict(holder)
    raise HTTPException(status_code=403, detail="invalid admin PIN")


# --- synchronization records ---------------------------------------------

def record(database: Connection, row: dict[str, Any]) -> dict[str, Any]:
    roles = database.execute(
        "SELECT role_code FROM auth_user_role WHERE user_id=%s ORDER BY role_code", (row["id"],)
    ).fetchall()
    ldap = (row.get("auth_source") or "local") == "ldap"
    return {
        "username": row["username"],
        "name": row.get("name"),
        "hospital_id": row.get("hospital_id"),
        "auth_source": row.get("auth_source") or "local",
        # LDAP passwords live in the directory server; Leaf-side caches never travel.
        "password_salt": None if ldap else row.get("password_salt"),
        "password_hash": None if ldap else row.get("password_hash"),
        "must_change_password": int(row.get("must_change_password") or 0),
        "is_active": int(row.get("is_active") or 0),
        "all_units": int(row.get("all_units") or 0),
        "admin_pin_salt": row.get("admin_pin_salt"),
        "admin_pin_hash": row.get("admin_pin_hash"),
        "role_codes": [item["role_code"] for item in roles],
        "units": user_units(database, row["id"]),
        "directory_version": int(row.get("directory_version") or 0),
    }


def _default_language(database: Connection) -> str:
    row = database.execute(
        """SELECT code FROM language_master WHERE is_active=1
           ORDER BY CASE WHEN code='en' THEN 0 ELSE 1 END, sort_order, code LIMIT 1"""
    ).fetchone()
    return row["code"] if row else "en"


def apply_record(database: Connection, incoming: dict[str, Any], *, from_canopy: bool) -> str:
    """Merge one record; newest directory_version wins. Returns applied|stale|skipped."""
    username = str(incoming.get("username") or "").strip()
    version = int(incoming.get("directory_version") or 0)
    if not username:
        return "skipped"
    existing = database.execute(
        "SELECT * FROM auth_user WHERE lower(username)=lower(%s) LIMIT 1", (username,)
    ).fetchone()
    if existing is not None and int(existing.get("directory_version") or 0) > version:
        return "stale"
    ldap = incoming.get("auth_source") == "ldap"
    keep_password = ldap or not incoming.get("password_hash")
    current = now_ms()
    with database.transaction():
        values = {
            "name": incoming.get("name") or username,
            "hospital_id": incoming.get("hospital_id"),
            "auth_source": incoming.get("auth_source") or "local",
            "must_change_password": 1 if incoming.get("must_change_password") else 0,
            "is_active": 1 if incoming.get("is_active") else 0,
            "all_units": 1 if incoming.get("all_units") else 0,
            "admin_pin_salt": incoming.get("admin_pin_salt"),
            "admin_pin_hash": incoming.get("admin_pin_hash"),
        }
        if existing is None:
            row = database.execute(
                """INSERT INTO auth_user(username,hospital_id,auth_source,password_salt,password_hash,name,role,
                         theme_mode,language_code,is_active,must_change_password,all_units,
                         admin_pin_salt,admin_pin_hash,directory_version,created_at,updated_at)
                   VALUES (%s,%s,%s,%s,%s,%s,'clinician','dark',%s,%s,%s,%s,%s,%s,%s,%s,%s) RETURNING *""",
                (username, values["hospital_id"], values["auth_source"],
                 None if ldap else incoming.get("password_salt"), None if ldap else incoming.get("password_hash"),
                 values["name"], _default_language(database), values["is_active"],
                 values["must_change_password"], values["all_units"], values["admin_pin_salt"],
                 values["admin_pin_hash"], version, current, current),
            ).fetchone()
        else:
            row = database.execute(
                f"""UPDATE auth_user SET name=%s,hospital_id=%s,auth_source=%s,must_change_password=%s,
                          is_active=%s,all_units=%s,admin_pin_salt=%s,admin_pin_hash=%s,
                          directory_version=%s,updated_at=%s
                          {'' if keep_password else ',password_salt=%s,password_hash=%s'}
                   WHERE id=%s RETURNING *""",
                (values["name"], values["hospital_id"], values["auth_source"], values["must_change_password"],
                 values["is_active"], values["all_units"], values["admin_pin_salt"], values["admin_pin_hash"],
                 version, current,
                 *(() if keep_password else (incoming.get("password_salt"), incoming.get("password_hash"))),
                 existing["id"]),
            ).fetchone()
        user_id = row["id"]
        if from_canopy and is_leaf():
            database.execute(
                "UPDATE auth_user SET directory_managed=1,directory_pending=0 WHERE id=%s", (user_id,)
            )
        valid_roles = [
            item["code"] for item in database.execute(
                "SELECT code FROM auth_role WHERE code=ANY(%s) AND is_active=1",
                (list(incoming.get("role_codes") or []),),
            ).fetchall()
        ]
        if valid_roles:
            database.execute("DELETE FROM auth_user_role WHERE user_id=%s", (user_id,))
            for code in valid_roles:
                database.execute(
                    """INSERT INTO auth_user_role(user_id,role_code,scope_type,scope_id,created_at,updated_at)
                       VALUES (%s,%s,'global','*',%s,%s)""",
                    (user_id, code, current, current),
                )
            legacy = "admin" if "system_admin" in valid_roles else valid_roles[0]
            database.execute("UPDATE auth_user SET role=%s WHERE id=%s", (legacy, user_id))
        database.execute("DELETE FROM auth_user_unit WHERE user_id=%s", (user_id,))
        for unit in incoming.get("units") or []:
            if unit.get("key"):
                database.execute(
                    """INSERT INTO auth_user_unit(user_id,unit_key,unit_name,created_at)
                       VALUES (%s,%s,%s,%s) ON CONFLICT DO NOTHING""",
                    (user_id, str(unit["key"]), str(unit.get("name") or ""), current),
                )
        if not values["is_active"] and is_leaf():
            database.execute(
                "UPDATE auth_session SET revoked_at=%s WHERE user_id=%s AND revoked_at IS NULL", (current, user_id)
            )
    return "applied"


# --- Canopy: what each Leaf receives ----------------------------------------

LEAF_SCOPE_SQL = """
    (u.all_units=1
     OR EXISTS (SELECT 1 FROM auth_user_role r WHERE r.user_id=u.id AND r.role_code='system_admin')
     OR EXISTS (SELECT 1 FROM auth_user_unit m JOIN canopy_leaf_unit lu ON lu.unit_key=m.unit_key
                WHERE m.user_id=u.id AND lu.leaf_id=%s))
"""


def leaf_unit(database: Connection, leaf_id: str) -> dict[str, str] | None:
    row = database.execute(
        "SELECT unit_key,unit_name FROM canopy_leaf_unit WHERE leaf_id=%s", (leaf_id,)
    ).fetchone()
    return {"key": row["unit_key"], "name": row["unit_name"]} if row else None


def in_leaf_scope(database: Connection, user_id: int, leaf_id: str) -> bool:
    return database.execute(
        f"SELECT 1 FROM auth_user u WHERE u.id=%s AND {LEAF_SCOPE_SQL}", (user_id, leaf_id)
    ).fetchone() is not None


def leaf_directory(database: Connection, leaf_id: str) -> dict[str, Any]:
    """Ward members plus all-ward users: everyone who may sign in at this Leaf."""
    rows = database.execute(
        f"SELECT u.* FROM auth_user u WHERE {LEAF_SCOPE_SQL} ORDER BY u.username", (leaf_id,)
    ).fetchall()
    return {
        "leaf_unit": leaf_unit(database, leaf_id),
        "units": ward_options(database)["rows"],
        "users": [record(database, row) for row in rows],
    }
