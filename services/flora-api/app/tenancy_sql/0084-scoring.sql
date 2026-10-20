-- Clinical scores (NEWS2, MEWS, qSOFA, Aldrete, GCS ...), format flora-score/1 (app/scoring.py).
-- Canopy owns the definitions (Workflow Studio → Scores); a workflow lists the scores it uses
-- (definition.scores) and published definitions travel to Leafs with the ward's workflows
-- (leaf_workflow_state.payload.scores). The Leaf computes each score every interval from the
-- effective timeline (overrides applied, masked readings left out) into case_score_result.
BEGIN;

CREATE TABLE IF NOT EXISTS canopy_score_definition (
  id text PRIMARY KEY CHECK (id ~ '^[a-z][a-z0-9_]{1,63}$'),
  name text NOT NULL DEFAULT '',
  description text NOT NULL DEFAULT '',
  definition jsonb NOT NULL,
  version bigint NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','published','archived')),
  published_definition jsonb,
  published_at bigint,
  created_at bigint NOT NULL,
  created_by text,
  updated_at bigint NOT NULL,
  updated_by text
);

-- One row per score per time point: automatic results at interval boundaries, manual ones
-- when a clinician runs the score. inputs keeps the values used, so a result can be checked later.
CREATE TABLE IF NOT EXISTS case_score_result (
  id bigserial PRIMARY KEY,
  case_id bigint NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
  score_id text NOT NULL,
  score_version bigint NOT NULL DEFAULT 0,
  ts bigint NOT NULL,
  source text NOT NULL DEFAULT 'auto' CHECK (source IN ('auto','manual')),
  total numeric,
  band text,
  level text,
  partial boolean NOT NULL DEFAULT false,
  items jsonb NOT NULL DEFAULT '[]'::jsonb,
  inputs jsonb NOT NULL DEFAULT '{}'::jsonb,
  missing text[] NOT NULL DEFAULT '{}',
  flags jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_by text,
  created_at bigint NOT NULL,
  updated_at bigint NOT NULL,
  UNIQUE (case_id, score_id, ts, source)
);
CREATE INDEX IF NOT EXISTS case_score_result_case_ts ON case_score_result (case_id, ts);

-- Observations the common scores need that devices do not send; charted by hand
-- (hidden from the default table until a hospital turns them on).
WITH seed(param_key,display_name,short_name,value_type,unit,display_order) AS (VALUES
  ('avpu','Level of consciousness (ACVPU)','ACVPU','text',NULL,600),
  ('gcs','Glasgow Coma Scale total','GCS','number','{score}',610),
  ('gcs_e','GCS eye opening','GCS E','number','{score}',611),
  ('gcs_v','GCS verbal response','GCS V','number','{score}',612),
  ('gcs_m','GCS motor response','GCS M','number','{score}',613),
  ('o2_supplemental','Supplemental oxygen (0 = air, 1 = oxygen)','O2 suppl','number',NULL,620),
  ('pain_score','Pain score (0-10)','Pain','number','{score}',630)
), concepts AS (
  INSERT INTO clinical_concept(domain,local_id,local_name,is_active,created_at,updated_at)
  SELECT 'observation',param_key,display_name,1,(extract(epoch from clock_timestamp())*1000)::bigint,(extract(epoch from clock_timestamp())*1000)::bigint FROM seed
  ON CONFLICT(domain,local_id) DO UPDATE SET local_name=excluded.local_name
  RETURNING id,local_id
)
INSERT INTO clinical_parameter_master(param_key,concept_id,display_name,short_name,value_type,unit,display_order,table_group,show_in_table,is_active,created_at,updated_at)
SELECT seed.param_key,concept.id,seed.display_name,seed.short_name,seed.value_type,seed.unit,seed.display_order,'measured',0,1,
       (extract(epoch from clock_timestamp())*1000)::bigint,(extract(epoch from clock_timestamp())*1000)::bigint
FROM seed JOIN concepts concept ON concept.local_id=seed.param_key
ON CONFLICT(param_key) DO NOTHING;

GRANT SELECT, INSERT, UPDATE, DELETE ON case_score_result TO flora_app;
GRANT USAGE, SELECT ON SEQUENCE case_score_result_id_seq TO flora_app;
DO $$ BEGIN
  GRANT SELECT, INSERT, UPDATE, DELETE ON canopy_score_definition TO flora_view;
EXCEPTION WHEN undefined_object THEN NULL; END $$;
DO $$ BEGIN
  GRANT SELECT ON canopy_score_definition TO flora_sync;
EXCEPTION WHEN undefined_object THEN NULL; END $$;

COMMIT;
