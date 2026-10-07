"""Read-side access on the record endpoints and in sync acknowledgements (Phase 4 review, group A): the same
rules as the query engine, version-aware masking, fail-closed policies, admin-only deleted records."""
import copy
import os
import unittest

os.environ.setdefault("FLORA_DATABASE_URL", "postgresql://unused@localhost/unused")
os.environ.setdefault("FLORA_API_MODE", "canopy")

from app.formdev.adapters.sqlite import SQLiteAdapter  # noqa: E402
from app.formdev.errors import FormDevError  # noqa: E402
from app.formdev.query.access import Principal  # noqa: E402
from app.formdev.query.catalog import build_catalog  # noqa: E402
from app.formdev.query.engine import QueryEngine, QueryRuntime  # noqa: E402
from app.formdev.record_access import RecordAccess  # noqa: E402
from helpers import USER, ready_services  # noqa: E402
from test_query_engine import ADMIN, CLINICIAN, REG_FORM, VIEWER, WARD_FORM, ward_record  # noqa: E402

NO_QUERY = Principal(7, "clerk", ("clerk",), ())


class Base(unittest.TestCase):
    def setUp(self):
        self.adapter = SQLiteAdapter(":memory:")
        self.fd = ready_services(self.adapter)
        for definition in (WARD_FORM, REG_FORM):
            self.fd.schemas.create_form(definition, USER)
            self.fd.schemas.publish(definition["form_id"], 1, USER)
        self.r1 = self.fd.records.create("ward_check", ward_record(1), USER, record_id="rec-0001-aaaa")

    def tearDown(self):
        self.adapter.close()

    def policy(self, policy, form_id="ward_check", version=1):
        self.adapter.save_form_policy({"form_id": form_id, "policy": policy, "version": version, "updated_at": 0, "updated_by": USER})

    def view(self, principal, form_id="ward_check"):
        return RecordAccess(self.fd, principal).form(form_id)

    def publish_v2(self, change, ops):
        v2 = copy.deepcopy(WARD_FORM)
        v2["schema_version"] = 2
        change(v2)
        v2["migration"] = {"from": 1, "ops": ops}
        self.fd.schemas.save_draft(v2, USER)
        self.fd.schemas.publish("ward_check", 2, USER)


class SubjectAndRelations(Base):
    def test_subject_id_follows_the_subject_field(self):
        """security:1 — $subject_id must not bypass a restriction on hn."""
        self.policy({"fields": {"hn": ["clinician"]}})
        catalog = build_catalog(self.fd, "ward_check")
        self.assertFalse(catalog.can_read(VIEWER, "$subject_id"))
        self.assertTrue(catalog.can_read(CLINICIAN, "$subject_id"))
        engine = QueryEngine(QueryRuntime(cursor_secret=b"t"), self.fd, VIEWER)
        with self.assertRaises(FormDevError) as caught:
            engine.run({"query": {"source": "ward_check", "select": ["$subject_id"], "filter": {"field": "$subject_id", "op": "prefix", "value": "HN-"}}})
        self.assertEqual(caught.exception.code, "invalid_query")
        self.assertEqual(self.view(VIEWER).mask_row(self.r1)["subject_id"], None)
        self.assertEqual(self.view(CLINICIAN).mask_row(self.r1)["subject_id"], "HN-0001")

    def test_relations_on_an_unreadable_local_field_are_hidden(self):
        """security:2 — patient.hn must not reveal a restricted hn."""
        self.policy({"fields": {"hn": ["clinician"]}})
        self.adapter.save_source({"source_id": "assessments", "form_id": "ward_check", "version": 1, "updated_at": 0, "updated_by": USER,
                                  "config": {"relations": {"patient": {"source": "patient_registration", "local": "hn", "foreign": "hn"}}}})
        catalog = build_catalog(self.fd, "assessments")
        self.assertNotIn("patient", catalog.public(VIEWER)["relations"])
        self.assertIn("patient", catalog.public(CLINICIAN)["relations"])
        engine = QueryEngine(QueryRuntime(cursor_secret=b"t"), self.fd, VIEWER)
        with self.assertRaises(FormDevError) as caught:
            engine.run({"query": {"source": "assessments", "select": ["patient.hn", "age"]}})
        self.assertIn("invalid_relation", str(caught.exception.details))


class VersionsAndPolicies(Base):
    def test_old_rows_are_masked_under_their_own_field_names(self):
        """security:3 / regressions:2 — remarks (v1) became notes (v2, restricted)."""
        self.publish_v2(lambda d: d["sections"][0]["fields"][-1].update({"id": "notes", "label": "Notes"}), [{"op": "rename_field", "from": "remarks", "to": "notes"}])
        self.policy({"fields": {"notes": ["clinician"]}}, version=2)
        stored = self.fd.records.get_raw("rec-0001-aaaa")
        self.assertIn("remarks", stored["data"])
        self.assertNotIn("remarks", self.view(VIEWER).mask_row(stored)["data"])
        self.assertIn("remarks", self.view(CLINICIAN).mask_row(stored)["data"])

    def test_publish_carries_the_policy_and_masking_never_fails_open(self):
        """security:4 / regressions:1 — renaming a restricted field keeps it restricted."""
        self.policy({"fields": {"remarks": ["clinician"], "full_name": ["clinician"]}})
        self.publish_v2(lambda d: d["sections"][0]["fields"][-1].update({"id": "notes", "label": "Notes"}), [{"op": "rename_field", "from": "remarks", "to": "notes"}])
        policy = self.adapter.get_form_policy("ward_check")
        self.assertEqual((policy["version"], policy["policy"]["fields"]), (2, {"notes": ["clinician"], "full_name": ["clinician"]}))
        build_catalog(self.fd, "ward_check")  # still valid
        self.assertEqual(self.view(VIEWER).hidden_latest, {"notes", "full_name"})

    def test_a_policy_that_no_longer_applies_fails_closed(self):
        self.policy({"query": ["clinician"], "fields": {"no_such_field": ["clinician"], "full_name": ["clinician"]}})
        with self.assertRaises(FormDevError):
            build_catalog(self.fd, "ward_check")
        viewer = self.view(VIEWER)
        self.assertFalse(viewer.readable)
        nurse = self.view(CLINICIAN)
        self.assertTrue(nurse.readable)
        self.assertTrue({"no_such_field", "full_name"} <= nurse.hidden_latest)
        self.assertEqual(nurse.mask_row(self.r1)["created_by"], None)

    def test_the_form_query_list_and_deleted_records(self):
        """security:5 / spec:2 — the policy's query list and admin-only deleted records."""
        self.policy({"query": ["clinician"]})
        self.assertFalse(self.view(VIEWER).readable)
        self.assertTrue(self.view(CLINICIAN).readable)
        self.assertFalse(self.view(NO_QUERY).readable)
        deleted = self.fd.records.delete("rec-0001-aaaa", 1, USER)
        self.assertFalse(self.view(CLINICIAN).can_see(deleted))
        self.assertTrue(self.view(ADMIN).can_see(deleted))

    def test_metadata_and_retired_values(self):
        self.policy({"fields": {"$created_by": ["system_admin"]}})
        row = {**self.r1, "data": {**self.r1["data"], "_retired": {"old": 1}}}
        seen = self.view(CLINICIAN).mask_row(row)
        self.assertEqual((seen["created_by"], "_retired" in seen["data"]), (None, False))
        admin = self.view(ADMIN).mask_row(row)
        self.assertEqual((admin["created_by"], admin["data"]["_retired"]), (USER, {"old": 1}))

    def test_policy_restricting_a_non_queryable_field(self):
        self.policy({"fields": {"remarks": ["clinician"]}})
        self.assertIn("remarks", self.view(VIEWER).hidden_latest)


class SyncAccess(Base):
    """security:6 — sync updates/deletes of existing records need read access (or authorship); acks never carry
    data the caller may not read."""

    def sync(self, principal, **op):
        from app.routes.formdev_runtime import hidden_fields, write_guard

        access = RecordAccess(self.fd, principal)

        def present(record):
            view = access.form(record["form_id"])
            return view.mask_row(record) if view.can_see(record) else {key: record.get(key) for key in ("record_id", "form_id", "version", "status")}

        locked, allows = write_guard(self.fd, principal, access)
        self.seq = getattr(self, "seq", 0) + 1
        op = {"op_id": f"access-op-{self.seq:04d}", "form_id": "ward_check", **op}
        return self.fd.sync.apply([op], principal.username, protected=hidden_fields(self.fd, principal, access), locked=locked, allows=allows, present=present)[0]

    def test_writers_without_read_access(self):
        self.policy({"query": ["clinician"]})
        stranger = Principal(8, "integration", ("integration",), ())
        created = self.sync(stranger, kind="create", record_id="ext-record-01", data={"hn": "HN-9"})
        self.assertEqual(created["status"], "applied")
        self.assertNotIn("data", created["record"], "no read access: identity and version only")
        own = self.sync(stranger, kind="update", record_id="ext-record-01", base_version=1, data={"hn": "HN-9b"})
        self.assertEqual(own["status"], "applied", "the creator may keep editing its own record")
        other = self.sync(stranger, kind="update", record_id="rec-0001-aaaa", base_version=0, data={}, client_updated_at=1)
        self.assertEqual((other["status"], other["error"]["code"]), ("rejected", "forbidden"))
        self.assertNotIn("record", other)
        gone = self.sync(stranger, kind="delete", record_id="rec-0001-aaaa", base_version=1)
        self.assertEqual(gone["error"]["code"], "forbidden")
        self.assertEqual(self.fd.records.get_raw("rec-0001-aaaa")["status"], "draft")

    def test_masked_acks_and_replays(self):
        """regressions:0 — acks (and duplicate replays) never include fields the writer may not read."""
        self.policy({"fields": {"full_name": ["clinician"]}})
        op = {"kind": "update", "record_id": "rec-0001-aaaa", "base_version": 1, "data": {"hn": "HN-0001"}}
        first = self.sync(VIEWER, **op)
        self.assertNotIn("full_name", first["record"]["data"])
        self.assertEqual(self.fd.records.get_raw("rec-0001-aaaa")["data"]["full_name"], "Patient 1", "kept, not erased")
        self.seq -= 1
        replay = self.sync(VIEWER, **op)
        self.assertTrue(replay.get("duplicate"))
        self.assertNotIn("full_name", replay["record"]["data"])


if __name__ == "__main__":
    unittest.main()
