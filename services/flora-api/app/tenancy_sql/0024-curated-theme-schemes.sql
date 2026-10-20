BEGIN;

INSERT INTO theme_scheme_master(
  code, display_name, color_1_canvas, color_2_surface, color_3_border,
  color_4_text, color_5_muted, color_6_accent, is_active, sort_order, created_at, updated_at
)
VALUES
  ('monochromatic', 'Mono', '#121212', '#1c1c1c', '#444444', '#e0e0e0', '#b0b0b0', '#a1a1aa', 1, 10, 0, 0),
  ('neon', 'Neon', '#0d0d0d', '#171717', '#444444', '#ffffff', '#b0b0b0', '#00ff85', 1, 20, 0, 0),
  ('warm', 'Warm', '#1c1c1c', '#292421', '#554640', '#f5e8d8', '#c8b9a9', '#ff6f61', 1, 30, 0, 0),
  ('pastel', 'Pastel', '#2c2c2c', '#383838', '#5a5a5a', '#e4e4e4', '#c5c5c5', '#a8dadc', 1, 40, 0, 0),
  ('pink-pastel', 'Pink Pastel', '#fff4f7', '#ffffff', '#e7c6d2', '#362832', '#75626c', '#ad416f', 1, 50, 0, 0)
ON CONFLICT (code) DO UPDATE SET
  display_name = EXCLUDED.display_name,
  color_1_canvas = EXCLUDED.color_1_canvas,
  color_2_surface = EXCLUDED.color_2_surface,
  color_3_border = EXCLUDED.color_3_border,
  color_4_text = EXCLUDED.color_4_text,
  color_5_muted = EXCLUDED.color_5_muted,
  color_6_accent = EXCLUDED.color_6_accent,
  is_active = EXCLUDED.is_active,
  sort_order = EXCLUDED.sort_order,
  updated_at = EXCLUDED.updated_at;

UPDATE auth_user
SET theme_color = 'monochromatic'
WHERE theme_color IS NOT NULL
  AND theme_color NOT IN ('monochromatic', 'neon', 'warm', 'pastel', 'pink-pastel');

UPDATE theme_scheme_master
SET is_active = 0
WHERE code NOT IN ('monochromatic', 'neon', 'warm', 'pastel', 'pink-pastel');

COMMIT;
