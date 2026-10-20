BEGIN;

ALTER TABLE case_diagnosis ADD COLUMN IF NOT EXISTS event_ts bigint;
ALTER TABLE case_diagnosis ADD COLUMN IF NOT EXISTS entry_context text;
ALTER TABLE case_procedure ADD COLUMN IF NOT EXISTS event_ts bigint;
ALTER TABLE case_procedure ADD COLUMN IF NOT EXISTS entry_context text;

UPDATE case_diagnosis entry
SET event_ts = cases.start_time,
    entry_context = COALESCE(NULLIF(entry.entry_context, ''), 'preoperative')
FROM cases
WHERE entry.case_id = cases.id
  AND (entry.event_ts IS NULL OR entry.entry_context IS NULL OR entry.entry_context = '');

UPDATE case_procedure entry
SET event_ts = cases.start_time,
    entry_context = COALESCE(NULLIF(entry.entry_context, ''), 'planned')
FROM cases
WHERE entry.case_id = cases.id
  AND (entry.event_ts IS NULL OR entry.entry_context IS NULL OR entry.entry_context = '');

ALTER TABLE case_diagnosis ALTER COLUMN event_ts SET NOT NULL;
ALTER TABLE case_diagnosis ALTER COLUMN entry_context SET NOT NULL;
ALTER TABLE case_procedure ALTER COLUMN event_ts SET NOT NULL;
ALTER TABLE case_procedure ALTER COLUMN entry_context SET NOT NULL;

CREATE INDEX IF NOT EXISTS case_diagnosis_timeline ON case_diagnosis(case_id, event_ts, seq, id);
CREATE INDEX IF NOT EXISTS case_procedure_timeline ON case_procedure(case_id, event_ts, seq, id);

GRANT SELECT, INSERT, UPDATE, DELETE ON case_diagnosis, case_procedure TO flora_app;

COMMIT;
