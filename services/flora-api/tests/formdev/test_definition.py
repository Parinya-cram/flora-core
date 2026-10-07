"""Definition, record and index rules driven by the shared cross-language fixtures."""
import json
import unittest

from app.formdev.definition import checksum, index_entries, validate_definition, validate_record
from app.formdev.field_types import FIELD_TYPES, all_props
from helpers import FORMDEV_ROOT, load_json

STYLES = [row["style_id"] for row in load_json("registry/styles.json")]
FONTS = [row["font_id"] for row in load_json("registry/fonts.json")]


class DefinitionFixtures(unittest.TestCase):
    def test_definition_cases(self):
        for case in load_json("spec/fixtures/definition-cases.json"):
            with self.subTest(case["name"]):
                codes = sorted(issue.code for issue in validate_definition(case["definition"], STYLES, FONTS))
                self.assertEqual(codes, sorted(case["codes"]))

    def test_record_cases(self):
        fixture = load_json("spec/fixtures/record-cases.json")
        definition = load_json(fixture["definition"])
        for case in fixture["cases"]:
            with self.subTest(case["name"]):
                codes = sorted(issue.code for issue in validate_record(definition, case["data"], case["status"]))
                self.assertEqual(codes, sorted(case["codes"]))

    def test_index_cases(self):
        fixture = load_json("spec/fixtures/index-cases.json")
        definition = load_json(fixture["definition"])
        for case in fixture["cases"]:
            with self.subTest(case["name"]):
                self.assertEqual(index_entries(definition, case["data"]), case["expected"])

    def test_examples_are_valid(self):
        for version in (1, 2):
            definition = load_json(f"examples/patient-assessment/v{version}.form.json")
            self.assertEqual(validate_definition(definition, STYLES, FONTS), [])

    def test_checksum_ignores_key_order(self):
        definition = load_json("examples/patient-assessment/v1.form.json")
        reordered = json.loads(json.dumps(definition, sort_keys=True))
        self.assertEqual(checksum(definition), checksum(dict(reversed(list(reordered.items())))))

    def test_json_schema_document_is_well_formed(self):
        schema = load_json("spec/form-definition.schema.json")
        self.assertEqual(schema["properties"]["format"]["const"], "flora.form/1")
        # The schema lists exactly the registered field types and field properties.
        self.assertEqual(sorted(schema["$defs"]["field"]["properties"]["type"]["enum"]), sorted(FIELD_TYPES))
        self.assertEqual(sorted(schema["$defs"]["field"]["properties"]), sorted(all_props()))

    def test_schema_registry_seeds_match_registry_files(self):
        import importlib.util

        spec = importlib.util.spec_from_file_location("sync_registry_seed", FORMDEV_ROOT / "scripts/sync_registry_seed.py")
        generator = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(generator)
        for path, cast in generator.SEED_TARGETS.items():
            with self.subTest(path.name):
                self.assertIn(generator.seed_block(cast), path.read_text(encoding="utf-8"))
        for path, (cast, transactional) in generator.UPGRADE_TARGETS.items():
            with self.subTest(path.name):
                self.assertEqual(path.read_text(encoding="utf-8"), generator.upgrade_file(cast, transactional))
        with self.subTest(generator.TS_TARGET.name):
            self.assertEqual(generator.TS_TARGET.read_text(encoding="utf-8"), generator.ts_module())
        with self.subTest("message catalogs"):
            self.assertEqual(generator.MESSAGES_PY.read_text(encoding="utf-8"), generator.messages_py())
            self.assertEqual(generator.MESSAGES_TS.read_text(encoding="utf-8"), generator.messages_ts())


if __name__ == "__main__":
    unittest.main()
