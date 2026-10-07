#!/usr/bin/env python3
"""Build formdev/spec/fixtures/query-cases.json.

Each case states its expected error and warning codes by hand. The script runs the Python
validator, refuses to write the file if any case disagrees with its expectation, and then
records the issue paths so the TypeScript twin is checked against codes AND paths.

    PYTHONPATH=services/flora-api python3 formdev/scripts/build_query_fixtures.py
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT.parent / "services/flora-api"))

from app.formdev.query.access import principal_from_dict  # noqa: E402
from app.formdev.query.catalog import catalog_from_dict  # noqa: E402
from app.formdev.query.policy import DEFAULT_POLICY  # noqa: E402
from app.formdev.query.validator import validate_query  # noqa: E402

REGISTRATION = {
    "source_id": "patient_registration",
    "fields": {
        "hn": {"type": "text", "indexed": True},
        "name": {"type": "text"},
        "phone": {"type": "text", "access": ["system_admin"]},
    },
}
CATALOGS = {
    "assessment": {
        "source_id": "patient_assessment",
        "fields": {
            "hn": {"type": "text", "indexed": True},
            "full_name": {"type": "text", "access": ["system_admin", "clinician"]},
            "age": {"type": "integer", "indexed": True},
            "sex": {"type": "select", "options": ["male", "female"]},
            "assessed_at": {"type": "datetime", "indexed": True},
            "fall_risk": {"type": "select", "indexed": True, "options": ["yes", "no"]},
            "ward": {"type": "text", "indexed": True, "state": "building"},
            "smoker": {"type": "checkbox", "indexed": True},
            "remarks": {"type": "textarea"},
            "tags": {"type": "multiselect", "options": ["a", "b"]},
            "bmi": {"type": "calculated", "indexed": True},
        },
        "relations": {"patient": {"local": "hn", "foreign": "hn", "target": REGISTRATION}},
    },
    # A subject-field change being backfilled: $subject_id is refused until the rebuild ends.
    "rebuilding": {
        "source_id": "rebuilding",
        "fields": {"hn": {"type": "text", "indexed": True}},
        "metadata_building": ["$subject_id"],
    },
    # The example from Flow-Form.md 4.1, verbatim.
    "patient": {
        "source_id": "patient",
        "fields": {"hn": {"type": "text", "indexed": True}, "name": {"type": "text"}, "age": {"type": "integer", "indexed": True}},
    },
}
QUERY = ["formdev.query"]
PRINCIPALS = {
    "admin": {"user_id": 1, "username": "admin", "roles": ["system_admin"], "permissions": ["formdev.query", "formdev.export", "formdev.diagnostics", "formdev.manage"]},
    "clinician": {"user_id": 2, "username": "nurse", "roles": ["clinician"], "permissions": QUERY},
    "viewer": {"user_id": 3, "username": "auditor", "roles": ["viewer"], "permissions": QUERY},
    "integration": {"user_id": 4, "username": "device", "roles": ["integration"], "permissions": []},
}


def q(**query):
    query.setdefault("source", "patient_assessment")
    return {"query": query}


PAGE = {"mode": "cursor", "limit": 50}
EQ_YES = {"field": "fall_risk", "op": "eq", "value": "yes"}


def leaf(field, op, value=None):
    node = {"field": field, "op": op}
    if value is not None:
        node["value"] = value
    return node


def nest(depth):
    node = EQ_YES
    for _ in range(depth - 1):
        node = {"and": [node]}
    return node


CASES = [
    # name, catalog, principal, body, errors, warnings
    ("spec example 4.1 verbatim", "patient", "viewer",
     {"query": {"id": "patient_list", "source": "patient", "select": ["hn", "name", "age", "status"], "pagination": {"mode": "cursor", "limit": 50}}},
     [], ["missing_filter"]),
    ("filtered list", "assessment", "clinician", q(select=["hn", "age", "$status"], filter=EQ_YES, pagination=PAGE), [], []),
    ("and / or / not", "assessment", "clinician",
     q(select=["hn"], filter={"and": [EQ_YES, {"or": [leaf("age", "gte", 65), leaf("$status", "eq", "draft")]}, {"not": leaf("smoker", "eq", True)}]}, pagination=PAGE), [], []),
    ("is_null and between", "assessment", "clinician", q(select=["hn"], filter={"and": [leaf("bmi", "is_null"), leaf("age", "between", [18, 65])]}, pagination=PAGE), [], []),
    ("missing limit", "assessment", "clinician", q(select=["hn"], filter=EQ_YES), ["missing_limit"], []),
    ("pagination without limit", "assessment", "clinician", q(select=["hn"], filter=EQ_YES, pagination={"mode": "cursor"}), ["missing_limit"], []),
    ("limit exceeded", "assessment", "clinician", q(select=["hn"], filter=EQ_YES, pagination={"mode": "cursor", "limit": 501}), ["limit_exceeded"], []),
    ("offset exceeded", "assessment", "clinician", q(select=["hn"], filter=EQ_YES, pagination={"mode": "offset", "limit": 10, "offset": 10001}), ["offset_exceeded"], []),
    ("top-level limit alias", "assessment", "clinician", q(select=["hn"], filter=EQ_YES, limit=20), [], []),
    ("select star", "assessment", "clinician", q(select=["*"], filter=EQ_YES, pagination=PAGE), ["select_star_not_allowed"], []),
    ("missing select", "assessment", "clinician", q(filter=EQ_YES, pagination=PAGE), ["missing_select"], []),
    ("invalid field", "assessment", "clinician", q(select=["agee"], filter=EQ_YES, pagination=PAGE), ["invalid_field"], []),
    ("bare metadata name", "assessment", "clinician", q(select=["hn", "status", "updated_at"], filter=EQ_YES, pagination=PAGE), [], []),
    ("unauthorized select", "assessment", "viewer", q(select=["hn", "full_name"], filter=EQ_YES, pagination=PAGE), ["unauthorized_field"], []),
    ("unauthorized filter oracle", "assessment", "viewer", q(select=["hn"], filter=leaf("full_name", "eq", "Somchai"), pagination=PAGE), ["unauthorized_field"], []),
    ("authorized sensitive select", "assessment", "clinician", q(select=["hn", "full_name"], pagination=PAGE), [], ["missing_filter"]),
    ("filter needs an index", "assessment", "clinician", q(select=["hn"], filter=leaf("sex", "eq", "male"), pagination=PAGE), ["not_filterable"], []),
    ("index building", "assessment", "clinician", q(select=["hn"], filter=leaf("ward", "eq", "W1"), pagination=PAGE), ["index_building"], []),
    ("subject id being backfilled", "rebuilding", "clinician", q(source="rebuilding", select=["hn"], filter=leaf("$subject_id", "eq", "HN-1"), pagination=PAGE), ["index_building"], []),
    ("subject id selectable while backfilled", "rebuilding", "clinician", q(source="rebuilding", select=["hn", "$subject_id"], filter=leaf("hn", "eq", "HN-1"), pagination=PAGE), [], []),
    ("textarea not filterable", "assessment", "clinician", q(select=["hn"], filter=leaf("remarks", "eq", "x"), pagination=PAGE), ["not_filterable"], []),
    ("multiselect not filterable", "assessment", "clinician", q(select=["hn"], filter=leaf("tags", "eq", "a"), pagination=PAGE), ["not_filterable"], []),
    ("unknown operator", "assessment", "clinician", q(select=["hn"], filter=leaf("hn", "like", "%1"), pagination=PAGE), ["invalid_operator"], []),
    ("prefix on a number", "assessment", "clinician", q(select=["hn"], filter=leaf("age", "prefix", "1"), pagination=PAGE), ["invalid_operator"], []),
    ("wrong value type", "assessment", "clinician", q(select=["hn"], filter=leaf("age", "eq", "old"), pagination=PAGE), ["invalid_value"], []),
    ("bad datetime value", "assessment", "clinician", q(select=["hn"], filter=leaf("assessed_at", "gte", "yesterday"), pagination=PAGE), ["invalid_value"], []),
    ("datetime range", "assessment", "clinician", q(select=["hn"], filter=leaf("assessed_at", "between", ["2026-10-01T00:00:00+07:00", "2026-10-31T23:59:59+07:00"]), pagination=PAGE), [], []),
    ("metadata time filter", "assessment", "clinician", q(select=["hn"], filter=leaf("$created_at", "gte", "2026-10-01T00:00:00Z"), pagination=PAGE), [], []),
    ("too many in values", "assessment", "clinician", q(select=["hn"], filter=leaf("hn", "in", [f"HN{i}" for i in range(501)]), pagination=PAGE), ["too_many_values"], []),
    ("filter too deep", "assessment", "clinician", q(select=["hn"], filter=nest(5), pagination=PAGE), ["filter_too_complex"], []),
    ("too many conditions", "assessment", "clinician", q(select=["hn"], filter={"or": [leaf("hn", "eq", f"HN{i}") for i in range(33)]}, pagination=PAGE), ["filter_too_complex"], []),
    ("too many index terms in one and", "assessment", "clinician", q(select=["hn"], filter={"and": [leaf("age", "gte", i) for i in range(9)]}, pagination=PAGE), ["filter_too_complex"], []),
    ("cursor needs a stable sort", "assessment", "clinician", q(select=["hn"], filter=EQ_YES, sort=[{"field": "age", "dir": "desc"}], pagination=PAGE), ["cursor_requires_stable_sort"], []),
    ("cursor on updated_at warns", "assessment", "clinician", q(select=["hn"], filter=EQ_YES, sort=[{"field": "$updated_at", "dir": "desc"}], pagination=PAGE), [], ["cursor_not_snapshot_stable"]),
    ("offset sort by indexed field", "assessment", "clinician", q(select=["hn"], filter=EQ_YES, sort=[{"field": "age", "dir": "asc"}], pagination={"mode": "offset", "limit": 20, "offset": 40}), [], []),
    ("offset sort needs an index", "assessment", "clinician", q(select=["hn"], filter=EQ_YES, sort=[{"field": "full_name"}], pagination={"mode": "offset", "limit": 20}), ["not_filterable"], []),
    ("two sort keys", "assessment", "clinician", q(select=["hn"], filter=EQ_YES, sort=[{"field": "$created_at"}, {"field": "$record_id"}], pagination=PAGE), ["invalid_sort"], []),
    ("raw sql key", "assessment", "clinician", q(select=["hn"], filter=EQ_YES, pagination=PAGE, sql="DROP TABLE formdev_record"), ["dangerous_operation"], []),
    ("unknown leaf key", "assessment", "clinician", q(select=["hn"], filter={"field": "hn", "op": "eq", "value": "x", "raw": "1=1"}, pagination=PAGE), ["dangerous_operation"], []),
    ("nul byte", "assessment", "clinician", q(select=["hn"], filter=leaf("hn", "eq", "HN\u00001"), pagination=PAGE), ["dangerous_operation"], []),
    ("hostile field name", "assessment", "clinician", q(select=["a') OR 1=1--"], filter=EQ_YES, pagination=PAGE), ["invalid_field"], []),
    ("hostile sort direction", "assessment", "clinician", q(select=["hn"], filter=EQ_YES, sort=[{"field": "$created_at", "dir": "desc; --"}], pagination=PAGE), ["invalid_sort"], []),
    ("hostile alias", "assessment", "clinician", q(group=["fall_risk"], aggregate=[{"fn": "count", "as": 'x"; DROP TABLE formdev_record; --'}]), ["invalid_alias"], []),
    ("unknown source", "assessment", "clinician", {"query": {"source": "nope", "select": ["hn"], "pagination": PAGE}}, ["unknown_source"], []),
    ("no query permission", "assessment", "integration", q(select=["hn"], filter=EQ_YES, pagination=PAGE), ["unknown_source"], []),
    ("relation select", "assessment", "clinician", q(select=["hn", "patient.name"], filter=EQ_YES, pagination=PAGE), [], []),
    ("relation filter", "assessment", "clinician", q(select=["hn"], filter=leaf("patient.name", "eq", "x"), pagination=PAGE), ["invalid_relation"], []),
    ("unknown relation", "assessment", "clinician", q(select=["hn", "doctor.name"], filter=EQ_YES, pagination=PAGE), ["invalid_relation"], []),
    ("unauthorized relation field", "assessment", "viewer", q(select=["hn", "patient.phone"], filter=EQ_YES, pagination=PAGE), ["unauthorized_field"], []),
    ("group count", "assessment", "viewer", q(group=["fall_risk"], aggregate=[{"fn": "count", "as": "n"}]), [], []),
    ("group with avg and offset", "assessment", "viewer",
     q(group=["fall_risk", "$status"], aggregate=[{"fn": "count", "as": "n"}, {"fn": "avg", "field": "age", "as": "avg_age"}], sort=[{"field": "n", "dir": "desc"}], pagination={"mode": "offset", "limit": 100}), [], []),
    ("aggregate without group", "assessment", "viewer", q(filter=EQ_YES, aggregate=[{"fn": "max", "field": "assessed_at", "as": "latest"}, {"fn": "avg", "field": "bmi", "as": "avg_bmi"}]), [], []),
    ("select must be grouped", "assessment", "viewer", q(select=["hn"], group=["fall_risk"], aggregate=[{"fn": "count", "as": "n"}]), ["select_not_grouped"], []),
    ("grouped cursor", "assessment", "viewer", q(group=["fall_risk"], aggregate=[{"fn": "count", "as": "n"}], pagination=PAGE), ["cursor_not_supported_for_group"], []),
    ("avg of text", "assessment", "viewer", q(group=["fall_risk"], aggregate=[{"fn": "avg", "field": "hn", "as": "x"}]), ["aggregate_invalid"], []),
    ("duplicate alias", "assessment", "viewer", q(group=["fall_risk"], aggregate=[{"fn": "count", "as": "n"}, {"fn": "max", "field": "age", "as": "n"}]), ["invalid_alias"], []),
    ("time group needs bucket", "assessment", "viewer", q(group=["$created_at"], aggregate=[{"fn": "count", "as": "n"}]), ["aggregate_invalid"], []),
    ("day bucket", "assessment", "viewer", q(group=[{"field": "$ingested_at", "bucket": "day", "tz_offset_minutes": 420}], aggregate=[{"fn": "count", "as": "n"}]), [], []),
    ("too many group keys", "assessment", "viewer", q(group=["fall_risk", "$status", "smoker", "hn"], aggregate=[{"fn": "count", "as": "n"}]), ["too_many_groups"], []),
    ("grouped sort by non-group", "assessment", "viewer", q(group=["fall_risk"], aggregate=[{"fn": "count", "as": "n"}], sort=[{"field": "age"}]), ["sort_not_grouped"], []),
    ("deleted needs admin", "assessment", "viewer", q(select=["hn"], filter=leaf("$status", "eq", "deleted"), pagination=PAGE), ["deleted_requires_admin"], []),
    ("admin sees deleted", "assessment", "admin", q(select=["hn"], filter=leaf("$status", "eq", "deleted"), pagination=PAGE), [], []),
    ("wrong format", "assessment", "clinician", {"format": "flora.query/9", "query": {"source": "patient_assessment", "select": ["hn"], "filter": EQ_YES, "pagination": PAGE}}, ["invalid_format"], []),
    ("timeout clamped", "assessment", "clinician", q(select=["hn"], filter=EQ_YES, pagination=PAGE, timeout=60000), [], ["timeout_clamped"]),
    ("export over the role limit", "assessment", "clinician", q(select=["hn"], filter=EQ_YES, pagination=PAGE, export={"format": "csv", "max_rows": 200000}), ["export_limit_exceeded"], []),
    ("admin export limit", "assessment", "admin", q(select=["hn"], filter=EQ_YES, pagination=PAGE, export={"format": "jsonl", "max_rows": 1000000}), [], []),
    ("capped count", "assessment", "clinician", q(select=["hn"], filter=EQ_YES, pagination=PAGE, count="capped"), [], []),
    ("bad query id", "assessment", "clinician", q(id="Patient List", select=["hn"], filter=EQ_YES, pagination=PAGE), ["invalid_value"], []),
    ("body must wrap query", "assessment", "clinician", {"source": "patient_assessment", "select": ["hn"]}, ["invalid_request"], []),
    ("trailing newline in a datetime", "assessment", "clinician", q(select=["hn"], filter=leaf("$created_at", "gte", "2025-01-01T00:00:00Z\n"), pagination=PAGE), ["invalid_value"], []),
    ("trailing newline in a field name", "assessment", "clinician", q(select=["hn\n"], filter=EQ_YES, pagination=PAGE), ["invalid_field"], []),
    ("list operator", "assessment", "clinician", q(select=["hn"], filter={"field": "hn", "op": ["eq"], "value": "x"}, pagination=PAGE), ["invalid_operator"], []),
    ("list aggregate fn", "assessment", "viewer", q(aggregate=[{"fn": ["count"], "as": "n"}]), ["aggregate_invalid"], []),
    ("list bucket", "assessment", "viewer", q(group=[{"field": "$created_at", "bucket": ["day"]}], aggregate=[{"fn": "count", "as": "n"}]), ["aggregate_invalid"], []),
    ("list grouped sort field", "assessment", "viewer", q(group=["fall_risk"], aggregate=[{"fn": "count", "as": "n"}], sort=[{"field": ["fall_risk"]}]), ["sort_not_grouped"], []),
]


def main() -> int:
    out, failures = [], 0
    for name, catalog_name, principal_name, body, errors, warnings in CASES:
        catalog = catalog_from_dict(CATALOGS[catalog_name])
        source = body.get("query", {}).get("source") if isinstance(body.get("query"), dict) else None
        issues, _ = validate_query(body, catalog if source == catalog.source_id else None, principal_from_dict(PRINCIPALS[principal_name]), DEFAULT_POLICY)
        got_errors = sorted(i.code for i in issues if i.severity == "error")
        got_warnings = sorted(i.code for i in issues if i.severity == "warning")
        if got_errors != sorted(errors) or got_warnings != sorted(warnings):
            failures += 1
            print(f"MISMATCH {name}: errors {got_errors} (want {sorted(errors)}), warnings {got_warnings} (want {sorted(warnings)})")
            for issue in issues:
                print("   ", issue.as_dict())
        out.append({"name": name, "catalog": catalog_name, "principal": principal_name, "body": body,
                    "errors": sorted(errors), "warnings": sorted(warnings),
                    "paths": sorted(f"{i.severity}:{i.code}:{i.path}" for i in issues)})
    if failures:
        print(f"{failures} case(s) disagree with their expectation; fixture not written", file=sys.stderr)
        return 1
    target = ROOT / "spec/fixtures/query-cases.json"
    target.write_text(json.dumps({"catalogs": CATALOGS, "principals": PRINCIPALS, "cases": out}, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    print(f"wrote {len(out)} cases to {target}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
