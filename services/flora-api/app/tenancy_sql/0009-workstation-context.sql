CREATE TABLE IF NOT EXISTS workstation_context (
  id smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  hospital_name text NOT NULL,
  building_name text NOT NULL,
  care_unit_name text NOT NULL,
  room_name text NOT NULL,
  bed_name text NOT NULL,
  timezone text NOT NULL DEFAULT 'Asia/Bangkok',
  updated_at bigint NOT NULL
);

INSERT INTO workstation_context
  (id, hospital_name, building_name, care_unit_name, room_name, bed_name, timezone, updated_at)
VALUES
  (1, 'Hospital', 'Main building', 'Perioperative unit', 'Operating room', 'Bed / workstation 1', 'Asia/Bangkok', 0)
ON CONFLICT (id) DO NOTHING;

GRANT SELECT, INSERT, UPDATE ON workstation_context TO flora_app;
