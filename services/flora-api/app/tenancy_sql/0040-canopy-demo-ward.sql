BEGIN;

-- Demo mode: an administrator can generate a "Demo Ward" (care_unit with is_demo)
-- holding synthetic Leafs, cases and archive rows for showing report statistics.
-- Demo rows never count towards the Canopy centre's own figures: fleet views
-- exclude them unless the demo ward is selected explicitly, and reports read the
-- 'flora-demo' archive source only for that ward.
ALTER TABLE canopy_location ADD COLUMN IF NOT EXISTS is_demo boolean NOT NULL DEFAULT false;

CREATE OR REPLACE VIEW canopy_leaf_unit AS
SELECT assignment.leaf_id, unit.id::text AS unit_key, unit.name AS unit_name, unit.is_demo
FROM canopy_leaf_assignment assignment
JOIN canopy_location bed ON bed.id = assignment.bed_location_id
JOIN canopy_location room ON room.id = bed.parent_id
JOIN canopy_location unit ON unit.id = room.parent_id AND unit.kind = 'care_unit';

-- The Canopy API (flora_view) writes the demo data itself ...
GRANT INSERT ON sync_leaf_node, sync_case_index TO flora_view;
GRANT INSERT ON archive_case, archive_case_context, archive_staff_assignment,
  archive_event, archive_form, archive_form_field, archive_case_report TO flora_view;

-- ... but may only delete it through this function, which touches demo rows only:
-- Leafs 'demo-%', archive source 'flora-demo' and is_demo locations.
CREATE OR REPLACE FUNCTION canopy_demo_reset() RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  demo_locations bigint[];
  demo_keys text[];
  removed_cases integer;
  removed_leaves integer;
  removed_archive integer;
BEGIN
  WITH RECURSIVE tree AS (
    SELECT id FROM canopy_location WHERE is_demo
    UNION SELECT child.id FROM canopy_location child JOIN tree ON child.parent_id = tree.id
  ) SELECT coalesce(array_agg(id), '{}') INTO demo_locations FROM tree;
  SELECT coalesce(array_agg(id::text), '{}') INTO demo_keys
  FROM canopy_location WHERE is_demo AND kind = 'care_unit';

  DELETE FROM sync_case_index WHERE leaf_id LIKE 'demo-%';
  GET DIAGNOSTICS removed_cases = ROW_COUNT;
  DELETE FROM sync_message WHERE leaf_id LIKE 'demo-%';
  DELETE FROM canopy_leaf_assignment
  WHERE leaf_id LIKE 'demo-%' OR bed_location_id = ANY(demo_locations);
  DELETE FROM sync_leaf_node WHERE leaf_id LIKE 'demo-%';
  GET DIAGNOSTICS removed_leaves = ROW_COUNT;
  DELETE FROM archive_case WHERE source_system = 'flora-demo';
  GET DIAGNOSTICS removed_archive = ROW_COUNT;
  DELETE FROM auth_user_unit WHERE unit_key = ANY(demo_keys);
  -- Children first: canopy_location.parent_id is ON DELETE RESTRICT.
  DELETE FROM canopy_location WHERE id = ANY(demo_locations) AND kind = 'bed';
  DELETE FROM canopy_location WHERE id = ANY(demo_locations) AND kind = 'room';
  DELETE FROM canopy_location WHERE id = ANY(demo_locations);
  RETURN jsonb_build_object('cases', removed_cases, 'leaves', removed_leaves,
                            'archive_cases', removed_archive, 'locations', cardinality(demo_locations));
END $$;

-- Keeps the demo Leafs and their active cases looking live while the demo ward is viewed.
CREATE OR REPLACE FUNCTION canopy_demo_heartbeat(unit_keys text[]) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  UPDATE sync_leaf_node leaf SET last_seen_at = now()
  FROM canopy_leaf_unit unit
  WHERE unit.leaf_id = leaf.leaf_id AND unit.is_demo AND unit.unit_key = ANY(unit_keys)
    AND leaf.leaf_id LIKE 'demo-%' AND leaf.last_seen_at < now() - interval '15 seconds';
  UPDATE sync_case_index c SET last_synced_at = now()
  FROM canopy_leaf_unit unit
  WHERE unit.leaf_id = c.leaf_id AND unit.is_demo AND unit.unit_key = ANY(unit_keys)
    AND c.leaf_id LIKE 'demo-%' AND upper(c.status) = 'ACTIVE'
    AND c.last_synced_at < now() - interval '15 seconds';
$$;

REVOKE ALL ON FUNCTION canopy_demo_reset(), canopy_demo_heartbeat(text[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION canopy_demo_reset(), canopy_demo_heartbeat(text[]) TO flora_view;

COMMIT;
