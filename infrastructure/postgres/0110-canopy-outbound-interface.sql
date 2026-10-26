BEGIN;

-- Outbound interface: Canopy sends case data to hospital systems as HL7 v2 ORU^R01 (over MLLP)
-- or FHIR R4 (a Bundle over HTTP). Each destination chooses the wards it serves ('*' = all),
-- whether patient identifiers are sent in full or masked, and its feeds:
--   vitals    -> candles (first / max / min / last) of each parameter every N minutes (>= 1)
--   form      -> when a case form is saved, after a delay or at a daily time
--   discharge -> when a case is discharged, after a delay or at a daily time
-- feeds = {"vitals": {"enabled": true, "interval_minutes": 5},
--          "form": {"enabled": true, "timing": "delay", "delay_seconds": 60, "daily_at": "00:00", "pdf": true},
--          "discharge": {...same as form}}
CREATE TABLE IF NOT EXISTS canopy_outbound_destination (
  id uuid PRIMARY KEY,
  name text NOT NULL,
  enabled boolean NOT NULL DEFAULT false,
  format text NOT NULL DEFAULT 'hl7v2' CHECK (format IN ('hl7v2', 'fhir')),
  hl7_version text NOT NULL DEFAULT '2.5.1',
  host text NOT NULL DEFAULT '',
  port integer,
  url text NOT NULL DEFAULT '',
  auth_type text NOT NULL DEFAULT 'none' CHECK (auth_type IN ('none', 'basic', 'bearer')),
  username text NOT NULL DEFAULT '',
  password text NOT NULL DEFAULT '',
  bearer_token text NOT NULL DEFAULT '',
  verify_tls boolean NOT NULL DEFAULT true,
  identity text NOT NULL DEFAULT 'full' CHECK (identity IN ('full', 'masked')),
  unit_keys text[] NOT NULL DEFAULT ARRAY['*'],
  sending_application text NOT NULL DEFAULT 'FLORA',
  sending_facility text NOT NULL DEFAULT '',
  receiving_application text NOT NULL DEFAULT '',
  receiving_facility text NOT NULL DEFAULT '',
  feeds jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at bigint NOT NULL,
  updated_at bigint NOT NULL,
  updated_by text
);

-- Outbox and log in one: a row is queued with the time it becomes due, then sent (or retried).
-- Messages are built when sent, so a form saved again before its delay ends is sent once, current.
CREATE TABLE IF NOT EXISTS canopy_outbound_message (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  destination_id uuid NOT NULL REFERENCES canopy_outbound_destination(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('vitals', 'form', 'discharge', 'test')),
  case_id uuid,
  period_start bigint,
  period_end bigint,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'error', 'failed', 'cancelled')),
  due_at bigint NOT NULL,
  attempts integer NOT NULL DEFAULT 0,
  next_attempt_at bigint NOT NULL,
  control_id text,
  message_type text,
  payload text,
  response text,
  error text,
  created_at bigint NOT NULL,
  sent_at bigint
);
-- One pending form / discharge message per case and destination: later events fold into it.
CREATE UNIQUE INDEX IF NOT EXISTS canopy_outbound_message_pending_idx
  ON canopy_outbound_message(destination_id, kind, case_id) WHERE status IN ('pending', 'error') AND kind IN ('form', 'discharge');
CREATE INDEX IF NOT EXISTS canopy_outbound_message_due_idx ON canopy_outbound_message(next_attempt_at) WHERE status IN ('pending', 'error');
CREATE INDEX IF NOT EXISTS canopy_outbound_message_created_idx ON canopy_outbound_message(created_at DESC);
CREATE INDEX IF NOT EXISTS canopy_outbound_message_dest_idx ON canopy_outbound_message(destination_id, created_at DESC);

-- What the event detector has seen of each case, so a form save or a discharge fires once.
CREATE TABLE IF NOT EXISTS canopy_outbound_case_state (
  case_id uuid PRIMARY KEY,
  status text,
  form_updated_at text,
  seen_at bigint NOT NULL
);

-- Vitals already sent per destination and case (end of the last candle sent, epoch ms).
CREATE TABLE IF NOT EXISTS canopy_outbound_vitals_state (
  destination_id uuid NOT NULL REFERENCES canopy_outbound_destination(id) ON DELETE CASCADE,
  case_id uuid NOT NULL,
  sent_until bigint NOT NULL,
  PRIMARY KEY (destination_id, case_id)
);

GRANT SELECT, INSERT, UPDATE, DELETE ON canopy_outbound_destination TO flora_view;
GRANT SELECT, INSERT, UPDATE, DELETE ON canopy_outbound_message TO flora_view;
GRANT USAGE, SELECT ON SEQUENCE canopy_outbound_message_id_seq TO flora_view;
GRANT SELECT, INSERT, UPDATE, DELETE ON canopy_outbound_case_state TO flora_view;
GRANT SELECT, INSERT, UPDATE, DELETE ON canopy_outbound_vitals_state TO flora_view;

COMMIT;
