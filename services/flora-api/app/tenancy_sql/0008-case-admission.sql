ALTER TABLE cases ADD COLUMN IF NOT EXISTS admission_source text NOT NULL DEFAULT 'legacy';
ALTER TABLE cases ADD COLUMN IF NOT EXISTS identity_status text NOT NULL DEFAULT 'verified';
ALTER TABLE cases ADD COLUMN IF NOT EXISTS admission_number text;
ALTER TABLE cases ADD COLUMN IF NOT EXISTS patient_display_name text;
ALTER TABLE cases ADD COLUMN IF NOT EXISTS admitted_by text;
ALTER TABLE cases ADD COLUMN IF NOT EXISTS admission_metadata jsonb NOT NULL DEFAULT '{}'::jsonb;

DO $$ BEGIN
  ALTER TABLE cases ADD CONSTRAINT cases_admission_source_check
    CHECK (admission_source IN ('legacy','prepared','his','manual','emergency'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE cases ADD CONSTRAINT cases_identity_status_check
    CHECK (identity_status IN ('verified','local','pending','reconciled'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS cases_admission_source_idx ON cases(admission_source, start_time DESC);
GRANT SELECT, INSERT, UPDATE, DELETE ON cases TO flora_app;
