import hashlib
import hmac
import json
import os
import re
import secrets
import time
from functools import wraps
from inspect import signature
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Request
from psycopg import Connection
from psycopg.types.json import Jsonb
from pydantic import BaseModel

from .. import directory, ldap_auth
from ..database import connection
from ..account_config_sync import (
    apply_account_config, authenticate_with_canopy, pull_account_config, push_personal_theme,
)


router = APIRouter(prefix="/api/auth", tags=["authentication"])
SESSION_TTL_MS = int(os.getenv("FLORA_AUTH_SESSION_TTL_MS", str(30 * 24 * 60 * 60 * 1000)))
DEFAULT_PASSWORD = os.getenv("FLORA_DEFAULT_STAFF_PASSWORD", "flora").strip() or "flora"
SERVICE_SECRET = os.getenv("FLORA_LEAF_SERVICE_SECRET", "").strip()


def atomic(function):
    """Keep a mutation and its audit record in one PostgreSQL transaction."""
    parameters = signature(function)

    @wraps(function)
    def wrapped(*args, **kwargs):
        database = parameters.bind(*args, **kwargs).arguments["database"]
        with database.transaction():
            return function(*args, **kwargs)

    return wrapped


class LoginRequest(BaseModel):
    username: str
    password: str


class PreferenceRequest(BaseModel):
    name: str | None = None
    theme_mode: str | None = None
    theme_color: str | None = None
    language_code: str | None = None
    parameter_preferences: dict[str, Any] | None = None
    report_preferences: dict[str, Any] | None = None


class LanguageMasterRequest(BaseModel):
    name_en: str
    name_native: str
    is_active: bool
    sort_order: int = 0


class ThemeMasterRequest(BaseModel):
    display_name: str
    colors: list[str]
    is_active: bool
    sort_order: int = 0


class LanguageCreateRequest(LanguageMasterRequest):
    code: str


class ThemeCreateRequest(ThemeMasterRequest):
    code: str


class PersonalThemeRequest(BaseModel):
    display_name: str
    colors: list[str]


class PersonalThemeCreateRequest(PersonalThemeRequest):
    code: str


class TranslationMasterRequest(BaseModel):
    values: dict[str, str]


class ActiveRequest(BaseModel):
    is_active: bool


class StaffLinkRequest(BaseModel):
    staff_directory_id: int | None = None


class PasswordResetRequest(BaseModel):
    password: str | None = None


class PasswordChangeRequest(BaseModel):
    current_password: str
    new_password: str


class UserCreateRequest(BaseModel):
    username: str
    name: str
    password: str = ""
    auth_source: str = "local"
    all_units: bool = False
    unit_keys: list[str] = []
    hospital_id: str | None = None
    staff_directory_id: int | None = None
    role_codes: list[str] = ["clinician"]
    language_code: str = "en"
    theme_color: str | None = None
    is_active: bool = True


class UserAccessRequest(BaseModel):
    role_codes: list[str]


class UserWardsRequest(BaseModel):
    all_units: bool = False
    unit_keys: list[str] = []


class AdminPinRequest(BaseModel):
    current_password: str
    pin: str | None = None


def now_ms() -> int:
    return int(time.time() * 1000)


def personal_theme_values(code: str, display_name: str, colors: list[str]) -> tuple[str, str, list[str]]:
    normalized = code.strip().lower()
    clean_name = display_name.strip()
    clean_colors = [color.strip().lower() for color in colors]
    if re.fullmatch(r"[a-z0-9][a-z0-9-]{1,47}", normalized) is None:
        raise HTTPException(status_code=400, detail="invalid personal theme code")
    if not clean_name or len(clean_colors) != 6 or any(re.fullmatch(r"#[0-9a-f]{6}", color) is None for color in clean_colors):
        raise HTTPException(status_code=400, detail="theme name and six hex colors are required")
    return normalized, clean_name, clean_colors


def personal_theme_public(row: dict[str, Any]) -> dict[str, Any]:
    return {
        **dict(row),
        "code": f"personal:{row['code']}",
        "scope": "personal",
        "sync_state": row.get("sync_state") or "local",
    }


def valid_theme_selection(database: Connection, user_id: int, value: str) -> bool:
    normalized = value.strip().lower()
    if normalized.startswith("personal:"):
        code = normalized.removeprefix("personal:")
        return database.execute(
            "SELECT 1 FROM user_theme_scheme WHERE owner_user_id=%s AND code=%s AND is_active=1",
            (user_id, code),
        ).fetchone() is not None
    return database.execute(
        "SELECT 1 FROM theme_scheme_master WHERE code=%s AND is_active=1", (normalized,)
    ).fetchone() is not None


def token_from(request: Request) -> str:
    explicit = request.headers.get("x-flora-session", "").strip()
    if explicit:
        return explicit
    authorization = request.headers.get("authorization", "").strip()
    return authorization[7:].strip() if authorization.lower().startswith("bearer ") else ""


def token_hash(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def password_hash(password: str, salt_hex: str) -> str:
    return hashlib.scrypt(
        password.encode("utf-8"), salt=bytes.fromhex(salt_hex), n=2**14, r=8, p=1, dklen=64
    ).hex()


def verify_password(password: str, salt_hex: str, expected_hex: str) -> bool:
    try:
        return hmac.compare_digest(password_hash(password, salt_hex), expected_hex)
    except (TypeError, ValueError):
        return False


def new_password_record(password: str) -> tuple[str, str]:
    if not password:
        raise HTTPException(status_code=400, detail="password required")
    salt = secrets.token_hex(16)
    return salt, password_hash(password, salt)


LEGACY_ROLE_MAP = {
    "admin": "system_admin", "system_admin": "system_admin",
    "clinical_admin": "clinical_admin", "viewer": "viewer", "auditor": "viewer",
    "integration": "integration", "clinician": "clinician", "nurse": "clinician",
    "anesthetist": "clinician",
}


def entitlements(database: Connection, row: dict[str, Any]) -> tuple[list[str], list[str]]:
    assigned = database.execute(
        """SELECT role.code FROM auth_user_role assignment
           JOIN auth_role role ON role.code=assignment.role_code AND role.is_active=1
           WHERE assignment.user_id=%s ORDER BY role.sort_order,role.code""",
        (row["id"],),
    ).fetchall()
    roles = [item["code"] for item in assigned]
    if not roles:
        roles = [LEGACY_ROLE_MAP.get(str(row.get("role") or "").lower(), "clinician")]
    permissions = database.execute(
        """SELECT DISTINCT permission_code AS code FROM auth_role_permission
           WHERE role_code=ANY(%s) ORDER BY permission_code""",
        (roles,),
    ).fetchall()
    return roles, [item["code"] for item in permissions]


def attach_entitlements(database: Connection, row: dict[str, Any]) -> dict[str, Any]:
    roles, permissions = entitlements(database, row)
    row["_role_codes"] = roles
    row["_permissions"] = permissions
    row["_units"] = directory.user_units(database, row["id"]) if row.get("id") else []
    return row


def set_user_roles(database: Connection, user_id: int, role_codes: list[str]) -> list[str]:
    normalized = list(dict.fromkeys(str(code).strip().lower() for code in role_codes if str(code).strip()))
    if not normalized:
        raise HTTPException(status_code=400, detail="at least one role is required")
    rows = database.execute(
        "SELECT code FROM auth_role WHERE code=ANY(%s) AND is_active=1 ORDER BY sort_order,code",
        (normalized,),
    ).fetchall()
    valid = [row["code"] for row in rows]
    if set(valid) != set(normalized):
        raise HTTPException(status_code=400, detail="one or more roles are invalid or inactive")
    current = now_ms()
    database.execute("DELETE FROM auth_user_role WHERE user_id=%s", (user_id,))
    for code in valid:
        database.execute(
            """INSERT INTO auth_user_role(user_id,role_code,scope_type,scope_id,created_at,updated_at)
               VALUES (%s,%s,'global','*',%s,%s)""",
            (user_id, code, current, current),
        )
    legacy = "admin" if "system_admin" in valid else valid[0]
    database.execute("UPDATE auth_user SET role=%s,updated_at=%s WHERE id=%s", (legacy, current, user_id))
    directory.touch(database, user_id, current)
    return valid


def ward_access(row: dict[str, Any]) -> dict[str, Any]:
    return {"allUnits": directory.has_all_units(row), "units": row.get("_units") or []}


def public_user(row: dict[str, Any]) -> dict[str, Any]:
    result = {"username": row["username"], "name": row.get("name") or row["username"]}
    if row.get("role"):
        result["role"] = row["role"]
    if row.get("theme_mode"):
        result["themeMode"] = row["theme_mode"]
    if row.get("theme_color"):
        result["themeColor"] = row["theme_color"]
    if row.get("language_code"):
        result["languageCode"] = row["language_code"]
    result["staffDirectoryId"] = row.get("staff_directory_id")
    result["parameterPreferences"] = row.get("parameter_preferences") or {}
    result["reportPreferences"] = row.get("report_preferences") or {}
    result["roleCodes"] = row.get("_role_codes") or []
    result["permissions"] = row.get("_permissions") or []
    result["mustChangePassword"] = bool(row.get("must_change_password"))
    result["authSource"] = row.get("auth_source") or "local"
    result["wardAccess"] = ward_access(row)
    result["hasAdminPin"] = bool(row.get("admin_pin_hash"))
    return result


def managed_user(row: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": row["id"],
        "username": row["username"],
        "hospitalId": row.get("hospital_id"),
        "authSource": row.get("auth_source"),
        "name": row.get("name") or row["username"],
        "role": row.get("role"),
        "themeMode": row.get("theme_mode"),
        "themeColor": row.get("theme_color"),
        "languageCode": row.get("language_code") or "en",
        "staffDirectoryId": row.get("staff_directory_id"),
        "parameterPreferences": row.get("parameter_preferences") or {},
        "reportPreferences": row.get("report_preferences") or {},
        "isActive": bool(row.get("is_active")),
        "createdAt": row.get("created_at") or 0,
        "updatedAt": row.get("updated_at") or 0,
        "lastLoginAt": row.get("last_login_at"),
        "roleCodes": row.get("_role_codes") or [],
        "permissions": row.get("_permissions") or [],
        "mustChangePassword": bool(row.get("must_change_password")),
        "allUnits": bool(row.get("all_units")),
        "units": row.get("_units") or [],
        "hasAdminPin": bool(row.get("admin_pin_hash")),
        "syncState": ("pending" if row.get("directory_pending") else "synced" if row.get("directory_managed") else "local")
                     if directory.is_leaf() else "synced",
    }


def audit(
    database: Connection,
    action: str,
    actor: dict[str, Any] | None,
    *,
    target: dict[str, Any] | None = None,
    status: str = "ok",
    detail: dict[str, Any] | None = None,
) -> None:
    database.execute(
        """
        INSERT INTO auth_audit (
          action, actor_user_id, actor_username, actor_role,
          target_user_id, target_username, status, detail_json, created_at
        ) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s)
        """,
        (
            action,
            actor.get("id") if actor else None,
            actor.get("username") if actor else None,
            actor.get("role") if actor else None,
            target.get("id") if target else None,
            target.get("username") if target else None,
            status,
            json.dumps(detail, separators=(",", ":")) if detail else None,
            now_ms(),
        ),
    )


def current_user(request: Request, database: Connection = Depends(connection)) -> dict[str, Any]:
    supplied_service_secret = request.headers.get("x-flora-service-secret", "").strip()
    if SERVICE_SECRET and supplied_service_secret and hmac.compare_digest(SERVICE_SECRET, supplied_service_secret):
        return {
            "id": None, "username": "flora-sync", "name": "Flora Sync", "role": "integration",
            "must_change_password": 0, "_role_codes": ["integration"],
            "_permissions": ["case.read", "integration.ingest"],
        }
    token = token_from(request)
    current = now_ms()
    if not token:
        raise HTTPException(status_code=401, detail="sign in required")
    row = database.execute(
        """
        SELECT s.id AS session_id, s.expires_at, s.revoked_at,
               u.id, u.username, u.hospital_id, u.auth_source, u.name, u.role,
               u.theme_mode, u.theme_color, u.language_code, u.staff_directory_id,
               u.parameter_preferences, u.report_preferences, u.is_active,
               u.must_change_password, u.created_at, u.updated_at, u.last_login_at,
               u.all_units, u.admin_pin_hash, u.directory_pending, u.directory_managed
        FROM auth_session s
        JOIN auth_user u ON u.id = s.user_id
        WHERE s.token_hash = %s
        LIMIT 1
        """,
        (token_hash(token),),
    ).fetchone()
    if row is None or row["revoked_at"] is not None or row["expires_at"] <= current or not row["is_active"]:
        raise HTTPException(status_code=401, detail="sign in required")
    database.execute(
        "UPDATE auth_session SET updated_at=%s, last_seen_at=%s, expires_at=%s WHERE id=%s",
        (current, current, current + SESSION_TTL_MS, row["session_id"]),
    )
    return attach_entitlements(database, row)


def admin_user(user: dict[str, Any] = Depends(current_user)) -> dict[str, Any]:
    if "account.manage" not in user.get("_permissions", []):
        raise HTTPException(status_code=403, detail="account.manage permission required")
    return user


def require_permission(permission_code: str):
    def permitted(user: dict[str, Any] = Depends(current_user)) -> dict[str, Any]:
        if user.get("must_change_password"):
            raise HTTPException(status_code=403, detail="password change required")
        if permission_code not in user.get("_permissions", []):
            raise HTTPException(status_code=403, detail=f"{permission_code} permission required")
        return user
    return permitted


def pin_approval(
    request: Request, user: dict[str, Any] = Depends(current_user), database: Connection = Depends(connection)
) -> dict[str, Any]:
    """Leaf user-management writes need an administrator's PIN, whoever is signed in."""
    approver = directory.approve_with_pin(database, request.headers.get("x-flora-admin-pin", "").strip())
    user["_approved_by"] = approver["username"]
    return user


def service_only(user: dict[str, Any] = Depends(current_user)) -> dict[str, Any]:
    if user.get("username") != "flora-sync" or user.get("id") is not None:
        raise HTTPException(status_code=403, detail="service access required")
    return user


def approval_detail(actor: dict[str, Any], detail: dict[str, Any] | None = None) -> dict[str, Any]:
    result = dict(detail or {})
    if actor.get("_approved_by"):
        result["approvedBy"] = actor["_approved_by"]
    return result


@router.post("/login")
def login(payload: LoginRequest, request: Request, database: Connection = Depends(connection)) -> dict:
    username = payload.username.strip()
    if not username or not payload.password:
        raise HTTPException(status_code=400, detail="username and password are required")
    user = database.execute(
        "SELECT * FROM auth_user WHERE lower(username)=lower(%s) LIMIT 1", (username,)
    ).fetchone()
    local_ok = (
        user is not None and user["is_active"] and (user.get("auth_source") or "local") != "ldap"
        and verify_password(payload.password, user["password_salt"], user["password_hash"])
    )
    if not local_ok:
        # Ask Canopy: a user just assigned to this ward, a password changed centrally,
        # or an LDAP account. LDAP passwords are cached locally for offline sign-in.
        outcome, central = authenticate_with_canopy(username, payload.password)
        if outcome == "ok" and central:
            with database.transaction():
                directory.apply_record(database, central, from_canopy=True)
                if central.get("auth_source") == "ldap":
                    salt, hashed = new_password_record(payload.password)
                    database.execute(
                        "UPDATE auth_user SET password_salt=%s,password_hash=%s WHERE lower(username)=lower(%s)",
                        (salt, hashed, username),
                    )
            user = database.execute(
                "SELECT * FROM auth_user WHERE lower(username)=lower(%s) LIMIT 1", (username,)
            ).fetchone()
            local_ok = user is not None and bool(user["is_active"])
        elif outcome == "unavailable" and user is not None and user["is_active"] and user.get("auth_source") == "ldap":
            local_ok = verify_password(payload.password, user["password_salt"] or "", user["password_hash"] or "")
    if not local_ok:
        audit(database, "auth.login", None, target={"username": username}, status="denied", detail={"reason": "invalid_credentials"})
        raise HTTPException(status_code=401, detail="invalid username or password")
    central_config = pull_account_config(user["username"])
    preference_source = "local"
    if central_config is not None:
        try:
            with database.transaction():
                if apply_account_config(database, user["id"], central_config):
                    preference_source = "canopy"
                    user = database.execute("SELECT * FROM auth_user WHERE id=%s", (user["id"],)).fetchone()
        except Exception:
            # Authentication and offline fallback must remain available if central configuration is invalid.
            preference_source = "local"
    token = secrets.token_urlsafe(32)
    current = now_ms()
    expires = current + SESSION_TTL_MS
    database.execute(
        """
        INSERT INTO auth_session (user_id, token_hash, client_label, created_at, updated_at, last_seen_at, expires_at)
        VALUES (%s, %s, %s, %s, %s, %s, %s)
        """,
        (user["id"], token_hash(token), request.headers.get("x-flora-client") or request.headers.get("user-agent"), current, current, current, expires),
    )
    database.execute("UPDATE auth_user SET last_login_at=%s, updated_at=%s WHERE id=%s", (current, current, user["id"]))
    audit(database, "auth.login", user, target=user)
    return {"user": public_user(attach_entitlements(database, user)), "session_token": token, "expires_at": expires,
            "preference_source": preference_source}


@router.post("/logout")
@atomic
def logout(request: Request, user: dict = Depends(current_user), database: Connection = Depends(connection)) -> dict:
    current = now_ms()
    database.execute(
        "UPDATE auth_session SET revoked_at=%s, updated_at=%s WHERE token_hash=%s",
        (current, current, token_hash(token_from(request))),
    )
    audit(database, "auth.logout", user, target=user)
    return {"ok": True}


@router.get("/whoami")
def whoami(user: dict = Depends(current_user)) -> dict:
    return {"user": public_user(user)}


@router.get("/preferences/options")
def preference_options(database: Connection = Depends(connection)) -> dict:
    languages = database.execute(
        """
        SELECT code, name_en, name_native
        FROM language_master
        WHERE is_active = 1
        ORDER BY sort_order, code
        """
    ).fetchall()
    themes = database.execute(
        """
        SELECT code, display_name, color_1_canvas, color_2_surface, color_3_border,
               color_4_text, color_5_muted, color_6_accent
        FROM theme_scheme_master
        WHERE is_active = 1
        ORDER BY sort_order, code
        """
    ).fetchall()
    return {
        "defaultLanguage": languages[0]["code"] if languages else "en",
        "defaultTheme": themes[0]["code"] if themes else "monochromatic",
        "languages": [dict(row) for row in languages],
        "themes": [dict(row) for row in themes],
    }


@router.get("/preferences/translations/{code}")
def language_translations(code: str, database: Connection = Depends(connection)) -> dict:
    rows = database.execute(
        "SELECT translation_key,translation_value FROM language_translation WHERE language_code=%s ORDER BY translation_key",
        (code.strip().lower(),),
    ).fetchall()
    return {"code": code.strip().lower(), "values": {row["translation_key"]: row["translation_value"] for row in rows}}


@router.get("/preferences/master")
def preference_master(
    _: dict = Depends(require_permission("config.manage")),
    database: Connection = Depends(connection),
) -> dict:
    languages = database.execute(
        "SELECT code,name_en,name_native,is_active,sort_order FROM language_master ORDER BY sort_order,code"
    ).fetchall()
    themes = database.execute(
        """SELECT code,display_name,color_1_canvas,color_2_surface,color_3_border,
                  color_4_text,color_5_muted,color_6_accent,is_active,sort_order
           FROM theme_scheme_master ORDER BY sort_order,code"""
    ).fetchall()
    return {"languages": [dict(row) for row in languages], "themes": [dict(row) for row in themes]}


@router.put("/preferences/languages/{code}")
@atomic
def update_language_master(
    code: str,
    payload: LanguageMasterRequest,
    actor: dict = Depends(require_permission("config.manage")),
    database: Connection = Depends(connection),
) -> dict:
    normalized = code.strip().lower()
    if not normalized or not payload.name_en.strip() or not payload.name_native.strip():
        raise HTTPException(status_code=400, detail="language names are required")
    if not payload.is_active:
        active_count = database.execute("SELECT count(*) AS n FROM language_master WHERE is_active=1").fetchone()["n"]
        current = database.execute("SELECT is_active FROM language_master WHERE code=%s", (normalized,)).fetchone()
        if current and current["is_active"] and active_count <= 1:
            raise HTTPException(status_code=400, detail="at least one language must remain active")
    row = database.execute(
        """UPDATE language_master SET name_en=%s,name_native=%s,is_active=%s,sort_order=%s,updated_at=%s
           WHERE code=%s RETURNING *""",
        (payload.name_en.strip(), payload.name_native.strip(), 1 if payload.is_active else 0,
         payload.sort_order, now_ms(), normalized),
    ).fetchone()
    if row is None:
        raise HTTPException(status_code=404, detail="language not found")
    audit(database, "auth.preference.language.update", actor, detail={"code": normalized})
    return {"row": dict(row)}


@router.post("/preferences/languages")
@atomic
def create_language_master(payload: LanguageCreateRequest, actor: dict = Depends(require_permission("config.manage")), database: Connection = Depends(connection)) -> dict:
    code = payload.code.strip().lower()
    if re.fullmatch(r"[a-z]{2,8}(?:-[a-z0-9]{2,8})?", code) is None:
        raise HTTPException(status_code=400, detail="invalid language code")
    if not payload.name_en.strip() or not payload.name_native.strip():
        raise HTTPException(status_code=400, detail="language names are required")
    try:
        row = database.execute(
            """INSERT INTO language_master(code,name_en,name_native,is_active,sort_order,created_at,updated_at)
               VALUES (%s,%s,%s,%s,%s,%s,%s) RETURNING *""",
            (code, payload.name_en.strip(), payload.name_native.strip(), 1 if payload.is_active else 0,
             payload.sort_order, now_ms(), now_ms()),
        ).fetchone()
    except Exception as error:
        raise HTTPException(status_code=409, detail="language code already exists") from error
    audit(database, "auth.preference.language.create", actor, detail={"code": code})
    return {"row": dict(row)}


@router.delete("/preferences/languages/{code}")
@atomic
def delete_language_master(code: str, actor: dict = Depends(require_permission("config.manage")), database: Connection = Depends(connection)) -> dict:
    normalized = code.strip().lower()
    replacement = database.execute(
        "SELECT code FROM language_master WHERE code<>%s ORDER BY is_active DESC,sort_order,code LIMIT 1", (normalized,)
    ).fetchone()
    if replacement is None:
        raise HTTPException(status_code=400, detail="at least one language profile is required")
    database.execute("UPDATE auth_user SET language_code=%s WHERE language_code=%s", (replacement["code"], normalized))
    deleted = database.execute("DELETE FROM language_master WHERE code=%s RETURNING code", (normalized,)).fetchone()
    if deleted is None:
        raise HTTPException(status_code=404, detail="language not found")
    audit(database, "auth.preference.language.delete", actor, detail={"code": normalized, "replacement": replacement["code"]})
    return {"ok": True, "code": normalized}


@router.put("/preferences/translations/{code}")
@atomic
def update_language_translations(code: str, payload: TranslationMasterRequest, actor: dict = Depends(require_permission("config.manage")), database: Connection = Depends(connection)) -> dict:
    normalized = code.strip().lower()
    if database.execute("SELECT 1 FROM language_master WHERE code=%s", (normalized,)).fetchone() is None:
        raise HTTPException(status_code=404, detail="language not found")
    current = now_ms()
    for key, value in payload.values.items():
        clean_key, clean_value = key.strip(), value.strip()
        if not clean_key or len(clean_key) > 160 or len(clean_value) > 4000:
            raise HTTPException(status_code=400, detail="invalid translation entry")
        if clean_value:
            database.execute(
                """INSERT INTO language_translation(language_code,translation_key,translation_value,updated_at)
                   VALUES (%s,%s,%s,%s) ON CONFLICT(language_code,translation_key)
                   DO UPDATE SET translation_value=excluded.translation_value,updated_at=excluded.updated_at""",
                (normalized, clean_key, clean_value, current),
            )
        else:
            database.execute("DELETE FROM language_translation WHERE language_code=%s AND translation_key=%s", (normalized, clean_key))
    audit(database, "auth.preference.translation.update", actor, detail={"code": normalized, "count": len(payload.values)})
    return language_translations(normalized, database)


@router.put("/preferences/themes/{code}")
@atomic
def update_theme_master(
    code: str,
    payload: ThemeMasterRequest,
    actor: dict = Depends(require_permission("config.manage")),
    database: Connection = Depends(connection),
) -> dict:
    normalized = code.strip().lower()
    colors = [color.strip().lower() for color in payload.colors]
    if not normalized or not payload.display_name.strip():
        raise HTTPException(status_code=400, detail="scheme name is required")
    if len(colors) != 6 or any(re.fullmatch(r"#[0-9a-f]{6}", color) is None for color in colors):
        raise HTTPException(status_code=400, detail="exactly six hex colors are required")
    if not payload.is_active:
        active_count = database.execute("SELECT count(*) AS n FROM theme_scheme_master WHERE is_active=1").fetchone()["n"]
        current = database.execute("SELECT is_active FROM theme_scheme_master WHERE code=%s", (normalized,)).fetchone()
        if current and current["is_active"] and active_count <= 1:
            raise HTTPException(status_code=400, detail="at least one scheme must remain active")
    row = database.execute(
        """UPDATE theme_scheme_master SET display_name=%s,color_1_canvas=%s,color_2_surface=%s,
                  color_3_border=%s,color_4_text=%s,color_5_muted=%s,color_6_accent=%s,
                  is_active=%s,sort_order=%s,updated_at=%s WHERE code=%s RETURNING *""",
        (payload.display_name.strip(), *colors, 1 if payload.is_active else 0,
         payload.sort_order, now_ms(), normalized),
    ).fetchone()
    if row is None:
        raise HTTPException(status_code=404, detail="theme scheme not found")
    audit(database, "auth.preference.theme.update", actor, detail={"code": normalized})
    return {"row": dict(row)}


@router.post("/preferences/themes")
@atomic
def create_theme_master(payload: ThemeCreateRequest, actor: dict = Depends(require_permission("config.manage")), database: Connection = Depends(connection)) -> dict:
    code = payload.code.strip().lower()
    colors = [color.strip().lower() for color in payload.colors]
    if re.fullmatch(r"[a-z0-9][a-z0-9-]{1,47}", code) is None:
        raise HTTPException(status_code=400, detail="invalid scheme code")
    if not payload.display_name.strip() or len(colors) != 6 or any(re.fullmatch(r"#[0-9a-f]{6}", color) is None for color in colors):
        raise HTTPException(status_code=400, detail="scheme name and six hex colors are required")
    try:
        row = database.execute(
            """INSERT INTO theme_scheme_master(code,display_name,color_1_canvas,color_2_surface,color_3_border,
                     color_4_text,color_5_muted,color_6_accent,is_active,sort_order,created_at,updated_at)
               VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s) RETURNING *""",
            (code, payload.display_name.strip(), *colors, 1 if payload.is_active else 0,
             payload.sort_order, now_ms(), now_ms()),
        ).fetchone()
    except Exception as error:
        raise HTTPException(status_code=409, detail="scheme code already exists") from error
    audit(database, "auth.preference.theme.create", actor, detail={"code": code})
    return {"row": dict(row)}


@router.delete("/preferences/themes/{code}")
@atomic
def delete_theme_master(code: str, actor: dict = Depends(require_permission("config.manage")), database: Connection = Depends(connection)) -> dict:
    normalized = code.strip().lower()
    replacement = database.execute("SELECT code FROM theme_scheme_master WHERE code<>%s ORDER BY is_active DESC,sort_order,code LIMIT 1", (normalized,)).fetchone()
    if replacement is None:
        raise HTTPException(status_code=400, detail="at least one scheme profile is required")
    database.execute("UPDATE auth_user SET theme_color=%s WHERE theme_color=%s", (replacement["code"], normalized))
    deleted = database.execute("DELETE FROM theme_scheme_master WHERE code=%s RETURNING code", (normalized,)).fetchone()
    if deleted is None:
        raise HTTPException(status_code=404, detail="scheme not found")
    audit(database, "auth.preference.theme.delete", actor, detail={"code": normalized, "replacement": replacement["code"]})
    return {"ok": True, "code": normalized}


@router.get("/self/themes")
def personal_themes(user: dict = Depends(current_user), database: Connection = Depends(connection)) -> dict:
    rows = database.execute(
        """SELECT code,display_name,color_1_canvas,color_2_surface,color_3_border,
                  color_4_text,color_5_muted,color_6_accent,is_active,sync_state,created_at,updated_at
           FROM user_theme_scheme WHERE owner_user_id=%s AND is_active=1
           ORDER BY updated_at DESC,code""",
        (user["id"],),
    ).fetchall()
    return {"rows": [personal_theme_public(row) for row in rows]}


@router.post("/self/themes")
@atomic
def create_personal_theme(
    payload: PersonalThemeCreateRequest,
    user: dict = Depends(current_user),
    database: Connection = Depends(connection),
) -> dict:
    code, display_name, colors = personal_theme_values(payload.code, payload.display_name, payload.colors)
    current = now_ms()
    try:
        row = database.execute(
            """INSERT INTO user_theme_scheme(owner_user_id,code,display_name,color_1_canvas,color_2_surface,
                     color_3_border,color_4_text,color_5_muted,color_6_accent,is_active,sync_state,created_at,updated_at)
               VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,1,'local',%s,%s) RETURNING *""",
            (user["id"], code, display_name, *colors, current, current),
        ).fetchone()
    except Exception as error:
        raise HTTPException(status_code=409, detail="personal theme code already exists") from error
    audit(database, "auth.personal-theme.create", user, detail={"code": code})
    return {"row": personal_theme_public(row)}


@router.put("/self/themes/{code}")
@atomic
def update_personal_theme(
    code: str,
    payload: PersonalThemeRequest,
    user: dict = Depends(current_user),
    database: Connection = Depends(connection),
) -> dict:
    normalized, display_name, colors = personal_theme_values(code, payload.display_name, payload.colors)
    row = database.execute(
        """UPDATE user_theme_scheme SET display_name=%s,color_1_canvas=%s,color_2_surface=%s,
                  color_3_border=%s,color_4_text=%s,color_5_muted=%s,color_6_accent=%s,
                  sync_state='local',updated_at=%s
           WHERE owner_user_id=%s AND code=%s RETURNING *""",
        (display_name, *colors, now_ms(), user["id"], normalized),
    ).fetchone()
    if row is None:
        raise HTTPException(status_code=404, detail="personal theme not found")
    audit(database, "auth.personal-theme.update", user, detail={"code": normalized})
    return {"row": personal_theme_public(row)}


@router.delete("/self/themes/{code}")
@atomic
def delete_personal_theme(
    code: str,
    user: dict = Depends(current_user),
    database: Connection = Depends(connection),
) -> dict:
    normalized = code.strip().lower().removeprefix("personal:")
    deleted = database.execute(
        "DELETE FROM user_theme_scheme WHERE owner_user_id=%s AND code=%s RETURNING code",
        (user["id"], normalized),
    ).fetchone()
    if deleted is None:
        raise HTTPException(status_code=404, detail="personal theme not found")
    database.execute(
        "UPDATE auth_user SET theme_color='monochromatic',updated_at=%s WHERE id=%s AND theme_color=%s",
        (now_ms(), user["id"], f"personal:{normalized}"),
    )
    audit(database, "auth.personal-theme.delete", user, detail={"code": normalized})
    return {"ok": True, "code": f"personal:{normalized}"}


@router.post("/self/themes/{code}/save-to-account")
@atomic
def save_personal_theme_to_account(
    code: str,
    user: dict = Depends(current_user),
    database: Connection = Depends(connection),
) -> dict:
    normalized = code.strip().lower().removeprefix("personal:")
    row = database.execute(
        "SELECT * FROM user_theme_scheme WHERE owner_user_id=%s AND code=%s AND is_active=1",
        (user["id"], normalized),
    ).fetchone()
    if row is None:
        raise HTTPException(status_code=404, detail="personal theme not found")
    if not push_personal_theme(user["username"], row):
        raise HTTPException(status_code=503, detail="Canopy is unavailable; theme remains local")
    row = database.execute(
        """UPDATE user_theme_scheme SET sync_state='central',updated_at=%s
           WHERE owner_user_id=%s AND code=%s RETURNING *""",
        (now_ms(), user["id"], normalized),
    ).fetchone()
    audit(database, "auth.personal-theme.publish", user, detail={"code": normalized})
    return {"row": personal_theme_public(row)}


@router.get("/self")
def self_account(user: dict = Depends(current_user)) -> dict:
    return {"row": managed_user(user)}


@router.get("/roles")
def roles(
    _: dict = Depends(admin_user),
    database: Connection = Depends(connection),
) -> dict:
    rows = database.execute(
        """SELECT role.code,role.display_name,role.description,role.is_system,role.is_active,
                  role.sort_order,coalesce(array_agg(permission.permission_code ORDER BY permission.permission_code)
                  FILTER (WHERE permission.permission_code IS NOT NULL),'{}') AS permissions
           FROM auth_role role
           LEFT JOIN auth_role_permission permission ON permission.role_code=role.code
           GROUP BY role.code ORDER BY role.sort_order,role.code"""
    ).fetchall()
    return {"rows": [dict(row) for row in rows]}


@router.get("/users")
def users(
    q: str = "",
    include_inactive: bool = True,
    _: dict = Depends(admin_user),
    database: Connection = Depends(connection),
) -> dict:
    pattern = f"%{q.strip()}%"
    rows = database.execute(
        """
        SELECT * FROM auth_user
        WHERE (%s = '' OR username ILIKE %s OR name ILIKE %s OR coalesce(hospital_id, '') ILIKE %s)
          AND (%s OR is_active = 1)
        ORDER BY name, username
        """,
        (q.strip(), pattern, pattern, pattern, include_inactive),
    ).fetchall()
    return {"rows": [managed_user(attach_entitlements(database, row)) for row in rows]}


@router.post("/users")
@atomic
def create_user(
    payload: UserCreateRequest,
    actor: dict = Depends(pin_approval),
    database: Connection = Depends(connection),
) -> dict:
    username = payload.username.strip().lower()
    name = payload.name.strip()
    password = payload.password.strip()
    auth_source = payload.auth_source.strip().lower() or "local"
    if auth_source not in {"local", "ldap"}:
        raise HTTPException(status_code=400, detail="authentication source must be local or ldap")
    if re.fullmatch(r"[a-z0-9][a-z0-9._-]{2,63}", username) is None:
        raise HTTPException(status_code=400, detail="username must be 3-64 characters using letters, numbers, dot, underscore or dash")
    if not name:
        raise HTTPException(status_code=400, detail="display name is required")
    if auth_source == "local" and len(password) < 8:
        raise HTTPException(status_code=400, detail="temporary password must be at least 8 characters")
    if payload.staff_directory_id is not None:
        staff = database.execute("SELECT id,hospital_id FROM staff_directory WHERE id=%s", (payload.staff_directory_id,)).fetchone()
        if staff is None:
            raise HTTPException(status_code=404, detail="staff directory entry not found")
        linked = database.execute("SELECT id FROM auth_user WHERE staff_directory_id=%s", (payload.staff_directory_id,)).fetchone()
        if linked is not None:
            raise HTTPException(status_code=409, detail="staff profile is already linked to another user")
    else:
        staff = None
    language = database.execute("SELECT code FROM language_master WHERE code=%s AND is_active=1", (payload.language_code,)).fetchone()
    if language is None:
        raise HTTPException(status_code=400, detail="invalid language")
    theme = payload.theme_color
    if theme is not None and database.execute("SELECT code FROM theme_scheme_master WHERE code=%s AND is_active=1", (theme,)).fetchone() is None:
        raise HTTPException(status_code=400, detail="invalid scheme")
    salt, hashed = new_password_record(password) if auth_source == "local" else (None, None)
    current = now_ms()
    try:
        with database.transaction():
            row = database.execute(
                """INSERT INTO auth_user(username,hospital_id,auth_source,password_salt,password_hash,name,role,
                         theme_mode,theme_color,language_code,staff_directory_id,is_active,must_change_password,
                         created_at,updated_at,parameter_preferences,report_preferences)
                   VALUES (%s,%s,%s,%s,%s,%s,'clinician','dark',%s,%s,%s,%s,%s,%s,%s,'{}'::jsonb,'{}'::jsonb)
                   RETURNING *""",
                (username, payload.hospital_id.strip() if payload.hospital_id else (staff.get("hospital_id") if staff else None),
                 auth_source, salt, hashed, name, theme, payload.language_code, payload.staff_directory_id,
                 1 if payload.is_active else 0, 1 if auth_source == "local" else 0, current, current),
            ).fetchone()
    except Exception as error:
        raise HTTPException(status_code=409, detail="username or staff link already exists") from error
    role_codes = set_user_roles(database, row["id"], payload.role_codes)
    unit_keys = payload.unit_keys
    if directory.is_leaf() and not payload.all_units and not unit_keys:
        # A user created at the bedside belongs to this Leaf's ward unless told otherwise.
        leaf_unit = directory.ward_options(database)["leafUnitKey"]
        unit_keys = [leaf_unit] if leaf_unit else []
    directory.set_units(database, row["id"], payload.all_units, unit_keys)
    row = database.execute("SELECT * FROM auth_user WHERE id=%s", (row["id"],)).fetchone()
    row = attach_entitlements(database, row)
    audit(database, "auth.user.create", actor, target=row,
          detail=approval_detail(actor, {"roles": role_codes, "authSource": auth_source,
                                         "allUnits": payload.all_units, "units": unit_keys}))
    return {"row": managed_user(row)}


@router.put("/users/{user_id}/access")
@atomic
def update_user_access(
    user_id: int,
    payload: UserAccessRequest,
    actor: dict = Depends(pin_approval),
    database: Connection = Depends(connection),
) -> dict:
    existing = database.execute("SELECT * FROM auth_user WHERE id=%s", (user_id,)).fetchone()
    if existing is None:
        raise HTTPException(status_code=404, detail="user not found")
    if user_id == actor["id"] and "system_admin" not in payload.role_codes:
        raise HTTPException(status_code=400, detail="you cannot remove your own system administrator access")
    role_codes = set_user_roles(database, user_id, payload.role_codes)
    row = attach_entitlements(database, database.execute("SELECT * FROM auth_user WHERE id=%s", (user_id,)).fetchone())
    audit(database, "auth.user.access.update", actor, target=row, detail=approval_detail(actor, {"roles": role_codes}))
    return {"row": managed_user(row)}


@router.put("/self/preferences")
@atomic
def preferences(
    payload: PreferenceRequest,
    user: dict = Depends(current_user),
    database: Connection = Depends(connection),
) -> dict:
    if all(value is None for value in (payload.name,payload.theme_mode,payload.theme_color,payload.language_code,payload.parameter_preferences,payload.report_preferences)):
        raise HTTPException(status_code=400, detail="at least one preference is required")
    clean_name = payload.name.strip() if payload.name is not None else None
    if payload.name is not None and not clean_name:
        raise HTTPException(status_code=400, detail="name required")
    if payload.theme_mode is not None and payload.theme_mode != "dark":
        raise HTTPException(status_code=400, detail="invalid theme mode")
    if payload.theme_color is not None:
        if not valid_theme_selection(database, user["id"], payload.theme_color):
            raise HTTPException(status_code=400, detail="invalid theme scheme")
    if payload.language_code is not None:
        valid_language = database.execute(
            "SELECT 1 FROM language_master WHERE code=%s AND is_active=1",
            (payload.language_code,),
        ).fetchone()
        if valid_language is None:
            raise HTTPException(status_code=400, detail="invalid language")
    current = now_ms()
    row = database.execute(
        """
        UPDATE auth_user
        SET name=coalesce(%s, name),
            theme_mode=coalesce(%s, theme_mode),
            theme_color=coalesce(%s, theme_color),
            language_code=coalesce(%s, language_code),
            parameter_preferences=coalesce(%s, parameter_preferences),
            report_preferences=coalesce(%s, report_preferences),
            updated_at=%s
        WHERE id=%s
        RETURNING *
        """,
        (clean_name,payload.theme_mode,payload.theme_color,payload.language_code,
         Jsonb(payload.parameter_preferences) if payload.parameter_preferences is not None else None,
         Jsonb(payload.report_preferences) if payload.report_preferences is not None else None,
         current,user["id"]),
    ).fetchone()
    audit(database, "auth.self.set-preferences", user, target=row)
    row = attach_entitlements(database, row)
    return {"user": public_user(row), "row": managed_user(row)}


@router.put("/users/{user_id}/staff-link")
@atomic
def link_user_staff(
    user_id: int,
    payload: StaffLinkRequest,
    actor: dict = Depends(pin_approval),
    database: Connection = Depends(connection),
) -> dict:
    if payload.staff_directory_id is not None:
        staff = database.execute("SELECT id,hospital_id FROM staff_directory WHERE id=%s",(payload.staff_directory_id,)).fetchone()
        if staff is None: raise HTTPException(status_code=404, detail="staff directory entry not found")
        linked = database.execute(
            "SELECT id FROM auth_user WHERE staff_directory_id=%s AND id<>%s",
            (payload.staff_directory_id, user_id),
        ).fetchone()
        if linked is not None:
            raise HTTPException(status_code=409, detail="staff profile is already linked to another user")
    else:
        staff = None
    row=database.execute("""UPDATE auth_user SET staff_directory_id=%s,
      hospital_id=coalesce(%s,hospital_id),updated_at=%s WHERE id=%s RETURNING *""",
      (payload.staff_directory_id,staff.get("hospital_id") if staff else None,now_ms(),user_id)).fetchone()
    if row is None: raise HTTPException(status_code=404, detail="user not found")
    audit(database,"auth.user.staff-link",actor,target=row,detail=approval_detail(actor,{"staffDirectoryId":payload.staff_directory_id}))
    return {"row":managed_user(attach_entitlements(database, row))}


@router.put("/users/{user_id}/active")
@atomic
def set_active(
    user_id: int,
    payload: ActiveRequest,
    actor: dict = Depends(pin_approval),
    database: Connection = Depends(connection),
) -> dict:
    if not payload.is_active and user_id == actor["id"]:
        raise HTTPException(status_code=400, detail="you cannot deactivate your own account")
    if not payload.is_active:
        target_admin = database.execute(
            "SELECT 1 FROM auth_user_role WHERE user_id=%s AND role_code='system_admin'", (user_id,)
        ).fetchone()
        active_admins = database.execute(
            """SELECT count(DISTINCT account.id) AS n FROM auth_user account
               JOIN auth_user_role assignment ON assignment.user_id=account.id
               WHERE account.is_active=1 AND assignment.role_code='system_admin'"""
        ).fetchone()["n"]
        if target_admin and active_admins <= 1:
            raise HTTPException(status_code=400, detail="at least one active system administrator is required")
    row = database.execute(
        "UPDATE auth_user SET is_active=%s, updated_at=%s WHERE id=%s RETURNING *",
        (1 if payload.is_active else 0, now_ms(), user_id),
    ).fetchone()
    if row is None:
        raise HTTPException(status_code=404, detail="user not found")
    directory.touch(database, user_id)
    if not payload.is_active and directory.is_leaf():
        database.execute("UPDATE auth_session SET revoked_at=%s WHERE user_id=%s AND revoked_at IS NULL", (now_ms(), user_id))
    audit(database, "auth.user.set-active", actor, target=row, detail=approval_detail(actor, {"isActive": payload.is_active}))
    row = database.execute("SELECT * FROM auth_user WHERE id=%s", (user_id,)).fetchone()
    return {"row": managed_user(attach_entitlements(database, row))}


@router.post("/users/{user_id}/reset-password")
@atomic
def reset_password(
    user_id: int,
    payload: PasswordResetRequest,
    actor: dict = Depends(pin_approval),
    database: Connection = Depends(connection),
) -> dict:
    existing = database.execute("SELECT * FROM auth_user WHERE id=%s", (user_id,)).fetchone()
    if existing is None:
        raise HTTPException(status_code=404, detail="user not found")
    if existing.get("auth_source") == "ldap":
        raise HTTPException(status_code=400, detail="LDAP passwords are managed in the directory server")
    applied = (payload.password or "").strip() or (
        DEFAULT_PASSWORD if existing.get("auth_source") == "staff" else str(existing.get("hospital_id") or "").strip()
    )
    if not applied:
        raise HTTPException(status_code=400, detail="no default password available for this user")
    salt, hashed = new_password_record(applied)
    row = database.execute(
        "UPDATE auth_user SET password_salt=%s, password_hash=%s, must_change_password=1, updated_at=%s WHERE id=%s RETURNING *",
        (salt, hashed, now_ms(), user_id),
    ).fetchone()
    if row is None:
        raise HTTPException(status_code=404, detail="user not found")
    directory.touch(database, user_id)
    if directory.is_leaf():
        database.execute("UPDATE auth_session SET revoked_at=%s WHERE user_id=%s AND revoked_at IS NULL", (now_ms(), user_id))
    audit(database, "auth.user.reset-password", actor, target=row, detail=approval_detail(actor))
    row = database.execute("SELECT * FROM auth_user WHERE id=%s", (user_id,)).fetchone()
    return {"row": managed_user(attach_entitlements(database, row)), "applied_password": applied}


@router.post("/self/change-password")
@atomic
def change_password(
    payload: PasswordChangeRequest,
    user: dict = Depends(current_user),
    database: Connection = Depends(connection),
) -> dict:
    if user.get("auth_source") == "ldap":
        raise HTTPException(status_code=400, detail="LDAP passwords are managed in the directory server")
    credential = database.execute("SELECT password_salt, password_hash FROM auth_user WHERE id=%s", (user["id"],)).fetchone()
    if credential is None or not verify_password(payload.current_password, credential["password_salt"], credential["password_hash"]):
        raise HTTPException(status_code=400, detail="current password is incorrect")
    new_password = payload.new_password.strip()
    if len(new_password) < 8:
        raise HTTPException(status_code=400, detail="new password must be at least 8 characters")
    salt, hashed = new_password_record(new_password)
    row = database.execute(
        "UPDATE auth_user SET password_salt=%s, password_hash=%s, must_change_password=0, updated_at=%s WHERE id=%s RETURNING *",
        (salt, hashed, now_ms(), user["id"]),
    ).fetchone()
    directory.touch(database, user["id"])
    audit(database, "auth.self.change-password", user, target=row)
    return {"row": managed_user(attach_entitlements(database, row))}


@router.put("/users/{user_id}/wards")
@atomic
def update_user_wards(
    user_id: int,
    payload: UserWardsRequest,
    actor: dict = Depends(pin_approval),
    database: Connection = Depends(connection),
) -> dict:
    if database.execute("SELECT 1 FROM auth_user WHERE id=%s", (user_id,)).fetchone() is None:
        raise HTTPException(status_code=404, detail="user not found")
    units = directory.set_units(database, user_id, payload.all_units, payload.unit_keys)
    row = attach_entitlements(database, database.execute("SELECT * FROM auth_user WHERE id=%s", (user_id,)).fetchone())
    audit(database, "auth.user.wards.update", actor, target=row,
          detail=approval_detail(actor, {"allUnits": payload.all_units, "units": [unit["key"] for unit in units]}))
    return {"row": managed_user(row)}


@router.get("/ward-options")
def leaf_ward_options(_: dict = Depends(current_user), database: Connection = Depends(connection)) -> dict:
    return directory.ward_options(database)


@router.get("/ldap/status")
def ldap_status(database: Connection = Depends(connection)) -> dict:
    # Leafs delegate LDAP sign-in to Canopy; reflect Canopy's setting from the last directory sync.
    state = database.execute("SELECT ldap_enabled FROM auth_directory_state WHERE id=1").fetchone()
    return {"enabled": bool(state and state["ldap_enabled"]), "delegated": True}


@router.put("/self/admin-pin")
def leaf_admin_pin(_: dict = Depends(current_user)) -> dict:
    raise HTTPException(status_code=409, detail="manage the admin PIN from Canopy")


# --- directory synchronization (called by the Leaf sync worker) ---------------

@router.get("/directory/pending")
def directory_pending(_: dict = Depends(service_only), database: Connection = Depends(connection)) -> dict:
    rows = database.execute("SELECT * FROM auth_user WHERE directory_pending=1 ORDER BY id").fetchall()
    return {"users": [directory.record(database, row) for row in rows]}


@router.put("/directory")
def directory_apply(
    payload: dict[str, Any],
    _: dict = Depends(service_only),
    database: Connection = Depends(connection),
) -> dict:
    leaf_unit = payload.get("leaf_unit") or {}
    units = [unit for unit in payload.get("units") or [] if isinstance(unit, dict)]
    users = [user for user in payload.get("users") or [] if isinstance(user, dict)]
    current = now_ms()
    database.execute(
        """INSERT INTO auth_directory_state(id,leaf_unit_key,leaf_unit_name,units,ldap_enabled,synced_at)
           VALUES (1,%s,%s,%s,%s,%s) ON CONFLICT(id) DO UPDATE SET leaf_unit_key=excluded.leaf_unit_key,
             leaf_unit_name=excluded.leaf_unit_name,units=excluded.units,ldap_enabled=excluded.ldap_enabled,
             synced_at=excluded.synced_at""",
        (leaf_unit.get("key"), leaf_unit.get("name"), Jsonb(units), 1 if payload.get("ldap_enabled") else 0, current),
    )
    # Canopy accepted these pushes; clear the pending flag unless edited again since.
    for ack in payload.get("acknowledged") or []:
        database.execute(
            """UPDATE auth_user SET directory_pending=0,directory_managed=1
               WHERE lower(username)=lower(%s) AND directory_version<=%s""",
            (str(ack.get("username") or ""), int(ack.get("directory_version") or 0)),
        )
    applied, stale, failed = 0, 0, []
    for user in users:
        try:
            result = directory.apply_record(database, user, from_canopy=True)
        except Exception as error:  # one bad record must not block the rest
            failed.append({"username": user.get("username"), "error": type(error).__name__})
            continue
        applied += result == "applied"
        stale += result == "stale"
    # Managed accounts no longer assigned to this ward stop working here.
    present = [str(user.get("username") or "").lower() for user in users]
    removed = database.execute(
        """UPDATE auth_user SET is_active=0,updated_at=%s
           WHERE directory_managed=1 AND directory_pending=0 AND is_active=1
             AND NOT (lower(username)=ANY(%s)) RETURNING id,username""",
        (current, present),
    ).fetchall()
    for row in removed:
        database.execute("UPDATE auth_session SET revoked_at=%s WHERE user_id=%s AND revoked_at IS NULL", (current, row["id"]))
    return {"ok": True, "applied": applied, "stale": stale, "failed": failed,
            "removed": [row["username"] for row in removed]}
