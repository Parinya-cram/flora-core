ALTER TABLE workstation_context
  ADD COLUMN IF NOT EXISTS control_plane_version bigint NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS canopy_location (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  parent_id bigint REFERENCES canopy_location(id) ON DELETE RESTRICT,
  kind text NOT NULL CHECK (kind IN ('hospital', 'building', 'care_unit', 'room', 'bed')),
  code text,
  name text NOT NULL,
  is_active boolean NOT NULL DEFAULT true,
  sort_order integer NOT NULL DEFAULT 0,
  created_at bigint NOT NULL,
  updated_at bigint NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS canopy_location_parent_name_unique
  ON canopy_location (coalesce(parent_id, 0), lower(name));
CREATE INDEX IF NOT EXISTS canopy_location_parent_idx
  ON canopy_location (parent_id, sort_order, name);

CREATE TABLE IF NOT EXISTS canopy_leaf_assignment (
  leaf_id text PRIMARY KEY REFERENCES sync_leaf_node(leaf_id) ON DELETE CASCADE,
  bed_location_id bigint NOT NULL REFERENCES canopy_location(id) ON DELETE RESTRICT,
  desired_config jsonb NOT NULL DEFAULT '{}'::jsonb,
  desired_version bigint NOT NULL DEFAULT 0,
  applied_version bigint NOT NULL DEFAULT 0,
  assigned_at bigint NOT NULL,
  updated_at bigint NOT NULL
);

CREATE INDEX IF NOT EXISTS canopy_leaf_assignment_location_idx
  ON canopy_leaf_assignment (bed_location_id);

CREATE TABLE IF NOT EXISTS canopy_leaf_group (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name text NOT NULL,
  description text NOT NULL DEFAULT '',
  is_active boolean NOT NULL DEFAULT true,
  created_at bigint NOT NULL,
  updated_at bigint NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS canopy_leaf_group_name_unique
  ON canopy_leaf_group (lower(name));

CREATE TABLE IF NOT EXISTS canopy_leaf_group_member (
  group_id bigint NOT NULL REFERENCES canopy_leaf_group(id) ON DELETE CASCADE,
  leaf_id text NOT NULL REFERENCES sync_leaf_node(leaf_id) ON DELETE CASCADE,
  created_at bigint NOT NULL,
  PRIMARY KEY (group_id, leaf_id)
);

GRANT SELECT, INSERT, UPDATE ON canopy_location, canopy_leaf_assignment,
  canopy_leaf_group, canopy_leaf_group_member TO flora_view;
GRANT DELETE ON canopy_leaf_group_member TO flora_view;
GRANT USAGE, SELECT ON SEQUENCE canopy_location_id_seq, canopy_leaf_group_id_seq TO flora_view;

GRANT SELECT ON canopy_location, canopy_leaf_group, canopy_leaf_group_member TO flora_sync;
GRANT SELECT, UPDATE (applied_version, updated_at) ON canopy_leaf_assignment TO flora_sync;

GRANT SELECT, UPDATE (hospital_name, building_name, care_unit_name, room_name, bed_name,
  timezone, date_format, time_format, updated_at, control_plane_version)
  ON workstation_context TO flora_app;
