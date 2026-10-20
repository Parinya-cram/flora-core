BEGIN;

-- The central sync API exposes only presentation preferences and their referenced
-- master records to authenticated Leaf nodes. Passwords and role assignments are
-- never returned by the endpoint.
GRANT SELECT ON auth_user, language_master, language_translation, theme_scheme_master TO flora_sync;

COMMIT;
