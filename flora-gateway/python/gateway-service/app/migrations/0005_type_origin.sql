-- Where a device type was defined: 'root' (a Root release, through Canopy), 'canopy'
-- (this hospital's own type, defined at its Canopy) or 'gateway' (a local template).
ALTER TABLE gateway_device_type ADD COLUMN IF NOT EXISTS origin text NOT NULL DEFAULT 'root'
  CHECK (origin IN ('root', 'canopy', 'gateway'));
UPDATE gateway_device_type SET origin = 'gateway' WHERE source <> 'haber';
