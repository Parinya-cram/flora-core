BEGIN;

-- Gateways check in with Haber (device license). Haber forwards each check-in to the
-- sync API, so Canopy keeps every gateway's configuration and license grant. Devices
-- belong to a Leaf, and through it to a ward (canopy_leaf_unit).
CREATE TABLE IF NOT EXISTS canopy_gateway (
  gateway_id text PRIMARY KEY,
  version text,
  site jsonb NOT NULL DEFAULT '{}'::jsonb,
  license jsonb NOT NULL DEFAULT '{}'::jsonb,
  config_hash text,
  first_seen_at bigint NOT NULL,
  last_seen_at bigint NOT NULL,
  config_changed_at bigint NOT NULL
);

CREATE TABLE IF NOT EXISTS canopy_gateway_device (
  gateway_id text NOT NULL REFERENCES canopy_gateway(gateway_id) ON DELETE CASCADE,
  device_id text NOT NULL,
  leaf_id text,
  device_type text NOT NULL,
  pod text,
  label text,
  enabled boolean NOT NULL DEFAULT true,
  options jsonb NOT NULL DEFAULT '{}'::jsonb,
  serial_number text,
  asset_tag text,
  station text,
  location text,
  installed_at bigint,
  notes text,
  parser_status text,
  updated_at bigint,
  PRIMARY KEY (gateway_id, device_id)
);
CREATE INDEX IF NOT EXISTS canopy_gateway_device_leaf_idx ON canopy_gateway_device(leaf_id);

-- One row per distinct configuration, so changes can be reviewed and restored.
CREATE TABLE IF NOT EXISTS canopy_gateway_config_snapshot (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  gateway_id text NOT NULL REFERENCES canopy_gateway(gateway_id) ON DELETE CASCADE,
  config_hash text NOT NULL,
  config jsonb NOT NULL,
  captured_at bigint NOT NULL
);
CREATE INDEX IF NOT EXISTS canopy_gateway_config_snapshot_idx
  ON canopy_gateway_config_snapshot(gateway_id, captured_at DESC);

-- Configuration Canopy wants a gateway to run (clone from another gateway, restore a
-- snapshot, or pre-provision a new gateway). Haber hands it over at the next check-in.
ALTER TABLE canopy_gateway
  ADD COLUMN IF NOT EXISTS desired_config jsonb,
  ADD COLUMN IF NOT EXISTS desired_version bigint NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS desired_source text,
  ADD COLUMN IF NOT EXISTS applied_version bigint NOT NULL DEFAULT 0;

GRANT SELECT, INSERT, UPDATE, DELETE
  ON canopy_gateway, canopy_gateway_device, canopy_gateway_config_snapshot TO flora_sync;
GRANT USAGE, SELECT ON SEQUENCE canopy_gateway_config_snapshot_id_seq TO flora_sync;
GRANT SELECT ON canopy_gateway, canopy_gateway_device, canopy_gateway_config_snapshot TO flora_view;
-- Canopy administrators clone configurations and pre-provision new gateways.
GRANT INSERT ON canopy_gateway TO flora_view;
GRANT UPDATE (desired_config, desired_version, desired_source) ON canopy_gateway TO flora_view;

COMMIT;
