"""Bulk-load a synthetic FormDev dataset into a *_test PostgreSQL database (Phase 4.13).

    python formdev/scripts/perf/load.py --records 100000 --noise 50000 --label 100k

Forms are created and published through the real repositories. Records are written with COPY:
the record tables are truncated, the index FK, the index-table primary key and every secondary
index of formdev_record / formdev_record_index are dropped, both tables are streamed in global
ingest order, then the exact same index definitions (captured from pg_indexes before the drop)
are rebuilt, the primary key is re-added, the FK is re-added NOT VALID and VALIDATEd, the per-form
change counters are set and the tables are VACUUM ANALYZEd. Index rows come from the REAL
app.formdev.definition.index_entries. 1% of the records are re-inserted into the scratch form
through RecordRepository.create and their stored rows are compared with what the generator wrote.
"""
from __future__ import annotations

import argparse
import json
import sys
import threading
import time
import uuid
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from common import (  # noqa: E402
    MIN_FREE_BYTES, RESULTS, USER, DiskLow, Generator, assessment_definition, check_disk, connect, database_url, ensure_forms, host_free_bytes,
    index_rows, pg_services, write_json,
)

RECORD_COLUMNS = ("record_id", "form_id", "schema_version", "status", "data", "created_at", "created_by", "updated_at", "updated_by",
                  "sync_id", "version", "subject_id", "ingest_seq", "ingested_at")
INDEX_COLUMNS = ("record_id", "form_id", "field_id", "value_text", "value_num", "status", "updated_at")
TABLES = ("formdev_record", "formdev_record_index")
FK = "formdev_record_index_record_id_fkey"
INDEX_PK = "formdev_record_index_pkey"


def esc(value) -> str:
    if value is None:
        return "\\N"
    if isinstance(value, float):
        return repr(value)
    if isinstance(value, int):
        return str(value)
    return str(value).replace("\\", "\\\\").replace("\t", "\\t").replace("\n", "\\n").replace("\r", "\\r")


def record_line(record: dict) -> str:
    values = [record[c] if c != "data" else json.dumps(record["data"], ensure_ascii=False, separators=(",", ":")) for c in RECORD_COLUMNS]
    return "\t".join(esc(v) for v in values) + "\n"


def wal_lsn(conn) -> str:
    return conn.execute("SELECT pg_current_wal_lsn()::text AS lsn").fetchone()["lsn"]


def wal_diff(conn, start: str) -> int:
    return int(conn.execute("SELECT pg_wal_lsn_diff(pg_current_wal_lsn(), %s::pg_lsn)::bigint AS d", (start,)).fetchone()["d"])


def index_definitions(conn) -> dict[str, str]:
    rows = conn.execute("SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = 'public' AND tablename = ANY(%s) ORDER BY indexname",
                        (list(TABLES),)).fetchall()
    return {row["indexname"]: row["indexdef"] for row in rows}


def constraint_definition(conn, name: str) -> str | None:
    row = conn.execute("SELECT pg_get_constraintdef(oid) AS d FROM pg_constraint WHERE conname = %s", (name,)).fetchone()
    return row["d"] if row else None


def sizes(conn) -> dict:
    out = {}
    for table in TABLES + ("formdev_record_revision",):
        row = conn.execute(
            "SELECT pg_relation_size(%s) AS heap, pg_indexes_size(%s) AS indexes, pg_total_relation_size(%s) AS total,"
            " (SELECT reltuples::bigint FROM pg_class WHERE relname = %s) AS reltuples", (table, table, table, table)).fetchone()
        idx = conn.execute("SELECT indexrelname AS name, pg_relation_size(indexrelid) AS bytes FROM pg_stat_user_indexes WHERE relname = %s ORDER BY 1",
                           (table,)).fetchall()
        out[table] = {**row, "per_index": {r["name"]: r["bytes"] for r in idx}}
    out["database"] = conn.execute("SELECT pg_database_size(current_database()) AS b").fetchone()["b"]
    return out


class DiskWatchdog(threading.Thread):
    """Cancels the loader's running statement (index build, VACUUM, ...) when host free space drops
    below 3 GB; the main thread then records the abort."""

    def __init__(self, url: str, backend_pid: int):
        super().__init__(daemon=True)
        self.url, self.pid = url, backend_pid
        self.tripped: str | None = None
        self.lowest = host_free_bytes()
        self.stop = threading.Event()

    def run(self) -> None:
        conn = connect(self.url)
        while not self.stop.wait(1.0):
            free = host_free_bytes()
            self.lowest = min(self.lowest, free)
            if free < MIN_FREE_BYTES and not self.tripped:
                self.tripped = f"watchdog: host free {free / 1e9:.2f} GB < 3 GB"
                conn.execute("SELECT pg_cancel_backend(%s)", (self.pid,))
        conn.close()


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--records", type=int, required=True)
    parser.add_argument("--noise", type=int, required=True)
    parser.add_argument("--label", required=True)
    parser.add_argument("--seed", type=int, default=4013)
    parser.add_argument("--sample-every", type=int, default=100)
    parser.add_argument("--reserve-gb", type=float, default=0.0, help="estimated growth; abort before starting if free - reserve < 3 GB")
    parser.add_argument("--chunk", type=int, default=5000)
    args = parser.parse_args()
    url = database_url()
    stats: dict = {"label": args.label, "records": args.records, "noise": args.noise, "seed": args.seed, "timings_s": {},
                   "host_free_gb": {"start": round(host_free_bytes() / 1e9, 2)}}
    timings = stats["timings_s"]
    try:
        check_disk("before load", int(args.reserve_gb * 1e9))
    except DiskLow as error:
        stats["aborted"] = str(error)
        write_json(RESULTS / f"load-{args.label}.json", stats)
        print(json.dumps(stats))
        return 3

    conn = connect(url)
    conn2 = connect(url)
    watchdog = DiskWatchdog(url, conn.info.backend_pid)
    watchdog.start()
    services = pg_services(conn)
    ensure_forms(services)
    conn.execute("SET maintenance_work_mem = '512MB'")
    before = index_definitions(conn)
    fk_def = constraint_definition(conn, FK)
    pk_def = constraint_definition(conn, INDEX_PK)
    stats["index_definitions"] = before
    stats["constraints"] = {FK: fk_def, INDEX_PK: pk_def}
    lsn0 = wal_lsn(conn)

    started = time.perf_counter()
    conn.execute("TRUNCATE formdev_record_revision, formdev_record_index, formdev_record")
    if fk_def:
        conn.execute(f"ALTER TABLE formdev_record_index DROP CONSTRAINT {FK}")
    if pk_def:
        conn.execute(f"ALTER TABLE formdev_record_index DROP CONSTRAINT {INDEX_PK}")
    secondary = {name: sql for name, sql in before.items() if not name.endswith("_pkey")}
    for name in secondary:
        conn.execute(f"DROP INDEX IF EXISTS {name}")
    timings["truncate_drop"] = round(time.perf_counter() - started, 2)

    generator = Generator(args.records, args.noise, args.seed)
    definitions = generator.definitions
    sample: list[dict] = []
    counts = {"records": 0, "index_rows": 0, "by_form": {}, "by_status": {}}
    copy_started = time.perf_counter()
    peak_low = host_free_bytes()
    cur1, cur2 = conn.cursor(), conn2.cursor()
    try:
        with cur1.copy(f"COPY formdev_record ({', '.join(RECORD_COLUMNS)}) FROM STDIN") as copy_records, \
                cur2.copy(f"COPY formdev_record_index ({', '.join(INDEX_COLUMNS)}) FROM STDIN") as copy_index:
            record_buffer: list[str] = []
            index_buffer: list[str] = []
            for record in generator.records():
                record_buffer.append(record_line(record))
                rows = index_rows(definitions[record["form_id"]], record)
                index_buffer.extend("\t".join(esc(v) for v in row) + "\n" for row in rows)
                counts["records"] += 1
                counts["index_rows"] += len(rows)
                counts["by_form"][record["form_id"]] = counts["by_form"].get(record["form_id"], 0) + 1
                if record["form_id"] == "perf_assessment":
                    counts["by_status"][record["status"]] = counts["by_status"].get(record["status"], 0) + 1
                    if record["ingest_seq"] % args.sample_every == 0 and record["status"] != "deleted":
                        sample.append(record)
                if len(record_buffer) >= args.chunk:
                    copy_records.write("".join(record_buffer))
                    copy_index.write("".join(index_buffer))
                    record_buffer.clear()
                    index_buffer.clear()
                    peak_low = min(peak_low, check_disk("copy"))
            copy_records.write("".join(record_buffer))
            copy_index.write("".join(index_buffer))
    except Exception as error:
        if not (isinstance(error, DiskLow) or watchdog.tripped):
            raise
        stats["aborted"] = str(error) if isinstance(error, DiskLow) else watchdog.tripped
        stats["counts_at_abort"] = counts
        write_json(RESULTS / f"load-{args.label}.json", stats)
        print(json.dumps({"aborted": str(error)}))
        return 3
    timings["copy"] = round(time.perf_counter() - copy_started, 2)
    stats["counts"] = counts
    try:
        code = _finish(args, conn, services, stats, timings, secondary, fk_def, pk_def, before, lsn0, sample, started, peak_low, counts)
        stats["host_free_gb"]["lowest_watchdog"] = round(watchdog.lowest / 1e9, 2)
        write_json(RESULTS / f"load-{args.label}.json", stats)
        return code
    except Exception as error:
        if not (isinstance(error, DiskLow) or watchdog.tripped):
            raise
        stats["aborted"] = str(error) if isinstance(error, DiskLow) else watchdog.tripped
        stats["host_free_gb"]["at_abort"] = round(host_free_bytes() / 1e9, 2)
        write_json(RESULTS / f"load-{args.label}.json", stats)
        print(json.dumps({"aborted": str(error), "timings_s": timings}))
        return 3


def _finish(args, conn, services, stats, timings, secondary, fk_def, pk_def, before, lsn0, sample, started, peak_low, counts) -> int:
    stats["copy_rows_per_s"] = {"records": round(counts["records"] / timings["copy"]), "index_rows": round(counts["index_rows"] / timings["copy"]),
                                "all_rows": round((counts["records"] + counts["index_rows"]) / timings["copy"])}
    stats["wal_bytes"] = {"copy": wal_diff(conn, lsn0)}

    # Rebuild: identical definitions, then PK, then FK NOT VALID + VALIDATE.
    lsn1 = wal_lsn(conn)
    build: dict[str, float] = {}
    for name, sql in secondary.items():
        check_disk(f"index {name}")
        t = time.perf_counter()
        conn.execute(sql)
        build[name] = round(time.perf_counter() - t, 2)
    if pk_def:
        t = time.perf_counter()
        conn.execute(f"ALTER TABLE formdev_record_index ADD CONSTRAINT {INDEX_PK} {pk_def}")
        build[INDEX_PK] = round(time.perf_counter() - t, 2)
    if fk_def:
        t = time.perf_counter()
        conn.execute(f"ALTER TABLE formdev_record_index ADD CONSTRAINT {FK} {fk_def} NOT VALID")
        conn.execute(f"ALTER TABLE formdev_record_index VALIDATE CONSTRAINT {FK}")
        build[f"{FK} (validate)"] = round(time.perf_counter() - t, 2)
    timings["index_build"] = build
    after = index_definitions(conn)
    stats["indexes_identical"] = after == before
    stats["index_definition_diff"] = {k: (before.get(k), after.get(k)) for k in set(before) | set(after) if before.get(k) != after.get(k)}
    stats["constraints_identical"] = constraint_definition(conn, FK) == fk_def and constraint_definition(conn, INDEX_PK) == pk_def
    stats["wal_bytes"]["index_build"] = wal_diff(conn, lsn1)

    # Per-form change counters = max(ingest_seq) (never lowered).
    conn.execute("""
        INSERT INTO formdev_data_version (form_id, version, updated_at)
        SELECT form_id, max(ingest_seq), (extract(epoch from now()) * 1000)::bigint FROM formdev_record GROUP BY form_id
        ON CONFLICT (form_id) DO UPDATE SET version = GREATEST(formdev_data_version.version, excluded.version), updated_at = excluded.updated_at""")

    # Generator validation through the real write path (scratch form, same definition).
    t = time.perf_counter()
    scratch_def = assessment_definition("perf_scratch")
    mismatches: list[dict] = []
    created_ms: list[float] = []
    expected: dict[str, list[tuple]] = {}
    expected_meta: dict[str, tuple] = {}
    for number, record in enumerate(sample):
        if number % 200 == 0:
            check_disk("validation")
        record_id = str(uuid.uuid4())
        t1 = time.perf_counter()
        services.records.create("perf_scratch", record["data"], USER, status=record["status"], record_id=record_id, updated_at=record["updated_at"])
        created_ms.append((time.perf_counter() - t1) * 1000)
        clone = {**record, "record_id": record_id, "form_id": "perf_scratch"}
        expected[record_id] = sorted(index_rows(scratch_def, clone))
        expected_meta[record_id] = (record["status"], record["updated_at"], record["subject_id"], json.dumps(record["data"], sort_keys=True))
    ids = list(expected)
    stored: dict[str, list[tuple]] = {rid: [] for rid in ids}
    for start in range(0, len(ids), 1000):
        chunk = ids[start:start + 1000]
        for row in conn.execute(f"SELECT {', '.join(INDEX_COLUMNS)} FROM formdev_record_index WHERE record_id = ANY(%s)", (chunk,)).fetchall():
            stored[row["record_id"]].append(tuple(row[c] for c in INDEX_COLUMNS))
        for row in conn.execute("SELECT record_id, status, updated_at, subject_id, data FROM formdev_record WHERE record_id = ANY(%s)", (chunk,)).fetchall():
            meta = (row["status"], int(row["updated_at"]), row["subject_id"], json.dumps(row["data"], sort_keys=True))
            if meta != expected_meta[row["record_id"]]:
                mismatches.append({"record_id": row["record_id"], "kind": "record", "stored": meta[:3], "expected": expected_meta[row["record_id"]][:3]})
    for rid in ids:
        got = sorted((r[0], r[1], r[2], r[3], float(r[4]) if r[4] is not None else None, r[5], int(r[6])) for r in stored[rid])
        want = sorted((r[0], r[1], r[2], r[3], float(r[4]) if r[4] is not None else None, r[5], int(r[6])) for r in expected[rid])
        if got != want:
            mismatches.append({"record_id": rid, "kind": "index", "stored": got, "expected": want})
    timings["validation"] = round(time.perf_counter() - t, 2)
    created_ms.sort()
    stats["validation"] = {"sampled": len(sample), "mismatches": len(mismatches), "examples": mismatches[:5],
                           "create_ms_p50": round(created_ms[len(created_ms) // 2], 2) if created_ms else None,
                           "create_ms_p95": round(created_ms[int(len(created_ms) * 0.95)], 2) if created_ms else None,
                           "creates_per_s": round(len(created_ms) / (sum(created_ms) / 1000)) if created_ms else None}

    check_disk("before vacuum")
    t = time.perf_counter()
    for table in TABLES:
        conn.execute(f"VACUUM (ANALYZE) {table}")
    conn.execute("ANALYZE")
    timings["vacuum_analyze"] = round(time.perf_counter() - t, 2)
    timings["total"] = round(time.perf_counter() - started, 2)
    stats["wal_bytes"]["total"] = wal_diff(conn, lsn0)
    stats["sizes"] = sizes(conn)
    stats["host_free_gb"].update({"lowest_during_copy": round(peak_low / 1e9, 2), "end": round(host_free_bytes() / 1e9, 2)})
    write_json(RESULTS / f"load-{args.label}.json", stats)
    print(json.dumps({k: stats[k] for k in ("counts", "timings_s", "copy_rows_per_s", "indexes_identical", "validation", "wal_bytes", "host_free_gb")}, default=str))
    return 0 if stats["indexes_identical"] and not mismatches else 1


if __name__ == "__main__":
    sys.exit(main())
