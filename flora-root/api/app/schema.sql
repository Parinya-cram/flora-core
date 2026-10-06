CREATE TABLE IF NOT EXISTS root_signing_key (
  key_id       text PRIMARY KEY,
  private_pem  text NOT NULL,
  public_raw   text NOT NULL,               -- base64 Ed25519 public key
  active       boolean NOT NULL DEFAULT true,
  created_at   bigint NOT NULL
);

CREATE TABLE IF NOT EXISTS root_tenant (
  tenant_id     text PRIMARY KEY,           -- one tenant = one hospital = one Canopy
  name          text NOT NULL,
  region        text,
  status        text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended')),
  api_key_hash  text NOT NULL,              -- Canopy authenticates with this key
  created_at    bigint NOT NULL,
  updated_at    bigint NOT NULL
);

CREATE TABLE IF NOT EXISTS root_license (
  bundle_id            text PRIMARY KEY,
  tenant_id            text NOT NULL REFERENCES root_tenant(tenant_id),
  modules              text[] NOT NULL,
  max_leaves           integer NOT NULL,
  max_gateways         integer NOT NULL,
  max_gateway_devices  integer NOT NULL,
  device_types         text[] NOT NULL DEFAULT '{}',
  issued_at            bigint NOT NULL,
  expires_at           bigint NOT NULL,
  revoked_at           bigint,
  current              boolean NOT NULL DEFAULT true
);
CREATE UNIQUE INDEX IF NOT EXISTS root_license_current ON root_license (tenant_id) WHERE current;

-- Applies to every tenant; delivered inside each signed bundle.
CREATE TABLE IF NOT EXISTS root_global_config (
  key         text PRIMARY KEY,
  value       jsonb NOT NULL,
  updated_at  bigint NOT NULL
);

CREATE TABLE IF NOT EXISTS root_checkin (
  tenant_id       text PRIMARY KEY REFERENCES root_tenant(tenant_id),
  last_seen_at    bigint NOT NULL,
  canopy_version  text,
  bundle_id       text,
  usage           jsonb NOT NULL DEFAULT '{}'::jsonb
);

-- Images built by Root CI and pushed to the Root registry. A release pins every
-- service of one component (canopy, leaf, gateway) to an image digest; Haber mirrors
-- the digests into the hospital and the hospital approves the rollout.
CREATE TABLE IF NOT EXISTS root_release (
  release_id    text PRIMARY KEY,               -- <component>-<version>
  component     text NOT NULL CHECK (component IN ('canopy', 'leaf', 'gateway')),
  version       text NOT NULL,
  channel       text NOT NULL DEFAULT 'stable',
  services      jsonb NOT NULL,                 -- {"api": {"repository": "flora/leaf/api", "digest": "sha256:…"}}
  device_types  jsonb NOT NULL DEFAULT '[]'::jsonb,  -- gateway: catalog; "image" names a service key
  notes         text,
  created_at    bigint NOT NULL,
  withdrawn_at  bigint,
  UNIQUE (component, version)
);

ALTER TABLE root_tenant ADD COLUMN IF NOT EXISTS release_channel text NOT NULL DEFAULT 'stable';

-- Root operators. Passwords are scrypt hashes; the browser holds only an opaque
-- session token whose sha256 is stored here.
CREATE TABLE IF NOT EXISTS root_user (
  id                    bigserial PRIMARY KEY,
  username              text NOT NULL UNIQUE,
  password_hash         text NOT NULL,                    -- scrypt$n$r$p$salt$hash
  display_name          text,
  role                  text NOT NULL DEFAULT 'viewer' CHECK (role IN ('admin', 'viewer')),
  enabled               boolean NOT NULL DEFAULT true,
  must_change_password  boolean NOT NULL DEFAULT false,
  failed_logins         integer NOT NULL DEFAULT 0,
  locked_until          bigint,
  created_at            bigint NOT NULL,
  updated_at            bigint NOT NULL,
  last_login_at         bigint
);

CREATE TABLE IF NOT EXISTS root_session (
  token_hash    text PRIMARY KEY,
  user_id       bigint NOT NULL REFERENCES root_user(id) ON DELETE CASCADE,
  created_at    bigint NOT NULL,
  expires_at    bigint NOT NULL,
  last_seen_at  bigint NOT NULL,
  ip            text,
  user_agent    text
);
CREATE INDEX IF NOT EXISTS root_session_expiry ON root_session (expires_at);

-- Who did what on Root: sign-ins (including failures) and every admin change.
CREATE TABLE IF NOT EXISTS root_audit (
  id        bigserial PRIMARY KEY,
  at        bigint NOT NULL,
  username  text,
  action    text NOT NULL,
  target    text,
  ip        text,
  detail    jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS root_audit_at ON root_audit (at DESC);
