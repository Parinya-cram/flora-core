BEGIN;

INSERT INTO theme_scheme_master(
  code, display_name, color_1_canvas, color_2_surface, color_3_border,
  color_4_text, color_5_muted, color_6_accent, is_active, sort_order, created_at, updated_at
)
VALUES
  ('air', 'Air', '#f3f7fa', '#ffffff', '#c7d4dc', '#17232d', '#60717d', '#147d92', 1, 70, 0, 0),
  ('sage', 'Sage', '#f3f7f2', '#ffffff', '#c8d7c7', '#1d2b23', '#66756b', '#2f7d5a', 1, 80, 0, 0),
  ('lilac', 'Lilac', '#f7f5fb', '#ffffff', '#d5cde3', '#282135', '#71677f', '#7257a8', 1, 90, 0, 0)
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

COMMIT;
