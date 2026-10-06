import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CaseStatus } from "../api/caseApi";
import ConfirmDialog from "../components/common/ConfirmDialog";
import {
  getCaseDetailDraft,
  patchCaseDetailDraft,
  saveCaseDetailDraft,
} from "../api/caseDetailApi";
import { getCasePatientInfo, updateCasePatientInfo } from "../api/caseHisApi";
import {
  formatDateInputDDMMYYYY,
  normalizeDateInputDDMMYYYY,
  normalizeTimeInputHHMM,
} from "../utils/clinicalInput";
import {
  PATIENT_DRAFT_FIELD_KEYS,
  SHARED_PATIENT_FORM_FIELD_KEYS,
  pickDraftFields,
} from "../utils/patientSharedFields";

type LegacyFormField = {
  sourceForm?: string;
  section?: string;
  label: string;
  value: string;
  unit?: string;
  recordedAt?: string;
  mappingStatus?: "native" | "derived" | "read_only_legacy" | "unmapped";
};
type FormValue = string | boolean | string[] | LegacyFormField[];
type FormState = Record<string, FormValue>;
type FormTabId =
  | "caseInfo"
  | "preop"
  | "checklist"
  | "ga_ett"
  | "ga_lma"
  | "ga_tubeless"
  | "neuraxial"
  | "pnb"
  | "line"
  | "invasive"
  | "comorbid"
  | "extubation"
  | "pacu"
  | "pain"
  | "outcome";

const GA_TAB_IDS: FormTabId[] = ["ga_ett", "ga_lma", "ga_tubeless"];
type AirwayTechniqueOutcome = "success" | "failure";
type AirwayTechnique = {
  id: string;
  outcome: AirwayTechniqueOutcome;
  technique_type: string;
  blade_type: string;
  blade_size: string;
  guide_stylet: string;
  laryngoscopic_view: string;
  attempt_no: string;
  vdo_type: string;
  vdo_other_type: string;
  vdo_blade: string;
  size_mm: string;
};

const FORM_TAB_DEFS: Array<{ id: FormTabId; label: string; removable: boolean }> = [
  { id: "caseInfo", label: "Case & Plan", removable: false },
  { id: "preop", label: "Pre-anesthesia", removable: false },
  { id: "checklist", label: "Safety Checklist", removable: false },
  { id: "ga_ett", label: "GA ETT", removable: true },
  { id: "ga_lma", label: "GA LMA", removable: true },
  { id: "ga_tubeless", label: "GA Tubeless", removable: true },
  { id: "neuraxial", label: "Neuraxial Block", removable: true },
  { id: "pnb", label: "PNB", removable: true },
  { id: "line", label: "Line", removable: true },
  { id: "comorbid", label: "Comorbid", removable: true },
  { id: "extubation", label: "Extubation", removable: true },
  { id: "pacu", label: "Recovery / PACU", removable: false },
  { id: "pain", label: "Pain", removable: true },
  { id: "outcome", label: "Outcome", removable: false },
];

const NON_GA_ADDABLE_TABS = FORM_TAB_DEFS.filter(t => t.removable && !GA_TAB_IDS.includes(t.id));

const FORM_REQUIRED_TAB: FormTabId = "caseInfo";
const CORE_FORM_TABS: FormTabId[] = ["caseInfo", "preop", "checklist", "pacu", "outcome"];
const TAB_REQUIRED_FIELDS: Partial<Record<FormTabId, string[]>> = {
  caseInfo: ["hn", "service", "anesthesiaTypes", "postoperativeDestination"],
  preop: ["preopConsent", "preopNpoStatus", "preopAirwayAssessment"],
  checklist: ["checklistPatientIdentity", "checklistProcedure", "checklistConsent", "checklistMachine"],
  pacu: ["pacuArrivalTime", "pacuAirway", "pacuDestination"],
  outcome: ["outcomeStatus"],
};
const AIRWAY_DETAIL_FIELDS_BY_DEVICE: Record<string, string[]> = {
  facemask: ["mask_adjunct", "opa_size", "npa_size"],
  oral_endotracheal_tube: [
    "oral_tube_type", "oral_tube_size", "oral_tube_mark_cm",
    "oral_cuff", "oral_cuff_volume_ml", "oral_cuff_pressure_cmh2o",
    "oral_tube_depth_cm", "oral_throat_pack", "oral_tube_in_situ",
  ],
  nasal_endotracheal_tube: [
    "nasal_tube_type", "nasal_tube_size", "nasal_tube_mark_cm",
    "nasal_cuff", "nasal_cuff_volume_ml", "nasal_cuff_pressure_cmh2o",
    "nasal_tube_depth_cm", "nasal_preparation", "nasal_nostril",
    "nasal_throat_pack", "nasal_tube_in_situ",
  ],
  tracheostomy_tube: [
    "trach_type", "trach_size", "trach_cuff",
    "trach_cuff_volume_ml", "trach_cuff_pressure_cmh2o", "trach_tube_in_situ",
  ],
  lma: ["lma_type", "lma_size", "lma_cuff_volume_ml", "lma_number_of_attempts", "lma_confirmation"],
  jet_ventilation: ["jet_type"],
  rigid_bronchoscope: [],
};
const AIRWAY_DETAIL_FIELDS = Array.from(
  new Set(Object.values(AIRWAY_DETAIL_FIELDS_BY_DEVICE).flat()),
);

/**
 * Maps each anesthesia-type checkbox value to the form tab it populates.
 * Checking a type auto-opens that tab; unchecking removes it if no other
 * checked type still needs it.
 */
const ANESTHESIA_TAB_MAP: Partial<Record<string, FormTabId>> = {
  "Spinal anesthesia":   "neuraxial",
  "Epidural anesthesia": "neuraxial",
  "Peripheral nerve block": "pnb",
  "Truncal block": "pnb",
  // "General anesthesia" now uses GA ETT/LMA/Tubeless tabs selected manually
  // "Conscious sedation/MAC" intentionally omitted — no dedicated tab
};

function normalizeEnabledForms(v: FormValue | undefined): FormTabId[] {
  const order = FORM_TAB_DEFS.map(tab => tab.id);
  const allowed = new Set(order);
  const raw = Array.isArray(v) ? v : [];
  const seen = new Set<FormTabId>();
  for (const required of CORE_FORM_TABS) seen.add(required);
  for (const item of raw) {
    if (typeof item !== "string") continue;
    if (item === "invasive") {
      seen.add("line");
      continue;
    }
    if (!allowed.has(item as FormTabId)) continue;
    seen.add(item as FormTabId);
  }
  return order.filter(id => seen.has(id));
}

export type FormDraftSnapshot = {
  draft: Record<string, unknown> | null;
  updated_at?: number | null;
};

/**
 * Pluggable storage for the form draft. Without one, FormView edits the active
 * Leaf case through /api/case/{id}/detail-draft.
 */
export type FormDataSource = {
  /** localStorage cache key, e.g. `doctor_form_canopy_{admissionId}`. */
  key: string;
  hn: string;
  load: () => Promise<FormDraftSnapshot>;
  /** Receives only the keys changed locally; returns the merged server draft. */
  patch: (patch: Record<string, unknown>) => Promise<{ draft?: Record<string, unknown> | null; updated_at?: number | null }>;
  readOnly?: boolean;
  /** Patient demographics are owned elsewhere: never send patient keys. */
  patientFieldsReadOnly?: boolean;
};

export type FormSaveState = {
  status: "idle" | "saving" | "saved" | "error";
  at?: number;
  message?: string;
};

interface FormViewProps {
  caseStatus?: CaseStatus;
  source?: FormDataSource;
  /** Restrict the visible tabs (e.g. ["preop", "checklist"] on a ward tablet). */
  allowedTabs?: readonly string[];
  onSaveStateChange?: (state: FormSaveState) => void;
  /** How often to pull edits made on the other side (Leaf <-> Canopy). */
  refreshIntervalMs?: number;
}

const IDLE_CASE: CaseStatus = { status: "IDLE" };
const FORM_REMOTE_REFRESH_MS = 10_000;

const card =
  "rounded-2xl border border-[var(--app-border)] bg-[var(--app-panel-bg)] p-4 space-y-4 shadow-sm";
const input =
  "min-h-11 w-full rounded-xl border border-[var(--app-control-border)] bg-[var(--app-control-bg)] px-3 py-2 text-sm text-[var(--app-text)] outline-none transition focus:border-[var(--app-accent)] focus:ring-2 focus:ring-[var(--app-accent)]/15";
const inputNarrow =
  "min-h-11 w-full rounded-xl border border-[var(--app-control-border)] bg-[var(--app-control-bg)] px-3 py-2 text-sm text-[var(--app-text)] outline-none transition focus:border-[var(--app-accent)] focus:ring-2 focus:ring-[var(--app-accent)]/15";
const inputCompact =
  "min-h-10 w-full rounded-xl border border-[var(--app-control-border)] bg-[var(--app-control-bg)] px-3 py-2 text-sm text-[var(--app-text)] outline-none transition focus:border-[var(--app-accent)]";
const label = "text-[10px] font-extrabold uppercase tracking-[0.12em] text-[var(--app-muted)]";
const primaryButton = "min-h-10 rounded-xl bg-[var(--app-accent)] px-4 py-2 text-sm font-bold text-[var(--app-accent-contrast)] hover:brightness-105";
const secondaryButton =
  "min-h-10 rounded-xl border border-[var(--app-border)] bg-[var(--app-control-bg)] px-4 py-2 text-sm font-semibold text-[var(--app-text)] hover:bg-[var(--app-control-bg-hover)]";
const dangerButton =
  "rounded border border-red-400 text-red-600 dark:text-red-300 px-3 py-1.5 text-sm";
const tabButtonBase =
  "rounded border px-3 py-1.5 text-sm transition-colors";
const split = (v: string) => v.split("|");

function normalizeMonitoringList(values: unknown): string[] {
  if (!Array.isArray(values)) return [];
  const normalized: string[] = [];
  for (const raw of values) {
    if (typeof raw !== "string") continue;
    const value = raw.trim();
    if (!value) continue;
    if (value === "EEG") {
      normalized.push("EEG/BIS");
      continue;
    }
    if (value === "NIR") {
      normalized.push("NIR Left", "NIR Right");
      continue;
    }
    normalized.push(value);
  }
  return Array.from(new Set(normalized));
}

const options = {
  serviceProvider: split(
    "G1|G2|G3|G4|Colorectal surgery|Urosurgery|Plastic surgery|Cardiothoracic surgery|Neurosurgery|Pediatric surgery|Obs & Gyn surgery|Orthopedic surgery|Ophthalmology|ENT|Breast center|Bronchoscopy|GI endoscopy|Surgical endoscopy|Cath Lab|ECT|Interventional radiology|Diagnostic radiology|Radiation therapy|Nuclear medicine|Other",
  ),
  anesthesia: split(
    "General anesthesia|Spinal anesthesia|Epidural anesthesia|Peripheral nerve block|Truncal block|Conscious sedation/MAC",
  ),
  monitoring: split(
    "NIBP|ECG|Pulse oximetry|Capnography|Temperature|Urine output|Invasive blood pressure|Central venous pressure|Pulmonary arterial pressure|Cardiac output|EEG/BIS|NIR Left|NIR Right",
  ),
  positioning: split(
    "Supine|Prone|Lithotomy|Trendelenburg|Reverse Trendelenburg|Lateral (right)|Lateral (left)|Sitting",
  ),
  patientSafety: split(
    "Close eyes|Support pressure points|Secured extremities|Check alignments",
  ),
  temperatureControl: split("Forced-air warmer|Fluid warmer|Water blanket"),
  ivSites: split(
    "Right hand|Left hand|Right forearm|Left forearm|Right arm|Left arm|Right leg|Left leg",
  ),
  ivSimpleInserted: split("Inserted in OR|In-situ|Inserted in ward|Inserted in ICU"),
  arterialSites: split(
    "Right radial artery|Left radial artery|Right femoral artery|Left femoral artery|Right brachial artery|Left brachial artery|Right dorsalis pedis|Left dorsalis pedis",
  ),
  cvcSites: split(
    "Right internal jugular vein|Left internal jugular vein|Right subclavian vein|Left subclavian vein|Right brachial vein|Left brachial vein|Right femoral vein|Left femoral vein|Right external jugular vein|Left external jugular vein",
  ),
  invasiveCvcSites: split(
    "Right internal jugular|Left internal jugular|Right subclavian|Left subclavian|Right femoral|Left femoral",
  ),
  invasiveLineCounts: split("0|1|2|3|4"),
  invasiveInserted: split("Inserted in OR|In-situ|Inserted in ICU|Inserted in ward"),
  invasiveSide: split("Left|Right"),
  invasiveArterialSites: split(
    "Radial artery|Femoral artery|Brachial artery|Dorsalis pedis|Axillary artery|Other",
  ),
  invasiveCvcSimpleSites: split(
    "Internal jugular vein|Subclavian vein|Femoral vein|External jugular vein|Brachial vein|Other",
  ),
  invasiveCvcTechnique: split("Landmark|Ultrasound guide|Ultrasound-guide landmark"),
  invasiveCvcTypes: split(
    "1 Lumen|2 Lumens|3 Lumens|4 Lumens|Introducer|Dialysis catheter|PICC|Other",
  ),
  invasiveCatheterSizes: split("4F|5F|6F|7F|8.5F|9F"),
  invasiveDifficulty: split("No|Yes"),
  invasiveYesNo: split("No|Yes"),
  invasiveSterilePrecautions: split(
    "Sterile/Drapes/Gown/Gloves/Glasses|Hand hygiene|Sterile gown|Sterile gloves|Sterile drape|Cap|Mask|Eye protection|Sterile probe cover",
  ),
  ivGauge: split("14 G|16 G|18 G|20 G|22 G|24 G"),
  arterialGauge: split("14 G|16 G|18 G|20 G|22 G|24 G"),
  cvcLumens: split("Single|Double|Triple"),
  cvcSizeFr: split("4 Fr|5 Fr|6 Fr|7 Fr|8.5 Fr|9 Fr"),
  levels: split(
    "T6-T7|T7-T8|T8-T9|T9-T10|T10-T11|T11-T12|T12-L1|L1-L2|L2-L3|L3-L4|L4-L5",
  ),
  sterileBarrier: split("Sterile gloves|Sterile drape|Mask|Cap"),
  cvcSterileBarrier: split(
    "Sterile gown|Sterile gloves|Sterile drape|Cap|Mask|Glasses|Sterile probe cover",
  ),
  skinPrep: split(
    "Alcoholic chlorhexidine|Povidone iodine|Chlorhexidine|Tincture iodine|Alcohol",
  ),
  neuraxialTechniques: split("Spinal|Epidural|Combined spinal-epidural|Caudal"),
  pnbTechniques: split(
    "FIPB|Femoral block|Adductor canal block|Sciatic block|Popliteal sciatic block|Interscalene block|Supraclavicular block|Infraclavicular block|Axillary block|TAP block|ESP block|PECS block|Paravertebral block|Other",
  ),
  pnbPerformedTechniques: split("Single shot|Continuous catheter"),
  pnbGuidance: split("Anatomical / PNS|USG-guided|USG + PNS|Other"),
  pnbSides: split("Left|Right|Bilateral|Midline"),
  pnbNeedles: split("Stimuplex|Echogenic block needle|Tuohy|Other"),
  pnbNeedleGauge: split("18 G|20 G|21 G|22 G|23 G"),
  pnbAsepticTechnique: split(
    "Sterile gloves|Sterile drape|Mask|Cap|Sterile probe cover",
  ),
  gaPreInduction: split(
    "IV line flush and test|Preoxygenate with 100% high flow oxygen",
  ),
  gaInduction: split("IV induction|Inhalation induction|Rapid sequence induction"),
  gaEyeProtection: split("taped|ointment|none"),
  gaPrimaryAirway: split(
    "oral_endotracheal_tube|nasal_endotracheal_tube|mask|lma|tracheostomy_tube|jet_ventilation|other",
  ),
  gaMaskAdjunct: split("none|oropharyngeal_airway|nasopharyngeal_airway"),
  gaMaskVentilationDifficulty: split("easy|difficult|impossible"),
  gaTubeType: split("standard_pvc|wire_reinforced|rae|double_lumen|laser_tube|mlt|other"),
  gaCuff: split("cuffed|uncuffed"),
  gaYesNo: split("yes|no"),
  gaNasalPreparation: split("cocaine|lidocaine|lidadin|oxymetazoline|other"),
  gaNostril: split("left|right|bilateral"),
  gaLmaType: split("first_generation|second_generation|flexible_lma"),
  gaLmaConfirmation: split("chest_rise|positive_capnography"),
  gaTrachType: split("portex|shiley|silver|other"),
  gaJetType: split("hfjv|manual"),
  gaTubelessTechnique: split("facemask|jet_ventilation|rigid_bronchoscope"),
  gaTechniqueType: split("direct_laryngoscopy|vdo_laryngoscopy|fiberoptic|fiberscope_bonfils"),
  gaBladeType: split("macintosh|miller"),
  gaVdoType: split("c-mac|mc_grath|glidescope|other"),
  gaVdoBlade: split("adult|pediatric|d-blade"),
  gaGuideStylet: split("yes|no"),
  gaLaryngoscopicView: split("1|2|3|4"),
  gaAttemptNumber: split("1|2|3|4|5|6"),
  extubationLocation: split("Extubated in OR|Extubated in PACU|Extubated in ICU|Remain Intubated"),
  extubationStatus: split("awake|deep|other"),
  extubationCondition: split("Awake, follow command|Deep anesthesia|Smooth extubation|Not assessed|Other"),
  extubationTof: split("No|Yes"),
  cvcPre: split(
    "All lumens are flushed and clamped|Patient is placed in Trendelenburg position",
  ),
  cvcPlacement: split(
    "Ultrasound visualization|Manometry|Venous waveform|Blood gas analysis|X-ray|ECG",
  ),
  cvcPost: split(
    "Guidewire is removed|Blood is aspirated from all lumens and flush|Apply sterile caps on all hubs|Apply sterile dressing",
  ),
};

function isServiceOption(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) return false;
  return options.serviceProvider.includes(trimmed);
}

function defaults(hn: string): FormState {
  return {
    hn,
    an: "",
    dob: "",
    ageY: "",
    ageM: "",
    heightCm: "",
    weightKg: "",
    bloodGroupABO: "",
    bloodGroupRh: "",
    asa: "",
    emergency: false,
    service: "",
    serviceProviderOther: "",
    clinic: "IPD",
    postoperativeDestination: "PACU",
    diagnosis: [""],
    operation: [""],
    anesthesiaTypes: [],
    monitoring: ["NIBP", "ECG", "Pulse oximetry"],
    positioning: [],
    headSupport: "",
    rightArmPosition: "",
    leftArmPosition: "",
    patientSafetyChecks: [],
    temperatureControl: [],
    ivSites: "",
    ivCatheterSize: "",
    ivWhereInserted: "",
    ivAttempts: "",
    ivLineCount: "0",
    ivLine1Site: "",
    ivLine1Gauge: "",
    ivLine1Inserted: "",
    ivLine1Attempts: "",
    ivLine1Note: "",
    ivLine2Site: "",
    ivLine2Gauge: "",
    ivLine2Inserted: "",
    ivLine2Attempts: "",
    ivLine2Note: "",
    ivLine3Site: "",
    ivLine3Gauge: "",
    ivLine3Inserted: "",
    ivLine3Attempts: "",
    ivLine3Note: "",
    ivLine4Site: "",
    ivLine4Gauge: "",
    ivLine4Inserted: "",
    ivLine4Attempts: "",
    ivLine4Note: "",
    arterialSites: "",
    arterialCatheterSize: "",
    arterialWhereInserted: "",
    arterialAttempts: "",
    cvcSites: "",
    cvcCatheterSize: "",
    cvcLumens: "",
    cvcWhereInserted: "",
    cvcUltrasound: "",
    cvcAttempts: "",
    pre_induction: [],
    induction: [],
    mask_ventilation_difficulty: "",
    eye_protection: [],
    primary_airway_device: "",
    secondary_airway_enabled: false,
    secondary_airway_device: "",
    mask_adjunct: "",
    opa_size: "",
    npa_size: "",
    oral_tube_type: "",
    oral_tube_size: "",
    oral_tube_mark_cm: "",
    oral_cuff: "",
    oral_cuff_volume_ml: "",
    oral_cuff_pressure_cmh2o: "",
    oral_tube_depth_cm: "",
    oral_throat_pack: "",
    oral_tube_in_situ: "",
    nasal_tube_type: "",
    nasal_tube_size: "",
    nasal_tube_mark_cm: "",
    nasal_cuff: "",
    nasal_cuff_volume_ml: "",
    nasal_cuff_pressure_cmh2o: "",
    nasal_tube_depth_cm: "",
    nasal_preparation: "",
    nasal_nostril: "",
    nasal_throat_pack: "",
    nasal_tube_in_situ: "",
    lma_type: "",
    lma_size: "",
    lma_cuff_volume_ml: "",
    lma_number_of_attempts: "",
    lma_confirmation: [],
    trach_type: "",
    trach_size: "",
    trach_cuff: "",
    trach_cuff_volume_ml: "",
    trach_cuff_pressure_cmh2o: "",
    trach_tube_in_situ: "",
    jet_type: "",
    airway_description: "",
    primary_airway_techniques: "[]",
    primary_failed_intubation: false,
    secondary_mask_adjunct: "",
    secondary_opa_size: "",
    secondary_npa_size: "",
    secondary_oral_tube_type: "",
    secondary_oral_tube_size: "",
    secondary_oral_cuff: "",
    secondary_oral_cuff_volume_ml: "",
    secondary_oral_tube_depth_cm: "",
    secondary_oral_throat_pack: "",
    secondary_oral_tube_in_situ: "",
    secondary_nasal_tube_type: "",
    secondary_nasal_tube_size: "",
    secondary_nasal_cuff: "",
    secondary_nasal_cuff_volume_ml: "",
    secondary_nasal_tube_depth_cm: "",
    secondary_nasal_preparation: "",
    secondary_nasal_nostril: "",
    secondary_nasal_throat_pack: "",
    secondary_nasal_tube_in_situ: "",
    secondary_lma_type: "",
    secondary_lma_size: "",
    secondary_lma_cuff_volume_ml: "",
    secondary_lma_number_of_attempts: "",
    secondary_trach_type: "",
    secondary_trach_size: "",
    secondary_trach_cuff: "",
    secondary_trach_cuff_volume_ml: "",
    secondary_jet_type: "",
    secondary_airway_description: "",
    secondary_airway_techniques: "[]",
    secondary_failed_intubation: false,
    neuraxialTechniques: [],
    neuraxialBlockType: "",
    neuraxialSterilePrecautions: [],
    spinalSterileBarriers: [],
    spinalSkinPreparation: "",
    spinalLetAirDry: false,
    spinalApproachingLevel: "",
    spinalCaudalBlock: false,
    spinalNeedle: "",
    spinalBlockFailure: false,
    spinalEvent: "",
    epiduralSterileBarriers: [],
    epiduralSkinPreparation: "",
    epiduralLetAirDry: false,
    epiduralApproachingLevel: "",
    epiduralNeedleTuohy: false,
    epiduralLossResistance: "",
    epiduralDepthCm: "",
    epiduralCatheterMarkCm: "",
    epiduralBlockFailure: false,
    epiduralEvent: "",
    pnbTechnique: "",
    pnbSecondTechnique: "",
    pnbSedation: "",
    pnbSide: "",
    pnbPerformedTechnique: "",
    pnbGuidance: "",
    pnbAsepticTechnique: [],
    pnbSkinPreparation: "",
    pnbNeedle: "",
    pnbGauge: "",
    pnbCatheter: "",
    pnbCatheterMarkSkinCm: "",
    pnbCatheterThreadedCm: "",
    pnbMedicationDose: "",
    pnbComplications: "",
    pnbEventNote: "",
    cvcInsertionSites: "",
    cvcInsertionCatheterSize: "",
    cvcInsertionLumens: "",
    cvcInsertionUltrasound: "",
    cvcInsertionAttempts: "",
    invasiveArterialCount: "0",
    invasiveArterial1Inserted: "",
    invasiveArterial1Gauge: "",
    invasiveArterial1Side: "",
    invasiveArterial1Site: "",
    invasiveArterial1Attempts: "",
    invasiveArterial1Comment: "",
    invasiveArterial2Inserted: "",
    invasiveArterial2Gauge: "",
    invasiveArterial2Side: "",
    invasiveArterial2Site: "",
    invasiveArterial2Attempts: "",
    invasiveArterial2Comment: "",
    invasiveArterial3Inserted: "",
    invasiveArterial3Gauge: "",
    invasiveArterial3Side: "",
    invasiveArterial3Site: "",
    invasiveArterial3Attempts: "",
    invasiveArterial3Comment: "",
    invasiveArterial4Inserted: "",
    invasiveArterial4Gauge: "",
    invasiveArterial4Side: "",
    invasiveArterial4Site: "",
    invasiveArterial4Attempts: "",
    invasiveArterial4Comment: "",
    invasiveCvcCount: "0",
    invasiveCvc1Inserted: "",
    invasiveCvc1Side: "",
    invasiveCvc1Site: "",
    invasiveCvc1Technique: "",
    invasiveCvc1Type: "",
    invasiveCvc1Size: "",
    invasiveCvc1Attempts: "",
    invasiveCvc1SkinPreparation: "",
    invasiveCvc1AsepticTechnique: "",
    invasiveCvc1AccidentalArteryPuncture: "",
    invasiveCvc1DepthCm: "",
    invasiveCvc1Difficulty: "",
    invasiveCvc1Note: "",
    invasiveCvc2Inserted: "",
    invasiveCvc2Side: "",
    invasiveCvc2Site: "",
    invasiveCvc2Technique: "",
    invasiveCvc2Type: "",
    invasiveCvc2Size: "",
    invasiveCvc2Attempts: "",
    invasiveCvc2SkinPreparation: "",
    invasiveCvc2AsepticTechnique: "",
    invasiveCvc2AccidentalArteryPuncture: "",
    invasiveCvc2DepthCm: "",
    invasiveCvc2Difficulty: "",
    invasiveCvc2Note: "",
    invasiveCvc3Inserted: "",
    invasiveCvc3Side: "",
    invasiveCvc3Site: "",
    invasiveCvc3Technique: "",
    invasiveCvc3Type: "",
    invasiveCvc3Size: "",
    invasiveCvc3Attempts: "",
    invasiveCvc3SkinPreparation: "",
    invasiveCvc3AsepticTechnique: "",
    invasiveCvc3AccidentalArteryPuncture: "",
    invasiveCvc3DepthCm: "",
    invasiveCvc3Difficulty: "",
    invasiveCvc3Note: "",
    invasiveCvc4Inserted: "",
    invasiveCvc4Side: "",
    invasiveCvc4Site: "",
    invasiveCvc4Technique: "",
    invasiveCvc4Type: "",
    invasiveCvc4Size: "",
    invasiveCvc4Attempts: "",
    invasiveCvc4SkinPreparation: "",
    invasiveCvc4AsepticTechnique: "",
    invasiveCvc4AccidentalArteryPuncture: "",
    invasiveCvc4DepthCm: "",
    invasiveCvc4Difficulty: "",
    invasiveCvc4Note: "",
    invasiveCvcFailedAttempt: "",
    invasiveCvcFailedAttemptSide: "",
    invasiveCvcFailedAttemptSite: "",
    cvcHandScrub: false,
    cvcSterileBarriers: [],
    cvcSkinPreparation: "",
    cvcLetSkinDry: false,
    cvcPreCannulation: [],
    cvcCannulationTechnique: "",
    cvcPlacementConfirmation: [],
    cvcPostCannulation: [],
    cvcInsertionComplications: "",
    cvcInsertionEventNote: "",
    comorbidDiseases: "",
    currentMedication: "",
    preopConsent: "",
    preopNpoStatus: "",
    preopLastMealTime: "",
    preopAirwayAssessment: "",
    preopMallampati: "",
    preopMouthOpeningCm: "",
    preopThyromentalDistanceCm: "",
    preopNeckMobility: "",
    preopDentition: [],
    preopFunctionalCapacity: "",
    preopGcsEye: "",
    preopGcsVerbal: "",
    preopGcsMotor: "",
    preopBaselineBp: "",
    preopBaselineHr: "",
    preopBaselineRr: "",
    preopBaselineSpo2: "",
    preopBaselineTemp: "",
    preopHb: "",
    preopHct: "",
    preopGlucose: "",
    preopPremedication: "",
    preopSpecialRisk: "",
    checklistPatientIdentity: false,
    checklistProcedure: false,
    checklistSite: false,
    checklistConsent: false,
    checklistAllergy: false,
    checklistAirwayRisk: false,
    checklistBloodLossRisk: false,
    checklistBloodAvailable: false,
    checklistMachine: false,
    checklistAirwayEquipment: false,
    checklistMedication: false,
    checklistFluids: false,
    checklistMonitoring: false,
    checklistAntibiotic: false,
    checklistImaging: false,
    checklistTeamIntroduced: false,
    checklistConcerns: "",
    pacuArrivalTime: "",
    pacuPlannedDestination: "",
    pacuAirway: "",
    pacuRespiration: "",
    pacuOxygen: "",
    pacuConsciousness: "",
    pacuCirculation: "",
    pacuActivity: "",
    pacuPainScore: "",
    pacuNauseaVomiting: "",
    pacuTemperature: "",
    pacuDrainOutput: "",
    pacuComplication: "",
    pacuIntervention: "",
    pacuDischargeTime: "",
    pacuDestination: "",
    painAssessmentTime: "",
    painScoreRest: "",
    painScoreMovement: "",
    painLocation: "",
    painTechnique: "",
    painCatheterSite: "",
    painSensoryLevel: "",
    painMotorBlock: "",
    painSedationScore: "",
    painNauseaVomiting: "",
    painPruritus: "",
    painRescueMedication: "",
    painPlan: "",
    outcomeStatus: "",
    outcomeComplications: [],
    outcomeSeverity: "",
    outcomeLocation: "",
    outcomeFollowUp: "",
    outcomeNote: "",
    extubation_time: "",
    extubation_location: "",
    extubation_status: "",
    extubation_condition: "",
    extubation_tof: "",
    extubation_tof_ratio: "",
    airway_device_removed: "",
    suction_performed: "",
    extubation_note: "",
    enabledForms: CORE_FORM_TABS,
  };
}

function fmt(ts: number) {
  const d = new Date(ts);
  const dd = String(d.getDate()).padStart(2, "0");
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const yy = d.getFullYear();
  const hh = String(d.getHours()).padStart(2, "0");
  const min = String(d.getMinutes()).padStart(2, "0");
  return `${dd}/${mm}/${yy} ${hh}:${min}`;
}

function parseClinicalDate(raw: string): Date | null {
  const value = raw.trim();
  if (!value) return null;

  const normalized = normalizeDateInputDDMMYYYY(value);
  const dmy = normalized?.match(/^(\d{2})\/(\d{2})\/(\d{4})$/) || null;
  if (dmy) {
    const dd = Number(dmy[1]);
    const mm = Number(dmy[2]);
    const yyyy = Number(dmy[3]);
    const dt = new Date(yyyy, mm - 1, dd);
    if (
      dt.getFullYear() === yyyy &&
      dt.getMonth() === mm - 1 &&
      dt.getDate() === dd
    ) {
      return dt;
    }
    return null;
  }

  const iso = value.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (iso) {
    const yyyy = Number(iso[1]);
    const mm = Number(iso[2]);
    const dd = Number(iso[3]);
    const dt = new Date(yyyy, mm - 1, dd);
    if (
      dt.getFullYear() === yyyy &&
      dt.getMonth() === mm - 1 &&
      dt.getDate() === dd
    ) {
      return dt;
    }
  }

  return null;
}

function toClinicalDate(dt: Date): string {
  const dd = String(dt.getDate()).padStart(2, "0");
  const mm = String(dt.getMonth() + 1).padStart(2, "0");
  const yyyy = dt.getFullYear();
  return `${dd}/${mm}/${yyyy}`;
}

function ageFromDob(dob: Date) {
  const now = new Date();
  if (dob.getTime() > now.getTime()) return null;

  let years = now.getFullYear() - dob.getFullYear();
  let months = now.getMonth() - dob.getMonth();

  if (now.getDate() < dob.getDate()) months -= 1;
  if (months < 0) {
    years -= 1;
    months += 12;
  }

  if (years < 0) return null;
  return { years, months };
}

function normalizeAgeText(raw: string, maxDigits: number): string {
  return raw.replace(/\D+/g, "").slice(0, maxDigits);
}

function normalizeAgeMonthText(raw: string): string {
  const value = normalizeAgeText(raw, 2);
  return value ? String(Math.min(11, Number(value))) : "";
}

function dobFromAge(ageYRaw: string, ageMRaw: string): Date | null {
  const yText = ageYRaw.trim();
  const mText = ageMRaw.trim();
  if (!yText && !mText) return null;

  const years = yText ? Number(yText) : 0;
  const months = mText ? Number(mText) : 0;
  if (!Number.isFinite(years) || !Number.isFinite(months)) return null;
  if (years < 0 || months < 0) return null;

  const totalMonths = Math.trunc(years) * 12 + Math.trunc(months);
  const anchor = new Date();
  const dt = new Date(anchor.getFullYear(), anchor.getMonth(), 1);
  dt.setMonth(dt.getMonth() - totalMonths);
  return dt;
}

function clampNumeric(raw: string, min: number, max: number, decimals = 0): string {
  const value = raw.trim();
  if (!value) return "";
  const n = Number(value);
  if (!Number.isFinite(n)) return "";
  const clamped = Math.min(max, Math.max(min, n));
  if (decimals <= 0) return String(Math.round(clamped));
  return clamped
    .toFixed(decimals)
    .replace(/\.0+$/, "")
    .replace(/(\.\d*[1-9])0+$/, "$1");
}

function normalizeStringList(v: FormValue | undefined): string[] {
  if (Array.isArray(v)) {
    const values = v.filter((item): item is string => typeof item === "string");
    return values.length > 0 ? values : [""];
  }
  if (typeof v === "string") return v.trim() ? [v] : [""];
  return [""];
}

function normalizeCodeText(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

function normalizeCodeList(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
}

function mapLegacyMaskDifficulty(value: string): string {
  const token = value.trim().toLowerCase();
  if (!token) return "";
  if (token === "n/a" || token === "na") return "";
  if (token === "easy" || token === "difficult" || token === "impossible") return token;
  return "";
}

function mapLegacyPrimaryAirway(airwayTypeRaw: string, routeRaw: string): string {
  const airwayType = airwayTypeRaw.trim().toLowerCase();
  const route = routeRaw.trim().toLowerCase();
  if (route === "nasotracheal") return "nasal_endotracheal_tube";
  if (route === "orotracheal") return "oral_endotracheal_tube";
  if (airwayType.includes("tracheostomy")) return "tracheostomy_tube";
  if (airwayType.includes("supraglottic")) return "lma";
  if (airwayType.includes("endotracheal")) return "oral_endotracheal_tube";
  return "";
}

function codeLabel(value: string): string {
  const overrides: Record<string, string> = {
    lma: "LMA",
    mlt: "MLT",
    rae: "RAE",
    hfjv: "HFJV",
    standard_pvc: "Standard PVC",
    oral_endotracheal_tube: "Oral endotracheal tube",
    nasal_endotracheal_tube: "Nasal endotracheal tube",
    tracheostomy_tube: "Tracheostomy tube",
    jet_ventilation: "Jet ventilation",
    oropharyngeal_airway: "Oropharyngeal airway",
    nasopharyngeal_airway: "Nasopharyngeal airway",
    double_lumen: "Double lumen",
    laser_tube: "Laser tube",
    intubating_lma: "Intubating LMA",
    direct_laryngoscopy: "Direct laryngoscopy",
    vdo_laryngoscopy: "VDO laryngoscopy",
    fiberoptic: "Fiberoptic",
    fiberscope_bonfils: "Fiberscope Bonfils",
    macintosh: "Macintosh",
    miller: "Miller",
    "c-mac": "C-MAC",
    mc_grath: "Mc Grath",
    glidescope: "Glidescope",
    "d-blade": "D-blade",
  };
  if (overrides[value]) return overrides[value];
  return value
    .replace(/_/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function createEmptyTechnique(): AirwayTechnique {
  return {
    id: "",
    outcome: "success",
    technique_type: "",
    blade_type: "",
    blade_size: "",
    guide_stylet: "",
    laryngoscopic_view: "",
    attempt_no: "1",
    vdo_type: "",
    vdo_other_type: "",
    vdo_blade: "",
    size_mm: "",
  };
}

function parseTechniqueList(raw: unknown): AirwayTechnique[] {
  if (typeof raw !== "string" || !raw.trim()) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object")
      .map((item) => {
        const base = createEmptyTechnique();
        return {
          ...base,
          id: normalizeCodeText(item.id) || String(Date.now()),
          outcome: item.outcome === "failure" ? "failure" : "success",
          technique_type: normalizeCodeText(item.technique_type),
          blade_type: normalizeCodeText(item.blade_type),
          blade_size: normalizeCodeText(item.blade_size),
          guide_stylet: normalizeCodeText(item.guide_stylet),
          laryngoscopic_view: normalizeCodeText(item.laryngoscopic_view),
          attempt_no: normalizeCodeText(item.attempt_no),
          vdo_type: normalizeCodeText(item.vdo_type),
          vdo_other_type: normalizeCodeText(item.vdo_other_type),
          vdo_blade: normalizeCodeText(item.vdo_blade),
          size_mm: normalizeCodeText(item.size_mm),
        };
      });
  } catch {
    return [];
  }
}

function buildReadableDraftText(raw: unknown): string {
  const payload =
    raw && typeof raw === "object" && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : {};
  const lines: string[] = [];
  const readText = (key: string) =>
    typeof payload[key] === "string" ? payload[key].trim() : "";
  const readList = (key: string) =>
    Array.isArray(payload[key])
      ? (payload[key] as unknown[])
          .filter((item): item is string => typeof item === "string" && item.trim().length > 0)
      : [];
  const readBool = (key: string) => payload[key] === true;
  const push = (text: string) => {
    if (text) lines.push(text);
  };
  const pushField = (label: string, value: string) => {
    if (value) lines.push(`${label}: ${value}`);
  };
  const pushList = (label: string, values: string[]) => {
    if (values.length > 0) lines.push(`${label}: ${values.join(", ")}`);
  };
  const appendAirway = (scopeLabel: "Primary" | "Secondary", prefix: string) => {
    const device = readText(`${prefix}airway_device`);
    if (!device) return;
    push(`${scopeLabel} Airway: ${codeLabel(device)}`);
    if (device === "oral_endotracheal_tube") {
      pushField("  Tube type", codeLabel(readText(`${prefix}oral_tube_type`)));
      pushField("  Tube size", readText(`${prefix}oral_tube_size`));
      pushField("  Tube depth (cm)", readText(`${prefix}oral_tube_depth_cm`));
    }
    if (device === "nasal_endotracheal_tube") {
      pushField("  Tube type", codeLabel(readText(`${prefix}nasal_tube_type`)));
      pushField("  Tube size", readText(`${prefix}nasal_tube_size`));
      pushField("  Tube depth (cm)", readText(`${prefix}nasal_tube_depth_cm`));
      pushField("  Nose preparation", codeLabel(readText(`${prefix}nasal_preparation`)));
      pushField("  Nostril", codeLabel(readText(`${prefix}nasal_nostril`)));
    }
    if (device === "mask") {
      pushField("  Mask adjunct", codeLabel(readText(`${prefix}mask_adjunct`)));
    }
    if (device === "lma") {
      pushField("  LMA type", codeLabel(readText(`${prefix}lma_type`)));
      pushField("  LMA size", readText(`${prefix}lma_size`));
    }

    const techniques = parseTechniqueList(readText(`${prefix}airway_techniques`));
    if (techniques.length > 0) {
      push(`  Technique attempts (${techniques.length})`);
      for (const item of techniques) {
        const outcome = item.outcome === "success" ? "Success" : "Failure";
        const parts = [`${outcome}: ${codeLabel(item.technique_type)}`];
        if (item.attempt_no) parts.push(`Attempt ${item.attempt_no}`);
        if (item.laryngoscopic_view) parts.push(`View ${item.laryngoscopic_view}`);
        if (item.blade_type) parts.push(`Blade ${codeLabel(item.blade_type)}`);
        if (item.blade_size) parts.push(`Blade size ${item.blade_size}`);
        if (item.vdo_type) parts.push(`VDO ${codeLabel(item.vdo_type)}`);
        if (item.vdo_other_type) parts.push(`VDO other ${item.vdo_other_type}`);
        if (item.vdo_blade) parts.push(`VDO blade ${codeLabel(item.vdo_blade)}`);
        if (item.guide_stylet) parts.push(`Guide/stylet ${codeLabel(item.guide_stylet)}`);
        if (item.size_mm) parts.push(`Size ${item.size_mm} mm`);
        push(`    - ${parts.join(" | ")}`);
      }
    }
    if (readBool(`${prefix}failed_intubation`)) {
      push("  Failed intubation: Yes");
    }
  };

  push("General");
  pushField("HN", readText("hn"));
  pushField("AN", readText("an"));
  pushField("DOB", readText("dob"));
  if (readText("ageY") || readText("ageM")) {
    push(`Age: ${readText("ageY") || "0"}y ${readText("ageM") || "0"}m`);
  }
  pushField("Service", readText("service"));
  pushField("Clinic", readText("clinic"));
  pushField("ASA", readText("asa"));
  pushField("Comorbid diseases", readText("comorbidDiseases"));
  pushField("Current medication", readText("currentMedication"));

  push("");
  push("Anesthesia");
  pushList("Types", readList("anesthesiaTypes"));
  pushList("Monitoring", normalizeMonitoringList(readList("monitoring")));
  pushList("Pre-induction", readList("pre_induction"));
  pushList("Induction", readList("induction"));
  pushField("Mask ventilation difficulty", codeLabel(readText("mask_ventilation_difficulty")));
  pushList("Eye protection", readList("eye_protection").map(codeLabel));

  push("");
  appendAirway("Primary", "primary_");
  if (readBool("secondary_airway_enabled")) {
    push("");
    appendAirway("Secondary", "secondary_");
  }

  push("");
  push("PNB");
  pushField("Technique", readText("pnbTechnique"));
  pushField("Second block", readText("pnbSecondTechnique"));
  pushField("Sedation", readText("pnbSedation"));
  pushField("Side", readText("pnbSide"));
  pushField("Performed technique", readText("pnbPerformedTechnique"));
  pushField("Guidance", readText("pnbGuidance"));
  pushList("Aseptic technique", readList("pnbAsepticTechnique"));
  pushField("Skin preparation", readText("pnbSkinPreparation"));
  pushField("Block needle", readText("pnbNeedle"));
  pushField("Gauge", readText("pnbGauge"));
  pushField("Catheter", readText("pnbCatheter"));
  pushField("Catheter mark at skin (cm)", readText("pnbCatheterMarkSkinCm"));
  pushField("Catheter threaded beyond tip (cm)", readText("pnbCatheterThreadedCm"));
  pushField("Medication / agents & dose", readText("pnbMedicationDose"));
  pushField("Complications", readText("pnbComplications"));
  pushField("Event note", readText("pnbEventNote"));

  push("");
  push("Extubation");
  pushField("Extubation time", readText("extubation_time"));
  pushField("Extubation location", readText("extubation_location"));
  pushField("Extubation status", codeLabel(readText("extubation_status")));
  pushField("Extubation condition", readText("extubation_condition"));
  pushField("TOF", readText("extubation_tof"));
  pushField("TOF ratio", readText("extubation_tof_ratio"));
  pushField("Airway device removed", codeLabel(readText("airway_device_removed")));
  pushField("Suction performed", codeLabel(readText("suction_performed")));
  pushField("Extubation note", readText("extubation_note"));

  push("");
  push("Line");
  const ivLineCount = Number.parseInt(readText("ivLineCount"), 10) || 0;
  for (let i = 1; i <= Math.min(4, ivLineCount); i += 1) {
    const prefix = `ivLine${i}`;
    const detail = [
      readText(`${prefix}Site`),
      readText(`${prefix}Gauge`),
      readText(`${prefix}Inserted`),
      readText(`${prefix}Attempts`) ? `${readText(`${prefix}Attempts`)} attempt(s)` : "",
    ].filter(Boolean).join(" | ");
    pushField(`IV line (${i})`, detail);
    pushField(`  Note (${i})`, readText(`${prefix}Note`));
  }

  const arterialCount = Number.parseInt(readText("invasiveArterialCount"), 10) || 0;
  for (let i = 1; i <= Math.min(4, arterialCount); i += 1) {
    const prefix = `invasiveArterial${i}`;
    const detail = [
      readText(`${prefix}Inserted`),
      readText(`${prefix}Gauge`),
      readText(`${prefix}Side`),
      readText(`${prefix}Site`),
      readText(`${prefix}Attempts`) ? `${readText(`${prefix}Attempts`)} attempt(s)` : "",
    ].filter(Boolean).join(" | ");
    pushField(`Arterial catheter (${i})`, detail);
    pushField(`  Comment (${i})`, readText(`${prefix}Comment`));
  }
  const cvcCount = Number.parseInt(readText("invasiveCvcCount"), 10) || 0;
  for (let i = 1; i <= Math.min(4, cvcCount); i += 1) {
    const prefix = `invasiveCvc${i}`;
    const detail = [
      readText(`${prefix}Inserted`),
      readText(`${prefix}Technique`),
      readText(`${prefix}Side`),
      readText(`${prefix}Site`),
      readText(`${prefix}Type`),
      readText(`${prefix}Size`),
      readText(`${prefix}Attempts`) ? `${readText(`${prefix}Attempts`)} attempt(s)` : "",
      readText(`${prefix}DepthCm`) ? `${readText(`${prefix}DepthCm`)} cm depth` : "",
    ].filter(Boolean).join(" | ");
    pushField(`Central venous catheter (${i})`, detail);
    pushField(`  Skin prep (${i})`, readText(`${prefix}SkinPreparation`));
    pushField(`  Aseptic (${i})`, readText(`${prefix}AsepticTechnique`));
    pushField(`  Accidental artery puncture (${i})`, readText(`${prefix}AccidentalArteryPuncture`));
    pushField(`  Difficulty (${i})`, readText(`${prefix}Difficulty`));
    pushField(`  Note (${i})`, readText(`${prefix}Note`));
  }
  pushField("CVC failed attempt", readText("invasiveCvcFailedAttempt"));
  pushField(
    "CVC failed attempt site",
    [readText("invasiveCvcFailedAttemptSide"), readText("invasiveCvcFailedAttemptSite")].filter(Boolean).join(" | "),
  );
  pushField("Catheter size (Fr)", readText("cvcInsertionCatheterSize"));
  pushField("Ultrasound guidance", codeLabel(readText("cvcInsertionUltrasound")));
  pushField("Hand scrub", readBool("cvcHandScrub") ? "Yes" : "");
  pushList("Sterile precaution", readList("cvcSterileBarriers"));
  pushField("Skin preparation", readText("cvcSkinPreparation"));
  pushField("Let skin dry", readBool("cvcLetSkinDry") ? "Yes" : "");
  pushList("Pre-cannulation", readList("cvcPreCannulation"));
  pushField("Cannulation technique", readText("cvcCannulationTechnique"));
  pushList("Venous placement confirmation", readList("cvcPlacementConfirmation"));
  pushList("Post-cannulation", readList("cvcPostCannulation"));
  pushField("Complications", readText("cvcInsertionComplications"));
  pushField("Event note", readText("cvcInsertionEventNote"));

  return lines.join("\n");
}

interface AirwayTechniquePanelProps {
  title: string;
  techniquesRaw: string;
  failedIntubation: boolean;
  onTechniquesChange: (nextRaw: string) => void;
  onFailedIntubationChange: (next: boolean) => void;
}

function normalizeTechniqueByType(input: AirwayTechnique): AirwayTechnique {
  const next: AirwayTechnique = { ...input };
  const isDirect = next.technique_type === "direct_laryngoscopy";
  const isVdo = next.technique_type === "vdo_laryngoscopy";
  const isScope = next.technique_type === "fiberoptic" || next.technique_type === "fiberscope_bonfils";

  if (!isDirect && !isVdo) {
    next.blade_type = "";
    next.blade_size = "";
    next.guide_stylet = "";
    next.laryngoscopic_view = "";
  }
  if (!isVdo) {
    next.vdo_type = "";
    next.vdo_other_type = "";
    next.vdo_blade = "";
  }
  if (!isScope) {
    next.size_mm = "";
  }
  return next;
}

function AirwayTechniquePanel({
  title,
  techniquesRaw,
  failedIntubation,
  onTechniquesChange,
  onFailedIntubationChange,
}: AirwayTechniquePanelProps) {
  const techniques = useMemo(() => parseTechniqueList(techniquesRaw), [techniquesRaw]);
  const [editingId, setEditingId] = useState("");
  const [draft, setDraft] = useState<AirwayTechnique>(() => createEmptyTechnique());
  const [note, setNote] = useState("");

  const hasSuccess = techniques.some(item => item.outcome === "success");
  const isEditing = editingId !== "";
  const isDirect = draft.technique_type === "direct_laryngoscopy";
  const isVdo = draft.technique_type === "vdo_laryngoscopy";
  const isScope = draft.technique_type === "fiberoptic" || draft.technique_type === "fiberscope_bonfils";

  const openNew = () => {
    setEditingId("");
    setDraft(createEmptyTechnique());
    setNote("");
  };
  const openEdit = (item: AirwayTechnique) => {
    setEditingId(item.id);
    setDraft(item);
    setNote("");
  };
  const closeEditor = () => {
    setEditingId("");
    setDraft(createEmptyTechnique());
    setNote("");
  };

  const saveDraft = () => {
    if (!draft.technique_type) {
      setNote("Technique type is required");
      return;
    }
    if (draft.outcome === "success" && techniques.some(item => item.outcome === "success" && item.id !== editingId)) {
      setNote("A successful technique already exists. Edit it instead of adding another.");
      return;
    }

    const id = editingId || `tech_${Date.now()}`;
    const normalized = normalizeTechniqueByType({
      ...draft,
      id,
      attempt_no: normalizeCodeText(draft.attempt_no) || "1",
    });
    const next = isEditing
      ? techniques.map(item => (item.id === editingId ? normalized : item))
      : [...techniques, normalized];

    const sorted = [...next].sort((a, b) => Number(a.attempt_no || 0) - Number(b.attempt_no || 0));
    onTechniquesChange(JSON.stringify(sorted));
    closeEditor();
  };

  const deleteTechnique = (id: string) => {
    const next = techniques.filter(item => item.id !== id);
    onTechniquesChange(JSON.stringify(next));
    if (editingId === id) closeEditor();
  };

  return (
    <div className="rounded border border-gray-200 dark:border-gray-800 p-3 space-y-3">
      <div className="flex items-center justify-between gap-2">
        <div className="font-medium">{title}</div>
        <label className="inline-flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={failedIntubation}
            onChange={(e) => onFailedIntubationChange(e.target.checked)}
          />
          <span>Failed intubation</span>
        </label>
      </div>

      {techniques.length > 0 ? (
        <div className="space-y-2">
          {techniques.map(item => (
            <div
              key={item.id}
              className="flex flex-wrap items-center gap-2 rounded border border-gray-200 dark:border-gray-800 px-2 py-1.5 text-sm"
            >
              <span className={item.outcome === "success" ? "text-green-600 dark:text-green-400" : "text-amber-600 dark:text-amber-400"}>
                {item.outcome === "success" ? "Successful" : "Failure"}
              </span>
              <span>{codeLabel(item.technique_type)}</span>
              <span className="text-gray-500 dark:text-gray-400">Attempt {item.attempt_no || "1"}</span>
              <button type="button" className={secondaryButton} onClick={() => openEdit(item)}>Edit</button>
              <button type="button" className={dangerButton} onClick={() => deleteTechnique(item.id)}>Remove</button>
            </div>
          ))}
        </div>
      ) : (
        <div className="text-sm text-gray-500 dark:text-gray-400">No technique recorded</div>
      )}

      {!hasSuccess || isEditing ? (
        <div className="rounded border border-gray-200 dark:border-gray-800 p-3 space-y-3">
          <div className="flex items-center justify-between">
            <div className="font-medium">{isEditing ? "Edit technique" : "Add technique"}</div>
            {!isEditing ? (
              <button type="button" className={secondaryButton} onClick={openNew}>Clear</button>
            ) : null}
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <div className="space-y-1">
              <div className={label}>Outcome</div>
              <div className="grid grid-cols-2 gap-2">
                <label className="inline-flex items-center gap-2 rounded border border-gray-200 dark:border-gray-800 px-2 py-1.5">
                  <input
                    type="radio"
                    checked={draft.outcome === "success"}
                    onChange={() => setDraft(prev => ({ ...prev, outcome: "success" }))}
                  />
                  <span>Success</span>
                </label>
                <label className="inline-flex items-center gap-2 rounded border border-gray-200 dark:border-gray-800 px-2 py-1.5">
                  <input
                    type="radio"
                    checked={draft.outcome === "failure"}
                    onChange={() => setDraft(prev => ({ ...prev, outcome: "failure" }))}
                  />
                  <span>Failure</span>
                </label>
              </div>
            </div>
            <label className="space-y-1">
              <div className={label}>Technique type</div>
              <select
                className={input}
                value={draft.technique_type}
                onChange={(e) => setDraft(prev => ({ ...prev, technique_type: e.target.value }))}
              >
                <option value="">Select technique</option>
                {options.gaTechniqueType.map(value => (
                  <option key={value} value={value}>{codeLabel(value)}</option>
                ))}
              </select>
            </label>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            <label className="space-y-1">
              <div className={label}>No. of attempt</div>
              <select
                className={input}
                value={draft.attempt_no}
                onChange={(e) => setDraft(prev => ({ ...prev, attempt_no: e.target.value }))}
              >
                {options.gaAttemptNumber.map(value => (
                  <option key={value} value={value}>{value}</option>
                ))}
              </select>
            </label>
            {isScope ? (
              <label className="space-y-1">
                <div className={label}>Size (mm)</div>
                <input
                  className={input}
                  value={draft.size_mm}
                  onChange={(e) => setDraft(prev => ({ ...prev, size_mm: e.target.value }))}
                />
              </label>
            ) : null}
          </div>

          {isDirect || isVdo ? (
            <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
              <label className="space-y-1">
                <div className={label}>Blade type</div>
                <select
                  className={input}
                  value={draft.blade_type}
                  onChange={(e) => setDraft(prev => ({ ...prev, blade_type: e.target.value }))}
                >
                  <option value="">Select blade type</option>
                  {options.gaBladeType.map(value => (
                    <option key={value} value={value}>{codeLabel(value)}</option>
                  ))}
                </select>
              </label>
              <label className="space-y-1">
                <div className={label}>Blade size</div>
                <input
                  className={input}
                  value={draft.blade_size}
                  onChange={(e) => setDraft(prev => ({ ...prev, blade_size: e.target.value }))}
                />
              </label>
              <label className="space-y-1">
                <div className={label}>Guide/stylet</div>
                <select
                  className={input}
                  value={draft.guide_stylet}
                  onChange={(e) => setDraft(prev => ({ ...prev, guide_stylet: e.target.value }))}
                >
                  <option value="">Select</option>
                  {options.gaGuideStylet.map(value => (
                    <option key={value} value={value}>{codeLabel(value)}</option>
                  ))}
                </select>
              </label>
              <label className="space-y-1">
                <div className={label}>Laryngoscopic view</div>
                <select
                  className={input}
                  value={draft.laryngoscopic_view}
                  onChange={(e) => setDraft(prev => ({ ...prev, laryngoscopic_view: e.target.value }))}
                >
                  <option value="">Select view</option>
                  {options.gaLaryngoscopicView.map(value => (
                    <option key={value} value={value}>{value}</option>
                  ))}
                </select>
              </label>
            </div>
          ) : null}

          {isVdo ? (
            <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
              <label className="space-y-1">
                <div className={label}>Type</div>
                <select
                  className={input}
                  value={draft.vdo_type}
                  onChange={(e) => setDraft(prev => ({ ...prev, vdo_type: e.target.value }))}
                >
                  <option value="">Select type</option>
                  {options.gaVdoType.map(value => (
                    <option key={value} value={value}>{codeLabel(value)}</option>
                  ))}
                </select>
              </label>
              {draft.vdo_type === "other" ? (
                <label className="space-y-1">
                  <div className={label}>Other type</div>
                  <input
                    className={input}
                    value={draft.vdo_other_type}
                    onChange={(e) => setDraft(prev => ({ ...prev, vdo_other_type: e.target.value }))}
                  />
                </label>
              ) : null}
              <label className="space-y-1">
                <div className={label}>VDO blade</div>
                <select
                  className={input}
                  value={draft.vdo_blade}
                  onChange={(e) => setDraft(prev => ({ ...prev, vdo_blade: e.target.value }))}
                >
                  <option value="">Select blade</option>
                  {options.gaVdoBlade.map(value => (
                    <option key={value} value={value}>{codeLabel(value)}</option>
                  ))}
                </select>
              </label>
            </div>
          ) : null}

          {note ? <div className="text-xs text-amber-600 dark:text-amber-400">{note}</div> : null}
          <div className="flex items-center justify-end gap-2">
            {isEditing ? (
              <button type="button" className={secondaryButton} onClick={closeEditor}>Cancel</button>
            ) : null}
            <button type="button" className={primaryButton} onClick={saveDraft}>Save Technique</button>
          </div>
        </div>
      ) : (
        <div className="text-sm text-gray-500 dark:text-gray-400">
          Successful technique recorded. Add another attempt only after editing/removing success.
        </div>
      )}
    </div>
  );
}

/** Normalizes a stored or server draft (including legacy keys) into editor form state. */
function buildFormFromDraft(parsed: FormState, hn: string): FormState {
  const base = defaults(hn);
  const merged: FormState = {
    ...base,
    ...parsed,
    hn,
  };

  if (!merged.clinic && typeof parsed.ipdClinic === "string") {
    merged.clinic = parsed.ipdClinic.toUpperCase() === "OPD" ? "OPD" : "IPD";
  }

  merged.diagnosis = normalizeStringList(parsed.diagnosis);
  merged.operation = normalizeStringList(parsed.operation);
  merged.enabledForms = normalizeEnabledForms(parsed.enabledForms);
  merged.monitoring = normalizeMonitoringList(parsed.monitoring);
  if (Array.isArray(merged.ivSites)) {
    merged.ivSites = normalizeCodeList(merged.ivSites)[0] || "";
  }
  if (Array.isArray(merged.arterialSites)) {
    merged.arterialSites = normalizeCodeList(merged.arterialSites)[0] || "";
  }
  if (Array.isArray(merged.cvcSites)) {
    merged.cvcSites = normalizeCodeList(merged.cvcSites)[0] || "";
  }
  if (Array.isArray(merged.cvcInsertionSites)) {
    merged.cvcInsertionSites = normalizeCodeList(merged.cvcInsertionSites)[0] || "";
  }
  if (!normalizeCodeText(merged.neuraxialBlockType)) {
    const legacyList = normalizeCodeList(merged.neuraxialTechniques);
    const first = String(legacyList[0] || "").trim();
    const map: Record<string, string> = {
      "Spinal anesthesia": "Spinal",
      "Epidural anesthesia": "Epidural",
      "Combined spinal-epidural anesthesia": "Combined spinal-epidural",
      "Caudal anesthesia": "Caudal",
    };
    if (first) {
      merged.neuraxialBlockType = map[first] || first;
    }
  }
  if (normalizeCodeList(merged.neuraxialSterilePrecautions).length === 0) {
    const mergedLegacy = [
      ...normalizeCodeList(merged.spinalSterileBarriers),
      ...normalizeCodeList(merged.epiduralSterileBarriers),
    ];
    merged.neuraxialSterilePrecautions = Array.from(new Set(mergedLegacy));
  }
  const normalizeLumensLabel = (value: string) => {
    const token = value.trim().toLowerCase();
    if (token === "1" || token === "single") return "Single";
    if (token === "2" || token === "double") return "Double";
    if (token === "3" || token === "triple") return "Triple";
    return value;
  };
  merged.cvcLumens = normalizeLumensLabel(normalizeCodeText(merged.cvcLumens));
  merged.cvcInsertionLumens = normalizeLumensLabel(normalizeCodeText(merged.cvcInsertionLumens));

  const hasLegacyIvLine =
    normalizeCodeText(merged.ivSites) ||
    normalizeCodeText(merged.ivCatheterSize) ||
    normalizeCodeText(merged.ivWhereInserted) ||
    normalizeCodeText(merged.ivAttempts);
  if (!normalizeCodeText(merged.ivLineCount) && hasLegacyIvLine) {
    merged.ivLineCount = "1";
    if (!normalizeCodeText(merged.ivLine1Site)) merged.ivLine1Site = normalizeCodeText(merged.ivSites);
    if (!normalizeCodeText(merged.ivLine1Gauge)) merged.ivLine1Gauge = normalizeCodeText(merged.ivCatheterSize);
    if (!normalizeCodeText(merged.ivLine1Attempts)) merged.ivLine1Attempts = normalizeCodeText(merged.ivAttempts);
    if (!normalizeCodeText(merged.ivLine1Inserted)) {
      const inserted = normalizeCodeText(merged.ivWhereInserted);
      merged.ivLine1Inserted = inserted === "In situ" ? "In-situ" : inserted === "OR" ? "Inserted in OR" : inserted;
    }
  }

  const hasLegacyArterial =
    normalizeCodeText(merged.arterialSites) ||
    normalizeCodeText(merged.arterialCatheterSize) ||
    normalizeCodeText(merged.arterialWhereInserted) ||
    normalizeCodeText(merged.arterialAttempts);
  if (!normalizeCodeText(merged.invasiveArterialCount) && hasLegacyArterial) {
    merged.invasiveArterialCount = "1";
    if (!normalizeCodeText(merged.invasiveArterial1Gauge)) merged.invasiveArterial1Gauge = normalizeCodeText(merged.arterialCatheterSize);
    if (!normalizeCodeText(merged.invasiveArterial1Attempts)) merged.invasiveArterial1Attempts = normalizeCodeText(merged.arterialAttempts);
    const arterialSite = normalizeCodeText(merged.arterialSites);
    if (!normalizeCodeText(merged.invasiveArterial1Site) && arterialSite) {
      const sideMatch = arterialSite.match(/^(Right|Left)\s+(.+)$/i);
      if (sideMatch) {
        merged.invasiveArterial1Side = sideMatch[1][0].toUpperCase() + sideMatch[1].slice(1).toLowerCase();
        merged.invasiveArterial1Site = sideMatch[2];
      } else {
        merged.invasiveArterial1Site = arterialSite;
      }
    }
    if (!normalizeCodeText(merged.invasiveArterial1Inserted)) {
      const inserted = normalizeCodeText(merged.arterialWhereInserted);
      merged.invasiveArterial1Inserted = inserted === "In situ" ? "In-situ" : inserted === "OR" ? "Inserted in OR" : inserted;
    }
  }

  const hasLegacyInvasiveCvc =
    normalizeCodeText(merged.cvcInsertionSites) ||
    normalizeCodeText(merged.cvcInsertionLumens) ||
    normalizeCodeText(merged.cvcInsertionCatheterSize) ||
    normalizeCodeText(merged.cvcInsertionAttempts) ||
    normalizeCodeText(merged.cvcInsertionEventNote);
  if (!normalizeCodeText(merged.invasiveCvcCount) && hasLegacyInvasiveCvc) {
    merged.invasiveCvcCount = "1";
    if (!normalizeCodeText(merged.invasiveCvc1Type)) {
      const lumens = normalizeLumensLabel(normalizeCodeText(merged.cvcInsertionLumens));
      merged.invasiveCvc1Type = lumens === "Single" ? "1 Lumen" : lumens === "Double" ? "2 Lumens" : lumens === "Triple" ? "3 Lumens" : lumens;
    }
    if (!normalizeCodeText(merged.invasiveCvc1Size)) {
      merged.invasiveCvc1Size = normalizeCodeText(merged.cvcInsertionCatheterSize).replace(/\s+Fr$/i, "F");
    }
    if (!normalizeCodeText(merged.invasiveCvc1Attempts)) {
      merged.invasiveCvc1Attempts = normalizeCodeText(merged.cvcInsertionAttempts);
    }
    if (!normalizeCodeText(merged.invasiveCvc1SkinPreparation)) {
      merged.invasiveCvc1SkinPreparation = normalizeCodeText(merged.cvcSkinPreparation);
    }
    const cvcSite = normalizeCodeText(merged.cvcInsertionSites);
    if (!normalizeCodeText(merged.invasiveCvc1Site) && cvcSite) {
      const sideMatch = cvcSite.match(/^(Right|Left)\s+(.+)$/i);
      if (sideMatch) {
        merged.invasiveCvc1Side = sideMatch[1][0].toUpperCase() + sideMatch[1].slice(1).toLowerCase();
        merged.invasiveCvc1Site = sideMatch[2].replace(/^internal jugular$/i, "Internal jugular vein");
      } else {
        merged.invasiveCvc1Site = cvcSite;
      }
    }
    if (!normalizeCodeText(merged.invasiveCvc1Note)) {
      merged.invasiveCvc1Note = normalizeCodeText(merged.cvcInsertionEventNote);
    }
  }

  const parsedDob = parseClinicalDate(typeof merged.dob === "string" ? merged.dob : "");
  if (parsedDob) {
    merged.dob = toClinicalDate(parsedDob);
    const age = ageFromDob(parsedDob);
    merged.ageY = age ? String(age.years) : "";
    merged.ageM = age ? String(age.months) : "";
  } else {
    const derivedDob = dobFromAge(
      typeof merged.ageY === "string" ? merged.ageY : "",
      typeof merged.ageM === "string" ? merged.ageM : "",
    );
    if (derivedDob) {
      merged.dob = toClinicalDate(derivedDob);
      const age = ageFromDob(derivedDob);
      merged.ageY = age ? String(age.years) : normalizeAgeText(String(merged.ageY || ""), 3);
      merged.ageM = age ? String(age.months) : normalizeAgeMonthText(String(merged.ageM || ""));
    }
  }

  if (normalizeCodeList(merged.pre_induction).length === 0) {
    const legacy = normalizeCodeList(merged.preInductionChecks);
    if (legacy.length > 0) merged.pre_induction = legacy;
  }

  if (normalizeCodeList(merged.induction).length === 0) {
    const legacy = normalizeCodeList(merged.inductionMethods);
    if (legacy.length > 0) merged.induction = legacy;
  }

  if (!normalizeCodeText(merged.mask_ventilation_difficulty)) {
    const legacy = mapLegacyMaskDifficulty(normalizeCodeText(merged.maskVentilationDifficulty));
    if (legacy) merged.mask_ventilation_difficulty = legacy;
  }

  if (!normalizeCodeText(merged.primary_airway_device)) {
    const mapped = mapLegacyPrimaryAirway(
      normalizeCodeText(merged.airwayType),
      normalizeCodeText(merged.intubationRoute),
    );
    if (mapped) merged.primary_airway_device = mapped;
  }
  if (!normalizeCodeText(merged.extubation_time)) {
    const legacy = normalizeCodeText(merged.extubationTime);
    if (legacy) merged.extubation_time = legacy;
  }
  if (!normalizeCodeText(merged.extubation_location)) {
    const legacy = normalizeCodeText(merged.extubationDisposition);
    if (legacy === "Extubated in PACU/ICU") {
      merged.extubation_location = "Extubated in PACU";
    } else if (legacy) {
      merged.extubation_location = legacy;
    }
  }
  if (!normalizeCodeText(merged.airway_device_removed)) {
    const legacy = normalizeCodeText(merged.extubationAirway).toUpperCase();
    if (legacy === "ETT") merged.airway_device_removed = "oral_endotracheal_tube";
    else if (legacy === "LMA") merged.airway_device_removed = "lma";
    else if (legacy === "TRACHEOSTOMY") merged.airway_device_removed = "tracheostomy_tube";
  }
  if (!normalizeCodeText(merged.extubation_note)) {
    const legacy = normalizeCodeText(merged.extubationNote);
    if (legacy) merged.extubation_note = legacy;
  }
  if (!normalizeCodeText(merged.airway_device_removed) && normalizeCodeText(merged.primary_airway_device)) {
    merged.airway_device_removed = normalizeCodeText(merged.primary_airway_device);
  }

  merged.primary_airway_techniques = JSON.stringify(
    parseTechniqueList(merged.primary_airway_techniques),
  );
  merged.secondary_airway_techniques = JSON.stringify(
    parseTechniqueList(merged.secondary_airway_techniques),
  );
  return merged;
}

/** Applies the same normalization a save writes (dates, age, airway techniques). */
function normalizeFormForSave(current: FormState, finalize: boolean): FormState {
  const read = (name: string) => (typeof current[name] === "string" ? (current[name] as string) : "");
  const normalized: FormState = { ...current };
  normalized.monitoring = normalizeMonitoringList(normalized.monitoring);
  const ageY = normalizeAgeText(read("ageY"), 3);
  const ageM = normalizeAgeMonthText(read("ageM"));
  const parsedDob = parseClinicalDate(read("dob"));
  const finalDob = parsedDob || dobFromAge(ageY, ageM);
  if (finalDob) {
    const age = ageFromDob(finalDob);
    normalized.dob = toClinicalDate(finalDob);
    normalized.ageY = age ? String(age.years) : ageY;
    normalized.ageM = age ? String(age.months) : ageM;
  } else {
    normalized.ageY = ageY;
    normalized.ageM = ageM;
  }
  normalized.primary_airway_techniques = JSON.stringify(
    parseTechniqueList(normalized.primary_airway_techniques),
  );
  normalized.secondary_airway_techniques = JSON.stringify(
    parseTechniqueList(normalized.secondary_airway_techniques),
  );
  if (
    !normalizeCodeText(normalized.airway_device_removed) &&
    normalizeCodeText(normalized.primary_airway_device)
  ) {
    normalized.airway_device_removed = normalizeCodeText(normalized.primary_airway_device);
  }
  if (finalize) {
    const extubationTime = normalizeTimeInputHHMM(read("extubation_time"));
    if (extubationTime) normalized.extubation_time = extubationTime;
  }
  return normalized;
}

function isEmptyFormValue(value: unknown): boolean {
  return value == null || value === "" || value === false || value === "[]"
    || (Array.isArray(value) && value.length === 0);
}

function sameFormValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === undefined || b === undefined) return isEmptyFormValue(a) && isEmptyFormValue(b);
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Keys whose value differs from the last state known to be on the server. */
function changedFormKeys(current: FormState, baseline: FormState): string[] {
  return Object.keys(current).filter(key => !sameFormValue(current[key], baseline[key]));
}


export default function FormView({
  caseStatus = IDLE_CASE,
  source,
  allowedTabs,
  onSaveStateChange,
  refreshIntervalMs = FORM_REMOTE_REFRESH_MS,
}: FormViewProps) {
  const leafCaseId = !source && caseStatus.status !== "IDLE" ? caseStatus.case_id : null;
  const idle = !source && leafCaseId == null;
  const formHn = source ? source.hn : caseStatus.status === "IDLE" ? "" : caseStatus.hn;
  const storageKey = source ? source.key : leafCaseId != null ? `doctor_form_${leafCaseId}` : "";
  const readOnly = Boolean(source?.readOnly);
  const patientFieldsReadOnly = Boolean(source?.patientFieldsReadOnly);

  /**
   * Where the draft lives. Leaf cases use /api/case/{id}/detail-draft; other
   * hosts (e.g. the Canopy admission tablet editor) inject their own source.
   */
  const dataSource = useMemo<FormDataSource | null>(() => {
    if (source) return source;
    if (leafCaseId == null) return null;
    return {
      key: `doctor_form_${leafCaseId}`,
      hn: formHn,
      load: async () => ({ draft: await getCaseDetailDraft(leafCaseId) }),
      patch: async (patch) => ({ draft: await patchCaseDetailDraft(leafCaseId, patch) }),
    };
  }, [source, leafCaseId, formHn]);

  const [form, setForm] = useState<FormState>(() => defaults(formHn));
  const [saveNote, setSaveNote] = useState("");
  const [isSaving, setIsSaving] = useState(false);
  const autoSaveReadyRef = useRef(false);
  /** Last form state known to match the server; keys that differ are local edits. */
  const baselineRef = useRef<FormState | null>(null);
  const formRef = useRef(form);
  const dataSourceRef = useRef(dataSource);
  const readOnlyRef = useRef(readOnly);
  const onSaveStateChangeRef = useRef(onSaveStateChange);
  const savingRef = useRef(false);
  /** Bumped by every save so a refresh started before it is discarded. */
  const syncSeqRef = useRef(0);
  const [showSavedPreview, setShowSavedPreview] = useState(false);
  const [savedPreview, setSavedPreview] = useState("");
  const [isResetConfirmOpen, setIsResetConfirmOpen] = useState(false);
  const [activeTab, setActiveTab] = useState<FormTabId>(FORM_REQUIRED_TAB);

  useEffect(() => {
    formRef.current = form;
  }, [form]);
  useEffect(() => {
    dataSourceRef.current = dataSource;
    readOnlyRef.current = readOnly;
    onSaveStateChangeRef.current = onSaveStateChange;
  }, [dataSource, readOnly, onSaveStateChange]);

  const text = (name: string) => (typeof form[name] === "string" ? (form[name] as string) : "");
  const bool = (name: string) => form[name] === true;
  const multi = (name: string) => (Array.isArray(form[name]) ? form[name].filter((value): value is string => typeof value === "string") : []);
  const enabledTabs = useMemo(
    () => normalizeEnabledForms(form.enabledForms),
    [form.enabledForms],
  );
  const visibleTabs = useMemo<FormTabId[]>(() => {
    if (!allowedTabs) return enabledTabs;
    return FORM_TAB_DEFS.map(tab => tab.id).filter(id => allowedTabs.includes(id));
  }, [allowedTabs, enabledTabs]);

  const completionByTab = useMemo(() => {
    const complete = (key: string) => {
      const value = form[key];
      if (typeof value === "boolean") return value;
      if (Array.isArray(value)) return value.some(item => typeof item === "string" && item.trim() !== "");
      return typeof value === "string" && value.trim() !== "";
    };
    return Object.fromEntries(visibleTabs.map(tabId => {
      const fields = TAB_REQUIRED_FIELDS[tabId] || [];
      const done = fields.filter(complete).length;
      return [tabId, { done, total: fields.length, percent: fields.length ? Math.round(done / fields.length * 100) : null }];
    })) as Record<FormTabId, { done: number; total: number; percent: number | null }>;
  }, [visibleTabs, form]);
  const coreCompletion = useMemo(() => {
    const totals = CORE_FORM_TABS.filter(tabId => visibleTabs.includes(tabId)).map(tabId => completionByTab[tabId]).filter(Boolean);
    const done = totals.reduce((sum, item) => sum + item.done, 0);
    const total = totals.reduce((sum, item) => sum + item.total, 0);
    return total ? Math.round(done / total * 100) : 0;
  }, [completionByTab, visibleTabs]);
  const activeGaTab = enabledTabs.find(id => GA_TAB_IDS.includes(id)) ?? null;

  const setText = (name: string, value: string) => {
    setForm((p) => ({ ...p, [name]: value }));
  };
  const setBool = (name: string, value: boolean) => setForm((p) => ({ ...p, [name]: value }));
  const setAirwayDevice = (scope: "primary" | "secondary", device: string) => {
    const deviceKey = scope === "primary" ? "primary_airway_device" : "secondary_airway_device";
    const prefix = scope === "primary" ? "" : "secondary_";
    const techniquesKey = scope === "primary" ? "primary_airway_techniques" : "secondary_airway_techniques";
    const failedKey = scope === "primary" ? "primary_failed_intubation" : "secondary_failed_intubation";
    setForm((prev) => {
      const next: FormState = { ...prev, [deviceKey]: device };
      const keep = new Set((AIRWAY_DETAIL_FIELDS_BY_DEVICE[device] || []).map((base) => `${prefix}${base}`));
      for (const base of AIRWAY_DETAIL_FIELDS) {
        const key = `${prefix}${base}`;
        if (keep.has(key)) continue;
        next[key] = "";
      }
      next[techniquesKey] = "[]";
      next[failedKey] = false;
      if (scope === "primary" && !normalizeCodeText(prev.airway_device_removed)) {
        next.airway_device_removed = device;
      }
      return next;
    });
  };
  const toggle = (name: string, option: string) => {
    setForm((p) => {
      const arr = Array.isArray(p[name]) ? (p[name] as string[]) : [];
      const next = arr.includes(option) ? arr.filter((x) => x !== option) : [...arr, option];
      return { ...p, [name]: next };
    });
  };

  /**
   * Toggles an anesthesia type checkbox and automatically adds/removes the
   * corresponding form tab so the relevant detail section is always visible.
   */
  const toggleAnesthesiaType = (option: string) => {
    const currentTypes = Array.isArray(form.anesthesiaTypes)
      ? (form.anesthesiaTypes as string[])
      : [];
    const isAdding = !currentTypes.includes(option);
    const nextTypes = isAdding
      ? [...currentTypes, option]
      : currentTypes.filter(x => x !== option);

    const mappedTab = ANESTHESIA_TAB_MAP[option];

    setForm(p => {
      const enabled = normalizeEnabledForms(p.enabledForms);

      if (!mappedTab) {
        // No dedicated tab — just toggle the value
        return { ...p, anesthesiaTypes: nextTypes };
      }

      if (isAdding) {
        // Add the tab if it isn't already enabled
        const nextEnabled = enabled.includes(mappedTab)
          ? enabled
          : [...enabled, mappedTab];
        return { ...p, anesthesiaTypes: nextTypes, enabledForms: nextEnabled };
      } else {
        // Remove the tab only if no remaining checked type still needs it
        const tabStillNeeded = nextTypes.some(t => ANESTHESIA_TAB_MAP[t] === mappedTab);
        if (tabStillNeeded) return { ...p, anesthesiaTypes: nextTypes };
        return {
          ...p,
          anesthesiaTypes: nextTypes,
          enabledForms: enabled.filter(id => id !== mappedTab),
        };
      }
    });

  };
  const setDob = (value: string, normalize = false) => {
    setForm((p) => {
      const inputValue = formatDateInputDDMMYYYY(value);
      const parsed = parseClinicalDate(inputValue);
      const dob = parsed && normalize ? toClinicalDate(parsed) : inputValue;
      if (!parsed) return { ...p, dob, ageY: "", ageM: "" };

      const age = ageFromDob(parsed);
      if (!age) return { ...p, dob, ageY: "", ageM: "" };

      return {
        ...p,
        dob,
        ageY: String(age.years),
        ageM: String(age.months),
      };
    });
  };
  const applyAgeToDob = (ageYRaw: string, ageMRaw: string) => {
    setForm((p) => {
      const ageY = normalizeAgeText(ageYRaw, 3);
      const ageM = normalizeAgeMonthText(ageMRaw);
      const derivedDob = dobFromAge(ageY, ageM);
      if (!derivedDob) return { ...p, dob: ageY || ageM ? p.dob : "", ageY, ageM };
      const age = ageFromDob(derivedDob);
      return {
        ...p,
        dob: toClinicalDate(derivedDob),
        ageY: age ? String(age.years) : ageY,
        ageM: age ? String(age.months) : ageM,
      };
    });
  };
  const reportSaveState = useCallback((state: FormSaveState) => {
    onSaveStateChangeRef.current?.(state);
  }, []);

  const writeCache = useCallback((draft: Record<string, unknown>) => {
    if (!storageKey) return;
    try {
      localStorage.setItem(storageKey, JSON.stringify(draft));
    } catch {
      // Storage may be unavailable; the in-memory form still works.
    }
  }, [storageKey]);

  /**
   * Applies a server (or freshly cached) draft. In "merge" mode keys the user
   * changed locally since the last sync keep their local value; every other key
   * takes the server value, so edits made on the other side (Leaf or Canopy
   * tablet) appear without clobbering what is being typed here.
   */
  const applyServerDraft = useCallback((draft: Record<string, unknown>, mode: "merge" | "replace" = "merge") => {
    const remote = buildFormFromDraft(draft as FormState, formHn);
    const previousBaseline = baselineRef.current;
    baselineRef.current = remote;
    setForm(prev => {
      if (mode === "replace" || !previousBaseline) return remote;
      let changed = false;
      const next: FormState = { ...prev };
      for (const key of Object.keys(remote)) {
        if (!sameFormValue(prev[key], previousBaseline[key])) continue;
        if (sameFormValue(prev[key], remote[key])) continue;
        next[key] = remote[key];
        changed = true;
      }
      return changed ? next : prev;
    });
  }, [formHn]);

  const loadDraftFromStorage = useCallback(() => {
    if (!storageKey) {
      autoSaveReadyRef.current = false;
      baselineRef.current = null;
      setForm(defaults(""));
      setSaveNote("");
      return;
    }
    let parsed: FormState | null = null;
    try {
      const raw = localStorage.getItem(storageKey);
      parsed = raw ? (JSON.parse(raw) as FormState) : null;
    } catch {
      parsed = null;
    }
    applyServerDraft(parsed || {}, "replace");
    setSaveNote(parsed ? "Loaded saved draft" : "");
  }, [storageKey, applyServerDraft]);

  useEffect(() => {
    let alive = true;
    autoSaveReadyRef.current = false;
    loadDraftFromStorage();
    async function loadDraftFromBackend() {
      const ds = dataSourceRef.current;
      if (!storageKey || !ds) return;
      try {
        const snapshot = await ds.load();
        if (!alive) return;
        // The server copy wins over the cache: it carries edits made elsewhere
        // (e.g. a pre-op form filled on a Canopy tablet before the case started).
        if (snapshot.draft) {
          writeCache(snapshot.draft);
          applyServerDraft(snapshot.draft);
          setSaveNote(Object.keys(snapshot.draft).length > 0 ? "Loaded saved draft" : "");
        }
      } catch {
        if (alive) setSaveNote("Offline – showing the cached draft");
      } finally {
        if (alive) autoSaveReadyRef.current = true;
      }
    }
    void loadDraftFromBackend();
    return () => {
      alive = false;
    };
  }, [storageKey, loadDraftFromStorage, applyServerDraft, writeCache]);

  useEffect(() => {
    let alive = true;
    async function loadSharedPatientRecord() {
      if (leafCaseId == null) return;
      try {
        const info = await getCasePatientInfo(leafCaseId);
        if (!alive || !info) return;
        setForm(prev => {
          const dob = info.dob ? formatDateInputDDMMYYYY(info.dob) : normalizeCodeText(prev.dob);
          const parsedDob = parseClinicalDate(dob);
          const age = parsedDob ? ageFromDob(parsedDob) : null;
          const fields: FormState = {
            hn: info.hn || formHn,
            an: info.an || normalizeCodeText(prev.an),
            dob,
            ageY: age ? String(age.years) : normalizeCodeText(prev.ageY),
            ageM: age ? String(age.months) : normalizeCodeText(prev.ageM),
            weightKg: info.weight_kg != null ? String(info.weight_kg) : normalizeCodeText(prev.weightKg),
            heightCm: info.height_cm != null ? String(info.height_cm) : normalizeCodeText(prev.heightCm),
            bloodGroupABO: info.blood_group_abo || normalizeCodeText(prev.bloodGroupABO),
            bloodGroupRh: info.blood_group_rh || normalizeCodeText(prev.bloodGroupRh),
          };
          // These values come from the server's patient record, so they are not local edits.
          if (baselineRef.current) baselineRef.current = { ...baselineRef.current, ...fields };
          return { ...prev, ...fields };
        });
      } catch {
        // The shared draft remains the offline fallback when patient API data is unavailable.
      }
    }
    void loadSharedPatientRecord();
    return () => {
      alive = false;
    };
  }, [leafCaseId, formHn]);

  useEffect(() => {
    if (leafCaseId == null || !storageKey) return;
    const onStorageChanged = (event: Event) => {
      const custom = event as CustomEvent<{ caseId?: unknown; source?: unknown }>;
      const changedCaseId = Number(custom.detail?.caseId);
      const changeSource = String(custom.detail?.source || "");
      if (changeSource === "form") return;
      if (!Number.isFinite(changedCaseId) || changedCaseId !== leafCaseId) return;
      try {
        const raw = localStorage.getItem(storageKey);
        if (raw) applyServerDraft(JSON.parse(raw) as Record<string, unknown>);
      } catch {
        return;
      }
      setSaveNote("Synced from Patient/HIS");
    };
    window.addEventListener("flora:form-storage-changed", onStorageChanged);
    return () => window.removeEventListener("flora:form-storage-changed", onStorageChanged);
  }, [leafCaseId, storageKey, applyServerDraft]);

  useEffect(() => {
    if (activeTab === "invasive") {
      setActiveTab("line");
      return;
    }
    if (visibleTabs.length === 0) return;
    if (!visibleTabs.includes(activeTab)) {
      setActiveTab(visibleTabs[0]);
    }
  }, [activeTab, visibleTabs]);

  const save = useCallback(async (auto = false) => {
    const ds = dataSourceRef.current;
    if (!ds || !storageKey || readOnlyRef.current) return;
    if (savingRef.current) return;
    const current = formRef.current;
    const read = (name: string) => (typeof current[name] === "string" ? (current[name] as string) : "");
    if (!auto) {
      const normalizedExtubationTime = normalizeTimeInputHHMM(read("extubation_time"));
      const service = read("service");
      if (service && !isServiceOption(service)) {
        setSaveNote("Service must be selected from the list");
        return;
      }
      if (read("extubation_time").trim() !== "" && !normalizedExtubationTime) {
        setSaveNote("Extubation time must be HH:mm (24-hour)");
        return;
      }
    }
    const normalized = normalizeFormForSave(current, !auto);

    // Only the keys changed since the last sync go to the server: it stamps a
    // version per key and the other side merges field by field (newest wins),
    // so re-sending untouched keys would overwrite edits made elsewhere.
    const baseline = baselineRef.current;
    let changedKeys = baseline ? changedFormKeys(normalized, baseline) : Object.keys(normalized);
    if (patientFieldsReadOnly) changedKeys = changedKeys.filter(key => !PATIENT_DRAFT_FIELD_KEYS.has(key));
    if (changedKeys.length === 0) {
      if (!auto) setSaveNote(`Saved ${fmt(Date.now())}`);
      return;
    }
    const draftPatch: Record<string, unknown> = Object.fromEntries(changedKeys.map(key => [key, normalized[key]]));

    savingRef.current = true;
    syncSeqRef.current += 1;
    setIsSaving(true);
    reportSaveState({ status: "saving" });
    try {
      if (leafCaseId != null) {
        const dirtyPatientKeys = new Set(changedKeys.filter(key => SHARED_PATIENT_FORM_FIELD_KEYS.has(key)));
        if (dirtyPatientKeys.size > 0) {
          const patientPatch: Parameters<typeof updateCasePatientInfo>[1] = {
            hn: normalizeCodeText(normalized.hn) || formHn,
          };
          if (dirtyPatientKeys.has("an")) patientPatch.an = normalizeCodeText(normalized.an);
          if (["dob", "ageY", "ageM"].some(key => dirtyPatientKeys.has(key))) {
            patientPatch.dob = normalizeCodeText(normalized.dob);
            patientPatch.ageText = [
              normalizeCodeText(normalized.ageY) ? `${normalizeCodeText(normalized.ageY)}y` : "",
              normalizeCodeText(normalized.ageM) ? `${normalizeCodeText(normalized.ageM)}m` : "",
            ].filter(Boolean).join(" ");
          }
          if (dirtyPatientKeys.has("weightKg")) patientPatch.weightKg = normalizeCodeText(normalized.weightKg);
          if (dirtyPatientKeys.has("heightCm")) patientPatch.heightCm = normalizeCodeText(normalized.heightCm);
          if (dirtyPatientKeys.has("bloodGroupABO")) patientPatch.bloodGroupABO = normalizeCodeText(normalized.bloodGroupABO);
          if (dirtyPatientKeys.has("bloodGroupRh")) patientPatch.bloodGroupRh = normalizeCodeText(normalized.bloodGroupRh);
          await updateCasePatientInfo(leafCaseId, patientPatch);
        }
      }

      const result = await ds.patch(draftPatch);
      // What was sent is now on the server.
      baselineRef.current = { ...(baselineRef.current || normalized), ...(draftPatch as FormState) };
      if (!auto) {
        // Show normalized values (dates, times) unless the field changed again meanwhile.
        setForm(prev => {
          let changed = false;
          const next: FormState = { ...prev };
          for (const key of changedKeys) {
            if (!sameFormValue(prev[key], current[key]) || sameFormValue(prev[key], normalized[key])) continue;
            next[key] = normalized[key];
            changed = true;
          }
          return changed ? next : prev;
        });
      }
      if (result.draft) {
        writeCache(result.draft);
        applyServerDraft(result.draft);
      }
      if (leafCaseId != null) {
        window.dispatchEvent(
          new CustomEvent("flora:form-storage-changed", {
            detail: { caseId: leafCaseId, source: "form" },
          }),
        );
      }
      const at = Date.now();
      setSaveNote(auto ? `Auto-saved ${fmt(at)}` : `Saved ${fmt(at)}`);
      reportSaveState({ status: "saved", at });
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : "";
      setSaveNote(auto ? "Auto-save failed – will retry" : "Save failed");
      reportSaveState({ status: "error", message: message || "Save failed" });
    } finally {
      savingRef.current = false;
      setIsSaving(false);
    }
  }, [storageKey, patientFieldsReadOnly, leafCaseId, formHn, reportSaveState, writeCache, applyServerDraft]);

  // Flush pending local edits when the editor closes (view switch, tablet editor closed).
  const saveRef = useRef(save);
  useEffect(() => {
    saveRef.current = save;
  }, [save]);
  useEffect(() => () => {
    const baseline = baselineRef.current;
    if (!autoSaveReadyRef.current || readOnlyRef.current || !baseline) return;
    if (changedFormKeys(normalizeFormForSave(formRef.current, false), baseline).length > 0) {
      void saveRef.current(true);
    }
  }, []);

  /** Pulls edits made on the other side; local unsaved keys are kept. */
  const refreshFromServer = useCallback(async () => {
    const ds = dataSourceRef.current;
    if (!ds || !autoSaveReadyRef.current || savingRef.current) return;
    const seq = syncSeqRef.current;
    try {
      const snapshot = await ds.load();
      if (seq !== syncSeqRef.current || savingRef.current || !snapshot.draft) return;
      writeCache(snapshot.draft);
      applyServerDraft(snapshot.draft, readOnlyRef.current ? "replace" : "merge");
    } catch {
      // Keep the local copy; the next tick retries.
    }
  }, [applyServerDraft, writeCache]);

  // Remote sync: every few seconds (and when the window regains focus) either
  // retry pending local edits or pull the latest server draft.
  useEffect(() => {
    if (!storageKey) return;
    const tick = () => {
      if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
      if (!autoSaveReadyRef.current || savingRef.current) return;
      const baseline = baselineRef.current;
      const dirty = !readOnlyRef.current && baseline
        && changedFormKeys(normalizeFormForSave(formRef.current, false), baseline).length > 0;
      if (dirty) {
        void save(true);
        return;
      }
      void refreshFromServer();
    };
    const timer = window.setInterval(tick, Math.max(2000, refreshIntervalMs));
    window.addEventListener("focus", tick);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", tick);
    };
  }, [storageKey, refreshIntervalMs, refreshFromServer, save]);

  // Auto-save: debounced 2s after any local edit, once the initial load is done.
  useEffect(() => {
    if (!autoSaveReadyRef.current || idle || readOnly) return;
    const baseline = baselineRef.current;
    if (!baseline || changedFormKeys(normalizeFormForSave(form, false), baseline).length === 0) return;
    const timer = setTimeout(() => {
      if (!autoSaveReadyRef.current) return;
      void save(true);
    }, 2000);
    return () => clearTimeout(timer);
  }, [form, idle, readOnly, save]);

  if (idle) {
    return <div className="p-6 text-gray-400">No active case</div>;
  }

  const reset = () => {
    if (leafCaseId == null) return;
    const patientFields = pickDraftFields(form as Record<string, unknown>, PATIENT_DRAFT_FIELD_KEYS);
    const next = { ...defaults(formHn), ...patientFields, hn: formHn } as FormState;
    baselineRef.current = next;
    setForm(next);
    writeCache(next);
    void saveCaseDetailDraft(leafCaseId, next as Record<string, unknown>).catch(() => {
      // Keep the local reset while retaining the shared patient fields.
    });
    window.dispatchEvent(
      new CustomEvent("flora:form-storage-changed", {
        detail: { caseId: leafCaseId, source: "form" },
      }),
    );
    setSaveNote("Draft reset");
    setShowSavedPreview(false);
    setSavedPreview("");
  };

  const viewSaved = async () => {
    if (!storageKey) return;
    let raw = localStorage.getItem(storageKey);
    if (!raw) {
      try {
        const snapshot = await dataSourceRef.current?.load();
        if (snapshot?.draft) {
          raw = JSON.stringify(snapshot.draft);
          localStorage.setItem(storageKey, raw);
        }
      } catch {
        // ignore and fall through
      }
    }
    if (!raw) {
      setSavedPreview("No saved draft found for this case.");
      setShowSavedPreview(true);
      return;
    }

    try {
      const parsed = JSON.parse(raw);
      setSavedPreview(buildReadableDraftText(parsed));
    } catch {
      setSavedPreview(raw);
    }
    setShowSavedPreview(true);
  };

  const setGaType = (gaId: FormTabId | null) => {
    setForm(prev => {
      const current = normalizeEnabledForms(prev.enabledForms);
      const withoutGa = current.filter(id => !GA_TAB_IDS.includes(id));
      const next: FormState = {
        ...prev,
        enabledForms: gaId ? [...withoutGa, gaId] : withoutGa,
        primary_airway_device: gaId === "ga_lma" ? "lma" : "",
        primary_airway_techniques: "[]",
        primary_failed_intubation: false,
      };
      // Clear airway detail fields that don't belong to new GA type
      const keepFields = new Set(gaId === "ga_lma" ? AIRWAY_DETAIL_FIELDS_BY_DEVICE["lma"] : []);
      for (const base of AIRWAY_DETAIL_FIELDS) {
        if (keepFields.has(base)) continue;
        next[base] = Array.isArray(prev[base]) ? [] : "";
      }
      return next;
    });
    if (gaId) setActiveTab(gaId);
  };

  const addFormTab = (tabId: FormTabId) => {
    setForm(prev => {
      const current = normalizeEnabledForms(prev.enabledForms);
      if (current.includes(tabId)) return prev;
      return { ...prev, enabledForms: [...current, tabId] };
    });
    setActiveTab(tabId);
  };

  const removeFormTab = (tabId: FormTabId) => {
    if (tabId === FORM_REQUIRED_TAB) return;
    setForm(prev => {
      const current = normalizeEnabledForms(prev.enabledForms);
      return {
        ...prev,
        enabledForms: current.filter(id => id !== tabId),
      };
    });
  };

  const t = (key: string, title: string, type: "text" | "number" | "date" = "text") => (
    <label key={key} className="space-y-1">
      <div className={label}>{title}</div>
      <input className={input} type={type} value={text(key)} onChange={(e) => setText(key, e.target.value)} />
    </label>
  );

  const s = (key: string, title: string, vals: string[], placeholder = "Select...") => (
    <label key={key} className="space-y-1">
      <div className={label}>{title}</div>
      <select
        className={input}
        value={text(key)}
        onChange={(e) => setText(key, e.target.value)}
      >
        <option value="">{placeholder}</option>
        {vals.map((v) => (
          <option key={`${key}-${v}`} value={v}>
            {v}
          </option>
        ))}
      </select>
    </label>
  );

  const a = (key: string, title: string, rows = 3) => (
    <label key={key} className="space-y-1">
      <div className={label}>{title}</div>
      <textarea className={input} rows={rows} value={text(key)} onChange={(e) => setText(key, e.target.value)} />
    </label>
  );

  const r = (key: string, title: string, vals: string[], cols = "grid-cols-2 md:grid-cols-4") => (
    <div key={key} className="space-y-1">
      <div className={label}>{title}</div>
      <div className={`grid ${cols} gap-2`}>
        {vals.map((v) => (
          <label key={`${key}-${v}`} className={`inline-flex min-h-11 cursor-pointer items-center gap-2 rounded-xl border px-3 py-2 transition ${text(key) === v ? "border-[var(--app-accent)] bg-[var(--app-accent)]/10 text-[var(--app-text)]" : "border-[var(--app-border)] bg-[var(--app-control-bg)] hover:bg-[var(--app-control-bg-hover)]"}`}>
            <input type="radio" checked={text(key) === v} onChange={() => setText(key, v)} />
            <span>{v}</span>
          </label>
        ))}
      </div>
    </div>
  );

  const choiceSelect = (
    key: string,
    title: string,
    vals: Array<{ value: string; label: string }>,
    placeholder = "Choose an option",
  ) => (
    <label key={key} className="space-y-1">
      <div className={label}>{title}</div>
      <select className={input} value={text(key)} onChange={(e) => setText(key, e.target.value)}>
        <option value="">{placeholder}</option>
        {vals.map(({ value, label: optionLabel }) => (
          <option key={`${key}-${value}`} value={value}>
            {optionLabel}
          </option>
        ))}
      </select>
    </label>
  );

  const scorePicker = (key: string, title: string, max = 10) => (
    <div key={key} className="space-y-2">
      <div className="flex items-center justify-between gap-3">
        <div className={label}>{title}</div>
        <div className="rounded-full bg-[var(--app-control-bg)] px-3 py-1 text-sm font-semibold text-[var(--app-text)]">
          {text(key) || "—"} / {max}
        </div>
      </div>
      <div className="grid grid-cols-6 gap-1.5 sm:grid-cols-11">
        {Array.from({ length: max + 1 }, (_, value) => String(value)).map((value) => (
          <button
            key={`${key}-${value}`}
            type="button"
            className={`min-h-10 rounded-lg border text-sm font-semibold transition ${text(key) === value ? "border-[var(--app-accent)] bg-[var(--app-accent)] text-[var(--app-accent-contrast)]" : "border-[var(--app-border)] bg-[var(--app-control-bg)] hover:bg-[var(--app-control-bg-hover)]"}`}
            onClick={() => setText(key, value)}
            aria-pressed={text(key) === value}
          >
            {value}
          </button>
        ))}
      </div>
    </div>
  );

  const attemptField = (key: string, title: string) => {
    const parsed = Number.parseInt(text(key), 10);
    const value = Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
    const setValue = (next: number) => {
      if (!Number.isFinite(next) || next <= 0) {
        setText(key, "");
        return;
      }
      setText(key, String(Math.min(next, 99)));
    };
    return (
      <div key={key} className="space-y-1">
        <div className={label}>{title}</div>
        <div className="inline-flex items-center gap-1.5">
          <button
            type="button"
            className="h-7 w-7 rounded border border-gray-300 dark:border-gray-700 text-sm leading-none hover:bg-gray-100 dark:hover:bg-gray-800"
            onClick={() => setValue(value - 1)}
            aria-label={`Decrease ${title}`}
          >
            -
          </button>
          <input
            className="h-7 w-12 rounded border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-950 px-1 text-center text-sm"
            inputMode="numeric"
            value={value > 0 ? String(value) : ""}
            onChange={(e) => {
              const digits = e.target.value.replace(/[^\d]/g, "");
              if (!digits) {
                setText(key, "");
                return;
              }
              setValue(Number.parseInt(digits, 10));
            }}
            placeholder="0"
          />
          <button
            type="button"
            className="h-7 w-7 rounded border border-gray-300 dark:border-gray-700 text-sm leading-none hover:bg-gray-100 dark:hover:bg-gray-800"
            onClick={() => setValue((value || 0) + 1)}
            aria-label={`Increase ${title}`}
          >
            +
          </button>
        </div>
      </div>
    );
  };

  const c = (key: string, title: string, vals: string[], cols = "grid-cols-2 md:grid-cols-3") => (
    <div key={key} className="space-y-1">
      <div className={label}>{title}</div>
      <div className={`grid ${cols} gap-2`}>
        {vals.map((v) => (
          <label key={`${key}-${v}`} className={`inline-flex min-h-11 cursor-pointer items-center gap-2 rounded-xl border px-3 py-2 transition ${multi(key).includes(v) ? "border-[var(--app-accent)] bg-[var(--app-accent)]/10 text-[var(--app-text)]" : "border-[var(--app-border)] bg-[var(--app-control-bg)] hover:bg-[var(--app-control-bg-hover)]"}`}>
            <input type="checkbox" checked={multi(key).includes(v)} onChange={() => toggle(key, v)} />
            <span>{v}</span>
          </label>
        ))}
      </div>
    </div>
  );

  const rCode = (
    key: string,
    title: string,
    vals: string[],
    cols = "grid-cols-2 md:grid-cols-4",
    onSelect?: (value: string) => void,
  ) => (
    <div key={key} className="space-y-1">
      <div className={label}>{title}</div>
      <div className={`grid ${cols} gap-2`}>
        {vals.map((v) => (
          <label key={`${key}-${v}`} className={`inline-flex min-h-11 cursor-pointer items-center gap-2 rounded-xl border px-3 py-2 transition ${text(key) === v ? "border-[var(--app-accent)] bg-[var(--app-accent)]/10 text-[var(--app-text)]" : "border-[var(--app-border)] bg-[var(--app-control-bg)] hover:bg-[var(--app-control-bg-hover)]"}`}>
            <input type="radio" checked={text(key) === v} onChange={() => (onSelect ? onSelect(v) : setText(key, v))} />
            <span>{codeLabel(v)}</span>
          </label>
        ))}
      </div>
    </div>
  );

  const cCode = (key: string, title: string, vals: string[], cols = "grid-cols-2 md:grid-cols-3") => (
    <div key={key} className="space-y-1">
      <div className={label}>{title}</div>
      <div className={`grid ${cols} gap-2`}>
        {vals.map((v) => (
          <label key={`${key}-${v}`} className={`inline-flex min-h-11 cursor-pointer items-center gap-2 rounded-xl border px-3 py-2 transition ${multi(key).includes(v) ? "border-[var(--app-accent)] bg-[var(--app-accent)]/10 text-[var(--app-text)]" : "border-[var(--app-border)] bg-[var(--app-control-bg)] hover:bg-[var(--app-control-bg-hover)]"}`}>
            <input type="checkbox" checked={multi(key).includes(v)} onChange={() => toggle(key, v)} />
            <span>{codeLabel(v)}</span>
          </label>
        ))}
      </div>
    </div>
  );

  const b = (key: string, title: string) => (
    <label key={key} className={`inline-flex min-h-11 cursor-pointer items-center gap-2 rounded-xl border px-3 py-2 transition ${bool(key) ? "border-emerald-500/60 bg-emerald-500/10" : "border-[var(--app-border)] bg-[var(--app-control-bg)] hover:bg-[var(--app-control-bg-hover)]"}`}>
      <input type="checkbox" checked={bool(key)} onChange={(e) => setBool(key, e.target.checked)} />
      <span>{title}</span>
    </label>
  );

  const countValue = (key: string) => {
    const n = Number.parseInt(text(key), 10);
    return Number.isFinite(n) ? Math.max(0, Math.min(4, n)) : 0;
  };

  const smallCounterField = (key: string, title: string, max = 4) => {
    const parsed = Number.parseInt(text(key), 10);
    const value = Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, max) : 0;
    const setValue = (next: number) => {
      if (!Number.isFinite(next) || next <= 0) {
        setText(key, "0");
        return;
      }
      setText(key, String(Math.min(next, max)));
    };
    return (
      <div key={key} className="space-y-1">
        <div className={label}>{title}</div>
        <div className="inline-flex items-center gap-1.5">
          <button
            type="button"
            className="h-8 w-8 rounded border border-gray-300 dark:border-gray-700 text-sm leading-none hover:bg-gray-100 dark:hover:bg-gray-800"
            onClick={() => setValue(value - 1)}
            aria-label={`Decrease ${title}`}
          >
            -
          </button>
          <input
            className="h-8 w-14 rounded border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-950 px-1 text-center text-sm"
            inputMode="numeric"
            value={String(value)}
            onChange={(e) => {
              const digits = e.target.value.replace(/[^\d]/g, "");
              setValue(digits ? Number.parseInt(digits, 10) : 0);
            }}
          />
          <button
            type="button"
            className="h-8 w-8 rounded border border-gray-300 dark:border-gray-700 text-sm leading-none hover:bg-gray-100 dark:hover:bg-gray-800"
            onClick={() => setValue(value + 1)}
            aria-label={`Increase ${title}`}
          >
            +
          </button>
        </div>
      </div>
    );
  };

  const ivLineBlocks = Array.from({ length: countValue("ivLineCount") }, (_, i) => i + 1);
  const invasiveArterialBlocks = Array.from({ length: countValue("invasiveArterialCount") }, (_, i) => i + 1);
  const invasiveCvcBlocks = Array.from({ length: countValue("invasiveCvcCount") }, (_, i) => i + 1);

  const renderIvLine = (index: number) => {
    const prefix = `ivLine${index}`;
    return (
      <div key={prefix} className="rounded border border-gray-200 dark:border-gray-800 p-3 space-y-3">
        <div className="font-medium text-blue-700 dark:text-blue-300">IV line ({index})</div>
        <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
          {s(`${prefix}Site`, "Site", options.ivSites)}
          {s(`${prefix}Gauge`, "Gauge", options.ivGauge)}
          {s(`${prefix}Inserted`, "Inserted", options.ivSimpleInserted)}
          {attemptField(`${prefix}Attempts`, "Number of attempt")}
        </div>
        {a(`${prefix}Note`, "Note", 2)}
      </div>
    );
  };

  const renderInvasiveArterial = (index: number) => {
    const prefix = `invasiveArterial${index}`;
    return (
      <div key={prefix} className="rounded border border-gray-200 dark:border-gray-800 p-3 space-y-3">
        <div className="font-medium text-blue-700 dark:text-blue-300">Arterial catheter ({index})</div>
        <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
          {s(`${prefix}Inserted`, "Inserted", options.invasiveInserted)}
          {s(`${prefix}Gauge`, "Gauge", options.arterialGauge)}
          {s(`${prefix}Side`, "Side", options.invasiveSide)}
          {s(`${prefix}Site`, "Site", options.invasiveArterialSites)}
        </div>
        <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
          {attemptField(`${prefix}Attempts`, "Number of attempt")}
          <div className="md:col-span-3">{t(`${prefix}Comment`, "Comment")}</div>
        </div>
      </div>
    );
  };

  const renderInvasiveCvc = (index: number) => {
    const prefix = `invasiveCvc${index}`;
    return (
      <div key={prefix} className="rounded border border-gray-200 dark:border-gray-800 p-3 space-y-3">
        <div className="font-medium text-blue-700 dark:text-blue-300">Central venous catheter ({index})</div>
        <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
          {s(`${prefix}Inserted`, "Inserted", options.invasiveInserted)}
          {s(`${prefix}Technique`, "Technique", options.invasiveCvcTechnique)}
          {s(`${prefix}Side`, "Side", options.invasiveSide)}
          {s(`${prefix}Site`, "CVC site", options.invasiveCvcSimpleSites)}
          {s(`${prefix}Type`, "Catheter type", options.invasiveCvcTypes)}
        </div>
        <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
          {s(`${prefix}Size`, "Catheter size", options.invasiveCatheterSizes)}
          {attemptField(`${prefix}Attempts`, "Number of attempt")}
          {s(`${prefix}AccidentalArteryPuncture`, "Accidental artery puncture?", options.invasiveYesNo)}
          {t(`${prefix}DepthCm`, "Depth (cm)", "number")}
        </div>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          {s(`${prefix}SkinPreparation`, "Skin preparation", options.skinPrep)}
          {s(`${prefix}AsepticTechnique`, "Aseptic technique", options.invasiveSterilePrecautions)}
          {s(`${prefix}Difficulty`, "Difficulty?", options.invasiveDifficulty)}
        </div>
        {a(`${prefix}Note`, "Note", 2)}
      </div>
    );
  };

  const dobText = text("dob");
  const dobFormatError =
    dobText.trim() !== "" && normalizeDateInputDDMMYYYY(dobText) == null
      ? "Use dd/mm/yyyy"
      : "";
  const extubationTimeText = text("extubation_time");
  const extubationTimeError =
    extubationTimeText.trim() !== "" && normalizeTimeInputHHMM(extubationTimeText) == null
      ? "Use HH:mm (24-hour)"
      : "";
  const pacuScoreFields = ["pacuActivity", "pacuRespiration", "pacuCirculation", "pacuConsciousness", "pacuOxygen"];
  const pacuScore = pacuScoreFields.reduce((sum, key) => sum + (Number.parseInt(text(key), 10) || 0), 0);
  const pacuScoreRecorded = pacuScoreFields.some(key => text(key) !== "");
  const legacyFields = Array.isArray(form.innovianLegacyFields)
    ? form.innovianLegacyFields.filter((field): field is LegacyFormField => (
      typeof field === "object"
      && field !== null
      && typeof field.label === "string"
      && typeof field.value === "string"
    ))
    : [];
  const legacyGroups = Array.from(
    legacyFields.reduce((groups, field) => {
      const group = field.sourceForm?.trim() || "Imported Innovian record";
      const existing = groups.get(group) || [];
      existing.push(field);
      groups.set(group, existing);
      return groups;
    }, new Map<string, LegacyFormField[]>()),
  );

  const tabClass = (tabId: FormTabId) =>
    `${tabButtonBase} min-h-11 whitespace-nowrap rounded-xl px-3 ${
      activeTab === tabId
        ? "border-[var(--app-accent)] bg-[var(--app-accent)] text-[var(--app-accent-contrast)] shadow-sm"
        : "border-[var(--app-border)] bg-[var(--app-control-bg)] text-[var(--app-muted)] hover:bg-[var(--app-control-bg-hover)] hover:text-[var(--app-text)]"
    }`;

  return (
    <div className="app-theme-scope mx-auto max-w-[1500px] space-y-4 p-4 pb-24 text-[var(--app-text)]">
      <div className="sticky top-3 z-20">
        <div className="rounded-2xl border border-[var(--app-border)] bg-[var(--app-panel-bg)]/95 p-3 shadow-lg backdrop-blur">
          <div className="flex flex-wrap items-center gap-3">
            <div className="min-w-56">
              <div className="text-[10px] font-extrabold uppercase tracking-[0.16em] text-[var(--app-muted)]">Clinical documentation</div>
              <div className="flex items-center gap-2"><h1 className="text-lg font-bold">Anesthesia record</h1><span className="rounded-full bg-[var(--app-accent)]/12 px-2 py-0.5 text-[10px] font-bold text-[var(--app-accent)]">{coreCompletion}% core complete</span></div>
            </div>
            <div className="min-w-48 flex-1">
              <div className="h-1.5 overflow-hidden rounded-full bg-[var(--app-border)]"><div className="h-full rounded-full bg-[var(--app-accent)] transition-all" style={{ width: `${coreCompletion}%` }} /></div>
            </div>
            <div className="text-xs font-medium text-[var(--app-muted)]">{readOnly ? "Read-only" : isSaving ? "Saving…" : saveNote || "Auto-save ready"}</div>
          </div>

          <div className="mt-3 flex gap-2 overflow-x-auto pb-1" role="tablist" aria-label="Anesthesia record sections">
            {visibleTabs.map(tabId => {
              const tab = FORM_TAB_DEFS.find(item => item.id === tabId);
              const progress = completionByTab[tabId];
              if (!tab) return null;
              return (
                <button key={tab.id} type="button" role="tab" aria-selected={activeTab === tab.id} className={tabClass(tab.id)} onClick={() => setActiveTab(tab.id)}>
                  <span className="font-bold">{tab.label}</span>
                  {progress?.percent != null ? <span className={`ml-2 rounded-full px-1.5 py-0.5 text-[9px] ${progress.percent === 100 ? "bg-emerald-500/20 text-emerald-700 dark:text-emerald-300" : "bg-black/10 dark:bg-white/10"}`}>{progress.done}/{progress.total}</span> : null}
                </button>
              );
            })}
          </div>

          {!allowedTabs && !readOnly ? <details className="mt-2 rounded-xl border border-[var(--app-border)] bg-[var(--app-control-bg)] px-3 py-2">
            <summary className="cursor-pointer text-xs font-bold text-[var(--app-muted)]">Configure procedure-specific sections</summary>
            <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-[var(--app-border)] pt-2">
            {/* GA type — radio, mutually exclusive */}
            <div className="flex items-center gap-2">
              <span className="text-xs font-bold text-[var(--app-muted)] shrink-0">General anesthesia:</span>
              {([null, "ga_ett", "ga_lma", "ga_tubeless"] as (FormTabId | null)[]).map(id => (
                <label key={id ?? "none"} className="inline-flex items-center gap-1 cursor-pointer text-xs">
                  <input
                    type="radio"
                    name="ga_type_selector"
                    checked={activeGaTab === id}
                    onChange={() => setGaType(id)}
                    className="accent-blue-500"
                  />
                  <span>{id === null ? "None" : id === "ga_ett" ? "ETT" : id === "ga_lma" ? "LMA" : "Tubeless"}</span>
                </label>
              ))}
            </div>
            {/* Separator */}
            <div className="h-4 w-px shrink-0 bg-[var(--app-border)]" />
            {/* Other sections — checkboxes */}
            {NON_GA_ADDABLE_TABS.map(tab => (
              <label key={tab.id} className="inline-flex items-center gap-1 cursor-pointer text-xs">
                <input
                  type="checkbox"
                  checked={enabledTabs.includes(tab.id)}
                  onChange={() => enabledTabs.includes(tab.id) ? removeFormTab(tab.id) : addFormTab(tab.id)}
                  className="accent-blue-500"
                />
                <span>{tab.label}</span>
              </label>
            ))}
            </div>
          </details> : null}
          </div>
      </div>

      <fieldset disabled={readOnly} className="m-0 min-w-0 space-y-4 border-0 p-0">
      <section className={`${card} ${activeTab === "caseInfo" ? "" : "hidden"}`}>
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div>
            <h2 className="font-semibold">Patient and case information</h2>
            <p className="mt-0.5 text-xs text-[var(--app-muted)]">
              AN, DOB, age, blood group, height, and weight stay synchronized with Patient.
            </p>
          </div>
          <span className="rounded-full border border-blue-300 bg-blue-50 px-2.5 py-1 text-[10px] font-bold uppercase tracking-wider text-blue-700 dark:border-blue-700 dark:bg-blue-950/40 dark:text-blue-300">
            Shared with Patient
          </span>
        </div>
        <div className="space-y-3">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            <label className="space-y-1">
              <div className={label}>HN</div>
              <input className={inputNarrow} value={text("hn")} readOnly />
            </label>
            <label className="space-y-1">
              <div className={label}>AN</div>
              <input className={inputNarrow} value={text("an")} onChange={(e) => setText("an", e.target.value)} />
            </label>
            <label className="space-y-1">
              <div className={label}>Date of Birth</div>
              <input
                className={inputNarrow}
                type="text"
                inputMode="numeric"
                placeholder="dd/mm/yyyy"
                value={dobText}
                onChange={(e) => setDob(e.target.value, false)}
                onBlur={(e) => setDob(e.target.value, true)}
              />
              {dobFormatError ? (
                <div className="text-xs text-red-600 dark:text-red-400">{dobFormatError}</div>
              ) : (
                <div className="text-xs text-gray-500 dark:text-gray-400">Format: dd/mm/yyyy</div>
              )}
            </label>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
            <label className="space-y-1">
              <div className={label}>Age (Y)</div>
              <input
                className={inputNarrow}
                inputMode="numeric"
                value={text("ageY")}
                onChange={(e) => applyAgeToDob(e.target.value, text("ageM"))}
              />
            </label>
            <label className="space-y-1">
              <div className={label}>Age (M)</div>
              <input
                className={inputNarrow}
                inputMode="numeric"
                value={text("ageM")}
                onChange={(e) => applyAgeToDob(text("ageY"), e.target.value)}
              />
            </label>
            <label className="space-y-1">
              <div className={label}>Blood group (ABO)</div>
              <select
                className={inputCompact}
                value={text("bloodGroupABO")}
                onChange={(e) => setText("bloodGroupABO", e.target.value)}
              >
                <option value="">Select ABO</option>
                <option value="A">A</option>
                <option value="B">B</option>
                <option value="O">O</option>
                <option value="AB">AB</option>
              </select>
            </label>
            <label className="space-y-1">
              <div className={label}>Blood group (Rh)</div>
              <select
                className={inputCompact}
                value={text("bloodGroupRh")}
                onChange={(e) => setText("bloodGroupRh", e.target.value)}
              >
                <option value="">Select Rh</option>
                <option value="+">+</option>
                <option value="-">-</option>
              </select>
            </label>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
            <label className="space-y-1">
              <div className={label}>Height (cm)</div>
              <input
                className={inputNarrow}
                type="number"
                inputMode="decimal"
                min={30}
                max={250}
                value={text("heightCm")}
                onChange={(e) => setText("heightCm", e.target.value)}
                onBlur={(e) => setText("heightCm", clampNumeric(e.target.value, 30, 250, 0))}
              />
            </label>
            <label className="space-y-1">
              <div className={label}>Weight (kg)</div>
              <input
                className={inputNarrow}
                type="number"
                inputMode="decimal"
                step="0.1"
                min={0.5}
                max={300}
                value={text("weightKg")}
                onChange={(e) => setText("weightKg", e.target.value)}
                onBlur={(e) => setText("weightKg", clampNumeric(e.target.value, 0.5, 300, 1))}
              />
            </label>
            <label className="space-y-1">
              <div className={label}>ASA</div>
              <select
                className={inputCompact}
                value={text("asa")}
                onChange={(e) => setText("asa", e.target.value)}
              >
                <option value="">Select ASA</option>
                <option value="1">1</option>
                <option value="2">2</option>
                <option value="3">3</option>
                <option value="4">4</option>
                <option value="5">5</option>
                <option value="6">6</option>
              </select>
            </label>
            <div className="space-y-1">
              <div className={label}>Emergency</div>
              <label className="inline-flex items-center gap-2 rounded border border-gray-200 dark:border-gray-800 px-2 py-1.5">
                <input
                  type="checkbox"
                  checked={bool("emergency")}
                  onChange={(e) => setBool("emergency", e.target.checked)}
                />
                <span>Yes</span>
              </label>
            </div>
          </div>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <label className="space-y-1">
            <div className={label}>Service</div>
            <input
              className={inputNarrow}
              list="service-options"
              placeholder="Select service"
              value={text("service")}
              onChange={(e) => setText("service", e.target.value)}
              onBlur={(e) => {
                const value = e.target.value.trim();
                if (!value) return;
                if (!isServiceOption(value)) {
                  setText("service", "");
                  setSaveNote("Service must be selected from the list");
                } else {
                  setText("service", value);
                }
              }}
            />
            <datalist id="service-options">
              {options.serviceProvider.map((v) => (
                <option key={v} value={v} />
              ))}
            </datalist>
          </label>
          {r("clinic", "Clinic", ["IPD", "OPD"], "grid-cols-2")}
        </div>
        {text("service") === "Other" ? (
          <label className="space-y-1">
            <div className={label}>Service - Other</div>
            <input
              className={inputNarrow}
              value={text("serviceProviderOther")}
              onChange={(e) => setText("serviceProviderOther", e.target.value)}
            />
          </label>
        ) : null}
        {r("postoperativeDestination", "Postoperative destination", ["PACU", "ICU", "Ward", "Death"])}
      </section>

      <section className={`${card} ${activeTab === "caseInfo" ? "" : "hidden"}`}>
        <h2 className="font-semibold">Anesthesia and Monitoring</h2>

        {/* Anesthesia type checkboxes — auto-open the matching detail tab */}
        <div className="space-y-1">
          <div className={label}>Anesthesia</div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
            {options.anesthesia.map(v => {
              const mappedTab = ANESTHESIA_TAB_MAP[v];
              const tabLabel = mappedTab
                ? FORM_TAB_DEFS.find(t => t.id === mappedTab)?.label
                : null;
              return (
                <label
                  key={`anesthesiaTypes-${v}`}
                  className="inline-flex items-center gap-2 rounded border border-gray-200 dark:border-gray-800 px-2 py-1.5 cursor-pointer"
                >
                  <input
                    type="checkbox"
                    checked={multi("anesthesiaTypes").includes(v)}
                    onChange={() => toggleAnesthesiaType(v)}
                  />
                  <span className="flex-1">{v}</span>
                  {tabLabel ? (
                    <span className="text-[10px] text-[var(--app-muted)] shrink-0">
                      → {tabLabel}
                    </span>
                  ) : null}
                </label>
              );
            })}
          </div>
        </div>

        {c("monitoring", "Monitoring", options.monitoring, "grid-cols-1 md:grid-cols-3")}
      </section>

      <section className={`${card} ${activeTab === "caseInfo" ? "" : "hidden"}`}>
        <h2 className="font-semibold">Patient Safety</h2>
        {c("positioning", "Positioning", options.positioning, "grid-cols-1 md:grid-cols-4")}
        {r("headSupport", "Head support", ["Headrest", "Head pin", "Horseshoe headrest"], "grid-cols-1 md:grid-cols-3")}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {r("rightArmPosition", "Right arm position", ["On armrest", "Tucked"], "grid-cols-2")}
          {r("leftArmPosition", "Left arm position", ["On armrest", "Tucked"], "grid-cols-2")}
        </div>
        {c("patientSafetyChecks", "Patient safety", options.patientSafety, "grid-cols-1 md:grid-cols-2")}
        {c("temperatureControl", "Temperature control", options.temperatureControl, "grid-cols-1 md:grid-cols-3")}
      </section>

      <section className={`${card} ${activeTab === "preop" ? "" : "hidden"}`}>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div><div className={label}>Before anesthesia</div><h2 className="text-lg font-bold">Pre-anesthetic assessment</h2><p className="text-xs text-[var(--app-muted)]">Focused risk assessment with details revealed only when clinically relevant.</p></div>
          <span className="rounded-full border border-[var(--app-border)] bg-[var(--app-control-bg)] px-3 py-1 text-xs font-bold text-[var(--app-muted)]">Innovian: Preanesthetic evaluation / PreOp</span>
        </div>
        <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
          <div className="space-y-4 rounded-2xl border border-[var(--app-border)] bg-[var(--app-control-bg)] p-4">
            <h3 className="font-bold">Readiness</h3>
            {r("preopConsent", "Consent", ["Confirmed", "Pending", "Not applicable"], "grid-cols-3")}
            {r("preopNpoStatus", "Fasting / NPO", ["Adequate", "Inadequate", "Emergency / unknown"], "grid-cols-3")}
            {text("preopNpoStatus") !== "Adequate" ? t("preopLastMealTime", "Last oral intake") : null}
            <div className="grid grid-cols-1 gap-3 md:grid-cols-2">{s("preopFunctionalCapacity", "Functional capacity", ["< 4 METs", "4–10 METs", "> 10 METs", "Unable to assess"])}{t("preopSpecialRisk", "Special risk / precaution")}</div>
          </div>
          <div className="space-y-4 rounded-2xl border border-[var(--app-border)] bg-[var(--app-control-bg)] p-4">
            <h3 className="font-bold">Airway assessment</h3>
            {r("preopAirwayAssessment", "Airway risk", ["Routine", "Potentially difficult", "Known difficult airway"], "grid-cols-3")}
            <div className="grid grid-cols-2 gap-3 md:grid-cols-4">{s("preopMallampati", "Mallampati", ["I", "II", "III", "IV"])}{t("preopMouthOpeningCm", "Mouth opening (cm)", "number")}{t("preopThyromentalDistanceCm", "Thyromental (cm)", "number")}{s("preopNeckMobility", "Neck mobility", ["Normal", "Limited", "Fixed"])}</div>
            {c("preopDentition", "Dentition", ["Normal", "Loose tooth", "Denture", "Crown / bridge", "Edentulous"], "grid-cols-2 md:grid-cols-3")}
          </div>
        </div>
        <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
          <div className="space-y-3 rounded-2xl border border-[var(--app-border)] p-4">
            <h3 className="font-bold">Baseline clinical state</h3>
            <div className="grid grid-cols-2 gap-3 md:grid-cols-5">{t("preopBaselineBp", "BP")}{t("preopBaselineHr", "HR", "number")}{t("preopBaselineRr", "RR", "number")}{t("preopBaselineSpo2", "SpO₂ (%)", "number")}{t("preopBaselineTemp", "Temp (°C)", "number")}</div>
            <div className="grid grid-cols-3 gap-3">{t("preopGcsEye", "GCS E", "number")}{t("preopGcsVerbal", "GCS V", "number")}{t("preopGcsMotor", "GCS M", "number")}</div>
          </div>
          <div className="space-y-3 rounded-2xl border border-[var(--app-border)] p-4">
            <h3 className="font-bold">Key investigations and preparation</h3>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">{t("preopHb", "Hb")}{t("preopHct", "Hct")}{t("preopGlucose", "Glucose / DTX")}</div>
            {a("preopPremedication", "Premedication and instructions", 3)}
          </div>
        </div>
      </section>

      <section className={`${card} ${activeTab === "checklist" ? "" : "hidden"}`}>
        <div><div className={label}>Safety workflow</div><h2 className="text-lg font-bold">Anesthesia safety checklist</h2><p className="text-xs text-[var(--app-muted)]">Tap once to confirm. Unconfirmed items stay visually quiet instead of filling the page with empty inputs.</p></div>
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
          <div className="space-y-2 rounded-2xl border border-[var(--app-border)] p-4"><h3 className="font-bold">Patient and plan</h3>{b("checklistPatientIdentity", "Identity confirmed")}{b("checklistProcedure", "Procedure confirmed")}{b("checklistSite", "Site / side marked")}{b("checklistConsent", "Consent confirmed")}</div>
          <div className="space-y-2 rounded-2xl border border-[var(--app-border)] p-4"><h3 className="font-bold">Risk briefing</h3>{b("checklistAllergy", "Allergy reviewed")}{b("checklistAirwayRisk", "Airway risk reviewed")}{b("checklistBloodLossRisk", "Blood-loss risk reviewed")}{b("checklistBloodAvailable", "Blood availability confirmed")}</div>
          <div className="space-y-2 rounded-2xl border border-[var(--app-border)] p-4"><h3 className="font-bold">Equipment and team</h3>{b("checklistMachine", "Machine check complete")}{b("checklistAirwayEquipment", "Airway equipment ready")}{b("checklistMedication", "Medication checked")}{b("checklistFluids", "Fluid / IV equipment ready")}</div>
        </div>
        <details className="rounded-2xl border border-[var(--app-border)] bg-[var(--app-control-bg)] p-4"><summary className="cursor-pointer font-bold">Time-out and additional checks</summary><div className="mt-3 grid grid-cols-1 gap-2 md:grid-cols-3">{b("checklistMonitoring", "Monitoring ready")}{b("checklistAntibiotic", "Antibiotic plan confirmed")}{b("checklistImaging", "Essential imaging displayed")}{b("checklistTeamIntroduced", "Team introduced / concerns shared")}</div><div className="mt-3">{a("checklistConcerns", "Team concerns or exception note", 3)}</div></details>
      </section>

      <section className={`${card} ${activeTab === "comorbid" ? "" : "hidden"}`}>
        <h2 className="font-semibold">Comorbid</h2>
        <label className="space-y-1">
          <div className={label}>Comorbid Diseases</div>
          <textarea
            className={input}
            rows={8}
            value={text("comorbidDiseases")}
            onChange={(e) => setText("comorbidDiseases", e.target.value)}
          />
        </label>
        <label className="space-y-1">
          <div className={label}>Current Medication</div>
          <textarea
            className={input}
            rows={8}
            value={text("currentMedication")}
            onChange={(e) => setText("currentMedication", e.target.value)}
          />
        </label>
      </section>

      <section className={`${card} ${activeTab === "line" ? "" : "hidden"}`}>
        <h2 className="font-semibold">Line</h2>
        <div className="space-y-4">
          <div className="rounded border border-gray-200 dark:border-gray-800 p-3 space-y-3">
            <div className="flex items-center justify-between gap-3">
              <div className="font-medium">IV Line</div>
              {smallCounterField("ivLineCount", "Number of IV line")}
            </div>
            {ivLineBlocks.length > 0 ? (
              <div className="space-y-3">
                {ivLineBlocks.map(renderIvLine)}
              </div>
            ) : (
              <div className="rounded border border-gray-200 dark:border-gray-800 p-3 text-sm text-gray-500 dark:text-gray-400">
                No IV line selected.
              </div>
            )}
          </div>

          <div className="rounded border border-gray-200 dark:border-gray-800 p-3 space-y-3">
            <div className="flex items-center justify-between gap-3">
              <div className="font-medium">Arterial Line</div>
              {smallCounterField("invasiveArterialCount", "Number of arterial line")}
            </div>
            {invasiveArterialBlocks.length > 0 ? (
              <div className="space-y-3">
                {invasiveArterialBlocks.map(renderInvasiveArterial)}
              </div>
            ) : (
              <div className="rounded border border-gray-200 dark:border-gray-800 p-3 text-sm text-gray-500 dark:text-gray-400">
                No arterial line selected.
              </div>
            )}
          </div>

          <div className="rounded border border-gray-200 dark:border-gray-800 p-3 space-y-3">
            <div className="flex items-center justify-between gap-3">
              <div className="font-medium">Central Line</div>
              {smallCounterField("invasiveCvcCount", "Number of central line")}
            </div>
            {invasiveCvcBlocks.length > 0 ? (
              <div className="space-y-3">
                {invasiveCvcBlocks.map(renderInvasiveCvc)}
              </div>
            ) : (
              <div className="rounded border border-gray-200 dark:border-gray-800 p-3 text-sm text-gray-500 dark:text-gray-400">
                No central line selected.
              </div>
            )}
            <div className="rounded border border-gray-200 dark:border-gray-800 p-3 space-y-3">
              <div className="font-medium text-blue-700 dark:text-blue-300">Site of failed attempt?</div>
              {s("invasiveCvcFailedAttempt", "Failed attempt", options.invasiveYesNo)}
              {text("invasiveCvcFailedAttempt") === "Yes" ? (
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  {s("invasiveCvcFailedAttemptSide", "Side", options.invasiveSide)}
                  {s("invasiveCvcFailedAttemptSite", "Site", options.invasiveCvcSimpleSites)}
                </div>
              ) : null}
            </div>
          </div>
        </div>
      </section>

      {/* ── GA ETT ── */}
      <section className={`${card} ${activeTab === "ga_ett" ? "" : "hidden"}`}>
        <h2 className="font-semibold">GA — Endotracheal Tube</h2>
        {c("pre_induction", "Pre-induction", options.gaPreInduction, "grid-cols-1 md:grid-cols-2")}
        {c("induction", "Induction", options.gaInduction, "grid-cols-1 md:grid-cols-3")}
        {rCode("mask_ventilation_difficulty", "Mask ventilation difficulty", options.gaMaskVentilationDifficulty, "grid-cols-3")}
        {cCode("eye_protection", "Eye protection", options.gaEyeProtection, "grid-cols-1 md:grid-cols-3")}
        <div className="rounded border border-gray-200 dark:border-gray-800 p-3 space-y-3">
          <div className="font-medium">Route</div>
          {rCode("primary_airway_device", "Route", ["oral_endotracheal_tube", "nasal_endotracheal_tube", "tracheostomy_tube"], "grid-cols-3", (value) => setAirwayDevice("primary", value))}
          {text("primary_airway_device") === "oral_endotracheal_tube" ? (
            <div className="space-y-3">
              {rCode("oral_tube_type", "Tube type", options.gaTubeType, "grid-cols-1 md:grid-cols-3")}
              {rCode("oral_cuff", "Cuff", options.gaCuff, "grid-cols-2")}
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                {t("oral_tube_size", "Size")}
                {t("oral_tube_mark_cm", "Mark (cm)", "number")}
                {t("oral_tube_depth_cm", "Depth at lip (cm)", "number")}
                {t("oral_cuff_volume_ml", "Cuff volume (mL)", "number")}
                {t("oral_cuff_pressure_cmh2o", "Cuff pressure (cmH₂O)", "number")}
              </div>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                {rCode("oral_throat_pack", "Throat pack", options.gaYesNo, "grid-cols-2")}
                {rCode("oral_tube_in_situ", "In situ", options.gaYesNo, "grid-cols-2")}
              </div>
            </div>
          ) : null}
          {text("primary_airway_device") === "nasal_endotracheal_tube" ? (
            <div className="space-y-3">
              {rCode("nasal_tube_type", "Tube type", options.gaTubeType, "grid-cols-1 md:grid-cols-3")}
              {rCode("nasal_cuff", "Cuff", options.gaCuff, "grid-cols-2")}
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                {t("nasal_tube_size", "Size")}
                {t("nasal_tube_mark_cm", "Mark (cm)", "number")}
                {t("nasal_tube_depth_cm", "Depth at nostril (cm)", "number")}
                {t("nasal_cuff_volume_ml", "Cuff volume (mL)", "number")}
                {t("nasal_cuff_pressure_cmh2o", "Cuff pressure (cmH₂O)", "number")}
              </div>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                {rCode("nasal_preparation", "Nasal preparation", options.gaNasalPreparation, "grid-cols-1 md:grid-cols-3")}
                {rCode("nasal_nostril", "Nostril", options.gaNostril, "grid-cols-3")}
              </div>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                {rCode("nasal_throat_pack", "Pack", options.gaYesNo, "grid-cols-2")}
                {rCode("nasal_tube_in_situ", "In situ", options.gaYesNo, "grid-cols-2")}
              </div>
            </div>
          ) : null}
          {text("primary_airway_device") === "tracheostomy_tube" ? (
            <div className="space-y-3">
              {rCode("trach_type", "Trach type", options.gaTrachType, "grid-cols-1 md:grid-cols-3")}
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                {t("trach_size", "Size")}
                {rCode("trach_cuff", "Cuff", options.gaCuff, "grid-cols-2")}
                {t("trach_cuff_volume_ml", "Cuff volume (mL)", "number")}
                {t("trach_cuff_pressure_cmh2o", "Cuff pressure (cmH₂O)", "number")}
              </div>
              {rCode("trach_tube_in_situ", "In situ", options.gaYesNo, "grid-cols-2")}
            </div>
          ) : null}
        </div>
        {(() => {
          const route = text("primary_airway_device");
          const inSitu = route === "oral_endotracheal_tube"
            ? text("oral_tube_in_situ")
            : route === "nasal_endotracheal_tube"
            ? text("nasal_tube_in_situ")
            : route === "tracheostomy_tube"
            ? text("trach_tube_in_situ")
            : "";
          return route && inSitu !== "yes" ? (
            <AirwayTechniquePanel
              title="Intubation technique"
              techniquesRaw={text("primary_airway_techniques")}
              failedIntubation={bool("primary_failed_intubation")}
              onTechniquesChange={(nextRaw) => setText("primary_airway_techniques", nextRaw)}
              onFailedIntubationChange={(next) => setBool("primary_failed_intubation", next)}
            />
          ) : null;
        })()}
      </section>

      {/* ── GA LMA ── */}
      <section className={`${card} ${activeTab === "ga_lma" ? "" : "hidden"}`}>
        <h2 className="font-semibold">GA — LMA</h2>
        {c("pre_induction", "Pre-induction", options.gaPreInduction, "grid-cols-1 md:grid-cols-2")}
        {c("induction", "Induction", options.gaInduction, "grid-cols-1 md:grid-cols-3")}
        {rCode("mask_ventilation_difficulty", "Mask ventilation difficulty", options.gaMaskVentilationDifficulty, "grid-cols-3")}
        {cCode("eye_protection", "Eye protection", options.gaEyeProtection, "grid-cols-1 md:grid-cols-3")}
        <div className="rounded border border-gray-200 dark:border-gray-800 p-3 space-y-3">
          <div className="font-medium">LMA detail</div>
          {rCode("lma_type", "LMA type", options.gaLmaType, "grid-cols-3")}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {t("lma_size", "Size")}
            {t("lma_number_of_attempts", "Number of attempts", "number")}
          </div>
          {cCode("lma_confirmation", "Confirmation", options.gaLmaConfirmation, "grid-cols-2")}
        </div>
      </section>

      {/* ── GA Tubeless ── */}
      <section className={`${card} ${activeTab === "ga_tubeless" ? "" : "hidden"}`}>
        <h2 className="font-semibold">GA — Tubeless</h2>
        {c("pre_induction", "Pre-induction", options.gaPreInduction, "grid-cols-1 md:grid-cols-2")}
        {c("induction", "Induction", options.gaInduction, "grid-cols-1 md:grid-cols-3")}
        {rCode("mask_ventilation_difficulty", "Mask ventilation difficulty", options.gaMaskVentilationDifficulty, "grid-cols-3")}
        {cCode("eye_protection", "Eye protection", options.gaEyeProtection, "grid-cols-1 md:grid-cols-3")}
        <div className="rounded border border-gray-200 dark:border-gray-800 p-3 space-y-3">
          <div className="font-medium">Technique</div>
          {rCode("primary_airway_device", "Technique", options.gaTubelessTechnique, "grid-cols-1 md:grid-cols-3", (value) => setAirwayDevice("primary", value))}
          {text("primary_airway_device") === "facemask" ? (
            <div className="space-y-3">
              {rCode("mask_adjunct", "Mask adjunct", options.gaMaskAdjunct, "grid-cols-1 md:grid-cols-3")}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                {t("opa_size", "OPA size")}
                {t("npa_size", "NPA size")}
              </div>
            </div>
          ) : null}
          {text("primary_airway_device") === "jet_ventilation" ? (
            <div className="space-y-3">
              {rCode("jet_type", "Jet type", options.gaJetType, "grid-cols-2")}
            </div>
          ) : null}
        </div>
      </section>

      <section className={`${card} ${activeTab === "neuraxial" ? "" : "hidden"}`}>
        <h2 className="font-semibold">Neuraxial Anesthesia</h2>
        {r("neuraxialBlockType", "Neuraxial block type", options.neuraxialTechniques, "grid-cols-1 md:grid-cols-2")}
        {c("neuraxialSterilePrecautions", "Sterile precautions", options.sterileBarrier, "grid-cols-2 md:grid-cols-4")}
        <div className="rounded border border-gray-200 dark:border-gray-800 p-3 space-y-3">
          <div className="font-medium">Spinal Anesthesia</div>
          {r("spinalSkinPreparation", "Skin preparation", options.skinPrep, "grid-cols-1 md:grid-cols-3")}
          {b("spinalLetAirDry", "Let air dry")}
          {r("spinalApproachingLevel", "Approaching level", options.levels, "grid-cols-2 md:grid-cols-4")}
          {b("spinalCaudalBlock", "Caudal block")}
          {r("spinalNeedle", "Needle", ["Quincke", "Whitacre", "Sprotte", "Pencil point"], "grid-cols-2 md:grid-cols-4")}
          {b("spinalBlockFailure", "Block failure")}
          {a("spinalEvent", "Event", 2)}
        </div>
        <div className="rounded border border-gray-200 dark:border-gray-800 p-3 space-y-3">
          <div className="font-medium">Epidural Anesthesia</div>
          {r("epiduralSkinPreparation", "Skin preparation", options.skinPrep, "grid-cols-1 md:grid-cols-3")}
          {b("epiduralLetAirDry", "Let air dry")}
          {r("epiduralApproachingLevel", "Approaching level", options.levels, "grid-cols-2 md:grid-cols-4")}
          {b("epiduralNeedleTuohy", "Needle: Tuohy")}
          {r("epiduralLossResistance", "Loss of resistance technique", ["Air", "Normal saline"], "grid-cols-2")}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">{t("epiduralDepthCm", "Depth from skin to space (cm)", "number")}{t("epiduralCatheterMarkCm", "Catheter mark (cm)", "number")}</div>
          {b("epiduralBlockFailure", "Block failure")}
          {a("epiduralEvent", "Event", 2)}
        </div>
      </section>

      <section className={`${card} ${activeTab === "pnb" ? "" : "hidden"}`}>
        <h2 className="font-semibold">Peripheral Nerve Block</h2>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          {s("pnbTechnique", "Technique", options.pnbTechniques)}
          {t("pnbSedation", "Sedation")}
          {s("pnbSide", "Side", options.pnbSides)}
        </div>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          {s("pnbPerformedTechnique", "Performed technique", options.pnbPerformedTechniques)}
          {s("pnbGuidance", "Guidance", options.pnbGuidance)}
          {s("pnbSkinPreparation", "Skin preparation", options.skinPrep)}
        </div>
        {c("pnbAsepticTechnique", "Aseptic technique", options.pnbAsepticTechnique, "grid-cols-1 md:grid-cols-3")}
        <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
          {s("pnbNeedle", "Block needle", options.pnbNeedles)}
          {s("pnbGauge", "Gauge", options.pnbNeedleGauge)}
          {t("pnbCatheter", "Catheter")}
          {t("pnbCatheterMarkSkinCm", "Catheter mark at skin (cm)", "number")}
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {t("pnbCatheterThreadedCm", "Catheter threaded beyond tip (cm)", "number")}
          {s("pnbSecondTechnique", "Second peripheral nerve block", options.pnbTechniques, "None")}
        </div>
        {a("pnbMedicationDose", "Medication / agents & dose", 2)}
        {a("pnbComplications", "Complications", 2)}
        {a("pnbEventNote", "Other note / event / technique", 3)}
      </section>

      <section className={`${card} ${activeTab === "invasive" ? "" : "hidden"}`}>
        <h2 className="font-semibold">Invasive Catheter</h2>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {smallCounterField("invasiveArterialCount", "Number of arterial catheter")}
          {smallCounterField("invasiveCvcCount", "Number of CVC catheter")}
        </div>

        {invasiveArterialBlocks.length > 0 ? (
          <div className="space-y-3">
            {invasiveArterialBlocks.map(renderInvasiveArterial)}
          </div>
        ) : (
          <div className="rounded border border-gray-200 dark:border-gray-800 p-3 text-sm text-gray-500 dark:text-gray-400">
            No arterial catheter selected.
          </div>
        )}

        {invasiveCvcBlocks.length > 0 ? (
          <div className="space-y-3">
            {invasiveCvcBlocks.map(renderInvasiveCvc)}
          </div>
        ) : (
          <div className="rounded border border-gray-200 dark:border-gray-800 p-3 text-sm text-gray-500 dark:text-gray-400">
            No CVC catheter selected.
          </div>
        )}

        <div className="rounded border border-gray-200 dark:border-gray-800 p-3 space-y-3">
          <div className="font-medium text-blue-700 dark:text-blue-300">Site of failed attempt?</div>
          {s("invasiveCvcFailedAttempt", "Failed attempt", options.invasiveYesNo)}
          {text("invasiveCvcFailedAttempt") === "Yes" ? (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              {s("invasiveCvcFailedAttemptSide", "Side", options.invasiveSide)}
              {s("invasiveCvcFailedAttemptSite", "Site", options.invasiveCvcSimpleSites)}
            </div>
          ) : null}
        </div>

        <div className="pt-1 border-t border-gray-200 dark:border-gray-800" />
        <h3 className="font-medium">CVC Sterile / Cannulation Detail</h3>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {rCode("cvcInsertionUltrasound", "Ultrasound guidance", options.gaYesNo, "grid-cols-2")}
          {s("cvcInsertionCatheterSize", "Catheter size (Fr)", options.invasiveCatheterSizes)}
        </div>
        {c("cvcSterileBarriers", "Precaution", options.invasiveSterilePrecautions, "grid-cols-1 md:grid-cols-2")}
        <div className="pt-1" />
        {b("cvcHandScrub", "Hand scrub")}
        {r("cvcSkinPreparation", "Skin preparation", options.skinPrep.slice(0, 4), "grid-cols-1 md:grid-cols-2")}
        {b("cvcLetSkinDry", "Let skin dry")}
        {c("cvcPreCannulation", "Pre-cannulation", options.cvcPre, "grid-cols-1 md:grid-cols-2")}
        {r("cvcCannulationTechnique", "Cannulation technique", ["Landmark", "Real-time ultrasound guide", "Ultrasound-guide landmark"], "grid-cols-1 md:grid-cols-3")}
        {c("cvcPlacementConfirmation", "Venous placement confirmation", options.cvcPlacement, "grid-cols-1 md:grid-cols-3")}
        {c("cvcPostCannulation", "Post-cannulation", options.cvcPost, "grid-cols-1 md:grid-cols-2")}
        {a("cvcInsertionComplications", "Complications", 2)}
        {a("cvcInsertionEventNote", "Event note", 2)}
      </section>

      <section className={`${card} ${activeTab === "extubation" ? "" : "hidden"}`}>
        <h2 className="font-semibold">Extubation</h2>
        <label className="space-y-1">
          <div className={label}>Extubation time (HH:mm)</div>
          <input
            className={input}
            type="text"
            inputMode="numeric"
            autoComplete="off"
            placeholder="HH:mm"
            value={extubationTimeText}
            onChange={(e) => setText("extubation_time", e.target.value)}
            onBlur={(e) => {
              const normalized = normalizeTimeInputHHMM(e.target.value);
              if (normalized) setText("extubation_time", normalized);
            }}
          />
          {extubationTimeError ? (
            <div className="text-xs text-red-600 dark:text-red-400">{extubationTimeError}</div>
          ) : (
            <div className="text-xs text-gray-500 dark:text-gray-400">Format: HH:mm</div>
          )}
        </label>
        {r("extubation_location", "Extubation location", options.extubationLocation, "grid-cols-1 md:grid-cols-2")}
        {rCode("extubation_status", "Extubation status", options.extubationStatus, "grid-cols-3")}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          {s("extubation_condition", "Condition", options.extubationCondition)}
          {s("extubation_tof", "TOF", options.extubationTof)}
          {t("extubation_tof_ratio", "TOF ratio")}
        </div>
        {rCode(
          "airway_device_removed",
          "Airway device removed",
          options.gaPrimaryAirway.filter((value) =>
            ["oral_endotracheal_tube", "nasal_endotracheal_tube", "lma", "tracheostomy_tube"].includes(value),
          ),
          "grid-cols-1 md:grid-cols-2",
        )}
        {!text("airway_device_removed") && text("primary_airway_device") ? (
          <div className="text-xs text-gray-500 dark:text-gray-400">
            Default from GA primary airway: {codeLabel(text("primary_airway_device"))}
          </div>
        ) : null}
        {rCode("suction_performed", "Suction performed", options.gaYesNo, "grid-cols-2")}
        {a("extubation_note", "Extubation note", 4)}
      </section>

      <section className={`${card} ${activeTab === "pacu" ? "" : "hidden"}`}>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div><div className={label}>Post-anesthesia</div><h2 className="text-lg font-bold">Recovery / PACU</h2><p className="text-xs text-[var(--app-muted)]">Arrival, recovery score, complications and safe destination in one flow.</p></div>
          <div className={`rounded-2xl border px-4 py-2 text-center ${pacuScoreRecorded && pacuScore >= 9 ? "border-emerald-500/50 bg-emerald-500/10" : "border-[var(--app-border)] bg-[var(--app-control-bg)]"}`}><div className={label}>Recovery score</div><div className="text-2xl font-black">{pacuScoreRecorded ? pacuScore : "—"}<span className="text-sm font-medium text-[var(--app-muted)]"> / 10</span></div></div>
        </div>
        <div className="grid grid-cols-1 gap-3 md:grid-cols-3">{t("pacuArrivalTime", "Arrival time")}{s("pacuAirway", "Airway", ["Patent", "Requires support", "Artificial airway", "Obstructed"])}{s("pacuPlannedDestination", "Planned destination", ["Ward", "ICU", "Day surgery", "Home", "Other"])}</div>
        <div className="rounded-2xl border border-[var(--app-border)] bg-[var(--app-control-bg)] p-4">
          <div className="mb-3"><h3 className="font-bold">Recovery scoring</h3><p className="text-xs text-[var(--app-muted)]">Choose the current state; FLORA totals the five dimensions automatically.</p></div>
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-5">
            {choiceSelect("pacuActivity", "Activity", [{ value: "2", label: "2 · Moves four limbs" }, { value: "1", label: "1 · Moves two limbs" }, { value: "0", label: "0 · No movement" }])}
            {choiceSelect("pacuRespiration", "Respiration", [{ value: "2", label: "2 · Breathes and coughs" }, { value: "1", label: "1 · Limited / dyspnea" }, { value: "0", label: "0 · Apneic" }])}
            {choiceSelect("pacuCirculation", "Circulation", [{ value: "2", label: "2 · Within 20% baseline" }, { value: "1", label: "1 · 20–50% deviation" }, { value: "0", label: "0 · Over 50% deviation" }])}
            {choiceSelect("pacuConsciousness", "Consciousness", [{ value: "2", label: "2 · Fully awake" }, { value: "1", label: "1 · Arousable" }, { value: "0", label: "0 · Unresponsive" }])}
            {choiceSelect("pacuOxygen", "Oxygenation", [{ value: "2", label: "2 · SpO₂ >92% on air" }, { value: "1", label: "1 · Needs oxygen" }, { value: "0", label: "0 · SpO₂ <90% with oxygen" }])}
          </div>
        </div>
        {scorePicker("pacuPainScore", "Pain score")}
        <div className="grid grid-cols-1 gap-3 md:grid-cols-3">{s("pacuNauseaVomiting", "Nausea / vomiting", ["None", "Nausea", "Vomiting", "Persistent"])}{t("pacuTemperature", "Temperature (°C)", "number")}{t("pacuDrainOutput", "Drain / output")}</div>
        <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">{a("pacuComplication", "Complication / abnormal finding", 3)}{a("pacuIntervention", "Intervention and response", 3)}</div>
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">{t("pacuDischargeTime", "PACU discharge time")}{s("pacuDestination", "Actual destination", ["Ward", "ICU", "Day surgery", "Home", "Other"])}</div>
      </section>

      <section className={`${card} ${activeTab === "pain" ? "" : "hidden"}`}>
        <div><div className={label}>Acute pain service</div><h2 className="text-lg font-bold">Pain assessment and plan</h2><p className="text-xs text-[var(--app-muted)]">Compact assessment with conditional catheter and adverse-effect detail.</p></div>
        <div className="grid grid-cols-1 gap-3 md:grid-cols-3">{t("painAssessmentTime", "Assessment time")}{t("painLocation", "Location")}{s("painTechnique", "Analgesia technique", ["Systemic", "PCA", "Epidural", "Peripheral catheter", "Intrathecal", "Multimodal", "Other"])}</div>
        <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">{scorePicker("painScoreRest", "Pain at rest")}{scorePicker("painScoreMovement", "Pain on movement")}</div>
        {["Epidural", "Peripheral catheter"].includes(text("painTechnique")) ? <div className="grid grid-cols-1 gap-3 rounded-2xl border border-[var(--app-border)] bg-[var(--app-control-bg)] p-4 md:grid-cols-3">{t("painCatheterSite", "Catheter site")}{t("painSensoryLevel", "Sensory level")}{s("painMotorBlock", "Motor block", ["None", "Mild", "Moderate", "Dense"])}</div> : null}
        <div className="grid grid-cols-1 gap-3 md:grid-cols-3">{s("painSedationScore", "Sedation", ["Alert", "Occasionally drowsy", "Frequently drowsy", "Somnolent"])}{s("painNauseaVomiting", "Nausea / vomiting", ["None", "Mild", "Moderate", "Severe"])}{s("painPruritus", "Pruritus", ["None", "Mild", "Moderate", "Severe"])}</div>
        <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">{a("painRescueMedication", "Rescue medication and response", 3)}{a("painPlan", "Pain service plan", 3)}</div>
      </section>

      <section className={`${card} ${activeTab === "outcome" ? "" : "hidden"}`}>
        <div><div className={label}>Case follow-up</div><h2 className="text-lg font-bold">Outcome and complications</h2><p className="text-xs text-[var(--app-muted)]">Explicitly record a normal outcome or document the complication—absence of data is not treated as “none”.</p></div>
        {r("outcomeStatus", "Outcome", ["No complication identified", "Complication identified", "Follow-up pending"], "grid-cols-1 md:grid-cols-3")}
        {text("outcomeStatus") === "Complication identified" ? <div className="space-y-4 rounded-2xl border border-amber-500/40 bg-amber-500/5 p-4">{c("outcomeComplications", "Complication category", ["Airway", "Respiratory", "Cardiovascular", "Neurologic", "Medication", "Regional anesthesia", "Pain", "PONV", "Injury", "Other"], "grid-cols-2 md:grid-cols-5")}<div className="grid grid-cols-1 gap-3 md:grid-cols-3">{s("outcomeSeverity", "Severity", ["Mild", "Moderate", "Severe", "Life-threatening", "Death"])}{t("outcomeLocation", "Location detected")}{t("outcomeFollowUp", "Follow-up due")}</div>{a("outcomeNote", "Clinical description, action and current status", 5)}</div> : null}
        {text("outcomeStatus") !== "Complication identified" ? a("outcomeNote", "Outcome / follow-up note", 4) : null}
      </section>

      {legacyGroups.length > 0 ? (
        <section className={card} aria-label="Imported Innovian record">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <div className={label}>Migration provenance</div>
              <h2 className="text-lg font-bold">Imported Innovian record</h2>
              <p className="text-xs text-[var(--app-muted)]">Read-only source values remain available even when they do not need a permanent FLORA input.</p>
            </div>
            <span className="rounded-full border border-[var(--app-border)] bg-[var(--app-control-bg)] px-3 py-1 text-xs font-bold">{legacyFields.length} source fields</span>
          </div>
          <div className="space-y-2">
            {legacyGroups.map(([group, fields]) => (
              <details key={group} className="rounded-2xl border border-[var(--app-border)] bg-[var(--app-control-bg)] px-4 py-3">
                <summary className="cursor-pointer font-bold">{group}<span className="ml-2 text-xs font-medium text-[var(--app-muted)]">{fields.length} fields</span></summary>
                <div className="mt-3 divide-y divide-[var(--app-border)] border-t border-[var(--app-border)]">
                  {fields.map((field, index) => (
                    <div key={`${group}-${field.label}-${index}`} className="grid gap-1 py-3 md:grid-cols-[minmax(12rem,1fr)_minmax(16rem,2fr)_auto] md:items-center">
                      <div><div className="font-semibold">{field.label}</div>{field.section ? <div className="text-xs text-[var(--app-muted)]">{field.section}</div> : null}</div>
                      <div className="break-words text-sm">{field.value}{field.unit ? ` ${field.unit}` : ""}</div>
                      <div className="flex flex-wrap gap-2 text-[10px] font-bold uppercase tracking-wide text-[var(--app-muted)]">
                        {field.recordedAt ? <span>{field.recordedAt}</span> : null}
                        <span className="rounded-full border border-[var(--app-border)] px-2 py-0.5">{field.mappingStatus || "read_only_legacy"}</span>
                      </div>
                    </div>
                  ))}
                </div>
              </details>
            ))}
          </div>
        </section>
      ) : null}
      </fieldset>

      {showSavedPreview ? (
        <div className="fixed inset-0 z-30 bg-black/40 flex items-center justify-center p-4">
          <div className="w-full max-w-3xl max-h-[80vh] rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-950 shadow-lg flex flex-col">
            <div className="flex items-center justify-between px-4 py-3 border-b border-gray-200 dark:border-gray-800">
              <div className="font-medium">Saved Draft Preview</div>
              <button
                type="button"
                className={secondaryButton}
                onClick={() => setShowSavedPreview(false)}
              >
                Close
              </button>
            </div>
            <pre className="p-4 overflow-auto text-xs text-gray-800 dark:text-gray-100 whitespace-pre-wrap break-words">
              {savedPreview}
            </pre>
          </div>
        </div>
      ) : null}

      <div className="sticky bottom-3 z-20 flex justify-end">
        <div className="flex items-center gap-2 rounded-lg border border-gray-200 dark:border-gray-700 bg-white/95 dark:bg-gray-950/95 backdrop-blur px-3 py-2 shadow-sm">
          {(isSaving || saveNote) ? (
            <div className="text-xs text-gray-500 dark:text-gray-400 mr-1">
              {isSaving ? "Saving…" : saveNote}
            </div>
          ) : null}
          {!readOnly ? <button
            type="button"
            className={primaryButton}
            onClick={() => void save()}
          >
            Save
          </button> : null}
          <button
            type="button"
            className={secondaryButton}
            onClick={viewSaved}
          >
            View Saved
          </button>
          {leafCaseId != null ? <button
            type="button"
            className={dangerButton}
            onClick={() => setIsResetConfirmOpen(true)}
          >
            Reset
          </button> : null}
        </div>
      </div>

      <ConfirmDialog
        open={isResetConfirmOpen}
        title="Reset Form Draft?"
        message="This will clear unsaved and saved draft values for this case."
        confirmLabel="Reset"
        busy={false}
        onCancel={() => setIsResetConfirmOpen(false)}
        onConfirm={() => {
          reset();
          setIsResetConfirmOpen(false);
        }}
      />
    </div>
  );
}
