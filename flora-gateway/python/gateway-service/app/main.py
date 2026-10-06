"""Flora Gateway Service: station admin for devices, controllers and the license.

Device types and the gateway's device license come from Haber (in Flora Canopy).
Each enabled device instance runs as its own device-medical-service container.
Manufacturers, local device types and installed devices are edited on the admin page.
"""
from __future__ import annotations

import asyncio
import json
import logging
import tomllib
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any

import httpx
import tomli_w
from aiokafka import AIOKafkaProducer
from fastapi import Depends, FastAPI, HTTPException, Request, Response
from fastapi.responses import FileResponse, RedirectResponse
from pydantic import BaseModel, Field
from psycopg.types.json import Jsonb

from . import auth, connection, db, docker_ops, settings
from .streams import WINDOW_SEC, monitor

log = logging.getLogger("gateway-service")
STATE: dict[str, Any] = {"haber": {"status": "never", "error": None, "last_sync": None}, "producer": None}


# ------------------------------------------------------------------ lifecycle

@asynccontextmanager
async def lifespan(_: FastAPI):
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    db.pool.open(wait=True, timeout=60)
    for name in db.migrate():
        log.info("applied migration %s", name)
    auth.ensure_default_admin()
    task = asyncio.create_task(background_loop())
    monitor.start()
    yield
    task.cancel()
    await monitor.stop()
    if STATE["producer"]:
        await STATE["producer"].stop()
    db.pool.close()


app = FastAPI(title="Flora Gateway Service", lifespan=lifespan)
auth.install(app, [r"/health", r"/login", r"/api/auth/login", r"/api/site/label"])


def require_admin(request: Request) -> None:
    if request.method in {"GET", "HEAD", "OPTIONS"} or not settings.ADMIN_KEY:
        return
    if request.headers.get("x-gateway-key") != settings.ADMIN_KEY:
        raise HTTPException(401, "x-gateway-key required")


async def background_loop() -> None:
    seeded = False
    while True:
        try:
            await haber_checkin()
        except Exception as error:  # Haber/Canopy may be offline; keep the last license
            STATE["haber"].update(status="offline", error=str(error))
            log.warning("haber check-in failed: %s", error)
        try:
            if not seeded:
                seeded = seed_instances()
            await asyncio.to_thread(reconcile)
        except Exception as error:
            log.warning("reconcile failed: %s", error)
        await asyncio.sleep(settings.SYNC_INTERVAL_SEC)


# ------------------------------------------------------------------ Haber + license

async def haber_checkin() -> dict[str, Any]:
    if not settings.HABER_URL:
        STATE["haber"].update(status="disabled", error=None)
        return {}
    instances = db.fetch_all("SELECT device_id, device_type, leaf_id, pod, enabled FROM gateway_device_instance")
    async with httpx.AsyncClient(timeout=5) as client:
        response = await client.post(
            f"{settings.HABER_URL}/api/haber/v1/gateways/{settings.GATEWAY_ID}/checkin",
            headers={"authorization": f"Bearer {settings.HABER_TOKEN}"},
            json={"gateway_id": settings.GATEWAY_ID, "version": "0.1.0", "devices": instances, "site": site_row()},
        )
        response.raise_for_status()
        payload = response.json()
    db.upsert_device_types(payload.get("device_types") or [], "haber")
    db.store_parser_images(payload.get("images") or [], payload.get("device_types") or [], payload.get("release_id"))
    if payload.get("license"):
        db.store_license(payload["license"], payload.get("tenant_id"))
    STATE["haber"].update(status="ok", error=None, last_sync=db.now_ms(), tenant_id=payload.get("tenant_id"),
                          release_id=payload.get("release_id"))
    return payload


def license_state() -> dict[str, Any]:
    row = db.fetch_one("SELECT * FROM gateway_license WHERE id=1")
    used = db.fetch_one("SELECT count(*) AS n FROM gateway_device_instance WHERE enabled")["n"]
    if row is None:
        return {"valid": not settings.LICENSE_REQUIRED, "reason": "no license received from Haber", "used": used}
    if (row["raw"] or {}).get("revoked"):
        return {"valid": False, "reason": "license revoked by Flora Root", "used": used, **row}
    if row["expires_at"] is not None and row["expires_at"] < db.now_ms():
        return {"valid": False, "reason": "license expired", "used": used, **row}
    return {"valid": True, "reason": None, "used": used, **row}


def check_license(device_type: str, adding: bool) -> None:
    state = license_state()
    if not state["valid"]:
        raise HTTPException(403, f"device license invalid: {state['reason']}")
    if state.get("allowed_types") and device_type not in state["allowed_types"]:
        raise HTTPException(403, f"device type {device_type} is not licensed")
    if adding and state.get("max_devices") is not None and state["used"] >= state["max_devices"]:
        raise HTTPException(403, f"device limit reached ({state['max_devices']})")


# ------------------------------------------------------------------ instances

class InstanceFields(BaseModel):
    device_type: str
    pod: str = Field(pattern=r"^[a-z]+\..+$", description="controller.pod-id, e.g. socket.or-monitor")
    label: str | None = None
    leaf_id: str | None = None
    options: dict[str, Any] = {}
    enabled: bool = True
    serial_number: str | None = None
    asset_tag: str | None = None
    station: str | None = None
    location: str | None = None
    installed_at: int | None = None
    notes: str | None = None


class InstanceIn(InstanceFields):
    device_id: str = Field(pattern=r"^[A-Za-z0-9_.-]{1,80}$")


INSTANCE_COLUMNS = ("label", "device_type", "pod", "leaf_id", "options", "enabled",
                    "serial_number", "asset_tag", "station", "location", "installed_at", "notes")
# Changing any of these means the running parser container is stale.
PARSER_COLUMNS = {"device_type", "pod", "options"}


def get_type(code: str) -> dict[str, Any]:
    row = db.fetch_one("SELECT * FROM gateway_device_type WHERE code=%s", (code,))
    if row is None:
        raise HTTPException(404, f"unknown device type {code}; sync from Haber first")
    return row


def start_instance(device_id: str) -> dict[str, Any]:
    instance = db.instance_row(db.fetch_one("SELECT * FROM gateway_device_instance WHERE device_id=%s", (device_id,)))
    container_id = docker_ops.start_parser(instance, get_type(instance["device_type"]))
    db.execute("UPDATE gateway_device_instance SET container_id=%s, updated_at=%s WHERE device_id=%s",
               (container_id, db.now_ms(), device_id))
    return {"device_id": device_id, "container_id": container_id}


def reconcile() -> dict[str, Any]:
    """Parser containers follow the instance table, the license and the device type's image."""
    states = docker_ops.parser_states()
    licensed = license_state()["valid"]
    started, stopped, upgraded = [], [], []
    for instance in db.fetch_all("SELECT * FROM gateway_device_instance"):
        state = states.get(instance["device_id"], {})
        running = state.get("status") == "running"
        wanted = instance["enabled"] and licensed
        if wanted and running and not upgraded:
            # A newly approved gateway release pins a new parser image: replace one parser per
            # cycle so a bad image takes down one device feed, not all of them at once.
            device_type = db.fetch_one("SELECT image FROM gateway_device_type WHERE code=%s", (instance["device_type"],))
            if device_type and state.get("image_ref") and state["image_ref"] != device_type["image"]:
                try:
                    start_instance(instance["device_id"])
                    upgraded.append(instance["device_id"])
                    log.info("parser %s now on %s", instance["device_id"], device_type["image"])
                except Exception as error:
                    log.warning("cannot upgrade %s: %s", instance["device_id"], error)
        if wanted and not running:
            try:
                start_instance(instance["device_id"])
                started.append(instance["device_id"])
            except Exception as error:
                log.warning("cannot start %s: %s", instance["device_id"], error)
        elif not wanted and instance["device_id"] in states:
            docker_ops.stop_parser(instance["device_id"])
            stopped.append(instance["device_id"])
    return {"started": started, "stopped": stopped, "upgraded": upgraded, "licensed": licensed}


def seed_instances() -> bool:
    """Creates demo/site instances from FLORA_GATEWAY_SEED once their types exist."""
    path = Path(settings.SEED_PATH)
    if not path.exists():
        return True
    pending = False
    for item in json.loads(path.read_text()):
        if db.fetch_one("SELECT 1 FROM gateway_device_instance WHERE device_id=%s", (item["device_id"],)):
            continue
        if not db.fetch_one("SELECT 1 FROM gateway_device_type WHERE code=%s", (item["device_type"],)):
            pending = True
            continue
        insert_instance(InstanceIn(**item))
        log.info("seeded device instance %s", item["device_id"])
    return not pending


def instance_values(payload: InstanceFields) -> list[Any]:
    data = payload.model_dump()
    return [Jsonb(data[column]) if column == "options" else data[column] for column in INSTANCE_COLUMNS]


def insert_instance(payload: InstanceIn) -> None:
    current = db.now_ms()
    columns = ("device_id", *INSTANCE_COLUMNS, "created_at", "updated_at")
    db.execute(
        f"INSERT INTO gateway_device_instance ({','.join(columns)}) VALUES ({','.join(['%s'] * len(columns))})",
        (payload.device_id, *instance_values(payload), current, current),
    )


@app.get("/api/instances")
def list_instances():
    states = docker_ops.parser_states()
    rows = [db.instance_row(row) for row in db.fetch_all("SELECT * FROM gateway_device_instance ORDER BY device_id")]
    for row in rows:
        row["container"] = states.get(row["device_id"])
    return {"rows": rows}


@app.post("/api/instances", dependencies=[Depends(require_admin)], status_code=201)
def create_instance(payload: InstanceIn):
    get_type(payload.device_type)
    if db.fetch_one("SELECT 1 FROM gateway_device_instance WHERE device_id=%s", (payload.device_id,)):
        raise HTTPException(409, "device_id already exists")
    check_license(payload.device_type, adding=payload.enabled)
    insert_instance(payload)
    return start_instance(payload.device_id) if payload.enabled else {"device_id": payload.device_id}


@app.put("/api/instances/{device_id}", dependencies=[Depends(require_admin)])
def update_instance(device_id: str, payload: InstanceFields):
    row = db.fetch_one("SELECT * FROM gateway_device_instance WHERE device_id=%s", (device_id,))
    if row is None:
        raise HTTPException(404, "device not found")
    current = db.instance_row(row)
    get_type(payload.device_type)
    if payload.enabled:
        check_license(payload.device_type, adding=not current["enabled"])
    db.execute(
        f"UPDATE gateway_device_instance SET {', '.join(c + '=%s' for c in INSTANCE_COLUMNS)}, updated_at=%s "
        "WHERE device_id=%s",
        (*instance_values(payload), db.now_ms(), device_id),
    )
    changed = {column for column in PARSER_COLUMNS if getattr(payload, column) != current[column]}
    if payload.enabled and changed:
        return {**start_instance(device_id), "restarted_for": sorted(changed)}
    return {"device_id": device_id, **reconcile()}


@app.post("/api/instances/{device_id}/restart", dependencies=[Depends(require_admin)])
def restart_instance(device_id: str):
    instance = db.fetch_one("SELECT device_type FROM gateway_device_instance WHERE device_id=%s", (device_id,))
    if instance is None:
        raise HTTPException(404, "device not found")
    check_license(instance["device_type"], adding=False)
    return start_instance(device_id)


@app.post("/api/instances/{device_id}/enabled/{enabled}", dependencies=[Depends(require_admin)])
def set_enabled(device_id: str, enabled: bool):
    instance = db.fetch_one("SELECT device_type, enabled FROM gateway_device_instance WHERE device_id=%s", (device_id,))
    if instance is None:
        raise HTTPException(404, "device not found")
    if enabled and not instance["enabled"]:
        check_license(instance["device_type"], adding=True)
    db.execute("UPDATE gateway_device_instance SET enabled=%s, updated_at=%s WHERE device_id=%s",
               (enabled, db.now_ms(), device_id))
    return reconcile()


@app.delete("/api/instances/{device_id}", dependencies=[Depends(require_admin)])
def delete_instance(device_id: str):
    docker_ops.stop_parser(device_id)
    db.execute("DELETE FROM gateway_device_instance WHERE device_id=%s", (device_id,))
    return {"deleted": device_id}


@app.post("/api/instances/reconcile", dependencies=[Depends(require_admin)])
def reconcile_now():
    return reconcile()


# ------------------------------------------------------------------ manufacturers + device types

CODE_PATTERN = r"^[a-z0-9][a-z0-9_.-]{0,63}$"


class ManufacturerIn(BaseModel):
    code: str = Field(pattern=CODE_PATTERN)
    name: str = Field(min_length=1)
    country: str | None = None
    website: str | None = None
    support_contact: str | None = None
    notes: str | None = None


MANUFACTURER_COLUMNS = ("name", "country", "website", "support_contact", "notes")


@app.get("/api/manufacturers")
def list_manufacturers():
    return {"rows": db.fetch_all(
        """SELECT m.*, (SELECT count(*) FROM gateway_device_type t WHERE t.manufacturer = m.code) AS device_types
           FROM gateway_device_manufacturer m ORDER BY m.name""")}


@app.post("/api/manufacturers", dependencies=[Depends(require_admin), Depends(auth.require_role_admin)], status_code=201)
def create_manufacturer(payload: ManufacturerIn):
    if db.fetch_one("SELECT 1 FROM gateway_device_manufacturer WHERE code=%s", (payload.code,)):
        raise HTTPException(409, "manufacturer code already exists")
    current = db.now_ms()
    db.execute(
        f"""INSERT INTO gateway_device_manufacturer (code,{','.join(MANUFACTURER_COLUMNS)},created_at,updated_at)
            VALUES ({','.join(['%s'] * (len(MANUFACTURER_COLUMNS) + 3))})""",
        (payload.code, *(getattr(payload, c) for c in MANUFACTURER_COLUMNS), current, current))
    return {"code": payload.code}


@app.put("/api/manufacturers/{code}", dependencies=[Depends(require_admin), Depends(auth.require_role_admin)])
def update_manufacturer(code: str, payload: ManufacturerIn):
    if not db.fetch_one("SELECT 1 FROM gateway_device_manufacturer WHERE code=%s", (code,)):
        raise HTTPException(404, "manufacturer not found")
    if payload.code != code and db.fetch_one("SELECT 1 FROM gateway_device_manufacturer WHERE code=%s",
                                             (payload.code,)):
        raise HTTPException(409, "manufacturer code already exists")
    db.execute(
        f"""UPDATE gateway_device_manufacturer SET code=%s, {', '.join(c + '=%s' for c in MANUFACTURER_COLUMNS)},
            updated_at=%s WHERE code=%s""",
        (payload.code, *(getattr(payload, c) for c in MANUFACTURER_COLUMNS), db.now_ms(), code))
    return {"code": payload.code}


@app.delete("/api/manufacturers/{code}", dependencies=[Depends(require_admin), Depends(auth.require_role_admin)])
def delete_manufacturer(code: str):
    used = db.fetch_one("SELECT count(*) AS n FROM gateway_device_type WHERE manufacturer=%s", (code,))["n"]
    if used:
        raise HTTPException(409, f"{used} device type(s) still use this manufacturer")
    db.execute("DELETE FROM gateway_device_manufacturer WHERE code=%s", (code,))
    return {"deleted": code}


class DeviceTypeIn(BaseModel):
    code: str = Field(pattern=CODE_PATTERN)
    label: str = Field(min_length=1)
    manufacturer: str | None = None
    model: str | None = None
    description: str | None = None
    category: str = "device"
    protocol: str = Field(min_length=1)
    controller: str = Field(pattern=r"^(serial|feeder|webhook|socket)$")
    parser: str = Field(min_length=1)
    image: str | None = None
    default_options: dict[str, Any] = {}
    connection_defaults: dict[str, Any] = {}


# Haber owns the connection fields of synced types and rewrites them on every check-in,
# so only the descriptive fields of those types are edited here.
HABER_EDITABLE = ("manufacturer", "model", "description", "connection_defaults")
TYPE_COLUMNS = ("label", "manufacturer", "model", "description", "category", "protocol", "controller", "parser",
                "image", "default_options", "connection_defaults")
JSON_TYPE_COLUMNS = {"default_options", "connection_defaults"}


def parser_images() -> list[dict[str, Any]]:
    # The image most Canopy types run on comes first, so it is the default for a new template.
    rows = db.fetch_all("""SELECT i.*, (SELECT count(*) FROM gateway_device_type t
                                        WHERE t.image = i.image AND t.source = 'haber') AS used_by
                           FROM gateway_parser_image i ORDER BY used_by DESC, i.image""")
    if rows:
        return rows
    # Before the first Canopy sync only the gateway's configured image is known.
    return [{"image": settings.PARSER_IMAGE, "version": None, "registry": "local", "parsers": [], "release_id": None,
             "synced_at": None}]


def check_image(payload: DeviceTypeIn) -> None:
    """Local templates must run on an image Canopy delivered, with a parser that image contains."""
    images = {row["image"]: row for row in parser_images()}
    image = payload.image or settings.PARSER_IMAGE
    if image not in images:
        raise HTTPException(422, f"image {image} was not delivered by Canopy; choose one of: {', '.join(images)}")
    if images[image]["parsers"] and payload.parser not in images[image]["parsers"]:
        raise HTTPException(422, f"image {image} has no parser {payload.parser}; available: "
                                 f"{', '.join(images[image]['parsers'])}")
    payload.image = image


@app.get("/api/parser-images")
def list_parser_images():
    return {"rows": parser_images(), "haber": STATE["haber"]}


def check_manufacturer(code: str | None) -> None:
    if code and not db.fetch_one("SELECT 1 FROM gateway_device_manufacturer WHERE code=%s", (code,)):
        raise HTTPException(422, f"unknown manufacturer {code}")


def type_values(payload: DeviceTypeIn, columns: tuple[str, ...]) -> list[Any]:
    data = {**payload.model_dump(), "image": payload.image or settings.PARSER_IMAGE}
    return [Jsonb(data[c]) if c in JSON_TYPE_COLUMNS else data[c] for c in columns]


def clean_connection(payload: DeviceTypeIn, controller: str) -> None:
    try:
        payload.connection_defaults = connection.validate(controller, payload.connection_defaults)
    except ValueError as error:
        raise HTTPException(422, str(error)) from None


@app.get("/api/device-types")
def device_types():
    return {"rows": db.fetch_all(
        """SELECT t.*, m.name AS manufacturer_name,
                  (SELECT count(*) FROM gateway_device_instance i WHERE i.device_type = t.code) AS instances
           FROM gateway_device_type t LEFT JOIN gateway_device_manufacturer m ON m.code = t.manufacturer
           ORDER BY m.name NULLS LAST, t.label""")}


@app.post("/api/device-types", dependencies=[Depends(require_admin), Depends(auth.require_role_admin)], status_code=201)
def create_device_type(payload: DeviceTypeIn):
    if db.fetch_one("SELECT 1 FROM gateway_device_type WHERE code=%s", (payload.code,)):
        raise HTTPException(409, "device type code already exists")
    check_manufacturer(payload.manufacturer)
    clean_connection(payload, payload.controller)
    check_image(payload)
    db.execute(
        f"""INSERT INTO gateway_device_type (code,{','.join(TYPE_COLUMNS)},source,synced_at)
            VALUES ({','.join(['%s'] * (len(TYPE_COLUMNS) + 3))})""",
        (payload.code, *type_values(payload, TYPE_COLUMNS), "local", db.now_ms()))
    db.execute("UPDATE gateway_device_type SET origin='gateway' WHERE code=%s", (payload.code,))
    return {"code": payload.code}


@app.put("/api/device-types/{code}", dependencies=[Depends(require_admin), Depends(auth.require_role_admin)])
def update_device_type(code: str, payload: DeviceTypeIn):
    if payload.code != code:
        raise HTTPException(422, "device type code cannot be changed")
    current = get_type(code)
    check_manufacturer(payload.manufacturer)
    # Haber types keep their controller, so their defaults are checked against it.
    clean_connection(payload, current["controller"] if current["source"] == "haber" else payload.controller)
    if current["source"] != "haber":
        check_image(payload)
    columns = HABER_EDITABLE if current["source"] == "haber" else TYPE_COLUMNS
    db.execute(f"UPDATE gateway_device_type SET {', '.join(c + '=%s' for c in columns)} WHERE code=%s",
               (*type_values(payload, columns), code))
    return {"code": code, "updated": list(columns)}


@app.delete("/api/device-types/{code}", dependencies=[Depends(require_admin), Depends(auth.require_role_admin)])
def delete_device_type(code: str):
    current = get_type(code)
    if current["source"] == "haber":
        raise HTTPException(409, "device types synced from Haber are managed at Canopy")
    used = db.fetch_one("SELECT count(*) AS n FROM gateway_device_instance WHERE device_type=%s", (code,))["n"]
    if used:
        raise HTTPException(409, f"{used} installed device(s) still use this type")
    db.execute("DELETE FROM gateway_device_type WHERE code=%s", (code,))
    return {"deleted": code}


# ------------------------------------------------------------------ controllers + config

@app.get("/api/controllers")
async def controllers():
    async with httpx.AsyncClient(timeout=2) as client:
        async def one(name: str, url: str):
            try:
                response = await client.get(f"{url}/status")
                return name, {"reachable": True, **response.json()}
            except Exception as error:
                return name, {"reachable": False, "error": str(error), "pods": []}
        results = dict(await asyncio.gather(*(one(name, url) for name, url in settings.CONTROLLERS.items())))
    states = await asyncio.to_thread(docker_ops.service_states)
    for name, result in results.items():
        result["container_status"] = states.get(name)
        result["ingress"] = name in settings.INGRESS
    return results


def controller_parsers(service: str) -> list[dict[str, Any]]:
    """Device instances whose pod belongs to this ingress controller, with their parser state."""
    states = docker_ops.parser_states()
    rows = db.fetch_all("SELECT device_id, label, pod, enabled FROM gateway_device_instance WHERE pod LIKE %s "
                        "ORDER BY device_id", (settings.INGRESS[service] + ".%",))
    for row in rows:
        row["parser_status"] = states.get(row["device_id"], {}).get("status")
    return rows


def check_ingress(service: str) -> None:
    if service not in settings.INGRESS:
        raise HTTPException(404, "only ingress controllers can be stopped or started")


@app.get("/api/controllers/{service}/usage")
def controller_usage(service: str):
    check_ingress(service)
    return {"service": service, "devices": controller_parsers(service)}


@app.post("/api/controllers/{service}/stop", dependencies=[Depends(require_admin)])
def stop_controller(service: str, request: Request, force: bool = False):
    """Refuses with 409 while parsers on this controller's pods are running, unless force=true."""
    check_ingress(service)
    running = [d for d in controller_parsers(service) if d["parser_status"] == "running"]
    if running and not force:
        raise HTTPException(409, {"message": f"{len(running)} parser(s) are still running on {service}",
                                  "running": running})
    try:
        stopped = docker_ops.stop_service(service)
    except LookupError as error:
        raise HTTPException(404, str(error)) from None
    log.warning("ingress %s stopped by %s%s", service, request.state.user["username"],
                f" with {len(running)} parser(s) running" if running else "")
    return {"stopped": stopped, "running_parsers": [d["device_id"] for d in running]}


@app.post("/api/controllers/{service}/start", dependencies=[Depends(require_admin)])
def start_controller(service: str):
    check_ingress(service)
    try:
        return {"started": docker_ops.start_service(service)}
    except LookupError as error:
        raise HTTPException(404, str(error)) from None


@app.post("/api/controllers/{service}/restart", dependencies=[Depends(require_admin)])
def restart_controller(service: str):
    if service not in settings.CONTROLLERS and service != "server":
        raise HTTPException(404, "unknown controller")
    try:
        return {"restarted": docker_ops.restart_service(service)}
    except LookupError as error:
        raise HTTPException(404, str(error)) from None


def read_config() -> dict[str, Any]:
    return tomllib.loads(Path(settings.CONFIG_PATH).read_text())


@app.get("/api/config")
def get_config():
    return read_config()


@app.put("/api/config/{section}", dependencies=[Depends(require_admin)])
def put_config(section: str, body: dict[str, Any], restart: bool = True):
    """Replaces one controller section (e.g. its `pods` list) and restarts it."""
    if section not in settings.CONFIG_SECTIONS:
        raise HTTPException(404, "unknown config section")
    config = read_config()
    config[section] = {**config.get(section, {}), **body}
    path = Path(settings.CONFIG_PATH)
    path.write_text(tomli_w.dumps(config))
    restarted = docker_ops.restart_service(settings.CONFIG_SECTIONS[section]) if restart else None
    return {"section": section, "config": config[section], "restarted": restarted}


# ------------------------------------------------------------------ live streams

def configured_pods() -> list[str]:
    try:
        config = read_config()
    except Exception:
        return []
    return [f"{section}.{pod['id']}" for section in settings.INGRESS.values()
            for pod in config.get(section, {}).get("pods", []) if pod.get("enabled", True)]


def window_arg(window: int) -> int:
    return max(30, min(window, WINDOW_SEC))


@app.get("/api/streams")
def list_streams(window: int = 300):
    """Every configured or active ingress pod with its rate and per-second series."""
    window = window_arg(window)
    devices: dict[str, list[str]] = {}
    for row in db.fetch_all("SELECT device_id, pod FROM gateway_device_instance ORDER BY device_id"):
        devices.setdefault(row["pod"], []).append(row["device_id"])
    names = sorted(set(configured_pods()) | set(monitor.pods))
    return {"monitor": monitor.status, "window": window, "now": db.now_ms(),
            "streams": [{**monitor.pod(name).summary(window), "devices": devices.get(name, []),
                         "configured": name in set(configured_pods())} for name in names]}


@app.get("/api/streams/{pod:path}")
def stream_detail(pod: str, window: int = 300, after: int = 0, limit: int = 100):
    """One pod's series plus its recent frames (newest first); `after` returns only frames with a larger id."""
    if pod not in monitor.pods and pod not in configured_pods():
        raise HTTPException(404, "unknown stream")
    stream = monitor.pod(pod)
    frames = [frame for frame in stream.recent if frame["id"] > after][-max(1, min(limit, 200)):]
    return {**stream.summary(window_arg(window)), "frames": frames[::-1], "monitor": monitor.status}


# ------------------------------------------------------------------ device commands

class CommandIn(BaseModel):
    payload: str
    encoding: str = "utf8"
    connection: int | None = None


@app.post("/api/pods/{pod}/command", dependencies=[Depends(require_admin)])
async def send_command(pod: str, body: CommandIn):
    if STATE["producer"] is None:
        producer = AIOKafkaProducer(bootstrap_servers=settings.KAFKA_BROKERS,
                                    value_serializer=lambda value: json.dumps(value).encode())
        await producer.start()
        STATE["producer"] = producer
    topic = "gw.cmd." + "".join(c if c.isalnum() or c in "._-" else "_" for c in pod)
    meta = {"connection": body.connection} if body.connection else {}
    await STATE["producer"].send_and_wait(topic, {"pod": pod, "encoding": body.encoding, "payload": body.payload,
                                                  "meta": meta, "issued_at": db.now_ms()})
    return {"sent": True, "topic": topic}


# ------------------------------------------------------------------ site (where this gateway is installed)

SITE_COLUMNS = ("display_name", "hospital", "building", "floor", "unit", "unit_type", "room", "contact", "notes")


class SiteIn(BaseModel):
    display_name: str | None = Field(default=None, max_length=120)
    hospital: str | None = Field(default=None, max_length=120)
    building: str | None = Field(default=None, max_length=120)
    floor: str | None = Field(default=None, max_length=40)
    unit: str | None = Field(default=None, max_length=80)
    unit_type: str | None = Field(default=None, pattern=r"^(or|icu|er|ward|other)$")
    room: str | None = Field(default=None, max_length=80)
    contact: str | None = Field(default=None, max_length=200)
    notes: str | None = None


def site_row() -> dict[str, Any]:
    return db.fetch_one("SELECT * FROM gateway_site WHERE id=1") or {}


def site_label(site: dict[str, Any]) -> str:
    """Short name for tabs and headers: the display name, else unit + room."""
    return site.get("display_name") or " · ".join(v for v in (site.get("unit"), site.get("room")) if v) or ""


@app.get("/api/site")
def get_site():
    site = site_row()
    license_ = db.fetch_one("SELECT tenant_id FROM gateway_license WHERE id=1") or {}
    return {**site, "gateway_id": settings.GATEWAY_ID, "tenant_id": license_.get("tenant_id"), "label": site_label(site)}


@app.get("/api/site/label")
def get_site_label():
    """Public: lets the sign-in page show which station this is. Only the ID and location name."""
    return {"gateway_id": settings.GATEWAY_ID, "label": site_label(site_row())}


@app.put("/api/site", dependencies=[Depends(require_admin), Depends(auth.require_role_admin)])
def put_site(payload: SiteIn, request: Request):
    db.execute(
        f"""UPDATE gateway_site SET {', '.join(c + '=%s' for c in SITE_COLUMNS)}, updated_at=%s, updated_by=%s
            WHERE id=1""",
        (*(getattr(payload, c) for c in SITE_COLUMNS), db.now_ms(), request.state.user["username"]))
    return get_site()


# ------------------------------------------------------------------ sign-in + users

class LoginIn(BaseModel):
    username: str
    password: str


@app.post("/api/auth/login")
def login(payload: LoginIn, response: Response):
    user = auth.authenticate(payload.username.strip(), payload.password)
    if user is None:
        raise HTTPException(401, "wrong username or password")
    response.set_cookie(auth.COOKIE, auth.create_session(user["id"]), max_age=settings.SESSION_HOURS * 3600,
                        httponly=True, samesite="strict", path="/")
    return {"username": user["username"], "display_name": user["display_name"]}


@app.post("/api/auth/logout")
def logout(request: Request, response: Response):
    auth.end_session(request.cookies.get(auth.COOKIE))
    response.delete_cookie(auth.COOKIE, path="/")
    return {"signed_out": True}


@app.get("/api/auth/me")
def me(request: Request):
    return request.state.user


class PasswordIn(BaseModel):
    current_password: str
    new_password: str = Field(min_length=6)


@app.post("/api/auth/password")
def change_password(payload: PasswordIn, request: Request):
    user = db.fetch_one("SELECT * FROM gateway_user WHERE id=%s", (request.state.user["id"],))
    if not auth.verify_password(payload.current_password, user["password_hash"]):
        raise HTTPException(403, "current password is wrong")
    db.execute("UPDATE gateway_user SET password_hash=%s, updated_at=%s WHERE id=%s",
               (auth.hash_password(payload.new_password), db.now_ms(), user["id"]))
    auth.end_user_sessions(user["id"], keep_token=request.cookies.get(auth.COOKIE))
    return {"changed": True}


class UserIn(BaseModel):
    username: str = Field(pattern=r"^[A-Za-z0-9_.@-]{2,64}$")
    password: str | None = Field(default=None, min_length=6)
    display_name: str | None = None
    enabled: bool = True
    role: str = Field(default="operator", pattern=r"^(admin|operator)$")


@app.get("/api/users", dependencies=[Depends(auth.require_role_admin)])
def list_users():
    return {"rows": db.fetch_all(
        "SELECT id, username, display_name, role, enabled, created_at, last_login_at FROM gateway_user ORDER BY username")}


@app.post("/api/users", status_code=201, dependencies=[Depends(auth.require_role_admin)])
def create_user(payload: UserIn):
    if not payload.password:
        raise HTTPException(422, "password is required")
    if db.fetch_one("SELECT 1 FROM gateway_user WHERE username=%s", (payload.username,)):
        raise HTTPException(409, "username already exists")
    current = db.now_ms()
    db.execute("""INSERT INTO gateway_user (username,password_hash,display_name,role,enabled,created_at,updated_at)
                  VALUES (%s,%s,%s,%s,%s,%s,%s)""",
               (payload.username, auth.hash_password(payload.password), payload.display_name, payload.role,
                payload.enabled, current, current))
    return {"username": payload.username}


def other_enabled_admins(user_id: int) -> int:
    return db.fetch_one("SELECT count(*) AS n FROM gateway_user WHERE enabled AND role='admin' AND id<>%s",
                        (user_id,))["n"]


@app.put("/api/users/{user_id}", dependencies=[Depends(auth.require_role_admin)])
def update_user(user_id: int, payload: UserIn):
    if not db.fetch_one("SELECT 1 FROM gateway_user WHERE id=%s", (user_id,)):
        raise HTTPException(404, "user not found")
    if db.fetch_one("SELECT 1 FROM gateway_user WHERE username=%s AND id<>%s", (payload.username, user_id)):
        raise HTTPException(409, "username already exists")
    if (not payload.enabled or payload.role != "admin") and not other_enabled_admins(user_id):
        raise HTTPException(409, "at least one enabled admin must remain")
    db.execute("UPDATE gateway_user SET username=%s, display_name=%s, role=%s, enabled=%s, updated_at=%s WHERE id=%s",
               (payload.username, payload.display_name, payload.role, payload.enabled, db.now_ms(), user_id))
    if payload.password:
        db.execute("UPDATE gateway_user SET password_hash=%s WHERE id=%s", (auth.hash_password(payload.password), user_id))
    if payload.password or not payload.enabled:
        auth.end_user_sessions(user_id)
    # Sessions read the role on every request, so a role change applies immediately.
    return {"id": user_id}


@app.delete("/api/users/{user_id}", dependencies=[Depends(auth.require_role_admin)])
def delete_user(user_id: int, request: Request):
    if user_id == request.state.user["id"]:
        raise HTTPException(409, "you cannot delete your own account")
    if not other_enabled_admins(user_id):
        raise HTTPException(409, "at least one enabled admin must remain")
    db.execute("DELETE FROM gateway_user WHERE id=%s", (user_id,))
    return {"deleted": user_id}


# ------------------------------------------------------------------ read models

@app.get("/health")
def health():
    db.fetch_one("SELECT 1")
    return {"status": "OK", "component": "gateway-service", "gateway_id": settings.GATEWAY_ID}


@app.get("/api/license")
def license_info():
    return {**license_state(), "haber": STATE["haber"]}


@app.post("/api/haber/sync", dependencies=[Depends(require_admin)])
async def haber_sync():
    try:
        payload = await haber_checkin()
    except Exception as error:
        STATE["haber"].update(status="offline", error=str(error))
        raise HTTPException(502, f"haber unreachable: {error}") from None
    seed_instances()
    return {"device_types": len(payload.get("device_types") or []), "license": payload.get("license")}


@app.get("/api/logs")
def logs(limit: int = 100):
    return {"rows": db.fetch_all("SELECT * FROM gateway_log ORDER BY ts DESC LIMIT %s", (min(limit, 500),))}


@app.get("/api/devices/status")
async def devices_status():
    async with httpx.AsyncClient(timeout=3) as client:
        response = await client.get(f"{settings.DATA_SERVER_URL}/api/devices/status")
        return response.json()


@app.get("/api/devices/{device_id}/latest")
async def device_latest(device_id: str, seconds: int = 120):
    end = db.now_ms()
    async with httpx.AsyncClient(timeout=3) as client:
        response = await client.get(f"{settings.DATA_SERVER_URL}/api/observations",
                                    params={"from": end - seconds * 1000, "to": end + 1, "device_id": device_id})
        return response.json()


@app.get("/")
def index():
    return FileResponse(Path(__file__).parent / "static" / "index.html")


@app.get("/login")
def login_page(request: Request):
    if auth.resolve_user(request):
        return RedirectResponse("/", status_code=303)
    return FileResponse(Path(__file__).parent / "static" / "login.html")
