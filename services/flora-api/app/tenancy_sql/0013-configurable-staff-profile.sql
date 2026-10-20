BEGIN;

CREATE TABLE IF NOT EXISTS staff_field_master (
  id bigserial PRIMARY KEY,
  field_key text NOT NULL UNIQUE,
  label text NOT NULL,
  field_type text NOT NULL DEFAULT 'text'
    CHECK (field_type IN ('text','email','number','date','select')),
  language_code text,
  name_part text
    CHECK (name_part IS NULL OR name_part IN ('prefix','given','middle','family','suffix')),
  core_mapping text
    CHECK (core_mapping IS NULL OR core_mapping IN
      ('hospital_id','staff_name','email','personal_id','entry_year','innovian_id')),
  options_json jsonb NOT NULL DEFAULT '[]'::jsonb,
  is_required bigint NOT NULL DEFAULT 0 CHECK (is_required IN (0,1)),
  is_active bigint NOT NULL DEFAULT 1 CHECK (is_active IN (0,1)),
  sort_order bigint NOT NULL DEFAULT 100,
  created_at bigint,
  updated_at bigint
);

ALTER TABLE staff_directory
  ADD COLUMN IF NOT EXISTS profile_data jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE case_staff
  ADD COLUMN IF NOT EXISTS profile_data jsonb NOT NULL DEFAULT '{}'::jsonb;

INSERT INTO staff_field_master
  (field_key,label,field_type,language_code,name_part,core_mapping,is_required,is_active,sort_order)
VALUES
  ('hospital_id','Hospital ID','text',NULL,NULL,'hospital_id',0,1,10),
  ('display_name','Display name','text',NULL,NULL,'staff_name',1,1,20),
  ('given_name','Given name','text',NULL,'given',NULL,0,1,30),
  ('middle_name','Middle name','text',NULL,'middle',NULL,0,1,40),
  ('family_name','Family name','text',NULL,'family',NULL,0,1,50),
  ('email','Email','email',NULL,NULL,'email',0,1,60),
  ('personal_id','Personal ID','text',NULL,NULL,'personal_id',0,1,70),
  ('entry_year','Entry year','number',NULL,NULL,'entry_year',0,1,80),
  ('name_th_given','Thai given name','text','th','given',NULL,0,0,110),
  ('name_th_family','Thai family name','text','th','family',NULL,0,0,120),
  ('name_en_given','English given name','text','en','given',NULL,0,0,130),
  ('name_en_family','English family name','text','en','family',NULL,0,0,140)
ON CONFLICT (field_key) DO NOTHING;

UPDATE staff_directory SET profile_data = jsonb_strip_nulls(profile_data || jsonb_build_object(
  'hospital_id', hospital_id,
  'display_name', staff_name,
  'email', email,
  'personal_id', personal_id,
  'entry_year', entry_year,
  'name_th_given', th_first_name,
  'name_th_family', th_last_name,
  'name_en_given', en_first_name,
  'name_en_family', en_last_name
));

UPDATE case_staff SET profile_data = jsonb_strip_nulls(profile_data || jsonb_build_object(
  'hospital_id', hospital_id,
  'display_name', staff_name,
  'email', email,
  'personal_id', personal_id,
  'entry_year', entry_year,
  'name_th_given', th_first_name,
  'name_th_family', th_last_name,
  'name_en_given', en_first_name,
  'name_en_family', en_last_name
));

CREATE INDEX IF NOT EXISTS idx_staff_field_master_active_order
  ON staff_field_master(is_active DESC, sort_order, id);
CREATE INDEX IF NOT EXISTS idx_staff_directory_profile_data
  ON staff_directory USING gin(profile_data);

GRANT SELECT, INSERT, UPDATE, DELETE ON staff_field_master TO flora_app;
GRANT USAGE, SELECT ON SEQUENCE staff_field_master_id_seq TO flora_app;
GRANT SELECT, INSERT, UPDATE ON staff_directory, case_staff TO flora_app;

COMMIT;
