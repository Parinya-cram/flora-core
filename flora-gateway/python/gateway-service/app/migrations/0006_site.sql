-- Where this gateway is installed, so people (and Canopy) can tell gateways apart.
CREATE TABLE IF NOT EXISTS gateway_site (
  id               integer PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  display_name     text,                                 -- e.g. "OR-1 anaesthesia station"
  hospital         text,
  building         text,
  floor            text,
  unit             text,                                 -- ward / unit, e.g. OR, ICU, ER, Ward 5A
  unit_type        text,                                 -- or | icu | er | ward | other
  room             text,
  contact          text,
  notes            text,
  updated_at       bigint,
  updated_by       text
);
INSERT INTO gateway_site (id) VALUES (1) ON CONFLICT (id) DO NOTHING;
