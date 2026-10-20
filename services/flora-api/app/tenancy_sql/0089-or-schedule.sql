-- OR schedule (Canopy → OR schedule): a Canopy admission is the OR "session" of a patient, booked
-- into an OR room for a start time and duration, with OR type, position / anaesthesia technique,
-- equipment and team. journey_state follows the patient through the OR ward (app/or_journey.py):
--   booked (Appointed) → assigned (Waiting) → in_or (Operation) → awaiting_recovery / assigned_recovery /
--   in_recovery (Recovery) → discharged (Completed), or cancelled.
-- Rooms carry a room_type (or / recovery / other); OR rooms an OR type.
BEGIN;

ALTER TABLE canopy_location
  ADD COLUMN IF NOT EXISTS room_type text,
  ADD COLUMN IF NOT EXISTS or_type_code text;
DO $$ BEGIN
  ALTER TABLE canopy_location ADD CONSTRAINT canopy_location_room_type_check CHECK (room_type IS NULL OR room_type IN ('or','recovery','other'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS canopy_or_type (
  code text PRIMARY KEY CHECK (code ~ '^[a-z][a-z0-9_]{0,39}$'),
  name text NOT NULL,
  sort_order integer NOT NULL DEFAULT 100,
  is_active boolean NOT NULL DEFAULT true,
  updated_at bigint NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS canopy_or_equipment (
  code text PRIMARY KEY CHECK (code ~ '^[a-z][a-z0-9_]{0,39}$'),
  name text NOT NULL,
  group_name text,
  sort_order integer NOT NULL DEFAULT 100,
  is_active boolean NOT NULL DEFAULT true,
  updated_at bigint NOT NULL DEFAULT 0
);
INSERT INTO canopy_or_type (code, name, sort_order) VALUES
  ('general', 'General surgery', 10), ('neuro', 'Neurosurgery', 20), ('cardiothoracic', 'Cardiothoracic', 30),
  ('orthopedic', 'Orthopaedics', 40), ('obgyn', 'Obstetrics & gynaecology', 50), ('ent', 'ENT', 60),
  ('eye', 'Ophthalmology', 70), ('angio', 'Angiography / interventional', 80), ('endoscopy', 'Endoscopy', 90)
ON CONFLICT (code) DO NOTHING;
INSERT INTO canopy_or_equipment (code, name, group_name, sort_order) VALUES
  ('c_arm', 'C-arm fluoroscopy', 'Imaging', 10), ('ultrasound', 'Ultrasound', 'Imaging', 20),
  ('microscope', 'Operating microscope', 'Optics', 30), ('endoscope_tower', 'Endoscopy / laparoscopy tower', 'Optics', 40),
  ('navigation', 'Neuronavigation', 'Navigation', 50), ('neuromonitoring', 'Neuromonitoring (IONM)', 'Monitoring', 60),
  ('electrosurgery', 'Electrosurgical unit', 'Energy', 70), ('cell_saver', 'Cell saver', 'Blood', 80),
  ('robot', 'Surgical robot', 'Other', 90)
ON CONFLICT (code) DO NOTHING;

ALTER TABLE canopy_admission
  ADD COLUMN IF NOT EXISTS room_location_id bigint REFERENCES canopy_location(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS duration_min integer,
  ADD COLUMN IF NOT EXISTS or_type_code text,
  ADD COLUMN IF NOT EXISTS equipment jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS team jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS journey_state text NOT NULL DEFAULT 'booked',
  ADD COLUMN IF NOT EXISTS current_leaf_id text,
  ADD COLUMN IF NOT EXISTS current_bed_location_id bigint REFERENCES canopy_location(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS discharge_destination text,
  ADD COLUMN IF NOT EXISTS discharge_note text,
  ADD COLUMN IF NOT EXISTS moved_in_at bigint,
  ADD COLUMN IF NOT EXISTS moved_out_at bigint,
  ADD COLUMN IF NOT EXISTS recovery_in_at bigint,
  ADD COLUMN IF NOT EXISTS discharged_at bigint,
  ADD COLUMN IF NOT EXISTS updated_by text;
DO $$ BEGIN
  ALTER TABLE canopy_admission ADD CONSTRAINT canopy_admission_journey_state_check CHECK (journey_state IN
    ('booked','assigned','in_or','awaiting_recovery','assigned_recovery','in_recovery','discharged','cancelled'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE INDEX IF NOT EXISTS canopy_admission_schedule_idx ON canopy_admission (room_location_id, scheduled_at);

-- Existing admissions get the state their status implies.
UPDATE canopy_admission SET journey_state = CASE
    WHEN status = 'cancelled' THEN 'cancelled'
    WHEN status = 'started' AND coalesce(case_status, 'active') IN ('discharged', 'archived') THEN 'discharged'
    WHEN status = 'started' THEN 'in_or'
    ELSE 'booked' END
  WHERE journey_state = 'booked';

-- Every step of a session (booked, assigned, moved in / out, discharged, rescheduled ...), from Canopy, a Leaf or HL7.
CREATE TABLE IF NOT EXISTS canopy_session_event (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  admission_id uuid NOT NULL REFERENCES canopy_admission(id) ON DELETE CASCADE,
  event text NOT NULL,
  location_id bigint REFERENCES canopy_location(id) ON DELETE SET NULL,
  leaf_id text,
  at bigint NOT NULL,
  source text NOT NULL DEFAULT 'canopy' CHECK (source IN ('canopy','leaf','hl7')),
  actor text,
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at bigint NOT NULL
);
CREATE INDEX IF NOT EXISTS canopy_session_event_admission ON canopy_session_event (admission_id, at);

DO $$ BEGIN
  GRANT SELECT, INSERT, UPDATE, DELETE ON canopy_or_type, canopy_or_equipment TO flora_view;
  GRANT SELECT, INSERT ON canopy_session_event TO flora_view;
  GRANT UPDATE ON canopy_location TO flora_view;
EXCEPTION WHEN undefined_object THEN NULL; END $$;
DO $$ BEGIN
  GRANT SELECT ON canopy_or_type, canopy_or_equipment TO flora_sync;
  GRANT SELECT, INSERT ON canopy_session_event TO flora_sync;
EXCEPTION WHEN undefined_object THEN NULL; END $$;

COMMIT;
