-- Report Studio: more case-level fields for the drag-and-drop report builder.
-- Definitions built in the studio are stored in canopy_report_definition with
-- definition.engine='studio'; they reference these field ids and never carry SQL.

INSERT INTO canopy_report_field
  (id,dataset_id,label,description,section,data_type,cardinality,allowed_uses,operators,source_config,is_active,sort_order,created_at,updated_at)
VALUES
  ('patient.gender','innovian_cases','Gender','Recorded patient gender.','Patient','category','scalar',ARRAY['filter','result','group'],ARRAY['equals','in','is_empty','is_not_empty'],'{"resolver":"context_column","column":"gender"}',true,42,1759795200000,1759795200000),
  ('patient.age_years','innovian_cases','Age (years)','Age in completed years on the procedure date.','Patient','number','scalar',ARRAY['filter','result','group','measure'],ARRAY['equals','greater_than','less_than','between','is_empty'],'{"resolver":"derived","formula":"age_years"}',true,44,1759795200000,1759795200000),
  ('case.encounter_number','innovian_cases','Encounter number','Hospital encounter / visit number.','Case','text','scalar',ARRAY['filter','result'],ARRAY['equals','contains','starts_with'],'{"resolver":"context_column","column":"encounter_number"}',true,25,1759795200000,1759795200000),
  ('case.care_unit','innovian_cases','Care unit','Recorded care unit.','Case','category','scalar',ARRAY['filter','result','group'],ARRAY['equals','in','contains','is_empty'],'{"resolver":"context_column","column":"care_unit"}',true,75,1759795200000,1759795200000),
  ('case.procedure_code','innovian_cases','Procedure code','Procedure code.','Case','text','scalar',ARRAY['filter','result','group'],ARRAY['equals','in','starts_with'],'{"resolver":"context_column","column":"procedure_code"}',true,72,1759795200000,1759795200000),
  ('case.diagnosis','innovian_cases','Diagnosis','Diagnosis name.','Case','text','scalar',ARRAY['filter','result','group'],ARRAY['equals','contains','starts_with','is_empty'],'{"resolver":"context_column","column":"diagnosis_name"}',true,74,1759795200000,1759795200000),
  ('staff.count','innovian_cases','Staff count','Number of staff assigned to the case.','Staff','number','scalar',ARRAY['filter','result','group','measure'],ARRAY['equals','greater_than','less_than','between'],'{"resolver":"derived","formula":"staff_count"}',true,105,1759795200000,1759795200000),
  ('report.pdf_status','innovian_cases','PDF report status','Whether the expected ANES, FORM, POST and PACU documents were all found.','Reports','category','scalar',ARRAY['filter','result','group'],ARRAY['equals','in'],'{"resolver":"case_report_status"}',true,200,1759795200000,1759795200000)
ON CONFLICT (id) DO UPDATE SET dataset_id=excluded.dataset_id,label=excluded.label,
  description=excluded.description,section=excluded.section,data_type=excluded.data_type,
  cardinality=excluded.cardinality,allowed_uses=excluded.allowed_uses,operators=excluded.operators,
  source_config=excluded.source_config,is_active=excluded.is_active,sort_order=excluded.sort_order,
  updated_at=excluded.updated_at;

-- Case duration can also be grouped (e.g. exact minutes) and filtered for blanks.
UPDATE canopy_report_field
   SET allowed_uses=ARRAY['filter','result','group','measure'],
       operators=ARRAY['equals','greater_than','less_than','between','is_empty','is_not_empty']
 WHERE id='case.duration_minutes';

CREATE INDEX IF NOT EXISTS canopy_report_definition_custom_idx
  ON canopy_report_definition (is_system, is_active, updated_at DESC);

-- Authoring in Form Studio, Report Studio and Workflow Studio.
INSERT INTO auth_permission(code,display_name,category,risk_level,created_at,updated_at) VALUES
 ('studio.manage','Create and update forms, reports and workflows in the studios','Configuration','high',1759795200000,1759795200000)
ON CONFLICT(code) DO UPDATE SET display_name=excluded.display_name,category=excluded.category,
  risk_level=excluded.risk_level,updated_at=excluded.updated_at;

INSERT INTO auth_role_permission(role_code,permission_code,created_at)
SELECT code,'studio.manage',1759795200000 FROM auth_role WHERE code IN ('system_admin','clinical_admin')
ON CONFLICT DO NOTHING;
