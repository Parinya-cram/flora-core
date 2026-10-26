-- AI Studio dashboard kiosk links: a permanent, revocable link that shows one dashboard on a wall
-- display without signing in. The URL carries fkd_<prefix>_<secret>; only the secret's SHA-256 is
-- kept. The board runs with its owner's access (and the ward chosen when the link was made), and
-- stops working when revoked, when the dashboard is deleted or when the owner is deactivated.
BEGIN;

CREATE TABLE IF NOT EXISTS ai_studio_dashboard_link (
  id uuid PRIMARY KEY,
  dashboard_id uuid NOT NULL REFERENCES ai_studio_dashboard(id) ON DELETE CASCADE,
  label text NOT NULL,
  prefix text NOT NULL UNIQUE,
  secret_hash text NOT NULL,
  ward_key text,
  created_by bigint REFERENCES auth_user(id) ON DELETE SET NULL,
  created_at bigint NOT NULL,
  revoked_at bigint,
  revoked_by bigint REFERENCES auth_user(id) ON DELETE SET NULL,
  last_used_at bigint,
  last_ip text
);
CREATE INDEX IF NOT EXISTS ai_studio_dashboard_link_dashboard_idx ON ai_studio_dashboard_link (dashboard_id, created_at DESC);

DO $$ BEGIN
  GRANT SELECT, INSERT, UPDATE ON ai_studio_dashboard_link TO flora_view;
EXCEPTION WHEN undefined_object THEN NULL; END $$;

COMMIT;
