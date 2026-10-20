"""The e2e kitchen-sink form (formdev/examples/e2e-kitchen-sink: every field type) on Canopy's side: the definition is
valid and every record case still gives the issues the TypeScript twin is checked against (record-cases.json;
frontend/tests/formdev/kitchenSink.test.ts). A change to either side's rules that breaks the agreement fails here or there."""
import json
import unittest
from pathlib import Path

from app.formdev.definition import validate_definition
from app.formdev.field_types import FIELD_TYPES
from app.formdev.logic.evaluate import evaluate_record

ROOT = Path(__file__).resolve().parents[4] / "formdev" / "examples" / "e2e-kitchen-sink"


def fields(items):
    for field in items:
        yield field
        yield from fields(field.get("fields") or [])


class KitchenSink(unittest.TestCase):
    definition = json.loads((ROOT / "v1.form.json").read_text())

    def test_every_field_type_and_a_valid_definition(self):
        types = {field["type"] for section in self.definition["sections"] for field in fields(section["fields"])}
        self.assertEqual(types, set(FIELD_TYPES))
        self.assertEqual(validate_definition(self.definition), [])

    def test_record_cases(self):
        for case in json.loads((ROOT / "record-cases.json").read_text()):
            with self.subTest(case["name"]):
                result = evaluate_record(self.definition, case["data"], case["status"])
                self.assertEqual(sorted({(issue.path, issue.code) for issue in result.issues}),
                                 sorted((issue["path"], issue["code"]) for issue in case["issues"]))


if __name__ == "__main__":
    unittest.main()
