"""Render the perf result JSON files as Markdown tables (Phase 4.13).

    python formdev/scripts/perf/report.py > formdev/docs/perf/tables.md

Reads formdev/docs/perf/results/{load,churn,bench}-*.json. No database access.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
RESULTS = HERE.parents[1] / "docs" / "perf" / "results"
ORDER = ["100k", "1m", "1m-churn"]


def load(name: str) -> dict | None:
    path = RESULTS / name
    return json.loads(path.read_text()) if path.exists() else None


def mb(value) -> str:
    return f"{value / 1e6:,.1f} MB" if isinstance(value, (int, float)) else "-"


def fmt(value, digits: int = 1) -> str:
    if value is None:
        return "-"
    if isinstance(value, float):
        return f"{value:,.{digits}f}"
    if isinstance(value, int):
        return f"{value:,}"
    return str(value)


def load_table() -> list[str]:
    out = ["| Dataset | Records (all forms) | perf_assessment | Index rows | COPY s | COPY rows/s | Index rebuild s | VACUUM ANALYZE s | Total s | WAL | DB size | Generator check |",
           "|---|---|---|---|---|---|---|---|---|---|---|---|"]
    for label in ("100k", "1m"):
        data = load(f"load-{label}.json")
        if not data:
            continue
        if data.get("aborted"):
            out.append(f"| {label} | aborted: {data['aborted']} |||||||||||")
            continue
        t = data["timings_s"]
        build = sum(v for v in t["index_build"].values())
        v = data["validation"]
        out.append(f"| {label} | {fmt(data['counts']['records'])} | {fmt(data['counts']['by_form']['perf_assessment'])} | {fmt(data['counts']['index_rows'])} | "
                   f"{t['copy']} | {fmt(data['copy_rows_per_s']['all_rows'])} | {build:.1f} | {t['vacuum_analyze']} | {t['total']} | "
                   f"{mb(data['wal_bytes']['total'])} | {mb(data['sizes']['database'])} | {v['sampled']} via RecordRepository.create, {v['mismatches']} mismatches |")
    return out


def size_table() -> list[str]:
    out = ["| Dataset | Relation | Heap | Indexes (total) | Per index |", "|---|---|---|---|---|"]
    for label in ("100k", "1m"):
        data = load(f"load-{label}.json")
        if not data or data.get("aborted"):
            continue
        for table in ("formdev_record", "formdev_record_index"):
            s = data["sizes"][table]
            per = ", ".join(f"{k} {mb(v)}" for k, v in s["per_index"].items())
            out.append(f"| {label} | {table} | {mb(s['heap'])} | {mb(s['indexes'])} | {per} |")
    return out


def case_table(label: str) -> list[str]:
    data = load(f"bench-{label}.json")
    if not data:
        return [f"_no results for {label}_"]
    out = [f"Runs: {data['warmup']} warm-up + {data['runs']} measured per case, end-to-end QueryEngine.run (ms). "
           f"Live perf_assessment records: {fmt(data['values']['live'])}.", "",
           "| Case | Query | p50 | p95 | max | Rows | Rows scanned | Buffers (main) | Heap fetches | SQL exec ms (EXPLAIN) | Indexes | est/act (top) | Failed checks | Result |",
           "|---|---|---|---|---|---|---|---|---|---|---|---|---|---|"]
    for case in data["cases"]:
        main = case["plan"].get("main") or case["plan"].get("probe") or {}
        failed = [k for k, v in case["checks"].items() if not v]
        err = f" ({case['error']['code']} after {case['error']['after_ms']} ms)" if case.get("error") else ""
        out.append(
            f"| `{case['name']}` | {case['what']} | {fmt(case.get('p50_ms'))} | {fmt(case.get('p95_ms'))} | {fmt(case.get('max_ms'))} | "
            f"{fmt(case.get('rows'))}{err} | {fmt(main.get('rows_scanned'))} | {fmt(main.get('buffers'))} | {fmt(main.get('heap_fetches'))} | "
            f"{fmt(main.get('execution_ms'), 2)} | {', '.join(main.get('indexes', [])) or '-'} | {fmt(main.get('top_est'), 0)}/{fmt(main.get('top_act'), 0)} | "
            f"{', '.join(failed) or '-'} | **{case['status']}** |")
    return out


def job_table() -> list[str]:
    out = ["| Dataset | Job | Status | Rows | Elapsed s | Rows/s | Result bytes | tracemalloc peak | ru_maxrss after | Failed checks | Result |",
           "|---|---|---|---|---|---|---|---|---|---|---|"]
    for label in ORDER:
        data = load(f"bench-{label}.json")
        if not data:
            continue
        for job in data.get("jobs", []):
            failed = [k for k, v in job["checks"].items() if not v]
            peak = (job.get("tracemalloc_run") or {}).get("tracemalloc_peak_mb")
            out.append(f"| {label} | `{job['name']}` | {job['status'] if 'status' in job else '-'} / job {job.get('kind', '')} | {fmt(job['rows'])} | {job['elapsed_s']} | "
                       f"{fmt(job.get('rows_per_s'))} | {fmt(job.get('bytes'))} | {fmt(peak, 2) + ' MB' if peak is not None else '-'} | "
                       f"{fmt(job.get('maxrss_kb_after'))} KB | {', '.join(failed) or '-'} | **{job['status']}** |")
    return out


def sqlite_table() -> list[str]:
    data = load("bench-sqlite-100k.json")
    if not data:
        return ["_no SQLite results_"]
    load_stats = data["load"]
    out = [f"SQLite {data['sqlite_version']}, file database (WAL), {fmt(load_stats['records'])} records / {fmt(load_stats['index_rows'])} index rows "
           f"inserted with executemany in {load_stats['insert_s']} s ({fmt(load_stats['rows_per_s'])} rows/s), file {mb(load_stats['file_bytes'])}.", "",
           "| Case | p50 | p95 | max | Rows | Indexes (EXPLAIN QUERY PLAN) | Plan | Failed checks | Result |", "|---|---|---|---|---|---|---|---|---|"]
    for case in data["cases"]:
        failed = [k for k, v in case["checks"].items() if not v]
        err = f" ({case['error']['code']} after {case['error']['after_ms']} ms)" if case.get("error") else ""
        plan = "; ".join(case["plan_details"]["main"])
        out.append(f"| `{case['name']}` | {fmt(case['p50_ms'])} | {fmt(case['p95_ms'])} | {fmt(case['max_ms'])} | {fmt(case['rows'])}{err} | "
                   f"{', '.join(case['indexes'])} | {plan} | {', '.join(failed) or '-'} | **{case['status']}** |")
    for job in data["jobs"]:
        out.append(f"| `{job['name']}` (job) | {job['elapsed_s']} s | | | {job['groups']} groups, total {fmt(job['total'])} | | | "
                   f"{', '.join(k for k, v in job['checks'].items() if not v) or '-'} | **{job['status']}** |")
    return out


def summary_table() -> list[str]:
    labels = [label for label in ORDER if load(f"bench-{label}.json")]
    rows: dict[str, dict[str, str]] = {}
    for label in labels:
        data = load(f"bench-{label}.json")
        for case in data["cases"] + data.get("jobs", []):
            rows.setdefault(case["name"], {})[label] = case["status"]
    sqlite = load("bench-sqlite-100k.json")
    if sqlite:
        labels.append("sqlite-100k")
        for case in sqlite["cases"] + sqlite["jobs"]:
            rows.setdefault(case["name"], {})["sqlite-100k"] = case["status"]
    out = ["| Case | " + " | ".join(labels) + " |", "|---|" + "---|" * len(labels)]
    for name, by_label in rows.items():
        out.append(f"| `{name}` | " + " | ".join(by_label.get(label, "n/a") for label in labels) + " |")
    return out


def main() -> int:
    sections = [("Summary (PASS/FAIL per case per dataset)", summary_table()), ("Load", load_table()), ("Table and index sizes", size_table())]
    for label in ORDER:
        sections.append((f"PostgreSQL interactive cases: {label}", case_table(label)))
    sections += [("Jobs", job_table()), ("SQLite 100k", sqlite_table())]
    for title, lines in sections:
        print(f"### {title}\n")
        print("\n".join(lines))
        print()
    return 0


if __name__ == "__main__":
    sys.exit(main())
