BEGIN;
-- Canopy's medication / fluid / output catalogue travels to Leafs with the directory
-- exchange (app/io_catalog.py): the sync API reads it, Leafs record the version applied.
GRANT SELECT ON io_item_master, io_group_master TO flora_sync;
ALTER TABLE auth_directory_state ADD COLUMN IF NOT EXISTS io_catalog_version bigint NOT NULL DEFAULT 0;
COMMIT;
