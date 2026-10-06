"""Canopy-side credential check, shared by Canopy sign-in and Leaf delegation."""
import logging
from typing import Any

from fastapi import HTTPException
from psycopg import Connection

from . import directory, ldap_auth
from .routes.auth_leaf import verify_password

log = logging.getLogger("flora.auth")


def _provision_ldap_user(database: Connection, username: str, profile: dict[str, Any]) -> dict[str, Any]:
    role = database.execute(
        "SELECT code FROM auth_role WHERE code=%s AND is_active=1", (ldap_auth.default_role(),)
    ).fetchone()
    if role is None:
        raise HTTPException(status_code=503, detail="LDAP default role is not configured")
    current = directory.now_ms()
    with database.transaction():
        row = database.execute(
            """INSERT INTO auth_user(username,auth_source,name,role,theme_mode,language_code,is_active,
                     must_change_password,all_units,directory_version,created_at,updated_at)
               VALUES (%s,'ldap',%s,%s,'dark',%s,1,0,0,%s,%s,%s) RETURNING *""",
            (username.lower(), profile.get("name") or username, role["code"],
             directory._default_language(database), current, current, current),
        ).fetchone()
        database.execute(
            """INSERT INTO auth_user_role(user_id,role_code,scope_type,scope_id,created_at,updated_at)
               VALUES (%s,%s,'global','*',%s,%s)""",
            (row["id"], role["code"], current, current),
        )
    log.warning("Provisioned LDAP user %s with role %s and no ward access", username, role["code"])
    return row


def authenticate(database: Connection, username: str, password: str) -> dict[str, Any]:
    """Return the auth_user row for valid credentials; raise 401 or 503 otherwise."""
    clean = username.strip()
    if not clean or not password:
        raise HTTPException(status_code=400, detail="username and password are required")
    user = database.execute(
        "SELECT * FROM auth_user WHERE lower(username)=lower(%s) LIMIT 1", (clean,)
    ).fetchone()
    if user is not None and not user["is_active"]:
        raise HTTPException(status_code=401, detail="invalid username or password")
    if user is not None and (user.get("auth_source") or "local") != "ldap":
        if verify_password(password, user["password_salt"] or "", user["password_hash"] or ""):
            return user
        raise HTTPException(status_code=401, detail="invalid username or password")
    if user is None and not (ldap_auth.enabled() and ldap_auth.auto_provision()):
        raise HTTPException(status_code=401, detail="invalid username or password")
    try:
        profile = ldap_auth.authenticate(clean, password)
    except ldap_auth.LdapUnavailable as error:
        log.error("LDAP unavailable: %s", error)
        raise HTTPException(status_code=503, detail="directory server unavailable") from None
    if profile is None:
        raise HTTPException(status_code=401, detail="invalid username or password")
    return user if user is not None else _provision_ldap_user(database, clean, profile)
