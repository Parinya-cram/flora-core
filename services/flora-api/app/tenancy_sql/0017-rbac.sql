BEGIN;

ALTER TABLE auth_user
  ADD COLUMN IF NOT EXISTS must_change_password bigint NOT NULL DEFAULT 0
    CHECK (must_change_password IN (0,1));

CREATE TABLE IF NOT EXISTS auth_role (
  code text PRIMARY KEY,
  display_name text NOT NULL,
  description text,
  is_system bigint NOT NULL DEFAULT 1 CHECK (is_system IN (0,1)),
  is_active bigint NOT NULL DEFAULT 1 CHECK (is_active IN (0,1)),
  sort_order bigint NOT NULL DEFAULT 0,
  created_at bigint NOT NULL,
  updated_at bigint NOT NULL
);

CREATE TABLE IF NOT EXISTS auth_permission (
  code text PRIMARY KEY,
  display_name text NOT NULL,
  category text NOT NULL,
  risk_level text NOT NULL DEFAULT 'normal'
    CHECK (risk_level IN ('normal','sensitive','high')),
  created_at bigint NOT NULL,
  updated_at bigint NOT NULL
);

CREATE TABLE IF NOT EXISTS auth_role_permission (
  role_code text NOT NULL REFERENCES auth_role(code) ON DELETE CASCADE,
  permission_code text NOT NULL REFERENCES auth_permission(code) ON DELETE CASCADE,
  created_at bigint NOT NULL,
  PRIMARY KEY (role_code, permission_code)
);

CREATE TABLE IF NOT EXISTS auth_user_role (
  user_id bigint NOT NULL REFERENCES auth_user(id) ON DELETE CASCADE,
  role_code text NOT NULL REFERENCES auth_role(code),
  scope_type text NOT NULL DEFAULT 'global'
    CHECK (scope_type IN ('global','hospital','care_unit','leaf')),
  scope_id text NOT NULL DEFAULT '*',
  created_at bigint NOT NULL,
  updated_at bigint NOT NULL,
  PRIMARY KEY (user_id, role_code, scope_type, scope_id)
);

INSERT INTO auth_role(code,display_name,description,is_system,is_active,sort_order,created_at,updated_at) VALUES
 ('system_admin','System administrator','Accounts, configuration, clinical workflow, reports and audit.',1,1,10,extract(epoch from clock_timestamp())*1000,extract(epoch from clock_timestamp())*1000),
 ('clinical_admin','Clinical administrator','Clinical workflow plus clinical and operational master data.',1,1,20,extract(epoch from clock_timestamp())*1000,extract(epoch from clock_timestamp())*1000),
 ('clinician','Clinician','Create and chart perioperative cases.',1,1,30,extract(epoch from clock_timestamp())*1000,extract(epoch from clock_timestamp())*1000),
 ('viewer','Viewer / auditor','Read cases and generate reports without changing clinical data.',1,1,40,extract(epoch from clock_timestamp())*1000,extract(epoch from clock_timestamp())*1000),
 ('integration','Integration service','Non-interactive device and system integration.',1,1,50,extract(epoch from clock_timestamp())*1000,extract(epoch from clock_timestamp())*1000)
ON CONFLICT(code) DO UPDATE SET display_name=excluded.display_name,description=excluded.description,
  is_active=excluded.is_active,sort_order=excluded.sort_order,updated_at=excluded.updated_at;

INSERT INTO auth_permission(code,display_name,category,risk_level,created_at,updated_at) VALUES
 ('account.manage','Manage users and access','Account','high',extract(epoch from clock_timestamp())*1000,extract(epoch from clock_timestamp())*1000),
 ('config.manage','Manage system configuration','Configuration','high',extract(epoch from clock_timestamp())*1000,extract(epoch from clock_timestamp())*1000),
 ('clinical_master.manage','Manage clinical master data','Configuration','high',extract(epoch from clock_timestamp())*1000,extract(epoch from clock_timestamp())*1000),
 ('staff.manage','Manage staff directory','Configuration','sensitive',extract(epoch from clock_timestamp())*1000,extract(epoch from clock_timestamp())*1000),
 ('case.read','View clinical cases','Case','sensitive',extract(epoch from clock_timestamp())*1000,extract(epoch from clock_timestamp())*1000),
 ('case.create','Admit and start cases','Case','high',extract(epoch from clock_timestamp())*1000,extract(epoch from clock_timestamp())*1000),
 ('case.chart','Record and amend clinical data','Case','high',extract(epoch from clock_timestamp())*1000,extract(epoch from clock_timestamp())*1000),
 ('case.discharge','Discharge and archive cases','Case','high',extract(epoch from clock_timestamp())*1000,extract(epoch from clock_timestamp())*1000),
 ('report.generate','Generate and export reports','Report','sensitive',extract(epoch from clock_timestamp())*1000,extract(epoch from clock_timestamp())*1000),
 ('audit.read','View audit history','Audit','sensitive',extract(epoch from clock_timestamp())*1000,extract(epoch from clock_timestamp())*1000),
 ('integration.ingest','Ingest device and integration data','Integration','high',extract(epoch from clock_timestamp())*1000,extract(epoch from clock_timestamp())*1000)
ON CONFLICT(code) DO UPDATE SET display_name=excluded.display_name,category=excluded.category,
  risk_level=excluded.risk_level,updated_at=excluded.updated_at;

INSERT INTO auth_role_permission(role_code,permission_code,created_at)
SELECT 'system_admin',code,extract(epoch from clock_timestamp())*1000 FROM auth_permission
ON CONFLICT DO NOTHING;

INSERT INTO auth_role_permission(role_code,permission_code,created_at) VALUES
 ('clinical_admin','config.manage',extract(epoch from clock_timestamp())*1000),
 ('clinical_admin','clinical_master.manage',extract(epoch from clock_timestamp())*1000),
 ('clinical_admin','staff.manage',extract(epoch from clock_timestamp())*1000),
 ('clinical_admin','case.read',extract(epoch from clock_timestamp())*1000),
 ('clinical_admin','case.create',extract(epoch from clock_timestamp())*1000),
 ('clinical_admin','case.chart',extract(epoch from clock_timestamp())*1000),
 ('clinical_admin','case.discharge',extract(epoch from clock_timestamp())*1000),
 ('clinical_admin','report.generate',extract(epoch from clock_timestamp())*1000),
 ('clinical_admin','audit.read',extract(epoch from clock_timestamp())*1000),
 ('clinician','case.read',extract(epoch from clock_timestamp())*1000),
 ('clinician','case.create',extract(epoch from clock_timestamp())*1000),
 ('clinician','case.chart',extract(epoch from clock_timestamp())*1000),
 ('clinician','case.discharge',extract(epoch from clock_timestamp())*1000),
 ('clinician','report.generate',extract(epoch from clock_timestamp())*1000),
 ('viewer','case.read',extract(epoch from clock_timestamp())*1000),
 ('viewer','report.generate',extract(epoch from clock_timestamp())*1000),
 ('integration','case.read',extract(epoch from clock_timestamp())*1000),
 ('integration','integration.ingest',extract(epoch from clock_timestamp())*1000)
ON CONFLICT DO NOTHING;

INSERT INTO auth_user_role(user_id,role_code,scope_type,scope_id,created_at,updated_at)
SELECT id,
  CASE lower(coalesce(role,''))
    WHEN 'admin' THEN 'system_admin'
    WHEN 'system_admin' THEN 'system_admin'
    WHEN 'clinical_admin' THEN 'clinical_admin'
    WHEN 'viewer' THEN 'viewer'
    WHEN 'auditor' THEN 'viewer'
    WHEN 'integration' THEN 'integration'
    ELSE 'clinician'
  END,
  'global','*',extract(epoch from clock_timestamp())*1000,extract(epoch from clock_timestamp())*1000
FROM auth_user
ON CONFLICT DO NOTHING;

CREATE INDEX IF NOT EXISTS auth_user_role_user_idx ON auth_user_role(user_id);
CREATE INDEX IF NOT EXISTS auth_role_permission_permission_idx ON auth_role_permission(permission_code);

GRANT SELECT,INSERT,UPDATE ON auth_role,auth_permission,auth_role_permission,auth_user_role TO flora_app;
GRANT DELETE ON auth_user_role TO flora_app;
GRANT SELECT,INSERT,UPDATE ON auth_user TO flora_app;

COMMIT;
