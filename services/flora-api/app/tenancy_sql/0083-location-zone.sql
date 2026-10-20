-- Zone of a room: the hospital's own name for a functional area of a care unit, e.g. in an
-- emergency department "Resuscitation (Red)", "Trauma", "Fast track", "Observation". Zone names
-- are hospital-specific (not a national standard); only rooms carry one.
ALTER TABLE canopy_location ADD COLUMN IF NOT EXISTS zone text;
CREATE INDEX IF NOT EXISTS canopy_location_zone ON canopy_location (parent_id, zone) WHERE zone IS NOT NULL;
