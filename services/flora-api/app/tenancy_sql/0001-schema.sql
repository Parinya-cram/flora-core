--
-- PostgreSQL database dump
--

\restrict f1gWJueHjY0kYspf5TarZoxBcHW43tfdfU9GM1ArK6S6OvbuZT5bdCYzyG6szV1

-- Dumped from database version 17.6
-- Dumped by pg_dump version 17.6

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET transaction_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: auth_audit; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.auth_audit (
    id bigint NOT NULL,
    action text,
    actor_user_id bigint,
    actor_username text,
    actor_role text,
    target_user_id bigint,
    target_username text,
    status text DEFAULT 'ok'::text,
    detail_json text,
    created_at bigint
);


--
-- Name: auth_audit_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.auth_audit_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: auth_audit_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.auth_audit_id_seq OWNED BY public.auth_audit.id;


--
-- Name: auth_permission; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.auth_permission (
    code text NOT NULL,
    display_name text NOT NULL,
    category text NOT NULL,
    risk_level text DEFAULT 'normal'::text NOT NULL,
    created_at bigint NOT NULL,
    updated_at bigint NOT NULL,
    CONSTRAINT auth_permission_risk_level_check CHECK ((risk_level = ANY (ARRAY['normal'::text, 'sensitive'::text, 'high'::text])))
);


--
-- Name: auth_role; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.auth_role (
    code text NOT NULL,
    display_name text NOT NULL,
    description text,
    is_system bigint DEFAULT 1 NOT NULL,
    is_active bigint DEFAULT 1 NOT NULL,
    sort_order bigint DEFAULT 0 NOT NULL,
    created_at bigint NOT NULL,
    updated_at bigint NOT NULL,
    CONSTRAINT auth_role_is_active_check CHECK ((is_active = ANY (ARRAY[(0)::bigint, (1)::bigint]))),
    CONSTRAINT auth_role_is_system_check CHECK ((is_system = ANY (ARRAY[(0)::bigint, (1)::bigint])))
);


--
-- Name: auth_role_permission; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.auth_role_permission (
    role_code text NOT NULL,
    permission_code text NOT NULL,
    created_at bigint NOT NULL
);


--
-- Name: auth_session; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.auth_session (
    id bigint NOT NULL,
    user_id bigint,
    token_hash text,
    client_label text,
    created_at bigint,
    updated_at bigint,
    last_seen_at bigint,
    expires_at bigint,
    revoked_at bigint
);


--
-- Name: auth_session_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.auth_session_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: auth_session_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.auth_session_id_seq OWNED BY public.auth_session.id;


--
-- Name: auth_user; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.auth_user (
    id bigint NOT NULL,
    username text,
    hospital_id text,
    auth_source text DEFAULT 'local'::text,
    password_salt text,
    password_hash text,
    name text,
    role text,
    theme_mode text,
    theme_color text,
    is_active bigint DEFAULT '1'::bigint,
    created_at bigint,
    updated_at bigint,
    last_login_at bigint,
    language_code text DEFAULT 'en'::text NOT NULL,
    staff_directory_id bigint,
    parameter_preferences jsonb DEFAULT '{}'::jsonb NOT NULL,
    report_preferences jsonb DEFAULT '{}'::jsonb NOT NULL,
    must_change_password bigint DEFAULT 0 NOT NULL,
    CONSTRAINT auth_user_is_active_check CHECK ((is_active = ANY (ARRAY[(0)::bigint, (1)::bigint]))),
    CONSTRAINT auth_user_must_change_password_check CHECK ((must_change_password = ANY (ARRAY[(0)::bigint, (1)::bigint])))
);


--
-- Name: auth_user_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.auth_user_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: auth_user_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.auth_user_id_seq OWNED BY public.auth_user.id;


--
-- Name: auth_user_role; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.auth_user_role (
    user_id bigint NOT NULL,
    role_code text NOT NULL,
    scope_type text DEFAULT 'global'::text NOT NULL,
    scope_id text DEFAULT '*'::text NOT NULL,
    created_at bigint NOT NULL,
    updated_at bigint NOT NULL,
    CONSTRAINT auth_user_role_scope_type_check CHECK ((scope_type = ANY (ARRAY['global'::text, 'hospital'::text, 'care_unit'::text, 'leaf'::text])))
);


--
-- Name: case_allergy; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.case_allergy (
    id bigint NOT NULL,
    case_id bigint,
    allergen text,
    reaction text,
    severity text,
    seq bigint DEFAULT '1'::bigint,
    created_at bigint
);


--
-- Name: case_allergy_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.case_allergy_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: case_allergy_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.case_allergy_id_seq OWNED BY public.case_allergy.id;


--
-- Name: case_clinical_audit; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.case_clinical_audit (
    id bigint NOT NULL,
    case_id bigint NOT NULL,
    action text NOT NULL,
    before_json text,
    after_json text,
    actor_username text NOT NULL,
    actor_role text,
    created_at bigint NOT NULL
);


--
-- Name: case_clinical_audit_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.case_clinical_audit_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: case_clinical_audit_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.case_clinical_audit_id_seq OWNED BY public.case_clinical_audit.id;


--
-- Name: case_detail; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.case_detail (
    id bigint NOT NULL,
    case_id bigint,
    surgeon text,
    or_room text,
    case_type text,
    note text,
    form_draft_json text,
    created_at bigint,
    updated_at bigint,
    CONSTRAINT case_detail_case_type_check CHECK ((case_type = ANY (ARRAY['elective'::text, 'emergency'::text])))
);


--
-- Name: case_detail_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.case_detail_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: case_detail_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.case_detail_id_seq OWNED BY public.case_detail.id;


--
-- Name: case_device_ingest_audit; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.case_device_ingest_audit (
    id bigint NOT NULL,
    case_id bigint,
    hn text,
    source_service text,
    source_endpoint text,
    fetch_mode text,
    minute_ts bigint,
    from_ts bigint,
    to_ts bigint,
    raw_row_count bigint DEFAULT '0'::bigint,
    written_row_count bigint DEFAULT '0'::bigint,
    status text,
    actor_username text,
    actor_role text,
    detail_json text,
    created_at bigint,
    CONSTRAINT case_device_ingest_audit_fetch_mode_check CHECK ((fetch_mode = ANY (ARRAY['minute'::text, 'bulk'::text]))),
    CONSTRAINT case_device_ingest_audit_status_check CHECK ((status = ANY (ARRAY['ok'::text, 'empty'::text, 'failed'::text])))
);


--
-- Name: case_device_ingest_audit_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.case_device_ingest_audit_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: case_device_ingest_audit_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.case_device_ingest_audit_id_seq OWNED BY public.case_device_ingest_audit.id;


--
-- Name: case_diagnosis; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.case_diagnosis (
    id bigint NOT NULL,
    case_id bigint,
    diagnosis_text text,
    icd_text text,
    icd_code text,
    icd_version text,
    seq bigint DEFAULT '1'::bigint,
    created_at bigint,
    concept_id bigint,
    coding_snapshot jsonb,
    event_ts bigint NOT NULL,
    entry_context text NOT NULL
);


--
-- Name: case_diagnosis_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.case_diagnosis_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: case_diagnosis_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.case_diagnosis_id_seq OWNED BY public.case_diagnosis.id;


--
-- Name: case_event_note; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.case_event_note (
    id bigint NOT NULL,
    case_id bigint,
    event_ts bigint,
    event_type text,
    title text,
    detail text,
    created_by text,
    created_at bigint,
    updated_by text,
    updated_at bigint,
    is_deleted bigint DEFAULT '0'::bigint,
    CONSTRAINT case_event_note_event_type_check CHECK ((event_type = ANY (ARRAY['event'::text, 'note'::text]))),
    CONSTRAINT case_event_note_is_deleted_check CHECK ((is_deleted = ANY (ARRAY[(0)::bigint, (1)::bigint])))
);


--
-- Name: case_event_note_audit; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.case_event_note_audit (
    id bigint NOT NULL,
    case_id bigint,
    event_note_id bigint,
    action text,
    old_event_ts bigint,
    old_event_type text,
    old_title text,
    old_detail text,
    new_event_ts bigint,
    new_event_type text,
    new_title text,
    new_detail text,
    reason text,
    actor_username text,
    actor_name text,
    actor_role text,
    created_at bigint,
    CONSTRAINT case_event_note_audit_action_check CHECK ((action = ANY (ARRAY['insert'::text, 'update'::text, 'delete'::text])))
);


--
-- Name: case_event_note_audit_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.case_event_note_audit_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: case_event_note_audit_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.case_event_note_audit_id_seq OWNED BY public.case_event_note_audit.id;


--
-- Name: case_event_note_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.case_event_note_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: case_event_note_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.case_event_note_id_seq OWNED BY public.case_event_note.id;


--
-- Name: case_his_allergy; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.case_his_allergy (
    id bigint NOT NULL,
    case_id bigint,
    allergen text,
    reaction text,
    severity text,
    status text,
    source text,
    raw_payload text,
    his_updated_at bigint,
    created_at bigint,
    updated_at bigint
);


--
-- Name: case_his_allergy_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.case_his_allergy_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: case_his_allergy_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.case_his_allergy_id_seq OWNED BY public.case_his_allergy.id;


--
-- Name: case_his_lab; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.case_his_lab (
    id bigint NOT NULL,
    case_id bigint,
    test_name text,
    test_group text,
    value_text text,
    unit text,
    ref_range text,
    flag text,
    collected_at bigint,
    source text,
    raw_payload text,
    his_updated_at bigint,
    created_at bigint,
    updated_at bigint
);


--
-- Name: case_his_lab_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.case_his_lab_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: case_his_lab_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.case_his_lab_id_seq OWNED BY public.case_his_lab.id;


--
-- Name: case_his_patient; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.case_his_patient (
    id bigint NOT NULL,
    case_id bigint,
    hn text,
    an text,
    is_patient text,
    notype text,
    id_card text,
    patient_name text,
    title_th text,
    title_en text,
    first_name text,
    last_name text,
    first_name_en text,
    last_name_en text,
    sex text,
    dob text,
    age_text text,
    weight_kg real,
    height_cm real,
    blood_group_text text,
    blood_group_abo text,
    blood_group_rh text,
    race text,
    ethnicity text,
    religion text,
    marital_status text,
    present_address text,
    present_province text,
    legal_address text,
    legal_province text,
    mobile text,
    contact_name text,
    contact_tel text,
    relation_desc text,
    nationality text,
    source text,
    raw_payload text,
    his_updated_at bigint,
    created_at bigint,
    updated_at bigint
);


--
-- Name: case_his_patient_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.case_his_patient_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: case_his_patient_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.case_his_patient_id_seq OWNED BY public.case_his_patient.id;


--
-- Name: case_io_audit; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.case_io_audit (
    id bigint NOT NULL,
    case_id bigint,
    entity_type text,
    entity_id bigint,
    action text,
    before_json text,
    after_json text,
    reason text,
    actor_username text,
    actor_name text,
    actor_role text,
    created_at bigint,
    CONSTRAINT case_io_audit_action_check CHECK ((action = ANY (ARRAY['insert'::text, 'update'::text, 'delete'::text]))),
    CONSTRAINT case_io_audit_entity_type_check CHECK ((entity_type = ANY (ARRAY['run'::text, 'segment'::text, 'event'::text])))
);


--
-- Name: case_io_audit_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.case_io_audit_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: case_io_audit_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.case_io_audit_id_seq OWNED BY public.case_io_audit.id;


--
-- Name: case_io_event; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.case_io_event (
    id bigint NOT NULL,
    case_id bigint,
    item_id bigint,
    kind text,
    event_ts bigint,
    volume_ml real,
    dose_value real,
    dose_unit text,
    note text,
    include_in_balance bigint DEFAULT '1'::bigint,
    created_by text,
    created_at bigint,
    updated_at bigint,
    CONSTRAINT case_io_event_include_in_balance_check CHECK ((include_in_balance = ANY (ARRAY[(0)::bigint, (1)::bigint]))),
    CONSTRAINT case_io_event_kind_check CHECK ((kind = ANY (ARRAY['fluid'::text, 'med'::text, 'output'::text])))
);


--
-- Name: case_io_event_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.case_io_event_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: case_io_event_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.case_io_event_id_seq OWNED BY public.case_io_event.id;


--
-- Name: case_io_run; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.case_io_run (
    id bigint NOT NULL,
    case_id bigint,
    item_id bigint,
    kind text,
    route text,
    started_at bigint,
    stopped_at bigint,
    note text,
    include_in_balance bigint DEFAULT '1'::bigint,
    created_by text,
    created_at bigint,
    updated_at bigint,
    entry_mode text,
    CONSTRAINT case_io_run_entry_mode_check CHECK ((entry_mode = ANY (ARRAY['bolus'::text, 'drip'::text]))),
    CONSTRAINT case_io_run_include_in_balance_check CHECK ((include_in_balance = ANY (ARRAY[(0)::bigint, (1)::bigint]))),
    CONSTRAINT case_io_run_kind_check CHECK ((kind = ANY (ARRAY['fluid'::text, 'med'::text, 'output'::text])))
);


--
-- Name: case_io_run_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.case_io_run_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: case_io_run_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.case_io_run_id_seq OWNED BY public.case_io_run.id;


--
-- Name: case_io_segment; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.case_io_segment (
    id bigint NOT NULL,
    run_id bigint,
    ts_from bigint,
    ts_to bigint,
    rate_value real,
    rate_unit text,
    dose_value real,
    dose_unit text,
    carrier_ml_per_hr real,
    include_in_balance bigint DEFAULT '1'::bigint,
    note text,
    created_by text,
    created_at bigint,
    updated_at bigint,
    CONSTRAINT case_io_segment_include_in_balance_check CHECK ((include_in_balance = ANY (ARRAY[(0)::bigint, (1)::bigint])))
);


--
-- Name: case_io_segment_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.case_io_segment_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: case_io_segment_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.case_io_segment_id_seq OWNED BY public.case_io_segment.id;


--
-- Name: case_procedure; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.case_procedure (
    id bigint NOT NULL,
    case_id bigint,
    procedure_text text,
    icd_text text,
    icd_code text,
    icd_version text,
    seq bigint DEFAULT '1'::bigint,
    created_at bigint,
    concept_id bigint,
    coding_snapshot jsonb,
    event_ts bigint NOT NULL,
    entry_context text NOT NULL
);


--
-- Name: case_procedure_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.case_procedure_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: case_procedure_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.case_procedure_id_seq OWNED BY public.case_procedure.id;


--
-- Name: case_staff; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.case_staff (
    id bigint NOT NULL,
    case_id bigint,
    hospital_id text,
    personal_id text,
    email text,
    th_first_name text,
    th_last_name text,
    en_first_name text,
    en_last_name text,
    innovian_id text,
    staff_role_id text,
    entry_year bigint,
    staff_name text,
    staff_role text,
    seq bigint DEFAULT '1'::bigint,
    created_by text,
    created_at bigint,
    updated_at bigint,
    profile_data jsonb DEFAULT '{}'::jsonb NOT NULL
);


--
-- Name: case_staff_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.case_staff_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: case_staff_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.case_staff_id_seq OWNED BY public.case_staff.id;


--
-- Name: case_timeline_audit; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.case_timeline_audit (
    id bigint NOT NULL,
    case_id bigint,
    ts_minute bigint,
    param_key text,
    action text,
    old_value_num real,
    old_value_text text,
    old_value_type text,
    new_value_num real,
    new_value_text text,
    new_value_type text,
    unit text,
    source text,
    note text,
    reason text,
    actor_username text,
    actor_name text,
    actor_role text,
    created_at bigint,
    CONSTRAINT case_timeline_audit_action_check CHECK ((action = ANY (ARRAY['insert'::text, 'update'::text, 'delete'::text])))
);


--
-- Name: case_timeline_audit_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.case_timeline_audit_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: case_timeline_audit_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.case_timeline_audit_id_seq OWNED BY public.case_timeline_audit.id;


--
-- Name: case_timeline_value; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.case_timeline_value (
    id bigint NOT NULL,
    case_id bigint,
    ts_minute bigint,
    param_key text,
    value_type text,
    value_num real,
    value_text text,
    unit text,
    source text,
    note text,
    created_by text,
    updated_by text,
    created_at bigint,
    updated_at bigint,
    CONSTRAINT case_timeline_value_source_check CHECK ((source = ANY (ARRAY['manual'::text, 'override'::text]))),
    CONSTRAINT case_timeline_value_value_type_check CHECK ((value_type = ANY (ARRAY['number'::text, 'text'::text, 'code'::text])))
);


--
-- Name: case_timeline_value_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.case_timeline_value_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: case_timeline_value_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.case_timeline_value_id_seq OWNED BY public.case_timeline_value.id;


--
-- Name: cases; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.cases (
    id bigint NOT NULL,
    case_code text,
    hn text,
    start_time bigint,
    device_capture_start_time bigint,
    discharge_time bigint,
    archive_time bigint,
    status text,
    created_at bigint,
    updated_at bigint,
    admission_source text DEFAULT 'legacy'::text NOT NULL,
    identity_status text DEFAULT 'verified'::text NOT NULL,
    admission_number text,
    patient_display_name text,
    admitted_by text,
    admission_metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    CONSTRAINT cases_admission_source_check CHECK ((admission_source = ANY (ARRAY['legacy'::text, 'prepared'::text, 'his'::text, 'manual'::text, 'emergency'::text]))),
    CONSTRAINT cases_identity_status_check CHECK ((identity_status = ANY (ARRAY['verified'::text, 'local'::text, 'pending'::text, 'reconciled'::text]))),
    CONSTRAINT cases_status_check CHECK ((status = ANY (ARRAY['active'::text, 'discharged'::text, 'archived'::text])))
);


--
-- Name: cases_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.cases_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: cases_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.cases_id_seq OWNED BY public.cases.id;


--
-- Name: clinical_concept; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.clinical_concept (
    id bigint NOT NULL,
    domain text NOT NULL,
    local_id text NOT NULL,
    local_name text NOT NULL,
    is_active bigint DEFAULT 1 NOT NULL,
    created_at bigint NOT NULL,
    updated_at bigint NOT NULL,
    CONSTRAINT clinical_concept_domain_check CHECK ((domain = ANY (ARRAY['observation'::text, 'fluid'::text, 'blood_product'::text, 'medication'::text, 'output'::text, 'diagnosis'::text, 'procedure'::text]))),
    CONSTRAINT clinical_concept_is_active_check CHECK ((is_active = ANY (ARRAY[(0)::bigint, (1)::bigint])))
);


--
-- Name: clinical_concept_coding; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.clinical_concept_coding (
    id bigint NOT NULL,
    concept_id bigint NOT NULL,
    system_key text NOT NULL,
    system_uri text NOT NULL,
    code text NOT NULL,
    display text,
    version text,
    is_preferred bigint DEFAULT 1 NOT NULL,
    created_at bigint NOT NULL,
    updated_at bigint NOT NULL,
    terminology_entry_id bigint,
    CONSTRAINT clinical_concept_coding_is_preferred_check CHECK ((is_preferred = ANY (ARRAY[(0)::bigint, (1)::bigint]))),
    CONSTRAINT clinical_concept_coding_system_key_check CHECK ((system_key = ANY (ARRAY['SNOMED_CT'::text, 'ICD_10'::text, 'ICD_9_CM'::text, 'LOINC'::text, 'RXNORM'::text, 'ATC'::text, 'UCUM'::text])))
);


--
-- Name: clinical_concept_coding_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.clinical_concept_coding_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: clinical_concept_coding_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.clinical_concept_coding_id_seq OWNED BY public.clinical_concept_coding.id;


--
-- Name: clinical_concept_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.clinical_concept_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: clinical_concept_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.clinical_concept_id_seq OWNED BY public.clinical_concept.id;


--
-- Name: clinical_parameter_master; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.clinical_parameter_master (
    id bigint NOT NULL,
    param_key text NOT NULL,
    concept_id bigint,
    display_name text NOT NULL,
    value_type text DEFAULT 'number'::text NOT NULL,
    unit text,
    is_active bigint DEFAULT 1 NOT NULL,
    created_at bigint NOT NULL,
    updated_at bigint NOT NULL,
    CONSTRAINT clinical_parameter_master_is_active_check CHECK ((is_active = ANY (ARRAY[(0)::bigint, (1)::bigint]))),
    CONSTRAINT clinical_parameter_master_value_type_check CHECK ((value_type = ANY (ARRAY['number'::text, 'text'::text, 'code'::text])))
);


--
-- Name: clinical_parameter_master_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.clinical_parameter_master_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: clinical_parameter_master_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.clinical_parameter_master_id_seq OWNED BY public.clinical_parameter_master.id;


--
-- Name: ephis_daily_case; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ephis_daily_case (
    id bigint NOT NULL,
    hn text,
    admit_date text,
    admit_datetime text,
    raw_admit_value text,
    source_payload text,
    imported_at bigint
);


--
-- Name: ephis_daily_case_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.ephis_daily_case_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: ephis_daily_case_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.ephis_daily_case_id_seq OWNED BY public.ephis_daily_case.id;


--
-- Name: his_allergy_buffer; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.his_allergy_buffer (
    id bigint NOT NULL,
    hn text,
    allergen text,
    reaction text,
    severity text,
    status text,
    source text,
    raw_payload text,
    his_updated_at bigint,
    created_at bigint,
    updated_at bigint
);


--
-- Name: his_allergy_buffer_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.his_allergy_buffer_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: his_allergy_buffer_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.his_allergy_buffer_id_seq OWNED BY public.his_allergy_buffer.id;


--
-- Name: his_lab_buffer; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.his_lab_buffer (
    id bigint NOT NULL,
    hn text,
    test_name text,
    test_group text,
    value_text text,
    unit text,
    ref_range text,
    flag text,
    collected_at bigint,
    source text,
    raw_payload text,
    his_updated_at bigint,
    created_at bigint,
    updated_at bigint
);


--
-- Name: his_lab_buffer_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.his_lab_buffer_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: his_lab_buffer_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.his_lab_buffer_id_seq OWNED BY public.his_lab_buffer.id;


--
-- Name: his_patient_buffer; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.his_patient_buffer (
    id bigint NOT NULL,
    hn text,
    an text,
    is_patient text,
    notype text,
    id_card text,
    patient_name text,
    title_th text,
    title_en text,
    first_name text,
    last_name text,
    first_name_en text,
    last_name_en text,
    sex text,
    dob text,
    age_text text,
    weight_kg real,
    height_cm real,
    blood_group_text text,
    blood_group_abo text,
    blood_group_rh text,
    race text,
    ethnicity text,
    religion text,
    marital_status text,
    present_address text,
    present_province text,
    legal_address text,
    legal_province text,
    mobile text,
    contact_name text,
    contact_tel text,
    relation_desc text,
    nationality text,
    source text,
    raw_payload text,
    pre_admit_at bigint,
    pre_admit_note text,
    his_updated_at bigint,
    created_at bigint,
    updated_at bigint
);


--
-- Name: his_patient_buffer_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.his_patient_buffer_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: his_patient_buffer_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.his_patient_buffer_id_seq OWNED BY public.his_patient_buffer.id;


--
-- Name: icd10_master; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.icd10_master (
    icd10 text NOT NULL,
    icd10who text,
    diagseq bigint,
    name_en text,
    name_th text,
    extcause bigint,
    mcode bigint,
    ca bigint,
    created_at bigint,
    updated_at bigint
);


--
-- Name: icd9cm_master; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.icd9cm_master (
    icd9cm text NOT NULL,
    short_name_en text,
    name_en text,
    created_at bigint,
    updated_at bigint
);


--
-- Name: io_group_master; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.io_group_master (
    id bigint NOT NULL,
    code text NOT NULL,
    display_name text NOT NULL,
    kind text NOT NULL,
    is_active bigint DEFAULT 1 NOT NULL,
    sort_order bigint DEFAULT 0 NOT NULL,
    created_at bigint NOT NULL,
    updated_at bigint NOT NULL,
    CONSTRAINT io_group_master_is_active_check CHECK ((is_active = ANY (ARRAY[(0)::bigint, (1)::bigint]))),
    CONSTRAINT io_group_master_kind_check CHECK ((kind = ANY (ARRAY['med'::text, 'fluid'::text, 'output'::text])))
);


--
-- Name: io_group_master_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.io_group_master_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: io_group_master_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.io_group_master_id_seq OWNED BY public.io_group_master.id;


--
-- Name: io_item_master; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.io_item_master (
    id bigint NOT NULL,
    kind text,
    code text,
    name text,
    default_unit text,
    category text,
    is_active bigint DEFAULT '1'::bigint,
    created_at bigint,
    updated_at bigint,
    usage_score bigint DEFAULT '0'::bigint,
    usage_rank bigint,
    concept_id bigint,
    group_id bigint,
    CONSTRAINT io_item_master_is_active_check CHECK ((is_active = ANY (ARRAY[(0)::bigint, (1)::bigint]))),
    CONSTRAINT io_item_master_kind_check CHECK ((kind = ANY (ARRAY['fluid'::text, 'med'::text, 'output'::text])))
);


--
-- Name: io_item_master_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.io_item_master_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: io_item_master_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.io_item_master_id_seq OWNED BY public.io_item_master.id;


--
-- Name: language_master; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.language_master (
    code text NOT NULL,
    name_en text NOT NULL,
    name_native text NOT NULL,
    is_active bigint DEFAULT 1 NOT NULL,
    sort_order bigint DEFAULT 0 NOT NULL,
    created_at bigint NOT NULL,
    updated_at bigint NOT NULL,
    CONSTRAINT language_master_is_active_check CHECK ((is_active = ANY (ARRAY[(0)::bigint, (1)::bigint])))
);


--
-- Name: language_translation; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.language_translation (
    language_code text NOT NULL,
    translation_key text NOT NULL,
    translation_value text NOT NULL,
    updated_at bigint NOT NULL
);


--
-- Name: legacy_med_drip_preset_analysis; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.legacy_med_drip_preset_analysis (
    id bigint NOT NULL,
    source_system text,
    source_scope text,
    source_year_from bigint,
    source_year_to bigint,
    drug_name text,
    preset_rank bigint,
    route text,
    weight_based bigint DEFAULT '0'::bigint,
    med_amount_value real,
    med_amount_unit text,
    carrier_name text,
    carrier_volume_ml real,
    concentration_value real,
    concentration_unit text,
    source_count bigint DEFAULT '0'::bigint,
    avg_minutes real,
    first_seen text,
    last_seen text,
    flora_kind text,
    flora_entry_mode text,
    display_label text,
    selection_note text,
    is_curated bigint DEFAULT '0'::bigint,
    imported_at bigint,
    updated_at bigint,
    CONSTRAINT legacy_med_drip_is_curated_check CHECK ((is_curated = ANY (ARRAY[(0)::bigint, (1)::bigint]))),
    CONSTRAINT legacy_med_drip_weight_based_check CHECK ((weight_based = ANY (ARRAY[(0)::bigint, (1)::bigint])))
);


--
-- Name: legacy_med_drip_preset_analysis_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.legacy_med_drip_preset_analysis_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: legacy_med_drip_preset_analysis_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.legacy_med_drip_preset_analysis_id_seq OWNED BY public.legacy_med_drip_preset_analysis.id;


--
-- Name: patient_snapshot; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.patient_snapshot (
    id bigint NOT NULL,
    case_id bigint,
    hn text,
    name text,
    gender text,
    id_number text,
    blood_group text,
    dob bigint,
    age_at_start bigint,
    weight real,
    asa_status text,
    created_at bigint,
    updated_at bigint
);


--
-- Name: patient_snapshot_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.patient_snapshot_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: patient_snapshot_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.patient_snapshot_id_seq OWNED BY public.patient_snapshot.id;


--
-- Name: staff_directory; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.staff_directory (
    id bigint NOT NULL,
    hospital_id text,
    personal_id text,
    email text,
    th_first_name text,
    th_last_name text,
    en_first_name text,
    en_last_name text,
    innovian_id text,
    staff_role_id text,
    entry_year bigint,
    is_active bigint DEFAULT '1'::bigint,
    staff_name text,
    staff_role text,
    used_count bigint DEFAULT '0'::bigint,
    last_used_at bigint,
    created_at bigint,
    updated_at bigint,
    profile_data jsonb DEFAULT '{}'::jsonb NOT NULL,
    CONSTRAINT staff_directory_is_active_check CHECK ((is_active = ANY (ARRAY[(0)::bigint, (1)::bigint])))
);


--
-- Name: staff_directory_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.staff_directory_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: staff_directory_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.staff_directory_id_seq OWNED BY public.staff_directory.id;


--
-- Name: staff_field_master; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.staff_field_master (
    id bigint NOT NULL,
    field_key text NOT NULL,
    label text NOT NULL,
    field_type text DEFAULT 'text'::text NOT NULL,
    language_code text,
    name_part text,
    core_mapping text,
    options_json jsonb DEFAULT '[]'::jsonb NOT NULL,
    is_required bigint DEFAULT 0 NOT NULL,
    is_active bigint DEFAULT 1 NOT NULL,
    sort_order bigint DEFAULT 100 NOT NULL,
    created_at bigint,
    updated_at bigint,
    CONSTRAINT staff_field_master_core_mapping_check CHECK (((core_mapping IS NULL) OR (core_mapping = ANY (ARRAY['hospital_id'::text, 'staff_name'::text, 'email'::text, 'personal_id'::text, 'entry_year'::text, 'innovian_id'::text])))),
    CONSTRAINT staff_field_master_field_type_check CHECK ((field_type = ANY (ARRAY['text'::text, 'email'::text, 'number'::text, 'date'::text, 'select'::text]))),
    CONSTRAINT staff_field_master_is_active_check CHECK ((is_active = ANY (ARRAY[(0)::bigint, (1)::bigint]))),
    CONSTRAINT staff_field_master_is_required_check CHECK ((is_required = ANY (ARRAY[(0)::bigint, (1)::bigint]))),
    CONSTRAINT staff_field_master_name_part_check CHECK (((name_part IS NULL) OR (name_part = ANY (ARRAY['prefix'::text, 'given'::text, 'middle'::text, 'family'::text, 'suffix'::text]))))
);


--
-- Name: staff_field_master_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.staff_field_master_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: staff_field_master_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.staff_field_master_id_seq OWNED BY public.staff_field_master.id;


--
-- Name: staff_role; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.staff_role (
    id text NOT NULL,
    display_name text,
    sort_order bigint
);


--
-- Name: sync_case_index; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.sync_case_index (
    global_case_id uuid NOT NULL,
    hospital_id text NOT NULL,
    leaf_id text NOT NULL,
    source_case_id text NOT NULL,
    case_code text,
    hn text,
    status text NOT NULL,
    start_time bigint,
    discharge_time bigint,
    revision bigint NOT NULL,
    snapshot jsonb DEFAULT '{}'::jsonb NOT NULL,
    last_synced_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: sync_leaf_node; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.sync_leaf_node (
    leaf_id text NOT NULL,
    hospital_id text NOT NULL,
    display_name text NOT NULL,
    software_version text,
    last_seen_at timestamp with time zone DEFAULT now() NOT NULL,
    registered_at timestamp with time zone DEFAULT now() NOT NULL,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL
);


--
-- Name: sync_message; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.sync_message (
    id bigint NOT NULL,
    leaf_id text NOT NULL,
    message_id uuid NOT NULL,
    entity_type text NOT NULL,
    entity_id text NOT NULL,
    operation text NOT NULL,
    revision bigint NOT NULL,
    occurred_at timestamp with time zone NOT NULL,
    payload jsonb DEFAULT '{}'::jsonb NOT NULL,
    received_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT sync_message_operation_check CHECK ((operation = ANY (ARRAY['upsert'::text, 'delete'::text])))
);


--
-- Name: sync_message_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.sync_message ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.sync_message_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: terminology_entry; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.terminology_entry (
    id bigint NOT NULL,
    release_id bigint NOT NULL,
    domain text NOT NULL,
    code text NOT NULL,
    display text NOT NULL,
    display_th text,
    definition text,
    parent_code text,
    is_billable bigint DEFAULT 1 NOT NULL,
    is_active bigint DEFAULT 1 NOT NULL,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    CONSTRAINT terminology_entry_domain_check CHECK ((domain = ANY (ARRAY['diagnosis'::text, 'procedure'::text, 'observation'::text, 'medication'::text, 'unit'::text]))),
    CONSTRAINT terminology_entry_is_active_check CHECK ((is_active = ANY (ARRAY[(0)::bigint, (1)::bigint]))),
    CONSTRAINT terminology_entry_is_billable_check CHECK ((is_billable = ANY (ARRAY[(0)::bigint, (1)::bigint])))
);


--
-- Name: terminology_entry_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.terminology_entry_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: terminology_entry_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.terminology_entry_id_seq OWNED BY public.terminology_entry.id;


--
-- Name: terminology_release; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.terminology_release (
    id bigint NOT NULL,
    system_key text NOT NULL,
    system_uri text NOT NULL,
    edition text NOT NULL,
    version text NOT NULL,
    release_date date,
    source_uri text,
    license_name text,
    license_uri text,
    status text DEFAULT 'active'::text NOT NULL,
    imported_at bigint NOT NULL,
    entry_count bigint DEFAULT 0 NOT NULL,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    CONSTRAINT terminology_release_status_check CHECK ((status = ANY (ARRAY['staged'::text, 'active'::text, 'superseded'::text])))
);


--
-- Name: terminology_release_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.terminology_release_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: terminology_release_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.terminology_release_id_seq OWNED BY public.terminology_release.id;


--
-- Name: terminology_synonym; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.terminology_synonym (
    id bigint NOT NULL,
    entry_id bigint NOT NULL,
    language_code text DEFAULT 'en'::text NOT NULL,
    term text NOT NULL,
    term_type text DEFAULT 'synonym'::text NOT NULL
);


--
-- Name: terminology_synonym_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.terminology_synonym_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: terminology_synonym_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.terminology_synonym_id_seq OWNED BY public.terminology_synonym.id;


--
-- Name: theme_scheme_master; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.theme_scheme_master (
    code text NOT NULL,
    display_name text NOT NULL,
    color_1_canvas text NOT NULL,
    color_2_surface text NOT NULL,
    color_3_border text NOT NULL,
    color_4_text text NOT NULL,
    color_5_muted text NOT NULL,
    color_6_accent text NOT NULL,
    is_active bigint DEFAULT 1 NOT NULL,
    sort_order bigint DEFAULT 0 NOT NULL,
    created_at bigint NOT NULL,
    updated_at bigint NOT NULL,
    CONSTRAINT theme_scheme_master_is_active_check CHECK ((is_active = ANY (ARRAY[(0)::bigint, (1)::bigint])))
);


--
-- Name: vital_minutes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.vital_minutes (
    id bigint NOT NULL,
    case_id bigint,
    ivy_source text,
    ts_minute bigint,
    payload text,
    created_at bigint
);


--
-- Name: vital_minutes_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.vital_minutes_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: vital_minutes_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.vital_minutes_id_seq OWNED BY public.vital_minutes.id;


--
-- Name: workstation_context; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.workstation_context (
    id smallint DEFAULT 1 NOT NULL,
    hospital_name text NOT NULL,
    building_name text NOT NULL,
    care_unit_name text NOT NULL,
    room_name text NOT NULL,
    bed_name text NOT NULL,
    timezone text DEFAULT 'Asia/Bangkok'::text NOT NULL,
    updated_at bigint NOT NULL,
    date_format text DEFAULT 'DD/MM/YYYY'::text NOT NULL,
    time_format text DEFAULT '24h'::text NOT NULL,
    CONSTRAINT workstation_context_date_format_check CHECK ((date_format = ANY (ARRAY['DD/MM/YYYY'::text, 'MM/DD/YYYY'::text, 'YYYY-MM-DD'::text]))),
    CONSTRAINT workstation_context_id_check CHECK ((id = 1)),
    CONSTRAINT workstation_context_time_format_check CHECK ((time_format = ANY (ARRAY['24h'::text, '12h'::text])))
);


--
-- Name: auth_audit id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auth_audit ALTER COLUMN id SET DEFAULT nextval('public.auth_audit_id_seq'::regclass);


--
-- Name: auth_session id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auth_session ALTER COLUMN id SET DEFAULT nextval('public.auth_session_id_seq'::regclass);


--
-- Name: auth_user id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auth_user ALTER COLUMN id SET DEFAULT nextval('public.auth_user_id_seq'::regclass);


--
-- Name: case_allergy id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.case_allergy ALTER COLUMN id SET DEFAULT nextval('public.case_allergy_id_seq'::regclass);


--
-- Name: case_clinical_audit id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.case_clinical_audit ALTER COLUMN id SET DEFAULT nextval('public.case_clinical_audit_id_seq'::regclass);


--
-- Name: case_detail id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.case_detail ALTER COLUMN id SET DEFAULT nextval('public.case_detail_id_seq'::regclass);


--
-- Name: case_device_ingest_audit id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.case_device_ingest_audit ALTER COLUMN id SET DEFAULT nextval('public.case_device_ingest_audit_id_seq'::regclass);


--
-- Name: case_diagnosis id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.case_diagnosis ALTER COLUMN id SET DEFAULT nextval('public.case_diagnosis_id_seq'::regclass);


--
-- Name: case_event_note id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.case_event_note ALTER COLUMN id SET DEFAULT nextval('public.case_event_note_id_seq'::regclass);


--
-- Name: case_event_note_audit id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.case_event_note_audit ALTER COLUMN id SET DEFAULT nextval('public.case_event_note_audit_id_seq'::regclass);


--
-- Name: case_his_allergy id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.case_his_allergy ALTER COLUMN id SET DEFAULT nextval('public.case_his_allergy_id_seq'::regclass);


--
-- Name: case_his_lab id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.case_his_lab ALTER COLUMN id SET DEFAULT nextval('public.case_his_lab_id_seq'::regclass);


--
-- Name: case_his_patient id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.case_his_patient ALTER COLUMN id SET DEFAULT nextval('public.case_his_patient_id_seq'::regclass);


--
-- Name: case_io_audit id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.case_io_audit ALTER COLUMN id SET DEFAULT nextval('public.case_io_audit_id_seq'::regclass);


--
-- Name: case_io_event id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.case_io_event ALTER COLUMN id SET DEFAULT nextval('public.case_io_event_id_seq'::regclass);


--
-- Name: case_io_run id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.case_io_run ALTER COLUMN id SET DEFAULT nextval('public.case_io_run_id_seq'::regclass);


--
-- Name: case_io_segment id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.case_io_segment ALTER COLUMN id SET DEFAULT nextval('public.case_io_segment_id_seq'::regclass);


--
-- Name: case_procedure id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.case_procedure ALTER COLUMN id SET DEFAULT nextval('public.case_procedure_id_seq'::regclass);


--
-- Name: case_staff id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.case_staff ALTER COLUMN id SET DEFAULT nextval('public.case_staff_id_seq'::regclass);


--
-- Name: case_timeline_audit id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.case_timeline_audit ALTER COLUMN id SET DEFAULT nextval('public.case_timeline_audit_id_seq'::regclass);


--
-- Name: case_timeline_value id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.case_timeline_value ALTER COLUMN id SET DEFAULT nextval('public.case_timeline_value_id_seq'::regclass);


--
-- Name: cases id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cases ALTER COLUMN id SET DEFAULT nextval('public.cases_id_seq'::regclass);


--
-- Name: clinical_concept id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.clinical_concept ALTER COLUMN id SET DEFAULT nextval('public.clinical_concept_id_seq'::regclass);


--
-- Name: clinical_concept_coding id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.clinical_concept_coding ALTER COLUMN id SET DEFAULT nextval('public.clinical_concept_coding_id_seq'::regclass);


--
-- Name: clinical_parameter_master id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.clinical_parameter_master ALTER COLUMN id SET DEFAULT nextval('public.clinical_parameter_master_id_seq'::regclass);


--
-- Name: ephis_daily_case id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ephis_daily_case ALTER COLUMN id SET DEFAULT nextval('public.ephis_daily_case_id_seq'::regclass);


--
-- Name: his_allergy_buffer id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.his_allergy_buffer ALTER COLUMN id SET DEFAULT nextval('public.his_allergy_buffer_id_seq'::regclass);


--
-- Name: his_lab_buffer id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.his_lab_buffer ALTER COLUMN id SET DEFAULT nextval('public.his_lab_buffer_id_seq'::regclass);


--
-- Name: his_patient_buffer id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.his_patient_buffer ALTER COLUMN id SET DEFAULT nextval('public.his_patient_buffer_id_seq'::regclass);


--
-- Name: io_group_master id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.io_group_master ALTER COLUMN id SET DEFAULT nextval('public.io_group_master_id_seq'::regclass);


--
-- Name: io_item_master id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.io_item_master ALTER COLUMN id SET DEFAULT nextval('public.io_item_master_id_seq'::regclass);


--
-- Name: legacy_med_drip_preset_analysis id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.legacy_med_drip_preset_analysis ALTER COLUMN id SET DEFAULT nextval('public.legacy_med_drip_preset_analysis_id_seq'::regclass);


--
-- Name: patient_snapshot id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.patient_snapshot ALTER COLUMN id SET DEFAULT nextval('public.patient_snapshot_id_seq'::regclass);


--
-- Name: staff_directory id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.staff_directory ALTER COLUMN id SET DEFAULT nextval('public.staff_directory_id_seq'::regclass);


--
-- Name: staff_field_master id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.staff_field_master ALTER COLUMN id SET DEFAULT nextval('public.staff_field_master_id_seq'::regclass);


--
-- Name: terminology_entry id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.terminology_entry ALTER COLUMN id SET DEFAULT nextval('public.terminology_entry_id_seq'::regclass);


--
-- Name: terminology_release id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.terminology_release ALTER COLUMN id SET DEFAULT nextval('public.terminology_release_id_seq'::regclass);


--
-- Name: terminology_synonym id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.terminology_synonym ALTER COLUMN id SET DEFAULT nextval('public.terminology_synonym_id_seq'::regclass);


--
-- Name: vital_minutes id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vital_minutes ALTER COLUMN id SET DEFAULT nextval('public.vital_minutes_id_seq'::regclass);


--
-- Name: auth_permission auth_permission_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auth_permission
    ADD CONSTRAINT auth_permission_pkey PRIMARY KEY (code);


--
-- Name: auth_role_permission auth_role_permission_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auth_role_permission
    ADD CONSTRAINT auth_role_permission_pkey PRIMARY KEY (role_code, permission_code);


--
-- Name: auth_role auth_role_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auth_role
    ADD CONSTRAINT auth_role_pkey PRIMARY KEY (code);


--
-- Name: auth_user_role auth_user_role_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auth_user_role
    ADD CONSTRAINT auth_user_role_pkey PRIMARY KEY (user_id, role_code, scope_type, scope_id);


--
-- Name: case_clinical_audit case_clinical_audit_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.case_clinical_audit
    ADD CONSTRAINT case_clinical_audit_pkey PRIMARY KEY (id);


--
-- Name: clinical_concept_coding clinical_concept_coding_concept_id_system_key_code_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.clinical_concept_coding
    ADD CONSTRAINT clinical_concept_coding_concept_id_system_key_code_key UNIQUE (concept_id, system_key, code);


--
-- Name: clinical_concept_coding clinical_concept_coding_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.clinical_concept_coding
    ADD CONSTRAINT clinical_concept_coding_pkey PRIMARY KEY (id);


--
-- Name: clinical_concept clinical_concept_domain_local_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.clinical_concept
    ADD CONSTRAINT clinical_concept_domain_local_id_key UNIQUE (domain, local_id);


--
-- Name: clinical_concept clinical_concept_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.clinical_concept
    ADD CONSTRAINT clinical_concept_pkey PRIMARY KEY (id);


--
-- Name: clinical_parameter_master clinical_parameter_master_param_key_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.clinical_parameter_master
    ADD CONSTRAINT clinical_parameter_master_param_key_key UNIQUE (param_key);


--
-- Name: clinical_parameter_master clinical_parameter_master_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.clinical_parameter_master
    ADD CONSTRAINT clinical_parameter_master_pkey PRIMARY KEY (id);


--
-- Name: icd10_master icd10_master_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.icd10_master
    ADD CONSTRAINT icd10_master_pkey PRIMARY KEY (icd10);


--
-- Name: icd9cm_master icd9cm_master_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.icd9cm_master
    ADD CONSTRAINT icd9cm_master_pkey PRIMARY KEY (icd9cm);


--
-- Name: cases idx_16393_cases_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cases
    ADD CONSTRAINT idx_16393_cases_pkey PRIMARY KEY (id);


--
-- Name: auth_user idx_16400_auth_user_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auth_user
    ADD CONSTRAINT idx_16400_auth_user_pkey PRIMARY KEY (id);


--
-- Name: auth_session idx_16409_auth_session_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auth_session
    ADD CONSTRAINT idx_16409_auth_session_pkey PRIMARY KEY (id);


--
-- Name: auth_audit idx_16416_auth_audit_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auth_audit
    ADD CONSTRAINT idx_16416_auth_audit_pkey PRIMARY KEY (id);


--
-- Name: vital_minutes idx_16424_vital_minutes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vital_minutes
    ADD CONSTRAINT idx_16424_vital_minutes_pkey PRIMARY KEY (id);


--
-- Name: case_device_ingest_audit idx_16431_case_device_ingest_audit_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.case_device_ingest_audit
    ADD CONSTRAINT idx_16431_case_device_ingest_audit_pkey PRIMARY KEY (id);


--
-- Name: case_timeline_value idx_16440_case_timeline_value_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.case_timeline_value
    ADD CONSTRAINT idx_16440_case_timeline_value_pkey PRIMARY KEY (id);


--
-- Name: case_timeline_audit idx_16447_case_timeline_audit_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.case_timeline_audit
    ADD CONSTRAINT idx_16447_case_timeline_audit_pkey PRIMARY KEY (id);


--
-- Name: case_event_note idx_16454_case_event_note_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.case_event_note
    ADD CONSTRAINT idx_16454_case_event_note_pkey PRIMARY KEY (id);


--
-- Name: case_event_note_audit idx_16462_case_event_note_audit_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.case_event_note_audit
    ADD CONSTRAINT idx_16462_case_event_note_audit_pkey PRIMARY KEY (id);


--
-- Name: patient_snapshot idx_16468_patient_snapshot_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.patient_snapshot
    ADD CONSTRAINT idx_16468_patient_snapshot_pkey PRIMARY KEY (id);


--
-- Name: case_detail idx_16474_case_detail_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.case_detail
    ADD CONSTRAINT idx_16474_case_detail_pkey PRIMARY KEY (id);


--
-- Name: case_diagnosis idx_16481_case_diagnosis_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.case_diagnosis
    ADD CONSTRAINT idx_16481_case_diagnosis_pkey PRIMARY KEY (id);


--
-- Name: case_procedure idx_16489_case_procedure_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.case_procedure
    ADD CONSTRAINT idx_16489_case_procedure_pkey PRIMARY KEY (id);


--
-- Name: legacy_med_drip_preset_analysis idx_16506_legacy_med_drip_preset_analysis_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.legacy_med_drip_preset_analysis
    ADD CONSTRAINT idx_16506_legacy_med_drip_preset_analysis_pkey PRIMARY KEY (id);


--
-- Name: case_allergy idx_16514_case_allergy_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.case_allergy
    ADD CONSTRAINT idx_16514_case_allergy_pkey PRIMARY KEY (id);


--
-- Name: case_his_patient idx_16520_case_his_patient_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.case_his_patient
    ADD CONSTRAINT idx_16520_case_his_patient_pkey PRIMARY KEY (id);


--
-- Name: case_his_allergy idx_16526_case_his_allergy_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.case_his_allergy
    ADD CONSTRAINT idx_16526_case_his_allergy_pkey PRIMARY KEY (id);


--
-- Name: case_his_lab idx_16532_case_his_lab_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.case_his_lab
    ADD CONSTRAINT idx_16532_case_his_lab_pkey PRIMARY KEY (id);


--
-- Name: ephis_daily_case idx_16537_ephis_daily_case_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ephis_daily_case
    ADD CONSTRAINT idx_16537_ephis_daily_case_pkey PRIMARY KEY (id);


--
-- Name: his_patient_buffer idx_16542_his_patient_buffer_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.his_patient_buffer
    ADD CONSTRAINT idx_16542_his_patient_buffer_pkey PRIMARY KEY (id);


--
-- Name: his_allergy_buffer idx_16547_his_allergy_buffer_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.his_allergy_buffer
    ADD CONSTRAINT idx_16547_his_allergy_buffer_pkey PRIMARY KEY (id);


--
-- Name: his_lab_buffer idx_16552_his_lab_buffer_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.his_lab_buffer
    ADD CONSTRAINT idx_16552_his_lab_buffer_pkey PRIMARY KEY (id);


--
-- Name: case_staff idx_16557_case_staff_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.case_staff
    ADD CONSTRAINT idx_16557_case_staff_pkey PRIMARY KEY (id);


--
-- Name: staff_directory idx_16563_staff_directory_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.staff_directory
    ADD CONSTRAINT idx_16563_staff_directory_pkey PRIMARY KEY (id);


--
-- Name: io_item_master idx_16576_io_item_master_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.io_item_master
    ADD CONSTRAINT idx_16576_io_item_master_pkey PRIMARY KEY (id);


--
-- Name: case_io_run idx_16585_case_io_run_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.case_io_run
    ADD CONSTRAINT idx_16585_case_io_run_pkey PRIMARY KEY (id);


--
-- Name: case_io_segment idx_16593_case_io_segment_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.case_io_segment
    ADD CONSTRAINT idx_16593_case_io_segment_pkey PRIMARY KEY (id);


--
-- Name: case_io_event idx_16601_case_io_event_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.case_io_event
    ADD CONSTRAINT idx_16601_case_io_event_pkey PRIMARY KEY (id);


--
-- Name: case_io_audit idx_16609_case_io_audit_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.case_io_audit
    ADD CONSTRAINT idx_16609_case_io_audit_pkey PRIMARY KEY (id);


--
-- Name: io_group_master io_group_master_code_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.io_group_master
    ADD CONSTRAINT io_group_master_code_key UNIQUE (code);


--
-- Name: io_group_master io_group_master_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.io_group_master
    ADD CONSTRAINT io_group_master_pkey PRIMARY KEY (id);


--
-- Name: language_master language_master_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.language_master
    ADD CONSTRAINT language_master_pkey PRIMARY KEY (code);


--
-- Name: language_translation language_translation_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.language_translation
    ADD CONSTRAINT language_translation_pkey PRIMARY KEY (language_code, translation_key);


--
-- Name: staff_field_master staff_field_master_field_key_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.staff_field_master
    ADD CONSTRAINT staff_field_master_field_key_key UNIQUE (field_key);


--
-- Name: staff_field_master staff_field_master_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.staff_field_master
    ADD CONSTRAINT staff_field_master_pkey PRIMARY KEY (id);


--
-- Name: staff_role staff_role_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.staff_role
    ADD CONSTRAINT staff_role_pkey PRIMARY KEY (id);


--
-- Name: sync_case_index sync_case_index_leaf_id_source_case_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sync_case_index
    ADD CONSTRAINT sync_case_index_leaf_id_source_case_id_key UNIQUE (leaf_id, source_case_id);


--
-- Name: sync_case_index sync_case_index_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sync_case_index
    ADD CONSTRAINT sync_case_index_pkey PRIMARY KEY (global_case_id);


--
-- Name: sync_leaf_node sync_leaf_node_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sync_leaf_node
    ADD CONSTRAINT sync_leaf_node_pkey PRIMARY KEY (leaf_id);


--
-- Name: sync_message sync_message_leaf_id_message_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sync_message
    ADD CONSTRAINT sync_message_leaf_id_message_id_key UNIQUE (leaf_id, message_id);


--
-- Name: sync_message sync_message_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sync_message
    ADD CONSTRAINT sync_message_pkey PRIMARY KEY (id);


--
-- Name: terminology_entry terminology_entry_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.terminology_entry
    ADD CONSTRAINT terminology_entry_pkey PRIMARY KEY (id);


--
-- Name: terminology_entry terminology_entry_release_id_domain_code_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.terminology_entry
    ADD CONSTRAINT terminology_entry_release_id_domain_code_key UNIQUE (release_id, domain, code);


--
-- Name: terminology_release terminology_release_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.terminology_release
    ADD CONSTRAINT terminology_release_pkey PRIMARY KEY (id);


--
-- Name: terminology_release terminology_release_system_key_edition_version_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.terminology_release
    ADD CONSTRAINT terminology_release_system_key_edition_version_key UNIQUE (system_key, edition, version);


--
-- Name: terminology_synonym terminology_synonym_entry_id_language_code_term_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.terminology_synonym
    ADD CONSTRAINT terminology_synonym_entry_id_language_code_term_key UNIQUE (entry_id, language_code, term);


--
-- Name: terminology_synonym terminology_synonym_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.terminology_synonym
    ADD CONSTRAINT terminology_synonym_pkey PRIMARY KEY (id);


--
-- Name: theme_scheme_master theme_scheme_master_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.theme_scheme_master
    ADD CONSTRAINT theme_scheme_master_pkey PRIMARY KEY (code);


--
-- Name: workstation_context workstation_context_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workstation_context
    ADD CONSTRAINT workstation_context_pkey PRIMARY KEY (id);


--
-- Name: auth_role_permission_permission_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX auth_role_permission_permission_idx ON public.auth_role_permission USING btree (permission_code);


--
-- Name: auth_session_token_hash_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX auth_session_token_hash_key ON public.auth_session USING btree (token_hash);


--
-- Name: auth_user_role_user_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX auth_user_role_user_idx ON public.auth_user_role USING btree (user_id);


--
-- Name: auth_user_staff_directory_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX auth_user_staff_directory_idx ON public.auth_user USING btree (staff_directory_id);


--
-- Name: auth_user_staff_directory_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX auth_user_staff_directory_unique ON public.auth_user USING btree (staff_directory_id) WHERE (staff_directory_id IS NOT NULL);


--
-- Name: auth_user_username_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX auth_user_username_key ON public.auth_user USING btree (username);


--
-- Name: case_clinical_audit_case; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX case_clinical_audit_case ON public.case_clinical_audit USING btree (case_id, created_at);


--
-- Name: case_detail_case_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX case_detail_case_key ON public.case_detail USING btree (case_id);


--
-- Name: case_diagnosis_concept; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX case_diagnosis_concept ON public.case_diagnosis USING btree (concept_id);


--
-- Name: case_his_patient_case_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX case_his_patient_case_key ON public.case_his_patient USING btree (case_id);


--
-- Name: case_procedure_concept; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX case_procedure_concept ON public.case_procedure USING btree (concept_id);


--
-- Name: case_staff_identity_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX case_staff_identity_key ON public.case_staff USING btree (case_id, staff_name, staff_role);


--
-- Name: case_timeline_value_minute_param_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX case_timeline_value_minute_param_key ON public.case_timeline_value USING btree (case_id, ts_minute, param_key);


--
-- Name: cases_admission_source_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX cases_admission_source_idx ON public.cases USING btree (admission_source, start_time DESC);


--
-- Name: cases_case_code_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX cases_case_code_key ON public.cases USING btree (case_code);


--
-- Name: clinical_concept_coding_entry; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX clinical_concept_coding_entry ON public.clinical_concept_coding USING btree (terminology_entry_id);


--
-- Name: clinical_concept_coding_lookup; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX clinical_concept_coding_lookup ON public.clinical_concept_coding USING btree (system_key, code);


--
-- Name: clinical_concept_domain_name; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX clinical_concept_domain_name ON public.clinical_concept USING btree (domain, is_active, local_name);


--
-- Name: his_patient_buffer_hn_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX his_patient_buffer_hn_key ON public.his_patient_buffer USING btree (hn);


--
-- Name: idx_16393_idx_cases_hn_start; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_16393_idx_cases_hn_start ON public.cases USING btree (hn, start_time);


--
-- Name: idx_16393_idx_cases_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_16393_idx_cases_status ON public.cases USING btree (status);


--
-- Name: idx_16400_idx_auth_user_hospital_id; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_16400_idx_auth_user_hospital_id ON public.auth_user USING btree (hospital_id);


--
-- Name: idx_16400_idx_auth_user_username; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_16400_idx_auth_user_username ON public.auth_user USING btree (username);


--
-- Name: idx_16409_idx_auth_session_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_16409_idx_auth_session_user ON public.auth_session USING btree (user_id, revoked_at, expires_at);


--
-- Name: idx_16416_idx_auth_audit_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_16416_idx_auth_audit_created ON public.auth_audit USING btree (created_at, id);


--
-- Name: idx_16424_idx_vital_minutes_case; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_16424_idx_vital_minutes_case ON public.vital_minutes USING btree (case_id, ts_minute);


--
-- Name: idx_16431_idx_case_device_ingest_audit_case; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_16431_idx_case_device_ingest_audit_case ON public.case_device_ingest_audit USING btree (case_id, created_at, id);


--
-- Name: idx_16440_idx_case_timeline_value_case; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_16440_idx_case_timeline_value_case ON public.case_timeline_value USING btree (case_id, ts_minute, param_key);


--
-- Name: idx_16447_idx_case_timeline_audit_case; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_16447_idx_case_timeline_audit_case ON public.case_timeline_audit USING btree (case_id, created_at);


--
-- Name: idx_16454_idx_case_event_note_case; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_16454_idx_case_event_note_case ON public.case_event_note USING btree (case_id, event_ts, id);


--
-- Name: idx_16454_idx_case_event_note_lifecycle; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_16454_idx_case_event_note_lifecycle ON public.case_event_note USING btree (case_id, event_type, is_deleted, event_ts, id);


--
-- Name: idx_16462_idx_case_event_note_audit_case; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_16462_idx_case_event_note_audit_case ON public.case_event_note_audit USING btree (case_id, created_at);


--
-- Name: idx_16468_idx_patient_snapshot_case; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_16468_idx_patient_snapshot_case ON public.patient_snapshot USING btree (case_id);


--
-- Name: idx_16474_idx_case_detail_case; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_16474_idx_case_detail_case ON public.case_detail USING btree (case_id);


--
-- Name: idx_16481_idx_case_diagnosis_case; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_16481_idx_case_diagnosis_case ON public.case_diagnosis USING btree (case_id);


--
-- Name: idx_16489_idx_case_procedure_case; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_16489_idx_case_procedure_case ON public.case_procedure USING btree (case_id);


--
-- Name: idx_16496_idx_icd10_master_name_en; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_16496_idx_icd10_master_name_en ON public.icd10_master USING btree (name_en);


--
-- Name: idx_16496_idx_icd10_master_name_th; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_16496_idx_icd10_master_name_th ON public.icd10_master USING btree (name_th);


--
-- Name: idx_16496_idx_icd10_master_who; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_16496_idx_icd10_master_who ON public.icd10_master USING btree (icd10who);


--
-- Name: idx_16501_idx_icd9cm_master_name_en; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_16501_idx_icd9cm_master_name_en ON public.icd9cm_master USING btree (name_en);


--
-- Name: idx_16501_idx_icd9cm_master_short_name_en; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_16501_idx_icd9cm_master_short_name_en ON public.icd9cm_master USING btree (short_name_en);


--
-- Name: idx_16506_idx_legacy_med_drip_preset_analysis_drug; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_16506_idx_legacy_med_drip_preset_analysis_drug ON public.legacy_med_drip_preset_analysis USING btree (drug_name, source_count, id);


--
-- Name: idx_16506_idx_legacy_med_drip_preset_analysis_scope; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_16506_idx_legacy_med_drip_preset_analysis_scope ON public.legacy_med_drip_preset_analysis USING btree (source_system, source_scope, source_year_from, source_year_to, is_curated);


--
-- Name: idx_16514_idx_case_allergy_case; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_16514_idx_case_allergy_case ON public.case_allergy USING btree (case_id);


--
-- Name: idx_16520_idx_case_his_patient_case; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_16520_idx_case_his_patient_case ON public.case_his_patient USING btree (case_id);


--
-- Name: idx_16526_idx_case_his_allergy_case; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_16526_idx_case_his_allergy_case ON public.case_his_allergy USING btree (case_id, id);


--
-- Name: idx_16532_idx_case_his_lab_case; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_16532_idx_case_his_lab_case ON public.case_his_lab USING btree (case_id, collected_at, id);


--
-- Name: idx_16537_idx_ephis_daily_case_admit_date; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_16537_idx_ephis_daily_case_admit_date ON public.ephis_daily_case USING btree (admit_date, hn);


--
-- Name: idx_16542_idx_his_patient_buffer_updated; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_16542_idx_his_patient_buffer_updated ON public.his_patient_buffer USING btree (his_updated_at, hn);


--
-- Name: idx_16547_idx_his_allergy_buffer_hn; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_16547_idx_his_allergy_buffer_hn ON public.his_allergy_buffer USING btree (hn, id);


--
-- Name: idx_16552_idx_his_lab_buffer_hn; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_16552_idx_his_lab_buffer_hn ON public.his_lab_buffer USING btree (hn, collected_at, id);


--
-- Name: idx_16557_idx_case_staff_case; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_16557_idx_case_staff_case ON public.case_staff USING btree (case_id, seq, id);


--
-- Name: idx_16563_idx_staff_directory_last_used; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_16563_idx_staff_directory_last_used ON public.staff_directory USING btree (last_used_at, used_count);


--
-- Name: idx_16576_idx_io_item_master_kind; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_16576_idx_io_item_master_kind ON public.io_item_master USING btree (kind, is_active, name);


--
-- Name: idx_16585_idx_case_io_run_case; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_16585_idx_case_io_run_case ON public.case_io_run USING btree (case_id, started_at, id);


--
-- Name: idx_16593_idx_case_io_segment_run; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_16593_idx_case_io_segment_run ON public.case_io_segment USING btree (run_id, ts_from, id);


--
-- Name: idx_16601_idx_case_io_event_case; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_16601_idx_case_io_event_case ON public.case_io_event USING btree (case_id, event_ts, id);


--
-- Name: idx_16609_idx_case_io_audit_case; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_16609_idx_case_io_audit_case ON public.case_io_audit USING btree (case_id, created_at, id);


--
-- Name: idx_ephis_daily_case_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_ephis_daily_case_unique ON public.ephis_daily_case USING btree (hn, admit_date, COALESCE(admit_datetime, ''::text));


--
-- Name: idx_legacy_med_drip_preset_analysis_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_legacy_med_drip_preset_analysis_key ON public.legacy_med_drip_preset_analysis USING btree (source_system, source_scope, COALESCE(source_year_from, (0)::bigint), COALESCE(source_year_to, (0)::bigint), drug_name, COALESCE(route, ''::text), weight_based, COALESCE(med_amount_value, (0)::real), COALESCE(med_amount_unit, ''::text), COALESCE(carrier_name, ''::text), COALESCE(carrier_volume_ml, (0)::real), COALESCE(concentration_value, (0)::real), COALESCE(concentration_unit, ''::text));


--
-- Name: idx_staff_directory_profile_data; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_staff_directory_profile_data ON public.staff_directory USING gin (profile_data);


--
-- Name: idx_staff_field_master_active_order; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_staff_field_master_active_order ON public.staff_field_master USING btree (is_active DESC, sort_order, id);


--
-- Name: idx_sync_case_index_active; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_sync_case_index_active ON public.sync_case_index USING btree (hospital_id, status, last_synced_at DESC);


--
-- Name: idx_sync_leaf_node_hospital_seen; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_sync_leaf_node_hospital_seen ON public.sync_leaf_node USING btree (hospital_id, last_seen_at DESC);


--
-- Name: idx_sync_message_leaf_revision; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_sync_message_leaf_revision ON public.sync_message USING btree (leaf_id, revision DESC);


--
-- Name: io_item_master_code_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX io_item_master_code_key ON public.io_item_master USING btree (code);


--
-- Name: io_item_master_concept; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX io_item_master_concept ON public.io_item_master USING btree (concept_id);


--
-- Name: io_item_master_group_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX io_item_master_group_idx ON public.io_item_master USING btree (group_id);


--
-- Name: patient_snapshot_case_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX patient_snapshot_case_key ON public.patient_snapshot USING btree (case_id);


--
-- Name: staff_directory_identity_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX staff_directory_identity_key ON public.staff_directory USING btree (staff_name, staff_role);


--
-- Name: staff_role_display_name_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX staff_role_display_name_key ON public.staff_role USING btree (display_name);


--
-- Name: terminology_entry_code; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX terminology_entry_code ON public.terminology_entry USING btree (code);


--
-- Name: terminology_entry_domain_display; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX terminology_entry_domain_display ON public.terminology_entry USING btree (domain, display);


--
-- Name: terminology_entry_search; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX terminology_entry_search ON public.terminology_entry USING gin (to_tsvector('simple'::regconfig, ((((COALESCE(code, ''::text) || ' '::text) || COALESCE(display, ''::text)) || ' '::text) || COALESCE(display_th, ''::text))));


--
-- Name: terminology_release_active; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX terminology_release_active ON public.terminology_release USING btree (system_key, status, release_date DESC);


--
-- Name: terminology_synonym_search; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX terminology_synonym_search ON public.terminology_synonym USING gin (to_tsvector('simple'::regconfig, COALESCE(term, ''::text)));


--
-- Name: vital_minutes_source_minute_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX vital_minutes_source_minute_key ON public.vital_minutes USING btree (case_id, ivy_source, ts_minute);


--
-- Name: auth_audit auth_audit_actor_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auth_audit
    ADD CONSTRAINT auth_audit_actor_user_id_fkey FOREIGN KEY (actor_user_id) REFERENCES public.auth_user(id) ON DELETE SET NULL;


--
-- Name: auth_audit auth_audit_target_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auth_audit
    ADD CONSTRAINT auth_audit_target_user_id_fkey FOREIGN KEY (target_user_id) REFERENCES public.auth_user(id) ON DELETE SET NULL;


--
-- Name: auth_role_permission auth_role_permission_permission_code_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auth_role_permission
    ADD CONSTRAINT auth_role_permission_permission_code_fkey FOREIGN KEY (permission_code) REFERENCES public.auth_permission(code) ON DELETE CASCADE;


--
-- Name: auth_role_permission auth_role_permission_role_code_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auth_role_permission
    ADD CONSTRAINT auth_role_permission_role_code_fkey FOREIGN KEY (role_code) REFERENCES public.auth_role(code) ON DELETE CASCADE;


--
-- Name: auth_session auth_session_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auth_session
    ADD CONSTRAINT auth_session_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.auth_user(id) ON DELETE CASCADE;


--
-- Name: auth_user auth_user_language_code_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auth_user
    ADD CONSTRAINT auth_user_language_code_fkey FOREIGN KEY (language_code) REFERENCES public.language_master(code);


--
-- Name: auth_user_role auth_user_role_role_code_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auth_user_role
    ADD CONSTRAINT auth_user_role_role_code_fkey FOREIGN KEY (role_code) REFERENCES public.auth_role(code);


--
-- Name: auth_user_role auth_user_role_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auth_user_role
    ADD CONSTRAINT auth_user_role_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.auth_user(id) ON DELETE CASCADE;


--
-- Name: auth_user auth_user_staff_directory_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auth_user
    ADD CONSTRAINT auth_user_staff_directory_id_fkey FOREIGN KEY (staff_directory_id) REFERENCES public.staff_directory(id) ON DELETE SET NULL;


--
-- Name: case_allergy case_allergy_case_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.case_allergy
    ADD CONSTRAINT case_allergy_case_id_fkey FOREIGN KEY (case_id) REFERENCES public.cases(id) ON DELETE CASCADE;


--
-- Name: case_clinical_audit case_clinical_audit_case_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.case_clinical_audit
    ADD CONSTRAINT case_clinical_audit_case_id_fkey FOREIGN KEY (case_id) REFERENCES public.cases(id);


--
-- Name: case_detail case_detail_case_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.case_detail
    ADD CONSTRAINT case_detail_case_id_fkey FOREIGN KEY (case_id) REFERENCES public.cases(id) ON DELETE CASCADE;


--
-- Name: case_device_ingest_audit case_device_ingest_audit_case_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.case_device_ingest_audit
    ADD CONSTRAINT case_device_ingest_audit_case_id_fkey FOREIGN KEY (case_id) REFERENCES public.cases(id) ON DELETE CASCADE;


--
-- Name: case_diagnosis case_diagnosis_case_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.case_diagnosis
    ADD CONSTRAINT case_diagnosis_case_id_fkey FOREIGN KEY (case_id) REFERENCES public.cases(id) ON DELETE CASCADE;


--
-- Name: case_diagnosis case_diagnosis_concept_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.case_diagnosis
    ADD CONSTRAINT case_diagnosis_concept_id_fkey FOREIGN KEY (concept_id) REFERENCES public.clinical_concept(id);


--
-- Name: case_event_note_audit case_event_note_audit_case_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.case_event_note_audit
    ADD CONSTRAINT case_event_note_audit_case_id_fkey FOREIGN KEY (case_id) REFERENCES public.cases(id) ON DELETE CASCADE;


--
-- Name: case_event_note case_event_note_case_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.case_event_note
    ADD CONSTRAINT case_event_note_case_id_fkey FOREIGN KEY (case_id) REFERENCES public.cases(id) ON DELETE CASCADE;


--
-- Name: case_his_allergy case_his_allergy_case_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.case_his_allergy
    ADD CONSTRAINT case_his_allergy_case_id_fkey FOREIGN KEY (case_id) REFERENCES public.cases(id) ON DELETE CASCADE;


--
-- Name: case_his_lab case_his_lab_case_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.case_his_lab
    ADD CONSTRAINT case_his_lab_case_id_fkey FOREIGN KEY (case_id) REFERENCES public.cases(id) ON DELETE CASCADE;


--
-- Name: case_his_patient case_his_patient_case_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.case_his_patient
    ADD CONSTRAINT case_his_patient_case_id_fkey FOREIGN KEY (case_id) REFERENCES public.cases(id) ON DELETE CASCADE;


--
-- Name: case_io_audit case_io_audit_case_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.case_io_audit
    ADD CONSTRAINT case_io_audit_case_id_fkey FOREIGN KEY (case_id) REFERENCES public.cases(id) ON DELETE CASCADE;


--
-- Name: case_io_event case_io_event_case_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.case_io_event
    ADD CONSTRAINT case_io_event_case_id_fkey FOREIGN KEY (case_id) REFERENCES public.cases(id) ON DELETE CASCADE;


--
-- Name: case_io_event case_io_event_item_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.case_io_event
    ADD CONSTRAINT case_io_event_item_id_fkey FOREIGN KEY (item_id) REFERENCES public.io_item_master(id);


--
-- Name: case_io_run case_io_run_case_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.case_io_run
    ADD CONSTRAINT case_io_run_case_id_fkey FOREIGN KEY (case_id) REFERENCES public.cases(id) ON DELETE CASCADE;


--
-- Name: case_io_run case_io_run_item_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.case_io_run
    ADD CONSTRAINT case_io_run_item_id_fkey FOREIGN KEY (item_id) REFERENCES public.io_item_master(id);


--
-- Name: case_io_segment case_io_segment_run_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.case_io_segment
    ADD CONSTRAINT case_io_segment_run_id_fkey FOREIGN KEY (run_id) REFERENCES public.case_io_run(id) ON DELETE CASCADE;


--
-- Name: case_procedure case_procedure_case_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.case_procedure
    ADD CONSTRAINT case_procedure_case_id_fkey FOREIGN KEY (case_id) REFERENCES public.cases(id) ON DELETE CASCADE;


--
-- Name: case_procedure case_procedure_concept_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.case_procedure
    ADD CONSTRAINT case_procedure_concept_id_fkey FOREIGN KEY (concept_id) REFERENCES public.clinical_concept(id);


--
-- Name: case_staff case_staff_case_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.case_staff
    ADD CONSTRAINT case_staff_case_id_fkey FOREIGN KEY (case_id) REFERENCES public.cases(id) ON DELETE CASCADE;


--
-- Name: case_timeline_audit case_timeline_audit_case_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.case_timeline_audit
    ADD CONSTRAINT case_timeline_audit_case_id_fkey FOREIGN KEY (case_id) REFERENCES public.cases(id) ON DELETE CASCADE;


--
-- Name: case_timeline_value case_timeline_value_case_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.case_timeline_value
    ADD CONSTRAINT case_timeline_value_case_id_fkey FOREIGN KEY (case_id) REFERENCES public.cases(id) ON DELETE CASCADE;


--
-- Name: clinical_concept_coding clinical_concept_coding_concept_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.clinical_concept_coding
    ADD CONSTRAINT clinical_concept_coding_concept_id_fkey FOREIGN KEY (concept_id) REFERENCES public.clinical_concept(id) ON DELETE CASCADE;


--
-- Name: clinical_concept_coding clinical_concept_coding_terminology_entry_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.clinical_concept_coding
    ADD CONSTRAINT clinical_concept_coding_terminology_entry_id_fkey FOREIGN KEY (terminology_entry_id) REFERENCES public.terminology_entry(id) ON DELETE SET NULL;


--
-- Name: clinical_parameter_master clinical_parameter_master_concept_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.clinical_parameter_master
    ADD CONSTRAINT clinical_parameter_master_concept_id_fkey FOREIGN KEY (concept_id) REFERENCES public.clinical_concept(id);


--
-- Name: io_item_master io_item_master_concept_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.io_item_master
    ADD CONSTRAINT io_item_master_concept_id_fkey FOREIGN KEY (concept_id) REFERENCES public.clinical_concept(id);


--
-- Name: io_item_master io_item_master_group_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.io_item_master
    ADD CONSTRAINT io_item_master_group_id_fkey FOREIGN KEY (group_id) REFERENCES public.io_group_master(id);


--
-- Name: language_translation language_translation_language_code_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.language_translation
    ADD CONSTRAINT language_translation_language_code_fkey FOREIGN KEY (language_code) REFERENCES public.language_master(code) ON DELETE CASCADE;


--
-- Name: patient_snapshot patient_snapshot_case_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.patient_snapshot
    ADD CONSTRAINT patient_snapshot_case_id_fkey FOREIGN KEY (case_id) REFERENCES public.cases(id) ON DELETE CASCADE;


--
-- Name: sync_case_index sync_case_index_leaf_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sync_case_index
    ADD CONSTRAINT sync_case_index_leaf_id_fkey FOREIGN KEY (leaf_id) REFERENCES public.sync_leaf_node(leaf_id);


--
-- Name: sync_message sync_message_leaf_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sync_message
    ADD CONSTRAINT sync_message_leaf_id_fkey FOREIGN KEY (leaf_id) REFERENCES public.sync_leaf_node(leaf_id);


--
-- Name: terminology_entry terminology_entry_release_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.terminology_entry
    ADD CONSTRAINT terminology_entry_release_id_fkey FOREIGN KEY (release_id) REFERENCES public.terminology_release(id) ON DELETE CASCADE;


--
-- Name: terminology_synonym terminology_synonym_entry_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.terminology_synonym
    ADD CONSTRAINT terminology_synonym_entry_id_fkey FOREIGN KEY (entry_id) REFERENCES public.terminology_entry(id) ON DELETE CASCADE;


--
-- Name: vital_minutes vital_minutes_case_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vital_minutes
    ADD CONSTRAINT vital_minutes_case_id_fkey FOREIGN KEY (case_id) REFERENCES public.cases(id);


--
-- PostgreSQL database dump complete
--

\unrestrict f1gWJueHjY0kYspf5TarZoxBcHW43tfdfU9GM1ArK6S6OvbuZT5bdCYzyG6szV1

