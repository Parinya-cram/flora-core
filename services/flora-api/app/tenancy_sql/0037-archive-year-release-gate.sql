CREATE TABLE IF NOT EXISTS archive_import_year_status (
  archive_year integer PRIMARY KEY,
  status text NOT NULL CHECK (status IN ('importing','ready_for_verification','verified','failed')),
  source_counts jsonb NOT NULL DEFAULT '{}'::jsonb,
  target_counts jsonb NOT NULL DEFAULT '{}'::jsonb,
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  verified_at timestamptz,
  error text
);

GRANT SELECT ON archive_import_year_status TO flora_view;
GRANT SELECT, INSERT, UPDATE, DELETE ON archive_import_year_status TO flora_sync;
