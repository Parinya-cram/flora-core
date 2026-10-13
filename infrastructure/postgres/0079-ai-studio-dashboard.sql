-- AI Studio dashboards: a grid board (cols x rows) of widgets placed by drag and drop.
-- widgets: [{id, type, x, y, w, h, title, config}] with x/y the top-left cell (0-based) and w/h
-- the span in cells (asymmetric spans such as 2x1 allowed). Types: snippet (a kept visual, by id),
-- html (sandboxed), image, text, and predefined widgets (system_status, active_cases,
-- gateway_alerts, case_counts, clock). Private to the owner unless shared, like snippets.

CREATE TABLE IF NOT EXISTS ai_studio_dashboard (
  id uuid PRIMARY KEY,
  owner_user_id bigint NOT NULL REFERENCES auth_user(id) ON DELETE CASCADE,
  title text NOT NULL,
  cols integer NOT NULL DEFAULT 3 CHECK (cols BETWEEN 1 AND 6),
  rows integer NOT NULL DEFAULT 3 CHECK (rows BETWEEN 1 AND 6),
  row_height integer NOT NULL DEFAULT 220 CHECK (row_height BETWEEN 120 AND 480),
  widgets jsonb NOT NULL DEFAULT '[]'::jsonb,
  shared boolean NOT NULL DEFAULT false,
  created_at bigint NOT NULL,
  updated_at bigint NOT NULL
);
CREATE INDEX IF NOT EXISTS ai_studio_dashboard_owner_idx ON ai_studio_dashboard (owner_user_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS ai_studio_dashboard_shared_idx ON ai_studio_dashboard (shared, updated_at DESC) WHERE shared;

GRANT SELECT, INSERT, UPDATE, DELETE ON ai_studio_dashboard TO flora_view;
