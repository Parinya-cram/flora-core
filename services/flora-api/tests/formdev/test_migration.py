"""Migration rules driven by the shared cross-language fixtures."""
import unittest

from app.formdev.errors import FormDevError
from app.formdev.migration import compatibility_issues, convert, migrate
from helpers import example, load_json


class MigrationFixtures(unittest.TestCase):
    def test_migration_cases(self):
        fixture = load_json("spec/fixtures/migration-cases.json")
        definitions = {int(version): load_json(path) for version, path in fixture["definitions"].items()}
        for case in fixture["cases"]:
            with self.subTest(case["name"]):
                original = dict(case["input"])
                result = migrate(case["input"], case["from"], case["to"], definitions.__getitem__)
                self.assertEqual(result, case["expected"])
                self.assertEqual(case["input"], original, "migration must not mutate its input")

    def test_downgrade_is_refused(self):
        with self.assertRaises(FormDevError) as caught:
            migrate({}, 2, 1, lambda version: example(version))
        self.assertEqual(caught.exception.code, "downgrade_not_supported")

    def test_example_v2_is_compatible_with_v1(self):
        self.assertEqual(compatibility_issues(example(1), example(2)), [])

    def test_dropping_a_field_without_an_op_is_reported(self):
        current = example(2)
        current["migration"]["ops"] = [op for op in current["migration"]["ops"] if op.get("field") != "smoker"]
        self.assertTrue(any("smoker" in problem for problem in compatibility_issues(example(1), current)))

    def test_type_change_without_convert_is_reported(self):
        current = example(2)
        current["migration"]["ops"] = [op for op in current["migration"]["ops"] if op["op"] != "convert_type"]
        self.assertTrue(any("weight_kg" in problem for problem in compatibility_issues(example(1), current)))

    def test_convert_rules(self):
        self.assertEqual(convert("61.5", "number"), 61.5)
        self.assertEqual(convert("60", "number"), 60)
        self.assertEqual(convert(" 7 ", "integer"), 7)
        self.assertEqual(convert(7.0, "integer"), 7)
        self.assertEqual(convert(2.5, "text"), "2.5")
        self.assertEqual(convert(3, "text"), "3")
        self.assertEqual(convert(True, "text"), "true")
        self.assertEqual(convert("1", "boolean"), True)
        self.assertIsNot(convert("1e3", "number"), 1000.0)
        self.assertIsNot(convert("inf", "number"), float("inf"))


if __name__ == "__main__":
    unittest.main()
