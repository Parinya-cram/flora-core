BEGIN;

CREATE TABLE IF NOT EXISTS clinical_concept (
  id bigserial PRIMARY KEY,
  domain text NOT NULL CHECK (domain IN ('observation','fluid','blood_product','medication','output','diagnosis','procedure')),
  local_id text NOT NULL,
  local_name text NOT NULL,
  is_active bigint NOT NULL DEFAULT 1 CHECK (is_active IN (0,1)),
  created_at bigint NOT NULL,
  updated_at bigint NOT NULL,
  UNIQUE(domain,local_id)
);

CREATE TABLE IF NOT EXISTS clinical_concept_coding (
  id bigserial PRIMARY KEY,
  concept_id bigint NOT NULL REFERENCES clinical_concept(id) ON DELETE CASCADE,
  system_key text NOT NULL CHECK (system_key IN ('SNOMED_CT','ICD_10','ICD_9_CM','LOINC','RXNORM','ATC','UCUM')),
  system_uri text NOT NULL,
  code text NOT NULL,
  display text,
  version text,
  is_preferred bigint NOT NULL DEFAULT 1 CHECK (is_preferred IN (0,1)),
  created_at bigint NOT NULL,
  updated_at bigint NOT NULL,
  UNIQUE(concept_id,system_key,code)
);

CREATE INDEX IF NOT EXISTS clinical_concept_domain_name ON clinical_concept(domain,is_active,local_name);
CREATE INDEX IF NOT EXISTS clinical_concept_coding_lookup ON clinical_concept_coding(system_key,code);

CREATE TABLE IF NOT EXISTS clinical_parameter_master (
  id bigserial PRIMARY KEY,
  param_key text NOT NULL UNIQUE,
  concept_id bigint REFERENCES clinical_concept(id),
  display_name text NOT NULL,
  value_type text NOT NULL DEFAULT 'number' CHECK (value_type IN ('number','text','code')),
  unit text,
  is_active bigint NOT NULL DEFAULT 1 CHECK (is_active IN (0,1)),
  created_at bigint NOT NULL,
  updated_at bigint NOT NULL
);

ALTER TABLE io_item_master ADD COLUMN IF NOT EXISTS concept_id bigint REFERENCES clinical_concept(id);
ALTER TABLE case_diagnosis ADD COLUMN IF NOT EXISTS concept_id bigint REFERENCES clinical_concept(id);
ALTER TABLE case_diagnosis ADD COLUMN IF NOT EXISTS coding_snapshot jsonb;
ALTER TABLE case_procedure ADD COLUMN IF NOT EXISTS concept_id bigint REFERENCES clinical_concept(id);
ALTER TABLE case_procedure ADD COLUMN IF NOT EXISTS coding_snapshot jsonb;

CREATE INDEX IF NOT EXISTS io_item_master_concept ON io_item_master(concept_id);
CREATE INDEX IF NOT EXISTS case_diagnosis_concept ON case_diagnosis(concept_id);
CREATE INDEX IF NOT EXISTS case_procedure_concept ON case_procedure(concept_id);

-- Existing local catalog names remain authoritative. Standard mappings are optional links.
INSERT INTO clinical_concept(domain,local_id,local_name,is_active,created_at,updated_at)
SELECT CASE kind WHEN 'med' THEN 'medication' ELSE kind END,code,name,is_active,
       coalesce(created_at,(extract(epoch from clock_timestamp())*1000)::bigint),
       coalesce(updated_at,(extract(epoch from clock_timestamp())*1000)::bigint)
FROM io_item_master
WHERE nullif(code,'') IS NOT NULL AND nullif(name,'') IS NOT NULL
ON CONFLICT(domain,local_id) DO UPDATE SET local_name=excluded.local_name;

UPDATE io_item_master item SET concept_id=concept.id
FROM clinical_concept concept
WHERE concept.domain=CASE item.kind WHEN 'med' THEN 'medication' ELSE item.kind END
  AND concept.local_id=item.code AND item.concept_id IS NULL;

WITH source(domain,local_id,local_name,system_key,code,display_name) AS (
  SELECT 'diagnosis',
         'legacy-'||substr(md5(coalesce(diagnosis_text,'')||'|'||coalesce(icd_code,'')),1,16),
         coalesce(nullif(diagnosis_text,''),nullif(icd_text,''),'Unspecified diagnosis'),
         'ICD_10',nullif(icd_code,''),icd_text
  FROM case_diagnosis
  UNION
  SELECT 'procedure',
         'legacy-'||substr(md5(coalesce(procedure_text,'')||'|'||coalesce(icd_code,'')),1,16),
         coalesce(nullif(procedure_text,''),nullif(icd_text,''),'Unspecified procedure'),
         CASE WHEN upper(coalesce(icd_version,''))='ICD-10' THEN 'ICD_10' ELSE 'ICD_9_CM' END,
         nullif(icd_code,''),icd_text
  FROM case_procedure
), inserted AS (
  INSERT INTO clinical_concept(domain,local_id,local_name,is_active,created_at,updated_at)
  SELECT domain,local_id,local_name,1,(extract(epoch from clock_timestamp())*1000)::bigint,(extract(epoch from clock_timestamp())*1000)::bigint
  FROM source
  ON CONFLICT(domain,local_id) DO UPDATE SET local_name=excluded.local_name
  RETURNING id,domain,local_id
)
INSERT INTO clinical_concept_coding(concept_id,system_key,system_uri,code,display,is_preferred,created_at,updated_at)
SELECT DISTINCT ON (concept.id,source.system_key,source.code) concept.id,source.system_key,
       CASE source.system_key WHEN 'ICD_10' THEN 'http://hl7.org/fhir/sid/icd-10' ELSE 'http://hl7.org/fhir/sid/icd-9-cm' END,
       source.code,source.display_name,1,(extract(epoch from clock_timestamp())*1000)::bigint,(extract(epoch from clock_timestamp())*1000)::bigint
FROM source JOIN inserted concept USING(domain,local_id)
WHERE source.code IS NOT NULL
ORDER BY concept.id,source.system_key,source.code,source.display_name NULLS LAST
ON CONFLICT(concept_id,system_key,code) DO UPDATE SET display=excluded.display;

UPDATE case_diagnosis entry SET concept_id=concept.id,
  coding_snapshot=jsonb_strip_nulls(jsonb_build_object('local_id',concept.local_id,'local_name',entry.diagnosis_text,'icd10_id',entry.icd_code,'icd10_name',entry.icd_text))
FROM clinical_concept concept
WHERE concept.domain='diagnosis'
  AND concept.local_id='legacy-'||substr(md5(coalesce(entry.diagnosis_text,'')||'|'||coalesce(entry.icd_code,'')),1,16)
  AND entry.concept_id IS NULL;

UPDATE case_procedure entry SET concept_id=concept.id,
  coding_snapshot=jsonb_strip_nulls(jsonb_build_object('local_id',concept.local_id,'local_name',entry.procedure_text,
    CASE WHEN upper(coalesce(entry.icd_version,''))='ICD-10' THEN 'icd10_id' ELSE 'icd9cm_id' END,entry.icd_code,'standard_name',entry.icd_text))
FROM clinical_concept concept
WHERE concept.domain='procedure'
  AND concept.local_id='legacy-'||substr(md5(coalesce(entry.procedure_text,'')||'|'||coalesce(entry.icd_code,'')),1,16)
  AND entry.concept_id IS NULL;

WITH seed(param_key,display_name,unit,domain) AS (VALUES
  ('hr','Heart rate','/min','observation'),('pr','Pulse rate','/min','observation'),('spo2','Peripheral oxygen saturation','%','observation'),
  ('nibp_sys','Non-invasive systolic blood pressure','mm[Hg]','observation'),('nibp_map','Non-invasive mean blood pressure','mm[Hg]','observation'),('nibp_dia','Non-invasive diastolic blood pressure','mm[Hg]','observation'),
  ('art_sys','Arterial systolic blood pressure','mm[Hg]','observation'),('art_map','Arterial mean blood pressure','mm[Hg]','observation'),('art_dia','Arterial diastolic blood pressure','mm[Hg]','observation'),
  ('cvp','Central venous pressure','mm[Hg]','observation'),('temperature','Body temperature','Cel','observation'),('rr','Respiratory rate','/min','observation'),
  ('et_co2','End-tidal carbon dioxide','mm[Hg]','observation'),('fi_co2','Inspired carbon dioxide','mm[Hg]','observation'),
  ('fio2','Inspired oxygen fraction','%','observation'),('fio2_meas','Inspired oxygen fraction sensor','%','observation'),('et_o2','End-tidal oxygen fraction','%','observation'),
  ('tidal_volume_exp','Expiratory tidal volume','mL','observation'),('minute_volume_exp','Expiratory minute volume','L/min','observation'),
  ('airway_pressure_peak','Peak airway pressure','cm[H2O]','observation'),('airway_pressure_plateau','Plateau airway pressure','cm[H2O]','observation'),
  ('airway_pressure_mean','Mean airway pressure','cm[H2O]','observation'),('airway_pressure_min','Minimum airway pressure','cm[H2O]','observation'),
  ('peep_total','Total positive end-expiratory pressure','cm[H2O]','observation'),('compliance','Respiratory compliance','mL/cm[H2O]','observation'),
  ('set_vent_mode','Ventilator mode',NULL,'observation'),('set_tidal_volume','Set tidal volume','mL','observation'),
  ('set_insp_pressure','Set inspiratory pressure','cm[H2O]','observation'),('set_rr','Set respiratory rate','/min','observation'),
  ('set_ie_ratio','Set inspiratory expiratory ratio',NULL,'observation'),('set_t_insp','Set inspiratory time','s','observation'),
  ('set_insp_pause_pct','Set inspiratory pause','%','observation'),('set_peep','Set positive end-expiratory pressure','cm[H2O]','observation'),
  ('set_peak_limit','Set peak pressure limit','cm[H2O]','observation'),('set_psupp','Set pressure support','cm[H2O]','observation'),
  ('set_flow_trigger','Set flow trigger','L/min','observation'),('set_end_flow','Set end flow','%','observation'),
  ('set_fio2','Set inspired oxygen fraction','%','observation'),('set_fgf_total','Set total fresh gas flow','L/min','observation'),
  ('flow_o2','Oxygen flow','L/min','observation'),('flow_n2o','Nitrous oxide flow','L/min','observation'),('flow_air','Air flow','L/min','observation'),
  ('fi_n2o','Inspired nitrous oxide fraction','%','observation'),('et_n2o','End-tidal nitrous oxide fraction','%','observation'),
  ('fi_agent','Inspired anesthetic agent concentration','%','observation'),('et_agent','End-tidal anesthetic agent concentration','%','observation'),
  ('mac','Minimum alveolar concentration','1','observation')
), concepts AS (
  INSERT INTO clinical_concept(domain,local_id,local_name,is_active,created_at,updated_at)
  SELECT domain,param_key,display_name,1,(extract(epoch from clock_timestamp())*1000)::bigint,(extract(epoch from clock_timestamp())*1000)::bigint FROM seed
  ON CONFLICT(domain,local_id) DO UPDATE SET local_name=excluded.local_name
  RETURNING id,domain,local_id
)
INSERT INTO clinical_parameter_master(param_key,concept_id,display_name,unit,is_active,created_at,updated_at)
SELECT seed.param_key,concept.id,seed.display_name,seed.unit,1,(extract(epoch from clock_timestamp())*1000)::bigint,(extract(epoch from clock_timestamp())*1000)::bigint
FROM seed JOIN concepts concept ON concept.domain=seed.domain AND concept.local_id=seed.param_key
ON CONFLICT(param_key) DO UPDATE SET concept_id=excluded.concept_id,display_name=excluded.display_name,unit=excluded.unit;

GRANT SELECT,INSERT,UPDATE,DELETE ON clinical_concept,clinical_concept_coding,clinical_parameter_master TO flora_app;
GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA public TO flora_app;

COMMIT;
