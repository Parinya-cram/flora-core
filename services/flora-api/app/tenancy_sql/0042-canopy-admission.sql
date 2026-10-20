BEGIN;

-- Cases admitted in Canopy (ward desk / tablet). A Leaf in the ward, or the chosen
-- bed, lists the admission under "Prepared patients" and starts it at the bedside.
-- Forms filled in Canopy (e.g. pre-op) keep syncing both ways through Canopy,
-- newest value per field wins (form_versions holds epoch ms per field key).
CREATE TABLE IF NOT EXISTS canopy_admission (
  id uuid PRIMARY KEY,
  unit_key text NOT NULL,
  target_leaf_id text,
  hn text NOT NULL,
  admission_number text,
  patient jsonb NOT NULL DEFAULT '{}'::jsonb,
  admission jsonb NOT NULL DEFAULT '{}'::jsonb,
  scheduled_at bigint,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'started', 'cancelled', 'conflict')),
  claimed_leaf_id text,
  leaf_case_id bigint,
  global_case_id uuid,
  case_status text,
  claimed_at bigint,
  form_values jsonb NOT NULL DEFAULT '{}'::jsonb,
  form_versions jsonb NOT NULL DEFAULT '{}'::jsonb,
  form_updated_at bigint NOT NULL DEFAULT 0,
  note text,
  created_by text,
  created_at bigint NOT NULL,
  updated_at bigint NOT NULL
);
CREATE INDEX IF NOT EXISTS canopy_admission_unit_status_idx ON canopy_admission(unit_key, status);
CREATE INDEX IF NOT EXISTS canopy_admission_leaf_idx ON canopy_admission(claimed_leaf_id);

GRANT SELECT, INSERT, UPDATE ON canopy_admission TO flora_view;
GRANT SELECT, UPDATE ON canopy_admission TO flora_sync;

-- Leaf side -----------------------------------------------------------------
ALTER TABLE case_detail ADD COLUMN IF NOT EXISTS field_versions jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE cases ADD COLUMN IF NOT EXISTS canopy_admission_id uuid;
CREATE INDEX IF NOT EXISTS cases_canopy_admission_idx ON cases(canopy_admission_id) WHERE canopy_admission_id IS NOT NULL;

-- Admissions this Leaf may start, as last received from Canopy.
CREATE TABLE IF NOT EXISTS canopy_admission_inbox (
  id uuid PRIMARY KEY,
  header jsonb NOT NULL DEFAULT '{}'::jsonb,
  form_values jsonb NOT NULL DEFAULT '{}'::jsonb,
  form_versions jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'claimed', 'withdrawn')),
  case_id bigint,
  claim_acknowledged boolean NOT NULL DEFAULT false,
  received_at bigint NOT NULL,
  updated_at bigint NOT NULL
);
GRANT SELECT, INSERT, UPDATE, DELETE ON canopy_admission_inbox TO flora_app;

COMMIT;
