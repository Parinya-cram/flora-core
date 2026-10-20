BEGIN;

ALTER TABLE auth_user
  ADD COLUMN IF NOT EXISTS staff_directory_id bigint REFERENCES staff_directory(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS parameter_preferences jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS report_preferences jsonb NOT NULL DEFAULT '{}'::jsonb;

UPDATE auth_user account
SET staff_directory_id=staff.id
FROM staff_directory staff
WHERE account.staff_directory_id IS NULL
  AND nullif(account.hospital_id,'') IS NOT NULL
  AND staff.hospital_id=account.hospital_id
  AND staff.is_active=1;

CREATE INDEX IF NOT EXISTS auth_user_staff_directory_idx ON auth_user(staff_directory_id);
CREATE UNIQUE INDEX IF NOT EXISTS auth_user_staff_directory_unique
  ON auth_user(staff_directory_id) WHERE staff_directory_id IS NOT NULL;

GRANT SELECT,INSERT,UPDATE ON auth_user TO flora_app;

COMMIT;
