"""Background jobs (Phase 4.9): Create Job -> Queue -> Worker -> Progress -> Result -> Download.

Kinds: export (list query -> csv/jsonl), search (list query -> jsonl), aggregate (aggregate query -> json),
report (aggregate query -> csv/json), reindex (internal, record index rebuild).

Guarantees
- Leases are fenced: every write a worker makes names (lease_owner, attempt); a worker whose lease
  was taken over writes nothing and stops. Expired leases are reclaimed on every poll.
- Graceful shutdown returns a running job to the queue without spending an attempt.
- Results are written to <job>.<attempt>.part, fsync'ed per batch and renamed on success; a
  checkpoint (last ingest_seq, rows, bytes) lets a retried attempt continue where it stopped.
- Exports read records in ingest order up to the ingest_seq boundary taken when the job started:
  every record that existed then appears exactly once, with its value at read time.
- Owners are re-checked (active, still allowed) when a job is claimed and when it is downloaded.
"""
from __future__ import annotations

import csv
import hashlib
import io
import json
import logging
import os
import shutil
import threading
import uuid
from contextlib import AbstractContextManager
from decimal import Decimal
from pathlib import Path
from typing import Any, Callable, Iterator

from ..adapters.sql_query import QueryFailed, QueryTimeout, compile_plan
from ..errors import FormDevError
from .access import Principal
from .catalog import SourceCatalog
from .engine import QueryEngine, QueryRuntime, fingerprints
from .plan import Leaf, Node, OrderKey, build_plan, count_plan

LOG = logging.getLogger("formdev.jobs")
KINDS = {"export": ("list", ("csv", "jsonl")), "search": ("list", ("jsonl",)), "aggregate": ("aggregate", ("json",)),
         "report": ("aggregate", ("csv", "json"))}
EXTENSIONS = {"csv": "csv", "jsonl": "jsonl", "json": "json"}
MEDIA_TYPES = {"csv": "text/csv; charset=utf-8", "jsonl": "application/x-ndjson", "json": "application/json"}
FORMULA_PREFIXES = ("=", "+", "-", "@", "\t", "\r")
TERMINAL = ("succeeded", "failed", "cancelled", "expired")


class LeaseLost(Exception):
    """Another worker owns the job now; stop without touching it."""


class Shutdown(Exception):
    """The process is stopping; give the job back to the queue."""


def public_job(row: dict[str, Any]) -> dict[str, Any]:
    total = row.get("total_estimate")
    progress = 1.0 if row["status"] == "succeeded" else (min(0.99, row["rows_processed"] / total) if total else None)
    return {key: row.get(key) for key in ("job_id", "kind", "status", "format", "rows_processed", "total_estimate", "result_bytes",
                                          "error", "created_at", "started_at", "finished_at", "expires_at", "attempt")} | {"progress": progress}


# Result files -----------------------------------------------------------------------------
class ResultStore:
    def __init__(self, root: str | Path):
        self.root = Path(root)
        self.root.mkdir(parents=True, exist_ok=True)
        os.chmod(self.root, 0o700)

    def part(self, job_id: str, attempt: int) -> Path:
        return self.root / f"{uuid.UUID(job_id)}.{int(attempt)}.part"

    def final(self, job_id: str, fmt: str) -> Path:
        return self.root / f"{uuid.UUID(job_id)}.{EXTENSIONS[fmt]}"

    def open_part(self, job_id: str, attempt: int, resume_from: Path | None, keep_bytes: int) -> io.BufferedRandom:
        path = self.part(job_id, attempt)
        if resume_from is not None and resume_from.exists() and resume_from != path:
            os.replace(resume_from, path)
        if not path.exists():
            os.close(os.open(path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600))
        handle = open(path, "r+b")
        handle.truncate(keep_bytes)
        handle.seek(keep_bytes)
        return handle

    def finish(self, job_id: str, attempt: int, fmt: str) -> tuple[int, str]:
        source, target = self.part(job_id, attempt), self.final(job_id, fmt)
        digest = hashlib.sha256()
        with open(source, "rb") as handle:
            for chunk in iter(lambda: handle.read(1 << 20), b""):
                digest.update(chunk)
        os.replace(source, target)
        return target.stat().st_size, digest.hexdigest()

    def remove(self, job_id: str) -> None:
        for path in self.root.glob(f"{uuid.UUID(job_id)}.*"):
            path.unlink(missing_ok=True)

    def existing_part(self, job_id: str) -> Path | None:
        parts = sorted(self.root.glob(f"{uuid.UUID(job_id)}.*.part"))
        return parts[-1] if parts else None

    def sweep(self, keep: set[str]) -> int:
        removed = 0
        for path in self.root.iterdir():
            job_id = path.name.split(".", 1)[0]
            if job_id not in keep:
                path.unlink(missing_ok=True)
                removed += 1
        return removed

    def free_bytes(self) -> int:
        return shutil.disk_usage(self.root).free


# Serialization ------------------------------------------------------------------------------
def _cell(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, float):
        text = format(Decimal(repr(value)), "f")
        return text[:-2] if text.endswith(".0") else text
    if isinstance(value, int):
        return str(value)
    if isinstance(value, list):
        value = "|".join(str(item).replace("\\", "\\\\").replace("|", "\\|") for item in value)
    text = str(value)
    # Spreadsheet formula injection: neutralize cells a spreadsheet would evaluate.
    return "'" + text if text.startswith(FORMULA_PREFIXES) else text


def csv_lines(rows: list[dict[str, Any]], columns: list[str]) -> bytes:
    buffer = io.StringIO()
    writer = csv.writer(buffer, lineterminator="\r\n")
    for row in rows:
        writer.writerow([_cell(row.get(column)) for column in columns])
    return buffer.getvalue().encode("utf-8")


def csv_header(columns: list[str], labels: list[str] | None) -> bytes:
    buffer = io.StringIO()
    writer = csv.writer(buffer, lineterminator="\r\n")
    writer.writerow(columns)
    if labels:
        writer.writerow(labels)
    return "﻿".encode("utf-8") + buffer.getvalue().encode("utf-8")


# Service ---------------------------------------------------------------------------------------
class JobService:
    """Request-side job operations (create/list/get/cancel/download) for one principal."""

    def __init__(self, runtime: QueryRuntime, services: Any, principal: Principal, store: ResultStore):
        self.runtime = runtime
        self.services = services
        self.adapter = services.adapter
        self.principal = principal
        self.store = store
        self.engine = QueryEngine(runtime, services, principal)

    def create(self, kind: str, body: Any, fmt: str | None = None) -> dict[str, Any]:
        if kind not in KINDS:
            raise FormDevError("invalid_job", f"kind is one of {', '.join(KINDS)}")
        query_kind, formats = KINDS[kind]
        _, spec, catalog = self.engine.require_valid(body)
        if spec["kind"] != query_kind:
            raise FormDevError("invalid_job", f"{kind} jobs need a {'list' if query_kind == 'list' else 'grouped or aggregate'} query")
        export = spec["export"] or {}
        fmt = fmt or export.get("format") or formats[0]
        if fmt not in formats:
            raise FormDevError("invalid_job", f"{kind} jobs write {', '.join(formats)}")
        if kind in ("export", "report") and not catalog.can_export(self.principal):
            self.engine.audit("denied", spec, catalog, None, None)
            raise FormDevError("export_forbidden", "You may not export this source", 403)
        hidden = [ref["name"] for ref in spec["select"] if ref["kind"] == "field" and not catalog.can_export_field(self.principal, ref["field"])]
        if kind == "export" and hidden:
            raise FormDevError("field_not_exportable", f"Excluded from export by the form's display policy or field permissions: {', '.join(hidden)}", 422, {"fields": hidden})
        policy = self.runtime.policy["jobs"]
        now = self.runtime.clock_ms()
        job_id = str(uuid.uuid4())
        shape_fp, _ = fingerprints(spec)
        with self.adapter.transaction():
            self.adapter.lock_job_quota(self.principal.user_id)
            if self.adapter.count_open_jobs(self.principal.user_id) >= policy["per_user_open"]:
                raise FormDevError("job_queue_full", f"You already have {policy['per_user_open']} jobs waiting or running", 429, {"retry_after": 30})
            if self.adapter.count_open_jobs(None) >= policy["global_open"]:
                raise FormDevError("job_queue_full", "The job queue is full; try again later", 429, {"retry_after": 60})
            self.adapter.insert_job({
                "job_id": job_id, "kind": kind, "status": "queued", "query": body, "format": fmt,
                "owner_user_id": self.principal.user_id, "owner": self.principal.username, "rows_processed": 0, "total_estimate": None,
                "checkpoint": None, "result_bytes": 0, "result_sha256": None, "error": None, "attempt": 0,
                "max_attempts": policy["max_attempts"], "lease_owner": None, "lease_expires_at": None, "cancel_requested": 0,
                "created_at": now, "started_at": None, "heartbeat_at": None, "finished_at": None, "expires_at": None,
            })
            self.engine.audit("job_create", spec, catalog, shape_fp, None, job_id=job_id, required=True)
        return public_job(self.adapter.get_job(job_id))

    def _owned(self, job_id: str) -> dict[str, Any]:
        try:
            uuid.UUID(job_id)
        except (ValueError, TypeError):
            raise FormDevError("job_not_found", "Job not found", 404) from None
        row = self.adapter.get_job(job_id)
        if row is None or row["kind"] == "reindex" or (row["owner_user_id"] != self.principal.user_id and not self.principal.is_admin):
            raise FormDevError("job_not_found", "Job not found", 404)
        return row

    def list(self) -> list[dict[str, Any]]:
        rows = self.adapter.list_jobs(None if self.principal.is_admin else self.principal.user_id)
        return [public_job(row) for row in rows if row["kind"] != "reindex"]

    def get(self, job_id: str) -> dict[str, Any]:
        return public_job(self._owned(job_id))

    def cancel(self, job_id: str) -> dict[str, Any]:
        row = self._owned(job_id)
        now = self.runtime.clock_ms()
        with self.adapter.transaction():
            if not self.adapter.update_job_where(job_id, ("queued",), {"status": "cancelled", "finished_at": now}):
                self.adapter.update_job_where(job_id, ("running",), {"cancel_requested": 1})
            self.engine.audit("job_cancel", None, None, None, None, job_id=job_id)
        if row["status"] == "queued":
            self.store.remove(job_id)
        return public_job(self.adapter.get_job(job_id))

    def download(self, job_id: str) -> tuple[Iterator[bytes], str, str, int]:
        row = self._owned(job_id)
        if row["status"] != "succeeded":
            raise FormDevError("job_not_ready" if row["status"] in ("queued", "running") else "job_expired",
                               f"The job is {row['status']}", 409 if row["status"] in ("queued", "running") else 410)
        path = self.store.final(job_id, row["format"])
        if not path.exists() or path.stat().st_size != int(row["result_bytes"]):
            self.adapter.update_job_where(job_id, ("succeeded",), {"status": "expired"})
            raise FormDevError("job_expired", "The result file is no longer available; run the job again", 410)
        self.engine.audit("job_download", None, None, None, int(row["rows_processed"]), job_id=job_id, sha256=row["result_sha256"], required=True)

        def chunks() -> Iterator[bytes]:
            with open(path, "rb") as handle:
                yield from iter(lambda: handle.read(1 << 16), b"")

        name = f"formdev-{row['kind']}-{job_id[:8]}.{EXTENSIONS[row['format']]}"
        return chunks(), MEDIA_TYPES[row["format"]], name, int(row["result_bytes"])


# Worker ---------------------------------------------------------------------------------------
class JobWorker:
    """In-process worker threads. ``connect`` yields FormDevServices on a storage connection
    reserved for jobs; ``load_principal(user_id)`` returns the owner's current entitlements or None."""

    def __init__(self, runtime: QueryRuntime, connect: Callable[[], AbstractContextManager[Any]],
                 load_principal: Callable[[Any], Principal | None], store: ResultStore, threads: int | None = None):
        self.runtime = runtime
        self.connect = connect
        self.load_principal = load_principal
        self.store = store
        self.policy = runtime.policy["jobs"]
        self.threads = threads if threads is not None else self.policy["workers"]
        self.stop_event = threading.Event()
        self._threads: list[threading.Thread] = []
        self._polls = 0

    # Lifecycle ------------------------------------------------------------------------------
    def start(self) -> None:
        self.stop_event.clear()
        for number in range(self.threads):
            thread = threading.Thread(target=self._loop, name=f"formdev-job-{number}", daemon=True)
            thread.start()
            self._threads.append(thread)

    def stop(self, timeout_s: float = 5.0) -> None:
        self.stop_event.set()
        for thread in self._threads:
            thread.join(timeout_s)
        self._threads = []

    def _loop(self) -> None:
        owner = f"{os.getpid()}:{threading.current_thread().name}:{uuid.uuid4().hex[:8]}"
        while not self.stop_event.is_set():
            try:
                worked = self.run_once(owner)
            except Exception:  # noqa: BLE001 - a worker thread must never die
                LOG.exception("formdev job worker iteration failed")
                worked = False
            if not worked:
                self.stop_event.wait(self.policy["poll_ms"] / 1000)

    # One poll ---------------------------------------------------------------------------------
    def maintenance(self, services: Any) -> None:
        now = self.runtime.clock_ms()
        adapter = services.adapter
        with adapter.transaction():
            adapter.fail_exhausted_jobs(now)
            expired = adapter.expire_jobs(now)
        for job_id in expired:
            self.store.remove(job_id)
        self.store.sweep(adapter.job_ids_with_files())

    def run_once(self, owner: str) -> bool:
        """Claim and run at most one job. Returns True when a job was processed."""
        with self.connect() as services:
            self._polls += 1
            if self._polls % 30 == 1:
                self.maintenance(services)
            now = self.runtime.clock_ms()
            job = None
            for job_id in services.adapter.claimable_jobs(now):
                with services.adapter.transaction():
                    job = services.adapter.claim_job(job_id, owner, now + self.policy["lease_ms"], now)
                if job:
                    break
            if job is None:
                return False
            self._process(services, job, owner)
            return True

    def _fenced(self, services: Any, job: dict[str, Any], owner: str, changes: dict[str, Any]) -> None:
        with services.adapter.transaction():
            if not services.adapter.update_job_fenced(job["job_id"], owner, job["attempt"], changes):
                raise LeaseLost()

    def _process(self, services: Any, job: dict[str, Any], owner: str) -> None:
        now = self.runtime.clock_ms
        try:
            if job["kind"] == "reindex":
                result = self._reindex(services, job, owner)
            else:
                principal = self.load_principal(job["owner_user_id"])
                if principal is None:
                    raise FormDevError("owner_inactive", "The job owner is no longer active")
                engine = QueryEngine(self.runtime, services, principal)
                _, spec, catalog = engine.require_valid(job["query"])
                if job["kind"] in ("export", "report") and not catalog.can_export(principal):
                    raise FormDevError("export_forbidden", "The job owner may no longer export this source", 403)
                result = self._export(services, engine, spec, catalog, job, owner) if job["kind"] in ("export", "search") \
                    else self._aggregate(services, engine, spec, catalog, job, owner)
            self._fenced(services, job, owner, {"status": "succeeded", "finished_at": now(), "lease_owner": None, "error": None,
                                                 "expires_at": now() + self.policy["result_ttl_ms"], **result})
        except LeaseLost:
            LOG.warning("formdev job %s: lease lost, stopping", job["job_id"])
        except Shutdown:
            with services.adapter.transaction():
                services.adapter.update_job_fenced(job["job_id"], owner, job["attempt"], {"status": "queued", "lease_owner": None,
                                                                                          "lease_expires_at": None, "attempt": job["attempt"] - 1})
        except _Cancelled:
            self.store.remove(job["job_id"])
            self._try_finish(services, job, owner, {"status": "cancelled", "finished_at": now(), "lease_owner": None})
        except (FormDevError, QueryTimeout) as error:
            code = error.code if isinstance(error, FormDevError) else "query_timeout"
            message = error.message if isinstance(error, FormDevError) else "A batch took longer than its time budget"
            self.store.remove(job["job_id"])
            self._try_finish(services, job, owner, {"status": "failed", "finished_at": now(), "lease_owner": None,
                                                     "error": {"code": code, "message": message}})
        except Exception as error:  # noqa: BLE001 - infrastructure problem: retry while attempts remain
            code = error.code if isinstance(error, QueryFailed) else type(error).__name__
            LOG.error("formdev job %s attempt %s failed: %s", job["job_id"], job["attempt"], code)
            final = job["attempt"] >= job["max_attempts"]
            self._try_finish(services, job, owner, {"status": "failed" if final else "queued", "lease_owner": None, "lease_expires_at": None,
                                                     "finished_at": now() if final else None,
                                                     "error": {"code": "job_error", "message": "The job failed; it will be retried" if not final else "The job failed"}})

    def _try_finish(self, services: Any, job: dict[str, Any], owner: str, changes: dict[str, Any]) -> None:
        try:
            self._fenced(services, job, owner, changes)
        except LeaseLost:
            pass

    def _check(self, services: Any, job: dict[str, Any], owner: str, checkpoint: dict[str, Any], rows: int, extend_ms: int | None = None) -> None:
        current = services.adapter.get_job(job["job_id"])
        if current is None or current["lease_owner"] != owner or current["attempt"] != job["attempt"]:
            raise LeaseLost()
        if current["cancel_requested"]:
            raise _Cancelled()
        if self.stop_event.is_set():
            raise Shutdown()
        now = self.runtime.clock_ms()
        if now - int(current["started_at"] or now) > self.policy["max_runtime_ms"]:
            raise FormDevError("job_too_long", "The job ran longer than allowed")
        self._fenced(services, job, owner, {"checkpoint": checkpoint, "rows_processed": rows, "heartbeat_at": now,
                                             "lease_expires_at": now + max(self.policy["lease_ms"], extend_ms or 0)})

    # Kinds ---------------------------------------------------------------------------------------
    def _export(self, services: Any, engine: QueryEngine, spec: dict[str, Any], catalog: SourceCatalog, job: dict[str, Any], owner: str) -> dict[str, Any]:
        policy = self.policy
        checkpoint = job.get("checkpoint") or {}
        if checkpoint and checkpoint.get("bytes") and self.store.existing_part(job["job_id"]) is None:
            # The partial file of the previous attempt is gone: restart this export from the beginning.
            checkpoint = {**checkpoint, "last_seq": None, "rows": 0, "bytes": 0}
        if not checkpoint:
            with services.adapter.read_session(policy["batch_timeout_ms"], "job") as session:
                boundary = session.data_versions([catalog.form_id])[catalog.form_id]
                total = int(session.fetch(compile_plan(count_plan(spec, 10_000_000)))[0]["total"])
            checkpoint = {"boundary": boundary, "last_seq": None, "rows": 0, "bytes": 0}
            self._fenced(services, job, owner, {"checkpoint": checkpoint, "total_estimate": total})
        fmt = job["format"]
        max_rows = (spec["export"] or {}).get("max_rows") or self.runtime.policy["export_max_rows"]["default"]
        columns = ["$record_id"] + [ref["output"] for ref in spec["select"]]
        handle = self.store.open_part(job["job_id"], job["attempt"], self.store.existing_part(job["job_id"]), checkpoint["bytes"])
        try:
            if checkpoint["bytes"] == 0 and fmt == "csv":
                labels = None
                if (spec["export"] or {}).get("headers") == "labels":
                    labels = ["record_id"] + [catalog.fields.get(ref.get("field") or "", {}).get("label") or ref["output"] for ref in spec["select"]]
                checkpoint["bytes"] += handle.write(csv_header(columns, labels))
            batch_where = Leaf("meta", "ingest_seq", "lte", (checkpoint["boundary"],))
            while checkpoint["rows"] < max_rows:
                plan = build_plan({**spec, "pagination": {"mode": "cursor", "limit": min(policy["batch_rows"], max_rows - checkpoint["rows"]), "offset": 0}})
                plan.order = OrderKey("meta", "ingest_seq", "asc", unique=True)
                plan.where = Node("and", (plan.where, batch_where)) if plan.where is not None else batch_where
                plan.keyset = (checkpoint["last_seq"],) if checkpoint["last_seq"] is not None else None
                plan.meta_columns = tuple(dict.fromkeys((*plan.meta_columns, "ingest_seq")))
                with services.adapter.read_session(policy["batch_timeout_ms"], "job") as session:
                    rows = session.fetch(compile_plan(plan))
                    relations = engine._relations(session, spec, catalog, rows[: plan.limit])
                page = engine._project(spec, catalog, plan, rows, relations, "")
                if not page["rows"]:
                    break
                if fmt == "csv":
                    chunk = csv_lines(page["rows"], columns)
                else:
                    chunk = "".join(json.dumps(row, ensure_ascii=False, default=str) + "\n" for row in page["rows"]).encode("utf-8")
                if checkpoint["bytes"] + len(chunk) > policy["max_result_bytes"]:
                    raise FormDevError("result_too_large", "The export exceeds the maximum result size; narrow the query")
                if self.store.free_bytes() < len(chunk) * 4 + (64 << 20):
                    raise FormDevError("disk_full", "Not enough disk space for the export")
                checkpoint["bytes"] += handle.write(chunk)
                handle.flush()
                os.fsync(handle.fileno())
                checkpoint["rows"] += len(page["rows"])
                checkpoint["last_seq"] = int(rows[: plan.limit][-1]["ingest_seq"])
                self._check(services, job, owner, checkpoint, checkpoint["rows"])
                if not page["has_more"]:
                    break
        finally:
            handle.close()
        size, digest = self.store.finish(job["job_id"], job["attempt"], fmt)
        return {"rows_processed": checkpoint["rows"], "result_bytes": size, "result_sha256": digest, "checkpoint": checkpoint}

    def _aggregate(self, services: Any, engine: QueryEngine, spec: dict[str, Any], catalog: SourceCatalog, job: dict[str, Any], owner: str) -> dict[str, Any]:
        budget = self.policy["aggregate_timeout_ms"]
        self._check(services, job, owner, {"phase": "aggregate"}, 0, extend_ms=budget + 60_000)
        plan = build_plan(spec)
        with services.adapter.read_session(budget, "job") as session:
            rows = session.fetch(compile_plan(plan))
        result = engine._aggregate_rows(spec, catalog, plan, rows)
        names = [key["name"] for key in spec["group"]] + [agg["as"] for agg in spec["aggregate"]]
        if job["format"] == "csv":
            content = csv_header(names, None) + csv_lines(result["rows"], names)
        else:
            content = json.dumps({"rows": result["rows"], "truncated": result["truncated"]}, ensure_ascii=False, default=str).encode("utf-8")
        handle = self.store.open_part(job["job_id"], job["attempt"], None, 0)
        try:
            handle.write(content)
            handle.flush()
            os.fsync(handle.fileno())
        finally:
            handle.close()
        size, digest = self.store.finish(job["job_id"], job["attempt"], job["format"])
        return {"rows_processed": len(result["rows"]), "result_bytes": size, "result_sha256": digest}

    def _reindex(self, services: Any, job: dict[str, Any], owner: str) -> dict[str, Any]:
        form_id = (job.get("query") or {}).get("form_id")
        checkpoint = job.get("checkpoint") or {"after": None, "rows": 0}
        if not checkpoint.get("total"):
            checkpoint["total"] = services.adapter.count_records(form_id)
            self._fenced(services, job, owner, {"total_estimate": checkpoint["total"], "checkpoint": checkpoint})
        while True:
            after = services.indexing.reindex_batch(form_id, checkpoint["after"], self.policy["batch_rows"])
            checkpoint["rows"] = min(checkpoint["total"], checkpoint["rows"] + self.policy["batch_rows"])
            checkpoint["after"] = after
            if after is None:
                break
            self._check(services, job, owner, checkpoint, checkpoint["rows"])
        services.indexing.finish(form_id)
        return {"rows_processed": checkpoint["total"], "result_bytes": 0, "result_sha256": None, "checkpoint": checkpoint}


class _Cancelled(Exception):
    pass


def enqueue_reindex(adapter: Any, clock_ms: Callable[[], int], max_attempts: int = 5) -> Callable[[str, str], None]:
    """Hook for IndexMaintenance: queue a reindex job (deduplicated per form)."""

    def enqueue(form_id: str, user: str) -> None:
        for row in adapter.list_jobs(None, 200):
            if row["kind"] == "reindex" and row["status"] in ("queued", "running") and row["owner"] == f"reindex:{form_id}":
                return
        now = clock_ms()
        adapter.insert_job({
            "job_id": str(uuid.uuid4()), "kind": "reindex", "status": "queued", "query": {"form_id": form_id}, "format": "json",
            "owner_user_id": None, "owner": f"reindex:{form_id}", "rows_processed": 0, "total_estimate": None, "checkpoint": None,
            "result_bytes": 0, "result_sha256": None, "error": None, "attempt": 0, "max_attempts": max_attempts, "lease_owner": None,
            "lease_expires_at": None, "cancel_requested": 0, "created_at": now, "started_at": None, "heartbeat_at": None,
            "finished_at": None, "expires_at": None,
        })

    return enqueue
