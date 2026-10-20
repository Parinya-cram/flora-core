BEGIN;

-- Workflow Studio (docs/workflow-studio.md). Leaf and Canopy share one schema;
-- each side uses its own tables below. Idempotent.

-- Canopy side ---------------------------------------------------------------

-- A workflow (`flora-workflow/1` JSON in `definition`). Editing a published workflow
-- makes it a draft again; Leafs keep receiving `published_definition` (the last
-- published copy) until it is published again.
CREATE TABLE IF NOT EXISTS canopy_workflow (
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

-- Wards (care units, canopy_location id as text) offering a workflow; one default per ward.
CREATE TABLE IF NOT EXISTS canopy_workflow_unit (
  workflow_id text NOT NULL REFERENCES canopy_workflow(id) ON DELETE CASCADE,
  unit_key text NOT NULL,
  sort_order integer NOT NULL DEFAULT 0,
  is_default boolean NOT NULL DEFAULT false,
  PRIMARY KEY (workflow_id, unit_key)
);
CREATE INDEX IF NOT EXISTS canopy_workflow_unit_unit ON canopy_workflow_unit(unit_key);
CREATE UNIQUE INDEX IF NOT EXISTS canopy_workflow_unit_one_default
  ON canopy_workflow_unit(unit_key) WHERE is_default;

GRANT SELECT, INSERT, UPDATE, DELETE ON canopy_workflow, canopy_workflow_unit TO flora_view;
GRANT SELECT ON canopy_workflow, canopy_workflow_unit TO flora_sync;

-- The sync API reads pinned form definitions for the ward exchange and upserts the
-- bedside workflow forms of each case snapshot into Form Studio as records.
DO $$
DECLARE name text;
BEGIN
  FOREACH name IN ARRAY ARRAY['formdev_form','formdev_schema_version','formdev_record','formdev_record_revision',
      'formdev_record_index','formdev_data_version','formdev_index_config','formdev_index_coverage',
      'formdev_form_policy','formdev_source','formdev_lookup','formdev_attachment','formdev_style','formdev_font',
      'formdev_asset','formdev_sync_receipt','formdev_conflict'] LOOP
    IF to_regclass(name) IS NOT NULL THEN
      EXECUTE format('GRANT SELECT ON %I TO flora_sync', name);
    END IF;
  END LOOP;
  FOREACH name IN ARRAY ARRAY['formdev_record','formdev_record_revision','formdev_data_version'] LOOP
    IF to_regclass(name) IS NOT NULL THEN
      EXECUTE format('GRANT INSERT, UPDATE ON %I TO flora_sync', name);
    END IF;
  END LOOP;
  IF to_regclass('formdev_record_index') IS NOT NULL THEN
    GRANT INSERT, UPDATE, DELETE ON formdev_record_index TO flora_sync;
  END IF;
END $$;

-- Leaf side -----------------------------------------------------------------

-- The ward's workflow set last received from Canopy ({version, items, forms}); works offline.
CREATE TABLE IF NOT EXISTS leaf_workflow_state (
  id integer PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  version bigint NOT NULL DEFAULT 0,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  synced_at bigint
);

-- The workflow chosen when the case started (a snapshot, incl. its pinned form definitions).
ALTER TABLE cases ADD COLUMN IF NOT EXISTS workflow jsonb;

-- Workflow (Form Studio) forms filled for a case; per-field versions as in case_detail.
CREATE TABLE IF NOT EXISTS case_form_record (
  case_id bigint NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
  form_id text NOT NULL,
  form_version integer NOT NULL,
  data jsonb NOT NULL DEFAULT '{}'::jsonb,
  field_versions jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','completed')),
  updated_at bigint NOT NULL,
  updated_by text,
  PRIMARY KEY (case_id, form_id)
);

GRANT SELECT, INSERT, UPDATE, DELETE ON leaf_workflow_state, case_form_record TO flora_app;
-- Canopy's case reads (cases_read) run as flora_view.
GRANT SELECT ON leaf_workflow_state, case_form_record TO flora_view;

COMMIT;
