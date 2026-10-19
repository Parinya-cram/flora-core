-- Hospital digital twin (Canopy → Digital twin): isometric map of care units, rooms (zones) and beds
-- with live patient status and patient journeys.
--
-- canopy_location.layout   map placement {x, y, w, h} in grid cells: care units on the building floor,
--                          rooms inside their care unit. Empty = placed automatically.
-- canopy_patient_movement  where a patient was moved inside or between units (bed / room / zone),
--                          in addition to what admissions, cases and handovers already tell.
ALTER TABLE canopy_location ADD COLUMN IF NOT EXISTS layout jsonb;

CREATE TABLE IF NOT EXISTS canopy_patient_movement (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  hn text NOT NULL,
  global_case_id uuid,
  from_location_id bigint REFERENCES canopy_location(id) ON DELETE SET NULL,
  to_location_id bigint REFERENCES canopy_location(id) ON DELETE SET NULL,
  zone text,
  event text NOT NULL DEFAULT 'moved'
    CHECK (event IN ('arrived', 'triaged', 'moved', 'transferred', 'admitted', 'discharged')),
  moved_at bigint NOT NULL,
  source text NOT NULL DEFAULT 'canopy',
  note text,
  created_by text,
  created_at bigint NOT NULL
);
CREATE INDEX IF NOT EXISTS canopy_patient_movement_hn ON canopy_patient_movement (hn, moved_at);
CREATE INDEX IF NOT EXISTS canopy_patient_movement_case ON canopy_patient_movement (global_case_id, moved_at);

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'flora_view') THEN
    GRANT SELECT, INSERT ON canopy_patient_movement TO flora_view;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'flora_sync') THEN
    GRANT SELECT, INSERT ON canopy_patient_movement TO flora_sync;
  END IF;
END $$;
