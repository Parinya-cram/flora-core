"""OR ward sessions: a Canopy admission booked into an OR room, and its journey through the OR ward.

journey_state (display label as used on OR boards):
  booked (Appointed) → assigned (Waiting: bed / Leaf assigned) → in_or (Operation: moved in)
  → awaiting_recovery / assigned_recovery / in_recovery (Recovery) → discharged (Completed).
Before the patient arrives a booking can instead be closed: cancelled, postponed, no_show or miscreate
(booked by mistake); restoring it books it again.
"""
from __future__ import annotations

from typing import Any, Iterable

SLOT_MIN = 15
MINUTE_MS = 60_000
CLOSED_STATES = ("cancelled", "postponed", "no_show", "miscreate")
STATES = ("booked", "assigned", "in_or", "awaiting_recovery", "assigned_recovery", "in_recovery", "discharged", *CLOSED_STATES)
LABEL = {"booked": "Appointed", "assigned": "Waiting", "in_or": "Operation", "awaiting_recovery": "Recovery",
         "assigned_recovery": "Recovery", "in_recovery": "Recovery", "discharged": "Completed", "cancelled": "Cancelled",
         "postponed": "Postponed", "no_show": "No-show", "miscreate": "Miscreate"}
# Allowed moves; anything else is refused (a Leaf event arriving late may also skip ahead along this path).
NEXT = {
    "booked": {"assigned", "in_or", *CLOSED_STATES},
    "assigned": {"booked", "in_or", *CLOSED_STATES},
    "in_or": {"awaiting_recovery", "discharged"},
    "awaiting_recovery": {"assigned_recovery", "in_recovery", "discharged"},
    "assigned_recovery": {"awaiting_recovery", "in_recovery", "discharged"},
    "in_recovery": {"discharged", "awaiting_recovery"},  # recovered in the OR room, then moved to recovery
    "discharged": set(),
    **{state: {"booked"} for state in CLOSED_STATES},
}
OPEN_STATES = {"booked", "assigned", "in_or", "awaiting_recovery", "assigned_recovery", "in_recovery"}
DEFAULT_DURATION_MIN = 120


class TransitionError(ValueError):
    pass


def check_transition(current: str, target: str) -> None:
    if target not in NEXT.get(current, set()):
        raise TransitionError(f"a session that is {LABEL.get(current, current)} cannot become {LABEL.get(target, target)}")


def snap(ts: int, step_min: int = SLOT_MIN) -> int:
    step = step_min * MINUTE_MS
    return (ts + step // 2) // step * step


def snap_duration(minutes: int | None) -> int:
    value = int(minutes or DEFAULT_DURATION_MIN)
    return max(SLOT_MIN, min(24 * 60, (value + SLOT_MIN // 2) // SLOT_MIN * SLOT_MIN))


def span(session: dict[str, Any]) -> tuple[int, int] | None:
    start = session.get("scheduled_at")
    if not start:
        return None
    return int(start), int(start) + snap_duration(session.get("duration_min")) * MINUTE_MS


def team_codes(session: dict[str, Any]) -> set[str]:
    return {str(member.get("staff_code") or "").strip().lower()
            for member in session.get("team") or [] if isinstance(member, dict) and member.get("staff_code")}


def conflicts(sessions: Iterable[dict[str, Any]]) -> dict[str, list[dict[str, Any]]]:
    """{session id: [{kind: room|staff, with: other id, staff_code?}]} for open sessions whose times overlap
    in the same room, or that share a team member. Warnings only: booking may still go ahead."""
    rows = [row for row in sessions if row.get("journey_state") in OPEN_STATES and span(row)]
    out: dict[str, list[dict[str, Any]]] = {}
    for index, first in enumerate(rows):
        a = span(first)
        for second in rows[index + 1:]:
            b = span(second)
            if not (a[0] < b[1] and b[0] < a[1]):
                continue
            found = []
            if first.get("room_location_id") and first.get("room_location_id") == second.get("room_location_id"):
                found.append({"kind": "room"})
            for code in sorted(team_codes(first) & team_codes(second)):
                found.append({"kind": "staff", "staff_code": code})
            for item in found:
                out.setdefault(str(first["id"]), []).append({**item, "with": str(second["id"])})
                out.setdefault(str(second["id"]), []).append({**item, "with": str(first["id"])})
    return out


def normalize_team(raw: Any) -> list[dict[str, Any]]:
    team = []
    seen = set()
    for member in raw if isinstance(raw, list) else []:
        if not isinstance(member, dict):
            continue
        code = str(member.get("staff_code") or "").strip()
        role = str(member.get("role_id") or "").strip()
        name = str(member.get("name") or "").strip()
        if not (code or name) or not role:
            continue
        key = (code.lower() or name.lower(), role)
        if key in seen:
            continue
        seen.add(key)
        team.append({"staff_code": code or None, "role_id": role, "name": name[:200] or None,
                     **({"slot": str(member["slot"])[:20]} if member.get("slot") else {})})
    return team[:30]
