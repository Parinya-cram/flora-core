-- FormDev Phase 4: query indexes. NOT wrapped in a transaction: CREATE/DROP INDEX
-- CONCURRENTLY keeps record writes (Leaf -> Canopy sync) running on large tables.
-- Idempotent. Run after 0061-formdev-query.sql.

-- Filtered keyset pages on updated_at (default sort) served by one index range scan (no sort, no record join).
-- status <> 'deleted' and IS NOT NULL make the indexes small; queries repeat those predicates literally.
CREATE INDEX CONCURRENTLY IF NOT EXISTS formdev_ri_text_live
  ON formdev_record_index (form_id, field_id, value_text, updated_at DESC, record_id DESC)
  WHERE value_text IS NOT NULL AND status <> 'deleted';
CREATE INDEX CONCURRENTLY IF NOT EXISTS formdev_ri_num_live
  ON formdev_record_index (form_id, field_id, value_num, updated_at DESC, record_id DESC)
  WHERE value_num IS NOT NULL AND status <> 'deleted';

-- Stable keysets: ingest order (jobs, $ingested_at lists), $created_at, and per-form subject lookups.
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS formdev_record_ingest
  ON formdev_record (form_id, ingest_seq);
CREATE INDEX CONCURRENTLY IF NOT EXISTS formdev_record_created
  ON formdev_record (form_id, created_at DESC, record_id DESC);
CREATE INDEX CONCURRENTLY IF NOT EXISTS formdev_record_subject
  ON formdev_record (form_id, subject_id, created_at DESC, record_id DESC)
  WHERE subject_id IS NOT NULL;

-- Superseded by the partial live indexes above (they indexed every NULL of the other column).
DROP INDEX CONCURRENTLY IF EXISTS formdev_record_index_text;
DROP INDEX CONCURRENTLY IF EXISTS formdev_record_index_num;

ANALYZE formdev_record;
ANALYZE formdev_record_index;
