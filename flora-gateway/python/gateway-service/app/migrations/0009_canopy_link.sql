-- How this gateway reaches Canopy, set on the gateway's own admin page. Once set, the
-- gateway checks in with Canopy (Haber) and Canopy owns the location (site). Empty
-- values fall back to the environment (HABER_URL, FLORA_GATEWAY_ID, HABER_GATEWAY_TOKEN).
CREATE TABLE IF NOT EXISTS gateway_canopy_link (
  id               integer PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  canopy_url       text,                                 -- e.g. https://canopy.hospital.local
  gateway_id       text,
  gateway_key      text,                                 -- never returned by the API
  updated_at       bigint,
  updated_by       text
);
INSERT INTO gateway_canopy_link (id) VALUES (1) ON CONFLICT (id) DO NOTHING;
