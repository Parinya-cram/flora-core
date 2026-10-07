"""One behavioural contract, executed against every storage vendor.

SQLite always runs. PostgreSQL runs when FORMDEV_PG_TEST_URL points to a disposable
database whose name ends in ``_test`` (the 0038 schema must be applied there).
Passing the same suite on both is the evidence that the engine is vendor-neutral.
"""
import os
import unittest
import uuid
from urllib.parse import urlparse

from app.formdev.adapters.sqlite import SQLiteAdapter
from app.formdev.errors import FormDevError
from helpers import USER, example, published_example, ready_services, submitted_data

PG_URL = os.environ.get("FORMDEV_PG_TEST_URL", "")
FORMDEV_TABLES = (
    "formdev_conflict", "formdev_sync_receipt", "formdev_record_index", "formdev_record_revision",
    "formdev_record", "formdev_asset", "formdev_job", "formdev_query", "formdev_query_stat", "formdev_query_audit",
    "formdev_index_coverage", "formdev_index_config", "formdev_source", "formdev_form_policy", "formdev_data_version",
    "formdev_schema_version", "formdev_form", "formdev_style", "formdev_font",
)


class Contract:
    """Mixin; subclasses provide make_adapter()."""

    def setUp(self):
        self.adapter = self.make_adapter()
        self.fd = ready_services(self.adapter)

    def op(self, kind, record_id, **fields):
        return {"op_id": str(uuid.uuid4()), "kind": kind, "record_id": record_id, "form_id": "patient_assessment", **fields}

    # Schema lifecycle -----------------------------------------------------------
    def test_records_need_a_published_version(self):
        self.fd.schemas.create_form(example(1), USER)
        with self.assertRaises(FormDevError) as caught:
            self.fd.records.create("patient_assessment", {}, USER)
        self.assertEqual(caught.exception.code, "form_not_published")

    def test_published_version_is_immutable_in_repository_and_storage(self):
        published_example(self.fd)
        changed = example(1)
        changed["title"] = "Changed after publish"
        with self.assertRaises(FormDevError) as caught:
            self.fd.schemas.save_draft(changed, USER)
        self.assertEqual(caught.exception.code, "version_immutable")
        with self.assertRaises(Exception):
            with self.adapter.transaction():
                self.adapter.update_schema_version("patient_assessment", 1, {"definition": changed, "checksum": "x"})
        self.assertEqual(self.fd.schemas.get_version("patient_assessment", 1)["definition"]["title"], example(1)["title"])

    def test_publish_rejects_incomplete_migration(self):
        published_example(self.fd)
        broken = example(2)
        broken["migration"]["ops"] = [op for op in broken["migration"]["ops"] if op.get("field") != "smoker"]
        self.fd.schemas.save_draft(broken, USER)
        with self.assertRaises(FormDevError) as caught:
            self.fd.schemas.publish("patient_assessment", 2, USER)
        self.assertEqual(caught.exception.code, "migration_incomplete")

    def test_unknown_style_is_rejected(self):
        definition = example(1)
        definition["style_id"] = "form.unknown"
        with self.assertRaises(FormDevError) as caught:
            self.fd.schemas.create_form(definition, USER)
        self.assertEqual(caught.exception.details[0]["code"], "unknown_style")

    # Record CRUD ------------------------------------------------------------------
    def test_create_read_update_submit_delete(self):
        published_example(self.fd)
        record = self.fd.records.create("patient_assessment", {"hn": "HN1"}, USER)
        self.assertEqual((record["version"], record["status"], record["schema_version"]), (1, "draft", 1))
        self.assertEqual(self.fd.records.get(record["record_id"])["data"], {"hn": "HN1"})

        updated = self.fd.records.update(record["record_id"], {"hn": "HN1", "age": 40}, 1, USER)
        self.assertEqual(updated["version"], 2)
        with self.assertRaises(FormDevError) as caught:
            self.fd.records.submit(record["record_id"], {"hn": "HN1"}, 2, USER)
        self.assertEqual(caught.exception.code, "invalid_record")
        submitted = self.fd.records.submit(record["record_id"], submitted_data(hn="HN1"), 2, USER)
        self.assertEqual((submitted["status"], submitted["version"]), ("submitted", 3))
        with self.assertRaises(FormDevError) as caught:
            self.fd.records.update(record["record_id"], submitted_data(hn="HN1"), 3, USER, status="draft")
        self.assertEqual(caught.exception.code, "invalid_transition")

        deleted = self.fd.records.delete(record["record_id"], 3, USER)
        self.assertEqual(deleted["status"], "deleted")
        self.assertEqual([row["version"] for row in self.fd.records.revisions(record["record_id"])], [1, 2, 3, 4])
        self.assertEqual(self.fd.records.search("patient_assessment")["rows"], [])
        self.assertEqual(len(self.fd.records.search("patient_assessment", statuses=["deleted"])["rows"]), 1)

    def test_stale_write_is_detected(self):
        published_example(self.fd)
        record = self.fd.records.create("patient_assessment", {"hn": "HN1"}, USER)
        self.fd.records.update(record["record_id"], {"hn": "HN2"}, 1, USER)
        with self.assertRaises(FormDevError) as caught:
            self.fd.records.update(record["record_id"], {"hn": "HN3"}, 1, USER)
        self.assertEqual(caught.exception.code, "version_conflict")
        self.assertEqual(self.fd.records.get(record["record_id"])["data"], {"hn": "HN2"})

    def test_invalid_data_writes_nothing(self):
        published_example(self.fd)
        with self.assertRaises(FormDevError):
            self.fd.records.create("patient_assessment", {"age": "old"}, USER, record_id="rec-invalid-1")
        self.assertIsNone(self.adapter.get_record("rec-invalid-1"))

    def test_hidden_field_values_are_stored(self):
        definition = example(1)
        definition["sections"][0]["fields"].append({"id": "internal_ref", "type": "text", "label": "Ref", "hidden": True})
        self.fd.schemas.create_form(definition, USER)
        self.fd.schemas.publish("patient_assessment", 1, USER)
        record = self.fd.records.create("patient_assessment", {"internal_ref": "R-9"}, USER)
        self.assertEqual(self.fd.records.get(record["record_id"])["data"]["internal_ref"], "R-9")

    # Search through the record index -------------------------------------------------
    def test_search_uses_indexed_fields_only(self):
        published_example(self.fd)
        for number, (hn, age, risk) in enumerate([("HN100", 30, "no"), ("HN101", 70, "yes"), ("HX200", 80, "yes")]):
            self.fd.records.create("patient_assessment", {"hn": hn, "age": age, "fall_risk": risk}, USER, record_id=f"rec-search-{number}")
        hns = lambda result: sorted(row["data"]["hn"] for row in result["rows"])  # noqa: E731
        self.assertEqual(hns(self.fd.records.search("patient_assessment", [{"field": "hn", "op": "eq", "value": "HN101"}])), ["HN101"])
        self.assertEqual(hns(self.fd.records.search("patient_assessment", [{"field": "hn", "op": "prefix", "value": "HN1"}])), ["HN100", "HN101"])
        self.assertEqual(hns(self.fd.records.search("patient_assessment", [{"field": "age", "op": "gte", "value": "70"}])), ["HN101", "HX200"])
        both = [{"field": "fall_risk", "op": "eq", "value": "yes"}, {"field": "age", "op": "lte", "value": 75}]
        self.assertEqual(hns(self.fd.records.search("patient_assessment", both)), ["HN101"])
        with self.assertRaises(FormDevError) as caught:
            self.fd.records.search("patient_assessment", [{"field": "full_name", "op": "eq", "value": "x"}])
        self.assertEqual(caught.exception.code, "field_not_indexed")
        with self.assertRaises(FormDevError):
            self.fd.records.search("patient_assessment", [{"field": "hn", "op": "prefix", "value": "%"}, {"field": "age", "op": "prefix", "value": "1"}])

    def test_like_wildcards_are_literal(self):
        published_example(self.fd)
        self.fd.records.create("patient_assessment", {"hn": "A_1"}, USER)
        self.fd.records.create("patient_assessment", {"hn": "AB1"}, USER)
        rows = self.fd.records.search("patient_assessment", [{"field": "hn", "op": "prefix", "value": "A_"}])["rows"]
        self.assertEqual([row["data"]["hn"] for row in rows], ["A_1"])

    def test_prefix_is_case_sensitive_on_every_vendor(self):
        published_example(self.fd)
        for hn in ("abc1", "ABC2", "ab", "b"):
            self.fd.records.create("patient_assessment", {"hn": hn}, USER)
        rows = self.fd.records.search("patient_assessment", [{"field": "hn", "op": "prefix", "value": "ab"}])["rows"]
        self.assertEqual(sorted(row["data"]["hn"] for row in rows), ["ab", "abc1"])

    def test_index_follows_updates(self):
        published_example(self.fd)
        record = self.fd.records.create("patient_assessment", {"hn": "OLD1"}, USER)
        self.fd.records.update(record["record_id"], {"hn": "NEW1"}, 1, USER)
        eq = lambda value: self.fd.records.search("patient_assessment", [{"field": "hn", "op": "eq", "value": value}])["rows"]  # noqa: E731
        self.assertEqual(eq("OLD1"), [])
        self.assertEqual(len(eq("NEW1")), 1)
        self.assertEqual(self.adapter.count_index_entries(record["record_id"]), 1)

    def test_cursor_pagination_is_stable(self):
        published_example(self.fd)
        created = {self.fd.records.create("patient_assessment", {"hn": f"HN{n}"}, USER, updated_at=1_700_000_000_000 + (n // 2))["record_id"] for n in range(7)}
        seen, cursor, pages = [], None, 0
        while True:
            page = self.fd.records.search("patient_assessment", cursor=cursor, limit=3)
            seen.extend(row["record_id"] for row in page["rows"])
            pages += 1
            cursor = page["next_cursor"]
            if not cursor:
                break
        self.assertEqual(pages, 3)
        self.assertEqual(len(seen), 7)
        self.assertEqual(set(seen), created)

    # Migration -------------------------------------------------------------------------
    def test_migration_does_not_destroy_existing_records(self):
        published_example(self.fd)
        v1_data = {"hn": "HN7", "bp": 140, "weight": "70", "fall_risk": "no", "smoker": True}
        record = self.fd.records.create("patient_assessment", v1_data, USER)
        self.fd.schemas.save_draft(example(2), USER)
        self.fd.schemas.publish("patient_assessment", 2, USER)

        view = self.fd.records.get(record["record_id"], as_version=2)
        self.assertEqual(view["data"]["bp_sys"], 140)
        self.assertEqual(view["data"]["_retired"], {"smoker": True})
        self.assertEqual(self.fd.records.get(record["record_id"])["data"], v1_data, "reading must not rewrite storage")

        upgraded = self.fd.records.upgrade(record["record_id"], 1, USER)
        self.assertEqual((upgraded["schema_version"], upgraded["version"]), (2, 2))
        self.assertEqual(self.adapter.get_revision(record["record_id"], 1)["data"], v1_data)
        rows = self.fd.records.search("patient_assessment", [{"field": "fall_risk_level", "op": "eq", "value": "low"}])["rows"]
        self.assertEqual([row["record_id"] for row in rows], [record["record_id"]])
        new = self.fd.records.create("patient_assessment", {"hn": "HN8", "bp_sys": 120}, USER)
        self.assertEqual(new["schema_version"], 2)

    # Index follows the latest published version (Phase 4) ---------------------------------
    def test_old_records_are_found_by_fields_renamed_in_a_newer_version(self):
        published_example(self.fd)
        record = self.fd.records.create("patient_assessment", {"hn": "HN9", "fall_risk": "yes"}, USER)
        self.fd.schemas.save_draft(example(2), USER)
        self.fd.schemas.publish("patient_assessment", 2, USER)
        rows = self.fd.records.search("patient_assessment", [{"field": "fall_risk_level", "op": "eq", "value": "high"}])["rows"]
        self.assertEqual([row["record_id"] for row in rows], [record["record_id"]])
        self.assertEqual(self.fd.records.get(record["record_id"])["schema_version"], 1, "reindex must not rewrite the record")
        self.assertEqual({row["field_id"]: row["state"] for row in self.adapter.list_index_coverage("patient_assessment")}["fall_risk_level"], "ready")

    def test_large_forms_reindex_in_the_background(self):
        import app.formdev.indexing as indexing

        queued = []
        self.fd.indexing.enqueue_reindex = lambda form_id, user: queued.append(form_id)
        published_example(self.fd)
        self.fd.records.create("patient_assessment", {"hn": "HN1", "fall_risk": "no"}, USER)
        original = indexing.SYNC_REINDEX_MAX_RECORDS
        indexing.SYNC_REINDEX_MAX_RECORDS = 0
        try:
            self.fd.schemas.save_draft(example(2), USER)
            self.fd.schemas.publish("patient_assessment", 2, USER)
        finally:
            indexing.SYNC_REINDEX_MAX_RECORDS = original
        self.assertEqual(queued, ["patient_assessment"])
        states = self.fd.indexing.indexed_fields("patient_assessment")
        self.assertEqual(states["fall_risk_level"]["state"], "building")
        self.assertEqual(states["hn"]["state"], "ready", "unchanged fields stay queryable")
        self.fd.indexing.reindex_all("patient_assessment")
        self.assertEqual(self.fd.indexing.indexed_fields("patient_assessment")["fall_risk_level"]["state"], "ready")

    def test_subject_id_and_ingest_order(self):
        definition = example(1)
        definition["extensions"] = {"flora.subject_field": "hn"}
        self.fd.schemas.create_form(definition, USER)
        self.fd.schemas.publish("patient_assessment", 1, USER)
        first = self.fd.records.create("patient_assessment", {"hn": "HN-A"}, USER, updated_at=5_000)
        second = self.fd.records.create("patient_assessment", {"hn": "HN-B"}, USER, updated_at=1_000)
        stored = [self.adapter.get_record(r["record_id"]) for r in (first, second)]
        self.assertEqual([row["subject_id"] for row in stored], ["HN-A", "HN-B"])
        self.assertLess(stored[0]["ingest_seq"], stored[1]["ingest_seq"], "ingest order follows the server, not client clocks")
        updated = self.fd.records.update(first["record_id"], {"hn": "HN-C"}, 1, USER)
        self.assertEqual((updated["ingest_seq"], self.adapter.get_record(first["record_id"])["subject_id"]), (stored[0]["ingest_seq"], "HN-C"))

    def test_server_side_index_config_without_publish(self):
        published_example(self.fd)
        self.fd.records.create("patient_assessment", {"hn": "HN1", "full_name": "Somchai"}, USER)
        with self.assertRaises(FormDevError):
            self.fd.records.search("patient_assessment", [{"field": "full_name", "op": "eq", "value": "Somchai"}])
        self.assertEqual(self.fd.indexing.add_config_field("patient_assessment", "full_name", USER), "ready")
        self.assertEqual(self.adapter.count_index_entries(self.fd.records.search("patient_assessment")["rows"][0]["record_id"]), 2)

    def test_writes_bump_the_change_counter(self):
        published_example(self.fd)
        before = self.adapter.data_versions(["patient_assessment"])["patient_assessment"]
        record = self.fd.records.create("patient_assessment", {"hn": "HN1"}, USER)
        self.fd.records.update(record["record_id"], {"hn": "HN2"}, 1, USER)
        self.assertEqual(self.adapter.data_versions(["patient_assessment"])["patient_assessment"], before + 2)

    # Sync --------------------------------------------------------------------------------
    def test_sync_is_idempotent(self):
        published_example(self.fd)
        create = self.op("create", "rec-sync-1", data={"hn": "HN1"}, client_updated_at=1_700_000_000_000)
        first = self.fd.sync.apply([create], USER)[0]
        again = self.fd.sync.apply([create], USER)[0]
        self.assertEqual(first["status"], "applied")
        self.assertTrue(again["duplicate"])
        self.assertEqual(again["record"], first["record"])
        self.assertEqual(len(self.fd.records.revisions("rec-sync-1")), 1)

    def test_sync_sequence_and_submit(self):
        published_example(self.fd)
        acks = self.fd.sync.apply([
            self.op("create", "rec-sync-2", data={"hn": "HN2"}),
            self.op("update", "rec-sync-2", base_version=1, data={"hn": "HN2", "age": 50}),
            self.op("submit", "rec-sync-2", base_version=2, data=submitted_data(hn="HN2")),
        ], USER)
        self.assertEqual([ack["status"] for ack in acks], ["applied", "applied", "applied"])
        self.assertEqual((acks[-1]["record"]["status"], acks[-1]["record"]["version"]), ("submitted", 3))
        self.assertEqual(acks[-1]["record"]["sync_id"], acks[-1]["op_id"])

    def test_conflict_last_write_wins_both_directions(self):
        published_example(self.fd)
        record = self.fd.records.create("patient_assessment", {"hn": "BASE"}, USER, record_id="rec-conflict", updated_at=1_000)
        self.fd.records.update(record["record_id"], {"hn": "SERVER"}, 1, "other", updated_at=5_000)

        older = self.fd.sync.apply([self.op("update", "rec-conflict", base_version=1, data={"hn": "OLDER"}, client_updated_at=3_000)], USER)[0]
        self.assertEqual((older["status"], older["conflict"]["resolution"]), ("conflict", "remote_wins"))
        self.assertEqual(self.fd.records.get("rec-conflict")["data"], {"hn": "SERVER"})

        newer = self.fd.sync.apply([self.op("update", "rec-conflict", base_version=1, data={"hn": "NEWER"}, client_updated_at=9_000)], USER)[0]
        self.assertEqual((newer["status"], newer["conflict"]["resolution"]), ("applied", "local_wins"))
        self.assertEqual(self.fd.records.get("rec-conflict")["data"], {"hn": "NEWER"})

        logged = self.adapter.list_conflicts("rec-conflict")
        self.assertEqual([row["resolution"] for row in logged], ["remote_wins", "local_wins"])
        self.assertEqual(logged[0]["local_data"], {"hn": "OLDER"})

    def test_conflict_log_keeps_insertion_order_within_one_millisecond(self):
        for conflict_id in ("zzzz-first", "aaaa-second"):
            self.adapter.insert_conflict({
                "conflict_id": conflict_id, "record_id": "rec-order", "op_id": conflict_id, "strategy": "last-write-wins",
                "resolution": "remote_wins", "base_version": 1, "server_version": 2, "local_data": {}, "server_data": {}, "created_at": 42,
            })
        self.assertEqual([row["conflict_id"] for row in self.adapter.list_conflicts("rec-order")], ["zzzz-first", "aaaa-second"])

    def test_rejected_ops_are_acknowledged_once(self):
        published_example(self.fd)
        bad = self.op("create", "rec-bad-1", data={"age": "not a number"})
        first = self.fd.sync.apply([bad], USER)[0]
        self.assertEqual((first["status"], first["error"]["code"]), ("rejected", "invalid_record"))
        self.assertTrue(self.fd.sync.apply([bad], USER)[0]["duplicate"])
        missing = self.fd.sync.apply([self.op("update", "rec-missing", base_version=1, data={})], USER)[0]
        self.assertEqual(missing["error"]["code"], "record_not_found")
        malformed = self.fd.sync.apply([{"op_id": "short"}], USER)[0]
        self.assertEqual(malformed["status"], "rejected")

    def test_failed_ops_do_not_block_others_in_a_batch(self):
        published_example(self.fd)
        acks = self.fd.sync.apply([
            self.op("create", "rec-batch-1", data={"age": -5}),
            self.op("create", "rec-batch-2", data={"hn": "OK"}),
        ], USER)
        self.assertEqual([ack["status"] for ack in acks], ["rejected", "applied"])
        self.assertIsNone(self.adapter.get_record("rec-batch-1"))

    def test_crash_before_commit_leaves_no_receipt_so_retry_succeeds(self):
        published_example(self.fd)
        create = self.op("create", "rec-crash", data={"hn": "HN1"})
        original = self.adapter.insert_revision
        calls = {"n": 0}

        def failing(row):
            calls["n"] += 1
            if calls["n"] == 1:
                raise RuntimeError("simulated storage failure")
            return original(row)

        self.adapter.insert_revision = failing
        with self.assertRaises(RuntimeError):
            self.fd.sync.apply([create], USER)
        self.assertIsNone(self.adapter.get_sync_receipt(create["op_id"]))
        self.assertIsNone(self.adapter.get_record("rec-crash"))
        self.assertEqual(self.fd.sync.apply([create], USER)[0]["status"], "applied")


class SQLiteContract(Contract, unittest.TestCase):
    def make_adapter(self):
        return SQLiteAdapter(":memory:")

    def tearDown(self):
        self.adapter.close()

    def test_phase3_files_are_upgraded_in_place(self):
        import sqlite3
        import tempfile

        from app.formdev.adapters.sqlite import MIGRATIONS

        with tempfile.TemporaryDirectory() as folder:
            path = f"{folder}/phase3.db"
            legacy = sqlite3.connect(path)
            legacy.executescript(MIGRATIONS[0].read_text(encoding="utf-8"))  # a Phase 3 file: user_version 0
            legacy.close()
            upgraded = SQLiteAdapter(path)
            self.assertEqual(upgraded.schema_version, len(MIGRATIONS))
            services = ready_services(upgraded)
            published_example(services)
            record = services.records.create("patient_assessment", {"hn": "UP1"}, USER)
            self.assertIsNotNone(upgraded.get_record(record["record_id"])["ingest_seq"])
            upgraded.close()
            self.assertEqual(SQLiteAdapter(path).schema_version, len(MIGRATIONS), "re-opening applies nothing twice")

    def test_file_database_survives_restart(self):
        import tempfile

        with tempfile.TemporaryDirectory() as folder:
            path = f"{folder}/formdev.db"
            first = ready_services(SQLiteAdapter(path))
            published_example(first)
            record = first.records.create("patient_assessment", {"hn": "KEEP"}, USER)
            first.adapter.close()
            reopened = ready_services(SQLiteAdapter(path))
            self.assertEqual(reopened.records.get(record["record_id"])["data"], {"hn": "KEEP"})
            reopened.adapter.close()


@unittest.skipUnless(PG_URL and urlparse(PG_URL).path.endswith("_test"), "set FORMDEV_PG_TEST_URL to a *_test database")
class PostgreSQLContract(Contract, unittest.TestCase):
    def make_adapter(self):
        import psycopg
        from psycopg.rows import dict_row

        from app.formdev.adapters.postgres import PostgreSQLAdapter

        self.connection = psycopg.connect(PG_URL, autocommit=True, row_factory=dict_row)
        self.connection.execute("ALTER TABLE formdev_schema_version DISABLE TRIGGER formdev_schema_version_immutable")
        for table in FORMDEV_TABLES:
            self.connection.execute(f"DELETE FROM {table}")
        self.connection.execute("ALTER TABLE formdev_schema_version ENABLE TRIGGER formdev_schema_version_immutable")
        return PostgreSQLAdapter(self.connection)

    def tearDown(self):
        self.connection.close()


if __name__ == "__main__":
    unittest.main()
