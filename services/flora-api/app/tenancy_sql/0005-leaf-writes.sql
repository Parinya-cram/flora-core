BEGIN;
-- Ensure every bigint primary key has a PostgreSQL sequence and safe next value.
DO $$
DECLARE r record; sequence_name text; maximum bigint;
BEGIN
  FOR r IN
    SELECT c.table_name,c.column_name FROM information_schema.columns c
    JOIN information_schema.key_column_usage k
      ON k.table_schema=c.table_schema AND k.table_name=c.table_name AND k.column_name=c.column_name
    JOIN information_schema.table_constraints t
      ON t.constraint_schema=k.constraint_schema AND t.constraint_name=k.constraint_name
    WHERE c.table_schema='public' AND t.constraint_type='PRIMARY KEY'
      AND c.column_name='id' AND c.data_type='bigint' AND c.column_default IS NULL AND c.is_identity='NO'
  LOOP
    sequence_name := r.table_name || '_id_seq';
    EXECUTE format('CREATE SEQUENCE IF NOT EXISTS %I',sequence_name);
    EXECUTE format('ALTER SEQUENCE %I OWNED BY %I.id',sequence_name,r.table_name);
    EXECUTE format('ALTER TABLE %I ALTER COLUMN id SET DEFAULT nextval(%L)',r.table_name,sequence_name);
    EXECUTE format('SELECT max(id) FROM %I',r.table_name) INTO maximum;
    PERFORM setval(sequence_name,coalesce(maximum,1),maximum IS NOT NULL);
  END LOOP;
END $$;
CREATE TABLE IF NOT EXISTS case_clinical_audit (
  id bigserial PRIMARY KEY, case_id bigint NOT NULL REFERENCES cases(id),
  action text NOT NULL, before_json text, after_json text,
  actor_username text NOT NULL, actor_role text, created_at bigint NOT NULL
);
CREATE INDEX IF NOT EXISTS case_clinical_audit_case ON case_clinical_audit(case_id,created_at);
GRANT SELECT,INSERT,UPDATE,DELETE ON case_clinical_audit TO flora_app;
GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA public TO flora_app;
COMMIT;
