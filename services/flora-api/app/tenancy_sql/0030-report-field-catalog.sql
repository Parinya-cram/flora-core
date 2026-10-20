-- Metadata used by the visual report builder and Flora Agent.  Definitions
-- reference stable field ids; clients never supply SQL expressions.
CREATE TABLE IF NOT EXISTS canopy_report_dataset (
  id text PRIMARY KEY,
  title text NOT NULL,
  description text NOT NULL DEFAULT '',
  grain text NOT NULL CHECK (grain IN ('case', 'staff_assignment', 'report_document')),
  source_system text NOT NULL,
  is_active boolean NOT NULL DEFAULT true,
  sort_order integer NOT NULL DEFAULT 0,
  created_at bigint NOT NULL,
  updated_at bigint NOT NULL
);

CREATE TABLE IF NOT EXISTS canopy_report_field (
  id text PRIMARY KEY,
  dataset_id text NOT NULL REFERENCES canopy_report_dataset(id) ON DELETE CASCADE,
  label text NOT NULL,
  description text NOT NULL DEFAULT '',
  section text NOT NULL,
  data_type text NOT NULL CHECK (data_type IN ('text', 'category', 'date', 'datetime', 'number', 'boolean', 'duration')),
  cardinality text NOT NULL DEFAULT 'scalar' CHECK (cardinality IN ('scalar', 'multi')),
  allowed_uses text[] NOT NULL DEFAULT ARRAY['result']::text[],
  operators text[] NOT NULL DEFAULT ARRAY['equals']::text[],
  source_config jsonb NOT NULL,
  is_active boolean NOT NULL DEFAULT true,
  sort_order integer NOT NULL DEFAULT 0,
  created_at bigint NOT NULL,
  updated_at bigint NOT NULL,
  CHECK (allowed_uses <@ ARRAY['filter','result','group','measure']::text[])
);

CREATE INDEX IF NOT EXISTS canopy_report_field_catalog_idx
  ON canopy_report_field (dataset_id, is_active, section, sort_order, label);

CREATE TABLE IF NOT EXISTS canopy_report_field_option (
  field_id text NOT NULL REFERENCES canopy_report_field(id) ON DELETE CASCADE,
  value_code text NOT NULL,
  display_label text NOT NULL,
  aliases jsonb NOT NULL DEFAULT '[]'::jsonb,
  is_active boolean NOT NULL DEFAULT true,
  sort_order integer NOT NULL DEFAULT 0,
  PRIMARY KEY (field_id, value_code)
);

INSERT INTO canopy_report_dataset
  (id,title,description,grain,source_system,is_active,sort_order,created_at,updated_at)
VALUES
  ('innovian_cases','Innovian archive cases','One row per migrated Innovian case with optional multi-value clinical attributes.','case','innovian_archive',true,10,1727366400000,1727366400000),
  ('innovian_staff_assignments','Innovian staff assignments','One row per staff assignment within a migrated case.','staff_assignment','innovian_archive',true,20,1727366400000,1727366400000),
  ('case_report_documents','Case PDF documents','One row per expected case-level report document.','report_document','innovian_archive',true,30,1727366400000,1727366400000)
ON CONFLICT (id) DO UPDATE SET title=excluded.title,description=excluded.description,
  grain=excluded.grain,source_system=excluded.source_system,is_active=excluded.is_active,
  sort_order=excluded.sort_order,updated_at=excluded.updated_at;

INSERT INTO canopy_report_field
  (id,dataset_id,label,description,section,data_type,cardinality,allowed_uses,operators,source_config,is_active,sort_order,created_at,updated_at)
VALUES
  ('case.started_at','innovian_cases','Procedure date','Case start/procedure date.','Case','datetime','scalar',ARRAY['filter','result','group'],ARRAY['between','before','after','equals'],'{"resolver":"case_column","column":"started_at"}',true,10,1727366400000,1727366400000),
  ('case.completed_at','innovian_cases','Procedure completed','Case completion/discharge date and time.','Case','datetime','scalar',ARRAY['filter','result'],ARRAY['between','before','after','is_empty','is_not_empty'],'{"resolver":"case_column","column":"completed_at"}',true,20,1727366400000,1727366400000),
  ('patient.hn','innovian_cases','HN','Hospital number.','Patient','text','scalar',ARRAY['filter','result','group'],ARRAY['equals','contains','starts_with'],'{"resolver":"context_column","column":"hn"}',true,30,1727366400000,1727366400000),
  ('patient.name','innovian_cases','Patient name','Patient display name from the archive context.','Patient','text','scalar',ARRAY['filter','result'],ARRAY['equals','contains','starts_with'],'{"resolver":"context_column","column":"patient_name"}',true,40,1727366400000,1727366400000),
  ('patient.asa_status','innovian_cases','ASA status','Recorded ASA physical status.','Patient','category','scalar',ARRAY['filter','result','group'],ARRAY['equals','in','is_empty','is_not_empty'],'{"resolver":"context_column","column":"asa_status"}',true,50,1727366400000,1727366400000),
  ('case.type','innovian_cases','Case type / service','Recorded Innovian case type or service.','Case','category','scalar',ARRAY['filter','result','group'],ARRAY['equals','in','contains','is_empty'],'{"resolver":"context_column","column":"case_type"}',true,60,1727366400000,1727366400000),
  ('case.procedure','innovian_cases','Procedure','Procedure name.','Case','text','scalar',ARRAY['filter','result','group'],ARRAY['equals','contains','starts_with'],'{"resolver":"context_column","column":"procedure_name"}',true,70,1727366400000,1727366400000),
  ('case.location','innovian_cases','Location','Recorded care location.','Case','category','scalar',ARRAY['filter','result','group'],ARRAY['equals','in','contains'],'{"resolver":"context_column","column":"location"}',true,80,1727366400000,1727366400000),
  ('staff.name','innovian_cases','Staff name','Any staff member assigned to the case.','Staff','category','multi',ARRAY['filter','result','group'],ARRAY['equals','in','contains'],'{"resolver":"staff_assignment","column":"display_name"}',true,90,1727366400000,1727366400000),
  ('staff.role','innovian_cases','Staff role','Any staff role assigned to the case.','Staff','category','multi',ARRAY['filter','result','group'],ARRAY['equals','in'],'{"resolver":"staff_assignment","column":"role"}',true,100,1727366400000,1727366400000),
  ('anesthesia.technique','innovian_cases','Anaesthesia technique','Documented Balance, TIVA, inhalational, MAC, IVA, GA or combined technique.','Anaesthesia','category','multi',ARRAY['filter','result','group'],ARRAY['equals','in','contains_any','contains_all','is_empty'],'{"resolver":"archive_form_components","component_ids":[4490,4897,4896,2657,790]}',true,110,1727366400000,1727366400000),
  ('anesthesia.regional','innovian_cases','Regional anaesthesia','Regional location, needle size and block type.','Anaesthesia','category','multi',ARRAY['filter','result','group'],ARRAY['equals','in','contains_any','is_empty'],'{"resolver":"archive_form_components","component_ids":[898,899,900]}',true,120,1727366400000,1727366400000),
  ('anesthesia.general','innovian_cases','General anaesthesia details','Documented general-anaesthesia and airway details.','Anaesthesia','category','multi',ARRAY['filter','result','group'],ARRAY['equals','in','contains_any','is_empty'],'{"resolver":"archive_form_components","component_ids":[790,873,5060,871,4491,868,4486,4487,4489,4391,4364]}',true,130,1727366400000,1727366400000),
  ('anesthesia.nerve_block','innovian_cases','Nerve block','Documented nerve-block procedures and types.','Anaesthesia','category','multi',ARRAY['filter','result','group'],ARRAY['equals','in','contains_any','is_empty'],'{"resolver":"archive_form_components","component_ids":[4816,4091,4092,900,4093]}',true,140,1727366400000,1727366400000),
  ('airway.intubation_technique','innovian_cases','Intubation technique','Documented airway and intubation technique values.','Airway','category','multi',ARRAY['filter','result','group'],ARRAY['equals','in','contains_any','is_empty'],'{"resolver":"archive_form_components","component_ids":[5060,5055,4491,868,4487,4489,873,871]}',true,150,1727366400000,1727366400000),
  ('equipment.general_item','innovian_cases','General item / equipment','Documented general equipment values.','Equipment','category','multi',ARRAY['filter','result','group'],ARRAY['equals','in','contains_any','is_empty'],'{"resolver":"archive_form_components","component_ids":[2699]}',true,160,1727366400000,1727366400000),
  ('anesthesia.special_technique','innovian_cases','Special technique','Documented special anaesthetic technique.','Anaesthesia','category','multi',ARRAY['filter','result','group'],ARRAY['equals','in','contains_any','is_empty'],'{"resolver":"archive_form_components","component_ids":[1406]}',true,170,1727366400000,1727366400000),
  ('recovery.pacu','innovian_cases','PACU documentation','Whether PACU or PACU Ambulatory documentation exists.','Recovery','category','multi',ARRAY['filter','result','group'],ARRAY['equals','in','is_empty'],'{"resolver":"form_presence","form_names":["PACU","PACU (Ambulatory)"]}',true,180,1727366400000,1727366400000),
  ('case.duration_minutes','innovian_cases','Case duration (minutes)','Minutes between case start and completion.','Case','duration','scalar',ARRAY['filter','result','measure'],ARRAY['equals','greater_than','less_than','between'],'{"resolver":"derived","formula":"case_duration_minutes"}',true,190,1727366400000,1727366400000),
  ('report.document_status','case_report_documents','PDF report status','Expected/generated status for ANES, FORM, POST and PACU documents.','Reports','category','scalar',ARRAY['filter','result','group'],ARRAY['equals','in'],'{"resolver":"case_report_status"}',true,200,1727366400000,1727366400000)
ON CONFLICT (id) DO UPDATE SET dataset_id=excluded.dataset_id,label=excluded.label,
  description=excluded.description,section=excluded.section,data_type=excluded.data_type,
  cardinality=excluded.cardinality,allowed_uses=excluded.allowed_uses,operators=excluded.operators,
  source_config=excluded.source_config,is_active=excluded.is_active,sort_order=excluded.sort_order,
  updated_at=excluded.updated_at;

INSERT INTO canopy_report_field_option (field_id,value_code,display_label,aliases,is_active,sort_order)
VALUES
  ('anesthesia.technique','general_anesthesia','General anaesthesia','["General anesthesia","GA"]',true,10),
  ('anesthesia.technique','balance','Balance','["Balance"]',true,20),
  ('anesthesia.technique','tiva','TIVA','["TIVA"]',true,30),
  ('anesthesia.technique','iva','IVA','["IVA"]',true,40),
  ('anesthesia.technique','inhalational','Inhalational','["Inhale","Inhalational"]',true,50),
  ('anesthesia.technique','mac','MAC','["MAC"]',true,60),
  ('anesthesia.technique','combined_ga_ra','Combined GA and RA','["Combined GA and RA"]',true,70)
ON CONFLICT (field_id,value_code) DO UPDATE SET display_label=excluded.display_label,
  aliases=excluded.aliases,is_active=excluded.is_active,sort_order=excluded.sort_order;

GRANT SELECT ON canopy_report_dataset,canopy_report_field,canopy_report_field_option TO flora_view,flora_sync;
GRANT INSERT,UPDATE,DELETE ON canopy_report_dataset,canopy_report_field,canopy_report_field_option TO flora_view;
