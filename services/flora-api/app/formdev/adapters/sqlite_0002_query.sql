-- FormDev Phase 4 (SQLite migration 2). Mirrors 0061-formdev-query.sql + 0061b.
ALTER TABLE formdev_record ADD COLUMN subject_id text;
ALTER TABLE formdev_record ADD COLUMN ingest_seq integer;
ALTER TABLE formdev_record ADD COLUMN ingested_at integer;
-- One window pass (SQLite 3.33+ UPDATE ... FROM), O(n log n): a correlated count per row was quadratic.
UPDATE formdev_record SET ingest_seq = numbered.seq, ingested_at = formdev_record.created_at
FROM (SELECT record_id, row_number() OVER (PARTITION BY form_id ORDER BY created_at, record_id) AS seq FROM formdev_record) AS numbered
WHERE numbered.record_id = formdev_record.record_id;

ALTER TABLE formdev_record_index ADD COLUMN status text;
ALTER TABLE formdev_record_index ADD COLUMN updated_at integer;
UPDATE formdev_record_index SET
  status = (SELECT r.status FROM formdev_record r WHERE r.record_id = formdev_record_index.record_id),
  updated_at = (SELECT r.updated_at FROM formdev_record r WHERE r.record_id = formdev_record_index.record_id);

CREATE TABLE IF NOT EXISTS formdev_data_version (
  form_id text PRIMARY KEY,
  version integer NOT NULL DEFAULT 0,
  updated_at integer NOT NULL
);
INSERT OR IGNORE INTO formdev_data_version (form_id, version, updated_at)
SELECT f.form_id, COALESCE((SELECT max(r.ingest_seq) FROM formdev_record r WHERE r.form_id = f.form_id), 0) + 1, 0 FROM formdev_form f;

CREATE TABLE IF NOT EXISTS formdev_form_policy (
  form_id text PRIMARY KEY REFERENCES formdev_form(form_id),
  policy text NOT NULL,
  version integer NOT NULL CHECK (version > 0),
  updated_at integer NOT NULL,
  updated_by text NOT NULL
);

CREATE TABLE IF NOT EXISTS formdev_source (
  source_id text PRIMARY KEY,
  form_id text NOT NULL REFERENCES formdev_form(form_id),
  config text NOT NULL,
  version integer NOT NULL CHECK (version > 0),
  updated_at integer NOT NULL,
  updated_by text NOT NULL
);

CREATE TABLE IF NOT EXISTS formdev_index_config (
  form_id text NOT NULL REFERENCES formdev_form(form_id),
  field_id text NOT NULL,
  created_at integer NOT NULL,
  created_by text NOT NULL,
  PRIMARY KEY (form_id, field_id)
);

CREATE TABLE IF NOT EXISTS formdev_index_coverage (
  form_id text NOT NULL REFERENCES formdev_form(form_id),
  field_id text NOT NULL,
  origin text NOT NULL CHECK (origin IN ('definition', 'config')),
  state text NOT NULL CHECK (state IN ('ready', 'building')),
  schema_version integer NOT NULL,
  updated_at integer NOT NULL,
  PRIMARY KEY (form_id, field_id)
);

CREATE TABLE IF NOT EXISTS formdev_query (
  query_id text PRIMARY KEY,
  definition text NOT NULL,
  owner_user_id integer,
  owner text NOT NULL,
  created_at integer NOT NULL,
  updated_at integer NOT NULL
);

CREATE TABLE IF NOT EXISTS formdev_query_stat (
  fingerprint text PRIMARY KEY,
  source_id text NOT NULL,
  shape text NOT NULL,
  runs integer NOT NULL DEFAULT 0,
  ok integer NOT NULL DEFAULT 0,
  timeouts integer NOT NULL DEFAULT 0,
  rejected integer NOT NULL DEFAULT 0,
  total_ms integer NOT NULL DEFAULT 0,
  max_ms integer NOT NULL DEFAULT 0,
  rows_returned integer NOT NULL DEFAULT 0,
  first_run_at integer NOT NULL,
  last_run_at integer NOT NULL
);

CREATE TABLE IF NOT EXISTS formdev_job (
  job_id text PRIMARY KEY,
  kind text NOT NULL CHECK (kind IN ('export', 'search', 'aggregate', 'report', 'reindex')),
  status text NOT NULL CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'cancelled', 'expired')),
  query text,
  format text NOT NULL,
  owner_user_id integer,
  owner text NOT NULL,
  rows_processed integer NOT NULL DEFAULT 0,
  total_estimate integer,
  checkpoint text,
  result_bytes integer NOT NULL DEFAULT 0,
  result_sha256 text,
  error text,
  attempt integer NOT NULL DEFAULT 0,
  max_attempts integer NOT NULL DEFAULT 3,
  lease_owner text,
  lease_expires_at integer,
  cancel_requested integer NOT NULL DEFAULT 0 CHECK (cancel_requested IN (0, 1)),
  created_at integer NOT NULL,
  started_at integer,
  heartbeat_at integer,
  finished_at integer,
  expires_at integer
);
CREATE INDEX IF NOT EXISTS formdev_job_queue ON formdev_job (status, created_at);
CREATE INDEX IF NOT EXISTS formdev_job_owner ON formdev_job (owner_user_id, status, created_at DESC);

CREATE TABLE IF NOT EXISTS formdev_query_audit (
  audit_id text PRIMARY KEY,
  at integer NOT NULL,
  actor_user_id integer,
  actor text NOT NULL,
  actor_roles text NOT NULL,
  action text NOT NULL CHECK (action IN ('query', 'job_create', 'job_download', 'job_cancel', 'diagnostics', 'denied')),
  source_id text,
  fingerprint text,
  fields text NOT NULL DEFAULT '[]',
  filter_fields text NOT NULL DEFAULT '[]',
  row_count integer,
  job_id text,
  result_sha256 text,
  client_ip text
);
CREATE INDEX IF NOT EXISTS formdev_query_audit_at ON formdev_query_audit (at DESC);

CREATE INDEX IF NOT EXISTS formdev_ri_text_live
  ON formdev_record_index (form_id, field_id, value_text, updated_at DESC, record_id DESC)
  WHERE value_text IS NOT NULL AND status <> 'deleted';
CREATE INDEX IF NOT EXISTS formdev_ri_num_live
  ON formdev_record_index (form_id, field_id, value_num, updated_at DESC, record_id DESC)
  WHERE value_num IS NOT NULL AND status <> 'deleted';
CREATE UNIQUE INDEX IF NOT EXISTS formdev_record_ingest ON formdev_record (form_id, ingest_seq);
CREATE INDEX IF NOT EXISTS formdev_record_created ON formdev_record (form_id, created_at DESC, record_id DESC);
CREATE INDEX IF NOT EXISTS formdev_record_subject ON formdev_record (form_id, subject_id, created_at DESC, record_id DESC)
  WHERE subject_id IS NOT NULL;
DROP INDEX IF EXISTS formdev_record_index_text;
DROP INDEX IF EXISTS formdev_record_index_num;
