CREATE UNIQUE INDEX IF NOT EXISTS idx_legacy_med_drip_preset_analysis_key
  ON legacy_med_drip_preset_analysis (
    source_system,
    source_scope,
    COALESCE(source_year_from, 0),
    COALESCE(source_year_to, 0),
    drug_name,
    COALESCE(route, ''),
    weight_based,
    COALESCE(med_amount_value, 0),
    COALESCE(med_amount_unit, ''),
    COALESCE(carrier_name, ''),
    COALESCE(carrier_volume_ml, 0),
    COALESCE(concentration_value, 0),
    COALESCE(concentration_unit, '')
  );

CREATE UNIQUE INDEX IF NOT EXISTS idx_ephis_daily_case_unique
  ON ephis_daily_case (hn, admit_date, COALESCE(admit_datetime, ''));

GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO flora_app;
GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public TO flora_app;
