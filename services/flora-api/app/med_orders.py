"""Medication orders + MAR: due times, slot statuses, approval rules and the shift-handover section.

Pure functions (no database) except the `*_rows` readers and `handover_section`.

    order_type: "continue" (standing until stopped) | "once" (one dose at start_at); prn: as needed, no slots.
    schedule:   {"kind": "every", "every_hours": 8, "anchor": "06:00"}      anchor default: start's local HH:MM
              | {"kind": "times", "times": ["08:00", "20:00"]}
              | {"kind": "infusion", "rate": 5, "rate_unit": "ml/h"}       continuous: no slots, a running drip
              | null (once / prn)

Times are epoch ms; local times use the Leaf's time zone (form_schedule.timezone_of). An order makes slots in
[max(start_at, activated_at), end) where end = min(end_at, start_at + duration_days, discontinued_at).
"""
from __future__ import annotations

import math
import time
from datetime import timedelta
from decimal import Decimal
from typing import Any, Iterable
from uuid import UUID
from zoneinfo import ZoneInfo

from . import form_schedule as fs

GRACE_MIN = 60
ATTENDING = 30  # seniority required when the case has no doctor in its staff
ROUTES = ("PO", "IV", "IM", "SC", "SL", "PR", "INH", "TOP", "NG", "ID", "IT", "EPI", "OTHER")
APPROVAL = ("none", "order", "admin", "both")
ADMIN_STATUSES = ("given", "held", "refused", "missed", "not_given")
OPEN_STATUSES = ("pending_approval", "active", "held")
MAX_SLOTS = 2000


# ---------------------------------------------------------------- approval flags

def approval_union(*flags: Any) -> str:
    """The strictest combination: 'order' + 'admin' = 'both'; unknown values count as 'none'."""
    order = any(flag in ("order", "both") for flag in flags)
    admin = any(flag in ("admin", "both") for flag in flags)
    return "both" if order and admin else "order" if order else "admin" if admin else "none"


def needs_order_approval(flag: Any) -> bool:
    return flag in ("order", "both")


def needs_admin_approval(flag: Any) -> bool:
    return flag in ("admin", "both")


# ---------------------------------------------------------------- approver eligibility

def norm_code(value: Any) -> str:
    return str(value or "").strip().lower()


def owner_seniority(case_doctors: Iterable[dict[str, Any]]) -> int | None:
    """The case owner's seniority: the most senior doctor-type case_staff row (None: no doctor on the case)."""
    levels = [int(d.get("seniority") or 0) for d in case_doctors]
    return max(levels) if levels else None


def case_owners(case_doctors: list[dict[str, Any]]) -> list[dict[str, Any]]:
    level = owner_seniority(case_doctors)
    return [d for d in case_doctors if int(d.get("seniority") or 0) == level] if level is not None else []


def can_approve(approver: dict[str, Any], case_doctors: list[dict[str, Any]]) -> bool:
    """A doctor whose role seniority is at least the case owner's (attending, 30, when the case has no doctor),
    or the case owner themself (matched by staff_code)."""
    code = norm_code(approver.get("staff_code"))
    if code and any(norm_code(owner.get("staff_code")) == code for owner in case_owners(case_doctors)):
        return True
    if approver.get("staff_type") != "doctor":
        return False
    needed = owner_seniority(case_doctors)
    return int(approver.get("seniority") or 0) >= (ATTENDING if needed is None else needed)


# ---------------------------------------------------------------- validation

def hhmm(value: Any) -> bool:
    return isinstance(value, str) and fs.HHMM.match(value) is not None


def schedule_issues(order_type: str, prn: bool, schedule: Any) -> list[str]:
    if order_type not in ("continue", "once"):
        return ["order_type must be continue or once"]
    if schedule is None:
        if order_type == "continue" and not prn:
            return ["a continue order needs a schedule unless it is prn"]
        return []
    if not isinstance(schedule, dict):
        return ["schedule must be an object"]
    kind = schedule.get("kind")
    if order_type == "once" and kind != "infusion":
        return ["a one-time order has no schedule"]
    if kind == "every":
        hours = schedule.get("every_hours")
        issues = [] if fs.is_int(hours) and 1 <= hours <= 72 else ["every_hours must be a whole number from 1 to 72"]
        if schedule.get("anchor") is not None and not hhmm(schedule["anchor"]):
            issues.append("anchor must be HH:MM")
        return issues
    if kind == "times":
        times = schedule.get("times")
        if not isinstance(times, list) or not times or not all(hhmm(t) for t in times) or len(set(times)) != len(times):
            return ["times must be a non-empty list of distinct HH:MM"]
        return []
    if kind == "infusion":
        rate = schedule.get("rate")
        if not isinstance(rate, (int, float)) or isinstance(rate, bool) or not math.isfinite(rate) or rate < 0:
            return ["infusion rate must be a number >= 0"]
        return []
    return ["schedule kind must be every, times or infusion"]


def normalize_schedule(schedule: Any) -> dict[str, Any] | None:
    if not isinstance(schedule, dict):
        return None
    kind = schedule.get("kind")
    if kind == "every":
        out = {"kind": "every", "every_hours": schedule["every_hours"]}
        if schedule.get("anchor"):
            out["anchor"] = schedule["anchor"]
        return out
    if kind == "times":
        return {"kind": "times", "times": sorted(schedule["times"])}
    if kind == "infusion":
        return {"kind": "infusion", "rate": schedule["rate"], "rate_unit": schedule.get("rate_unit") or "ml/h"}
    return None


def is_infusion(order: dict[str, Any]) -> bool:
    return isinstance(order.get("schedule"), dict) and order["schedule"].get("kind") == "infusion"


# ---------------------------------------------------------------- due times

def tzinfo(tz: Any) -> ZoneInfo:
    return tz if isinstance(tz, ZoneInfo) else fs.zone(tz)


def effective_end(order: dict[str, Any]) -> int | None:
    ends = []
    if order.get("end_at"):
        ends.append(int(order["end_at"]))
    if order.get("duration_days"):
        ends.append(int(order["start_at"]) + int(order["duration_days"]) * fs.DAY)
    if order.get("status") in ("discontinued", "completed") and order.get("discontinued_at"):
        ends.append(int(order["discontinued_at"]))
    return min(ends) if ends else None


def due_times(order: dict[str, Any], from_ms: int, to_ms: int, tz: Any) -> list[int]:
    """Scheduled due times in [from_ms, to_ms] (inclusive), before the order's end (exclusive)."""
    zone = tzinfo(tz)
    if order.get("status") == "pending_approval" or order.get("prn"):
        return []
    start = int(order["start_at"])
    if order.get("order_type") == "once":
        if is_infusion(order):
            return []
        return [start] if from_ms <= start <= to_ms else []
    schedule = order.get("schedule") or {}
    start = max(start, int(order.get("activated_at") or 0))
    end = effective_end(order)
    first = max(start, from_ms)
    last = to_ms if end is None else min(to_ms, end - 1)
    if last < first:
        return []
    out: list[int] = []
    kind = schedule.get("kind")
    if kind == "every":
        step = int(schedule["every_hours"]) * fs.HOUR
        anchor = schedule.get("anchor") or fs.local(start, zone).strftime("%H:%M")
        base = fs.at_local(fs.local(start, zone).date(), fs.minutes(anchor), zone)
        ts = base + math.ceil((first - base) / step) * step
        while ts <= last and len(out) < MAX_SLOTS:
            out.append(ts)
            ts += step
        return out
    if kind == "times":
        offsets = sorted(fs.minutes(t) for t in schedule.get("times") or [])
        day = fs.local(first, zone).date()
        last_day = fs.local(last, zone).date()
        while day <= last_day and len(out) < MAX_SLOTS:
            out.extend(ts for ts in (fs.at_local(day, m, zone) for m in offsets) if first <= ts <= last)
            day += timedelta(days=1)
        return out
    return []


# ---------------------------------------------------------------- MAR status

def in_hold(order: dict[str, Any], ts: int) -> bool:
    for hold in order.get("holds") or []:
        if int(hold.get("from") or 0) <= ts and (hold.get("to") is None or ts < int(hold["to"])):
            return True
    return False


def slot_status(due_at: int, now: int, admin: dict[str, Any] | None = None, held: bool = False,
                grace_min: int = GRACE_MIN) -> str:
    """given / held / refused / missed / not_given (recorded), else held (order on hold), upcoming, due
    (within +-grace of the due time) or overdue."""
    if admin is not None:
        return admin["status"]
    if held:
        return "held"
    grace = grace_min * fs.MINUTE
    if now < due_at - grace:
        return "upcoming"
    return "due" if now < due_at + grace else "overdue"


def mar_slots(order: dict[str, Any], admins: list[dict[str, Any]], from_ms: int, to_ms: int, now: int, tz: Any,
              grace_min: int = GRACE_MIN) -> list[dict[str, Any]]:
    """[{due_at, status, admin_id}] for the window: computed slots plus recorded doses whose due_at is no longer
    a slot (the schedule changed)."""
    by_due = {int(a["due_at"]): a for a in admins if a.get("due_at") is not None}
    times = set(due_times(order, from_ms, to_ms, tz))
    times.update(ts for ts in by_due if from_ms <= ts <= to_ms)
    out = []
    for ts in sorted(times):
        admin = by_due.get(ts)
        out.append({"due_at": ts, "status": slot_status(ts, now, admin, in_hold(order, ts), grace_min),
                    "admin_id": str(admin["id"]) if admin else None})
    return out


# ---------------------------------------------------------------- public rows

def plain(value: Any) -> Any:
    """JSON-safe copy of a row (uuid -> str, numeric -> float)."""
    if isinstance(value, dict):
        return {k: plain(v) for k, v in value.items()}
    if isinstance(value, list):
        return [plain(v) for v in value]
    if isinstance(value, UUID):
        return str(value)
    if isinstance(value, Decimal):
        return float(value)
    return value


def order_rows(database: Any, case_id: int, open_only: bool = False) -> list[dict[str, Any]]:
    where = " AND o.status IN ('pending_approval','active','held')" if open_only else ""
    return [plain(row) for row in database.execute(
        f"""SELECT o.*, i.code AS item_code, i.default_unit AS item_unit FROM case_med_order o
            LEFT JOIN io_item_master i ON i.id = o.item_id WHERE o.case_id=%s{where}
            ORDER BY o.order_type, o.status = 'discontinued', o.start_at, o.drug_name""", (case_id,)).fetchall()]


def admin_rows(database: Any, case_id: int) -> list[dict[str, Any]]:
    return [plain(row) for row in database.execute(
        "SELECT * FROM case_med_admin WHERE case_id=%s ORDER BY coalesce(given_at, due_at, recorded_at)", (case_id,)).fetchall()]


def approval_rows(database: Any, case_id: int) -> list[dict[str, Any]]:
    return [plain(row) for row in database.execute(
        "SELECT * FROM case_med_approval WHERE case_id=%s ORDER BY approved_at", (case_id,)).fetchall()]


def running_infusions(database: Any, case_id: int) -> list[dict[str, Any]]:
    """Drips started from the MAR that are still running, with their latest segment rate."""
    return [plain(row) for row in database.execute(
        """SELECT a.order_id, o.drug_name, r.id AS run_id, r.started_at, s.rate_value, s.rate_unit, s.dose_value, s.dose_unit
           FROM case_med_admin a JOIN case_med_order o ON o.id = a.order_id
           JOIN case_io_run r ON r.id = a.io_run_id AND r.stopped_at IS NULL
           LEFT JOIN LATERAL (SELECT * FROM case_io_segment WHERE run_id = r.id ORDER BY ts_from DESC, id DESC LIMIT 1) s ON true
           WHERE a.case_id=%s ORDER BY r.started_at""", (case_id,)).fetchall()]


def window_bounds(window: Any) -> tuple[int, int]:
    if isinstance(window, dict):
        return int(window.get("from") or window.get("from_ms")), int(window.get("to") or window.get("to_ms"))
    return int(window[0]), int(window[1])


def handover_section(database: Any, case_id: int, window: Any) -> dict[str, Any]:
    """Medication part of the shift handover. `window` = (from_ms, to_ms) or {"from", "to"}.

    {window, active_orders, due: [{order_id, drug_name, dose, dose_unit, route, due_at, status}] (due / overdue
     slots in the window), given: [admin + drug_name] (given in the window), infusions: [running drips],
     approvals: [doctor PIN approvals in the window], counts: {active, due, overdue, given, infusions}}
    """
    from_ms, to_ms = window_bounds(window)
    now = int(time.time() * 1000)
    tz = fs.timezone_of(database)
    orders = order_rows(database, case_id)
    admins = admin_rows(database, case_id)
    names = {o["id"]: o["drug_name"] for o in orders}
    due = []
    for order in orders:
        own = [a for a in admins if a["order_id"] == order["id"]]
        for slot in mar_slots(order, own, from_ms, to_ms, now, tz):
            if slot["status"] in ("due", "overdue"):
                due.append({"order_id": order["id"], "drug_name": order["drug_name"], "dose": order.get("dose"),
                            "dose_unit": order.get("dose_unit"), "route": order.get("route"), **slot})
    given = [{**a, "drug_name": names.get(a["order_id"])} for a in admins
             if a["status"] == "given" and a.get("given_at") is not None and from_ms <= a["given_at"] <= to_ms]
    approvals = [a for a in approval_rows(database, case_id) if from_ms <= a["approved_at"] <= to_ms]
    active = [o for o in orders if o["status"] in OPEN_STATUSES]
    infusions = running_infusions(database, case_id)
    return {"window": {"from": from_ms, "to": to_ms}, "active_orders": active, "due": sorted(due, key=lambda d: d["due_at"]),
            "given": given, "infusions": infusions, "approvals": approvals,
            "counts": {"active": len(active), "due": sum(1 for d in due if d["status"] == "due"),
                       "overdue": sum(1 for d in due if d["status"] == "overdue"), "given": len(given),
                       "infusions": len(infusions)}}
