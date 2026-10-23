BEGIN;

-- Multi-case Leaf and the live stream from the Gateway stream-hub (docs/live-stream/PROTOCOL.md).
-- Leaf tables; harmless (empty) on Canopy. Existing Leaf databases get this file at leaf-api
-- start-up (app/live_schema.py), since initdb only runs on an empty volume.

-- Gateways this Leaf reads from: data-api for the minute pull, stream-hub for the live stream.
CREATE TABLE IF NOT EXISTS leaf_gateway_link (
  id serial PRIMARY KEY,
  gateway_id text,
  label text,
  data_api_url text,
  stream_url text,
  token text,
  is_default boolean NOT NULL DEFAULT false,
  created_at bigint NOT NULL,
  updated_at bigint NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS leaf_gateway_link_one_default ON leaf_gateway_link (is_default) WHERE is_default;

-- The gateway wizard's singleton source becomes the default link.
DO $$ BEGIN
  IF to_regclass('leaf_device_source') IS NOT NULL THEN
    INSERT INTO leaf_gateway_link (gateway_id, label, data_api_url, is_default, created_at, updated_at)
    SELECT gateway_id, coalesce(gateway_id, 'Gateway'), data_api_url, true, configured_at, configured_at
    FROM leaf_device_source WHERE id = 1 AND NOT EXISTS (SELECT 1 FROM leaf_gateway_link);
  END IF;
END $$;

-- Gateway devices a case records from. Open while released_at is NULL.
CREATE TABLE IF NOT EXISTS case_device_binding (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id bigint NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
  gateway_link_id integer REFERENCES leaf_gateway_link(id) ON DELETE SET NULL,
  device_id text NOT NULL,
  mode text NOT NULL DEFAULT 'exclusive' CHECK (mode IN ('exclusive', 'shared')),
  bound_at bigint NOT NULL,
  released_at bigint,
  release_reason text,
  gateway_state text NOT NULL DEFAULT 'pending' CHECK (gateway_state IN ('pending', 'bound', 'rejected')),
  gateway_detail text
);
CREATE UNIQUE INDEX IF NOT EXISTS case_device_binding_exclusive
  ON case_device_binding (gateway_link_id, device_id) WHERE released_at IS NULL AND mode = 'exclusive';
CREATE INDEX IF NOT EXISTS case_device_binding_open ON case_device_binding (case_id) WHERE released_at IS NULL;
CREATE INDEX IF NOT EXISTS case_device_binding_device ON case_device_binding (gateway_link_id, device_id) WHERE released_at IS NULL;

ALTER TABLE cases ADD COLUMN IF NOT EXISTS bed_label text;

-- One row per bound device-second received from the stream (seq = epoch second); highest rev wins.
CREATE TABLE IF NOT EXISTS stream_second (
  case_id bigint NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
  device_id text NOT NULL,
  seq bigint NOT NULL,
  rev integer NOT NULL DEFAULT 0,
  numerics jsonb NOT NULL DEFAULT '[]'::jsonb,
  received_at bigint NOT NULL,
  PRIMARY KEY (case_id, device_id, seq)
);

-- Waveform samples as received (little-endian int16). Not exported to Canopy.
CREATE TABLE IF NOT EXISTS stream_wave (
  case_id bigint NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
  device_id text NOT NULL,
  channel text NOT NULL,
  t0 bigint NOT NULL,
  rate_hz real NOT NULL,
  samples bytea NOT NULL,
  received_at bigint NOT NULL,
  PRIMARY KEY (case_id, device_id, channel, t0)
);

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'flora_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON leaf_gateway_link, case_device_binding, stream_second, stream_wave TO flora_app;
    GRANT USAGE, SELECT, UPDATE ON SEQUENCE leaf_gateway_link_id_seq TO flora_app;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'flora_view') THEN
    GRANT SELECT ON case_device_binding, stream_second, stream_wave TO flora_view;
    -- Holds the stream-hub token.
    REVOKE ALL ON leaf_gateway_link FROM flora_view;
  END IF;
END $$;

COMMIT;
