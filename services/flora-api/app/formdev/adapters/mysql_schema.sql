-- FormDev schema for MySQL 8.0.19+ / 8.4 (MySQL migration 1). Same tables as the PostgreSQL migrations
-- 0060-0064 and the SQLite migrations 1-5; repositories never depend on vendor differences.
-- * utf8mb4_bin everywhere: comparisons and ordering are by code point, like PostgreSQL's C collation and
--   SQLite's BINARY (prefix ranges and cursors depend on it).
-- * Text keys are VARCHAR(191) (field ids 128, keeping composite index keys under 3072 bytes); JSON is LONGTEXT (encoded / decoded by the adapter, as in SQLite).
-- * No partial indexes in MySQL: the "live" indexes include status instead of filtering on it.
-- Statements are separated by ";" at the end of a line; DELIMITER lines work as in the mysql client.

CREATE TABLE IF NOT EXISTS formdev_form (
  form_id varchar(191) NOT NULL PRIMARY KEY,
  title text NOT NULL,
  latest_version int NOT NULL DEFAULT 0,
  published_version int NULL,
  created_at bigint NOT NULL,
  created_by varchar(191) NOT NULL,
  updated_at bigint NOT NULL,
  updated_by varchar(191) NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

CREATE TABLE IF NOT EXISTS formdev_schema_version (
  form_id varchar(191) NOT NULL,
  schema_version int NOT NULL CHECK (schema_version > 0),
  status varchar(16) NOT NULL CHECK (status IN ('draft','published','archived')),
  definition longtext NOT NULL,
  checksum varchar(128) NOT NULL,
  created_at bigint NOT NULL,
  created_by varchar(191) NOT NULL,
  published_at bigint NULL,
  published_by varchar(191) NULL,
  PRIMARY KEY (form_id, schema_version),
  CONSTRAINT formdev_schema_version_form FOREIGN KEY (form_id) REFERENCES formdev_form(form_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

DROP TRIGGER IF EXISTS formdev_schema_version_immutable_update;
DROP TRIGGER IF EXISTS formdev_schema_version_immutable_delete;
DELIMITER //
CREATE TRIGGER formdev_schema_version_immutable_update BEFORE UPDATE ON formdev_schema_version FOR EACH ROW
BEGIN
  IF OLD.status IN ('published','archived') AND (NEW.definition <> OLD.definition OR NEW.checksum <> OLD.checksum OR NEW.status = 'draft') THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'published form versions are immutable';
  END IF;
END//
CREATE TRIGGER formdev_schema_version_immutable_delete BEFORE DELETE ON formdev_schema_version FOR EACH ROW
BEGIN
  IF OLD.status IN ('published','archived') THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'published form versions are immutable';
  END IF;
END//
DELIMITER ;

CREATE TABLE IF NOT EXISTS formdev_record (
  record_id varchar(191) NOT NULL PRIMARY KEY,
  form_id varchar(191) NOT NULL,
  schema_version int NOT NULL,
  status varchar(16) NOT NULL CHECK (status IN ('draft','submitted','deleted')),
  data longtext NOT NULL,
  created_at bigint NOT NULL,
  created_by varchar(191) NOT NULL,
  updated_at bigint NOT NULL,
  updated_by varchar(191) NOT NULL,
  sync_id varchar(191) NULL,
  version int NOT NULL CHECK (version > 0),
  subject_id varchar(191) NULL,
  ingest_seq bigint NULL,
  ingested_at bigint NULL,
  CONSTRAINT formdev_record_version FOREIGN KEY (form_id, schema_version) REFERENCES formdev_schema_version(form_id, schema_version),
  UNIQUE KEY formdev_record_ingest (form_id, ingest_seq),
  KEY formdev_record_recent (form_id, updated_at, record_id),
  KEY formdev_record_status_recent (form_id, status, updated_at, record_id),
  KEY formdev_record_created (form_id, created_at DESC, record_id DESC),
  KEY formdev_record_subject (form_id, subject_id, created_at DESC, record_id DESC)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

CREATE TABLE IF NOT EXISTS formdev_record_revision (
  record_id varchar(191) NOT NULL,
  version int NOT NULL,
  schema_version int NOT NULL,
  status varchar(16) NOT NULL,
  data longtext NOT NULL,
  updated_at bigint NOT NULL,
  updated_by varchar(191) NOT NULL,
  sync_id varchar(191) NULL,
  PRIMARY KEY (record_id, version),
  CONSTRAINT formdev_revision_record FOREIGN KEY (record_id) REFERENCES formdev_record(record_id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

CREATE TABLE IF NOT EXISTS formdev_record_index (
  record_id varchar(191) NOT NULL,
  form_id varchar(191) NOT NULL,
  field_id varchar(128) NOT NULL,
  value_text text NULL,
  value_num double NULL,
  status varchar(16) NULL,
  updated_at bigint NULL,
  PRIMARY KEY (record_id, field_id),
  KEY formdev_ri_text_live (form_id, field_id, status, value_text(191), updated_at DESC, record_id DESC),
  KEY formdev_ri_num_live (form_id, field_id, status, value_num, updated_at DESC, record_id DESC),
  CONSTRAINT formdev_index_record FOREIGN KEY (record_id) REFERENCES formdev_record(record_id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

CREATE TABLE IF NOT EXISTS formdev_sync_receipt (
  op_id varchar(191) NOT NULL PRIMARY KEY,
  record_id varchar(191) NOT NULL,
  result longtext NOT NULL,
  processed_at bigint NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

CREATE TABLE IF NOT EXISTS formdev_conflict (
  seq bigint NOT NULL AUTO_INCREMENT PRIMARY KEY,
  conflict_id varchar(191) NOT NULL UNIQUE,
  record_id varchar(191) NOT NULL,
  op_id varchar(191) NOT NULL,
  strategy varchar(64) NOT NULL,
  resolution varchar(16) NOT NULL CHECK (resolution IN ('local_wins','remote_wins')),
  base_version int NOT NULL,
  server_version int NOT NULL,
  local_data longtext NULL,
  server_data longtext NULL,
  created_at bigint NOT NULL,
  KEY formdev_conflict_record (record_id, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

CREATE TABLE IF NOT EXISTS formdev_asset (
  form_id varchar(191) NOT NULL,
  path varchar(512) NOT NULL,
  media_type varchar(191) NOT NULL,
  sha256 varchar(64) NOT NULL,
  size bigint NOT NULL,
  content_b64 longtext NOT NULL,
  created_at bigint NOT NULL,
  PRIMARY KEY (form_id, path),
  CONSTRAINT formdev_asset_form FOREIGN KEY (form_id) REFERENCES formdev_form(form_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

CREATE TABLE IF NOT EXISTS formdev_style (
  style_id varchar(191) NOT NULL PRIMARY KEY,
  version int NOT NULL,
  definition longtext NOT NULL,
  updated_at bigint NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

CREATE TABLE IF NOT EXISTS formdev_font (
  font_id varchar(191) NOT NULL PRIMARY KEY,
  metadata longtext NOT NULL,
  updated_at bigint NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

CREATE TABLE IF NOT EXISTS formdev_data_version (
  form_id varchar(191) NOT NULL PRIMARY KEY,
  version bigint NOT NULL DEFAULT 0,
  updated_at bigint NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

CREATE TABLE IF NOT EXISTS formdev_form_policy (
  form_id varchar(191) NOT NULL PRIMARY KEY,
  policy longtext NOT NULL,
  version int NOT NULL CHECK (version > 0),
  updated_at bigint NOT NULL,
  updated_by varchar(191) NOT NULL,
  CONSTRAINT formdev_policy_form FOREIGN KEY (form_id) REFERENCES formdev_form(form_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

CREATE TABLE IF NOT EXISTS formdev_source (
  source_id varchar(191) NOT NULL PRIMARY KEY,
  form_id varchar(191) NOT NULL,
  config longtext NOT NULL,
  version int NOT NULL CHECK (version > 0),
  updated_at bigint NOT NULL,
  updated_by varchar(191) NOT NULL,
  CONSTRAINT formdev_source_form FOREIGN KEY (form_id) REFERENCES formdev_form(form_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

CREATE TABLE IF NOT EXISTS formdev_index_config (
  form_id varchar(191) NOT NULL,
  field_id varchar(128) NOT NULL,
  created_at bigint NOT NULL,
  created_by varchar(191) NOT NULL,
  PRIMARY KEY (form_id, field_id),
  CONSTRAINT formdev_index_config_form FOREIGN KEY (form_id) REFERENCES formdev_form(form_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

CREATE TABLE IF NOT EXISTS formdev_index_coverage (
  form_id varchar(191) NOT NULL,
  field_id varchar(128) NOT NULL,
  origin varchar(16) NOT NULL CHECK (origin IN ('definition', 'config')),
  state varchar(16) NOT NULL CHECK (state IN ('ready', 'building')),
  schema_version int NOT NULL,
  updated_at bigint NOT NULL,
  PRIMARY KEY (form_id, field_id),
  CONSTRAINT formdev_index_coverage_form FOREIGN KEY (form_id) REFERENCES formdev_form(form_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

CREATE TABLE IF NOT EXISTS formdev_query (
  query_id varchar(191) NOT NULL PRIMARY KEY,
  definition longtext NOT NULL,
  owner_user_id bigint NULL,
  owner varchar(191) NOT NULL,
  created_at bigint NOT NULL,
  updated_at bigint NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

CREATE TABLE IF NOT EXISTS formdev_query_stat (
  fingerprint varchar(191) NOT NULL PRIMARY KEY,
  source_id varchar(191) NOT NULL,
  shape longtext NOT NULL,
  runs bigint NOT NULL DEFAULT 0,
  ok bigint NOT NULL DEFAULT 0,
  timeouts bigint NOT NULL DEFAULT 0,
  rejected bigint NOT NULL DEFAULT 0,
  total_ms bigint NOT NULL DEFAULT 0,
  max_ms bigint NOT NULL DEFAULT 0,
  rows_returned bigint NOT NULL DEFAULT 0,
  first_run_at bigint NOT NULL,
  last_run_at bigint NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

CREATE TABLE IF NOT EXISTS formdev_job (
  job_id varchar(191) NOT NULL PRIMARY KEY,
  kind varchar(16) NOT NULL CHECK (kind IN ('export', 'search', 'aggregate', 'report', 'reindex')),
  status varchar(16) NOT NULL CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'cancelled', 'expired')),
  query longtext NULL,
  format varchar(16) NOT NULL,
  owner_user_id bigint NULL,
  owner varchar(191) NOT NULL,
  rows_processed bigint NOT NULL DEFAULT 0,
  total_estimate bigint NULL,
  checkpoint longtext NULL,
  result_bytes bigint NOT NULL DEFAULT 0,
  result_sha256 varchar(64) NULL,
  error longtext NULL,
  attempt int NOT NULL DEFAULT 0,
  max_attempts int NOT NULL DEFAULT 3,
  lease_owner varchar(191) NULL,
  lease_expires_at bigint NULL,
  cancel_requested tinyint NOT NULL DEFAULT 0 CHECK (cancel_requested IN (0, 1)),
  created_at bigint NOT NULL,
  started_at bigint NULL,
  heartbeat_at bigint NULL,
  finished_at bigint NULL,
  expires_at bigint NULL,
  KEY formdev_job_queue (status, created_at),
  KEY formdev_job_owner (owner_user_id, status, created_at DESC)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

-- Rows locked FOR UPDATE to serialise job quota checks (PostgreSQL uses advisory locks).
CREATE TABLE IF NOT EXISTS formdev_job_lock (
  lock_key varchar(191) NOT NULL PRIMARY KEY
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

CREATE TABLE IF NOT EXISTS formdev_query_audit (
  audit_id varchar(191) NOT NULL PRIMARY KEY,
  at bigint NOT NULL,
  actor_user_id bigint NULL,
  actor varchar(191) NOT NULL,
  actor_roles longtext NOT NULL,
  action varchar(32) NOT NULL CHECK (action IN ('query', 'job_create', 'job_download', 'job_cancel', 'diagnostics', 'denied')),
  source_id varchar(191) NULL,
  fingerprint varchar(191) NULL,
  fields longtext NOT NULL,
  filter_fields longtext NOT NULL,
  row_count bigint NULL,
  job_id varchar(191) NULL,
  result_sha256 varchar(64) NULL,
  client_ip varchar(64) NULL,
  KEY formdev_query_audit_at (at DESC)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

CREATE TABLE IF NOT EXISTS formdev_lookup (
  lookup_id varchar(191) NOT NULL PRIMARY KEY,
  version int NOT NULL,
  metadata longtext NOT NULL,
  entries longtext NOT NULL,
  updated_at bigint NOT NULL,
  updated_by varchar(191) NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

CREATE TABLE IF NOT EXISTS formdev_attachment (
  sha256 varchar(64) NOT NULL PRIMARY KEY,
  media_type varchar(255) NOT NULL,
  size bigint NOT NULL,
  content longblob NOT NULL,
  created_at bigint NOT NULL,
  created_by varchar(191) NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;
