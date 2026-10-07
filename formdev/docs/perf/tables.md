### Summary (PASS/FAIL per case per dataset)

| Case | 100k | 300k | 1m | sqlite-100k |
|---|---|---|---|---|
| `eq_hn` | PASS | FAIL | PASS | FAIL |
| `eq_wbig_p1` | PASS | PASS | PASS | PASS |
| `eq_wbig_deep` | PASS | PASS | PASS | PASS |
| `eq_wrare` | PASS | PASS | PASS | n/a |
| `and_age_fall` | PASS | PASS | PASS | PASS |
| `or_index` | PASS | PASS | PASS | n/a |
| `or_meta_index` | PASS | PASS | PASS | n/a |
| `not_fall` | PASS | PASS | PASS | n/a |
| `isnull_age` | PASS | PASS | PASS | n/a |
| `prefix_hn` | PASS | PASS | PASS | n/a |
| `dt_month` | PASS | PASS | PASS | PASS |
| `nofilter_p1` | PASS | PASS | PASS | PASS |
| `nofilter_deep` | PASS | PASS | PASS | PASS |
| `offset0` | PASS | PASS | PASS | n/a |
| `offset10000` | FAIL | FAIL | PASS | n/a |
| `sort_age_off0` | PASS | PASS | PASS | n/a |
| `sort_age_off5000` | FAIL | PASS | PASS | n/a |
| `count_capped` | PASS | PASS | PASS | n/a |
| `relation_p1` | PASS | PASS | PASS | n/a |
| `agg_month_ward` | FAIL | FAIL | FAIL | FAIL |
| `agg_month_ward_fall` | PASS | PASS | FAIL | n/a |
| `agg_all_ward` | PASS | PASS | PASS | n/a |
| `job_agg_ward` | PASS | PASS | PASS | PASS |
| `job_agg_ward_fall_avg_age` | PASS | PASS | PASS | n/a |
| `job_export_csv` | PASS | PASS | PASS | n/a |

### Load

| Dataset | Records (all forms) | perf_assessment | Index rows | COPY s | COPY rows/s | Index rebuild s | VACUUM ANALYZE s | Total s | WAL | DB size | Generator check |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 100k | 160,100 | 100,000 | 919,808 | 7.78 | 138,806 | 6.2 | 9.73 | 25.14 | 421.5 MB | 464.0 MB | 992 via RecordRepository.create, 0 mismatches |
| 300k | 390,300 | 300,000 | 2,336,838 | 18.46 | 147,732 | 19.3 | 12.37 | 58.41 | 1,106.6 MB | 1,163.7 MB | 2971 via RecordRepository.create, 0 mismatches |
| 1m | 1,151,000 | 1,000,000 | 7,086,962 | 59.13 | 139,319 | 55.3 | 15.67 | 153.55 | 3,394.0 MB | 3,507.4 MB | 9891 via RecordRepository.create, 0 mismatches |

### Table and index sizes

| Dataset | Relation | Heap | Indexes (total) | Per index |
|---|---|---|---|---|
| 100k | formdev_record | 79.6 MB | 80.2 MB | formdev_record_created 14.0 MB, formdev_record_ingest 6.7 MB, formdev_record_pkey 12.3 MB, formdev_record_recent 14.0 MB, formdev_record_status_recent 16.6 MB, formdev_record_subject 16.6 MB |
| 100k | formdev_record_index | 115.2 MB | 179.5 MB | formdev_record_index_pkey 62.8 MB, formdev_ri_num_live 54.6 MB, formdev_ri_text_live 62.1 MB |
| 300k | formdev_record | 206.9 MB | 197.7 MB | formdev_record_created 34.3 MB, formdev_record_ingest 16.4 MB, formdev_record_pkey 31.0 MB, formdev_record_recent 34.3 MB, formdev_record_status_recent 40.9 MB, formdev_record_subject 40.9 MB |
| 300k | formdev_record_index | 293.2 MB | 454.8 MB | formdev_record_index_pkey 159.8 MB, formdev_ri_num_live 138.1 MB, formdev_ri_text_live 157.0 MB |
| 1m | formdev_record | 642.9 MB | 581.7 MB | formdev_record_created 101.3 MB, formdev_record_ingest 48.4 MB, formdev_record_pkey 87.8 MB, formdev_record_recent 101.3 MB, formdev_record_status_recent 121.5 MB, formdev_record_subject 121.4 MB |
| 1m | formdev_record_index | 890.4 MB | 1,376.7 MB | formdev_record_index_pkey 484.9 MB, formdev_ri_num_live 417.1 MB, formdev_ri_text_live 474.6 MB |

### PostgreSQL interactive cases: 100k

Runs: 3 warm-up + 20 measured per case, end-to-end QueryEngine.run (ms). Live perf_assessment records: 99,020.

| Case | Query | p50 | p95 | max | Rows | Rows scanned | Buffers (main) | Heap fetches | SQL exec ms (EXPLAIN) | Indexes | est/act (top) | Failed checks | Result |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| `eq_hn` | eq on hn (selective, ~10 matches) | 1.3 | 1.5 | 1.7 | 15 | 45 | 124 | 0 | 0.09 | formdev_record_pkey, formdev_ri_text_live | 2/15 | - | **PASS** |
| `eq_wbig_p1` | eq on ward W_BIG (30%), page 1 | 2.0 | 2.7 | 3.7 | 50 | 392 | 901 | 0 | 0.40 | formdev_record_index_pkey, formdev_record_ingest, formdev_record_pkey | 51/51 | - | **PASS** |
| `eq_wbig_deep` | eq on ward W_BIG, keyset page after the 5000th match | 2.3 | 3.0 | 5.2 | 50 | 385 | 895 | 0 | 1.11 | formdev_record_index_pkey, formdev_record_ingest, formdev_record_pkey | 51/51 | - | **PASS** |
| `eq_wrare` | eq on ward W_RARE (0.05%, all oldest): LIMIT trap | 1.8 | 2.3 | 3.2 | 50 | 150 | 405 | 0 | 0.18 | formdev_record_pkey, formdev_ri_text_live | 39/50 | - | **PASS** |
| `and_age_fall` | AND(age between 30..50, fall_risk eq yes) | 6.5 | 11.3 | 26.4 | 50 | 3,117 | 6,929 | 0 | 2.80 | formdev_record_index_pkey, formdev_record_ingest, formdev_record_pkey | 51/51 | - | **PASS** |
| `or_index` | OR(hn eq X, ward eq W_RARE): index leaves only | 1.9 | 2.8 | 2.9 | 50 | 231 | 469 | 0 | 0.24 | formdev_record_pkey, formdev_ri_text_live | 40/51 | - | **PASS** |
| `or_meta_index` | OR($subject_id eq X, ward eq W_RARE): metadata + index leaf | 22.4 | 31.4 | 36.3 | 50 | 100,092 | 11,371 | 0 | 19.14 | formdev_record_ingest, formdev_record_pkey, formdev_ri_text_live | 51/51 | - | **PASS** |
| `not_fall` | NOT(fall_risk eq no) | 2.2 | 2.6 | 3.2 | 50 | 770 | 1,678 | 0 | 0.69 | formdev_record_index_pkey, formdev_record_ingest, formdev_record_pkey | 51/51 | - | **PASS** |
| `isnull_age` | age is_null (25% missing) | 2.5 | 3.7 | 3.9 | 50 | 460 | 989 | 0 | 0.46 | formdev_record_index_pkey, formdev_record_ingest, formdev_record_pkey | 51/51 | - | **PASS** |
| `prefix_hn` | prefix on hn 'HN00012' (~1000 matches) | 3.4 | 4.3 | 4.5 | 50 | 2,059 | 4,237 | 0 | 1.92 | formdev_record_pkey, formdev_ri_text_live | 51/51 | - | **PASS** |
| `dt_month` | assessed_at in March 2025 (one month, old) | 8.9 | 14.9 | 37.9 | 50 | 8,425 | 17,013 | 0 | 7.75 | formdev_record_pkey, formdev_ri_num_live | 51/51 | - | **PASS** |
| `nofilter_p1` | no filter, page 1 | 1.6 | 2.1 | 2.3 | 50 | 104 | 214 | 0 | 0.09 | formdev_record_ingest, formdev_record_pkey | 51/51 | - | **PASS** |
| `nofilter_deep` | no filter, keyset page at the middle of the form | 1.8 | 2.3 | 2.5 | 50 | 103 | 228 | 0 | 0.12 | formdev_record_ingest, formdev_record_pkey | 51/51 | - | **PASS** |
| `offset0` | ward eq W_BIG, offset 0 | 2.0 | 2.4 | 2.4 | 50 | 392 | 901 | 0 | 0.38 | formdev_record_index_pkey, formdev_record_ingest, formdev_record_pkey | 51/51 | - | **PASS** |
| `offset10000` | ward eq W_BIG, offset 10000 | 43.2 | 61.9 | 62.5 | 50 | 190,893 | 10,300 | 0 | 57.36 | formdev_record_pkey, formdev_ri_text_live | 51/51 | no_seq_scan | **FAIL** |
| `sort_age_off0` | sort by age asc (field sort), offset 0 | 5.3 | 7.6 | 9.3 | 50 | 2,233 | 3,680 | 0 | 3.04 | formdev_record_index_pkey, formdev_record_pkey, formdev_ri_num_live | 51/51 | - | **PASS** |
| `sort_age_off5000` | sort by age asc, offset 5000 | 110.5 | 136.4 | 209.7 | 50 | 238,189 | 65,611 | 0 | 102.54 | formdev_record_index_pkey, formdev_record_pkey, formdev_ri_num_live | 51/51 | no_seq_scan | **FAIL** |
| `count_capped` | ward eq W_BIG + capped count (cap 10000) | 10.2 | 12.1 | 13.6 | 50 | 392 | 901 | 0 | 0.47 | formdev_record_index_pkey, formdev_record_ingest, formdev_record_pkey | 51/51 | - | **PASS** |
| `relation_p1` | perf_with_patient: hn, ward, patient.name; ward eq W05; page of 50 | 6.8 | 8.9 | 10.0 | 50 | 2,354 | 4,913 | 0 | 3.06 | formdev_record_index_pkey, formdev_record_ingest, formdev_record_pkey | 51/51 | - | **PASS** |
| `agg_month_ward` | interactive aggregate: count by ward, one month (probe <= 50000) | 26.9 | 34.5 | 40.1 | 19 | 16,767 | 33,557 | 0 | 21.27 | formdev_record_index_pkey, formdev_record_pkey, formdev_ri_num_live | 200/19 | top_estimate_within_10x | **FAIL** |
| `agg_month_ward_fall` | interactive aggregate: by ward+fall_risk avg(age), one month | 39.3 | 72.2 | 85.2 | 38 | 25,160 | 34,327 | 0 | 30.29 | formdev_record_index_pkey, formdev_record_pkey, formdev_ri_num_live | 200/38 | - | **PASS** |
| `agg_all_ward` | aggregate over the whole form: interactive must refuse (job) | - | - | - | - (full_scan_requires_job after 8.3 ms) | 50,981 | 646 | 0 | 8.97 | formdev_record_status_recent | 1/1 | - | **PASS** |

### PostgreSQL interactive cases: 300k

Runs: 3 warm-up + 20 measured per case, end-to-end QueryEngine.run (ms). Live perf_assessment records: 296,985.

| Case | Query | p50 | p95 | max | Rows | Rows scanned | Buffers (main) | Heap fetches | SQL exec ms (EXPLAIN) | Indexes | est/act (top) | Failed checks | Result |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| `eq_hn` | eq on hn (selective, ~10 matches) | 1.6 | 2.8 | 5.4 | 19 | 57 | 158 | 0 | 0.12 | formdev_record_pkey, formdev_ri_text_live | 1/19 | top_estimate_within_10x | **FAIL** |
| `eq_wbig_p1` | eq on ward W_BIG (30%), page 1 | 1.9 | 2.3 | 2.4 | 50 | 302 | 848 | 0 | 0.35 | formdev_record_index_pkey, formdev_record_ingest, formdev_record_pkey | 51/51 | - | **PASS** |
| `eq_wbig_deep` | eq on ward W_BIG, keyset page after the 5000th match | 2.2 | 3.8 | 6.4 | 50 | 435 | 1,181 | 0 | 0.46 | formdev_record_index_pkey, formdev_record_ingest, formdev_record_pkey | 51/51 | - | **PASS** |
| `eq_wrare` | eq on ward W_RARE (0.05%, all oldest): LIMIT trap | 1.9 | 2.5 | 2.6 | 50 | 347 | 803 | 0 | 0.36 | formdev_record_pkey, formdev_ri_text_live | 14/51 | - | **PASS** |
| `and_age_fall` | AND(age between 30..50, fall_risk eq yes) | 5.4 | 6.4 | 6.5 | 50 | 3,408 | 9,395 | 0 | 3.43 | formdev_record_index_pkey, formdev_record_ingest, formdev_record_pkey | 51/51 | - | **PASS** |
| `or_index` | OR(hn eq X, ward eq W_RARE): index leaves only | 2.0 | 2.2 | 2.2 | 50 | 534 | 891 | 0 | 0.42 | formdev_record_pkey, formdev_ri_text_live | 16/51 | - | **PASS** |
| `or_meta_index` | OR($subject_id eq X, ward eq W_RARE): metadata + index leaf | 137.9 | 196.9 | 201.5 | 50 | 300,087 | 29,826 | 0 | 152.69 | formdev_record_ingest, formdev_record_pkey, formdev_ri_text_live | 51/51 | - | **PASS** |
| `not_fall` | NOT(fall_risk eq no) | 2.9 | 4.1 | 5.0 | 50 | 544 | 1,455 | 0 | 0.83 | formdev_record_index_pkey, formdev_record_ingest, formdev_record_pkey | 51/51 | - | **PASS** |
| `isnull_age` | age is_null (25% missing) | 2.1 | 2.9 | 3.4 | 50 | 404 | 1,053 | 0 | 0.48 | formdev_record_index_pkey, formdev_record_ingest, formdev_record_pkey | 51/51 | - | **PASS** |
| `prefix_hn` | prefix on hn 'HN00012' (~1000 matches) | 3.2 | 3.6 | 3.8 | 50 | 1,981 | 4,182 | 0 | 1.67 | formdev_record_pkey, formdev_ri_text_live | 51/51 | - | **PASS** |
| `dt_month` | assessed_at in March 2025 (one month, old) | 23.7 | 30.8 | 30.9 | 50 | 25,225 | 50,730 | 0 | 26.41 | formdev_record_pkey, formdev_ri_num_live | 51/51 | - | **PASS** |
| `nofilter_p1` | no filter, page 1 | 1.6 | 2.1 | 2.6 | 50 | 102 | 211 | 0 | 0.10 | formdev_record_ingest, formdev_record_pkey | 51/51 | - | **PASS** |
| `nofilter_deep` | no filter, keyset page at the middle of the form | 4.0 | 8.4 | 11.2 | 50 | 102 | 212 | 0 | 0.78 | formdev_record_ingest, formdev_record_pkey | 51/51 | - | **PASS** |
| `offset0` | ward eq W_BIG, offset 0 | 2.8 | 10.5 | 15.1 | 50 | 302 | 848 | 0 | 0.36 | formdev_record_index_pkey, formdev_record_ingest, formdev_record_pkey | 51/51 | - | **PASS** |
| `offset10000` | ward eq W_BIG, offset 10000 | 123.2 | 172.3 | 177.1 | 50 | 482,814 | 26,660 | 0 | 137.74 | formdev_record_pkey, formdev_ri_text_live | 51/51 | no_seq_scan | **FAIL** |
| `sort_age_off0` | sort by age asc (field sort), offset 0 | 8.0 | 17.3 | 20.7 | 50 | 4,834 | 9,110 | 0 | 8.78 | formdev_record_index_pkey, formdev_record_pkey, formdev_ri_num_live | 51/51 | - | **PASS** |
| `sort_age_off5000` | sort by age asc, offset 5000 | 168.9 | 385.1 | 603.4 | 50 | 77,463 | 97,160 | 0 | 157.71 | formdev_record_index_pkey, formdev_record_pkey, formdev_ri_num_live | 51/51 | - | **PASS** |
| `count_capped` | ward eq W_BIG + capped count (cap 10000) | 22.9 | 39.4 | 39.5 | 50 | 302 | 848 | 0 | 0.58 | formdev_record_index_pkey, formdev_record_ingest, formdev_record_pkey | 51/51 | - | **PASS** |
| `relation_p1` | perf_with_patient: hn, ward, patient.name; ward eq W05; page of 50 | 6.7 | 11.0 | 11.3 | 50 | 2,646 | 6,784 | 0 | 2.81 | formdev_record_index_pkey, formdev_record_ingest, formdev_record_pkey | 51/51 | - | **PASS** |
| `agg_month_ward` | interactive aggregate: count by ward, one month (probe <= 50000) | 89.5 | 126.0 | 149.7 | 19 | 50,367 | 113,461 | 0 | 86.39 | formdev_record_index_pkey, formdev_record_pkey, formdev_ri_num_live | 200/19 | top_estimate_within_10x | **FAIL** |
| `agg_month_ward_fall` | interactive aggregate: by ward+fall_risk avg(age), one month | 115.9 | 151.2 | 156.8 | 38 | 62,973 | 116,121 | 0 | 96.39 | formdev_record_index_pkey, formdev_record_pkey, formdev_ri_num_live | 368/38 | - | **PASS** |
| `agg_all_ward` | aggregate over the whole form: interactive must refuse (job) | - | - | - | - (full_scan_requires_job after 9.0 ms) | 53,016 | 950 | 628 | 7.94 | formdev_record_status_recent | 1/1 | - | **PASS** |

### PostgreSQL interactive cases: 1m

Runs: 3 warm-up + 20 measured per case, end-to-end QueryEngine.run (ms). Live perf_assessment records: 989,929.

| Case | Query | p50 | p95 | max | Rows | Rows scanned | Buffers (main) | Heap fetches | SQL exec ms (EXPLAIN) | Indexes | est/act (top) | Failed checks | Result |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| `eq_hn` | eq on hn (selective, ~10 matches) | 3.2 | 11.3 | 25.5 | 9 | 27 | 80 | 0 | 0.08 | formdev_record_pkey, formdev_ri_text_live | 2/9 | - | **PASS** |
| `eq_wbig_p1` | eq on ward W_BIG (30%), page 1 | 3.0 | 4.3 | 5.0 | 50 | 380 | 1,041 | 0 | 0.45 | formdev_record_index_pkey, formdev_record_ingest, formdev_record_pkey | 51/51 | - | **PASS** |
| `eq_wbig_deep` | eq on ward W_BIG, keyset page after the 5000th match | 4.5 | 4.9 | 5.4 | 50 | 409 | 1,115 | 0 | 0.73 | formdev_record_index_pkey, formdev_record_ingest, formdev_record_pkey | 51/51 | - | **PASS** |
| `eq_wrare` | eq on ward W_RARE (0.05%, all oldest): LIMIT trap | 4.6 | 5.6 | 5.8 | 50 | 1,035 | 2,183 | 0 | 1.48 | formdev_record_pkey, formdev_ri_text_live | 51/51 | - | **PASS** |
| `and_age_fall` | AND(age between 30..50, fall_risk eq yes) | 34.5 | 54.5 | 57.0 | 50 | 3,844 | 10,583 | 0 | 5.38 | formdev_record_index_pkey, formdev_record_ingest, formdev_record_pkey | 51/51 | - | **PASS** |
| `or_index` | OR(hn eq X, ward eq W_RARE): index leaves only | 6.9 | 10.5 | 14.3 | 50 | 1,569 | 2,313 | 0 | 1.12 | formdev_record_pkey, formdev_ri_text_live | 51/51 | - | **PASS** |
| `or_meta_index` | OR($subject_id eq X, ward eq W_RARE): metadata + index leaf | 5.7 | 7.7 | 9.0 | 50 | 1,000,081 | 93,366 | 0 | 490.33 | formdev_record_ingest, formdev_record_pkey, formdev_ri_text_live | 51/51 | - | **PASS** |
| `not_fall` | NOT(fall_risk eq no) | 2.3 | 3.2 | 3.3 | 50 | 574 | 1,534 | 0 | 0.70 | formdev_record_index_pkey, formdev_record_ingest, formdev_record_pkey | 51/51 | - | **PASS** |
| `isnull_age` | age is_null (25% missing) | 1.9 | 2.3 | 2.3 | 50 | 452 | 1,173 | 0 | 0.50 | formdev_record_index_pkey, formdev_record_ingest, formdev_record_pkey | 51/51 | - | **PASS** |
| `prefix_hn` | prefix on hn 'HN00012' (~1000 matches) | 5.1 | 7.6 | 7.6 | 50 | 1,935 | 4,328 | 0 | 1.68 | formdev_record_pkey, formdev_ri_text_live | 51/51 | - | **PASS** |
| `dt_month` | assessed_at in March 2025 (one month, old) | 110.1 | 135.7 | 261.6 | 50 | 1,483,699 | 3,760,020 | 0 | 4,936.74 | formdev_record_index_pkey, formdev_record_ingest, formdev_record_pkey | 51/51 | - | **PASS** |
| `nofilter_p1` | no filter, page 1 | 1.7 | 2.0 | 2.2 | 50 | 103 | 211 | 0 | 0.11 | formdev_record_ingest, formdev_record_pkey | 51/51 | - | **PASS** |
| `nofilter_deep` | no filter, keyset page at the middle of the form | 1.7 | 2.0 | 2.0 | 50 | 102 | 212 | 0 | 0.11 | formdev_record_ingest, formdev_record_pkey | 51/51 | - | **PASS** |
| `offset0` | ward eq W_BIG, offset 0 | 2.9 | 3.1 | 3.3 | 50 | 380 | 1,041 | 0 | 0.48 | formdev_record_index_pkey, formdev_record_ingest, formdev_record_pkey | 51/51 | - | **PASS** |
| `offset10000` | ward eq W_BIG, offset 10000 | 172.1 | 210.3 | 241.3 | 50 | 66,981 | 169,909 | 0 | 173.62 | formdev_record_index_pkey, formdev_record_ingest, formdev_record_pkey | 51/51 | - | **PASS** |
| `sort_age_off0` | sort by age asc (field sort), offset 0 | 22.0 | 26.1 | 27.0 | 50 | 15,561 | 30,788 | 0 | 20.57 | formdev_record_index_pkey, formdev_record_pkey, formdev_ri_num_live | 51/51 | - | **PASS** |
| `sort_age_off5000` | sort by age asc, offset 5000 | 178.5 | 253.0 | 270.9 | 50 | 75,680 | 107,795 | 0 | 168.59 | formdev_record_index_pkey, formdev_record_pkey, formdev_ri_num_live | 51/51 | - | **PASS** |
| `count_capped` | ward eq W_BIG + capped count (cap 10000) | 67.2 | 125.4 | 258.6 | 50 | 380 | 1,041 | 0 | 1.04 | formdev_record_index_pkey, formdev_record_ingest, formdev_record_pkey | 51/51 | - | **PASS** |
| `relation_p1` | perf_with_patient: hn, ward, patient.name; ward eq W05; page of 50 | 12.4 | 22.5 | 31.7 | 50 | 2,440 | 6,276 | 0 | 3.18 | formdev_record_index_pkey, formdev_record_ingest, formdev_record_pkey | 51/51 | - | **PASS** |
| `agg_month_ward` | interactive aggregate: count by ward, one month (probe <= 50000) | - | - | - | - (full_scan_requires_job after 255.4 ms) | 168,239 | 379,081 | 0 | 899.60 | formdev_record_index_pkey, formdev_record_pkey, formdev_ri_num_live | 200/19 | answered, p95_lt_300ms, top_estimate_within_10x | **FAIL** |
| `agg_month_ward_fall` | interactive aggregate: by ward+fall_risk avg(age), one month | 629.2 | 780.3 | 836.1 | 38 | 210,313 | 388,463 | 0 | 652.12 | formdev_record_index_pkey, formdev_record_pkey, formdev_ri_num_live | 1,001/38 | p95_lt_300ms, top_estimate_within_10x | **FAIL** |
| `agg_all_ward` | aggregate over the whole form: interactive must refuse (job) | - | - | - | - (full_scan_requires_job after 11.2 ms) | 60,072 | 1,031 | 0 | 9.65 | formdev_record_status_recent | 1/1 | - | **PASS** |

### PostgreSQL interactive cases: 1m-churn

_no results for 1m-churn_

### Jobs

| Dataset | Job | Status | Rows | Elapsed s | Rows/s | Result bytes | tracemalloc peak | ru_maxrss after | Failed checks | Result |
|---|---|---|---|---|---|---|---|---|---|---|
| 100k | `job_agg_ward` | PASS / job aggregate | 20 | 0.18 | 110 | 595 | - | 47,252 KB | - | **PASS** |
| 100k | `job_agg_ward_fall_avg_age` | PASS / job aggregate | 40 | 0.22 | 183 | 3,114 | - | 47,252 KB | - | **PASS** |
| 100k | `job_export_csv` | PASS / job export | 99,020 | 1.89 | 52,307 | 23,633,880 | 4.49 MB | 53,412 KB | - | **PASS** |
| 300k | `job_agg_ward` | PASS / job aggregate | 20 | 0.67 | 30 | 600 | - | 47,060 KB | - | **PASS** |
| 300k | `job_agg_ward_fall_avg_age` | PASS / job aggregate | 40 | 0.67 | 59 | 3,141 | - | 47,060 KB | - | **PASS** |
| 300k | `job_export_csv` | PASS / job export | 100,000 | 2.3 | 43,401 | 23,820,316 | 4.59 MB | 54,228 KB | - | **PASS** |
| 1m | `job_agg_ward` | PASS / job aggregate | 20 | 2.44 | 8 | 615 | - | 48,028 KB | - | **PASS** |
| 1m | `job_agg_ward_fall_avg_age` | PASS / job aggregate | 40 | 2.92 | 14 | 3,164 | - | 48,028 KB | - | **PASS** |
| 1m | `job_export_csv` | PASS / job export | 100,000 | 2.66 | 37,556 | 25,136,459 | 4.57 MB | 54,812 KB | - | **PASS** |

### SQLite 100k

SQLite 3.46.1, file database (WAL), 160,100 records / 919,808 index rows inserted with executemany in 13.62 s (79,272 rows/s), file 395.0 MB.

| Case | p50 | p95 | max | Rows | Indexes (EXPLAIN QUERY PLAN) | Plan | Failed checks | Result |
|---|---|---|---|---|---|---|---|---|
| `eq_hn` | 219.6 | 575.0 | 756.6 | 15 | formdev_record_ingest, sqlite_autoindex_formdev_record_1, sqlite_autoindex_formdev_record_index_1 | CO-ROUTINE page; SEARCH k USING INDEX formdev_record_ingest (form_id=?); CORRELATED SCALAR SUBQUERY 1; SEARCH i1 USING INDEX sqlite_autoindex_formdev_record_index_1 (record_id=? AND field_id=?); SCAN page; SEARCH r USING INDEX sqlite_autoindex_formdev_record_1 (record_id=?); USE TEMP B-TREE FOR ORDER BY | p95_lt_300ms | **FAIL** |
| `eq_wbig_p1` | 1.8 | 2.6 | 3.0 | 50 | formdev_record_ingest, sqlite_autoindex_formdev_record_1, sqlite_autoindex_formdev_record_index_1 | CO-ROUTINE page; SEARCH k USING INDEX formdev_record_ingest (form_id=?); CORRELATED SCALAR SUBQUERY 1; SEARCH i1 USING INDEX sqlite_autoindex_formdev_record_index_1 (record_id=? AND field_id=?); SCAN page; SEARCH r USING INDEX sqlite_autoindex_formdev_record_1 (record_id=?); USE TEMP B-TREE FOR ORDER BY | - | **PASS** |
| `eq_wbig_deep` | 1.1 | 2.3 | 2.4 | 50 | formdev_record_ingest, sqlite_autoindex_formdev_record_1, sqlite_autoindex_formdev_record_index_1 | CO-ROUTINE page; SEARCH k USING INDEX formdev_record_ingest (form_id=? AND ingest_seq<?); CORRELATED SCALAR SUBQUERY 1; SEARCH i1 USING INDEX sqlite_autoindex_formdev_record_index_1 (record_id=? AND field_id=?); SCAN page; SEARCH r USING INDEX sqlite_autoindex_formdev_record_1 (record_id=?); USE TEMP B-TREE FOR ORDER BY | - | **PASS** |
| `and_age_fall` | 4.2 | 6.3 | 7.5 | 50 | formdev_record_ingest, sqlite_autoindex_formdev_record_1, sqlite_autoindex_formdev_record_index_1 | CO-ROUTINE page; SEARCH k USING INDEX formdev_record_ingest (form_id=?); CORRELATED SCALAR SUBQUERY 1; SEARCH i1 USING INDEX sqlite_autoindex_formdev_record_index_1 (record_id=? AND field_id=?); CORRELATED SCALAR SUBQUERY 2; SEARCH i2 USING INDEX sqlite_autoindex_formdev_record_index_1 (record_id=? AND field_id=?); SCAN page; SEARCH r USING INDEX sqlite_autoindex_formdev_record_1 (record_id=?); USE TEMP B-TREE FOR ORDER BY | - | **PASS** |
| `dt_month` | 164.8 | 257.6 | 269.5 | 50 | formdev_record_ingest, sqlite_autoindex_formdev_record_1, sqlite_autoindex_formdev_record_index_1 | CO-ROUTINE page; SEARCH k USING INDEX formdev_record_ingest (form_id=?); CORRELATED SCALAR SUBQUERY 1; SEARCH i1 USING INDEX sqlite_autoindex_formdev_record_index_1 (record_id=? AND field_id=?); SCAN page; SEARCH r USING INDEX sqlite_autoindex_formdev_record_1 (record_id=?); USE TEMP B-TREE FOR ORDER BY | - | **PASS** |
| `nofilter_p1` | 0.7 | 0.9 | 1.1 | 50 | formdev_record_ingest, sqlite_autoindex_formdev_record_1 | CO-ROUTINE page; SEARCH k USING INDEX formdev_record_ingest (form_id=?); SCAN page; SEARCH r USING INDEX sqlite_autoindex_formdev_record_1 (record_id=?); USE TEMP B-TREE FOR ORDER BY | - | **PASS** |
| `nofilter_deep` | 0.7 | 0.7 | 0.7 | 50 | formdev_record_ingest, sqlite_autoindex_formdev_record_1 | CO-ROUTINE page; SEARCH k USING INDEX formdev_record_ingest (form_id=? AND ingest_seq<?); SCAN page; SEARCH r USING INDEX sqlite_autoindex_formdev_record_1 (record_id=?); USE TEMP B-TREE FOR ORDER BY | - | **PASS** |
| `agg_month_ward` | 447.0 | 514.3 | 522.5 | 19 (full_scan_requires_job after 251.6 ms) | formdev_record_status_recent, sqlite_autoindex_formdev_record_index_1 | CO-ROUTINE q; CO-ROUTINE p; SEARCH k USING COVERING INDEX formdev_record_status_recent (form_id=?); CORRELATED SCALAR SUBQUERY 1; SEARCH i1 USING INDEX sqlite_autoindex_formdev_record_index_1 (record_id=? AND field_id=?); SEARCH x USING INDEX sqlite_autoindex_formdev_record_index_1 (record_id=? AND field_id=?) LEFT-JOIN; USE TEMP B-TREE FOR GROUP BY; SCAN p; USE TEMP B-TREE FOR GROUP BY; SCAN q; USE TEMP B-TREE FOR ORDER BY | answered, p95_lt_300ms | **FAIL** |
| `job_agg_ward` (job) | 0.27 s | | | 20 groups, total 99,020 | | | - | **PASS** |

