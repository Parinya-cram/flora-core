-- AI Studio: chat with the shared AI service (ai_service_config) about Canopy data.
-- Assistant replies may carry visuals: sandboxed HTML plus named data queries in the
-- Report Studio spec format. Visuals store the queries, never the data, so a kept
-- visual re-runs on current data.

CREATE TABLE IF NOT EXISTS ai_studio_session (
  id uuid PRIMARY KEY,
  owner_user_id bigint NOT NULL REFERENCES auth_user(id) ON DELETE CASCADE,
  title text NOT NULL DEFAULT 'New chat',
  created_at bigint NOT NULL,
  updated_at bigint NOT NULL
);
CREATE INDEX IF NOT EXISTS ai_studio_session_owner_idx ON ai_studio_session (owner_user_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS ai_studio_message (
  id uuid PRIMARY KEY,
  session_id uuid NOT NULL REFERENCES ai_studio_session(id) ON DELETE CASCADE,
  seq integer NOT NULL,
  role text NOT NULL CHECK (role IN ('user', 'assistant')),
  content text NOT NULL,             -- shown text; visuals appear as [[artifact:N]] markers
  raw text NOT NULL DEFAULT '',      -- model output as received (conversation history)
  artifacts jsonb NOT NULL DEFAULT '[]'::jsonb,
  queries jsonb NOT NULL DEFAULT '[]'::jsonb,   -- aggregate queries the model ran for this reply
  error text,
  created_at bigint NOT NULL,
  UNIQUE (session_id, seq)
);

CREATE TABLE IF NOT EXISTS ai_studio_artifact (
  id uuid PRIMARY KEY,
  owner_user_id bigint NOT NULL REFERENCES auth_user(id) ON DELETE CASCADE,
  session_id uuid REFERENCES ai_studio_session(id) ON DELETE SET NULL,
  title text NOT NULL,
  html text NOT NULL,
  data jsonb NOT NULL DEFAULT '{}'::jsonb,       -- {name: StudioSpec}
  created_at bigint NOT NULL,
  updated_at bigint NOT NULL,
  last_run_at bigint
);
CREATE INDEX IF NOT EXISTS ai_studio_artifact_owner_idx ON ai_studio_artifact (owner_user_id, updated_at DESC);

-- Chat sessions are private to their owner. A kept visual (snippet) can be shared with every
-- AI Studio user; it always runs with the viewer's own ward scope. Only the owner changes it.
ALTER TABLE ai_studio_artifact ADD COLUMN IF NOT EXISTS shared boolean NOT NULL DEFAULT false;
CREATE INDEX IF NOT EXISTS ai_studio_artifact_shared_idx ON ai_studio_artifact (shared, updated_at DESC) WHERE shared;

GRANT SELECT, INSERT, UPDATE, DELETE ON ai_studio_session, ai_studio_message, ai_studio_artifact TO flora_view;
