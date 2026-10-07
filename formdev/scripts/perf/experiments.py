"""Evidence for the suggested engine fixes (Phase 4.13). Changes NO engine code.

    python formdev/scripts/perf/experiments.py --label 300k            # PostgreSQL (loaded *_test database)
    python formdev/scripts/perf/experiments.py --label sqlite-100k --sqlite

For each finding, the SQL the engine compiles today ("current", taken from the real compiler) and a
hand-written alternative shape ("proposed") are run in the same read session settings the engine
uses, with EXPLAIN (ANALYZE, BUFFERS) and 3 warm-up + 10 timed executions each. The result rows
(record ids, in order) must be identical, otherwise the experiment is reported as not equivalent.
One PostgreSQL experiment needs an index-table column the schema does not have (ingest_seq); it
builds a scratch copy of the needed index rows (perf_exp_ri) in the *_test database and drops it.
"""
from __future__ import annotations

import argparse
import json
import re
import sys
import tempfile
import time
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parent))

from bench import MONTH, SECRET, SOURCE, Bench, leaf, nth_seq, probe_values, q  # noqa: E402
from common import PLANS, READER, RESULTS, connect, database_url, percentile, plan_facts, trim_plan, write_json  # noqa: E402

from app.formdev.adapters.sql_query import CompiledQuery  # noqa: E402

EXISTS = re.compile(r"EXISTS \(SELECT 1 FROM formdev_record_index (i\d+) WHERE \1\.record_id = k\.record_id AND ([^()]*?)\)")


def timed(fetch, statement: CompiledQuery, runs: int = 10, warmup: int = 3) -> tuple[list[float], list[Any]]:
    rows: list[Any] = []
    times = []
    for index in range(warmup + runs):
        started = time.perf_counter()
        rows = fetch(statement)
        if index >= warmup:
            times.append((time.perf_counter() - started) * 1000)
    return times, rows


def ids(rows: list[dict[str, Any]]) -> list[Any]:
    return [row.get("record_id") or row.get("g0") or tuple(row.values()) for row in rows]


def summary(times: list[float]) -> dict[str, float]:
    return {"p50_ms": round(percentile(times, 0.5), 2), "p95_ms": round(percentile(times, 0.95), 2), "max_ms": round(max(times), 2)}


# PostgreSQL ------------------------------------------------------------------------------------------
def pg_experiments(label: str) -> dict[str, Any]:
    conn = connect(database_url())
    bench = Bench(conn, label, 0, 0, 120_000)
    values = bench.values = probe_values(conn)
    adapter = bench.services.adapter
    out: dict[str, Any] = {"label": label, "values": values, "experiments": []}

    # Scratch copy of the perf_assessment index rows with the record's ingest_seq (proposed column).
    started = time.perf_counter()
    conn.execute("DROP TABLE IF EXISTS perf_exp_ri")
    conn.execute("""CREATE TABLE perf_exp_ri AS
        SELECT i.record_id, i.form_id, i.field_id, i.value_text, i.value_num, i.status, i.updated_at, r.ingest_seq
        FROM formdev_record_index i JOIN formdev_record r ON r.record_id = i.record_id WHERE i.form_id = %s""", (SOURCE,))
    conn.execute("CREATE INDEX perf_exp_ri_text_seq ON perf_exp_ri (form_id, field_id, value_text, ingest_seq DESC) INCLUDE (record_id)"
                 " WHERE value_text IS NOT NULL AND status <> 'deleted'")
    conn.execute("CREATE INDEX perf_exp_ri_num_seq ON perf_exp_ri (form_id, field_id, value_num, ingest_seq DESC) INCLUDE (record_id)"
                 " WHERE value_num IS NOT NULL AND status <> 'deleted'")
    conn.execute("VACUUM (ANALYZE) perf_exp_ri")
    size = conn.execute("SELECT pg_total_relation_size('perf_exp_ri') AS b, pg_indexes_size('perf_exp_ri') AS i").fetchone()
    out["scratch_table"] = {"build_s": round(time.perf_counter() - started, 2), "total_bytes": size["b"], "index_bytes": size["i"]}

    def run(name: str, finding: str, current: CompiledQuery, proposed: CompiledQuery, note: str = "") -> None:
        record: dict[str, Any] = {"name": name, "finding": finding, "note": note}
        plans = {}
        with adapter.read_session(120_000, "interactive") as session:
            for key, statement in (("current", current), ("proposed", proposed)):
                times, rows = timed(session.fetch, statement)
                record[key] = summary(times)
                record[key]["rows"] = len(rows)
                record[f"{key}_ids"] = ids(rows)
        for key, statement in (("current", current), ("proposed", proposed)):
            plans[key] = bench.explain(statement)
            record[key]["plan"] = {k: plan_facts(plans[key])[k] for k in ("node_types", "indexes", "seq_scans", "rows_scanned", "buffers", "heap_fetches",
                                                                          "top_est", "top_act", "execution_ms", "sort_methods")}
        record["equivalent"] = record.pop("current_ids") == record.pop("proposed_ids")
        write_json(PLANS / f"exp-{name}-{label}.json", {"experiment": name, "label": label, "statements": plans})
        out["experiments"].append(record)
        c, p = record["current"], record["proposed"]
        print(f"{name:28} equivalent={record['equivalent']} current p50={c['p50_ms']} buf={c['plan']['buffers']} seq={c['plan']['seq_scans']} | "
              f"proposed p50={p['p50_ms']} buf={p['plan']['buffers']} seq={p['plan']['seq_scans']} idx={p['plan']['indexes']}", flush=True)

    head = "SELECT r.record_id, r.schema_version, r.data, r.ingested_at, page.ok AS order_value FROM ("
    tail = ") page JOIN formdev_record r ON r.record_id = page.rid ORDER BY page.ok DESC"

    # F1: default sort ($ingested_at = ingest_seq) has no index on the index table -> offset / deep pages.
    for case, body, extra in (
        ("offset10000", q(filter=leaf("ward", "eq", "W_BIG"), pagination={"mode": "offset", "limit": 50, "offset": 10000}), None),
        ("eq_wbig_p1", q(filter=leaf("ward", "eq", "W_BIG")), None),
        ("eq_wbig_deep", q(filter=leaf("ward", "eq", "W_BIG")), "deep"),
        ("eq_hn", q(filter=leaf("hn", "eq", values["hn_a"])), None),
    ):
        if extra == "deep":
            seq = nth_seq(conn, min(5000, values["counts"]["w_big"] - 100), "W_BIG")
            body = bench.with_cursor(body, seq)
        compiled = bench.compiled(body)
        plan = compiled["plan"]
        leaf_ = plan.where
        params: list[Any] = [SOURCE, leaf_.field, leaf_.values[0]]
        keyset = ""
        if plan.keyset is not None:
            keyset = " AND x.ingest_seq < %s"
            params.append(plan.keyset[0])
        params.append(plan.limit + 1)
        offset = ""
        if plan.offset:
            offset = " OFFSET %s"
            params.append(plan.offset)
        proposed = CompiledQuery(
            head + "SELECT x.record_id AS rid, x.ingest_seq AS ok FROM perf_exp_ri x WHERE x.form_id = %s AND x.field_id = %s AND x.value_text = %s"
            f" AND x.value_text IS NOT NULL AND x.status <> 'deleted'{keyset} ORDER BY x.ingest_seq DESC LIMIT %s{offset}" + tail, tuple(params))
        proposed = CompiledQuery(proposed.sql.replace("%s", "?"), proposed.params)
        run(f"F1-{case}", "filtered default-sort pages need an index on (form_id, field_id, value, ingest_seq)", compiled["main"], proposed,
            "proposed reads perf_exp_ri = formdev_record_index + ingest_seq column, index (form_id, field_id, value_text, ingest_seq DESC) INCLUDE (record_id)"
            " WHERE value_text IS NOT NULL AND status <> 'deleted'")

    # F2: OR of a metadata leaf and an index leaf walks every record of the form.
    body = q(filter={"or": [leaf("$subject_id", "eq", values["hn_b"]), leaf("ward", "eq", "W_RARE")]})
    compiled = bench.compiled(body)
    limit = compiled["plan"].limit + 1
    branch = ("(SELECT k.record_id AS rid, k.ingest_seq AS ok FROM formdev_record k WHERE k.form_id = ? AND k.status <> 'deleted' AND {cond}"
              " ORDER BY k.ingest_seq DESC LIMIT ?)")
    meta = branch.format(cond="k.subject_id = ?")
    index = branch.format(cond="EXISTS (SELECT 1 FROM formdev_record_index i1 WHERE i1.record_id = k.record_id AND i1.form_id = ? AND i1.status <> 'deleted'"
                               " AND i1.field_id = ? AND i1.value_text = ?)")
    proposed = CompiledQuery(head + f"SELECT u.rid, u.ok FROM ({meta} UNION {index}) u ORDER BY u.ok DESC LIMIT ?" + tail,
                             (SOURCE, values["hn_b"], limit, SOURCE, SOURCE, "ward", "W_RARE", limit, limit))
    run("F2-or_meta_index", "OR(meta leaf, index leaf) cannot use an index: compile as UNION of per-branch keyset tops", compiled["main"], proposed)

    # F3: field-sorted offset pages join formdev_record for the whole window before LIMIT/OFFSET.
    body = q(sort=[{"field": "age", "dir": "asc"}], pagination={"mode": "offset", "limit": 50, "offset": 5000})
    compiled = bench.compiled(body)
    sql = compiled["main"].sql
    marker = ") page JOIN formdev_record r ON r.record_id = page.rid ORDER BY page.nb, page.sv ASC, page.rid ASC LIMIT ? OFFSET ?"
    assert sql.endswith(marker), sql[-200:]
    inner = sql[: -len(marker)].split(" FROM (", 1)[1]
    proposed_sql = ("SELECT r.record_id, r.schema_version, r.data, r.ingested_at, page.sv AS order_value FROM (SELECT u.* FROM (" + inner +
                    ") u ORDER BY u.nb, u.sv ASC, u.rid ASC LIMIT ? OFFSET ?) page JOIN formdev_record r ON r.record_id = page.rid"
                    " ORDER BY page.nb, page.sv ASC, page.rid ASC")
    run("F3-sort_age_off5000", "apply ORDER BY/LIMIT/OFFSET before joining formdev_record", compiled["main"], CompiledQuery(proposed_sql, compiled["main"].params))

    # F4: aggregate group estimate (pivot column has no statistics -> default 200 groups).
    body = {"query": {"source": SOURCE, "cache": False, "filter": leaf("assessed_at", "between", MONTH), "group": ["ward"], "aggregate": [{"fn": "count", "as": "n"}]}}
    compiled = bench.compiled(body)
    current = compiled["main"]
    lo, hi = compiled["plan"].where.values
    proposed_sql = ("SELECT * FROM (SELECT x.value_text AS g0, COUNT(*) AS a0 FROM formdev_record k LEFT JOIN formdev_record_index x ON x.record_id = k.record_id"
                    " AND x.form_id = ? AND x.field_id = ? WHERE k.form_id = ? AND k.status <> 'deleted' AND EXISTS (SELECT 1 FROM formdev_record_index i1"
                    " WHERE i1.record_id = k.record_id AND i1.form_id = ? AND i1.status <> 'deleted' AND i1.field_id = ? AND i1.value_num >= ? AND i1.value_num <= ?)"
                    " GROUP BY x.value_text) q ORDER BY (q.g0 IS NULL), q.g0 ASC LIMIT ?")
    proposed = CompiledQuery(proposed_sql, (SOURCE, "ward", SOURCE, SOURCE, "assessed_at", lo, hi, compiled["plan"].limit + 1))
    run("F4-agg_month_ward", "group by a single field: group on the index column (statistics) instead of the pivot", current, proposed)

    conn.execute("DROP TABLE IF EXISTS perf_exp_ri")
    return out


# SQLite --------------------------------------------------------------------------------------------------
def sqlite_experiments(label: str, records: int, noise: int) -> dict[str, Any]:
    from sqlite_bench import load, values_for

    from app.formdev import services_for
    from app.formdev.adapters.sql_query import compile_plan
    from app.formdev.adapters.sqlite import SQLiteAdapter
    from app.formdev.query.engine import QueryEngine, QueryRuntime
    from app.formdev.query.plan import build_plan
    from common import require_test_path

    path = require_test_path(Path(tempfile.gettempdir()) / f"formdev_perf_exp_{label.replace('-', '_')}_test.db")
    for suffix in ("", "-wal", "-shm"):
        Path(str(path) + suffix).unlink(missing_ok=True)
    adapter = SQLiteAdapter(path)
    load(adapter, records, noise)
    services = services_for(adapter)
    values = values_for(adapter.connection)
    engine = QueryEngine(QueryRuntime(cursor_secret=SECRET), services, READER)
    out: dict[str, Any] = {"label": label, "values": values, "experiments": []}
    for name, body in (("eq_hn", q(filter=leaf("hn", "eq", values["hn_a"]))), ("dt_month", q(filter=leaf("assessed_at", "between", MONTH))),
                       ("eq_wbig_p1", q(filter=leaf("ward", "eq", "W_BIG")))):
        _, spec, _ = engine.require_valid(body)
        current = compile_plan(build_plan(spec))
        proposed_sql, replaced = EXISTS.subn(lambda m: f"k.record_id IN (SELECT {m.group(1)}.record_id FROM formdev_record_index {m.group(1)} WHERE "
                                                       f"{m.group(2)} AND {m.group(1)}.value_{'text' if 'value_text' in m.group(2) else 'num'} IS NOT NULL)",
                                              current.sql)
        assert replaced == 1, current.sql
        proposed = CompiledQuery(proposed_sql, current.params[:1] + current.params[1:])
        record: dict[str, Any] = {"name": f"S1-{name}", "finding": "SQLite never uses formdev_ri_*_live for EXISTS filters: use IN (subquery)"}
        with adapter.read_session(60_000) as session:
            for key, statement in (("current", current), ("proposed", proposed)):
                times, rows = timed(session.fetch, statement)
                record[key] = {**summary(times), "rows": len(rows), "plan": session.explain(statement)["node_types"]}
                record[f"{key}_ids"] = ids(rows)
        record["equivalent"] = record.pop("current_ids") == record.pop("proposed_ids")
        out["experiments"].append(record)
        print(f"{record['name']:16} equivalent={record['equivalent']} current p50={record['current']['p50_ms']} | proposed p50={record['proposed']['p50_ms']} "
              f"plan={record['proposed']['plan']}", flush=True)
    adapter.close()
    for suffix in ("", "-wal", "-shm"):
        Path(str(path) + suffix).unlink(missing_ok=True)
    return out


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--label", required=True)
    parser.add_argument("--sqlite", action="store_true")
    parser.add_argument("--records", type=int, default=100_000)
    parser.add_argument("--noise", type=int, default=50_000)
    args = parser.parse_args()
    result = sqlite_experiments(args.label, args.records, args.noise) if args.sqlite else pg_experiments(args.label)
    write_json(RESULTS / f"experiments-{args.label}.json", result)
    return 0


if __name__ == "__main__":
    sys.exit(main())
