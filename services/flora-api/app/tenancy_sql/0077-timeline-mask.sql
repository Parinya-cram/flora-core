-- Clinicians mark device readings invalid (artifact, disconnected probe...).
-- A mask covers one parameter over a minute range [from_ts, to_ts]; the device
-- values stay in vital_minutes, the effective timeline leaves them out.
-- Undo revokes a mask (revoked_at) instead of deleting it, so the trail stays.
BEGIN;

CREATE TABLE IF NOT EXISTS case_timeline_mask (
  id bigserial PRIMARY KEY,
  case_id bigint NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
  param_key text NOT NULL,
  from_ts bigint NOT NULL,
  to_ts bigint NOT NULL,
  reason text,
  created_by text,
  created_at bigint NOT NULL,
  revoked_by text,
  revoked_at bigint,
  CONSTRAINT case_timeline_mask_range_check CHECK (to_ts >= from_ts)
);
CREATE INDEX IF NOT EXISTS case_timeline_mask_case_idx ON case_timeline_mask (case_id, param_key, from_ts);

GRANT SELECT, INSERT, UPDATE ON case_timeline_mask TO flora_app;
GRANT USAGE, SELECT ON SEQUENCE case_timeline_mask_id_seq TO flora_app;
DO $$ BEGIN
  GRANT SELECT ON case_timeline_mask TO flora_view;
EXCEPTION WHEN undefined_object THEN NULL; END $$;

COMMIT;
