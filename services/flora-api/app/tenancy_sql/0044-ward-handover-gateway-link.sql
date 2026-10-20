BEGIN;

-- Ward page, case handover between Leaves, and the Leaf gateway setup wizard.
-- Leaf and Canopy share one schema; each side uses its own tables below.

-- Leaf side -----------------------------------------------------------------

-- What the Leaf last received from Canopy about its ward (peers, gateways,
-- released handovers). The Ward page reads this; it works offline.
CREATE TABLE IF NOT EXISTS leaf_ward_state (
  id integer PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  synced_at bigint
);

-- Outcome of each sync-worker step, for the Ward page sync indicator.
CREATE TABLE IF NOT EXISTS leaf_sync_status (
  component text PRIMARY KEY,
  last_attempt_at bigint,
  last_ok_at bigint,
  last_error text,
  detail jsonb NOT NULL DEFAULT '{}'::jsonb
);

-- "Sync now": the Leaf API raises the flag, the sync worker polls it.
CREATE TABLE IF NOT EXISTS leaf_sync_control (
  id integer PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  requested_at bigint
);

-- Where the device writer reads bedside data (set by the gateway wizard).
-- Without a row the Leaf falls back to VECTOR_READ_URL from the environment.
CREATE TABLE IF NOT EXISTS leaf_device_source (
  id integer PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  gateway_id text,
  data_api_url text NOT NULL,
  configured_by text,
  configured_at bigint NOT NULL
);

-- Handover: a case continued here from another Leaf, or handed over from here.
ALTER TABLE cases ADD COLUMN IF NOT EXISTS handover_from_leaf_id text;
ALTER TABLE cases ADD COLUMN IF NOT EXISTS handover_from_case_id bigint;
ALTER TABLE cases ADD COLUMN IF NOT EXISTS handover_global_case_id uuid;
ALTER TABLE cases ADD COLUMN IF NOT EXISTS handover_to_leaf_id text;
ALTER TABLE cases ADD COLUMN IF NOT EXISTS handover_at bigint;

GRANT SELECT, INSERT, UPDATE ON leaf_ward_state, leaf_sync_status, leaf_sync_control, leaf_device_source TO flora_app;

-- Canopy side ---------------------------------------------------------------

-- How a Leaf on the gateway's LAN reaches its data-api (reported by the gateway;
-- kept out of `site` so cloning a configuration never copies it).
DO $$ BEGIN
  IF to_regclass('canopy_gateway') IS NOT NULL THEN
    ALTER TABLE canopy_gateway ADD COLUMN IF NOT EXISTS data_api_url text;
  END IF;
END $$;

-- Complete raw copy of each case (every row, not the 24 h viewer window), so a
-- different Leaf can continue the case even when the original Leaf is gone.
CREATE TABLE IF NOT EXISTS canopy_case_export (
  global_case_id uuid PRIMARY KEY,
  leaf_id text NOT NULL,
  source_case_id text NOT NULL,
  revision bigint NOT NULL,
  export jsonb NOT NULL,
  updated_at bigint NOT NULL
);

CREATE TABLE IF NOT EXISTS canopy_case_handover (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  global_case_id uuid NOT NULL,
  from_leaf_id text NOT NULL,
  from_case_id text NOT NULL,
  to_leaf_id text NOT NULL,
  to_case_id bigint,
  status text NOT NULL CHECK (status IN ('claimed', 'imported', 'released', 'cancelled')),
  move_devices boolean NOT NULL DEFAULT false,
  moved_devices jsonb NOT NULL DEFAULT '[]'::jsonb,
  requested_by text,
  export_revision bigint,
  created_at bigint NOT NULL,
  updated_at bigint NOT NULL
);
-- At most one open handover per case.
CREATE UNIQUE INDEX IF NOT EXISTS canopy_case_handover_open
  ON canopy_case_handover (global_case_id) WHERE status IN ('claimed', 'imported');
CREATE INDEX IF NOT EXISTS canopy_case_handover_from ON canopy_case_handover (from_leaf_id, status);

GRANT SELECT, INSERT, UPDATE ON canopy_case_export, canopy_case_handover TO flora_sync;
GRANT SELECT ON canopy_case_export, canopy_case_handover TO flora_view;

COMMIT;
