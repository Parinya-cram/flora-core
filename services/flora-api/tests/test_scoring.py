"""Score engine (app/scoring.py) against hand-computed cases and the bundled library."""
import json
from pathlib import Path

import pytest

from app import scoring

LIBRARY = Path(__file__).resolve().parents[1] / "app" / "scoring_library"
CASES = json.loads((Path(__file__).parent / "scoring" / "score-cases.json").read_text(encoding="utf-8"))["cases"]
DEFINITIONS = {path.stem: json.loads(path.read_text(encoding="utf-8")) for path in LIBRARY.glob("*.json")}
PARAMS = {"rr", "spo2", "o2_supplemental", "nibp_sys", "art_sys", "hr", "pr", "avpu", "temperature",
          "gcs", "gcs_e", "gcs_v", "gcs_m"}


@pytest.mark.parametrize("score_id", sorted(DEFINITIONS))
def test_library_is_publishable(score_id):
    assert scoring.validate(DEFINITIONS[score_id], PARAMS) == []
    assert scoring.normalize(scoring.normalize(DEFINITIONS[score_id])) == scoring.normalize(DEFINITIONS[score_id])


@pytest.mark.parametrize("case", CASES, ids=[case["name"] for case in CASES])
def test_cases(case):
    result = scoring.evaluate(DEFINITIONS[case["score"]], case["values"])
    expect = case["expect"]
    for key in ("total", "band", "level", "partial", "missing"):
        if key in expect:
            assert result[key] == expect[key], key
    if "flags" in expect:
        assert [flag["label"] for flag in result["flags"]] == expect["flags"]
    points = {item["key"]: item["points"] for item in result["items"]}
    for key, value in (expect.get("points") or {}).items():
        assert points[key] == value, key


MINUTE = 60_000


def test_inputs_from_timeline_window_fallback_and_rounding():
    news2 = scoring.normalize(DEFINITIONS["news2"])
    ts = 100 * MINUTE
    minutes = {
        80 * MINUTE: {"spo2": 99, "hr": 60},            # spo2 older than its 15 min window
        95 * MINUTE: {"art_sys": 118, "rr": "18"},      # text from manual charting is a number
        99 * MINUTE: {"hr": 88.6, "temperature": 35.04, "avpu": "a", "o2_supplemental": 1},
        101 * MINUTE: {"hr": 150},                      # after ts: not used
    }
    values, used = scoring.resolve_inputs(news2, minutes, ts)
    assert values["spo2"] is None
    assert values["sbp"] == 118 and used["sbp"]["param"] == "art_sys"
    assert values["rr"] == 18
    assert values["pulse"] == 89 and used["pulse"]["ts"] == 99 * MINUTE
    assert values["temp"] == 35.0
    assert values["avpu"] == "A" and values["o2"] is True
    assert values["spo2_scale2"] is False and used["spo2_scale2"]["source"] == "default"


def test_aggregate_and_manual_override():
    definition = {"id": "t_min", "name": "T", "inputs": {"s": {"param": "spo2", "window_min": 10, "agg": "min"}},
                  "items": [{"key": "s", "label": "S", "input": "s", "bands": [{"max": 89, "points": 1}, {"min": 90, "points": 0}]}]}
    minutes = {1 * MINUTE: {"spo2": 95}, 5 * MINUTE: {"spo2": 88}, 9 * MINUTE: {"spo2": 97}}
    assert scoring.evaluate_at(definition, minutes, 10 * MINUTE)["total"] == 1
    assert scoring.evaluate_at(definition, minutes, 10 * MINUTE, {"s": 96})["total"] == 0


def test_validation_reports_problems():
    issues = scoring.validate({"id": "bad", "name": "", "interval_min": 0, "inputs": {"x": {"param": "nope", "agg": "median"}},
                               "items": [{"key": "a", "label": "A", "input": "y"},
                                         {"key": "b", "label": "B", "input": "x", "bands": [{"max": 5, "points": 1}, {"min": 4, "points": 2}]},
                                         {"key": "c", "label": "C", "formula": "x + zz"}]}, {"spo2"})
    messages = " | ".join(issue["message"] for issue in issues)
    for text in ("name is required", "interval_min", "not in the parameter master", "agg must be",
                 "input 'y' is not defined", "overlaps band 1", "unknown name 'zz'"):
        assert text in messages


def test_slots_align_to_the_clock():
    assert scoring.slots({"interval_min": 15}, 7 * MINUTE, 46 * MINUTE) == [15 * MINUTE, 30 * MINUTE, 45 * MINUTE]
