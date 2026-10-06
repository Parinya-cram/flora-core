-- Station admin registry: manufacturers, richer device types and installed
-- devices, plus admin users. Idempotent; gateway-service applies it on start
-- after db/0001-gateway.sql has created the base tables.

CREATE TABLE IF NOT EXISTS gateway_device_manufacturer (
  code             text PRIMARY KEY,
  name             text NOT NULL,
  country          text,
  website          text,
  support_contact  text,
  notes            text,
  created_at       bigint NOT NULL,
  updated_at       bigint NOT NULL
);

ALTER TABLE gateway_device_type ADD COLUMN IF NOT EXISTS manufacturer text
  REFERENCES gateway_device_manufacturer(code) ON UPDATE CASCADE ON DELETE SET NULL;
ALTER TABLE gateway_device_type ADD COLUMN IF NOT EXISTS model text;
ALTER TABLE gateway_device_type ADD COLUMN IF NOT EXISTS description text;

-- Where and what each installed device is, for the station's biomedical record.
ALTER TABLE gateway_device_instance ADD COLUMN IF NOT EXISTS serial_number text;
ALTER TABLE gateway_device_instance ADD COLUMN IF NOT EXISTS asset_tag text;
ALTER TABLE gateway_device_instance ADD COLUMN IF NOT EXISTS station text;     -- e.g. OR-1, ICU bed 3
ALTER TABLE gateway_device_instance ADD COLUMN IF NOT EXISTS location text;
ALTER TABLE gateway_device_instance ADD COLUMN IF NOT EXISTS installed_at bigint;
ALTER TABLE gateway_device_instance ADD COLUMN IF NOT EXISTS notes text;

INSERT INTO gateway_device_manufacturer (code, name, country, website, created_at, updated_at) VALUES
  ('draeger', 'Drägerwerk AG', 'DE', 'https://www.draeger.com', 0, 0),
  ('ge',      'GE HealthCare', 'US', 'https://www.gehealthcare.com', 0, 0),
  ('bbraun',  'B. Braun',      'DE', 'https://www.bbraun.com', 0, 0),
  ('hidro',   'Hidro (HL7 integration profile)', NULL, NULL, 0, 0),
  ('generic', 'Generic / unspecified', NULL, NULL, 0, 0)
ON CONFLICT (code) DO NOTHING;

UPDATE gateway_device_type SET manufacturer = CASE
    WHEN code LIKE 'draeger-%' THEN 'draeger'
    WHEN code LIKE 'ge-%' THEN 'ge'
    WHEN code LIKE 'bbraun-%' THEN 'bbraun'
    WHEN code LIKE 'hidro-%' THEN 'hidro'
    ELSE 'generic' END
  WHERE manufacturer IS NULL;

CREATE TABLE IF NOT EXISTS gateway_user (
  id               bigserial PRIMARY KEY,
  username         text NOT NULL UNIQUE,
  password_hash    text NOT NULL,                        -- scrypt$n$r$p$salt$hash
  display_name     text,
  enabled          boolean NOT NULL DEFAULT true,
  created_at       bigint NOT NULL,
  updated_at       bigint NOT NULL,
  last_login_at    bigint
);

CREATE TABLE IF NOT EXISTS gateway_session (
  token_hash       text PRIMARY KEY,                     -- sha256 of the cookie value
  user_id          bigint NOT NULL REFERENCES gateway_user(id) ON DELETE CASCADE,
  created_at       bigint NOT NULL,
  expires_at       bigint NOT NULL
);
CREATE INDEX IF NOT EXISTS gateway_session_expiry ON gateway_session (expires_at);
