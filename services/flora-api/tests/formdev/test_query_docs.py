"""Specification documents stay in step with the code (policy, error codes, schema enums)."""
import re
import unittest
from pathlib import Path

from app.formdev.query.policy import DEFAULT_POLICY
from app.formdev.query.validator import AGG_FNS, NULL_OPS, VALUE_OPS
from helpers import FORMDEV_ROOT, load_json

APP = Path(__file__).resolve().parents[2] / "app"


class QueryDocuments(unittest.TestCase):
    def test_policy_file_matches_the_server_defaults(self):
        self.assertEqual(load_json("spec/query-policy.json"), DEFAULT_POLICY)

    def test_every_emitted_code_is_documented(self):
        spec = (FORMDEV_ROOT / "spec/QUERY.md").read_text(encoding="utf-8")
        validator = (APP / "formdev/query/validator.py").read_text(encoding="utf-8")
        codes = set(re.findall(r'(?:ctx\.(?:error|warn)\([^,]+, |Issue\([^,]+, )"([a-z_]+)"', validator))
        for path in [*(APP / "formdev/query").glob("*.py"), APP / "routes/formdev_query.py", APP / "routes/formdev_runtime.py"]:
            codes |= set(re.findall(r'FormDevError\(\s*"([a-z_]+)"', path.read_text(encoding="utf-8")))
        self.assertGreater(len(codes), 50)
        missing = sorted(code for code in codes if f"`{code}`" not in spec)
        self.assertEqual(missing, [], "codes missing from formdev/spec/QUERY.md")

    def test_schema_enumerations_match_the_validator(self):
        schema = load_json("spec/query.schema.json")
        self.assertEqual(set(schema["$defs"]["leaf"]["properties"]["op"]["enum"]), VALUE_OPS | NULL_OPS)
        self.assertEqual(set(schema["$defs"]["aggregate"]["properties"]["fn"]["enum"]), AGG_FNS)
        self.assertEqual(schema["properties"]["format"]["const"], "flora.query/1")


if __name__ == "__main__":
    unittest.main()
