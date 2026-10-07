-- FormDev data layer: attachment content for file and image fields, addressed by SHA-256.
-- Used unless FORMDEV_ATTACHMENT_DIR points the API at a directory instead. Idempotent.
BEGIN;

CREATE TABLE IF NOT EXISTS formdev_attachment (
  sha256 text PRIMARY KEY CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  media_type text NOT NULL,
  size integer NOT NULL CHECK (size >= 0),
  content bytea NOT NULL,
  created_at bigint NOT NULL,
  created_by text
);

GRANT SELECT, INSERT ON formdev_attachment TO flora_view, flora_app;

COMMIT;
