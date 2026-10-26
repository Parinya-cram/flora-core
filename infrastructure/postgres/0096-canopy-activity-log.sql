-- Canopy activity log (Administrator → Logs): who did what on Canopy. Sign-ins (also failed ones),
-- sign-outs, every write request and every patient chart opened; written by the canopy API.
BEGIN;

CREATE TABLE IF NOT EXISTS canopy_activity_log (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  at bigint NOT NULL,
  user_id bigint,
  username text,
  user_name text,
  role text,
  category text NOT NULL,
  action text NOT NULL,
  method text,
  path text,
  query text,
  status integer,
  ok boolean NOT NULL DEFAULT true,
  duration_ms integer,
  ip text,
  user_agent text,
  detail jsonb
);
CREATE INDEX IF NOT EXISTS canopy_activity_log_at_idx ON canopy_activity_log (at DESC);
CREATE INDEX IF NOT EXISTS canopy_activity_log_user_idx ON canopy_activity_log (lower(username), at DESC);

DO $$ BEGIN
  GRANT SELECT, INSERT ON canopy_activity_log TO flora_view;
  GRANT SELECT ON auth_audit TO flora_view;
EXCEPTION WHEN undefined_object THEN NULL; END $$;

COMMIT;
