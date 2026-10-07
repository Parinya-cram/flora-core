import { useCallback, useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import {
  archiveCase,
  dischargeCase,
  getCaseStartOverlap,
  getSuggestedCaseEndTime,
  startCase,
  updateCaseDischargeTime,
  updateCaseStartTime,
  type CaseStartOverlap,
  type SuggestedCaseEnd,
  type StartCaseOverlapPolicy,
} from "../api/caseApi";
import { getCaseDetailDraft } from "../api/caseDetailApi";
import { listLeafWorkflows } from "../api/workflowApi";
import { defaultWorkflowId } from "../components/workflow/leafWorkflows";
import { saveCaseDetailDraft } from "../api/caseDetailApi";
import type { CaseStatus } from "../api/caseApi";
import ConfirmDialog from "../components/common/ConfirmDialog";
import HnBarcode from "../components/common/HnBarcode";
import {
  createCaseAllergy,
  deleteCaseAllergy,
  getCaseAllergies,
  syncCaseHis,
  updateCaseAllergy,
  type CaseAllergyRow,
} from "../api/caseHisApi";
import {
  getCaseDiagnosis,
  getCaseProcedures,
  type CaseDiagnosisRow,
  type CaseProcedureRow,
} from "../api/caseClinicalApi";
import {
  formatTimeInputHHMM,
  normalizeTimeInputHHMM,
} from "../utils/clinicalInput";
import { useAuth } from "../auth/useAuth";
import { openTimePicker } from "../components/common/timePicker";
import { normalizePatientNameLanguage } from "../utils/patientName";

type FormPayload = Record<string, unknown>;
type SummaryField = {
  key: string;
  label: string;
};
type SummaryItem = {
  key: string;
  label: string;
  value: string;
};
type CaseAction = "discharge" | "archive";
type StartOverlapPromptState = {
  hn: string;
  startTime: number;
  overlap: CaseStartOverlap;
};
type LeftRailUiState = {
  allergyOpen: boolean;
  caseControlOpen: boolean;
  diagOpsOpen: boolean;
  generalOpen: boolean;
  comorbidOpen: boolean;
  lineOpen: boolean;
  anesOpen: boolean;
  extubationOpen: boolean;
  safetyOpen: boolean;
};

const LEFT_RAIL_UI_STATE_KEY = "flora.leftRail.ui.v1";
const PRESTART_PATIENT_DRAFT_PREFIX = "flora.prestartPatientDraft.";
const PRESTART_HN_SYNC_EVENT = "flora:prestart-hn-sync";
const ANESTHESIA_CODE_KEYS = new Set<string>([
  "mask_ventilation_difficulty",
  "eye_protection",
  "primary_airway_device",
  "secondary_airway_device",
  "mask_adjunct",
  "oral_tube_type",
  "oral_cuff",
  "oral_throat_pack",
  "oral_tube_in_situ",
  "nasal_tube_type",
  "nasal_cuff",
  "nasal_preparation",
  "nasal_nostril",
  "nasal_throat_pack",
  "nasal_tube_in_situ",
  "secondary_mask_adjunct",
  "secondary_oral_tube_type",
  "secondary_oral_cuff",
  "secondary_oral_throat_pack",
  "secondary_oral_tube_in_situ",
  "secondary_nasal_tube_type",
  "secondary_nasal_cuff",
  "secondary_nasal_preparation",
  "secondary_nasal_nostril",
  "secondary_nasal_throat_pack",
  "secondary_nasal_tube_in_situ",
  "secondary_lma_type",
  "secondary_trach_type",
  "secondary_trach_cuff",
  "secondary_jet_type",
  "lma_type",
  "trach_type",
  "trach_cuff",
  "jet_type",
  "extubation_status",
  "airway_device_removed",
  "suction_performed",
  "cvcUltrasound",
  "cvcInsertionUltrasound",
]);

const GENERAL_FIELDS: SummaryField[] = [
  { key: "heightCm", label: "Height (cm)" },
  { key: "weightKg", label: "Weight (kg)" },
  { key: "service", label: "Service" },
  { key: "serviceProviderOther", label: "Service Other" },
  { key: "clinic", label: "Clinic" },
  { key: "postoperativeDestination", label: "Post-op Destination" },
];

const COMORBID_FIELDS: SummaryField[] = [
  { key: "comorbidDiseases", label: "Comorbid Diseases" },
  { key: "currentMedication", label: "Current Medication" },
];
const EXTUBATION_FIELDS: SummaryField[] = [
  { key: "extubation_time", label: "Extubation Time" },
  { key: "extubation_location", label: "Extubation Location" },
  { key: "extubation_status", label: "Extubation Status" },
  { key: "extubation_condition", label: "Extubation Condition" },
  { key: "extubation_tof", label: "TOF" },
  { key: "extubation_tof_ratio", label: "TOF Ratio" },
  { key: "airway_device_removed", label: "Airway Device Removed" },
  { key: "suction_performed", label: "Suction Performed" },
  { key: "extubation_note", label: "Extubation Note" },
];

const ASA_ROMAN_BY_NUMBER: Record<string, string> = {
  "1": "I",
  "2": "II",
  "3": "III",
  "4": "IV",
  "5": "V",
  "6": "VI",
};

const ANESTHESIA_FIELDS: SummaryField[] = [
  { key: "anesthesiaTypes", label: "Anesthesia Types" },
  { key: "monitoring", label: "Monitoring" },
  { key: "pre_induction", label: "Pre-induction" },
  { key: "induction", label: "Induction" },
  { key: "mask_ventilation_difficulty", label: "Mask Ventilation" },
  { key: "eye_protection", label: "Eye Protection" },
  { key: "pnbTechnique", label: "PNB Technique" },
  { key: "pnbSecondTechnique", label: "Second PNB" },
  { key: "pnbSide", label: "PNB Side" },
  { key: "pnbPerformedTechnique", label: "PNB Performed Technique" },
  { key: "pnbGuidance", label: "PNB Guidance" },
  { key: "pnbMedicationDose", label: "PNB Medication / Dose" },
  { key: "pnbComplications", label: "PNB Complications" },
];

const SAFETY_FIELDS: SummaryField[] = [
  { key: "positioning", label: "Positioning" },
  { key: "headSupport", label: "Head Support" },
  { key: "rightArmPosition", label: "Right Arm" },
  { key: "leftArmPosition", label: "Left Arm" },
  { key: "patientSafetyChecks", label: "Safety Checks" },
  { key: "temperatureControl", label: "Temperature Control" },
];

const COMMON_ALLERGEN_SUGGESTIONS = [
  "Latex",
  "Penicillin",
  "Cephalosporin",
  "Sulfa",
  "NSAID",
  "Aspirin",
  "Morphine",
  "Fentanyl",
  "Propofol",
  "Iodine",
  "Contrast media",
  "Seafood",
  "Egg",
  "Milk",
  "Soy",
  "Peanut",
  "Shellfish",
];

const ALLERGY_SEVERITY_SUGGESTIONS = [
  "Mild",
  "Moderate",
  "Severe",
  "Fatal",
  "Unknown",
  "None",
];

function formatDateTime(ts: number) {
  const d = new Date(ts);
  const dd = String(d.getDate()).padStart(2, "0");
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const yy = String(d.getFullYear()).slice(-2);
  const hh = String(d.getHours()).padStart(2, "0");
  const min = String(d.getMinutes()).padStart(2, "0");
  return `${dd}/${mm}/${yy} ${hh}:${min}`;
}

function formatElapsedShort(startTs: number, endTs: number) {
  const diffMs = Math.max(0, endTs - startTs);
  const totalMin = Math.floor(diffMs / 60000);
  const hours = Math.floor(totalMin / 60);
  const mins = totalMin % 60;
  if (hours <= 0) return `${mins}m`;
  if (mins === 0) return `${hours}hr`;
  return `${hours}hr ${mins}m`;
}

function normalizeHH(v: string) {
  const n = Number(v);
  if (Number.isNaN(n) || n < 0 || n > 23) return "00";
  return String(n).padStart(2, "0");
}

function normalizeMM(v: string) {
  const n = Number(v);
  if (Number.isNaN(n) || n < 0 || n > 59) return "00";
  return String(n).padStart(2, "0");
}

function floorToQuarterMinute(minute: number) {
  if (!Number.isFinite(minute)) return 0;
  const safe = Math.max(0, Math.min(59, Math.trunc(minute)));
  return Math.floor(safe / 15) * 15;
}

function nowHHMM() {
  const d = new Date();
  return {
    hh: String(d.getHours()).padStart(2, "0"),
    mm: String(d.getMinutes()).padStart(2, "0"),
  };
}

function parseStartClockInputs(
  hhRaw: string,
  mmRaw: string,
): { ok: true; hours: number; minutes: number } | { ok: false; message: string } {
  const hhText = String(hhRaw || "").trim();
  const mmText = String(mmRaw || "").trim();
  if (!hhText || !mmText) {
    return { ok: false, message: "Please enter the case start time." };
  }
  if (!/^\d{1,2}$/.test(hhText) || !/^\d{1,2}$/.test(mmText)) {
    return { ok: false, message: "Start time must use numeric HH and mm." };
  }

  const hours = Number(hhText);
  const minutes = Number(mmText);
  if (!Number.isInteger(hours) || hours < 0 || hours > 23) {
    return { ok: false, message: "Hour must be between 00 and 23." };
  }
  if (!Number.isInteger(minutes) || minutes < 0 || minutes > 59) {
    return { ok: false, message: "Minute must be between 00 and 59." };
  }

  return { ok: true, hours, minutes };
}

function readPrestartPatientDraft(hn: string): Record<string, unknown> | null {
  if (typeof window === "undefined") return null;
  const targetHn = String(hn || "").trim();
  if (!targetHn) return null;
  try {
    const raw = window.localStorage.getItem(`${PRESTART_PATIENT_DRAFT_PREFIX}${targetHn}`);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

function clearPrestartPatientDraft(hn: string) {
  if (typeof window === "undefined") return;
  const targetHn = String(hn || "").trim();
  if (!targetHn) return;
  try {
    window.localStorage.removeItem(`${PRESTART_PATIENT_DRAFT_PREFIX}${targetHn}`);
  } catch {
    // ignore local cache failure
  }
}

function toDateInput(ts: number) {
  const d = new Date(ts);
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function toTimeInput(ts: number) {
  const d = new Date(ts);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `${hh}:${mm}`;
}

function formatOverlapWindow(tsFrom: number, tsTo: number) {
  return `${toTimeInput(tsFrom)} to ${toTimeInput(tsTo)}`;
}

function parseDateTimeInputs(
  dateValue: string,
  timeValue: string,
  invalidLabel: string,
): { ok: true; ts: number } | { ok: false; message: string } {
  if (!dateValue || !timeValue) {
    return { ok: false, message: "Please select date and time." };
  }

  const normalizedTime = normalizeTimeInputHHMM(timeValue);
  if (!normalizedTime) {
    return { ok: false, message: "Time must be HH:mm (24-hour)." };
  }

  const [y, m, d] = dateValue.split("-").map(Number);
  if (![y, m, d].every(Number.isFinite)) {
    return { ok: false, message: "Invalid date." };
  }

  const [hhPart, mmPart] = normalizedTime.split(":").map(Number);
  if (![hhPart, mmPart].every(Number.isFinite)) {
    return { ok: false, message: "Invalid time." };
  }

  const ts = new Date(y, m - 1, d, hhPart, mmPart, 0, 0).getTime();
  if (!Number.isFinite(ts)) {
    return { ok: false, message: invalidLabel };
  }

  return { ok: true, ts };
}

function isNkaAllergyRow(row: CaseAllergyRow) {
  const allergen = String(row?.allergen || "").trim().toUpperCase();
  const status = String(row?.status || "").trim().toLowerCase();
  return (
    allergen === "NKA" ||
    allergen === "NO KNOWN ALLERGY" ||
    status === "nka"
  );
}

function formatAllergyDisplay(row: CaseAllergyRow) {
  const parts = [row.allergen];
  if (row.reaction) parts.push(`Rxn: ${row.reaction}`);
  if (row.severity) parts.push(`Severity: ${row.severity}`);
  return parts.join(" | ");
}

function normalizeSummaryValue(raw: unknown): string | null {
  if (raw == null) return null;

  if (typeof raw === "boolean") {
    return raw ? "Yes" : null;
  }

  if (typeof raw === "number") {
    return Number.isFinite(raw) ? String(raw) : null;
  }

  if (typeof raw === "string") {
    const value = raw.trim();
    return value ? value : null;
  }

  if (Array.isArray(raw)) {
    const values = raw
      .map(item => (typeof item === "string" ? item.trim() : ""))
      .filter(Boolean);

    return values.length > 0 ? values.join(", ") : null;
  }

  return null;
}

function formatCodeValue(raw: string): string {
  const token = raw.trim().toLowerCase();
  if (!token) return "";
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
  const mapped = overrides[token];
  if (mapped) return mapped;
  return token
    .replace(/_/g, " ")
    .replace(/\b\w/g, ch => ch.toUpperCase());
}

function parseTechniqueSummary(raw: unknown): Array<{
  outcome: string;
  techniqueType: string;
  attemptNo: string;
  view: string;
  bladeType: string;
  bladeSize: string;
  guideStylet: string;
  vdoType: string;
  vdoOtherType: string;
  vdoBlade: string;
  sizeMm: string;
}> {
  if (typeof raw !== "string" || !raw.trim()) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object")
      .map((item) => ({
        outcome: String(item.outcome || "").trim().toLowerCase(),
        techniqueType: String(item.technique_type || "").trim(),
        attemptNo: String(item.attempt_no || "").trim(),
        view: String(item.laryngoscopic_view || "").trim(),
        bladeType: String(item.blade_type || "").trim(),
        bladeSize: String(item.blade_size || "").trim(),
        guideStylet: String(item.guide_stylet || "").trim(),
        vdoType: String(item.vdo_type || "").trim(),
        vdoOtherType: String(item.vdo_other_type || "").trim(),
        vdoBlade: String(item.vdo_blade || "").trim(),
        sizeMm: String(item.size_mm || "").trim(),
      }))
      .filter(item => item.techniqueType);
  } catch {
    return [];
  }
}

function isTruthyFlag(raw: unknown): boolean {
  if (typeof raw === "boolean") return raw;
  if (typeof raw === "number") return Number.isFinite(raw) && raw > 0;
  if (typeof raw !== "string") return false;
  const token = raw.trim().toLowerCase();
  if (!token) return false;
  return (
    token === "1" ||
    token === "true" ||
    token === "yes" ||
    token === "y" ||
    token === "e" ||
    token === "on" ||
    token === "checked" ||
    token.includes("emerg")
  );
}

function formatAsaDisplay(raw: unknown, emergency: boolean): string {
  const value = String(raw ?? "").trim();
  if (!value) return "";

  const normalized = value.replace(/^asa\s*/i, "").trim().toUpperCase();
  const asNumber = Number(normalized);
  const romanFromNumber =
    Number.isFinite(asNumber) && asNumber > 0
      ? ASA_ROMAN_BY_NUMBER[String(Math.trunc(asNumber))]
      : null;
  const roman =
    romanFromNumber ||
    (Object.values(ASA_ROMAN_BY_NUMBER).includes(normalized) ? normalized : normalized);

  return emergency ? `${roman} E` : roman;
}

function formatBloodGroupDisplay(aboRaw: unknown, rhRaw: unknown): string {
  const abo = String(aboRaw ?? "").trim().toUpperCase();
  const rh = String(rhRaw ?? "").trim().toUpperCase();
  if (!abo && !rh) return "";
  if (!abo) return rh;
  if (!rh) return abo;
  if (abo.endsWith("+") || abo.endsWith("-")) return abo;
  if (rh === "+" || rh === "-") return `${abo}${rh}`;
  return `${abo} ${rh}`;
}

function buildGeneralSummaryItems(payload: FormPayload | null): SummaryItem[] {
  const items = buildSummarySection(GENERAL_FIELDS, payload);
  if (!payload) return items;

  const result: SummaryItem[] = [];

  const dob = normalizeSummaryValue(payload.dob);
  const ageY = normalizeSummaryValue(payload.ageY);
  const ageM = normalizeSummaryValue(payload.ageM);
  const ageParts: string[] = [];
  if (ageY) ageParts.push(`${ageY}y`);
  if (ageM) ageParts.push(`${ageM}m`);
  const ageText = ageParts.join(" ");
  if (dob || ageText) {
    result.push({
      key: "dobAge",
      label: dob ? "DOB" : "Age",
      value: dob && ageText ? `${dob} (${ageText})` : dob || ageText,
    });
  }

  const heightItem = items.find(item => item.key === "heightCm");
  const weightItem = items.find(item => item.key === "weightKg");
  if (heightItem) result.push(heightItem);
  if (weightItem) result.push(weightItem);

  const bloodDisplay = formatBloodGroupDisplay(payload.bloodGroupABO, payload.bloodGroupRh);
  if (bloodDisplay) {
    result.push({
      key: "bloodGroup",
      label: "Blood",
      value: bloodDisplay,
    });
  }

  const emergency = isTruthyFlag(payload.emergency);
  const asaDisplay = formatAsaDisplay(payload.asa, emergency);
  if (asaDisplay) {
    result.push({
      key: "asa",
      label: "ASA",
      value: asaDisplay,
    });
  }

  const trailingItems = items.filter(
    item => item.key !== "heightCm" && item.key !== "weightKg",
  );
  return [...result, ...trailingItems];
}

function buildAnesthesiaSummaryItems(payload: FormPayload | null): SummaryItem[] {
  if (!payload) return [];

  const items = buildSummarySection(ANESTHESIA_FIELDS, payload);
  const result: SummaryItem[] = [...items];
  const readText = (key: string) => normalizeSummaryValue(payload[key]) || "";
  const readCode = (key: string) => {
    const raw = normalizeSummaryValue(payload[key]);
    if (!raw) return "";
    return raw
      .split(",")
      .map(chunk => formatCodeValue(chunk))
      .filter(Boolean)
      .join(", ");
  };

  const appendAirway = (scope: "primary" | "secondary") => {
    const prefix = scope === "primary" ? "" : "secondary_";
    const labelPrefix = scope === "primary" ? "Primary" : "Secondary";
    const deviceKey = scope === "primary" ? "primary_airway_device" : "secondary_airway_device";
    const deviceRaw = readText(deviceKey);
    if (!deviceRaw) return;

    result.push({
      key: `${scope}_airway_device`,
      label: `${labelPrefix} Airway`,
      value: formatCodeValue(deviceRaw),
    });

    if (deviceRaw === "oral_endotracheal_tube") {
      const oralType = readCode(`${prefix}oral_tube_type`);
      const oralSize = readText(`${prefix}oral_tube_size`);
      const oralDepth = readText(`${prefix}oral_tube_depth_cm`);
      if (oralType) result.push({ key: `${scope}_oral_type`, label: `${labelPrefix} Oral Type`, value: oralType });
      if (oralSize) result.push({ key: `${scope}_oral_size`, label: `${labelPrefix} Oral Size`, value: oralSize });
      if (oralDepth) result.push({ key: `${scope}_oral_depth`, label: `${labelPrefix} Oral Depth (cm)`, value: oralDepth });
      return;
    }

    if (deviceRaw === "nasal_endotracheal_tube") {
      const nasalType = readCode(`${prefix}nasal_tube_type`);
      const nasalSize = readText(`${prefix}nasal_tube_size`);
      const nasalDepth = readText(`${prefix}nasal_tube_depth_cm`);
      const nasalPrep = readCode(`${prefix}nasal_preparation`);
      const nostril = readCode(`${prefix}nasal_nostril`);
      const nasalPack = readCode(`${prefix}nasal_throat_pack`);
      if (nasalType) result.push({ key: `${scope}_nasal_type`, label: `${labelPrefix} Nasal Type`, value: nasalType });
      if (nasalSize) result.push({ key: `${scope}_nasal_size`, label: `${labelPrefix} Nasal Size`, value: nasalSize });
      if (nasalDepth) result.push({ key: `${scope}_nasal_depth`, label: `${labelPrefix} Nasal Depth (cm)`, value: nasalDepth });
      if (nasalPrep) result.push({ key: `${scope}_nasal_prep`, label: `${labelPrefix} Nose Prep`, value: nasalPrep });
      if (nostril) result.push({ key: `${scope}_nostril`, label: `${labelPrefix} Nostril`, value: nostril });
      if (nasalPack) result.push({ key: `${scope}_nasal_pack`, label: `${labelPrefix} Pack`, value: nasalPack });
      return;
    }

    if (deviceRaw === "mask") {
      const maskAdjunct = readCode(`${prefix}mask_adjunct`);
      if (maskAdjunct) result.push({ key: `${scope}_mask_adjunct`, label: `${labelPrefix} Mask Adjunct`, value: maskAdjunct });
      return;
    }

    if (deviceRaw === "lma") {
      const lmaType = readCode(`${prefix}lma_type`);
      const lmaSize = readText(`${prefix}lma_size`);
      if (lmaType) result.push({ key: `${scope}_lma_type`, label: `${labelPrefix} LMA Type`, value: lmaType });
      if (lmaSize) result.push({ key: `${scope}_lma_size`, label: `${labelPrefix} LMA Size`, value: lmaSize });
      return;
    }
  };

  appendAirway("primary");
  const primaryTechniques = parseTechniqueSummary(payload.primary_airway_techniques);
  for (const item of primaryTechniques) {
    const outcome = item.outcome === "failure" ? "Failure" : "Success";
    const parts = [`${outcome}: ${formatCodeValue(item.techniqueType)}`];
    if (item.attemptNo) parts.push(`Attempt ${item.attemptNo}`);
    if (item.view) parts.push(`View ${item.view}`);
    if (item.bladeType) parts.push(`Blade ${formatCodeValue(item.bladeType)}`);
    if (item.bladeSize) parts.push(`Blade size ${item.bladeSize}`);
    if (item.vdoType) parts.push(`VDO ${formatCodeValue(item.vdoType)}`);
    if (item.vdoOtherType) parts.push(`VDO other ${item.vdoOtherType}`);
    if (item.vdoBlade) parts.push(`VDO blade ${formatCodeValue(item.vdoBlade)}`);
    if (item.guideStylet) parts.push(`Guide/stylet ${formatCodeValue(item.guideStylet)}`);
    if (item.sizeMm) parts.push(`Size ${item.sizeMm} mm`);
    result.push({ key: `primary_tech_${item.techniqueType}_${item.attemptNo}`, label: "Primary Technique", value: parts.join(" | ") });
  }
  if (isTruthyFlag(payload.primary_failed_intubation)) {
    result.push({ key: "primary_failed_intubation", label: "Primary Failed Intubation", value: "Yes" });
  }
  if (isTruthyFlag(payload.secondary_airway_enabled)) {
    appendAirway("secondary");
    const secondaryTechniques = parseTechniqueSummary(payload.secondary_airway_techniques);
    for (const item of secondaryTechniques) {
      const outcome = item.outcome === "failure" ? "Failure" : "Success";
      const parts = [`${outcome}: ${formatCodeValue(item.techniqueType)}`];
      if (item.attemptNo) parts.push(`Attempt ${item.attemptNo}`);
      if (item.view) parts.push(`View ${item.view}`);
      if (item.bladeType) parts.push(`Blade ${formatCodeValue(item.bladeType)}`);
      if (item.bladeSize) parts.push(`Blade size ${item.bladeSize}`);
      if (item.vdoType) parts.push(`VDO ${formatCodeValue(item.vdoType)}`);
      if (item.vdoOtherType) parts.push(`VDO other ${item.vdoOtherType}`);
      if (item.vdoBlade) parts.push(`VDO blade ${formatCodeValue(item.vdoBlade)}`);
      if (item.guideStylet) parts.push(`Guide/stylet ${formatCodeValue(item.guideStylet)}`);
      if (item.sizeMm) parts.push(`Size ${item.sizeMm} mm`);
      result.push({ key: `secondary_tech_${item.techniqueType}_${item.attemptNo}`, label: "Secondary Technique", value: parts.join(" | ") });
    }
    if (isTruthyFlag(payload.secondary_failed_intubation)) {
      result.push({ key: "secondary_failed_intubation", label: "Secondary Failed Intubation", value: "Yes" });
    }
  }
  return result;
}

function buildLineSummaryItems(payload: FormPayload | null): SummaryItem[] {
  if (!payload) return [];
  const items: SummaryItem[] = [];
  const read = (key: string) => normalizeSummaryValue(payload[key]) || "";
  const push = (key: string, label: string, value: string) => {
    const clean = value.trim();
    if (!clean) return;
    items.push({ key, label, value: clean });
  };

  const ivCount = Number.parseInt(read("ivLineCount"), 10) || 0;
  if (ivCount > 0) {
    for (let i = 1; i <= Math.min(4, ivCount); i += 1) {
      const prefix = `ivLine${i}`;
      push(
        `${prefix}_summary`,
        `IV ${i}`,
        [read(`${prefix}Site`), read(`${prefix}Gauge`), read(`${prefix}Inserted`), read(`${prefix}Attempts`) ? `${read(`${prefix}Attempts`)} attempt(s)` : ""]
          .filter(Boolean)
          .join(" | "),
      );
    }
  } else {
    push("iv_legacy", "IV", [read("ivSites"), read("ivCatheterSize"), read("ivWhereInserted")].filter(Boolean).join(" | "));
    push("iv_legacy_attempts", "IV Attempts", read("ivAttempts"));
  }

  const arterialCount = Number.parseInt(read("invasiveArterialCount"), 10) || 0;
  for (let i = 1; i <= Math.min(4, arterialCount); i += 1) {
    const prefix = `invasiveArterial${i}`;
    push(
      `${prefix}_summary`,
      `A-line ${i}`,
      [read(`${prefix}Inserted`), read(`${prefix}Gauge`), read(`${prefix}Side`), read(`${prefix}Site`), read(`${prefix}Attempts`) ? `${read(`${prefix}Attempts`)} attempt(s)` : ""]
        .filter(Boolean)
        .join(" | "),
    );
  }

  const cvcCount = Number.parseInt(read("invasiveCvcCount"), 10) || 0;
  for (let i = 1; i <= Math.min(4, cvcCount); i += 1) {
    const prefix = `invasiveCvc${i}`;
    push(
      `${prefix}_summary`,
      `C-line ${i}`,
      [
        read(`${prefix}Inserted`),
        read(`${prefix}Technique`),
        read(`${prefix}Side`),
        read(`${prefix}Site`),
        read(`${prefix}Type`),
        read(`${prefix}Size`),
        read(`${prefix}Attempts`) ? `${read(`${prefix}Attempts`)} attempt(s)` : "",
      ]
        .filter(Boolean)
        .join(" | "),
    );
  }

  const failedAttempt = read("invasiveCvcFailedAttempt");
  if (failedAttempt === "Yes") {
    push(
      "cvc_failed_attempt",
      "C-line Failed Attempt",
      [failedAttempt, read("invasiveCvcFailedAttemptSide"), read("invasiveCvcFailedAttemptSite")].filter(Boolean).join(" | "),
    );
  }

  return items;
}

function buildSummarySection(
  fields: SummaryField[],
  payload: FormPayload | null,
): SummaryItem[] {
  if (!payload) return [];

  const items: SummaryItem[] = [];

  for (const field of fields) {
    let value = normalizeSummaryValue(payload[field.key]);
    if (!value) continue;
    if (ANESTHESIA_CODE_KEYS.has(field.key)) {
      value = value
        .split(",")
        .map(chunk => formatCodeValue(chunk))
        .filter(Boolean)
        .join(", ");
      if (!value) continue;
    }
    items.push({
      key: field.key,
      label: field.label,
      value,
    });
  }

  return items;
}

function pickSummaryText(payload: FormPayload | null, keys: string[]): string {
  if (!payload) return "";
  for (const key of keys) {
    const value = normalizeSummaryValue(payload[key]);
    if (value) return value;
  }
  return "";
}

function buildPatientName(
  payload: FormPayload | null,
  titleKeys: string[],
  firstKeys: string[],
  lastKeys: string[],
) {
  const title = pickSummaryText(payload, titleKeys);
  const first = pickSummaryText(payload, firstKeys);
  const last = pickSummaryText(payload, lastKeys);
  return [title, first, last].filter(Boolean).join(" ").trim();
}

function readStoredForm(storageKey: string): FormPayload | null {
  if (!storageKey) return null;
  const raw = localStorage.getItem(storageKey);
  if (!raw) return null;

  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return null;
    }
    return parsed as FormPayload;
  } catch {
    return null;
  }
}

function readLeftRailUiState(): Partial<LeftRailUiState> {
  const raw = localStorage.getItem(LEFT_RAIL_UI_STATE_KEY);
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return parsed as Partial<LeftRailUiState>;
  } catch {
    return {};
  }
}

function writeLeftRailUiState(next: LeftRailUiState) {
  localStorage.setItem(LEFT_RAIL_UI_STATE_KEY, JSON.stringify(next));
}

interface LeftRailProps {
  caseStatus: CaseStatus;
  onCaseChange: () => Promise<void>;
  historyMode?: boolean;
  onCurrentCaseStarted?: () => void;
  onCaseStartTimeUpdated?: (caseId: number, startTime: number) => void;
  onCaseDischargeTimeUpdated?: (caseId: number, dischargeTime: number) => void;
}

export default function LeftRail({
  caseStatus,
  onCaseChange,
  historyMode = false,
  onCurrentCaseStarted,
  onCaseStartTimeUpdated,
  onCaseDischargeTimeUpdated,
}: LeftRailProps) {
  const { user: sessionUser } = useAuth();
  const patientNameLanguage = normalizePatientNameLanguage(
    sessionUser?.parameterPreferences?.patientNameLanguage,
  );
  const [initialUiState] = useState<Partial<LeftRailUiState>>(() => readLeftRailUiState());
  const [hn, setHn] = useState("");
  const [hh, setHh] = useState(() => nowHHMM().hh);
  const [mm, setMm] = useState(() => nowHHMM().mm);
  const [autoStartClock, setAutoStartClock] = useState(true);
  // Desktop: the shared hour/minute grid for the separate HH and MM boxes.
  const openStartClockPicker = (anchor: HTMLElement) => {
    const hour = Number(hh), minute = Number(mm);
    openTimePicker(anchor, Number.isFinite(hour) && Number.isFinite(minute) ? { hour, minute } : null, (h, m) => {
      setHh(String(h).padStart(2, "0"));
      setMm(String(m).padStart(2, "0"));
      setAutoStartClock(false);
    });
  };
  const [formPayload, setFormPayload] = useState<FormPayload | null>(null);
  const [diagnosisRows, setDiagnosisRows] = useState<CaseDiagnosisRow[]>([]);
  const [operationRows, setOperationRows] = useState<CaseProcedureRow[]>([]);
  const [allergyRows, setAllergyRows] = useState<CaseAllergyRow[]>([]);

  const [isAllergyOpen, setIsAllergyOpen] = useState(initialUiState.allergyOpen ?? true);
  const [isCaseControlOpen, setIsCaseControlOpen] = useState(initialUiState.caseControlOpen ?? true);
  const [isDiagOpsOpen, setIsDiagOpsOpen] = useState(initialUiState.diagOpsOpen ?? true);
  const [isGeneralOpen, setIsGeneralOpen] = useState(initialUiState.generalOpen ?? true);
  const [isComorbidOpen, setIsComorbidOpen] = useState(initialUiState.comorbidOpen ?? true);
  const [isLineOpen, setIsLineOpen] = useState(initialUiState.lineOpen ?? true);
  const [isAnesOpen, setIsAnesOpen] = useState(initialUiState.anesOpen ?? true);
  const [isExtubationOpen, setIsExtubationOpen] = useState(initialUiState.extubationOpen ?? true);
  const [isSafetyOpen, setIsSafetyOpen] = useState(initialUiState.safetyOpen ?? true);
  const [pendingCaseAction, setPendingCaseAction] = useState<CaseAction | null>(null);
  const [caseActionBusy, setCaseActionBusy] = useState(false);
  const [hisSyncBusy, setHisSyncBusy] = useState(false);
  const [hisSyncNote, setHisSyncNote] = useState("");
  const [backToCurrentBusy, setBackToCurrentBusy] = useState(false);
  const [startEditOpen, setStartEditOpen] = useState(false);
  const [startEditDate, setStartEditDate] = useState("");
  const [startEditTime, setStartEditTime] = useState("");
  const [startEditBusy, setStartEditBusy] = useState(false);
  const [startEditNote, setStartEditNote] = useState("");
  const [pendingDischargeDate, setPendingDischargeDate] = useState("");
  const [pendingDischargeTime, setPendingDischargeTime] = useState("");
  const [suggestedCaseEnd, setSuggestedCaseEnd] = useState<SuggestedCaseEnd>(null);
  const [dischargeEditOpen, setDischargeEditOpen] = useState(false);
  const [dischargeEditDate, setDischargeEditDate] = useState("");
  const [dischargeEditTime, setDischargeEditTime] = useState("");
  const [dischargeEditBusy, setDischargeEditBusy] = useState(false);
  const [dischargeEditNote, setDischargeEditNote] = useState("");
  const [caseActionNote, setCaseActionNote] = useState("");
  const [stoppedDripWarnings, setStoppedDripWarnings] = useState<Array<{ name: string; delivered_ml: number; planned_volume_ml: number | null }>>([]);
  const [startCaseNote, setStartCaseNote] = useState("");
  const [startOverlapPrompt, setStartOverlapPrompt] = useState<StartOverlapPromptState | null>(null);
  const [startOverlapBusy, setStartOverlapBusy] = useState(false);
  const [nkaBusy, setNkaBusy] = useState(false);
  const [nkaNote, setNkaNote] = useState("");
  const [isAllergyModalOpen, setIsAllergyModalOpen] = useState(false);
  const [editingAllergyId, setEditingAllergyId] = useState<number | string | null>(null);
  const [allergyModalAllergen, setAllergyModalAllergen] = useState("");
  const [allergyModalReaction, setAllergyModalReaction] = useState("");
  const [allergyModalSeverity, setAllergyModalSeverity] = useState("");
  const [allergyModalBusy, setAllergyModalBusy] = useState(false);
  const [allergyModalError, setAllergyModalError] = useState("");
  const [pendingDeleteAllergyId, setPendingDeleteAllergyId] = useState<number | string | null>(null);
  const [allergyDeleteBusy, setAllergyDeleteBusy] = useState(false);

  const formStorageKey = useMemo(() => {
    if (caseStatus.status === "IDLE") return "";
    return `doctor_form_${caseStatus.case_id}`;
  }, [caseStatus]);

  useEffect(() => {
    let alive = true;

    async function loadSuggestedEnd() {
      if (caseStatus.status === "IDLE") {
        if (alive) setSuggestedCaseEnd(null);
        return;
      }
      try {
        const suggestion = await getSuggestedCaseEndTime(caseStatus.case_id);
        if (!alive) return;
        setSuggestedCaseEnd(suggestion);
      } catch {
        if (!alive) return;
        setSuggestedCaseEnd(null);
      }
    }

    loadSuggestedEnd().catch(() => {
      if (alive) setSuggestedCaseEnd(null);
    });
    return () => {
      alive = false;
    };
  }, [caseStatus]);

  const refreshFormSummary = useCallback(() => {
    if (!formStorageKey || caseStatus.status === "IDLE") {
      setFormPayload(null);
      return;
    }

    const localDraft = readStoredForm(formStorageKey);
    if (localDraft) {
      setFormPayload(localDraft);
    } else {
      setFormPayload(null);
    }

    void (async () => {
      try {
        const backendDraft = await getCaseDetailDraft(caseStatus.case_id);
        if (!backendDraft) return;
        localStorage.setItem(formStorageKey, JSON.stringify(backendDraft));
        setFormPayload(backendDraft);
      } catch {
        // keep current local summary if backend read fails
      }
    })();
  }, [caseStatus, formStorageKey]);

  useEffect(() => {
    if (caseStatus.status !== "IDLE" && caseStatus.status !== "DISCHARGED") return;
    const t = nowHHMM();
    setHh(t.hh);
    setMm(t.mm);
    setAutoStartClock(true);
    setStartCaseNote("");
  }, [caseStatus.status]);

  useEffect(() => {
    if (caseStatus.status === "IDLE") {
      setStartEditOpen(false);
      setStartEditDate("");
      setStartEditTime("");
      setStartEditNote("");
      setPendingDischargeDate("");
      setPendingDischargeTime("");
      setDischargeEditOpen(false);
      setDischargeEditDate("");
      setDischargeEditTime("");
      setDischargeEditNote("");
      setCaseActionNote("");
      setNkaNote("");
      return;
    }
    setStartEditDate(toDateInput(caseStatus.start_time));
    setStartEditTime(toTimeInput(caseStatus.start_time));
    setDischargeEditDate(toDateInput(caseStatus.discharge_time ?? caseStatus.start_time));
    setDischargeEditTime(toTimeInput(caseStatus.discharge_time ?? caseStatus.start_time));
  }, [caseStatus]);

  useEffect(() => {
    if (caseStatus.status !== "IDLE" && caseStatus.status !== "DISCHARGED") return;
    if (!autoStartClock) return;

    const tick = () => {
      const t = nowHHMM();
      setHh(t.hh);
      setMm(t.mm);
    };

    const timer = window.setInterval(tick, 1000 * 15);
    return () => window.clearInterval(timer);
  }, [autoStartClock, caseStatus.status]);

  useEffect(() => {
    writeLeftRailUiState({
      allergyOpen: isAllergyOpen,
      caseControlOpen: isCaseControlOpen,
      diagOpsOpen: isDiagOpsOpen,
      generalOpen: isGeneralOpen,
      comorbidOpen: isComorbidOpen,
      lineOpen: isLineOpen,
      anesOpen: isAnesOpen,
      extubationOpen: isExtubationOpen,
      safetyOpen: isSafetyOpen,
    });
  }, [
    isAllergyOpen,
    isCaseControlOpen,
    isDiagOpsOpen,
    isGeneralOpen,
    isComorbidOpen,
    isLineOpen,
    isAnesOpen,
    isExtubationOpen,
    isSafetyOpen,
  ]);

  useEffect(() => {
    const onPatientHnSelected = (event: Event) => {
      const custom = event as CustomEvent<{ hn?: unknown }>;
      const selectedHn = String(custom.detail?.hn || "").trim();
      if (!selectedHn) return;
      setHn(selectedHn);
    };

    window.addEventListener("flora:patient-hn-selected", onPatientHnSelected);
    return () =>
      window.removeEventListener("flora:patient-hn-selected", onPatientHnSelected);
  }, []);

  useEffect(() => {
    refreshFormSummary();
  }, [refreshFormSummary]);

  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.key !== formStorageKey) return;
      refreshFormSummary();
    };

    const onFormChanged = (event: Event) => {
      if (caseStatus.status === "IDLE") return;
      const custom = event as CustomEvent<{ caseId?: number }>;
      if (custom.detail?.caseId !== caseStatus.case_id) return;
      refreshFormSummary();
    };

    window.addEventListener("storage", onStorage);
    window.addEventListener("flora:form-storage-changed", onFormChanged);

    return () => {
      window.removeEventListener("storage", onStorage);
      window.removeEventListener("flora:form-storage-changed", onFormChanged);
    };
  }, [caseStatus, formStorageKey, refreshFormSummary]);

  useEffect(() => {
    if (caseStatus.status === "IDLE") {
      setDiagnosisRows([]);
      setOperationRows([]);
      setAllergyRows([]);
      return;
    }

    let alive = true;
    const activeCaseId = caseStatus.case_id;

    const loadClinical = async () => {
      try {
        const [diagRows, opsRows] = await Promise.all([
          getCaseDiagnosis(activeCaseId),
          getCaseProcedures(activeCaseId),
        ]);
        if (!alive) return;
        setDiagnosisRows(diagRows);
        setOperationRows(opsRows);
      } catch {
        if (!alive) return;
      }
    };

    const onClinicalChanged = (event: Event) => {
      const custom = event as CustomEvent<{ caseId?: number }>;
      if (custom.detail?.caseId !== activeCaseId) return;
      void loadClinical();
    };

    void loadClinical();
    window.addEventListener("flora:clinical-changed", onClinicalChanged);
    return () => {
      alive = false;
      window.removeEventListener("flora:clinical-changed", onClinicalChanged);
    };
  }, [caseStatus]);

  useEffect(() => {
    if (caseStatus.status === "IDLE") {
      setAllergyRows([]);
      return;
    }

    let alive = true;
    const activeCaseId = caseStatus.case_id;

    const loadAllergy = async () => {
      try {
        const rows = await getCaseAllergies(activeCaseId);
        if (!alive) return;
        setAllergyRows(rows);
      } catch {
        if (!alive) return;
      }
    };

    const onHisSynced = (event: Event) => {
      const custom = event as CustomEvent<{ caseId?: number }>;
      if (custom.detail?.caseId !== activeCaseId) return;
      void loadAllergy();
    };

    const onAllergyChanged = (event: Event) => {
      const custom = event as CustomEvent<{ caseId?: number }>;
      if (custom.detail?.caseId !== activeCaseId) return;
      void loadAllergy();
    };

    void loadAllergy();
    window.addEventListener("flora:his-synced", onHisSynced);
    window.addEventListener("flora:allergy-changed", onAllergyChanged);
    return () => {
      alive = false;
      window.removeEventListener("flora:his-synced", onHisSynced);
      window.removeEventListener("flora:allergy-changed", onAllergyChanged);
    };
  }, [caseStatus]);

  useEffect(() => {
    if (!(caseStatus.status === "IDLE" || caseStatus.status === "DISCHARGED") || historyMode) {
      return;
    }
    const onPrestartHnSync = (event: Event) => {
      const custom = event as CustomEvent<{ hn?: unknown; source?: unknown }>;
      if (String(custom.detail?.source || "") === "left-rail") return;
      const nextHn = String(custom.detail?.hn || "").trim();
      if (nextHn === hn) return;
      setHn(nextHn);
    };
    window.addEventListener(PRESTART_HN_SYNC_EVENT, onPrestartHnSync);
    return () => window.removeEventListener(PRESTART_HN_SYNC_EVENT, onPrestartHnSync);
  }, [caseStatus.status, historyMode, hn]);

  const nonNkaAllergyRows = useMemo(
    () => allergyRows.filter(row => !isNkaAllergyRow(row)),
    [allergyRows],
  );
  const nkaRow = useMemo(
    () => allergyRows.find(row => isNkaAllergyRow(row)) || null,
    [allergyRows],
  );
  const canEditNka =
    !historyMode &&
    (caseStatus.status === "ACTIVE" || caseStatus.status === "DISCHARGED");
  const hasAllergyRecords = nonNkaAllergyRows.length > 0;
  const allergyAutocompleteOptions = useMemo(() => {
    const picked = new Set<string>();
    for (const value of COMMON_ALLERGEN_SUGGESTIONS) {
      const next = value.trim();
      if (next) picked.add(next);
    }
    for (const row of nonNkaAllergyRows) {
      const next = String(row.allergen || "").trim();
      if (next) picked.add(next);
    }
    return Array.from(picked).sort((a, b) =>
      a.localeCompare(b, undefined, { sensitivity: "base" }),
    );
  }, [nonNkaAllergyRows]);
  const hasNkaConfirmed = Boolean(nkaRow);
  const allergyVisualState: "attention" | "allergy" | "nka" = hasAllergyRecords
    ? "allergy"
    : hasNkaConfirmed
      ? "nka"
      : "attention";
  const diagOpsItems = useMemo<SummaryItem[]>(() => {
    const items: SummaryItem[] = [];
    for (const row of diagnosisRows) {
      items.push({
        key: `diag-${row.id}`,
        label: "Dx",
        value: `${row.diagnosis_text}${row.icd_code ? ` (${row.icd_code})` : ""}`,
      });
    }
    for (const row of operationRows) {
      items.push({
        key: `op-${row.id}`,
        label: "Op",
        value: `${row.procedure_text}${row.icd_code ? ` (${row.icd_code})` : ""}`,
      });
    }
    return items;
  }, [diagnosisRows, operationRows]);

  const generalItems = useMemo(
    () => buildGeneralSummaryItems(formPayload),
    [formPayload],
  );
  const anesthesiaItems = useMemo(
    () => buildAnesthesiaSummaryItems(formPayload),
    [formPayload],
  );
  const comorbidItems = useMemo(
    () => buildSummarySection(COMORBID_FIELDS, formPayload),
    [formPayload],
  );
  const lineItems = useMemo(
    () => buildLineSummaryItems(formPayload),
    [formPayload],
  );
  const extubationItems = useMemo(
    () => buildSummarySection(EXTUBATION_FIELDS, formPayload),
    [formPayload],
  );
  const safetyItems = useMemo(
    () => buildSummarySection(SAFETY_FIELDS, formPayload),
    [formPayload],
  );
  const thPatientName = useMemo(
    () =>
      buildPatientName(
        formPayload,
        ["titleTh", "title_th"],
        ["firstName", "first_name"],
        ["lastName", "last_name"],
      ),
    [formPayload],
  );
  const enPatientName = useMemo(
    () =>
      buildPatientName(
        formPayload,
        ["titleEn", "title_en"],
        ["firstNameEn", "first_name_en"],
        ["lastNameEn", "last_name_en"],
      ),
    [formPayload],
  );
  const preferredPatientName =
    patientNameLanguage === "english"
      ? enPatientName || thPatientName
      : thPatientName || enPatientName;
  const caseAn = useMemo(() => pickSummaryText(formPayload, ["an"]), [formPayload]);
  const startClockState = useMemo(() => parseStartClockInputs(hh, mm), [hh, mm]);
  const canStartCase = Boolean(hn.trim()) && startClockState.ok;

  const hasSummaryItems =
    diagOpsItems.length > 0 ||
    generalItems.length > 0 ||
    comorbidItems.length > 0 ||
    lineItems.length > 0 ||
    anesthesiaItems.length > 0 ||
    extubationItems.length > 0 ||
    safetyItems.length > 0;

  async function completeStartCase(
    targetHn: string,
    startTime: number,
    overlapPolicy?: StartCaseOverlapPolicy,
  ) {
    // Quick start has no workflow picker: use the ward's default workflow when there is one.
    const workflowId = await listLeafWorkflows()
      .then(result => defaultWorkflowId(result.rows))
      .catch(() => "");
    const started = await startCase(targetHn, startTime, { overlapPolicy, ...(workflowId ? { workflowId } : {}) });
    const startedCaseId = Number(started?.case_id);
    const pendingPatientDraft = readPrestartPatientDraft(targetHn);
    if (Number.isFinite(startedCaseId) && startedCaseId > 0 && pendingPatientDraft) {
      try {
        await saveCaseDetailDraft(startedCaseId, {
          ...pendingPatientDraft,
          hn: String(targetHn).trim(),
        });
        clearPrestartPatientDraft(targetHn);
      } catch (draftErr) {
        console.error("[CASE] failed to transfer prestart patient draft", draftErr);
      }
    }
    await onCaseChange();
    window.dispatchEvent(
      new CustomEvent("flora:case-started", {
        detail: { caseId: startedCaseId, hn: String(targetHn).trim() },
      }),
    );
    setStartOverlapPrompt(null);
    setHn("");
    setAutoStartClock(true);
    onCurrentCaseStarted?.();
  }

  async function onStart() {
    if (!hn) return;
    const parsedClock = parseStartClockInputs(hh, mm);
    if (!parsedClock.ok) {
      setStartCaseNote(parsedClock.message);
      return;
    }

    const startHour = parsedClock.hours;
    const startMinute = floorToQuarterMinute(parsedClock.minutes);
    const d = new Date();
    d.setHours(startHour, startMinute, 0, 0);
    setStartCaseNote("");
    try {
      const overlap = await getCaseStartOverlap(d.getTime());
      if (overlap) {
        setStartOverlapPrompt({
          hn: String(hn).trim(),
          startTime: d.getTime(),
          overlap,
        });
        setHh(String(startHour).padStart(2, "0"));
        setMm(String(startMinute).padStart(2, "0"));
        return;
      }

      await completeStartCase(String(hn).trim(), d.getTime());
      setHh(String(startHour).padStart(2, "0"));
      setMm(String(startMinute).padStart(2, "0"));
    } catch (err) {
      setStartCaseNote(err instanceof Error ? err.message : "Failed to start case.");
    }
  }

  async function onResolveStartOverlap(policy: StartCaseOverlapPolicy) {
    if (!startOverlapPrompt) return;
    setStartOverlapBusy(true);
    setStartCaseNote("");
    try {
      await completeStartCase(startOverlapPrompt.hn, startOverlapPrompt.startTime, policy);
      setHh(String(new Date(startOverlapPrompt.startTime).getHours()).padStart(2, "0"));
      setMm(String(new Date(startOverlapPrompt.startTime).getMinutes()).padStart(2, "0"));
    } catch (err) {
      setStartCaseNote(err instanceof Error ? err.message : "Failed to start case.");
    } finally {
      setStartOverlapBusy(false);
    }
  }

  function closeStartOverlapPrompt() {
    if (startOverlapBusy) return;
    setStartOverlapPrompt(null);
  }

  function onDischarge() {
    if (caseStatus.status !== "ACTIVE") return;
    const nextTs = Date.now();
    setPendingDischargeDate(toDateInput(nextTs));
    setPendingDischargeTime(toTimeInput(nextTs));
    setCaseActionNote("");
    setPendingCaseAction("discharge");
  }

  function onArchive() {
    if (caseStatus.status !== "DISCHARGED") return;
    setCaseActionNote("");
    setPendingCaseAction("archive");
  }

  async function onConfirmCaseAction() {
    if (!pendingCaseAction || caseStatus.status === "IDLE") return;
    setCaseActionBusy(true);
    try {
      if (pendingCaseAction === "discharge" && caseStatus.status === "ACTIVE") {
        const parsed = parseDateTimeInputs(
          pendingDischargeDate,
          pendingDischargeTime,
          "Invalid discharge time.",
        );
        if (!parsed.ok) {
          setCaseActionNote(parsed.message);
          return;
        }
        const result = await dischargeCase(caseStatus.case_id, parsed.ts);
        const warnings = Array.isArray(result?.stopped_drips) ? result.stopped_drips : [];
        if (warnings.length > 0) {
          setStoppedDripWarnings(warnings);
        }
      } else if (
        pendingCaseAction === "archive" &&
        caseStatus.status === "DISCHARGED"
      ) {
        await archiveCase(caseStatus.case_id);
      }
      await onCaseChange();
      setCaseActionNote("");
      setPendingCaseAction(null);
    } catch (err) {
      setCaseActionNote(
        err instanceof Error ? err.message : "Failed to update case status.",
      );
    } finally {
      setCaseActionBusy(false);
    }
  }

  async function onSyncHis() {
    if (caseStatus.status === "IDLE") {
      setHisSyncNote("Start case first to sync HIS.");
      return;
    }
    setHisSyncBusy(true);
    setHisSyncNote("");
    try {
      const result = await syncCaseHis(caseStatus.case_id);
      const partial =
        result.his_errors && Object.keys(result.his_errors).length > 0
          ? ` (partial: ${Object.keys(result.his_errors).join(", ")})`
          : "";
      setHisSyncNote(`HIS synced${partial}`);
      window.dispatchEvent(
        new CustomEvent("flora:his-synced", {
          detail: { caseId: caseStatus.case_id },
        }),
      );
    } catch (err) {
      setHisSyncNote(err instanceof Error ? err.message : "HIS sync failed");
    } finally {
      setHisSyncBusy(false);
    }
  }

  async function onBackToCurrentCase() {
    setBackToCurrentBusy(true);
    try {
      await onCaseChange();
    } finally {
      setBackToCurrentBusy(false);
    }
  }

  async function onSaveStartTime() {
    if (caseStatus.status === "IDLE") return;
    const parsed = parseDateTimeInputs(
      startEditDate,
      startEditTime,
      "Invalid start time.",
    );
    if (!parsed.ok) {
      setStartEditNote(parsed.message);
      return;
    }
    const nextTs = parsed.ts;

    setStartEditBusy(true);
    setStartEditNote("");
    try {
      await updateCaseStartTime(caseStatus.case_id, nextTs);
      onCaseStartTimeUpdated?.(caseStatus.case_id, nextTs);
      window.dispatchEvent(
        new CustomEvent("flora:case-events-changed", {
          detail: { caseId: caseStatus.case_id },
        }),
      );
      window.dispatchEvent(
        new CustomEvent("flora:case-io-changed", {
          detail: { caseId: caseStatus.case_id },
        }),
      );
      window.dispatchEvent(
        new CustomEvent("flora:case-start-time-updated", {
          detail: { caseId: caseStatus.case_id, startTime: nextTs },
        }),
      );
      await onCaseChange();
      setStartEditOpen(false);
      setStartEditNote("Start time updated.");
    } catch (err) {
      setStartEditNote(err instanceof Error ? err.message : "Failed to update start time.");
    } finally {
      setStartEditBusy(false);
    }
  }

  async function onSaveDischargeTime() {
    if (caseStatus.status !== "DISCHARGED" && caseStatus.status !== "ARCHIVED") {
      return;
    }
    const parsed = parseDateTimeInputs(
      dischargeEditDate,
      dischargeEditTime,
      "Invalid discharge time.",
    );
    if (!parsed.ok) {
      setDischargeEditNote(parsed.message);
      return;
    }
    const nextTs = parsed.ts;

    setDischargeEditBusy(true);
    setDischargeEditNote("");
    try {
      await updateCaseDischargeTime(caseStatus.case_id, nextTs);
      onCaseDischargeTimeUpdated?.(caseStatus.case_id, nextTs);
      await onCaseChange();
      setDischargeEditOpen(false);
      setDischargeEditNote("Discharge time updated.");
    } catch (err) {
      setDischargeEditNote(
        err instanceof Error ? err.message : "Failed to update discharge time.",
      );
    } finally {
      setDischargeEditBusy(false);
    }
  }

  async function onToggleNka(checked: boolean) {
    if (caseStatus.status === "IDLE") return;
    if (!canEditNka) return;

    setNkaBusy(true);
    setNkaNote("");
    try {
      if (checked) {
        if (!nkaRow) {
          await createCaseAllergy(caseStatus.case_id, {
            allergen: "NKA",
            reaction: "No known allergy",
            severity: "none",
            status: "nka",
          });
        }
      } else if (nkaRow) {
        await deleteCaseAllergy(caseStatus.case_id, nkaRow.id);
      }

      await refreshAllergyRowsAndNotify();
    } catch (err) {
      setNkaNote(err instanceof Error ? err.message : "NKA update failed");
    } finally {
      setNkaBusy(false);
    }
  }

  async function refreshAllergyRowsAndNotify() {
    if (caseStatus.status === "IDLE") return;
    const rows = await getCaseAllergies(caseStatus.case_id);
    setAllergyRows(rows);
    window.dispatchEvent(
      new CustomEvent("flora:allergy-changed", {
        detail: { caseId: caseStatus.case_id },
      }),
    );
  }

  function openAllergyCreateModal() {
    setEditingAllergyId(null);
    setAllergyModalAllergen("");
    setAllergyModalReaction("");
    setAllergyModalSeverity("");
    setAllergyModalError("");
    setIsAllergyModalOpen(true);
  }

  function openAllergyEditModal(row: CaseAllergyRow) {
    setEditingAllergyId(row.id);
    setAllergyModalAllergen(row.allergen || "");
    setAllergyModalReaction(row.reaction || "");
    setAllergyModalSeverity(row.severity || "");
    setAllergyModalError("");
    setIsAllergyModalOpen(true);
  }

  function closeAllergyModal() {
    if (allergyModalBusy) return;
    setIsAllergyModalOpen(false);
    setAllergyModalError("");
  }

  async function onSaveAllergyModal() {
    if (caseStatus.status === "IDLE") return;
    if (!canEditNka) return;
    const allergen = allergyModalAllergen.trim();
    if (!allergen) {
      setAllergyModalError("Allergen is required.");
      return;
    }

    setAllergyModalBusy(true);
    setAllergyModalError("");
    try {
      const payload = {
        allergen,
        reaction: allergyModalReaction.trim() || undefined,
        severity: allergyModalSeverity.trim() || undefined,
      };
      if (editingAllergyId != null) {
        await updateCaseAllergy(caseStatus.case_id, editingAllergyId, payload);
      } else {
        await createCaseAllergy(caseStatus.case_id, payload);
      }
      await refreshAllergyRowsAndNotify();
      setIsAllergyModalOpen(false);
      setNkaNote("");
    } catch (err) {
      setAllergyModalError(err instanceof Error ? err.message : "Failed to save allergy.");
    } finally {
      setAllergyModalBusy(false);
    }
  }

  async function onConfirmDeleteAllergy() {
    if (caseStatus.status === "IDLE") return;
    if (!canEditNka) return;
    if (pendingDeleteAllergyId == null) return;
    setAllergyDeleteBusy(true);
    try {
      await deleteCaseAllergy(caseStatus.case_id, pendingDeleteAllergyId);
      setPendingDeleteAllergyId(null);
      await refreshAllergyRowsAndNotify();
    } catch (err) {
      setNkaNote(err instanceof Error ? err.message : "Failed to delete allergy.");
    } finally {
      setAllergyDeleteBusy(false);
    }
  }

  const renderSummarySection = (
    title: string,
    items: SummaryItem[],
    isOpen: boolean,
    setIsOpen: (value: boolean | ((prev: boolean) => boolean)) => void,
  ) => {
    if (items.length === 0) return null;

    return (
      <div className="space-y-1">
        <button
          type="button"
          className="w-full flex items-center justify-between text-left text-xs font-medium text-gray-700 dark:text-gray-300"
          onClick={() => setIsOpen(prev => !prev)}
        >
          <span>{title}</span>
          <span className="text-[10px] text-gray-500 dark:text-gray-400">
            {isOpen ? "Hide" : "Show"}
          </span>
        </button>

        {isOpen ? (
          <div className="pl-1 space-y-1">
            {items.map(item => (
              <div key={item.key} className="text-xs leading-snug">
                <span className="text-gray-500 dark:text-gray-400">{item.label}: </span>
                <span className="break-words">{item.value}</span>
              </div>
            ))}
          </div>
        ) : null}
      </div>
    );
  };

  const isCaseControlOpenEffective =
    caseStatus.status === "IDLE" ? true : isCaseControlOpen;

  return (
    <div className="h-full p-3 space-y-3 text-sm bg-gray-50 text-gray-900 dark:bg-gray-900 dark:text-gray-100 overflow-y-auto">
      {caseStatus.status !== "IDLE" ? (
        <div className="space-y-1.5">
          <button
            type="button"
            onClick={() => setIsAllergyOpen(prev => !prev)}
            className="w-full flex items-center justify-between text-left text-sm font-medium tracking-wide"
          >
            <span
              className={`inline-flex items-center gap-1 ${
                allergyVisualState === "allergy"
                  ? "text-red-600 dark:text-red-400"
                  : allergyVisualState === "nka"
                    ? "text-emerald-600 dark:text-emerald-400"
                    : "text-amber-600 dark:text-amber-400"
              }`}
            >
              {allergyVisualState === "attention" ? (
                <svg viewBox="0 0 24 24" fill="none" className="h-3.5 w-3.5" aria-hidden="true">
                  <path d="M12 4l8 14H4l8-14z" stroke="currentColor" strokeWidth="2" />
                  <path d="M12 9v4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                  <circle cx="12" cy="16.5" r="1" fill="currentColor" />
                </svg>
              ) : null}
              Allergy
            </span>
            <span className="text-[10px] text-gray-500 dark:text-gray-400">
              {isAllergyOpen ? "Hide" : "Show"}
            </span>
          </button>
          {isAllergyOpen ? (
            <div
              className={`rounded-lg px-2 py-1.5 space-y-1 ${
                allergyVisualState === "allergy"
                  ? "border border-red-200 dark:border-red-900/50 bg-red-50/60 dark:bg-red-950/20"
                  : allergyVisualState === "nka"
                    ? "border border-emerald-200 dark:border-emerald-900/50 bg-emerald-50/60 dark:bg-emerald-950/20"
                    : "border border-amber-200 dark:border-amber-900/50 bg-amber-50/60 dark:bg-amber-950/20"
              }`}
            >
              {canEditNka && !nkaRow ? (
                <div className="flex justify-end">
                  <button
                    type="button"
                    onClick={openAllergyCreateModal}
                    className="rounded border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-900 px-2 py-0.5 text-[11px] hover:bg-gray-100 dark:hover:bg-gray-800"
                  >
                    Add
                  </button>
                </div>
              ) : null}

              {nonNkaAllergyRows.length === 0 ? (
                <>
                  <label className="flex items-center gap-2 text-xs">
                    <input
                      type="checkbox"
                      checked={Boolean(nkaRow)}
                      disabled={!canEditNka || nkaBusy}
                      onChange={e => {
                        void onToggleNka(e.target.checked);
                      }}
                    />
                    <span className={nkaRow ? "font-semibold text-emerald-700 dark:text-emerald-300" : ""}>
                      NKA (No Known Allergy)
                    </span>
                  </label>
                  {!canEditNka ? (
                    <div className="text-[11px] text-gray-500 dark:text-gray-400">
                      Allergy status is read-only in this mode.
                    </div>
                  ) : null}
                </>
              ) : null}

              {nonNkaAllergyRows.length > 0 ? (
                nonNkaAllergyRows.map(row => (
                  <div key={String(row.id)} className="text-xs leading-snug space-y-1">
                    <span className="font-semibold text-red-700 dark:text-red-300">
                      {formatAllergyDisplay(row)}
                    </span>
                    {canEditNka ? (
                      <div className="flex items-center gap-1">
                        <button
                          type="button"
                          onClick={() => openAllergyEditModal(row)}
                          className="inline-flex items-center justify-center rounded border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-900 px-1.5 py-0.5 text-[10px] hover:bg-gray-100 dark:hover:bg-gray-800"
                          aria-label="Edit allergy"
                          title="Edit"
                        >
                          <svg viewBox="0 0 24 24" className="h-3 w-3" fill="none" aria-hidden="true">
                            <path
                              d="M4 20h4l10-10-4-4L4 16v4zM13 7l4 4"
                              stroke="currentColor"
                              strokeWidth="2"
                              strokeLinecap="round"
                              strokeLinejoin="round"
                            />
                          </svg>
                        </button>
                        <button
                          type="button"
                          onClick={() => setPendingDeleteAllergyId(row.id)}
                          className="inline-flex items-center justify-center rounded border border-red-300 dark:border-red-800 bg-red-50 dark:bg-red-950/30 px-1.5 py-0.5 text-[10px] font-semibold text-red-700 dark:text-red-300 hover:bg-red-100 dark:hover:bg-red-900/40"
                          aria-label="Remove allergy"
                          title="Remove"
                        >
                          x
                        </button>
                      </div>
                    ) : null}
                  </div>
                ))
              ) : nkaRow ? (
                <div className="text-xs text-emerald-700 dark:text-emerald-300">
                  NKA confirmed.
                </div>
              ) : (
                <div className="text-xs text-amber-700 dark:text-amber-300">
                  No allergy recorded. Please verify patient allergy or check NKA.
                </div>
              )}

              {nkaNote ? (
                <div className="text-[11px] text-red-700 dark:text-red-300">{nkaNote}</div>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}

      <div className="space-y-1.5">
        <button
          type="button"
          onClick={() => {
            if (caseStatus.status === "IDLE") return;
            setIsCaseControlOpen(prev => !prev);
          }}
          className="w-full flex items-center justify-between text-left text-sm font-medium tracking-wide"
        >
          <span>Case Control</span>
          <span className="text-[10px] text-gray-500 dark:text-gray-400">
            {isCaseControlOpenEffective ? "Hide" : "Show"}
          </span>
        </button>

        {isCaseControlOpenEffective ? (
          <div className="space-y-2">
            <div className="rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-950 px-2 py-1.5 space-y-0.5 text-xs text-gray-900 dark:text-white">
              {caseStatus.status === "IDLE" ? (
                <div className="font-medium">IDLE</div>
              ) : (
                <>
                  <div>
                    <span className="text-gray-800 dark:text-white">Status: </span>
                    <span className="font-medium text-blue-600 dark:text-blue-400">
                      {caseStatus.status.toLowerCase()}
                    </span>
                  </div>
                  <div className="text-gray-900 dark:text-white">HN: {caseStatus.hn}</div>
                  {caseAn ? <div className="text-gray-900 dark:text-white">AN: {caseAn}</div> : null}
                  {preferredPatientName ? (
                    <div className="pt-1 text-lg font-semibold leading-tight text-gray-950 dark:text-white">
                      {preferredPatientName}
                    </div>
                  ) : null}
                  <div className="mt-1">
                    <HnBarcode value={caseStatus.hn} height={32} className="w-full text-gray-900 dark:text-gray-100" />
                  </div>
                  <div className="text-gray-900 dark:text-white">
                    Start: {formatDateTime(caseStatus.start_time)} (
                    {formatElapsedShort(
                      caseStatus.start_time,
                      (caseStatus.status === "DISCHARGED" ||
                        caseStatus.status === "ARCHIVED") &&
                      caseStatus.discharge_time
                        ? caseStatus.discharge_time
                        : Date.now(),
                    )}
                    )
                  </div>

                  {(caseStatus.status === "DISCHARGED" ||
                    caseStatus.status === "ARCHIVED") &&
                    caseStatus.discharge_time && (
                      <div className="text-gray-900 dark:text-white">
                          Discharged: {formatDateTime(caseStatus.discharge_time)}
                        </div>
                    )}
                  {stoppedDripWarnings.length > 0 ? (
                    <div className="mt-2 rounded border border-amber-500/60 bg-amber-500/10 px-3 py-2 text-xs text-amber-200 space-y-1.5">
                      <div className="flex items-center justify-between">
                        <span className="font-medium">⚠ Drips auto-stopped at discharge</span>
                        <button type="button" className="text-amber-300 hover:text-amber-100 text-[11px]" onClick={() => setStoppedDripWarnings([])}>✕</button>
                      </div>
                      {stoppedDripWarnings.map((d, i) => {
                        const planned = d.planned_volume_ml;
                        const delivered = d.delivered_ml;
                        let statusLabel = "";
                        let statusColor = "text-amber-200";
                        if (planned != null && planned > 0) {
                          if (delivered < planned * 0.95) {
                            statusLabel = `incomplete (${delivered}/${planned} mL)`;
                            statusColor = "text-orange-300";
                          } else if (delivered > planned * 1.05) {
                            statusLabel = `over target! (${delivered}/${planned} mL)`;
                            statusColor = "text-red-300 font-medium";
                          } else {
                            statusLabel = `complete (${delivered}/${planned} mL)`;
                            statusColor = "text-green-300";
                          }
                        } else {
                          statusLabel = `${delivered} mL delivered`;
                        }
                        return (
                          <div key={i} className="flex items-baseline gap-1">
                            <span className="text-amber-100 shrink-0">• {d.name}</span>
                            <span className={statusColor}>— {statusLabel}</span>
                          </div>
                        );
                      })}
                      <div className="text-amber-300/70 text-[10px] pt-0.5">Please verify intended dose was met.</div>
                    </div>
                  ) : null}

                  {!historyMode &&
                  (caseStatus.status === "ACTIVE" ||
                    caseStatus.status === "DISCHARGED") ? (
                    <div className="mt-2 rounded border border-gray-300 dark:border-gray-600 divide-y divide-gray-300 dark:divide-gray-600 overflow-hidden">
                      {/* Adjust Start Time */}
                      <button
                        type="button"
                        onClick={() => {
                          setStartEditOpen(prev => !prev);
                          setStartEditNote("");
                        }}
                        className="w-full text-left px-3 py-2 text-[11px] font-medium bg-white dark:bg-gray-800 hover:bg-gray-50 dark:hover:bg-gray-700 flex justify-between items-center"
                      >
                        <span>{startEditOpen ? "✕ Cancel" : "Adjust Start Time"}</span>
                        {!startEditOpen && <span className="text-gray-400">›</span>}
                      </button>
                      {startEditOpen ? (
                        <div className="px-2 py-1.5 space-y-1.5 bg-gray-50 dark:bg-gray-800">
                          <div className="flex gap-1.5 items-center">
                            <input
                              type="date"
                              className="w-0 flex-1 rounded border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-950 px-1 py-1 text-[11px]"
                              value={startEditDate}
                              onChange={e => setStartEditDate(e.target.value)}
                            />
                            <input
                              type="text"
                              inputMode="numeric"
                              autoComplete="off"
                              className="w-14 shrink-0 rounded border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-950 px-1 py-1 text-[11px]"
                              value={startEditTime}
                              onChange={e => setStartEditTime(formatTimeInputHHMM(e.target.value))}
                              onBlur={e => {
                                const normalized = normalizeTimeInputHHMM(e.target.value);
                                if (normalized) setStartEditTime(normalized);
                              }}
                              placeholder="HH:mm"
                            />
                          </div>
                          <button
                            type="button"
                            onClick={() => void onSaveStartTime()}
                            disabled={startEditBusy}
                            className="rounded border border-blue-300 dark:border-blue-700 bg-blue-50 dark:bg-blue-950/30 px-2 py-1 text-[11px] text-blue-700 dark:text-blue-300 hover:bg-blue-100 dark:hover:bg-blue-900/40 disabled:opacity-60"
                          >
                            {startEditBusy ? "Saving..." : "Save"}
                          </button>
                          {startEditNote ? (
                            <div className="text-[11px] text-gray-600 dark:text-gray-400">{startEditNote}</div>
                          ) : null}
                        </div>
                      ) : null}

                      {/* Adjust Discharge Time — only when discharged */}
                      {caseStatus.status === "DISCHARGED" ? (
                        <>
                          <button
                            type="button"
                            onClick={() => {
                              setDischargeEditOpen(prev => !prev);
                              setDischargeEditNote("");
                            }}
                            className="w-full text-left px-3 py-2 text-[11px] font-medium bg-white dark:bg-gray-800 hover:bg-gray-50 dark:hover:bg-gray-700 flex justify-between items-center"
                          >
                            <span>{dischargeEditOpen ? "✕ Cancel" : "Adjust Discharge Time"}</span>
                            {!dischargeEditOpen && <span className="text-gray-400">›</span>}
                          </button>
                          {dischargeEditOpen ? (
                            <div className="px-2 py-1.5 space-y-1.5 bg-gray-50 dark:bg-gray-800">
                              <div className="flex gap-1.5 items-center">
                                <input
                                  type="date"
                                  className="w-0 flex-1 rounded border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-950 px-1 py-1 text-[11px]"
                                  value={dischargeEditDate}
                                  onChange={e => setDischargeEditDate(e.target.value)}
                                />
                                <input
                                  type="text"
                                  inputMode="numeric"
                                  autoComplete="off"
                                  className="w-14 shrink-0 rounded border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-950 px-1 py-1 text-[11px]"
                                  value={dischargeEditTime}
                                  onChange={e => setDischargeEditTime(formatTimeInputHHMM(e.target.value))}
                                  onBlur={e => {
                                    const normalized = normalizeTimeInputHHMM(e.target.value);
                                    if (normalized) setDischargeEditTime(normalized);
                                  }}
                                  placeholder="HH:mm"
                                />
                              </div>
                              <button
                                type="button"
                                onClick={() => void onSaveDischargeTime()}
                                disabled={dischargeEditBusy}
                                className="rounded border border-amber-300 dark:border-amber-700 bg-amber-50 dark:bg-amber-950/30 px-2 py-1 text-[11px] text-amber-700 dark:text-amber-300 hover:bg-amber-100 dark:hover:bg-amber-900/40 disabled:opacity-60"
                              >
                                {dischargeEditBusy ? "Saving..." : "Save"}
                              </button>
                              {dischargeEditNote ? (
                                <div className="text-[11px] text-gray-600 dark:text-gray-400">{dischargeEditNote}</div>
                              ) : null}
                            </div>
                          ) : null}

                          {/* Archive */}
                          <button
                            type="button"
                            onClick={onArchive}
                            disabled={caseActionBusy}
                            className="w-full text-left px-3 py-2 text-[11px] font-medium bg-white dark:bg-gray-800 hover:bg-red-50 dark:hover:bg-red-950/40 text-red-500 dark:text-red-400 flex justify-between items-center disabled:opacity-60"
                          >
                            <span>Archive case</span>
                            <span className="text-red-400 dark:text-red-500">›</span>
                          </button>
                        </>
                      ) : null}
                    </div>
                  ) : null}
                </>
              )}
            </div>

            {historyMode ? (
              <button
                type="button"
                onClick={() => {
                  void onBackToCurrentCase();
                }}
                disabled={backToCurrentBusy}
                className="w-full rounded border border-blue-300 dark:border-blue-700 bg-blue-50 dark:bg-blue-950/30 text-blue-700 dark:text-blue-300 hover:bg-blue-100 dark:hover:bg-blue-900/40 py-1.5 text-sm disabled:opacity-60"
              >
                {backToCurrentBusy ? "Loading current case..." : "Back to Current Case"}
              </button>
            ) : null}

            {(caseStatus.status === "IDLE" || caseStatus.status === "DISCHARGED") &&
            !historyMode ? (
              <div className="space-y-2">
                {caseStatus.status === "DISCHARGED" && (
                  <div className="text-[11px] font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wide pt-1 border-t border-gray-200 dark:border-gray-700">
                    Start Next Case
                  </div>
                )}
                <div className="flex gap-2">
                  <input
                    className="flex-1 w-12 rounded border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-950 px-2 py-1 text-sm"
                    placeholder="HN"
                    value={hn}
                    onChange={e => {
                      const nextHn = e.target.value;
                      setHn(nextHn);
                      window.dispatchEvent(
                        new CustomEvent(PRESTART_HN_SYNC_EVENT, {
                          detail: { hn: nextHn, source: "left-rail" },
                        }),
                      );
                    }}
                  />
                  <button
                    type="button"
                    className="px-3 py-1 rounded border border-gray-300 dark:border-gray-700 bg-gray-100 dark:bg-gray-800 text-sm hover:bg-gray-200 dark:hover:bg-gray-700"
                    onClick={() => {
                      const requestHn = hn.trim();
                      if (!requestHn) {
                        setHisSyncNote("Enter HN before Get HIS.");
                        return;
                      }
                      window.dispatchEvent(
                        new CustomEvent("flora:patient-gethis-request", {
                          detail: { hn: requestHn },
                        }),
                      );
                      setHisSyncNote("Get HIS requested.");
                    }}
                    disabled={hisSyncBusy}
                  >
                    Get HIS
                  </button>
                </div>

                <div className="flex items-center gap-1">
                  <input
                    className="w-12 rounded border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-950 text-center text-sm"
                    value={hh}
                    onFocus={e => openStartClockPicker(e.currentTarget.parentElement!)}
                    onChange={e => {
                      setHh(e.target.value);
                      setAutoStartClock(false);
                    }}
                    onBlur={() => setHh(normalizeHH(hh))}
                  />
                  <span>:</span>
                  <input
                    className="w-12 rounded border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-950 text-center text-sm"
                    value={mm}
                    onFocus={e => openStartClockPicker(e.currentTarget.parentElement!)}
                    onChange={e => {
                      setMm(e.target.value);
                      setAutoStartClock(false);
                    }}
                    onBlur={() => setMm(normalizeMM(mm))}
                  />
                </div>

                <button
                  onClick={onStart}
                    disabled={!canStartCase}
                    className={`w-full py-1.5 rounded text-sm text-white ${
                    canStartCase
                      ? "bg-blue-600 hover:bg-blue-700"
                      : "bg-gray-400 cursor-not-allowed"
                  }`}
                >
                  Start
                </button>

                {startCaseNote ? (
                  <div className="text-xs text-red-600 dark:text-red-400">{startCaseNote}</div>
                ) : null}

                {hn.trim() ? (
                  <div>
                    <HnBarcode value={hn} height={28} className="w-full text-gray-900 dark:text-gray-100" />
                  </div>
                ) : null}
              </div>
            ) : null}

            {caseStatus.status === "DISCHARGED" ? (
              <button
                type="button"
                onClick={onSyncHis}
                disabled={hisSyncBusy}
                className="w-full rounded border border-gray-300 dark:border-gray-700 bg-gray-100 dark:bg-gray-800 hover:bg-gray-200 dark:hover:bg-gray-700 py-1.5 text-sm disabled:opacity-60"
              >
                {hisSyncBusy ? "Syncing HIS..." : "Get HIS"}
              </button>
            ) : null}

            {caseStatus.status === "ACTIVE" ? (
              <button
                onClick={onDischarge}
                disabled={caseActionBusy}
                className="w-full rounded border border-red-600 text-red-600 hover:bg-red-600 hover:text-white py-1.5 text-sm"
              >
                Discharge
              </button>
            ) : null}

            {hisSyncNote ? (
              <div className="text-[11px] text-gray-900 dark:text-white">
                {hisSyncNote}
              </div>
            ) : null}
          </div>
        ) : null}
      </div>

      {caseStatus.status !== "IDLE" ? (
        <div className="space-y-2 pt-2 border-t border-gray-200 dark:border-gray-800">
          {!hasSummaryItems ? (
            <div className="text-xs text-gray-500 dark:text-gray-400">
              No saved form data yet.
            </div>
          ) : (
            <>
              {renderSummarySection(
                "Diag/Ops",
                diagOpsItems,
                isDiagOpsOpen,
                setIsDiagOpsOpen,
              )}
              {renderSummarySection(
                "General",
                generalItems,
                isGeneralOpen,
                setIsGeneralOpen,
              )}
              {renderSummarySection(
                "Comorbid",
                comorbidItems,
                isComorbidOpen,
                setIsComorbidOpen,
              )}
              {renderSummarySection(
                "Line",
                lineItems,
                isLineOpen,
                setIsLineOpen,
              )}
              {renderSummarySection(
                "General Anesthesia",
                anesthesiaItems,
                isAnesOpen,
                setIsAnesOpen,
              )}
              {renderSummarySection(
                "Extubation",
                extubationItems,
                isExtubationOpen,
                setIsExtubationOpen,
              )}
              {renderSummarySection(
                "Patient Safety",
                safetyItems,
                isSafetyOpen,
                setIsSafetyOpen,
              )}
            </>
          )}
        </div>
      ) : null}

      {startOverlapPrompt && typeof document !== "undefined"
        ? createPortal(
            <div className="app-theme-scope fixed inset-0 z-[1000] flex items-center justify-center bg-black/45 px-3">
              <div className="w-full max-w-lg rounded-lg border border-[var(--app-border)] bg-[var(--app-panel-bg)] text-[var(--app-text)] p-4 space-y-3 shadow-2xl">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <div className="text-base font-semibold">Overlap Data Detected</div>
                    <div className="text-xs text-[var(--app-muted)]">
                      Case start will stay at {toTimeInput(startOverlapPrompt.startTime)}.
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={closeStartOverlapPrompt}
                    disabled={startOverlapBusy}
                    className="rounded border border-[var(--app-border)] px-2 py-1 text-xs"
                  >
                    Close
                  </button>
                </div>

                <div className="rounded border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm text-[var(--app-text)]">
                  There is overlapping vital sign / agent data with the previous case from{" "}
                  <span className="font-semibold">
                    {formatOverlapWindow(
                      startOverlapPrompt.overlap.overlap_start_time,
                      startOverlapPrompt.overlap.overlap_end_time,
                    )}
                  </span>
                  .
                </div>

                <div className="space-y-1 text-sm text-[var(--app-muted)]">
                  <div>
                    Previous case HN:{" "}
                    <span className="font-medium text-[var(--app-text)]">
                      {startOverlapPrompt.overlap.previous_case_hn || "-"}
                    </span>
                  </div>
                  <div>
                    Overlap minutes already used in previous case:{" "}
                    <span className="font-medium text-[var(--app-text)]">
                      {startOverlapPrompt.overlap.overlap_minute_count}
                    </span>
                  </div>
                  <div>Choose whether those automatic data minutes should be included in the new case.</div>
                </div>

                <div className="flex flex-wrap justify-end gap-2 pt-1">
                  <button
                    type="button"
                    onClick={closeStartOverlapPrompt}
                    disabled={startOverlapBusy}
                    className="rounded border border-[var(--app-border)] px-3 py-1.5 text-sm text-[var(--app-text)]"
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      void onResolveStartOverlap("include");
                    }}
                    disabled={startOverlapBusy}
                    className="rounded border border-[var(--app-border)] px-3 py-1.5 text-sm text-[var(--app-text)] hover:bg-[var(--app-button-neutral-hover)] disabled:opacity-60"
                  >
                    Include Overlap
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      void onResolveStartOverlap("exclude");
                    }}
                    disabled={startOverlapBusy}
                    className="rounded bg-blue-600 px-3 py-1.5 text-sm text-white hover:bg-blue-700 disabled:opacity-60"
                  >
                    {startOverlapBusy ? "Starting..." : "Exclude Overlap"}
                  </button>
                </div>
              </div>
            </div>,
            document.body,
          )
        : null}

      {isAllergyModalOpen && typeof document !== "undefined"
        ? createPortal(
            <div className="app-theme-scope fixed inset-0 z-[1000] flex items-center justify-center bg-black/35 px-3">
              <div className="w-full max-w-md rounded-lg border border-[var(--app-border)] bg-[var(--app-panel-bg)] text-[var(--app-text)] p-3 space-y-2 shadow-2xl">
                <div className="flex items-center justify-between">
                  <div className="text-sm font-semibold">
                    {editingAllergyId != null ? "Edit" : "Add"}
                  </div>
                  <button
                    type="button"
                    onClick={closeAllergyModal}
                    disabled={allergyModalBusy}
                    className="rounded border border-[var(--app-border)] px-2 py-1 text-xs"
                  >
                    Close
                  </button>
                </div>

                <label className="block space-y-1">
                  <div className="text-xs text-[var(--app-muted)]">Allergen</div>
                  <input
                    className="w-full rounded border border-[var(--app-border)] bg-[var(--app-control-bg)] px-2 py-1.5 text-xs text-[var(--app-control-text)] placeholder:text-[var(--app-control-muted)]"
                    value={allergyModalAllergen}
                    onChange={e => setAllergyModalAllergen(e.target.value)}
                    placeholder="e.g. Latex"
                    autoComplete="off"
                    list="left-rail-allergen-options"
                  />
                  <datalist id="left-rail-allergen-options">
                    {allergyAutocompleteOptions.map(item => (
                      <option key={item} value={item} />
                    ))}
                  </datalist>
                </label>

                <label className="block space-y-1">
                  <div className="text-xs text-[var(--app-muted)]">Reaction</div>
                  <input
                    className="w-full rounded border border-[var(--app-border)] bg-[var(--app-control-bg)] px-2 py-1.5 text-xs text-[var(--app-control-text)] placeholder:text-[var(--app-control-muted)]"
                    value={allergyModalReaction}
                    onChange={e => setAllergyModalReaction(e.target.value)}
                    placeholder="e.g. rash"
                  />
                </label>

                <label className="block space-y-1">
                  <div className="text-xs text-[var(--app-muted)]">Severity</div>
                  <input
                    className="w-full rounded border border-[var(--app-border)] bg-[var(--app-control-bg)] px-2 py-1.5 text-xs text-[var(--app-control-text)] placeholder:text-[var(--app-control-muted)]"
                    value={allergyModalSeverity}
                    onChange={e => setAllergyModalSeverity(e.target.value)}
                    placeholder="e.g. severe"
                    list="left-rail-severity-options"
                  />
                  <datalist id="left-rail-severity-options">
                    {ALLERGY_SEVERITY_SUGGESTIONS.map(item => (
                      <option key={item} value={item} />
                    ))}
                  </datalist>
                </label>

                {allergyModalError ? (
                  <div className="text-xs text-red-600 dark:text-red-400">{allergyModalError}</div>
                ) : null}

                <div className="flex justify-end gap-2 pt-1">
                  <button
                    type="button"
                    onClick={closeAllergyModal}
                    disabled={allergyModalBusy}
                    className="rounded border border-[var(--app-border)] px-3 py-1 text-xs"
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      void onSaveAllergyModal();
                    }}
                    disabled={allergyModalBusy || !allergyModalAllergen.trim()}
                    className="rounded bg-blue-600 px-3 py-1 text-xs text-white hover:bg-blue-700 disabled:opacity-60"
                  >
                    {allergyModalBusy ? "Saving..." : editingAllergyId != null ? "Save" : "Add"}
                  </button>
                </div>
              </div>
            </div>,
            document.body,
          )
        : null}

      <ConfirmDialog
        open={pendingDeleteAllergyId != null}
        title="Remove Allergy?"
        message="This allergy record will be removed from this case."
        confirmLabel="Remove"
        busy={allergyDeleteBusy}
        onCancel={() => setPendingDeleteAllergyId(null)}
        onConfirm={onConfirmDeleteAllergy}
      />

      <ConfirmDialog
        open={pendingCaseAction != null}
        title={
          pendingCaseAction === "archive"
            ? "Archive?"
            : "Discharge?"
        }
        message={
          pendingCaseAction === "archive"
            ? "This case will be archived and is final."
            : "This will stop live charting for this case."
        }
        confirmLabel={pendingCaseAction === "archive" ? "Archive" : "Discharge"}
        busy={caseActionBusy}
        onCancel={() => {
          setPendingCaseAction(null);
          setCaseActionNote("");
        }}
        onConfirm={onConfirmCaseAction}
      >
        {pendingCaseAction === "discharge" ? (
          <div className="space-y-2">
            {suggestedCaseEnd ? (
              <div className="flex flex-wrap items-center justify-between gap-2 rounded border border-amber-500/60 bg-amber-500/10 px-2 py-1.5 text-xs text-amber-200">
                <span>
                  Suggested end {formatDateTime(suggestedCaseEnd.suggested_end_time)}
                </span>
                <button
                  type="button"
                  className="rounded border border-amber-400/70 bg-amber-400/10 px-2 py-1 text-[11px] font-medium text-amber-100 disabled:opacity-50"
                  disabled={caseActionBusy}
                  onClick={() => {
                    setPendingDischargeDate(toDateInput(suggestedCaseEnd.suggested_end_time));
                    setPendingDischargeTime(toTimeInput(suggestedCaseEnd.suggested_end_time));
                    setCaseActionNote("");
                  }}
                >
                  Use Suggested Time
                </button>
              </div>
            ) : null}
            <div className="flex gap-2">
              <input
                type="date"
                className="flex-1 rounded border border-[var(--app-border)] bg-[var(--app-control-bg)] px-2 py-1.5 text-sm text-[var(--app-control-text)]"
                value={pendingDischargeDate}
                onChange={e => {
                  setPendingDischargeDate(e.target.value);
                  setCaseActionNote("");
                }}
                disabled={caseActionBusy}
              />
              <input
                type="text"
                inputMode="numeric"
                autoComplete="off"
                className="w-24 rounded border border-[var(--app-border)] bg-[var(--app-control-bg)] px-2 py-1.5 text-sm text-[var(--app-control-text)]"
                value={pendingDischargeTime}
                onChange={e => {
                  setPendingDischargeTime(e.target.value);
                  setCaseActionNote("");
                }}
                onBlur={e => {
                  const normalized = normalizeTimeInputHHMM(e.target.value);
                  if (normalized) setPendingDischargeTime(normalized);
                }}
                placeholder="HH:mm"
                disabled={caseActionBusy}
              />
            </div>
            {caseActionNote ? (
              <div className="text-xs text-red-600 dark:text-red-400">{caseActionNote}</div>
            ) : null}
          </div>
        ) : caseActionNote ? (
          <div className="text-xs text-red-600 dark:text-red-400">{caseActionNote}</div>
        ) : null}
      </ConfirmDialog>
    </div>
  );
}
