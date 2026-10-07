#!/usr/bin/env python3
"""Build the Phase 2 logic fixtures shared by the Python and TypeScript engines.

Every case states its expected result by hand; the script runs the Python engine and refuses to write
if any case disagrees. The TypeScript suite must then agree with the same file.

    PYTHONPATH=services/flora-api python3 formdev/scripts/build_logic_fixtures.py

Writes spec/fixtures/formula-cases.json and spec/fixtures/logic-record-cases.json.
"""
from __future__ import annotations

import json
import math
import sys
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT.parent / "services/flora-api"))

from app.formdev.logic.evaluate import evaluate_record  # noqa: E402
from app.formdev.logic.formula import FormulaError, run  # noqa: E402

TODAY = "2026-10-06"
VITALS = {"weight_kg": 70, "height_cm": 175, "bp_sys": 120, "bp_dia": 80, "birth_date": "1960-10-07", "has_fever": True, "name": "สมชาย",
          "meds": None, "pain": None, "zero": 0, "scores": None}
SCORES = {**VITALS, "meds.dose_mg": [500, 20, None, 40], "meds.drug": ["A", "B", "C", "D"], "empty.dose": []}

# (name, formula, values, expected value) or (name, formula, values, {"error": code, "position": column})
CASES: list[tuple[str, str, dict[str, Any], Any]] = [
    ("number", "42", {}, 42),
    ("precedence", "1 + 2 * 3", {}, 7),
    ("parentheses", "(1 + 2) * 3", {}, 9),
    ("power binds tighter than unary minus", "-2 ^ 2", {}, -4),
    ("power is right associative", "2 ^ 3 ^ 2", {}, 512),
    ("remainder keeps the dividend's sign", "-7 % 3", {}, -1),
    ("BMI", "weight_kg / ((height_cm / 100) ^ 2)", VITALS, 22.857142857142858),
    ("BMI rounded", "ROUND(weight_kg / ((height_cm / 100) ^ 2), 1)", VITALS, 22.9),
    ("MAP", "(bp_sys + 2 * bp_dia) / 3", VITALS, 93.33333333333333),
    ("BSA Mosteller", "ROUND(SQRT(weight_kg * height_cm / 3600), 2)", VITALS, 1.84),
    ("missing input gives null", "weight_kg / ((pain / 100) ^ 2)", VITALS, None),
    ("unknown key gives null", "nope + 1", VITALS, None),
    ("division by zero gives null", "weight_kg / zero", VITALS, None),
    ("text in arithmetic gives null", "name * 2", VITALS, None),
    ("round half away from zero", "ROUND(2.5) + ROUND(-2.5)", {}, 0),
    ("round 1.005 to 2 digits follows binary floating point", "ROUND(1.005, 2)", {}, 1),
    ("round digits must be 0-10", "ROUND(1.5, 11)", {}, None),
    ("IF", "IF(weight_kg / ((height_cm / 100) ^ 2) >= 25, 'overweight', 'normal')", VITALS, "normal"),
    ("IF is lazy", "IF(TRUE, 1, 1 / 0)", {}, 1),
    ("AND OR NOT", "has_fever AND NOT (bp_sys < 90 OR bp_dia > 100)", VITALS, True),
    ("keywords are case-insensitive", "true and not False", {}, True),
    ("null equals null only", "pain = NULL", VITALS, True),
    ("ordering with null is unknown", "pain < 1", VITALS, None),
    ("unknown counts as false in OR", "pain < 1 OR pain >= 1", VITALS, False),
    ("AGE of a future date is null", "AGE('2030-01-01')", {}, None),
    ("not equal across types", "bp_sys != '120'", VITALS, True),
    ("text comparison", "name = 'สมชาย'", VITALS, True),
    ("SUM of a repeat column ignores nulls", "SUM(meds.dose_mg)", SCORES, 560),
    ("COUNT counts values", "COUNT(meds.drug, meds.dose_mg)", SCORES, 7),
    ("AVG", "AVG(meds.dose_mg)", SCORES, 186.66666666666666),
    ("MIN MAX", "MAX(meds.dose_mg) - MIN(meds.dose_mg, 5)", SCORES, 495),
    ("SUM of nothing is 0", "SUM(empty.dose)", SCORES, 0),
    ("AVG of nothing is null", "AVG(empty.dose)", SCORES, None),
    ("total score", "SUM(1, 2, NULL, 3)", {}, 6),
    ("percentage", "ROUND(7 / 9 * 100, 1)", {}, 77.8),
    ("COALESCE", "COALESCE(pain, '', 0)", VITALS, 0),
    ("ISBLANK", "ISBLANK(pain) AND NOT ISBLANK(name)", VITALS, True),
    ("AGE completed years (birthday tomorrow)", "AGE(birth_date)", VITALS, 65),
    ("AGE on a given date", "AGE(birth_date, '2026-10-07')", VITALS, 66),
    ("AGE of a datetime", "AGE('2000-02-29T10:00:00+07:00', '2026-02-28')", {}, 25),
    ("DAYS", "DAYS('2026-10-01', TODAY())", {}, 5),
    ("invalid date gives null", "AGE('2026-02-30')", {}, None),
    ("FLOOR CEIL ABS", "FLOOR(2.7) + CEIL(2.1) + ABS(-3)", {}, 8),
    ("SQRT of a negative is null", "SQRT(-4)", {}, None),
    ("escaped quotes", "'it\\'s'", {}, "it's"),
    ("lower-case function names", "round(2.345, 2)", {}, 2.35),
    ("syntax: missing operand", "1 +", {}, {"error": "formula_syntax", "position": 4}),
    ("syntax: unclosed parenthesis", "(1 + 2", {}, {"error": "formula_syntax", "position": 7}),
    ("syntax: unclosed text", "'abc", {}, {"error": "formula_syntax", "position": 1}),
    ("syntax: chained comparison", "1 < 2 < 3", {}, {"error": "formula_syntax", "position": 7}),
    ("syntax: Thai outside quotes", "น้ำหนัก * 2", {}, {"error": "formula_syntax", "position": 1}),
    ("syntax: upper-case key", "Weight + 1", {}, {"error": "formula_syntax", "position": 1}),
    ("syntax: stray character", "weight_kg ; 1", {}, {"error": "formula_syntax", "position": 11}),
    ("unknown function", "EVAL('1')", {}, {"error": "unknown_function", "position": 1}),
    ("arity", "IF(TRUE, 1)", {}, {"error": "invalid_arguments", "position": 1}),
    ("arity of TODAY", "TODAY(1)", {}, {"error": "invalid_arguments", "position": 1}),
    ("too long", "1" + "+1" * 1000, {}, {"error": "formula_too_complex", "position": 1}),
    ("too deep", "(" * 70 + "1" + ")" * 70, {}, {"error": "formula_too_complex", "position": 65}),
]


LOGIC_FORM = "examples/phase2-logic/v1.form.json"
BASE = {"hn": "HN0001", "birth_date": "1950-01-01", "bp_sys": 130, "bp_dia": 80, "weight_kg": 60, "height_cm": 160}


def record(**changes: Any) -> dict[str, Any]:
    out = dict(BASE)
    for key, value in changes.items():
        if value is None:
            out.pop(key, None)
        else:
            out[key] = value
    return out


# (name, status, data, {"values": {key: expected stored value}, "codes": [...], "hidden": [...]})
RECORDS: list[tuple[str, str, dict[str, Any], dict[str, Any]]] = [
    ("calculated values are computed and the client's are overwritten", "submitted", record(bmi=999, age=1),
     {"values": {"age": 76, "bmi": 23.4, "bmi_class": "น้ำหนักเกิน", "fall_count": 0}, "codes": [], "hidden": ["$.data.packs_per_day", "$.data.temperature_c"]}),
    ("BMI stays empty until weight and height are both entered", "draft", record(height_cm=None),
     {"values": {"bmi": None, "bmi_class": None}, "codes": [], "hidden": ["$.data.packs_per_day", "$.data.temperature_c"]}),
    ("BMI class boundaries", "draft", record(weight_kg=47), {"values": {"bmi": 18.4, "bmi_class": "ต่ำกว่าเกณฑ์"}, "codes": [], "hidden": ["$.data.packs_per_day", "$.data.temperature_c"]}),
    ("hidden with clear_when_hidden is cleared", "submitted", record(has_fever=False, temperature_c=38.5),
     {"values": {"temperature_c": None}, "codes": [], "hidden": ["$.data.packs_per_day", "$.data.temperature_c"]}),
    ("shown again it is required", "submitted", record(has_fever=True),
     {"values": {}, "codes": ["required"], "hidden": ["$.data.packs_per_day"]}),
    ("a hidden value is kept but not validated", "submitted", record(smoker="never", packs_per_day=99),
     {"values": {"packs_per_day": 99}, "codes": [], "hidden": ["$.data.packs_per_day", "$.data.temperature_c"]}),
    ("visible again the same value is validated", "submitted", record(smoker="current", packs_per_day=99),
     {"values": {"packs_per_day": 99}, "codes": ["out_of_range"], "hidden": ["$.data.temperature_c"]}),
    ("custom field rule", "draft", record(bp_sys=80, bp_dia=90), {"values": {}, "codes": ["rule_failed"], "hidden": ["$.data.packs_per_day", "$.data.temperature_c"]}),
    ("a rule with a missing input passes", "draft", record(bp_dia=None), {"values": {}, "codes": [], "hidden": ["$.data.packs_per_day", "$.data.temperature_c"]}),
    ("form rule reported on its field", "draft", record(admitted_on="2026-10-05", discharged_on="2026-10-01"),
     {"values": {}, "codes": ["rule_failed"], "hidden": ["$.data.packs_per_day", "$.data.temperature_c"]}),
    ("pattern, e-mail and future date", "draft", record(phone="12345", email="a@b", birth_date="2030-01-01"),
     {"values": {"age": None}, "codes": ["date_too_late", "invalid_email", "pattern_mismatch"], "hidden": ["$.data.packs_per_day", "$.data.temperature_c"]}),
    ("other text is required when other is chosen", "submitted", record(symptoms=["dizzy", "other"]),
     {"values": {}, "codes": ["other_text_required"], "hidden": ["$.data.packs_per_day", "$.data.temperature_c"]}),
    ("other text is kept with its answer", "submitted", record(symptoms=["other"], _other={"symptoms": "ปวดเข่า"}),
     {"values": {"_other": {"symptoms": "ปวดเข่า"}}, "codes": [], "hidden": ["$.data.packs_per_day", "$.data.temperature_c"]}),
    ("other text without its answer is dropped", "draft", record(symptoms=["dizzy"], _other={"symptoms": "ปวดเข่า", "smoker": "x"}),
     {"values": {"_other": None}, "codes": [], "hidden": ["$.data.packs_per_day", "$.data.temperature_c"]}),
    ("repeat section: items, counts, item visibility and required", "submitted",
     record(falls=[{"fall_date": "2026-09-01", "injury": "yes"}, {"fall_date": "2026-08-01", "injury": "other", "_other": {"injury": "ล้มในห้องน้ำ"}}, {"injury": "no"}]),
     {"values": {"fall_count": 2}, "codes": ["required", "required"], "hidden": ["$.data.falls[1].injury_detail", "$.data.falls[2].injury_detail",
                                                                                  "$.data.packs_per_day", "$.data.temperature_c"]}),
    ("repeat section limit", "draft", record(falls=[{"fall_date": "2026-01-0" + str(day)} for day in range(1, 7)]),
     {"values": {"fall_count": 6}, "codes": ["too_many_items"], "hidden": ["$.data.packs_per_day", "$.data.temperature_c"]
      + [f"$.data.falls[{index}].injury_detail" for index in range(6)]}),
]


def same(a: Any, b: Any) -> bool:
    if isinstance(a, (int, float)) and isinstance(b, (int, float)) and not isinstance(a, bool) and not isinstance(b, bool):
        return math.isclose(a, b, rel_tol=1e-12, abs_tol=1e-12)
    return a == b and type(a) is type(b) if isinstance(a, bool) or isinstance(b, bool) else a == b


def main() -> int:
    failures = 0
    out = []
    for name, formula, values, expected in CASES:
        try:
            got: Any = run(formula, values, TODAY)
            outcome: Any = {"value": got}
        except FormulaError as error:
            outcome = {"error": error.code, "position": error.position}
        want = expected if isinstance(expected, dict) else {"value": expected}
        ok = outcome.keys() == want.keys() and (same(outcome["value"], want["value"]) if "value" in want else outcome == want)
        if not ok:
            failures += 1
            print(f"MISMATCH {name}: got {outcome}, want {want}")
        out.append({"name": name, "formula": formula, "values": values, **want})
    definition = json.loads((ROOT / LOGIC_FORM).read_text(encoding="utf-8"))
    records = []
    for name, status, data, want in RECORDS:
        result = evaluate_record(definition, data, status, TODAY)
        codes = sorted(issue.code for issue in result.issues)
        problems = []
        if codes != sorted(want["codes"]):
            problems.append(f"codes {codes} != {sorted(want['codes'])}")
        if result.hidden != sorted(want["hidden"]):
            problems.append(f"hidden {result.hidden} != {sorted(want['hidden'])}")
        for key, value in want["values"].items():
            if not same(result.data.get(key), value):
                problems.append(f"{key}={result.data.get(key)!r} != {value!r}")
        if problems:
            failures += 1
            print(f"MISMATCH record {name}: " + "; ".join(problems))
        records.append({"name": name, "status": status, "data": data, "expect": {
            "data": result.data, "codes": codes, "paths": sorted(issue.path for issue in result.issues), "hidden": result.hidden}})
    if failures:
        print(f"{failures} case(s) disagree with their expectation; fixture not written", file=sys.stderr)
        return 1
    (ROOT / "spec/fixtures/logic-record-cases.json").write_text(json.dumps(
        {"definition": LOGIC_FORM, "today": TODAY, "cases": records}, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    target = ROOT / "spec/fixtures/formula-cases.json"
    target.write_text(json.dumps({"today": TODAY, "cases": out}, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    print(f"wrote {len(out)} formula cases, {len(records)} record logic cases")
    return 0


if __name__ == "__main__":
    sys.exit(main())
