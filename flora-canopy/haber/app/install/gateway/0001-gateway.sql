-- Flora Gateway local store. Owned by the gateway; Leaf reads it only through
-- the data-api (Kong → server), never directly.

CREATE TABLE IF NOT EXISTS gateway_device_type (
  code             text PRIMARY KEY,
  label            text NOT NULL,
  category         text NOT NULL DEFAULT 'device',      -- patient_monitor, anesthesia_machine, ventilator, ...
  protocol         text NOT NULL,                        -- hl7v2, json, ascii, ...
  controller       text NOT NULL,                        -- serial | feeder | webhook | socket
  parser           text NOT NULL,                        -- device-medical-service parser name
  image            text NOT NULL,                        -- parser container image
  default_options  jsonb NOT NULL DEFAULT '{}'::jsonb,
  source           text NOT NULL DEFAULT 'local',        -- local | haber
  haber_version    text,
  synced_at        bigint
);

-- Device license slice issued to this gateway by Haber (Canopy), which derives it
-- from the hospital bundle signed by Flora Root.
CREATE TABLE IF NOT EXISTS gateway_license (
  id               integer PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  gateway_id       text NOT NULL,
  tenant_id        text,
  max_devices      integer NOT NULL,
  allowed_types    text[] NOT NULL DEFAULT '{}',
  expires_at       bigint,
  bundle_id        text,
  raw              jsonb NOT NULL,
  synced_at        bigint NOT NULL
);

CREATE TABLE IF NOT EXISTS gateway_device_instance (
  id               bigserial PRIMARY KEY,
  device_id        text NOT NULL UNIQUE,
  label            text,
  device_type      text NOT NULL REFERENCES gateway_device_type(code),
  pod              text NOT NULL,                        -- e.g. socket.or-monitor, serial.COM1
  leaf_id          text,                                 -- Leaf workstation the device belongs to
  options          jsonb NOT NULL DEFAULT '{}'::jsonb,
  enabled          boolean NOT NULL DEFAULT true,
  container_id     text,
  created_at       bigint NOT NULL,
  updated_at       bigint NOT NULL
);

CREATE TABLE IF NOT EXISTS gateway_observation (
  id               bigserial PRIMARY KEY,
  device_id        text NOT NULL,
  source           text,
  protocol         text,
  raw_code         text,
  ivy_param        text NOT NULL,
  value            jsonb,
  unit             text,
  device_ts        bigint,
  system_ts        bigint NOT NULL,
  pod              text
);
CREATE INDEX IF NOT EXISTS gateway_observation_time ON gateway_observation (system_ts);
CREATE INDEX IF NOT EXISTS gateway_observation_device_time ON gateway_observation (device_id, system_ts);

CREATE TABLE IF NOT EXISTS gateway_device_seen (
  device_id          text PRIMARY KEY,
  source             text,
  protocol           text,
  pod                text,
  last_seen_ts       bigint NOT NULL,
  total_samples      bigint NOT NULL DEFAULT 0,
  latest_observation jsonb
);

CREATE TABLE IF NOT EXISTS gateway_log (
  id               bigserial PRIMARY KEY,
  ts               bigint NOT NULL,
  component        text NOT NULL,
  level            text NOT NULL,
  pod              text,
  message          text NOT NULL,
  detail           jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS gateway_log_time ON gateway_log (ts DESC);
