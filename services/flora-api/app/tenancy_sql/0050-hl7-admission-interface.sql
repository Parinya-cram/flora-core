BEGIN;

-- Admissions can arrive from an HL7 interface engine (Scope-Life HL7 gateway webhook)
-- as well as from the Canopy ward desk. external_ref makes repeated messages idempotent.
ALTER TABLE canopy_admission
  ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'canopy',
  ADD COLUMN IF NOT EXISTS external_ref text,
  ADD COLUMN IF NOT EXISTS accession_number text,
  ADD COLUMN IF NOT EXISTS appointment_id text;
CREATE UNIQUE INDEX IF NOT EXISTS canopy_admission_external_ref_idx
  ON canopy_admission(source, external_ref) WHERE external_ref IS NOT NULL;
CREATE INDEX IF NOT EXISTS canopy_admission_hn_idx ON canopy_admission(hn, status);

-- Connection to the HL7 gateway (single row).
CREATE TABLE IF NOT EXISTS canopy_hl7_interface (
  id bigint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  enabled boolean NOT NULL DEFAULT false,
  gateway_url text NOT NULL DEFAULT '',
  basic_username text NOT NULL DEFAULT '',
  basic_password text NOT NULL DEFAULT '',
  bearer_token text NOT NULL DEFAULT '',
  verify_tls boolean NOT NULL DEFAULT true,
  webhook_token text NOT NULL DEFAULT '',
  default_unit_key text,
  create_on text[] NOT NULL DEFAULT ARRAY['SIU^S12', 'ORM^O01'],
  updated_at bigint NOT NULL DEFAULT 0,
  updated_by text
);

-- HL7 location (AIL-3 / PV1-3 point of care) -> Canopy ward, optionally one bed's Leaf.
CREATE TABLE IF NOT EXISTS canopy_hl7_location_map (
  code text PRIMARY KEY,
  unit_key text NOT NULL,
  target_leaf_id text,
  note text,
  updated_at bigint NOT NULL
);

-- Every message received on the webhook, and what Canopy did with it.
CREATE TABLE IF NOT EXISTS canopy_hl7_message (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  received_at bigint NOT NULL,
  message_type text,
  control_id text,
  mrn text,
  location_code text,
  status text NOT NULL CHECK (status IN ('applied', 'ignored', 'unrouted', 'error')),
  action text,
  admission_id uuid,
  error text,
  payload jsonb NOT NULL
);
CREATE INDEX IF NOT EXISTS canopy_hl7_message_received_idx ON canopy_hl7_message(received_at DESC);
CREATE INDEX IF NOT EXISTS canopy_hl7_message_status_idx ON canopy_hl7_message(status, received_at DESC);

GRANT SELECT, INSERT, UPDATE ON canopy_hl7_interface TO flora_view;
GRANT SELECT, INSERT, UPDATE, DELETE ON canopy_hl7_location_map TO flora_view;
GRANT SELECT, INSERT, UPDATE ON canopy_hl7_message TO flora_view;
GRANT USAGE, SELECT ON SEQUENCE canopy_hl7_message_id_seq TO flora_view;

COMMIT;
