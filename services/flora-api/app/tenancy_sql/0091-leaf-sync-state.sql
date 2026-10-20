-- The sync worker's memory, kept in the Leaf database (formdev/docs/LEAF-DYNAMIC-STANDALONE-ANALYSIS.md, phase 0).
--
-- Before: the digest of every case last sent to Canopy, the cases active at the last pass and "first pass done" were in
-- the worker's memory, so a restart re-sent every case at once, and discharged cases left the sync 24 hours after
-- discharge. Now each case keeps what Canopy last took (digest, when) and when it was last checked: active cases are
-- checked every cycle, open ones in turn (oldest check first), archived ones once after archiving, with no time limit.
-- Idempotent.
BEGIN;

CREATE TABLE IF NOT EXISTS leaf_sync_case (
  case_id bigint PRIMARY KEY REFERENCES cases(id) ON DELETE CASCADE,
  -- The case snapshot Canopy accepted last (digest of its content) and when.
  snapshot_digest text,
  snapshot_sent_at bigint,
  -- The handover export of an active case last sent.
  export_digest text,
  checked_at bigint NOT NULL DEFAULT 0,
  -- Why this case could not be sent (a failing case no longer blocks the others).
  last_error text,
  last_error_at bigint
);
CREATE INDEX IF NOT EXISTS leaf_sync_case_checked ON leaf_sync_case (checked_at);

-- Small settings of the sync worker (e.g. whether Canopy speaks the case form exchange, when admissions last synced).
CREATE TABLE IF NOT EXISTS leaf_sync_state (
  key text PRIMARY KEY CHECK (key ~ '^[a-z][a-z0-9_.-]{1,63}$'),
  value jsonb NOT NULL,
  updated_at bigint NOT NULL
);

GRANT SELECT, INSERT, UPDATE, DELETE ON leaf_sync_case, leaf_sync_state TO flora_app;
GRANT SELECT ON leaf_sync_case, leaf_sync_state TO flora_view;

COMMIT;
