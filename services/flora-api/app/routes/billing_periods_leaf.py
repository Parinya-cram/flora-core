"""Leaf: ICU daily billing of a case, one order per billing day (see app/billing_periods.py).

A day is addressed by its period_start (epoch ms). Opening a day that has started creates its order
with the standing charges; Close submits and locks it (and sends it to Canopy with the next snapshot,
key "billing_all" = GET /{case_id}/billing/all); Reopen needs billing.manage.
"""
from typing import Any

from fastapi import APIRouter, Body, Depends, HTTPException, Query
from psycopg import Connection

from .. import billing, billing_periods
from ..clinical import case_audit, text
from ..database import connection
from ..form_schedule import timezone_of, workflow_day_start
from .auth_leaf import now_ms, require_permission
from .billing_leaf import case_template
from .cases_lifecycle import editable_case

router = APIRouter(prefix="/api/case", tags=["billing"])


def _workflow(database: Connection, row: dict[str, Any]) -> dict[str, Any] | None:
    """The case's workflow; a case without one uses the ward's default workflow (as case_template does)."""
    from .case_workflow import cached_items
    if isinstance(row.get("workflow"), dict):
        return row["workflow"]
    items, _forms, _synced = cached_items(database)
    return next((item["definition"] for item in items if item.get("isDefault")), None)


def _context(database: Connection, case_id: int, now: int) -> dict[str, Any]:
    row = database.execute("SELECT id, status, start_time, discharge_time, workflow FROM cases WHERE id=%s", (case_id,)).fetchone()
    if row is None:
        raise HTTPException(404, "case not found")
    workflow = _workflow(database, row)
    tz = timezone_of(database)
    day_start = workflow_day_start(workflow)
    return {"case": row, "workflow": workflow, "template": case_template(database, case_id), "timezone": tz,
            "day_start": day_start, "windows": billing_periods.periods(row, tz, day_start, now),
            "mode": billing_periods.billing_mode(workflow)}


def _case_order_used(database: Connection, case_id: int) -> bool:
    order = billing.live_order(database, case_id)
    return bool(order and database.execute("SELECT 1 FROM case_billing_order_item WHERE order_id=%s", (order["id"],)).fetchone())


def _window(ctx: dict[str, Any], orders: dict[int, dict[str, Any]], period_start: int, now: int) -> dict[str, Any]:
    if period_start > now:
        raise HTTPException(409, "this billing day has not started")
    order = orders.get(period_start)
    if order is not None:  # also a day kept from before a day_start change
        return {"period_start": int(order["period_start"]), "period_end": int(order["period_end"])}
    window = billing_periods.find_period(ctx["windows"], period_start)
    if window is None:
        raise HTTPException(404, "not a billing day of this case")
    return window


def _day_payload(database: Connection, case_id: int, ctx: dict[str, Any], window: dict[str, Any],
                 order: dict[str, Any] | None) -> dict[str, Any]:
    known = billing_periods.find_period(ctx["windows"], window["period_start"]) or window
    out: dict[str, Any] = {"period": {**known, "period_end": window["period_end"]}, "timezone": ctx["timezone"],
                           "day_start": ctx["day_start"], "template": ctx["template"]}
    if order is not None:
        out.update(billing.order_payload(database, case_id, order))
        out["locked"] = order["status"] == "submitted"
    else:
        lines = billing_periods.standing_lines(database, case_id, window, ctx["template"])
        for line in lines:
            line["amount"] = billing.amount(line)
        out.update({"order": None, "items": [], "total_amount": None, "locked": False,
                    "standing_preview": {"items": lines, "total_amount": billing_periods.total(lines)}})
    return out


def _unknown(devices: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return [{"device_id": d["device_id"], "device_type": d["device_type"], "label": d["label"]} for d in devices if not d["kind"]]


@router.get("/{case_id}/billing/periods")
def list_periods(case_id: int, _: dict = Depends(require_permission("case.read")),
                 database: Connection = Depends(connection)) -> dict:
    """Billing days with status (open / closed), totals, and today's standing charges."""
    now = now_ms()
    ctx = _context(database, case_id, now)
    orders = billing_periods.daily_orders(database, case_id)
    # A day kept from before a day_start change is listed too.
    windows = ctx["windows"] + [{"day": None, "period_start": start, "period_end": int(order["period_end"]), "date": None,
                                 "current": False} for start, order in orders.items()
                                if billing_periods.find_period(ctx["windows"], start) is None]
    estimate = billing_periods.estimate(database, case_id, 0, workflow=ctx["workflow"], template=ctx["template"],
                                        tz_name=ctx["timezone"], now=now)
    totals = {day["period_start"]: day for day in estimate["days"]}
    devices = billing_periods.case_devices(database, case_id)
    current = next((w for w in ctx["windows"] if w["current"]), ctx["windows"][-1])
    preview = billing_periods.standing_lines(database, case_id, current, ctx["template"], devices)
    for line in preview:
        line["amount"] = billing.amount(line)
    days = []
    for window in sorted(windows, key=lambda w: w["period_start"]):
        order = orders.get(window["period_start"])
        days.append({**window, "status": "closed" if order and order["status"] == "submitted" else "open",
                     "has_order": order is not None, "order_uuid": str(order["order_uuid"]) if order else None,
                     "item_count": len(billing.order_lines(database, order["id"])) if order else 0,
                     "total": (totals.get(window["period_start"]) or {}).get("total"),
                     "closed_at": (order or {}).get("closed_at"), "closed_by": (order or {}).get("closed_by"),
                     "handover_billed": bool((order or {}).get("handover_billed"))})
    case_used = _case_order_used(database, case_id)
    mode = "daily" if ctx["mode"] == "daily" or orders else "case"
    return {"mode": mode, "workflow_mode": ctx["mode"], "can_switch": ctx["mode"] != "daily" and not orders and not case_used,
            "case_order_used": case_used, "timezone": ctx["timezone"], "day_start": ctx["day_start"],
            "case_status": ctx["case"]["status"], "days": days,
            "standing_preview": {"period_start": current["period_start"], "items": preview,
                                 "total_amount": billing_periods.total(preview)},
            "devices": [{k: d[k] for k in ("device_id", "device_type", "label", "kind", "bound_at", "released_at")} for d in devices],
            "unknown_devices": _unknown(devices)}


@router.get("/{case_id}/billing/periods/{period_start}")
def read_period(case_id: int, period_start: int, actor: dict = Depends(require_permission("case.read")),
                database: Connection = Depends(connection)) -> dict:
    """The day's lines. The first open by someone who may chart creates the order with its standing charges."""
    now = now_ms()
    with database.transaction():
        ctx = _context(database, case_id, now)
        orders = billing_periods.daily_orders(database, case_id)
        window = _window(ctx, orders, period_start, now)
        order = orders.get(period_start)
        may_create = ("case.chart" in actor.get("_permissions", []) and ctx["case"]["status"] != "archived"
                      and (ctx["mode"] == "daily" or orders or not _case_order_used(database, case_id)))
        if order is None and may_create:
            editable_case(database, case_id)
            order, created = billing_periods.ensure_daily_order(database, case_id, window, actor["username"], now)
            if created:
                billing_periods.generate(database, case_id, order, ctx["template"], now, manual=[])
                case_audit(database, case_id, "billing.day.open", None, {"period_start": period_start}, actor)
        return _day_payload(database, case_id, ctx, window, order)


def _open_order(database: Connection, case_id: int, period_start: int, actor: dict, now: int,
                create: bool = True) -> tuple[dict[str, Any], dict[str, Any], dict[str, Any]]:
    """(ctx, window, order) of a day that may be changed; the order is created when missing."""
    editable_case(database, case_id)
    ctx = _context(database, case_id, now)
    orders = billing_periods.daily_orders(database, case_id)
    window = _window(ctx, orders, period_start, now)
    order = orders.get(period_start)
    if order is None:
        if not create:
            raise HTTPException(404, "no billing for this day yet")
        if ctx["mode"] != "daily" and not orders and _case_order_used(database, case_id):
            raise HTTPException(409, "this case is billed per case (the case billing has items)")
        order, _created = billing_periods.ensure_daily_order(database, case_id, window, actor["username"], now)
        billing_periods.generate(database, case_id, order, ctx["template"], now, manual=[])
    return ctx, window, order


def _locked(order: dict[str, Any]) -> None:
    if order["status"] == "submitted":
        raise HTTPException(409, "this billing day is closed; reopen it to make changes")


def _audit_lines(database: Connection, order_id: int) -> list[list[Any]]:
    return [[i["item_code"] or i["name"], i["qty"], i["source"]] for i in billing.order_lines(database, order_id)]


@router.put("/{case_id}/billing/periods/{period_start}")
def save_period(case_id: int, period_start: int, payload: dict = Body(...), actor: dict = Depends(require_permission("case.chart")),
                database: Connection = Depends(connection)) -> dict:
    """Replace the day's manual lines (same line format as PUT /billing); the standing lines stay."""
    now = now_ms()
    with database.transaction():
        ctx, window, order = _open_order(database, case_id, period_start, actor, now)
        _locked(order)
        try:
            manual = billing.normalise_lines(database, payload.get("items") or [])
        except ValueError as error:
            raise HTTPException(400, str(error)) from error
        before = _audit_lines(database, order["id"])
        standing = [line for line in billing.order_lines(database, order["id"]) if line.get("source") == "standing"]
        billing_periods.write_lines(database, case_id, order["id"], billing_periods.merge(standing, manual), now)
        database.execute("UPDATE case_billing_order SET note=%s,updated_by=%s,updated_at=%s WHERE id=%s",
                         (text(payload.get("note")) or None, actor["username"], now, order["id"]))
        case_audit(database, case_id, "billing.day.save", {"period_start": period_start, "items": before},
                   {"period_start": period_start, "items": _audit_lines(database, order["id"])}, actor)
        order = billing_periods.daily_orders(database, case_id)[period_start]
        return _day_payload(database, case_id, ctx, window, order)


@router.post("/{case_id}/billing/periods/{period_start}/generate")
def generate_period(case_id: int, period_start: int, actor: dict = Depends(require_permission("case.chart")),
                    database: Connection = Depends(connection)) -> dict:
    """Recompute the day's standing charges (e.g. after a ventilator was bound)."""
    now = now_ms()
    with database.transaction():
        ctx, window, order = _open_order(database, case_id, period_start, actor, now)
        _locked(order)
        billing_periods.generate(database, case_id, order, ctx["template"], now)
        database.execute("UPDATE case_billing_order SET updated_by=%s,updated_at=%s WHERE id=%s", (actor["username"], now, order["id"]))
        return _day_payload(database, case_id, ctx, window, billing_periods.daily_orders(database, case_id)[period_start])


@router.post("/{case_id}/billing/periods/{period_start}/close")
def close_period(case_id: int, period_start: int, actor: dict = Depends(require_permission("case.chart")),
                 database: Connection = Depends(connection)) -> dict:
    """Close the day: refresh its standing charges, then submit and lock it."""
    now = now_ms()
    with database.transaction():
        ctx, window, order = _open_order(database, case_id, period_start, actor, now)
        _locked(order)
        billing_periods.generate(database, case_id, order, ctx["template"], now)
        database.execute(
            """UPDATE case_billing_order SET status='submitted',submitted_at=%s,submitted_by=%s,closed_at=%s,closed_by=%s,
                 updated_by=%s,updated_at=%s WHERE id=%s""",
            (now, actor["username"], now, actor["username"], actor["username"], now, order["id"]))
        case_audit(database, case_id, "billing.day.close", {"period_start": period_start, "status": "draft"},
                   {"period_start": period_start, "status": "submitted"}, actor)
        return _day_payload(database, case_id, ctx, window, billing_periods.daily_orders(database, case_id)[period_start])


@router.post("/{case_id}/billing/periods/{period_start}/reopen")
def reopen_period(case_id: int, period_start: int, actor: dict = Depends(require_permission("billing.manage")),
                  database: Connection = Depends(connection)) -> dict:
    """Unlock a closed day (billing.manage: the day was already sent to billing)."""
    now = now_ms()
    with database.transaction():
        ctx, window, order = _open_order(database, case_id, period_start, actor, now, create=False)
        if order["status"] != "submitted":
            raise HTTPException(409, "this billing day is not closed")
        if order.get("handover_billed"):
            raise HTTPException(409, "this day was billed under the previous case of the handover")
        database.execute(
            """UPDATE case_billing_order SET status='draft',submitted_at=NULL,submitted_by=NULL,closed_at=NULL,closed_by=NULL,
                 updated_by=%s,updated_at=%s WHERE id=%s""", (actor["username"], now, order["id"]))
        case_audit(database, case_id, "billing.day.reopen", {"period_start": period_start, "status": "submitted"},
                   {"period_start": period_start, "status": "draft"}, actor)
        return _day_payload(database, case_id, ctx, window, billing_periods.daily_orders(database, case_id)[period_start])


@router.get("/{case_id}/billing/estimate")
def estimate(case_id: int, extra_days: int = Query(default=0, ge=0, le=365), _: dict = Depends(require_permission("case.read")),
             database: Connection = Depends(connection)) -> dict:
    """Closed days + open days + standing charges projected to today, plus extra_days more days."""
    now = now_ms()
    ctx = _context(database, case_id, now)
    return billing_periods.estimate(database, case_id, extra_days, workflow=ctx["workflow"], template=ctx["template"],
                                    tz_name=ctx["timezone"], now=now)


@router.get("/{case_id}/billing/all")
def all_orders(case_id: int, _: dict = Depends(require_permission("case.read")), database: Connection = Depends(connection)) -> dict:
    """Every live order of the case (the case order and each billing day): snapshot key "billing_all"."""
    if not database.execute("SELECT 1 FROM cases WHERE id=%s", (case_id,)).fetchone():
        raise HTTPException(404, "case not found")
    rows = database.execute(
        """SELECT * FROM case_billing_order WHERE case_id=%s AND status<>'void'
           ORDER BY (kind='daily'), period_start NULLS FIRST, id""", (case_id,)).fetchall()
    return {"orders": [billing.order_payload(database, case_id, billing.row_dict(row)) for row in rows]}
