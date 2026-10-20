-- Devices (Canopy): the medical device registry, gateway registry fields, the hospital's own
-- device types, and the hourly activity and on/off events gateways send through Haber.
--
-- Canopy is the master registry. Gateways that check in and devices they report that are not
-- registered yet are added automatically with registry_status 'auto' for an admin to review.
-- Wards: a gateway belongs to canopy_gateway.unit_id (Canopy-owned: set with Set location or in
-- Device Management; the gateway's own site record does not keep it);
-- a device belongs to its own unit_id (from the Leaf it feeds when added automatically).

ALTER TABLE canopy_gateway
  ADD COLUMN IF NOT EXISTS registry_status text NOT NULL DEFAULT 'auto'
    CHECK (registry_status IN ('auto', 'registered', 'retired')),
  ADD COLUMN IF NOT EXISTS display_name text,
  ADD COLUMN IF NOT EXISTS serial_number text,
  ADD COLUMN IF NOT EXISTS asset_tag text,
  ADD COLUMN IF NOT EXISTS registry_notes text,
  ADD COLUMN IF NOT EXISTS registered_at bigint,
  ADD COLUMN IF NOT EXISTS registered_by text,
  ADD COLUMN IF NOT EXISTS unit_id bigint REFERENCES canopy_location(id) ON DELETE SET NULL;

CREATE TABLE IF NOT EXISTS canopy_medical_device (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  display_name text NOT NULL,
  category text,                         -- patient_monitor, ventilator, anesthesia_machine, infusion_pump, …
  device_type text,                      -- gateway device type code, e.g. hl7-patient-monitor
  manufacturer text,
  model text,
  serial_number text,
  asset_tag text,
  unit_id bigint REFERENCES canopy_location(id) ON DELETE SET NULL,   -- care unit (ward)
  location text,                         -- room / bed / station
  status text NOT NULL DEFAULT 'in_service'
    CHECK (status IN ('in_service', 'maintenance', 'out_of_service', 'retired')),
  registry_status text NOT NULL DEFAULT 'registered' CHECK (registry_status IN ('registered', 'auto')),
  gateway_id text,                       -- link to the device as a gateway knows it
  gateway_device_id text,
  acquired_at bigint,
  warranty_until bigint,
  last_pm_at bigint,
  next_pm_at bigint,
  vendor_contact text,
  notes text,
  last_event_type text,                  -- latest on/off event, kept here for fast lists
  last_event_at bigint,
  created_at bigint NOT NULL,
  created_by text,
  updated_at bigint NOT NULL,
  updated_by text,
  CHECK ((gateway_id IS NULL) = (gateway_device_id IS NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS canopy_medical_device_link ON canopy_medical_device (gateway_id, gateway_device_id)
  WHERE gateway_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS canopy_medical_device_asset_tag ON canopy_medical_device (lower(asset_tag))
  WHERE asset_tag IS NOT NULL AND asset_tag <> '';
CREATE INDEX IF NOT EXISTS canopy_medical_device_unit ON canopy_medical_device (unit_id);
CREATE INDEX IF NOT EXISTS canopy_medical_device_serial ON canopy_medical_device (lower(serial_number));

-- One row per hour per device (subject 'device') or for the gateway service (subject 'gateway',
-- device_id ''). `complete` is false while the hour is running; `version` makes resends idempotent.
CREATE TABLE IF NOT EXISTS canopy_device_activity_hour (
  gateway_id text NOT NULL,
  subject text NOT NULL CHECK (subject IN ('gateway', 'device')),
  device_id text NOT NULL DEFAULT '',
  hour_start bigint NOT NULL,
  samples_ok integer NOT NULL DEFAULT 0,
  samples_down integer NOT NULL DEFAULT 0,
  samples_stopped integer NOT NULL DEFAULT 0,
  online_seconds integer NOT NULL DEFAULT 0,
  observations integer NOT NULL DEFAULT 0,
  first_data_ts bigint,
  last_data_ts bigint,
  power_on integer NOT NULL DEFAULT 0,
  power_off integer NOT NULL DEFAULT 0,
  complete boolean NOT NULL DEFAULT false,
  version integer NOT NULL,
  received_at bigint NOT NULL,
  PRIMARY KEY (gateway_id, subject, device_id, hour_start)
);
CREATE INDEX IF NOT EXISTS canopy_device_activity_hour_time ON canopy_device_activity_hour (hour_start);

-- power_on / power_off (basis 'connection'): the device's own link came up / went down.
-- data_resumed / data_stopped (basis 'data'): data flow started / stopped (possibly off).
CREATE TABLE IF NOT EXISTS canopy_device_event (
  gateway_id text NOT NULL,
  event_id bigint NOT NULL,
  device_id text NOT NULL,
  event_type text NOT NULL CHECK (event_type IN ('power_on', 'power_off', 'data_resumed', 'data_stopped')),
  basis text NOT NULL CHECK (basis IN ('connection', 'data')),
  occurred_at bigint NOT NULL,
  detail text,
  received_at bigint NOT NULL,
  PRIMARY KEY (gateway_id, event_id)
);
CREATE INDEX IF NOT EXISTS canopy_device_event_device ON canopy_device_event (gateway_id, device_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS canopy_device_event_time ON canopy_device_event (occurred_at DESC);

-- The hospital's own device types (Canopy → Devices → Device types). Haber adds the enabled ones
-- to the catalog every gateway receives at check-in (origin 'canopy'), running the release's
-- parser image; they are licensed when the Root bundle licenses a type with the same parser.
CREATE TABLE IF NOT EXISTS canopy_device_type (
  code text PRIMARY KEY CHECK (code ~ '^[a-z0-9][a-z0-9_.-]{0,63}$'),
  label text NOT NULL,
  category text NOT NULL DEFAULT 'device',
  manufacturer text,
  model text,
  description text,
  protocol text NOT NULL,
  controller text NOT NULL CHECK (controller IN ('serial', 'socket', 'feeder', 'webhook')),
  parser text NOT NULL,
  default_options jsonb NOT NULL DEFAULT '{}',
  connection_defaults jsonb NOT NULL DEFAULT '{}',
  enabled boolean NOT NULL DEFAULT true,
  created_at bigint NOT NULL,
  created_by text,
  updated_at bigint NOT NULL,
  updated_by text
);

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'flora_sync') THEN
    GRANT SELECT ON canopy_device_type TO flora_sync;
    GRANT SELECT, INSERT, UPDATE ON canopy_medical_device, canopy_device_activity_hour, canopy_device_event TO flora_sync;
    GRANT USAGE, SELECT ON SEQUENCE canopy_medical_device_id_seq TO flora_sync;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'flora_view') THEN
    GRANT SELECT ON canopy_device_activity_hour, canopy_device_event TO flora_view;
    GRANT SELECT, INSERT, UPDATE, DELETE ON canopy_medical_device, canopy_device_type TO flora_view;
    GRANT USAGE, SELECT ON SEQUENCE canopy_medical_device_id_seq TO flora_view;
    GRANT UPDATE (registry_status, display_name, serial_number, asset_tag, registry_notes, registered_at, registered_by,
                  unit_id)
      ON canopy_gateway TO flora_view;
  END IF;
END $$;
