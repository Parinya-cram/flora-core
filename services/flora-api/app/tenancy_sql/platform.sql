-- Account registry of a multi-account Canopy (schema `platform`). Holds no patient data and no
-- account configuration: only which accounts exist, where their schema is and how Leafs / Haber
-- prove they belong to one (sync secret, stored as a SHA-256 hash).
CREATE SCHEMA IF NOT EXISTS platform;
CREATE SCHEMA IF NOT EXISTS flora_no_account;   -- empty: connections without an account point here

CREATE TABLE IF NOT EXISTS platform.account (
  code text PRIMARY KEY CHECK (code ~ '^[a-z][a-z0-9_]{1,30}$' AND code <> 'platform'),
  name text NOT NULL,
  schema_name text NOT NULL UNIQUE,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended')),
  sync_secret_hash text UNIQUE,
  haber_url text,
  created_at bigint NOT NULL,
  created_by text,
  updated_at bigint NOT NULL
);

CREATE TABLE IF NOT EXISTS platform.schema_migration (
  account_code text NOT NULL REFERENCES platform.account(code) ON DELETE CASCADE,
  file_name text NOT NULL,
  applied_at bigint NOT NULL,
  PRIMARY KEY (account_code, file_name)
);

CREATE TABLE IF NOT EXISTS platform.admin_user (
  username text PRIMARY KEY,
  password_salt text NOT NULL,
  password_hash text NOT NULL,
  name text,
  is_active boolean NOT NULL DEFAULT true,
  created_at bigint NOT NULL,
  last_login_at bigint
);

CREATE TABLE IF NOT EXISTS platform.audit (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  actor text,
  action text NOT NULL,
  account_code text,
  detail jsonb NOT NULL DEFAULT '{}',
  created_at bigint NOT NULL
);

GRANT USAGE ON SCHEMA platform, flora_no_account TO flora_view, flora_sync;
GRANT SELECT ON platform.account TO flora_view, flora_sync;
