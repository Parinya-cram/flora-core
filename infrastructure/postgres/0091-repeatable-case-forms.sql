-- Repeatable workflow forms (formdev/docs/CANOPY-LEAF-FORM-WORKFLOW.md §12): a form a workflow marks "repeatable" has
-- several copies per case, the first under the form's id and the next as "<form_id>~2", "<form_id>~3"... (up to 99).
-- Canopy's copies accept that key. Idempotent.
BEGIN;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'canopy_case_form_form_id_check') THEN
    ALTER TABLE canopy_case_form DROP CONSTRAINT canopy_case_form_form_id_check;
  END IF;
  ALTER TABLE canopy_case_form ADD CONSTRAINT canopy_case_form_form_id_check
    CHECK (form_id ~ '^[a-z][a-z0-9_]{1,63}(~([2-9]|[1-9][0-9]))?$');
END $$;

COMMIT;
