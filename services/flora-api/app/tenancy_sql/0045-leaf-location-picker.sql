BEGIN;

-- A Leaf may choose its own bed from Canopy's location tree (Settings > Location).
-- The sync API records that choice as the Leaf's assignment, the same row Canopy
-- administrators write from the Infrastructure view.
DO $$ BEGIN
  IF to_regclass('canopy_leaf_assignment') IS NOT NULL THEN
    GRANT INSERT, UPDATE ON canopy_leaf_assignment TO flora_sync;
  END IF;
END $$;

COMMIT;
