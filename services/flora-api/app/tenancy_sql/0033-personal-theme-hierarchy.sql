BEGIN;

CREATE TABLE IF NOT EXISTS user_theme_scheme (
  owner_user_id bigint NOT NULL REFERENCES auth_user(id) ON DELETE CASCADE,
  code text NOT NULL,
  display_name text NOT NULL,
  color_1_canvas text NOT NULL,
  color_2_surface text NOT NULL,
  color_3_border text NOT NULL,
  color_4_text text NOT NULL,
  color_5_muted text NOT NULL,
  color_6_accent text NOT NULL,
  is_active bigint NOT NULL DEFAULT 1 CHECK (is_active IN (0,1)),
  sync_state text NOT NULL DEFAULT 'local' CHECK (sync_state IN ('local','central')),
  created_at bigint NOT NULL,
  updated_at bigint NOT NULL,
  PRIMARY KEY (owner_user_id, code),
  CHECK (code ~ '^[a-z0-9][a-z0-9-]{1,47}$')
);

CREATE INDEX IF NOT EXISTS user_theme_scheme_owner_active_idx
  ON user_theme_scheme(owner_user_id,is_active,updated_at DESC);

GRANT SELECT,INSERT,UPDATE,DELETE ON user_theme_scheme TO flora_app,flora_view,flora_sync;

COMMIT;
