"""Haber: the hospital's image repository and device registry inside Flora Canopy.

- Pulls the hospital's license bundle from Flora Root and verifies its Ed25519
  signature. The verified bundle is cached, so the hospital keeps running when
  the cloud is unreachable, until the bundle expires.
- Publishes the device catalog (Device Type, Image) to every Flora Gateway.
- Splits the hospital's gateway-device entitlement across gateways (Device License).
- Reports hospital usage (Leaves, gateways, devices, node versions) back to Root.
- Image repository: pulls Root's signed release manifest, mirrors every release
  image by digest into the hospital registry (haber-registry), and lets the
  hospital approve which release each component (canopy, leaf, gateway) runs.
  Every node's flora-updater asks Haber for its approved release and pulls the
  images from here, so nodes never reach the cloud registry themselves.
"""
from __future__ import annotations

import asyncio
import base64
import hashlib
import hmac
import json
import logging
import os
import sqlite3
import time
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any

import httpx
from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, PlainTextResponse
from pydantic import BaseModel

from . import basic_auth
from .registry import Mirror

log = logging.getLogger("haber")
ROOT_URL = os.getenv("FLORA_ROOT_URL", "http://host.docker.internal:7100").rstrip("/")
TENANT_ID = os.getenv("FLORA_TENANT_ID", "hospital-01")
TENANT_KEY = os.getenv("FLORA_ROOT_TENANT_KEY", "")
# Pin Root's key in production; without it the first key seen is trusted (demo).
PINNED_KEY = os.getenv("FLORA_ROOT_PUBLIC_KEY", "").strip()
GATEWAY_TOKEN = os.getenv("HABER_GATEWAY_TOKEN", "")
NODE_TOKEN = os.getenv("HABER_NODE_TOKEN", "")
# Haber talks to its registry on the compose network; nodes pull via REGISTRY_PUBLIC.
REGISTRY_URL = os.getenv("HABER_REGISTRY_URL", "http://haber-registry:5000")
REGISTRY_PUBLIC = os.getenv("HABER_REGISTRY_PUBLIC", "localhost:7205")
ROOT_REGISTRY_URL = os.getenv("FLORA_ROOT_REGISTRY_URL", "").rstrip("/")  # empty = the one Root advertises
COMPONENTS = ("canopy", "leaf", "gateway")
# Canopy keeps every gateway's configuration and can hand one back (clone / restore).
CANOPY_SYNC_URL = os.getenv("FLORA_CANOPY_SYNC_URL", "").rstrip("/")
SYNC_SECRET = os.getenv("FLORA_SYNC_SHARED_SECRET", "")
# Canopy sync URL as a Leaf on the hospital LAN reaches it (handed to new Leafs at install).
CANOPY_SYNC_PUBLIC = os.getenv("FLORA_CANOPY_SYNC_PUBLIC_URL", "").rstrip("/")
SYNC_INTERVAL = int(os.getenv("HABER_ROOT_SYNC_SEC", "20"))
DB_PATH = os.getenv("HABER_DB_PATH", "/data/haber.db")
# Config that an admin can change at runtime from the Settings UI. The env value above is the
# bootstrap default; a value saved in the UI (kv key "setting:<name>") overrides it live — no
# restart, because the loops read these module globals each iteration. {name: (global, caster)}.
SETTINGS_KEYS = {
    "root_url": ("ROOT_URL", str), "root_registry_url": ("ROOT_REGISTRY_URL", str),
    "registry_public": ("REGISTRY_PUBLIC", str), "canopy_sync_url": ("CANOPY_SYNC_URL", str),
    "canopy_sync_public": ("CANOPY_SYNC_PUBLIC", str),
    "tenant_id": ("TENANT_ID", str), "tenant_key": ("TENANT_KEY", str),
    "sync_interval": ("SYNC_INTERVAL", int),
}
SECRET_KEYS = {"tenant_key"}  # never returned by the API, only writable
# Snapshot the env-derived defaults now, before any override is applied, so clearing a
# setting in the UI can restore the default live (not only after a restart).
ENV_DEFAULTS = {global_name: globals()[global_name] for global_name, _ in SETTINGS_KEYS.values()}
CATALOG = json.loads((Path(__file__).parent / "catalog.json").read_text())
STATE: dict[str, Any] = {"root": {"status": "never", "error": None, "last_sync": None},
                         "mirror": {"status": "idle", "error": None, "last_run": None}}


def now_ms() -> int:
    return int(time.time() * 1000)


def canonical(value: Any) -> bytes:
    return json.dumps(value, sort_keys=True, separators=(",", ":")).encode()


# ------------------------------------------------------------------ local store

def db() -> sqlite3.Connection:
    connection = sqlite3.connect(DB_PATH)
    connection.row_factory = sqlite3.Row
    return connection


def init_db() -> None:
    Path(DB_PATH).parent.mkdir(parents=True, exist_ok=True)
    with db() as connection:
        connection.executescript("""
            CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS gateway (
              gateway_id TEXT PRIMARY KEY, first_seen INTEGER NOT NULL, last_seen INTEGER NOT NULL,
              version TEXT, devices TEXT NOT NULL DEFAULT '[]');
            -- One row per release in Root's manifest: is every image in haber-registry yet?
            CREATE TABLE IF NOT EXISTS release_mirror (
              release_id TEXT PRIMARY KEY, component TEXT NOT NULL, version TEXT NOT NULL,
              status TEXT NOT NULL, error TEXT, bytes INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL);
            -- The hospital's decision: which release each component runs.
            CREATE TABLE IF NOT EXISTS release_approval (
              component TEXT PRIMARY KEY, release_id TEXT NOT NULL, approved_at INTEGER NOT NULL, approved_by TEXT);
            -- Last report from each node's flora-updater.
            CREATE TABLE IF NOT EXISTS node (
              node_id TEXT PRIMARY KEY, component TEXT NOT NULL, project TEXT, release_id TEXT, target TEXT,
              state TEXT, detail TEXT, images TEXT NOT NULL DEFAULT '{}', last_seen INTEGER NOT NULL);
        """)
        columns = {row["name"] for row in connection.execute("PRAGMA table_info(gateway)")}
        if "site" not in columns:
            # Where the gateway is installed, as configured on the gateway itself.
            connection.execute("ALTER TABLE gateway ADD COLUMN site TEXT NOT NULL DEFAULT '{}'")


def kv_get(key: str) -> Any:
    with db() as connection:
        row = connection.execute("SELECT value FROM kv WHERE key=?", (key,)).fetchone()
    return json.loads(row["value"]) if row else None


def kv_set(key: str, value: Any) -> None:
    with db() as connection:
        connection.execute("INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                           (key, json.dumps(value)))


def kv_del(key: str) -> None:
    with db() as connection:
        connection.execute("DELETE FROM kv WHERE key=?", (key,))


def apply_settings_overrides() -> None:
    """Load any admin-saved settings from kv and override the matching module globals, so the
    loops pick them up without a restart. Env remains the default when nothing is saved."""
    for name, (global_name, caster) in SETTINGS_KEYS.items():
        stored = kv_get("setting:" + name)
        if stored in (None, ""):
            globals()[global_name] = ENV_DEFAULTS[global_name]   # no override: restore env default live
            continue
        try:
            value = caster(stored)
            if isinstance(value, str):
                value = value.rstrip("/") if global_name.endswith("URL") else value
            globals()[global_name] = value
        except (TypeError, ValueError):
            log.warning("ignoring bad setting %s=%r", name, stored)


def current_settings() -> dict[str, Any]:
    """Effective config for the Settings UI. Secrets report only whether they are set."""
    out: dict[str, Any] = {}
    for name, (global_name, _caster) in SETTINGS_KEYS.items():
        overridden = kv_get("setting:" + name) not in (None, "")
        if name in SECRET_KEYS:
            out[name] = {"set": bool(globals().get(global_name)), "overridden": overridden, "secret": True}
        else:
            out[name] = {"value": globals().get(global_name), "overridden": overridden}
    return out


# ------------------------------------------------------------------ Root sync

def verify(envelope: dict[str, Any], keys: dict[str, str]) -> dict[str, Any]:
    public = keys.get(envelope.get("key_id", ""))
    if not public:
        raise ValueError(f"unknown signing key {envelope.get('key_id')}")
    try:
        Ed25519PublicKey.from_public_bytes(base64.b64decode(public)).verify(
            base64.b64decode(envelope["signature"]), canonical(envelope["bundle"]))
    except InvalidSignature:
        raise ValueError("bundle signature is invalid") from None
    return envelope["bundle"]


async def sync_root() -> None:
    headers = {"authorization": f"Bearer {TENANT_KEY}"}
    async with httpx.AsyncClient(timeout=5) as client:
        keys = kv_get("root_keys") or {}
        if PINNED_KEY:
            keys = {"pinned": PINNED_KEY} | keys
        if not keys or not PINNED_KEY:
            response = await client.get(f"{ROOT_URL}/api/v1/keys")
            response.raise_for_status()
            fetched = {item["key_id"]: item["public_key"] for item in response.json()["keys"]}
            if PINNED_KEY and PINNED_KEY not in fetched.values():
                raise ValueError("Root key does not match FLORA_ROOT_PUBLIC_KEY")
            keys = {**keys, **fetched}
            kv_set("root_keys", keys)
        response = await client.get(f"{ROOT_URL}/api/v1/tenants/{TENANT_ID}/bundle", headers=headers)
        response.raise_for_status()
        envelope = response.json()
        bundle = verify(envelope, keys)
        kv_set("bundle", envelope)
        response = await client.get(f"{ROOT_URL}/api/v1/tenants/{TENANT_ID}/releases", headers=headers)
        if response.status_code != 404:  # older Root without releases
            response.raise_for_status()
            releases = response.json()
            verify(releases, keys)
            kv_set("releases", releases)
        response = await client.get(f"{ROOT_URL}/api/v1/tenants/{TENANT_ID}/installs/pending", headers=headers)
        if response.status_code != 404:  # older Root without installs
            response.raise_for_status()
            planned = response.json()
            verify(planned, keys)
            kv_set("installs", planned)
        await flush_install_reports(client, headers)
        STATE["root"].update(status="ok", error=None, last_sync=now_ms(), verified=True)
        await client.post(f"{ROOT_URL}/api/v1/tenants/{TENANT_ID}/heartbeat", headers=headers, json={
            "canopy_version": "1.2.2", "bundle_id": bundle["bundle_id"], "usage": usage()})


async def root_loop() -> None:
    while True:
        try:
            await sync_root()
        except Exception as error:
            STATE["root"].update(status="offline", error=str(error))
            log.warning("root sync failed: %s", error)
        try:
            await place_new_leaves()   # LAN work: runs even while Root is unreachable
        except Exception as error:
            log.warning("leaf placement failed: %s", error)
        await asyncio.sleep(SYNC_INTERVAL)


def current_bundle() -> dict[str, Any] | None:
    return verified("bundle")


def verified(name: str) -> dict[str, Any] | None:
    envelope = kv_get(name)
    if not envelope:
        return None
    try:
        return verify(envelope, kv_get("root_keys") or {})
    except ValueError:
        return None


# ------------------------------------------------------------------ releases (image repository)

def releases_manifest() -> dict[str, Any] | None:
    return verified("releases")


def release_by_id(release_id: str) -> dict[str, Any] | None:
    manifest = releases_manifest() or {"releases": []}
    return next((r for r in manifest["releases"] if r["release_id"] == release_id), None)


def mirror_rows() -> dict[str, dict[str, Any]]:
    with db() as connection:
        return {row["release_id"]: dict(row) for row in connection.execute("SELECT * FROM release_mirror")}


def set_mirror(release: dict[str, Any], status: str, error: str | None = None, size: int = 0) -> None:
    with db() as connection:
        connection.execute(
            """INSERT INTO release_mirror (release_id, component, version, status, error, bytes, updated_at)
               VALUES (?,?,?,?,?,?,?) ON CONFLICT(release_id) DO UPDATE SET status=excluded.status,
                 error=excluded.error, bytes=release_mirror.bytes + excluded.bytes, updated_at=excluded.updated_at""",
            (release["release_id"], release["component"], release["version"], status, error, size, now_ms()))


async def mirror_releases() -> None:
    """Brings every signed release's images into haber-registry before anyone approves it."""
    manifest = releases_manifest()
    if not manifest:
        return
    done = {key for key, row in mirror_rows().items() if row["status"] == "ready"}
    pending = [release for release in manifest["releases"] if release["release_id"] not in done]
    if not pending:
        STATE["mirror"].update(error=None)   # everything mirrored; clear any stale error from a withdrawn release
        return
    mirror = Mirror(ROOT_REGISTRY_URL or manifest["registry"], REGISTRY_URL)
    STATE["mirror"].update(status="running", error=None)
    try:
        for release in pending:
            set_mirror(release, "mirroring")
            try:
                size = 0
                for image in release["services"].values():
                    size += await mirror.copy(image["repository"], image["digest"])
                set_mirror(release, "ready", size=size)
                log.info("mirrored %s (%d bytes)", release["release_id"], size)
            except Exception as error:
                set_mirror(release, "failed", str(error))
                STATE["mirror"].update(error=f"{release['release_id']}: {error}")
                log.warning("mirror %s failed: %s", release["release_id"], error)
    finally:
        await mirror.close()
        STATE["mirror"].update(status="idle", last_run=now_ms())


async def mirror_loop() -> None:
    while True:
        try:
            await mirror_releases()
        except Exception as error:
            STATE["mirror"].update(status="idle", error=str(error))
            log.warning("mirror run failed: %s", error)
        await asyncio.sleep(SYNC_INTERVAL)


def approvals() -> dict[str, dict[str, Any]]:
    with db() as connection:
        return {row["component"]: dict(row) for row in connection.execute("SELECT * FROM release_approval")}


def approved_release(component: str) -> dict[str, Any] | None:
    approval = approvals().get(component)
    return release_by_id(approval["release_id"]) if approval else None


def image_ref(image: dict[str, Any]) -> str:
    return f"{REGISTRY_PUBLIC}/{image['repository']}@{image['digest']}"


def nodes() -> list[dict[str, Any]]:
    with db() as connection:
        rows = connection.execute("SELECT * FROM node ORDER BY component, node_id").fetchall()
    return [{**dict(row), "images": json.loads(row["images"])} for row in rows]


# ------------------------------------------------------------------ usage

def canopy_leaves() -> list[dict[str, Any]]:
    """The hospital's Leaf nodes, read from Canopy over HTTP (sync-api) rather than canopy-db
    directly, so Haber needs no database credentials and can run as its own stack."""
    if not CANOPY_SYNC_URL or not SYNC_SECRET:
        return []
    try:
        response = httpx.get(f"{CANOPY_SYNC_URL}/api/sync/v1/leaves",
                             headers={"authorization": f"Bearer {SYNC_SECRET}"}, timeout=3)
        response.raise_for_status()
        return response.json().get("leaves", [])
    except Exception as error:  # Canopy down must not break Haber's overview
        log.warning("cannot read Canopy leaves: %s", error)
        return []


def gateways() -> list[dict[str, Any]]:
    with db() as connection:
        rows = connection.execute("SELECT * FROM gateway ORDER BY gateway_id").fetchall()
    return [{**dict(row), "devices": json.loads(row["devices"]), "site": json.loads(row["site"] or "{}")} for row in rows]


def usage() -> dict[str, Any]:
    leaves = canopy_leaves()
    known = gateways()
    devices = sum(len([d for d in gateway["devices"] if d.get("enabled", True)]) for gateway in known)
    # Per-gateway device detail so Root's fleet console can drill a hospital down to
    # gateway -> device -> parser (version/status), not just counts.
    gateway_detail = [{
        "gateway_id": gateway.get("gateway_id"),
        "site": (gateway.get("site") or {}).get("display_name") or gateway.get("gateway_id"),
        "version": gateway.get("version"),
        "last_seen": gateway.get("last_seen"),
        "devices": [{key: d.get(key) for key in ("device_id", "device_type", "label", "leaf_id", "pod", "station",
                                                 "location", "serial_number", "asset_tag", "parser_status", "live")}
                    | {"enabled": d.get("enabled", True)}
                    for d in (gateway.get("devices") or [])],
    } for gateway in known]
    return {"leaves": len(leaves), "gateways": len(known), "gateway_devices": devices,
            "leaf_ids": [leaf["leaf_id"] for leaf in leaves],
            "leaf_detail": [{key: leaf.get(key) for key in ("leaf_id", "name", "ward_key", "ward", "room", "bed", "last_seen")}
                            for leaf in leaves],
            "gateway_detail": gateway_detail,
            "nodes": [{key: node[key] for key in ("node_id", "component", "release_id", "state", "last_seen")}
                      for node in nodes()]}


# ------------------------------------------------------------------ app

@asynccontextmanager
async def lifespan(_: FastAPI):
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    init_db()
    apply_settings_overrides()  # admin-saved settings win over env defaults
    tasks = [asyncio.create_task(root_loop()), asyncio.create_task(mirror_loop())]
    yield
    for task in tasks:
        task.cancel()


app = FastAPI(title="Flora Canopy Haber", lifespan=lifespan)
basic_auth.install(app, "Canopy Haber", "HABER", [
    r"/health", r"/api/haber/v1/gateways/[^/]+/(checkin|alerts|activity)",  # gateways, token auth
    r"/api/haber/v1/root-keys", r"/api/haber/v1/nodes/[^/]+/(desired|report)",  # flora-updater, token auth
    r"/install/(leaf|gateway)\.sh", r"/install/files/[a-z]+/[A-Za-z0-9._-]+", r"/api/haber/v1/install/(claim|report)",   # new LAN machines, one-time code
])


class Checkin(BaseModel):
    gateway_id: str
    version: str | None = None
    devices: list[dict[str, Any]] = []
    site: dict[str, Any] = {}
    applied_config_version: int = 0
    data_api_url: str | None = None


@app.post("/api/haber/v1/gateways/{gateway_id}/checkin")
def gateway_checkin(gateway_id: str, body: Checkin, request: Request):
    supplied = request.headers.get("authorization", "").removeprefix("Bearer ").strip()
    if not GATEWAY_TOKEN or not hmac.compare_digest(supplied, GATEWAY_TOKEN):
        raise HTTPException(401, "invalid gateway token")
    bundle = current_bundle()
    if bundle is None:
        raise HTTPException(503, "no verified license bundle from Flora Root yet")
    entitlements = bundle["entitlements"]
    known = {gateway["gateway_id"]: gateway for gateway in gateways()}
    if gateway_id not in known and len(known) >= entitlements["max_gateways"]:
        raise HTTPException(403, f"gateway limit reached ({entitlements['max_gateways']})")
    current = now_ms()
    with db() as connection:
        connection.execute(
            """INSERT INTO gateway (gateway_id, first_seen, last_seen, version, devices, site) VALUES (?,?,?,?,?,?)
               ON CONFLICT(gateway_id) DO UPDATE SET last_seen=excluded.last_seen, version=excluded.version,
                 devices=excluded.devices, site=excluded.site""",
            (gateway_id, current, current, body.version, json.dumps(body.devices), json.dumps(body.site, default=str)))
    others = sum(len([d for d in gateway["devices"] if d.get("enabled", True)])
                 for gid, gateway in known.items() if gid != gateway_id)
    licensed = "gateway" in entitlements["modules"]
    max_devices = max(0, entitlements["max_gateway_devices"] - others) if licensed else 0
    allowed = set(entitlements.get("device_types") or [])
    catalog, release = gateway_catalog()
    canopy = forward_to_canopy(gateway_id, body, {
        "max_devices": max_devices, "allowed_types": sorted(allowed), "expires_at": bundle["expires_at"],
        "bundle_id": bundle["bundle_id"], "revoked": bool(bundle.get("revoked")), "issued_by": "flora-root"})
    # The hospital's own device types (Canopy → Devices → Device types) run the release's parsers.
    # They are licensed when the Root bundle licenses a type using the same parser.
    allowed_parsers = {item["parser"] for item in catalog if not allowed or item["code"] in allowed}
    root_codes = {item["code"] for item in catalog}
    parser_image = (image_ref(release["services"]["parser"]) if release and "parser" in release.get("services", {})
                    else CATALOG["images"][0]["image"])
    for item in canopy.get("device_types") or []:
        if item.get("code") in root_codes or item.get("parser") not in allowed_parsers:
            continue
        catalog = [*catalog, {**item, "image": parser_image, "origin": "canopy"}]
        if allowed:
            allowed.add(item["code"])
    license_grant = {
        "max_devices": max_devices,
        "allowed_types": sorted(allowed),
        "expires_at": bundle["expires_at"],
        "bundle_id": bundle["bundle_id"],
        "revoked": bool(bundle.get("revoked")),
        "issued_by": "flora-root",
    }
    return {
        "gateway_id": gateway_id,
        "tenant_id": bundle["tenant"]["tenant_id"],
        "license": license_grant,
        "canopy_config": canopy.get("desired_config"),
        "device_types": [item for item in catalog if not allowed or item["code"] in allowed],
        "images": CATALOG["images"],
        "release_id": release["release_id"] if release else None,
        "global_config": bundle.get("global_config", {}),
    }


def gateway_catalog() -> tuple[list[dict[str, Any]], dict[str, Any] | None]:
    """Device types gateways receive from Root: the approved gateway release's, else the built-in catalog."""
    release = approved_release("gateway")
    if release and release["device_types"]:
        # Parser images come from the approved gateway release, pinned by digest in haber-registry.
        return [{**item, "image": image_ref(release["services"][item["image"]]), "version": release["version"]}
                for item in release["device_types"]], release
    return CATALOG["device_types"], None


def forward_to_canopy(gateway_id: str, body: Checkin, license_grant: dict[str, Any]) -> dict[str, Any]:
    """Store this check-in in Canopy. Canopy answers with a configuration it wants applied
    (`desired_config`) and the hospital's own device types (`device_types`)."""
    if not CANOPY_SYNC_URL or not SYNC_SECRET:
        return {}
    try:
        response = httpx.post(
            f"{CANOPY_SYNC_URL}/api/sync/v1/gateways/{gateway_id}/config",
            headers={"authorization": f"Bearer {SYNC_SECRET}"}, timeout=3,
            json={"version": body.version, "site": body.site, "license": license_grant, "devices": body.devices,
                  "applied_config_version": body.applied_config_version, "data_api_url": body.data_api_url},
        )
        response.raise_for_status()
        return response.json()
    except Exception as error:  # Canopy down must not block device licensing
        log.warning("canopy gateway sync failed for %s: %s", gateway_id, error)
        return {}


class GatewayAlerts(BaseModel):
    gateway_id: str
    alerts: list[dict[str, Any]] = []


@app.post("/api/haber/v1/gateways/{gateway_id}/alerts")
def gateway_alerts(gateway_id: str, body: GatewayAlerts, request: Request):
    """Relays a gateway's alert log to Canopy, the central log. Canopy's answer lists the
    alert versions it stored; the gateway resends anything not listed."""
    supplied = request.headers.get("authorization", "").removeprefix("Bearer ").strip()
    if not GATEWAY_TOKEN or not hmac.compare_digest(supplied, GATEWAY_TOKEN):
        raise HTTPException(401, "invalid gateway token")
    if not CANOPY_SYNC_URL or not SYNC_SECRET:
        raise HTTPException(503, "Canopy sync is not configured; alerts stay queued on the gateway")
    try:
        response = httpx.post(f"{CANOPY_SYNC_URL}/api/sync/v1/gateways/{gateway_id}/alerts",
                              headers={"authorization": f"Bearer {SYNC_SECRET}"}, timeout=5,
                              json={"alerts": body.alerts})
        response.raise_for_status()
    except Exception as error:
        log.warning("canopy alert relay failed for %s: %s", gateway_id, error)
        raise HTTPException(502, f"Canopy unreachable: {error}") from None
    return response.json()


class GatewayActivity(BaseModel):
    gateway_id: str
    hours: list[dict[str, Any]] = []
    events: list[dict[str, Any]] = []


@app.post("/api/haber/v1/gateways/{gateway_id}/activity")
def gateway_activity(gateway_id: str, body: GatewayActivity, request: Request):
    """Relays a gateway's hourly device activity and on/off events to Canopy's Device Management.
    Canopy's answer lists what it stored; the gateway resends anything not listed."""
    supplied = request.headers.get("authorization", "").removeprefix("Bearer ").strip()
    if not GATEWAY_TOKEN or not hmac.compare_digest(supplied, GATEWAY_TOKEN):
        raise HTTPException(401, "invalid gateway token")
    if not CANOPY_SYNC_URL or not SYNC_SECRET:
        raise HTTPException(503, "Canopy sync is not configured; activity stays queued on the gateway")
    try:
        response = httpx.post(f"{CANOPY_SYNC_URL}/api/sync/v1/gateways/{gateway_id}/activity",
                              headers={"authorization": f"Bearer {SYNC_SECRET}"}, timeout=10,
                              json={"hours": body.hours, "events": body.events})
        response.raise_for_status()
    except Exception as error:
        log.warning("canopy activity relay failed for %s: %s", gateway_id, error)
        raise HTTPException(502, f"Canopy unreachable: {error}") from None
    return response.json()


def require_node(request: Request) -> None:
    supplied = request.headers.get("authorization", "").removeprefix("Bearer ").strip()
    if not NODE_TOKEN or not hmac.compare_digest(supplied, NODE_TOKEN):
        raise HTTPException(401, "invalid node token")


@app.get("/api/haber/v1/root-keys")
def root_keys(request: Request):
    require_node(request)
    return {"keys": [{"key_id": key, "public_key": value} for key, value in (kv_get("root_keys") or {}).items()]}


@app.get("/api/haber/v1/nodes/{node_id}/desired")
def node_desired(node_id: str, component: str, request: Request):
    """What flora-updater should run. The envelope is Root's, untouched, so the node verifies it itself."""
    require_node(request)
    if component not in COMPONENTS:
        raise HTTPException(422, f"component must be one of {COMPONENTS}")
    approval = approvals().get(component)
    release_id = approval["release_id"] if approval else None
    if release_id and mirror_rows().get(release_id, {}).get("status") != "ready":
        release_id = None  # never send a node to pull something Haber does not hold
    return {"node_id": node_id, "component": component, "release_id": release_id,
            "registry": REGISTRY_PUBLIC, "envelope": kv_get("releases") if release_id else None}


class NodeReport(BaseModel):
    component: str
    project: str | None = None
    release_id: str | None = None
    target: str | None = None
    state: str
    detail: str | None = None
    images: dict[str, str] = {}


@app.post("/api/haber/v1/nodes/{node_id}/report")
def node_report(node_id: str, body: NodeReport, request: Request):
    require_node(request)
    with db() as connection:
        connection.execute(
            """INSERT INTO node (node_id, component, project, release_id, target, state, detail, images, last_seen)
               VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(node_id) DO UPDATE SET component=excluded.component,
                 project=excluded.project, release_id=excluded.release_id, target=excluded.target, state=excluded.state,
                 detail=excluded.detail, images=CASE WHEN excluded.images='{}' THEN node.images ELSE excluded.images END,
                 last_seen=excluded.last_seen""",
            (node_id, body.component, body.project, body.release_id, body.target, body.state, body.detail,
             json.dumps(body.images), now_ms()))
    return {"ok": True}


@app.post("/api/haber/v1/releases/{release_id}/approve")
def approve_release(release_id: str, request: Request):
    """Hospital admin: roll this release out to every node of its component (also used to roll back)."""
    release = release_by_id(release_id)
    if release is None:
        raise HTTPException(404, "not in Root's signed release manifest")
    if mirror_rows().get(release_id, {}).get("status") != "ready":
        raise HTTPException(409, "images are not mirrored into Haber yet")
    user = basic_auth.username_of(request)
    with db() as connection:
        connection.execute(
            """INSERT INTO release_approval (component, release_id, approved_at, approved_by) VALUES (?,?,?,?)
               ON CONFLICT(component) DO UPDATE SET release_id=excluded.release_id, approved_at=excluded.approved_at,
                 approved_by=excluded.approved_by""",
            (release["component"], release_id, now_ms(), user))
    log.info("%s approved %s", user, release_id)
    return {"component": release["component"], "release_id": release_id}


@app.post("/api/haber/v1/components/{component}/hold")
def hold_component(component: str):
    """Clears the approval: nodes keep what they run and stop following new approvals."""
    with db() as connection:
        connection.execute("DELETE FROM release_approval WHERE component=?", (component,))
    return {"component": component, "held": True}


@app.post("/api/haber/v1/releases/{release_id}/mirror")
async def retry_mirror(release_id: str):
    with db() as connection:
        connection.execute("DELETE FROM release_mirror WHERE release_id=?", (release_id,))
    await mirror_releases()
    return mirror_rows().get(release_id)


@app.post("/api/haber/v1/root/sync")
async def force_root_sync():
    try:
        await sync_root()
    except Exception as error:
        STATE["root"].update(status="offline", error=str(error))
        raise HTTPException(502, str(error)) from None
    return overview()


class SettingsIn(BaseModel):
    root_url: str | None = None
    root_registry_url: str | None = None
    registry_public: str | None = None
    canopy_sync_url: str | None = None
    canopy_sync_public: str | None = None   # Canopy sync URL handed to new Leafs on the LAN
    tenant_id: str | None = None
    tenant_key: str | None = None   # write-only; blank keeps the current value
    sync_interval: int | str | None = None   # blank string resets to the env default (like the URL fields)


@app.get("/api/haber/v1/settings")
def get_settings():
    """Effective Haber config for the admin UI (env default, overridable here instead of redeploying)."""
    return {"settings": current_settings()}


@app.put("/api/haber/v1/settings")
def put_settings(body: SettingsIn, request: Request):
    user = basic_auth.username_of(request)
    changed = []
    for name in SETTINGS_KEYS:
        value = getattr(body, name)
        if value is None:
            continue
        if isinstance(value, str):
            value = value.strip()
            if value == "":
                if name in SECRET_KEYS:
                    continue            # blank secret = keep current
                kv_del("setting:" + name)  # blank = reset to the env default
                changed.append(name)
                continue
        kv_set("setting:" + name, value)
        changed.append(name)
    apply_settings_overrides()
    log.info("%s updated settings: %s", user, ", ".join(changed) or "(none)")
    return {"changed": changed, "settings": current_settings()}


# ---- adopted device types: which licensed device types this hospital has "downloaded" for Canopy/Leaf use
def adopted_types() -> list[str]:
    return kv_get("adopted_types") or []


@app.get("/api/haber/v1/adopted")
def get_adopted():
    return {"codes": adopted_types()}


@app.post("/api/haber/v1/adopted/{code}")
def adopt_type(code: str, request: Request):
    user = basic_auth.username_of(request)
    codes = adopted_types()
    if code not in codes:
        codes.append(code)
        kv_set("adopted_types", codes)
        log.info("%s adopted device type %s", user, code)
    return {"codes": codes}


@app.delete("/api/haber/v1/adopted/{code}")
def unadopt_type(code: str, request: Request):
    user = basic_auth.username_of(request)
    codes = [c for c in adopted_types() if c != code]
    kv_set("adopted_types", codes)
    log.info("%s removed device type %s", user, code)
    return {"codes": codes}


@app.get("/api/haber/v1/device-types")
def device_types():
    return {"rows": CATALOG["device_types"]}


@app.get("/api/haber/v1/images")
def images():
    return {"rows": CATALOG["images"]}


@app.get("/api/haber/v1/overview")
def overview():
    bundle = current_bundle()
    return {
        "server_ts": now_ms(),
        "tenant_id": TENANT_ID,
        "root": {"url": ROOT_URL, **STATE["root"]},
        "bundle": bundle,
        "license_valid": bool(bundle and bundle["expires_at"] > now_ms()),
        "usage": usage(),
        "leaves": canopy_leaves(),
        "gateways": gateways(),
        "catalog": CATALOG,
        "gateway_catalog": gateway_catalog()[0],
        "releases": release_overview(),
        "nodes": nodes(),
        "adopted": adopted_types(),
        "installs": install_overview(),
    }


def release_overview() -> dict[str, Any]:
    manifest = releases_manifest()
    mirrors = mirror_rows()
    return {
        "channel": manifest["channel"] if manifest else None,
        "latest": manifest["latest"] if manifest else {},
        "registry": REGISTRY_PUBLIC,
        "mirror": STATE["mirror"],
        "approvals": approvals(),
        "rows": [{**release, "device_types": len(release["device_types"]),
                  "mirror": mirrors.get(release["release_id"], {"status": "pending"})}
                 for release in (manifest["releases"] if manifest else [])],
    }


# ------------------------------------------------------------------ installs (planned at Root)
# Root plans each Leaf / gateway and gives the operator a one-time code. Haber keeps Root's signed list of
# open installs (code hashes only), so a machine on the hospital LAN installs from here even while the
# internet is down: it trades the code for its node settings, Haber remembers the claim, places a new Leaf
# on its bed in Canopy once that Leaf first syncs, and reports every step back to Root.

INSTALL_KINDS = {"leaf", "gateway"}


def install_plans() -> list[dict[str, Any]]:
    planned = verified("installs")
    return (planned or {}).get("installs") or []


def install_states() -> dict[str, dict[str, Any]]:
    return kv_get("install_state") or {}


def save_install_state(install_id: str, **changes: Any) -> dict[str, Any]:
    states = install_states()
    state = {**states.get(install_id, {}), **changes, "updated_at": now_ms()}
    if "status" in changes:
        state["reported"] = False      # Root hears about every status change
    states[install_id] = state
    kv_set("install_state", states)
    return state


def plan_for_code(code: str, kind: str | None = None) -> dict[str, Any] | None:
    digest = hashlib.sha256(code.strip().upper().encode()).hexdigest()
    for plan in install_plans():
        if hmac.compare_digest(plan["code_hash"], digest) and (kind is None or plan["kind"] == kind) and plan["expires_at"] > now_ms():
            return plan
    return None


async def flush_install_reports(client: httpx.AsyncClient, headers: dict[str, str]) -> None:
    for install_id, state in install_states().items():
        if state.get("reported") or state.get("status") not in {"claimed", "installed", "failed"}:
            continue
        detail = {key: state.get(key) for key in ("hostname", "ip", "placed", "placement_error", "error") if state.get(key) is not None}
        status = "failed" if state.get("last_result") == "failed" and state.get("status") == "claimed" else state["status"]
        response = await client.post(f"{ROOT_URL}/api/v1/tenants/{TENANT_ID}/installs/{install_id}/report", headers=headers,
                                     json={"status": status, "detail": detail})
        if response.status_code in (200, 409):   # 409: Root already closed it (revoked / done)
            _mark_reported(install_id)


def _mark_reported(install_id: str) -> None:
    states = install_states()
    if install_id in states:
        states[install_id]["reported"] = True
        kv_set("install_state", states)


async def place_new_leaves() -> None:
    """Put a newly installed Leaf on the bed Root planned, once Canopy knows the Leaf (after its first sync)."""
    if not CANOPY_SYNC_URL or not SYNC_SECRET:
        return
    plans = {plan["install_id"]: plan for plan in install_plans()} | (kv_get("install_plan_copy") or {})
    waiting = [(install_id, plans[install_id]) for install_id, state in install_states().items()
               if install_id in plans and plans[install_id]["kind"] == "leaf" and state.get("status") in {"claimed", "installed"}
               and not state.get("placed") and plans[install_id].get("bed")]
    if not waiting:
        return
    known = {leaf["leaf_id"] for leaf in canopy_leaves()}
    headers = {"authorization": f"Bearer {SYNC_SECRET}"}
    async with httpx.AsyncClient(timeout=5) as client:
        for install_id, plan in waiting:
            if plan["node_id"] not in known:
                continue                     # not synced yet; try again next cycle
            response = await client.post(f"{CANOPY_SYNC_URL}/api/sync/v1/locations", headers=headers, json={"leaf_id": plan["node_id"]})
            response.raise_for_status()
            bed_id = find_bed(response.json().get("locations") or [], plan)
            if bed_id is None:
                save_install_state(install_id, placement_error=f"no bed '{plan.get('bed')}' in ward '{plan.get('ward')}' in Canopy — assign it in Canopy")
                continue
            response = await client.post(f"{CANOPY_SYNC_URL}/api/sync/v1/leaves/{plan['node_id']}/location", headers=headers,
                                         json={"bed_location_id": bed_id})
            response.raise_for_status()
            save_install_state(install_id, placed=bed_id, placement_error=None, reported=False)
            log.info("placed leaf %s on bed %s", plan["node_id"], bed_id)


def find_bed(locations: list[dict[str, Any]], plan: dict[str, Any]) -> int | None:
    """The bed named in the plan, under its room and ward when those are given (names compared case-insensitively)."""
    same = lambda a, b: str(a or "").strip().casefold() == str(b or "").strip().casefold()
    by_id = {row["id"]: row for row in locations}
    def ancestors(row: dict[str, Any]) -> list[dict[str, Any]]:
        chain, parent = [], by_id.get(row.get("parent_id"))
        while parent:
            chain.append(parent)
            parent = by_id.get(parent.get("parent_id"))
        return chain
    for row in locations:
        if row["kind"] != "bed" or not same(row["name"], plan.get("bed")):
            continue
        up = ancestors(row)
        if plan.get("room") and not any(r["kind"] == "room" and same(r["name"], plan["room"]) for r in up):
            continue
        if plan.get("ward") and not any(r["kind"] == "care_unit" and same(r["name"], plan["ward"]) for r in up):
            continue
        return row["id"]
    return None


class InstallClaim(BaseModel):
    code: str
    kind: str
    hostname: str | None = None


@app.post("/api/haber/v1/install/claim")
def install_claim(body: InstallClaim, request: Request):
    """A new LAN machine trades its one-time code for its node settings. The same machine may claim again
    (a retried install) until the code expires; another machine may not."""
    if body.kind not in INSTALL_KINDS:
        raise HTTPException(422, "kind is leaf or gateway")
    plan = plan_for_code(body.code, body.kind)
    if plan is None:
        raise HTTPException(403, "invalid, used or expired install code (or this appliance has not synced it from Root yet)")
    state = install_states().get(plan["install_id"], {})
    if state.get("status") == "installed" or (state.get("hostname") and body.hostname and state["hostname"] != body.hostname):
        raise HTTPException(409, f"this code was already used by {state.get('hostname') or 'another machine'}")
    copies = kv_get("install_plan_copy") or {}
    copies[plan["install_id"]] = plan            # keep the plan after Root closes it (placement still needs it)
    kv_set("install_plan_copy", copies)
    save_install_state(plan["install_id"], status="claimed", hostname=body.hostname,
                       ip=request.client.host if request.client else None, claimed_at=now_ms())
    haber_url = str(request.base_url).rstrip("/")
    node = {"install_id": plan["install_id"], "kind": plan["kind"], "node_id": plan["node_id"], "label": plan.get("label"),
            "ward": plan.get("ward"), "room": plan.get("room"), "bed": plan.get("bed"),
            "haber_url": haber_url, "registry": REGISTRY_PUBLIC, "tenant_id": TENANT_ID}
    if plan["kind"] == "leaf":
        node |= {"node_token": NODE_TOKEN, "canopy_sync_url": CANOPY_SYNC_PUBLIC, "sync_secret": SYNC_SECRET}
    else:
        node |= {"gateway_token": GATEWAY_TOKEN, "node_token": NODE_TOKEN}
    return node


class InstallResult(BaseModel):
    code: str
    status: str
    error: str | None = None


@app.post("/api/haber/v1/install/report")
def install_report(body: InstallResult):
    if body.status not in {"installed", "failed"}:
        raise HTTPException(422, "status is installed or failed")
    digest = hashlib.sha256(body.code.strip().upper().encode()).hexdigest()
    plans = list((kv_get("install_plan_copy") or {}).values()) + install_plans()
    plan = next((p for p in plans if hmac.compare_digest(p["code_hash"], digest)), None)
    if plan is None or install_states().get(plan["install_id"], {}).get("status") != "claimed":
        raise HTTPException(409, "no claimed install for this code")
    # failed: stays claimed so the same machine can fix the cause and run the installer again
    save_install_state(plan["install_id"], status="installed" if body.status == "installed" else "claimed",
                       error=body.error, last_result=body.status, finished_at=now_ms())
    return {"ok": True}


def install_overview() -> list[dict[str, Any]]:
    plans = {plan["install_id"]: plan for plan in install_plans()} | (kv_get("install_plan_copy") or {})
    states = install_states()
    return [{key: plan.get(key) for key in ("install_id", "kind", "node_id", "label", "ward", "room", "bed", "expires_at")}
            | {key: states.get(install_id, {}).get(key) for key in ("status", "hostname", "placed", "placement_error", "reported")}
            for install_id, plan in plans.items()]


@app.get("/install/{kind}.sh")
def install_script(kind: str, request: Request):
    if kind not in INSTALL_KINDS:
        raise HTTPException(404, "no such installer")
    script = f"{kind}.sh"          # full install from this appliance's registry (images only)
    return PlainTextResponse((Path(__file__).parent / "install" / script).read_text()
                             .replace("__HABER_URL__", str(request.base_url).rstrip("/")).replace("__KIND__", kind),
                             media_type="text/x-shellscript")


INSTALL_FILES = {"leaf": {"compose.yaml", "https.conf.template"},
                 "gateway": {"compose.yaml", "gateway.toml", "instances.json", "kong.yaml", "nginx.conf",
                             "0001-gateway.sql", "0002-device-measurements.sql"}}


@app.get("/install/files/{kind}/{name}")
def install_file(kind: str, name: str):
    """The files an installer writes next to its compose project (no source code, images only)."""
    if name not in INSTALL_FILES.get(kind, set()):
        raise HTTPException(404, "no such file")
    return PlainTextResponse((Path(__file__).parent / "install" / kind / name).read_text())


@app.get("/health")
def health():
    return {"status": "OK", "component": "haber", "root": STATE["root"]["status"]}


@app.get("/")
def index():
    return FileResponse(Path(__file__).parent / "static" / "index.html")
