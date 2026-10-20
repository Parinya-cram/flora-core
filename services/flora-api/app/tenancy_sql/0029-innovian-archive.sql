-- Canopy-owned, vendor-neutral archive store.  Anora/Minivia may be used as
-- one-time migration sources, but Canopy reads these tables directly at run time.
CREATE TABLE IF NOT EXISTS archive_case (
  id uuid PRIMARY KEY,
  hospital_id uuid,
  source_system text NOT NULL DEFAULT 'innovian',
  source_case_id text NOT NULL,
  representation_version integer NOT NULL DEFAULT 1,
  patient_reference text,
  patient_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  procedure_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  started_at timestamptz,
  completed_at timestamptz,
  migration_status text NOT NULL DEFAULT 'complete',
  mapping_profile text NOT NULL DEFAULT 'innovian-legacy',
  migration_run_id uuid,
  source_record_hash text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (hospital_id, source_system, source_case_id, representation_version)
);

CREATE INDEX IF NOT EXISTS archive_case_started_idx ON archive_case (started_at, id);
CREATE INDEX IF NOT EXISTS archive_case_patient_idx ON archive_case (patient_reference);

CREATE TABLE IF NOT EXISTS archive_case_context (
  archive_case_id uuid PRIMARY KEY REFERENCES archive_case(id) ON DELETE CASCADE,
  source_poid text,
  hn text,
  encounter_number text,
  patient_name text,
  date_of_birth date,
  gender text,
  asa_status text,
  order_number text,
  procedure_code text,
  procedure_name text,
  diagnosis_code text,
  diagnosis_name text,
  case_type text,
  care_unit text,
  location text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS archive_case_context_hn_idx ON archive_case_context (hn);
CREATE INDEX IF NOT EXISTS archive_case_context_type_idx ON archive_case_context (case_type);

CREATE TABLE IF NOT EXISTS archive_staff_assignment (
  id uuid PRIMARY KEY,
  archive_case_id uuid NOT NULL REFERENCES archive_case(id) ON DELETE CASCADE,
  source_record_id uuid,
  source_staff_id integer,
  display_name text,
  role text,
  staff_group text,
  raw_time_in integer,
  raw_time_out integer,
  entered_at timestamptz,
  exited_at timestamptz,
  time_quality text NOT NULL DEFAULT 'unmapped',
  source_deleted boolean NOT NULL DEFAULT false
);

CREATE INDEX IF NOT EXISTS archive_staff_case_time_idx ON archive_staff_assignment (archive_case_id, entered_at);
CREATE INDEX IF NOT EXISTS archive_staff_name_idx ON archive_staff_assignment (display_name);

CREATE TABLE IF NOT EXISTS archive_event (
  id uuid PRIMARY KEY,
  archive_case_id uuid NOT NULL REFERENCES archive_case(id) ON DELETE CASCADE,
  event_definition_id uuid,
  source_record_id uuid,
  source_event_code text,
  source_event_name text NOT NULL,
  source_event_kind text NOT NULL DEFAULT 'event',
  care_unit text,
  source_state text,
  memo text,
  raw_timestamp integer,
  occurred_at timestamptz,
  time_quality text NOT NULL DEFAULT 'unmapped'
);

CREATE INDEX IF NOT EXISTS archive_event_case_time_idx ON archive_event (archive_case_id, occurred_at);
CREATE INDEX IF NOT EXISTS archive_event_name_state_idx ON archive_event (source_event_name, source_state);

CREATE TABLE IF NOT EXISTS archive_form (
  id uuid PRIMARY KEY,
  archive_case_id uuid NOT NULL REFERENCES archive_case(id) ON DELETE CASCADE,
  source_form_id integer NOT NULL,
  source_original_form_id integer NOT NULL,
  source_poid uuid,
  name text NOT NULL,
  layout jsonb NOT NULL DEFAULT '{}'::jsonb,
  source_created_at timestamptz,
  source_updated_at timestamptz,
  imported_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (archive_case_id, source_form_id)
);

CREATE INDEX IF NOT EXISTS archive_form_case_name_idx ON archive_form (archive_case_id, name);

CREATE TABLE IF NOT EXISTS archive_form_field (
  id uuid PRIMARY KEY,
  archive_form_id uuid NOT NULL REFERENCES archive_form(id) ON DELETE CASCADE,
  source_grid_cell_id bigint NOT NULL,
  source_component_id integer NOT NULL,
  component_type smallint NOT NULL,
  name text,
  title text,
  raw_value text,
  value jsonb NOT NULL DEFAULT '{}'::jsonb,
  choices jsonb NOT NULL DEFAULT '[]'::jsonb,
  position jsonb NOT NULL DEFAULT '{}'::jsonb,
  UNIQUE (archive_form_id, source_grid_cell_id)
);

CREATE INDEX IF NOT EXISTS archive_form_field_form_component_idx
  ON archive_form_field (archive_form_id, source_component_id);

-- One row represents one expected case-level document.  file_path points to
-- the ePHIS-visible PDF when it has been generated/saved; no "_merged" suffix.
CREATE TABLE IF NOT EXISTS archive_case_report (
  archive_case_id uuid NOT NULL REFERENCES archive_case(id) ON DELETE CASCADE,
  report_type text NOT NULL CHECK (report_type IN ('ANES', 'FORM', 'POST', 'PACU')),
  expected boolean NOT NULL DEFAULT true,
  evidence text,
  file_path text,
  generated_at timestamptz,
  file_size_bytes bigint,
  checksum_sha256 text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (archive_case_id, report_type)
);

CREATE INDEX IF NOT EXISTS archive_case_report_path_idx ON archive_case_report (file_path);

GRANT SELECT ON archive_case, archive_case_context, archive_staff_assignment,
  archive_event, archive_form, archive_form_field, archive_case_report TO flora_view;

GRANT SELECT, INSERT, UPDATE, DELETE ON archive_case, archive_case_context,
  archive_staff_assignment, archive_event, archive_form, archive_form_field,
  archive_case_report TO flora_sync;
