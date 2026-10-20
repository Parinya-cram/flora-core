BEGIN;

-- One AI / LLM service shared by every Flora feature. Canopy owns it; Leafs receive a
-- copy with the directory sync. The key never leaves the API (not sent to browsers).
CREATE TABLE IF NOT EXISTS ai_service_config (
  id bigint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  api_format text NOT NULL DEFAULT 'anthropic' CHECK (api_format IN ('anthropic', 'openai')),
  host text NOT NULL DEFAULT '',
  api_key text NOT NULL DEFAULT '',
  model text NOT NULL DEFAULT '',
  version bigint NOT NULL DEFAULT 0,
  updated_at bigint NOT NULL DEFAULT 0,
  updated_by text
);

GRANT SELECT, INSERT, UPDATE ON ai_service_config TO flora_view;
GRANT SELECT ON ai_service_config TO flora_sync;
GRANT SELECT, INSERT, UPDATE, DELETE ON ai_service_config TO flora_app;

COMMIT;
