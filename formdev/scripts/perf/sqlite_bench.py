"""SQLite (standalone / desktop storage) benchmark at 100k records (Phase 4.13).

    python formdev/scripts/perf/sqlite_bench.py --records 100000 --noise 50000 --label sqlite-100k

Creates <tmp>/formdev_perf_<label>_test.db (the name must end in _test), creates and publishes the
same forms through the real repositories on SQLiteAdapter, bulk-inserts the SAME generator output
with executemany (one transaction), ANALYZEs, then runs a subset of the PostgreSQL cases through
QueryEngine.run (eq, range, AND, cursor pages, aggregate) plus one aggregate job, and records
EXPLAIN QUERY PLAN details and index names for each.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import tempfile
import time
from contextlib import contextmanager
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parent))

from bench import MONTH, SECRET, SOURCE, cases, leaf, q  # noqa: E402
from common import (  # noqa: E402
    EXPORTER, PLANS, PRINCIPALS, READER, RESULTS, Generator, ensure_forms, index_rows, percentile, require_test_path, write_json,
)

from app.formdev import services_for  # noqa: E402
from app.formdev.adapters.sql_query import compile_plan  # noqa: E402
from app.formdev.adapters.sqlite import SQLiteAdapter  # noqa: E402
from app.formdev.errors import FormDevError  # noqa: E402
from app.formdev.query import cursor as cursors  # noqa: E402
from app.formdev.query.engine import QueryEngine, QueryRuntime, fingerprints  # noqa: E402
from app.formdev.query.jobs import JobService, JobWorker, ResultStore  # noqa: E402
from app.formdev.query.plan import build_plan, count_plan  # noqa: E402

SUBSET = ("eq_hn", "eq_wbig_p1", "eq_wbig_deep", "dt_month", "and_age_fall", "nofilter_p1", "nofilter_deep", "agg_month_ward")
RECORD_COLUMNS = ("record_id", "form_id", "schema_version", "status", "data", "created_at", "created_by", "updated_at", "updated_by",
                  "sync_id", "version", "subject_id", "ingest_seq", "ingested_at")
LATENCY_MS = 300


def load(adapter: SQLiteAdapter, records: int, noise: int) -> dict[str, Any]:
    services = services_for(adapter)
    ensure_forms(services, with_scratch=False)
    generator = Generator(records, noise)
    conn = adapter.connection
    started = time.perf_counter()
    counts = {"records": 0, "index_rows": 0}
    record_sql = f"INSERT INTO formdev_record ({', '.join(RECORD_COLUMNS)}) VALUES ({', '.join('?' for _ in RECORD_COLUMNS)})"
    index_sql = "INSERT INTO formdev_record_index (record_id, form_id, field_id, value_text, value_num, status, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
    conn.execute("BEGIN IMMEDIATE")
    batch_r: list[tuple] = []
    batch_i: list[tuple] = []
    for record in generator.records():
        batch_r.append(tuple(json.dumps(record["data"], ensure_ascii=False, separators=(",", ":")) if c == "data" else record[c] for c in RECORD_COLUMNS))
        batch_i.extend(index_rows(generator.definitions[record["form_id"]], record))
        if len(batch_r) >= 5000:
            conn.executemany(record_sql, batch_r)
            conn.executemany(index_sql, batch_i)
            counts["records"] += len(batch_r)
            counts["index_rows"] += len(batch_i)
            batch_r.clear()
            batch_i.clear()
    conn.executemany(record_sql, batch_r)
    conn.executemany(index_sql, batch_i)
    counts["records"] += len(batch_r)
    counts["index_rows"] += len(batch_i)
    conn.execute("INSERT INTO formdev_data_version (form_id, version, updated_at) SELECT form_id, max(ingest_seq), 0 FROM formdev_record GROUP BY form_id "
                 "ON CONFLICT (form_id) DO UPDATE SET version = excluded.version")
    conn.execute("COMMIT")
    insert_s = time.perf_counter() - started
    t = time.perf_counter()
    conn.execute("ANALYZE")
    analyze_s = time.perf_counter() - t
    return {**counts, "insert_s": round(insert_s, 2), "rows_per_s": round((counts["records"] + counts["index_rows"]) / insert_s),
            "analyze_s": round(analyze_s, 2), "file_bytes": os.path.getsize(adapter.path)}


def values_for(conn) -> dict[str, Any]:
    one = lambda sql, *p: conn.execute(sql, p).fetchone()  # noqa: E731
    live = one("SELECT count(*) FROM formdev_record WHERE form_id = ? AND status <> 'deleted'", SOURCE)[0]
    pick = lambda offset: one("SELECT subject_id FROM formdev_record WHERE form_id = ? AND status = 'submitted' ORDER BY ingest_seq DESC LIMIT 1 OFFSET ?", SOURCE, offset)[0]  # noqa: E731
    w_big = one("SELECT count(*) FROM formdev_record WHERE form_id = ? AND status <> 'deleted' AND json_extract(data, '$.ward') = 'W_BIG'", SOURCE)[0]
    return {"live": live, "hn_a": pick(live // 3), "hn_b": pick(live // 2), "prefix": "HN00012", "counts": {"w_big": w_big}}


def nth_seq(conn, n: int, ward: str | None) -> int:
    if ward:
        sql = ("SELECT k.ingest_seq FROM formdev_record k WHERE k.form_id = ? AND k.status <> 'deleted' AND EXISTS (SELECT 1 FROM formdev_record_index i"
               " WHERE i.record_id = k.record_id AND i.form_id = ? AND i.status <> 'deleted' AND i.field_id = 'ward' AND i.value_text = ?)"
               " ORDER BY k.ingest_seq DESC LIMIT 1 OFFSET ?")
        return int(conn.execute(sql, (SOURCE, SOURCE, ward, n - 1)).fetchone()[0])
    return int(conn.execute("SELECT ingest_seq FROM formdev_record WHERE form_id = ? AND status <> 'deleted' ORDER BY ingest_seq DESC LIMIT 1 OFFSET ?",
                            (SOURCE, n - 1)).fetchone()[0])


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--records", type=int, default=100_000)
    parser.add_argument("--noise", type=int, default=50_000)
    parser.add_argument("--label", default="sqlite-100k")
    parser.add_argument("--runs", type=int, default=20)
    parser.add_argument("--warmup", type=int, default=3)
    parser.add_argument("--dir", default=tempfile.gettempdir())
    args = parser.parse_args()
    path = require_test_path(Path(args.dir) / f"formdev_perf_{args.label.replace('-', '_')}_test.db")
    for suffix in ("", "-wal", "-shm"):
        Path(str(path) + suffix).unlink(missing_ok=True)
    adapter = SQLiteAdapter(path)
    stats = load(adapter, args.records, args.noise)
    print(json.dumps({"load": stats}), flush=True)
    services = services_for(adapter)
    runtime = QueryRuntime(cursor_secret=SECRET)
    values = values_for(adapter.connection)
    results: dict[str, Any] = {"label": args.label, "sqlite_version": adapter.connection.execute("SELECT sqlite_version()").fetchone()[0],
                               "load": stats, "values": values, "cases": [], "jobs": []}
    for case in cases(values):
        if case["name"] not in SUBSET:
            continue
        engine = QueryEngine(runtime, services, READER)
        body = case["body"]
        if "cursor" in case:
            ward = case["cursor"].get("ward")
            available = values["counts"]["w_big"] if ward == "W_BIG" else values["live"]
            seq = nth_seq(adapter.connection, max(1, min(case["cursor"]["n"], available - 100)), ward)
            _, spec, _ = engine.require_valid(body)
            token = cursors.encode(SECRET, [seq], fingerprints(spec)[1], READER.user_id, runtime.clock_ms())
            body = json.loads(json.dumps(body))
            body["query"]["pagination"]["cursor"] = token
        timings, error, result = [], None, None
        for index in range(args.warmup + args.runs):
            started = time.perf_counter()
            try:
                result = engine.run(body)
            except FormDevError as failure:
                error = {"code": failure.code, "after_ms": round((time.perf_counter() - started) * 1000, 1)}
                break
            if index >= args.warmup:
                timings.append((time.perf_counter() - started) * 1000)
        _, spec, _ = engine.require_valid(body)
        _, query_fp = fingerprints(spec)
        plan = build_plan(spec, engine._keyset(spec, query_fp))
        statements = {"main": compile_plan(plan)}
        if spec["kind"] == "aggregate":
            statements["probe"] = compile_plan(count_plan(spec, runtime.policy["interactive_aggregate_max_rows"]))
        explained = {}
        with adapter.read_session(60_000) as session:
            for key, statement in statements.items():
                explained[key] = session.explain(statement)
                explained[key]["sql"] = statement.sql
        write_json(PLANS / f"{case['name']}-{args.label}.json", {"case": case["name"], "label": args.label, "statements": explained})
        p95 = round(percentile(timings, 0.95), 1) if timings else None
        checks = {"answered": error is None, f"p95_lt_{LATENCY_MS}ms": p95 is not None and p95 < LATENCY_MS,
                  "no_full_scan": not any(e["full_scan"] for e in explained.values())}
        record = {"name": case["name"], "what": case["what"], "p50_ms": round(percentile(timings, 0.5), 1) if timings else None, "p95_ms": p95,
                  "max_ms": round(max(timings), 1) if timings else None, "rows": len(result["rows"]) if result else None, "error": error,
                  "indexes": sorted({i for e in explained.values() for i in e["indexes_used"]}),
                  "plan_details": {k: e["node_types"] for k, e in explained.items()}, "checks": checks,
                  "status": "PASS" if all(checks.values()) else "FAIL"}
        results["cases"].append(record)
        print(f"{record['status']:4} {record['name']:18} p50={record['p50_ms']} p95={p95} rows={record['rows']} err={error} idx={record['indexes']} "
              f"fails={[k for k, v in checks.items() if not v]}", flush=True)
    # Aggregate job over the whole form (the interactive path refuses it above 50,000 records).
    folder = tempfile.mkdtemp(prefix="perf-sqlite-jobs-")
    store = ResultStore(folder)

    @contextmanager
    def connect():
        yield services

    body = {"query": {"source": SOURCE, "group": ["ward"], "aggregate": [{"fn": "count", "as": "n"}]}}
    started = time.perf_counter()
    job = JobService(runtime, services, EXPORTER, store).create("aggregate", body, "json")
    JobWorker(runtime, connect, PRINCIPALS.get, store, threads=0).run_once("perf-sqlite")
    elapsed = time.perf_counter() - started
    row = adapter.get_job(job["job_id"])
    content = json.loads(store.final(job["job_id"], "json").read_text()) if row["status"] == "succeeded" else {"rows": []}
    total = sum(r["n"] for r in content["rows"])
    checks = {"succeeded": row["status"] == "succeeded", "count_matches_live": total == values["live"]}
    results["jobs"].append({"name": "job_agg_ward", "elapsed_s": round(elapsed, 2), "status_job": row["status"], "groups": len(content["rows"]),
                            "total": total, "checks": checks, "status": "PASS" if all(checks.values()) else "FAIL"})
    print(json.dumps(results["jobs"][-1]))
    write_json(RESULTS / f"bench-{args.label}.json", results)
    adapter.close()
    for suffix in ("", "-wal", "-shm"):
        Path(str(path) + suffix).unlink(missing_ok=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
