-- Scheduled workflow forms (ICU rounds, docs/ICU-ROUNDS.md): a form with a `schedule` in the case's workflow
-- is filled once per slot (daily, every N h, per shift); each fill is one entry. slot_ts NULL = an unscheduled
-- entry. Forms without a schedule keep one case_form_record per case. Leaf table; harmless (empty) on Canopy.
-- Existing Leaf databases get this file at leaf-api start-up (app/live_schema.py).
BEGIN;

CREATE TABLE IF NOT EXISTS case_form_entry (
  id uuid PRIMARY KEY,
  case_id bigint NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
  form_id text NOT NULL,
  form_version integer NOT NULL,
  slot_ts bigint,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','completed','skipped')),
  data jsonb NOT NULL DEFAULT '{}'::jsonb,
  field_versions jsonb NOT NULL DEFAULT '{}'::jsonb,
  skip_reason text,
  created_at bigint NOT NULL,
  created_by text,
  updated_at bigint NOT NULL,
  updated_by text,
  completed_at bigint,
  completed_by text
);
CREATE UNIQUE INDEX IF NOT EXISTS case_form_entry_slot ON case_form_entry (case_id, form_id, slot_ts)
  WHERE slot_ts IS NOT NULL;
CREATE INDEX IF NOT EXISTS case_form_entry_case ON case_form_entry (case_id, form_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON case_form_entry TO flora_app;
DO $$
BEGIN
  -- Canopy's case reads (cases_read) run as flora_view.
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'flora_view') THEN
    GRANT SELECT ON case_form_entry TO flora_view;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'flora_sync') THEN
    GRANT SELECT ON case_form_entry TO flora_sync;
  END IF;
END $$;

COMMIT;
