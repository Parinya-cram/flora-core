-- Complete Canopy-owned Innovian archive. These are migration destinations;
-- Canopy reads them directly and never depends on Anora at runtime.

CREATE TABLE IF NOT EXISTS archive_patient_demographics (
  archive_case_id uuid PRIMARY KEY REFERENCES archive_case(id) ON DELETE CASCADE,
  source_record_id uuid NOT NULL,
  national_id text, blood_type text, admission_weight numeric, weight_unit text,
  height numeric, height_unit text, hospital_admitted_at timestamptz,
  date_of_birth date, gender text, asa_status text, nationality text,
  language text, religion text
);

CREATE TABLE IF NOT EXISTS archive_allergy (
  id uuid PRIMARY KEY,
  archive_case_id uuid NOT NULL REFERENCES archive_case(id) ON DELETE CASCADE,
  source_record_id uuid NOT NULL,
  code text, label text, description text, reaction text,
  source_severity integer, source_category integer,
  recorded_at timestamptz, deleted_at timestamptz,
  source_deleted boolean NOT NULL DEFAULT false
);
CREATE INDEX IF NOT EXISTS archive_allergy_case_idx ON archive_allergy(archive_case_id, recorded_at);

CREATE TABLE IF NOT EXISTS archive_note (
  id uuid PRIMARY KEY,
  archive_case_id uuid NOT NULL REFERENCES archive_case(id) ON DELETE CASCADE,
  source_record_id uuid,
  note_type varchar, note_name varchar, code varchar, text text,
  procedure_status varchar, care_unit varchar, raw_timestamp integer,
  occurred_at timestamptz, time_quality varchar NOT NULL DEFAULT 'unmapped',
  source_deleted boolean NOT NULL DEFAULT false
);
CREATE INDEX IF NOT EXISTS archive_note_case_time_idx ON archive_note(archive_case_id, occurred_at);

CREATE TABLE IF NOT EXISTS archive_observation (
  id uuid PRIMARY KEY,
  archive_case_id uuid NOT NULL REFERENCES archive_case(id) ON DELETE CASCADE,
  source_record_id uuid, parameter_code varchar, parameter_label varchar NOT NULL,
  value_number numeric, value_text text, unit varchar, raw_timestamp integer,
  observed_at timestamptz, time_quality varchar NOT NULL DEFAULT 'unmapped',
  validated boolean, quality varchar NOT NULL DEFAULT 'source'
);
CREATE INDEX IF NOT EXISTS archive_observation_case_time_idx ON archive_observation(archive_case_id, observed_at);

CREATE TABLE IF NOT EXISTS archive_device_parameter (
  id uuid PRIMARY KEY,
  archive_case_id uuid NOT NULL REFERENCES archive_case(id) ON DELETE CASCADE,
  source_kind varchar NOT NULL, source_key varchar NOT NULL,
  parameter_label varchar NOT NULL, unit varchar, value_number numeric,
  value_text text, raw_timestamp bigint, observed_at timestamptz,
  time_quality varchar NOT NULL DEFAULT 'exact', source_parameter_id integer
);
CREATE INDEX IF NOT EXISTS archive_device_parameter_case_time_idx ON archive_device_parameter(archive_case_id, observed_at);

CREATE TABLE IF NOT EXISTS archive_fluid_io (
  id uuid PRIMARY KEY,
  archive_case_id uuid NOT NULL REFERENCES archive_case(id) ON DELETE CASCADE,
  source_record_id uuid, source_paraminstance integer, source_cid integer,
  label varchar, unit varchar, value_number numeric, value_text text,
  state smallint, scheduled smallint, raw_timestamp integer,
  occurred_at timestamptz, time_quality varchar NOT NULL DEFAULT 'unmapped'
);
CREATE INDEX IF NOT EXISTS archive_fluid_io_case_time_idx ON archive_fluid_io(archive_case_id, occurred_at);

CREATE TABLE IF NOT EXISTS archive_infusion (
  id uuid PRIMARY KEY,
  archive_case_id uuid NOT NULL REFERENCES archive_case(id) ON DELETE CASCADE,
  source_record_id uuid, source_paraminstance integer NOT NULL,
  label varchar, source_type smallint, pump_state smallint,
  raw_pause_timestamp integer, raw_discontinue_timestamp integer,
  concentration_config jsonb NOT NULL DEFAULT '{}'::jsonb,
  UNIQUE(archive_case_id, source_paraminstance)
);

CREATE TABLE IF NOT EXISTS archive_infusion_component (
  id uuid PRIMARY KEY,
  archive_infusion_id uuid NOT NULL REFERENCES archive_infusion(id) ON DELETE CASCADE,
  source_cid integer, component_index integer, label varchar, unit varchar,
  source_type smallint, display_order smallint,
  configuration jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS archive_infusion_component_parent_idx ON archive_infusion_component(archive_infusion_id);

CREATE TABLE IF NOT EXISTS archive_infusion_measurement (
  id uuid PRIMARY KEY,
  archive_infusion_component_id uuid NOT NULL REFERENCES archive_infusion_component(id) ON DELETE CASCADE,
  source_record_id uuid, value_number numeric, value_text text,
  state smallint, scheduled smallint, raw_timestamp integer,
  observed_at timestamptz, time_quality varchar NOT NULL DEFAULT 'unmapped'
);
CREATE INDEX IF NOT EXISTS archive_infusion_measurement_parent_time_idx ON archive_infusion_measurement(archive_infusion_component_id, observed_at);

CREATE TABLE IF NOT EXISTS archive_vital_series_segment (
  id uuid PRIMARY KEY,
  archive_case_id uuid NOT NULL REFERENCES archive_case(id) ON DELETE CASCADE,
  source_record_id uuid, source_segment_key varchar NOT NULL,
  source_parameter_id integer NOT NULL, parameter_code varchar,
  parameter_label varchar NOT NULL, unit varchar, graph_type smallint,
  vital_priority smallint NOT NULL, raw_first_timestamp bigint NOT NULL,
  raw_next_timestamp bigint NOT NULL, raw_interval_units integer NOT NULL,
  sample_interval_ms integer, sample_count integer NOT NULL,
  encoded_samples integer[] NOT NULL, raw_payload bytea NOT NULL,
  encoding varchar NOT NULL, exponent smallint NOT NULL,
  decimal_places smallint NOT NULL, observed_start_at timestamptz,
  observed_end_at timestamptz, time_quality varchar NOT NULL DEFAULT 'unmapped',
  valid_sample_count integer, value_sum numeric, value_min numeric,
  value_max numeric, source_hash varchar NOT NULL,
  imported_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(archive_case_id, source_segment_key)
);
CREATE INDEX IF NOT EXISTS archive_vital_segment_case_parameter_time_idx
  ON archive_vital_series_segment(archive_case_id, parameter_code, observed_start_at);

GRANT SELECT ON archive_patient_demographics, archive_allergy, archive_note,
  archive_observation, archive_device_parameter, archive_fluid_io,
  archive_infusion, archive_infusion_component, archive_infusion_measurement,
  archive_vital_series_segment TO flora_view;

GRANT SELECT, INSERT, UPDATE, DELETE ON archive_patient_demographics,
  archive_allergy, archive_note, archive_observation, archive_device_parameter,
  archive_fluid_io, archive_infusion, archive_infusion_component,
  archive_infusion_measurement, archive_vital_series_segment TO flora_sync;
