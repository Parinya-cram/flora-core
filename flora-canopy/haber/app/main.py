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
import psycopg
from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse
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
CANOPY_DB_URL = os.getenv("CANOPY_DATABASE_URL", "")
SYNC_INTERVAL = int(os.getenv("HABER_ROOT_SYNC_SEC", "20"))
DB_PATH = os.getenv("HABER_DB_PATH", "/data/haber.db")
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


def kv_get(key: str) -> Any:
    with db() as connection:
        row = connection.execute("SELECT value FROM kv WHERE key=?", (key,)).fetchone()
    return json.loads(row["value"]) if row else None


def kv_set(key: str, value: Any) -> None:
    with db() as connection:
        connection.execute("INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                           (key, json.dumps(value)))


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
    if not CANOPY_DB_URL:
        return []
    try:
        with psycopg.connect(CANOPY_DB_URL, connect_timeout=3) as connection:
            rows = connection.execute(
                "SELECT leaf_id, coalesce(canopy_display_name, display_name) AS name, hospital_id, "
                "extract(epoch FROM last_seen_at)*1000 AS last_seen FROM sync_leaf_node ORDER BY leaf_id").fetchall()
    except Exception as error:
        log.warning("cannot read Canopy leaves: %s", error)
        return []
    return [{"leaf_id": r[0], "name": r[1], "hospital_id": r[2], "last_seen": int(r[3] or 0)} for r in rows]


def gateways() -> list[dict[str, Any]]:
    with db() as connection:
        rows = connection.execute("SELECT * FROM gateway ORDER BY gateway_id").fetchall()
    return [{**dict(row), "devices": json.loads(row["devices"])} for row in rows]


def usage() -> dict[str, Any]:
    leaves = canopy_leaves()
    known = gateways()
    devices = sum(len([d for d in gateway["devices"] if d.get("enabled", True)]) for gateway in known)
    return {"leaves": len(leaves), "gateways": len(known), "gateway_devices": devices,
            "leaf_ids": [leaf["leaf_id"] for leaf in leaves],
            "nodes": [{key: node[key] for key in ("node_id", "component", "release_id", "state", "last_seen")}
                      for node in nodes()]}


# ------------------------------------------------------------------ app

@asynccontextmanager
async def lifespan(_: FastAPI):
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    init_db()
    tasks = [asyncio.create_task(root_loop()), asyncio.create_task(mirror_loop())]
    yield
    for task in tasks:
        task.cancel()


app = FastAPI(title="Flora Canopy Haber", lifespan=lifespan)
basic_auth.install(app, "Canopy Haber", "HABER", [
    r"/health", r"/api/haber/v1/gateways/[^/]+/checkin",  # gateways, token auth
    r"/api/haber/v1/root-keys", r"/api/haber/v1/nodes/[^/]+/(desired|report)",  # flora-updater, token auth
])


class Checkin(BaseModel):
    gateway_id: str
    version: str | None = None
    devices: list[dict[str, Any]] = []


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
            """INSERT INTO gateway (gateway_id, first_seen, last_seen, version, devices) VALUES (?,?,?,?,?)
               ON CONFLICT(gateway_id) DO UPDATE SET last_seen=excluded.last_seen, version=excluded.version,
                 devices=excluded.devices""",
            (gateway_id, current, current, body.version, json.dumps(body.devices)))
    others = sum(len([d for d in gateway["devices"] if d.get("enabled", True)])
                 for gid, gateway in known.items() if gid != gateway_id)
    licensed = "gateway" in entitlements["modules"]
    max_devices = max(0, entitlements["max_gateway_devices"] - others) if licensed else 0
    allowed = set(entitlements.get("device_types") or [])
    release = approved_release("gateway")
    if release and release["device_types"]:
        # Parser images come from the approved gateway release, pinned by digest in haber-registry.
        catalog = [{**item, "image": image_ref(release["services"][item["image"]]), "version": release["version"]}
                   for item in release["device_types"]]
    else:
        catalog = CATALOG["device_types"]
    return {
        "gateway_id": gateway_id,
        "tenant_id": bundle["tenant"]["tenant_id"],
        "license": {
            "max_devices": max_devices,
            "allowed_types": sorted(allowed),
            "expires_at": bundle["expires_at"],
            "bundle_id": bundle["bundle_id"],
            "revoked": bool(bundle.get("revoked")),
            "issued_by": "flora-root",
        },
        "device_types": [item for item in catalog if not allowed or item["code"] in allowed],
        "images": CATALOG["images"],
        "release_id": release["release_id"] if release else None,
        "global_config": bundle.get("global_config", {}),
    }


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
        "releases": release_overview(),
        "nodes": nodes(),
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


@app.get("/health")
def health():
    return {"status": "OK", "component": "haber", "root": STATE["root"]["status"]}


@app.get("/")
def index():
    return FileResponse(Path(__file__).parent / "static" / "index.html")
