-- Case UUID ↔ device bindings recorded by each Gateway's stream-hub (gateway_case_binding,
-- docs/live-stream/PROTOCOL.md). Gateways send new and closed rows through Haber; a resend
-- never reopens a closed row, so delivery is idempotent.
CREATE TABLE IF NOT EXISTS canopy_gateway_case_binding (
  gateway_id     text NOT NULL,
  binding_id     bigint NOT NULL,                       -- the gateway's own row id
  session_id     uuid NOT NULL,
  leaf_id        text NOT NULL,
  case_uuid      uuid NOT NULL,                         -- sync_case_index.global_case_id
  device_id      text NOT NULL,
  mode           text NOT NULL,
  bound_at       timestamptz NOT NULL,
  unbound_at     timestamptz,
  unbind_reason  text,
  last_acked_seq bigint,
  updated_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (gateway_id, binding_id)
);
CREATE INDEX IF NOT EXISTS canopy_gateway_case_binding_case ON canopy_gateway_case_binding (case_uuid, bound_at DESC);
CREATE INDEX IF NOT EXISTS canopy_gateway_case_binding_leaf ON canopy_gateway_case_binding (leaf_id, bound_at DESC);
CREATE INDEX IF NOT EXISTS canopy_gateway_case_binding_open ON canopy_gateway_case_binding (gateway_id, device_id)
  WHERE unbound_at IS NULL;

-- The sync API (Haber relay) writes; the Canopy UI API reads.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'flora_sync') THEN
    GRANT SELECT, INSERT, UPDATE ON canopy_gateway_case_binding TO flora_sync;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'flora_view') THEN
    GRANT SELECT ON canopy_gateway_case_binding TO flora_view;
  END IF;
END $$;
