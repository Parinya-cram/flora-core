BEGIN;

INSERT INTO theme_scheme_master(
  code, display_name, color_1_canvas, color_2_surface, color_3_border,
  color_4_text, color_5_muted, color_6_accent, is_active, sort_order, created_at, updated_at
)
VALUES
  ('muji', 'Muji', '#f7f2e8', '#fffaf0', '#d8c8ad', '#3f3529', '#796b5c', '#8a6846', 1, 50, 0, 0),
  ('mori', 'Mori', '#f1f6ef', '#fbfdf9', '#c8d8c2', '#26352a', '#667569', '#3f7652', 1, 60, 0, 0),
  ('ocean', 'Ocean', '#eef5fa', '#f9fcff', '#bfd0df', '#15283a', '#5a7084', '#174f7a', 1, 70, 0, 0),
  ('pink-pastel', 'Pink Pastel', '#fff4f7', '#ffffff', '#e7c6d2', '#362832', '#75626c', '#ad416f', 1, 80, 0, 0)
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

UPDATE theme_scheme_master
SET is_active = 0
WHERE code NOT IN ('monochromatic', 'neon', 'warm', 'pastel', 'muji', 'mori', 'ocean', 'pink-pastel');

COMMIT;
