BEGIN;

CREATE TABLE IF NOT EXISTS terminology_release (
  id bigserial PRIMARY KEY,
  system_key text NOT NULL,
  system_uri text NOT NULL,
  edition text NOT NULL,
  version text NOT NULL,
  release_date date,
  source_uri text,
  license_name text,
  license_uri text,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('staged','active','superseded')),
  imported_at bigint NOT NULL,
  entry_count bigint NOT NULL DEFAULT 0,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  UNIQUE(system_key,edition,version)
);

CREATE TABLE IF NOT EXISTS terminology_entry (
  id bigserial PRIMARY KEY,
  release_id bigint NOT NULL REFERENCES terminology_release(id) ON DELETE CASCADE,
  domain text NOT NULL CHECK (domain IN ('diagnosis','procedure','observation','medication','unit')),
  code text NOT NULL,
  display text NOT NULL,
  display_th text,
  definition text,
  parent_code text,
  is_billable bigint NOT NULL DEFAULT 1 CHECK (is_billable IN (0,1)),
  is_active bigint NOT NULL DEFAULT 1 CHECK (is_active IN (0,1)),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  UNIQUE(release_id,domain,code)
);

CREATE TABLE IF NOT EXISTS terminology_synonym (
  id bigserial PRIMARY KEY,
  entry_id bigint NOT NULL REFERENCES terminology_entry(id) ON DELETE CASCADE,
  language_code text NOT NULL DEFAULT 'en',
  term text NOT NULL,
  term_type text NOT NULL DEFAULT 'synonym',
  UNIQUE(entry_id,language_code,term)
);

ALTER TABLE clinical_concept_coding
  ADD COLUMN IF NOT EXISTS terminology_entry_id bigint REFERENCES terminology_entry(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS terminology_release_active ON terminology_release(system_key,status,release_date DESC);
CREATE INDEX IF NOT EXISTS terminology_entry_code ON terminology_entry(code);
CREATE INDEX IF NOT EXISTS terminology_entry_domain_display ON terminology_entry(domain,display);
CREATE INDEX IF NOT EXISTS terminology_entry_search ON terminology_entry USING gin
  (to_tsvector('simple',coalesce(code,'')||' '||coalesce(display,'')||' '||coalesce(display_th,'')));
CREATE INDEX IF NOT EXISTS terminology_synonym_search ON terminology_synonym USING gin
  (to_tsvector('simple',coalesce(term,'')));
CREATE INDEX IF NOT EXISTS clinical_concept_coding_entry ON clinical_concept_coding(terminology_entry_id);

GRANT SELECT,INSERT,UPDATE,DELETE ON terminology_release,terminology_entry,terminology_synonym TO flora_app;
GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA public TO flora_app;

COMMIT;
