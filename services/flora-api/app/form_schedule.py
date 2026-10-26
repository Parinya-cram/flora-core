"""Scheduled workflow forms (ICU rounds): slots are computed from the form's `schedule`, never stored.

See docs/ICU-ROUNDS.md. Pure functions (no database) except `timezone_of`.

    schedule = {"kind": "daily" | "every" | "per_shift", "at": "07:00", "every_hours": 8,
                "days": None | N, "grace_min": 120}

Times are epoch ms; local times use the Leaf's time zone (workstation_context.timezone).
"""
from __future__ import annotations

import re
from datetime import date, datetime, timedelta
from typing import Any, Iterable
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

DEFAULT_TIMEZONE = "Asia/Bangkok"
DEFAULT_DAY_START = "07:00"
DEFAULT_SHIFTS: list[dict[str, str]] = [
    {"code": "D", "label": "Day", "start": "07:00"},
    {"code": "E", "label": "Evening", "start": "15:00"},
    {"code": "N", "label": "Night", "start": "23:00"},
]
KINDS = ("daily", "every", "per_shift")
DEFAULT_GRACE_MIN = 120
HHMM = re.compile(r"^([01]\d|2[0-3]):([0-5]\d)\Z")
SHIFT_CODE = re.compile(r"^[A-Za-z0-9]{1,8}\Z")
MINUTE = 60_000
HOUR = 60 * MINUTE
DAY = 24 * HOUR


def minutes(value: str) -> int:
    hours, mins = value.split(":")
    return int(hours) * 60 + int(mins)


def zone(name: str | None) -> ZoneInfo:
    try:
        return ZoneInfo(name or DEFAULT_TIMEZONE)
    except (ZoneInfoNotFoundError, ValueError):
        return ZoneInfo(DEFAULT_TIMEZONE)


def timezone_of(database: Any) -> str:
    """The Leaf's time zone (workstation_context.timezone), Asia/Bangkok when unset or unknown."""
    try:
        row = database.execute("SELECT timezone FROM workstation_context WHERE id=1").fetchone() or {}
    except Exception:  # noqa: BLE001 - no workstation context table (Canopy)
        return DEFAULT_TIMEZONE
    name = (row or {}).get("timezone") or DEFAULT_TIMEZONE
    try:
        ZoneInfo(name)
    except (ZoneInfoNotFoundError, ValueError):
        return DEFAULT_TIMEZONE
    return name


# ---------------------------------------------------------------- definition

def normalize_schedule(value: Any) -> Any:
    """The schedule as stored in a workflow (None = not scheduled); unknown values are kept for validation."""
    if value is None or value == {}:
        return None
    if not isinstance(value, dict):
        return value
    kind = value.get("kind")
    out: dict[str, Any] = {"kind": kind}
    if kind == "daily":
        out["at"] = value.get("at") or DEFAULT_DAY_START
    if kind == "every":
        out["every_hours"] = value.get("every_hours")
    out["days"] = value.get("days")
    if value.get("grace_min") is not None:
        out["grace_min"] = value.get("grace_min")
    return out


def is_int(value: Any) -> bool:
    return isinstance(value, int) and not isinstance(value, bool)


def schedule_issues(schedule: Any, path: str) -> list[dict[str, str]]:
    if schedule is None:
        return []
    if not isinstance(schedule, dict):
        return [{"path": path, "message": "schedule must be an object"}]
    issues = []
    kind = schedule.get("kind")
    if kind not in KINDS:
        return [{"path": f"{path}.kind", "message": "kind must be daily, every or per_shift"}]
    if kind == "daily" and not (isinstance(schedule.get("at"), str) and HHMM.match(schedule["at"])):
        issues.append({"path": f"{path}.at", "message": "at must be HH:MM (00:00-23:59)"})
    if kind == "every" and not (is_int(schedule.get("every_hours")) and 1 <= schedule["every_hours"] <= 24):
        issues.append({"path": f"{path}.every_hours", "message": "every_hours must be a whole number from 1 to 24"})
    days = schedule.get("days")
    if days is not None and not (is_int(days) and 1 <= days <= 365):
        issues.append({"path": f"{path}.days", "message": "days must be null (until discharge) or 1-365"})
    grace = schedule.get("grace_min")
    if grace is not None and not (is_int(grace) and 1 <= grace <= 24 * 60):
        issues.append({"path": f"{path}.grace_min", "message": "grace_min must be 1-1440 minutes"})
    return issues


def day_settings_issues(day_start: Any, shifts: Any) -> list[dict[str, str]]:
    issues = []
    if day_start is not None and not (isinstance(day_start, str) and HHMM.match(day_start)):
        issues.append({"path": "$.day_start", "message": "day_start must be HH:MM (00:00-23:59)"})
    if shifts is None:
        return issues
    if not isinstance(shifts, list) or not shifts:
        return issues + [{"path": "$.shifts", "message": "shifts must be a non-empty list"}]
    codes: set[str] = set()
    previous = -1
    for index, shift in enumerate(shifts):
        path = f"$.shifts[{index}]"
        if not isinstance(shift, dict):
            issues.append({"path": path, "message": "shift must be an object"})
            continue
        code = shift.get("code")
        if not isinstance(code, str) or not SHIFT_CODE.match(code):
            issues.append({"path": f"{path}.code", "message": "code must be 1-8 letters or digits"})
        elif code in codes:
            issues.append({"path": f"{path}.code", "message": f"shift code '{code}' is listed twice"})
        else:
            codes.add(code)
        start = shift.get("start")
        if not (isinstance(start, str) and HHMM.match(start)):
            issues.append({"path": f"{path}.start", "message": "start must be HH:MM (00:00-23:59)"})
            continue
        if minutes(start) <= previous:
            issues.append({"path": f"{path}.start", "message": "shifts must be ordered by start time"})
        previous = minutes(start)
    return issues


def workflow_day_start(workflow: dict[str, Any] | None) -> str:
    value = (workflow or {}).get("day_start")
    return value if isinstance(value, str) and HHMM.match(value) else DEFAULT_DAY_START


def workflow_shifts(workflow: dict[str, Any] | None) -> list[dict[str, str]]:
    value = (workflow or {}).get("shifts")
    if isinstance(value, list) and value and not day_settings_issues(None, value):
        return [{"code": s["code"], "label": str(s.get("label") or s["code"]), "start": s["start"]} for s in value]
    return [dict(s) for s in DEFAULT_SHIFTS]


# ---------------------------------------------------------------- slots

def local(ts: int, tz: ZoneInfo) -> datetime:
    return datetime.fromtimestamp(ts / 1000, tz)


def at_local(day: date, minute_of_day: int, tz: ZoneInfo) -> int:
    moment = datetime(day.year, day.month, day.day, minute_of_day // 60, minute_of_day % 60, tzinfo=tz)
    return int(moment.timestamp() * 1000)


def stay_day(ts: int, start: int, tz: ZoneInfo, day_start: str = DEFAULT_DAY_START) -> int:
    """1-based day of the stay; day 1 starts at the first day_start at or before the case start."""
    shift = timedelta(minutes=minutes(day_start))
    return ((local(ts, tz) - shift).date() - (local(start, tz) - shift).date()).days + 1


def window(start: int, discharge: int | None, now: int, days: int | None) -> tuple[int, int]:
    """[first, last] bounds of the slots: from the case start (minute precision) to
    min(discharge or now+24h, start + days*24h)."""
    first = -(-start // MINUTE) * MINUTE  # first whole minute at or after the start
    last = discharge if discharge is not None else now + DAY
    if days:
        last = min(last, start + days * DAY)
    return first, last


def slot_times(schedule: dict[str, Any], start: int, discharge: int | None, now: int, tz: ZoneInfo,
               day_start: str = DEFAULT_DAY_START,
               shifts: list[dict[str, str]] | None = None) -> list[tuple[int, str | None, int]]:
    """[(slot_ts, shift_code|None, grace_ms)] in time order."""
    first, last = window(start, discharge, now, schedule.get("days"))
    if last < first:
        return []
    kind = schedule.get("kind")
    grace_min = schedule.get("grace_min")
    grace = int(grace_min) * MINUTE if grace_min else DEFAULT_GRACE_MIN * MINUTE
    out: list[tuple[int, str | None, int]] = []
    first_day = local(first, tz).date() - timedelta(days=1)
    last_day = local(last, tz).date() + timedelta(days=1)
    if kind == "every":
        step = int(schedule["every_hours"]) * HOUR
        anchor_day = (local(start, tz) - timedelta(minutes=minutes(day_start))).date()
        ts = at_local(anchor_day, minutes(day_start), tz)
        while ts <= last:
            if ts >= first:
                out.append((ts, None, grace))
            ts += step
        return out
    day = first_day
    while day <= last_day:
        if kind == "daily":
            candidates = [(at_local(day, minutes(schedule.get("at") or DEFAULT_DAY_START), tz), None, grace)]
        elif kind == "per_shift":
            shift_list = shifts or DEFAULT_SHIFTS
            starts = [minutes(s["start"]) for s in shift_list]
            candidates = []
            for index, shift in enumerate(shift_list):
                ends = starts[index + 1] if index + 1 < len(starts) else starts[0] + 24 * 60
                length = (ends - starts[index]) * MINUTE
                candidates.append((at_local(day, starts[index], tz), shift["code"], int(grace_min) * MINUTE if grace_min else length))
        else:
            return []
        out.extend(c for c in candidates if first <= c[0] <= last)
        day += timedelta(days=1)
    return sorted(out)


def slot_status(slot_ts: int, grace: int, now: int, entry: dict[str, Any] | None) -> str:
    if entry is not None:
        return {"completed": "done", "skipped": "skipped"}.get(entry.get("status"), "draft")
    if now < slot_ts:
        return "upcoming"
    return "due" if now < slot_ts + grace else "overdue"


def label(slot_ts: int, day: int, shift: str | None, tz: ZoneInfo) -> str:
    return f"Day {day} · {shift if shift else local(slot_ts, tz).strftime('%H:%M')}"


def slots(schedule: dict[str, Any], start: int, discharge: int | None, now: int, tz_name: str | None,
          day_start: str = DEFAULT_DAY_START, shifts: list[dict[str, str]] | None = None,
          entries: Iterable[dict[str, Any]] = ()) -> list[dict[str, Any]]:
    """[Slot] with statuses from the entries ({id, slot_ts, status}); see docs/ICU-ROUNDS.md."""
    tz = zone(tz_name)
    by_slot = {int(e["slot_ts"]): e for e in entries if e.get("slot_ts") is not None}
    out = []
    for slot_ts, shift, grace in slot_times(schedule, start, discharge, now, tz, day_start, shifts):
        entry = by_slot.get(slot_ts)
        day = stay_day(slot_ts, start, tz, day_start)
        out.append({"slot_ts": slot_ts, "day": day, "shift": shift, "label": label(slot_ts, day, shift, tz),
                    "status": slot_status(slot_ts, grace, now, entry),
                    "entry_id": str(entry["id"]) if entry is not None else None,
                    # Who / when, so a slot list needs no request per entry (entry rows or public entries).
                    "completedBy": field(entry, "completed_by", "completedBy"),
                    "completedAt": field(entry, "completed_at", "completedAt"),
                    "skipReason": field(entry, "skip_reason", "skipReason"),
                    "updatedAt": field(entry, "updated_at", "updatedAt")})
    return out


def field(entry: dict[str, Any] | None, *names: str) -> Any:
    for name in names:
        if entry is not None and entry.get(name) is not None:
            return entry[name]
    return None


def summary(slot_list: list[dict[str, Any]]) -> dict[str, int]:
    return {key: sum(1 for s in slot_list if s["status"] == key) for key in ("due", "overdue", "done")}


def next_slot_ts(slot_list: list[dict[str, Any]]) -> int | None:
    """The earliest slot still to be filled (overdue, due or upcoming)."""
    open_slots = [s["slot_ts"] for s in slot_list if s["status"] in ("overdue", "due", "upcoming")]
    return min(open_slots) if open_slots else None


# ---------------------------------------------------------------- shift windows (shift handover)

def shift_window(ts: int, shifts: list[dict[str, str]] | None, tz: ZoneInfo | str | None,
                 offset: int = 0) -> dict[str, Any]:
    """The shift containing `ts` ({code, label, start, end}, end exclusive); offset -1 = the shift before it,
    +1 = the one after. A shift that starts before midnight (N 23:00) ends on the next day."""
    zone_info = tz if isinstance(tz, ZoneInfo) else zone(tz)
    shift_list = shifts or DEFAULT_SHIFTS
    today = local(ts, zone_info).date()
    starts = sorted(((at_local(today + timedelta(days=d), minutes(s["start"]), zone_info), s)
                    for d in (-1, 0, 1) for s in shift_list), key=lambda pair: pair[0])
    index = max(i for i, (start, _) in enumerate(starts) if start <= ts)
    start, shift = starts[index]
    window_out = {"code": shift["code"], "label": str(shift.get("label") or shift["code"]), "start": start,
                  "end": starts[index + 1][0]}
    if offset < 0:
        return shift_window(start - 1, shift_list, zone_info, offset + 1)
    if offset > 0:
        return shift_window(window_out["end"], shift_list, zone_info, offset - 1)
    return window_out


def previous_shift_window(ts: int, shifts: list[dict[str, str]] | None, tz: ZoneInfo | str | None) -> dict[str, Any]:
    return shift_window(ts, shifts, tz, -1)
