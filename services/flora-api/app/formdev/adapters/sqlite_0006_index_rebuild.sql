-- FormDev Phase 4 (SQLite migration 6). Mirrors 0065-formdev-index-rebuild.sql: forms with records are
-- marked '*' building until the job worker's maintenance rebuilds their index under the latest-version rule.
INSERT OR IGNORE INTO formdev_index_coverage (form_id, field_id, origin, state, schema_version, updated_at)
SELECT f.form_id, '*', 'definition', 'building', 0, 0
FROM formdev_form f
WHERE EXISTS (SELECT 1 FROM formdev_record r WHERE r.form_id = f.form_id);
