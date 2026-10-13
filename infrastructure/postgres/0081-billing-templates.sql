-- Itemize (billing) templates for Workflow Studio, like standing orders: a curated,
-- ordered set of groups and billing items (from billing_item), optionally preselected
-- with a default quantity. A workflow refers to one template (definition.billing.template_id),
-- so one template can serve many workflows. Published templates travel to Leafs with the
-- ward's workflows (leaf_workflow_state.payload.billing_templates) and drive the Leaf
-- Billing screen. Format: flora-billing-template/1 (app/billing_templates.py).
BEGIN;

CREATE TABLE IF NOT EXISTS canopy_billing_template (
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

GRANT SELECT, INSERT, UPDATE, DELETE ON canopy_billing_template TO flora_view;
DO $$ BEGIN
  GRANT SELECT ON canopy_billing_template TO flora_sync;
EXCEPTION WHEN undefined_object THEN NULL; END $$;

COMMIT;
