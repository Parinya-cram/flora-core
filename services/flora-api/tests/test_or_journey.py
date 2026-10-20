"""OR sessions (app/or_journey.py): journey transitions, 15-minute snapping and overlap warnings."""
import pytest

from app import or_journey

MIN = 60_000
H = 60 * MIN


def test_happy_path_and_refused_moves():
    path = ["booked", "assigned", "in_or", "awaiting_recovery", "assigned_recovery", "in_recovery", "discharged"]
    for current, target in zip(path, path[1:]):
        or_journey.check_transition(current, target)
    for current, target in [("booked", "discharged"), ("in_or", "booked"), ("discharged", "in_or"), ("in_or", "cancelled")]:
        with pytest.raises(or_journey.TransitionError):
            or_journey.check_transition(current, target)


def test_labels_follow_the_board():
    assert [or_journey.LABEL[s] for s in ("booked", "assigned", "in_or", "in_recovery", "discharged")] == \
        ["Appointed", "Waiting", "Operation", "Recovery", "Completed"]


def test_snapping():
    assert or_journey.snap(8 * H + 7 * MIN) == 8 * H
    assert or_journey.snap(8 * H + 8 * MIN) == 8 * H + 15 * MIN
    assert or_journey.snap_duration(50) == 45
    assert or_journey.snap_duration(None) == or_journey.DEFAULT_DURATION_MIN
    assert or_journey.snap_duration(1) == 15


def session(id_, room, start_h, minutes, team=(), state="booked"):
    return {"id": id_, "room_location_id": room, "scheduled_at": int(start_h * H), "duration_min": minutes,
            "team": [{"staff_code": code, "role_id": "surgeon"} for code in team], "journey_state": state}


def test_overlaps_by_room_and_staff_but_not_back_to_back():
    rows = [
        session("a", 1, 8, 120, ["D1"]),
        session("b", 1, 9, 60),             # same room, overlaps a
        session("c", 2, 9.5, 60, ["d1"]),   # other room, same surgeon (case-insensitive) as a
        session("d", 1, 10, 60),            # starts when a ends: no clash
        session("e", 1, 8, 60, state="cancelled"),
    ]
    found = or_journey.conflicts(rows)
    assert {(x["kind"], x["with"]) for x in found["a"]} == {("room", "b"), ("staff", "c")}
    assert "d" not in found and "e" not in found


def test_team_normalised():
    team = or_journey.normalize_team([{"staff_code": " D1 ", "role_id": "surgeon"}, {"staff_code": "D1", "role_id": "surgeon"},
                                      {"name": "Visiting surgeon", "role_id": "surgeon"}, {"role_id": "assistant"}, "x"])
    assert team == [{"staff_code": "D1", "role_id": "surgeon", "name": None},
                    {"staff_code": None, "role_id": "surgeon", "name": "Visiting surgeon"}]


def test_closing_a_booking_before_arrival_only():
    for state in or_journey.CLOSED_STATES:
        or_journey.check_transition("booked", state)
        or_journey.check_transition("assigned", state)
        or_journey.check_transition(state, "booked")  # book again
        with pytest.raises(or_journey.TransitionError):
            or_journey.check_transition("in_or", state)
    assert or_journey.LABEL["no_show"] == "No-show" and or_journey.LABEL["miscreate"] == "Miscreate"


def test_recovery_can_be_skipped_but_not_reversed():
    or_journey.check_transition("in_or", "discharged")          # straight to ICU from the OR
    or_journey.check_transition("awaiting_recovery", "discharged")
    with pytest.raises(or_journey.TransitionError):
        or_journey.check_transition("in_recovery", "in_or")
