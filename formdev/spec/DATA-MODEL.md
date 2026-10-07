# FormDev data model (Phase 3.1, 3.2, 3.11)

## Conceptual model

| Concept | Meaning | Storage |
| --- | --- | --- |
| Form Definition | Identity of a form (`form_id`, title, latest/published pointers) | `formdev_form` |
| Schema Version | One immutable-after-publish version of the definition (`flora.form/1` JSON) | `formdev_schema_version` |
| Form Record | One filled form: metadata columns + data | `formdev_record` |
| Form Value | The field values of a record, keyed by field id | `formdev_record.data` (JSON) and every revision |
| Form Index | Copies of values of fields marked `indexed: true` | `formdev_record_index` |

Supporting tables: `formdev_record_revision` (every version of every record),
`formdev_sync_receipt` (idempotency), `formdev_conflict` (conflict log), `formdev_asset`,
`formdev_attachment` (file / image field content addressed by SHA-256: `sha256`, `media_type`, `size`, `content`,
`created_at`, `created_by`; PostgreSQL `0064-formdev-attachment.sql`, SQLite migration 5; or a directory with
`FORMDEV_ATTACHMENT_DIR`), `formdev_style`, `formdev_font` (registries), `formdev_lookup` (Phase 2.3 lookup tables:
`lookup_id`, `version`, `metadata`, `entries`, `updated_at`, `updated_by`; PostgreSQL
[`0063-formdev-lookup.sql`](../../infrastructure/postgres/0063-formdev-lookup.sql), SQLite migration 4, both
generated from `formdev/registry/lookups/*.json` by `sync_registry_seed.py`).

The same schema exists for PostgreSQL ([`0060-formdev.sql`](../../infrastructure/postgres/0060-formdev.sql))
and SQLite ([`sqlite_schema.sql`](../../services/flora-api/app/formdev/adapters/sqlite_schema.sql)).
JSON columns are `jsonb` in PostgreSQL and `TEXT` in SQLite; nothing above the adapter depends on either.

Record data is keyed by field **key** (Phase 1; the key defaults to the field id, so data written before
Phase 1 is unchanged). Group children are stored at the top level; a repeat stores a list of item objects
keyed by its children's keys. The record index, query catalog, policies and migrations all use keys.
Format reference: [FORM-SCHEMA.md](FORM-SCHEMA.md).

## Record metadata

| Column | Purpose |
| --- | --- |
| `record_id` | Client-generated id (UUID) so records can be created offline |
| `form_id`, `schema_version` | The exact definition version the data conforms to (FK) |
| `status` | `draft` → `submitted` (amendable) → `deleted` (soft delete) |
| `created_at`, `created_by` | First edit time and author |
| `updated_at`, `updated_by` | Last edit time (client edit time for synced edits, clamped to server time + 5 min) |
| `sync_id` | `op_id` of the sync operation that produced the current version (`formpack` for seeds) |
| `version` | Optimistic concurrency counter, +1 per write; writes must name the version they edited |

## Hybrid storage (3.2)

- Metadata are ordinary columns with B-tree indexes:
  `(form_id, updated_at DESC, record_id DESC)` and `(form_id, status, updated_at DESC, record_id DESC)`
  serve lists and keyset pagination.
- Field values are one JSON document per record (`data`), so a new form version never needs DDL.
- Fields a definition marks `indexed: true` are copied into `formdev_record_index`
  (`value_text` with C collation, or `value_num`) inside the same transaction as the record write.
  Filters join this table through `(form_id, field_id, value_*)` indexes; they never scan JSON.
  Filtering on a field that is not indexed is refused (`field_not_indexed`) instead of falling back to a scan.
- At most 16 indexed fields per form, and only scalar types (`text`, `number`, `integer`, `date`,
  `datetime`, `time`, `select`, `checkbox`). Every index costs a row per record on write, so only fields
  that are actually filtered should be indexed (Phase 4 will derive this from query usage).

## Lifecycle rules

- A form starts as draft v1. Records can only be created against **published** versions.
- Published (and archived) versions are immutable: enforced by `SchemaRepository` and by database triggers
  in both vendors (update of definition/checksum, return to draft, or delete is aborted).
- `checksum` is the SHA-256 of the canonical JSON (sorted keys) of the definition.
- Hidden fields (`hidden: true`) are not rendered but their values are stored and validated like any other.
- Delete is a soft delete; every revision remains in `formdev_record_revision`.

## Migration strategy (3.11)

A version `v >= 2` may declare how records of `v - 1` map onto it:

```json
"migration": { "from": 1, "ops": [
  { "op": "rename_field", "from": "bp", "to": "bp_sys" },
  { "op": "convert_type", "field": "weight_kg", "to": "number" },
  { "op": "map_values", "field": "fall_risk_level", "mapping": { "yes": "high", "no": "low" } },
  { "op": "remove_field", "field": "smoker" },
  { "op": "add_field", "field": "pain_score", "default": null }
]}
```

- **Never destructive**: `remove_field` and failed conversions move the old value into `data._retired`.
- **Read-time**: `GET /records/{id}?as_version=N` returns a migrated view; storage is not rewritten.
- **Persisted upgrade**: `POST /records/{id}/upgrade` writes a new version with `schema_version = N`;
  the previous revision (old schema, old data) stays in the revision table.
- **Publish guard**: publishing `v` fails with `migration_incomplete` if a field of `v - 1` disappears without
  `rename_field`/`remove_field`, or changes value family (text/number/boolean) without `convert_type`.
- Chains run step by step (v1 → v2 → v3). Downgrades are refused.
- Python ([`migration.py`](../../services/flora-api/app/formdev/migration.py)) and TypeScript
  ([`migrate.ts`](../../frontend/src/formdev/core/migrate.ts)) implement identical rules, proven by
  [`fixtures/migration-cases.json`](fixtures/migration-cases.json).

## Phase 4 additions (`0061-formdev-query.sql`, `0061b-formdev-query-indexes.sql`, SQLite migration 2)

| Change | Why |
| --- | --- |
| `formdev_record.subject_id` | Patient/subject key from `extensions["flora.subject_field"]` of the latest version |
| `formdev_record.ingest_seq`, `ingested_at` | Server-assigned, commit-ordered per-form sequence and receive time. `created_at`/`updated_at` are client edit times; jobs and stable cursors use the ingest order |
| `formdev_record_index.status`, `updated_at` | Copied from the record so filtered keyset pages and single-field aggregates are served by the index table alone |
| `formdev_ri_text_live`, `formdev_ri_num_live` | Partial indexes `(form_id, field_id, value, updated_at DESC, record_id DESC) WHERE value IS NOT NULL AND status <> 'deleted'`; replace the Phase 3 index pair |
| `formdev_record_ingest`, `formdev_record_created`, `formdev_record_subject` | Ingest-order keyset, `$created_at` cursor, per-form subject lookups |
| Extended statistics on `(form_id, field_id, value_*)`, statistics target 1000, aggressive autovacuum | The EAV value domain depends on the field; estimates must not assume independence |
| `formdev_data_version` | Per-form change counter: cache invalidation and the source of `ingest_seq` |
| `formdev_form_policy`, `formdev_source` | Access policies and named sources (relations, narrowing) |
| `formdev_index_config`, `formdev_index_coverage` | Server-side indexed fields and per-field index readiness |
| `formdev_query`, `formdev_query_stat`, `formdev_query_audit` | Saved queries, usage statistics by shape, audit trail |
| `formdev_job` | Background jobs with fenced leases and checkpoints |
| RBAC permissions | `formdev.query`, `formdev.export`, `formdev.diagnostics`, `formdev.manage` |

**Index rows follow the latest published version.** A record's index rows and `subject_id` are
computed from the form's latest published definition applied to the record's data migrated to that
version (plus server-side indexed fields). A v1 record is therefore found by a field that was renamed
or newly indexed in v2. Publishing (or changing the index configuration) reindexes the affected
fields: inline for forms up to 5 000 records, otherwise as a `reindex` job while the validator
refuses those fields with `index_building`. Reindexing never changes a record's version or times.

**Datetimes** are indexed both as text and as epoch milliseconds (`value_num`), so ranges and sorts
compare instants; values without an offset use +07:00 (Asia/Bangkok).

**Calculated** fields can be indexed (numeric). Multiselect and textarea fields cannot.
