# FormDev query engine: performance report (1M records)

Date: 2026-10-07. Branch `Flora-Form`. All numbers below were measured; nothing is extrapolated.
Full tables (every case, every dataset): [perf/tables.md](perf/tables.md). Raw results and
`EXPLAIN (ANALYZE, BUFFERS)` plans: `perf/results/*.json`, `perf/plans/*-1m.json`.

## Verdict

| Area | 1M result |
|---|---|
| Interactive list queries (19 cases: equality, ranges, AND/OR/NOT, prefix, null, keyset and offset pages, field sort, capped count, relation) | **19/19 PASS**: p95 between 2 ms and 253 ms, no sequential scan, no spill |
| Background jobs (aggregate ×2, CSV export of 100 000 rows) | **3/3 PASS**: results equal an independent SQL reference; export 37 556 rows/s |
| Interactive aggregates over one month (≈ 42 000 records) | **2 FAIL** (see "Open findings") |
| Load and generator check | 1 151 000 records, 7 086 962 index rows in 154 s; 9 891 records re-written through the real write path, **0 mismatches** |

Pass criteria per interactive case (bench.py): the engine answers, p95 < 300 ms end to end through
`QueryEngine.run` (cache off), no Seq Scan on the record tables, no external sort, top-node row estimate
within 10× of actual, deep keyset pages cost at most 3× page 1.

## Set-up

- PostgreSQL 17.6 (Docker, `flora-core-v2-postgres-1`): shared_buffers and other settings as recorded in
  `results/bench-1m.json` → `server`. One Mac host; API code runs in the `flora-core-v2-flora-canopy-api` image.
- Data (`load.py --records 1000000 --noise 50000 --seed 4013`): `perf_assessment` 1 000 000 records
  (97% submitted, 2% draft, 1% deleted; 7 indexed fields incl. a datetime and a calculated BMI),
  `perf_registration` 101 000 (relation target, with duplicate keys), 50 000 records in three noise forms.
  Records are bulk-loaded with COPY; index rows come from the real `index_entries`, and 1% of the
  records are written again through `RecordRepository.create` and compared row by row.
- Each interactive case: 3 warm-up + 20 measured runs. Commands: `formdev/scripts/perf/run.sh load.py …`,
  `run.sh bench.py --label 1m`, `python3 formdev/scripts/perf/report.py > formdev/docs/perf/tables.md`.

Storage at 1M: database 3.5 GB (formdev_record 643 MB heap + 582 MB indexes; formdev_record_index
890 MB heap + 1 377 MB indexes). Load wrote 3.4 GB of WAL.

## What the 1M run found, and what changed

The first 1M run (same data, code before these fixes) failed 7 cases. Three were bugs in the
benchmark/harness or the deployment, two were a real engine problem that 100k data did not show,
and two remain open.

| Case | First 1M run | Cause | Fix | Now (p95) |
|---|---|---|---|---|
| `dt_month` (one old month) | timeout (5 s) | **LIMIT trap**: PostgreSQL walked the ingest-order index from the newest record and checked each one; the matches were all old, so it read 738 066 records for 51 rows (its estimate assumed matches spread evenly) | Engine: a bounded density probe (stops after one page of matches among the next 20 pages); when matches are sparse and the candidate set is smaller than the expected walk, the page is built **filter-first** (materialized candidates from the index, OR → UNION, then top-N sort) | 136 ms |
| `or_meta_index` (`$subject_id` OR rare ward) | 3 344 ms | same trap | same | 7.7 ms |
| `job_agg_*`, `job_export_csv` | job_error | (1) bench.py still passed the pre-fix `load_principal(user_id)`; (2) **PostgreSQL parallel workers ran out of `/dev/shm`** (Docker default 64 MB, SQLSTATE 53100) | (1) harness updated; (2) job reads retry once without parallel workers on 53100, and `compose/postgres.yaml` now sets `shm_size: 1gb` (takes effect when the container is recreated) | PASS (2.4–2.9 s) |

The probe chooses per query; dense filters keep the order-first plan they had (for example
`eq_wbig_p1` 4.3 ms, `and_age_fall` 54.5 ms). Both strategies return identical pages, including keyset
pages (contract test on SQLite, PostgreSQL and MySQL: `test_filter_first_pages_equal_order_first_pages`).

The generator check itself caught one more thing: the server now derives calculated fields on every
write, while the generator rounded BMI to two decimals. The generator now computes the field exactly as
the form's formula does; the reload then matched 9 891 / 9 891 records.

## Open findings

1. **Interactive aggregates over ≈ 42 000 records exceed 300 ms at 1M.** `agg_month_ward_fall`
   (group by ward + fall_risk, avg(age), one month) answers correctly in p50 629 ms / p95 780 ms. The plan
   joins every matching index row to `formdev_record` (pkey probe) to check `form_id`/`status` and pivots
   per record; ≈ 390 000 buffers.
2. **`agg_month_ward` is refused (`full_scan_requires_job`) although the month is below the 50 000-record
   threshold**: the capped count probe needs ≈ 140 ms warm and sometimes exceeds `probe_timeout_ms` (250 ms),
   and a probe that runs out of time refuses the query. The same report as a job takes 2.4 s for all 1M.

Options (a decision, not done here):
(a) read the pivot from `formdev_record_index` alone when no metadata column is grouped or filtered
(status and form_id are stored on index rows) — removes the per-record heap probe, gain to be measured;
(b) lower `interactive_aggregate_max_rows` (e.g. to 20 000) so such reports go to jobs by design;
(c) raise `probe_timeout_ms`. Until then, month-sized reports on 1M-record forms should be run as jobs.

## Earlier datasets

The 100k and 300k rows in [perf/tables.md](perf/tables.md) were measured before the Phase 4 fixes and
before the filter-first plan; they are kept for the load and size trend, not as current latency. The
SQLite 100k run (`sqlite_bench.py`) is the only SQLite measurement.

## Reproduce

```
sh formdev/scripts/perf/db.sh create flora_formdev_perf_test
formdev/scripts/perf/run.sh load.py --records 1000000 --noise 50000 --label 1m --reserve-gb 5.5
formdev/scripts/perf/run.sh bench.py --label 1m
python3 formdev/scripts/perf/report.py > formdev/docs/perf/tables.md
sh formdev/scripts/perf/db.sh drop flora_formdev_perf_test
```

The loader refuses to start, and a watchdog cancels it, when host free space would fall below 3 GB
(the 1M load needs about 5.5 GB while it runs).
