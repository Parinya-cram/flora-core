-- Staff directory owned by Canopy, synced to Leafs by ward (app/staff_sync.py).
-- staff_code (doctor / nurse code, e.g. licence number) identifies a person across nodes:
-- required for doctor and nurse roles to sync. A Leaf may add staff; it pushes them with
-- their code and Canopy keeps its own record when the code already exists. Records that
-- came from Canopy are read-only on the Leaf (directory_managed = 1).
BEGIN;

ALTER TABLE staff_role
  ADD COLUMN IF NOT EXISTS staff_type text NOT NULL DEFAULT 'other',
  ADD COLUMN IF NOT EXISTS is_active bigint NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS updated_at bigint NOT NULL DEFAULT 0;
DO $$ BEGIN
  ALTER TABLE staff_role ADD CONSTRAINT staff_role_type_check CHECK (staff_type IN ('doctor','nurse','other'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- The roles the Leaf staff screen has always offered; empty before this migration.
INSERT INTO staff_role (id, display_name, sort_order, staff_type, updated_at) VALUES
  ('anesthetist', 'Anesthetist', 1, 'doctor', 1),
  ('assistant', 'Assistant', 2, 'other', 1),
  ('circulatingNurse', 'Circulating nurse', 3, 'nurse', 1),
  ('fellowAnesthetist', 'Fellow Anesthetist', 4, 'doctor', 1),
  ('instrumentNurse', 'Instrument nurse', 5, 'nurse', 1),
  ('medicalStudent', 'Medical Student', 6, 'other', 1),
  ('nurseAnesthetist', 'Nurse anesthetist', 7, 'nurse', 1),
  ('rotateResident', 'Rotate resident', 8, 'doctor', 1),
  ('scrubNurse', 'Scrub nurse', 9, 'nurse', 1),
  ('surgeon', 'Surgeon', 10, 'doctor', 1),
  ('surgeryResident', 'Surgery resident', 11, 'doctor', 1),
  ('anesthetistResident', 'Anesthetist Resident', 12, 'doctor', 1)
ON CONFLICT (id) DO NOTHING;

ALTER TABLE staff_directory
  ADD COLUMN IF NOT EXISTS staff_code text,
  ADD COLUMN IF NOT EXISTS all_units boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS directory_version bigint NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS directory_pending smallint NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS directory_managed smallint NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS sync_error text,
  ADD COLUMN IF NOT EXISTS origin_leaf text,
  ADD COLUMN IF NOT EXISTS needs_review boolean NOT NULL DEFAULT false;
CREATE UNIQUE INDEX IF NOT EXISTS staff_directory_code_key ON staff_directory (lower(staff_code))
  WHERE staff_code IS NOT NULL AND staff_code <> '';
CREATE INDEX IF NOT EXISTS staff_directory_pending ON staff_directory (directory_pending) WHERE directory_pending = 1;

ALTER TABLE case_staff ADD COLUMN IF NOT EXISTS staff_code text;

-- Canopy: the wards (care units) each person works in; all_units = every ward.
CREATE TABLE IF NOT EXISTS staff_directory_unit (
  staff_id bigint NOT NULL REFERENCES staff_directory(id) ON DELETE CASCADE,
  unit_key text NOT NULL,
  unit_name text,
  PRIMARY KEY (staff_id, unit_key)
);

GRANT SELECT, INSERT, UPDATE, DELETE ON staff_role, staff_directory, staff_directory_unit TO flora_app;
DO $$ BEGIN
  GRANT SELECT, INSERT, UPDATE, DELETE ON staff_role, staff_directory, staff_directory_unit TO flora_sync;
  GRANT USAGE, SELECT ON SEQUENCE staff_directory_id_seq TO flora_sync;
EXCEPTION WHEN undefined_object THEN NULL; END $$;
DO $$ BEGIN
  GRANT SELECT, INSERT, UPDATE, DELETE ON staff_role, staff_directory, staff_directory_unit TO flora_view;
  GRANT USAGE, SELECT ON SEQUENCE staff_directory_id_seq TO flora_view;
EXCEPTION WHEN undefined_object THEN NULL; END $$;

COMMIT;
