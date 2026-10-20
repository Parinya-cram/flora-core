\set sync_password `echo "$FLORA_DB_SYNC_PASSWORD"`

SELECT format('CREATE ROLE flora_sync LOGIN PASSWORD %L', :'sync_password')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'flora_sync')\gexec

CREATE TABLE IF NOT EXISTS sync_leaf_node (
  leaf_id text PRIMARY KEY,
  hospital_id text NOT NULL,
  display_name text NOT NULL,
  software_version text,
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  registered_at timestamptz NOT NULL DEFAULT now(),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE TABLE IF NOT EXISTS sync_message (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  leaf_id text NOT NULL REFERENCES sync_leaf_node(leaf_id),
  message_id uuid NOT NULL,
  entity_type text NOT NULL,
  entity_id text NOT NULL,
  operation text NOT NULL CHECK (operation IN ('upsert', 'delete')),
  revision bigint NOT NULL,
  occurred_at timestamptz NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  received_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (leaf_id, message_id)
);

CREATE TABLE IF NOT EXISTS sync_case_index (
  global_case_id uuid PRIMARY KEY,
  hospital_id text NOT NULL,
  leaf_id text NOT NULL REFERENCES sync_leaf_node(leaf_id),
  source_case_id text NOT NULL,
  case_code text,
  hn text,
  status text NOT NULL,
  start_time bigint,
  discharge_time bigint,
  revision bigint NOT NULL,
  snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  last_synced_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (leaf_id, source_case_id)
);

CREATE INDEX IF NOT EXISTS idx_sync_leaf_node_hospital_seen
  ON sync_leaf_node(hospital_id, last_seen_at DESC);
CREATE INDEX IF NOT EXISTS idx_sync_case_index_active
  ON sync_case_index(hospital_id, status, last_synced_at DESC);
CREATE INDEX IF NOT EXISTS idx_sync_message_leaf_revision
  ON sync_message(leaf_id, revision DESC);

SELECT format('GRANT CONNECT ON DATABASE %I TO flora_sync', current_database())\gexec
GRANT USAGE ON SCHEMA public TO flora_sync;
GRANT SELECT, INSERT, UPDATE ON sync_leaf_node, sync_message, sync_case_index TO flora_sync;
GRANT USAGE, SELECT ON SEQUENCE sync_message_id_seq TO flora_sync;

GRANT SELECT ON sync_leaf_node, sync_message, sync_case_index TO flora_view;

