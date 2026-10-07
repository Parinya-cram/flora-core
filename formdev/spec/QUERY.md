# FormDev query specification (`flora.query/1`, Phase 4)

Queries are JSON documents. The UI and other clients never send SQL: the server validates the
document, turns it into a vendor-free plan and the storage adapter compiles that plan into
parameterized SQL. JSON Schema: [`query.schema.json`](query.schema.json). Limits:
[`query-policy.json`](query-policy.json). Validator twins: `services/flora-api/app/formdev/query/validator.py`
and `frontend/src/formdev/query/validate.ts`, kept identical by [`fixtures/query-cases.json`](fixtures/query-cases.json).

## Document

```json
{ "format": "flora.query/1",
  "query": {
    "id": "patient_list",
    "source": "patient_assessment",
    "select": ["hn", "age", "$status", "patient.full_name"],
    "filter": { "and": [ { "field": "fall_risk", "op": "eq", "value": "yes" },
                         { "or": [ { "field": "age", "op": "gte", "value": 65 }, { "field": "$status", "op": "eq", "value": "draft" } ] } ] },
    "sort": [ { "field": "$ingested_at", "dir": "desc" } ],
    "pagination": { "mode": "cursor", "limit": 50, "cursor": "<from the previous page>" },
    "count": "capped",
    "timeout": 5000,
    "cache": { "ttl": 30 },
    "export": { "format": "csv", "headers": "ids", "max_rows": 100000 } } }
```

| Key | Meaning |
| --- | --- |
| `format` | Optional; `flora.query/1` |
| `query.id` (`query_id`) | Name for saved queries and statistics |
| `source` | A published form id or a named source (`formdev_source`) |
| `select` | Required for lists; explicit fields only (`*` is refused) |
| `filter` | `and` / `or` / `not` groups and leaves `{field, op, value}` |
| `sort` | One key; the record id always breaks ties |
| `pagination` | `cursor` (default, stable) or `offset`; `limit` is required (top-level `limit` is an alias) |
| `group`, `aggregate` | Grouped/aggregate queries (see below) |
| `count` | `none` (default) or `capped`: total up to `count_cap`, flagged as a lower bound beyond it |
| `timeout` | Milliseconds, clamped to the policy maximum |
| `cache` | `false` or `{ttl: seconds}`; clamped to the policy maximum |
| `export` | Used by export jobs: `csv` / `jsonl` / `json`, header style, row cap |

Names: plain names are form field ids; `$name` (or a bare name that is not a field) is a metadata
column: `$record_id`, `$status`, `$schema_version`, `$version`, `$created_at`, `$updated_at`,
`$ingested_at` (server receive time, ordered by the per-form ingest sequence), `$created_by`,
`$updated_by`, `$subject_id`. `relation.field` reads a field of a declared many-to-one relation
(select only).

## Filters

Operators by field family: text (`text`, `select`, `date`, `time`): eq ne in lt lte gt gte between
prefix is_null is_not_null; numbers (`number`, `integer`, `calculated`): eq ne in lt lte gt gte between
is_null is_not_null; `datetime` (values are ISO datetimes, compared as instants): the numeric
operators; `checkbox`: eq ne is_null is_not_null; metadata columns: see the validator tables.
`textarea` and `multiselect` fields cannot be filtered. A dynamic field must be indexed and its
index must be ready (`index_building` otherwise).

Semantics — "missing" means the record has no value for the field:

| Filter | Matches |
| --- | --- |
| `eq`, `lt` … `prefix`, `in`, `between` | records with a value that matches |
| `ne` | records with a value that differs (missing is not "ne") |
| `not F` | every record for which F is false, including records missing the field |
| `is_null` / `is_not_null` | missing / has a value |

`prefix` is case-sensitive on every vendor. Soft-deleted records are always excluded for
non-administrators; administrators see them only when they filter on `$status`.

## Results

List queries return `{rows, next_cursor, has_more, truncated, next_offset?, total?, total_is_lower_bound?,
warnings, diagnostics}`. Every row has `$record_id` plus the selected names. Values are migrated to the
form's latest published version (renamed fields, converted types, mapped values), so records saved
under older versions read like new ones; stored data is never rewritten by a query.

**Projection.** The SQL first selects only keys for the page, then fetches `data` for at most
`limit + 1` rows, because schema-version migration needs the whole stored object; the engine then
returns only the selected names. `data` is never returned wholesale.

## Pagination and cursors

- Cursor keys: `$ingested_at` (default), `$created_at`, `$record_id` — stable; `$updated_at` is allowed
  with a `cursor_not_snapshot_stable` warning (a record edited while paging can move). Each record
  that does not change while paging appears exactly once.
- Cursors are signed (HMAC), bound to the query shape and values, the user and a 1-hour expiry, and
  type-checked before use; a changed, forged, foreign or expired cursor is `invalid_cursor` (400).
- Offset pagination accepts sorting by an indexed field (missing values last); `offset` ≤ `max_offset`.
- SQL keyset predicates are `col <= v AND (col, record_id) < (v, id)`: an index range start, not a filter.

## Grouped and aggregate queries

`group`: up to 3 keys — indexed text/number/checkbox fields, `$status`, `$schema_version`,
`$created_by`, `$updated_by`, or `{field: "$created_at" | "$updated_at" | "$ingested_at", bucket: "day",
tz_offset_minutes}`. `aggregate`: `count` (optionally of a field: non-null count), `sum`, `avg`, `min`,
`max` over indexed numeric fields (`min`/`max` also datetimes). Aliases (`as`) are lower_snake_case
and unique; SQL uses generated aliases only. `select` may list only group keys and aliases; `sort`
only those names; pagination is offset (or none, up to `max_groups`). Interactive aggregates covering
more than `interactive_aggregate_max_rows` records (capped count probe) are refused with
`full_scan_requires_job`: run them as `aggregate` or `report` jobs.

## Limits (query-policy.json)

Rows per page 500 · offset 10 000 · select 40 fields · filter depth 4, 32 conditions, 8 indexed
conditions per `and`, 500 `in` values, 2 000 values in total · text values 1 000 characters ·
timeout 5 s default, 15 s maximum · result 2 MB · cache TTL 30 s default, 300 s maximum ·
request body 64 KB · rate 60 queries/min per user (burst 20) · 2 concurrent queries per user, 4 per
process · jobs: 3 open per user, 20 in total, 1 000-row batches, 30 s per batch, 5 min per aggregate,
30 min per job, 512 MB per result, results kept 24 h · export rows: 100 000, 1 000 000 for `formdev.manage`.

## Execution safeguards

- PostgreSQL sessions are `READ ONLY` with `statement_timeout`, `transaction_timeout` (PG 17),
  `plan_cache_mode = force_custom_plan`, JIT off and no parallel workers for interactive queries;
  statements are sent with `prepare=False`. SQLite reads use a private read-only connection with a
  progress-handler deadline.
- On timeout the database cancels the statement, the transaction rolls back, the connection returns
  clean to the pool, the event is logged with the query fingerprint only, and the caller gets
  `query_timeout` (504) with a hint. Driver errors become `query_failed` (500) without driver text.
- Rate and concurrency limits are checked before a connection is taken; pool waits are bounded
  (2 s → `database_busy`, 503).
- Cache keys combine the query, the page position, the caller's roles and permissions, the source's
  catalog revision (published versions, policy and source versions) and the per-form change counters
  read inside the query's own transaction. Any write, publish or policy change invalidates them.

## Background jobs

`POST /api/formdev/jobs {kind, format?, body}` — kinds `export` (csv, jsonl), `search` (jsonl),
`aggregate` (json), `report` (csv, json); `reindex` is internal. Lifecycle:
`queued → running → succeeded | failed | cancelled`, then `expired` after 24 h. Workers hold fenced
leases (`lease_owner` + `attempt`), checkpoint every batch, resume after a crash and return jobs to
the queue on shutdown. Exports iterate the immutable ingest order up to the boundary taken when the
job started: every record that existed then appears exactly once. Owners are re-checked when a job
is claimed and when it is downloaded; job creation and downloads are audited.

CSV dialect: UTF-8 with BOM, RFC 4180 quoting, CRLF, header row of names (`headers: labels` adds a
second row of labels), `true`/`false`, empty cell for null, multiselect values joined with `|`
(`|` and `\` escaped), cells starting with `= + - @ tab CR` prefixed with `'` (formula injection).

## Diagnostics

Every response: `execution_ms`, `rows_returned`, `cache_hit`, `query_type`, `fingerprint`.
With `explain=1` and the `formdev.diagnostics` permission: compiled SQL (placeholders only), index
names, node types, full-scan flag, estimated rows and — on PostgreSQL — rows scanned and buffers from
`EXPLAIN ANALYZE`. Conditions and filters are removed from plans because PostgreSQL prints bound
values inside them. Usage statistics are recorded by shape (no values) for the index advisor.

## Error codes

Validation issues are returned as `invalid_query` (422) with `details: [{path, code, message, severity}]`.

| Code | Meaning |
| --- | --- |
| `invalid_request` | Body is not `{query: {...}}` |
| `invalid_format` | Unknown `format` |
| `dangerous_operation` | Unknown key (raw SQL, unsupported clause), NUL byte, duplicate JSON key, excessive nesting |
| `unknown_source` | Source does not exist or the caller may not query it (the two are indistinguishable) |
| `missing_select` / `select_star_not_allowed` / `too_many_fields` | Projection rules |
| `invalid_field` | Unknown field (suggestions only name fields the caller may read) |
| `unauthorized_field` | The caller may not read a field used in select, filter, sort, group or aggregate |
| `not_filterable` | Field is not indexed or its type cannot be filtered/sorted/grouped |
| `index_building` | The field's index is being rebuilt |
| `invalid_filter` / `invalid_operator` / `invalid_value` / `too_many_values` / `filter_too_complex` | Filter rules |
| `deleted_requires_admin` | Querying deleted records |
| `invalid_sort` / `cursor_requires_stable_sort` | Sort rules |
| `missing_limit` / `limit_exceeded` / `offset_exceeded` / `invalid_pagination` / `invalid_cursor` | Pagination rules |
| `invalid_relation` | Unknown relation, or a relation field outside `select` |
| `aggregate_invalid` / `invalid_alias` / `too_many_groups` / `select_not_grouped` / `sort_not_grouped` / `cursor_not_supported_for_group` | Grouped queries |
| `invalid_timeout` / `invalid_cache` / `invalid_export` / `export_limit_exceeded` | Options |
| warnings: `missing_filter`, `cursor_not_snapshot_stable`, `timeout_clamped`, `cache_ttl_clamped` | Accepted, with a note |

Runtime errors:

| Code | HTTP | Meaning |
| --- | --- | --- |
| `invalid_query` | 422 | See `details` |
| `full_scan_requires_job` | 409 | Aggregate too large for interactive use |
| `result_too_large` | 422 | Result above `max_result_bytes` (interactive) or job byte limit |
| `query_timeout` | 504 | Time budget exceeded |
| `query_failed` | 500 | Database failure (no driver details) |
| `diagnostics_forbidden` | 403 | `explain` without `formdev.diagnostics` |
| `rate_limited` / `too_many_concurrent_queries` / `job_queue_full` | 429 | With `Retry-After` |
| `database_busy` / `jobs_unavailable` / `audit_unavailable` | 503 | Temporary |
| `body_too_large` | 413 | Body above 64 KB |
| `export_forbidden` / `forbidden` | 403 | Missing permission |
| `field_not_exportable` | 422 | An export selects a field whose `display.export` is false (Phase 1.4 display policy); `details.fields` lists them |
| `job_not_found` / `query_not_found` | 404 | Not found or not yours |
| `job_not_ready` | 409 | Still running |
| `job_expired` | 410 | Result removed or expired |
| `invalid_job`, `invalid_policy`, `invalid_source` | 400 | Bad administrative input |
| job failure codes | — | `owner_inactive`, `export_forbidden`, `query_timeout`, `result_too_large`, `disk_full`, `job_too_long`, `job_abandoned`, `job_error` |
