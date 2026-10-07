"""Index rebuilds (Phase 4 review, group D): batches never overwrite a concurrent write with stale values
(regressions:3, spec:5), a subject-field change backfills subject_id (regressions:5), upgraded databases are
rebuilt once (regressions:8) and the SQLite upgrade backfill is not quadratic (regressions:9)."""
import os
import sqlite3
import tempfile
import threading
import time
import unittest
from urllib.parse import urlparse

os.environ.setdefault("FLORA_DATABASE_URL", "postgresql://unused@localhost/unused")
os.environ.setdefault("FLORA_API_MODE", "canopy")

import app.formdev.indexing as indexing  # noqa: E402
from app.formdev.adapters.sqlite import MIGRATIONS, SQLiteAdapter  # noqa: E402
from app.formdev.errors import FormDevError  # noqa: E402
from app.formdev.query.engine import QueryEngine, QueryRuntime  # noqa: E402
from helpers import USER, example, published_example, ready_services  # noqa: E402
from test_adapter_contract import FORMDEV_TABLES, MYSQL_READY, MYSQL_URL, PG_URL, fresh_mysql  # noqa: E402
from test_query_engine import ADMIN  # noqa: E402

FORM = "patient_assessment"


def with_subject(definition, field="hn"):
    definition["extensions"] = {**(definition.get("extensions") or {}), "flora.subject_field": field}
    return definition


class RebuildContract:
    """make_adapter() -> adapter; second_adapter() -> another connection to the same database."""

    def setUp(self):
        self.adapter = self.make_adapter()
        self.fd = ready_services(self.adapter)

    def query(self, **query):
        query.setdefault("source", FORM)
        query.setdefault("pagination", {"mode": "cursor", "limit": 50})
        return QueryEngine(QueryRuntime(cursor_secret=b"t"), self.fd, ADMIN).run({"query": query})

    def test_a_write_during_a_batch_is_not_overwritten(self):
        published_example(self.fd)
        records = [self.fd.records.create(FORM, {"hn": f"HN-OLD{n}"}, USER) for n in range(3)]
        target = records[1]
        second = self.second_adapter()
        other = ready_services(second) if not hasattr(self, "second_services") else self.second_services(second)
        original = self.adapter.records_after
        writer = {}

        def read_then_concurrent_write(*args, **kwargs):
            rows = original(*args, **kwargs)

            def write():
                current = other.records.get(target["record_id"])
                writer["record"] = other.records.update(target["record_id"], {"hn": "HN-NEW1"}, current["version"], USER)

            thread = threading.Thread(target=write)
            thread.start()
            thread.join(0.5)  # finishes at once without a lock; with one, waits for the batch to commit
            writer["thread"] = thread
            return rows

        self.adapter.records_after = read_then_concurrent_write
        try:
            self.fd.indexing.reindex_batch(FORM, None, 10)
        finally:
            self.adapter.records_after = original
        writer["thread"].join(10)
        second.close()
        self.assertEqual(writer["record"]["data"]["hn"], "HN-NEW1")
        found = self.query(select=["hn"], filter={"field": "hn", "op": "eq", "value": "HN-NEW1"})
        self.assertEqual([row["$record_id"] for row in found["rows"]], [target["record_id"]], "the index follows the record")
        stale = self.query(select=["hn"], filter={"field": "hn", "op": "eq", "value": "HN-OLD1"})
        self.assertEqual(stale["rows"], [])

    def test_a_subject_field_change_backfills_subject_id(self):
        published_example(self.fd)
        record = self.fd.records.create(FORM, {"hn": "HN0001"}, USER)
        self.fd.schemas.save_draft(with_subject(example(2)), USER)
        self.fd.schemas.publish(FORM, 2, USER)
        self.assertEqual(self.adapter.get_record(record["record_id"])["subject_id"], "HN0001", "small forms: rebuilt inline")

    def test_a_large_subject_change_is_building_until_rebuilt(self):
        queued = []
        self.fd.indexing.enqueue_reindex = lambda form_id, user: queued.append(form_id)
        published_example(self.fd)
        record = self.fd.records.create(FORM, {"hn": "HN0001"}, USER)
        original = indexing.SYNC_REINDEX_MAX_RECORDS
        indexing.SYNC_REINDEX_MAX_RECORDS = 0
        try:
            self.fd.schemas.save_draft(with_subject(example(2)), USER)
            self.fd.schemas.publish(FORM, 2, USER)
        finally:
            indexing.SYNC_REINDEX_MAX_RECORDS = original
        self.assertEqual(queued, [FORM])
        self.assertEqual(self.fd.indexing.metadata_building(FORM), ["$subject_id"])
        with self.assertRaises(FormDevError) as caught:
            self.query(select=["hn"], filter={"field": "$subject_id", "op": "eq", "value": "HN0001"})
        self.assertEqual(caught.exception.details[0]["code"], "index_building")
        self.fd.indexing.reindex_all(FORM)
        self.assertEqual(self.fd.indexing.metadata_building(FORM), [])
        self.assertEqual(self.adapter.get_record(record["record_id"])["subject_id"], "HN0001")
        found = self.query(select=["hn"], filter={"field": "$subject_id", "op": "eq", "value": "HN0001"})
        self.assertEqual(len(found["rows"]), 1)

    def test_a_publish_without_index_changes_keeps_building_fields_building(self):
        self.fd.indexing.enqueue_reindex = lambda form_id, user: None
        published_example(self.fd)
        self.fd.records.create(FORM, {"hn": "HN1"}, USER)
        original = indexing.SYNC_REINDEX_MAX_RECORDS
        indexing.SYNC_REINDEX_MAX_RECORDS = 0
        try:
            self.fd.schemas.save_draft(example(2), USER)
            self.fd.schemas.publish(FORM, 2, USER)
            self.assertEqual(self.fd.indexing.indexed_fields(FORM)["fall_risk_level"]["state"], "building")
            self.fd.indexing.schedule(FORM, set(), set(), USER)  # e.g. a later publish that changes no index
        finally:
            indexing.SYNC_REINDEX_MAX_RECORDS = original
        self.assertEqual(self.fd.indexing.indexed_fields(FORM)["fall_risk_level"]["state"], "building", "nothing was rebuilt")


class SQLiteRebuild(RebuildContract, unittest.TestCase):
    def make_adapter(self):
        self.folder = tempfile.TemporaryDirectory()
        return SQLiteAdapter(f"{self.folder.name}/formdev.db")

    def second_adapter(self):
        return SQLiteAdapter(f"{self.folder.name}/formdev.db")

    def tearDown(self):
        self.adapter.close()
        self.folder.cleanup()

    def legacy_file(self, path, records):
        """A Phase 3 file (migration 1 only) holding the published example and ``records`` records."""
        modern = ready_services(SQLiteAdapter(f"{self.folder.name}/modern.db"))
        published_example(modern)
        modern.adapter.close()
        legacy = sqlite3.connect(path)
        legacy.executescript(MIGRATIONS[0].read_text(encoding="utf-8"))
        legacy.execute("ATTACH DATABASE ? AS modern", (f"{self.folder.name}/modern.db",))
        legacy.execute("INSERT INTO formdev_form SELECT * FROM modern.formdev_form")
        legacy.execute("INSERT INTO formdev_schema_version SELECT * FROM modern.formdev_schema_version")
        legacy.executemany(
            "INSERT INTO formdev_record (record_id, form_id, schema_version, status, data, created_at, created_by, updated_at, updated_by, version) "
            "VALUES (?, ?, 1, 'submitted', ?, ?, 'legacy', ?, 'legacy', 1)",
            [(f"legacy-{n:07d}", FORM, '{"hn": "HN%07d"}' % n, 1_700_000_000_000 + (n * 7919) % records, 1_700_000_000_000 + n) for n in range(records)],
        )
        legacy.commit()
        legacy.close()

    def test_upgraded_files_are_rebuilt_once(self):
        """regressions:8 — every field (and $subject_id) is building until the first full rebuild."""
        path = f"{self.folder.name}/phase3.db"
        self.legacy_file(path, 12)
        upgraded = SQLiteAdapter(path)
        services = ready_services(upgraded)
        self.assertTrue(all(info["state"] == "building" for info in services.indexing.indexed_fields(FORM).values()))
        self.assertEqual(services.indexing.metadata_building(FORM), ["$subject_id"])
        self.assertEqual(upgraded.building_forms(), [FORM])
        services.indexing.reindex_all(FORM)
        self.assertTrue(all(info["state"] == "ready" for info in services.indexing.indexed_fields(FORM).values()))
        self.assertEqual(upgraded.building_forms(), [])
        upgraded.close()

    def test_the_upgrade_backfill_is_not_quadratic(self):
        """regressions:9 — 20 000 records took 25.7 s with the correlated count."""
        path = f"{self.folder.name}/big.db"
        self.legacy_file(path, 20_000)
        started = time.monotonic()
        upgraded = SQLiteAdapter(path)
        elapsed = time.monotonic() - started
        self.assertLess(elapsed, 5.0)
        rows = upgraded.connection.execute("SELECT created_at, record_id, ingest_seq FROM formdev_record ORDER BY created_at, record_id").fetchall()
        self.assertEqual([row["ingest_seq"] for row in rows], list(range(1, 20_001)), "ingest order follows created_at, then record_id")
        upgraded.close()


@unittest.skipUnless(PG_URL and urlparse(PG_URL).path.endswith("_test"), "set FORMDEV_PG_TEST_URL to a *_test database")
class PostgreSQLRebuild(RebuildContract, unittest.TestCase):
    def connect(self):
        import psycopg
        from psycopg.rows import dict_row

        return psycopg.connect(PG_URL, autocommit=True, row_factory=dict_row)

    def make_adapter(self):
        from app.formdev.adapters.postgres import PostgreSQLAdapter

        self.connection = self.connect()
        self.connection.execute("ALTER TABLE formdev_schema_version DISABLE TRIGGER formdev_schema_version_immutable")
        for table in FORMDEV_TABLES:
            self.connection.execute(f"DELETE FROM {table}")
        self.connection.execute("ALTER TABLE formdev_schema_version ENABLE TRIGGER formdev_schema_version_immutable")
        return PostgreSQLAdapter(self.connection)

    def second_adapter(self):
        from app.formdev.adapters.postgres import PostgreSQLAdapter

        return _Closing(PostgreSQLAdapter(self.connect()))

    def second_services(self, adapter):
        from app.formdev import services_for

        return services_for(adapter)

    def tearDown(self):
        self.connection.close()


@unittest.skipUnless(MYSQL_READY, "set FORMDEV_MYSQL_TEST_URL to a *_test database")
class MySQLRebuild(RebuildContract, unittest.TestCase):
    def make_adapter(self):
        return fresh_mysql()

    def second_adapter(self):
        from app.formdev.adapters.mysql import MySQLAdapter

        return MySQLAdapter(MYSQL_URL)

    def second_services(self, adapter):
        from app.formdev import services_for

        return services_for(adapter)

    def tearDown(self):
        self.adapter.close()


class _Closing:
    """A PostgreSQLAdapter whose close() closes its own connection."""

    def __init__(self, adapter):
        self._adapter = adapter

    def __getattr__(self, name):
        return getattr(self._adapter, name)

    def close(self):
        self._adapter.connection.close()


if __name__ == "__main__":
    unittest.main()
