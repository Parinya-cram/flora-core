BEGIN;

ALTER TABLE case_timeline_value
  ADD COLUMN IF NOT EXISTS original_value_type text,
  ADD COLUMN IF NOT EXISTS original_value_num double precision,
  ADD COLUMN IF NOT EXISTS original_value_text text,
  ADD COLUMN IF NOT EXISTS original_source text;

ALTER TABLE case_timeline_audit
  ADD COLUMN IF NOT EXISTS original_value_type text,
  ADD COLUMN IF NOT EXISTS original_value_num double precision,
  ADD COLUMN IF NOT EXISTS original_value_text text,
  ADD COLUMN IF NOT EXISTS original_source text;

DO $$ BEGIN
  ALTER TABLE case_timeline_value ADD CONSTRAINT case_timeline_original_value_type_check
    CHECK (original_value_type IS NULL OR original_value_type IN ('number','text','code'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE case_timeline_audit ADD CONSTRAINT case_timeline_audit_original_value_type_check
    CHECK (original_value_type IS NULL OR original_value_type IN ('number','text','code'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Preserve the source reading for overrides created before provenance columns existed.
UPDATE case_timeline_value value SET
  original_value_type=CASE jsonb_typeof(minute.payload::jsonb -> value.param_key)
    WHEN 'number' THEN 'number' WHEN 'string' THEN 'text' ELSE NULL END,
  original_value_num=CASE WHEN jsonb_typeof(minute.payload::jsonb -> value.param_key)='number'
    THEN (minute.payload::jsonb ->> value.param_key)::double precision ELSE NULL END,
  original_value_text=CASE WHEN jsonb_typeof(minute.payload::jsonb -> value.param_key)='string'
    THEN minute.payload::jsonb ->> value.param_key ELSE NULL END,
  original_source=minute.ivy_source
FROM vital_minutes minute
WHERE value.source='override' AND value.case_id=minute.case_id AND value.ts_minute=minute.ts_minute
  AND minute.payload::jsonb ? value.param_key AND value.original_value_type IS NULL;

UPDATE case_timeline_audit audit SET
  original_value_type=value.original_value_type,
  original_value_num=value.original_value_num,
  original_value_text=value.original_value_text,
  original_source=value.original_source
FROM case_timeline_value value
WHERE audit.case_id=value.case_id AND audit.ts_minute=value.ts_minute
  AND audit.param_key=value.param_key AND audit.original_value_type IS NULL;

GRANT SELECT,INSERT,UPDATE,DELETE ON case_timeline_value,case_timeline_audit TO flora_app;

COMMIT;
