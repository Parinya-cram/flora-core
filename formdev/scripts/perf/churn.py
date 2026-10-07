"""Churn a loaded perf dataset through the REAL write path (Phase 4.13).

    python formdev/scripts/perf/churn.py --label 1m --update-pct 1 --delete-pct 0.2

Updates ~1% and soft-deletes ~0.2% of perf_assessment records with RecordRepository.update /
RecordRepository.delete (revision rows, index rows, data version: everything the API does).
No VACUUM is run afterwards. Autovacuum is switched off on the two record tables for the duration
of the after-churn measurement (--freeze-autovacuum, default on) so the measurement sees the dead
tuples and cleared visibility-map bits a burst of writes leaves behind; bench.py --restore-autovacuum
(or this script with --restore) switches it back on.
"""
from __future__ import annotations

import argparse
import json
import random
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from common import RESULTS, WARDS, connect, database_url, pg_services, write_json  # noqa: E402

TABLES = ("formdev_record", "formdev_record_index")


def table_state(conn) -> dict:
    out = {}
    for table in TABLES:
        row = conn.execute(
            "SELECT c.relpages, c.relallvisible, s.n_live_tup, s.n_dead_tup, s.n_mod_since_analyze, s.last_autovacuum::text AS last_autovacuum,"
            " s.last_vacuum::text AS last_vacuum, s.last_autoanalyze::text AS last_autoanalyze, pg_relation_size(c.oid) AS heap_bytes,"
            " pg_indexes_size(c.oid) AS index_bytes, c.reloptions"
            " FROM pg_class c JOIN pg_stat_user_tables s ON s.relid = c.oid WHERE c.relname = %s", (table,)).fetchone()
        row = dict(row)
        # relallvisible is only refreshed by VACUUM/ANALYZE; the visibility map itself is read with pg_visibility.
        row["relallvisible_stale_fraction"] = round(row["relallvisible"] / row["relpages"], 4) if row["relpages"] else None
        try:
            vm = conn.execute("SELECT all_visible, all_frozen FROM pg_visibility_map_summary(%s::regclass)", (table,)).fetchone()
            pages = row["heap_bytes"] // 8192
            row["vm_all_visible_pages"] = vm["all_visible"]
            row["vm_all_visible_fraction"] = round(vm["all_visible"] / pages, 4) if pages else None
        except Exception as error:  # noqa: BLE001 - extension unavailable
            row["vm_error"] = str(error)[:120]
        out[table] = row
    return out


def set_autovacuum(conn, enabled: bool) -> None:
    for table in TABLES:
        if enabled:
            conn.execute(f"ALTER TABLE {table} RESET (autovacuum_enabled)")
        else:
            conn.execute(f"ALTER TABLE {table} SET (autovacuum_enabled = false)")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--label", required=True)
    parser.add_argument("--update-pct", type=float, default=1.0)
    parser.add_argument("--delete-pct", type=float, default=0.2)
    parser.add_argument("--seed", type=int, default=7)
    parser.add_argument("--restore", action="store_true", help="only re-enable autovacuum and exit")
    parser.add_argument("--state-only", default="", help="only record the current table state under this key in churn-<label>.json")
    parser.add_argument("--no-freeze-autovacuum", action="store_true")
    args = parser.parse_args()
    conn = connect(database_url())
    try:
        conn.execute("CREATE EXTENSION IF NOT EXISTS pg_visibility")
    except Exception:  # noqa: BLE001
        pass
    if args.state_only:
        path = RESULTS / f"churn-{args.label}.json"
        stats = json.loads(path.read_text()) if path.exists() else {}
        stats[args.state_only] = table_state(conn)
        write_json(path, stats)
        print(json.dumps({t: {k: v for k, v in row.items() if k.startswith(("vm_", "n_dead"))} for t, row in stats[args.state_only].items()}))
        return 0
    if args.restore:
        set_autovacuum(conn, True)
        print("autovacuum restored")
        return 0
    if not args.no_freeze_autovacuum:
        set_autovacuum(conn, False)
    services = pg_services(conn)
    rng = random.Random(args.seed)
    rows = conn.execute("SELECT record_id FROM formdev_record WHERE form_id = 'perf_assessment' AND status <> 'deleted'").fetchall()
    ids = [row["record_id"] for row in rows]
    rng.shuffle(ids)
    n_update = round(len(ids) * args.update_pct / 100)
    n_delete = round(len(ids) * args.delete_pct / 100)
    updates, deletes = ids[:n_update], ids[n_update:n_update + n_delete]
    before = table_state(conn)
    lsn = conn.execute("SELECT pg_current_wal_lsn()::text AS l").fetchone()["l"]

    timings: dict[str, list[float]] = {"update": [], "delete": []}
    started = time.perf_counter()
    for record_id in updates:
        current = services.records.get(record_id)
        data = dict(current["data"])
        data["score"] = round(rng.uniform(0, 100), 1)
        if rng.random() < 0.5:
            data["ward"] = rng.choice(WARDS[:18])
        if rng.random() < 0.3:
            data["age"] = rng.randint(0, 100)
        data["remarks"] = (data.get("remarks") or "") + " reviewed"
        t = time.perf_counter()
        services.records.update(record_id, data, current["version"], "perf-churn")
        timings["update"].append((time.perf_counter() - t) * 1000)
    for record_id in deletes:
        current = services.records.get(record_id)
        t = time.perf_counter()
        services.records.delete(record_id, current["version"], "perf-churn")
        timings["delete"].append((time.perf_counter() - t) * 1000)
    elapsed = time.perf_counter() - started
    wal = int(conn.execute("SELECT pg_wal_lsn_diff(pg_current_wal_lsn(), %s::pg_lsn)::bigint AS d", (lsn,)).fetchone()["d"])
    conn.execute("SELECT pg_stat_force_next_flush()")
    time.sleep(1.0)
    after = table_state(conn)

    def summary(values: list[float]) -> dict:
        values = sorted(values)
        if not values:
            return {}
        return {"n": len(values), "p50_ms": round(values[len(values) // 2], 2), "p95_ms": round(values[int(len(values) * 0.95)], 2),
                "max_ms": round(values[-1], 2), "per_s": round(len(values) / (sum(values) / 1000))}

    stats = {"label": args.label, "live_records_before": len(ids), "updated": len(updates), "deleted": len(deletes), "elapsed_s": round(elapsed, 2),
             "update": summary(timings["update"]), "delete": summary(timings["delete"]), "wal_bytes": wal,
             "autovacuum_disabled_for_measurement": not args.no_freeze_autovacuum, "tables_before": before, "tables_after": after}
    write_json(RESULTS / f"churn-{args.label}.json", stats)
    print(json.dumps({k: stats[k] for k in ("updated", "deleted", "elapsed_s", "update", "delete", "wal_bytes")}))
    print(json.dumps({t: {k: after[t].get(k) for k in ("n_dead_tup", "vm_all_visible_fraction", "relpages")} for t in TABLES}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
