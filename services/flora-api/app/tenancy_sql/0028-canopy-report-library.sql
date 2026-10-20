CREATE TABLE IF NOT EXISTS canopy_report_definition (
  id text PRIMARY KEY,
  title text NOT NULL,
  description text NOT NULL DEFAULT '',
  category text NOT NULL CHECK (category IN ('clinical_timing', 'clinical_summary', 'operations')),
  source_system text NOT NULL DEFAULT 'innovian_archive',
  definition jsonb NOT NULL DEFAULT '{}'::jsonb,
  is_system boolean NOT NULL DEFAULT false,
  is_active boolean NOT NULL DEFAULT true,
  sort_order integer NOT NULL DEFAULT 0,
  created_by text,
  created_at bigint NOT NULL,
  updated_at bigint NOT NULL
);

CREATE INDEX IF NOT EXISTS canopy_report_definition_library_idx
  ON canopy_report_definition (is_active, category, sort_order, title);

INSERT INTO canopy_report_definition
  (id, title, description, category, source_system, definition, is_system, sort_order, created_at, updated_at)
VALUES
  ('admit-discharge-time', 'Admit and Discharge Time', 'Patient In/Admit, Patient Out/Discharge and encounter duration with care-unit context.', 'clinical_timing', 'innovian_archive',
   '{"engine_report":"admit-discharge-time","dataset":"innovian_archive","mode":"detail","filters":["date_range","hn","staff","completeness"],"columns":["hn","patient_name","admit_datetime","discharge_datetime","stay_minutes","care_unit_label","device_label","asa_status","record_status"]}', true, 10, 1727366400000, 1727366400000),
  ('staff-time-in-or', 'Staff Time In (OR)', 'Compare staff Time In with Patient In OR and calculate the interval for every assignment.', 'clinical_timing', 'innovian_archive',
   '{"engine_report":"staff-time-in-or","dataset":"innovian_archive","mode":"detail","filters":["date_range","hn","staff","role","completeness"],"columns":["hn","patient_name","staff_name","staff_role","staff_time_in","patient_in_or_datetime","duration_minutes","record_status"]}', true, 20, 1727366400000, 1727366400000),
  ('anaesthetic-release-time', 'Anaesthetic Release Time', 'Compare Start ANES with Position 1 and flag incomplete or clinically implausible intervals.', 'clinical_timing', 'innovian_archive',
   '{"engine_report":"anaesthetic-release-time","dataset":"innovian_archive","mode":"detail","filters":["date_range","hn","staff","completeness"],"columns":["hn","patient_name","start_anes_datetime","position_1_datetime","duration_minutes","release_record_status"]}', true, 30, 1727366400000, 1727366400000),
  ('asa-status', 'ASA Status', 'Monthly case and distinct-patient counts grouped by recorded ASA status.', 'clinical_summary', 'innovian_archive',
   '{"engine_report":"asa-status","dataset":"innovian_archive","mode":"monthly_drilldown","filters":["date_range","hn","staff","completeness"],"dimensions":["month","asa_status"],"measures":["case_count","patient_count"]}', true, 40, 1727366400000, 1727366400000),
  ('case-type-service', 'Case Type / Service', 'Monthly case and patient counts grouped by Innovian case type or service.', 'clinical_summary', 'innovian_archive',
   '{"engine_report":"case-type-service","dataset":"innovian_archive","mode":"monthly_drilldown","filters":["date_range","hn","staff","completeness"],"dimensions":["month","category"],"measures":["case_count","patient_count"]}', true, 50, 1727366400000, 1727366400000),
  ('anes-technique', 'Anes-Technique', 'Monthly summary of documented Balance, TIVA, MAC and other anaesthetic techniques.', 'clinical_summary', 'innovian_archive',
   '{"engine_report":"anes-technique","dataset":"innovian_archive","mode":"monthly_drilldown","filters":["date_range","hn","staff","completeness"],"dimensions":["month","category"],"measures":["case_count","patient_count"]}', true, 60, 1727366400000, 1727366400000),
  ('anes-ra', 'Anes-RA', 'Monthly regional-anaesthesia summary using decoded source form components.', 'clinical_summary', 'innovian_archive',
   '{"engine_report":"anes-ra","dataset":"innovian_archive","mode":"monthly_drilldown","filters":["date_range","hn","staff","completeness"],"dimensions":["month","category"],"measures":["case_count","patient_count"]}', true, 70, 1727366400000, 1727366400000),
  ('anes-ga', 'Anes-GA', 'Monthly general-anaesthesia summary using documented Innovian components.', 'clinical_summary', 'innovian_archive',
   '{"engine_report":"anes-ga","dataset":"innovian_archive","mode":"monthly_drilldown","filters":["date_range","hn","staff","completeness"],"dimensions":["month","category"],"measures":["case_count","patient_count"]}', true, 80, 1727366400000, 1727366400000),
  ('general-item-equipment', 'General Item / Equipment', 'Monthly airway equipment and tube/cuff summary with case drill-down.', 'clinical_summary', 'innovian_archive',
   '{"engine_report":"general-item-equipment","dataset":"innovian_archive","mode":"monthly_drilldown","filters":["date_range","hn","staff","completeness"],"dimensions":["month","category"],"measures":["case_count","patient_count"]}', true, 90, 1727366400000, 1727366400000),
  ('intubation-technique', 'Intubation Technique', 'Monthly direct, video and other recorded intubation-technique categories.', 'clinical_summary', 'innovian_archive',
   '{"engine_report":"intubation-technique","dataset":"innovian_archive","mode":"monthly_drilldown","filters":["date_range","hn","staff","completeness"],"dimensions":["month","category"],"measures":["case_count","patient_count"]}', true, 100, 1727366400000, 1727366400000),
  ('special-technique', 'Special Technique', 'Monthly documented special techniques including hypothermia, hypotensive technique and scalp block.', 'clinical_summary', 'innovian_archive',
   '{"engine_report":"special-technique","dataset":"innovian_archive","mode":"monthly_drilldown","filters":["date_range","hn","staff","completeness"],"dimensions":["month","category"],"measures":["case_count","patient_count"]}', true, 110, 1727366400000, 1727366400000),
  ('pacu-summary', 'PACU Summary', 'Monthly cases and distinct patients documented in PACU or PACU Ambulatory.', 'clinical_summary', 'innovian_archive',
   '{"engine_report":"pacu-summary","dataset":"innovian_archive","mode":"monthly_drilldown","filters":["date_range","hn","staff","completeness"],"dimensions":["month","category"],"measures":["case_count","patient_count"]}', true, 120, 1727366400000, 1727366400000),
  ('nerve-block', 'Nerve Block', 'Monthly documented nerve-block procedure counts with case drill-down.', 'clinical_summary', 'innovian_archive',
   '{"engine_report":"nerve-block","dataset":"innovian_archive","mode":"monthly_drilldown","filters":["date_range","hn","staff","completeness"],"dimensions":["month","category"],"measures":["case_count","patient_count"]}', true, 130, 1727366400000, 1727366400000),
  ('case-volume-month', 'Case Volume by Month', 'Monthly encounter and distinct-patient volume with discharge-data completeness.', 'operations', 'innovian_archive',
   '{"engine_report":"case-volume-month","dataset":"innovian_archive","mode":"summary","filters":["date_range","hn","staff","completeness"],"dimensions":["month"],"measures":["encounter_count","patient_count","complete_count","missing_count","average_stay_minutes"]}', true, 140, 1727366400000, 1727366400000),
  ('pdf-report-completeness', 'PDF Report Completeness', 'Compare expected ANES, FORM, POST and PACU documents with discovered source files.', 'operations', 'innovian_archive',
   '{"engine_report":"pdf-report-completeness","dataset":"innovian_archive","mode":"detail","filters":["date_range","hn","completeness"],"columns":["hn","patient_name","admit_datetime","found_anes","found_form","found_post","found_pacu","missing_types","source_count","record_status"]}', true, 150, 1727366400000, 1727366400000)
ON CONFLICT (id) DO UPDATE SET
  title=excluded.title,
  description=excluded.description,
  category=excluded.category,
  source_system=excluded.source_system,
  definition=excluded.definition,
  is_system=excluded.is_system,
  is_active=excluded.is_active,
  sort_order=excluded.sort_order,
  updated_at=excluded.updated_at;

GRANT SELECT, INSERT, UPDATE ON canopy_report_definition TO flora_view;

-- A standalone Canopy database needs one initial local administrator before
-- centralized identity is connected. The bootstrap routine only writes when
-- auth_user is completely empty.
GRANT INSERT ON auth_user, auth_user_role TO flora_view;
GRANT USAGE, SELECT ON SEQUENCE auth_user_id_seq TO flora_view;
