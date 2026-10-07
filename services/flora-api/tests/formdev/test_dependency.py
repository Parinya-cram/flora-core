"""Phase 2.3 dependency: dependent options, lookup tables and derived values. The shared fixture (twin:
frontend/tests/formdev/dependency.test.ts) plus the registry, server writes and formpacks that carry lookups."""
import copy
import unittest

from app.formdev.adapters.sqlite import SQLiteAdapter
from app.formdev.errors import FormDevError
from app.formdev.formpack import export_formpack, install_formpack, read_formpack
from app.formdev.logic.evaluate import evaluate_record
from app.formdev.logic.lookup import derive_value, lookup_ids, lookup_options
from app.formdev.lookups import validate_lookup
from helpers import USER, load_json, ready_services

FIXTURE = load_json("spec/fixtures/dependency-cases.json")
DEFINITION = load_json(FIXTURE["definition"])
TABLE = load_json(FIXTURE["lookups"]["thai_address"])
LOOKUPS = {"thai_address": TABLE["entries"]}


class SharedCases(unittest.TestCase):
    def test_cases(self):
        for case in FIXTURE["cases"]:
            with self.subTest(case["name"]):
                result = evaluate_record(DEFINITION, case["data"], case["status"], FIXTURE["today"], LOOKUPS if case["lookups"] else {})
                expect = case["expect"]
                self.assertEqual(result.data, expect["data"])
                self.assertEqual(sorted(issue.code for issue in result.issues), expect["codes"])
                self.assertEqual(sorted(issue.path for issue in result.issues), expect["paths"])
                self.assertEqual(result.hidden, expect["hidden"])
                self.assertEqual(result.options, expect["options"])

    def test_the_input_is_not_modified(self):
        data = {"hn": "HN1", "scheme": "uc", "province": "ภูเก็ต", "district": "อำเภอสันทราย"}
        before = copy.deepcopy(data)
        evaluate_record(DEFINITION, data, "draft", FIXTURE["today"], LOOKUPS)
        self.assertEqual(data, before)


class Helpers(unittest.TestCase):
    def test_options_and_derivation(self):
        entries = TABLE["entries"]
        value_of = {"province": "เชียงใหม่", "district": "อำเภอสันทราย", "subdistrict": "ตำบลสันทรายหลวง"}.get
        self.assertEqual([o["value"] for o in lookup_options(entries, {"value": "district", "filter": {"province": "province"}}, value_of)],
                         ["อำเภอเมืองเชียงใหม่", "อำเภอสันทราย"])
        self.assertEqual(derive_value(entries, {"column": "postcode", "match": {"subdistrict": "subdistrict"}}, value_of), "50210")
        self.assertIsNone(derive_value(entries, {"column": "postcode", "match": {"subdistrict": "missing"}}, value_of))
        self.assertEqual(lookup_ids(DEFINITION), {"thai_address"})

    def test_sample_table_is_valid_and_marked(self):
        self.assertEqual(validate_lookup(TABLE["lookup_id"], TABLE["metadata"], TABLE["entries"]), [])
        self.assertIs(TABLE["metadata"]["authoritative"], False)
        self.assertIn("SAMPLE", TABLE["metadata"]["notice"])

    def test_invalid_tables(self):
        codes = lambda *args: sorted(issue.code for issue in validate_lookup(*args))  # noqa: E731
        self.assertEqual(codes("Bad-Id", {"title": "t", "columns": [{"name": "a"}]}, []), ["invalid_lookup_id"])
        self.assertEqual(codes("t1", {"title": "t", "columns": [{"name": "a"}, {"name": "a"}]}, []), ["invalid_lookup"])
        self.assertEqual(codes("t1", {"title": "t", "columns": [{"name": "a"}], "colour": 1}, [{"b": "x"}, {"a": 5}]),
                         ["invalid_lookup", "invalid_lookup", "unknown_property"])


class Storage(unittest.TestCase):
    def setUp(self):
        self.adapter = SQLiteAdapter(":memory:")
        self.fd = ready_services(self.adapter)

    def tearDown(self):
        self.adapter.close()

    def test_migration_seeds_the_sample_and_put_bumps_the_version(self):
        row = self.fd.lookups.get("thai_address")
        self.assertEqual((row["version"], len(row["entries"])), (1, len(TABLE["entries"])))
        self.assertNotIn("entries", self.fd.lookups.list()[0])
        saved = self.fd.lookups.put("thai_address", {"metadata": TABLE["metadata"], "entries": TABLE["entries"][:2]}, USER)
        self.assertEqual(saved["version"], 2)
        self.assertEqual(len(self.fd.lookups.get("thai_address")["entries"]), 2)
        with self.assertRaises(FormDevError) as caught:
            self.fd.lookups.put("thai_address", {"metadata": {}, "entries": []}, USER)
        self.assertEqual(caught.exception.code, "invalid_lookup")
        with self.assertRaises(FormDevError):
            self.fd.lookups.get("nope")

    def test_server_writes_use_the_stored_table(self):
        self.fd.schemas.create_form(DEFINITION, USER)
        self.fd.schemas.publish(DEFINITION["form_id"], 1, USER)
        saved = self.fd.records.create(DEFINITION["form_id"], {"hn": "HN1", "scheme": "uc", "province": "เชียงใหม่", "district": "อำเภอสันทราย",
                                                               "subdistrict": "ตำบลสันทรายหลวง", "postcode": "00000"}, USER)
        self.assertEqual(saved["data"]["postcode"], "50210")
        draft = self.fd.records.create(DEFINITION["form_id"], {"hn": "HN2", "scheme": "uc", "province": "ภูเก็ต", "district": "อำเภอสันทราย"}, USER)
        self.assertNotIn("district", draft["data"])
        with self.assertRaises(FormDevError) as caught:
            self.fd.records.create(DEFINITION["form_id"], {"hn": "HN3", "scheme": "uc", "province": "ภูเก็ต", "district": "อำเภอสันทราย"}, USER, status="submitted")
        self.assertEqual(sorted(item["code"] for item in caught.exception.details), ["required", "required"])

    def test_formpack_carries_and_installs_the_table(self):
        self.fd.schemas.create_form(DEFINITION, USER)
        self.fd.schemas.publish(DEFINITION["form_id"], 1, USER)
        data = export_formpack(self.fd.schemas, self.fd.styles, DEFINITION["form_id"])
        package = read_formpack(data)
        self.assertEqual(package["manifest"]["lookup_ids"], ["thai_address"])
        self.assertEqual(package["lookups"][0]["entries"], TABLE["entries"])

        target = SQLiteAdapter(":memory:")
        try:
            other = ready_services(target)
            other.lookups.put("thai_address", {"metadata": TABLE["metadata"], "entries": TABLE["entries"]}, USER)  # a newer local import
            summary = install_formpack(data, other.schemas, other.styles, other.records, USER)
            self.assertEqual(summary["lookups"], {"thai_address": "unchanged"})
            self.assertEqual(other.lookups.get("thai_address")["version"], 2)
        finally:
            target.close()

    def test_formpack_refuses_a_missing_table(self):
        definition = copy.deepcopy(DEFINITION)
        definition["sections"][0]["fields"][1]["lookup"]["source"] = "not_registered"
        self.fd.schemas.create_form(definition, USER)
        self.fd.schemas.publish(definition["form_id"], 1, USER)
        with self.assertRaises(FormDevError) as caught:
            export_formpack(self.fd.schemas, self.fd.styles, definition["form_id"])
        self.assertEqual(caught.exception.code, "lookup_not_found")


if __name__ == "__main__":
    unittest.main()
