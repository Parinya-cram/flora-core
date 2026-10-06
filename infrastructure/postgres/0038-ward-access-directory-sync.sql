BEGIN;

-- Ward (care unit) access is assigned separately from roles. A user with
-- all_units=1 (or the system_admin role) can open every ward.
ALTER TABLE auth_user
  ADD COLUMN IF NOT EXISTS all_units bigint NOT NULL DEFAULT 0 CHECK (all_units IN (0,1)),
  ADD COLUMN IF NOT EXISTS admin_pin_salt text,
  ADD COLUMN IF NOT EXISTS admin_pin_hash text,
  -- Last-write-wins clock (epoch ms) for identity fields shared between Canopy and Leafs:
  -- name, password, active flag, roles, wards, admin PIN.
  ADD COLUMN IF NOT EXISTS directory_version bigint NOT NULL DEFAULT 0,
  -- Leaf only: 1 = local change waiting to be pushed to Canopy.
  ADD COLUMN IF NOT EXISTS directory_pending bigint NOT NULL DEFAULT 0 CHECK (directory_pending IN (0,1)),
  -- Leaf only: 1 = this account is managed by the Canopy directory.
  ADD COLUMN IF NOT EXISTS directory_managed bigint NOT NULL DEFAULT 0 CHECK (directory_managed IN (0,1));

-- unit_key is the Canopy care_unit location id (as text); unit_name is kept so
-- Leafs can display wards without the Canopy location tree.
CREATE TABLE IF NOT EXISTS auth_user_unit (
  user_id bigint NOT NULL REFERENCES auth_user(id) ON DELETE CASCADE,
  unit_key text NOT NULL,
  unit_name text NOT NULL DEFAULT '',
  created_at bigint NOT NULL,
  PRIMARY KEY (user_id, unit_key)
);
CREATE INDEX IF NOT EXISTS auth_user_unit_key_idx ON auth_user_unit(unit_key);

-- Leaf only: the last directory received from Canopy (single row).
CREATE TABLE IF NOT EXISTS auth_directory_state (
  id bigint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  leaf_unit_key text,
  leaf_unit_name text,
  units jsonb NOT NULL DEFAULT '[]'::jsonb,
  ldap_enabled bigint NOT NULL DEFAULT 0 CHECK (ldap_enabled IN (0,1)),
  synced_at bigint NOT NULL DEFAULT 0
);

UPDATE auth_user SET all_units=1
WHERE id IN (SELECT user_id FROM auth_user_role WHERE role_code='system_admin');

-- Canopy: which ward each Leaf belongs to (bed -> room -> care_unit).
CREATE OR REPLACE VIEW canopy_leaf_unit AS
SELECT assignment.leaf_id, unit.id::text AS unit_key, unit.name AS unit_name
FROM canopy_leaf_assignment assignment
JOIN canopy_location bed ON bed.id = assignment.bed_location_id
JOIN canopy_location room ON room.id = bed.parent_id
JOIN canopy_location unit ON unit.id = room.parent_id AND unit.kind = 'care_unit';

-- Canopy API (flora_view): manage users, roles and ward assignments.
GRANT UPDATE (role, is_active, all_units, admin_pin_salt, admin_pin_hash, directory_version,
              auth_source, hospital_id)
  ON auth_user TO flora_view;
GRANT SELECT, INSERT, DELETE ON auth_user_unit, auth_user_role TO flora_view;
GRANT UPDATE ON auth_user_role TO flora_view;
GRANT SELECT ON canopy_leaf_unit TO flora_view;

-- Sync API (flora_sync): exchange the directory with Leafs.
GRANT SELECT, INSERT, UPDATE ON auth_user TO flora_sync;
GRANT USAGE, SELECT ON SEQUENCE auth_user_id_seq TO flora_sync;
GRANT SELECT, INSERT, UPDATE, DELETE ON auth_user_role, auth_user_unit TO flora_sync;
GRANT SELECT ON auth_role, auth_role_permission, canopy_leaf_unit TO flora_sync;
GRANT INSERT ON auth_audit TO flora_sync;
GRANT USAGE, SELECT ON SEQUENCE auth_audit_id_seq TO flora_sync;

-- Leaf API (flora_app) gets the new tables through default privileges; be explicit
-- for databases created before those defaults existed.
GRANT SELECT, INSERT, UPDATE, DELETE ON auth_user_unit, auth_directory_state TO flora_app;

COMMIT;
