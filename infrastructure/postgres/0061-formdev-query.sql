-- FormDev Phase 4: query engine storage (transactional part).
-- Large-table indexes are created CONCURRENTLY in 0061b-formdev-query-indexes.sql.
-- Idempotent: safe to apply to databases that already ran it.
BEGIN;

-- Records: patient/subject key (definition extensions["flora.subject_field"]) and server-side
-- ingest order. created_at/updated_at are client edit times; ingest_seq (per-form, assigned at
-- insert from formdev_data_version, commit-ordered) and ingested_at (server clock) are not.
ALTER TABLE formdev_record ADD COLUMN IF NOT EXISTS subject_id text;
ALTER TABLE formdev_record ADD COLUMN IF NOT EXISTS ingest_seq bigint;
ALTER TABLE formdev_record ADD COLUMN IF NOT EXISTS ingested_at bigint;
UPDATE formdev_record r SET ingest_seq = ordered.seq, ingested_at = r.created_at
FROM (SELECT record_id, row_number() OVER (PARTITION BY form_id ORDER BY created_at, record_id) AS seq FROM formdev_record) ordered
WHERE ordered.record_id = r.record_id AND r.ingest_seq IS NULL;
ALTER TABLE formdev_record ALTER COLUMN ingest_seq SET NOT NULL;
ALTER TABLE formdev_record ALTER COLUMN ingested_at SET NOT NULL;

-- Index rows carry the record's status and updated_at so filtered keyset pages (default sort)
-- and single-field aggregates are served from the index table alone (partial "live" indexes).
ALTER TABLE formdev_record_index ADD COLUMN IF NOT EXISTS status text;
ALTER TABLE formdev_record_index ADD COLUMN IF NOT EXISTS updated_at bigint;
UPDATE formdev_record_index i SET status = r.status, updated_at = r.updated_at
FROM formdev_record r
WHERE r.record_id = i.record_id AND (i.status IS NULL OR i.updated_at IS NULL);
ALTER TABLE formdev_record_index ALTER COLUMN status SET NOT NULL;
ALTER TABLE formdev_record_index ALTER COLUMN updated_at SET NOT NULL;

-- Planner statistics for the EAV index table: field_id and the value domain are correlated.
ALTER TABLE formdev_record_index ALTER COLUMN field_id SET STATISTICS 1000;
ALTER TABLE formdev_record_index ALTER COLUMN value_text SET STATISTICS 1000;
ALTER TABLE formdev_record_index ALTER COLUMN value_num SET STATISTICS 1000;
CREATE STATISTICS IF NOT EXISTS formdev_ri_text_st (mcv, dependencies, ndistinct) ON form_id, field_id, value_text FROM formdev_record_index;
CREATE STATISTICS IF NOT EXISTS formdev_ri_num_st (mcv, dependencies, ndistinct) ON form_id, field_id, value_num FROM formdev_record_index;
-- Every record write rewrites its index rows; vacuum often so index-only scans stay index-only.
ALTER TABLE formdev_record_index SET (autovacuum_vacuum_scale_factor = 0.01, autovacuum_vacuum_insert_scale_factor = 0.01, autovacuum_analyze_scale_factor = 0.02);

-- Per-form change counter: bumped (upsert) by every record write and catalog change. It
-- invalidates query caches and hands out ingest_seq values to new records.
CREATE TABLE IF NOT EXISTS formdev_data_version (
  form_id text PRIMARY KEY,
  version bigint NOT NULL DEFAULT 0,
  updated_at bigint NOT NULL
) WITH (fillfactor = 50);
INSERT INTO formdev_data_version (form_id, version, updated_at)
SELECT f.form_id, COALESCE((SELECT max(r.ingest_seq) FROM formdev_record r WHERE r.form_id = f.form_id), 0) + 1, 0
FROM formdev_form f ON CONFLICT (form_id) DO NOTHING;

-- Access policy per form: who may query/export, and per-field role/permission allow-lists.
CREATE TABLE IF NOT EXISTS formdev_form_policy (
  form_id text PRIMARY KEY REFERENCES formdev_form(form_id),
  policy jsonb NOT NULL,
  version integer NOT NULL CHECK (version > 0),
  updated_at bigint NOT NULL,
  updated_by text NOT NULL
);

-- Named query sources: relations (many-to-one lookups) and policy narrowing.
CREATE TABLE IF NOT EXISTS formdev_source (
  source_id text PRIMARY KEY CHECK (source_id ~ '^[a-z][a-z0-9_]{1,63}$'),
  form_id text NOT NULL REFERENCES formdev_form(form_id),
  config jsonb NOT NULL,
  version integer NOT NULL CHECK (version > 0),
  updated_at bigint NOT NULL,
  updated_by text NOT NULL
);

-- Extra indexed fields chosen by administrators (index advisor "apply"); no schema publish needed.
CREATE TABLE IF NOT EXISTS formdev_index_config (
  form_id text NOT NULL REFERENCES formdev_form(form_id),
  field_id text NOT NULL,
  created_at bigint NOT NULL,
  created_by text NOT NULL,
  PRIMARY KEY (form_id, field_id)
);

-- Per field: is the record index complete for it? Filters on 'building' fields are refused.
CREATE TABLE IF NOT EXISTS formdev_index_coverage (
  form_id text NOT NULL REFERENCES formdev_form(form_id),
  field_id text NOT NULL,
  origin text NOT NULL CHECK (origin IN ('definition', 'config')),
  state text NOT NULL CHECK (state IN ('ready', 'building')),
  schema_version integer NOT NULL,
  updated_at bigint NOT NULL,
  PRIMARY KEY (form_id, field_id)
);

-- Saved query definitions (flora.query/1), addressed by query_id.
CREATE TABLE IF NOT EXISTS formdev_query (
  query_id text PRIMARY KEY CHECK (query_id ~ '^[a-z][a-z0-9_]{1,63}$'),
  definition jsonb NOT NULL,
  owner_user_id bigint,
  owner text NOT NULL,
  created_at bigint NOT NULL,
  updated_at bigint NOT NULL
);

-- Query usage by shape (no values), flushed in batches; input for the index advisor.
CREATE TABLE IF NOT EXISTS formdev_query_stat (
  fingerprint text PRIMARY KEY,
  source_id text NOT NULL,
  shape jsonb NOT NULL,
  runs bigint NOT NULL DEFAULT 0,
  ok bigint NOT NULL DEFAULT 0,
  timeouts bigint NOT NULL DEFAULT 0,
  rejected bigint NOT NULL DEFAULT 0,
  total_ms bigint NOT NULL DEFAULT 0,
  max_ms bigint NOT NULL DEFAULT 0,
  rows_returned bigint NOT NULL DEFAULT 0,
  first_run_at bigint NOT NULL,
  last_run_at bigint NOT NULL
);

-- Background jobs (export, report, aggregate, large search, reindex) with fenced leases.
CREATE TABLE IF NOT EXISTS formdev_job (
  job_id text PRIMARY KEY,
  kind text NOT NULL CHECK (kind IN ('export', 'search', 'aggregate', 'report', 'reindex')),
  status text NOT NULL CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'cancelled', 'expired')),
  query jsonb,
  format text NOT NULL,
  owner_user_id bigint,
  owner text NOT NULL,
  rows_processed bigint NOT NULL DEFAULT 0,
  total_estimate bigint,
  checkpoint jsonb,
  result_bytes bigint NOT NULL DEFAULT 0,
  result_sha256 text,
  error jsonb,
  attempt integer NOT NULL DEFAULT 0,
  max_attempts integer NOT NULL DEFAULT 3,
  lease_owner text,
  lease_expires_at bigint,
  cancel_requested integer NOT NULL DEFAULT 0 CHECK (cancel_requested IN (0, 1)),
  created_at bigint NOT NULL,
  started_at bigint,
  heartbeat_at bigint,
  finished_at bigint,
  expires_at bigint
);
CREATE INDEX IF NOT EXISTS formdev_job_queue ON formdev_job (status, created_at);
CREATE INDEX IF NOT EXISTS formdev_job_owner ON formdev_job (owner_user_id, status, created_at DESC);

-- Audit of bulk access to patient data (job creation/download, sensitive-field queries, denials).
-- Never stores filter values.
CREATE TABLE IF NOT EXISTS formdev_query_audit (
  audit_id text PRIMARY KEY,
  at bigint NOT NULL,
  actor_user_id bigint,
  actor text NOT NULL,
  actor_roles jsonb NOT NULL,
  action text NOT NULL CHECK (action IN ('query', 'job_create', 'job_download', 'job_cancel', 'diagnostics', 'denied')),
  source_id text,
  fingerprint text,
  fields jsonb NOT NULL DEFAULT '[]'::jsonb,
  filter_fields jsonb NOT NULL DEFAULT '[]'::jsonb,
  row_count bigint,
  job_id text,
  result_sha256 text,
  client_ip text
);
CREATE INDEX IF NOT EXISTS formdev_query_audit_at ON formdev_query_audit (at DESC);

-- Permissions (only where the Flora RBAC tables exist).
DO $$
BEGIN
  IF to_regclass('public.auth_permission') IS NOT NULL THEN
    INSERT INTO auth_permission (code, display_name, category, risk_level, created_at, updated_at) VALUES
      ('formdev.query', 'Query form records', 'FormDev', 'sensitive', 0, 0),
      ('formdev.export', 'Export form records and run reports', 'FormDev', 'high', 0, 0),
      ('formdev.diagnostics', 'View query plans and diagnostics', 'FormDev', 'high', 0, 0),
      ('formdev.manage', 'Manage FormDev sources, policies and indexes', 'FormDev', 'high', 0, 0)
    ON CONFLICT (code) DO NOTHING;
    INSERT INTO auth_role_permission (role_code, permission_code, created_at)
    SELECT grant_row.role_code, grant_row.permission_code, 0
    FROM (VALUES
      ('system_admin', 'formdev.query'), ('system_admin', 'formdev.export'),
      ('system_admin', 'formdev.diagnostics'), ('system_admin', 'formdev.manage'),
      ('clinical_admin', 'formdev.query'), ('clinical_admin', 'formdev.export'), ('clinical_admin', 'formdev.manage'),
      ('clinician', 'formdev.query'),
      ('viewer', 'formdev.query')
    ) AS grant_row(role_code, permission_code)
    WHERE EXISTS (SELECT 1 FROM auth_role role WHERE role.code = grant_row.role_code)
    ON CONFLICT DO NOTHING;
  END IF;
END $$;

GRANT SELECT, INSERT, UPDATE, DELETE ON formdev_job, formdev_query_stat, formdev_query, formdev_source, formdev_index_config TO flora_view, flora_app;
GRANT SELECT, INSERT, UPDATE ON formdev_data_version, formdev_form_policy, formdev_index_coverage TO flora_view, flora_app;
GRANT SELECT, INSERT ON formdev_query_audit TO flora_view, flora_app;

COMMIT;
