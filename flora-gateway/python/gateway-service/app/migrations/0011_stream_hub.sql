-- Leaf live stream (stream-hub, docs/live-stream/PROTOCOL.md): Leaf tokens, the audit of
-- case UUID ↔ device bindings, and device types whose instances share one pod parser.

-- A Leaf proves itself to the stream hub with a token issued on the admin page. Only the
-- sha256 (hex) is kept; the token is shown once. A Leaf may hold several (rotation).
CREATE TABLE IF NOT EXISTS gateway_leaf_token (
    id serial PRIMARY KEY,
    leaf_id text NOT NULL,
    token_hash text NOT NULL UNIQUE,
    label text,
    created_at timestamptz NOT NULL DEFAULT now(),
    created_by text,
    revoked_at timestamptz
);
CREATE INDEX IF NOT EXISTS gateway_leaf_token_leaf ON gateway_leaf_token (leaf_id) WHERE revoked_at IS NULL;

-- One row per bind on a stream session; closed with unbound_at and a reason:
-- the Leaf's unbind reason (discharged, archived, edited, case_inactive), disconnect or revoked.
CREATE TABLE IF NOT EXISTS gateway_case_binding (
    id bigserial PRIMARY KEY,
    session_id uuid NOT NULL,
    leaf_id text NOT NULL,
    case_uuid uuid NOT NULL,
    device_id text NOT NULL,
    mode text NOT NULL CHECK (mode IN ('exclusive', 'shared')),
    bound_at timestamptz NOT NULL DEFAULT now(),
    unbound_at timestamptz,
    unbind_reason text,
    last_acked_seq bigint,
    delivered boolean NOT NULL DEFAULT false   -- reported to Canopy
);
CREATE INDEX IF NOT EXISTS gateway_case_binding_open ON gateway_case_binding (device_id) WHERE unbound_at IS NULL;
CREATE INDEX IF NOT EXISTS gateway_case_binding_case ON gateway_case_binding (case_uuid, bound_at DESC);
CREATE INDEX IF NOT EXISTS gateway_case_binding_recent ON gateway_case_binding (bound_at DESC);

-- Device types whose monitors share one pod (e.g. M540s on one multicast or relay pod) run
-- one parser container per pod that splits frames by source_ip. NULL = not set by Canopy;
-- a later sync without the field keeps the value.
ALTER TABLE gateway_device_type ADD COLUMN IF NOT EXISTS demux boolean;
UPDATE gateway_device_type SET demux = true WHERE code = 'draeger-iacs-m540' AND demux IS NULL;
