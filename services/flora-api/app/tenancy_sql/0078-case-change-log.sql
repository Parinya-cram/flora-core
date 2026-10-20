-- Chart undo. Every row change to the chart's tables made inside a chart action
-- (the API sets flora.change_set from the X-Flora-Change-Set header) is logged with
-- its before/after image. Undo restores the before images of the latest action.
-- Device ingest, sync and handover imports set no change set and are not logged.
BEGIN;

CREATE TABLE IF NOT EXISTS case_change_log (
  id bigserial PRIMARY KEY,
  change_set text NOT NULL,
  case_id bigint,
  table_name text NOT NULL,
  row_id bigint NOT NULL,
  op text NOT NULL CHECK (op IN ('INSERT','UPDATE','DELETE')),
  old_row jsonb,
  new_row jsonb,
  actor text,
  created_at bigint NOT NULL,
  undone_at bigint,
  undone_by text
);
CREATE INDEX IF NOT EXISTS case_change_log_case_idx ON case_change_log (case_id, id DESC);
CREATE INDEX IF NOT EXISTS case_change_log_set_idx ON case_change_log (change_set);
CREATE INDEX IF NOT EXISTS case_change_log_row_idx ON case_change_log (table_name, row_id, id DESC);

CREATE OR REPLACE FUNCTION flora_log_case_change() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  change_set text := nullif(current_setting('flora.change_set', true), '');
  old_row jsonb;
  new_row jsonb;
  row_case bigint;
BEGIN
  IF change_set IS NULL THEN RETURN NULL; END IF;
  IF TG_OP <> 'INSERT' THEN old_row := to_jsonb(OLD); END IF;
  IF TG_OP <> 'DELETE' THEN new_row := to_jsonb(NEW); END IF;
  IF TG_OP = 'UPDATE' AND old_row = new_row THEN RETURN NULL; END IF;
  row_case := coalesce((new_row->>'case_id')::bigint, (old_row->>'case_id')::bigint);
  IF row_case IS NULL AND TG_TABLE_NAME = 'case_io_segment' THEN
    SELECT case_id INTO row_case FROM case_io_run
     WHERE id = coalesce((new_row->>'run_id')::bigint, (old_row->>'run_id')::bigint);
  END IF;
  INSERT INTO case_change_log (change_set, case_id, table_name, row_id, op, old_row, new_row, actor, created_at)
  VALUES (change_set, row_case, TG_TABLE_NAME, coalesce((new_row->>'id')::bigint, (old_row->>'id')::bigint),
          TG_OP, old_row, new_row, nullif(current_setting('flora.actor', true), ''),
          (extract(epoch FROM clock_timestamp()) * 1000)::bigint);
  RETURN NULL;
END $$;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['case_timeline_value','case_timeline_mask','case_event_note','case_io_run','case_io_segment','case_io_event'] LOOP
    IF to_regclass(t) IS NOT NULL THEN
      EXECUTE format('DROP TRIGGER IF EXISTS flora_change_log ON %I', t);
      EXECUTE format('CREATE TRIGGER flora_change_log AFTER INSERT OR UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION flora_log_case_change()', t);
    END IF;
  END LOOP;
END $$;

GRANT SELECT, INSERT, UPDATE ON case_change_log TO flora_app;
GRANT USAGE, SELECT ON SEQUENCE case_change_log_id_seq TO flora_app;

COMMIT;
