"""ICU daily billing: one billing order per billing day of a case (docs/BILLING.md, "ICU daily billing").

Billing days follow the case workflow's `day_start` (default 07:00) in the Leaf's time zone
(app/form_schedule.py): day 1 runs from the case start to the next day_start, then whole days
until discharge (or now). A day's order is case_billing_order kind 'daily' with
[period_start, period_end); closing it submits and locks it, and the snapshot key
"billing_all" carries it to Canopy (billing.project_orders).

Standing charges are added once per day as lines with source 'standing':
- the itemize template's items marked `standing: true` (qty = the template qty, else 1), or, when
  the template marks none, every active master item with charge_basis per_day / per_device_day;
- per_device_day items only when a bound device of that `device_kind` overlapped the day, one per
  device. The kind comes from the gateway device list the Leaf caches from Canopy
  (leaf_ward_state → gateways[].devices[].device_type / label), else from the device id; see
  `device_kind`. A device whose kind cannot be told adds nothing: staff add the device-day item by
  hand for that day (it is listed under `unknown_devices`).
A manual line with the same item code replaces the standing line (to change its quantity).
Generation is idempotent: the standing lines are recomputed and rewritten, manual lines kept.

Pure functions (periods, standing_for_period, device_kind, overlaps, summarize) have no database.
"""
from __future__ import annotations

import uuid
from datetime import timedelta
from typing import Any, Iterable

from psycopg import Connection

from . import billing
from .form_schedule import DAY, at_local, local, minutes, workflow_day_start, zone

BASES_STANDING = ("per_day", "per_device_day")
MAX_DAYS = 400
# Keyword → device kind, first match wins (anesthesia machines before ventilators: both ventilate).
KIND_WORDS: tuple[tuple[str, tuple[str, ...]], ...] = (
    ("anesthesia_machine", ("anesthesia", "anaesthesia", "fabius", "primus", "perseus", "aisys", "atlan")),
    ("ventilator", ("ventilator", "vent", "hamilton", "servo", "evita", "puritan", "bennett", "bipap", "cpap")),
    ("infusion_pump", ("infusion", "pump", "syringe", "perfusor", "infusomat", "alaris")),
    ("monitor", ("monitor", "m540", "iacs", "intellivue", "vista", "mindray", "bedside")),
)


# ---------------------------------------------------------------- day windows
def billing_mode(workflow: dict[str, Any] | None) -> str:
    """'daily' when the workflow bills by day (definition.billing.mode), else 'case'."""
    value = ((workflow or {}).get("billing") or {}) if isinstance((workflow or {}).get("billing"), dict) else {}
    return "daily" if value.get("mode") == "daily" else "case"


def periods(case: dict[str, Any], tz_name: str | None, day_start: str, now: int) -> list[dict[str, Any]]:
    """[{day, period_start, period_end, date}] from the case start to discharge (or now).

    Day 1: case start → the next day_start; then whole days. The day holding the end is the last."""
    tz = zone(tz_name)
    start = int(case["start_time"])
    end = int(case.get("discharge_time") or now)
    shift = minutes(day_start)
    day = (local(start, tz) - timedelta(minutes=shift)).date()  # billing date of the start
    out: list[dict[str, Any]] = []
    low = start
    while len(out) < MAX_DAYS:
        high = at_local(day + timedelta(days=1), shift, tz)
        out.append({"day": len(out) + 1, "period_start": low, "period_end": high,
                    "date": local(low, tz).date().isoformat(), "current": low <= now < high})
        if high >= end:
            break
        low, day = high, day + timedelta(days=1)
    return out


def find_period(windows: list[dict[str, Any]], period_start: int) -> dict[str, Any] | None:
    return next((w for w in windows if w["period_start"] == period_start), None)


# ---------------------------------------------------------------- devices
def device_kind(*texts: Any) -> str | None:
    """ventilator | infusion_pump | monitor | anesthesia_machine from a device type, label or id."""
    blob = " ".join(str(t) for t in texts if t).lower()
    if not blob:
        return None
    for kind, words in KIND_WORDS:
        if any(word in blob for word in words):
            return kind
    return None


def overlaps(device: dict[str, Any], period: dict[str, Any]) -> bool:
    released = device.get("released_at")
    return int(device["bound_at"]) < int(period["period_end"]) and (released is None or int(released) > int(period["period_start"]))


def case_devices(database: Connection, case_id: int) -> list[dict[str, Any]]:
    """Every binding of the case (released ones too) with its device type and kind."""
    rows = database.execute(
        """SELECT b.device_id, b.bound_at, b.released_at, l.gateway_id FROM case_device_binding b
           LEFT JOIN leaf_gateway_link l ON l.id = b.gateway_link_id WHERE b.case_id=%s ORDER BY b.bound_at""",
        (case_id,)).fetchall()
    if not rows:
        return []
    known: dict[tuple[str | None, str], dict[str, Any]] = {}
    state = None
    if database.execute("SELECT to_regclass('leaf_ward_state') AS t").fetchone()["t"]:
        state = database.execute("SELECT payload FROM leaf_ward_state WHERE id=1").fetchone()
    for gateway in ((state or {}).get("payload") or {}).get("gateways") or []:
        for device in gateway.get("devices") or [] if isinstance(gateway, dict) else []:
            if isinstance(device, dict) and device.get("device_id"):
                known[(gateway.get("gateway_id"), str(device["device_id"]))] = device
                known.setdefault((None, str(device["device_id"])), device)
    out = []
    for row in rows:
        info = known.get((row["gateway_id"], row["device_id"])) or known.get((None, row["device_id"])) or {}
        out.append({"device_id": row["device_id"], "bound_at": int(row["bound_at"]),
                    "released_at": int(row["released_at"]) if row["released_at"] is not None else None,
                    "device_type": info.get("device_type"), "label": info.get("label"),
                    "kind": device_kind(info.get("device_type"), info.get("label")) or device_kind(row["device_id"])})
    return out


# ---------------------------------------------------------------- standing charges
def standing_rules(items: Iterable[dict[str, Any]], template: dict[str, Any] | None) -> list[dict[str, Any]]:
    """[{item, qty}]: the template's `standing` items, else every active per_day / per_device_day item."""
    by_code = {item["code"]: item for item in items if int(item.get("is_active", 1))}
    flagged = [entry for group in (template or {}).get("groups") or [] for entry in group.get("items") or []
               if isinstance(entry, dict) and entry.get("standing")]
    if flagged:
        return [{"item": by_code[e["code"]], "qty": float(e.get("qty") or 1)} for e in flagged if e.get("code") in by_code]
    return [{"item": item, "qty": 1.0} for item in by_code.values() if item.get("charge_basis") in BASES_STANDING]


def _line(item: dict[str, Any], qty: float, note: str | None = None) -> dict[str, Any]:
    return {"item_code": item["code"], "group_code": item["group_code"], "name": item["name"], "variant": None,
            "qty": round(qty, 2), "unit": item.get("unit"), "qty_mode": item.get("qty_mode") or "count",
            "unit_price": item.get("unit_price"), "charge_code": item.get("charge_code"), "source": "standing", "note": note}


def standing_for_period(rules: list[dict[str, Any]], devices: list[dict[str, Any]], period: dict[str, Any]) -> list[dict[str, Any]]:
    """The standing lines of one day (pure)."""
    lines = []
    for rule in rules:
        item = rule["item"]
        if item.get("charge_basis") == "per_device_day":
            used = sorted({d["device_id"] for d in devices if item.get("device_kind") and d.get("kind") == item["device_kind"]
                           and overlaps(d, period)})
            if used:
                lines.append(_line(item, rule["qty"] * len(used), ", ".join(used)))
        else:
            lines.append(_line(item, rule["qty"]))
    return lines


def merge(standing: list[dict[str, Any]], manual: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Standing lines first, then the manual ones; a manual line of the same item replaces the standing one."""
    taken = {line["item_code"] for line in manual if line.get("item_code")}
    return [line for line in standing if line["item_code"] not in taken] + [line for line in manual if line.get("source") != "standing"]


def total(lines: Iterable[dict[str, Any]]) -> float | None:
    priced = [value for value in (billing.amount(line) for line in lines) if value is not None]
    return round(sum(priced), 2) if priced else None


def standing_lines(database: Connection, case_id: int, period: dict[str, Any], template: dict[str, Any] | None = None,
                   devices: list[dict[str, Any]] | None = None) -> list[dict[str, Any]]:
    items = [billing.row_dict(row) for row in database.execute("SELECT * FROM billing_item ORDER BY sort_order, code").fetchall()]
    return standing_for_period(standing_rules(items, template), case_devices(database, case_id) if devices is None else devices, period)


# ---------------------------------------------------------------- daily orders
def daily_orders(database: Connection, case_id: int) -> dict[int, dict[str, Any]]:
    """{period_start: live daily order}."""
    rows = database.execute(
        "SELECT * FROM case_billing_order WHERE case_id=%s AND kind='daily' AND status<>'void' ORDER BY period_start",
        (case_id,)).fetchall()
    return {int(row["period_start"]): billing.row_dict(row) for row in rows}


def ensure_daily_order(database: Connection, case_id: int, period: dict[str, Any], actor: str | None, now: int) -> tuple[dict[str, Any], bool]:
    """(order, created) for the day."""
    row = database.execute(
        """INSERT INTO case_billing_order(case_id,order_uuid,kind,period_start,period_end,status,created_by,created_at,updated_by,updated_at)
           VALUES (%s,%s,'daily',%s,%s,'draft',%s,%s,%s,%s)
           ON CONFLICT (case_id, coalesce(period_start, 0)) WHERE status <> 'void' DO NOTHING RETURNING *""",
        (case_id, str(uuid.uuid4()), period["period_start"], period["period_end"], actor, now, actor, now)).fetchone()
    if row:
        return billing.row_dict(row), True
    return daily_orders(database, case_id)[int(period["period_start"])], False


def write_lines(database: Connection, case_id: int, order_id: int, lines: list[dict[str, Any]], now: int) -> None:
    database.execute("DELETE FROM case_billing_order_item WHERE order_id=%s", (order_id,))
    for number, line in enumerate(lines, start=1):
        database.execute(
            """INSERT INTO case_billing_order_item(case_id,order_id,line_no,item_code,group_code,name,variant,qty,unit,
                 qty_mode,unit_price,charge_code,source,note,created_at,updated_at)
               VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)""",
            (case_id, order_id, number, line["item_code"], line["group_code"], line["name"], line.get("variant"),
             line["qty"], line.get("unit"), line.get("qty_mode") or "count", line.get("unit_price"), line.get("charge_code"),
             line.get("source") or "manual", line.get("note"), now, now))


def generate(database: Connection, case_id: int, order: dict[str, Any], template: dict[str, Any] | None, now: int,
             manual: list[dict[str, Any]] | None = None) -> list[dict[str, Any]]:
    """Rewrite the day's lines: fresh standing lines + the manual lines (the given ones, else the stored ones)."""
    period = {"period_start": int(order["period_start"]), "period_end": int(order["period_end"])}
    if manual is None:
        manual = [line for line in billing.order_lines(database, order["id"]) if line.get("source") != "standing"]
    lines = merge(standing_lines(database, case_id, period, template), manual)
    write_lines(database, case_id, order["id"], lines, now)
    return lines


# ---------------------------------------------------------------- overview and estimate
def summarize(windows: list[dict[str, Any]], orders: dict[int, dict[str, Any]], order_totals: dict[int, float | None],
              previews: dict[int, float | None], projected_day: float | None, extra_days: int) -> dict[str, Any]:
    """Per-day totals (stored order, else the standing preview) and the estimate (pure)."""
    days, closed, open_, projected = [], 0.0, 0.0, 0.0
    for window in windows:
        start = window["period_start"]
        order = orders.get(start)
        if order is not None:
            amount = order_totals.get(start) or 0.0
            status = "closed" if order.get("status") == "submitted" else "open"
            if status == "closed":
                closed += amount
            else:
                open_ += amount
        else:
            amount, status = previews.get(start) or 0.0, "open"
            projected += amount
        days.append({**window, "status": status, "has_order": order is not None, "total": round(amount, 2),
                     "source": "order" if order is not None else "standing_preview"})
    future = round((projected_day or 0.0) * max(0, extra_days), 2)
    return {"days": days, "closed_total": round(closed, 2), "open_total": round(open_, 2),
            "projected_to_today": round(projected, 2), "to_date_total": round(closed + open_ + projected, 2),
            "extra_days": max(0, extra_days), "standing_per_day": round(projected_day or 0.0, 2),
            "projected_extra": future, "grand_total": round(closed + open_ + projected + future, 2)}


def estimate(database: Connection, case_id: int, extra_days: int = 0, *, workflow: dict[str, Any] | None = None,
             template: dict[str, Any] | None = None, tz_name: str | None = None, now: int) -> dict[str, Any]:
    case = database.execute("SELECT start_time, discharge_time FROM cases WHERE id=%s", (case_id,)).fetchone()
    windows = periods(case, tz_name, workflow_day_start(workflow), now)
    orders = daily_orders(database, case_id)
    order_totals = {start: total(billing.order_lines(database, order["id"])) for start, order in orders.items()}
    items = [billing.row_dict(row) for row in database.execute("SELECT * FROM billing_item ORDER BY sort_order, code").fetchall()]
    rules = standing_rules(items, template)
    devices = case_devices(database, case_id)
    previews = {w["period_start"]: total(standing_for_period(rules, devices, w)) for w in windows if w["period_start"] not in orders}
    projected_day = None
    if not case["discharge_time"]:
        # A further day: the devices still bound keep counting.
        last = windows[-1]["period_end"]
        projected_day = total(standing_for_period(rules, devices, {"period_start": last, "period_end": last + DAY}))
    return {**summarize(windows, orders, order_totals, previews, projected_day, extra_days),
            "discharged": bool(case["discharge_time"])}
