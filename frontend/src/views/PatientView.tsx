import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CaseStatus } from "../api/caseApi";
import type { LabSummary } from "./LabView";

const LabView = lazy(() => import("./LabView"));
import ConfirmDialog from "../components/common/ConfirmDialog";
import {
  getCaseDetailDraft,
  patchCaseDetailDraft,
} from "../api/caseDetailApi";
import {
  createCaseAllergy,
  deleteCaseAllergy,
  fetchHisAllergyByHn,
  getCaseAllergies,
  getCasePatientInfo,
  lookupPatientInfoByHn,
  syncCaseHisAllergy,
  syncCasePatientInfo,
  updateCasePatientInfo,
  updateCaseAllergy,
  type CaseAllergyRow,
  type CasePatientInfo,
} from "../api/caseHisApi";
import {
  formatDateInputDDMMYYYY,
  normalizeDateInputDDMMYYYY,
} from "../utils/clinicalInput";

type Props = {
  caseStatus: CaseStatus;
};

type PatientFormState = {
  hn: string;
  an: string;
  idType: string;
  idCard: string;
  titleTh: string;
  titleEn: string;
  firstName: string;
  lastName: string;
  firstNameEn: string;
  lastNameEn: string;
  sex: string;
  dob: string;
  ageY: string;
  ageM: string;
  weightKg: string;
  heightCm: string;
  bloodGroupABO: string;
  bloodGroupRh: string;
  race: string;
  ethnicity: string;
  religion: string;
  maritalStatus: string;
  nationality: string;
  preferredLanguage: string;
  mobile: string;
  email: string;
  presentAddress: string;
  presentProvince: string;
  legalAddress: string;
  legalProvince: string;
  contactName: string;
  contactRelation: string;
  contactTel: string;
  contactInstructions: string;
};

const card =
  "rounded-xl border border-[var(--app-border)] bg-[var(--app-panel-bg)] p-4 space-y-4 shadow-sm";
const input =
  "w-full min-h-10 rounded-lg border border-[var(--app-control-border)] bg-[var(--app-control-bg)] px-3 py-2 text-sm text-[var(--app-text)] disabled:cursor-not-allowed disabled:opacity-60";
const label = "text-[10px] font-bold uppercase tracking-[0.12em] text-[var(--app-muted)]";
const primaryButton =
  "min-h-9 rounded-lg bg-[var(--app-accent)] px-3 py-1.5 text-xs font-bold text-[var(--app-accent-contrast)] hover:brightness-105 disabled:cursor-not-allowed disabled:opacity-50";
const secondaryButton =
  "min-h-9 rounded-lg border border-[var(--app-border)] bg-[var(--app-control-bg)] px-3 py-1.5 text-xs font-semibold text-[var(--app-text)] hover:bg-[var(--app-control-bg-hover)] disabled:cursor-not-allowed disabled:opacity-50";
const TITLE_TH_OPTIONS = ["", "นาย", "นาง", "น.ส.", "ด.ช.", "ด.ญ."];
const TITLE_EN_OPTIONS = ["", "Mr.", "Mrs.", "Ms.", "Miss", "Master"];
const IDENTIFIER_TYPE_OPTIONS = [
  { value: "", label: "Select or enter ID to detect" },
  { value: "National ID", label: "Thai national ID" },
  { value: "Passport", label: "Passport" },
  { value: "Other government ID", label: "Other government ID" },
  { value: "Unknown", label: "Unknown / not provided" },
];
const ALLERGY_SEVERITY_OPTIONS = ["Mild", "Moderate", "Severe", "Fatal", "Unknown", "None"];
const PRESTART_PATIENT_DRAFT_PREFIX = "flora.prestartPatientDraft.";
const PRESTART_HN_SYNC_EVENT = "flora:prestart-hn-sync";

function isNoKnownAllergy(row: CaseAllergyRow) {
  const value = String(row.allergen || "").trim().toUpperCase().replace(/[^A-Z]/g, "");
  return value === "NKA" || value === "NKDA" || value === "NOKNOWNALLERGY" || value === "NOKNOWNDRUGALLERGY";
}

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function numText(value: unknown): string {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "string") {
    const raw = value.trim();
    if (!raw) return "";
    const n = Number(raw);
    if (Number.isFinite(n)) return String(n);
  }
  return "";
}

function prettyJson(value: unknown): string {
  if (value == null) return "";
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function fmt(ts: number): string {
  const d = new Date(ts);
  const dd = String(d.getDate()).padStart(2, "0");
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const yyyy = d.getFullYear();
  const hh = String(d.getHours()).padStart(2, "0");
  const min = String(d.getMinutes()).padStart(2, "0");
  return `${dd}/${mm}/${yyyy} ${hh}:${min}`;
}

function defaults(hn: string): PatientFormState {
  return {
    hn,
    an: "",
    idType: "",
    idCard: "",
    titleTh: "",
    titleEn: "",
    firstName: "",
    lastName: "",
    firstNameEn: "",
    lastNameEn: "",
    sex: "",
    dob: "",
    ageY: "",
    ageM: "",
    weightKg: "",
    heightCm: "",
    bloodGroupABO: "",
    bloodGroupRh: "",
    race: "",
    ethnicity: "",
    religion: "",
    maritalStatus: "",
    nationality: "",
    preferredLanguage: "",
    mobile: "",
    email: "",
    presentAddress: "",
    presentProvince: "",
    legalAddress: "",
    legalProvince: "",
    contactName: "",
    contactRelation: "",
    contactTel: "",
    contactInstructions: "",
  };
}

function parseDob(value: string): Date | null {
  const normalized = normalizeDateInputDDMMYYYY(value);
  if (!normalized) return null;
  const [dd, mm, yyyy] = normalized.split("/").map(Number);
  const dt = new Date(yyyy, mm - 1, dd);
  if (Number.isNaN(dt.getTime())) return null;
  return dt;
}

function ageFromDob(dob: Date): { years: number; months: number } | null {
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

function formatDob(date: Date): string {
  const dd = String(date.getDate()).padStart(2, "0");
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const yyyy = date.getFullYear();
  return `${dd}/${mm}/${yyyy}`;
}

function normalizeAgeText(raw: string, maxDigits: number): string {
  return raw.replace(/\D+/g, "").slice(0, maxDigits);
}

function normalizeAgeMonthText(raw: string): string {
  const value = normalizeAgeText(raw, 2);
  if (!value) return "";
  return String(Math.min(11, Number(value)));
}

function detectIdentifierType(raw: string): "National ID" | "Passport" | "" {
  const value = raw.trim().replace(/[\s-]+/g, "");
  if (/^\d{13}$/.test(value)) return "National ID";
  if (/^(?=.*[A-Za-z])[A-Za-z0-9]{6,12}$/.test(value)) return "Passport";
  return "";
}

function normalizeIdentifierType(raw: string, identifier = ""): string {
  const value = raw.trim().toLowerCase().replace(/[\s_-]+/g, "");
  if (["1", "cid", "nid", "nationalid", "thaiid", "บัตรประชาชน"].includes(value)) return "National ID";
  if (["2", "passport", "pp", "หนังสือเดินทาง"].includes(value)) return "Passport";
  if (["other", "othergovernmentid", "governmentid"].includes(value)) return "Other government ID";
  if (["unknown", "na", "none"].includes(value)) return "Unknown";
  return detectIdentifierType(identifier) || (raw.trim() ? "Other government ID" : "");
}

function isValidThaiNationalId(raw: string): boolean {
  const digits = raw.replace(/\D+/g, "");
  if (digits.length !== 13) return false;
  const sum = digits
    .slice(0, 12)
    .split("")
    .reduce((total, digit, index) => total + Number(digit) * (13 - index), 0);
  return (11 - (sum % 11)) % 10 === Number(digits[12]);
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

function looksThai(textValue: string): boolean {
  return /[\u0E00-\u0E7F]/.test(textValue);
}

function normalizeSex(raw: string): string {
  const value = raw.trim().toUpperCase();
  if (!value) return "";
  if (value === "M" || value === "MALE" || value === "ชาย") return "M";
  if (value === "F" || value === "FEMALE" || value === "หญิง") return "F";
  return raw.trim();
}

function parseBloodText(raw: string): { abo: string; rh: string } {
  const value = raw.trim().toUpperCase();
  if (!value) return { abo: "", rh: "" };
  const aboMatch = value.match(/(AB|A|B|O)/);
  const rh =
    value.includes("RH+") || /\+/.test(value)
      ? "+"
      : value.includes("RH-") || /-/.test(value)
        ? "-"
        : "";
  return { abo: aboMatch ? aboMatch[1] : "", rh };
}

function readDraft(caseId: number): Record<string, unknown> {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(`doctor_form_${caseId}`);
    if (!raw) return {};
    return asObject(JSON.parse(raw) as unknown);
  } catch {
    return {};
  }
}

function readPrestartPatientDraft(hn: string): Record<string, unknown> {
  if (typeof window === "undefined") return {};
  const targetHn = String(hn || "").trim();
  if (!targetHn) return {};
  try {
    const raw = window.localStorage.getItem(`${PRESTART_PATIENT_DRAFT_PREFIX}${targetHn}`);
    if (!raw) return {};
    return asObject(JSON.parse(raw) as unknown);
  } catch {
    return {};
  }
}

function writePrestartPatientDraft(hn: string, patch: Record<string, unknown>) {
  if (typeof window === "undefined") return;
  const targetHn = String(hn || "").trim();
  if (!targetHn) return;
  try {
    const key = `${PRESTART_PATIENT_DRAFT_PREFIX}${targetHn}`;
    const prev = readPrestartPatientDraft(targetHn);
    const next = { ...prev, ...patch, hn: targetHn };
    window.localStorage.setItem(key, JSON.stringify(next));
  } catch {
    // Ignore write failure in restricted environment.
  }
}

function writeDraft(caseId: number, patch: Record<string, unknown>) {
  if (typeof window === "undefined") return;
  try {
    const key = `doctor_form_${caseId}`;
    const prev = readDraft(caseId);
    const next = { ...prev, ...patch };
    window.localStorage.setItem(key, JSON.stringify(next));
  } catch {
    // Ignore write failure in restricted environment.
  }
}

function buildFormFromDraft(hn: string, draft: Record<string, unknown>): PatientFormState {
  return {
    ...defaults(hn),
    hn,
    an: text(draft.an),
    idType: normalizeIdentifierType(text(draft.idType || draft.notype), text(draft.idCard || draft.id_card)),
    idCard: text(draft.idCard || draft.id_card),
    titleTh: text(draft.titleTh || draft.title_th),
    titleEn: text(draft.titleEn || draft.title_en),
    firstName: text(draft.firstName || draft.first_name),
    lastName: text(draft.lastName || draft.last_name),
    firstNameEn: text(draft.firstNameEn || draft.first_name_en),
    lastNameEn: text(draft.lastNameEn || draft.last_name_en),
    sex: normalizeSex(text(draft.sex)),
    dob: formatDateInputDDMMYYYY(text(draft.dob)),
    ageY: text(draft.ageY),
    ageM: text(draft.ageM),
    weightKg: numText(draft.weightKg),
    heightCm: numText(draft.heightCm),
    bloodGroupABO: text(draft.bloodGroupABO),
    bloodGroupRh: text(draft.bloodGroupRh),
    race: text(draft.race),
    ethnicity: text(draft.ethnicity),
    religion: text(draft.religion),
    maritalStatus: text(draft.maritalStatus),
    nationality: text(draft.nationality),
    preferredLanguage: text(draft.preferredLanguage || draft.language),
    mobile: text(draft.mobile),
    email: text(draft.email),
    presentAddress: text(draft.presentAddress || draft.present_address),
    presentProvince: text(draft.presentProvince || draft.present_province),
    legalAddress: text(draft.legalAddress || draft.legal_address),
    legalProvince: text(draft.legalProvince || draft.legal_province),
    contactName: text(draft.contactName || draft.contact_name),
    contactRelation: text(draft.contactRelation || draft.relation_desc),
    contactTel: text(draft.contactTel || draft.contact_tel),
    contactInstructions: text(draft.contactInstructions),
  };
}

function applyHisToForm(prev: PatientFormState, info: CasePatientInfo): PatientFormState {
  const thFirst = (info.first_name || "").trim();
  const thLast = (info.last_name || "").trim();
  const enFirst = (info.first_name_en || "").trim();
  const enLast = (info.last_name_en || "").trim();
  const bloodFromText = parseBloodText(info.blood_group_text || "");
  const nameParts = (info.patient_name || "")
    .trim()
    .split(/\s+/)
    .filter(Boolean);

  const resolvedFirstName =
    thFirst && looksThai(thFirst)
      ? thFirst
      : enFirst && looksThai(enFirst)
        ? enFirst
        : thFirst || enFirst || nameParts[0] || prev.firstName;
  const resolvedLastName =
    thLast && looksThai(thLast)
      ? thLast
      : enLast && looksThai(enLast)
        ? enLast
        : thLast || enLast || nameParts.slice(1).join(" ") || prev.lastName;

  return {
    ...prev,
    hn: info.hn || prev.hn,
    an: info.an || "",
    idType: normalizeIdentifierType(info.notype || "", info.id_card || ""),
    idCard: info.id_card || "",
    titleTh: info.title_th || prev.titleTh,
    titleEn: info.title_en || prev.titleEn,
    firstName: resolvedFirstName,
    lastName: resolvedLastName,
    firstNameEn: enFirst || (looksThai(thFirst) ? prev.firstNameEn : thFirst),
    lastNameEn: enLast || (looksThai(thLast) ? prev.lastNameEn : thLast),
    sex: normalizeSex(info.sex || ""),
    dob: formatDateInputDDMMYYYY(info.dob || ""),
    weightKg: numText(info.weight_kg),
    heightCm: numText(info.height_cm),
    bloodGroupABO: (info.blood_group_abo || bloodFromText.abo || "").toUpperCase(),
    bloodGroupRh: (info.blood_group_rh || bloodFromText.rh || "").toUpperCase(),
    race: info.race || "",
    ethnicity: info.ethnicity || "",
    religion: info.religion || "",
    maritalStatus: info.marital_status || "",
    nationality: info.nationality || "",
    preferredLanguage: prev.preferredLanguage,
    mobile: info.mobile || "",
    email: prev.email,
    presentAddress: info.present_address || "",
    presentProvince: info.present_province || "",
    legalAddress: info.legal_address || "",
    legalProvince: info.legal_province || "",
    contactName: info.contact_name || "",
    contactRelation: info.relation_desc || "",
    contactTel: info.contact_tel || "",
    contactInstructions: prev.contactInstructions,
  };
}

export default function PatientView({ caseStatus }: Props) {
  const activeCase = caseStatus.status === "IDLE" ? null : caseStatus;
  const caseId = activeCase?.case_id ?? null;
  const hasActiveCase = activeCase != null && caseId != null;
  const isReadOnly = caseStatus.status === "ARCHIVED";
  const [form, setForm] = useState<PatientFormState>(defaults(""));

  const [allergies, setAllergies] = useState<CaseAllergyRow[]>([]);
  const [labSummary, setLabSummary] = useState<LabSummary>({ total: 0, abnormal: 0, critical: 0, loaded: false });
  const [editingAllergyId, setEditingAllergyId] = useState<number | string | null>(null);
  const [newAllergen, setNewAllergen] = useState("");
  const [newReaction, setNewReaction] = useState("");
  const [newSeverity, setNewSeverity] = useState("");
  const [pendingDeleteAllergyId, setPendingDeleteAllergyId] = useState<number | string | null>(null);
  const [alertTitle, setAlertTitle] = useState("");
  const [alertMessage, setAlertMessage] = useState("");
  const knownAllergies = useMemo(() => allergies.filter(row => !isNoKnownAllergy(row)), [allergies]);
  const noKnownAllergyRows = useMemo(() => allergies.filter(isNoKnownAllergy), [allergies]);
  const allergyReviewState = knownAllergies.length > 0 ? "allergic" : noKnownAllergyRows.length > 0 ? "none" : "unknown";
  const handleLabSummary = useCallback((next: LabSummary) => {
    setLabSummary(prev => prev.total === next.total && prev.abnormal === next.abnormal && prev.critical === next.critical && prev.loaded === next.loaded ? prev : next);
  }, []);

  const loadAllergies = async () => {
    if (!caseId) return;
    try {
      const rows = await getCaseAllergies(caseId);
      setAllergies(rows);
    } catch (err) {
      setAlertTitle("Load Failed");
      setAlertMessage(err instanceof Error ? err.message : "failed to load allergies");
    }
  };

  const handleSaveAllergy = async () => {
    if (!newAllergen.trim() || !caseId || isReadOnly) return;
    try {
      if (editingAllergyId) {
        await updateCaseAllergy(caseId, editingAllergyId, {
          allergen: newAllergen,
          reaction: newReaction,
          severity: newSeverity,
        });
      } else {
        await Promise.all(noKnownAllergyRows.map(row => deleteCaseAllergy(caseId, row.id)));
        await createCaseAllergy(caseId, {
          allergen: newAllergen,
          reaction: newReaction,
          severity: newSeverity,
        });
      }
      setNewAllergen("");
      setNewReaction("");
      setNewSeverity("");
      setEditingAllergyId(null);
      await loadAllergies();
      emitAllergyChanged();
    } catch (err) {
      setAlertTitle("Save Failed");
      setAlertMessage(err instanceof Error ? err.message : "failed to save allergy");
    }
  };

  const markNoKnownAllergies = async () => {
    if (!caseId || isReadOnly || knownAllergies.length > 0 || noKnownAllergyRows.length > 0) return;
    setLoadingSupport(true);
    try {
      await createCaseAllergy(caseId, { allergen: "NKA", reaction: "", severity: "None", status: "Active" });
      await loadAllergies();
      emitAllergyChanged();
    } catch (err) {
      setAlertTitle("Update Failed");
      setAlertMessage(err instanceof Error ? err.message : "Allergy review status could not be saved");
    } finally {
      setLoadingSupport(false);
    }
  };

  const markAllergiesNotReviewed = async () => {
    if (!caseId || isReadOnly || knownAllergies.length > 0) return;
    setLoadingSupport(true);
    try {
      await Promise.all(noKnownAllergyRows.map(row => deleteCaseAllergy(caseId, row.id)));
      await loadAllergies();
      emitAllergyChanged();
    } catch (err) {
      setAlertTitle("Update Failed");
      setAlertMessage(err instanceof Error ? err.message : "Allergy review status could not be saved");
    } finally {
      setLoadingSupport(false);
    }
  };

  const handleEditAllergy = (allergy: CaseAllergyRow) => {
    setEditingAllergyId(allergy.id);
    setNewAllergen(allergy.allergen);
    setNewReaction(allergy.reaction || "");
    setNewSeverity(allergy.severity || "");
  };

  const confirmDeleteAllergy = async () => {
    if (!pendingDeleteAllergyId || !caseId || isReadOnly) return;
    try {
      await deleteCaseAllergy(caseId, pendingDeleteAllergyId);
      setPendingDeleteAllergyId(null);
      await loadAllergies();
      emitAllergyChanged();
    } catch (err) {
      setAlertTitle("Delete Failed");
      setAlertMessage(err instanceof Error ? err.message : "failed to delete allergy");
    }
  };
  const [loadingHis, setLoadingHis] = useState(false);
  const [loadingSupport, setLoadingSupport] = useState(false);
  const [error, setError] = useState("");
  const [saveNote, setSaveNote] = useState("");
  const [isSaving, setIsSaving] = useState(false);
  const [patientTab, setPatientTab] = useState<"info" | "contact" | "allergy" | "lab">("info");
  const [dataSource, setDataSource] = useState<"HIS" | "BUFFER" | null>(null);
  const [notification, setNotification] = useState<{ type: "success" | "warning" | "error"; text: string } | null>(null);
  const [hisRawPayloadText, setHisRawPayloadText] = useState("");
  const [showHisRawPayload, setShowHisRawPayload] = useState(false);
  const autoSaveReadyRef = useRef(false);
  const lastSyncedFormRef = useRef("");
  const hnInputRef = useRef<HTMLInputElement>(null);

  const emitAllergyChanged = () => {
    if (!caseId) return;
    window.dispatchEvent(
      new CustomEvent("flora:allergy-changed", {
        detail: { caseId },
      }),
    );
  };

  useEffect(() => {
    if (!activeCase || caseId == null) {
      autoSaveReadyRef.current = false;
      setForm(prev => {
        const draft = readPrestartPatientDraft(prev.hn);
        const targetHn = String(prev.hn || "").trim();
        return targetHn && Object.keys(draft).length > 0
          ? buildFormFromDraft(targetHn, draft)
          : defaults("");
      });
      setAllergies([]);
      setDataSource(null);
      setHisRawPayloadText("");
      setShowHisRawPayload(false);
      return;
    }
    autoSaveReadyRef.current = false;
    const draft = readDraft(caseId);
    const next = buildFormFromDraft(activeCase.hn, draft);
    lastSyncedFormRef.current = JSON.stringify(next);
    setForm(next);
  }, [activeCase, caseId]);

  useEffect(() => {
    if (hasActiveCase) return;
    const onPrestartHnSync = (event: Event) => {
      const custom = event as CustomEvent<{ hn?: unknown; source?: unknown }>;
      if (String(custom.detail?.source || "") === "patient-view") return;
      const nextHn = String(custom.detail?.hn || "").trim();
      setForm(prev => {
        if (nextHn === String(prev.hn || "").trim()) return prev;
        if (!nextHn) return { ...prev, hn: "" };
        const draft = readPrestartPatientDraft(nextHn);
        return Object.keys(draft).length > 0
          ? buildFormFromDraft(nextHn, draft)
          : { ...prev, hn: nextHn };
      });
    };
    window.addEventListener(PRESTART_HN_SYNC_EVENT, onPrestartHnSync);
    return () => window.removeEventListener(PRESTART_HN_SYNC_EVENT, onPrestartHnSync);
  }, [hasActiveCase]);

  useEffect(() => {
    let alive = true;
    async function loadDraftFromBackend() {
      if (!activeCase || caseId == null) return;
      try {
        const backendDraft = await getCaseDetailDraft(caseId);
        if (!alive) return;
        if (backendDraft) {
          writeDraft(caseId, backendDraft);
          const next = buildFormFromDraft(activeCase.hn, backendDraft);
          lastSyncedFormRef.current = JSON.stringify(next);
          setForm(next);
        }
        autoSaveReadyRef.current = true;
      } catch {
        // still enable auto-save so user edits are not silently dropped
        autoSaveReadyRef.current = true;
      }
    }
    void loadDraftFromBackend();
    return () => {
      alive = false;
    };
  }, [activeCase, caseId]);

  useEffect(() => {
    if (!activeCase || caseId == null) return;
    const onDraftChanged = (event: Event) => {
      const custom = event as CustomEvent<{ caseId?: unknown; source?: unknown }>;
      const changedCaseId = Number(custom.detail?.caseId);
      const source = String(custom.detail?.source || "");
      if (!Number.isFinite(changedCaseId) || changedCaseId !== caseId) return;
      if (source === "patient") return;
      const draft = readDraft(caseId);
      const next = buildFormFromDraft(activeCase.hn, draft);
      lastSyncedFormRef.current = JSON.stringify(next);
      setForm(next);
      setSaveNote("Updated from Form");
    };
    window.addEventListener("flora:form-storage-changed", onDraftChanged);
    return () => window.removeEventListener("flora:form-storage-changed", onDraftChanged);
  }, [activeCase, caseId]);

  // Focus HN input on mount (or when case clears, so user can type HN immediately)
  useEffect(() => {
    if (!hasActiveCase) {
      const t = setTimeout(() => hnInputRef.current?.focus(), 80);
      return () => clearTimeout(t);
    }
  }, [hasActiveCase]);

  // Auto-save: debounced 1.5s after any form change, once initial load is done
  useEffect(() => {
    if (!autoSaveReadyRef.current || !hasActiveCase || isReadOnly) return;
    const signature = JSON.stringify(form);
    if (signature === lastSyncedFormRef.current) return;
    const timer = setTimeout(() => {
      if (!autoSaveReadyRef.current || !hasActiveCase || isReadOnly) return;
      lastSyncedFormRef.current = signature;
      setIsSaving(true);
      void save().finally(() => setIsSaving(false));
    }, 1500);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form, isReadOnly]);

  useEffect(() => {
    if (hasActiveCase) return;
    const targetHn = String(form.hn || "").trim();
    if (!targetHn) return;
    const timer = setTimeout(() => {
      const normalizedDob = normalizeDateInputDDMMYYYY(form.dob) || "";
      const patch: Record<string, unknown> = {
        hn: targetHn,
        an: form.an.trim(),
        idType: form.idType.trim(),
        idCard: form.idCard.trim(),
        titleTh: form.titleTh.trim(),
        titleEn: form.titleEn.trim(),
        firstName: form.firstName.trim(),
        lastName: form.lastName.trim(),
        firstNameEn: form.firstNameEn.trim(),
        lastNameEn: form.lastNameEn.trim(),
        sex: normalizeSex(form.sex),
        dob: normalizedDob,
        ageY: normalizeAgeText(form.ageY, 3),
        ageM: normalizeAgeMonthText(form.ageM),
        weightKg: form.weightKg.trim(),
        heightCm: form.heightCm.trim(),
        bloodGroupABO: form.bloodGroupABO.trim(),
        bloodGroupRh: form.bloodGroupRh.trim(),
        race: form.race.trim(),
        ethnicity: form.ethnicity.trim(),
        religion: form.religion.trim(),
        maritalStatus: form.maritalStatus.trim(),
        nationality: form.nationality.trim(),
        preferredLanguage: form.preferredLanguage.trim(),
        mobile: form.mobile.trim(),
        email: form.email.trim(),
        presentAddress: form.presentAddress.trim(),
        presentProvince: form.presentProvince.trim(),
        legalAddress: form.legalAddress.trim(),
        legalProvince: form.legalProvince.trim(),
        contactName: form.contactName.trim(),
        contactRelation: form.contactRelation.trim(),
        contactTel: form.contactTel.trim(),
        contactInstructions: form.contactInstructions.trim(),
      };
      writePrestartPatientDraft(targetHn, patch);
      setSaveNote(`Saved pre-start patient draft ${fmt(Date.now())}`);
    }, 700);
    return () => clearTimeout(timer);
  }, [form, hasActiveCase]);

  useEffect(() => {
    if (hasActiveCase) return;
    window.dispatchEvent(
      new CustomEvent(PRESTART_HN_SYNC_EVENT, {
        detail: { hn: String(form.hn || ""), source: "patient-view" },
      }),
    );
  }, [form.hn, hasActiveCase]);

  const loadSupportData = useCallback(async () => {
    if (!caseId || !activeCase) return;
    setLoadingSupport(true);
    setError("");
    try {
      const rows = await getCaseAllergies(caseId);
      setAllergies(rows);
    } catch {
      setError("Some HIS data could not be loaded.");
    } finally {
      setLoadingSupport(false);
    }
  }, [activeCase, caseId]);

  const applyLookupResult = useCallback((lookup: {
    row: CasePatientInfo | null;
    allergies: CaseAllergyRow[];
    his_payload?: unknown;
    his_errors?: Record<string, string>;
    source?: "HIS" | "BUFFER" | "DEMO_HIS";
    offline?: boolean;
  }) => {
    if (!lookup.row) {
      setNotification({ type: "warning", text: "HIS returned no patient data for this HN. Check HN and try again." });
      return false;
    }

    setAllergies(lookup.allergies);
    const rawPayloadText = prettyJson(lookup.his_payload ?? lookup.row.his_payload ?? null);
    setHisRawPayloadText(rawPayloadText);
    setShowHisRawPayload(Boolean(rawPayloadText));
    let resolvedName = "";
    setForm(prev => {
      const next = applyHisToForm(prev, lookup.row as CasePatientInfo);
      const parsed = parseDob(next.dob);
      const age = parsed ? ageFromDob(parsed) : null;
      const finalNext = {
        ...next,
        ageY: age ? String(age.years) : "",
        ageM: age ? String(age.months) : "",
      };
      resolvedName = [next.firstName, next.lastName].filter(Boolean).join(" ");
      return finalNext;
    });

    const suffix =
      lookup.his_errors && Object.keys(lookup.his_errors).length > 0
        ? ` (${Object.keys(lookup.his_errors).join(", ")})`
        : "";
    setSaveNote(`Loaded patient info from HIS${suffix}.`);
    setDataSource("HIS");
    setNotification({
      type: lookup.his_errors && Object.keys(lookup.his_errors).length > 0 ? "warning" : "success",
      text: `${resolvedName || "Patient"} patient info loaded from HIS${suffix}.`,
    });
    return true;
  }, []);

  useEffect(() => {
    void loadSupportData();
  }, [loadSupportData]);

  const applyHisFromCache = useCallback(async () => {
    if (!caseId) return false;
    const info = await getCasePatientInfo(caseId);
    if (!info) return false;
    const rawPayloadText = prettyJson(info.his_payload ?? null);
    setHisRawPayloadText(rawPayloadText);
    setShowHisRawPayload(Boolean(rawPayloadText));
    setForm(prev => {
      const next = applyHisToForm(prev, info);
      const parsed = parseDob(next.dob);
      const age = parsed ? ageFromDob(parsed) : null;
      return {
        ...next,
        ageY: age ? String(age.years) : "",
        ageM: age ? String(age.months) : "",
      };
    });
    return true;
  }, [caseId]);

  useEffect(() => {
    if (!caseId || !activeCase) return;
    const onHisSynced = (event: Event) => {
      const custom = event as CustomEvent<{ caseId?: unknown }>;
      const changedCaseId = Number(custom.detail?.caseId);
      if (!Number.isFinite(changedCaseId) || changedCaseId !== caseId) return;
      void (async () => {
        setLoadingSupport(true);
        try {
          const loaded = await applyHisFromCache();
          await loadSupportData();
          if (loaded) { setSaveNote("Loaded HIS data."); setDataSource("HIS"); }
        } catch (err) {
          setError(err instanceof Error ? err.message : "GetHIS failed");
        } finally {
          setLoadingSupport(false);
        }
      })();
    };
    window.addEventListener("flora:his-synced", onHisSynced);
    return () => window.removeEventListener("flora:his-synced", onHisSynced);
  }, [activeCase, applyHisFromCache, caseId, loadSupportData]);

  const getHis = useCallback(async (forcedHn?: string) => {
    if (!hasActiveCase) {
      const hn = String(forcedHn ?? form.hn).trim();
      if (!hn) {
        setError("Enter HN before GetHIS.");
        return;
      }
      setLoadingHis(true);
      setError("");
      try {
        const lookup = await lookupPatientInfoByHn(hn);
        applyLookupResult(lookup);
      } catch (err) {
        setError(err instanceof Error ? err.message : "GetHIS failed");
      } finally {
        setLoadingHis(false);
      }
      return;
    }
    if (!caseId || !activeCase) return;
    const targetHn = String(forcedHn ?? form.hn ?? activeCase.hn).trim();
    if (!targetHn) {
      setError("Enter HN before GetHIS.");
      return;
    }
    setLoadingHis(true);
    setError("");
    try {
      if (targetHn !== String(activeCase.hn || "").trim()) {
        await updateCasePatientInfo(caseId, { hn: targetHn });
        window.dispatchEvent(
          new CustomEvent("flora:case-hn-updated", {
            detail: { caseId, hn: targetHn },
          }),
        );
        setForm(prev => ({ ...prev, hn: targetHn }));
      }
      const sync = await syncCasePatientInfo(caseId);
      const loaded = await applyHisFromCache();
      if (!loaded) {
        setNotification({ type: "warning", text: "HIS returned no patient data for this HN. Check HN and try again." });
        setLoadingHis(false);
        return;
      }
      const hisErrors =
        sync.his_errors && Object.keys(sync.his_errors).length > 0
          ? ` (${Object.keys(sync.his_errors).join(", ")})`
          : "";
      setSaveNote(`Loaded patient info from HIS${hisErrors}.`);
      setDataSource("HIS");
      setNotification({ type: hisErrors ? "warning" : "success", text: `Patient info loaded from HIS${hisErrors}.` });
      await loadSupportData();
    } catch (err) {
      setNotification({ type: "error", text: err instanceof Error ? err.message : "GetHIS failed" });
    } finally {
      setLoadingHis(false);
    }
  }, [activeCase, applyHisFromCache, applyLookupResult, caseId, form.hn, hasActiveCase, loadSupportData]);

  const getAllergy = async (forcedHn?: string) => {
    const hn = String(forcedHn ?? (hasActiveCase && activeCase ? activeCase.hn : form.hn)).trim();
    if (!hn) {
      setError("Enter HN before Get Allergy.");
      return;
    }
    setLoadingHis(true);
    setError("");
    try {
      if (hasActiveCase && caseId) {
        await syncCaseHisAllergy(caseId, { allow_buffer_fallback: true });
        const fresh = await getCaseAllergies(caseId);
        setAllergies(fresh);
        emitAllergyChanged();
        if (fresh.length === 0) {
          setNotification({ type: "warning", text: "No allergy records found in HIS for this patient." });
        } else {
          setNotification({ type: "success", text: `${fresh.length} allergy record${fresh.length !== 1 ? "s" : ""} loaded from HIS.` });
        }
      } else {
        const result = await fetchHisAllergyByHn(hn, { allow_buffer_fallback: true });
        setAllergies(result.rows);
        const suffix =
          result.his_errors && Object.keys(result.his_errors).length > 0
            ? ` (partial: ${Object.keys(result.his_errors).join(", ")})`
            : "";
        const src = (result.source || "HIS").toLowerCase();
        if (result.rows.length === 0) {
          setNotification({ type: "warning", text: `No allergy records found in ${src}${suffix}.` });
        } else {
          setNotification({ type: "success", text: `${result.rows.length} allergy record${result.rows.length !== 1 ? "s" : ""} loaded from ${src}${suffix}.` });
        }
      }
    } catch (err) {
      setNotification({ type: "error", text: err instanceof Error ? err.message : "Get allergy failed" });
    } finally {
      setLoadingHis(false);
    }
  };

  useEffect(() => {
    const onRequested = (event: Event) => {
      const custom = event as CustomEvent<{ hn?: unknown }>;
      const hn = String(custom.detail?.hn || "").trim();
      if (!hn) return;
      setForm(prev => ({ ...prev, hn }));
      void getHis(hn);
    };
    window.addEventListener("flora:patient-gethis-request", onRequested);
    return () => window.removeEventListener("flora:patient-gethis-request", onRequested);
  }, [getHis]);

  const save = async () => {
    if (isReadOnly) {
      setError("Archived patient records are read-only.");
      return;
    }
    const finalHn = String(form.hn || "").trim();
    if (!finalHn) {
      setError("HN is required");
      return;
    }
    const normalizedDob = normalizeDateInputDDMMYYYY(form.dob);
    if (form.dob.trim() && !normalizedDob) {
      setError("DOB must use dd/mm/yyyy");
      return;
    }

    const ageYInput = normalizeAgeText(form.ageY, 3);
    const ageMInput = normalizeAgeMonthText(form.ageM);
    const parsed =
      normalizedDob != null
        ? parseDob(normalizedDob)
        : dobFromAge(ageYInput, ageMInput);
    const age = parsed ? ageFromDob(parsed) : null;
    const finalDob = parsed ? formatDob(parsed) : "";
    const finalAgeY = age ? String(age.years) : ageYInput;
    const finalAgeM = age ? String(age.months) : ageMInput;
    const patch: Record<string, unknown> = {
      hn: finalHn,
      an: form.an.trim(),
      idType: form.idType.trim(),
      idCard: form.idCard.trim(),
      titleTh: form.titleTh.trim(),
      titleEn: form.titleEn.trim(),
      firstName: form.firstName.trim(),
      lastName: form.lastName.trim(),
      firstNameEn: form.firstNameEn.trim(),
      lastNameEn: form.lastNameEn.trim(),
      sex: normalizeSex(form.sex),
      dob: finalDob,
      ageY: finalAgeY,
      ageM: finalAgeM,
      weightKg: form.weightKg.trim(),
      heightCm: form.heightCm.trim(),
      bloodGroupABO: form.bloodGroupABO.trim(),
      bloodGroupRh: form.bloodGroupRh.trim(),
      race: form.race.trim(),
      ethnicity: form.ethnicity.trim(),
      religion: form.religion.trim(),
      maritalStatus: form.maritalStatus.trim(),
      nationality: form.nationality.trim(),
      preferredLanguage: form.preferredLanguage.trim(),
      mobile: form.mobile.trim(),
      email: form.email.trim(),
      presentAddress: form.presentAddress.trim(),
      presentProvince: form.presentProvince.trim(),
      legalAddress: form.legalAddress.trim(),
      legalProvince: form.legalProvince.trim(),
      contactName: form.contactName.trim(),
      contactRelation: form.contactRelation.trim(),
      contactTel: form.contactTel.trim(),
      contactInstructions: form.contactInstructions.trim(),
    };

    if (!hasActiveCase || !caseId || !activeCase) {
      writePrestartPatientDraft(finalHn, patch);
      setForm(prev => ({
        ...prev,
        hn: finalHn,
        dob: finalDob,
        ageY: finalAgeY,
        ageM: finalAgeM,
      }));
      setError("");
      setSaveNote(`Saved for case start ${fmt(Date.now())}`);
      return;
    }

    await updateCasePatientInfo(caseId, {
      hn: finalHn,
      an: form.an.trim(),
      idType: form.idType.trim(),
      idCard: form.idCard.trim(),
      titleTh: form.titleTh.trim(),
      titleEn: form.titleEn.trim(),
      firstName: form.firstName.trim(),
      lastName: form.lastName.trim(),
      firstNameEn: form.firstNameEn.trim(),
      lastNameEn: form.lastNameEn.trim(),
      sex: normalizeSex(form.sex),
      dob: finalDob,
      ageText: [finalAgeY ? `${finalAgeY}y` : "", finalAgeM ? `${finalAgeM}m` : ""].filter(Boolean).join(" "),
      weightKg: form.weightKg.trim(),
      heightCm: form.heightCm.trim(),
      bloodGroupABO: form.bloodGroupABO.trim(),
      bloodGroupRh: form.bloodGroupRh.trim(),
      race: form.race.trim(),
      ethnicity: form.ethnicity.trim(),
      religion: form.religion.trim(),
      maritalStatus: form.maritalStatus.trim(),
      nationality: form.nationality.trim(),
      mobile: form.mobile.trim(),
      presentAddress: form.presentAddress.trim(),
      presentProvince: form.presentProvince.trim(),
      legalAddress: form.legalAddress.trim(),
      legalProvince: form.legalProvince.trim(),
      contactName: form.contactName.trim(),
      contactRelation: form.contactRelation.trim(),
      contactTel: form.contactTel.trim(),
    });
    const mergedDraft = await patchCaseDetailDraft(caseId, patch);
    writeDraft(caseId, mergedDraft);
    window.dispatchEvent(
      new CustomEvent("flora:form-storage-changed", {
        detail: { caseId, source: "patient" },
      }),
    );
    window.dispatchEvent(
      new CustomEvent("flora:case-hn-updated", {
        detail: { caseId, hn: finalHn },
      }),
    );
    setForm(prev => {
      const next = {
        ...prev,
        hn: finalHn,
        dob: finalDob,
        ageY: finalAgeY,
        ageM: finalAgeM,
      };
      lastSyncedFormRef.current = JSON.stringify(next);
      return next;
    });
    setError("");
    setSaveNote(`Saved ${fmt(Date.now())}`);
  };

  const applyAgeToDob = (ageYRaw: string, ageMRaw: string) => {
    setForm(prev => {
      const ageY = normalizeAgeText(ageYRaw, 3);
      const ageM = normalizeAgeMonthText(ageMRaw);
      const derivedDob = dobFromAge(ageY, ageM);
      if (!derivedDob) return { ...prev, dob: ageY || ageM ? prev.dob : "", ageY, ageM };
      const age = ageFromDob(derivedDob);
      return {
        ...prev,
        dob: formatDob(derivedDob),
        ageY: age ? String(age.years) : ageY,
        ageM: age ? String(age.months) : ageM,
      };
    });
  };

  return (
    <div className="app-theme-scope w-full space-y-3 p-4">
      <div className="sticky top-3 z-20">
        <div className="rounded-xl border border-[var(--app-border)] bg-[var(--app-panel-bg)]/95 px-3 py-2.5 shadow-sm backdrop-blur">
          <div className="flex flex-wrap items-center gap-3">
            <div className="min-w-44">
              <div className="text-[10px] font-extrabold uppercase tracking-[0.16em] text-[var(--app-muted)]">Clinical record</div>
              <div className="flex items-center gap-2">
                <h1 className="text-base font-bold text-[var(--app-text)]">Patient</h1>
                {caseStatus.status !== "IDLE" ? (
                  <span className={`rounded-full border px-2 py-0.5 text-[9px] font-extrabold uppercase tracking-wide ${
                    caseStatus.status === "ACTIVE"
                      ? "border-emerald-500/45 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
                      : caseStatus.status === "DISCHARGED"
                        ? "border-amber-500/45 bg-amber-500/10 text-amber-700 dark:text-amber-300"
                        : "border-[var(--app-border)] bg-[var(--app-control-bg)] text-[var(--app-muted)]"
                  }`}>{caseStatus.status.toLowerCase()}</span>
                ) : null}
              </div>
            </div>

            <div className="inline-flex shrink-0 overflow-hidden rounded-lg border border-[var(--app-border)] bg-[var(--app-control-bg)]" role="tablist" aria-label="Patient record sections">
              {([
                ["info", "Profile", ""],
                ["contact", "Contact", ""],
                ["allergy", "Allergy", allergyReviewState === "allergic" ? `${knownAllergies.length} recorded` : allergyReviewState === "none" ? "None known" : "Not reviewed"],
                ["lab", "Labs", !labSummary.loaded ? "Open to review" : labSummary.critical ? `${labSummary.critical} critical` : labSummary.total ? `${labSummary.total} results` : "No results"],
              ] as const).map(([tab, tabLabel, tabStatus]) => (
                <button
                  key={tab}
                  type="button"
                  role="tab"
                  aria-selected={patientTab === tab}
                  onClick={() => setPatientTab(tab)}
                  className={`min-h-11 border-l border-[var(--app-border)] px-3 py-1 text-xs font-bold first:border-l-0 ${patientTab === tab ? "bg-[var(--app-accent)] text-[var(--app-accent-contrast)]" : "text-[var(--app-muted)] hover:bg-[var(--app-control-bg-hover)] hover:text-[var(--app-text)]"}`}
                >
                  <span className="block">{tabLabel}</span>
                  {tabStatus ? <span className={`block text-[9px] font-semibold ${patientTab === tab ? "opacity-85" : tab === "allergy" && allergyReviewState === "allergic" ? "text-red-600 dark:text-red-300" : tab === "allergy" && allergyReviewState === "unknown" ? "text-amber-600 dark:text-amber-300" : tab === "lab" && labSummary.critical ? "text-red-600 dark:text-red-300" : "text-[var(--app-muted)]"}`}>{tabStatus}</span> : null}
                </button>
              ))}
            </div>

            <div className="ml-auto flex flex-wrap items-center justify-end gap-2">
              {patientTab === "info" || patientTab === "contact" ? (
                <button type="button" className={secondaryButton} onClick={() => void getHis()} disabled={loadingHis || isReadOnly}>
                  {loadingHis ? "Loading HIS…" : "Sync HIS"}
                </button>
              ) : null}
              {patientTab === "allergy" ? (
                <button type="button" className={secondaryButton} onClick={() => void getAllergy()} disabled={loadingHis || isReadOnly}>
                  {loadingHis ? "Syncing…" : "Sync allergy"}
                </button>
              ) : null}
              {(patientTab === "info" || patientTab === "contact") && !isReadOnly ? (
                <button
                  type="button"
                  className={primaryButton}
                  disabled={isSaving || !form.hn.trim()}
                  onClick={() => {
                    setIsSaving(true);
                    void save().finally(() => setIsSaving(false));
                  }}
                >
                  {isSaving ? "Saving…" : "Save changes"}
                </button>
              ) : null}
              <span className="max-w-64 truncate text-[10px] text-[var(--app-muted)]">{!isSaving ? saveNote : ""}</span>
            </div>
          </div>
        </div>
        {notification && (
          <div className={`mt-1 flex items-center justify-between gap-2 rounded-xl border px-3 py-2 text-xs shadow-sm ${
            notification.type === "success"
              ? "border-green-300 dark:border-green-700 bg-green-50 dark:bg-green-900/20 text-green-700 dark:text-green-300"
              : notification.type === "warning"
                ? "border-amber-300 dark:border-amber-700 bg-amber-50 dark:bg-amber-900/20 text-amber-700 dark:text-amber-300"
                : "border-red-300 dark:border-red-700 bg-red-50 dark:bg-red-900/20 text-red-700 dark:text-red-300"
          }`}>
            <span>{notification.text}</span>
            <button
              type="button"
              className="ml-2 opacity-60 hover:opacity-100 text-base leading-none"
              onClick={() => setNotification(null)}
            >
              ✕
            </button>
          </div>
        )}
      </div>

      {isReadOnly ? (
        <div className="rounded-xl border border-[var(--app-border)] bg-[var(--app-control-bg)] px-3 py-2 text-xs font-semibold text-[var(--app-muted)]">
          Archived record — patient information and safety data are read-only.
        </div>
      ) : null}

      {patientTab === "lab" && (
        <Suspense fallback={<div className="p-4 text-sm text-gray-400">Loading…</div>}>
          <LabView caseStatus={caseStatus} onSummaryChange={handleLabSummary} />
        </Suspense>
      )}

      {patientTab === "info" && <fieldset disabled={isReadOnly} className="space-y-3">

      <section className={card}>
        <div className="flex items-center justify-between gap-2">
          <div>
            <div className="flex items-center gap-2">
            <div className="text-sm font-bold text-[var(--app-text)]">Identity and demographics</div>
              {dataSource && (
                <span className={`rounded px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wider ${
                  dataSource === "HIS"
                    ? "bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-400"
                    : "bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-400"
                }`}>
                  {dataSource === "HIS" ? "From HIS" : "Loaded"}
                </span>
              )}
            </div>
            <div className="text-xs text-gray-500 dark:text-gray-400">
              Verify identifiers first. Common case fields stay synchronized with Forms.
            </div>
          </div>
          <span className="rounded-full border border-blue-300 bg-blue-50 px-2.5 py-1 text-[10px] font-bold uppercase tracking-wider text-blue-700 dark:border-blue-700 dark:bg-blue-950/40 dark:text-blue-300">
            Shared with Forms
          </span>
          {hisRawPayloadText ? (
            <div className="flex items-center gap-2">
              <button
                type="button"
                className={secondaryButton}
                onClick={() => setShowHisRawPayload(prev => !prev)}
              >
                {showHisRawPayload ? "Hide HIS Raw" : "Show HIS Raw"}
              </button>
              <button
                type="button"
                className={secondaryButton}
                onClick={() => {
                  if (typeof navigator !== "undefined" && navigator.clipboard) {
                    void navigator.clipboard.writeText(hisRawPayloadText);
                  }
                }}
              >
                Copy JSON
              </button>
            </div>
          ) : null}
        </div>

        {showHisRawPayload && hisRawPayloadText ? (
          <div className="rounded border border-amber-300 dark:border-amber-700 bg-amber-50/70 dark:bg-amber-950/20 p-2 space-y-2">
            <div className="text-xs font-semibold text-amber-800 dark:text-amber-300">
              HIS Raw JSON
            </div>
            <textarea
              className="w-full min-h-[220px] rounded border border-amber-200 dark:border-amber-800 bg-white/90 dark:bg-gray-950 px-2 py-1.5 text-[11px] font-mono"
              value={hisRawPayloadText}
              readOnly
            />
          </div>
        ) : null}

        <div className="grid grid-cols-1 md:grid-cols-12 gap-2">
          <div className="md:col-span-12 space-y-2">
            <label className="space-y-1 block">
              <div className={label}>HN</div>
              <div className="flex gap-1">
                <input
                  ref={hnInputRef}
                  className={input}
                  value={form.hn}
                  onChange={e => setForm(prev => ({ ...prev, hn: e.target.value }))}
                  onKeyDown={e => { if (e.key === "Enter" && form.hn.trim()) void getHis(); }}
                />
                <button
                  type="button"
                  className={primaryButton}
                  onClick={() => void getHis()}
                  disabled={loadingHis || !form.hn.trim()}
                >
                  {loadingHis ? "…" : "Get"}
                </button>
              </div>
            </label>
            <label className="space-y-1 block">
              <div className={label}>AN</div>
              <input
                className={input}
                value={form.an}
                onChange={e => setForm(prev => ({ ...prev, an: e.target.value }))}
              />
            </label>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
              <label className="space-y-1">
                <div className={label}>Identifier type</div>
                <select
                  className={input}
                  value={form.idType}
                  onChange={e => setForm(prev => ({ ...prev, idType: e.target.value }))}
                >
                  {IDENTIFIER_TYPE_OPTIONS.map(option => <option key={option.value || "auto"} value={option.value}>{option.label}</option>)}
                </select>
              </label>
              <label className="space-y-1 sm:col-span-2">
                <div className="flex items-center justify-between gap-2"><span className={label}>Government / Passport ID</span>{detectIdentifierType(form.idCard) ? <span className="text-[10px] font-bold text-emerald-600 dark:text-emerald-300">Detected: {detectIdentifierType(form.idCard) === "National ID" ? "Thai national ID" : "Passport"}</span> : null}</div>
                <input
                  className={input}
                  value={form.idCard}
                  autoComplete="off"
                  onChange={e => {
                    const idCard = e.target.value;
                    const detected = detectIdentifierType(idCard);
                    setForm(prev => ({ ...prev, idCard, idType: detected || prev.idType }));
                  }}
                />
                {form.idType === "National ID" && form.idCard.replace(/\D+/g, "").length === 13 ? (
                  <div className={`text-[11px] font-semibold ${isValidThaiNationalId(form.idCard) ? "text-emerald-600 dark:text-emerald-300" : "text-amber-600 dark:text-amber-300"}`}>
                    {isValidThaiNationalId(form.idCard) ? "Thai national ID checksum valid" : "13 digits detected, but the checksum is invalid"}
                  </div>
                ) : null}
              </label>
            </div>
          </div>

          <div className="md:col-span-12 grid grid-cols-1 md:grid-cols-12 gap-2">
            <label className="space-y-1 md:col-span-2">
              <div className={label}>Title (TH)</div>
              <select
                className={input}
                value={form.titleTh}
                onChange={e => setForm(prev => ({ ...prev, titleTh: e.target.value }))}
              >
                {TITLE_TH_OPTIONS.map(opt => (
                  <option key={opt || "empty"} value={opt}>
                    {opt || "-"}
                  </option>
                ))}
              </select>
            </label>
            <label className="space-y-1 md:col-span-5">
              <div className={label}>TH First Name</div>
              <input className={input} value={form.firstName} onChange={e => setForm(prev => ({ ...prev, firstName: e.target.value }))} />
            </label>
            <label className="space-y-1 md:col-span-5">
              <div className={label}>TH Last Name</div>
              <input className={input} value={form.lastName} onChange={e => setForm(prev => ({ ...prev, lastName: e.target.value }))} />
            </label>

            <label className="space-y-1 md:col-span-2">
              <div className={label}>Title (EN)</div>
              <select
                className={input}
                value={form.titleEn}
                onChange={e => setForm(prev => ({ ...prev, titleEn: e.target.value }))}
              >
                {TITLE_EN_OPTIONS.map(opt => (
                  <option key={opt || "empty"} value={opt}>
                    {opt || "-"}
                  </option>
                ))}
              </select>
            </label>
            <label className="space-y-1 md:col-span-5">
              <div className={label}>EN First Name</div>
              <input className={input} value={form.firstNameEn} onChange={e => setForm(prev => ({ ...prev, firstNameEn: e.target.value }))} />
            </label>
            <label className="space-y-1 md:col-span-5">
              <div className={label}>EN Last Name</div>
              <input className={input} value={form.lastNameEn} onChange={e => setForm(prev => ({ ...prev, lastNameEn: e.target.value }))} />
            </label>

            <label className="space-y-1 md:col-span-2">
              <div className={label}>Blood Group (ABO)</div>
              <select
                className={input}
                value={(form.bloodGroupABO || "").toUpperCase()}
                onChange={e => setForm(prev => ({ ...prev, bloodGroupABO: e.target.value }))}
              >
                <option value="">Unknown</option>
                <option value="A">A</option>
                <option value="B">B</option>
                <option value="AB">AB</option>
                <option value="O">O</option>
              </select>
            </label>
            <label className="space-y-1 md:col-span-2">
              <div className={label}>Blood Group (Rh)</div>
              <select
                className={input}
                value={(form.bloodGroupRh || "").toUpperCase()}
                onChange={e => setForm(prev => ({ ...prev, bloodGroupRh: e.target.value }))}
              >
                <option value="">Unknown</option>
                <option value="+">Rh+</option>
                <option value="-">Rh-</option>
              </select>
            </label>
            <label className="space-y-1 md:col-span-3">
              <div className={label}>Date of Birth</div>
              <input
                className={input}
                placeholder="dd/mm/yyyy"
                value={form.dob}
                onChange={e => {
                  const dob = formatDateInputDDMMYYYY(e.target.value);
                  const parsed = parseDob(dob);
                  const age = parsed ? ageFromDob(parsed) : null;
                  setForm(prev => ({
                    ...prev,
                    dob,
                    ageY: age ? String(age.years) : dob ? prev.ageY : "",
                    ageM: age ? String(age.months) : dob ? prev.ageM : "",
                  }));
                }}
              />
              <div className="text-[10px] text-[var(--app-muted)]">Enter DOB to calculate age, or enter age to estimate DOB.</div>
            </label>
            <label className="space-y-1 md:col-span-2">
              <div className={label}>Age (Y)</div>
              <input
                className={input}
                inputMode="numeric"
                value={form.ageY}
                onChange={e => {
                  const ageY = normalizeAgeText(e.target.value, 3);
                  applyAgeToDob(ageY, form.ageM);
                }}
              />
            </label>
            <label className="space-y-1 md:col-span-3">
              <div className={label}>Age (M)</div>
              <input
                className={input}
                inputMode="numeric"
                value={form.ageM}
                onChange={e => {
                  const ageM = normalizeAgeMonthText(e.target.value);
                  applyAgeToDob(form.ageY, ageM);
                }}
                max={11}
              />
            </label>

            <div className="space-y-1 md:col-span-4">
              <div className={label}>Sex</div>
              <div className="grid grid-cols-3 gap-2">
                <label className="inline-flex items-center justify-center gap-1 rounded border border-gray-300 dark:border-gray-700 px-2 py-1.5 text-xs">
                  <input
                    type="radio"
                    name="patient-sex"
                    checked={normalizeSex(form.sex) === "M"}
                    onChange={() => setForm(prev => ({ ...prev, sex: "M" }))}
                  />
                  Male
                </label>
                <label className="inline-flex items-center justify-center gap-1 rounded border border-gray-300 dark:border-gray-700 px-2 py-1.5 text-xs">
                  <input
                    type="radio"
                    name="patient-sex"
                    checked={normalizeSex(form.sex) === "F"}
                    onChange={() => setForm(prev => ({ ...prev, sex: "F" }))}
                  />
                  Female
                </label>
                <label className="inline-flex items-center justify-center gap-1 rounded border border-gray-300 dark:border-gray-700 px-2 py-1.5 text-xs">
                  <input
                    type="radio"
                    name="patient-sex"
                    checked={normalizeSex(form.sex) === ""}
                    onChange={() => setForm(prev => ({ ...prev, sex: "" }))}
                  />
                  Unknown
                </label>
              </div>
            </div>
            <label className="space-y-1 md:col-span-4">
              <div className={label}>Weight (kg)</div>
              <input
                type="number"
                min="0"
                max="400"
                step="0.1"
                className={input}
                value={form.weightKg}
                onChange={e => setForm(prev => ({ ...prev, weightKg: e.target.value }))}
              />
            </label>
            <label className="space-y-1 md:col-span-4">
              <div className={label}>Height (cm)</div>
              <input
                type="number"
                min="0"
                max="260"
                step="0.1"
                className={input}
                value={form.heightCm}
                onChange={e => setForm(prev => ({ ...prev, heightCm: e.target.value }))}
              />
            </label>

            <div className="md:col-span-12 mt-2 border-t border-[var(--app-border)] pt-3">
              <div className="text-[10px] font-extrabold uppercase tracking-[0.15em] text-[var(--app-muted)]">Additional demographics</div>
            </div>
            <label className="space-y-1 md:col-span-3">
              <div className={label}>Race</div>
              <input className={input} value={form.race} onChange={e => setForm(prev => ({ ...prev, race: e.target.value }))} />
            </label>
            <label className="space-y-1 md:col-span-3">
              <div className={label}>Ethnicity</div>
              <input className={input} value={form.ethnicity} onChange={e => setForm(prev => ({ ...prev, ethnicity: e.target.value }))} />
            </label>
            <label className="space-y-1 md:col-span-3">
              <div className={label}>Religion</div>
              <input className={input} value={form.religion} onChange={e => setForm(prev => ({ ...prev, religion: e.target.value }))} />
            </label>
            <label className="space-y-1 md:col-span-3">
              <div className={label}>Marital status</div>
              <input className={input} value={form.maritalStatus} onChange={e => setForm(prev => ({ ...prev, maritalStatus: e.target.value }))} />
            </label>
            <label className="space-y-1 md:col-span-3">
              <div className={label}>Nationality</div>
              <input className={input} value={form.nationality} onChange={e => setForm(prev => ({ ...prev, nationality: e.target.value }))} />
            </label>
            <label className="space-y-1 md:col-span-3">
              <div className={label}>Preferred language</div>
              <input className={input} value={form.preferredLanguage} onChange={e => setForm(prev => ({ ...prev, preferredLanguage: e.target.value }))} />
            </label>
          </div>
        </div>

        {error ? (
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-xs text-red-500">{error}</span>
          </div>
        ) : null}
      </section>

      </fieldset>}

      {patientTab === "contact" && <fieldset disabled={isReadOnly} className="space-y-3">
        <section className={card}>
          <div>
            <div className="text-sm font-bold text-[var(--app-text)]">Contact and communication</div>
            <div className="text-xs text-[var(--app-muted)]">Patient-owned contact data. Encounter location and care team are maintained with the case.</div>
          </div>
          <div className="grid grid-cols-1 gap-2 md:grid-cols-12">
            <label className="space-y-1 md:col-span-4">
              <div className={label}>Mobile</div>
              <input className={input} inputMode="tel" value={form.mobile} onChange={e => setForm(prev => ({ ...prev, mobile: e.target.value }))} />
            </label>
            <label className="space-y-1 md:col-span-4">
              <div className={label}>Email</div>
              <input className={input} type="email" value={form.email} onChange={e => setForm(prev => ({ ...prev, email: e.target.value }))} />
            </label>
            <label className="space-y-1 md:col-span-4">
              <div className={label}>Preferred language</div>
              <input className={input} value={form.preferredLanguage} onChange={e => setForm(prev => ({ ...prev, preferredLanguage: e.target.value }))} />
            </label>
          </div>
        </section>

        <section className={card}>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <div className="text-sm font-bold text-[var(--app-text)]">Addresses</div>
              <div className="text-xs text-[var(--app-muted)]">Keep current and registered addresses distinct for HIS reconciliation.</div>
            </div>
            <button
              type="button"
              className={secondaryButton}
              onClick={() => setForm(prev => ({ ...prev, legalAddress: prev.presentAddress, legalProvince: prev.presentProvince }))}
            >
              Same as current
            </button>
          </div>
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            <div className="space-y-2 rounded-xl border border-[var(--app-border)] bg-[var(--app-control-bg)] p-3">
              <div className={label}>Current address</div>
              <textarea className={`${input} min-h-24 resize-y`} value={form.presentAddress} onChange={e => setForm(prev => ({ ...prev, presentAddress: e.target.value }))} />
              <label className="space-y-1 block">
                <div className={label}>Province / State</div>
                <input className={input} value={form.presentProvince} onChange={e => setForm(prev => ({ ...prev, presentProvince: e.target.value }))} />
              </label>
            </div>
            <div className="space-y-2 rounded-xl border border-[var(--app-border)] bg-[var(--app-control-bg)] p-3">
              <div className={label}>Registered address</div>
              <textarea className={`${input} min-h-24 resize-y`} value={form.legalAddress} onChange={e => setForm(prev => ({ ...prev, legalAddress: e.target.value }))} />
              <label className="space-y-1 block">
                <div className={label}>Province / State</div>
                <input className={input} value={form.legalProvince} onChange={e => setForm(prev => ({ ...prev, legalProvince: e.target.value }))} />
              </label>
            </div>
          </div>
        </section>

        <section className={card}>
          <div>
            <div className="text-sm font-bold text-[var(--app-text)]">Emergency contact / next of kin</div>
            <div className="text-xs text-[var(--app-muted)]">A contact party is not the patient and may later be linked as a FHIR RelatedPerson.</div>
          </div>
          <div className="grid grid-cols-1 gap-2 md:grid-cols-12">
            <label className="space-y-1 md:col-span-5">
              <div className={label}>Contact name</div>
              <input className={input} value={form.contactName} onChange={e => setForm(prev => ({ ...prev, contactName: e.target.value }))} />
            </label>
            <label className="space-y-1 md:col-span-3">
              <div className={label}>Relationship</div>
              <input className={input} value={form.contactRelation} onChange={e => setForm(prev => ({ ...prev, contactRelation: e.target.value }))} />
            </label>
            <label className="space-y-1 md:col-span-4">
              <div className={label}>Phone</div>
              <input className={input} inputMode="tel" value={form.contactTel} onChange={e => setForm(prev => ({ ...prev, contactTel: e.target.value }))} />
            </label>
            <label className="space-y-1 md:col-span-12">
              <div className={label}>Contact instructions</div>
              <textarea className={`${input} min-h-20 resize-y`} placeholder="Priority, preferred time, interpreter, or other contact instruction" value={form.contactInstructions} onChange={e => setForm(prev => ({ ...prev, contactInstructions: e.target.value }))} />
            </label>
          </div>
        </section>
      </fieldset>}

      {patientTab === "allergy" && <fieldset className={card} disabled={isReadOnly}>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="text-base font-bold text-[var(--app-text)]">Allergy safety</div>
            <div className="text-xs text-[var(--app-muted)]">Review and confirm allergy status before medication administration.</div>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-[10px] font-semibold text-[var(--app-muted)]">{loadingSupport ? "Loading…" : "Case record"}</span>
            <button
              type="button"
              className={secondaryButton}
              onClick={() => void getAllergy()}
              disabled={loadingHis}
            >
              {loadingHis ? "Syncing…" : "Sync HIS allergy"}
            </button>
          </div>
        </div>

        <div className={`rounded-xl border p-4 ${allergyReviewState === "allergic" ? "border-red-300 bg-red-50 dark:border-red-800 dark:bg-red-950/25" : allergyReviewState === "none" ? "border-emerald-300 bg-emerald-50 dark:border-emerald-800 dark:bg-emerald-950/25" : "border-amber-300 bg-amber-50 dark:border-amber-800 dark:bg-amber-950/25"}`}>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-3">
              <span className={`flex h-10 w-10 items-center justify-center rounded-full text-xl font-black ${allergyReviewState === "allergic" ? "bg-red-600 text-white" : allergyReviewState === "none" ? "bg-emerald-600 text-white" : "bg-amber-500 text-white"}`}>{allergyReviewState === "allergic" ? "!" : allergyReviewState === "none" ? "✓" : "?"}</span>
              <div>
                <div className={`font-extrabold ${allergyReviewState === "allergic" ? "text-red-700 dark:text-red-300" : allergyReviewState === "none" ? "text-emerald-700 dark:text-emerald-300" : "text-amber-700 dark:text-amber-300"}`}>{allergyReviewState === "allergic" ? `${knownAllergies.length} recorded allerg${knownAllergies.length === 1 ? "y" : "ies"}` : allergyReviewState === "none" ? "No known allergies (NKA)" : "Allergy status not reviewed"}</div>
                <div className="text-xs text-[var(--app-muted)]">{allergyReviewState === "allergic" ? "Review the allergen, reaction, and severity below." : allergyReviewState === "none" ? "A clinician has explicitly confirmed no known allergies." : "An empty list does not mean this patient has no allergies."}</div>
              </div>
            </div>
            {allergyReviewState === "unknown" ? <button type="button" className="min-h-9 rounded-lg bg-emerald-600 px-3 text-xs font-bold text-white hover:bg-emerald-500" onClick={() => void markNoKnownAllergies()}>Confirm no known allergies</button> : allergyReviewState === "none" ? <button type="button" className={secondaryButton} onClick={() => void markAllergiesNotReviewed()}>Mark not reviewed</button> : null}
          </div>
        </div>

        {knownAllergies.length === 0 ? (
          <div className="rounded-xl border border-dashed border-[var(--app-border)] px-4 py-6 text-center text-xs text-[var(--app-muted)]">{allergyReviewState === "none" ? "No allergen entries. Add one below if new information is discovered." : "No allergy has been documented yet. Confirm NKA or record an allergen below."}</div>
        ) : (
          <div className="rounded border border-gray-200 dark:border-gray-800 overflow-hidden">
            <table className="w-full text-xs">
              <thead className="bg-gray-100 dark:bg-gray-900/50">
                <tr>
                  <th className="px-2 py-1 text-left">Allergen</th>
                  <th className="px-2 py-1 text-left">Reaction</th>
                  <th className="px-2 py-1 text-left">Severity</th>
                  <th className="px-2 py-1 text-left">Source</th>
                  <th className="px-2 py-1 text-right">Action</th>
                </tr>
              </thead>
              <tbody>
                {knownAllergies.map(row => (
                  <tr key={row.id} className="border-t border-gray-200 dark:border-gray-800">
                    <td className="px-2 py-1 font-bold text-red-600 dark:text-red-400">{row.allergen}</td>
                    <td className="px-2 py-1">{row.reaction || "-"}</td>
                    <td className="px-2 py-1">
                      {row.severity ? (
                        <span className="rounded bg-red-100 dark:bg-red-900/30 px-1.5 py-0.5 text-[10px] font-bold text-red-700 dark:text-red-400">
                          {row.severity}
                        </span>
                      ) : "-"}
                    </td>
                    <td className="px-2 py-1 text-[10px] text-gray-400 uppercase">{row.source || "HIS"}</td>
                    <td className="px-2 py-1 text-right space-x-2">
                      <button
                        type="button"
                        onClick={() => handleEditAllergy(row)}
                        className="text-blue-600 dark:text-blue-400 hover:underline"
                      >
                        Edit
                      </button>
                      <button
                        type="button"
                        onClick={() => setPendingDeleteAllergyId(row.id)}
                        className="text-red-600 dark:text-red-400 hover:underline"
                      >
                        Remove
                      </button>

                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <div className="mt-4 space-y-3 rounded-xl border border-[var(--app-border)] bg-[var(--app-control-bg)] p-4">
          <div><div className="text-sm font-bold text-[var(--app-text)]">{editingAllergyId ? "Edit allergy" : "Record an allergy"}</div><div className="text-xs text-[var(--app-muted)]">Adding an allergen automatically replaces a previous NKA status.</div></div>
          <div className="grid grid-cols-1 gap-2 md:grid-cols-3">
            <div className="space-y-1">
              <div className={label}>Allergen</div>
              <input
                className={input}
                placeholder="e.g. Penicillin"
                list="allergen-options"
                value={newAllergen}
                onChange={e => setNewAllergen(e.target.value)}
              />
              <datalist id="allergen-options">
                {/* Antibiotics */}
                <option value="Penicillin" />
                <option value="Amoxicillin" />
                <option value="Ampicillin" />
                <option value="Co-trimoxazole (TMP-SMX)" />
                <option value="Cefazolin" />
                <option value="Ceftriaxone" />
                <option value="Cephalexin" />
                <option value="Clindamycin" />
                <option value="Metronidazole" />
                <option value="Vancomycin" />
                <option value="Ciprofloxacin" />
                <option value="Tetracycline" />
                <option value="Erythromycin" />
                {/* NSAIDs / Analgesics */}
                <option value="Aspirin" />
                <option value="Ibuprofen" />
                <option value="Diclofenac" />
                <option value="Mefenamic acid (Ponstan)" />
                <option value="Naproxen" />
                <option value="Morphine" />
                <option value="Codeine" />
                <option value="Tramadol" />
                <option value="Paracetamol" />
                {/* Anesthesia */}
                <option value="Latex" />
                <option value="Succinylcholine" />
                <option value="Rocuronium" />
                <option value="Cisatracurium" />
                <option value="Propofol" />
                <option value="Thiopental" />
                <option value="Neostigmine" />
                <option value="Contrast media (Iodine)" />
                <option value="Chlorhexidine" />
                <option value="Protamine" />
                {/* High SJS risk in Thai/Asian (HLA-associated) */}
                <option value="Carbamazepine" />
                <option value="Phenytoin" />
                <option value="Allopurinol" />
                <option value="Oxcarbazepine" />
                {/* Food */}
                <option value="Shellfish" />
                <option value="Fish / Fish sauce" />
                <option value="Peanuts" />
                <option value="Tree nuts" />
                <option value="Sesame" />
                <option value="Soy" />
                <option value="Eggs" />
                <option value="Milk / Dairy" />
                {/* Environmental / Other */}
                <option value="House dust mite" />
                <option value="Bee / Wasp venom" />
                <option value="Andrographis (ฟ้าทะลายโจร)" />
              </datalist>
            </div>
            <div className="space-y-1">
              <div className={label}>Reaction</div>
              <input
                className={input}
                placeholder="e.g. Skin rash"
                value={newReaction}
                onChange={e => setNewReaction(e.target.value)}
                list="patient-allergy-reaction-options"
              />
              <datalist id="patient-allergy-reaction-options">
                {['Rash', 'Urticaria', 'Angioedema', 'Bronchospasm', 'Hypotension', 'Anaphylaxis', 'Nausea / vomiting', 'Stevens-Johnson syndrome'].map(item => <option key={item} value={item} />)}
              </datalist>
            </div>
            <div className="space-y-1">
              <div className={label}>Severity</div>
              <select
                className={input}
                value={newSeverity}
                onChange={e => setNewSeverity(e.target.value)}
              >
                <option value="">Select severity</option>
                {ALLERGY_SEVERITY_OPTIONS.map(item => (
                  <option key={item} value={item}>{item}</option>
                ))}
              </select>
            </div>
          </div>
          <div className="flex justify-end gap-2">
            {editingAllergyId && (
              <button
                type="button"
                className="text-xs text-gray-500 hover:underline px-2"
                onClick={() => {
                  setEditingAllergyId(null);
                  setNewAllergen("");
                  setNewReaction("");
                  setNewSeverity("");
                }}
              >
                Cancel
              </button>
            )}
            <button
              type="button"
              className={primaryButton}
              disabled={!newAllergen.trim()}
              onClick={() => void handleSaveAllergy()}
            >
              {editingAllergyId ? "Update Entry" : "Add Entry"}
            </button>
          </div>
        </div>
      </fieldset>}

      <ConfirmDialog
        open={pendingDeleteAllergyId !== null}
        title="Remove Allergy"
        message="Are you sure you want to remove this allergy record from the case?"
        confirmLabel="Remove"
        tone="danger"
        onConfirm={confirmDeleteAllergy}
        onCancel={() => setPendingDeleteAllergyId(null)}
      />

      <ConfirmDialog
        open={alertMessage !== ""}
        title={alertTitle || "Notice"}
        message={alertMessage}
        confirmLabel="OK"
        tone="primary"
        onConfirm={() => {
          setAlertMessage("");
          setAlertTitle("");
        }}
        onCancel={() => {
          setAlertMessage("");
          setAlertTitle("");
        }}
      />
    </div>
  );
}
