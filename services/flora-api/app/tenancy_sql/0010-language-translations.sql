CREATE TABLE IF NOT EXISTS language_translation (
  language_code text NOT NULL REFERENCES language_master(code) ON DELETE CASCADE,
  translation_key text NOT NULL,
  translation_value text NOT NULL,
  updated_at bigint NOT NULL,
  PRIMARY KEY (language_code, translation_key)
);

GRANT SELECT, INSERT, UPDATE, DELETE ON language_translation TO flora_app;
