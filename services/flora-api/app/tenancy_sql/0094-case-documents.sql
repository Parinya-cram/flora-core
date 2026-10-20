-- Documents attached to a case (formdev/docs/FORM-STUDIO-V2.md §6): scanned or PDF pages put together on the Leaf
-- (the assembly workspace) and kept with the case as one PDF; the sync worker sends each to Canopy once. Idempotent.
BEGIN;

-- Leaf: the case's documents (works offline). A removed document keeps its row (who / when / why) and is sent again.
CREATE TABLE IF NOT EXISTS case_document (
  id bigserial PRIMARY KEY,
  case_id bigint NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
  title text NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  pages integer NOT NULL CHECK (pages >= 1),
  bytes integer NOT NULL,
  sha256 text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  content bytea NOT NULL,
  created_at bigint NOT NULL,
  created_by text,
  removed_at bigint,
  removed_by text,
  removed_reason text,
  synced_at bigint,
  sync_error text
);
CREATE INDEX IF NOT EXISTS case_document_case ON case_document (case_id, created_at);
CREATE INDEX IF NOT EXISTS case_document_unsent ON case_document (id) WHERE synced_at IS NULL;
GRANT SELECT, INSERT, UPDATE ON case_document TO flora_app;
GRANT USAGE, SELECT ON SEQUENCE case_document_id_seq TO flora_app;
GRANT SELECT ON case_document TO flora_view;

-- Canopy: the copies received from the Leafs, by the case's global id. The details arrive first; the file (content)
-- only when Canopy does not have it yet, as it is (no base64), checked against sha256. A removal sends the details only.
CREATE TABLE IF NOT EXISTS canopy_case_document (
  leaf_id text NOT NULL,
  document_id bigint NOT NULL,
  global_case_id text NOT NULL,
  source_case_id text NOT NULL,
  hn text,
  title text NOT NULL,
  pages integer NOT NULL,
  bytes integer NOT NULL,
  sha256 text NOT NULL,
  content bytea,
  created_at bigint NOT NULL,
  created_by text,
  removed_at bigint,
  removed_by text,
  removed_reason text,
  received_at bigint NOT NULL,
  PRIMARY KEY (leaf_id, document_id)
);
ALTER TABLE canopy_case_document ALTER COLUMN content DROP NOT NULL;
CREATE INDEX IF NOT EXISTS canopy_case_document_case ON canopy_case_document (global_case_id, created_at);
GRANT SELECT ON canopy_case_document TO flora_view;
GRANT SELECT, INSERT, UPDATE ON canopy_case_document TO flora_sync;

COMMIT;
