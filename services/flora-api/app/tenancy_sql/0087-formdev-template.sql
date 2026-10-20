-- Form Studio template library: complete form definitions offered as starting points, written by hand or built by
-- the AI form builder from source documents (PDF, images, Word, Excel). A template is a draft until an author marks it
-- reviewed; forms are created from it in Form Studio and only published forms reach Workflow Studio. The source
-- documents stay in formdev_attachment (sources lists their sha256). Idempotent.
BEGIN;

CREATE TABLE IF NOT EXISTS formdev_template (
  template_id text PRIMARY KEY CHECK (template_id ~ '^[a-z][a-z0-9_]{1,63}$'),
  title text NOT NULL,
  description text NOT NULL DEFAULT '',
  origin text NOT NULL CHECK (origin IN ('ai', 'manual', 'import')),
  status text NOT NULL CHECK (status IN ('draft', 'reviewed')),
  definition jsonb NOT NULL,
  report jsonb,
  sources jsonb NOT NULL DEFAULT '[]'::jsonb,
  version integer NOT NULL CHECK (version >= 1),
  created_at bigint NOT NULL,
  created_by text,
  updated_at bigint NOT NULL,
  updated_by text
);

CREATE INDEX IF NOT EXISTS formdev_template_updated ON formdev_template (updated_at DESC);

GRANT SELECT, INSERT, UPDATE, DELETE ON formdev_template TO flora_view, flora_app;

COMMIT;
