"""Background jobs (Phase 4.9) on SQLite and PostgreSQL."""
import csv
import io
import json
import tempfile
import unittest
from contextlib import contextmanager
from urllib.parse import urlparse

from app.formdev.errors import FormDevError
from app.formdev.query.access import Principal
from app.formdev.query.engine import QueryRuntime
from app.formdev.query.jobs import JobService, JobWorker, LeaseLost, ResultStore, enqueue_reindex
from app.formdev.query.policy import policy
from helpers import USER
from test_query_engine import ADMIN, VIEWER, QueryContract, ward_record
from test_adapter_contract import FORMDEV_TABLES, PG_URL

EXPORTER = Principal(7, "exporter", ("clinical_admin", "clinician"), ("formdev.query", "formdev.export"))


class Clock:
    def __init__(self):
        self.now = 1_800_000_000_000

    def __call__(self):
        return self.now


class JobContract(QueryContract):
    N = 30

    def setUp(self):
        super().setUp()
        self.folder = tempfile.TemporaryDirectory()
        self.store = ResultStore(self.folder.name)
        self.clock = Clock()
        self.runtime = QueryRuntime(policy=policy({"jobs": {"batch_rows": 5, "per_user_open": 2, "global_open": 5}}), cursor_secret=b"jobs", clock_ms=self.clock)
        self.active = {ADMIN.user_id: ADMIN, EXPORTER.user_id: EXPORTER, VIEWER.user_id: VIEWER}
        self.worker = JobWorker(self.runtime, self.connect, self.active.get, self.store, threads=0)

    def tearDown(self):
        self.folder.cleanup()
        super().tearDown()

    @contextmanager
    def connect(self):
        yield self.fd

    def jobs(self, principal=EXPORTER):
        return JobService(self.runtime, self.fd, principal, self.store)

    def export_body(self, fmt="csv", **query):
        query.setdefault("source", "ward_check")
        query.setdefault("select", ["hn", "full_name", "age", "smoker"])
        query.setdefault("pagination", {"mode": "cursor", "limit": 50})
        return {"query": {**query, "export": {"format": fmt}}}

    def download_text(self, job_id, principal=EXPORTER):
        chunks, media_type, name, size = self.jobs(principal).download(job_id)
        content = b"".join(chunks)
        self.assertEqual(len(content), size)
        return content.decode("utf-8"), media_type

    def run_all(self):
        while self.worker.run_once("worker-a"):
            pass

    # End to end ---------------------------------------------------------------------------------
    def test_export_end_to_end_csv(self):
        self.fd.records.update("rec-0002-aaaa", {**ward_record(2), "full_name": "=HYPERLINK(\"http://x\")"}, 1, USER)
        self.fd.records.update("rec-0004-aaaa", {**ward_record(4), "full_name": "สมชาย ใจดี"}, 1, USER)
        job = self.jobs().create("export", self.export_body())
        self.assertEqual(job["status"], "queued")
        self.run_all()
        status = self.jobs().get(job["job_id"])
        self.assertEqual((status["status"], status["rows_processed"], status["progress"]), ("succeeded", self.N - 1, 1.0))
        text, media_type = self.download_text(job["job_id"])
        self.assertTrue(text.startswith("﻿"), "UTF-8 BOM for Excel")
        self.assertIn("text/csv", media_type)
        rows = list(csv.reader(io.StringIO(text.lstrip("﻿"))))
        self.assertEqual(rows[0], ["$record_id", "hn", "full_name", "age", "smoker"])
        self.assertEqual(len(rows) - 1, self.N - 1)
        by_id = {row[0]: row for row in rows[1:]}
        self.assertEqual(by_id["rec-0002-aaaa"][2], "'=HYPERLINK(\"http://x\")", "formula cells are neutralized")
        self.assertEqual(by_id["rec-0004-aaaa"][2], "สมชาย ใจดี")
        self.assertEqual(by_id["rec-0005-aaaa"][3], "", "missing values are empty cells")
        self.assertIn(by_id["rec-0006-aaaa"][4], ("true", "false"))
        self.assertTrue(text.endswith("\r\n"))
        actions = [row["action"] for row in self.adapter.list_audit()]
        self.assertIn("job_create", actions)
        self.assertIn("job_download", actions)

    def test_jsonl_export_matches_the_query(self):
        job = self.jobs().create("export", self.export_body("jsonl", filter={"field": "ward", "op": "eq", "value": "W2"}))
        self.run_all()
        text, _ = self.download_text(job["job_id"])
        exported = {json.loads(line)["$record_id"] for line in text.splitlines()}
        self.assertEqual(exported, self.live(lambda n, d: d["ward"] == "W2"))

    def test_records_present_at_start_are_exported_exactly_once(self):
        job = self.jobs().create("export", self.export_body("jsonl", select=["hn"]))
        original_check = self.worker._check
        calls = {"n": 0}

        def check(services, job_row, owner, checkpoint, rows, extend_ms=None):
            calls["n"] += 1
            if calls["n"] == 1:
                # Concurrent activity between batches: edits (old client clock) and brand-new records.
                for n in (0, 1, 27, 28):
                    self.fd.records.update(f"rec-{n:04d}-aaaa", {**ward_record(n), "age": 99}, 1, USER, updated_at=1_700_000_000_000)
                for n in range(3):
                    self.fd.records.create("ward_check", {"hn": f"NEW-{n}", "ward": "W1", "smoker": False}, USER, record_id=f"new-{n:04d}-bbbb")
            return original_check(services, job_row, owner, checkpoint, rows, extend_ms)

        self.worker._check = check
        self.run_all()
        text, _ = self.download_text(job["job_id"])
        ids = [json.loads(line)["$record_id"] for line in text.splitlines()]
        self.assertEqual(len(ids), len(set(ids)), "no duplicates")
        self.assertEqual(set(ids), self.live(), "exactly the records that existed when the job started")

    def test_retry_resumes_from_the_checkpoint(self):
        job = self.jobs().create("export", self.export_body("jsonl", select=["hn"]))
        original_check = self.worker._check
        calls = {"n": 0}

        def flaky(services, job_row, owner, checkpoint, rows, extend_ms=None):
            calls["n"] += 1
            original_check(services, job_row, owner, checkpoint, rows, extend_ms)
            if calls["n"] == 3:
                raise RuntimeError("simulated crash after the third batch")

        self.worker._check = flaky
        self.assertTrue(self.worker.run_once("worker-a"))
        row = self.adapter.get_job(job["job_id"])
        self.assertEqual((row["status"], row["attempt"], row["checkpoint"]["rows"]), ("queued", 1, 15))
        self.worker._check = original_check
        reads = {"n": 0}
        original_session = self.adapter.read_session

        def counting(*args, **kwargs):
            reads["n"] += 1
            return original_session(*args, **kwargs)

        self.adapter.read_session = counting
        self.run_all()
        self.adapter.read_session = original_session
        self.assertEqual(self.adapter.get_job(job["job_id"])["status"], "succeeded")
        self.assertLessEqual(reads["n"], 4, "the retry continues after the checkpoint instead of re-reading everything")
        ids = [json.loads(line)["$record_id"] for line in self.download_text(job["job_id"])[0].splitlines()]
        self.assertEqual(sorted(ids), sorted(self.live()))
        self.assertEqual(list(self.store.root.glob("*.part")), [])

    def test_lease_is_fenced(self):
        job = self.jobs().create("export", self.export_body("jsonl", select=["hn"]))
        with self.adapter.transaction():
            claimed = self.adapter.claim_job(job["job_id"], "worker-a", self.clock.now + 1000, self.clock.now)
        self.assertEqual(claimed["attempt"], 1)
        self.clock.now += 5000
        with self.adapter.transaction():
            reclaimed = self.adapter.claim_job(job["job_id"], "worker-b", self.clock.now + 1000, self.clock.now)
        self.assertEqual((reclaimed["lease_owner"], reclaimed["attempt"]), ("worker-b", 2))
        with self.assertRaises(LeaseLost):
            self.worker._fenced(self.fd, claimed, "worker-a", {"rows_processed": 99})
        self.assertEqual(self.adapter.get_job(job["job_id"])["rows_processed"], 0)

    def test_shutdown_returns_the_job_without_spending_an_attempt(self):
        job = self.jobs().create("export", self.export_body("jsonl", select=["hn"]))
        original_check = self.worker._check

        def stop_then_check(*args, **kwargs):
            self.worker.stop_event.set()
            return original_check(*args, **kwargs)

        self.worker._check = stop_then_check
        self.worker.run_once("worker-a")
        row = self.adapter.get_job(job["job_id"])
        self.assertEqual((row["status"], row["attempt"], row["lease_owner"]), ("queued", 0, None))
        self.worker.stop_event.clear()
        self.worker._check = original_check
        self.run_all()
        self.assertEqual(self.adapter.get_job(job["job_id"])["status"], "succeeded")

    def test_cancel_queued_and_running_jobs(self):
        queued = self.jobs().create("export", self.export_body("jsonl", select=["hn"]))
        self.assertEqual(self.jobs().cancel(queued["job_id"])["status"], "cancelled")
        running = self.jobs().create("export", self.export_body("jsonl", select=["hn"]))
        original_check = self.worker._check

        def cancel_midway(*args, **kwargs):
            self.adapter.update_job_where(running["job_id"], ("running",), {"cancel_requested": 1})
            return original_check(*args, **kwargs)

        self.worker._check = cancel_midway
        self.run_all()
        self.assertEqual(self.adapter.get_job(running["job_id"])["status"], "cancelled")
        self.assertEqual(list(self.store.root.iterdir()), [])

    def test_job_limits_permissions_and_ownership(self):
        self.jobs().create("export", self.export_body())
        self.jobs().create("export", self.export_body())
        with self.assertRaises(FormDevError) as caught:
            self.jobs().create("export", self.export_body())
        self.assertEqual((caught.exception.code, caught.exception.status), ("job_queue_full", 429))
        with self.assertRaises(FormDevError) as caught:
            self.jobs(VIEWER).create("export", self.export_body(select=["hn", "age"]))
        self.assertEqual(caught.exception.code, "export_forbidden")
        self.assertIn("denied", [row["action"] for row in self.adapter.list_audit()])
        own = self.jobs().list()[0]["job_id"]
        with self.assertRaises(FormDevError) as caught:
            self.jobs(VIEWER).get(own)
        self.assertEqual(caught.exception.status, 404)
        self.assertEqual(self.jobs(ADMIN).get(own)["job_id"], own)

    def test_inactive_owner_fails_the_job(self):
        job = self.jobs().create("export", self.export_body())
        del self.active[EXPORTER.user_id]
        self.run_all()
        row = self.adapter.get_job(job["job_id"])
        self.assertEqual((row["status"], row["error"]["code"]), ("failed", "owner_inactive"))

    def test_missing_result_is_gone_not_a_server_error(self):
        job = self.jobs().create("export", self.export_body())
        self.run_all()
        self.store.remove(job["job_id"])
        with self.assertRaises(FormDevError) as caught:
            self.jobs().download(job["job_id"])
        self.assertEqual(caught.exception.status, 410)
        self.assertEqual(self.adapter.get_job(job["job_id"])["status"], "expired")

    def test_results_expire(self):
        job = self.jobs().create("export", self.export_body())
        self.run_all()
        self.clock.now += self.runtime.policy["jobs"]["result_ttl_ms"] + 1
        self.worker.maintenance(self.fd)
        self.assertEqual(self.adapter.get_job(job["job_id"])["status"], "expired")
        self.assertEqual(list(self.store.root.iterdir()), [])

    def test_report_job_runs_large_aggregates(self):
        runtime = QueryRuntime(policy=policy({"interactive_aggregate_max_rows": 5}), cursor_secret=b"x", clock_ms=self.clock)
        body = {"query": {"source": "ward_check", "group": ["ward"], "aggregate": [{"fn": "count", "as": "n"}, {"fn": "avg", "field": "score", "as": "avg_score"}]}}
        job = JobService(runtime, self.fd, EXPORTER, self.store).create("report", body, "csv")
        JobWorker(runtime, self.connect, self.active.get, self.store, threads=0).run_once("w")
        text, _ = self.download_text(job["job_id"])
        rows = list(csv.reader(io.StringIO(text.lstrip("﻿"))))
        self.assertEqual(rows[0], ["ward", "n", "avg_score"])
        self.assertEqual(sum(int(row[1]) for row in rows[1:]), self.N - 1)

    def test_reindex_runs_as_a_job_for_large_forms(self):
        import app.formdev.indexing as indexing

        self.fd.indexing.enqueue_reindex = enqueue_reindex(self.adapter, self.clock)
        original = indexing.SYNC_REINDEX_MAX_RECORDS
        indexing.SYNC_REINDEX_MAX_RECORDS = 0
        try:
            self.assertEqual(self.fd.indexing.add_config_field("ward_check", "full_name", USER), "building")
        finally:
            indexing.SYNC_REINDEX_MAX_RECORDS = original
        with self.assertRaises(FormDevError) as caught:
            self.run_query(ADMIN, select=["hn"], filter={"field": "full_name", "op": "eq", "value": "Patient 3"}, pagination={"mode": "cursor", "limit": 5})
        self.assertEqual(caught.exception.details[0]["code"], "index_building")
        self.run_all()
        result = self.run_query(ADMIN, select=["hn"], filter={"field": "full_name", "op": "eq", "value": "Patient 3"}, pagination={"mode": "cursor", "limit": 5})
        self.assertEqual([row["hn"] for row in result["rows"]], ["HN-0003"])


class SQLiteJobContract(JobContract, unittest.TestCase):
    def make_adapter(self):
        from app.formdev.adapters.sqlite import SQLiteAdapter

        return SQLiteAdapter(":memory:")

    def tearDown(self):
        super().tearDown()
        self.adapter.close()


@unittest.skipUnless(PG_URL and urlparse(PG_URL).path.endswith("_test"), "set FORMDEV_PG_TEST_URL to a *_test database")
class PostgreSQLJobContract(JobContract, unittest.TestCase):
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
        super().tearDown()
        self.connection.close()


# Only the job tests: do not re-run the inherited query-engine tests from this module.
for _cls in (SQLiteJobContract, PostgreSQLJobContract):
    for _name in [name for name in dir(QueryContract) if name.startswith("test_")]:
        if _name not in JobContract.__dict__:
            setattr(_cls, _name, None)
del _cls, _name

if __name__ == "__main__":
    unittest.main()
