-- Workflow forms between Flora Leaf and Canopy, field by field in both directions (formdev/docs/CANOPY-LEAF-FORM-WORKFLOW.md).
--
-- Canopy keeps one copy of every case form (canopy_case_form): the Leaf's changes and Canopy's own (amendments made in
-- Form Studio with a reason, forms filled for a Canopy admission before the case starts) merge per field, newest wins,
-- each field remembering who changed it. Form Studio's formdev_record is written from it, and the Leaf gets a receipt
-- for every form (stored, kept as draft, not stored + why, waiting for files) instead of a log line. Idempotent.
BEGIN;

-- Canopy side ----------------------------------------------------------------

CREATE TABLE IF NOT EXISTS canopy_case_form (
  -- The global case id (uuid text), or 'admission:<uuid>' for a form filled for an admission before its case started.
  case_key text NOT NULL,
  form_id text NOT NULL CHECK (form_id ~ '^[a-z][a-z0-9_]{1,63}$'),
  form_version integer NOT NULL,
  hn text,
  admission_id uuid,
  leaf_id text,
  source_case_id text,
  data jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- Per field (and "__status"): epoch ms of the last change, and {by, at, via: leaf|canopy, leaf_id?, reason?}.
  field_versions jsonb NOT NULL DEFAULT '{}'::jsonb,
  field_authors jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'completed')),
  -- The Form Studio record written from this form, and how that went.
  record_id text NOT NULL UNIQUE,
  record_state text NOT NULL DEFAULT 'pending'
    CHECK (record_state IN ('pending', 'stored', 'kept_as_draft', 'not_stored', 'waiting_files')),
  record_issues jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- Newest change made in Canopy, and the newest of those the Leaf has confirmed (Canopy sends while canopy_rev > leaf_rev).
  canopy_rev bigint NOT NULL DEFAULT 0,
  leaf_rev bigint NOT NULL DEFAULT 0,
  -- What the Leaf did with Canopy's copy: applied, or not_in_workflow (the case's workflow has no such form).
  leaf_state text,
  created_at bigint NOT NULL,
  updated_at bigint NOT NULL,
  PRIMARY KEY (case_key, form_id)
);
CREATE INDEX IF NOT EXISTS canopy_case_form_leaf ON canopy_case_form (leaf_id, source_case_id);
CREATE INDEX IF NOT EXISTS canopy_case_form_admission ON canopy_case_form (admission_id) WHERE admission_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS canopy_case_form_hn ON canopy_case_form (hn);

-- Every change Canopy made to a form filled on a Leaf: what changed, why, who, when (nothing is overwritten silently).
CREATE TABLE IF NOT EXISTS canopy_case_form_amendment (
  id bigserial PRIMARY KEY,
  case_key text NOT NULL,
  form_id text NOT NULL,
  record_id text,
  changes jsonb NOT NULL,
  reason text NOT NULL CHECK (length(btrim(reason)) BETWEEN 3 AND 500),
  amended_by text NOT NULL,
  amended_at bigint NOT NULL
);
CREATE INDEX IF NOT EXISTS canopy_case_form_amendment_form ON canopy_case_form_amendment (case_key, form_id, amended_at);

GRANT SELECT, INSERT, UPDATE, DELETE ON canopy_case_form TO flora_view, flora_sync;
GRANT SELECT, INSERT ON canopy_case_form_amendment TO flora_view, flora_sync;
GRANT USAGE, SELECT ON SEQUENCE canopy_case_form_amendment_id_seq TO flora_view, flora_sync;

-- The sync API stores the files of Leaf forms (file / image fields) in Form Studio's attachment store.
DO $$
BEGIN
  IF to_regclass('formdev_attachment') IS NOT NULL THEN
    GRANT INSERT ON formdev_attachment TO flora_sync;
  END IF;
END $$;

-- Leaf side ------------------------------------------------------------------

ALTER TABLE case_form_record ADD COLUMN IF NOT EXISTS field_authors jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE case_form_record ADD COLUMN IF NOT EXISTS created_at bigint;
ALTER TABLE case_form_record ADD COLUMN IF NOT EXISTS created_by text;
-- Canopy's receipt for the copy it last took: digest of (data, versions, status), state and issues.
ALTER TABLE case_form_record ADD COLUMN IF NOT EXISTS sent_digest text;
ALTER TABLE case_form_record ADD COLUMN IF NOT EXISTS sync_state text NOT NULL DEFAULT 'pending';
ALTER TABLE case_form_record ADD COLUMN IF NOT EXISTS sync_issues jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE case_form_record ADD COLUMN IF NOT EXISTS synced_at bigint;
ALTER TABLE case_form_record ADD COLUMN IF NOT EXISTS canopy_record_id text;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'case_form_record_sync_state_check') THEN
    ALTER TABLE case_form_record ADD CONSTRAINT case_form_record_sync_state_check
      CHECK (sync_state IN ('pending', 'stored', 'kept_as_draft', 'not_stored', 'waiting_files'));
  END IF;
END $$;

COMMIT;
