BEGIN;

ALTER TABLE theme_scheme_master
  ADD COLUMN IF NOT EXISTS managed_by_canopy smallint NOT NULL DEFAULT 0
  CHECK (managed_by_canopy IN (0, 1));

GRANT SELECT, INSERT, UPDATE, DELETE ON theme_scheme_master TO flora_app;

COMMIT;
