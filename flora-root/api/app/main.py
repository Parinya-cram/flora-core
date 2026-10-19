"""Flora Root: cloud control plane for every tenant (hospital).

Root issues each tenant a license bundle (modules, Leaf/Gateway limits, licensed
device types) plus global configuration, signed with Ed25519. Canopy's Haber
pulls the bundle, verifies it against Root's public key, and keeps working from
the cached bundle when the cloud is unreachable.

Root is also the only place images are built. A release pins every service of a
component (canopy, leaf, gateway) to an image digest in the Root registry; each
tenant receives the releases of its channel as a signed manifest. Haber mirrors
those digests into the hospital, the hospital approves the rollout, and every
node's flora-updater pulls from Haber.
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import json
import logging
import os
import secrets
import time
import urllib.request
import uuid
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from fastapi import Body, Depends, FastAPI, HTTPException, Request
from fastapi.responses import FileResponse
from psycopg.rows import dict_row
from psycopg.types.json import Jsonb
from psycopg_pool import ConnectionPool
from pydantic import BaseModel, Field

from . import auth

log = logging.getLogger("flora-root")
DATABASE_URL = os.getenv("FLORA_ROOT_DATABASE_URL", "postgresql://flora_root:flora-root-local-only@root-db:5432/flora_root")
# Where Haber pulls release images from (the Root registry as seen by hospitals).
REGISTRY_URL = os.getenv("ROOT_REGISTRY_URL", "http://host.docker.internal:7105").rstrip("/")
REGISTRY_INTERNAL = os.getenv("ROOT_REGISTRY_INTERNAL_URL", "http://root-registry:5000").rstrip("/")
RELEASES_PER_COMPONENT = int(os.getenv("ROOT_RELEASES_PER_COMPONENT", "5"))
DAY_MS = 86_400_000
pool = ConnectionPool(DATABASE_URL, min_size=1, max_size=5, open=False, kwargs={"row_factory": dict_row, "autocommit": True})


def now_ms() -> int:
    return int(time.time() * 1000)


def key_hash(value: str) -> str:
    return hashlib.sha256(value.encode()).hexdigest()


def canonical(value: Any) -> bytes:
    return json.dumps(value, sort_keys=True, separators=(",", ":")).encode()


# ------------------------------------------------------------------ bootstrap

DEMO_TENANT = {
    "tenant_id": os.getenv("ROOT_DEMO_TENANT_ID", "hospital-01"),
    "name": os.getenv("ROOT_DEMO_TENANT_NAME", "Demo Hospital"),
    "region": "TH",
    "api_key": os.getenv("ROOT_DEMO_TENANT_KEY", "root-tenant-demo-key"),
}
DEMO_DEVICE_TYPES = ["hl7-patient-monitor", "json-anesthesia-machine", "http-ventilator", "serial-temp-module",
                     "draeger-vista-120s", "draeger-iacs-m540"]
DEFAULT_GLOBAL_CONFIG = {
    "terminology_release": "2026.09",
    "minimum_versions": {"leaf": "1.2.0", "canopy": "1.2.0", "gateway": "0.1.0"},
    "feature_flags": {"archive_reports": True, "ai_assist": False},
    "sync_interval_sec": 10,
}


def bootstrap() -> None:
    with pool.connection() as connection:
        connection.execute((Path(__file__).parent / "schema.sql").read_text())
        if connection.execute("SELECT 1 FROM root_signing_key WHERE active").fetchone() is None:
            private = Ed25519PrivateKey.generate()
            pem = private.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8,
                                        serialization.NoEncryption()).decode()
            public = base64.b64encode(private.public_key().public_bytes(
                serialization.Encoding.Raw, serialization.PublicFormat.Raw)).decode()
            connection.execute("INSERT INTO root_signing_key (key_id, private_pem, public_raw, created_at) VALUES (%s,%s,%s,%s)",
                               (f"root-{uuid.uuid4().hex[:8]}", pem, public, now_ms()))
            log.info("generated Root signing key")
        for key, value in DEFAULT_GLOBAL_CONFIG.items():
            connection.execute("INSERT INTO root_global_config (key, value, updated_at) VALUES (%s,%s,%s) ON CONFLICT DO NOTHING",
                               (key, Jsonb(value), now_ms()))
        if os.getenv("ROOT_SEED_DEMO", "true").lower() == "true" and connection.execute(
                "SELECT 1 FROM root_tenant WHERE tenant_id=%s", (DEMO_TENANT["tenant_id"],)).fetchone() is None:
            current = now_ms()
            connection.execute(
                "INSERT INTO root_tenant (tenant_id, name, region, api_key_hash, created_at, updated_at) VALUES (%s,%s,%s,%s,%s,%s)",
                (DEMO_TENANT["tenant_id"], DEMO_TENANT["name"], DEMO_TENANT["region"], key_hash(DEMO_TENANT["api_key"]), current, current))
            issue_license(connection, DEMO_TENANT["tenant_id"], LicenseIn(device_types=DEMO_DEVICE_TYPES))
            log.info("seeded demo tenant %s", DEMO_TENANT["tenant_id"])
        # Keep the demo tenant's live license in sync with DEMO_DEVICE_TYPES: re-issue
        # (idempotent) only when its current license is missing a newly-added type, so a
        # deploy that adds a device type reaches the already-seeded tenant without a manual
        # license replace. Other license fields fall back to defaults (demo uses defaults).
        if os.getenv("ROOT_SEED_DEMO", "true").lower() == "true":
            lic = connection.execute(
                "SELECT device_types FROM root_license WHERE tenant_id=%s AND current",
                (DEMO_TENANT["tenant_id"],)).fetchone()
            if lic is not None and not set(DEMO_DEVICE_TYPES).issubset(set(lic["device_types"] or [])):
                issue_license(connection, DEMO_TENANT["tenant_id"], LicenseIn(device_types=DEMO_DEVICE_TYPES))
                log.info("re-issued demo license for %s with updated device types", DEMO_TENANT["tenant_id"])
    load_device_types()
    auth.ensure_bootstrap_admin()


# Table -> primary key for each list in reference/device_types.json.
DEVICE_SEED_TABLES = {
    "sources": ("device_type_source", "source_id"),
    "manufacturers": ("device_manufacturer", "manufacturer_code"),
    "protocols": ("device_protocol", "protocol"),
    "connection_types": ("device_connection_type", "connection_type"),
    "lanes": ("device_protocol_lane", "lane_no"),
    "device_types": ("device_type", "device_type_id"),
}


def load_device_types() -> None:
    """Upsert the device type catalog seed when its source files changed (sha256 per source)."""
    seed = json.loads((Path(__file__).parent / "reference" / "device_types.json").read_text())
    with pool.connection() as connection, connection.transaction():
        stored = {row["source_id"]: row["sha256"] for row in connection.execute("SELECT source_id, sha256 FROM device_type_source")}
        if all(stored.get(source["source_id"]) == source["sha256"] for source in seed["sources"]):
            return
        current = now_ms()
        for key, (table, primary) in DEVICE_SEED_TABLES.items():
            for row in seed[key]:
                row = {**row, **({"imported_at": current} if key == "sources" else {}),
                       **({"updated_at": current} if key == "device_types" else {})}
                columns = list(row)
                updates = ", ".join(f"{column}=excluded.{column}" for column in columns if column != primary)
                connection.execute(
                    f"INSERT INTO {table} ({', '.join(columns)}) VALUES ({', '.join(['%s'] * len(columns))}) "
                    f"ON CONFLICT ({primary}) DO UPDATE SET {updates}", [row[column] for column in columns])
    log.info("loaded device type catalog: %s", {key: len(seed[key]) for key in DEVICE_SEED_TABLES})


@asynccontextmanager
async def lifespan(_: FastAPI):
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    pool.open(wait=True, timeout=60)
    bootstrap()
    yield
    pool.close()


app = FastAPI(title="Flora Root", lifespan=lifespan)
auth.install(app, pool, [
    r"/health", r"/api/v1/keys", r"/api/v1/tenants/[^/]+/(bundle|heartbeat|releases)",  # Canopy, tenant key auth
    r"/api/auth/status",                                                                # login page status panel
])
app.include_router(auth.router)
require_admin = auth.require_admin  # signed-in admin operator, or Root CI with x-root-key / Basic


# ------------------------------------------------------------------ auth


def require_tenant(tenant_id: str, request: Request) -> dict[str, Any]:
    supplied = request.headers.get("authorization", "").removeprefix("Bearer ").strip()
    with pool.connection() as connection:
        tenant = connection.execute("SELECT * FROM root_tenant WHERE tenant_id=%s", (tenant_id,)).fetchone()
    if tenant is None or not supplied or not hmac.compare_digest(tenant["api_key_hash"], key_hash(supplied)):
        raise HTTPException(401, "invalid tenant credentials")
    return tenant


# ------------------------------------------------------------------ licenses + bundles

class LicenseIn(BaseModel):
    modules: list[str] = ["leaf", "canopy", "gateway"]
    max_leaves: int = Field(4, ge=0)
    max_gateways: int = Field(2, ge=0)
    max_gateway_devices: int = Field(8, ge=0)
    device_types: list[str] = []
    valid_days: int = Field(365, ge=0, le=3650)


def issue_license(connection, tenant_id: str, payload: LicenseIn) -> str:
    bundle_id = f"lic-{uuid.uuid4().hex[:12]}"
    current = now_ms()
    connection.execute("UPDATE root_license SET current=false WHERE tenant_id=%s AND current", (tenant_id,))
    connection.execute(
        """INSERT INTO root_license (bundle_id, tenant_id, modules, max_leaves, max_gateways, max_gateway_devices,
                                     device_types, issued_at, expires_at)
           VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s)""",
        (bundle_id, tenant_id, payload.modules, payload.max_leaves, payload.max_gateways, payload.max_gateway_devices,
         payload.device_types, current, current + payload.valid_days * DAY_MS))
    return bundle_id


def sign(payload: dict[str, Any]) -> dict[str, Any]:
    """Every Root document travels as {bundle, signature, key_id}; tiers verify it the same way."""
    with pool.connection() as connection:
        key = connection.execute("SELECT * FROM root_signing_key WHERE active ORDER BY created_at DESC LIMIT 1").fetchone()
    private = serialization.load_pem_private_key(key["private_pem"].encode(), password=None)
    signature = base64.b64encode(private.sign(canonical(payload))).decode()
    return {"bundle": payload, "signature": signature, "key_id": key["key_id"], "algorithm": "Ed25519"}


def signed_bundle(tenant_id: str) -> dict[str, Any]:
    with pool.connection() as connection:
        tenant = connection.execute("SELECT * FROM root_tenant WHERE tenant_id=%s", (tenant_id,)).fetchone()
        license_ = connection.execute("SELECT * FROM root_license WHERE tenant_id=%s AND current", (tenant_id,)).fetchone()
        config = {row["key"]: row["value"] for row in connection.execute("SELECT key, value FROM root_global_config ORDER BY key")}
    if license_ is None:
        raise HTTPException(404, "tenant has no license")
    bundle = {
        "bundle_id": license_["bundle_id"],
        "tenant": {"tenant_id": tenant["tenant_id"], "name": tenant["name"], "region": tenant["region"], "status": tenant["status"]},
        "entitlements": {
            "modules": license_["modules"],
            "max_leaves": license_["max_leaves"],
            "max_gateways": license_["max_gateways"],
            "max_gateway_devices": license_["max_gateway_devices"],
            "device_types": license_["device_types"],
        },
        "issued_at": license_["issued_at"],
        # Suspension and revocation are expressed as an already-expired bundle.
        "expires_at": 0 if license_["revoked_at"] or tenant["status"] != "active" else license_["expires_at"],
        "revoked": bool(license_["revoked_at"]),
        "global_config": config,
        "signed_at": now_ms(),
    }
    return sign(bundle)


@app.get("/api/v1/keys")
def public_keys():
    with pool.connection() as connection:
        rows = connection.execute("SELECT key_id, public_raw, active FROM root_signing_key ORDER BY created_at").fetchall()
    return {"keys": [{"key_id": row["key_id"], "algorithm": "Ed25519", "public_key": row["public_raw"], "active": row["active"]} for row in rows]}


@app.get("/api/v1/tenants/{tenant_id}/bundle")
def tenant_bundle(tenant_id: str, request: Request):
    require_tenant(tenant_id, request)
    return signed_bundle(tenant_id)


class Heartbeat(BaseModel):
    canopy_version: str | None = None
    bundle_id: str | None = None
    usage: dict[str, Any] = {}


@app.post("/api/v1/tenants/{tenant_id}/heartbeat")
def heartbeat(tenant_id: str, body: Heartbeat, request: Request):
    require_tenant(tenant_id, request)
    with pool.connection() as connection:
        connection.execute(
            """INSERT INTO root_checkin (tenant_id, last_seen_at, canopy_version, bundle_id, usage) VALUES (%s,%s,%s,%s,%s)
               ON CONFLICT (tenant_id) DO UPDATE SET last_seen_at=excluded.last_seen_at, canopy_version=excluded.canopy_version,
                 bundle_id=excluded.bundle_id, usage=excluded.usage""",
            (tenant_id, now_ms(), body.canopy_version, body.bundle_id, Jsonb(body.usage)))
        current = connection.execute("SELECT bundle_id FROM root_license WHERE tenant_id=%s AND current", (tenant_id,)).fetchone()
    return {"current_bundle_id": current["bundle_id"] if current else None, "server_ts": now_ms()}


# ------------------------------------------------------------------ releases

def release_doc(row: dict[str, Any]) -> dict[str, Any]:
    return {"release_id": row["release_id"], "component": row["component"], "version": row["version"],
            "channel": row["channel"], "services": row["services"], "device_types": row["device_types"],
            "notes": row["notes"], "created_at": row["created_at"]}


def signed_releases(tenant: dict[str, Any]) -> dict[str, Any]:
    with pool.connection() as connection:
        rows = connection.execute(
            """SELECT * FROM (
                 SELECT r.*, row_number() OVER (PARTITION BY component ORDER BY created_at DESC) AS rank
                 FROM root_release r WHERE channel=%s AND withdrawn_at IS NULL) ranked
               WHERE rank <= %s ORDER BY component, created_at DESC""",
            (tenant["release_channel"], RELEASES_PER_COMPONENT)).fetchall()
    releases = [release_doc(row) for row in rows]
    latest: dict[str, str] = {}
    for release in releases:
        latest.setdefault(release["component"], release["release_id"])
    return sign({
        "tenant_id": tenant["tenant_id"],
        "channel": tenant["release_channel"],
        "registry": REGISTRY_URL,
        "releases": releases,
        "latest": latest,
        "signed_at": now_ms(),
    })


@app.get("/api/v1/tenants/{tenant_id}/releases")
def tenant_releases(tenant_id: str, request: Request):
    tenant = require_tenant(tenant_id, request)
    if tenant["status"] != "active":
        raise HTTPException(403, "tenant suspended")
    return signed_releases(tenant)


class ServiceImage(BaseModel):
    repository: str = Field(pattern=r"^[a-z0-9]+([._/-][a-z0-9]+)*$")
    digest: str = Field(pattern=r"^sha256:[0-9a-f]{64}$")
    tag: str | None = None


class ReleaseIn(BaseModel):
    component: str = Field(pattern=r"^(canopy|leaf|gateway)$")
    version: str = Field(pattern=r"^[0-9A-Za-z.+-]{1,40}$")
    channel: str = Field("stable", pattern=r"^[a-z0-9-]{2,20}$")
    services: dict[str, ServiceImage] = Field(min_length=1)
    device_types: list[dict[str, Any]] = []
    notes: str | None = None


@app.post("/api/v1/releases", dependencies=[Depends(require_admin)], status_code=201)
def publish_release(body: ReleaseIn):
    """Called by Root CI after it pushed every image of the release to the Root registry."""
    for item in body.device_types:
        if item.get("image") not in body.services:
            raise HTTPException(422, f"device type {item.get('code')} uses unknown service {item.get('image')!r}")
    release_id = f"{body.component}-{body.version}"
    with pool.connection() as connection:
        if connection.execute("SELECT 1 FROM root_release WHERE release_id=%s", (release_id,)).fetchone():
            raise HTTPException(409, f"{release_id} exists; releases are immutable, bump the version")
        connection.execute(
            """INSERT INTO root_release (release_id, component, version, channel, services, device_types, notes, created_at)
               VALUES (%s,%s,%s,%s,%s,%s,%s,%s)""",
            (release_id, body.component, body.version, body.channel,
             Jsonb({key: value.model_dump(exclude_none=True) for key, value in body.services.items()}),
             Jsonb(body.device_types), body.notes, now_ms()))
    return {"release_id": release_id}


@app.post("/api/v1/releases/{release_id}/withdraw", dependencies=[Depends(require_admin)])
def withdraw_release(release_id: str):
    with pool.connection() as connection:
        row = connection.execute("UPDATE root_release SET withdrawn_at=%s WHERE release_id=%s AND withdrawn_at IS NULL "
                                 "RETURNING release_id", (now_ms(), release_id)).fetchone()
    if row is None:
        raise HTTPException(404, "no such active release")
    return {"withdrawn": release_id}


@app.get("/api/v1/releases", dependencies=[Depends(require_admin)])
def list_releases():
    with pool.connection() as connection:
        rows = connection.execute("SELECT * FROM root_release ORDER BY component, created_at DESC").fetchall()
    return {"registry": REGISTRY_URL, "rows": rows}


class ChannelIn(BaseModel):
    channel: str = Field(pattern=r"^[a-z0-9-]{2,20}$")


@app.put("/api/v1/tenants/{tenant_id}/channel", dependencies=[Depends(require_admin)])
def set_channel(tenant_id: str, body: ChannelIn):
    with pool.connection() as connection:
        row = connection.execute("UPDATE root_tenant SET release_channel=%s, updated_at=%s WHERE tenant_id=%s RETURNING tenant_id",
                                 (body.channel, now_ms(), tenant_id)).fetchone()
    if row is None:
        raise HTTPException(404, "tenant not found")
    return {"tenant_id": tenant_id, "channel": body.channel}


# ------------------------------------------------------------------ administration

class TenantIn(BaseModel):
    tenant_id: str = Field(pattern=r"^[a-z0-9-]{3,40}$")
    name: str
    region: str | None = None


@app.post("/api/v1/tenants", dependencies=[Depends(require_admin)], status_code=201)
def create_tenant(body: TenantIn):
    api_key = secrets.token_urlsafe(24)
    current = now_ms()
    with pool.connection() as connection:
        if connection.execute("SELECT 1 FROM root_tenant WHERE tenant_id=%s", (body.tenant_id,)).fetchone():
            raise HTTPException(409, "tenant exists")
        connection.execute(
            "INSERT INTO root_tenant (tenant_id, name, region, api_key_hash, created_at, updated_at) VALUES (%s,%s,%s,%s,%s,%s)",
            (body.tenant_id, body.name, body.region, key_hash(api_key), current, current))
        bundle_id = issue_license(connection, body.tenant_id, LicenseIn(device_types=DEMO_DEVICE_TYPES))
    # The key is shown once; Root stores only its hash.
    return {"tenant_id": body.tenant_id, "api_key": api_key, "bundle_id": bundle_id}


@app.put("/api/v1/tenants/{tenant_id}/license", dependencies=[Depends(require_admin)])
def replace_license(tenant_id: str, body: LicenseIn):
    with pool.connection() as connection, connection.transaction():
        if connection.execute("SELECT 1 FROM root_tenant WHERE tenant_id=%s", (tenant_id,)).fetchone() is None:
            raise HTTPException(404, "tenant not found")
        bundle_id = issue_license(connection, tenant_id, body)
    return {"bundle_id": bundle_id}


@app.post("/api/v1/tenants/{tenant_id}/license/revoke", dependencies=[Depends(require_admin)])
def revoke_license(tenant_id: str):
    with pool.connection() as connection:
        row = connection.execute("UPDATE root_license SET revoked_at=%s WHERE tenant_id=%s AND current RETURNING bundle_id",
                                 (now_ms(), tenant_id)).fetchone()
    if row is None:
        raise HTTPException(404, "no current license")
    return {"revoked": row["bundle_id"]}


@app.put("/api/v1/global-config/{key}", dependencies=[Depends(require_admin)])
def put_global_config(key: str, value: Any = Body(...)):
    with pool.connection() as connection:
        connection.execute("""INSERT INTO root_global_config (key, value, updated_at) VALUES (%s,%s,%s)
                              ON CONFLICT (key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at""",
                           (key, Jsonb(value), now_ms()))
    return {"key": key, "value": value}


@app.get("/api/v1/overview")
def overview():
    with pool.connection() as connection:
        tenants = connection.execute(
            """SELECT t.tenant_id, t.name, t.region, t.status, t.release_channel, l.bundle_id, l.modules, l.max_leaves, l.max_gateways,
                      l.max_gateway_devices, l.device_types, l.issued_at, l.expires_at, l.revoked_at,
                      c.last_seen_at, c.canopy_version, c.bundle_id AS canopy_bundle_id, c.usage
               FROM root_tenant t
               LEFT JOIN root_license l ON l.tenant_id=t.tenant_id AND l.current
               LEFT JOIN root_checkin c ON c.tenant_id=t.tenant_id
               ORDER BY t.tenant_id""").fetchall()
        config = connection.execute("SELECT key, value, updated_at FROM root_global_config ORDER BY key").fetchall()
        keys = connection.execute("SELECT key_id, public_raw, created_at FROM root_signing_key WHERE active").fetchall()
        releases = connection.execute(
            "SELECT release_id, component, version, channel, services, jsonb_array_length(device_types) AS device_types, "
            "notes, created_at, withdrawn_at FROM root_release ORDER BY created_at DESC LIMIT 30").fetchall()
        # Device-type codes an admin can license to a tenant = the catalog the current gateway
        # release ships (its parsers). Falls back to the demo set before any gateway release exists.
        gateway_release = connection.execute(
            "SELECT device_types FROM root_release WHERE component='gateway' AND withdrawn_at IS NULL "
            "ORDER BY created_at DESC LIMIT 1").fetchone()
    catalog = (gateway_release["device_types"] if gateway_release and gateway_release["device_types"]
               else [{"code": code} for code in DEMO_DEVICE_TYPES])
    gateway_device_types = [{"code": item["code"], "label": item.get("label", item["code"])}
                            for item in catalog if item.get("code")]
    return {"server_ts": now_ms(), "tenants": tenants, "global_config": config, "signing_keys": keys,
            "registry": REGISTRY_URL, "releases": releases, "gateway_device_types": gateway_device_types}


# ------------------------------------------------------------------ device type catalog

@app.get("/api/v1/device-types")
def list_device_types(manufacturer: str | None = None, category: str | None = None, status: str | None = None,
                      protocol: str | None = None, gateway_type: str | None = None, q: str | None = None):
    """Every known device model or family; any signed-in operator. Filters combine with AND."""
    where, params = [], []
    for column, value in (("manufacturer_code", manufacturer), ("category", category), ("status", status)):
        if value is not None:
            where.append(f"{column}=%s")
            params.append(value)
    if protocol:
        where.append("flora_protocol ILIKE %s")
        params.append(f"%{protocol}%")
    if gateway_type:
        where.append("%s = ANY(gateway_device_types)")
        params.append(gateway_type)
    if q:
        where.append("(model ILIKE %s OR series ILIKE %s OR manufacturer ILIKE %s OR integration_method ILIKE %s)")
        params.extend([f"%{q}%"] * 4)
    sql = "SELECT * FROM device_type" + (" WHERE " + " AND ".join(where) if where else "") + \
          " ORDER BY manufacturer_code, series NULLS LAST, model"
    with pool.connection() as connection:
        rows = connection.execute(sql, params).fetchall()
    return {"count": len(rows), "rows": rows}


@app.get("/api/v1/device-types/{device_type_id}")
def get_device_type(device_type_id: str):
    with pool.connection() as connection:
        row = connection.execute("SELECT * FROM device_type WHERE device_type_id=%s", (device_type_id,)).fetchone()
    if row is None:
        raise HTTPException(404, "device type not found")
    return row


DEVICE_REFERENCE = {
    "manufacturers": "SELECT * FROM device_manufacturer ORDER BY name",
    "protocols": "SELECT * FROM device_protocol ORDER BY protocol",
    "connection-types": "SELECT * FROM device_connection_type ORDER BY connection_type",
    "lanes": "SELECT * FROM device_protocol_lane ORDER BY lane_no",
    "sources": "SELECT * FROM device_type_source ORDER BY source_id",
    "summary": """SELECT manufacturer_code, status, count(*)::int AS models FROM device_type
                  GROUP BY manufacturer_code, status ORDER BY manufacturer_code, status""",
}


@app.get("/api/v1/device-reference/{kind}")
def device_reference(kind: str):
    if kind not in DEVICE_REFERENCE:
        raise HTTPException(404, f"kind must be one of {sorted(DEVICE_REFERENCE)}")
    with pool.connection() as connection:
        rows = connection.execute(DEVICE_REFERENCE[kind]).fetchall()
    return {"kind": kind, "rows": rows}


@app.get("/api/auth/status")
def auth_status():
    """Public readiness for the sign-in page. Shows nothing about tenants."""
    status: dict[str, Any] = {"server_ts": now_ms(), "database": "ready", "registry": "unreachable", "signing_key": None}
    try:
        with pool.connection() as connection:
            key = connection.execute(
                "SELECT key_id, public_raw FROM root_signing_key WHERE active ORDER BY created_at DESC LIMIT 1").fetchone()
        if key:
            fingerprint = hashlib.sha256(base64.b64decode(key["public_raw"])).hexdigest()
            status["signing_key"] = {"key_id": key["key_id"], "fingerprint": ":".join(
                fingerprint[i:i + 4] for i in range(0, 16, 4)).upper()}
    except Exception:
        status["database"] = "unavailable"
    try:
        with urllib.request.urlopen(REGISTRY_INTERNAL + "/v2/", timeout=2) as response:
            status["registry"] = "ready" if response.status == 200 else "unreachable"
    except Exception:
        pass
    return status


@app.get("/login")
def login_page():
    return FileResponse(Path(__file__).parent / "static" / "login.html", headers={"cache-control": "no-store"})


@app.get("/health")
def health():
    with pool.connection() as connection:
        connection.execute("SELECT 1")
    return {"status": "OK", "component": "flora-root"}


@app.get("/")
def index():
    return FileResponse(Path(__file__).parent / "static" / "index.html")
