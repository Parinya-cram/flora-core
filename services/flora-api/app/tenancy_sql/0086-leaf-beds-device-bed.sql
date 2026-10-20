-- Physical topology (Canopy → Topology → Physical): Care unit → Room → Bed.
--
-- A Leaf keeps its primary bed in canopy_leaf_assignment (that bed decides its ward and what the
-- Leaf is told about its location). canopy_leaf_bed lists further beds the same Leaf serves, e.g. one
-- workstation for a whole ER zone. A bed is served by at most one Leaf.
-- canopy_medical_device.bed_id places a registered device at a bed, whether or not it is connected
-- through a gateway.
CREATE TABLE IF NOT EXISTS canopy_leaf_bed (
  leaf_id text NOT NULL REFERENCES sync_leaf_node(leaf_id) ON DELETE CASCADE,
  bed_location_id bigint NOT NULL REFERENCES canopy_location(id) ON DELETE CASCADE,
  created_at bigint NOT NULL,
  PRIMARY KEY (leaf_id, bed_location_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS canopy_leaf_bed_one_leaf ON canopy_leaf_bed (bed_location_id);

ALTER TABLE canopy_medical_device
  ADD COLUMN IF NOT EXISTS bed_id bigint REFERENCES canopy_location(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS canopy_medical_device_bed ON canopy_medical_device (bed_id);

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'flora_view') THEN
    GRANT SELECT, INSERT, DELETE ON canopy_leaf_bed TO flora_view;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'flora_sync') THEN
    GRANT SELECT ON canopy_leaf_bed TO flora_sync;
  END IF;
END $$;
