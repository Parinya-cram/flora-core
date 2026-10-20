BEGIN;

CREATE TABLE IF NOT EXISTS language_master (
  code text PRIMARY KEY,
  name_en text NOT NULL,
  name_native text NOT NULL,
  is_active bigint NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
  sort_order bigint NOT NULL DEFAULT 0,
  created_at bigint NOT NULL,
  updated_at bigint NOT NULL
);

CREATE TABLE IF NOT EXISTS theme_scheme_master (
  code text PRIMARY KEY,
  display_name text NOT NULL,
  color_1_canvas text NOT NULL,
  color_2_surface text NOT NULL,
  color_3_border text NOT NULL,
  color_4_text text NOT NULL,
  color_5_muted text NOT NULL,
  color_6_accent text NOT NULL,
  is_active bigint NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
  sort_order bigint NOT NULL DEFAULT 0,
  created_at bigint NOT NULL,
  updated_at bigint NOT NULL
);

INSERT INTO language_master(code, name_en, name_native, sort_order, created_at, updated_at)
VALUES
  ('en', 'English', 'English', 10, 0, 0),
  ('th', 'Thai', 'ไทย', 20, 0, 0)
ON CONFLICT (code) DO UPDATE SET
  name_en = EXCLUDED.name_en,
  name_native = EXCLUDED.name_native,
  sort_order = EXCLUDED.sort_order;

INSERT INTO theme_scheme_master(
  code, display_name, color_1_canvas, color_2_surface, color_3_border,
  color_4_text, color_5_muted, color_6_accent, sort_order, created_at, updated_at
)
VALUES
  ('monochromatic', 'Mono', '#121212', '#1c1c1c', '#444444', '#e0e0e0', '#b0b0b0', '#a1a1aa', 10, 0, 0),
  ('neon', 'Neon', '#0d0d0d', '#171717', '#444444', '#ffffff', '#b0b0b0', '#00ff85', 20, 0, 0),
  ('warm', 'Warm', '#1c1c1c', '#292421', '#554640', '#f5e8d8', '#c8b9a9', '#ff6f61', 30, 0, 0),
  ('pastel', 'Pastel', '#2c2c2c', '#383838', '#5a5a5a', '#e4e4e4', '#c5c5c5', '#a8dadc', 40, 0, 0),
  ('jewel', 'Jewel', '#1a1a1a', '#202827', '#3e5641', '#f0f0f0', '#bdbdbd', '#89c1cf', 50, 0, 0),
  ('vibrant', 'Vibrant', '#181818', '#252120', '#555555', '#f7f7f7', '#c6c6c6', '#ff5722', 60, 0, 0),
  ('air', 'Air', '#f3f7fa', '#ffffff', '#c7d4dc', '#17232d', '#60717d', '#147d92', 70, 0, 0),
  ('sage', 'Sage', '#f3f7f2', '#ffffff', '#c8d7c7', '#1d2b23', '#66756b', '#2f7d5a', 80, 0, 0),
  ('lilac', 'Lilac', '#f7f5fb', '#ffffff', '#d5cde3', '#282135', '#71677f', '#7257a8', 90, 0, 0)
ON CONFLICT (code) DO UPDATE SET
  display_name = EXCLUDED.display_name,
  color_1_canvas = EXCLUDED.color_1_canvas,
  color_2_surface = EXCLUDED.color_2_surface,
  color_3_border = EXCLUDED.color_3_border,
  color_4_text = EXCLUDED.color_4_text,
  color_5_muted = EXCLUDED.color_5_muted,
  color_6_accent = EXCLUDED.color_6_accent,
  sort_order = EXCLUDED.sort_order;

ALTER TABLE auth_user ADD COLUMN IF NOT EXISTS language_code text;
UPDATE auth_user SET language_code = 'en' WHERE language_code IS NULL OR btrim(language_code) = '';
ALTER TABLE auth_user ALTER COLUMN language_code SET DEFAULT 'en';
ALTER TABLE auth_user ALTER COLUMN language_code SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'auth_user_language_code_fkey') THEN
    ALTER TABLE auth_user
      ADD CONSTRAINT auth_user_language_code_fkey
      FOREIGN KEY (language_code) REFERENCES language_master(code);
  END IF;
END $$;

GRANT SELECT ON language_master, theme_scheme_master TO flora_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON language_master, theme_scheme_master TO flora_app;

COMMIT;
