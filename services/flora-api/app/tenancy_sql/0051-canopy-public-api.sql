BEGIN;

-- Keys for the Canopy public API (/api/v1) and the MCP server. Only a SHA-256 of the
-- secret is stored; the full key is shown once when it is created.
CREATE TABLE IF NOT EXISTS canopy_api_key (
  id uuid PRIMARY KEY,
  name text NOT NULL,
  prefix text NOT NULL UNIQUE,
  secret_hash text NOT NULL,
  scopes text[] NOT NULL DEFAULT '{}',
  unit_keys text[],                       -- NULL = every (non-demo) ward
  include_demo boolean NOT NULL DEFAULT false,
  created_by text,
  created_at bigint NOT NULL,
  expires_at bigint,
  last_used_at bigint,
  revoked_at bigint,
  revoked_by text
);

-- Every public API / MCP request: who, what, result, and which cases were returned.
CREATE TABLE IF NOT EXISTS canopy_api_access_log (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  at bigint NOT NULL,
  key_id uuid,
  key_prefix text,
  method text NOT NULL,
  path text NOT NULL,
  query text,
  status integer NOT NULL,
  duration_ms integer,
  ip text,
  user_agent text,
  client text,
  tool text,
  case_ids text[],
  error text
);
CREATE INDEX IF NOT EXISTS canopy_api_access_log_at_idx ON canopy_api_access_log(at DESC);
CREATE INDEX IF NOT EXISTS canopy_api_access_log_key_idx ON canopy_api_access_log(key_id, at DESC);

GRANT SELECT, INSERT, UPDATE ON canopy_api_key TO flora_view;
GRANT SELECT, INSERT ON canopy_api_access_log TO flora_view;
GRANT USAGE, SELECT ON SEQUENCE canopy_api_access_log_id_seq TO flora_view;

COMMIT;
