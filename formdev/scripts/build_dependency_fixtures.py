#!/usr/bin/env python3
"""Build spec/fixtures/dependency-cases.json (Phase 2.3) for the Python and TypeScript engines.

Each case states by hand the values that must survive (or be filled), the issue codes and the options offered;
the script runs the Python engine and refuses to write on any disagreement. The fixture stores the engine's
full result so the TypeScript twin is held to the same answers.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT.parent / "services/flora-api"))

from app.formdev.definition import validate_definition  # noqa: E402
from app.formdev.logic.evaluate import evaluate_record  # noqa: E402

TODAY = "2026-10-06"
FORM = "examples/phase2-dependency/v1.form.json"
LOOKUP = "registry/lookups/thai_address.json"
CM, SANSAI, SANSAI_LUANG = "เชียงใหม่", "อำเภอสันทราย", "ตำบลสันทรายหลวง"
MUEANG_CM = "อำเภอเมืองเชียงใหม่"
PHUKET = "ภูเก็ต"
BKK, BANGRAK = "กรุงเทพมหานคร", "เขตบางรัก"
PROVINCES = ["กรุงเทพมหานคร", "เชียงใหม่", "ขอนแก่น", "ภูเก็ต"]
SCHEME = {"hn": "HN1", "scheme": "uc"}

# (name, status, data, with the lookup table?, {"values": {key: expected, None = absent}, "codes": [...],
#  "options": {path: [values]} for the paths named})
CASES: list[tuple[str, str, dict[str, Any], bool, dict[str, Any]]] = [
    ("no province yet: every province is offered, no districts", "draft", {**SCHEME}, True,
     {"values": {"district": None}, "codes": [], "options": {"$.data.province": PROVINCES, "$.data.district": [], "$.data.subdistrict": []}}),
    ("districts follow the province", "draft", {**SCHEME, "province": CM}, True,
     {"values": {"province": CM}, "codes": [], "options": {"$.data.district": [MUEANG_CM, SANSAI], "$.data.subdistrict": []}}),
    ("the chain derives the postcode and overwrites the client's", "submitted",
     {**SCHEME, "province": CM, "district": SANSAI, "subdistrict": SANSAI_LUANG, "postcode": "99999"}, True,
     {"values": {"postcode": "50210"}, "codes": [], "options": {"$.data.subdistrict": [SANSAI_LUANG]}}),
    ("changing the province clears the district, sub-district and postcode", "draft",
     {**SCHEME, "province": PHUKET, "district": SANSAI, "subdistrict": SANSAI_LUANG, "postcode": "50210"}, True,
     {"values": {"province": PHUKET, "district": None, "subdistrict": None, "postcode": None}, "codes": [],
      "options": {"$.data.district": ["อำเภอเมืองภูเก็ต", "อำเภอกะทู้"]}}),
    ("a cleared required value is reported on submit", "submitted", {**SCHEME, "province": PHUKET, "district": SANSAI}, True,
     {"values": {"district": None}, "codes": ["required", "required"], "options": {}}),
    ("a value that is not in the table is cleared", "draft", {**SCHEME, "province": "ไม่มีจังหวัดนี้"}, True,
     {"values": {"province": None}, "codes": [], "options": {}}),
    ("without the table nothing is cleared or derived", "draft",
     {**SCHEME, "province": "ไม่มีจังหวัดนี้", "district": "x", "postcode": "12345"}, False,
     {"values": {"province": "ไม่มีจังหวัดนี้", "district": "x", "postcode": "12345"}, "codes": [], "options": {}}),
    ("option conditions: dental is offered to social security", "draft", {"hn": "HN1", "scheme": "sss", "benefits": ["opd", "dental"]}, True,
     {"values": {"benefits": ["opd", "dental"]}, "codes": [], "options": {"$.data.benefits": ["opd", "ipd", "dental"]}}),
    ("option conditions: a selection no longer offered is dropped", "draft", {"hn": "HN1", "scheme": "uc", "benefits": ["opd", "dental"]}, True,
     {"values": {"benefits": ["opd"]}, "codes": [], "options": {"$.data.benefits": ["opd", "ipd"]}}),
    ("option conditions: the only selection dropped clears the field", "draft", {"hn": "HN1", "scheme": "uc", "benefits": ["discount"]}, True,
     {"values": {"benefits": None}, "codes": [], "options": {}}),
    ("inside a repeat each item filters by its own province", "draft",
     {**SCHEME, "contacts": [{"contact_name": "A", "contact_province": BKK, "contact_district": BANGRAK},
                             {"contact_name": "B", "contact_province": "ขอนแก่น", "contact_district": BANGRAK}]}, True,
     {"values": {}, "codes": [], "options": {"$.data.contacts[0].contact_district": ["เขตพระนคร", "เขตปทุมวัน", BANGRAK],
                                             "$.data.contacts[1].contact_district": ["อำเภอเมืองขอนแก่น"]},
      "items": {"contacts": [{"contact_name": "A", "contact_province": BKK, "contact_district": BANGRAK},
                             {"contact_name": "B", "contact_province": "ขอนแก่น"}]}}),
]


def main() -> int:
    definition = json.loads((ROOT / FORM).read_text(encoding="utf-8"))
    issues = validate_definition(definition)
    if issues:
        print("definition invalid:", [issue.as_dict() for issue in issues], file=sys.stderr)
        return 1
    table = json.loads((ROOT / LOOKUP).read_text(encoding="utf-8"))
    lookups = {table["lookup_id"]: table["entries"]}
    failures, out = 0, []
    for name, status, data, with_table, want in CASES:
        result = evaluate_record(definition, data, status, TODAY, lookups if with_table else {})
        codes = sorted(issue.code for issue in result.issues)
        problems = []
        if codes != sorted(want["codes"]):
            problems.append(f"codes {codes}")
        for key, value in want["values"].items():
            if result.data.get(key) != value:
                problems.append(f"{key}={result.data.get(key)!r} != {value!r}")
        for key, items in want.get("items", {}).items():
            if result.data.get(key) != items:
                problems.append(f"{key}={result.data.get(key)!r}")
        for path, values in want["options"].items():
            got = [option["value"] for option in result.options.get(path, [])]
            if got != values:
                problems.append(f"options {path} {got} != {values}")
        if problems:
            failures += 1
            print(f"MISMATCH {name}: " + "; ".join(problems))
        out.append({"name": name, "status": status, "data": data, "lookups": with_table, "expect": {
            "data": result.data, "codes": codes, "paths": sorted(issue.path for issue in result.issues),
            "hidden": result.hidden, "options": result.options}})
    if failures:
        print(f"{failures} case(s) disagree; fixture not written", file=sys.stderr)
        return 1
    target = ROOT / "spec/fixtures/dependency-cases.json"
    target.write_text(json.dumps({"definition": FORM, "lookups": {table["lookup_id"]: LOOKUP}, "today": TODAY, "cases": out},
                                 ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    print(f"wrote {len(out)} dependency cases")
    return 0


if __name__ == "__main__":
    sys.exit(main())
