-- FormDev: every PostgreSQL migration (0060-0065, 0083) in order, for databases created before FormDev.
-- Paste into psql (or psql -f). Safe to run again. Generated from infrastructure/postgres/006*.sql and 0083-formdev-template.sql.

-- ===== 0060-formdev.sql =====
-- FormDev data engine (Phase 3): form definitions, versioned schemas, hybrid records,
-- record index, sync receipts, conflicts, assets and the style/font registry.
-- Mirrors services/flora-api/app/formdev/adapters/sqlite_schema.sql.
-- Registry seed rows are generated from formdev/registry/*.json (scripts/sync_registry_seed.py).
BEGIN;

CREATE TABLE IF NOT EXISTS formdev_form (
  form_id text PRIMARY KEY CHECK (form_id ~ '^[a-z][a-z0-9_]{1,63}$'),
  title text NOT NULL,
  latest_version integer NOT NULL DEFAULT 0,
  published_version integer,
  created_at bigint NOT NULL,
  created_by text NOT NULL,
  updated_at bigint NOT NULL,
  updated_by text NOT NULL
);

CREATE TABLE IF NOT EXISTS formdev_schema_version (
  form_id text NOT NULL REFERENCES formdev_form(form_id),
  schema_version integer NOT NULL CHECK (schema_version > 0),
  status text NOT NULL CHECK (status IN ('draft','published','archived')),
  definition jsonb NOT NULL,
  checksum text NOT NULL,
  created_at bigint NOT NULL,
  created_by text NOT NULL,
  published_at bigint,
  published_by text,
  PRIMARY KEY (form_id, schema_version)
);

CREATE OR REPLACE FUNCTION formdev_guard_published_version() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status IN ('published','archived') THEN
    IF TG_OP = 'DELETE' OR NEW.definition IS DISTINCT FROM OLD.definition
       OR NEW.checksum IS DISTINCT FROM OLD.checksum OR NEW.status = 'draft' THEN
      RAISE EXCEPTION 'published form versions are immutable' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END $$;

DROP TRIGGER IF EXISTS formdev_schema_version_immutable ON formdev_schema_version;
CREATE TRIGGER formdev_schema_version_immutable
BEFORE UPDATE OR DELETE ON formdev_schema_version
FOR EACH ROW EXECUTE FUNCTION formdev_guard_published_version();

CREATE TABLE IF NOT EXISTS formdev_record (
  record_id text PRIMARY KEY CHECK (length(record_id) BETWEEN 8 AND 64),
  form_id text NOT NULL,
  schema_version integer NOT NULL,
  status text NOT NULL CHECK (status IN ('draft','submitted','deleted')),
  data jsonb NOT NULL,
  created_at bigint NOT NULL,
  created_by text NOT NULL,
  updated_at bigint NOT NULL,
  updated_by text NOT NULL,
  sync_id text,
  version integer NOT NULL CHECK (version > 0),
  FOREIGN KEY (form_id, schema_version) REFERENCES formdev_schema_version(form_id, schema_version)
);
CREATE INDEX IF NOT EXISTS formdev_record_recent ON formdev_record(form_id, updated_at DESC, record_id DESC);
CREATE INDEX IF NOT EXISTS formdev_record_status_recent ON formdev_record(form_id, status, updated_at DESC, record_id DESC);

CREATE TABLE IF NOT EXISTS formdev_record_revision (
  record_id text NOT NULL REFERENCES formdev_record(record_id) ON DELETE CASCADE,
  version integer NOT NULL,
  schema_version integer NOT NULL,
  status text NOT NULL,
  data jsonb NOT NULL,
  updated_at bigint NOT NULL,
  updated_by text NOT NULL,
  sync_id text,
  PRIMARY KEY (record_id, version)
);

CREATE TABLE IF NOT EXISTS formdev_record_index (
  record_id text NOT NULL REFERENCES formdev_record(record_id) ON DELETE CASCADE,
  form_id text NOT NULL,
  field_id text NOT NULL,
  value_text text COLLATE "C",
  value_num double precision,
  PRIMARY KEY (record_id, field_id)
);
-- C collation: byte order keeps ISO dates sortable and lets one B-tree serve =, ranges and LIKE prefix.
CREATE INDEX IF NOT EXISTS formdev_record_index_text ON formdev_record_index(form_id, field_id, value_text);
CREATE INDEX IF NOT EXISTS formdev_record_index_num ON formdev_record_index(form_id, field_id, value_num);

CREATE TABLE IF NOT EXISTS formdev_sync_receipt (
  op_id text PRIMARY KEY,
  record_id text NOT NULL,
  result jsonb NOT NULL,
  processed_at bigint NOT NULL
);

CREATE TABLE IF NOT EXISTS formdev_conflict (
  conflict_id text PRIMARY KEY,
  seq bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
  record_id text NOT NULL,
  op_id text NOT NULL,
  strategy text NOT NULL,
  resolution text NOT NULL CHECK (resolution IN ('local_wins','remote_wins')),
  base_version integer NOT NULL,
  server_version integer NOT NULL,
  local_data jsonb,
  server_data jsonb,
  created_at bigint NOT NULL
);
CREATE INDEX IF NOT EXISTS formdev_conflict_record ON formdev_conflict(record_id, created_at);

CREATE TABLE IF NOT EXISTS formdev_asset (
  form_id text NOT NULL REFERENCES formdev_form(form_id),
  path text NOT NULL,
  media_type text NOT NULL,
  sha256 text NOT NULL,
  size integer NOT NULL,
  content_b64 text NOT NULL,
  created_at bigint NOT NULL,
  PRIMARY KEY (form_id, path)
);

CREATE TABLE IF NOT EXISTS formdev_style (
  style_id text PRIMARY KEY,
  version integer NOT NULL,
  definition jsonb NOT NULL,
  updated_at bigint NOT NULL
);

CREATE TABLE IF NOT EXISTS formdev_font (
  font_id text PRIMARY KEY,
  metadata jsonb NOT NULL,
  updated_at bigint NOT NULL
);

-- BEGIN registry seed (generated by formdev/scripts/sync_registry_seed.py)
INSERT INTO formdev_font (font_id, metadata, updated_at) VALUES
  ('noto-sans-thai', '{"family":"Noto Sans Thai Variable","display_name":"Noto Sans Thai","category":"ui","official":false,"scripts":["thai","latin"],"weights":[100,900],"styles":["normal"],"license":"OFL-1.1","license_verified":true,"assets":[{"kind":"bundled","package":"@fontsource-variable/noto-sans-thai","installed":true}],"fallback":["Noto Sans Thai Variable","Noto Sans Thai","Tahoma","sans-serif"]}'::jsonb, 0),
  ('inter', '{"family":"Inter Variable","display_name":"Inter","category":"ui","official":false,"scripts":["latin"],"weights":[100,900],"styles":["normal"],"license":"OFL-1.1","license_verified":true,"assets":[{"kind":"bundled","package":"@fontsource-variable/inter","installed":true}],"fallback":["Inter Variable","Inter","system-ui","sans-serif"]}'::jsonb, 0),
  ('th-sarabun-new', '{"family":"TH Sarabun New","display_name":"TH Sarabun New","category":"official-th","official":true,"scripts":["thai","latin"],"weights":[400,700],"styles":["normal","italic"],"license":"Thai National Fonts released by SIPA/DIP for free use. FormDev ships no font files; verify the licence text distributed with the font before bundling it.","license_verified":false,"note":"TH Sarabun New (2011 update of TH SarabunPSK) is the font named for Thai government documents; it is the +1 beside the 13 national fonts.","assets":[{"kind":"system","family":"TH Sarabun New","note":"Use the copy installed on the workstation (no file is shipped)"},{"kind":"web_alternative","family":"Sarabun","package":"@fontsource/sarabun","license":"OFL-1.1","installed":false,"note":"Open-licence redesign of the same typeface; not installed (no packages are downloaded)"}],"fallback":["TH Sarabun New","Sarabun","Noto Sans Thai Variable","Noto Sans Thai","Tahoma","sans-serif"]}'::jsonb, 0),
  ('th-sarabun-psk', '{"family":"TH SarabunPSK","display_name":"TH SarabunPSK","category":"official-th","official":true,"scripts":["thai","latin"],"weights":[400,700],"styles":["normal","italic"],"license":"Thai National Fonts released by SIPA/DIP for free use. FormDev ships no font files; verify the licence text distributed with the font before bundling it.","license_verified":false,"assets":[{"kind":"system","family":"TH SarabunPSK","note":"Use the copy installed on the workstation (no file is shipped)"},{"kind":"web_alternative","family":"Sarabun","package":"@fontsource/sarabun","license":"OFL-1.1","installed":false,"note":"Open-licence redesign of the same typeface; not installed (no packages are downloaded)"}],"fallback":["TH SarabunPSK","Sarabun","Noto Sans Thai Variable","Noto Sans Thai","Tahoma","sans-serif"]}'::jsonb, 0),
  ('th-chakra-petch', '{"family":"TH Chakra Petch","display_name":"TH Chakra Petch","category":"official-th","official":true,"scripts":["thai","latin"],"weights":[400,700],"styles":["normal","italic"],"license":"Thai National Fonts released by SIPA/DIP for free use. FormDev ships no font files; verify the licence text distributed with the font before bundling it.","license_verified":false,"assets":[{"kind":"system","family":"TH Chakra Petch","note":"Use the copy installed on the workstation (no file is shipped)"},{"kind":"web_alternative","family":"Chakra Petch","package":"@fontsource/chakra-petch","license":"OFL-1.1","installed":false,"note":"Open-licence redesign of the same typeface; not installed (no packages are downloaded)"}],"fallback":["TH Chakra Petch","Chakra Petch","Noto Sans Thai Variable","Noto Sans Thai","Tahoma","sans-serif"]}'::jsonb, 0),
  ('th-baijam', '{"family":"TH Baijam","display_name":"TH Baijam","category":"official-th","official":true,"scripts":["thai","latin"],"weights":[400,700],"styles":["normal","italic"],"license":"Thai National Fonts released by SIPA/DIP for free use. FormDev ships no font files; verify the licence text distributed with the font before bundling it.","license_verified":false,"assets":[{"kind":"system","family":"TH Baijam","note":"Use the copy installed on the workstation (no file is shipped)"},{"kind":"web_alternative","family":"Bai Jamjuree","package":"@fontsource/bai-jamjuree","license":"OFL-1.1","installed":false,"note":"Open-licence redesign of the same typeface; not installed (no packages are downloaded)"}],"fallback":["TH Baijam","Bai Jamjuree","Noto Sans Thai Variable","Noto Sans Thai","Tahoma","sans-serif"]}'::jsonb, 0),
  ('th-charm-of-au', '{"family":"TH Charm of AU","display_name":"TH Charm of AU","category":"official-th","official":true,"scripts":["thai","latin"],"weights":[400,700],"styles":["normal","italic"],"license":"Thai National Fonts released by SIPA/DIP for free use. FormDev ships no font files; verify the licence text distributed with the font before bundling it.","license_verified":false,"assets":[{"kind":"system","family":"TH Charm of AU","note":"Use the copy installed on the workstation (no file is shipped)"},{"kind":"web_alternative","family":"Charm","package":"@fontsource/charm","license":"OFL-1.1","installed":false,"note":"Open-licence redesign of the same typeface; not installed (no packages are downloaded)"}],"fallback":["TH Charm of AU","Charm","Noto Sans Thai Variable","Noto Sans Thai","Tahoma","sans-serif"]}'::jsonb, 0),
  ('th-charmonman', '{"family":"TH Charmonman","display_name":"TH Charmonman","category":"official-th","official":true,"scripts":["thai","latin"],"weights":[400,700],"styles":["normal","italic"],"license":"Thai National Fonts released by SIPA/DIP for free use. FormDev ships no font files; verify the licence text distributed with the font before bundling it.","license_verified":false,"assets":[{"kind":"system","family":"TH Charmonman","note":"Use the copy installed on the workstation (no file is shipped)"},{"kind":"web_alternative","family":"Charmonman","package":"@fontsource/charmonman","license":"OFL-1.1","installed":false,"note":"Open-licence redesign of the same typeface; not installed (no packages are downloaded)"}],"fallback":["TH Charmonman","Charmonman","Noto Sans Thai Variable","Noto Sans Thai","Tahoma","sans-serif"]}'::jsonb, 0),
  ('th-fah-kwang', '{"family":"TH Fah kwang","display_name":"TH Fah kwang","category":"official-th","official":true,"scripts":["thai","latin"],"weights":[400,700],"styles":["normal","italic"],"license":"Thai National Fonts released by SIPA/DIP for free use. FormDev ships no font files; verify the licence text distributed with the font before bundling it.","license_verified":false,"assets":[{"kind":"system","family":"TH Fah kwang","note":"Use the copy installed on the workstation (no file is shipped)"},{"kind":"web_alternative","family":"Fahkwang","package":"@fontsource/fahkwang","license":"OFL-1.1","installed":false,"note":"Open-licence redesign of the same typeface; not installed (no packages are downloaded)"}],"fallback":["TH Fah kwang","Fahkwang","Noto Sans Thai Variable","Noto Sans Thai","Tahoma","sans-serif"]}'::jsonb, 0),
  ('th-k2d-july8', '{"family":"TH K2D July8","display_name":"TH K2D July8","category":"official-th","official":true,"scripts":["thai","latin"],"weights":[400,700],"styles":["normal","italic"],"license":"Thai National Fonts released by SIPA/DIP for free use. FormDev ships no font files; verify the licence text distributed with the font before bundling it.","license_verified":false,"assets":[{"kind":"system","family":"TH K2D July8","note":"Use the copy installed on the workstation (no file is shipped)"},{"kind":"web_alternative","family":"K2D","package":"@fontsource/k2d","license":"OFL-1.1","installed":false,"note":"Open-licence redesign of the same typeface; not installed (no packages are downloaded)"}],"fallback":["TH K2D July8","K2D","Noto Sans Thai Variable","Noto Sans Thai","Tahoma","sans-serif"]}'::jsonb, 0),
  ('th-kodchasal', '{"family":"TH Kodchasal","display_name":"TH Kodchasal","category":"official-th","official":true,"scripts":["thai","latin"],"weights":[400,700],"styles":["normal","italic"],"license":"Thai National Fonts released by SIPA/DIP for free use. FormDev ships no font files; verify the licence text distributed with the font before bundling it.","license_verified":false,"assets":[{"kind":"system","family":"TH Kodchasal","note":"Use the copy installed on the workstation (no file is shipped)"},{"kind":"web_alternative","family":"Kodchasan","package":"@fontsource/kodchasan","license":"OFL-1.1","installed":false,"note":"Open-licence redesign of the same typeface; not installed (no packages are downloaded)"}],"fallback":["TH Kodchasal","Kodchasan","Noto Sans Thai Variable","Noto Sans Thai","Tahoma","sans-serif"]}'::jsonb, 0),
  ('th-koho', '{"family":"TH KoHo","display_name":"TH KoHo","category":"official-th","official":true,"scripts":["thai","latin"],"weights":[400,700],"styles":["normal","italic"],"license":"Thai National Fonts released by SIPA/DIP for free use. FormDev ships no font files; verify the licence text distributed with the font before bundling it.","license_verified":false,"assets":[{"kind":"system","family":"TH KoHo","note":"Use the copy installed on the workstation (no file is shipped)"},{"kind":"web_alternative","family":"KoHo","package":"@fontsource/koho","license":"OFL-1.1","installed":false,"note":"Open-licence redesign of the same typeface; not installed (no packages are downloaded)"}],"fallback":["TH KoHo","KoHo","Noto Sans Thai Variable","Noto Sans Thai","Tahoma","sans-serif"]}'::jsonb, 0),
  ('th-krub', '{"family":"TH Krub","display_name":"TH Krub","category":"official-th","official":true,"scripts":["thai","latin"],"weights":[400,700],"styles":["normal","italic"],"license":"Thai National Fonts released by SIPA/DIP for free use. FormDev ships no font files; verify the licence text distributed with the font before bundling it.","license_verified":false,"assets":[{"kind":"system","family":"TH Krub","note":"Use the copy installed on the workstation (no file is shipped)"},{"kind":"web_alternative","family":"Krub","package":"@fontsource/krub","license":"OFL-1.1","installed":false,"note":"Open-licence redesign of the same typeface; not installed (no packages are downloaded)"}],"fallback":["TH Krub","Krub","Noto Sans Thai Variable","Noto Sans Thai","Tahoma","sans-serif"]}'::jsonb, 0),
  ('th-mali-grade6', '{"family":"TH Mali Grade6","display_name":"TH Mali Grade6","category":"official-th","official":true,"scripts":["thai","latin"],"weights":[400,700],"styles":["normal","italic"],"license":"Thai National Fonts released by SIPA/DIP for free use. FormDev ships no font files; verify the licence text distributed with the font before bundling it.","license_verified":false,"assets":[{"kind":"system","family":"TH Mali Grade6","note":"Use the copy installed on the workstation (no file is shipped)"},{"kind":"web_alternative","family":"Mali","package":"@fontsource/mali","license":"OFL-1.1","installed":false,"note":"Open-licence redesign of the same typeface; not installed (no packages are downloaded)"}],"fallback":["TH Mali Grade6","Mali","Noto Sans Thai Variable","Noto Sans Thai","Tahoma","sans-serif"]}'::jsonb, 0),
  ('th-niramit-as', '{"family":"TH Niramit AS","display_name":"TH Niramit AS","category":"official-th","official":true,"scripts":["thai","latin"],"weights":[400,700],"styles":["normal","italic"],"license":"Thai National Fonts released by SIPA/DIP for free use. FormDev ships no font files; verify the licence text distributed with the font before bundling it.","license_verified":false,"assets":[{"kind":"system","family":"TH Niramit AS","note":"Use the copy installed on the workstation (no file is shipped)"},{"kind":"web_alternative","family":"Niramit","package":"@fontsource/niramit","license":"OFL-1.1","installed":false,"note":"Open-licence redesign of the same typeface; not installed (no packages are downloaded)"}],"fallback":["TH Niramit AS","Niramit","Noto Sans Thai Variable","Noto Sans Thai","Tahoma","sans-serif"]}'::jsonb, 0),
  ('th-srisakdi', '{"family":"TH Srisakdi","display_name":"TH Srisakdi","category":"official-th","official":true,"scripts":["thai","latin"],"weights":[400,700],"styles":["normal","italic"],"license":"Thai National Fonts released by SIPA/DIP for free use. FormDev ships no font files; verify the licence text distributed with the font before bundling it.","license_verified":false,"assets":[{"kind":"system","family":"TH Srisakdi","note":"Use the copy installed on the workstation (no file is shipped)"},{"kind":"web_alternative","family":"Srisakdi","package":"@fontsource/srisakdi","license":"OFL-1.1","installed":false,"note":"Open-licence redesign of the same typeface; not installed (no packages are downloaded)"}],"fallback":["TH Srisakdi","Srisakdi","Noto Sans Thai Variable","Noto Sans Thai","Tahoma","sans-serif"]}'::jsonb, 0)
ON CONFLICT (font_id) DO NOTHING;

INSERT INTO formdev_style (style_id, version, definition, updated_at) VALUES
  ('style.base', 1, '{"name":"Base","category":"base","tokens":{"fontId":"noto-sans-thai","fontSize":11,"fontWeight":400,"lineHeight":1.4,"color":"#1f2937","background":"transparent","align":"left","labelPosition":"top","border":"solid","borderColor":"#cbd5e1","radius":1.5,"padding":1.5,"gap":3,"columns":2,"inputHeight":8,"rule":"solid","uppercase":false,"pageMarginTop":15,"pageMarginRight":15,"pageMarginBottom":15,"pageMarginLeft":15},"components":{"label":{"fontSize":10,"fontWeight":600,"color":"#475569"},"section":{"fontSize":12,"fontWeight":700,"color":"#0f172a"},"header":{"fontSize":9,"color":"#64748b"},"footer":{"fontSize":9,"color":"#64748b"}}}'::jsonb, 0),
  ('style.a4.default', 1, '{"name":"A4 default","category":"form","inherit":"style.base","paper":"A4","tokens":{"fontSize":11}}'::jsonb, 0),
  ('style.a4.medical', 1, '{"name":"A4 medical record","category":"form","inherit":"style.a4.default","paper":"A4","tokens":{"fontSize":10,"pageMarginTop":12,"pageMarginRight":12,"pageMarginBottom":14,"pageMarginLeft":12,"rule":"solid"},"components":{"label":{"fontSize":9},"section":{"fontSize":11}}}'::jsonb, 0),
  ('style.a4.official', 1, '{"name":"A4 official document","category":"form","inherit":"style.a4.default","paper":"A4","tokens":{"fontId":"th-sarabun-new","fontSize":16,"columns":1,"rule":"none","border":"underline","pageMarginTop":25,"pageMarginRight":20,"pageMarginBottom":20,"pageMarginLeft":30},"components":{"label":{"fontSize":16,"fontWeight":400,"color":"#000000"},"section":{"fontSize":16,"fontWeight":700,"color":"#000000"}}}'::jsonb, 0),
  ('style.a4.compact', 1, '{"name":"A4 compact","category":"form","inherit":"style.a4.default","paper":"A4","tokens":{"fontSize":9,"gap":1.5,"padding":1,"inputHeight":6,"columns":3,"pageMarginTop":10,"pageMarginRight":10,"pageMarginBottom":10,"pageMarginLeft":10},"components":{"label":{"fontSize":8},"section":{"fontSize":10}}}'::jsonb, 0),
  ('field.text.default', 1, '{"name":"Text field","category":"field","tokens":{"border":"solid","inputHeight":8}}'::jsonb, 0),
  ('field.number.large', 1, '{"name":"Large number","category":"field","inherit":"field.text.default","tokens":{"fontSize":16,"fontWeight":700,"align":"right"}}'::jsonb, 0),
  ('section.header', 1, '{"name":"Header section","category":"section","tokens":{"rule":"card","background":"#f1f5f9","padding":3},"components":{"section":{"fontSize":13,"uppercase":true}}}'::jsonb, 0),
  ('form.a4.medical', 2, '{"name":"A4 medical record (alias of style.a4.medical)","category":"form","inherit":"style.a4.medical","paper":"A4","tokens":{}}'::jsonb, 0),
  ('form.a4.official', 2, '{"name":"A4 official document (alias of style.a4.official)","category":"form","inherit":"style.a4.official","paper":"A4","tokens":{}}'::jsonb, 0),
  ('form.screen.default', 2, '{"name":"Screen default","category":"form","inherit":"style.base","paper":"screen","tokens":{"fontId":"inter","rule":"card"}}'::jsonb, 0)
ON CONFLICT (style_id) DO NOTHING;
-- END registry seed

-- Canopy (flora_view) designs forms and receives synced records; Leaf (flora_app) may host them.
GRANT SELECT, INSERT, UPDATE ON formdev_form, formdev_schema_version, formdev_record,
  formdev_record_revision, formdev_sync_receipt, formdev_conflict, formdev_asset,
  formdev_style, formdev_font TO flora_view, flora_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON formdev_record_index TO flora_view, flora_app;

COMMIT;

-- ===== 0061-formdev-query.sql =====
-- FormDev Phase 4: query engine storage (transactional part).
-- Large-table indexes are created CONCURRENTLY in 0061b-formdev-query-indexes.sql.
-- Idempotent: safe to apply to databases that already ran it.
BEGIN;

-- Records: patient/subject key (definition extensions["flora.subject_field"]) and server-side
-- ingest order. created_at/updated_at are client edit times; ingest_seq (per-form, assigned at
-- insert from formdev_data_version, commit-ordered) and ingested_at (server clock) are not.
ALTER TABLE formdev_record ADD COLUMN IF NOT EXISTS subject_id text;
ALTER TABLE formdev_record ADD COLUMN IF NOT EXISTS ingest_seq bigint;
ALTER TABLE formdev_record ADD COLUMN IF NOT EXISTS ingested_at bigint;
UPDATE formdev_record r SET ingest_seq = ordered.seq, ingested_at = r.created_at
FROM (SELECT record_id, row_number() OVER (PARTITION BY form_id ORDER BY created_at, record_id) AS seq FROM formdev_record) ordered
WHERE ordered.record_id = r.record_id AND r.ingest_seq IS NULL;
ALTER TABLE formdev_record ALTER COLUMN ingest_seq SET NOT NULL;
ALTER TABLE formdev_record ALTER COLUMN ingested_at SET NOT NULL;

-- Index rows carry the record's status and updated_at so filtered keyset pages (default sort)
-- and single-field aggregates are served from the index table alone (partial "live" indexes).
ALTER TABLE formdev_record_index ADD COLUMN IF NOT EXISTS status text;
ALTER TABLE formdev_record_index ADD COLUMN IF NOT EXISTS updated_at bigint;
UPDATE formdev_record_index i SET status = r.status, updated_at = r.updated_at
FROM formdev_record r
WHERE r.record_id = i.record_id AND (i.status IS NULL OR i.updated_at IS NULL);
ALTER TABLE formdev_record_index ALTER COLUMN status SET NOT NULL;
ALTER TABLE formdev_record_index ALTER COLUMN updated_at SET NOT NULL;

-- Planner statistics for the EAV index table: field_id and the value domain are correlated.
ALTER TABLE formdev_record_index ALTER COLUMN field_id SET STATISTICS 1000;
ALTER TABLE formdev_record_index ALTER COLUMN value_text SET STATISTICS 1000;
ALTER TABLE formdev_record_index ALTER COLUMN value_num SET STATISTICS 1000;
CREATE STATISTICS IF NOT EXISTS formdev_ri_text_st (mcv, dependencies, ndistinct) ON form_id, field_id, value_text FROM formdev_record_index;
CREATE STATISTICS IF NOT EXISTS formdev_ri_num_st (mcv, dependencies, ndistinct) ON form_id, field_id, value_num FROM formdev_record_index;
-- Every record write rewrites its index rows; vacuum often so index-only scans stay index-only.
ALTER TABLE formdev_record_index SET (autovacuum_vacuum_scale_factor = 0.01, autovacuum_vacuum_insert_scale_factor = 0.01, autovacuum_analyze_scale_factor = 0.02);

-- Per-form change counter: bumped (upsert) by every record write and catalog change. It
-- invalidates query caches and hands out ingest_seq values to new records.
CREATE TABLE IF NOT EXISTS formdev_data_version (
  form_id text PRIMARY KEY,
  version bigint NOT NULL DEFAULT 0,
  updated_at bigint NOT NULL
) WITH (fillfactor = 50);
INSERT INTO formdev_data_version (form_id, version, updated_at)
SELECT f.form_id, COALESCE((SELECT max(r.ingest_seq) FROM formdev_record r WHERE r.form_id = f.form_id), 0) + 1, 0
FROM formdev_form f ON CONFLICT (form_id) DO NOTHING;

-- Access policy per form: who may query/export, and per-field role/permission allow-lists.
CREATE TABLE IF NOT EXISTS formdev_form_policy (
  form_id text PRIMARY KEY REFERENCES formdev_form(form_id),
  policy jsonb NOT NULL,
  version integer NOT NULL CHECK (version > 0),
  updated_at bigint NOT NULL,
  updated_by text NOT NULL
);

-- Named query sources: relations (many-to-one lookups) and policy narrowing.
CREATE TABLE IF NOT EXISTS formdev_source (
  source_id text PRIMARY KEY CHECK (source_id ~ '^[a-z][a-z0-9_]{1,63}$'),
  form_id text NOT NULL REFERENCES formdev_form(form_id),
  config jsonb NOT NULL,
  version integer NOT NULL CHECK (version > 0),
  updated_at bigint NOT NULL,
  updated_by text NOT NULL
);

-- Extra indexed fields chosen by administrators (index advisor "apply"); no schema publish needed.
CREATE TABLE IF NOT EXISTS formdev_index_config (
  form_id text NOT NULL REFERENCES formdev_form(form_id),
  field_id text NOT NULL,
  created_at bigint NOT NULL,
  created_by text NOT NULL,
  PRIMARY KEY (form_id, field_id)
);

-- Per field: is the record index complete for it? Filters on 'building' fields are refused.
CREATE TABLE IF NOT EXISTS formdev_index_coverage (
  form_id text NOT NULL REFERENCES formdev_form(form_id),
  field_id text NOT NULL,
  origin text NOT NULL CHECK (origin IN ('definition', 'config')),
  state text NOT NULL CHECK (state IN ('ready', 'building')),
  schema_version integer NOT NULL,
  updated_at bigint NOT NULL,
  PRIMARY KEY (form_id, field_id)
);

-- Saved query definitions (flora.query/1), addressed by query_id.
CREATE TABLE IF NOT EXISTS formdev_query (
  query_id text PRIMARY KEY CHECK (query_id ~ '^[a-z][a-z0-9_]{1,63}$'),
  definition jsonb NOT NULL,
  owner_user_id bigint,
  owner text NOT NULL,
  created_at bigint NOT NULL,
  updated_at bigint NOT NULL
);

-- Query usage by shape (no values), flushed in batches; input for the index advisor.
CREATE TABLE IF NOT EXISTS formdev_query_stat (
  fingerprint text PRIMARY KEY,
  source_id text NOT NULL,
  shape jsonb NOT NULL,
  runs bigint NOT NULL DEFAULT 0,
  ok bigint NOT NULL DEFAULT 0,
  timeouts bigint NOT NULL DEFAULT 0,
  rejected bigint NOT NULL DEFAULT 0,
  total_ms bigint NOT NULL DEFAULT 0,
  max_ms bigint NOT NULL DEFAULT 0,
  rows_returned bigint NOT NULL DEFAULT 0,
  first_run_at bigint NOT NULL,
  last_run_at bigint NOT NULL
);

-- Background jobs (export, report, aggregate, large search, reindex) with fenced leases.
CREATE TABLE IF NOT EXISTS formdev_job (
  job_id text PRIMARY KEY,
  kind text NOT NULL CHECK (kind IN ('export', 'search', 'aggregate', 'report', 'reindex')),
  status text NOT NULL CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'cancelled', 'expired')),
  query jsonb,
  format text NOT NULL,
  owner_user_id bigint,
  owner text NOT NULL,
  rows_processed bigint NOT NULL DEFAULT 0,
  total_estimate bigint,
  checkpoint jsonb,
  result_bytes bigint NOT NULL DEFAULT 0,
  result_sha256 text,
  error jsonb,
  attempt integer NOT NULL DEFAULT 0,
  max_attempts integer NOT NULL DEFAULT 3,
  lease_owner text,
  lease_expires_at bigint,
  cancel_requested integer NOT NULL DEFAULT 0 CHECK (cancel_requested IN (0, 1)),
  created_at bigint NOT NULL,
  started_at bigint,
  heartbeat_at bigint,
  finished_at bigint,
  expires_at bigint
);
CREATE INDEX IF NOT EXISTS formdev_job_queue ON formdev_job (status, created_at);
CREATE INDEX IF NOT EXISTS formdev_job_owner ON formdev_job (owner_user_id, status, created_at DESC);

-- Audit of bulk access to patient data (job creation/download, sensitive-field queries, denials).
-- Never stores filter values.
CREATE TABLE IF NOT EXISTS formdev_query_audit (
  audit_id text PRIMARY KEY,
  at bigint NOT NULL,
  actor_user_id bigint,
  actor text NOT NULL,
  actor_roles jsonb NOT NULL,
  action text NOT NULL CHECK (action IN ('query', 'job_create', 'job_download', 'job_cancel', 'diagnostics', 'denied')),
  source_id text,
  fingerprint text,
  fields jsonb NOT NULL DEFAULT '[]'::jsonb,
  filter_fields jsonb NOT NULL DEFAULT '[]'::jsonb,
  row_count bigint,
  job_id text,
  result_sha256 text,
  client_ip text
);
CREATE INDEX IF NOT EXISTS formdev_query_audit_at ON formdev_query_audit (at DESC);

-- Permissions (only where the Flora RBAC tables exist).
DO $$
BEGIN
  IF to_regclass('public.auth_permission') IS NOT NULL THEN
    INSERT INTO auth_permission (code, display_name, category, risk_level, created_at, updated_at) VALUES
      ('formdev.query', 'Query form records', 'FormDev', 'sensitive', 0, 0),
      ('formdev.export', 'Export form records and run reports', 'FormDev', 'high', 0, 0),
      ('formdev.diagnostics', 'View query plans and diagnostics', 'FormDev', 'high', 0, 0),
      ('formdev.manage', 'Manage FormDev sources, policies and indexes', 'FormDev', 'high', 0, 0)
    ON CONFLICT (code) DO NOTHING;
    INSERT INTO auth_role_permission (role_code, permission_code, created_at)
    SELECT grant_row.role_code, grant_row.permission_code, 0
    FROM (VALUES
      ('system_admin', 'formdev.query'), ('system_admin', 'formdev.export'),
      ('system_admin', 'formdev.diagnostics'), ('system_admin', 'formdev.manage'),
      ('clinical_admin', 'formdev.query'), ('clinical_admin', 'formdev.export'), ('clinical_admin', 'formdev.manage'),
      ('clinician', 'formdev.query'),
      ('viewer', 'formdev.query')
    ) AS grant_row(role_code, permission_code)
    WHERE EXISTS (SELECT 1 FROM auth_role role WHERE role.code = grant_row.role_code)
    ON CONFLICT DO NOTHING;
  END IF;
END $$;

GRANT SELECT, INSERT, UPDATE, DELETE ON formdev_job, formdev_query_stat, formdev_query, formdev_source, formdev_index_config TO flora_view, flora_app;
GRANT SELECT, INSERT, UPDATE ON formdev_data_version, formdev_form_policy, formdev_index_coverage TO flora_view, flora_app;
GRANT SELECT, INSERT ON formdev_query_audit TO flora_view, flora_app;

COMMIT;

-- ===== 0061b-formdev-query-indexes.sql =====
-- FormDev Phase 4: query indexes. NOT wrapped in a transaction: CREATE/DROP INDEX
-- CONCURRENTLY keeps record writes (Leaf -> Canopy sync) running on large tables.
-- Idempotent. Run after 0061-formdev-query.sql.

-- Filtered keyset pages on updated_at (default sort) served by one index range scan (no sort, no record join).
-- status <> 'deleted' and IS NOT NULL make the indexes small; queries repeat those predicates literally.
CREATE INDEX CONCURRENTLY IF NOT EXISTS formdev_ri_text_live
  ON formdev_record_index (form_id, field_id, value_text, updated_at DESC, record_id DESC)
  WHERE value_text IS NOT NULL AND status <> 'deleted';
CREATE INDEX CONCURRENTLY IF NOT EXISTS formdev_ri_num_live
  ON formdev_record_index (form_id, field_id, value_num, updated_at DESC, record_id DESC)
  WHERE value_num IS NOT NULL AND status <> 'deleted';

-- Stable keysets: ingest order (jobs, $ingested_at lists), $created_at, and per-form subject lookups.
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS formdev_record_ingest
  ON formdev_record (form_id, ingest_seq);
CREATE INDEX CONCURRENTLY IF NOT EXISTS formdev_record_created
  ON formdev_record (form_id, created_at DESC, record_id DESC);
CREATE INDEX CONCURRENTLY IF NOT EXISTS formdev_record_subject
  ON formdev_record (form_id, subject_id, created_at DESC, record_id DESC)
  WHERE subject_id IS NOT NULL;

-- Superseded by the partial live indexes above (they indexed every NULL of the other column).
DROP INDEX CONCURRENTLY IF EXISTS formdev_record_index_text;
DROP INDEX CONCURRENTLY IF EXISTS formdev_record_index_num;

ANALYZE formdev_record;
ANALYZE formdev_record_index;

-- ===== 0062-formdev-registry.sql =====
-- FormDev Phase 1: style registry with inheritance and tokens, Thai official font metadata.
-- Generated by formdev/scripts/sync_registry_seed.py from formdev/registry/*.json; do not edit.
-- Idempotent: a style row is replaced only by a newer registry version; built-in font rows are refreshed.
BEGIN;

INSERT INTO formdev_font (font_id, metadata, updated_at) VALUES
  ('noto-sans-thai', '{"family":"Noto Sans Thai Variable","display_name":"Noto Sans Thai","category":"ui","official":false,"scripts":["thai","latin"],"weights":[100,900],"styles":["normal"],"license":"OFL-1.1","license_verified":true,"assets":[{"kind":"bundled","package":"@fontsource-variable/noto-sans-thai","installed":true}],"fallback":["Noto Sans Thai Variable","Noto Sans Thai","Tahoma","sans-serif"]}'::jsonb, 0),
  ('inter', '{"family":"Inter Variable","display_name":"Inter","category":"ui","official":false,"scripts":["latin"],"weights":[100,900],"styles":["normal"],"license":"OFL-1.1","license_verified":true,"assets":[{"kind":"bundled","package":"@fontsource-variable/inter","installed":true}],"fallback":["Inter Variable","Inter","system-ui","sans-serif"]}'::jsonb, 0),
  ('th-sarabun-new', '{"family":"TH Sarabun New","display_name":"TH Sarabun New","category":"official-th","official":true,"scripts":["thai","latin"],"weights":[400,700],"styles":["normal","italic"],"license":"Thai National Fonts released by SIPA/DIP for free use. FormDev ships no font files; verify the licence text distributed with the font before bundling it.","license_verified":false,"note":"TH Sarabun New (2011 update of TH SarabunPSK) is the font named for Thai government documents; it is the +1 beside the 13 national fonts.","assets":[{"kind":"system","family":"TH Sarabun New","note":"Use the copy installed on the workstation (no file is shipped)"},{"kind":"web_alternative","family":"Sarabun","package":"@fontsource/sarabun","license":"OFL-1.1","installed":false,"note":"Open-licence redesign of the same typeface; not installed (no packages are downloaded)"}],"fallback":["TH Sarabun New","Sarabun","Noto Sans Thai Variable","Noto Sans Thai","Tahoma","sans-serif"]}'::jsonb, 0),
  ('th-sarabun-psk', '{"family":"TH SarabunPSK","display_name":"TH SarabunPSK","category":"official-th","official":true,"scripts":["thai","latin"],"weights":[400,700],"styles":["normal","italic"],"license":"Thai National Fonts released by SIPA/DIP for free use. FormDev ships no font files; verify the licence text distributed with the font before bundling it.","license_verified":false,"assets":[{"kind":"system","family":"TH SarabunPSK","note":"Use the copy installed on the workstation (no file is shipped)"},{"kind":"web_alternative","family":"Sarabun","package":"@fontsource/sarabun","license":"OFL-1.1","installed":false,"note":"Open-licence redesign of the same typeface; not installed (no packages are downloaded)"}],"fallback":["TH SarabunPSK","Sarabun","Noto Sans Thai Variable","Noto Sans Thai","Tahoma","sans-serif"]}'::jsonb, 0),
  ('th-chakra-petch', '{"family":"TH Chakra Petch","display_name":"TH Chakra Petch","category":"official-th","official":true,"scripts":["thai","latin"],"weights":[400,700],"styles":["normal","italic"],"license":"Thai National Fonts released by SIPA/DIP for free use. FormDev ships no font files; verify the licence text distributed with the font before bundling it.","license_verified":false,"assets":[{"kind":"system","family":"TH Chakra Petch","note":"Use the copy installed on the workstation (no file is shipped)"},{"kind":"web_alternative","family":"Chakra Petch","package":"@fontsource/chakra-petch","license":"OFL-1.1","installed":false,"note":"Open-licence redesign of the same typeface; not installed (no packages are downloaded)"}],"fallback":["TH Chakra Petch","Chakra Petch","Noto Sans Thai Variable","Noto Sans Thai","Tahoma","sans-serif"]}'::jsonb, 0),
  ('th-baijam', '{"family":"TH Baijam","display_name":"TH Baijam","category":"official-th","official":true,"scripts":["thai","latin"],"weights":[400,700],"styles":["normal","italic"],"license":"Thai National Fonts released by SIPA/DIP for free use. FormDev ships no font files; verify the licence text distributed with the font before bundling it.","license_verified":false,"assets":[{"kind":"system","family":"TH Baijam","note":"Use the copy installed on the workstation (no file is shipped)"},{"kind":"web_alternative","family":"Bai Jamjuree","package":"@fontsource/bai-jamjuree","license":"OFL-1.1","installed":false,"note":"Open-licence redesign of the same typeface; not installed (no packages are downloaded)"}],"fallback":["TH Baijam","Bai Jamjuree","Noto Sans Thai Variable","Noto Sans Thai","Tahoma","sans-serif"]}'::jsonb, 0),
  ('th-charm-of-au', '{"family":"TH Charm of AU","display_name":"TH Charm of AU","category":"official-th","official":true,"scripts":["thai","latin"],"weights":[400,700],"styles":["normal","italic"],"license":"Thai National Fonts released by SIPA/DIP for free use. FormDev ships no font files; verify the licence text distributed with the font before bundling it.","license_verified":false,"assets":[{"kind":"system","family":"TH Charm of AU","note":"Use the copy installed on the workstation (no file is shipped)"},{"kind":"web_alternative","family":"Charm","package":"@fontsource/charm","license":"OFL-1.1","installed":false,"note":"Open-licence redesign of the same typeface; not installed (no packages are downloaded)"}],"fallback":["TH Charm of AU","Charm","Noto Sans Thai Variable","Noto Sans Thai","Tahoma","sans-serif"]}'::jsonb, 0),
  ('th-charmonman', '{"family":"TH Charmonman","display_name":"TH Charmonman","category":"official-th","official":true,"scripts":["thai","latin"],"weights":[400,700],"styles":["normal","italic"],"license":"Thai National Fonts released by SIPA/DIP for free use. FormDev ships no font files; verify the licence text distributed with the font before bundling it.","license_verified":false,"assets":[{"kind":"system","family":"TH Charmonman","note":"Use the copy installed on the workstation (no file is shipped)"},{"kind":"web_alternative","family":"Charmonman","package":"@fontsource/charmonman","license":"OFL-1.1","installed":false,"note":"Open-licence redesign of the same typeface; not installed (no packages are downloaded)"}],"fallback":["TH Charmonman","Charmonman","Noto Sans Thai Variable","Noto Sans Thai","Tahoma","sans-serif"]}'::jsonb, 0),
  ('th-fah-kwang', '{"family":"TH Fah kwang","display_name":"TH Fah kwang","category":"official-th","official":true,"scripts":["thai","latin"],"weights":[400,700],"styles":["normal","italic"],"license":"Thai National Fonts released by SIPA/DIP for free use. FormDev ships no font files; verify the licence text distributed with the font before bundling it.","license_verified":false,"assets":[{"kind":"system","family":"TH Fah kwang","note":"Use the copy installed on the workstation (no file is shipped)"},{"kind":"web_alternative","family":"Fahkwang","package":"@fontsource/fahkwang","license":"OFL-1.1","installed":false,"note":"Open-licence redesign of the same typeface; not installed (no packages are downloaded)"}],"fallback":["TH Fah kwang","Fahkwang","Noto Sans Thai Variable","Noto Sans Thai","Tahoma","sans-serif"]}'::jsonb, 0),
  ('th-k2d-july8', '{"family":"TH K2D July8","display_name":"TH K2D July8","category":"official-th","official":true,"scripts":["thai","latin"],"weights":[400,700],"styles":["normal","italic"],"license":"Thai National Fonts released by SIPA/DIP for free use. FormDev ships no font files; verify the licence text distributed with the font before bundling it.","license_verified":false,"assets":[{"kind":"system","family":"TH K2D July8","note":"Use the copy installed on the workstation (no file is shipped)"},{"kind":"web_alternative","family":"K2D","package":"@fontsource/k2d","license":"OFL-1.1","installed":false,"note":"Open-licence redesign of the same typeface; not installed (no packages are downloaded)"}],"fallback":["TH K2D July8","K2D","Noto Sans Thai Variable","Noto Sans Thai","Tahoma","sans-serif"]}'::jsonb, 0),
  ('th-kodchasal', '{"family":"TH Kodchasal","display_name":"TH Kodchasal","category":"official-th","official":true,"scripts":["thai","latin"],"weights":[400,700],"styles":["normal","italic"],"license":"Thai National Fonts released by SIPA/DIP for free use. FormDev ships no font files; verify the licence text distributed with the font before bundling it.","license_verified":false,"assets":[{"kind":"system","family":"TH Kodchasal","note":"Use the copy installed on the workstation (no file is shipped)"},{"kind":"web_alternative","family":"Kodchasan","package":"@fontsource/kodchasan","license":"OFL-1.1","installed":false,"note":"Open-licence redesign of the same typeface; not installed (no packages are downloaded)"}],"fallback":["TH Kodchasal","Kodchasan","Noto Sans Thai Variable","Noto Sans Thai","Tahoma","sans-serif"]}'::jsonb, 0),
  ('th-koho', '{"family":"TH KoHo","display_name":"TH KoHo","category":"official-th","official":true,"scripts":["thai","latin"],"weights":[400,700],"styles":["normal","italic"],"license":"Thai National Fonts released by SIPA/DIP for free use. FormDev ships no font files; verify the licence text distributed with the font before bundling it.","license_verified":false,"assets":[{"kind":"system","family":"TH KoHo","note":"Use the copy installed on the workstation (no file is shipped)"},{"kind":"web_alternative","family":"KoHo","package":"@fontsource/koho","license":"OFL-1.1","installed":false,"note":"Open-licence redesign of the same typeface; not installed (no packages are downloaded)"}],"fallback":["TH KoHo","KoHo","Noto Sans Thai Variable","Noto Sans Thai","Tahoma","sans-serif"]}'::jsonb, 0),
  ('th-krub', '{"family":"TH Krub","display_name":"TH Krub","category":"official-th","official":true,"scripts":["thai","latin"],"weights":[400,700],"styles":["normal","italic"],"license":"Thai National Fonts released by SIPA/DIP for free use. FormDev ships no font files; verify the licence text distributed with the font before bundling it.","license_verified":false,"assets":[{"kind":"system","family":"TH Krub","note":"Use the copy installed on the workstation (no file is shipped)"},{"kind":"web_alternative","family":"Krub","package":"@fontsource/krub","license":"OFL-1.1","installed":false,"note":"Open-licence redesign of the same typeface; not installed (no packages are downloaded)"}],"fallback":["TH Krub","Krub","Noto Sans Thai Variable","Noto Sans Thai","Tahoma","sans-serif"]}'::jsonb, 0),
  ('th-mali-grade6', '{"family":"TH Mali Grade6","display_name":"TH Mali Grade6","category":"official-th","official":true,"scripts":["thai","latin"],"weights":[400,700],"styles":["normal","italic"],"license":"Thai National Fonts released by SIPA/DIP for free use. FormDev ships no font files; verify the licence text distributed with the font before bundling it.","license_verified":false,"assets":[{"kind":"system","family":"TH Mali Grade6","note":"Use the copy installed on the workstation (no file is shipped)"},{"kind":"web_alternative","family":"Mali","package":"@fontsource/mali","license":"OFL-1.1","installed":false,"note":"Open-licence redesign of the same typeface; not installed (no packages are downloaded)"}],"fallback":["TH Mali Grade6","Mali","Noto Sans Thai Variable","Noto Sans Thai","Tahoma","sans-serif"]}'::jsonb, 0),
  ('th-niramit-as', '{"family":"TH Niramit AS","display_name":"TH Niramit AS","category":"official-th","official":true,"scripts":["thai","latin"],"weights":[400,700],"styles":["normal","italic"],"license":"Thai National Fonts released by SIPA/DIP for free use. FormDev ships no font files; verify the licence text distributed with the font before bundling it.","license_verified":false,"assets":[{"kind":"system","family":"TH Niramit AS","note":"Use the copy installed on the workstation (no file is shipped)"},{"kind":"web_alternative","family":"Niramit","package":"@fontsource/niramit","license":"OFL-1.1","installed":false,"note":"Open-licence redesign of the same typeface; not installed (no packages are downloaded)"}],"fallback":["TH Niramit AS","Niramit","Noto Sans Thai Variable","Noto Sans Thai","Tahoma","sans-serif"]}'::jsonb, 0),
  ('th-srisakdi', '{"family":"TH Srisakdi","display_name":"TH Srisakdi","category":"official-th","official":true,"scripts":["thai","latin"],"weights":[400,700],"styles":["normal","italic"],"license":"Thai National Fonts released by SIPA/DIP for free use. FormDev ships no font files; verify the licence text distributed with the font before bundling it.","license_verified":false,"assets":[{"kind":"system","family":"TH Srisakdi","note":"Use the copy installed on the workstation (no file is shipped)"},{"kind":"web_alternative","family":"Srisakdi","package":"@fontsource/srisakdi","license":"OFL-1.1","installed":false,"note":"Open-licence redesign of the same typeface; not installed (no packages are downloaded)"}],"fallback":["TH Srisakdi","Srisakdi","Noto Sans Thai Variable","Noto Sans Thai","Tahoma","sans-serif"]}'::jsonb, 0)
ON CONFLICT (font_id) DO UPDATE SET metadata = excluded.metadata, updated_at = excluded.updated_at
  WHERE formdev_font.metadata <> excluded.metadata;

INSERT INTO formdev_style (style_id, version, definition, updated_at) VALUES
  ('style.base', 1, '{"name":"Base","category":"base","tokens":{"fontId":"noto-sans-thai","fontSize":11,"fontWeight":400,"lineHeight":1.4,"color":"#1f2937","background":"transparent","align":"left","labelPosition":"top","border":"solid","borderColor":"#cbd5e1","radius":1.5,"padding":1.5,"gap":3,"columns":2,"inputHeight":8,"rule":"solid","uppercase":false,"pageMarginTop":15,"pageMarginRight":15,"pageMarginBottom":15,"pageMarginLeft":15},"components":{"label":{"fontSize":10,"fontWeight":600,"color":"#475569"},"section":{"fontSize":12,"fontWeight":700,"color":"#0f172a"},"header":{"fontSize":9,"color":"#64748b"},"footer":{"fontSize":9,"color":"#64748b"}}}'::jsonb, 0),
  ('style.a4.default', 1, '{"name":"A4 default","category":"form","inherit":"style.base","paper":"A4","tokens":{"fontSize":11}}'::jsonb, 0),
  ('style.a4.medical', 1, '{"name":"A4 medical record","category":"form","inherit":"style.a4.default","paper":"A4","tokens":{"fontSize":10,"pageMarginTop":12,"pageMarginRight":12,"pageMarginBottom":14,"pageMarginLeft":12,"rule":"solid"},"components":{"label":{"fontSize":9},"section":{"fontSize":11}}}'::jsonb, 0),
  ('style.a4.official', 1, '{"name":"A4 official document","category":"form","inherit":"style.a4.default","paper":"A4","tokens":{"fontId":"th-sarabun-new","fontSize":16,"columns":1,"rule":"none","border":"underline","pageMarginTop":25,"pageMarginRight":20,"pageMarginBottom":20,"pageMarginLeft":30},"components":{"label":{"fontSize":16,"fontWeight":400,"color":"#000000"},"section":{"fontSize":16,"fontWeight":700,"color":"#000000"}}}'::jsonb, 0),
  ('style.a4.compact', 1, '{"name":"A4 compact","category":"form","inherit":"style.a4.default","paper":"A4","tokens":{"fontSize":9,"gap":1.5,"padding":1,"inputHeight":6,"columns":3,"pageMarginTop":10,"pageMarginRight":10,"pageMarginBottom":10,"pageMarginLeft":10},"components":{"label":{"fontSize":8},"section":{"fontSize":10}}}'::jsonb, 0),
  ('field.text.default', 1, '{"name":"Text field","category":"field","tokens":{"border":"solid","inputHeight":8}}'::jsonb, 0),
  ('field.number.large', 1, '{"name":"Large number","category":"field","inherit":"field.text.default","tokens":{"fontSize":16,"fontWeight":700,"align":"right"}}'::jsonb, 0),
  ('section.header', 1, '{"name":"Header section","category":"section","tokens":{"rule":"card","background":"#f1f5f9","padding":3},"components":{"section":{"fontSize":13,"uppercase":true}}}'::jsonb, 0),
  ('form.a4.medical', 2, '{"name":"A4 medical record (alias of style.a4.medical)","category":"form","inherit":"style.a4.medical","paper":"A4","tokens":{}}'::jsonb, 0),
  ('form.a4.official', 2, '{"name":"A4 official document (alias of style.a4.official)","category":"form","inherit":"style.a4.official","paper":"A4","tokens":{}}'::jsonb, 0),
  ('form.screen.default', 2, '{"name":"Screen default","category":"form","inherit":"style.base","paper":"screen","tokens":{"fontId":"inter","rule":"card"}}'::jsonb, 0)
ON CONFLICT (style_id) DO UPDATE SET version = excluded.version, definition = excluded.definition, updated_at = excluded.updated_at
  WHERE formdev_style.version < excluded.version;

COMMIT;

-- ===== 0063-formdev-lookup.sql =====
-- FormDev Phase 2.3: lookup tables for dependent options and derived values (formdev/registry/lookups/*.json).
-- Generated by formdev/scripts/sync_registry_seed.py; do not edit. Idempotent: a row is replaced only by a newer version.
BEGIN;

CREATE TABLE IF NOT EXISTS formdev_lookup (
  lookup_id text PRIMARY KEY,
  version integer NOT NULL,
  metadata jsonb NOT NULL,
  entries jsonb NOT NULL,
  updated_at bigint NOT NULL,
  updated_by text
);

INSERT INTO formdev_lookup (lookup_id, version, metadata, entries, updated_at, updated_by) VALUES
  ('thai_address', 1, '{"title":"ที่อยู่ประเทศไทย (จังหวัด / อำเภอ / ตำบล / รหัสไปรษณีย์)","columns":[{"name":"province","label":"จังหวัด"},{"name":"district","label":"อำเภอ / เขต"},{"name":"subdistrict","label":"ตำบล / แขวง"},{"name":"postcode","label":"รหัสไปรษณีย์"}],"authoritative":false,"notice":"SAMPLE ONLY: a handful of rows for development and tests, not a complete or verified list. Import the official dataset with formdev/scripts/import_lookup.py before production use."}'::jsonb, '[{"province":"กรุงเทพมหานคร","district":"เขตพระนคร","subdistrict":"แขวงพระบรมมหาราชวัง","postcode":"10200"},{"province":"กรุงเทพมหานคร","district":"เขตพระนคร","subdistrict":"แขวงวังบูรพาภิรมย์","postcode":"10200"},{"province":"กรุงเทพมหานคร","district":"เขตพระนคร","subdistrict":"แขวงวัดราชบพิธ","postcode":"10200"},{"province":"กรุงเทพมหานคร","district":"เขตปทุมวัน","subdistrict":"แขวงลุมพินี","postcode":"10330"},{"province":"กรุงเทพมหานคร","district":"เขตปทุมวัน","subdistrict":"แขวงรองเมือง","postcode":"10330"},{"province":"กรุงเทพมหานคร","district":"เขตบางรัก","subdistrict":"แขวงสีลม","postcode":"10500"},{"province":"เชียงใหม่","district":"อำเภอเมืองเชียงใหม่","subdistrict":"ตำบลศรีภูมิ","postcode":"50200"},{"province":"เชียงใหม่","district":"อำเภอเมืองเชียงใหม่","subdistrict":"ตำบลสุเทพ","postcode":"50200"},{"province":"เชียงใหม่","district":"อำเภอเมืองเชียงใหม่","subdistrict":"ตำบลช้างเผือก","postcode":"50300"},{"province":"เชียงใหม่","district":"อำเภอสันทราย","subdistrict":"ตำบลสันทรายหลวง","postcode":"50210"},{"province":"ขอนแก่น","district":"อำเภอเมืองขอนแก่น","subdistrict":"ตำบลในเมือง","postcode":"40000"},{"province":"ภูเก็ต","district":"อำเภอเมืองภูเก็ต","subdistrict":"ตำบลตลาดใหญ่","postcode":"83000"},{"province":"ภูเก็ต","district":"อำเภอกะทู้","subdistrict":"ตำบลป่าตอง","postcode":"83150"}]'::jsonb, 0, 'system')
ON CONFLICT (lookup_id) DO UPDATE SET version = excluded.version, metadata = excluded.metadata, entries = excluded.entries,
  updated_at = excluded.updated_at, updated_by = excluded.updated_by
  WHERE formdev_lookup.version < excluded.version;

GRANT SELECT, INSERT, UPDATE ON formdev_lookup TO flora_view, flora_app;

COMMIT;

-- ===== 0064-formdev-attachment.sql =====
-- FormDev data layer: attachment content for file and image fields, addressed by SHA-256.
-- Used unless FORMDEV_ATTACHMENT_DIR points the API at a directory instead. Idempotent.
BEGIN;

CREATE TABLE IF NOT EXISTS formdev_attachment (
  sha256 text PRIMARY KEY CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  media_type text NOT NULL,
  size integer NOT NULL CHECK (size >= 0),
  content bytea NOT NULL,
  created_at bigint NOT NULL,
  created_by text
);

GRANT SELECT, INSERT ON formdev_attachment TO flora_view, flora_app;

COMMIT;

-- ===== 0065-formdev-index-rebuild.sql =====
-- FormDev Phase 4: rebuild the record index once after upgrading.
-- Index rows and subject_id now follow each form's latest published definition (0061). Records written
-- before that keep index rows under their own version and no subject_id, so every form that has records
-- is marked '*' building: queries on its indexed fields and $subject_id answer index_building until the
-- job worker's maintenance runs a full rebuild and clears the marker. Idempotent; no-op on a new database.
BEGIN;

INSERT INTO formdev_index_coverage (form_id, field_id, origin, state, schema_version, updated_at)
SELECT f.form_id, '*', 'definition', 'building', 0, 0
FROM formdev_form f
WHERE EXISTS (SELECT 1 FROM formdev_record r WHERE r.form_id = f.form_id)
ON CONFLICT (form_id, field_id) DO NOTHING;

GRANT DELETE ON formdev_index_coverage TO flora_view, flora_app;

COMMIT;

-- ===== 0083-formdev-template.sql =====
-- Form Studio template library: complete form definitions offered as starting points, written by hand or built by
-- the AI form builder from source documents (PDF, images, Word, Excel). A template is a draft until an author marks it
-- reviewed; forms are created from it in Form Studio and only published forms reach Workflow Studio. The source
-- documents stay in formdev_attachment (sources lists their sha256). Idempotent.
BEGIN;

CREATE TABLE IF NOT EXISTS formdev_template (
  template_id text PRIMARY KEY CHECK (template_id ~ '^[a-z][a-z0-9_]{1,63}$'),
  title text NOT NULL,
  description text NOT NULL DEFAULT '',
  origin text NOT NULL CHECK (origin IN ('ai', 'manual', 'import')),
  status text NOT NULL CHECK (status IN ('draft', 'reviewed')),
  definition jsonb NOT NULL,
  report jsonb,
  sources jsonb NOT NULL DEFAULT '[]'::jsonb,
  version integer NOT NULL CHECK (version >= 1),
  created_at bigint NOT NULL,
  created_by text,
  updated_at bigint NOT NULL,
  updated_by text
);

CREATE INDEX IF NOT EXISTS formdev_template_updated ON formdev_template (updated_at DESC);

GRANT SELECT, INSERT, UPDATE, DELETE ON formdev_template TO flora_view, flora_app;

COMMIT;

\dt formdev_*
