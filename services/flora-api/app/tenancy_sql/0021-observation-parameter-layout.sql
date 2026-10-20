BEGIN;

ALTER TABLE clinical_parameter_master
  ADD COLUMN IF NOT EXISTS short_name text,
  ADD COLUMN IF NOT EXISTS display_order bigint NOT NULL DEFAULT 1000,
  ADD COLUMN IF NOT EXISTS table_group text NOT NULL DEFAULT 'measured',
  ADD COLUMN IF NOT EXISTS show_in_table bigint NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS chart_group_key text,
  ADD COLUMN IF NOT EXISTS chart_label text,
  ADD COLUMN IF NOT EXISTS chart_style text,
  ADD COLUMN IF NOT EXISTS show_in_chart bigint NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS chart_default_visible bigint NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS source_aliases jsonb NOT NULL DEFAULT '[]'::jsonb;

DO $$ BEGIN
  ALTER TABLE clinical_parameter_master ADD CONSTRAINT clinical_parameter_table_group
    CHECK (table_group IN ('core','set','measured'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE clinical_parameter_master ADD CONSTRAINT clinical_parameter_show_in_table
    CHECK (show_in_table IN (0,1));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE clinical_parameter_master ADD CONSTRAINT clinical_parameter_show_in_chart
    CHECK (show_in_chart IN (0,1));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE clinical_parameter_master ADD CONSTRAINT clinical_parameter_chart_default
    CHECK (chart_default_visible IN (0,1));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE clinical_parameter_master ADD CONSTRAINT clinical_parameter_chart_style
    CHECK (chart_style IS NULL OR chart_style IN ('line','point','range'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

WITH layout(param_key,short_name,display_order,table_group,chart_group_key,chart_label,chart_style,show_in_chart,chart_default_visible) AS (VALUES
  ('hr','HR',10,'core','hr','HR','line',1,1),
  ('pr','PR/PLS',20,'core','pr','PR/PLS','line',1,1),
  ('spo2','SpO2',30,'core','spo2','SpO2','line',1,1),
  ('nibp_sys','NIBP Sys',40,'core','nibp','NIBP','range',1,1),
  ('nibp_map','NIBP Map',41,'core','nibp','NIBP','range',1,1),
  ('nibp_dia','NIBP Dia',42,'core','nibp','NIBP','range',1,1),
  ('art_sys','ART Sys',50,'core','art','ART','range',1,0),
  ('art_map','ART Map',51,'core','art','ART','range',1,0),
  ('art_dia','ART Dia',52,'core','art','ART','range',1,0),
  ('cvp','CVP',60,'core','cvp','CVP','point',1,0),
  ('temperature','Temp',70,'core','temp','Temp','line',1,0),
  ('set_vent_mode','Vent Mode',110,'set',NULL,NULL,NULL,0,0),
  ('set_tidal_volume','Tidal Volume',120,'set',NULL,NULL,NULL,0,0),
  ('set_insp_pressure','Inspired Pressure',130,'set',NULL,NULL,NULL,0,0),
  ('set_rr','RR',140,'set',NULL,NULL,NULL,0,0),
  ('set_ie_ratio','I:E Ratio',150,'set',NULL,NULL,NULL,0,0),
  ('set_t_insp','T Insp',160,'set',NULL,NULL,NULL,0,0),
  ('set_insp_pause_pct','T Pause',170,'set',NULL,NULL,NULL,0,0),
  ('set_peep','PEEP',180,'set',NULL,NULL,NULL,0,0),
  ('set_peak_limit','Peak Limit',190,'set',NULL,NULL,NULL,0,0),
  ('set_psupp','Pressure Support',200,'set',NULL,NULL,NULL,0,0),
  ('set_flow_trigger','Flow Trigger',210,'set',NULL,NULL,NULL,0,0),
  ('set_end_flow','End Flow',220,'set',NULL,NULL,NULL,0,0),
  ('set_fio2','FiO2',230,'set',NULL,NULL,NULL,0,0),
  ('set_fgf_total','Fresh Gas Flow',240,'set',NULL,NULL,NULL,0,0),
  ('rr','RR',310,'measured',NULL,NULL,NULL,0,0),
  ('tidal_volume_exp','TV Exp',320,'measured',NULL,NULL,NULL,0,0),
  ('minute_volume_exp','MV Exp',330,'measured',NULL,NULL,NULL,0,0),
  ('airway_pressure_peak','Ppeak',340,'measured',NULL,NULL,NULL,0,0),
  ('airway_pressure_plateau','Pplat',350,'measured',NULL,NULL,NULL,0,0),
  ('airway_pressure_mean','Pmean',360,'measured',NULL,NULL,NULL,0,0),
  ('airway_pressure_min','Pmin',370,'measured',NULL,NULL,NULL,0,0),
  ('peep_total','Total PEEP',380,'measured',NULL,NULL,NULL,0,0),
  ('compliance','Compliance',390,'measured',NULL,NULL,NULL,0,0),
  ('fi_agent','FiAgent',400,'measured',NULL,NULL,NULL,0,0),
  ('et_agent','EtAgent',410,'measured',NULL,NULL,NULL,0,0),
  ('mac','MAC',420,'measured',NULL,NULL,NULL,0,0),
  ('fio2','FiO2',430,'measured',NULL,NULL,NULL,0,0),
  ('fio2_meas','FiO2 (sensor)',440,'measured',NULL,NULL,NULL,0,0),
  ('fi_co2','FiCO2',450,'measured',NULL,NULL,NULL,0,0),
  ('et_co2','EtCO2',460,'measured',NULL,NULL,NULL,0,0),
  ('et_o2','EtO2',470,'measured',NULL,NULL,NULL,0,0),
  ('fi_n2o','Fi N2O',480,'measured',NULL,NULL,NULL,0,0),
  ('et_n2o','Et N2O',490,'measured',NULL,NULL,NULL,0,0),
  ('flow_o2','O2 Flow',500,'measured',NULL,NULL,NULL,0,0),
  ('flow_n2o','N2O Flow',510,'measured',NULL,NULL,NULL,0,0),
  ('flow_air','Air Flow',520,'measured',NULL,NULL,NULL,0,0)
)
UPDATE clinical_parameter_master parameter SET
  short_name=layout.short_name,
  display_order=layout.display_order,
  table_group=layout.table_group,
  chart_group_key=layout.chart_group_key,
  chart_label=layout.chart_label,
  chart_style=layout.chart_style,
  show_in_chart=layout.show_in_chart,
  chart_default_visible=layout.chart_default_visible
FROM layout WHERE parameter.param_key=layout.param_key;

CREATE INDEX IF NOT EXISTS clinical_parameter_display_order
  ON clinical_parameter_master(is_active,show_in_table,display_order,param_key);

GRANT SELECT,INSERT,UPDATE,DELETE ON clinical_parameter_master TO flora_app;

COMMIT;
