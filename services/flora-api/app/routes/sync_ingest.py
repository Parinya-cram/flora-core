import hashlib
import hmac
import os
import uuid
from datetime import datetime, timezone
from typing import Any, Literal

from fastapi import APIRouter, Depends, Header, HTTPException
from pydantic import BaseModel, Field
from psycopg import Connection
from psycopg.types.json import Jsonb

from .. import central_auth, directory, ldap_auth
from ..database import connection


router = APIRouter(prefix="/api/sync/v1", tags=["leaf-canopy-sync"])


class SyncMessage(BaseModel):
    message_id: uuid.UUID
    entity_type: str = Field(min_length=1, max_length=80)
    entity_id: str = Field(min_length=1, max_length=160)
    operation: Literal["upsert", "delete"] = "upsert"
    revision: int = Field(ge=0)
    occurred_at: datetime
    payload: dict[str, Any] = Field(default_factory=dict)


class SyncBatch(BaseModel):
    leaf_id: str = Field(min_length=1, max_length=120)
    hospital_id: str = Field(min_length=1, max_length=120)
    display_name: str = Field(min_length=1, max_length=160)
    software_version: str | None = Field(default=None, max_length=80)
    observed_location: dict[str, Any] | None = None
    applied_config_version: int = Field(default=0, ge=0)
    messages: list[SyncMessage] = Field(default_factory=list, max_length=500)


class DirectoryExchange(BaseModel):
    leaf_id: str = Field(min_length=1, max_length=120)
    changes: list[dict[str, Any]] = Field(default_factory=list, max_length=1000)


class DirectoryAuthentication(BaseModel):
    leaf_id: str = Field(min_length=1, max_length=120)
    username: str = Field(min_length=1, max_length=160)
    password: str = Field(min_length=1, max_length=512)


class PersonalThemeSync(BaseModel):
    display_name: str
    colors: list[str]


def require_sync_secret(authorization: str | None = Header(default=None)) -> None:
    expected = os.getenv("FLORA_SYNC_SHARED_SECRET", "").strip()
    supplied = ""
    if authorization and authorization.lower().startswith("bearer "):
        supplied = authorization[7:].strip()
    if not expected or not hmac.compare_digest(supplied, expected):
        raise HTTPException(status_code=401, detail="invalid synchronization credentials")


def _global_case_id(hospital_id: str, leaf_id: str, source_case_id: str) -> uuid.UUID:
    return uuid.uuid5(uuid.NAMESPACE_URL, f"flora:{hospital_id}:{leaf_id}:case:{source_case_id}")


@router.post("/batch", dependencies=[Depends(require_sync_secret)])
def ingest_batch(batch: SyncBatch, database: Connection = Depends(connection)) -> dict[str, Any]:
    now = datetime.now(timezone.utc)
    accepted = 0
    duplicates = 0
    with database.transaction():
        database.execute(
            """
            INSERT INTO sync_leaf_node
              (leaf_id, hospital_id, display_name, software_version, last_seen_at, metadata)
            VALUES (%s, %s, %s, %s, %s, %s)
            ON CONFLICT (leaf_id) DO UPDATE SET
              hospital_id = EXCLUDED.hospital_id,
              display_name = EXCLUDED.display_name,
              software_version = EXCLUDED.software_version,
              last_seen_at = EXCLUDED.last_seen_at,
              metadata = sync_leaf_node.metadata || EXCLUDED.metadata
            """,
            (
                batch.leaf_id,
                batch.hospital_id,
                batch.display_name,
                batch.software_version,
                now,
                Jsonb({"observed_location": batch.observed_location or {}}),
            ),
        )
        database.execute(
            """UPDATE canopy_leaf_assignment
               SET applied_version=GREATEST(applied_version,%s),updated_at=(extract(epoch from clock_timestamp())*1000)::bigint
               WHERE leaf_id=%s""",
            (batch.applied_config_version, batch.leaf_id),
        )
        for message in batch.messages:
            inserted = database.execute(
                """
                INSERT INTO sync_message
                  (leaf_id, message_id, entity_type, entity_id, operation, revision, occurred_at, payload)
                VALUES (%s, %s, %s, %s, %s, %s, %s, %s)
                ON CONFLICT (leaf_id, message_id) DO NOTHING
                RETURNING id
                """,
                (
                    batch.leaf_id,
                    message.message_id,
                    message.entity_type,
                    message.entity_id,
                    message.operation,
                    message.revision,
                    message.occurred_at,
                    Jsonb(message.payload),
                ),
            ).fetchone()
            if not inserted:
                duplicates += 1
                continue
            accepted += 1
            if message.entity_type != "case_snapshot":
                continue
            case = message.payload.get("case") or {}
            global_case_id = _global_case_id(batch.hospital_id, batch.leaf_id, message.entity_id)
            database.execute(
                """
                INSERT INTO sync_case_index
                  (global_case_id, hospital_id, leaf_id, source_case_id, case_code, hn, status,
                   start_time, discharge_time, revision, snapshot, last_synced_at)
                VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
                ON CONFLICT (leaf_id, source_case_id) DO UPDATE SET
                  case_code = EXCLUDED.case_code,
                  hn = EXCLUDED.hn,
                  status = EXCLUDED.status,
                  start_time = EXCLUDED.start_time,
                  discharge_time = EXCLUDED.discharge_time,
                  revision = EXCLUDED.revision,
                  snapshot = EXCLUDED.snapshot,
                  last_synced_at = EXCLUDED.last_synced_at
                WHERE EXCLUDED.revision >= sync_case_index.revision
                """,
                (
                    global_case_id,
                    batch.hospital_id,
                    batch.leaf_id,
                    message.entity_id,
                    case.get("case_code"),
                    case.get("hn"),
                    str(case.get("status") or "UNKNOWN").upper(),
                    case.get("start_time"),
                    case.get("discharge_time"),
                    message.revision,
                    Jsonb(message.payload),
                    now,
                ),
            )
        assignment = database.execute(
            """SELECT desired_config,desired_version,applied_version
               FROM canopy_leaf_assignment WHERE leaf_id=%s""",
            (batch.leaf_id,),
        ).fetchone()
    return {
        "ok": True,
        "accepted": accepted,
        "duplicates": duplicates,
        "server_time": now,
        "configuration": assignment["desired_config"] if assignment else None,
        "desired_config_version": assignment["desired_version"] if assignment else 0,
        "applied_config_version": assignment["applied_version"] if assignment else 0,
    }


@router.get("/fingerprint")
def fingerprint() -> dict[str, str]:
    secret = os.getenv("FLORA_SYNC_SHARED_SECRET", "").encode("utf-8")
    return {"protocol": "flora-sync-v1", "key_fingerprint": hashlib.sha256(secret).hexdigest()[:12]}


@router.get("/account-config/{username}", dependencies=[Depends(require_sync_secret)])
def account_config(username: str, database: Connection = Depends(connection)) -> dict[str, Any]:
    user = database.execute(
        """SELECT id,username,theme_mode,theme_color,language_code,
                  parameter_preferences,report_preferences,updated_at
           FROM auth_user
           WHERE lower(username)=lower(%s) AND is_active=1
           LIMIT 1""",
        (username.strip(),),
    ).fetchone()
    if user is None:
        raise HTTPException(status_code=404, detail="account configuration not found")
    personal_themes = database.execute(
        """SELECT code,display_name,color_1_canvas,color_2_surface,color_3_border,
                  color_4_text,color_5_muted,color_6_accent,is_active,created_at,updated_at
           FROM user_theme_scheme WHERE owner_user_id=%s AND is_active=1
           ORDER BY updated_at DESC,code""",
        (user["id"],),
    ).fetchall()
    public_themes = database.execute(
        """SELECT code,display_name,color_1_canvas,color_2_surface,color_3_border,
                  color_4_text,color_5_muted,color_6_accent,is_active,sort_order,created_at,updated_at
           FROM theme_scheme_master ORDER BY sort_order,code"""
    ).fetchall()
    theme = None
    theme_color = str(user.get("theme_color") or "")
    if theme_color.startswith("personal:"):
        personal_code = theme_color.removeprefix("personal:")
        theme = next((dict(row) for row in personal_themes if row["code"] == personal_code), None)
        if theme:
            theme["scope"] = "personal"
    elif theme_color:
        theme = database.execute(
            """SELECT code,display_name,color_1_canvas,color_2_surface,color_3_border,
                      color_4_text,color_5_muted,color_6_accent,is_active,sort_order,created_at,updated_at
               FROM theme_scheme_master WHERE code=%s""",
            (user["theme_color"],),
        ).fetchone()
        if theme:
            theme = {**dict(theme), "scope": "public"}
    language = database.execute(
        """SELECT code,name_en,name_native,is_active,sort_order,created_at,updated_at
           FROM language_master WHERE code=%s""",
        (user["language_code"],),
    ).fetchone()
    translations = database.execute(
        """SELECT translation_key,translation_value FROM language_translation
           WHERE language_code=%s ORDER BY translation_key""",
        (user["language_code"],),
    ).fetchall()
    return {
        "username": user["username"],
        "updated_at": user.get("updated_at") or 0,
        "preferences": {
            "theme_mode": user.get("theme_mode"),
            "theme_color": user.get("theme_color"),
            "language_code": user.get("language_code"),
            "parameter_preferences": user.get("parameter_preferences") or {},
            "report_preferences": user.get("report_preferences") or {},
        },
        "theme": dict(theme) if theme else None,
        "public_themes": [{**dict(row), "scope": "public"} for row in public_themes],
        "personal_themes": [{**dict(row), "scope": "personal"} for row in personal_themes],
        "language": dict(language) if language else None,
        "translations": {row["translation_key"]: row["translation_value"] for row in translations},
    }


@router.put("/account-config/{username}/themes/{code}", dependencies=[Depends(require_sync_secret)])
def save_personal_theme(
    username: str,
    code: str,
    payload: PersonalThemeSync,
    database: Connection = Depends(connection),
) -> dict[str, Any]:
    import re

    normalized = code.strip().lower().removeprefix("personal:")
    colors = [color.strip().lower() for color in payload.colors]
    if re.fullmatch(r"[a-z0-9][a-z0-9-]{1,47}", normalized) is None:
        raise HTTPException(status_code=400, detail="invalid personal theme code")
    if not payload.display_name.strip() or len(colors) != 6 or any(re.fullmatch(r"#[0-9a-f]{6}", color) is None for color in colors):
        raise HTTPException(status_code=400, detail="theme name and six hex colors are required")
    user = database.execute(
        "SELECT id FROM auth_user WHERE lower(username)=lower(%s) AND is_active=1 LIMIT 1",
        (username.strip(),),
    ).fetchone()
    if user is None:
        raise HTTPException(status_code=404, detail="account not found")
    current = int(datetime.now(timezone.utc).timestamp() * 1000)
    row = database.execute(
        """INSERT INTO user_theme_scheme(owner_user_id,code,display_name,color_1_canvas,color_2_surface,
                 color_3_border,color_4_text,color_5_muted,color_6_accent,is_active,sync_state,created_at,updated_at)
           VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,1,'central',%s,%s)
           ON CONFLICT(owner_user_id,code) DO UPDATE SET display_name=excluded.display_name,
             color_1_canvas=excluded.color_1_canvas,color_2_surface=excluded.color_2_surface,
             color_3_border=excluded.color_3_border,color_4_text=excluded.color_4_text,
             color_5_muted=excluded.color_5_muted,color_6_accent=excluded.color_6_accent,
             is_active=1,sync_state='central',updated_at=excluded.updated_at
           RETURNING code,display_name,updated_at""",
        (user["id"], normalized, payload.display_name.strip(), *colors, current, current),
    ).fetchone()
    return {"ok": True, "row": dict(row)}


def _directory_audit(database: Connection, action: str, leaf_id: str, username: str | None, detail: dict[str, Any]) -> None:
    import json
    database.execute(
        """INSERT INTO auth_audit(action,actor_username,actor_role,target_username,status,detail_json,created_at)
           VALUES (%s,%s,'integration',%s,'ok',%s,%s)""",
        (action, f"leaf:{leaf_id}", username, json.dumps(detail, separators=(",", ":")), directory.now_ms()),
    )


@router.post("/directory", dependencies=[Depends(require_sync_secret)])
def exchange_directory(payload: DirectoryExchange, database: Connection = Depends(connection)) -> dict[str, Any]:
    """Accept user changes made on a Leaf, then return that Leaf's ward directory."""
    acknowledged = []
    for change in payload.changes:
        username = str(change.get("username") or "")
        try:
            result = directory.apply_record(database, change, from_canopy=False)
        except Exception as error:  # e.g. a duplicate hospital id; report and continue
            acknowledged.append({"username": username, "status": "failed", "error": type(error).__name__})
            continue
        if result == "applied":
            _directory_audit(database, "directory.leaf-change", payload.leaf_id, username,
                             {"directoryVersion": change.get("directory_version")})
        acknowledged.append({"username": username, "status": result,
                             "directory_version": int(change.get("directory_version") or 0)})
    result = directory.leaf_directory(database, payload.leaf_id)
    result["ldap_enabled"] = ldap_auth.enabled()
    # Only acknowledge pushes that Canopy now holds (applied, or superseded by a newer central edit).
    result["acknowledged"] = [item for item in acknowledged if item["status"] in {"applied", "stale"}]
    result["failed"] = [item for item in acknowledged if item["status"] == "failed"]
    return result


@router.post("/directory/authenticate", dependencies=[Depends(require_sync_secret)])
def authenticate_for_leaf(payload: DirectoryAuthentication, database: Connection = Depends(connection)) -> dict[str, Any]:
    user = central_auth.authenticate(database, payload.username, payload.password)
    if not directory.in_leaf_scope(database, user["id"], payload.leaf_id):
        raise HTTPException(status_code=403, detail="user is not assigned to this ward")
    return {"user": directory.record(database, user)}
