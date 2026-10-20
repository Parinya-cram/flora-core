"""Record cases of the e2e kitchen-sink form (formdev/examples/e2e-kitchen-sink) with the issues Canopy's Python rules
give, for the TypeScript twin to match (frontend/tests/formdev/kitchenSink.test.ts): the same record must get the same
answer on Flora Leaf (browser) and in Canopy. Run in the API image:

    python formdev/scripts/build_kitchen_sink_cases.py   (from the repo root, PYTHONPATH=services/flora-api)
"""
import copy
import json
from pathlib import Path

from app.formdev.logic.evaluate import evaluate_record

ROOT = Path(__file__).resolve().parents[1] / "examples" / "e2e-kitchen-sink"
definition = json.loads((ROOT / "v1.form.json").read_text())
valid = json.loads((ROOT / "sample.record.json").read_text())["record"]


def variant(**changes):
    data = copy.deepcopy(valid)
    for key, value in changes.items():
        if value is None:
            data.pop(key, None)
        else:
            data[key] = value
    return data


CASES = [
    ("complete record", valid, "submitted"),
    ("required fields missing", variant(hn=None, full_name=None, assessed_at=None, consent=None), "submitted"),
    ("a draft may leave required fields empty", variant(hn=None, consent=None), "draft"),
    ("fever: temperature required and in range", variant(temperature_c=None), "submitted"),
    ("temperature out of range", variant(temperature_c=45.5), "submitted"),
    ("no fever: the hidden temperature is not required", variant(has_fever=False, temperature_c=None), "submitted"),
    ("phone pattern", variant(contact_phone="12ab"), "submitted"),
    ("repeat: a required child missing", variant(lines=[{"gauge": "20"}]), "submitted"),
    ("repeat: too many items", variant(lines=[{"site": str(i)} for i in range(5)]), "submitted"),
    ("matrix cell out of range", variant(aldrete={"activity": {"admit": 5}}), "submitted"),
    ("Other chosen without its text", variant(_other={"smoker": "pipe"}), "submitted"),
    ("wrong value types", variant(age="abc", weight_kg=-1, has_fever="yes"), "submitted"),
    ("an option that is not offered", variant(sex="unknown", symptoms=["dizzy", "flying"]), "submitted"),
    ("unknown field", variant(not_in_form=1), "submitted"),
    ("timeline value off its axis", variant(trends={**valid["trends"], "values": {"hr": {"1": 80}}}), "submitted"),
]

out = []
for name, data, status in CASES:
    result = evaluate_record(definition, data, status)
    out.append({"name": name, "status": status, "data": data,
                "issues": sorted({(issue.path, issue.code) for issue in result.issues})})
(ROOT / "record-cases.json").write_text(json.dumps(
    [{**case, "issues": [{"path": path, "code": code} for path, code in case["issues"]]} for case in out],
    ensure_ascii=False, indent=1) + "\n")
for case in out:
    print(f"{case['name']}: {case['issues']}")
