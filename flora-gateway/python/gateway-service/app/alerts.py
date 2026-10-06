"""Alert log for the station: opened and resolved from status samples, sent to Canopy.

A lane that is `down` for ALERT_AFTER consecutive samples opens one alert; the first
`ok` or `stopped` sample resolves it. Canopy (through Haber) is the central log:
every change bumps `version`, and `push()` resends rows until Canopy confirms them.
"""
from __future__ import annotations

import logging
from typing import Any

import httpx

from . import db, settings

log = logging.getLogger("gateway-service.alerts")

ALERT_AFTER = 2                    # consecutive down samples (30 s apart) before an alert opens
PUSH_BATCH = 100
_down_streak: dict[str, int] = {}


def describe(lane: str, label: str) -> tuple[str, str, str]:
    """(category, severity, title) for a lane going down."""
    kind = lane.partition(":")[0]
    if kind == "canopy":
        return "canopy", "warning", "Canopy connection lost"
    if kind == "controller":
        return "controller", "critical", f"Controller down: {label}"
    if kind == "device":
        return "device", "critical", f"No data from {label}"
    return "gateway", "warning", label


def observe(now: int, rows: list[tuple[str, str, str | None]], labels: dict[str, str]) -> None:
    """Feed one round of status samples; opens and resolves alerts."""
    open_alerts = {row["alert_key"]: row for row in
                   db.fetch_all("SELECT id, alert_key FROM gateway_alert WHERE resolved_at IS NULL")}
    for lane, state, detail in rows:
        if lane == "gateway":
            continue
        if state == "down":
            _down_streak[lane] = _down_streak.get(lane, 0) + 1
            if lane in open_alerts:
                db.execute("UPDATE gateway_alert SET last_seen_at=%s, detail=%s WHERE id=%s",
                           (now, detail, open_alerts[lane]["id"]))
            elif _down_streak[lane] >= ALERT_AFTER:
                category, severity, title = describe(lane, labels.get(lane, lane))
                db.execute(
                    """INSERT INTO gateway_alert (alert_key,category,severity,title,detail,opened_at,last_seen_at)
                       VALUES (%s,%s,%s,%s,%s,%s,%s) ON CONFLICT DO NOTHING""",
                    (lane, category, severity, title, detail, now - (ALERT_AFTER - 1) * 30_000, now))
                log.warning("alert opened: %s (%s)", title, detail)
        else:
            _down_streak.pop(lane, None)
            if lane in open_alerts:
                db.execute("UPDATE gateway_alert SET resolved_at=%s, last_seen_at=%s, version=version+1 WHERE id=%s",
                           (now, now, open_alerts[lane]["id"]))
                log.info("alert resolved: %s", lane)
    # A lane that is no longer sampled (device removed) cannot recover by itself.
    sampled = {lane for lane, _, _ in rows}
    for lane, alert in open_alerts.items():
        if lane not in sampled and lane != "gateway":
            _down_streak.pop(lane, None)
            db.execute("""UPDATE gateway_alert SET resolved_at=%s, last_seen_at=%s, version=version+1,
                            detail=coalesce(detail || ' · ', '') || 'closed: no longer monitored' WHERE id=%s""",
                       (now, now, alert["id"]))


def record_downtime(last_sample: int | None, now: int) -> None:
    """On start: if the previous sample is old, gateway-service was not running in between."""
    if last_sample is None or now - last_sample < 120_000:
        return
    minutes = round((now - last_sample) / 60000)
    db.execute(
        """INSERT INTO gateway_alert (alert_key,category,severity,title,detail,opened_at,last_seen_at,resolved_at)
           VALUES ('gateway','gateway','warning','Gateway service was not running',%s,%s,%s,%s)""",
        (f"no status recorded for {minutes} min (restart, power or host outage)", last_sample, now, now))


def acknowledge(alert_id: int, username: str) -> bool:
    row = db.fetch_one(
        """UPDATE gateway_alert SET acknowledged_at=%s, acknowledged_by=%s, version=version+1
           WHERE id=%s AND acknowledged_at IS NULL RETURNING id""", (db.now_ms(), username, alert_id))
    return row is not None


def wire(row: dict[str, Any]) -> dict[str, Any]:
    """The shape Canopy stores. `alert_id` is unique per gateway; `version` makes resends idempotent."""
    return {key: row[key] for key in ("alert_key", "category", "severity", "title", "detail", "opened_at",
                                      "last_seen_at", "resolved_at", "acknowledged_at", "acknowledged_by", "version")} \
        | {"alert_id": row["id"]}


async def push() -> dict[str, Any]:
    """Sends undelivered alert changes to Canopy through Haber; returns what happened."""
    if not settings.HABER_URL:
        return {"sent": 0, "reason": "Haber not configured"}
    rows = db.fetch_all("SELECT * FROM gateway_alert WHERE delivered_version < version ORDER BY id LIMIT %s",
                        (PUSH_BATCH,))
    if not rows:
        return {"sent": 0}
    async with httpx.AsyncClient(timeout=5) as client:
        response = await client.post(
            f"{settings.HABER_URL}/api/haber/v1/gateways/{settings.GATEWAY_ID}/alerts",
            headers={"authorization": f"Bearer {settings.HABER_TOKEN}"},
            json={"gateway_id": settings.GATEWAY_ID, "alerts": [wire(row) for row in rows]},
        )
        response.raise_for_status()
        accepted = response.json().get("accepted") or []
    now = db.now_ms()
    for item in accepted:
        db.execute("""UPDATE gateway_alert SET delivered_version=GREATEST(delivered_version, %s), delivered_at=%s
                      WHERE id=%s""", (int(item["version"]), now, int(item["alert_id"])))
    return {"sent": len(accepted), "pending": len(rows) - len(accepted)}
