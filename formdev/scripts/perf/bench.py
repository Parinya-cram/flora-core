"""Benchmark the FormDev query engine on a loaded *_test PostgreSQL database (Phase 4.13).

    python formdev/scripts/perf/bench.py --label 1m [--runs 20 --warmup 3] [--cases eq_hn,dt_month] [--skip-jobs]

Every interactive case goes through QueryEngine.run (validation, catalog, read session, projection)
exactly as the API calls it, with the query cache disabled ("cache": false). Jobs go through
JobService.create + JobWorker.run_once. For every interactive case the exact SQL the engine compiled
is re-run under EXPLAIN (ANALYZE, BUFFERS, SETTINGS, FORMAT JSON) inside adapter.read_session(...,
"interactive") — the same READ ONLY transaction, plan_cache_mode, jit, parallel and work_mem settings
the engine uses (only statement_timeout is raised so a slow plan can still be captured).

Assertions per interactive case (any failure = FAIL, the run keeps going):
  no Seq Scan on formdev_record / formdev_record_index, no external sort / spill, top-node row
  estimate within 10x of actual, deep keyset page buffers <= 3x page 1, p95 below the case threshold,
  and the engine must answer (no timeout / error).
"""
from __future__ import annotations

import argparse
import gc
import json
import resource
import sys
import tempfile
import time
import tracemalloc
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Callable

sys.path.insert(0, str(Path(__file__).resolve().parent))

from common import (  # noqa: E402
    EXPORTER, PLANS, PRINCIPALS, READER, RESULTS, connect, database_url, percentile, pg_services, plan_facts, trim_plan, write_json,
)

from app.formdev.adapters.sql_query import CompiledQuery, compile_plan, relation_lookup  # noqa: E402
from app.formdev.errors import FormDevError  # noqa: E402
from app.formdev.query import cursor as cursors  # noqa: E402
from app.formdev.query.engine import QueryEngine, QueryRuntime, fingerprints  # noqa: E402
from app.formdev.query.jobs import JobService, JobWorker, ResultStore  # noqa: E402
from app.formdev.query.plan import build_plan, count_plan  # noqa: E402

SOURCE = "perf_assessment"
SELECT = ["hn", "ward", "age", "fall_risk", "assessed_at", "score", "$ingested_at"]
RECORD_TABLES = {"formdev_record", "formdev_record_index"}
SECRET = b"perf-cursor-secret"
LATENCY_MS = 300
DEEP_OFFSET_LATENCY_MS = 1000


# Data-dependent parameters ---------------------------------------------------------------------
def probe_values(conn) -> dict[str, Any]:
    one = lambda sql, *p: conn.execute(sql, p).fetchone()  # noqa: E731
    live = one("SELECT count(*) AS n FROM formdev_record WHERE form_id = %s AND status <> 'deleted'", SOURCE)["n"]
    # A subject with a typical number of assessments (selective eq) and a second one for the OR cases.
    hn_a = one("SELECT subject_id AS s FROM formdev_record WHERE form_id = %s AND status = 'submitted' ORDER BY ingest_seq DESC OFFSET %s LIMIT 1",
               SOURCE, live // 3)["s"]
    hn_b = one("SELECT subject_id AS s FROM formdev_record WHERE form_id = %s AND status = 'submitted' ORDER BY ingest_seq DESC OFFSET %s LIMIT 1",
               SOURCE, live // 2)["s"]
    counts = {}
    for name, sql, params in (
        ("hn_a", "SELECT count(*) AS n FROM formdev_record WHERE form_id = %s AND status <> 'deleted' AND subject_id = %s", (SOURCE, hn_a)),
        ("w_big", "SELECT count(*) AS n FROM formdev_record WHERE form_id = %s AND status <> 'deleted' AND data->>'ward' = 'W_BIG'", (SOURCE,)),
        ("w_rare", "SELECT count(*) AS n FROM formdev_record WHERE form_id = %s AND status <> 'deleted' AND data->>'ward' = 'W_RARE'", (SOURCE,)),
    ):
        counts[name] = conn.execute(sql, params).fetchone()["n"]
    return {"live": live, "hn_a": hn_a, "hn_b": hn_b, "prefix": "HN00012", "counts": counts}


def nth_seq(conn, n: int, ward: str | None = None) -> int | None:
    """ingest_seq of the n-th (1-based) live match in the default order (ingest_seq DESC)."""
    if ward:
        sql = ("SELECT k.ingest_seq AS s FROM formdev_record k WHERE k.form_id = %s AND k.status <> 'deleted' AND EXISTS (SELECT 1 FROM formdev_record_index i"
               " WHERE i.record_id = k.record_id AND i.form_id = %s AND i.status <> 'deleted' AND i.field_id = 'ward' AND i.value_text = %s)"
               " ORDER BY k.ingest_seq DESC OFFSET %s LIMIT 1")
        row = conn.execute(sql, (SOURCE, SOURCE, ward, n - 1)).fetchone()
    else:
        row = conn.execute("SELECT ingest_seq AS s FROM formdev_record WHERE form_id = %s AND status <> 'deleted' ORDER BY ingest_seq DESC OFFSET %s LIMIT 1",
                           (SOURCE, n - 1)).fetchone()
    return int(row["s"]) if row else None


# Case catalogue ------------------------------------------------------------------------------------
def q(**query) -> dict[str, Any]:
    query.setdefault("source", SOURCE)
    query.setdefault("cache", False)
    query.setdefault("select", list(SELECT))
    query.setdefault("pagination", {"mode": "cursor", "limit": 50})
    return {"format": "flora.query/1", "query": query}


def leaf(field: str, op: str, value: Any = None) -> dict[str, Any]:
    out = {"field": field, "op": op}
    if value is not None:
        out["value"] = value
    return out


MONTH = ["2025-03-01T00:00:00+07:00", "2025-03-31T23:59:59+07:00"]


def cases(v: dict[str, Any]) -> list[dict[str, Any]]:
    """name, group, body, threshold, optional deep_of (page-1 case) and deep cursor spec."""
    return [
        {"name": "eq_hn", "what": "eq on hn (selective, ~10 matches)", "body": q(filter=leaf("hn", "eq", v["hn_a"]))},
        {"name": "eq_wbig_p1", "what": "eq on ward W_BIG (30%), page 1", "body": q(filter=leaf("ward", "eq", "W_BIG"))},
        {"name": "eq_wbig_deep", "what": "eq on ward W_BIG, keyset page after the 5000th match", "body": q(filter=leaf("ward", "eq", "W_BIG")),
         "deep_of": "eq_wbig_p1", "cursor": {"n": 5000, "ward": "W_BIG"}},
        {"name": "eq_wrare", "what": "eq on ward W_RARE (0.05%, all oldest): LIMIT trap", "body": q(filter=leaf("ward", "eq", "W_RARE"))},
        {"name": "and_age_fall", "what": "AND(age between 30..50, fall_risk eq yes)",
         "body": q(filter={"and": [leaf("age", "between", [30, 50]), leaf("fall_risk", "eq", "yes")]})},
        {"name": "or_index", "what": "OR(hn eq X, ward eq W_RARE): index leaves only",
         "body": q(filter={"or": [leaf("hn", "eq", v["hn_b"]), leaf("ward", "eq", "W_RARE")]})},
        {"name": "or_meta_index", "what": "OR($subject_id eq X, ward eq W_RARE): metadata + index leaf",
         "body": q(filter={"or": [leaf("$subject_id", "eq", v["hn_b"]), leaf("ward", "eq", "W_RARE")]})},
        {"name": "not_fall", "what": "NOT(fall_risk eq no)", "body": q(filter={"not": leaf("fall_risk", "eq", "no")})},
        {"name": "isnull_age", "what": "age is_null (25% missing)", "body": q(filter=leaf("age", "is_null"))},
        {"name": "prefix_hn", "what": "prefix on hn 'HN00012' (~1000 matches)", "body": q(filter=leaf("hn", "prefix", v["prefix"]))},
        {"name": "dt_month", "what": "assessed_at in March 2025 (one month, old)", "body": q(filter=leaf("assessed_at", "between", MONTH))},
        {"name": "nofilter_p1", "what": "no filter, page 1", "body": q()},
        {"name": "nofilter_deep", "what": "no filter, keyset page at the middle of the form", "body": q(), "deep_of": "nofilter_p1",
         "cursor": {"n": max(1, v["live"] // 2)}},
        {"name": "offset0", "what": "ward eq W_BIG, offset 0", "body": q(filter=leaf("ward", "eq", "W_BIG"), pagination={"mode": "offset", "limit": 50, "offset": 0})},
        {"name": "offset10000", "what": "ward eq W_BIG, offset 10000", "body": q(filter=leaf("ward", "eq", "W_BIG"), pagination={"mode": "offset", "limit": 50, "offset": 10000}),
         "threshold": DEEP_OFFSET_LATENCY_MS},
        {"name": "sort_age_off0", "what": "sort by age asc (field sort), offset 0",
         "body": q(sort=[{"field": "age", "dir": "asc"}], pagination={"mode": "offset", "limit": 50, "offset": 0})},
        {"name": "sort_age_off5000", "what": "sort by age asc, offset 5000",
         "body": q(sort=[{"field": "age", "dir": "asc"}], pagination={"mode": "offset", "limit": 50, "offset": 5000}), "threshold": DEEP_OFFSET_LATENCY_MS},
        {"name": "count_capped", "what": "ward eq W_BIG + capped count (cap 10000)", "body": q(filter=leaf("ward", "eq", "W_BIG"), count="capped")},
        {"name": "relation_p1", "what": "perf_with_patient: hn, ward, patient.name; ward eq W05; page of 50",
         "body": q(source="perf_with_patient", select=["hn", "ward", "patient.name"], filter=leaf("ward", "eq", "W05"))},
        {"name": "agg_month_ward", "what": "interactive aggregate: count by ward, one month (probe <= 50000)",
         "body": {"query": {"source": SOURCE, "cache": False, "filter": leaf("assessed_at", "between", MONTH), "group": ["ward"],
                            "aggregate": [{"fn": "count", "as": "n"}]}}},
        {"name": "agg_month_ward_fall", "what": "interactive aggregate: by ward+fall_risk avg(age), one month",
         "body": {"query": {"source": SOURCE, "cache": False, "filter": leaf("assessed_at", "between", MONTH), "group": ["ward", "fall_risk"],
                            "aggregate": [{"fn": "count", "as": "n"}, {"fn": "avg", "field": "age", "as": "avg_age"}]}}},
        {"name": "agg_all_ward", "what": "aggregate over the whole form: interactive must refuse (job)", "expect_error": "full_scan_requires_job",
         "body": {"query": {"source": SOURCE, "cache": False, "group": ["ward"], "aggregate": [{"fn": "count", "as": "n"}]}}},
    ]


# Measurement --------------------------------------------------------------------------------------------
class Bench:
    def __init__(self, conn, label: str, runs: int, warmup: int, explain_timeout_ms: int):
        self.conn = conn
        self.services = pg_services(conn)
        self.runtime = QueryRuntime(cursor_secret=SECRET)
        self.label = label
        self.runs = runs
        self.warmup = warmup
        self.explain_timeout_ms = explain_timeout_ms

    def engine(self, principal=READER) -> QueryEngine:
        return QueryEngine(self.runtime, self.services, principal)

    def with_cursor(self, body: dict[str, Any], seq: int) -> dict[str, Any]:
        engine = self.engine()
        _, spec, _ = engine.require_valid(body)
        _, query_fp = fingerprints(spec)
        token = cursors.encode(SECRET, [seq], query_fp, READER.user_id, self.runtime.clock_ms())
        out = json.loads(json.dumps(body))
        out["query"]["pagination"] = {**out["query"]["pagination"], "cursor": token}
        return out

    def compiled(self, body: dict[str, Any]) -> dict[str, Any]:
        """The statements QueryEngine._run would execute for this body (same code path)."""
        engine = self.engine()
        _, spec, catalog = engine.require_valid(body)
        _, query_fp = fingerprints(spec)
        policy = self.runtime.policy
        out: dict[str, Any] = {"spec": spec, "catalog": catalog}
        if spec["kind"] == "aggregate":
            out["probe"] = compile_plan(count_plan(spec, policy["interactive_aggregate_max_rows"]))
        keyset = engine._keyset(spec, query_fp)
        plan = build_plan(spec, keyset)
        out["plan"] = plan
        out["main"] = compile_plan(plan)
        if spec["kind"] == "list" and spec["count"] == "capped":
            out["count"] = compile_plan(count_plan(spec, policy["count_cap"]))
        return out

    def explain(self, statement: CompiledQuery, purpose: str = "interactive", timeout_ms: int | None = None) -> dict[str, Any]:
        sql = "EXPLAIN (ANALYZE, BUFFERS, SETTINGS, FORMAT JSON) " + statement.sql.replace("?", "%s")
        with self.services.adapter.read_session(timeout_ms or self.explain_timeout_ms, purpose) as session:
            row = session.connection.execute(sql, statement.params, prepare=False).fetchone()
        document = next(iter(row.values()))
        trimmed = trim_plan(document)
        trimmed["sql"] = statement.sql
        trimmed["params"] = [p if not isinstance(p, str) or len(p) < 80 else p[:77] + "..." for p in statement.params]
        return trimmed

    def relation_statement(self, compiled: dict[str, Any]) -> CompiledQuery | None:
        spec, catalog, plan = compiled["spec"], compiled["catalog"], compiled["plan"]
        used = sorted({ref["relation"] for ref in spec["select"] if ref["kind"] == "relation"})
        if not used:
            return None
        relation = catalog.relations[used[0]]
        target = relation["target"]
        with self.services.adapter.read_session(self.explain_timeout_ms, "interactive") as session:
            rows = session.fetch(compiled["main"])[: plan.limit]
        keys = list(dict.fromkeys(row["data"].get(relation["local"]) for row in rows if row["data"].get(relation["local"])))
        return relation_lookup(target.form_id, relation["foreign"], "value_text", keys) if keys else None

    def time_case(self, body: dict[str, Any]) -> dict[str, Any]:
        engine = self.engine()
        timings: list[float] = []
        first: list[float] = []
        result = None
        error = None
        for index in range(self.warmup + self.runs):
            started = time.perf_counter()
            try:
                result = engine.run(body)
            except FormDevError as failure:
                error = {"code": failure.code, "status": failure.status, "after_ms": round((time.perf_counter() - started) * 1000, 1)}
                break
            elapsed = (time.perf_counter() - started) * 1000
            (first if index < self.warmup else timings).append(elapsed)
        out: dict[str, Any] = {"warmup_ms": [round(t, 1) for t in first]}
        if error:
            out["error"] = error
        if timings:
            out.update({"p50_ms": round(percentile(timings, 0.5), 1), "p95_ms": round(percentile(timings, 0.95), 1), "max_ms": round(max(timings), 1),
                        "min_ms": round(min(timings), 1), "runs": len(timings)})
        if result is not None:
            out["rows"] = len(result["rows"])
            out["has_more"] = result.get("has_more")
            out["first_row"] = result["rows"][0].get("$record_id") if result["rows"] else None
            for key in ("total", "total_is_lower_bound", "relation_ambiguous"):
                if key in result:
                    out[key] = result[key]
            if result["rows"] and "patient.name" in result["rows"][0]:
                out["relation_filled"] = sum(1 for row in result["rows"] if row.get("patient.name"))
        return out

    def run_case(self, case: dict[str, Any], pages: dict[str, dict[str, Any]]) -> dict[str, Any]:
        body = case["body"]
        if "cursor" in case:
            ward = case["cursor"].get("ward")
            available = self.values["counts"]["w_big"] if ward == "W_BIG" else self.values["live"]
            seq = nth_seq(self.conn, max(1, min(case["cursor"]["n"], available - 100)), ward)
            body = self.with_cursor(body, seq)
            case = {**case, "cursor_after_seq": seq}
        timing = self.time_case(body)
        record: dict[str, Any] = {"name": case["name"], "what": case["what"], **{k: case[k] for k in ("cursor_after_seq",) if k in case}, **timing}
        checks: dict[str, Any] = {}
        compiled = self.compiled(body)
        statements = {"main": compiled["main"]}
        if "count" in compiled:
            statements["count"] = compiled["count"]
        if "probe" in compiled:
            statements["probe"] = compiled["probe"]
        relation = self.relation_statement(compiled) if compiled["spec"]["kind"] == "list" else None
        if relation is not None:
            statements["relation"] = relation
        expected_error = case.get("expect_error")
        plans: dict[str, Any] = {}
        facts: dict[str, Any] = {}
        for key, statement in statements.items():
            if expected_error and key == "main":
                continue  # refused interactively; the full statement runs as a job below
            try:
                plans[key] = self.explain(statement)
                facts[key] = plan_facts(plans[key])
            except Exception as failure:  # noqa: BLE001 - recorded, not fatal
                facts[key] = {"explain_error": f"{type(failure).__name__}: {failure}"[:300]}
        write_json(PLANS / f"{case['name']}-{self.label}.json", {"case": case["name"], "what": case["what"], "label": self.label, "statements": plans})
        record["plan"] = facts

        # Assertions -----------------------------------------------------------------------------
        threshold = case.get("threshold", LATENCY_MS)
        if expected_error:
            checks["refused_as_expected"] = bool(timing.get("error")) and timing["error"]["code"] == expected_error
            checks["probe_no_seq_scan"] = not (set(facts.get("probe", {}).get("seq_scans", [])) & RECORD_TABLES)
        else:
            checks["answered"] = "error" not in timing
            checks[f"p95_lt_{threshold}ms"] = "p95_ms" in timing and timing["p95_ms"] < threshold
            seq = sorted({rel for f in facts.values() for rel in f.get("seq_scans", []) if rel in RECORD_TABLES})
            checks["no_seq_scan"] = not seq and all("explain_error" not in f for f in facts.values())
            checks["no_external_sort"] = not any(f.get("external_sort") or f.get("spilled") for f in facts.values())
            main = facts.get("main", {})
            checks["top_estimate_within_10x"] = "top_ratio" in main and main["top_ratio"] <= 10
            if "deep_of" in case and case["deep_of"] in pages:
                base = pages[case["deep_of"]]["plan"].get("main", {}).get("buffers")
                deep = main.get("buffers")
                checks["deep_buffers_le_3x_page1"] = base is not None and deep is not None and deep <= 3 * max(base, 1)
                record["deep_vs_page1_buffers"] = [deep, base]
        record["checks"] = checks
        record["status"] = "PASS" if all(checks.values()) else "FAIL"
        return record

    # Jobs ----------------------------------------------------------------------------------------------
    @contextmanager
    def job_services(self):
        yield self.services

    def run_job(self, kind: str, body: dict[str, Any], fmt: str, memory: bool = False) -> dict[str, Any]:
        folder = tempfile.mkdtemp(prefix="perf-jobs-")
        store = ResultStore(folder)
        service = JobService(self.runtime, self.services, EXPORTER, store)
        worker = JobWorker(self.runtime, self.job_services, PRINCIPALS.get, store, threads=0)
        gc.collect()
        rss_before = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
        if memory:
            tracemalloc.start()
        started = time.perf_counter()
        job = service.create(kind, body, fmt)
        created_ms = (time.perf_counter() - started) * 1000
        worker.run_once("perf-worker")
        elapsed = time.perf_counter() - started
        peak = None
        if memory:
            _, peak = tracemalloc.get_traced_memory()
            tracemalloc.stop()
        rss_after = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
        row = self.services.adapter.get_job(job["job_id"])
        out = {"kind": kind, "format": fmt, "status": row["status"], "error": row["error"], "rows": int(row["rows_processed"]),
               "total_estimate": row["total_estimate"], "bytes": int(row["result_bytes"]), "elapsed_s": round(elapsed, 2),
               "create_ms": round(created_ms, 1), "rows_per_s": round(int(row["rows_processed"]) / elapsed) if elapsed else None,
               "maxrss_kb_before": rss_before, "maxrss_kb_after": rss_after}
        if memory:
            out["tracemalloc_peak_mb"] = round(peak / 1e6, 2)
        path = store.final(job["job_id"], fmt)
        if path.exists():
            with open(path, "rb") as handle:
                out["file_lines"] = sum(1 for _ in handle)
            if fmt == "json":
                out["result"] = json.loads(path.read_text(encoding="utf-8"))
            path.unlink()
        return out

    def aggregate_reference(self, by_fall: bool) -> dict[str, Any]:
        """Same aggregate computed directly from formdev_record.data (correctness evidence)."""
        if by_fall:
            sql = ("SELECT data->>'ward' AS ward, data->>'fall_risk' AS fall_risk, count(*) AS n, avg((data->>'age')::numeric) AS avg_age"
                   " FROM formdev_record WHERE form_id = %s AND status <> 'deleted' GROUP BY 1, 2")
        else:
            sql = "SELECT data->>'ward' AS ward, count(*) AS n FROM formdev_record WHERE form_id = %s AND status <> 'deleted' GROUP BY 1"
        rows = self.conn.execute(sql, (SOURCE,)).fetchall()
        return {(r["ward"], r.get("fall_risk")): (int(r["n"]), float(r["avg_age"]) if r.get("avg_age") is not None else None) for r in rows}

    def jobs(self, values: dict[str, Any]) -> list[dict[str, Any]]:
        out = []
        for name, by_fall in (("job_agg_ward", False), ("job_agg_ward_fall_avg_age", True)):
            group = ["ward", "fall_risk"] if by_fall else ["ward"]
            aggregates = [{"fn": "count", "as": "n"}] + ([{"fn": "avg", "field": "age", "as": "avg_age"}] if by_fall else [])
            body = {"query": {"source": SOURCE, "group": group, "aggregate": aggregates}}
            result = self.run_job("aggregate", body, "json")
            reference = self.aggregate_reference(by_fall)
            got = {(r["ward"], r.get("fall_risk")): (r["n"], r.get("avg_age")) for r in (result.get("result") or {}).get("rows", [])}
            mismatches = [k for k in reference if k not in got or got[k][0] != reference[k][0]
                          or (reference[k][1] is not None and (got[k][1] is None or abs(got[k][1] - reference[k][1]) > 1e-6))]
            result.pop("result", None)
            compiled = self.compiled(body)
            try:
                plan = self.explain(compiled["main"], purpose="job", timeout_ms=self.runtime.policy["jobs"]["aggregate_timeout_ms"])
                facts = plan_facts(plan)
                write_json(PLANS / f"{name}-{self.label}.json", {"case": name, "label": self.label, "purpose": "job", "statements": {"main": plan}})
            except Exception as failure:  # noqa: BLE001
                facts = {"explain_error": str(failure)[:300]}
            checks = {"succeeded": result["status"] == "succeeded", "matches_reference": not mismatches and len(got) == len(reference),
                      "within_aggregate_timeout": result["elapsed_s"] * 1000 < self.runtime.policy["jobs"]["aggregate_timeout_ms"]}
            out.append({"name": name, "what": f"aggregate job: group by {'+'.join(group)}", **result, "groups": len(got), "reference_groups": len(reference),
                        "mismatches": mismatches[:5], "plan": {"main": facts}, "checks": checks, "status": "PASS" if all(checks.values()) else "FAIL"})
        # Export: ~100k rows CSV (EXPORTER's default cap is 100000 rows).
        body = {"query": {"source": SOURCE, "select": ["hn", "ward", "age", "fall_risk", "assessed_at", "score", "bmi", "full_name", "remarks"],
                          "pagination": {"mode": "cursor", "limit": 500}, "export": {"format": "csv"}}}
        expected = min(values["live"], self.runtime.policy["export_max_rows"]["default"])
        timed = self.run_job("export", body, "csv")
        traced = self.run_job("export", body, "csv", memory=True)
        batch = self.compiled(body)
        checks = {"succeeded": timed["status"] == "succeeded" and traced["status"] == "succeeded", "rows_expected": timed["rows"] == expected,
                  "file_lines_rows_plus_header": timed.get("file_lines") == expected + 1,
                  "tracemalloc_peak_lt_64mb": traced.get("tracemalloc_peak_mb", 1e9) < 64}
        out.append({"name": "job_export_csv", "what": f"export job, CSV, {expected} rows, 9 columns", **timed, "expected_rows": expected,
                    "tracemalloc_run": {k: traced.get(k) for k in ("elapsed_s", "rows_per_s", "tracemalloc_peak_mb", "maxrss_kb_after")},
                    "checks": checks, "status": "PASS" if all(checks.values()) else "FAIL"})
        del batch
        return out


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--label", required=True)
    parser.add_argument("--runs", type=int, default=20)
    parser.add_argument("--warmup", type=int, default=3)
    parser.add_argument("--cases", default="")
    parser.add_argument("--skip-jobs", action="store_true")
    parser.add_argument("--explain-timeout-ms", type=int, default=120_000)
    args = parser.parse_args()
    conn = connect(database_url())
    bench = Bench(conn, args.label, args.runs, args.warmup, args.explain_timeout_ms)
    values = bench.values = probe_values(conn)
    selected = set(filter(None, args.cases.split(",")))
    server = {r["name"]: r["setting"] for r in conn.execute(
        "SELECT name, setting FROM pg_settings WHERE name IN ('shared_buffers','work_mem','effective_cache_size','random_page_cost',"
        "'max_parallel_workers_per_gather','jit','server_version','maintenance_work_mem','effective_io_concurrency')").fetchall()}
    results: dict[str, Any] = {"label": args.label, "runs": args.runs, "warmup": args.warmup, "values": values, "server": server, "cases": [], "jobs": []}
    pages: dict[str, dict[str, Any]] = {}
    started = time.perf_counter()
    for case in cases(values):
        if selected and case["name"] not in selected and not any(case.get("deep_of") == s for s in selected):
            continue
        t = time.perf_counter()
        record = bench.run_case(case, pages)
        pages[case["name"]] = record
        results["cases"].append(record)
        main = record["plan"].get("main", {})
        print(f"{record['status']:4} {record['name']:22} p50={record.get('p50_ms')} p95={record.get('p95_ms')} rows={record.get('rows')} "
              f"err={record.get('error', {}).get('code') if record.get('error') else ''} idx={main.get('indexes')} buf={main.get('buffers')} "
              f"scanned={main.get('rows_scanned')} est/act={main.get('top_est')}/{main.get('top_act')} "
              f"fails={[k for k, v in record['checks'].items() if not v]} ({time.perf_counter() - t:.1f}s)", flush=True)
        write_json(RESULTS / f"bench-{args.label}.json", results)
    if not args.skip_jobs and not selected:
        for record in bench.jobs(values):
            results["jobs"].append(record)
            print(f"{record['status']:4} {record['name']:26} {record['elapsed_s']}s rows={record['rows']} rows/s={record.get('rows_per_s')} "
                  f"fails={[k for k, v in record['checks'].items() if not v]}", flush=True)
            write_json(RESULTS / f"bench-{args.label}.json", results)
    results["elapsed_s"] = round(time.perf_counter() - started, 1)
    write_json(RESULTS / f"bench-{args.label}.json", results)
    failed = [c["name"] for c in results["cases"] + results["jobs"] if c["status"] != "PASS"]
    print(json.dumps({"label": args.label, "failed": failed, "elapsed_s": results["elapsed_s"]}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
