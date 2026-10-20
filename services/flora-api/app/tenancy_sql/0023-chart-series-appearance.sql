BEGIN;

ALTER TABLE clinical_parameter_master
  ADD COLUMN IF NOT EXISTS chart_color text,
  ADD COLUMN IF NOT EXISTS chart_marker text;

DO $$ BEGIN
  ALTER TABLE clinical_parameter_master ADD CONSTRAINT clinical_parameter_chart_color
    CHECK (chart_color IS NULL OR chart_color ~ '^#[0-9A-Fa-f]{6}$');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE clinical_parameter_master ADD CONSTRAINT clinical_parameter_chart_marker
    CHECK (chart_marker IS NULL OR chart_marker IN ('circle','heart','diamond','square','triangle','range'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

WITH appearance(chart_group_key,chart_color,chart_marker) AS (VALUES
  ('hr','#F5F7FA','heart'),
  ('pr','#78D9C6','circle'),
  ('spo2','#8CBFF2','circle'),
  ('nibp','#8ED99A','range'),
  ('art','#EF9696','range'),
  ('cvp','#C6A7F2','diamond'),
  ('temp','#F2BF75','diamond')
)
UPDATE clinical_parameter_master parameter SET
  chart_color=appearance.chart_color,
  chart_marker=appearance.chart_marker
FROM appearance
WHERE parameter.chart_group_key=appearance.chart_group_key
  AND (parameter.chart_color IS NULL OR parameter.chart_marker IS NULL);

GRANT SELECT,INSERT,UPDATE,DELETE ON clinical_parameter_master TO flora_app;

COMMIT;
