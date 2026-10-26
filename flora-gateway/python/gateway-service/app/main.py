"""Flora Gateway Service: station admin for devices, controllers and the license.

Device types and the gateway's device license come from Haber (in Flora Canopy).
Each enabled device instance runs as its own device-medical-service container.
Manufacturers, local device types and installed devices are edited on the admin page.
"""
from __future__ import annotations

import asyncio
import hashlib
import re
import json
import logging
import secrets
import tomllib
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Annotated, Any

import httpx
import tomli_w
import tomlkit
from aiokafka import AIOKafkaProducer
from fastapi import Depends, FastAPI, HTTPException, Request, Response
from fastapi.responses import FileResponse, RedirectResponse
from pydantic import AfterValidator, BaseModel, BeforeValidator, Field
from psycopg.types.json import Jsonb

from . import activity, alerts, auth, case_bindings, connection, db, docker_ops, settings
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
    load_canopy_link()
    auth.ensure_default_admin()
    task = asyncio.create_task(background_loop())
    sampler = asyncio.create_task(status_sampler())
    monitor.start()
    yield
    task.cancel()
    sampler.cancel()
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
        try:
            STATE["alerts_push"] = {**await alerts.push(), "at": db.now_ms(), "error": None}
        except Exception as error:  # Canopy unreachable: alerts stay queued and are resent next round
            STATE["alerts_push"] = {"sent": 0, "at": db.now_ms(), "error": str(error)}
        try:
            STATE["activity_push"] = {**await activity.push(), "at": db.now_ms(), "error": None}
        except Exception as error:  # kept and resent next round
            STATE["activity_push"] = {"sent": 0, "at": db.now_ms(), "error": str(error)}
        try:
            STATE["case_bindings_push"] = {**await case_bindings.push(), "at": db.now_ms(), "error": None}
        except Exception as error:  # kept and resent next round
            STATE["case_bindings_push"] = {"sent": 0, "at": db.now_ms(), "error": str(error)}
        await asyncio.sleep(settings.SYNC_INTERVAL_SEC)


# ------------------------------------------------------------------ status history

STATUS_SAMPLE_SEC = 30
STATUS_RETENTION_MS = 7 * 86_400_000
DATA_PURGE_BATCH = 20_000            # rows per delete, so the collector is never blocked for long


def purge_old_data(now: int) -> dict[str, int]:
    """Deletes stored observations and measurements older than GATEWAY_DATA_RETENTION_DAYS (0 = keep all)."""
    if settings.DATA_RETENTION_DAYS <= 0:
        return {}
    cutoff = now - settings.DATA_RETENTION_DAYS * 86_400_000
    removed: dict[str, int] = {}
    for table in ("gateway_observation", "gateway_measurement"):
        total = 0
        while True:
            with db.pool.connection() as connection:
                count = connection.execute(
                    f"DELETE FROM {table} WHERE id IN (SELECT id FROM {table} WHERE system_ts < %s LIMIT %s)",
                    (cutoff, DATA_PURGE_BATCH)).rowcount
            total += count
            if count < DATA_PURGE_BATCH:
                break
        if total:
            removed[table] = total
    if removed:
        log.info("retention (%s days): removed %s", settings.DATA_RETENTION_DAYS, removed)
    return removed
DEVICE_SILENT_MS = 120_000          # an enabled device with no data for this long counts as down
CONTROLLER_LABELS = {"serial-controller": "Serial (RS-232)", "feeder-controller": "Feeder (HTTP poll)",
                     "webhook-controller": "Webhook (HTTP push)", "socket-controller": "Socket (TCP/UDP)",
                     "collector": "Collector", "publisher": "Publisher", "stream-hub": "Stream hub (Leaf live)"}


async def sample_status() -> list[tuple[str, str, str | None]]:
    """One (lane, state, detail) row per part of the gateway, as it is right now."""
    rows: list[tuple[str, str, str | None]] = [("gateway", "ok", None)]
    haber, now = STATE["haber"], db.now_ms()
    if haber["status"] == "disabled":
        rows.append(("canopy", "stopped", "Haber URL not configured"))
    elif haber["status"] == "ok" and haber.get("last_sync") and now - haber["last_sync"] < 3 * settings.SYNC_INTERVAL_SEC * 1000:
        rows.append(("canopy", "ok", None))
    else:
        rows.append(("canopy", "down", haber.get("error") or f"no check-in since {haber.get('last_sync') or 'start'}"))
    pods: dict[str, bool] = {}
    pod_status: dict[str, dict[str, Any]] = {}
    for name, result in (await controllers()).items():
        if result.get("reachable") and name in settings.INGRESS:
            pods |= {pod["pod"]: bool(pod.get("connected")) for pod in result.get("pods") or [] if pod.get("pod")}
            pod_status |= {pod["pod"]: pod for pod in result.get("pods") or [] if pod.get("pod")}
        status = result.get("container_status")
        if status and status != "running":
            rows.append((f"controller:{name}", "stopped", f"container {status}"))
        elif result.get("reachable"):
            rows.append((f"controller:{name}", "ok", None))
        else:
            rows.append((f"controller:{name}", "down", str(result.get("error") or "unreachable")[:200]))
    seen = {r["device_id"]: r["last_seen_ts"] for r in db.fetch_all("SELECT device_id, last_seen_ts FROM gateway_device_seen")}
    tcp_open = open_tcp_peers(pod_status)
    for instance in db.fetch_all("SELECT device_id, enabled, pod, options FROM gateway_device_instance"):
        last = seen.get(instance["device_id"])
        # Network devices report a lost connection, unless their TCP session is still open (then: no data);
        # serial ones are switched off or unplugged.
        how = "network: " if instance["pod"].split(".", 1)[0] in ("socket", "webhook", "feeder") else ""
        source = (instance.get("options") or {}).get("source_ip")
        if how and source and source in tcp_open.get(instance["pod"], ()):
            how = "connected, "
        if not instance["enabled"]:
            rows.append((f"device:{instance['device_id']}", "stopped", "disabled"))
        elif last and now - last < DEVICE_SILENT_MS:
            rows.append((f"device:{instance['device_id']}", "ok", None))
        else:
            rows.append((f"device:{instance['device_id']}", "down",
                         how + (f"no data for {round((now - last) / 60000)} min" if last else "no data yet")))
    STATE["pods"] = pods
    return rows


async def status_sampler() -> None:
    await asyncio.sleep(5)   # let the first Haber check-in finish
    try:
        alerts.record_downtime(db.fetch_one("SELECT max(ts) AS ts FROM gateway_status_sample")["ts"], db.now_ms())
    except Exception as error:
        log.warning("downtime alert failed: %s", error)
    count = 0
    while True:
        try:
            now = db.now_ms()
            rows = await sample_status()
            try:
                labels = {f"device:{r['device_id']}": r["label"] or r["device_id"]
                          for r in db.fetch_all("SELECT device_id, label FROM gateway_device_instance")}
                labels |= {f"controller:{name}": label for name, label in CONTROLLER_LABELS.items()}
                alerts.observe(now, rows, labels)
            except Exception as error:
                log.warning("alert update failed: %s", error)
            try:
                activity.track(now, rows, STATE.get("pods") or {})
                await asyncio.to_thread(activity.rollup, now)
            except Exception as error:
                log.warning("device activity update failed: %s", error)
            with db.pool.connection() as connection:
                connection.cursor().executemany(
                    "INSERT INTO gateway_status_sample (ts, lane, state, detail) VALUES (%s,%s,%s,%s)",
                    [(now, lane, state, detail) for lane, state, detail in rows])
                if count % 120 == 0:
                    connection.execute("DELETE FROM gateway_status_sample WHERE ts < %s", (now - STATUS_RETENTION_MS,))
            if count % 120 == 0:   # hourly (and once at start)
                try:
                    await asyncio.to_thread(purge_old_data, now)
                except Exception as error:
                    log.warning("data retention failed: %s", error)
            count += 1
        except Exception as error:
            log.warning("status sample failed: %s", error)
        await asyncio.sleep(STATUS_SAMPLE_SEC)


@app.get("/api/alerts")
def list_alerts(status: str = "all", limit: int = 200):
    where = {"open": "WHERE resolved_at IS NULL", "resolved": "WHERE resolved_at IS NOT NULL"}.get(status, "")
    rows = db.fetch_all(f"SELECT * FROM gateway_alert {where} ORDER BY resolved_at IS NOT NULL, opened_at DESC LIMIT %s",
                        (max(1, min(limit, 1000)),))
    counts = db.fetch_one(
        """SELECT count(*) FILTER (WHERE resolved_at IS NULL) AS open,
                  count(*) FILTER (WHERE resolved_at IS NULL AND acknowledged_at IS NULL) AS unacknowledged,
                  count(*) FILTER (WHERE delivered_version < version) AS undelivered
           FROM gateway_alert""")
    return {"rows": rows, "counts": counts, "delivery": STATE.get("alerts_push"), "haber_url": bool(settings.HABER_URL)}


@app.post("/api/alerts/{alert_id}/ack")
def acknowledge_alert(alert_id: int, request: Request):
    if not alerts.acknowledge(alert_id, request.state.user["username"]):
        raise HTTPException(409, "alert not found or already acknowledged")
    return {"acknowledged": alert_id}


@app.post("/api/alerts/push", dependencies=[Depends(require_admin)])
async def push_alerts():
    try:
        STATE["alerts_push"] = {**await alerts.push(), "at": db.now_ms(), "error": None}
    except Exception as error:
        STATE["alerts_push"] = {"sent": 0, "at": db.now_ms(), "error": str(error)}
        raise HTTPException(502, f"Canopy did not accept the alerts: {error}") from None
    return STATE["alerts_push"]


# hours -> bucket size; each bucket holds several 30 s samples.
TIMELINE_BUCKETS = {1: 60_000, 6: 120_000, 24: 600_000}


def lane_label(lane: str, labels: dict[str, str]) -> tuple[str, str]:
    kind, _, name = lane.partition(":")
    if kind == "gateway":
        return "Gateway service", "gateway"
    if kind == "canopy":
        return "Canopy connection", "canopy"
    if kind == "controller":
        return CONTROLLER_LABELS.get(name, name), "controller"
    return labels.get(name) or name, "device"


@app.get("/api/status/timeline")
def status_timeline(hours: int = 6):
    """Per-lane state per bucket: down wins over ok, ok over stopped; 'none' = no sample.
    A bucket with no samples from any lane after recording began means gateway-service was down."""
    hours = hours if hours in TIMELINE_BUCKETS else 6
    bucket = TIMELINE_BUCKETS[hours]
    end = (db.now_ms() // bucket + 1) * bucket
    start = end - hours * 3_600_000
    samples = db.fetch_all("SELECT ts, lane, state, detail FROM gateway_status_sample WHERE ts >= %s ORDER BY ts",
                           (start,))
    first = db.fetch_one("SELECT min(ts) AS ts FROM gateway_status_sample")["ts"]
    n = (end - start) // bucket
    rank = {"none": 0, "stopped": 1, "ok": 2, "down": 3}
    lanes: dict[str, dict[str, Any]] = {}
    any_sample = [False] * n
    for row in samples:
        i = (row["ts"] - start) // bucket
        any_sample[i] = True
        lane = lanes.setdefault(row["lane"], {"states": ["none"] * n, "details": [None] * n})
        if rank[row["state"]] >= rank[lane["states"][i]]:
            lane["states"][i] = row["state"]
            lane["details"][i] = row["detail"] or lane["details"][i]
    gateway = lanes.setdefault("gateway", {"states": ["none"] * n, "details": [None] * n})
    for i in range(n):
        bucket_end = start + (i + 1) * bucket
        if not any_sample[i] and first is not None and bucket_end > first and start + i * bucket < db.now_ms() - bucket:
            gateway["states"][i], gateway["details"][i] = "down", "gateway service not running"
    labels = {r["device_id"]: r["label"] for r in db.fetch_all("SELECT device_id, label FROM gateway_device_instance")}
    order = {"gateway": 0, "canopy": 1, "controller": 2, "device": 3}
    out = []
    for lane, data in lanes.items():
        label, kind = lane_label(lane, labels)
        states = data["states"]
        incidents, i = [], 0
        while i < n:
            if states[i] == "down":
                j = i
                while j + 1 < n and states[j + 1] == "down":
                    j += 1
                incidents.append({"start": start + i * bucket, "end": min(start + (j + 1) * bucket, db.now_ms()),
                                  "detail": next((d for d in data["details"][i:j + 1] if d), None)})
                i = j + 1
            else:
                i += 1
        up, down = states.count("ok"), states.count("down")
        out.append({"lane": lane, "label": label, "kind": kind, "states": states, "details": data["details"],
                    "uptime": round(100 * up / (up + down), 1) if up + down else None, "incidents": incidents})
    out.sort(key=lambda r: (order[r["kind"]], r["label"]))
    return {"hours": hours, "start": start, "bucket_ms": bucket, "buckets": n, "recording_since": first, "lanes": out}


# ------------------------------------------------------------------ Haber + license

SECRET_OPTION = ("password", "secret", "token", "key", "credential")
MASK = "••••"


def masked_options(options: dict[str, Any]) -> dict[str, Any]:
    return {key: MASK if any(word in key.lower() for word in SECRET_OPTION) else value
            for key, value in options.items()}


def apply_canopy_config(config: dict[str, Any]) -> dict[str, Any]:
    """Make this gateway match a configuration stored in Canopy (clone, restore, new gateway).

    Secrets never leave a gateway, so masked option values keep this gateway's own
    value; a secret this gateway does not have yet is reported for manual entry.
    """
    version = int(config.get("version") or 0)
    if "site" in config:
        site = config.get("site") or {}
        db.execute(
            f"""UPDATE gateway_site SET {', '.join(c + '=%s' for c in SITE_COLUMNS)}, updated_at=%s, updated_by='canopy'
                WHERE id=1""",
            (*(site.get(c) for c in SITE_COLUMNS), db.now_ms()))
    if "devices" not in config:
        # Location set at Canopy: a site-only configuration never touches this gateway's devices.
        db.execute("UPDATE gateway_site SET canopy_config_version=%s WHERE id=1", (version,))
        result = {"version": version, "site_only": True, "at": db.now_ms()}
        log.info("applied Canopy location %s", version)
        return result
    wanted = {str(device["device_id"]): device for device in config.get("devices") or [] if device.get("device_id")}
    existing = {row["device_id"]: db.instance_row(row) for row in db.fetch_all("SELECT * FROM gateway_device_instance")}
    removed, applied, skipped, missing_secrets = [], [], [], []
    for device_id in set(existing) - set(wanted):
        docker_ops.stop_parser(device_id)
        db.execute("DELETE FROM gateway_device_instance WHERE device_id=%s", (device_id,))
        removed.append(device_id)
    for device_id, device in sorted(wanted.items()):
        if not db.fetch_one("SELECT 1 FROM gateway_device_type WHERE code=%s", (device.get("device_type"),)):
            skipped.append({"device_id": device_id, "reason": f"unknown device type {device.get('device_type')}"})
            continue
        options = dict(device.get("options") or {})
        own = (existing.get(device_id) or {}).get("options") or {}
        for key, value in list(options.items()):
            if value == MASK:
                if key in own:
                    options[key] = own[key]
                else:
                    options.pop(key)
                    missing_secrets.append(f"{device_id}.{key}")
        fields = InstanceFields(**{**{c: device.get(c) for c in INSTANCE_COLUMNS if c in device},
                                   "options": options, "enabled": bool(device.get("enabled", True))})
        if device_id in existing:
            db.execute(
                f"UPDATE gateway_device_instance SET {', '.join(c + '=%s' for c in INSTANCE_COLUMNS)}, updated_at=%s "
                "WHERE device_id=%s",
                (*instance_values(fields), db.now_ms(), device_id))
            if any(getattr(fields, c) != existing[device_id].get(c) for c in PARSER_COLUMNS):
                docker_ops.stop_parser(device_id)  # reconcile restarts it with the new settings
        else:
            insert_instance(InstanceIn(device_id=device_id, **fields.model_dump()))
        applied.append(device_id)
    db.execute("UPDATE gateway_site SET canopy_config_version=%s WHERE id=1", (version,))
    result = {"version": version, "applied": applied, "removed": removed, "skipped": skipped,
              "missing_secrets": missing_secrets, "at": db.now_ms()}
    log.info("applied Canopy configuration %s: %s", version, result)
    try:
        reconcile()
    except Exception as error:
        log.warning("reconcile after Canopy configuration failed: %s", error)
    return result


async def haber_checkin() -> dict[str, Any]:
    if not settings.HABER_URL:
        STATE["haber"].update(status="disabled", error=None)
        return {}
    # Full device configuration so Canopy can show what each gateway feeds and how it is set up.
    states = await asyncio.to_thread(docker_ops.parser_states)
    # Each device's live state (receiving / standby / unplugged …) and when it was last heard, so Canopy and
    # Root can show it down to the bed. Best effort: a failure here never blocks the check-in.
    try:
        live = {row["device_id"]: row for row in (await asyncio.to_thread(live_devices))["rows"]}
    except Exception as error:  # noqa: BLE001
        log.warning("live device state for check-in failed: %s", error)
        live = {}
    def live_state(device_id: str) -> dict[str, Any] | None:
        row = live.get(device_id)
        if not row:
            return None
        status = row.get("status") or {}
        return {"state": status.get("state"), "detail": status.get("detail"), "since": status.get("since"),
                "last_in_ts": (row.get("ingress") or {}).get("last_in_ts") or status.get("last_in_ts"),
                "last_value_ts": row.get("last_value_ts")}
    instances = [
        {**row, "options": masked_options(row.get("options") or {}),
         "parser_status": (states.get(row["device_id"]) or {}).get("status") or "absent",
         "live": live_state(row["device_id"])}
        for row in db.fetch_all(
            """SELECT device_id, device_type, leaf_id, pod, enabled, label, options, serial_number,
                      asset_tag, station, location, installed_at, notes, updated_at
               FROM gateway_device_instance ORDER BY device_id""")
    ]
    async with httpx.AsyncClient(timeout=5) as client:
        response = await client.post(
            f"{settings.HABER_URL}/api/haber/v1/gateways/{settings.GATEWAY_ID}/checkin",
            headers={"authorization": f"Bearer {settings.HABER_TOKEN}"},
            json={"gateway_id": settings.GATEWAY_ID, "version": "0.1.0", "devices": instances, "site": site_row(),
                  "applied_config_version": int(site_row().get("canopy_config_version") or 0),
                  "data_api_url": settings.DATA_API_PUBLIC_URL or None},
        )
        response.raise_for_status()
        payload = response.json()
    canopy_config = payload.get("canopy_config")
    if isinstance(canopy_config, dict) and int(canopy_config.get("version") or 0) > int(site_row().get("canopy_config_version") or 0):
        result = await asyncio.to_thread(apply_canopy_config, canopy_config)
        STATE["haber"].update(canopy_config=result)
    db.upsert_device_types(payload.get("device_types") or [], "haber")
    db.store_parser_images(payload.get("images") or [], payload.get("device_types") or [], payload.get("release_id"))
    if payload.get("license"):
        db.store_license(payload["license"], payload.get("tenant_id"))
    if isinstance(payload.get("leaf_tokens"), list):   # older appliances do not send it: keep what is there
        changed = db.sync_leaf_tokens(payload["leaf_tokens"])
        if changed["added"] or changed["revoked"]:
            log.info("leaf stream tokens from the appliance: %s", changed)
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


def type_line_settings(device_type: dict[str, Any]) -> dict[str, Any]:
    """Every setting the type's controller manages on a pod: the type's value, or None for "controller default"."""
    defaults = device_type.get("connection_defaults") or {}
    return {field: defaults.get(field) for field in connection.MODELS[device_type["controller"]].model_fields}


def apply_type_to_pod(pod: str, device_type_code: str, device_id: str | None) -> dict[str, Any]:
    """Makes the pod's line/framing settings follow the device type (the pod's port, path and address stay).

    Fields the type leaves unset are removed from the pod so the controller default applies. Refuses when another
    enabled device on the same pod needs different settings, since one port has one set of line settings.
    Rewrites only the changed keys (comments in the site config survive) and restarts the controller."""
    device_type = get_type(device_type_code)
    section, _, pod_id = pod.partition(".")
    if section != device_type["controller"]:
        raise HTTPException(422, f"{device_type_code} is a {device_type['controller']} device; pod {pod} belongs to "
                                 f"the {section} controller")
    wanted = type_line_settings(device_type)
    for other in db.fetch_all("SELECT device_id, device_type FROM gateway_device_instance "
                              "WHERE pod=%s AND enabled AND device_id IS DISTINCT FROM %s AND device_type <> %s",
                              (pod, device_id, device_type_code)):
        differ = sorted(k for k, v in type_line_settings(get_type(other["device_type"])).items() if v != wanted[k])
        if differ:
            raise HTTPException(409, f"pod {pod} is used by {other['device_id']} ({other['device_type']}), which needs "
                                     f"different {', '.join(differ)}; use another pod or disable that device first")
    path = Path(settings.CONFIG_PATH)
    document = tomlkit.parse(path.read_text())
    entry = next((p for p in document.get(section, {}).get("pods", []) if p.get("id") == pod_id), None)
    if entry is None:
        raise HTTPException(422, f"pod {pod} is not in {path.name}")
    changes: dict[str, Any] = {}
    for field, value in wanted.items():
        if value is None and field in entry:
            changes[field] = None
            del entry[field]
        elif value is not None and entry.get(field) != value:
            changes[field] = value
            entry[field] = value
    if not changes:
        return {"pod": pod, "changed": {}}
    path.write_text(tomlkit.dumps(document))
    try:
        restarted = docker_ops.restart_service(settings.CONFIG_SECTIONS[section])
    except LookupError:
        # Not a container (Windows: serial-controller runs natively); its operator restarts it.
        log.warning("pod %s now follows %s: %s; restart the native %s to apply", pod, device_type_code, changes,
                    settings.CONFIG_SECTIONS[section])
        return {"pod": pod, "changed": changes, "restarted": None,
                "restart_required": f"restart the native {settings.CONFIG_SECTIONS[section]}"}
    log.info("pod %s now follows %s: %s (restarted %s)", pod, device_type_code, changes, restarted)
    return {"pod": pod, "changed": changes, "restarted": restarted}


def is_demux(device_type: dict[str, Any] | None) -> bool:
    """Types whose instances share a pod run as one pod parser that splits frames by source_ip."""
    return bool(device_type and device_type.get("demux"))


def start_instance(device_id: str, force: bool = False) -> dict[str, Any]:
    instance = db.instance_row(db.fetch_one("SELECT * FROM gateway_device_instance WHERE device_id=%s", (device_id,)))
    device_type = get_type(instance["device_type"])
    if is_demux(device_type):
        # The pod's parser carries every instance on the pod; reconcile rebuilds it when they change.
        if force:
            docker_ops.stop_pod_parser(instance["pod"])
        return {"device_id": device_id, "pod_parser": docker_ops.pod_parser_name(instance["pod"]), **reconcile()}
    container_id = docker_ops.start_parser(instance, device_type)
    db.execute("UPDATE gateway_device_instance SET container_id=%s, updated_at=%s WHERE device_id=%s",
               (container_id, db.now_ms(), device_id))
    return {"device_id": device_id, "container_id": container_id}


def pod_device_map(members: list[tuple[dict[str, Any], dict[str, Any]]]) -> list[dict[str, Any]]:
    return sorted(({"device_id": instance["device_id"], "parser": device_type["parser"],
                    "options": {**(device_type.get("default_options") or {}), **(instance.get("options") or {})}}
                   for instance, device_type in members), key=lambda item: item["device_id"])


def reconcile() -> dict[str, Any]:
    """Parser containers follow the instance table, the license and the device type's image."""
    states = docker_ops.parser_states()
    pod_states = docker_ops.pod_parser_states()
    licensed = license_state()["valid"]
    types = {row["code"]: row for row in db.fetch_all("SELECT * FROM gateway_device_type")}
    started, stopped, upgraded = [], [], []
    pods: dict[str, list[tuple[dict[str, Any], dict[str, Any]]]] = {}
    for instance in db.fetch_all("SELECT * FROM gateway_device_instance"):
        device_type = types.get(instance["device_type"])
        state = states.get(instance["device_id"], {})
        wanted = instance["enabled"] and licensed
        if is_demux(device_type):
            if state and not state.get("pod"):
                # Left over from before the type ran as a pod parser.
                docker_ops.stop_parser(instance["device_id"])
                stopped.append(instance["device_id"])
            if wanted:
                pods.setdefault(instance["pod"], []).append((db.instance_row(instance), device_type))
            continue
        if state.get("pod"):
            state = {}   # the type stopped being demux; its pod parser goes below
        running = state.get("status") == "running"
        if wanted and running and not upgraded:
            # A newly approved gateway release pins a new parser image: replace one parser per
            # cycle so a bad image takes down one device feed, not all of them at once.
            # Replace the parser when the type now names another image, or when that image tag was rebuilt
            # (same name, new image ID) - otherwise a rebuilt parser image never reaches running devices.
            current = docker_ops.image_id(device_type["image"]) if device_type else None
            if device_type and state.get("image_ref") and (
                    state["image_ref"] != device_type["image"]
                    or (current and state.get("image_id") and state["image_id"] != current)):
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
        elif not wanted and state:
            docker_ops.stop_parser(instance["device_id"])
            stopped.append(instance["device_id"])
    for pod, members in sorted(pods.items()):
        device_map = pod_device_map(members)
        images = sorted({device_type["image"] for _, device_type in members})
        if len(images) > 1:
            log.warning("pod %s: device types use different images %s; using %s", pod, images, images[0])
        image = images[0]
        config_hash = hashlib.sha1(json.dumps(device_map, sort_keys=True).encode()).hexdigest()[:16]
        state = pod_states.get(pod) or {}
        try:
            if state.get("status") != "running" or state.get("config_hash") != config_hash:
                docker_ops.start_pod_parser(pod, image, device_map, config_hash)
                started.append(f"pod:{pod}")
                log.info("pod parser %s started for %s", pod, ", ".join(item["device_id"] for item in device_map))
            elif state.get("image_ref") != image and not upgraded:
                docker_ops.start_pod_parser(pod, image, device_map, config_hash)
                upgraded.append(f"pod:{pod}")
                log.info("pod parser %s now on %s", pod, image)
        except Exception as error:
            log.warning("cannot start pod parser %s: %s", pod, error)
    for pod in set(pod_states) - set(pods):
        docker_ops.stop_pod_parser(pod)
        stopped.append(f"pod:{pod}")
    return {"started": started, "stopped": stopped, "upgraded": upgraded, "licensed": licensed}


def seed_instances() -> bool:
    """Creates demo/site instances from FLORA_GATEWAY_SEED once their types exist."""
    path = Path(settings.SEED_PATH)
    if not path.exists() or int(site_row().get("canopy_config_version") or 0) > 0:
        return True  # a configuration from Canopy replaces the seed
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


UNREGISTERED_WINDOW_MS = 10 * 60 * 1000


@app.get("/api/pods/demux")
def demux_pods():
    """Pods parsed by one pod parser: the listener, its parser container, the sub devices
    (instances tagged by source_ip) and monitors heard on the pod that no instance claims."""
    pod_states = docker_ops.pod_parser_states()
    rows = db.fetch_all(
        "SELECT i.device_id, i.pod, i.device_type, i.options->>'source_ip' AS source_ip FROM gateway_device_instance i "
        "JOIN gateway_device_type t ON t.code = i.device_type WHERE t.demux ORDER BY i.device_id")
    pods: dict[str, dict[str, Any]] = {}
    for row in rows:
        pod = pods.setdefault(row["pod"], {"pod": row["pod"], "device_types": [], "devices": [], "unregistered": []})
        if row["device_type"] not in pod["device_types"]:
            pod["device_types"].append(row["device_type"])
        pod["devices"].append({"device_id": row["device_id"], "source_ip": row["source_ip"]})
    heard = db.fetch_all(
        "SELECT pod, detail->>'source_ip' AS source_ip, max(ts) AS last_seen FROM gateway_log "
        "WHERE detail->>'event' = 'unregistered_monitor' AND ts > %s GROUP BY 1, 2 ORDER BY 2",
        (db.now_ms() - UNREGISTERED_WINDOW_MS,))
    for row in heard:
        pod = pods.get(row["pod"])
        if pod and row["source_ip"] not in {d["source_ip"] for d in pod["devices"]}:
            pod["unregistered"].append({"source_ip": row["source_ip"], "last_seen": row["last_seen"]})
    for pod in pods.values():
        pod["container"] = pod_states.get(pod["pod"])
    return {"rows": sorted(pods.values(), key=lambda p: p["pod"])}


@app.post("/api/instances", dependencies=[Depends(require_admin)], status_code=201)
def create_instance(payload: InstanceIn):
    get_type(payload.device_type)
    if db.fetch_one("SELECT 1 FROM gateway_device_instance WHERE device_id=%s", (payload.device_id,)):
        raise HTTPException(409, "device_id already exists")
    check_license(payload.device_type, adding=payload.enabled)
    pod_settings = apply_type_to_pod(payload.pod, payload.device_type, payload.device_id) if payload.enabled else None
    insert_instance(payload)
    result = start_instance(payload.device_id) if payload.enabled else {"device_id": payload.device_id}
    return {**result, "pod_settings": pod_settings}


@app.put("/api/instances/{device_id}", dependencies=[Depends(require_admin)])
def update_instance(device_id: str, payload: InstanceFields):
    row = db.fetch_one("SELECT * FROM gateway_device_instance WHERE device_id=%s", (device_id,))
    if row is None:
        raise HTTPException(404, "device not found")
    current = db.instance_row(row)
    get_type(payload.device_type)
    pod_settings = None
    if payload.enabled:
        check_license(payload.device_type, adding=not current["enabled"])
        pod_settings = apply_type_to_pod(payload.pod, payload.device_type, device_id)
    db.execute(
        f"UPDATE gateway_device_instance SET {', '.join(c + '=%s' for c in INSTANCE_COLUMNS)}, updated_at=%s "
        "WHERE device_id=%s",
        (*instance_values(payload), db.now_ms(), device_id),
    )
    changed = {column for column in PARSER_COLUMNS if getattr(payload, column) != current[column]}
    if payload.enabled and changed:
        return {**start_instance(device_id), "restarted_for": sorted(changed), "pod_settings": pod_settings}
    return {"device_id": device_id, **reconcile(), "pod_settings": pod_settings}


@app.post("/api/instances/{device_id}/restart", dependencies=[Depends(require_admin)])
def restart_instance(device_id: str):
    instance = db.fetch_one("SELECT device_type FROM gateway_device_instance WHERE device_id=%s", (device_id,))
    if instance is None:
        raise HTTPException(404, "device not found")
    check_license(instance["device_type"], adding=False)
    return start_instance(device_id, force=True)


@app.post("/api/instances/{device_id}/enabled/{enabled}", dependencies=[Depends(require_admin)])
def set_enabled(device_id: str, enabled: bool):
    instance = db.fetch_one("SELECT device_type, pod, enabled FROM gateway_device_instance WHERE device_id=%s", (device_id,))
    if instance is None:
        raise HTTPException(404, "device not found")
    pod_settings = None
    if enabled and not instance["enabled"]:
        check_license(instance["device_type"], adding=True)
        pod_settings = apply_type_to_pod(instance["pod"], instance["device_type"], device_id)
    db.execute("UPDATE gateway_device_instance SET enabled=%s, updated_at=%s WHERE device_id=%s",
               (enabled, db.now_ms(), device_id))
    return {**reconcile(), "pod_settings": pod_settings}


@app.delete("/api/instances/{device_id}", dependencies=[Depends(require_admin)])
def delete_instance(device_id: str):
    docker_ops.stop_parser(device_id)
    row = db.fetch_one("SELECT t.demux FROM gateway_device_instance i JOIN gateway_device_type t ON t.code = i.device_type "
                       "WHERE i.device_id=%s", (device_id,))
    db.execute("DELETE FROM gateway_device_instance WHERE device_id=%s", (device_id,))
    if row and row["demux"]:
        reconcile()   # rebuilds (or stops) the pod parser without this device
    return {"deleted": device_id}


@app.post("/api/instances/reconcile", dependencies=[Depends(require_admin)])
def reconcile_now():
    return reconcile()


# ------------------------------------------------------------------ Leaf live stream (stream-hub)

class LeafTokenIn(BaseModel):
    leaf_id: str = Field(pattern=r"^[A-Za-z0-9_.-]{1,120}$")
    label: str | None = Field(default=None, max_length=120)


@app.get("/api/leaf-tokens")
def list_leaf_tokens():
    """Never returns a token; only its owner, label and state."""
    return {"rows": db.fetch_all(
        """SELECT t.id, t.leaf_id, t.label, t.created_at, t.created_by, t.revoked_at,
                  (SELECT count(*) FROM gateway_case_binding b WHERE b.leaf_id = t.leaf_id AND b.unbound_at IS NULL) AS open_bindings
           FROM gateway_leaf_token t ORDER BY t.revoked_at IS NOT NULL, t.leaf_id, t.created_at DESC""")}


@app.post("/api/leaf-tokens", dependencies=[Depends(require_admin), Depends(auth.require_role_admin)], status_code=201)
def create_leaf_token(payload: LeafTokenIn, request: Request):
    """The plaintext token is in this response only; the gateway keeps its sha256."""
    token = secrets.token_urlsafe(32)
    row = db.fetch_one(
        """INSERT INTO gateway_leaf_token (leaf_id, token_hash, label, created_by) VALUES (%s,%s,%s,%s)
           RETURNING id, leaf_id, label, created_at""",
        (payload.leaf_id, hashlib.sha256(token.encode()).hexdigest(), payload.label, request.state.user["username"]))
    log.info("leaf token %s issued for %s by %s", row["id"], payload.leaf_id, request.state.user["username"])
    return {**row, "token": token}


@app.post("/api/leaf-tokens/{token_id}/revoke", dependencies=[Depends(require_admin), Depends(auth.require_role_admin)])
def revoke_leaf_token(token_id: int, request: Request):
    """The stream hub re-checks tokens every few seconds and closes a revoked Leaf's bindings ('revoked')."""
    row = db.fetch_one("UPDATE gateway_leaf_token SET revoked_at = now() WHERE id=%s AND revoked_at IS NULL "
                       "RETURNING id, leaf_id, revoked_at", (token_id,))
    if row is None:
        raise HTTPException(409, "token not found or already revoked")
    log.info("leaf token %s (%s) revoked by %s", token_id, row["leaf_id"], request.state.user["username"])
    return row


@app.get("/api/case-bindings")
def list_case_bindings(open: bool = False, leaf_id: str | None = None, device_id: str | None = None,
                  case_uuid: str | None = None, limit: int = 200):
    """Audit of case UUID ↔ device bindings from the stream hub; open ones first."""
    where, params = [], []
    if open:
        where.append("b.unbound_at IS NULL")
    for column, value in (("b.leaf_id", leaf_id), ("b.device_id", device_id), ("b.case_uuid::text", case_uuid)):
        if value:
            where.append(f"{column} = %s")
            params.append(value)
    rows = db.fetch_all(
        f"""SELECT b.*, i.label AS device_label FROM gateway_case_binding b
            LEFT JOIN gateway_device_instance i ON i.device_id = b.device_id
            {'WHERE ' + ' AND '.join(where) if where else ''}
            ORDER BY b.unbound_at IS NOT NULL, b.bound_at DESC LIMIT %s""",
        (*params, max(1, min(limit, 1000))))
    counts = db.fetch_one("SELECT count(*) FILTER (WHERE unbound_at IS NULL) AS open, count(*) AS total FROM gateway_case_binding")
    return {"rows": rows, "counts": counts}


# ------------------------------------------------------------------ manufacturers + device types

CODE_PATTERN = r"^[a-z0-9][a-z0-9_.-]{0,63}$"


def check_code(value: str) -> str:
    if not re.fullmatch(CODE_PATTERN, value):
        raise ValueError("use 1–64 characters: letters, digits, dot, dash or underscore, starting with a letter or digit")
    return value


# Codes are stable lowercase IDs; "T200" or "Philips MX800" is accepted as "t200" / "philips-mx800".
Code = Annotated[str, BeforeValidator(lambda v: re.sub(r"\s+", "-", str(v).strip()).lower()), AfterValidator(check_code)]


class ManufacturerIn(BaseModel):
    code: Code
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
    code: Code
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
    return {"code": code, "updated": list(columns), **apply_type_to_devices(code, current)}


def apply_type_to_devices(code: str, before: dict[str, Any]) -> dict[str, Any]:
    """After a type edit, its enabled devices follow it: their pods take the new line settings and their parsers
    restart when the parser, image or default options changed. Problems are reported, not raised."""
    after = get_type(code)
    parser_changed = any(before.get(k) != after.get(k) for k in ("parser", "image", "default_options"))
    pods, restarted, problems = [], [], []
    for instance in db.fetch_all("SELECT device_id, pod FROM gateway_device_instance WHERE device_type=%s AND enabled "
                                 "ORDER BY device_id", (code,)):
        try:
            result = apply_type_to_pod(instance["pod"], code, instance["device_id"])
            if result.get("changed"):
                pods.append(result)
            if parser_changed and license_state()["valid"]:
                start_instance(instance["device_id"])
                restarted.append(instance["device_id"])
        except HTTPException as error:
            problems.append(f"{instance['device_id']}: {error.detail}")
        except Exception as error:  # docker or config trouble on one device must not hide the others
            problems.append(f"{instance['device_id']}: {error}")
    return {"pod_settings": pods, "restarted_parsers": restarted, "problems": problems}


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


# ------------------------------------------------------------------ device monitor

# hours -> bucket size: per minute for the last hour, 5 min for 6 h, 15 min for a day.
MONITOR_BUCKETS = {1: 60_000, 6: 300_000, 24: 900_000}


def bucket_counts(table: str, device_id: str, start: int, bucket: int) -> dict[int, int]:
    try:
        rows = db.fetch_all(
            f"SELECT (system_ts / %s) * %s AS t, count(*) AS n FROM {table} "
            "WHERE device_id=%s AND system_ts >= %s GROUP BY 1",
            (bucket, bucket, device_id, start))
    except Exception:  # gateway_measurement is missing on gateways created before it existed
        return {}
    return {int(row["t"]): row["n"] for row in rows}


@app.get("/api/devices/{device_id}/monitor")
def device_monitor(device_id: str, hours: int = 1):
    """Stored history (what the collector wrote) for one device, plus its live output rate."""
    instance = db.fetch_one("SELECT * FROM gateway_device_instance WHERE device_id=%s", (device_id,))
    if instance is None:
        raise HTTPException(404, "device not found")
    hours = hours if hours in MONITOR_BUCKETS else 1
    bucket = MONITOR_BUCKETS[hours]
    end = db.now_ms() // bucket * bucket          # last complete bucket; the live tiles cover the current one
    start = end - hours * 3_600_000
    observations = bucket_counts("gateway_observation", device_id, start, bucket)
    measurements = bucket_counts("gateway_measurement", device_id, start, bucket)
    series = [[t // 1000, observations.get(t, 0), measurements.get(t, 0)] for t in range(start, end, bucket)]
    # Parameters look at everything stored in the range, including the bucket still filling.
    parameters = db.fetch_all(
        """SELECT DISTINCT ON (ivy_param) ivy_param, raw_code, value, unit, system_ts,
                  count(*) OVER (PARTITION BY ivy_param) AS n
           FROM gateway_observation WHERE device_id=%s AND system_ts >= %s
           ORDER BY ivy_param, system_ts DESC""", (device_id, start))
    live = monitor.devices.get(device_id)
    return {
        "device": db.instance_row(instance), "hours": hours, "bucket_ms": bucket, "series": series,
        "totals": {"observations": sum(observations.values()), "measurements": sum(measurements.values())},
        "parameters": parameters,
        "live": {"rate": live.rate() if live else {"obs_per_min": 0, "measurements_per_min": 0},
                 "totals": live.totals if live else {"obs": 0, "measurement": 0},
                 "last_ts": live.last_ts if live else None},
        "monitor": monitor.status,
    }


@app.get("/api/devices/{device_id}/payloads")
def device_payloads(device_id: str, after: int = 0, limit: int = 100):
    """Messages this device's parser published for the collector (newest first); `after` = last seen id."""
    live = monitor.devices.get(device_id)
    rows = [row for row in (live.recent if live else []) if row["id"] > after][-max(1, min(limit, 300)):]
    return {"rows": rows[::-1], "monitor": monitor.status}


# ------------------------------------------------------------------ live data (per device: raw in -> decoded out)

LIVE_WINDOW_MS = 10 * 60_000     # "latest value" lookback for the live table


def latest_parameters(device_ids: list[str], since: int) -> dict[str, list[dict[str, Any]]]:
    rows = db.fetch_all(
        """SELECT DISTINCT ON (device_id, ivy_param) device_id, ivy_param, raw_code, value, unit, system_ts
           FROM gateway_observation WHERE device_id = ANY(%s) AND system_ts >= %s
           ORDER BY device_id, ivy_param, system_ts DESC""", (device_ids, since))
    result: dict[str, list[dict[str, Any]]] = {}
    for row in rows:
        result.setdefault(row["device_id"], []).append(row)
    return result


SERIAL_NAMES = (("/dev/ttyS", "COM", 1), ("/dev/ttyUSB", "USB-serial ", 0), ("/dev/ttyACM", "USB-ACM ", 0))


WINDOWS_COM = re.compile(r"^COM\d+$", re.IGNORECASE)


def serial_port_name(host_path: str | None) -> str | None:
    """/dev/ttyS0 -> COM1; /dev/ttyUSB0 -> USB-serial 0; Windows COM3 stays COM3; virtual ttyV* ports have none."""
    if host_path and WINDOWS_COM.match(host_path):
        return host_path.upper()
    for prefix, label, base in SERIAL_NAMES:
        if host_path and host_path.startswith(prefix) and host_path[len(prefix):].isdigit():
            return f"{label}{int(host_path[len(prefix):]) + base}"
    return None


def pod_connections() -> dict[str, dict[str, Any]]:
    """Where each ingress pod meets the outside: COM/USB port, LAN port on this host, or the URL it polls."""
    try:
        config = read_config()
    except Exception:
        return {}
    result: dict[str, dict[str, Any]] = {}
    for service, section in settings.INGRESS.items():
        pods = config.get(section, {}).get("pods", [])
        if not pods:
            continue
        wiring = docker_ops.service_wiring(service)
        for pod in pods:
            key, info = f"{section}.{pod['id']}", {"kind": section, "enabled": pod.get("enabled", True)}
            if section == "serial":
                path = pod.get("path")
                # Windows: serial-controller runs natively and opens COMn itself (no container mapping).
                host = path if path and WINDOWS_COM.match(path) else wiring["devices"].get(path)
                info.update(path=path, host_path=host, port_name=serial_port_name(host),
                            virtual=host is None, line=f"{pod.get('baud', 9600)} {pod.get('data_bits', 8)}"
                            f"{str(pod.get('parity', 'none'))[0].upper()}{pod.get('stop_bits', 1)}")
            elif section in ("socket", "webhook"):
                transport = pod.get("transport", "tcp" if section == "socket" else "http")
                proto = "udp" if transport == "udp" else "tcp"
                info.update(transport=transport, container_port=pod.get("port"), framing=pod.get("framing"),
                            remote_host=pod.get("remote_host"),
                            host_ports=wiring["ports"].get(f"{pod.get('port')}/{proto}", []))
            else:
                info.update(url=pod.get("url"), interval_ms=pod.get("interval_ms"))
            result[key] = info
    return result


def frame_sources(frames) -> list[dict[str, Any]]:
    """Senders seen in a pod's recent inbound frames (monitor IP for relayed IACS), newest first."""
    sources: dict[str, dict[str, Any]] = {}
    for frame in frames:
        ip = frame["meta"].get("source_ip") if frame["direction"] == "in" else None
        if not ip:
            continue
        entry = sources.setdefault(ip, {"ip": ip, "frames": 0, "last_ts": 0, "peer": None})
        entry["frames"] += 1
        if frame["ts"] >= entry["last_ts"]:
            entry.update(last_ts=frame["ts"], peer=frame["meta"].get("peer"))
    return sorted(sources.values(), key=lambda s: s["last_ts"], reverse=True)


LIVE_GRAPH_MINUTES = 30   # live cards chart one point per complete minute


def device_graph(device: dict[str, Any], connection: dict[str, Any] | None, stream) -> dict[str, Any]:
    """What a live card charts, one point per minute: nothing for a disabled device; on a LAN pod only the
    frames from the device's source_ip (none without one, since the pod may carry other monitors); else the pod."""
    if not device.get("enabled"):
        return {"mode": "disabled", "series": []}
    if connection and connection["kind"] in ("socket", "webhook"):
        source = (device.get("options") or {}).get("source_ip")
        if not source:
            return {"mode": "no_source_ip", "series": []}
        series = stream.minute_series(LIVE_GRAPH_MINUTES, source) if stream else []
        return {"mode": "source_ip", "series": series, "frames_in": sum(r[1] for r in series),
                "bytes_in": sum(r[2] for r in series)}
    return {"mode": "pod", "series": stream.minute_series(LIVE_GRAPH_MINUTES) if stream else []}


def own_frames(device: dict[str, Any], frames) -> list[dict[str, Any]]:
    """Ingress frames of the device's pod; on a shared pod only those from its source_ip."""
    source = (device.get("options") or {}).get("source_ip")
    return [frame for frame in frames
            if not source or frame["direction"] != "in" or frame["meta"].get("source_ip") in (None, source)]


DEVICE_ACTIVE_MS = 30_000   # frames or values newer than this count as "now"


def ingress_pod_status() -> dict[str, dict[str, Any]]:
    """Per-pod status from the serial and socket controllers: serial `connected` = the port is open,
    socket `detail.connections` = open TCP connections. Missing when a controller is unreachable."""
    result: dict[str, dict[str, Any]] = {}
    with httpx.Client(timeout=0.8) as client:
        for name in ("serial-controller", "socket-controller"):
            try:
                for pod in client.get(f"{settings.CONTROLLERS[name]}/status").json().get("pods", []):
                    result[pod["pod"]] = pod
            except Exception:
                continue
    return result


def open_tcp_peers(pod_status: dict[str, dict[str, Any]]) -> dict[str, set[str]]:
    """Sender IPs with an open TCP session, per socket pod, from the socket-controller's connect/disconnect log.
    A pod the controller reports with no open connection has none (a controller restart logs no disconnects)."""
    sessions: dict[tuple[str, Any], str] = {}
    for row in db.fetch_all("""SELECT pod, message, detail FROM gateway_log WHERE component='socket-controller'
                               AND message IN ('device connected', 'device disconnected') AND ts > %s ORDER BY ts, id""",
                            (db.now_ms() - 7 * 86_400_000,)):
        detail = row["detail"] or {}
        key = (row["pod"], detail.get("connection"))
        if row["message"] == "device connected" and detail.get("peer"):
            sessions[key] = str(detail["peer"]).rsplit(":", 1)[0].strip("[]")
        else:
            sessions.pop(key, None)
    by_pod: dict[str, list[str]] = {}
    for (pod, _), ip in sessions.items():          # oldest first (log order)
        by_pod.setdefault(pod, []).append(ip)
    result: dict[str, set[str]] = {}
    for pod, ips in by_pod.items():
        # Only as many as the controller has open now, newest first: sessions cut by a restart leave no disconnect.
        count = int((((pod_status.get(pod) or {}).get("detail") or {}).get("connections")) or 0)
        if count:
            result[pod] = set(ips[-count:])
    return result


def device_status(device: dict[str, Any], connection: dict[str, Any] | None, stream, container: dict | None,
                  pod_status: dict[str, Any] | None, last_value: int | None, now: int,
                  tcp_open: set[str] | None = None, last_setting: int | None = None) -> dict[str, Any]:
    """The device's own state for its live card.
    receiving: measurements now · standby (online, not in use): the device talks but sends no measurements ·
    plugged_in: a serial device whose modem lines are up but that sends nothing yet ·
    connected: a network device with an open TCP session that sends nothing (now) ·
    unplugged: a serial device that stopped answering (off or cable out) ·
    not_connected / connection_lost: a network device never seen / no longer heard · plus gateway-side faults."""
    kind = (connection or {}).get("kind") or device["pod"].split(".", 1)[0]
    network = kind in ("socket", "webhook", "feeder")
    source = (device.get("options") or {}).get("source_ip")
    last_in = (stream.source_last_ts.get(source) if source else stream.last_in_ts) if stream else None
    fresh = lambda ts: bool(ts) and now - ts < DEVICE_ACTIVE_MS
    state = lambda code, detail=None, since=None: {"state": code, "network": network, "detail": detail,
                                                   "since": since, "last_in_ts": last_in}
    if not device.get("enabled"):
        return state("disabled")
    if container is not None and container.get("status") != "running":
        return state("parser_down", f"parser container {container.get('status')}")
    if kind == "serial" and pod_status and not pod_status.get("connected"):
        return state("port_error", pod_status.get("last_error") or "serial port is not open")
    if fresh(last_value):
        return state("receiving", since=last_value)
    if fresh(last_in):
        # Online but not in use: the device talks, yet sends no measurements (standby, no patient connected).
        if fresh(last_setting):
            return state("standby", "online · settings only, no measurements (standby)", since=last_in)
        return state("standby", "online · " + ("sends data, no measurements (no patient)" if network
                                               else "answers, no measurements (standby or no patient)"), since=last_in)
    if not network:
        # A powered device on a full RS-232 cable raises DSR/CTS/DCD even before it sends anything.
        lines = ((pod_status or {}).get("detail") or {}).get("lines") or {}
        raised = [name.upper() for name in ("dsr", "cts", "dcd") if lines.get(name)]
        if raised:
            return state("plugged_in", f"online · cable plugged in, device on ({'/'.join(raised)}) · no reply yet "
                                   "(if it stays: check the device's protocol and line settings)", since=last_in)
        return state("unplugged", "no reply and no line signal: switched off or cable out", since=last_in)
    connections = ((pod_status or {}).get("detail") or {}).get("connections")
    if (source and source in (tcp_open or ())) or (not source and connections):
        # Found on the network (TCP session open) but silent: not a lost connection.
        return state("connected", "online · TCP connection open, sends nothing " + ("now" if last_in else "yet"), since=last_in)
    if last_in:
        return state("connection_lost", "no data from the device over the network", since=last_in)
    return state("not_connected", f"never heard from {source}" if source else "no device has connected yet")


KONG_LEAF_ROUTE = re.compile(r'paths:\s*\[\s*"/data-api/([A-Za-z0-9_.-]+)"\s*\]')


def kong_leaves() -> list[str]:
    """Leafs with a data-api route (/data-api/<leaf-id>) in kong.yaml; a Leaf without one cannot read its devices."""
    try:
        return sorted(set(KONG_LEAF_ROUTE.findall(Path(settings.KONG_CONFIG_PATH).read_text())))
    except OSError:
        return []


@app.get("/api/device-form")
def device_form_options():
    """Choices for the Add/Edit device form: Leafs, pods with their physical port, licensed types, used places."""
    routed = kong_leaves()
    used = [row["leaf_id"] for row in db.fetch_all(
        "SELECT DISTINCT leaf_id FROM gateway_device_instance WHERE leaf_id IS NOT NULL AND leaf_id <> ''")]
    leaves = [{"id": leaf, "route": leaf in routed} for leaf in sorted(set(routed) | set(used))]
    places = db.fetch_all("SELECT DISTINCT station, location FROM gateway_device_instance")
    license_row = license_state()
    pods = pod_connections()
    try:
        config = read_config()
    except Exception:
        config = {}
    managed = {section: set(model.model_fields) for section, model in connection.MODELS.items()}
    current = {f"{section}.{pod['id']}": {k: v for k, v in pod.items() if k in managed[section]}
               for section in managed for pod in config.get(section, {}).get("pods", [])}
    in_use: dict[str, list[str]] = {}
    for row in db.fetch_all("SELECT device_id, pod FROM gateway_device_instance WHERE enabled"):
        in_use.setdefault(row["pod"], []).append(row["device_id"])
    return {
        "leaves": leaves, "kong_routes": bool(routed),
        "pods": [{"pod": pod, **info, "devices": in_use.get(pod, []), "settings": current.get(pod, {})}
                 for pod, info in pods.items()],
        "managed_fields": {section: sorted(fields) for section, fields in managed.items()},
        "allowed_types": license_row.get("allowed_types") or [],
        "stations": sorted({p["station"] for p in places if p["station"]}),
        "locations": sorted({p["location"] for p in places if p["location"]}),
    }


@app.get("/api/live")
def live_devices():
    """Every installed device with its parser, ingress traffic and latest decoded values."""
    states = docker_ops.parser_states()
    devices = [db.instance_row(row) for row in db.fetch_all("SELECT * FROM gateway_device_instance ORDER BY device_id")]
    now = db.now_ms()
    latest = latest_parameters([d["device_id"] for d in devices], now - LIVE_WINDOW_MS) if devices else {}
    connections = pod_connections()
    pod_status = ingress_pod_status() if devices else {}
    tcp_open = open_tcp_peers(pod_status) if devices else {}
    rows = []
    for device in devices:
        stream = monitor.pods.get(device["pod"])
        frames = own_frames(device, stream.recent) if stream else []
        last_in = max((f["ts"] for f in frames if f["direction"] == "in"), default=None)
        output = monitor.devices.get(device["device_id"])
        params = latest.get(device["device_id"], [])
        last_value = max((p["system_ts"] for p in params), default=None)
        # "In use" means measurements; device settings (set_*) keep coming while a device is in standby.
        last_measured = max((p["system_ts"] for p in params if not str(p["ivy_param"]).startswith("set_")), default=None)
        last_setting = max((p["system_ts"] for p in params if str(p["ivy_param"]).startswith("set_")), default=None)
        rows.append({
            **{key: device.get(key) for key in ("device_id", "label", "device_type", "pod", "leaf_id", "enabled")},
            "container": states.get(device["device_id"]),
            "status": device_status(device, connections.get(device["pod"]), stream, states.get(device["device_id"]),
                                    pod_status.get(device["pod"]), last_measured, now, tcp_open.get(device["pod"]),
                                    last_setting),
            "controller": device["pod"].split(".", 1)[0],
            "connection": connections.get(device["pod"]),
            "graph": device_graph(device, connections.get(device["pod"]), stream),
            "source_ip": (device.get("options") or {}).get("source_ip"),
            "sources": frame_sources(stream.recent) if stream else [],
            "ingress": {"frames_in": stream.totals["frames_in"] if stream else 0,
                        "bytes_in": stream.totals["bytes_in"] if stream else 0,
                        "frames_out": stream.totals["frames_out"] if stream else 0,
                        "rate": stream.rate() if stream else None, "last_in_ts": last_in},
            "output": {"totals": output.totals if output else {"obs": 0, "measurement": 0},
                       "last_ts": output.last_ts if output else None},
            "last_value_ts": last_value,
            "parameters": params,
        })
    return {"rows": rows, "now": now, "window_ms": LIVE_WINDOW_MS, "monitor": monitor.status}


@app.get("/api/live/{device_id}")
def live_device(device_id: str, limit: int = 40):
    """Raw frames the device sent (and the gateway's replies) next to what its parser decoded from them."""
    row = db.fetch_one("SELECT * FROM gateway_device_instance WHERE device_id=%s", (device_id,))
    if row is None:
        raise HTTPException(404, "device not found")
    device = db.instance_row(row)
    limit = max(1, min(limit, 200))
    stream = monitor.pods.get(device["pod"])
    frames = own_frames(device, stream.recent)[-limit:][::-1] if stream else []
    # Decoded rows come from the database so they survive a gateway-service restart; newest first.
    since = db.now_ms() - LIVE_WINDOW_MS
    observations = db.fetch_all(
        """SELECT raw_code, ivy_param, value, unit, system_ts FROM gateway_observation
           WHERE device_id=%s AND system_ts >= %s ORDER BY system_ts DESC, id DESC LIMIT %s""",
        (device_id, since, limit * 10))
    try:
        measurements = db.fetch_all(
            """SELECT raw_code, raw_value, value, definition, mapping, system_ts FROM gateway_measurement
               WHERE device_id=%s AND system_ts >= %s ORDER BY system_ts DESC, id DESC LIMIT %s""",
            (device_id, since, limit * 10))
    except Exception:  # gateways created before gateway_measurement existed
        measurements = []
    # One row per source field: the value as the device sent it -> the Flora parameter it became.
    fields: dict[str, dict[str, Any]] = {}
    for m in measurements:
        definition, mapping = m["definition"] or {}, m["mapping"] or {}
        fields.setdefault(m["raw_code"], {"raw_code": m["raw_code"], "raw_value": m["raw_value"],
                                          "device_value": m["value"], "name": definition.get("name"),
                                          "device_unit": definition.get("unit"),
                                          "ivy_param": mapping.get("ivy_param"), "system_ts": m["system_ts"]})
    for o in observations:
        field = fields.setdefault(o["raw_code"] or o["ivy_param"], {"raw_code": o["raw_code"], "system_ts": o["system_ts"]})
        if "value" not in field:
            field.update(ivy_param=o["ivy_param"], value=o["value"], unit=o["unit"], value_ts=o["system_ts"])
    return {"device": {key: device.get(key) for key in ("device_id", "label", "device_type", "pod", "leaf_id",
                                                         "enabled", "options")},
            "frames": frames,
            "fields": sorted(fields.values(), key=lambda f: (f.get("ivy_param") is None, str(f.get("raw_code")))),
            "observations": observations[:limit], "now": db.now_ms(), "monitor": monitor.status}


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


# ------------------------------------------------------------------ link to Canopy

ENV_LINK = {"canopy_url": settings.HABER_URL, "gateway_id": settings.GATEWAY_ID, "gateway_key": settings.HABER_TOKEN}


def normalize_url(value: str | None) -> str:
    value = (value or "").strip().rstrip("/")
    if value and "://" not in value:
        value = "https://" + value          # a bare host name means the Canopy edge on 443
    return value


def load_canopy_link() -> None:
    """Values saved on the admin page win over the environment."""
    row = db.fetch_one("SELECT * FROM gateway_canopy_link WHERE id=1") or {}
    settings.HABER_URL = normalize_url(row.get("canopy_url")) or ENV_LINK["canopy_url"]
    settings.GATEWAY_ID = row.get("gateway_id") or ENV_LINK["gateway_id"]
    settings.HABER_TOKEN = row.get("gateway_key") or ENV_LINK["gateway_key"]


def link_state() -> dict[str, Any]:
    row = db.fetch_one("SELECT * FROM gateway_canopy_link WHERE id=1") or {}
    return {"canopy_url": settings.HABER_URL, "gateway_id": settings.GATEWAY_ID, "has_key": bool(settings.HABER_TOKEN),
            "source": "admin page" if row.get("canopy_url") or row.get("gateway_id") else "environment",
            "updated_at": row.get("updated_at"), "updated_by": row.get("updated_by"), "haber": STATE["haber"]}


class CanopyLinkIn(BaseModel):
    canopy_url: str = Field(min_length=1, max_length=300)
    gateway_id: str = Field(pattern=r"^[A-Za-z0-9_.-]{1,120}$")
    gateway_key: str | None = Field(default=None, max_length=500)   # blank keeps the current key


@app.get("/api/canopy-link")
def get_canopy_link():
    return link_state()


@app.put("/api/canopy-link", dependencies=[Depends(require_admin), Depends(auth.require_role_admin)])
async def put_canopy_link(payload: CanopyLinkIn, request: Request):
    """Saves how to reach Canopy and checks in right away; the result says whether Canopy accepted it."""
    url = normalize_url(payload.canopy_url)
    if not url.startswith(("https://", "http://")):
        raise HTTPException(422, "Canopy address must be a host name or an http(s) URL")
    previous_id = settings.GATEWAY_ID
    db.execute(
        """UPDATE gateway_canopy_link SET canopy_url=%s, gateway_id=%s,
             gateway_key=COALESCE(NULLIF(%s, ''), gateway_key), updated_at=%s, updated_by=%s WHERE id=1""",
        (url, payload.gateway_id, payload.gateway_key or "", db.now_ms(), request.state.user["username"]))
    load_canopy_link()
    if previous_id != settings.GATEWAY_ID:
        # Controllers stamp this id on frames; they pick it up from gateway.toml when restarted.
        try:
            config = read_config()
            config["gateway_id"] = settings.GATEWAY_ID
            Path(settings.CONFIG_PATH).write_text(tomli_w.dumps(config))
        except Exception as error:
            log.warning("could not write gateway_id to %s: %s", settings.CONFIG_PATH, error)
    try:
        await haber_checkin()
        connected, error = True, None
    except Exception as failure:
        STATE["haber"].update(status="offline", error=str(failure))
        connected, error = False, str(failure)
    return {**link_state(), "connected": connected, "error": error, "gateway_id_changed": previous_id != settings.GATEWAY_ID}


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
    return {**site, "gateway_id": settings.GATEWAY_ID, "tenant_id": license_.get("tenant_id"), "label": site_label(site),
            "managed_by_canopy": bool(settings.HABER_URL)}


@app.get("/api/site/label")
def get_site_label():
    """Public: lets the sign-in page show which station this is. Only the ID and location name."""
    return {"gateway_id": settings.GATEWAY_ID, "label": site_label(site_row())}


@app.put("/api/site", dependencies=[Depends(require_admin), Depends(auth.require_role_admin)])
def put_site(payload: SiteIn, request: Request):
    if settings.HABER_URL:
        raise HTTPException(409, "this gateway is connected to Canopy; set its location at Canopy (Topology → gateway)")
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
def logs(limit: int = 100, offset: int = 0, order: str = "desc", since: int | None = None, until: int | None = None):
    """One page of the gateway log; order=desc is newest first, asc oldest first.
    since/until (epoch ms, until exclusive) limit it to a period, e.g. one local day picked in the browser."""
    direction = "ASC" if order.lower() == "asc" else "DESC"
    where = "WHERE ts >= %s AND ts < %s"
    period = (since if since is not None else 0, until if until is not None else 2**62)
    rows = db.fetch_all(f"SELECT * FROM gateway_log {where} ORDER BY ts {direction}, id {direction} LIMIT %s OFFSET %s",
                        (*period, max(1, min(limit, 500)), max(0, offset)))
    return {"rows": rows, "total": db.fetch_one(f"SELECT count(*) AS n FROM gateway_log {where}", period)["n"]}


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
