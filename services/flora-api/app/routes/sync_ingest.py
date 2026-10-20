import hashlib
import time
import hmac
import os
import uuid
from datetime import datetime, timezone
from typing import Any, Literal

from fastapi import APIRouter, Depends, Header, HTTPException, Query, Request
from pydantic import BaseModel, Field
from psycopg import Connection
from psycopg.types.json import Jsonb

from .. import ai_service, billing, case_forms, central_auth, tenancy, device_registry, device_types, directory, form_sync, io_catalog, ldap_auth, workflows
from ..database import connection, pool


router = APIRouter(prefix="/api/sync/v1", tags=["leaf-canopy-sync"])
# This Canopy's sync protocol and features (answered to every batch; the Leaf's are kept in sync_leaf_node.metadata).
PROTOCOL_VERSION = 2
CAPABILITIES = ["case_snapshot", "case_forms", "case_form_files"]
# The oldest Leaf sync protocol this Canopy takes (FLORA_SYNC_MIN_PROTOCOL; 1, the default, takes every worker, also
# those from before the handshake). Raising it turns away a Leaf whose worker is too old with 426 and the reason (kept
# in sync_leaf_node.metadata.protocol_refused for the fleet view) instead of reading data in a shape Canopy has dropped.
MIN_PROTOCOL_VERSION = max(1, int(os.getenv("FLORA_SYNC_MIN_PROTOCOL", "1") or 1))


def require_protocol(database: Connection, leaf_id: str, version: int | None) -> None:
    """Refuse a Leaf whose sync protocol is older than MIN_PROTOCOL_VERSION (426 Upgrade Required)."""
    version = int(version or 1)
    if version >= MIN_PROTOCOL_VERSION:
        return
    refused = {"code": "protocol_unsupported", "protocol_version": version, "minimum": MIN_PROTOCOL_VERSION,
               "canopy_protocol": PROTOCOL_VERSION,
               "message": f"Canopy needs Leaf sync protocol {MIN_PROTOCOL_VERSION} or newer; this Leaf uses {version}. Update Flora Leaf."}
    database.execute("UPDATE sync_leaf_node SET metadata = metadata || %s WHERE leaf_id = %s",
                     (Jsonb({"protocol_refused": {**refused, "at": int(time.time() * 1000)}}), leaf_id))
    raise HTTPException(status_code=426, detail=refused)


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
    # Sync protocol of the Leaf's worker (1 when absent: workers before the handshake) and what it supports.
    protocol_version: int = Field(default=1, ge=1, le=1000)
    capabilities: list[str] = Field(default_factory=list, max_length=50)
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
    """Leafs and Haber prove their account with its sync secret (unique per account); the account
    middleware has already resolved it, so an unknown secret leaves the request without an account."""
    if tenancy.MULTI_ACCOUNT:
        if tenancy.current_account() is None:
            raise HTTPException(status_code=401, detail="invalid synchronization credentials")
        return
    expected = os.getenv("FLORA_SYNC_SHARED_SECRET", "").strip()
    supplied = ""
    if authorization and authorization.lower().startswith("bearer "):
        supplied = authorization[7:].strip()
    if not expected or not hmac.compare_digest(supplied, expected):
        raise HTTPException(status_code=401, detail="invalid synchronization credentials")


def _global_case_id(hospital_id: str, leaf_id: str, source_case_id: str) -> uuid.UUID:
    return uuid.uuid5(uuid.NAMESPACE_URL, f"flora:{hospital_id}:{leaf_id}:case:{source_case_id}")


# sync_message keeps every message a Leaf sent so a message sent again is not applied twice; the payloads are read only
# when they arrive. Payloads older than this many days are emptied (the rows stay: duplicates are still recognised),
# at most once an hour and a batch at a time, so the table does not grow by every snapshot for ever. 0 keeps them.
MESSAGE_KEEP_DAYS = int(os.getenv("FLORA_SYNC_MESSAGE_KEEP_DAYS", "30"))
_compacted = {"at": 0.0}


def compact_messages(database: Connection, batch_size: int = 5000) -> int:
    """Empty the payloads of messages older than MESSAGE_KEEP_DAYS (one batch); the number emptied."""
    if MESSAGE_KEEP_DAYS <= 0:
        return 0
    result = database.execute(
        """UPDATE sync_message SET payload = '{}'::jsonb
           WHERE id IN (SELECT id FROM sync_message WHERE received_at < now() - make_interval(days => %s) AND payload <> '{}'::jsonb
                        ORDER BY id LIMIT %s)""", (MESSAGE_KEEP_DAYS, batch_size))
    return result.rowcount or 0


@router.post("/batch", dependencies=[Depends(require_sync_secret)])
def ingest_batch(batch: SyncBatch, database: Connection = Depends(connection)) -> dict[str, Any]:
    require_protocol(database, batch.leaf_id, batch.protocol_version)
    now = datetime.now(timezone.utc)
    if time.time() - _compacted["at"] > 3600:
        _compacted["at"] = time.time()
        compact_messages(database)
    accepted = 0
    duplicates = 0
    workflow_forms: list[dict[str, Any]] = []
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
                Jsonb({"observed_location": batch.observed_location or {}, "protocol_version": batch.protocol_version,
                       "capabilities": [str(item)[:40] for item in batch.capabilities], "protocol_refused": None}),
            ),
        )
        database.execute(
            """UPDATE canopy_leaf_assignment
               SET applied_version=GREATEST(applied_version,%s),updated_at=(extract(epoch from clock_timestamp())*1000)::bigint
               WHERE leaf_id=%s""",
            (batch.applied_config_version, batch.leaf_id),
        )
        for message in batch.messages:
            if message.entity_type == "case_export":
                # Full copy for handover: only the newest matters, so it is not kept in sync_message.
                export_id = _global_case_id(batch.hospital_id, batch.leaf_id, message.entity_id)
                stored = database.execute(
                    """INSERT INTO canopy_case_export (global_case_id, leaf_id, source_case_id, revision, export, updated_at)
                       VALUES (%s, %s, %s, %s, %s, %s)
                       ON CONFLICT (global_case_id) DO UPDATE SET revision=excluded.revision, export=excluded.export,
                         updated_at=excluded.updated_at
                       WHERE excluded.revision > canopy_case_export.revision
                       RETURNING 1""",
                    (export_id, batch.leaf_id, message.entity_id, message.revision, Jsonb(message.payload),
                     int(now.timestamp() * 1000)),
                ).fetchone()
                accepted += 1 if stored else 0
                duplicates += 0 if stored else 1
                continue
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
            if database.execute(
                """SELECT 1 FROM canopy_case_handover WHERE global_case_id=%s AND from_leaf_id=%s
                   AND status IN ('claimed','imported','released')""", (global_case_id, batch.leaf_id)).fetchone():
                # Another Leaf continues this case; late snapshots from the old Leaf must not overwrite it.
                continue
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
            if "billing" in message.payload:
                # Structured copy of the case's billing order for billing staff.
                with database.transaction():
                    billing.project_snapshot(database, global_case_id, batch.leaf_id, message.entity_id,
                                             message.payload, message.revision, int(time.time() * 1000))
            # Leafs with the case form exchange (app/case_forms.py) send their forms there, field by field with receipts.
            if message.payload.get("workflow_forms") and not message.payload.get("case_forms_channel"):
                workflow_forms.append({"global_case_id": str(global_case_id), "hn": case.get("hn"),
                                       "workflow_forms": message.payload["workflow_forms"]})
        assignment = database.execute(
            """SELECT desired_config,desired_version,applied_version
               FROM canopy_leaf_assignment WHERE leaf_id=%s""",
            (batch.leaf_id,),
        ).fetchone()
    if workflow_forms:
        # Workflow Studio: bedside workflow forms also become Form Studio records (best effort).
        try:
            with pool.connection() as formdev_connection:
                workflows.ingest_workflow_forms(formdev_connection, workflow_forms, batch.leaf_id)
        except Exception as error:
            workflows.LOG.warning("workflow form ingest failed: %s: %s", type(error).__name__, error)
    return {
        "ok": True,
        "accepted": accepted,
        "duplicates": duplicates,
        "server_time": now,
        "protocol_version": PROTOCOL_VERSION,
        "capabilities": CAPABILITIES,
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
    # The shared AI service (including its key) travels with the directory to every Leaf.
    result["ai_service"] = ai_service.load(database)
    # Medication / fluid / output catalogue; the Leaf applies it only when newer.
    try:
        result["io_catalog"] = io_catalog.load(database)
    except Exception:  # never block the directory over the catalogue
        result["io_catalog"] = None
    # OR billing checklist master (groups + items); applied on the Leaf when newer.
    try:
        result["billing_catalog"] = billing.load_catalog(database)
    except Exception:
        result["billing_catalog"] = None
    # Only acknowledge pushes that Canopy now holds (applied, or superseded by a newer central edit).
    result["acknowledged"] = [item for item in acknowledged if item["status"] in {"applied", "stale"}]
    result["failed"] = [item for item in acknowledged if item["status"] == "failed"]
    return result


class StaffExchange(BaseModel):
    leaf_id: str = Field(min_length=1, max_length=120)
    digest: str | None = None
    changes: list[dict[str, Any]] = Field(default_factory=list, max_length=2000)


@router.post("/staff", dependencies=[Depends(require_sync_secret)])
def exchange_staff(payload: StaffExchange, database: Connection = Depends(connection)) -> dict[str, Any]:
    """Staff added on a Leaf (with their code), then that Leaf's ward staff directory and roles."""
    from .. import staff_sync
    result = staff_sync.exchange(database, payload.leaf_id, payload.changes, payload.digest)
    created = [item["staff_code"] for item in result["results"] if item["status"] == "created"]
    if created:
        _directory_audit(database, "staff.leaf-added", payload.leaf_id, None, {"codes": created[:50]})
    return result


@router.post("/directory/authenticate", dependencies=[Depends(require_sync_secret)])
def authenticate_for_leaf(payload: DirectoryAuthentication, database: Connection = Depends(connection)) -> dict[str, Any]:
    user = central_auth.authenticate(database, payload.username, payload.password)
    if not directory.in_leaf_scope(database, user["id"], payload.leaf_id):
        raise HTTPException(status_code=403, detail="user is not assigned to this ward")
    return {"user": directory.record(database, user)}


class GatewayConfig(BaseModel):
    version: str | None = None
    site: dict[str, Any] = Field(default_factory=dict)
    license: dict[str, Any] = Field(default_factory=dict)
    devices: list[dict[str, Any]] = Field(default_factory=list, max_length=500)
    applied_config_version: int = Field(default=0, ge=0)
    # How a Leaf on the gateway's LAN reaches its data-api; not part of the cloned config.
    data_api_url: str | None = Field(default=None, max_length=300)


DEVICE_FIELDS = ("leaf_id", "device_type", "pod", "label", "enabled", "options", "serial_number",
                 "asset_tag", "station", "location", "installed_at", "notes")


@router.post("/gateways/{gateway_id}/config", dependencies=[Depends(require_sync_secret)])
def store_gateway_config(gateway_id: str, payload: GatewayConfig, database: Connection = Depends(connection)) -> dict[str, Any]:
    """Haber forwards each gateway check-in; Canopy keeps the configuration and license grant."""
    import json

    devices = sorted((device for device in payload.devices if device.get("device_id")),
                     key=lambda device: str(device["device_id"]))
    # Only the configuration counts for change history, not runtime state.
    config = {
        "site": {key: value for key, value in payload.site.items()
                 if key not in {"id", "updated_at", "updated_by", "canopy_config_version"}},
        "devices": [{"device_id": device["device_id"], **{field: device.get(field) for field in DEVICE_FIELDS}}
                    for device in devices],
    }
    config_hash = hashlib.sha256(json.dumps(config, sort_keys=True, default=str).encode()).hexdigest()
    current = directory.now_ms()
    with database.transaction():
        previous = database.execute(
            "SELECT config_hash,first_seen_at FROM canopy_gateway WHERE gateway_id=%s FOR UPDATE", (gateway_id,)
        ).fetchone()
        changed = previous is None or previous["config_hash"] != config_hash
        database.execute(
            """INSERT INTO canopy_gateway(gateway_id,version,site,license,config_hash,first_seen_at,last_seen_at,config_changed_at,
                                         data_api_url)
               VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s)
               ON CONFLICT(gateway_id) DO UPDATE SET version=excluded.version,site=excluded.site,
                 data_api_url=coalesce(excluded.data_api_url,canopy_gateway.data_api_url),
                 license=excluded.license,config_hash=excluded.config_hash,last_seen_at=excluded.last_seen_at,
                 first_seen_at=CASE WHEN canopy_gateway.first_seen_at=0 THEN excluded.first_seen_at
                                    ELSE canopy_gateway.first_seen_at END,
                 applied_version=GREATEST(canopy_gateway.applied_version,%s),
                 config_changed_at=CASE WHEN canopy_gateway.config_hash IS DISTINCT FROM excluded.config_hash
                                        THEN excluded.config_changed_at ELSE canopy_gateway.config_changed_at END""",
            (gateway_id, payload.version, Jsonb(payload.site), Jsonb(payload.license), config_hash,
             current, current, current, payload.data_api_url, payload.applied_config_version),
        )
        database.execute("DELETE FROM canopy_gateway_device WHERE gateway_id=%s", (gateway_id,))
        for device in devices:
            database.execute(
                """INSERT INTO canopy_gateway_device(gateway_id,device_id,leaf_id,device_type,pod,label,enabled,options,
                         serial_number,asset_tag,station,location,installed_at,notes,parser_status,updated_at)
                   VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)""",
                (gateway_id, str(device["device_id"]), device.get("leaf_id"), str(device.get("device_type") or "unknown"),
                 device.get("pod"), device.get("label"), bool(device.get("enabled", True)),
                 Jsonb(device.get("options") if isinstance(device.get("options"), dict) else {}),
                 device.get("serial_number"), device.get("asset_tag"), device.get("station"), device.get("location"),
                 device.get("installed_at"), device.get("notes"), device.get("parser_status"), device.get("updated_at")),
            )
        # Device Management: keep every reported device linked to (or added to) the registry.
        device_registry.reconcile_reported(database, gateway_id, devices, current)
        if changed:
            database.execute(
                """INSERT INTO canopy_gateway_config_snapshot(gateway_id,config_hash,config,captured_at)
                   VALUES (%s,%s,%s,%s)""",
                (gateway_id, config_hash, Jsonb(config), current),
            )
        desired = database.execute(
            "SELECT desired_config,desired_version,applied_version FROM canopy_gateway WHERE gateway_id=%s",
            (gateway_id,),
        ).fetchone()
    pending = desired and desired["desired_config"] and desired["desired_version"] > desired["applied_version"]
    return {
        "ok": True, "changed": changed, "config_hash": config_hash,
        "desired_config": {**desired["desired_config"], "version": desired["desired_version"]} if pending else None,
        # The hospital's own device types; Haber adds them to the gateway's catalog.
        "device_types": device_types.for_gateways(database),
    }


# --- Canopy admissions: Leafs pick them up and sync their forms ----------------

class AdmissionClaim(BaseModel):
    leaf_id: str = Field(min_length=1, max_length=120)


class AdmissionExchange(BaseModel):
    leaf_id: str = Field(min_length=1, max_length=120)
    hospital_id: str | None = None
    cases: list[dict[str, Any]] = Field(default_factory=list, max_length=500)
    claims: list[dict[str, Any]] = Field(default_factory=list, max_length=500)


def _admission_for_leaf(row: dict[str, Any], database: Connection | None = None) -> dict[str, Any]:
    from .. import or_sessions
    session = or_sessions.leaf_header(database, row) if database is not None else None
    return {
        "id": str(row["id"]),
        "header": {
            "hn": row["hn"], "admission_number": row["admission_number"], "patient": row["patient"] or {},
            "admission": row["admission"] or {}, "unit_key": row["unit_key"], "unit_name": row.get("unit_name"),
            "target_leaf_id": row["target_leaf_id"], "scheduled_at": row["scheduled_at"], "note": row["note"],
            "created_by": row["created_by"],
            **({"or_session": session} if session else {}),
        },
        "form_values": row["form_values"] or {},
        "form_versions": row["form_versions"] or {},
    }


def _requests(row: dict[str, Any]) -> dict[str, Any]:
    from .. import or_sessions
    found = or_sessions.leaf_requests(row)
    return {"requests": found} if found else {}


def _claim(database: Connection, admission_id: str, leaf_id: str, case: dict[str, Any] | None = None) -> str:
    """claimed | already | previous | taken | missing"""
    row = database.execute(
        "SELECT * FROM canopy_admission WHERE id::text=%s FOR UPDATE", (admission_id,)
    ).fetchone()
    if row is None:
        return "missing"
    if row["claimed_leaf_id"] and row["claimed_leaf_id"] != leaf_id:
        from .. import or_sessions
        if or_sessions.is_previous_leaf(database, str(row["id"]), leaf_id):
            return "previous"  # the OR room's Leaf, after the case moved on to recovery
        if case is not None and row["status"] != "conflict":
            # Started offline at two Leafs: keep the first, flag for review.
            database.execute("UPDATE canopy_admission SET status='conflict',updated_at=%s WHERE id=%s",
                             (directory.now_ms(), row["id"]))
        return "taken"
    if row["status"] == "cancelled" and not row["claimed_leaf_id"]:
        return "taken"
    current = directory.now_ms()
    database.execute(
        """UPDATE canopy_admission SET status=CASE WHEN status='conflict' THEN status ELSE 'started' END,
             claimed_leaf_id=%s, claimed_at=coalesce(claimed_at,%s), updated_at=%s WHERE id=%s""",
        (leaf_id, current, current, row["id"]),
    )
    from .. import or_sessions
    or_sessions.on_leaf_claim(database, str(row["id"]), leaf_id, case)
    return "already" if row["claimed_leaf_id"] == leaf_id else "claimed"


@router.post("/admissions/{admission_id}/claim", dependencies=[Depends(require_sync_secret)])
def claim_admission(admission_id: str, payload: AdmissionClaim, database: Connection = Depends(connection)) -> dict[str, Any]:
    with database.transaction():
        result = _claim(database, admission_id, payload.leaf_id)
    if result in {"taken", "missing"}:
        raise HTTPException(status_code=409, detail="admission already started elsewhere or cancelled")
    return {"ok": True, "result": result}


@router.post("/admissions", dependencies=[Depends(require_sync_secret)])
def exchange_admissions(payload: AdmissionExchange, database: Connection = Depends(connection)) -> dict[str, Any]:
    """Store form changes of Leaf cases started from Canopy admissions, then return
    the admissions this Leaf may start and Canopy-side form changes for its cases."""
    acknowledged, conflicts = [], []
    with database.transaction():
        for claim in payload.claims:
            result = _claim(database, str(claim.get("admission_id")), payload.leaf_id, case=claim)
            if result == "previous":
                acknowledged.append(str(claim.get("admission_id")))
                continue
            (conflicts if result in {"taken", "missing"} else acknowledged).append(str(claim.get("admission_id")))
        for case in payload.cases:
            admission_id = str(case.get("admission_id") or "")
            result = _claim(database, admission_id, payload.leaf_id, case=case)
            if result == "previous":
                acknowledged.append(admission_id)
                continue
            if result in {"taken", "missing"}:
                conflicts.append(admission_id)
                continue
            acknowledged.append(admission_id)
            row = database.execute(
                "SELECT form_values,form_versions FROM canopy_admission WHERE id::text=%s FOR UPDATE", (admission_id,)
            ).fetchone()
            values, versions, changed = form_sync.merge(
                row["form_values"] or {}, row["form_versions"] or {}, case.get("values") or {}, case.get("versions") or {})
            hospital = payload.hospital_id or database.execute(
                "SELECT hospital_id FROM sync_leaf_node WHERE leaf_id=%s", (payload.leaf_id,)).fetchone()["hospital_id"]
            database.execute(
                """UPDATE canopy_admission SET form_values=%s,form_versions=%s,
                     form_updated_at=CASE WHEN %s THEN %s ELSE form_updated_at END,
                     leaf_case_id=%s,global_case_id=%s,case_status=%s,updated_at=%s WHERE id::text=%s""",
                (Jsonb(values), Jsonb(versions), changed, directory.now_ms(), case.get("case_id"),
                 _global_case_id(hospital, payload.leaf_id, str(case.get("case_id"))), case.get("status"),
                 directory.now_ms(), admission_id),
            )
            from .. import or_sessions
            or_sessions.on_leaf_case(database, admission_id, payload.leaf_id, case)
        unit = directory.leaf_unit(database, payload.leaf_id)
        pending = database.execute(
            """SELECT a.*, unit.name AS unit_name FROM canopy_admission a
               LEFT JOIN canopy_location unit ON unit.id::text=a.unit_key
               WHERE ((a.status='pending' AND a.claimed_leaf_id IS NULL)
                      OR to_jsonb(a) ->> 'journey_state' = 'assigned_recovery')
                 AND (a.target_leaf_id=%s OR (a.target_leaf_id IS NULL AND a.unit_key=%s
                      -- An OR-schedule booking reaches a Leaf only once the ward desk assigns its bed.
                      AND to_jsonb(a) ->> 'room_location_id' IS NULL)
                      -- Recovery: the moved-out case waits for this recovery bed's Leaf.
                      OR (to_jsonb(a) ->> 'journey_state' = 'assigned_recovery' AND a.target_leaf_id=%s))
               ORDER BY a.scheduled_at NULLS LAST, a.created_at""",
            (payload.leaf_id, (unit or {}).get("key"), payload.leaf_id),
        ).fetchall()
        linked = database.execute(
            """SELECT * FROM canopy_admission
               WHERE claimed_leaf_id=%s AND status IN ('started','conflict')
                 AND coalesce(case_status,'active') <> 'archived'""",
            (payload.leaf_id,),
        ).fetchall()
    return {
        "pending": [_admission_for_leaf(row, database) for row in pending],
        "linked": [{"admission_id": str(row["id"]), "values": row["form_values"] or {},
                    "versions": row["form_versions"] or {}, **_requests(row)} for row in linked],
        "acknowledged": acknowledged,
        "conflicts": conflicts,
    }


# --- Workflow (Form Studio) forms of Leaf cases, field by field both ways (app/case_forms.py) ---

class CaseFormExchange(BaseModel):
    leaf_id: str = Field(min_length=1, max_length=120)
    hospital_id: str | None = Field(default=None, max_length=120)
    protocol_version: int = Field(default=1, ge=1, le=1000)
    forms: list[dict[str, Any]] = Field(default_factory=list, max_length=500)
    cases: list[dict[str, Any]] = Field(default_factory=list, max_length=500)
    acks: list[dict[str, Any]] = Field(default_factory=list, max_length=2000)


def _hospital(database: Connection, leaf_id: str, given: str | None) -> str:
    if given:
        return given
    row = database.execute("SELECT hospital_id FROM sync_leaf_node WHERE leaf_id=%s", (leaf_id,)).fetchone()
    if row is None:
        raise HTTPException(status_code=409, detail="unknown Leaf: send a case batch first")
    return row["hospital_id"]


@router.post("/case-forms", dependencies=[Depends(require_sync_secret)])
def exchange_case_forms(payload: CaseFormExchange, database: Connection = Depends(connection)) -> dict[str, Any]:
    """The Leaf's changed case forms in, a receipt for each and Canopy's changes for the Leaf's cases out."""
    require_protocol(database, payload.leaf_id, payload.protocol_version)
    hospital = _hospital(database, payload.leaf_id, payload.hospital_id)
    return case_forms.exchange(database, payload.leaf_id, hospital, payload.model_dump(), directory.now_ms())


@router.put("/case-forms/files/{sha256}", dependencies=[Depends(require_sync_secret)])
async def put_case_form_file(sha256: str, request: Request, leaf_id: str = Query(min_length=1, max_length=120),
                             database: Connection = Depends(connection)) -> dict[str, Any]:
    """A file of a Leaf form (file / image field) that Canopy asked for (`need_files`); checked against its SHA-256."""
    from ..formdev.errors import FormDevError

    wanted = database.execute(
        """SELECT 1 FROM canopy_case_form WHERE leaf_id=%s AND record_state='waiting_files' AND strpos(data::text, %s) > 0 LIMIT 1""",
        (leaf_id, f"att:{sha256}")).fetchone()
    if wanted is None:
        raise HTTPException(status_code=404, detail="no form of this Leaf is waiting for this file")
    content = await request.body()
    media_type = (request.headers.get("content-type") or "application/octet-stream").split(";")[0].strip().lower()
    try:
        meta = case_forms.formdev_services(database).records.attachments.put(sha256, media_type, content, f"leaf:{leaf_id}"[:120])
    except FormDevError as error:
        raise HTTPException(status_code=error.status, detail=error.message) from None
    return {"ok": True, "sha256": sha256, "created": meta.get("created", False)}


class CaseDocument(BaseModel):
    """The details of a document attached to a case on a Leaf (0094); the file itself goes to PUT …/content."""
    leaf_id: str = Field(min_length=1, max_length=120)
    hospital_id: str | None = Field(default=None, max_length=120)
    protocol_version: int = Field(default=1, ge=1, le=1000)
    case_id: int
    global_case_id: str | None = None
    hn: str | None = None
    document_id: int
    title: str = Field(min_length=1, max_length=200)
    pages: int = Field(ge=1)
    bytes: int = Field(ge=1)
    sha256: str = Field(pattern=r"^[0-9a-f]{64}$")
    created_at: int
    created_by: str | None = None
    removed_at: int | None = None
    removed_by: str | None = None
    removed_reason: str | None = None


CASE_DOCUMENT_MAX_BYTES = 30 * 1024 * 1024


@router.put("/case-documents", dependencies=[Depends(require_sync_secret)])
def receive_case_document(payload: CaseDocument, database: Connection = Depends(connection)) -> dict[str, Any]:
    """A document's details, or its removal; kept by the case's global id. needs_content says whether Canopy still
    needs the file (PUT /case-documents/{leaf_id}/{document_id}/content): never again once it has it."""
    require_protocol(database, payload.leaf_id, payload.protocol_version)
    hospital = _hospital(database, payload.leaf_id, payload.hospital_id)
    global_id = payload.global_case_id or case_forms.global_case_id(hospital, payload.leaf_id, payload.case_id)
    row = database.execute(
        """INSERT INTO canopy_case_document (leaf_id, document_id, global_case_id, source_case_id, hn, title, pages, bytes, sha256,
             created_at, created_by, removed_at, removed_by, removed_reason, received_at)
           VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
           ON CONFLICT (leaf_id, document_id) DO UPDATE SET removed_at=excluded.removed_at, removed_by=excluded.removed_by,
             removed_reason=excluded.removed_reason, received_at=excluded.received_at
           RETURNING content IS NULL AS needs_content""",
        (payload.leaf_id, payload.document_id, global_id, str(payload.case_id), payload.hn, payload.title, payload.pages, payload.bytes,
         payload.sha256, payload.created_at, payload.created_by, payload.removed_at, payload.removed_by, payload.removed_reason,
         directory.now_ms())).fetchone()
    return {"ok": True, "global_case_id": global_id, "needs_content": row["needs_content"]}


async def case_document_body(request: Request) -> bytes:
    from ..request_body import read_limited

    return await read_limited(request, CASE_DOCUMENT_MAX_BYTES)


@router.put("/case-documents/{leaf_id}/{document_id}/content", dependencies=[Depends(require_sync_secret)])
def receive_case_document_content(leaf_id: str, document_id: int, content: bytes = Depends(case_document_body),
                                  database: Connection = Depends(connection)) -> dict[str, Any]:
    """The file of a document whose details arrived first, as it is; it must match the sha256 sent with them."""
    row = database.execute("SELECT sha256 FROM canopy_case_document WHERE leaf_id=%s AND document_id=%s", (leaf_id, document_id)).fetchone()
    if row is None:
        raise HTTPException(status_code=404, detail="send the document's details first (PUT /case-documents)")
    if hashlib.sha256(content).hexdigest() != row["sha256"]:
        raise HTTPException(status_code=422, detail="the document does not match its sha256")
    database.execute("UPDATE canopy_case_document SET content=%s, bytes=%s, received_at=%s WHERE leaf_id=%s AND document_id=%s",
                     (content, len(content), directory.now_ms(), leaf_id, document_id))
    return {"ok": True}

