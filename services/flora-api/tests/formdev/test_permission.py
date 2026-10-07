"""Phase 2.8 permissions: the shared fixture (twin: frontend/src/formdev/logic/permission.test.ts) and the server
rules that apply them (masked reads, guarded sync writes, the query catalog)."""
import os
import unittest

os.environ.setdefault("FLORA_DATABASE_URL", "postgresql://unused@localhost/unused")
os.environ.setdefault("FLORA_API_MODE", "canopy")

from app.formdev.logic.permission import denied, field_permissions, form_allows, mask, record_allows  # noqa: E402
from helpers import load_json  # noqa: E402

FIXTURE = load_json("spec/fixtures/permission-cases.json")
DEFINITION = FIXTURE["definition"]
RID = "record-0001"


class SharedCases(unittest.TestCase):
    def test_cases(self):
        for case in FIXTURE["cases"]:
            with self.subTest(case["name"]):
                roles, admin = case["roles"], case["is_admin"]
                self.assertEqual({action: form_allows(DEFINITION, action, roles, admin) for action in case["form"]}, case["form"])
                self.assertEqual({action: record_allows(DEFINITION, action, roles, admin) for action in case["record"]}, case["record"])
                self.assertEqual(field_permissions(DEFINITION, roles, admin), case["fields"])
                for action, keys in case["denied"].items():
                    self.assertEqual(sorted(denied(DEFINITION, action, roles, admin)), keys)

    def test_nested_denials(self):
        self.assertEqual(denied(DEFINITION, "view", ["clinician"], nested=True), {"meds.cost"})
        self.assertEqual(denied(DEFINITION, "view", ["clinician"]), set())


class Masking(unittest.TestCase):
    def test_top_level_children_and_other_text(self):
        data = {"hn": "HN1", "diagnosis": "x", "_other": {"diagnosis": "y", "hn": "z"},
                "meds": [{"drug": "A", "cost": 10, "_other": {"cost": "?"}}, {"drug": "B"}]}
        self.assertEqual(mask(data, {"diagnosis", "meds.cost"}), {
            "hn": "HN1", "_other": {"hn": "z"}, "meds": [{"drug": "A", "_other": {}}, {"drug": "B"}]})
        self.assertIs(mask(data, set()), data)


class ServerEnforcement(unittest.TestCase):
    """Sync writes and reads for each role, through the same guards the /sync and /records routes use."""

    def setUp(self):
        from app.formdev.adapters.sqlite import SQLiteAdapter
        from helpers import ready_services

        self.adapter = SQLiteAdapter(":memory:")
        self.fd = ready_services(self.adapter)
        self.fd.schemas.create_form(DEFINITION, "tester")
        self.fd.schemas.publish(DEFINITION["form_id"], 1, "tester")
        self.seq = 0

    def tearDown(self):
        self.adapter.close()

    def principal(self, *roles):
        from app.formdev.query.access import Principal

        return Principal(1, "tester", tuple(roles), ("formdev.query",))

    def sync(self, principal, **op):
        from app.routes.formdev_runtime import hidden_fields, write_guard

        self.seq += 1
        op = {"op_id": f"perm-op-{self.seq:04d}", "form_id": DEFINITION["form_id"], **op}
        locked, allows = write_guard(self.fd, principal)
        return self.fd.sync.apply([op], "tester", protected=hidden_fields(self.fd, principal), locked=locked, allows=allows)[0]

    def test_form_actions(self):
        viewer = self.principal("viewer")
        ack = self.sync(viewer, kind="create", record_id=RID, data={"hn": "HN1"})
        self.assertEqual((ack["status"], ack["error"]["code"]), ("rejected", "forbidden"))
        ack = self.sync(self.principal("clinician"), kind="create", record_id=RID, data={"hn": "HN1"})
        self.assertEqual(ack["status"], "applied")
        ack = self.sync(self.principal("clinician"), kind="delete", record_id=RID, base_version=1)
        self.assertEqual(ack["error"]["code"], "forbidden")
        ack = self.sync(self.principal("clinical_admin"), kind="delete", record_id=RID, base_version=1)
        self.assertEqual(ack["status"], "applied")

    def test_locked_fields_keep_their_values(self):
        clinician = self.principal("clinician")
        ack = self.sync(clinician, kind="create", record_id=RID,
                        data={"hn": "HN1", "note": "typed by a clinician", "diagnosis": "flu", "meds": [{"drug": "A", "cost": 5}]})
        self.assertEqual(ack["record"]["data"], {"hn": "HN1", "diagnosis": "flu"})  # note and meds are not theirs to set
        stored = self.fd.records.get_raw(RID)
        self.assertEqual(stored["data"], {"hn": "HN1", "diagnosis": "flu"})
        # The admin may edit only the note; their copy has no diagnosis (masked), which must survive.
        admin = self.principal("clinical_admin")
        ack = self.sync(admin, kind="update", record_id=RID, base_version=1, data={"hn": "changed", "note": "admin note"})
        self.assertEqual(ack["status"], "applied")
        self.assertNotIn("diagnosis", ack["record"]["data"])
        self.assertEqual(self.fd.records.get_raw(RID)["data"], {"hn": "HN1", "diagnosis": "flu", "note": "admin note"})

    def test_reads_are_masked(self):
        from app.routes.formdev_runtime import hidden_fields

        self.sync(self.principal("clinician"), kind="create", record_id=RID, data={"hn": "HN1", "diagnosis": "flu", "hb": 12.5})
        hidden = hidden_fields(self.fd, self.principal("clinical_admin"))(DEFINITION["form_id"])
        self.assertEqual(hidden, {"diagnosis", "hb"})
        self.assertEqual(hidden_fields(self.fd, self.principal("clinician"))(DEFINITION["form_id"]), {"meds.cost"})
        self.assertEqual(mask(self.fd.records.get_raw(RID)["data"], hidden), {"hn": "HN1"})

    def test_query_catalog_follows_the_definition(self):
        from app.formdev.query.catalog import build_catalog

        catalog = build_catalog(self.fd, DEFINITION["form_id"])
        self.assertFalse(catalog.can_query(self.principal("auditor")))
        self.assertTrue(catalog.can_query(self.principal("viewer")))
        self.assertEqual(catalog.denied_fields(self.principal("viewer")), {"diagnosis"})
        admin = self.principal("clinical_admin")
        self.assertFalse(catalog.can_export_field(admin, "contact_name"))
        self.assertTrue(catalog.can_export_field(admin, "hn"))


if __name__ == "__main__":
    unittest.main()
