-- Form Studio template library (SQLite migration 7). Mirrors 0087-formdev-template.sql.
CREATE TABLE IF NOT EXISTS formdev_template (
  template_id text PRIMARY KEY,
  title text NOT NULL,
  description text NOT NULL DEFAULT '',
  origin text NOT NULL,
  status text NOT NULL,
  definition text NOT NULL,
  report text,
  sources text NOT NULL DEFAULT '[]',
  version integer NOT NULL,
  created_at integer NOT NULL,
  created_by text,
  updated_at integer NOT NULL,
  updated_by text
);
CREATE INDEX IF NOT EXISTS formdev_template_updated ON formdev_template (updated_at DESC);
