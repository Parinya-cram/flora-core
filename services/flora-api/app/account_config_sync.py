import concurrent.futures
import json
import os
import urllib.error
import urllib.parse
import urllib.request
from typing import Any

from psycopg import Connection
from psycopg.types.json import Jsonb


CANOPY_SYNC_URL = os.getenv("FLORA_CANOPY_SYNC_URL", "").strip().rstrip("/")
SYNC_SECRET = os.getenv("FLORA_SYNC_SHARED_SECRET", "").strip()
SYNC_TIMEOUT_SECONDS = max(0.2, float(os.getenv("FLORA_ACCOUNT_CONFIG_SYNC_TIMEOUT_SECONDS", "1.5")))
SYNC_EXECUTOR = concurrent.futures.ThreadPoolExecutor(max_workers=4, thread_name_prefix="account-config-sync")


def _fetch_account_config(username: str) -> dict[str, Any] | None:
    encoded_username = urllib.parse.quote(username.strip(), safe="")
    request = urllib.request.Request(
        f"{CANOPY_SYNC_URL}/api/sync/v1/account-config/{encoded_username}",
        headers={"Authorization": f"Bearer {SYNC_SECRET}", "Accept": "application/json"},
        method="GET",
    )
    try:
        with urllib.request.urlopen(request, timeout=SYNC_TIMEOUT_SECONDS) as response:
            payload = json.load(response)
            return payload if isinstance(payload, dict) else None
    except (OSError, ValueError, urllib.error.HTTPError, urllib.error.URLError):
        return None


def pull_account_config(username: str) -> dict[str, Any] | None:
    """Fetch central preferences while strictly bounding the Leaf login delay."""
    if not CANOPY_SYNC_URL or not SYNC_SECRET:
        return None
    future = SYNC_EXECUTOR.submit(_fetch_account_config, username)
    try:
        return future.result(timeout=SYNC_TIMEOUT_SECONDS)
    except concurrent.futures.TimeoutError:
        future.cancel()
        return None


def _push_personal_theme(username: str, theme: dict[str, Any]) -> bool:
    encoded_username = urllib.parse.quote(username.strip(), safe="")
    encoded_code = urllib.parse.quote(str(theme["code"]).strip().lower(), safe="")
    body = json.dumps({
        "display_name": theme["display_name"],
        "colors": [theme[f"color_{index}_{name}"] for index, name in enumerate(
            ("canvas", "surface", "border", "text", "muted", "accent"), start=1
        )],
    }).encode("utf-8")
    request = urllib.request.Request(
        f"{CANOPY_SYNC_URL}/api/sync/v1/account-config/{encoded_username}/themes/{encoded_code}",
        data=body,
        headers={
            "Authorization": f"Bearer {SYNC_SECRET}",
            "Accept": "application/json",
            "Content-Type": "application/json",
        },
        method="PUT",
    )
    try:
        with urllib.request.urlopen(request, timeout=SYNC_TIMEOUT_SECONDS) as response:
            return response.status == 200
    except (OSError, ValueError, urllib.error.HTTPError, urllib.error.URLError):
        return False


LEAF_ID = os.getenv("FLORA_LEAF_ID", "").strip()
DIRECTORY_AUTH_TIMEOUT_SECONDS = max(0.5, float(os.getenv("FLORA_DIRECTORY_AUTH_TIMEOUT_SECONDS", "4")))


def _authenticate(username: str, password: str) -> tuple[str, dict[str, Any] | None]:
    request = urllib.request.Request(
        f"{CANOPY_SYNC_URL}/api/sync/v1/directory/authenticate",
        data=json.dumps({"leaf_id": LEAF_ID, "username": username, "password": password}).encode("utf-8"),
        headers={"Authorization": f"Bearer {SYNC_SECRET}", "Accept": "application/json",
                 "Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=DIRECTORY_AUTH_TIMEOUT_SECONDS) as response:
            payload = json.load(response)
            user = payload.get("user") if isinstance(payload, dict) else None
            return ("ok", user) if isinstance(user, dict) else ("unavailable", None)
    except urllib.error.HTTPError as error:
        return ("denied", None) if error.code in {401, 403, 404} else ("unavailable", None)
    except (OSError, ValueError, urllib.error.URLError):
        return ("unavailable", None)


def authenticate_with_canopy(username: str, password: str) -> tuple[str, dict[str, Any] | None]:
    """Verify credentials centrally: ("ok", directory record) | ("denied", None) | ("unavailable", None)."""
    if not CANOPY_SYNC_URL or not SYNC_SECRET or not LEAF_ID:
        return ("unavailable", None)
    future = SYNC_EXECUTOR.submit(_authenticate, username, password)
    try:
        return future.result(timeout=DIRECTORY_AUTH_TIMEOUT_SECONDS + 0.5)
    except concurrent.futures.TimeoutError:
        future.cancel()
        return ("unavailable", None)


def push_personal_theme(username: str, theme: dict[str, Any]) -> bool:
    """Explicitly publish one private theme to the owner's central account."""
    if not CANOPY_SYNC_URL or not SYNC_SECRET:
        return False
    future = SYNC_EXECUTOR.submit(_push_personal_theme, username, theme)
    try:
        return future.result(timeout=SYNC_TIMEOUT_SECONDS)
    except concurrent.futures.TimeoutError:
        future.cancel()
        return False


def apply_account_config(database: Connection, user_id: int, config: dict[str, Any]) -> bool:
    """Cache Canopy appearance data locally. This is deliberately pull-only."""
    preferences = config.get("preferences")
    if not isinstance(preferences, dict):
        return False

    public_themes = config.get("public_themes")
    if isinstance(public_themes, list):
        central_codes: list[str] = []
        for public_theme in public_themes:
            if not isinstance(public_theme, dict) or not str(public_theme.get("code") or "").strip():
                continue
            code = str(public_theme["code"]).strip().lower()
            central_codes.append(code)
            database.execute(
                """INSERT INTO theme_scheme_master(
                     code,display_name,color_1_canvas,color_2_surface,color_3_border,
                     color_4_text,color_5_muted,color_6_accent,is_active,sort_order,created_at,updated_at,managed_by_canopy)
                   VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,1)
                   ON CONFLICT(code) DO UPDATE SET display_name=excluded.display_name,
                     color_1_canvas=excluded.color_1_canvas,color_2_surface=excluded.color_2_surface,
                     color_3_border=excluded.color_3_border,color_4_text=excluded.color_4_text,
                     color_5_muted=excluded.color_5_muted,color_6_accent=excluded.color_6_accent,
                     is_active=excluded.is_active,sort_order=excluded.sort_order,
                     updated_at=excluded.updated_at,managed_by_canopy=1""",
                (
                    code,
                    str(public_theme.get("display_name") or code),
                    str(public_theme.get("color_1_canvas") or "#121212"),
                    str(public_theme.get("color_2_surface") or "#1c1c1c"),
                    str(public_theme.get("color_3_border") or "#444444"),
                    str(public_theme.get("color_4_text") or "#e0e0e0"),
                    str(public_theme.get("color_5_muted") or "#b0b0b0"),
                    str(public_theme.get("color_6_accent") or "#a1a1aa"),
                    1 if public_theme.get("is_active", True) else 0,
                    int(public_theme.get("sort_order") or 0),
                    int(public_theme.get("created_at") or 0),
                    int(public_theme.get("updated_at") or 0),
                ),
            )
        if central_codes:
            database.execute(
                "UPDATE theme_scheme_master SET is_active=0 WHERE managed_by_canopy=1 AND NOT (code=ANY(%s))",
                (central_codes,),
            )

    language = config.get("language")
    if isinstance(language, dict) and str(language.get("code") or "").strip():
        database.execute(
            """INSERT INTO language_master(code,name_en,name_native,is_active,sort_order,created_at,updated_at)
               VALUES (%s,%s,%s,%s,%s,%s,%s)
               ON CONFLICT(code) DO UPDATE SET name_en=excluded.name_en,name_native=excluded.name_native,
                 is_active=excluded.is_active,sort_order=excluded.sort_order,updated_at=excluded.updated_at""",
            (
                str(language["code"]).strip().lower(),
                str(language.get("name_en") or language["code"]),
                str(language.get("name_native") or language.get("name_en") or language["code"]),
                1 if language.get("is_active", True) else 0,
                int(language.get("sort_order") or 0),
                int(language.get("created_at") or 0),
                int(language.get("updated_at") or 0),
            ),
        )
        translations = config.get("translations")
        if isinstance(translations, dict):
            for key, value in translations.items():
                clean_key, clean_value = str(key).strip(), str(value).strip()
                if clean_key and clean_value and len(clean_key) <= 160 and len(clean_value) <= 4000:
                    database.execute(
                        """INSERT INTO language_translation(language_code,translation_key,translation_value,updated_at)
                           VALUES (%s,%s,%s,%s) ON CONFLICT(language_code,translation_key)
                           DO UPDATE SET translation_value=excluded.translation_value,updated_at=excluded.updated_at""",
                        (str(language["code"]).strip().lower(), clean_key, clean_value, int(language.get("updated_at") or 0)),
                    )

    personal_themes = config.get("personal_themes")
    if isinstance(personal_themes, list):
        for personal in personal_themes:
            if not isinstance(personal, dict) or not str(personal.get("code") or "").strip():
                continue
            database.execute(
                """INSERT INTO user_theme_scheme(owner_user_id,code,display_name,color_1_canvas,color_2_surface,
                         color_3_border,color_4_text,color_5_muted,color_6_accent,is_active,sync_state,created_at,updated_at)
                   VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,'central',%s,%s)
                   ON CONFLICT(owner_user_id,code) DO UPDATE SET display_name=excluded.display_name,
                     color_1_canvas=excluded.color_1_canvas,color_2_surface=excluded.color_2_surface,
                     color_3_border=excluded.color_3_border,color_4_text=excluded.color_4_text,
                     color_5_muted=excluded.color_5_muted,color_6_accent=excluded.color_6_accent,
                     is_active=excluded.is_active,sync_state='central',updated_at=excluded.updated_at""",
                (
                    user_id, str(personal["code"]).strip().lower(),
                    str(personal.get("display_name") or personal["code"]),
                    str(personal.get("color_1_canvas") or "#121212"),
                    str(personal.get("color_2_surface") or "#1c1c1c"),
                    str(personal.get("color_3_border") or "#444444"),
                    str(personal.get("color_4_text") or "#e0e0e0"),
                    str(personal.get("color_5_muted") or "#b0b0b0"),
                    str(personal.get("color_6_accent") or "#a1a1aa"),
                    1 if personal.get("is_active", True) else 0,
                    int(personal.get("created_at") or 0), int(personal.get("updated_at") or 0),
                ),
            )

    theme = config.get("theme")
    if isinstance(theme, dict) and theme.get("scope") != "personal" and str(theme.get("code") or "").strip():
        database.execute(
            """INSERT INTO theme_scheme_master(
                 code,display_name,color_1_canvas,color_2_surface,color_3_border,
                 color_4_text,color_5_muted,color_6_accent,is_active,sort_order,created_at,updated_at)
               VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
               ON CONFLICT(code) DO UPDATE SET display_name=excluded.display_name,
                 color_1_canvas=excluded.color_1_canvas,color_2_surface=excluded.color_2_surface,
                 color_3_border=excluded.color_3_border,color_4_text=excluded.color_4_text,
                 color_5_muted=excluded.color_5_muted,color_6_accent=excluded.color_6_accent,
                 is_active=excluded.is_active,sort_order=excluded.sort_order,updated_at=excluded.updated_at""",
            (
                str(theme["code"]).strip().lower(),
                str(theme.get("display_name") or theme["code"]),
                str(theme.get("color_1_canvas") or "#121212"),
                str(theme.get("color_2_surface") or "#1c1c1c"),
                str(theme.get("color_3_border") or "#444444"),
                str(theme.get("color_4_text") or "#e0e0e0"),
                str(theme.get("color_5_muted") or "#b0b0b0"),
                str(theme.get("color_6_accent") or "#a1a1aa"),
                1 if theme.get("is_active", True) else 0,
                int(theme.get("sort_order") or 0),
                int(theme.get("created_at") or 0),
                int(theme.get("updated_at") or 0),
            ),
        )

    theme_mode = str(preferences.get("theme_mode") or "").strip().lower()
    theme_color = str(preferences.get("theme_color") or "").strip().lower()
    language_code = str(preferences.get("language_code") or "").strip().lower()
    parameter_preferences = preferences.get("parameter_preferences")
    report_preferences = preferences.get("report_preferences")
    database.execute(
        """UPDATE auth_user SET
             theme_mode=CASE WHEN %s<>'' THEN %s ELSE theme_mode END,
             theme_color=CASE WHEN %s<>'' THEN %s ELSE theme_color END,
             language_code=CASE WHEN %s<>'' THEN %s ELSE language_code END,
             parameter_preferences=CASE WHEN %s THEN %s ELSE parameter_preferences END,
             report_preferences=CASE WHEN %s THEN %s ELSE report_preferences END,
             updated_at=GREATEST(updated_at,%s)
           WHERE id=%s""",
        (
            theme_mode, theme_mode,
            theme_color, theme_color,
            language_code, language_code,
            isinstance(parameter_preferences, dict), Jsonb(parameter_preferences) if isinstance(parameter_preferences, dict) else None,
            isinstance(report_preferences, dict), Jsonb(report_preferences) if isinstance(report_preferences, dict) else None,
            int(config.get("updated_at") or 0), user_id,
        ),
    )
    return True


def _claim_admission(admission_id: str) -> str:
    request = urllib.request.Request(
        f"{CANOPY_SYNC_URL}/api/sync/v1/admissions/{urllib.parse.quote(admission_id, safe='')}/claim",
        data=json.dumps({"leaf_id": LEAF_ID}).encode("utf-8"),
        headers={"Authorization": f"Bearer {SYNC_SECRET}", "Accept": "application/json",
                 "Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=SYNC_TIMEOUT_SECONDS * 2) as response:
            return "ok" if response.status == 200 else "unavailable"
    except urllib.error.HTTPError as error:
        return "taken" if error.code in {404, 409} else "unavailable"
    except (OSError, ValueError, urllib.error.URLError):
        return "unavailable"


def claim_canopy_admission(admission_id: str) -> str:
    """Reserve a Canopy admission for this Leaf: "ok" | "taken" | "unavailable" (start offline)."""
    if not CANOPY_SYNC_URL or not SYNC_SECRET or not LEAF_ID:
        return "unavailable"
    future = SYNC_EXECUTOR.submit(_claim_admission, admission_id)
    try:
        return future.result(timeout=SYNC_TIMEOUT_SECONDS * 2 + 0.5)
    except concurrent.futures.TimeoutError:
        future.cancel()
        return "unavailable"
