-- FormDev Phase 4: rebuild the record index once after upgrading.
-- Index rows and subject_id now follow each form's latest published definition (0061). Records written
-- before that keep index rows under their own version and no subject_id, so every form that has records
-- is marked '*' building: queries on its indexed fields and $subject_id answer index_building until the
-- job worker's maintenance runs a full rebuild and clears the marker. Idempotent; no-op on a new database.
BEGIN;

INSERT INTO formdev_index_coverage (form_id, field_id, origin, state, schema_version, updated_at)
SELECT f.form_id, '*', 'definition', 'building', 0, 0
FROM formdev_form f
WHERE EXISTS (SELECT 1 FROM formdev_record r WHERE r.form_id = f.form_id)
ON CONFLICT (form_id, field_id) DO NOTHING;

GRANT DELETE ON formdev_index_coverage TO flora_view, flora_app;

COMMIT;
