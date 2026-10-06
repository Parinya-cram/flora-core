-- Admin vs operator accounts, and the parser images Canopy (Haber) has delivered.
-- Device types normally come from Canopy; a gateway admin may add local templates,
-- but only on an image Canopy delivered and with a parser that image contains.

ALTER TABLE gateway_user ADD COLUMN IF NOT EXISTS role text NOT NULL DEFAULT 'operator'
  CHECK (role IN ('admin', 'operator'));
UPDATE gateway_user SET role = 'admin';   -- every account before roles existed was a full admin

CREATE TABLE IF NOT EXISTS gateway_parser_image (
  image            text PRIMARY KEY,                     -- reference passed to Docker (tag or repo@digest)
  version          text,
  registry         text,
  parsers          text[] NOT NULL DEFAULT '{}',
  release_id       text,
  synced_at        bigint NOT NULL
);
