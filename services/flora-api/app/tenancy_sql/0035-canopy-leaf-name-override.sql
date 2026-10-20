BEGIN;

ALTER TABLE sync_leaf_node
  ADD COLUMN IF NOT EXISTS canopy_display_name text;

GRANT SELECT, UPDATE ON sync_leaf_node TO flora_view;

COMMIT;
