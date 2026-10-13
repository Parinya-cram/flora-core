"""Device activity for Canopy's Device Management: hourly alive rollups and on/off events.

`track()` turns each round of status samples into events, `rollup()` rebuilds the hourly
table from gateway_status_sample / gateway_observation / gateway_device_event, and `push()`
sends whatever Canopy has not confirmed yet through Haber (same pattern as alerts.py).

What the gateway can tell about power:
- power_on / power_off: the device's own link came up / went down on a pod used by this device
  only. Socket pods: the device opened / closed its TCP connection (or UDP data started /
  stopped); feeder pods: the device answered / stopped answering polls. Serial pods are not
  used: "port open" describes the USB adapter, not the device.
- data_resumed / data_stopped: data started again / stopped for DEVICE_SILENT_MS. Works for
  every device, but cannot tell power-off from an unplugged cable or an idle device.
"""
from __future__ import annotations

import hashlib
import json
import logging
from typing import Any

import httpx

from . import db, settings

log = logging.getLogger("gateway-service.activity")

HOUR_MS = 3_600_000
SAMPLE_SEC = 30
ROLLUP_EVERY_MS = 10 * 60_000       # the running hour is refreshed this often
ROLLUP_HOURS = 24                   # past hours rebuilt each time (late samples, restarts)
RETENTION_MS = 30 * 86_400_000      # delivered rows older than this are dropped locally
POWER_CONTROLLERS = {"socket", "feeder"}
HOURS_BATCH, EVENTS_BATCH = 200, 500

_data: dict[str, bool] = {}         # device_id -> data flowing at the last sample
_link: dict[str, bool] = {}         # device_id -> link up at the last sample
_last_rollup = 0


def record(device_id: str, event_type: str, basis: str, at: int, detail: str | None = None) -> None:
    db.execute("""INSERT INTO gateway_device_event (device_id, event_type, basis, occurred_at, detail)
                  VALUES (%s,%s,%s,%s,%s)""", (device_id, event_type, basis, at, detail))
    log.info("device event %s %s (%s)", device_id, event_type, basis)


def track(now: int, rows: list[tuple[str, str, str | None]], pods: dict[str, bool]) -> None:
    """Feed one round of status samples plus the controllers' pod link state ({pod: connected})."""
    seen = {r["device_id"]: r["last_seen_ts"] for r in db.fetch_all("SELECT device_id, last_seen_ts FROM gateway_device_seen")}
    for lane, state, detail in rows:
        if not lane.startswith("device:"):
            continue
        device_id = lane.removeprefix("device:")
        if state == "stopped":       # disabled on purpose: not an on/off event
            _data.pop(device_id, None)
            _link.pop(device_id, None)
            continue
        flowing = state == "ok"
        before = _data.get(device_id)
        _data[device_id] = flowing
        if before is not None and before != flowing:
            record(device_id, "data_resumed" if flowing else "data_stopped", "data",
                   now if flowing else (seen.get(device_id) or now), detail)

    instances = db.fetch_all("SELECT device_id, pod FROM gateway_device_instance WHERE enabled")
    per_pod: dict[str, int] = {}
    for instance in instances:
        per_pod[instance["pod"]] = per_pod.get(instance["pod"], 0) + 1
    for instance in instances:
        pod, device_id = instance["pod"], instance["device_id"]
        if pod.partition(".")[0] not in POWER_CONTROLLERS or per_pod[pod] != 1 or pod not in pods:
            _link.pop(device_id, None)
            continue
        up = pods[pod]
        before = _link.get(device_id)
        _link[device_id] = up
        if before is not None and before != up:
            record(device_id, "power_on" if up else "power_off", "connection", now,
                   f"{pod} {'connected' if up else 'disconnected'}")


def _bucket(column: str) -> str:
    """Start of the hour, as SQL (%% is a literal % in parameterised queries)."""
    return f"({column} - {column} %% {HOUR_MS})"


def rollup(now: int, force: bool = False) -> int:
    """Rebuilds the last ROLLUP_HOURS hours; returns how many rows changed."""
    global _last_rollup
    if not force and now - _last_rollup < ROLLUP_EVERY_MS:
        return 0
    _last_rollup = now
    current = now - now % HOUR_MS
    since = current - ROLLUP_HOURS * HOUR_MS
    rows: dict[tuple[str, str, int], dict[str, Any]] = {}

    def row(subject: str, device_id: str, hour: int) -> dict[str, Any]:
        return rows.setdefault((subject, device_id, hour), {
            "samples_ok": 0, "samples_down": 0, "samples_stopped": 0, "observations": 0,
            "first_data_ts": None, "last_data_ts": None, "power_on": 0, "power_off": 0})

    for sample in db.fetch_all(
            f"""SELECT lane, {_bucket('ts')} AS hour, count(*) FILTER (WHERE state='ok') AS ok,
                       count(*) FILTER (WHERE state='down') AS down, count(*) FILTER (WHERE state='stopped') AS stopped
                FROM gateway_status_sample WHERE ts >= %s AND (lane = 'gateway' OR lane LIKE 'device:%%')
                GROUP BY 1, 2""", (since,)):
        subject, device_id = ("gateway", "") if sample["lane"] == "gateway" else ("device", sample["lane"][7:])
        target = row(subject, device_id, int(sample["hour"]))
        target.update(samples_ok=sample["ok"], samples_down=sample["down"], samples_stopped=sample["stopped"])

    # Observation counts are expensive: keep them for hours already stored as complete.
    stored = {(r["subject"], r["device_id"], int(r["hour_start"])): r for r in db.fetch_all(
        "SELECT * FROM gateway_activity_hour WHERE hour_start >= %s", (since,))}
    done = {hour for (subject, _, hour), r in stored.items() if r["complete"]}
    for hour in sorted({since + n * HOUR_MS for n in range(ROLLUP_HOURS + 1)} - done):
        for obs in db.fetch_all(
                """SELECT device_id, count(*) AS n, min(system_ts) AS first, max(system_ts) AS last
                   FROM gateway_observation WHERE system_ts >= %s AND system_ts < %s GROUP BY device_id""",
                (hour, hour + HOUR_MS)):
            row("device", obs["device_id"], hour).update(observations=obs["n"], first_data_ts=obs["first"],
                                                         last_data_ts=obs["last"])
    for key, previous in stored.items():
        if key[0] == "device" and key[2] in done and key in rows:
            rows[key].update(observations=previous["observations"], first_data_ts=previous["first_data_ts"],
                             last_data_ts=previous["last_data_ts"])

    for event in db.fetch_all(
            f"""SELECT device_id, {_bucket('occurred_at')} AS hour,
                       count(*) FILTER (WHERE event_type='power_on') AS power_on,
                       count(*) FILTER (WHERE event_type='power_off') AS power_off
                FROM gateway_device_event WHERE occurred_at >= %s GROUP BY 1, 2""", (since,)):
        row("device", event["device_id"], int(event["hour"])).update(power_on=event["power_on"],
                                                                     power_off=event["power_off"])

    changed = 0
    with db.pool.connection() as connection:
        for (subject, device_id, hour), values in rows.items():
            values["online_seconds"] = min(3600, values["samples_ok"] * SAMPLE_SEC)
            values["complete"] = hour + HOUR_MS + 60_000 <= now
            checksum = hashlib.sha1(json.dumps(values, sort_keys=True).encode()).hexdigest()
            result = connection.execute(
                """INSERT INTO gateway_activity_hour (subject, device_id, hour_start, samples_ok, samples_down,
                       samples_stopped, online_seconds, observations, first_data_ts, last_data_ts, power_on,
                       power_off, complete, checksum)
                   VALUES (%(subject)s, %(device_id)s, %(hour)s, %(samples_ok)s, %(samples_down)s, %(samples_stopped)s,
                       %(online_seconds)s, %(observations)s, %(first_data_ts)s, %(last_data_ts)s, %(power_on)s,
                       %(power_off)s, %(complete)s, %(checksum)s)
                   ON CONFLICT (subject, device_id, hour_start) DO UPDATE SET
                       samples_ok=excluded.samples_ok, samples_down=excluded.samples_down,
                       samples_stopped=excluded.samples_stopped, online_seconds=excluded.online_seconds,
                       observations=excluded.observations, first_data_ts=excluded.first_data_ts,
                       last_data_ts=excluded.last_data_ts, power_on=excluded.power_on, power_off=excluded.power_off,
                       complete=excluded.complete, checksum=excluded.checksum,
                       version=gateway_activity_hour.version + 1
                   WHERE gateway_activity_hour.checksum <> excluded.checksum""",
                {**values, "subject": subject, "device_id": device_id, "hour": hour, "checksum": checksum})
            changed += result.rowcount
        connection.execute("DELETE FROM gateway_activity_hour WHERE hour_start < %s AND delivered_version >= version",
                           (now - RETENTION_MS,))
        connection.execute("DELETE FROM gateway_device_event WHERE occurred_at < %s AND delivered", (now - RETENTION_MS,))
    return changed


HOUR_FIELDS = ("subject", "device_id", "hour_start", "samples_ok", "samples_down", "samples_stopped", "online_seconds",
               "observations", "first_data_ts", "last_data_ts", "power_on", "power_off", "complete", "version")
EVENT_FIELDS = ("id", "device_id", "event_type", "basis", "occurred_at", "detail")


async def push() -> dict[str, Any]:
    """Sends unconfirmed hours and events to Canopy through Haber."""
    if not settings.HABER_URL:
        return {"sent": 0, "reason": "Haber not configured"}
    hours = db.fetch_all("SELECT * FROM gateway_activity_hour WHERE delivered_version < version "
                         "ORDER BY hour_start LIMIT %s", (HOURS_BATCH,))
    events = db.fetch_all("SELECT * FROM gateway_device_event WHERE NOT delivered ORDER BY id LIMIT %s", (EVENTS_BATCH,))
    if not hours and not events:
        return {"sent": 0}
    async with httpx.AsyncClient(timeout=10) as client:
        response = await client.post(
            f"{settings.HABER_URL}/api/haber/v1/gateways/{settings.GATEWAY_ID}/activity",
            headers={"authorization": f"Bearer {settings.HABER_TOKEN}"},
            json={"gateway_id": settings.GATEWAY_ID,
                  "hours": [{field: row[field] for field in HOUR_FIELDS} for row in hours],
                  "events": [{field: row[field] for field in EVENT_FIELDS} for row in events]},
        )
        response.raise_for_status()
        body = response.json()
    with db.pool.connection() as connection:
        for item in body.get("accepted_hours") or []:
            connection.execute(
                """UPDATE gateway_activity_hour SET delivered_version=GREATEST(delivered_version, %s)
                   WHERE subject=%s AND device_id=%s AND hour_start=%s""",
                (int(item["version"]), item["subject"], item["device_id"], int(item["hour_start"])))
        accepted_events = [int(event_id) for event_id in body.get("accepted_events") or []]
        if accepted_events:
            connection.execute("UPDATE gateway_device_event SET delivered=true WHERE id = ANY(%s)", (accepted_events,))
    return {"hours": len(body.get("accepted_hours") or []), "events": len(accepted_events)}
