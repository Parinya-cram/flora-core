-- FormDev data layer: attachment content for file and image fields (SQLite migration 5). Mirrors 0064-formdev-attachment.sql.
CREATE TABLE IF NOT EXISTS formdev_attachment (
  sha256 text PRIMARY KEY,
  media_type text NOT NULL,
  size integer NOT NULL,
  content blob NOT NULL,
  created_at integer NOT NULL,
  created_by text
);
