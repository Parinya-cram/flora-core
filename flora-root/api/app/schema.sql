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

-- Device type catalog: every known medical device model or family, what it speaks and
-- how Flora reaches it. Seeded from reference/device_types.json (built by
-- scripts/build_device_type_seed.py from the files in flora-root/reference/).
-- gateway_device_types links a model to the gateway catalog codes (device-types.json)
-- whose parser covers it. Status follows docs/DEVICE-COMPATIBILITY-CATALOG.md:
-- a driver in code is not a validated model.
CREATE TABLE IF NOT EXISTS device_type_source (
  source_id    text PRIMARY KEY,
  title        text NOT NULL,
  kind         text NOT NULL CHECK (kind IN ('spreadsheet', 'image', 'manual')),
  file_name    text,
  sha256       text,
  description  text,
  imported_at  bigint NOT NULL
);

CREATE TABLE IF NOT EXISTS device_type (
  device_type_id        text PRIMARY KEY,               -- <manufacturer_code>-<model slug>
  manufacturer_code     text NOT NULL,                  -- ge, draeger, philips … (gateway manufacturer codes)
  manufacturer          text NOT NULL,
  country               text,
  category              text NOT NULL,                  -- patient_monitor, anesthesia_machine, ventilator, infusion_pump …
  series                text,
  model                 text NOT NULL,                  -- exact model, or a family such as "MP20–MP90"
  is_family             boolean NOT NULL DEFAULT false,
  year_released         integer,
  care_area             text,
  display_size          text,
  hl7_v2                text,                           -- Yes / No / Optional / Partial
  hl7_fhir              text,
  ieee_11073            text,
  dicom                 text,
  wifi                  text,
  wifi_standard         text,
  lan                   text,
  bluetooth             text,
  usb                   text,
  cellular              text,
  integration_method    text,                           -- vendor route: central station, gateway …
  flora_protocol        text,                           -- protocol lane Flora uses
  flora_adapter         text,                           -- transport at the Flora edge
  gateway_device_types  text[] NOT NULL DEFAULT '{}',
  status                text NOT NULL DEFAULT 'reference_only'
                          CHECK (status IN ('validated', 'integration_tested', 'driver_in_code', 'to_validate', 'reference_only')),
  notes                 text,
  sources               text[] NOT NULL DEFAULT '{}',
  updated_at            bigint NOT NULL
);
CREATE INDEX IF NOT EXISTS device_type_manufacturer ON device_type (manufacturer_code);
CREATE INDEX IF NOT EXISTS device_type_status ON device_type (status);

CREATE TABLE IF NOT EXISTS device_protocol (
  protocol     text PRIMARY KEY,
  version      text,
  transport    text,
  data_format  text,
  use_case     text,
  vendors      text,
  source_id    text REFERENCES device_type_source(source_id)
);

CREATE TABLE IF NOT EXISTS device_connection_type (
  connection_type  text PRIMARY KEY,
  standard         text,
  speed            text,
  range            text,
  use_case         text,
  source_id        text REFERENCES device_type_source(source_id)
);

CREATE TABLE IF NOT EXISTS device_manufacturer (
  manufacturer_code    text PRIMARY KEY,
  name                 text NOT NULL,
  country              text,
  hl7_v2_support       text,
  fhir_support         text,
  wifi_support         text,
  primary_integration  text,
  market_segment       text,
  source_id            text REFERENCES device_type_source(source_id)
);

-- The protocol lanes of the compatibility map: one manufacturer family, one protocol,
-- one Flora edge adapter.
CREATE TABLE IF NOT EXISTS device_protocol_lane (
  lane_no            integer PRIMARY KEY,
  manufacturer_code  text NOT NULL,
  family             text NOT NULL,
  models             text NOT NULL,
  protocol           text NOT NULL,
  adapter            text NOT NULL,
  note               text,
  source_id          text REFERENCES device_type_source(source_id)
);

-- Installs planned at Root, one row per machine: a hospital site (Canopy + appliance), a Leaf or a gateway.
-- Only Root operators create them. The one-time code is shown once and stored as a hash; the hospital's
-- appliance pulls the pending list (signed) so Leafs and gateways on the LAN install without internet.
CREATE TABLE IF NOT EXISTS root_install (
  install_id    text PRIMARY KEY,
  tenant_id     text NOT NULL REFERENCES root_tenant(tenant_id) ON DELETE CASCADE,
  kind          text NOT NULL CHECK (kind IN ('site', 'leaf', 'gateway')),
  node_id       text,                       -- leaf_id / gateway_id the machine will register as
  label         text,
  ward          text,
  room          text,
  bed           text,
  code_hash     text NOT NULL UNIQUE,
  status        text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'claimed', 'installed', 'failed', 'revoked')),
  detail        jsonb NOT NULL DEFAULT '{}',
  created_at    bigint NOT NULL,
  created_by    text,
  expires_at    bigint NOT NULL,
  updated_at    bigint NOT NULL
);
CREATE INDEX IF NOT EXISTS root_install_tenant_idx ON root_install (tenant_id, created_at DESC);
