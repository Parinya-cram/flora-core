BEGIN;

-- Canopy centrally manages the shared interface language and color-scheme masters.
-- Keep the viewer role read-only everywhere else; only these configuration tables,
-- the current user's preferences, and the authentication audit trail are writable.
GRANT SELECT, INSERT, UPDATE, DELETE
  ON language_master, language_translation, theme_scheme_master
  TO flora_view;

GRANT UPDATE (name, password_salt, password_hash, must_change_password,
              theme_mode, theme_color, language_code,
              parameter_preferences, report_preferences, updated_at)
  ON auth_user TO flora_view;

GRANT INSERT ON auth_audit TO flora_view;
GRANT USAGE, SELECT ON SEQUENCE auth_audit_id_seq TO flora_view;

COMMIT;
