-- Flora Root dev seed: dump of the demo Root database (flora_root), 2026-10-14T01:39Z.
-- Sanitised: sign-in sessions removed, every user's password = admin's, signing keys removed.
-- Root creates a new Ed25519 signing key on first start: re-issue licenses and re-publish releases
-- (demo/release.sh) after restoring, and give Haber the new public key.
-- Restore into a fresh Root database:
--   psql -U flora_root -d flora_root -f databases/seed/flora_root.sql

--
-- PostgreSQL database dump
--

\restrict SWgpm5gCrXbjMFUuszonOzoGN88VZ8aew5u3ubYr59fp5XCgShbkThKsPYBKS7y

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

ALTER TABLE IF EXISTS ONLY public.root_session DROP CONSTRAINT IF EXISTS root_session_user_id_fkey;
ALTER TABLE IF EXISTS ONLY public.root_license DROP CONSTRAINT IF EXISTS root_license_tenant_id_fkey;
ALTER TABLE IF EXISTS ONLY public.root_checkin DROP CONSTRAINT IF EXISTS root_checkin_tenant_id_fkey;
ALTER TABLE IF EXISTS ONLY public.device_protocol DROP CONSTRAINT IF EXISTS device_protocol_source_id_fkey;
ALTER TABLE IF EXISTS ONLY public.device_protocol_lane DROP CONSTRAINT IF EXISTS device_protocol_lane_source_id_fkey;
ALTER TABLE IF EXISTS ONLY public.device_manufacturer DROP CONSTRAINT IF EXISTS device_manufacturer_source_id_fkey;
ALTER TABLE IF EXISTS ONLY public.device_connection_type DROP CONSTRAINT IF EXISTS device_connection_type_source_id_fkey;
DROP INDEX IF EXISTS public.root_session_expiry;
DROP INDEX IF EXISTS public.root_license_current;
DROP INDEX IF EXISTS public.root_audit_at;
DROP INDEX IF EXISTS public.device_type_status;
DROP INDEX IF EXISTS public.device_type_manufacturer;
ALTER TABLE IF EXISTS ONLY public.root_user DROP CONSTRAINT IF EXISTS root_user_username_key;
ALTER TABLE IF EXISTS ONLY public.root_user DROP CONSTRAINT IF EXISTS root_user_pkey;
ALTER TABLE IF EXISTS ONLY public.root_tenant DROP CONSTRAINT IF EXISTS root_tenant_pkey;
ALTER TABLE IF EXISTS ONLY public.root_signing_key DROP CONSTRAINT IF EXISTS root_signing_key_pkey;
ALTER TABLE IF EXISTS ONLY public.root_session DROP CONSTRAINT IF EXISTS root_session_pkey;
ALTER TABLE IF EXISTS ONLY public.root_release DROP CONSTRAINT IF EXISTS root_release_pkey;
ALTER TABLE IF EXISTS ONLY public.root_release DROP CONSTRAINT IF EXISTS root_release_component_version_key;
ALTER TABLE IF EXISTS ONLY public.root_license DROP CONSTRAINT IF EXISTS root_license_pkey;
ALTER TABLE IF EXISTS ONLY public.root_global_config DROP CONSTRAINT IF EXISTS root_global_config_pkey;
ALTER TABLE IF EXISTS ONLY public.root_checkin DROP CONSTRAINT IF EXISTS root_checkin_pkey;
ALTER TABLE IF EXISTS ONLY public.root_audit DROP CONSTRAINT IF EXISTS root_audit_pkey;
ALTER TABLE IF EXISTS ONLY public.device_type_source DROP CONSTRAINT IF EXISTS device_type_source_pkey;
ALTER TABLE IF EXISTS ONLY public.device_type DROP CONSTRAINT IF EXISTS device_type_pkey;
ALTER TABLE IF EXISTS ONLY public.device_protocol DROP CONSTRAINT IF EXISTS device_protocol_pkey;
ALTER TABLE IF EXISTS ONLY public.device_protocol_lane DROP CONSTRAINT IF EXISTS device_protocol_lane_pkey;
ALTER TABLE IF EXISTS ONLY public.device_manufacturer DROP CONSTRAINT IF EXISTS device_manufacturer_pkey;
ALTER TABLE IF EXISTS ONLY public.device_connection_type DROP CONSTRAINT IF EXISTS device_connection_type_pkey;
ALTER TABLE IF EXISTS public.root_user ALTER COLUMN id DROP DEFAULT;
ALTER TABLE IF EXISTS public.root_audit ALTER COLUMN id DROP DEFAULT;
DROP SEQUENCE IF EXISTS public.root_user_id_seq;
DROP TABLE IF EXISTS public.root_user;
DROP TABLE IF EXISTS public.root_tenant;
DROP TABLE IF EXISTS public.root_signing_key;
DROP TABLE IF EXISTS public.root_session;
DROP TABLE IF EXISTS public.root_release;
DROP TABLE IF EXISTS public.root_license;
DROP TABLE IF EXISTS public.root_global_config;
DROP TABLE IF EXISTS public.root_checkin;
DROP SEQUENCE IF EXISTS public.root_audit_id_seq;
DROP TABLE IF EXISTS public.root_audit;
DROP TABLE IF EXISTS public.device_type_source;
DROP TABLE IF EXISTS public.device_type;
DROP TABLE IF EXISTS public.device_protocol_lane;
DROP TABLE IF EXISTS public.device_protocol;
DROP TABLE IF EXISTS public.device_manufacturer;
DROP TABLE IF EXISTS public.device_connection_type;
SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: device_connection_type; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.device_connection_type (
    connection_type text NOT NULL,
    standard text,
    speed text,
    range text,
    use_case text,
    source_id text
);


--
-- Name: device_manufacturer; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.device_manufacturer (
    manufacturer_code text NOT NULL,
    name text NOT NULL,
    country text,
    hl7_v2_support text,
    fhir_support text,
    wifi_support text,
    primary_integration text,
    market_segment text,
    source_id text
);


--
-- Name: device_protocol; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.device_protocol (
    protocol text NOT NULL,
    version text,
    transport text,
    data_format text,
    use_case text,
    vendors text,
    source_id text
);


--
-- Name: device_protocol_lane; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.device_protocol_lane (
    lane_no integer NOT NULL,
    manufacturer_code text NOT NULL,
    family text NOT NULL,
    models text NOT NULL,
    protocol text NOT NULL,
    adapter text NOT NULL,
    note text,
    source_id text
);


--
-- Name: device_type; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.device_type (
    device_type_id text NOT NULL,
    manufacturer_code text NOT NULL,
    manufacturer text NOT NULL,
    country text,
    category text NOT NULL,
    series text,
    model text NOT NULL,
    is_family boolean DEFAULT false NOT NULL,
    year_released integer,
    care_area text,
    display_size text,
    hl7_v2 text,
    hl7_fhir text,
    ieee_11073 text,
    dicom text,
    wifi text,
    wifi_standard text,
    lan text,
    bluetooth text,
    usb text,
    cellular text,
    integration_method text,
    flora_protocol text,
    flora_adapter text,
    gateway_device_types text[] DEFAULT '{}'::text[] NOT NULL,
    status text DEFAULT 'reference_only'::text NOT NULL,
    notes text,
    sources text[] DEFAULT '{}'::text[] NOT NULL,
    updated_at bigint NOT NULL,
    CONSTRAINT device_type_status_check CHECK ((status = ANY (ARRAY['validated'::text, 'integration_tested'::text, 'driver_in_code'::text, 'to_validate'::text, 'reference_only'::text])))
);


--
-- Name: device_type_source; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.device_type_source (
    source_id text NOT NULL,
    title text NOT NULL,
    kind text NOT NULL,
    file_name text,
    sha256 text,
    description text,
    imported_at bigint NOT NULL,
    CONSTRAINT device_type_source_kind_check CHECK ((kind = ANY (ARRAY['spreadsheet'::text, 'image'::text, 'manual'::text])))
);


--
-- Name: root_audit; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.root_audit (
    id bigint NOT NULL,
    at bigint NOT NULL,
    username text,
    action text NOT NULL,
    target text,
    ip text,
    detail jsonb DEFAULT '{}'::jsonb NOT NULL
);


--
-- Name: root_audit_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.root_audit_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: root_audit_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.root_audit_id_seq OWNED BY public.root_audit.id;


--
-- Name: root_checkin; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.root_checkin (
    tenant_id text NOT NULL,
    last_seen_at bigint NOT NULL,
    canopy_version text,
    bundle_id text,
    usage jsonb DEFAULT '{}'::jsonb NOT NULL
);


--
-- Name: root_global_config; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.root_global_config (
    key text NOT NULL,
    value jsonb NOT NULL,
    updated_at bigint NOT NULL
);


--
-- Name: root_license; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.root_license (
    bundle_id text NOT NULL,
    tenant_id text NOT NULL,
    modules text[] NOT NULL,
    max_leaves integer NOT NULL,
    max_gateways integer NOT NULL,
    max_gateway_devices integer NOT NULL,
    device_types text[] DEFAULT '{}'::text[] NOT NULL,
    issued_at bigint NOT NULL,
    expires_at bigint NOT NULL,
    revoked_at bigint,
    current boolean DEFAULT true NOT NULL
);


--
-- Name: root_release; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.root_release (
    release_id text NOT NULL,
    component text NOT NULL,
    version text NOT NULL,
    channel text DEFAULT 'stable'::text NOT NULL,
    services jsonb NOT NULL,
    device_types jsonb DEFAULT '[]'::jsonb NOT NULL,
    notes text,
    created_at bigint NOT NULL,
    withdrawn_at bigint,
    CONSTRAINT root_release_component_check CHECK ((component = ANY (ARRAY['canopy'::text, 'leaf'::text, 'gateway'::text])))
);


--
-- Name: root_session; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.root_session (
    token_hash text NOT NULL,
    user_id bigint NOT NULL,
    created_at bigint NOT NULL,
    expires_at bigint NOT NULL,
    last_seen_at bigint NOT NULL,
    ip text,
    user_agent text
);


--
-- Name: root_signing_key; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.root_signing_key (
    key_id text NOT NULL,
    private_pem text NOT NULL,
    public_raw text NOT NULL,
    active boolean DEFAULT true NOT NULL,
    created_at bigint NOT NULL
);


--
-- Name: root_tenant; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.root_tenant (
    tenant_id text NOT NULL,
    name text NOT NULL,
    region text,
    status text DEFAULT 'active'::text NOT NULL,
    api_key_hash text NOT NULL,
    created_at bigint NOT NULL,
    updated_at bigint NOT NULL,
    release_channel text DEFAULT 'stable'::text NOT NULL,
    CONSTRAINT root_tenant_status_check CHECK ((status = ANY (ARRAY['active'::text, 'suspended'::text])))
);


--
-- Name: root_user; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.root_user (
    id bigint NOT NULL,
    username text NOT NULL,
    password_hash text NOT NULL,
    display_name text,
    role text DEFAULT 'viewer'::text NOT NULL,
    enabled boolean DEFAULT true NOT NULL,
    must_change_password boolean DEFAULT false NOT NULL,
    failed_logins integer DEFAULT 0 NOT NULL,
    locked_until bigint,
    created_at bigint NOT NULL,
    updated_at bigint NOT NULL,
    last_login_at bigint,
    CONSTRAINT root_user_role_check CHECK ((role = ANY (ARRAY['admin'::text, 'viewer'::text])))
);


--
-- Name: root_user_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.root_user_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: root_user_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.root_user_id_seq OWNED BY public.root_user.id;


--
-- Name: root_audit id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.root_audit ALTER COLUMN id SET DEFAULT nextval('public.root_audit_id_seq'::regclass);


--
-- Name: root_user id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.root_user ALTER COLUMN id SET DEFAULT nextval('public.root_user_id_seq'::regclass);


--
-- Data for Name: device_connection_type; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.device_connection_type (connection_type, standard, speed, range, use_case, source_id) FROM stdin;
WiFi 802.11b	IEEE 802.11b (2.4 GHz)	11 Mbps	35m indoor	Legacy monitors; basic wireless; avoid for new deployments	Patient_Monitor_Database.xlsx
WiFi 802.11g	IEEE 802.11g (2.4 GHz)	54 Mbps	38m indoor	Older Dräger Infinity; still functional but limited	Patient_Monitor_Database.xlsx
WiFi 802.11n	IEEE 802.11n (2.4/5 GHz)	600 Mbps	70m indoor	Most common in current monitors; dual-band capable; recommended minimum	Patient_Monitor_Database.xlsx
WiFi 802.11ac	IEEE 802.11ac (5 GHz)	6.9 Gbps	35m indoor	Newer premium monitors (Philips MX750, NK G7, Mindray N22); faster throughput	Patient_Monitor_Database.xlsx
WiFi 802.11ax	IEEE 802.11ax (WiFi 6)	9.6 Gbps	30m indoor	Latest monitors (2024+); better density handling; ideal for ICU with many devices	Patient_Monitor_Database.xlsx
Ethernet 100M	IEEE 802.3u (100BASE-TX)	100 Mbps	100m cable	Standard for bedside fixed installation; reliable, no interference	Patient_Monitor_Database.xlsx
Ethernet 1G	IEEE 802.3ab (1000BASE-T)	1 Gbps	100m cable	Premium monitors and central stations; recommended for high-throughput	Patient_Monitor_Database.xlsx
Bluetooth Classic	Bluetooth 2.1 + EDR	3 Mbps	~10m	Welch Allyn peripherals; Zoll data transfer; legacy pairing	Patient_Monitor_Database.xlsx
BLE (Bluetooth Low Energy)	Bluetooth 4.0+ / 5.0	2 Mbps	~50m	NK G7/G3 wearable sensors; Masimo; transport handoff; low power	Patient_Monitor_Database.xlsx
USB	USB 2.0 / 3.0	480 Mbps / 5 Gbps	5m cable	Data export; firmware update; serial-over-USB for legacy devices	Patient_Monitor_Database.xlsx
RS-232 Serial	EIA/TIA-232	115.2 Kbps	15m cable	Legacy device output; direct cable connection; requires adapter	Patient_Monitor_Database.xlsx
Cellular (4G/5G)	LTE / 5G NR	100+ Mbps	km range	Zoll Propaq (ambulance); telemedicine; remote monitoring scenarios	Patient_Monitor_Database.xlsx
MLLP (TCP)	HL7 Minimum Lower Layer Protocol	Network speed	Network	Primary transport for HL7 v2.x messages between monitor and gateway/EMR	Patient_Monitor_Database.xlsx
\.


--
-- Data for Name: device_manufacturer; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.device_manufacturer (manufacturer_code, name, country, hl7_v2_support, fhir_support, wifi_support, primary_integration, market_segment, source_id) FROM stdin;
philips	Philips	Netherlands	All models	No (roadmap)	Most models	IntelliVue Information Center + IntelliBridge	Premium / Global leader	Patient_Monitor_Database.xlsx
ge	GE Healthcare	USA	All models	Partial (B850/ONE)	Most models	CARESCAPE Gateway + CIC Pro	Premium / Critical care	Patient_Monitor_Database.xlsx
mindray	Mindray	China	All models	Partial (N22/N17)	Most models	eGateway + BeneVision CMS	Mid-premium / Fastest growing	Patient_Monitor_Database.xlsx
nihon-kohden	Nihon Kohden	Japan	All models	Partial (G7/G5Max)	Most models	CGS-9002 HL7 Gateway + NK-HiQ	Premium / Strong in Japan/Asia	Patient_Monitor_Database.xlsx
draeger	Dräger	Germany	All models	No	All models	MIB module + Infinity CentralStation	Premium / OR + ICU specialist	Patient_Monitor_Database.xlsx
spacelabs	Spacelabs	USA	All models	No	All models	Vital Signs Interface (HL7) + Intesys CMS	Mid-range / US market	Patient_Monitor_Database.xlsx
edan	Edan	China	All models	No	All models	HL7/XML direct + MFM-CMS	Mid-range / Value leader	Patient_Monitor_Database.xlsx
biolight	Biolight	China	Optional	No	Optional	HL7 optional module + CMS	Budget-mid / OEM supplier	Patient_Monitor_Database.xlsx
comen	Comen	China	Most models	No	Most models	HL7 + CMS central station	Budget-mid / Domestic China + export	Patient_Monitor_Database.xlsx
schiller	Schiller	Switzerland	All models	No	Most models	HL7 + SEMA central station	Mid-range / Europe + emerging markets	Patient_Monitor_Database.xlsx
welch-allyn	Welch Allyn (Baxter)	USA	Most models	No	All models	HL7 wireless direct + Connex Hub	Spot monitoring / Global leader	Patient_Monitor_Database.xlsx
masimo	Masimo	USA	Root/Rad-7	No	Root only	HL7 + Patient SafetyNet + Iris	SpO2 specialist / Premium sensors	Patient_Monitor_Database.xlsx
fukuda	Fukuda Denshi	Japan	All models	No	Select models	HL7 Gateway + DS-NET	Mid-range / Strong Japan/SE Asia	Patient_Monitor_Database.xlsx
zoll	Zoll	USA	All models	No	All models	HL7 + WiFi/BT/cellular + RescueNet	Transport/EMS / Rugged military	Patient_Monitor_Database.xlsx
bpl	BPL Medical	India	Yes/Optional	No	Optional	HL7 optional + CMS	Budget / India + South Asia	Patient_Monitor_Database.xlsx
contec	Contec Medical	China	Optional/No	No	Optional	Basic CMS; limited EMR	Budget / Global emerging markets	Patient_Monitor_Database.xlsx
mediana	Mediana	South Korea	All models	No	Yes/Optional	HL7 + CMS	Mid-range / Korean market	Patient_Monitor_Database.xlsx
skanray	Skanray	India	Yes	No	Optional	HL7 optional + CMS	Budget-mid / India export	Patient_Monitor_Database.xlsx
infinium	Infinium Medical	USA	All models	No	Yes/Optional	HL7 direct + CMS	Mid-range / USA domestic	Patient_Monitor_Database.xlsx
hamilton	Hamilton Medical	Switzerland	Yes	Partial	Yes	HL7 + PDMS (ventilator focus)	ICU ventilator with monitoring	Patient_Monitor_Database.xlsx
siemens	Siemens Healthineers	Germany	Yes (legacy)	No	No (legacy)	Infinity Gateway (now Dräger)	Legacy / Serviced by Dräger	Patient_Monitor_Database.xlsx
bbraun	B. Braun	Germany	\N	\N	\N	BCC protocol	\N	flora-protocol-compatibility-map.webp
fresenius	Fresenius Kabi	Germany	\N	\N	\N	Agilia Serial Export Protocol	\N	flora-protocol-compatibility-map.webp
progetti	Progetti	Italy	\N	\N	\N	Native HL7	\N	flora-protocol-compatibility-map.webp
\.


--
-- Data for Name: device_protocol; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.device_protocol (protocol, version, transport, data_format, use_case, vendors, source_id) FROM stdin;
HL7 v2.x	v2.3 / v2.5 / v2.7	TCP/IP (MLLP)	Pipe-delimited segments (MSH, PID, OBX)	ADT messages, vital signs (ORU^R01), orders (ORM), results — most common protocol for bedside-to-EMR	All major vendors (Philips, GE, Mindray, NK, Dräger, etc.)	Patient_Monitor_Database.xlsx
HL7 FHIR	R4 (STU)	HTTP/REST + JSON	FHIR Resources (Observation, Patient, Device)	Modern interoperability; external data exchange; cloud-based monitoring; newer devices starting to support	Newer models from GE, Mindray, NK G7; Masimo; growing adoption	Patient_Monitor_Database.xlsx
IEEE 11073	11073-10201 (DIM)\n11073-20601 (PHD)	TCP/IP or BLE	Binary ASN.1 / XML	Device-to-device communication; standard nomenclature for vitals; maps to FHIR via PoCD/PHD IG	Philips, GE, NK, Dräger, Fukuda (higher-end models)	Patient_Monitor_Database.xlsx
DICOM	3.0	TCP/IP	Binary DICOM format	Medical imaging (CT, MRI, X-ray, ultrasound); not typical for bedside monitors but relevant for imaging integration	Imaging modalities; some high-end monitors with waveform export	Patient_Monitor_Database.xlsx
IHE PCD	PCD-01 (DEC)\nPCD-03 (ACM)	HL7 v2 messages	HL7 v2 encapsulated IEEE 11073	IHE Device Enterprise Communication profile; alarm communication; standard integration profile	GE, Philips, Dräger, NK — via gateway/central station	Patient_Monitor_Database.xlsx
Proprietary Serial	Vendor-specific	RS-232 / USB serial	Binary or ASCII	Legacy devices; direct serial output of vitals data; requires vendor-specific adapter/parser	Older monitors from all vendors; some Biolight, Contec models	Patient_Monitor_Database.xlsx
BLE GATT	Bluetooth 4.0+\n(Low Energy)	BLE	GATT Services (Heart Rate, BP, SpO2)	Personal health devices, wearables, transport monitors; maps to IEEE 11073-20601	NK G7/G3, Zoll Propaq, Welch Allyn, Masimo	Patient_Monitor_Database.xlsx
WiFi (Data)	802.11a/b/g/n/ac/ax	TCP/IP or UDP/IP	Varies by vendor	Wireless networking for bedside monitors; real-time data to central station; transport monitoring continuity	Nearly all modern monitors from 2015+	Patient_Monitor_Database.xlsx
\.


--
-- Data for Name: device_protocol_lane; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.device_protocol_lane (lane_no, manufacturer_code, family, models, protocol, adapter, note, source_id) FROM stdin;
1	ge	GE anaesthesia, ventilation and patient monitors	Carestation 750; Aestiva; Aespire; Avance; Aisys; Carestation 600 / 620 / 650; Engström; CARESCAPE R860; B105; B125; B450; B650; B850	GE Datex-Ohmeda S/5 / CARESCAPE protocols	Serial / Ethernet adapters	\N	flora-protocol-compatibility-map.webp
2	philips	Philips IntelliVue	MP5; MP20–MP90; MX400–MX850; Avalon FM20–FM50	Philips IntelliVue native protocol	LAN or MIB / RS-232	Native IntelliVue, not through a vendor gateway	flora-protocol-compatibility-map.webp
3	draeger	Dräger IACS	Infinity M540	IACS UDP multicast	Network listener	\N	flora-protocol-compatibility-map.webp
4	draeger	Dräger MEDIBUS.X	Atlan; Perseus A500; Primus; Apollo; Fabius; Zeus; Evita; Savina; Carina; Oxylog; Babylog	MEDIBUS.X	RS-232	\N	flora-protocol-compatibility-map.webp
5	draeger	Dräger Vista family	Vista 120; Vista 120 S; Vista 120 SC	Vista Gateway / CMS → HL7	TCP/IP HL7 receiver	\N	flora-protocol-compatibility-map.webp
6	bbraun	B. Braun Space	Space pumps via SpaceCom / SpaceStation	BCC protocol	LAN or RS-232	\N	flora-protocol-compatibility-map.webp
7	fresenius	Fresenius Kabi Agilia	Agilia Injectomat; Agilia Volumat; Injectomat TCI; Agilia Link+	Agilia Serial Export Protocol	RS-232 / USB or TCP via Link+	\N	flora-protocol-compatibility-map.webp
8	progetti	Progetti PG RIA	PG RIA 3; PG RIA 5; PG RIA 9	Native HL7	LAN / Wi-Fi	\N	flora-protocol-compatibility-map.webp
9	mindray	Mindray BeneVision	N12; N15; N17	Native HL7	TCP/IP	Also compatible native-HL7 Mindray families	flora-protocol-compatibility-map.webp
\.


--
-- Data for Name: device_type; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.device_type (device_type_id, manufacturer_code, manufacturer, country, category, series, model, is_family, year_released, care_area, display_size, hl7_v2, hl7_fhir, ieee_11073, dicom, wifi, wifi_standard, lan, bluetooth, usb, cellular, integration_method, flora_protocol, flora_adapter, gateway_device_types, status, notes, sources, updated_at) FROM stdin;
bbraun-space-pumps-via-spacecom-spacestation	bbraun	B. Braun	Germany	infusion_pump	B. Braun Space	Space pumps via SpaceCom / SpaceStation	t	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	BCC protocol	LAN or RS-232	{bbraun-space-bcc}	driver_in_code	\N	{flora-protocol-compatibility-map.webp}	1791866236730
biolight-a3-a2e	biolight	Biolight	China	patient_monitor	AnyView	A3/A2E	t	2017	Ward / Transport	7"	No	No	No	No	Optional	802.11b/g/n	Yes	No	Yes	No	CMS only; limited EMR integration	\N	\N	{}	reference_only	Compact entry-level; transport	{Patient_Monitor_Database.xlsx}	1791866236730
biolight-a6-a5	biolight	Biolight	China	patient_monitor	AnyView	A6/A5	t	2018	Ward / ER	12"/10"	Optional	No	No	No	Optional	802.11b/g/n	Yes	No	Yes	No	HL7 optional; CMS	\N	\N	{}	reference_only	Mid-range	{Patient_Monitor_Database.xlsx}	1791866236730
biolight-a8	biolight	Biolight	China	patient_monitor	AnyView	A8	f	2019	ICU / OR	15"	Optional	No	No	No	Optional	802.11b/g/n	Yes	No	Yes	No	HL7 optional module; CMS integration	\N	\N	{}	reference_only	Modular high-end; neonatal capable	{Patient_Monitor_Database.xlsx}	1791866236730
bpl-excello	bpl	BPL Medical	India	patient_monitor	Excello	Excello	f	2018	Ward / OPD	10"	Optional	No	No	No	Optional	802.11b/g/n	Yes	No	Yes	No	HL7 optional; basic CMS	\N	\N	{}	reference_only	Cost-effective for emerging markets	{Patient_Monitor_Database.xlsx}	1791866236730
bpl-ultima-prime	bpl	BPL Medical	India	patient_monitor	Ultima Prime	Ultima Prime	f	2020	ICU / Ward	12.1"	Yes	No	No	No	Optional	802.11b/g/n	Yes	No	Yes	No	HL7 optional; CMS networking	\N	\N	{}	reference_only	Popular in India/South Asia	{Patient_Monitor_Database.xlsx}	1791866236730
comen-c100-c80-c60	comen	Comen	China	patient_monitor	C	C100/C80/C60	t	2019	Ward / OPD	12"/10"/8"	Optional	No	No	No	Optional	802.11b/g/n	Yes	No	Yes	No	HL7 optional; central monitoring	\N	\N	{}	reference_only	Cost-effective range	{Patient_Monitor_Database.xlsx}	1791866236730
comen-star-8000-star-5000	comen	Comen	China	patient_monitor	STAR	STAR 8000/STAR 5000	t	2018	Ward / ER	15"/12"	Yes	No	No	No	Yes	802.11b/g/n	Yes	No	Yes	No	HL7; CMS central station	\N	\N	{}	reference_only	Mid-range series	{Patient_Monitor_Database.xlsx}	1791866236730
comen-star-8800	comen	Comen	China	patient_monitor	STAR	STAR 8800	f	2020	ICU / OR	17"	Yes	No	No	No	Yes	802.11a/b/g/n	Yes	No	Yes	No	HL7 to EMR; CMS networking	\N	\N	{}	reference_only	Modular; touchscreen	{Patient_Monitor_Database.xlsx}	1791866236730
contec-cms-6000-5100	contec	Contec Medical	China	patient_monitor	CMS	CMS 6000/5100	t	2018	Ward / OPD	7"	No	No	No	No	Optional	802.11b/g	Yes	No	Yes	No	Basic CMS networking; limited EMR	\N	\N	{}	reference_only	Entry-level; popular in SE Asia/Africa	{Patient_Monitor_Database.xlsx}	1791866236730
contec-cms-9200-8000	contec	Contec Medical	China	patient_monitor	CMS	CMS 9200/8000	t	2019	ICU / Ward	15"/12"	Optional	No	No	No	Optional	802.11b/g/n	Yes	No	Yes	No	HL7 optional; CMS central	\N	\N	{}	reference_only	Budget; wide global distribution	{Patient_Monitor_Database.xlsx}	1791866236730
draeger-acute-care-system-acs	draeger	Dräger	Germany	patient_monitor	Infinity	Acute Care System (ACS)	f	2015	ICU / OR	Variable	Yes	No	Yes	No	Yes	802.11a/b/g/n	Yes	No	Yes	No	MIB for HL7; WinAccess API for custom integration	\N	\N	{}	reference_only	Modular system; Perseus A500 anesthesia integration	{Patient_Monitor_Database.xlsx}	1791866236730
draeger-apollo	draeger	Dräger	Germany	anesthesia_machine	Dräger MEDIBUS.X	Apollo	f	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	MEDIBUS.X	RS-232	{draeger-medibus}	driver_in_code	\N	{flora-protocol-compatibility-map.webp}	1791866236730
draeger-atlan	draeger	Dräger	Germany	anesthesia_machine	Dräger MEDIBUS.X	Atlan	f	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	MEDIBUS.X	RS-232	{draeger-medibus}	driver_in_code	\N	{flora-protocol-compatibility-map.webp}	1791866236730
draeger-babylog	draeger	Dräger	Germany	ventilator	Dräger MEDIBUS.X	Babylog	f	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	MEDIBUS.X	RS-232	{draeger-medibus}	driver_in_code	\N	{flora-protocol-compatibility-map.webp}	1791866236730
draeger-carina	draeger	Dräger	Germany	ventilator	Dräger MEDIBUS.X	Carina	f	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	MEDIBUS.X	RS-232	{draeger-medibus}	driver_in_code	\N	{flora-protocol-compatibility-map.webp}	1791866236730
draeger-delta	draeger	Dräger	Germany	patient_monitor	Infinity	Delta	f	2008	Ward / ER	12"	Yes	No	Yes	No	Yes	802.11g (WPA2)	Yes	No	Yes	No	Infinity CentralStation; MIB for HL7	\N	\N	{}	reference_only	Compact version of Delta XL	{Patient_Monitor_Database.xlsx}	1791866236730
draeger-delta-xl	draeger	Dräger	Germany	patient_monitor	Infinity	Delta XL	f	2008	ICU / OR	15"	Yes	No	Yes	No	Yes	802.11g (WPA2)	Yes	No	Yes	No	Infinity Network; MIB module for HL7; DirectNet	\N	\N	{}	reference_only	Flexible acuity. Docking station networking	{Patient_Monitor_Database.xlsx}	1791866236730
draeger-evita	draeger	Dräger	Germany	ventilator	Dräger MEDIBUS.X	Evita	f	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	MEDIBUS.X	RS-232	{draeger-medibus}	driver_in_code	\N	{flora-protocol-compatibility-map.webp}	1791866236730
draeger-fabius	draeger	Dräger	Germany	anesthesia_machine	Dräger MEDIBUS.X	Fabius	f	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	MEDIBUS.X	RS-232	{draeger-medibus}	driver_in_code	\N	{flora-protocol-compatibility-map.webp}	1791866236730
draeger-infinity-m540	draeger	Dräger	Germany	patient_monitor	Dräger IACS	Infinity M540	f	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	IACS UDP multicast	Network listener	{draeger-iacs-m540}	driver_in_code	\N	{flora-protocol-compatibility-map.webp}	1791866236730
draeger-oxylog	draeger	Dräger	Germany	ventilator	Dräger MEDIBUS.X	Oxylog	f	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	MEDIBUS.X	RS-232	{draeger-medibus}	driver_in_code	\N	{flora-protocol-compatibility-map.webp}	1791866236730
draeger-perseus-a500	draeger	Dräger	Germany	anesthesia_machine	Dräger MEDIBUS.X	Perseus A500	f	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	MEDIBUS.X	RS-232	{draeger-medibus}	driver_in_code	\N	{flora-protocol-compatibility-map.webp}	1791866236730
draeger-primus	draeger	Dräger	Germany	anesthesia_machine	Dräger MEDIBUS.X	Primus	f	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	MEDIBUS.X	RS-232	{draeger-medibus}	driver_in_code	\N	{flora-protocol-compatibility-map.webp}	1791866236730
draeger-savina	draeger	Dräger	Germany	ventilator	Dräger MEDIBUS.X	Savina	f	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	MEDIBUS.X	RS-232	{draeger-medibus}	driver_in_code	\N	{flora-protocol-compatibility-map.webp}	1791866236730
draeger-vista-120	draeger	Dräger	Germany	patient_monitor	Dräger Vista family	Vista 120	f	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	Vista Gateway / CMS → HL7	TCP/IP HL7 receiver	{}	to_validate	\N	{flora-protocol-compatibility-map.webp}	1791866236730
draeger-vista-120-s	draeger	Dräger	Germany	patient_monitor	Vista 120 S	Vista 120 S	f	2018	Ward / ER	12.1"	Yes	No	No	No	Yes	802.11a/b/g/n	Yes	No	Yes	No	HL7 via Infinity Gateway; Networking option	Vista Gateway / CMS → HL7	TCP/IP HL7 receiver	{draeger-vista-120s}	driver_in_code	Standalone; non-Infinity network option	{Patient_Monitor_Database.xlsx,flora-protocol-compatibility-map.webp}	1791866236730
draeger-vista-120-sc	draeger	Dräger	Germany	patient_monitor	Dräger Vista family	Vista 120 SC	f	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	Vista Gateway / CMS → HL7	TCP/IP HL7 receiver	{}	to_validate	\N	{flora-protocol-compatibility-map.webp}	1791866236730
draeger-vista-xl	draeger	Dräger	Germany	patient_monitor	Infinity	Vista XL	f	2010	ICU / NICU	19"	Yes	No	Yes	No	Yes	802.11g (WPA2)	Yes	No	Yes	No	Infinity CentralStation; MIB (Medical Info Bus) for HL7; IEEE 1073	\N	\N	{}	reference_only	High-end ICU. Modular Infinity architecture	{Patient_Monitor_Database.xlsx}	1791866236730
draeger-zeus	draeger	Dräger	Germany	anesthesia_machine	Dräger MEDIBUS.X	Zeus	f	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	MEDIBUS.X	RS-232	{draeger-medibus}	driver_in_code	\N	{flora-protocol-compatibility-map.webp}	1791866236730
edan-elite-v8	edan	Edan	China	patient_monitor	Elite V	Elite V8	f	2022	ICU / OR	17"	Yes	No	No	No	Yes	802.11a/b/g/n	Yes	No	Yes	No	HL7/XML to EMR; MFM-CMS central station	\N	\N	{}	reference_only	High-end modular; expandable slots	{Patient_Monitor_Database.xlsx}	1791866236730
edan-im20-im50	edan	Edan	China	patient_monitor	iM	iM20/iM50	t	2017	Ward / OPD	10.1"	Yes	No	No	No	Yes	802.11b/g/n	Yes	No	Yes	No	HL7 + WiFi to CMS and EMR	\N	\N	{}	reference_only	Entry to mid-range; internal memory	{Patient_Monitor_Database.xlsx}	1791866236730
edan-im60	edan	Edan	China	patient_monitor	iM	iM60	f	2018	Ward / ER	10.1"	Yes	No	No	No	Yes	802.11a/b/g/n	Yes	No	Yes	No	HL7 direct; WiFi; LAN; MFM-CMS	\N	\N	{}	reference_only	Compact; defibrillator sync	{Patient_Monitor_Database.xlsx}	1791866236730
edan-im70	edan	Edan	China	patient_monitor	iM	iM70	f	2019	ICU / Ward	12.1"	Yes	No	No	No	Yes	802.11a/b/g/n	Yes	No	Yes	No	HL7 direct; LAN; MFM-CMS; Nurse Call	\N	\N	{}	reference_only	Popular mid-range; good value	{Patient_Monitor_Database.xlsx}	1791866236730
edan-im80	edan	Edan	China	patient_monitor	iM	iM80	f	2021	ICU / ER	15"	Yes	No	No	No	Yes	802.11a/b/g/n	Yes	No	Yes	No	HL7 + XML direct to EMR; MFM-CMS	\N	\N	{}	reference_only	Built-in WiFi + HL7	{Patient_Monitor_Database.xlsx}	1791866236730
fresenius-agilia-injectomat	fresenius	Fresenius Kabi	Germany	infusion_pump	Fresenius Kabi Agilia	Agilia Injectomat	f	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	Agilia Serial Export Protocol	RS-232 / USB or TCP via Link+	{}	to_validate	\N	{flora-protocol-compatibility-map.webp}	1791866236730
fresenius-agilia-link	fresenius	Fresenius Kabi	Germany	docking_station	Fresenius Kabi Agilia	Agilia Link+	f	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	Agilia Serial Export Protocol	RS-232 / USB or TCP via Link+	{}	to_validate	\N	{flora-protocol-compatibility-map.webp}	1791866236730
fresenius-agilia-volumat	fresenius	Fresenius Kabi	Germany	infusion_pump	Fresenius Kabi Agilia	Agilia Volumat	f	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	Agilia Serial Export Protocol	RS-232 / USB or TCP via Link+	{}	to_validate	\N	{flora-protocol-compatibility-map.webp}	1791866236730
fresenius-injectomat-tci	fresenius	Fresenius Kabi	Germany	infusion_pump	Fresenius Kabi Agilia	Injectomat TCI	f	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	Agilia Serial Export Protocol	RS-232 / USB or TCP via Link+	{}	to_validate	\N	{flora-protocol-compatibility-map.webp}	1791866236730
fukuda-ds-7700	fukuda	Fukuda Denshi	Japan	patient_monitor	Dynascope	DS-7700	f	2010	ICU / Ward	12.1"	Yes	No	Yes	No	No	N/A	Yes	No	Yes	No	HL7 via DS-NET gateway	\N	\N	{}	reference_only	Legacy; still widely used in Asia	{Patient_Monitor_Database.xlsx}	1791866236730
fukuda-ds-8007	fukuda	Fukuda Denshi	Japan	patient_monitor	DS	DS-8007	f	2018	Ward / Transport	7"	Yes	No	No	No	Optional	802.11b/g/n	Yes	No	Yes	No	HL7 Gateway; portable	\N	\N	{}	reference_only	Compact portable	{Patient_Monitor_Database.xlsx}	1791866236730
fukuda-ds-8500	fukuda	Fukuda Denshi	Japan	patient_monitor	DS	DS-8500	f	2016	ICU / Ward	12.1"	Yes	No	Yes	No	Optional	802.11b/g/n	Yes	No	Yes	No	HL7 via Gateway; DS-NET	\N	\N	{}	reference_only	Mid-range bedside	{Patient_Monitor_Database.xlsx}	1791866236730
fukuda-ds-8900	fukuda	Fukuda Denshi	Japan	patient_monitor	DS	DS-8900	f	2020	ICU / OR	19"	Yes	No	Yes	No	Yes	802.11a/b/g/n	Yes	No	Yes	No	HL7 via Gateway; DS-NET networking	\N	\N	{}	reference_only	Flagship touchscreen; modular	{Patient_Monitor_Database.xlsx}	1791866236730
ge-aespire	ge	GE	USA	anesthesia_machine	GE anaesthesia, ventilation and patient monitors	Aespire	f	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	GE Datex-Ohmeda S/5 / CARESCAPE protocols	Serial / Ethernet adapters	{}	to_validate	\N	{flora-protocol-compatibility-map.webp}	1791866236730
ge-aestiva	ge	GE	USA	anesthesia_machine	GE anaesthesia, ventilation and patient monitors	Aestiva	f	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	GE Datex-Ohmeda S/5 / CARESCAPE protocols	Serial / Ethernet adapters	{}	to_validate	\N	{flora-protocol-compatibility-map.webp}	1791866236730
ge-aisys	ge	GE	USA	anesthesia_machine	GE anaesthesia, ventilation and patient monitors	Aisys	f	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	GE Datex-Ohmeda S/5 / CARESCAPE protocols	Serial / Ethernet adapters	{ge-aisys-cs2,ge-aisys-dri}	driver_in_code	\N	{flora-protocol-compatibility-map.webp}	1791866236730
ge-avance	ge	GE	USA	anesthesia_machine	GE anaesthesia, ventilation and patient monitors	Avance	f	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	GE Datex-Ohmeda S/5 / CARESCAPE protocols	Serial / Ethernet adapters	{}	to_validate	\N	{flora-protocol-compatibility-map.webp}	1791866236730
ge-b105	ge	GE	USA	patient_monitor	GE anaesthesia, ventilation and patient monitors	B105	f	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	GE Datex-Ohmeda S/5 / CARESCAPE protocols	Serial / Ethernet adapters	{}	to_validate	\N	{flora-protocol-compatibility-map.webp}	1791866236730
ge-b125	ge	GE Healthcare	USA	patient_monitor	CARESCAPE	B125	f	2018	General Ward / OPD	12.1"	Yes	No	No	No	Optional	802.11b/g/n	Yes	No	Yes	No	CARESCAPE Gateway for HL7 ADT/results	GE Datex-Ohmeda S/5 / CARESCAPE protocols	Serial / Ethernet adapters	{}	to_validate	Essential care monitor; cost-effective	{Patient_Monitor_Database.xlsx,flora-protocol-compatibility-map.webp}	1791866236730
ge-b450	ge	GE Healthcare	USA	patient_monitor	CARESCAPE	B450	f	2012	General Ward / Transport	12.1"	Yes	No	Yes	No	Yes	802.11a/b/g/n	Yes	No	Yes	No	CARESCAPE Gateway; wireless transport capable	GE Datex-Ohmeda S/5 / CARESCAPE protocols	Serial / Ethernet adapters	{ge-bx50-dri}	driver_in_code	Lightweight; intra-hospital transport	{Patient_Monitor_Database.xlsx,flora-protocol-compatibility-map.webp}	1791866236730
ge-b650	ge	GE Healthcare	USA	patient_monitor	CARESCAPE	B650	f	2013	ICU / ER / OR	15"	Yes	Partial	Yes	No	Yes	802.11a/b/g/n	Yes	No	Yes	No	CARESCAPE Gateway for HL7; MC network	GE Datex-Ohmeda S/5 / CARESCAPE protocols	Serial / Ethernet adapters	{ge-bx50-dri}	driver_in_code	Mid-range ICU. EK-Pro ECG algorithm	{Patient_Monitor_Database.xlsx,flora-protocol-compatibility-map.webp}	1791866236730
ge-b850	ge	GE Healthcare	USA	patient_monitor	CARESCAPE	B850	f	2015	ICU / OR / NICU	18.5"	Yes	Partial	Yes	No	Yes	802.11a/b/g/n	Yes	No	Yes	No	CARESCAPE Gateway; CIC Pro central; HL7 export via Gateway	GE Datex-Ohmeda S/5 / CARESCAPE protocols	Serial / Ethernet adapters	{ge-bx50-dri}	driver_in_code	Flagship critical care. CARESCAPE ONE module	{Patient_Monitor_Database.xlsx,flora-protocol-compatibility-map.webp}	1791866236730
ge-carescape-one	ge	GE Healthcare	USA	parameter_module	CARESCAPE ONE	CARESCAPE ONE	f	2020	ICU / OR	Module	Yes	Partial	Yes	No	Yes	802.11a/b/g/n/ac	Yes	No	Yes	No	Plugs into B850/B650; CARESCAPE Gateway	\N	\N	{}	reference_only	Parameter acquisition module; next-gen PDM	{Patient_Monitor_Database.xlsx}	1791866236730
ge-carescape-r860	ge	GE	USA	ventilator	GE anaesthesia, ventilation and patient monitors	CARESCAPE R860	f	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	GE Datex-Ohmeda S/5 / CARESCAPE protocols	Serial / Ethernet adapters	{}	to_validate	\N	{flora-protocol-compatibility-map.webp}	1791866236730
ge-carestation-600-620-650	ge	GE	USA	anesthesia_machine	GE anaesthesia, ventilation and patient monitors	Carestation 600 / 620 / 650	t	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	GE Datex-Ohmeda S/5 / CARESCAPE protocols	Serial / Ethernet adapters	{}	to_validate	\N	{flora-protocol-compatibility-map.webp}	1791866236730
ge-carestation-750	ge	GE	USA	anesthesia_machine	GE anaesthesia, ventilation and patient monitors	Carestation 750	f	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	GE Datex-Ohmeda S/5 / CARESCAPE protocols	Serial / Ethernet adapters	{ge-carestation-750}	driver_in_code	\N	{flora-protocol-compatibility-map.webp}	1791866236730
ge-engstrom	ge	GE	USA	ventilator	GE anaesthesia, ventilation and patient monitors	Engström	f	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	GE Datex-Ohmeda S/5 / CARESCAPE protocols	Serial / Ethernet adapters	{}	to_validate	\N	{flora-protocol-compatibility-map.webp}	1791866236730
ge-procare-v100	ge	GE Healthcare	USA	patient_monitor	DINAMAP	ProCare V100	f	2015	OPD / Ward	7"	Yes	No	No	No	Optional	802.11b/g/n	Yes	No	Yes	No	HL7 spot-check to EMR	\N	\N	{}	reference_only	Vital signs spot monitor	{Patient_Monitor_Database.xlsx}	1791866236730
ge-solar-8000m-i	ge	GE Healthcare	USA	patient_monitor	Solar	Solar 8000M/i	t	2005	ICU / OR	12.1"	Yes	No	Yes	No	No	N/A	Yes	No	Yes	No	CIC Pro central station for HL7	\N	\N	{}	reference_only	Legacy but still in use globally	{Patient_Monitor_Database.xlsx}	1791866236730
hamilton-c6-with-monitoring	hamilton	Hamilton Medical	Switzerland	ventilator	IntelliCuff	C6 (with monitoring)	f	2021	ICU	12.1"	Yes	Partial	No	No	Yes	802.11a/b/g/n	Yes	No	Yes	No	HL7 to EMR; PDMS integration	\N	\N	{}	reference_only	Ventilator with integrated monitoring	{Patient_Monitor_Database.xlsx}	1791866236730
infinium-omni-ii	infinium	Infinium Medical	USA	patient_monitor	OMNI	OMNI II	f	2017	Ward / ER	12"	Yes	No	No	No	Optional	802.11b/g/n	Yes	No	Yes	No	HL7; CMS	\N	\N	{}	reference_only	Mid-range	{Patient_Monitor_Database.xlsx}	1791866236730
infinium-omni-k	infinium	Infinium Medical	USA	patient_monitor	OMNI	OMNI K	f	2019	ICU / OR	15"	Yes	No	No	No	Yes	802.11a/b/g/n	Yes	No	Yes	No	HL7 direct; CMS networking	\N	\N	{}	reference_only	Made in USA; competitive pricing	{Patient_Monitor_Database.xlsx}	1791866236730
masimo-patient-safetynet	masimo	Masimo	USA	central_station	SafetyNet	Patient SafetyNet	f	2014	Ward / Floor	Central	Yes	No	No	No	N/A	N/A	Yes	No	N/A	No	HL7 export to EMR; wireless sensor network	\N	\N	{}	reference_only	Central surveillance; floor-level monitoring	{Patient_Monitor_Database.xlsx}	1791866236730
masimo-radical-7	masimo	Masimo	USA	pulse_oximeter	Radical-7	Radical-7	f	2008	ICU / OR	4.3"	Yes	No	No	No	Optional	802.11b/g	Yes	Yes	Yes	No	HL7 via Root or Patient SafetyNet	\N	\N	{}	reference_only	SpO2/rainbow only; docks into Root	{Patient_Monitor_Database.xlsx}	1791866236730
masimo-root	masimo	Masimo	USA	patient_monitor	Root	Root	f	2014	ICU / OR / ER	7"	Yes	No	No	No	Yes	802.11a/b/g/n	Yes	Yes	Yes	No	HL7 to EMR; Iris platform; Patient SafetyNet	\N	\N	{}	reference_only	Root + Radical-7 SpO2 hub; rainbow SET	{Patient_Monitor_Database.xlsx}	1791866236730
mediana-ym1000	mediana	Mediana	South Korea	patient_monitor	YM	YM1000	f	2019	OPD / Ward	7"	Yes	No	No	No	Optional	802.11b/g/n	Yes	No	Yes	No	HL7; basic CMS	\N	\N	{}	reference_only	Vital signs monitor	{Patient_Monitor_Database.xlsx}	1791866236730
mediana-ym6000	mediana	Mediana	South Korea	patient_monitor	YM	YM6000	f	2020	ICU / Ward	15"	Yes	No	No	No	Yes	802.11a/b/g/n	Yes	No	Yes	No	HL7 to EMR; CMS networking	\N	\N	{}	reference_only	Growing brand; Korean hospitals	{Patient_Monitor_Database.xlsx}	1791866236730
mindray-epm-15m-12m-10m	mindray	Mindray	China	patient_monitor	ePM	ePM 15M/12M/10M	t	2020	Ward / ER	15"/12"/10"	Yes	No	No	No	Yes	802.11a/b/g/n	Yes	No	Yes	No	eGateway HL7; optional CMS	\N	\N	{}	reference_only	Cost-effective; wide distribution	{Patient_Monitor_Database.xlsx}	1791866236730
mindray-imec-15-12-10-8	mindray	Mindray	China	patient_monitor	iMEC	iMEC 15/12/10/8	t	2014	Ward / Clinic	15"-8"	Yes	No	No	No	Optional	802.11b/g/n	Yes	No	Yes	No	eGateway for HL7	\N	\N	{}	reference_only	Entry-level; popular in developing markets	{Patient_Monitor_Database.xlsx}	1791866236730
mindray-n1	mindray	Mindray	China	patient_monitor	BeneVision N	N1	f	2019	Transport / Ward	5"	Yes	No	No	No	Yes	802.11a/b/g/n	Yes	Yes	Yes	No	eGateway HL7; auto-dock to N-series bedside	\N	\N	{}	reference_only	Transport monitor; Bluetooth for mobility	{Patient_Monitor_Database.xlsx}	1791866236730
mindray-n12	mindray	Mindray	China	patient_monitor	BeneVision N	N12	f	2018	Ward / Step-down	12"	Yes	No	Yes	No	Yes	802.11a/b/g/n (2.4/5GHz)	Yes	No	Yes	No	eGateway for HL7; CMS	Native HL7	TCP/IP	{hl7-patient-monitor}	to_validate	8 waveforms; compact	{Patient_Monitor_Database.xlsx,flora-protocol-compatibility-map.webp}	1791866236730
mindray-n15	mindray	Mindray	China	patient_monitor	BeneVision N	N15	f	2018	ICU / ER	15"	Yes	Partial	Yes	No	Yes	802.11a/b/g/n (2.4/5GHz)	Yes	No	Yes	No	eGateway for HL7; wireless CMS	Native HL7	TCP/IP	{hl7-patient-monitor}	to_validate	10 waveforms	{Patient_Monitor_Database.xlsx,flora-protocol-compatibility-map.webp}	1791866236730
mindray-n17	mindray	Mindray	China	patient_monitor	BeneVision N	N17	f	2018	ICU / OR	17"	Yes	Partial	Yes	No	Yes	802.11a/b/g/n (2.4/5GHz)	Yes	No	Yes	No	eGateway HL7 to EMR; BeneVision CMS central	Native HL7	TCP/IP	{hl7-patient-monitor}	to_validate	12 waveforms; high-acuity	{Patient_Monitor_Database.xlsx,flora-protocol-compatibility-map.webp}	1791866236730
mindray-n22-n19	mindray	Mindray	China	patient_monitor	BeneVision N	N22/N19	t	2021	ICU / OR	22"/19"	Yes	Partial	Yes	No	Yes	802.11a/b/g/n/ac	Yes	No	Yes	No	eGateway for HL7; BeneLink device connectivity; HyperVisor CMS	\N	\N	{}	reference_only	Flagship. 4K display option	{Patient_Monitor_Database.xlsx}	1791866236730
mindray-v12-v8-v6	mindray	Mindray	China	patient_monitor	BeneVision V	V12/V8/V6	t	2022	Ward / ER / OPD	12"/8"/6"	Yes	No	No	No	Yes	802.11a/b/g/n	Yes	No	Yes	No	eGateway for HL7; CMS	\N	\N	{}	reference_only	Mid-range versatile series	{Patient_Monitor_Database.xlsx}	1791866236730
mindray-vs-900-800-600	mindray	Mindray	China	patient_monitor	VS	VS 900/800/600	t	2016	OPD / Ward	7"	Yes	No	No	No	Optional	802.11b/g/n	Yes	No	Yes	No	HL7 spot-check export	\N	\N	{}	reference_only	Vital signs spot monitor	{Patient_Monitor_Database.xlsx}	1791866236730
nihon-kohden-bsm-2301k	nihon-kohden	Nihon Kohden	Japan	patient_monitor	Life Scope	BSM-2301K	f	2019	Ward	10"	Yes	No	No	No	Optional	802.11b/g/n	Yes	No	Yes	No	Ethernet TCP/IP (LS-NET) + HL7	\N	\N	{}	reference_only	Compact bedside	{Patient_Monitor_Database.xlsx}	1791866236730
nihon-kohden-e7-bsm-5700	nihon-kohden	Nihon Kohden	Japan	patient_monitor	Life Scope	E7 (BSM-5700)	f	2023	Ward / ER	12.1"	Yes	No	Yes	No	Yes	802.11a/b/g/n	Yes	No	Yes	No	Direct HL7 to EMR or via Gateway	\N	\N	{}	reference_only	Mid-range; compact	{Patient_Monitor_Database.xlsx}	1791866236730
nihon-kohden-g3-gz-130-140	nihon-kohden	Nihon Kohden	Japan	patient_monitor	Life Scope	G3 (GZ-130/140)	t	2022	Transport / Ward	10.1"	Yes	No	No	No	Yes	802.11a/b/g/n	Yes	Yes	Yes	No	HL7 Gateway; local monitoring during WiFi loss	\N	\N	{}	reference_only	Transport + ward versatile	{Patient_Monitor_Database.xlsx}	1791866236730
nihon-kohden-g5-csm-1500	nihon-kohden	Nihon Kohden	Japan	patient_monitor	Life Scope	G5 (CSM-1500)	f	2016	ICU / ER	15"	Yes	No	Yes	No	Yes	802.11a/b/g/n	Yes	No	Yes	No	CGS-9002 HL7 Gateway; NK-HiQ CMS	\N	\N	{}	reference_only	High-acuity bedside	{Patient_Monitor_Database.xlsx}	1791866236730
nihon-kohden-g5-max	nihon-kohden	Nihon Kohden	Japan	patient_monitor	Life Scope	G5 Max	f	2020	ICU / OR	15"	Yes	Partial	Yes	No	Yes	802.11a/b/g/n/ac	Yes	Yes	Yes	No	Direct HL7 or CGS-9002 Gateway	\N	\N	{}	reference_only	Enhanced G5 with AI features	{Patient_Monitor_Database.xlsx}	1791866236730
nihon-kohden-g7-csm-1700	nihon-kohden	Nihon Kohden	Japan	patient_monitor	Life Scope	G7 (CSM-1700)	f	2021	ICU / OR / NICU	19"	Yes	Partial	Yes	No	Yes	802.11a/b/g/n/ac	Yes	Yes	Yes	No	Direct HL7 or CGS-9002 Gateway; NK-HiQ CMS	\N	\N	{}	reference_only	Flagship. BLE for wearable sensors	{Patient_Monitor_Database.xlsx}	1791866236730
nihon-kohden-svm-7200	nihon-kohden	Nihon Kohden	Japan	patient_monitor	Life Scope	SVM-7200	f	2020	OPD / Ward	7"	Yes	No	No	No	Yes	802.11a/b/g/n	Yes	No	Yes	No	HL7 spot-check to EMR	\N	\N	{}	reference_only	Vital signs monitor; WLAN built-in	{Patient_Monitor_Database.xlsx}	1791866236730
philips-avalon-fm20-fm50	philips	Philips	Netherlands	fetal_monitor	Philips IntelliVue	Avalon FM20–FM50	t	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	Philips IntelliVue native protocol	LAN or MIB / RS-232	{}	to_validate	Native IntelliVue, not through a vendor gateway	{flora-protocol-compatibility-map.webp}	1791866236730
philips-mp20-mp5	philips	Philips	Netherlands	patient_monitor	IntelliVue MP	MP20/MP5	t	2006	General Ward / Transport	8.4"/5"	Yes	No	Yes	No	Optional	802.11a/b/g	Yes	No	Yes	No	IIC; wireless transport	Philips IntelliVue native protocol	LAN or MIB / RS-232	{}	to_validate	Compact and portable variants	{Patient_Monitor_Database.xlsx,flora-protocol-compatibility-map.webp}	1791866236730
philips-mp20-mp90	philips	Philips	Netherlands	patient_monitor	Philips IntelliVue	MP20–MP90	t	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	Philips IntelliVue native protocol	LAN or MIB / RS-232	{}	to_validate	Native IntelliVue, not through a vendor gateway	{flora-protocol-compatibility-map.webp}	1791866236730
philips-mp5	philips	Philips	Netherlands	patient_monitor	Philips IntelliVue	MP5	f	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	Philips IntelliVue native protocol	LAN or MIB / RS-232	{}	to_validate	Native IntelliVue, not through a vendor gateway	{flora-protocol-compatibility-map.webp}	1791866236730
philips-mp50-mp40-mp30	philips	Philips	Netherlands	patient_monitor	IntelliVue MP	MP50/MP40/MP30	t	2006	General Ward	12"/10"/8"	Yes	No	Yes	No	Optional	802.11a/b/g	Yes	No	Yes	No	IIC for HL7 export	Philips IntelliVue native protocol	LAN or MIB / RS-232	{}	to_validate	Legacy mid-range series	{Patient_Monitor_Database.xlsx,flora-protocol-compatibility-map.webp}	1791866236730
philips-mp70-mp60	philips	Philips	Netherlands	patient_monitor	IntelliVue MP	MP70/MP60	t	2006	ICU / OR	15" / 12"	Yes	No	Yes	No	Optional	802.11a/b/g	Yes	No	Yes	No	IIC; IntelliBridge EC10	Philips IntelliVue native protocol	LAN or MIB / RS-232	{}	to_validate	Legacy but widely installed globally	{Patient_Monitor_Database.xlsx,flora-protocol-compatibility-map.webp}	1791866236730
philips-mx400	philips	Philips	Netherlands	patient_monitor	IntelliVue MX	MX400	f	2014	General Ward	8.4"	Yes	No	Yes	No	Optional	802.11a/b/g/n	Yes	No	Yes	No	IIC for HL7; wireless transport capable	Philips IntelliVue native protocol	LAN or MIB / RS-232	{}	to_validate	Compact; often used for sub-acute	{Patient_Monitor_Database.xlsx,flora-protocol-compatibility-map.webp}	1791866236730
philips-mx400-mx850	philips	Philips	Netherlands	patient_monitor	Philips IntelliVue	MX400–MX850	t	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	Philips IntelliVue native protocol	LAN or MIB / RS-232	{}	to_validate	Native IntelliVue, not through a vendor gateway	{flora-protocol-compatibility-map.webp}	1791866236730
philips-mx500	philips	Philips	Netherlands	patient_monitor	IntelliVue MX	MX500	f	2018	General Ward / ER	10.1"	Yes	No	Yes	No	Yes	802.11a/b/g/n	Yes	No	Yes	No	IIC for HL7 export to EMR	Philips IntelliVue native protocol	LAN or MIB / RS-232	{}	to_validate	Mid-range bedside monitor	{Patient_Monitor_Database.xlsx,flora-protocol-compatibility-map.webp}	1791866236730
philips-mx600	philips	Philips	Netherlands	patient_monitor	IntelliVue MX	MX600	f	2012	General Ward	12"	Yes	No	Yes	No	Yes	802.11a/b/g/n	Yes	No	Yes	No	IIC for HL7; IntelliBridge modules	Philips IntelliVue native protocol	LAN or MIB / RS-232	{}	to_validate	Compact bedside for step-down units	{Patient_Monitor_Database.xlsx,flora-protocol-compatibility-map.webp}	1791866236730
philips-mx700	philips	Philips	Netherlands	patient_monitor	IntelliVue MX	MX700	f	2012	ICU / ER / OR	15"	Yes	No	Yes	No	Yes	802.11a/b/g/n	Yes	No	Yes	No	IIC central station; IntelliBridge EC10/EC40 device interfaces	Philips IntelliVue native protocol	LAN or MIB / RS-232	{}	to_validate	Workhorse ICU monitor. Modular with MMS	{Patient_Monitor_Database.xlsx,flora-protocol-compatibility-map.webp}	1791866236730
philips-mx750	philips	Philips	Netherlands	patient_monitor	IntelliVue MX	MX750	f	2020	ICU / OR	15.6"	Yes	No	Yes	No	Yes	802.11a/b/g/n/ac	Yes	No	Yes	No	IIC iX central station; HL7 ADT inbound + results outbound	Philips IntelliVue native protocol	LAN or MIB / RS-232	{}	to_validate	Next-gen MX series. IntelliSpace integration	{Patient_Monitor_Database.xlsx,flora-protocol-compatibility-map.webp}	1791866236730
philips-mx800	philips	Philips	Netherlands	patient_monitor	IntelliVue MX	MX800	f	2015	ICU / OR / NICU	19"	Yes	No	Yes	No	Yes	802.11a/b/g/n	Yes	No	Yes	No	IntelliVue Information Center (IIC) for HL7 export; IntelliBridge for device connectivity	Philips IntelliVue native protocol	LAN or MIB / RS-232	{}	to_validate	Flagship bedside. UDP/IP based protocol; HL7 via central station	{Patient_Monitor_Database.xlsx,flora-protocol-compatibility-map.webp}	1791866236730
philips-vs30	philips	Philips	Netherlands	patient_monitor	EarlyVue	VS30	f	2019	General Ward / OPD	10.1"	Yes	No	No	No	Yes	802.11a/b/g/n	Yes	No	Yes	No	HL7 direct export to EMR; spot-check workflow	\N	\N	{}	reference_only	Early warning scoring (NEWS2/MEWS) built-in	{Patient_Monitor_Database.xlsx}	1791866236730
philips-x3-mx100	philips	Philips	Netherlands	patient_monitor	IntelliVue X3	X3 / MX100	t	2014	Transport / ICU	6.1"	Yes	No	Yes	No	Yes	802.11a/b/g/n	Yes	No	Yes	No	Companion to MX800; auto-dock for seamless handoff	Philips IntelliVue native protocol	LAN or MIB / RS-232	{}	to_validate	Transport + ICU dual-use; cableless option	{Patient_Monitor_Database.xlsx,flora-protocol-compatibility-map.webp}	1791866236730
progetti-pg-ria-3	progetti	Progetti	Italy	patient_monitor	Progetti PG RIA	PG RIA 3	f	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	Native HL7	LAN / Wi-Fi	{hl7-patient-monitor}	to_validate	\N	{flora-protocol-compatibility-map.webp}	1791866236730
progetti-pg-ria-5	progetti	Progetti	Italy	patient_monitor	Progetti PG RIA	PG RIA 5	f	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	Native HL7	LAN / Wi-Fi	{hl7-patient-monitor}	to_validate	\N	{flora-protocol-compatibility-map.webp}	1791866236730
progetti-pg-ria-9	progetti	Progetti	Italy	patient_monitor	Progetti PG RIA	PG RIA 9	f	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	Native HL7	LAN / Wi-Fi	{hl7-patient-monitor}	to_validate	\N	{flora-protocol-compatibility-map.webp}	1791866236730
schiller-argus-lcm-plus	schiller	Schiller	Switzerland	patient_monitor	ARGUS	ARGUS LCM plus	f	2016	Ward / Transport	8.4"	Yes	No	No	No	Optional	802.11b/g/n	Yes	No	Yes	No	HL7 via SEMA; LAN networking	\N	\N	{}	reference_only	Compact; transport rated	{Patient_Monitor_Database.xlsx}	1791866236730
schiller-argus-pro-lifevue	schiller	Schiller	Switzerland	patient_monitor	ARGUS	ARGUS PRO LifeVue	f	2019	ICU / OR	12.1"	Yes	No	No	No	Yes	802.11a/b/g/n	Yes	No	Yes	No	HL7 to EMR; SEMA central station	\N	\N	{}	reference_only	Swiss precision; modular	{Patient_Monitor_Database.xlsx}	1791866236730
schiller-ds20	schiller	Schiller	Switzerland	patient_monitor	DS20	DS20	f	2020	Ward / OPD	10"	Yes	No	No	No	Yes	802.11b/g/n	Yes	No	Yes	No	HL7 spot-check to EMR	\N	\N	{}	reference_only	Diagnostic station; vital signs	{Patient_Monitor_Database.xlsx}	1791866236730
siemens-sc-9000-xl	siemens	Siemens Healthineers	Germany	patient_monitor	SC	SC 9000 XL	f	2005	ICU / OR	15"	Yes	No	Yes	No	No	N/A	Yes	No	Yes	No	Infinity Gateway for HL7 (Dräger acquired)	\N	\N	{}	reference_only	Legacy; now serviced by Dräger	{Patient_Monitor_Database.xlsx}	1791866236730
skanray-star-70-60-50	skanray	Skanray	India	patient_monitor	Star	Star 70/60/50	t	2019	ICU / Ward	12"/10"/8"	Yes	No	No	No	Optional	802.11b/g/n	Yes	No	Yes	No	HL7 optional; CMS	\N	\N	{}	reference_only	Indian manufacturer; growing export	{Patient_Monitor_Database.xlsx}	1791866236730
spacelabs-elance	spacelabs	Spacelabs	USA	patient_monitor	Elance	Elance	f	2011	Ward / ER	12.1"	Yes	No	No	No	Yes	802.11a/b/g/n	Yes	No	Yes	No	HL7 CIS interface; ICS central	\N	\N	{}	reference_only	Mid-range versatile	{Patient_Monitor_Database.xlsx}	1791866236730
spacelabs-qube	spacelabs	Spacelabs	USA	patient_monitor	qube	qube	f	2014	Ward / Transport	8.4"	Yes	No	No	No	Yes	802.11a/b/g/n	Yes	No	Yes	No	HL7 via Vital Signs Interface; CIS integration	\N	\N	{}	reference_only	Compact; transport capable	{Patient_Monitor_Database.xlsx}	1791866236730
spacelabs-xprezon	spacelabs	Spacelabs	USA	patient_monitor	XPREZON	XPREZON	f	2017	ICU / OR / ER	15.6"	Yes	No	Yes	No	Yes	802.11a/b/g/n	Yes	No	Yes	No	Vital Signs Interface for HL7; Intesys CMS	\N	\N	{}	reference_only	Modular bedside; Command Module based	{Patient_Monitor_Database.xlsx}	1791866236730
welch-allyn-connex-probp-3400	welch-allyn	Welch Allyn (Baxter)	USA	bp_monitor	Connex	Connex ProBP 3400	f	2019	OPD / Clinic	3.5"	No	No	No	No	Yes	802.11b/g/n	No	Yes	Yes	No	Direct to EMR via WiFi/BLE	\N	\N	{}	reference_only	Digital BP only; wireless workflow	{Patient_Monitor_Database.xlsx}	1791866236730
welch-allyn-connex-spot-monitor-csm	welch-allyn	Welch Allyn (Baxter)	USA	patient_monitor	Connex	Connex Spot Monitor (CSM)	f	2015	OPD / Ward	7"	Yes	No	No	No	Yes	802.11a/b/g/n	Yes	Yes	Yes	No	HL7 wireless direct to EMR; BLE for peripherals	\N	\N	{}	reference_only	Most popular spot monitor worldwide	{Patient_Monitor_Database.xlsx}	1791866236730
welch-allyn-connex-vsm-6000	welch-allyn	Welch Allyn (Baxter)	USA	patient_monitor	Connex	Connex VSM 6000	f	2016	ICU / Ward	15.6"	Yes	No	No	No	Yes	802.11a/b/g/n	Yes	Yes	Yes	No	HL7 direct to EMR; Connex Vitals Hub	\N	\N	{}	reference_only	Continuous monitoring + spot-check	{Patient_Monitor_Database.xlsx}	1791866236730
zoll-propaq-m	zoll	Zoll	USA	patient_monitor	Propaq	Propaq M	f	2016	Transport / ER / Military	6.5"	Yes	No	No	No	Yes	802.11a/b/g/n	Yes	Yes	Yes	Yes	HL7; WiFi + Bluetooth + USB cellular; RescueNet CaseReview	\N	\N	{}	reference_only	Rugged transport; MIL-STD-810G rated	{Patient_Monitor_Database.xlsx}	1791866236730
zoll-propaq-md	zoll	Zoll	USA	patient_monitor	Propaq	Propaq MD	f	2014	Transport / ER	6.5"	Yes	No	No	No	Yes	802.11a/b/g/n	Yes	Yes	Yes	Yes	HL7; WiFi telemedicine; RescueNet	\N	\N	{}	reference_only	Monitor + defibrillator combo	{Patient_Monitor_Database.xlsx}	1791866236730
zoll-x-series	zoll	Zoll	USA	patient_monitor	X Series	X Series	f	2011	ER / Transport / Military	6.5"	Yes	No	No	No	Yes	802.11a/b/g/n	Yes	Yes	Yes	Yes	HL7; WiFi/BT/cellular; real-time 12-lead transmission	\N	\N	{}	reference_only	Advanced monitor/defib; rugged	{Patient_Monitor_Database.xlsx}	1791866236730
\.


--
-- Data for Name: device_type_source; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.device_type_source (source_id, title, kind, file_name, sha256, description, imported_at) FROM stdin;
Patient_Monitor_Database.xlsx	CIS-LIFE Patient Monitor Database — Worldwide Reference	spreadsheet	reference/Patient_Monitor_Database.xlsx	097416800cf0e5a9fe253b3b42a52b0f04898550f9fcce86388137a9e93d1f03	Patient monitors with brand, model, year, protocol support and connectivity, for CIS integration planning. Sheets: Patient Monitors, Protocol Reference, Brand Summary, Connection Types.	1791866236730
flora-protocol-compatibility-map.webp	FLORA Medical Device Connectivity — Protocol-First Compatibility Map	image	reference/flora-protocol-compatibility-map.webp	f9985aca86f8a8735c0601e539c738fb5646f88bce62a7c9a2a1c5aaca3e4f23	Nine protocol lanes from device family to Flora edge adapter. Its '150+ devices' figure is a compatibility estimate across models and protocol families; deployment compatibility is validated per model, software version, interface and hospital.	1791866236730
\.


--
-- Data for Name: root_audit; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.root_audit (id, at, username, action, target, ip, detail) FROM stdin;
1	1791260217076	system	user.bootstrap	admin	\N	{}
2	1791260222982	admin	login.ok	\N	192.168.65.1	{}
3	1791260223022	admin	POST /api/v1/releases/nope/withdraw	\N	192.168.65.1	{"via": "session", "status": 404}
4	1791260236909	admin	POST /api/v1/users	\N	192.168.65.1	{"via": "basic", "status": 201}
5	1791260236950	qa-viewer	login.failed	\N	192.168.65.1	{"locked": false}
6	1791260236991	qa-viewer	login.failed	\N	192.168.65.1	{"locked": false}
7	1791260237037	qa-viewer	login.failed	\N	192.168.65.1	{"locked": false}
8	1791260237077	qa-viewer	login.failed	\N	192.168.65.1	{"locked": false}
9	1791260237116	qa-viewer	login.failed	\N	192.168.65.1	{"locked": true}
10	1791260237128	qa-viewer	login.locked	\N	192.168.65.1	{}
11	1791260237140	qa-viewer	login.locked	\N	192.168.65.1	{}
12	1791260237223	admin	POST /api/v1/users/2/unlock	\N	192.168.65.1	{"via": "basic", "status": 200}
13	1791260237263	qa-viewer	login.ok	\N	192.168.65.1	{}
14	1791260237342	qa-viewer	password.changed	\N	192.168.65.1	{}
15	1791260237370	qa-viewer	POST /api/v1/releases/gateway-0.1.0/withdraw	\N	192.168.65.1	{"via": "session", "status": 403}
16	1791260273808	admin	login.ok	\N	192.168.112.1	{}
17	1791260297848	admin	PUT /api/v1/users/2	\N	192.168.65.1	{"via": "basic", "status": 200}
18	1791260462118	admin	login.ok	\N	192.168.65.1	{}
19	1791260462141	admin	logout	\N	192.168.65.1	{}
20	1791261673839	admin	login.ok	\N	192.168.65.1	{}
21	1791274574407	admin	login.ok	\N	192.168.65.1	{}
22	1791274842152	admin	PUT /api/v1/tenants/hospital-01/license	\N	192.168.65.1	{"via": "session", "status": 200}
23	1791274858183	admin	POST /api/v1/tenants/hospital-01/license/revoke	\N	192.168.65.1	{"via": "session", "status": 200}
24	1791274886332	admin	POST /api/v1/releases	\N	192.168.112.1	{"via": "basic", "status": 201}
25	1791276639676	admin	login.ok	\N	192.168.112.1	{}
26	1791296927172	admin	login.ok	\N	192.168.112.1	{}
27	1791365282530	admin	PUT /api/v1/tenants/hospital-01/license	\N	192.168.112.1	{"via": "basic", "status": 200}
28	1791365809742	admin	POST /api/v1/releases	\N	192.168.112.1	{"via": "basic", "status": 201}
29	1791366288513	admin	POST /api/v1/releases	\N	192.168.112.1	{"via": "basic", "status": 201}
30	1791366403540	admin	POST /api/v1/releases	\N	192.168.112.1	{"via": "basic", "status": 201}
31	1791366407380	admin	POST /api/v1/releases	\N	192.168.112.1	{"via": "basic", "status": 409}
32	1791366436036	admin	POST /api/v1/releases	\N	192.168.112.1	{"via": "basic", "status": 201}
33	1791366524151	admin	login.ok	\N	192.168.112.1	{}
34	1791385493844	admin	POST /api/v1/releases	\N	192.168.112.1	{"via": "basic", "status": 409}
35	1791385524456	admin	login.failed	\N	192.168.112.1	{"locked": false}
36	1791385527140	admin	login.failed	\N	192.168.112.1	{"locked": false}
37	1791385530058	admin	login.failed	\N	192.168.112.1	{"locked": false}
38	1791385532087	admin	login.ok	\N	192.168.112.1	{}
39	1791385542958	admin	POST /api/v1/releases	\N	192.168.112.1	{"via": "basic", "status": 201}
40	1791386644738	admin	POST /api/v1/releases	\N	192.168.112.1	{"via": "basic", "status": 201}
41	1791387475566	admin	POST /api/v1/releases	\N	192.168.112.1	{"via": "basic", "status": 201}
42	1791425564374	admin	POST /api/v1/releases	\N	192.168.112.1	{"via": "basic", "status": 201}
43	1791440746998	admin	login.ok	\N	192.168.112.1	{}
44	1791476086443	admin	POST /api/v1/releases	\N	192.168.112.1	{"via": "basic", "status": 201}
45	1791479879027	admin	POST /api/v1/releases	\N	192.168.112.1	{"via": "basic", "status": 201}
46	1791771453600	admin	login.failed	\N	192.168.112.1	{"locked": false}
47	1791771455711	admin	login.ok	\N	192.168.112.1	{}
48	1791866246505	 admin	login.failed	\N	192.168.112.1	{"reason": "unknown user"}
49	1791866246565	 admin	login.failed	\N	192.168.112.1	{"reason": "unknown user"}
50	1791866246616	 admin	login.failed	\N	192.168.112.1	{"reason": "unknown user"}
51	1791866246664	 admin	login.failed	\N	192.168.112.1	{"reason": "unknown user"}
52	1791866257456	 admin	login.failed	\N	192.168.112.1	{"reason": "unknown user"}
53	1791866257505	 admin	login.failed	\N	192.168.112.1	{"reason": "unknown user"}
54	1791866257554	 admin	login.failed	\N	192.168.112.1	{"reason": "unknown user"}
55	1791866257601	 admin	login.failed	\N	192.168.112.1	{"reason": "unknown user"}
56	1791866279926	admin	login.ok	\N	192.168.112.1	{}
57	1791875951839	admin	POST /api/v1/releases	\N	192.168.112.1	{"via": "basic", "status": 201}
58	1791876584757	admin	POST /api/v1/releases	\N	192.168.112.1	{"via": "basic", "status": 201}
59	1791876593470	admin	POST /api/v1/releases	\N	192.168.112.1	{"via": "basic", "status": 201}
60	1791877147662	admin	POST /api/v1/releases	\N	192.168.112.1	{"via": "basic", "status": 201}
61	1791877464313	admin	POST /api/v1/releases	\N	192.168.112.1	{"via": "basic", "status": 201}
\.


--
-- Data for Name: root_checkin; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.root_checkin (tenant_id, last_seen_at, canopy_version, bundle_id, usage) FROM stdin;
hospital-01	1791941964120	1.2.2	lic-e4011381788b	{"nodes": [{"state": "current", "node_id": "canopy", "component": "canopy", "last_seen": 1791941935282, "release_id": "canopy-1.2.9"}, {"state": "current", "node_id": "gateway-hospital-01-a", "component": "gateway", "last_seen": 1791941939962, "release_id": "gateway-0.2.4"}, {"state": "waiting", "node_id": "leaf-icu-01", "component": "leaf", "last_seen": 1791941959453, "release_id": "leaf-1.2.2"}, {"state": "waiting", "node_id": "leaf-or-01", "component": "leaf", "last_seen": 1791941959454, "release_id": "leaf-1.2.6"}], "leaves": 6, "gateways": 1, "leaf_ids": ["demo-leaf-01", "demo-leaf-02", "demo-leaf-03", "demo-leaf-04", "leaf-icu-01", "leaf-or-01"], "gateway_devices": 1}
\.


--
-- Data for Name: root_global_config; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.root_global_config (key, value, updated_at) FROM stdin;
terminology_release	"2026.09"	1790883710704
minimum_versions	{"leaf": "1.2.0", "canopy": "1.2.0", "gateway": "0.1.0"}	1790883710704
feature_flags	{"ai_assist": false, "archive_reports": true}	1790883710704
sync_interval_sec	10	1790883710704
\.


--
-- Data for Name: root_license; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.root_license (bundle_id, tenant_id, modules, max_leaves, max_gateways, max_gateway_devices, device_types, issued_at, expires_at, revoked_at, current) FROM stdin;
lic-6aed560e6ea7	hospital-01	{leaf,canopy,gateway}	4	2	8	{hl7-patient-monitor,json-anesthesia-machine,http-ventilator,serial-temp-module}	1790883710705	1822419710705	1790884056314	f
lic-5eabdec1470d	hospital-01	{leaf,canopy,gateway}	4	2	8	{hl7-patient-monitor,json-anesthesia-machine,http-ventilator,serial-temp-module}	1790884088400	1822420088400	\N	f
lic-e1870bc0c50a	hospital-01	{leaf,canopy,gateway}	4	2	8	{hl7-patient-monitor,json-anesthesia-machine,http-ventilator,serial-temp-module,acme-t200}	1791258406593	1822448806593	\N	f
lic-fb97ac10d48e	hospital-01	{leaf,canopy,gateway}	10	2	8	{hl7-patient-monitor,json-anesthesia-machine,http-ventilator,serial-temp-module,acme-t200}	1791274842150	1822810842150	1791274858182	f
lic-f179cebde90a	hospital-01	{leaf,canopy,gateway}	10	2	8	{hl7-patient-monitor,json-anesthesia-machine,http-ventilator,serial-temp-module,acme-t200,draeger-vista-120s}	1791365282528	1822901282528	\N	f
lic-e4011381788b	hospital-01	{leaf,canopy,gateway}	4	2	8	{hl7-patient-monitor,json-anesthesia-machine,http-ventilator,serial-temp-module,draeger-vista-120s,draeger-iacs-m540}	1791866236727	1823402236727	\N	t
\.


--
-- Data for Name: root_release; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.root_release (release_id, component, version, channel, services, device_types, notes, created_at, withdrawn_at) FROM stdin;
gateway-0.1.0	gateway	0.1.0	stable	{"rust": {"tag": "0.1.0", "digest": "sha256:3f5800cbb8c3ddefc5aaf793e6ff74cb4d429cbf3e5a114bf383e9a92db55c63", "repository": "flora/gateway/rust"}, "parser": {"tag": "0.1.0", "digest": "sha256:9fc509be8e1a7378ba4e2091f8040459fbfd8280e9d87e1361d2736bfe2fd06d", "repository": "flora/gateway/parser"}, "service": {"tag": "0.1.0", "digest": "sha256:440397f466f1216a55cac1dd76dd860dcc53d36daf2c9c8257d85b435579506b", "repository": "flora/gateway/service"}}	[{"code": "hl7-patient-monitor", "image": "parser", "label": "Patient monitor (HL7 v2 / IHE PCD-01)", "parser": "hl7v2", "version": "1", "category": "patient_monitor", "protocol": "hl7v2", "controller": "socket", "default_options": {"timezone": "Asia/Bangkok"}}, {"code": "json-anesthesia-machine", "image": "parser", "label": "Anesthesia machine (JSON push)", "parser": "json_fields", "version": "1", "category": "anesthesia_machine", "protocol": "json", "controller": "webhook", "default_options": {"units": {"fio2": "%", "et_agent": "%", "fi_agent": "%", "airway_pressure_peak": "cmH2O"}}}, {"code": "http-ventilator", "image": "parser", "label": "ICU ventilator (HTTP poll)", "parser": "json_fields", "version": "1", "category": "ventilator", "protocol": "json", "controller": "feeder", "default_options": {"codes": {"MODE": "set_vent_mode", "PEEP": "set_peep", "RR_SET": "set_rr", "VT_SET": "set_tidal_volume", "FIO2_SET": "set_fio2"}}}, {"code": "serial-temp-module", "image": "parser", "label": "Temperature / CVP module (RS-232, polled)", "parser": "ascii_kv", "version": "1", "category": "temperature_module", "protocol": "ascii", "controller": "serial", "default_options": {"codes": {"CVP": "cvp", "TEMP": "temperature"}, "units": {"cvp": "mmHg", "temperature": "Cel"}, "poll_command": "?\\\\r\\\\n", "poll_interval_sec": 5}}, {"code": "draeger-iacs-m540", "image": "parser", "label": "Dräger M540 (IACS UDP, research mapping)", "parser": "iacs_m540", "version": "1", "category": "patient_monitor", "protocol": "draeger-iacs", "controller": "socket", "default_options": {}}, {"code": "draeger-medibus", "image": "parser", "label": "Dräger MEDIBUS.X (RS-232 numeric data)", "parser": "medibus", "version": "1", "category": "ventilator", "protocol": "draeger-medibus", "controller": "serial", "default_options": {"poll_interval_sec": 1, "session_timeout_sec": 10, "response_timeout_sec": 3}}, {"code": "ge-carestation-750", "image": "parser", "label": "GE Carestation 750 (COM 1.2)", "parser": "ge_carestation", "version": "1", "category": "anesthesia_machine", "protocol": "ge-datex-com12", "controller": "serial", "default_options": {}}, {"code": "ge-aisys-cs2", "image": "parser", "label": "GE Aisys CS2 (Hidro COM 1.2 profile)", "parser": "ge_carestation", "version": "1", "category": "anesthesia_machine", "protocol": "ge-datex-com12", "controller": "serial", "default_options": {}}, {"code": "ge-bx50-dri", "image": "parser", "label": "GE Bx50 / B650 (Hidro DRI profile)", "parser": "ge_dri", "version": "1", "category": "patient_monitor", "protocol": "ge-s5-dri", "controller": "serial", "default_options": {"dri_levels": [12, 11, 10, 9, 8, 6], "checksum_mode": "escaped"}}, {"code": "ge-s5-dri", "image": "parser", "label": "GE S/5 (DRI)", "parser": "ge_dri", "version": "1", "category": "patient_monitor", "protocol": "ge-s5-dri", "controller": "serial", "default_options": {"dri_levels": [9, 8, 7], "checksum_mode": "payload"}}, {"code": "ge-aisys-dri", "image": "parser", "label": "GE Aisys (legacy DRI alternative)", "parser": "ge_dri", "version": "1", "category": "anesthesia_machine", "protocol": "ge-s5-dri", "controller": "serial", "default_options": {"dri_levels": [12, 11, 10, 9, 8, 6], "checksum_mode": "payload"}}, {"code": "bbraun-space-bcc", "image": "parser", "label": "B. Braun SpaceCom (BCC TCP)", "parser": "bbraun_bcc", "version": "1", "category": "infusion_pump", "protocol": "bbraun-bcc", "controller": "socket", "default_options": {"bed_id": "1/1/1", "poll_interval_sec": 5}}, {"code": "hidro-hl7-monitor", "image": "parser", "label": "Hidro shared HL7 monitor (GE / configured vendor aliases)", "parser": "hidro_hl7", "version": "1", "category": "patient_monitor", "protocol": "hl7v2", "controller": "socket", "default_options": {"timezone": "Asia/Bangkok", "repair_segments": false}}]	First release built by Root	1791251235670	\N
leaf-1.2.2	leaf	1.2.2	stable	{"api": {"tag": "1.2.2", "digest": "sha256:fb423f6e919dd1d65ff4e9b67d00fe8b906305b57c4271c603a95f7ea2e92646", "repository": "flora/leaf/api"}, "sync": {"tag": "1.2.2", "digest": "sha256:babd545e075de01da95feb8e1297f568047a38aff340f4b510655c116bb6c960", "repository": "flora/leaf/sync"}}	[]	First release built by Root	1791251245862	\N
canopy-1.2.2	canopy	1.2.2	stable	{"api": {"tag": "1.2.2", "digest": "sha256:7d1f612c5dd638fe61038d63d5143681479e39a122884c3450e17d1c00363a4d", "repository": "flora/canopy/api"}, "haber": {"tag": "1.2.2", "digest": "sha256:37e001de35af2bd09ca0ab885f5398d5d228afafaff2ca114fa36883841a9969", "repository": "flora/canopy/haber"}}	[]	First release built by Root	1791251250240	\N
canopy-1.2.3	canopy	1.2.3	stable	{"api": {"tag": "1.2.3", "digest": "sha256:7d1f612c5dd638fe61038d63d5143681479e39a122884c3450e17d1c00363a4d", "repository": "flora/canopy/api"}, "haber": {"tag": "1.2.3", "digest": "sha256:d82c6cc865129e7b180bd058d5d93b93da908b5c09364a6e5c9f706e2255c673", "repository": "flora/canopy/haber"}}	[]	Haber: left tab navigation	1791251531949	\N
gateway-0.2.0	gateway	0.2.0	stable	{"rust": {"tag": "0.2.0", "digest": "sha256:3f5800cbb8c3ddefc5aaf793e6ff74cb4d429cbf3e5a114bf383e9a92db55c63", "repository": "flora/gateway/rust"}, "parser": {"tag": "0.2.0", "digest": "sha256:fd57562240c2ca7d3f6f89516defa9c7dfc921d29e66616c2069b4f962708886", "repository": "flora/gateway/parser"}, "service": {"tag": "0.2.0", "digest": "sha256:dd1c3d53b8a2203a59611bf0892edf045eaf29fc48a2cd1c57c10da742fdb4ce", "repository": "flora/gateway/service"}}	[{"code": "hl7-patient-monitor", "image": "parser", "label": "Patient monitor (HL7 v2 / IHE PCD-01)", "parser": "hl7v2", "version": "1", "category": "patient_monitor", "protocol": "hl7v2", "controller": "socket", "default_options": {"timezone": "Asia/Bangkok"}, "connection_defaults": {"framing": "mllp", "auto_ack": true, "transport": "tcp"}}, {"code": "json-anesthesia-machine", "image": "parser", "label": "Anesthesia machine (JSON push)", "parser": "json_fields", "version": "1", "category": "anesthesia_machine", "protocol": "json", "controller": "webhook", "default_options": {"units": {"fio2": "%", "et_agent": "%", "fi_agent": "%", "airway_pressure_peak": "cmH2O"}}}, {"code": "http-ventilator", "image": "parser", "label": "ICU ventilator (HTTP poll)", "parser": "json_fields", "version": "1", "category": "ventilator", "protocol": "json", "controller": "feeder", "default_options": {"codes": {"MODE": "set_vent_mode", "PEEP": "set_peep", "RR_SET": "set_rr", "VT_SET": "set_tidal_volume", "FIO2_SET": "set_fio2"}}, "connection_defaults": {"interval_ms": 5000}}, {"code": "serial-temp-module", "image": "parser", "label": "Temperature / CVP module (RS-232, polled)", "parser": "ascii_kv", "version": "1", "category": "temperature_module", "protocol": "ascii", "controller": "serial", "default_options": {"codes": {"CVP": "cvp", "TEMP": "temperature"}, "units": {"cvp": "mmHg", "temperature": "Cel"}, "poll_command": "?\\\\r\\\\n", "poll_interval_sec": 5}, "connection_defaults": {"baud": 9600, "parity": "none", "idle_ms": 80, "data_bits": 8, "stop_bits": 1, "flow_control": "none"}}, {"code": "draeger-iacs-m540", "image": "parser", "label": "Dräger M540 (IACS UDP, research mapping)", "parser": "iacs_m540", "version": "1", "category": "patient_monitor", "protocol": "draeger-iacs", "controller": "socket", "default_options": {}, "connection_defaults": {"auto_ack": false, "transport": "udp", "max_frame_bytes": 6096}}, {"code": "draeger-medibus", "image": "parser", "label": "Dräger MEDIBUS.X (RS-232 numeric data)", "parser": "medibus", "version": "1", "category": "ventilator", "protocol": "draeger-medibus", "controller": "serial", "default_options": {"poll_interval_sec": 1, "session_timeout_sec": 10, "response_timeout_sec": 3}, "connection_defaults": {"dtr": true, "rts": true, "baud": 19200, "parity": "even", "idle_ms": 20, "data_bits": 8, "stop_bits": 1, "flow_control": "none", "max_frame_bytes": 16384}}, {"code": "ge-carestation-750", "image": "parser", "label": "GE Carestation 750 (COM 1.2)", "parser": "ge_carestation", "version": "1", "category": "anesthesia_machine", "protocol": "ge-datex-com12", "controller": "serial", "default_options": {}, "connection_defaults": {"dtr": true, "rts": true, "baud": 19200, "parity": "odd", "idle_ms": 20, "data_bits": 7, "stop_bits": 1, "flow_control": "none"}}, {"code": "ge-aisys-cs2", "image": "parser", "label": "GE Aisys CS2 (Hidro COM 1.2 profile)", "parser": "ge_carestation", "version": "1", "category": "anesthesia_machine", "protocol": "ge-datex-com12", "controller": "serial", "default_options": {}, "connection_defaults": {"dtr": true, "rts": true, "baud": 19200, "parity": "odd", "idle_ms": 20, "data_bits": 7, "stop_bits": 1, "flow_control": "none"}}, {"code": "ge-bx50-dri", "image": "parser", "label": "GE Bx50 / B650 (Hidro DRI profile)", "parser": "ge_dri", "version": "1", "category": "patient_monitor", "protocol": "ge-s5-dri", "controller": "serial", "default_options": {"dri_levels": [12, 11, 10, 9, 8, 6], "checksum_mode": "escaped"}, "connection_defaults": {"dtr": true, "baud": 19200, "parity": "even", "idle_ms": 20, "data_bits": 8, "stop_bits": 1, "flow_control": "hardware"}}, {"code": "ge-s5-dri", "image": "parser", "label": "GE S/5 (DRI)", "parser": "ge_dri", "version": "1", "category": "patient_monitor", "protocol": "ge-s5-dri", "controller": "serial", "default_options": {"dri_levels": [9, 8, 7], "checksum_mode": "payload"}, "connection_defaults": {"dtr": true, "baud": 19200, "parity": "even", "idle_ms": 20, "data_bits": 8, "stop_bits": 1, "flow_control": "hardware"}}, {"code": "ge-aisys-dri", "image": "parser", "label": "GE Aisys (legacy DRI alternative)", "parser": "ge_dri", "version": "1", "category": "anesthesia_machine", "protocol": "ge-s5-dri", "controller": "serial", "default_options": {"dri_levels": [12, 11, 10, 9, 8, 6], "checksum_mode": "payload"}, "connection_defaults": {"dtr": true, "rts": true, "baud": 115200, "parity": "even", "idle_ms": 20, "data_bits": 8, "stop_bits": 1, "flow_control": "none"}}, {"code": "bbraun-space-bcc", "image": "parser", "label": "B. Braun SpaceCom (BCC TCP)", "parser": "bbraun_bcc", "version": "1", "category": "infusion_pump", "protocol": "bbraun-bcc", "controller": "socket", "default_options": {"bed_id": "1/1/1", "poll_interval_sec": 5}, "connection_defaults": {"framing": "raw", "auto_ack": false, "transport": "tcp", "reconnect_ms": 3000, "read_timeout_ms": 15000, "connect_timeout_ms": 3000}}, {"code": "hidro-hl7-monitor", "image": "parser", "label": "Hidro shared HL7 monitor (GE / configured vendor aliases)", "parser": "hidro_hl7", "version": "1", "category": "patient_monitor", "protocol": "hl7v2", "controller": "socket", "default_options": {"timezone": "Asia/Bangkok", "repair_segments": false}, "connection_defaults": {"framing": "mllp", "auto_ack": true, "transport": "tcp"}}, {"code": "acme-t200", "image": "parser", "label": "Acme T-200 temperature / CVP (RS-232, polled)", "parser": "acme_t200", "version": "1", "category": "temperature_module", "protocol": "acme-t200", "controller": "serial", "default_options": {"poll_interval_sec": 2}, "connection_defaults": {"baud": 9600, "parity": "none", "idle_ms": 50, "data_bits": 8, "stop_bits": 1, "flow_control": "none"}}]	Add Acme T-200 serial parser (acme-t200)	1791258398187	\N
canopy-1.2.4	canopy	1.2.4	stable	{"api": {"tag": "1.2.4", "digest": "sha256:5e6148ccf549b9fbdd403689879282265c719c187d9ed8308702db0497b943d7", "repository": "flora/canopy/api"}, "haber": {"tag": "1.2.4", "digest": "sha256:020592b70b95a5db9840141a7f6a4d580687d4f1342885219be3daf4b150ff4f", "repository": "flora/canopy/haber"}}	[]	demo/release.sh	1791274886330	\N
gateway-0.2.1	gateway	0.2.1	stable	{"rust": {"tag": "0.2.1", "digest": "sha256:4cb7e66debf67f40e92854a3660038ae67c26c085d897a8bd52379a4a78c77bf", "repository": "flora/gateway/rust"}, "parser": {"tag": "0.2.1", "digest": "sha256:c731e424457b9fee6d1469afb937fbbdcc1d1b5323230f42a8496a5232cb3763", "repository": "flora/gateway/parser"}, "service": {"tag": "0.2.1", "digest": "sha256:eb08c934e67a4595693242956d246a32c1ac41cdabda36d8959f6847857705dd", "repository": "flora/gateway/service"}}	[{"code": "hl7-patient-monitor", "image": "parser", "label": "Patient monitor (HL7 v2 / IHE PCD-01)", "parser": "hl7v2", "version": "1", "category": "patient_monitor", "protocol": "hl7v2", "controller": "socket", "default_options": {"timezone": "Asia/Bangkok"}, "connection_defaults": {"framing": "mllp", "auto_ack": true, "transport": "tcp"}}, {"code": "json-anesthesia-machine", "image": "parser", "label": "Anesthesia machine (JSON push)", "parser": "json_fields", "version": "1", "category": "anesthesia_machine", "protocol": "json", "controller": "webhook", "default_options": {"units": {"fio2": "%", "et_agent": "%", "fi_agent": "%", "airway_pressure_peak": "cmH2O"}}}, {"code": "http-ventilator", "image": "parser", "label": "ICU ventilator (HTTP poll)", "parser": "json_fields", "version": "1", "category": "ventilator", "protocol": "json", "controller": "feeder", "default_options": {"codes": {"MODE": "set_vent_mode", "PEEP": "set_peep", "RR_SET": "set_rr", "VT_SET": "set_tidal_volume", "FIO2_SET": "set_fio2"}}, "connection_defaults": {"interval_ms": 5000}}, {"code": "serial-temp-module", "image": "parser", "label": "Temperature / CVP module (RS-232, polled)", "parser": "ascii_kv", "version": "1", "category": "temperature_module", "protocol": "ascii", "controller": "serial", "default_options": {"codes": {"CVP": "cvp", "TEMP": "temperature"}, "units": {"cvp": "mmHg", "temperature": "Cel"}, "poll_command": "?\\\\r\\\\n", "poll_interval_sec": 5}, "connection_defaults": {"baud": 9600, "parity": "none", "idle_ms": 80, "data_bits": 8, "stop_bits": 1, "flow_control": "none"}}, {"code": "draeger-iacs-m540", "image": "parser", "label": "Dräger M540 (IACS UDP, research mapping)", "parser": "iacs_m540", "version": "1", "category": "patient_monitor", "protocol": "draeger-iacs", "controller": "socket", "default_options": {}, "connection_defaults": {"auto_ack": false, "transport": "udp", "max_frame_bytes": 6096}}, {"code": "draeger-medibus", "image": "parser", "label": "Dräger MEDIBUS.X (RS-232 numeric data)", "parser": "medibus", "version": "1", "category": "ventilator", "protocol": "draeger-medibus", "controller": "serial", "default_options": {"poll_interval_sec": 1, "session_timeout_sec": 10, "response_timeout_sec": 3}, "connection_defaults": {"dtr": true, "rts": true, "baud": 19200, "parity": "even", "idle_ms": 20, "data_bits": 8, "stop_bits": 1, "flow_control": "none", "max_frame_bytes": 16384}}, {"code": "ge-carestation-750", "image": "parser", "label": "GE Carestation 750 (COM 1.2)", "parser": "ge_carestation", "version": "1", "category": "anesthesia_machine", "protocol": "ge-datex-com12", "controller": "serial", "default_options": {}, "connection_defaults": {"dtr": true, "rts": true, "baud": 19200, "parity": "odd", "idle_ms": 20, "data_bits": 7, "stop_bits": 1, "flow_control": "none"}}, {"code": "ge-aisys-cs2", "image": "parser", "label": "GE Aisys CS2 (Hidro COM 1.2 profile)", "parser": "ge_carestation", "version": "1", "category": "anesthesia_machine", "protocol": "ge-datex-com12", "controller": "serial", "default_options": {}, "connection_defaults": {"dtr": true, "rts": true, "baud": 19200, "parity": "odd", "idle_ms": 20, "data_bits": 7, "stop_bits": 1, "flow_control": "none"}}, {"code": "ge-bx50-dri", "image": "parser", "label": "GE Bx50 / B650 (Hidro DRI profile)", "parser": "ge_dri", "version": "1", "category": "patient_monitor", "protocol": "ge-s5-dri", "controller": "serial", "default_options": {"dri_levels": [12, 11, 10, 9, 8, 6], "checksum_mode": "escaped"}, "connection_defaults": {"dtr": true, "baud": 19200, "parity": "even", "idle_ms": 20, "data_bits": 8, "stop_bits": 1, "flow_control": "hardware"}}, {"code": "ge-s5-dri", "image": "parser", "label": "GE S/5 (DRI)", "parser": "ge_dri", "version": "1", "category": "patient_monitor", "protocol": "ge-s5-dri", "controller": "serial", "default_options": {"dri_levels": [9, 8, 7], "checksum_mode": "payload"}, "connection_defaults": {"dtr": true, "baud": 19200, "parity": "even", "idle_ms": 20, "data_bits": 8, "stop_bits": 1, "flow_control": "hardware"}}, {"code": "ge-aisys-dri", "image": "parser", "label": "GE Aisys (legacy DRI alternative)", "parser": "ge_dri", "version": "1", "category": "anesthesia_machine", "protocol": "ge-s5-dri", "controller": "serial", "default_options": {"dri_levels": [12, 11, 10, 9, 8, 6], "checksum_mode": "payload"}, "connection_defaults": {"dtr": true, "rts": true, "baud": 115200, "parity": "even", "idle_ms": 20, "data_bits": 8, "stop_bits": 1, "flow_control": "none"}}, {"code": "bbraun-space-bcc", "image": "parser", "label": "B. Braun SpaceCom (BCC TCP)", "parser": "bbraun_bcc", "version": "1", "category": "infusion_pump", "protocol": "bbraun-bcc", "controller": "socket", "default_options": {"bed_id": "1/1/1", "poll_interval_sec": 5}, "connection_defaults": {"framing": "raw", "auto_ack": false, "transport": "tcp", "reconnect_ms": 3000, "read_timeout_ms": 15000, "connect_timeout_ms": 3000}}, {"code": "hidro-hl7-monitor", "image": "parser", "label": "Hidro shared HL7 monitor (GE / configured vendor aliases)", "parser": "hidro_hl7", "version": "1", "category": "patient_monitor", "protocol": "hl7v2", "controller": "socket", "default_options": {"timezone": "Asia/Bangkok", "repair_segments": false}, "connection_defaults": {"framing": "mllp", "auto_ack": true, "transport": "tcp"}}, {"code": "acme-t200", "image": "parser", "label": "Acme T-200 temperature / CVP (RS-232, polled)", "parser": "acme_t200", "version": "1", "category": "temperature_module", "protocol": "acme-t200", "controller": "serial", "default_options": {"poll_interval_sec": 2}, "connection_defaults": {"baud": 9600, "parity": "none", "idle_ms": 50, "data_bits": 8, "stop_bits": 1, "flow_control": "none"}}, {"code": "draeger-vista-120s", "image": "parser", "label": "Dräger Vista 120 S patient monitor (CMS link, TCP)", "model": "Vista 120 S", "parser": "draeger_vista_s", "version": "1", "category": "patient_monitor", "protocol": "draeger-vista-s", "controller": "socket", "manufacturer": "draeger", "default_options": {"min_interval_sec": 1}, "connection_defaults": {"framing": "raw", "auto_ack": false, "transport": "tcp"}}]	demo/release.sh	1791365809741	\N
gateway-0.2.2	gateway	0.2.2	stable	{"rust": {"tag": "0.2.2", "digest": "sha256:ae4c70f53c7eb2154be2c4150315abb10c941520cc96ee76fa70e2a5acf7c168", "repository": "flora/gateway/rust"}, "parser": {"tag": "0.2.2", "digest": "sha256:beda6d9bafb2e735e528f229a83ad6d4cca4c9d6e3d0d182258b65122a565d88", "repository": "flora/gateway/parser"}, "service": {"tag": "0.2.2", "digest": "sha256:eb08c934e67a4595693242956d246a32c1ac41cdabda36d8959f6847857705dd", "repository": "flora/gateway/service"}}	[{"code": "hl7-patient-monitor", "image": "parser", "label": "Patient monitor (HL7 v2 / IHE PCD-01)", "parser": "hl7v2", "version": "1", "category": "patient_monitor", "protocol": "hl7v2", "controller": "socket", "default_options": {"timezone": "Asia/Bangkok"}, "connection_defaults": {"framing": "mllp", "auto_ack": true, "transport": "tcp"}}, {"code": "json-anesthesia-machine", "image": "parser", "label": "Anesthesia machine (JSON push)", "parser": "json_fields", "version": "1", "category": "anesthesia_machine", "protocol": "json", "controller": "webhook", "default_options": {"units": {"fio2": "%", "et_agent": "%", "fi_agent": "%", "airway_pressure_peak": "cmH2O"}}}, {"code": "http-ventilator", "image": "parser", "label": "ICU ventilator (HTTP poll)", "parser": "json_fields", "version": "1", "category": "ventilator", "protocol": "json", "controller": "feeder", "default_options": {"codes": {"MODE": "set_vent_mode", "PEEP": "set_peep", "RR_SET": "set_rr", "VT_SET": "set_tidal_volume", "FIO2_SET": "set_fio2"}}, "connection_defaults": {"interval_ms": 5000}}, {"code": "serial-temp-module", "image": "parser", "label": "Temperature / CVP module (RS-232, polled)", "parser": "ascii_kv", "version": "1", "category": "temperature_module", "protocol": "ascii", "controller": "serial", "default_options": {"codes": {"CVP": "cvp", "TEMP": "temperature"}, "units": {"cvp": "mmHg", "temperature": "Cel"}, "poll_command": "?\\\\r\\\\n", "poll_interval_sec": 5}, "connection_defaults": {"baud": 9600, "parity": "none", "idle_ms": 80, "data_bits": 8, "stop_bits": 1, "flow_control": "none"}}, {"code": "draeger-iacs-m540", "image": "parser", "label": "Dräger M540 (IACS UDP, research mapping)", "parser": "iacs_m540", "version": "1", "category": "patient_monitor", "protocol": "draeger-iacs", "controller": "socket", "default_options": {}, "connection_defaults": {"auto_ack": false, "transport": "udp", "max_frame_bytes": 6096}}, {"code": "draeger-medibus", "image": "parser", "label": "Dräger MEDIBUS.X (RS-232 numeric data)", "parser": "medibus", "version": "1", "category": "ventilator", "protocol": "draeger-medibus", "controller": "serial", "default_options": {"poll_interval_sec": 1, "session_timeout_sec": 10, "response_timeout_sec": 3}, "connection_defaults": {"dtr": true, "rts": true, "baud": 19200, "parity": "even", "idle_ms": 20, "data_bits": 8, "stop_bits": 1, "flow_control": "none", "max_frame_bytes": 16384}}, {"code": "ge-carestation-750", "image": "parser", "label": "GE Carestation 750 (COM 1.2)", "parser": "ge_carestation", "version": "1", "category": "anesthesia_machine", "protocol": "ge-datex-com12", "controller": "serial", "default_options": {}, "connection_defaults": {"dtr": true, "rts": true, "baud": 19200, "parity": "odd", "idle_ms": 20, "data_bits": 7, "stop_bits": 1, "flow_control": "none"}}, {"code": "ge-aisys-cs2", "image": "parser", "label": "GE Aisys CS2 (Hidro COM 1.2 profile)", "parser": "ge_carestation", "version": "1", "category": "anesthesia_machine", "protocol": "ge-datex-com12", "controller": "serial", "default_options": {}, "connection_defaults": {"dtr": true, "rts": true, "baud": 19200, "parity": "odd", "idle_ms": 20, "data_bits": 7, "stop_bits": 1, "flow_control": "none"}}, {"code": "ge-bx50-dri", "image": "parser", "label": "GE Bx50 / B650 (Hidro DRI profile)", "parser": "ge_dri", "version": "1", "category": "patient_monitor", "protocol": "ge-s5-dri", "controller": "serial", "default_options": {"dri_levels": [12, 11, 10, 9, 8, 6], "checksum_mode": "escaped"}, "connection_defaults": {"dtr": true, "baud": 19200, "parity": "even", "idle_ms": 20, "data_bits": 8, "stop_bits": 1, "flow_control": "hardware"}}, {"code": "ge-s5-dri", "image": "parser", "label": "GE S/5 (DRI)", "parser": "ge_dri", "version": "1", "category": "patient_monitor", "protocol": "ge-s5-dri", "controller": "serial", "default_options": {"dri_levels": [9, 8, 7], "checksum_mode": "payload"}, "connection_defaults": {"dtr": true, "baud": 19200, "parity": "even", "idle_ms": 20, "data_bits": 8, "stop_bits": 1, "flow_control": "hardware"}}, {"code": "ge-aisys-dri", "image": "parser", "label": "GE Aisys (legacy DRI alternative)", "parser": "ge_dri", "version": "1", "category": "anesthesia_machine", "protocol": "ge-s5-dri", "controller": "serial", "default_options": {"dri_levels": [12, 11, 10, 9, 8, 6], "checksum_mode": "payload"}, "connection_defaults": {"dtr": true, "rts": true, "baud": 115200, "parity": "even", "idle_ms": 20, "data_bits": 8, "stop_bits": 1, "flow_control": "none"}}, {"code": "bbraun-space-bcc", "image": "parser", "label": "B. Braun SpaceCom (BCC TCP)", "parser": "bbraun_bcc", "version": "1", "category": "infusion_pump", "protocol": "bbraun-bcc", "controller": "socket", "default_options": {"bed_id": "1/1/1", "poll_interval_sec": 5}, "connection_defaults": {"framing": "raw", "auto_ack": false, "transport": "tcp", "reconnect_ms": 3000, "read_timeout_ms": 15000, "connect_timeout_ms": 3000}}, {"code": "hidro-hl7-monitor", "image": "parser", "label": "Hidro shared HL7 monitor (GE / configured vendor aliases)", "parser": "hidro_hl7", "version": "1", "category": "patient_monitor", "protocol": "hl7v2", "controller": "socket", "default_options": {"timezone": "Asia/Bangkok", "repair_segments": false}, "connection_defaults": {"framing": "mllp", "auto_ack": true, "transport": "tcp"}}, {"code": "acme-t200", "image": "parser", "label": "Acme T-200 temperature / CVP (RS-232, polled)", "parser": "acme_t200", "version": "1", "category": "temperature_module", "protocol": "acme-t200", "controller": "serial", "default_options": {"poll_interval_sec": 2}, "connection_defaults": {"baud": 9600, "parity": "none", "idle_ms": 50, "data_bits": 8, "stop_bits": 1, "flow_control": "none"}}, {"code": "draeger-vista-120s", "image": "parser", "label": "Dräger Vista 120 S patient monitor (CMS link, TCP)", "model": "Vista 120 S", "parser": "draeger_vista_s", "version": "1", "category": "patient_monitor", "protocol": "draeger-vista-s", "controller": "socket", "manufacturer": "draeger", "default_options": {"min_interval_sec": 1}, "connection_defaults": {"framing": "raw", "auto_ack": false, "transport": "tcp"}}]	demo/release.sh	1791366288512	\N
canopy-1.2.5	canopy	1.2.5	stable	{"api": {"tag": "1.2.5", "digest": "sha256:9788ba2f6b4a9d753e9de6f25ad792b29ec7187262f3f436ba5bf406895a1e8a", "repository": "flora/canopy/api"}, "haber": {"tag": "1.2.5", "digest": "sha256:6eba55e49199fb3666b81b8d6ddec2cfe6a787a12679dffd1113af59fe9fe3cf", "repository": "flora/canopy/haber"}}	[]	Header: ESM Flora	1791366403539	\N
gateway-0.2.3	gateway	0.2.3	stable	{"rust": {"tag": "0.2.3", "digest": "sha256:ae4c70f53c7eb2154be2c4150315abb10c941520cc96ee76fa70e2a5acf7c168", "repository": "flora/gateway/rust"}, "parser": {"tag": "0.2.3", "digest": "sha256:beda6d9bafb2e735e528f229a83ad6d4cca4c9d6e3d0d182258b65122a565d88", "repository": "flora/gateway/parser"}, "service": {"tag": "0.2.3", "digest": "sha256:4fa1e644a10af598f3657fc74663da8a9ba4de53bc81ea0c9b64e05bbe92dd8b", "repository": "flora/gateway/service"}}	[{"code": "hl7-patient-monitor", "image": "parser", "label": "Patient monitor (HL7 v2 / IHE PCD-01)", "parser": "hl7v2", "version": "1", "category": "patient_monitor", "protocol": "hl7v2", "controller": "socket", "default_options": {"timezone": "Asia/Bangkok"}, "connection_defaults": {"framing": "mllp", "auto_ack": true, "transport": "tcp"}}, {"code": "json-anesthesia-machine", "image": "parser", "label": "Anesthesia machine (JSON push)", "parser": "json_fields", "version": "1", "category": "anesthesia_machine", "protocol": "json", "controller": "webhook", "default_options": {"units": {"fio2": "%", "et_agent": "%", "fi_agent": "%", "airway_pressure_peak": "cmH2O"}}}, {"code": "http-ventilator", "image": "parser", "label": "ICU ventilator (HTTP poll)", "parser": "json_fields", "version": "1", "category": "ventilator", "protocol": "json", "controller": "feeder", "default_options": {"codes": {"MODE": "set_vent_mode", "PEEP": "set_peep", "RR_SET": "set_rr", "VT_SET": "set_tidal_volume", "FIO2_SET": "set_fio2"}}, "connection_defaults": {"interval_ms": 5000}}, {"code": "serial-temp-module", "image": "parser", "label": "Temperature / CVP module (RS-232, polled)", "parser": "ascii_kv", "version": "1", "category": "temperature_module", "protocol": "ascii", "controller": "serial", "default_options": {"codes": {"CVP": "cvp", "TEMP": "temperature"}, "units": {"cvp": "mmHg", "temperature": "Cel"}, "poll_command": "?\\\\r\\\\n", "poll_interval_sec": 5}, "connection_defaults": {"baud": 9600, "parity": "none", "idle_ms": 80, "data_bits": 8, "stop_bits": 1, "flow_control": "none"}}, {"code": "draeger-iacs-m540", "image": "parser", "label": "Dräger M540 (IACS UDP, research mapping)", "parser": "iacs_m540", "version": "1", "category": "patient_monitor", "protocol": "draeger-iacs", "controller": "socket", "default_options": {}, "connection_defaults": {"auto_ack": false, "transport": "udp", "max_frame_bytes": 6096}}, {"code": "draeger-medibus", "image": "parser", "label": "Dräger MEDIBUS.X (RS-232 numeric data)", "parser": "medibus", "version": "1", "category": "ventilator", "protocol": "draeger-medibus", "controller": "serial", "default_options": {"poll_interval_sec": 1, "session_timeout_sec": 10, "response_timeout_sec": 3}, "connection_defaults": {"dtr": true, "rts": true, "baud": 19200, "parity": "even", "idle_ms": 20, "data_bits": 8, "stop_bits": 1, "flow_control": "none", "max_frame_bytes": 16384}}, {"code": "ge-carestation-750", "image": "parser", "label": "GE Carestation 750 (COM 1.2)", "parser": "ge_carestation", "version": "1", "category": "anesthesia_machine", "protocol": "ge-datex-com12", "controller": "serial", "default_options": {}, "connection_defaults": {"dtr": true, "rts": true, "baud": 19200, "parity": "odd", "idle_ms": 20, "data_bits": 7, "stop_bits": 1, "flow_control": "none"}}, {"code": "ge-aisys-cs2", "image": "parser", "label": "GE Aisys CS2 (Hidro COM 1.2 profile)", "parser": "ge_carestation", "version": "1", "category": "anesthesia_machine", "protocol": "ge-datex-com12", "controller": "serial", "default_options": {}, "connection_defaults": {"dtr": true, "rts": true, "baud": 19200, "parity": "odd", "idle_ms": 20, "data_bits": 7, "stop_bits": 1, "flow_control": "none"}}, {"code": "ge-bx50-dri", "image": "parser", "label": "GE Bx50 / B650 (Hidro DRI profile)", "parser": "ge_dri", "version": "1", "category": "patient_monitor", "protocol": "ge-s5-dri", "controller": "serial", "default_options": {"dri_levels": [12, 11, 10, 9, 8, 6], "checksum_mode": "escaped"}, "connection_defaults": {"dtr": true, "baud": 19200, "parity": "even", "idle_ms": 20, "data_bits": 8, "stop_bits": 1, "flow_control": "hardware"}}, {"code": "ge-s5-dri", "image": "parser", "label": "GE S/5 (DRI)", "parser": "ge_dri", "version": "1", "category": "patient_monitor", "protocol": "ge-s5-dri", "controller": "serial", "default_options": {"dri_levels": [9, 8, 7], "checksum_mode": "payload"}, "connection_defaults": {"dtr": true, "baud": 19200, "parity": "even", "idle_ms": 20, "data_bits": 8, "stop_bits": 1, "flow_control": "hardware"}}, {"code": "ge-aisys-dri", "image": "parser", "label": "GE Aisys (legacy DRI alternative)", "parser": "ge_dri", "version": "1", "category": "anesthesia_machine", "protocol": "ge-s5-dri", "controller": "serial", "default_options": {"dri_levels": [12, 11, 10, 9, 8, 6], "checksum_mode": "payload"}, "connection_defaults": {"dtr": true, "rts": true, "baud": 115200, "parity": "even", "idle_ms": 20, "data_bits": 8, "stop_bits": 1, "flow_control": "none"}}, {"code": "bbraun-space-bcc", "image": "parser", "label": "B. Braun SpaceCom (BCC TCP)", "parser": "bbraun_bcc", "version": "1", "category": "infusion_pump", "protocol": "bbraun-bcc", "controller": "socket", "default_options": {"bed_id": "1/1/1", "poll_interval_sec": 5}, "connection_defaults": {"framing": "raw", "auto_ack": false, "transport": "tcp", "reconnect_ms": 3000, "read_timeout_ms": 15000, "connect_timeout_ms": 3000}}, {"code": "hidro-hl7-monitor", "image": "parser", "label": "Hidro shared HL7 monitor (GE / configured vendor aliases)", "parser": "hidro_hl7", "version": "1", "category": "patient_monitor", "protocol": "hl7v2", "controller": "socket", "default_options": {"timezone": "Asia/Bangkok", "repair_segments": false}, "connection_defaults": {"framing": "mllp", "auto_ack": true, "transport": "tcp"}}, {"code": "acme-t200", "image": "parser", "label": "Acme T-200 temperature / CVP (RS-232, polled)", "parser": "acme_t200", "version": "1", "category": "temperature_module", "protocol": "acme-t200", "controller": "serial", "default_options": {"poll_interval_sec": 2}, "connection_defaults": {"baud": 9600, "parity": "none", "idle_ms": 50, "data_bits": 8, "stop_bits": 1, "flow_control": "none"}}, {"code": "draeger-vista-120s", "image": "parser", "label": "Dräger Vista 120 S patient monitor (CMS link, TCP)", "model": "Vista 120 S", "parser": "draeger_vista_s", "version": "1", "category": "patient_monitor", "protocol": "draeger-vista-s", "controller": "socket", "manufacturer": "draeger", "default_options": {"min_interval_sec": 1}, "connection_defaults": {"framing": "raw", "auto_ack": false, "transport": "tcp"}}]	Header: ESM Flora	1791366436033	\N
gateway-0.2.4	gateway	0.2.4	stable	{"rust": {"tag": "0.2.4", "digest": "sha256:bb0c27268b1d606807cfae956a72fed15bd3202f9dbd268aa810427690e6fef8", "repository": "flora/gateway/rust"}, "parser": {"tag": "0.2.4", "digest": "sha256:ec88cf4d3e2f638cb280e56091aee484cb217df9090df3975dc9f965c4663719", "repository": "flora/gateway/parser"}, "service": {"tag": "0.2.4", "digest": "sha256:d52ac8df7ad13920af08d7e91f44fc59a49b00ce69c3ac93bfb7d7193bd9230f", "repository": "flora/gateway/service"}}	[{"code": "hl7-patient-monitor", "image": "parser", "label": "Patient monitor (HL7 v2 / IHE PCD-01)", "parser": "hl7v2", "version": "1", "category": "patient_monitor", "protocol": "hl7v2", "controller": "socket", "default_options": {"timezone": "Asia/Bangkok"}, "connection_defaults": {"framing": "mllp", "auto_ack": true, "transport": "tcp"}}, {"code": "json-anesthesia-machine", "image": "parser", "label": "Anesthesia machine (JSON push)", "parser": "json_fields", "version": "1", "category": "anesthesia_machine", "protocol": "json", "controller": "webhook", "default_options": {"units": {"fio2": "%", "et_agent": "%", "fi_agent": "%", "airway_pressure_peak": "cmH2O"}}}, {"code": "http-ventilator", "image": "parser", "label": "ICU ventilator (HTTP poll)", "parser": "json_fields", "version": "1", "category": "ventilator", "protocol": "json", "controller": "feeder", "default_options": {"codes": {"MODE": "set_vent_mode", "PEEP": "set_peep", "RR_SET": "set_rr", "VT_SET": "set_tidal_volume", "FIO2_SET": "set_fio2"}}, "connection_defaults": {"interval_ms": 5000}}, {"code": "serial-temp-module", "image": "parser", "label": "Temperature / CVP module (RS-232, polled)", "parser": "ascii_kv", "version": "1", "category": "temperature_module", "protocol": "ascii", "controller": "serial", "default_options": {"codes": {"CVP": "cvp", "TEMP": "temperature"}, "units": {"cvp": "mmHg", "temperature": "Cel"}, "poll_command": "?\\\\r\\\\n", "poll_interval_sec": 5}, "connection_defaults": {"baud": 9600, "parity": "none", "idle_ms": 80, "data_bits": 8, "stop_bits": 1, "flow_control": "none"}}, {"code": "draeger-iacs-m540", "image": "parser", "label": "Dräger M540 (IACS UDP, research mapping)", "parser": "iacs_m540", "version": "1", "category": "patient_monitor", "protocol": "draeger-iacs", "controller": "socket", "default_options": {}, "connection_defaults": {"auto_ack": false, "transport": "udp", "max_frame_bytes": 6096}}, {"code": "draeger-medibus", "image": "parser", "label": "Dräger MEDIBUS.X (RS-232 numeric data)", "parser": "medibus", "version": "1", "category": "ventilator", "protocol": "draeger-medibus", "controller": "serial", "default_options": {"poll_interval_sec": 1, "session_timeout_sec": 10, "response_timeout_sec": 3}, "connection_defaults": {"dtr": true, "rts": true, "baud": 19200, "parity": "even", "idle_ms": 20, "data_bits": 8, "stop_bits": 1, "flow_control": "none", "max_frame_bytes": 16384}}, {"code": "ge-carestation-750", "image": "parser", "label": "GE Carestation 750 (COM 1.2)", "parser": "ge_carestation", "version": "1", "category": "anesthesia_machine", "protocol": "ge-datex-com12", "controller": "serial", "default_options": {}, "connection_defaults": {"dtr": true, "rts": true, "baud": 19200, "parity": "odd", "idle_ms": 20, "data_bits": 7, "stop_bits": 1, "flow_control": "none"}}, {"code": "ge-aisys-cs2", "image": "parser", "label": "GE Aisys CS2 (Hidro COM 1.2 profile)", "parser": "ge_carestation", "version": "1", "category": "anesthesia_machine", "protocol": "ge-datex-com12", "controller": "serial", "default_options": {}, "connection_defaults": {"dtr": true, "rts": true, "baud": 19200, "parity": "odd", "idle_ms": 20, "data_bits": 7, "stop_bits": 1, "flow_control": "none"}}, {"code": "ge-bx50-dri", "image": "parser", "label": "GE Bx50 / B650 (Hidro DRI profile)", "parser": "ge_dri", "version": "1", "category": "patient_monitor", "protocol": "ge-s5-dri", "controller": "serial", "default_options": {"dri_levels": [12, 11, 10, 9, 8, 6], "checksum_mode": "escaped"}, "connection_defaults": {"dtr": true, "baud": 19200, "parity": "even", "idle_ms": 20, "data_bits": 8, "stop_bits": 1, "flow_control": "hardware"}}, {"code": "ge-s5-dri", "image": "parser", "label": "GE S/5 (DRI)", "parser": "ge_dri", "version": "1", "category": "patient_monitor", "protocol": "ge-s5-dri", "controller": "serial", "default_options": {"dri_levels": [9, 8, 7], "checksum_mode": "payload"}, "connection_defaults": {"dtr": true, "baud": 19200, "parity": "even", "idle_ms": 20, "data_bits": 8, "stop_bits": 1, "flow_control": "hardware"}}, {"code": "ge-aisys-dri", "image": "parser", "label": "GE Aisys (legacy DRI alternative)", "parser": "ge_dri", "version": "1", "category": "anesthesia_machine", "protocol": "ge-s5-dri", "controller": "serial", "default_options": {"dri_levels": [12, 11, 10, 9, 8, 6], "checksum_mode": "payload"}, "connection_defaults": {"dtr": true, "rts": true, "baud": 115200, "parity": "even", "idle_ms": 20, "data_bits": 8, "stop_bits": 1, "flow_control": "none"}}, {"code": "bbraun-space-bcc", "image": "parser", "label": "B. Braun SpaceCom (BCC TCP)", "parser": "bbraun_bcc", "version": "1", "category": "infusion_pump", "protocol": "bbraun-bcc", "controller": "socket", "default_options": {"bed_id": "1/1/1", "poll_interval_sec": 5}, "connection_defaults": {"framing": "raw", "auto_ack": false, "transport": "tcp", "reconnect_ms": 3000, "read_timeout_ms": 15000, "connect_timeout_ms": 3000}}, {"code": "hidro-hl7-monitor", "image": "parser", "label": "Hidro shared HL7 monitor (GE / configured vendor aliases)", "parser": "hidro_hl7", "version": "1", "category": "patient_monitor", "protocol": "hl7v2", "controller": "socket", "default_options": {"timezone": "Asia/Bangkok", "repair_segments": false}, "connection_defaults": {"framing": "mllp", "auto_ack": true, "transport": "tcp"}}, {"code": "acme-t200", "image": "parser", "label": "Acme T-200 temperature / CVP (RS-232, polled)", "parser": "acme_t200", "version": "1", "category": "temperature_module", "protocol": "acme-t200", "controller": "serial", "default_options": {"poll_interval_sec": 2}, "connection_defaults": {"baud": 9600, "parity": "none", "idle_ms": 50, "data_bits": 8, "stop_bits": 1, "flow_control": "none"}}, {"code": "draeger-vista-120s", "image": "parser", "label": "Dräger Vista 120 S patient monitor (CMS link, TCP)", "model": "Vista 120 S", "parser": "draeger_vista_s", "version": "1", "category": "patient_monitor", "protocol": "draeger-vista-s", "controller": "socket", "manufacturer": "draeger", "default_options": {"min_interval_sec": 1}, "connection_defaults": {"framing": "raw", "auto_ack": false, "transport": "tcp"}}]	demo/release.sh	1791385542957	\N
canopy-1.2.6	canopy	1.2.6	stable	{"api": {"tag": "1.2.6", "digest": "sha256:b3abf6674683a57bb710e1c6292e36d34dc349ddec46d7323e4cc445472ed6fe", "repository": "flora/canopy/api"}, "haber": {"tag": "1.2.6", "digest": "sha256:6eba55e49199fb3666b81b8d6ddec2cfe6a787a12679dffd1113af59fe9fe3cf", "repository": "flora/canopy/haber"}}	[]	demo/release.sh	1791386644736	\N
leaf-1.2.3	leaf	1.2.3	stable	{"api": {"tag": "1.2.3", "digest": "sha256:b795c63405af89ef94ba89b5803b06271d2dc277992117fff39f93c4a303cd69", "repository": "flora/leaf/api"}, "sync": {"tag": "1.2.3", "digest": "sha256:4c54997070fd61188d0413637e500757446bcb9beb9bc0aa52ec90bdfa7af8b0", "repository": "flora/leaf/sync"}}	[]	demo/release.sh	1791387475565	\N
leaf-1.2.4	leaf	1.2.4	stable	{"api": {"tag": "1.2.4", "digest": "sha256:57cd4f24b08242f0756bca762d7c020570c0ea68fb972c80b55c1be06d8234bb", "repository": "flora/leaf/api"}, "sync": {"tag": "1.2.4", "digest": "sha256:dccc362bc3ceb01a686056dd85b5e5f22dbd2984a7a64481c897d007bb8156fe", "repository": "flora/leaf/sync"}}	[]	demo/release.sh	1791425564373	\N
leaf-1.2.5	leaf	1.2.5	stable	{"api": {"tag": "1.2.5", "digest": "sha256:c1c33cc7f9b43adcb76d2b1c905b7ba8eff51e3e4e7a1bce37f211ebab40fbb4", "repository": "flora/leaf/api"}, "sync": {"tag": "1.2.5", "digest": "sha256:dccc362bc3ceb01a686056dd85b5e5f22dbd2984a7a64481c897d007bb8156fe", "repository": "flora/leaf/sync"}}	[]	demo/release.sh	1791476086442	\N
leaf-1.2.6	leaf	1.2.6	stable	{"api": {"tag": "1.2.6", "digest": "sha256:34f2826f1671e195c020bfe000c0d9cc167b8cd4ab8c64814e457342cbdc5c1a", "repository": "flora/leaf/api"}, "sync": {"tag": "1.2.6", "digest": "sha256:dccc362bc3ceb01a686056dd85b5e5f22dbd2984a7a64481c897d007bb8156fe", "repository": "flora/leaf/sync"}}	[]	demo/release.sh	1791479879025	\N
canopy-1.2.7	canopy	1.2.7	stable	{"api": {"tag": "1.2.7", "digest": "sha256:ae843b54eea4278916a55265a972e61131d13fb854022bcd10c33168441167d4", "repository": "flora/canopy/api"}, "haber": {"tag": "1.2.7", "digest": "sha256:8b726954059f9a6c7a442de85eb979fef01ad29dd291df02c78286e6387ff466", "repository": "flora/canopy/haber"}}	[]	demo/release.sh	1791875951834	\N
leaf-1.2.7	leaf	1.2.7	stable	{"api": {"tag": "1.2.7", "digest": "sha256:24d6452b330c5246bf1db5e8e15eb13e5fa8e69a7e5b41456994f777708c647f", "repository": "flora/leaf/api"}, "sync": {"tag": "1.2.7", "digest": "sha256:66f7902736691665c81a073661944333b2c602e3f1c014a33270ca60b6c95e9c", "repository": "flora/leaf/sync"}}	[]	demo/release.sh	1791876584756	\N
canopy-1.2.8	canopy	1.2.8	stable	{"api": {"tag": "1.2.8", "digest": "sha256:a72120f205889e2eefe55ef29ca8ea69cb7f84241c331124b2d1f4ed0705c8f8", "repository": "flora/canopy/api"}, "haber": {"tag": "1.2.8", "digest": "sha256:8b726954059f9a6c7a442de85eb979fef01ad29dd291df02c78286e6387ff466", "repository": "flora/canopy/haber"}}	[]	demo/release.sh	1791876593467	\N
canopy-1.2.9	canopy	1.2.9	stable	{"api": {"tag": "1.2.9", "digest": "sha256:1632581f3f0c07244e70139b80caadd6256e323c59fa778665842933584c9792", "repository": "flora/canopy/api"}, "haber": {"tag": "1.2.9", "digest": "sha256:8b726954059f9a6c7a442de85eb979fef01ad29dd291df02c78286e6387ff466", "repository": "flora/canopy/haber"}}	[]	demo/release.sh	1791877147661	\N
leaf-1.2.8	leaf	1.2.8	stable	{"api": {"tag": "1.2.8", "digest": "sha256:0dca7b8c033987d97f65c23c98dd2c7c8e4f30e7d3aa7319cecab72cadb0ba97", "repository": "flora/leaf/api"}, "sync": {"tag": "1.2.8", "digest": "sha256:66f7902736691665c81a073661944333b2c602e3f1c014a33270ca60b6c95e9c", "repository": "flora/leaf/sync"}}	[]	demo/release.sh	1791877464312	\N
\.


--
-- Data for Name: root_session; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.root_session (token_hash, user_id, created_at, expires_at, last_seen_at, ip, user_agent) FROM stdin;
\.


--
-- Data for Name: root_signing_key; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.root_signing_key (key_id, private_pem, public_raw, active, created_at) FROM stdin;
\.


--
-- Data for Name: root_tenant; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.root_tenant (tenant_id, name, region, status, api_key_hash, created_at, updated_at, release_channel) FROM stdin;
hospital-01	Demo Hospital	TH	active	0f07cf66590cc1fccfbcfc1d8fab80846a32e10f02f5e54d54d6e5fbcd352933	1790883710705	1790883710705	stable
\.


--
-- Data for Name: root_user; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.root_user (id, username, password_hash, display_name, role, enabled, must_change_password, failed_logins, locked_until, created_at, updated_at, last_login_at) FROM stdin;
2	qa-viewer	scrypt$16384$8$1$137481af90c97e6fe5c55e3a2d6e2c39$2831aa114cb13a95dc27fa47de49233043ef348cd260b2c250f73391eff48a1b	QA Viewer	viewer	f	f	0	\N	1791260236878	1791260297847	1791260237263
1	admin	scrypt$16384$8$1$137481af90c97e6fe5c55e3a2d6e2c39$2831aa114cb13a95dc27fa47de49233043ef348cd260b2c250f73391eff48a1b	Root Administrator	admin	t	f	0	\N	1791260217035	1791260217035	1791866279924
\.


--
-- Name: root_audit_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.root_audit_id_seq', 61, true);


--
-- Name: root_user_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.root_user_id_seq', 2, true);


--
-- Name: device_connection_type device_connection_type_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.device_connection_type
    ADD CONSTRAINT device_connection_type_pkey PRIMARY KEY (connection_type);


--
-- Name: device_manufacturer device_manufacturer_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.device_manufacturer
    ADD CONSTRAINT device_manufacturer_pkey PRIMARY KEY (manufacturer_code);


--
-- Name: device_protocol_lane device_protocol_lane_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.device_protocol_lane
    ADD CONSTRAINT device_protocol_lane_pkey PRIMARY KEY (lane_no);


--
-- Name: device_protocol device_protocol_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.device_protocol
    ADD CONSTRAINT device_protocol_pkey PRIMARY KEY (protocol);


--
-- Name: device_type device_type_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.device_type
    ADD CONSTRAINT device_type_pkey PRIMARY KEY (device_type_id);


--
-- Name: device_type_source device_type_source_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.device_type_source
    ADD CONSTRAINT device_type_source_pkey PRIMARY KEY (source_id);


--
-- Name: root_audit root_audit_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.root_audit
    ADD CONSTRAINT root_audit_pkey PRIMARY KEY (id);


--
-- Name: root_checkin root_checkin_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.root_checkin
    ADD CONSTRAINT root_checkin_pkey PRIMARY KEY (tenant_id);


--
-- Name: root_global_config root_global_config_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.root_global_config
    ADD CONSTRAINT root_global_config_pkey PRIMARY KEY (key);


--
-- Name: root_license root_license_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.root_license
    ADD CONSTRAINT root_license_pkey PRIMARY KEY (bundle_id);


--
-- Name: root_release root_release_component_version_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.root_release
    ADD CONSTRAINT root_release_component_version_key UNIQUE (component, version);


--
-- Name: root_release root_release_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.root_release
    ADD CONSTRAINT root_release_pkey PRIMARY KEY (release_id);


--
-- Name: root_session root_session_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.root_session
    ADD CONSTRAINT root_session_pkey PRIMARY KEY (token_hash);


--
-- Name: root_signing_key root_signing_key_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.root_signing_key
    ADD CONSTRAINT root_signing_key_pkey PRIMARY KEY (key_id);


--
-- Name: root_tenant root_tenant_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.root_tenant
    ADD CONSTRAINT root_tenant_pkey PRIMARY KEY (tenant_id);


--
-- Name: root_user root_user_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.root_user
    ADD CONSTRAINT root_user_pkey PRIMARY KEY (id);


--
-- Name: root_user root_user_username_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.root_user
    ADD CONSTRAINT root_user_username_key UNIQUE (username);


--
-- Name: device_type_manufacturer; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX device_type_manufacturer ON public.device_type USING btree (manufacturer_code);


--
-- Name: device_type_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX device_type_status ON public.device_type USING btree (status);


--
-- Name: root_audit_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX root_audit_at ON public.root_audit USING btree (at DESC);


--
-- Name: root_license_current; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX root_license_current ON public.root_license USING btree (tenant_id) WHERE current;


--
-- Name: root_session_expiry; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX root_session_expiry ON public.root_session USING btree (expires_at);


--
-- Name: device_connection_type device_connection_type_source_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.device_connection_type
    ADD CONSTRAINT device_connection_type_source_id_fkey FOREIGN KEY (source_id) REFERENCES public.device_type_source(source_id);


--
-- Name: device_manufacturer device_manufacturer_source_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.device_manufacturer
    ADD CONSTRAINT device_manufacturer_source_id_fkey FOREIGN KEY (source_id) REFERENCES public.device_type_source(source_id);


--
-- Name: device_protocol_lane device_protocol_lane_source_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.device_protocol_lane
    ADD CONSTRAINT device_protocol_lane_source_id_fkey FOREIGN KEY (source_id) REFERENCES public.device_type_source(source_id);


--
-- Name: device_protocol device_protocol_source_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.device_protocol
    ADD CONSTRAINT device_protocol_source_id_fkey FOREIGN KEY (source_id) REFERENCES public.device_type_source(source_id);


--
-- Name: root_checkin root_checkin_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.root_checkin
    ADD CONSTRAINT root_checkin_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.root_tenant(tenant_id);


--
-- Name: root_license root_license_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.root_license
    ADD CONSTRAINT root_license_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.root_tenant(tenant_id);


--
-- Name: root_session root_session_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.root_session
    ADD CONSTRAINT root_session_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.root_user(id) ON DELETE CASCADE;


--
-- PostgreSQL database dump complete
--

\unrestrict SWgpm5gCrXbjMFUuszonOzoGN88VZ8aew5u3ubYr59fp5XCgShbkThKsPYBKS7y

