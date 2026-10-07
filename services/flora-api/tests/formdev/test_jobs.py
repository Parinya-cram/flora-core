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
from test_adapter_contract import FORMDEV_TABLES, MYSQL_READY, PG_URL, fresh_mysql

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
        self.worker = JobWorker(self.runtime, self.connect, self.owner, self.store, threads=0)

    def tearDown(self):
        self.folder.cleanup()
        super().tearDown()

    def owner(self, services, user_id):
        return self.active.get(user_id)

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
        JobWorker(runtime, self.connect, self.owner, self.store, threads=0).run_once("w")
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


    # Phase 4 review, group C ---------------------------------------------------------------------
    def test_search_jobs_need_the_export_permission(self):
        """security:0 / spec:1 — a search job is a downloadable bulk file."""
        with self.assertRaises(FormDevError) as caught:
            self.jobs(VIEWER).create("search", self.export_body("jsonl", select=["hn", "age"]))
        self.assertEqual(caught.exception.code, "export_forbidden")
        job = self.jobs().create("search", self.export_body("jsonl", select=["hn"]))
        self.active[EXPORTER.user_id] = Principal(EXPORTER.user_id, "exporter", EXPORTER.roles, ("formdev.query",))
        self.run_all()
        row = self.adapter.get_job(job["job_id"])
        self.assertEqual((row["status"], row["error"]["code"]), ("failed", "export_forbidden"), "re-checked when claimed")

    def test_download_rechecks_permissions(self):
        """security:9 / spec:10 — revoking export or a field withdraws finished results."""
        job = self.jobs().create("export", self.export_body("jsonl", select=["hn", "full_name"]))
        self.run_all()
        self.download_text(job["job_id"])
        revoked = Principal(EXPORTER.user_id, "exporter", EXPORTER.roles, ("formdev.query",))
        with self.assertRaises(FormDevError) as caught:
            self.jobs(revoked).download(job["job_id"])
        self.assertEqual((caught.exception.code, caught.exception.status), ("export_forbidden", 403))
        self.assertIn("denied", [row["action"] for row in self.adapter.list_audit()])
        self.adapter.save_form_policy({"form_id": "ward_check", "policy": {"fields": {"full_name": ["system_admin"]}}, "version": 1,
                                       "updated_at": 0, "updated_by": USER})
        with self.assertRaises(FormDevError) as caught:
            self.jobs().download(job["job_id"])
        self.assertEqual(caught.exception.code, "export_forbidden", "a selected field is no longer readable")
        self.download_text(job["job_id"], ADMIN)

    def test_retained_results_quota(self):
        """security:11 — finished results count against a per-user byte quota."""
        self.runtime.policy["jobs"]["per_user_retained_bytes"] = 1
        job = self.jobs().create("export", self.export_body())
        self.run_all()
        with self.assertRaises(FormDevError) as caught:
            self.jobs().create("export", self.export_body())
        self.assertEqual((caught.exception.code, caught.exception.status), ("job_quota_exceeded", 429))
        self.clock.now += self.runtime.policy["jobs"]["result_ttl_ms"] + 1
        self.worker.maintenance(self.fd)
        self.assertEqual(self.adapter.get_job(job["job_id"])["status"], "expired")
        self.jobs().create("export", self.export_body())

    def test_a_cancelled_job_whose_worker_died_ends(self):
        """reliability:2 / spec:4 — cancel_requested jobs are never claimable; maintenance finishes them."""
        job = self.jobs().create("export", self.export_body("jsonl", select=["hn"]))
        with self.adapter.transaction():
            self.adapter.claim_job(job["job_id"], "dead-worker", self.clock.now + 1000, self.clock.now)
        self.assertEqual(self.jobs().cancel(job["job_id"])["status"], "running")
        self.worker.maintenance(self.fd)
        self.assertEqual(self.adapter.get_job(job["job_id"])["status"], "running", "the lease is still valid")
        self.clock.now += 2000
        self.worker.maintenance(self.fd)
        self.assertEqual(self.adapter.get_job(job["job_id"])["status"], "cancelled")
        self.assertEqual(self.adapter.count_open_jobs(EXPORTER.user_id), 0)

    def test_an_infrastructure_failure_after_a_cancel_ends_cancelled(self):
        job = self.jobs().create("export", self.export_body("jsonl", select=["hn"]))
        original_check = self.worker._check

        def cancel_then_crash(*args, **kwargs):
            original_check(*args, **kwargs)
            self.adapter.update_job_where(job["job_id"], ("running",), {"cancel_requested": 1})
            raise RuntimeError("simulated crash")

        self.worker._check = cancel_then_crash
        self.worker.run_once("worker-a")
        self.assertEqual(self.adapter.get_job(job["job_id"])["status"], "cancelled")
        self.assertEqual(list(self.store.root.iterdir()), [])

    def test_runtime_is_measured_per_attempt(self):
        """reliability:3 — a requeued job does not carry its old started_at."""
        job = self.jobs().create("export", self.export_body("jsonl", select=["hn"]))
        original_check = self.worker._check

        def stop_then_check(*args, **kwargs):
            self.worker.stop_event.set()
            return original_check(*args, **kwargs)

        self.worker._check = stop_then_check
        self.worker.run_once("worker-a")
        self.worker.stop_event.clear()
        self.worker._check = original_check
        self.clock.now += self.runtime.policy["jobs"]["max_runtime_ms"] + 60_000
        self.run_all()
        self.assertEqual(self.adapter.get_job(job["job_id"])["status"], "succeeded")

    def test_a_stale_worker_never_removes_the_new_owners_result(self):
        """reliability:4 — failure paths remove files only after a fenced update succeeded."""
        job = self.jobs().create("export", self.export_body("jsonl", select=["hn"]))
        with self.adapter.transaction():
            stale = self.adapter.claim_job(job["job_id"], "worker-a", self.clock.now + 1000, self.clock.now)
        self.clock.now += 5000
        self.assertTrue(self.worker.run_once("worker-b"))
        del self.active[EXPORTER.user_id]  # worker-a now fails its own (lost) attempt with owner_inactive
        self.worker._process(self.fd, stale, "worker-a")
        self.active[EXPORTER.user_id] = EXPORTER
        self.assertEqual(self.adapter.get_job(job["job_id"])["status"], "succeeded")
        self.download_text(job["job_id"])

    def test_a_reclaimed_part_is_copied_not_shared(self):
        job_id = self.jobs().create("export", self.export_body("jsonl", select=["hn"]))["job_id"]
        old = self.store.open_part(job_id, 1, None, 0)
        old.write(b"abc")
        old.flush()
        new = self.store.open_part(job_id, 2, self.store.part(job_id, 1), 3)
        old.write(b"STALE")  # the stale worker's handle
        old.flush()
        old.close()
        new.seek(0)
        self.assertEqual(new.read(), b"abc")
        new.close()
        self.assertFalse(self.store.part(job_id, 1).exists())

    def test_cancel_never_removes_a_result_finished_meanwhile(self):
        """reliability:8 — the queued->cancelled update decides, not the status read before it."""
        job = self.jobs().create("export", self.export_body("jsonl", select=["hn"]))
        service = self.jobs()
        owned = service._owned

        def finished_meanwhile(job_id):
            row = owned(job_id)
            self.run_all()
            return row

        service._owned = finished_meanwhile
        self.assertEqual(service.cancel(job["job_id"])["status"], "succeeded")
        self.download_text(job["job_id"])

    def test_cancelling_a_running_aggregate(self):
        """spec:11 — a cancel made during the aggregate statement is honoured."""
        body = {"query": {"source": "ward_check", "group": ["ward"], "aggregate": [{"fn": "count", "as": "n"}]}}
        job = self.jobs().create("report", body, "csv")
        original = self.adapter.read_session

        @contextmanager
        def cancelled_during(*args, **kwargs):
            with original(*args, **kwargs) as session:
                yield session
            self.adapter.update_job_where(job["job_id"], ("running",), {"cancel_requested": 1})

        self.adapter.read_session = cancelled_during
        try:
            self.run_all()
        finally:
            self.adapter.read_session = original
        self.assertEqual(self.adapter.get_job(job["job_id"])["status"], "cancelled")
        self.assertEqual(list(self.store.root.iterdir()), [])

    def test_shutdown_requeues_interrupted_and_stuck_jobs(self):
        """reliability:5 / spec:15 — no attempt is spent when a statement outlives the shutdown wait."""
        from app.formdev.adapters.sql_query import QueryFailed

        job = self.jobs().create("export", self.export_body("jsonl", select=["hn"]))
        original = self.adapter.read_session

        @contextmanager
        def interrupted(*args, **kwargs):
            self.worker.stop_event.set()  # shutdown began; the statement is then interrupted
            raise QueryFailed("interrupted")
            yield  # pragma: no cover

        self.adapter.read_session = interrupted
        try:
            self.worker.run_once("worker-a")
        finally:
            self.adapter.read_session = original
        row = self.adapter.get_job(job["job_id"])
        self.assertEqual((row["status"], row["attempt"]), ("queued", 0))
        # A thread that never comes back: stop() requeues its job itself.
        self.worker.stop_event.clear()
        with self.adapter.transaction():
            claimed = self.adapter.claim_job(job["job_id"], "stuck-worker", self.clock.now + 60_000, self.clock.now)
        self.worker._active["stuck-worker"] = (self.fd, claimed)
        self.worker.stop(timeout_s=0, interrupt_wait_s=0)
        row = self.adapter.get_job(job["job_id"])
        self.assertEqual((row["status"], row["attempt"], row["lease_owner"]), ("queued", 0, None))


    # Phase 4 review, group D -------------------------------------------------------------------
    def large_form(self):
        import app.formdev.indexing as indexing

        self.fd.indexing.enqueue_reindex = enqueue_reindex(self.adapter, self.clock)
        original = indexing.SYNC_REINDEX_MAX_RECORDS
        indexing.SYNC_REINDEX_MAX_RECORDS = 0
        self.addCleanup(setattr, indexing, "SYNC_REINDEX_MAX_RECORDS", original)

    def reindex_jobs(self, status=None):
        return [row for row in self.adapter.list_jobs(None, 100) if row["kind"] == "reindex" and (status is None or row["status"] == status)]

    def test_a_field_added_during_a_rebuild_is_not_marked_ready_early(self):
        """reliability:0 / regressions:4 — the running job never covered full_name for the records it had passed."""
        self.large_form()
        self.fd.indexing.add_config_field("ward_check", "score", USER)
        original_check = self.worker._check
        calls = {"n": 0}

        def change_midway(*args, **kwargs):
            calls["n"] += 1
            if calls["n"] == 1:
                self.assertEqual(self.fd.indexing.add_config_field("ward_check", "full_name", USER), "building")
            return original_check(*args, **kwargs)

        self.worker._check = change_midway
        self.assertTrue(self.worker.run_once("worker-a"))
        self.worker._check = original_check
        self.assertEqual(self.fd.indexing.indexed_fields("ward_check")["full_name"]["state"], "building", "the first job did not cover it")
        self.assertEqual(self.fd.indexing.indexed_fields("ward_check")["score"]["state"], "ready")
        self.assertEqual(len(self.reindex_jobs("queued")), 1, "the change got a job of its own")
        self.run_all()
        self.assertEqual(self.fd.indexing.indexed_fields("ward_check")["full_name"]["state"], "ready")
        for n in (3, 13):
            found = self.run_query(ADMIN, select=["hn"], filter={"field": "full_name", "op": "eq", "value": f"Patient {n}"}, pagination={"mode": "cursor", "limit": 5})
            self.assertEqual([row["hn"] for row in found["rows"]], [f"HN-{n:04d}"])

    def test_a_failed_rebuild_is_queued_again(self):
        """reliability:6 — building coverage with no job left gets a new job (after a pause when one failed)."""
        self.large_form()
        self.fd.indexing.add_config_field("ward_check", "full_name", USER)
        job = self.reindex_jobs("queued")[0]
        self.adapter.update_job_where(job["job_id"], ("queued",), {"status": "failed", "finished_at": self.clock.now,
                                                                   "error": {"code": "job_abandoned", "message": "x"}})
        self.worker.maintenance(self.fd)
        self.assertEqual(self.reindex_jobs("queued"), [], "not straight after a failure")
        self.clock.now += 11 * 60_000
        self.worker.maintenance(self.fd)
        self.assertEqual(len(self.reindex_jobs("queued")), 1)
        self.run_all()
        self.assertEqual(self.fd.indexing.indexed_fields("ward_check")["full_name"]["state"], "ready")
        self.worker.maintenance(self.fd)
        self.assertEqual(self.reindex_jobs("queued"), [], "nothing left to rebuild")


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
@unittest.skipUnless(MYSQL_READY, "set FORMDEV_MYSQL_TEST_URL to a *_test database")
class MySQLJobContract(JobContract, unittest.TestCase):
    def make_adapter(self):
        return fresh_mysql()

    def tearDown(self):
        super().tearDown()
        self.adapter.close()


for _cls in (SQLiteJobContract, PostgreSQLJobContract, MySQLJobContract):
    for _name in [name for name in dir(QueryContract) if name.startswith("test_")]:
        if _name not in JobContract.__dict__:
            setattr(_cls, _name, None)
del _cls, _name

if __name__ == "__main__":
    unittest.main()
