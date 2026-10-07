"""Build formdev/spec/fixtures/permission-cases.json (Phase 2.8).

Each case states by hand the form actions and the top-level keys a role set may not view / edit / export; the
script runs the Python engine, refuses to write on any disagreement, and stores the full per-field result so the
TypeScript twin (frontend/src/formdev/logic/permission.ts) is held to the same answers.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT.parent / "services/flora-api"))

from app.formdev.definition import validate_definition  # noqa: E402
from app.formdev.logic.permission import FORM_ACTIONS, RECORD_ACTIONS, denied, field_permissions, form_allows, record_allows  # noqa: E402

DEFINITION: dict[str, Any] = {
    "format": "flora.form/1", "form_id": "permission_demo", "schema_version": 1, "title": "Permission demo",
    "paper": {"size": "A4", "orientation": "portrait"}, "style_id": "style.a4.medical",
    "permission": {"view": ["clinician", "clinical_admin", "viewer"], "create": ["clinician"], "edit": ["clinician"],
                   "delete": ["clinical_admin"], "export": ["clinical_admin"]},
    "sections": [
        {"id": "general", "title": "ทั่วไป", "fields": [
            {"id": "hn", "type": "text", "label": "HN"},
            {"id": "note", "type": "textarea", "label": "บันทึกผู้ดูแลระบบ", "permission": {"edit": ["clinical_admin"]}},
            {"id": "contact", "type": "group", "label": "ผู้ติดต่อ", "permission": {"export": ["clinician"]}, "fields": [
                {"id": "contact_name", "type": "text", "label": "ชื่อ"}]},
        ]},
        {"id": "clinical", "title": "ข้อมูลทางคลินิก", "permission": {"view": ["clinician"]}, "fields": [
            {"id": "diagnosis", "type": "text", "label": "การวินิจฉัย"}],
         "categories": [{"id": "labs", "title": "ผลแล็บ", "permission": {"view": ["clinician", "viewer"]}, "fields": [
             {"id": "hb", "type": "decimal", "label": "Hb", "decimals": 1}]}]},
        {"id": "medication", "title": "ยา", "fields": [
            {"id": "meds", "type": "repeat", "label": "รายการยา", "fields": [
                {"id": "drug", "type": "text", "label": "ชื่อยา"},
                {"id": "cost", "type": "decimal", "label": "ราคา", "permission": {"view": ["clinical_admin"]}}]}]},
    ],
}

ALL = ["contact_name", "diagnosis", "hb", "hn", "meds", "note"]

# (name, roles, is_admin, allowed form actions, allowed record actions, {action: denied top-level keys})
CASES: list[tuple[str, list[str], bool, list[str], list[str], dict[str, list[str]]]] = [
    ("clinician: no admin note; a repeat with a child they cannot see is locked as a whole", ["clinician"], False,
     ["create", "edit", "view"], ["create", "edit"], {"view": [], "edit": ["meds", "note"], "export": ["diagnosis", "hb", "hn", "meds", "note"]}),
    ("clinical admin: no clinical section, may edit only the note", ["clinical_admin"], False, ["delete", "export", "view"], ["delete", "edit"],
     {"view": ["diagnosis", "hb"], "edit": ["contact_name", "diagnosis", "hb", "hn", "meds"], "export": ["contact_name", "diagnosis", "hb"]}),
    ("viewer: a category list widens the section's (innermost wins)", ["viewer"], False, ["view"], [],
     {"view": ["diagnosis"], "edit": ALL, "export": ALL}),
    ("several roles combine", ["viewer", "clinical_admin"], False, ["delete", "export", "view"], ["delete", "edit"],
     {"view": ["diagnosis"], "edit": ["contact_name", "diagnosis", "hb", "hn", "meds"], "export": ["contact_name", "diagnosis"]}),
    ("no roles: nothing", [], False, [], [], {"view": ALL, "edit": ALL, "export": ALL}),
    ("an unknown role: nothing", ["auditor"], False, [], [], {"view": ALL, "edit": ALL, "export": ALL}),
    ("system administrator passes everything", [], True, list(FORM_ACTIONS), list(RECORD_ACTIONS), {"view": [], "edit": [], "export": []}),
]


def main() -> int:
    issues = validate_definition(DEFINITION)
    if issues:
        print("definition invalid:", [issue.as_dict() for issue in issues], file=sys.stderr)
        return 1
    failures, out = 0, []
    for name, roles, is_admin, actions, record_actions, want in CASES:
        form = {action: form_allows(DEFINITION, action, roles, is_admin) for action in FORM_ACTIONS}
        record = {action: record_allows(DEFINITION, action, roles, is_admin) for action in RECORD_ACTIONS}
        got_denied = {action: sorted(denied(DEFINITION, action, roles, is_admin)) for action in ("view", "edit", "export")}
        problems = []
        if sorted(a for a, ok in form.items() if ok) != sorted(actions):
            problems.append(f"form {form}")
        if sorted(a for a, ok in record.items() if ok) != sorted(record_actions):
            problems.append(f"record {record}")
        for action, keys in want.items():
            if got_denied[action] != sorted(keys):
                problems.append(f"{action} denied {got_denied[action]} != {sorted(keys)}")
        if problems:
            failures += 1
            print(f"MISMATCH {name}: " + "; ".join(problems))
        out.append({"name": name, "roles": roles, "is_admin": is_admin, "form": form, "record": record,
                    "fields": field_permissions(DEFINITION, roles, is_admin), "denied": got_denied})
    if failures:
        print(f"{failures} case(s) disagree; fixture not written", file=sys.stderr)
        return 1
    target = ROOT / "spec/fixtures/permission-cases.json"
    target.write_text(json.dumps({"definition": DEFINITION, "cases": out}, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    print(f"wrote {len(out)} permission cases")
    return 0


if __name__ == "__main__":
    sys.exit(main())
