import re
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Request
from psycopg import Connection
from psycopg.types.json import Jsonb

from .. import directory
from ..database import connection
from .auth_canopy import read_token
from .auth_leaf import (
    LanguageCreateRequest,
    LanguageMasterRequest,
    PasswordChangeRequest,
    PersonalThemeCreateRequest,
    PersonalThemeRequest,
    PreferenceRequest,
    ThemeCreateRequest,
    ThemeMasterRequest,
    TranslationMasterRequest,
    atomic,
    attach_entitlements,
    audit,
    managed_user,
    new_password_record,
    now_ms,
    personal_theme_public,
    personal_theme_values,
    public_user,
    valid_theme_selection,
)
from .auth_canopy import verify_password


router = APIRouter(prefix="/api/auth", tags=["canopy preferences"])


def current_canopy_user(request: Request, database: Connection = Depends(connection)) -> dict[str, Any]:
    payload = read_token(request)
    row = database.execute(
        """SELECT id,username,name,role,theme_mode,theme_color,language_code,
                  staff_directory_id,parameter_preferences,report_preferences,
                  must_change_password,is_active,auth_source,all_units,admin_pin_hash
           FROM auth_user WHERE id=%s LIMIT 1""",
        (payload["sub"],),
    ).fetchone()
    if row is None or not row["is_active"]:
        raise HTTPException(status_code=401, detail="sign in required")
    return attach_entitlements(database, row)


def require_canopy_permission(permission_code: str):
    def permitted(user: dict[str, Any] = Depends(current_canopy_user)) -> dict[str, Any]:
        if user.get("must_change_password"):
            raise HTTPException(status_code=403, detail="password change required")
        if permission_code not in user.get("_permissions", []):
            raise HTTPException(status_code=403, detail=f"{permission_code} permission required")
        return user
    return permitted


@router.get("/preferences/options")
def preference_options(database: Connection = Depends(connection)) -> dict:
    languages = database.execute(
        "SELECT code,name_en,name_native FROM language_master WHERE is_active=1 ORDER BY sort_order,code"
    ).fetchall()
    themes = database.execute(
        """SELECT code,display_name,color_1_canvas,color_2_surface,color_3_border,
                  color_4_text,color_5_muted,color_6_accent
           FROM theme_scheme_master WHERE is_active=1 ORDER BY sort_order,code"""
    ).fetchall()
    return {
        "defaultLanguage": languages[0]["code"] if languages else "en",
        "defaultTheme": themes[0]["code"] if themes else "monochromatic",
        "languages": [dict(row) for row in languages],
        "themes": [dict(row) for row in themes],
    }


@router.get("/preferences/translations/{code}")
def language_translations(code: str, database: Connection = Depends(connection)) -> dict:
    normalized = code.strip().lower()
    rows = database.execute(
        "SELECT translation_key,translation_value FROM language_translation WHERE language_code=%s ORDER BY translation_key",
        (normalized,),
    ).fetchall()
    return {"code": normalized, "values": {row["translation_key"]: row["translation_value"] for row in rows}}


@router.get("/preferences/master")
def preference_master(
    _: dict = Depends(require_canopy_permission("config.manage")),
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


@router.get("/self")
def self_account(user: dict = Depends(current_canopy_user)) -> dict:
    return {"row": managed_user(user)}


@router.get("/self/themes")
def personal_themes(user: dict = Depends(current_canopy_user), database: Connection = Depends(connection)) -> dict:
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
    user: dict = Depends(current_canopy_user),
    database: Connection = Depends(connection),
) -> dict:
    code, display_name, colors = personal_theme_values(payload.code, payload.display_name, payload.colors)
    current = now_ms()
    try:
        row = database.execute(
            """INSERT INTO user_theme_scheme(owner_user_id,code,display_name,color_1_canvas,color_2_surface,
                     color_3_border,color_4_text,color_5_muted,color_6_accent,is_active,sync_state,created_at,updated_at)
               VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,1,'central',%s,%s) RETURNING *""",
            (user["id"], code, display_name, *colors, current, current),
        ).fetchone()
    except Exception as error:
        raise HTTPException(status_code=409, detail="personal theme code already exists") from error
    audit(database, "canopy.personal-theme.create", user, detail={"code": code})
    return {"row": personal_theme_public(row)}


@router.put("/self/themes/{code}")
@atomic
def update_personal_theme(
    code: str,
    payload: PersonalThemeRequest,
    user: dict = Depends(current_canopy_user),
    database: Connection = Depends(connection),
) -> dict:
    normalized, display_name, colors = personal_theme_values(code, payload.display_name, payload.colors)
    row = database.execute(
        """UPDATE user_theme_scheme SET display_name=%s,color_1_canvas=%s,color_2_surface=%s,
                  color_3_border=%s,color_4_text=%s,color_5_muted=%s,color_6_accent=%s,
                  sync_state='central',updated_at=%s
           WHERE owner_user_id=%s AND code=%s RETURNING *""",
        (display_name, *colors, now_ms(), user["id"], normalized),
    ).fetchone()
    if row is None:
        raise HTTPException(status_code=404, detail="personal theme not found")
    audit(database, "canopy.personal-theme.update", user, detail={"code": normalized})
    return {"row": personal_theme_public(row)}


@router.delete("/self/themes/{code}")
@atomic
def delete_personal_theme(
    code: str,
    user: dict = Depends(current_canopy_user),
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
    audit(database, "canopy.personal-theme.delete", user, detail={"code": normalized})
    return {"ok": True, "code": f"personal:{normalized}"}


@router.put("/preferences/languages/{code}")
@atomic
def update_language_master(
    code: str,
    payload: LanguageMasterRequest,
    actor: dict = Depends(require_canopy_permission("config.manage")),
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
    audit(database, "canopy.preference.language.update", actor, detail={"code": normalized})
    return {"row": dict(row)}


@router.post("/preferences/languages")
@atomic
def create_language_master(
    payload: LanguageCreateRequest,
    actor: dict = Depends(require_canopy_permission("config.manage")),
    database: Connection = Depends(connection),
) -> dict:
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
    audit(database, "canopy.preference.language.create", actor, detail={"code": code})
    return {"row": dict(row)}


@router.delete("/preferences/languages/{code}")
@atomic
def delete_language_master(
    code: str,
    actor: dict = Depends(require_canopy_permission("config.manage")),
    database: Connection = Depends(connection),
) -> dict:
    normalized = code.strip().lower()
    replacement = database.execute(
        "SELECT code FROM language_master WHERE code<>%s ORDER BY is_active DESC,sort_order,code LIMIT 1",
        (normalized,),
    ).fetchone()
    if replacement is None:
        raise HTTPException(status_code=400, detail="at least one language profile is required")
    database.execute("UPDATE auth_user SET language_code=%s WHERE language_code=%s", (replacement["code"], normalized))
    deleted = database.execute("DELETE FROM language_master WHERE code=%s RETURNING code", (normalized,)).fetchone()
    if deleted is None:
        raise HTTPException(status_code=404, detail="language not found")
    audit(database, "canopy.preference.language.delete", actor, detail={"code": normalized, "replacement": replacement["code"]})
    return {"ok": True, "code": normalized}


@router.put("/preferences/translations/{code}")
@atomic
def update_language_translations(
    code: str,
    payload: TranslationMasterRequest,
    actor: dict = Depends(require_canopy_permission("config.manage")),
    database: Connection = Depends(connection),
) -> dict:
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
            database.execute(
                "DELETE FROM language_translation WHERE language_code=%s AND translation_key=%s",
                (normalized, clean_key),
            )
    audit(database, "canopy.preference.translation.update", actor, detail={"code": normalized, "count": len(payload.values)})
    return language_translations(normalized, database)


def validated_theme(code: str, display_name: str, colors: list[str]) -> tuple[str, str, list[str]]:
    normalized = code.strip().lower()
    clean_name = display_name.strip()
    clean_colors = [color.strip().lower() for color in colors]
    if re.fullmatch(r"[a-z0-9][a-z0-9-]{1,47}", normalized) is None:
        raise HTTPException(status_code=400, detail="invalid scheme code")
    if not clean_name or len(clean_colors) != 6 or any(re.fullmatch(r"#[0-9a-f]{6}", color) is None for color in clean_colors):
        raise HTTPException(status_code=400, detail="scheme name and six hex colors are required")
    return normalized, clean_name, clean_colors


@router.put("/preferences/themes/{code}")
@atomic
def update_theme_master(
    code: str,
    payload: ThemeMasterRequest,
    actor: dict = Depends(require_canopy_permission("config.manage")),
    database: Connection = Depends(connection),
) -> dict:
    normalized, display_name, colors = validated_theme(code, payload.display_name, payload.colors)
    if not payload.is_active:
        active_count = database.execute("SELECT count(*) AS n FROM theme_scheme_master WHERE is_active=1").fetchone()["n"]
        current = database.execute("SELECT is_active FROM theme_scheme_master WHERE code=%s", (normalized,)).fetchone()
        if current and current["is_active"] and active_count <= 1:
            raise HTTPException(status_code=400, detail="at least one scheme must remain active")
    row = database.execute(
        """UPDATE theme_scheme_master SET display_name=%s,color_1_canvas=%s,color_2_surface=%s,
                  color_3_border=%s,color_4_text=%s,color_5_muted=%s,color_6_accent=%s,
                  is_active=%s,sort_order=%s,updated_at=%s WHERE code=%s RETURNING *""",
        (display_name, *colors, 1 if payload.is_active else 0, payload.sort_order, now_ms(), normalized),
    ).fetchone()
    if row is None:
        raise HTTPException(status_code=404, detail="theme scheme not found")
    audit(database, "canopy.preference.theme.update", actor, detail={"code": normalized})
    return {"row": dict(row)}


@router.post("/preferences/themes")
@atomic
def create_theme_master(
    payload: ThemeCreateRequest,
    actor: dict = Depends(require_canopy_permission("config.manage")),
    database: Connection = Depends(connection),
) -> dict:
    code, display_name, colors = validated_theme(payload.code, payload.display_name, payload.colors)
    try:
        row = database.execute(
            """INSERT INTO theme_scheme_master(code,display_name,color_1_canvas,color_2_surface,color_3_border,
                     color_4_text,color_5_muted,color_6_accent,is_active,sort_order,created_at,updated_at)
               VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s) RETURNING *""",
            (code, display_name, *colors, 1 if payload.is_active else 0, payload.sort_order, now_ms(), now_ms()),
        ).fetchone()
    except Exception as error:
        raise HTTPException(status_code=409, detail="scheme code already exists") from error
    audit(database, "canopy.preference.theme.create", actor, detail={"code": code})
    return {"row": dict(row)}


@router.delete("/preferences/themes/{code}")
@atomic
def delete_theme_master(
    code: str,
    actor: dict = Depends(require_canopy_permission("config.manage")),
    database: Connection = Depends(connection),
) -> dict:
    normalized = code.strip().lower()
    replacement = database.execute(
        "SELECT code FROM theme_scheme_master WHERE code<>%s ORDER BY is_active DESC,sort_order,code LIMIT 1",
        (normalized,),
    ).fetchone()
    if replacement is None:
        raise HTTPException(status_code=400, detail="at least one scheme profile is required")
    database.execute("UPDATE auth_user SET theme_color=%s WHERE theme_color=%s", (replacement["code"], normalized))
    deleted = database.execute("DELETE FROM theme_scheme_master WHERE code=%s RETURNING code", (normalized,)).fetchone()
    if deleted is None:
        raise HTTPException(status_code=404, detail="scheme not found")
    audit(database, "canopy.preference.theme.delete", actor, detail={"code": normalized, "replacement": replacement["code"]})
    return {"ok": True, "code": normalized}


@router.put("/self/preferences")
@atomic
def update_self_preferences(
    payload: PreferenceRequest,
    user: dict = Depends(current_canopy_user),
    database: Connection = Depends(connection),
) -> dict:
    if all(value is None for value in (
        payload.name, payload.theme_mode, payload.theme_color, payload.language_code,
        payload.parameter_preferences, payload.report_preferences,
    )):
        raise HTTPException(status_code=400, detail="at least one preference is required")
    if payload.theme_mode is not None and payload.theme_mode != "dark":
        raise HTTPException(status_code=400, detail="invalid theme mode")
    if payload.theme_color is not None and not valid_theme_selection(database, user["id"], payload.theme_color):
        raise HTTPException(status_code=400, detail="invalid theme scheme")
    if payload.language_code is not None and database.execute(
        "SELECT 1 FROM language_master WHERE code=%s AND is_active=1", (payload.language_code,)
    ).fetchone() is None:
        raise HTTPException(status_code=400, detail="invalid language")
    clean_name = payload.name.strip() if payload.name is not None else None
    row = database.execute(
        """UPDATE auth_user SET name=coalesce(%s,name),theme_mode=coalesce(%s,theme_mode),
                  theme_color=coalesce(%s,theme_color),language_code=coalesce(%s,language_code),
                  parameter_preferences=coalesce(%s,parameter_preferences),
                  report_preferences=coalesce(%s,report_preferences),updated_at=%s
           WHERE id=%s RETURNING id,username,name,role,theme_mode,theme_color,language_code,
                 staff_directory_id,parameter_preferences,report_preferences,must_change_password,is_active""",
        (clean_name, payload.theme_mode, payload.theme_color, payload.language_code,
         Jsonb(payload.parameter_preferences) if payload.parameter_preferences is not None else None,
         Jsonb(payload.report_preferences) if payload.report_preferences is not None else None,
         now_ms(), user["id"]),
    ).fetchone()
    audit(database, "canopy.self.set-preferences", user, target=row)
    return {"user": public_user(attach_entitlements(database, row))}


@router.post("/self/change-password")
@atomic
def change_password(
    payload: PasswordChangeRequest,
    user: dict = Depends(current_canopy_user),
    database: Connection = Depends(connection),
) -> dict:
    if user.get("auth_source") == "ldap":
        raise HTTPException(status_code=400, detail="LDAP passwords are managed in the directory server")
    credential = database.execute(
        "SELECT password_salt,password_hash FROM auth_user WHERE id=%s", (user["id"],)
    ).fetchone()
    if credential is None or not verify_password(
        payload.current_password, credential["password_salt"], credential["password_hash"]
    ):
        raise HTTPException(status_code=400, detail="current password is incorrect")
    new_password = payload.new_password.strip()
    if len(new_password) < 8:
        raise HTTPException(status_code=400, detail="new password must be at least 8 characters")
    salt, hashed = new_password_record(new_password)
    row = database.execute(
        """UPDATE auth_user SET password_salt=%s,password_hash=%s,must_change_password=0,updated_at=%s
           WHERE id=%s RETURNING *""",
        (salt, hashed, now_ms(), user["id"]),
    ).fetchone()
    directory.touch(database, user["id"])
    audit(database, "canopy.self.change-password", user, target=row)
    return {"row": managed_user(attach_entitlements(database, row))}
