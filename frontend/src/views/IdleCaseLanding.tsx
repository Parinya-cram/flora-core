import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { createCaseDiagnosis, createCaseProcedure } from "../api/caseClinicalApi";
import {
  getCanopyAdmissions,
  getCaseStartOverlap,
  startCase,
  type AdmissionSource,
  type CanopyAdmissionRow,
  type StartCaseOverlapPolicy,
} from "../api/caseApi";
import {
  createCaseAllergy,
  getHisBufferByHn,
  listDemoHisPatients,
  listHisBuffer,
  lookupHisByHn,
  syncCaseHis,
  type CaseHisLookupResult,
  type DemoHisPatient,
  type HisBufferListRow,
} from "../api/caseHisApi";
import type { AuthUser } from "../auth/useAuth";
import { useLanguage } from "../context/LanguageContext";
import { getWorkstationContext, type WorkstationContext } from "../api/workstationApi";
import preparedPathIcon from "../assets/admission-paths/prepared.png";
import hisPathIcon from "../assets/admission-paths/his.png";
import manualPathIcon from "../assets/admission-paths/manual.png";
import emergencyPathIcon from "../assets/admission-paths/emergency.png";
import ClinicalDateInput from "../components/ClinicalDateInput";
import ClinicalDateTimeInput from "../components/ClinicalDateTimeInput";
import { searchClinicalConcepts, type ClinicalConcept } from "../api/terminologyApi";
import {
  formatPatientDisplayName,
  normalizePatientNameLanguage,
  type PatientNameLanguage,
} from "../utils/patientName";

type Props = {
  sessionUser: AuthUser | null;
  onCaseStarted: () => Promise<void> | void;
};

type AdmissionMode = "prepared" | "his" | "manual" | "emergency";

const admissionPathIcons: Record<AdmissionMode, string> = {
  prepared: preparedPathIcon,
  his: hisPathIcon,
  manual: manualPathIcon,
  emergency: emergencyPathIcon,
};

function dateTimeLocalNow() {
  const date = new Date();
  date.setSeconds(0, 0);
  const offset = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 16);
}

function estimatedDobFromAge(yearsText: string, monthsText: string) {
  if (!yearsText.trim() && !monthsText.trim()) return "";
  const years = Math.max(0, Number.parseInt(yearsText || "0", 10) || 0);
  const months = Math.min(11, Math.max(0, Number.parseInt(monthsText || "0", 10) || 0));
  const date = new Date();
  date.setHours(12, 0, 0, 0);
  date.setFullYear(date.getFullYear() - years);
  date.setMonth(date.getMonth() - months);
  const offset = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 10);
}

function ageLabel(yearsText: string, monthsText: string) {
  if (!yearsText.trim() && !monthsText.trim()) return "";
  const years = Math.max(0, Number.parseInt(yearsText || "0", 10) || 0);
  const months = Math.min(11, Math.max(0, Number.parseInt(monthsText || "0", 10) || 0));
  return `${years}y ${months}m`;
}

function ageFromDob(dob: string) {
  const birth = new Date(`${dob}T12:00:00`);
  if (!dob || Number.isNaN(birth.getTime()) || birth.getTime() > Date.now()) return { years: "", months: "" };
  const today = new Date();
  let months = (today.getFullYear() - birth.getFullYear()) * 12 + today.getMonth() - birth.getMonth();
  if (today.getDate() < birth.getDate()) months -= 1;
  months = Math.max(0, months);
  return { years: String(Math.floor(months / 12)), months: String(months % 12) };
}

function formattedProfileDate(date: Date, timezone: string, format: string) {
  const parts = new Intl.DateTimeFormat("en-GB", { day: "2-digit", month: "2-digit", year: "numeric", timeZone: timezone }).formatToParts(date);
  const value = (type: string) => parts.find(part => part.type === type)?.value || "";
  return format.replace("DD", value("day")).replace("MM", value("month")).replace("YYYY", value("year"));
}

function patientName(result: CaseHisLookupResult | null, preference: PatientNameLanguage) {
  const row = result?.row;
  if (!row) return "";
  return formatPatientDisplayName(row, preference);
}

function preparedPatientName(row: HisBufferListRow, preference: PatientNameLanguage) {
  return formatPatientDisplayName(row, preference) || row.hn;
}

const CANOPY_ADMISSIONS_REFRESH_MS = 15_000;
const ASA_ROMAN: Record<string, string> = { "1": "I", "2": "II", "3": "III", "4": "IV", "5": "V", "6": "VI" };
const SURGICAL_PRIORITIES = ["elective", "urgent", "emergency"];

function normalizeAsa(value: string | null | undefined) {
  const raw = String(value || "").trim().toUpperCase();
  return ASA_ROMAN[raw] || raw;
}

function formatScheduled(ms: number | null | undefined, timezone: string, language: string) {
  if (!ms || !Number.isFinite(ms)) return "";
  return new Intl.DateTimeFormat(language === "th" ? "th-TH" : "en-GB", {
    day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", timeZone: timezone,
  }).format(new Date(ms));
}

/** Errors meaning the Canopy admission was taken or withdrawn; the list must be refreshed. */
function isCanopyAdmissionGone(message: string) {
  return /no longer available|already started at another leaf/i.test(message);
}

function FieldIcon({ children }: { children: ReactNode }) {
  return <span className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-[var(--app-accent)]/12 text-[var(--app-accent)]">{children}</span>;
}

function preferredCoding(concept: ClinicalConcept, domain: "diagnosis" | "procedure") {
  const order = domain === "diagnosis" ? ["ICD_10", "SNOMED_CT"] : ["ICD_9_CM", "SNOMED_CT", "ICD_10"];
  for (const system of order) {
    const coding = concept.codings?.[system];
    if (coding?.code) return { ...coding, systemKey: system };
  }
  return null;
}

function codingLabel(concept: ClinicalConcept, domain: "diagnosis" | "procedure") {
  const coding = preferredCoding(concept, domain);
  return coding ? `${coding.systemKey.replaceAll("_", "-")} · ${coding.code}` : concept.local_id;
}

export default function IdleCaseLanding({ sessionUser, onCaseStarted }: Props) {
  const { language, t } = useLanguage();
  const patientNameLanguage = normalizePatientNameLanguage(
    sessionUser?.parameterPreferences?.patientNameLanguage,
  );
  const [mode, setMode] = useState<AdmissionMode>("prepared");
  const [hn, setHn] = useState("");
  const [lookup, setLookup] = useState<CaseHisLookupResult | null>(null);
  const [prepared, setPrepared] = useState<HisBufferListRow[]>([]);
  const [canopyAdmissions, setCanopyAdmissions] = useState<CanopyAdmissionRow[]>([]);
  const [canopyAdmission, setCanopyAdmission] = useState<CanopyAdmissionRow | null>(null);
  /** The Canopy admission's HN also exists in the local HIS buffer (so HIS sync is worthwhile). */
  const [canopyHisBuffered, setCanopyHisBuffered] = useState(false);
  const [demoPatients, setDemoPatients] = useState<DemoHisPatient[]>([]);
  const [procedure, setProcedure] = useState("");
  const [diagnosis, setDiagnosis] = useState("");
  const [diagnosisMatches, setDiagnosisMatches] = useState<ClinicalConcept[]>([]);
  const [procedureMatches, setProcedureMatches] = useState<ClinicalConcept[]>([]);
  const [selectedDiagnosis, setSelectedDiagnosis] = useState<ClinicalConcept | null>(null);
  const [selectedProcedure, setSelectedProcedure] = useState<ClinicalConcept | null>(null);
  const [anaesthesiaTechnique, setAnaesthesiaTechnique] = useState("");
  const [asaStatus, setAsaStatus] = useState("");
  const [asaEmergency, setAsaEmergency] = useState(false);
  const [surgicalPriority, setSurgicalPriority] = useState("elective");
  const [codePatient, setCodePatient] = useState<DemoHisPatient | null>(null);
  const [startAt, setStartAt] = useState(dateTimeLocalNow);
  const [allergyReviewed, setAllergyReviewed] = useState(false);
  const [nkaConfirmed, setNkaConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [overlapChoice, setOverlapChoice] = useState(false);
  const [emergencyOverlapChoice, setEmergencyOverlapChoice] = useState(false);
  const [manual, setManual] = useState({ name: "", an: "", sex: "unknown", dob: "", dobPrecision: "" as "" | "exact" | "estimated", ageYears: "", ageMonths: "", weight: "" });
  const [now, setNow] = useState(() => new Date());
  const [workstation, setWorkstation] = useState<WorkstationContext | null>(null);

  useEffect(() => {
    let cancelled = false;
    void listHisBuffer({ limit: 6 }).then(rows => {
      if (!cancelled) setPrepared(rows);
    }).catch(() => {
      if (!cancelled) setPrepared([]);
    });
    return () => { cancelled = true; };
  }, []);

  const refreshCanopyAdmissions = useCallback(async () => {
    try {
      setCanopyAdmissions(await getCanopyAdmissions());
    } catch {
      // Canopy may be unreachable; keep the last known list.
    }
  }, []);

  useEffect(() => {
    void refreshCanopyAdmissions();
    const timer = window.setInterval(() => void refreshCanopyAdmissions(), CANOPY_ADMISSIONS_REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [refreshCanopyAdmissions]);

  useEffect(() => {
    if (selectedDiagnosis?.local_name === diagnosis || diagnosis.trim().length < 2) { setDiagnosisMatches([]); return; }
    let cancelled = false;
    const timer = window.setTimeout(() => void searchClinicalConcepts("diagnosis", diagnosis).then(rows => { if (!cancelled) setDiagnosisMatches(rows); }).catch(() => { if (!cancelled) setDiagnosisMatches([]); }), 250);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [diagnosis, selectedDiagnosis]);

  useEffect(() => {
    if (selectedProcedure?.local_name === procedure || procedure.trim().length < 2) { setProcedureMatches([]); return; }
    let cancelled = false;
    const timer = window.setTimeout(() => void searchClinicalConcepts("procedure", procedure).then(rows => { if (!cancelled) setProcedureMatches(rows); }).catch(() => { if (!cancelled) setProcedureMatches([]); }), 250);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [procedure, selectedProcedure]);

  useEffect(() => {
    let cancelled = false;
    void listDemoHisPatients().then(rows => {
      if (!cancelled) setDemoPatients(rows);
    }).catch(() => {
      if (!cancelled) setDemoPatients([]);
    });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    let cancelled = false;
    void getWorkstationContext().then(value => {
      if (!cancelled) setWorkstation(value);
    }).catch(() => {});
    return () => { cancelled = true; };
  }, []);

  const displayTimezone = workstation?.timezone || "Asia/Bangkok";
  const clock = useMemo(() => new Intl.DateTimeFormat(language === "th" ? "th-TH" : "en-GB", {
    hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: workstation?.timeFormat === "12h", timeZone: displayTimezone,
  }).format(now), [displayTimezone, language, now, workstation?.timeFormat]);
  const calendarDate = useMemo(() => formattedProfileDate(now, displayTimezone, workstation?.dateFormat || "DD/MM/YYYY"), [displayTimezone, now, workstation?.dateFormat]);

  const hasAllergies = Boolean(lookup?.allergies.length);
  const patientReady = Boolean(lookup?.row && (lookup.row.hn || mode === "manual"));
  const safeToStart = patientReady && Boolean(procedure.trim()) && allergyReviewed && Boolean(startAt) && !busy;
  const clinician = sessionUser?.name || sessionUser?.username || t("landing.notAssigned");
  const sourceLabel = canopyAdmission ? t("landing.canopySource") : mode === "manual" ? t("admit.manual") : lookup?.offline ? t("landing.bufferSource") : lookup?.exchange?.label || t("landing.hisSource");
  const startTimestamp = useMemo(() => new Date(startAt).getTime(), [startAt]);

  function resetPatient() {
    setLookup(null);
    setCanopyAdmission(null);
    setCanopyHisBuffered(false);
    setProcedure("");
    setDiagnosis("");
    setSelectedProcedure(null);
    setSelectedDiagnosis(null);
    setAnaesthesiaTechnique("");
    setAsaStatus("");
    setAsaEmergency(false);
    setSurgicalPriority("elective");
    setAllergyReviewed(false);
    setNkaConfirmed(false);
    setOverlapChoice(false);
    setError("");
  }

  function chooseMode(nextMode: AdmissionMode) {
    resetPatient();
    setMode(nextMode);
    setHn("");
    setEmergencyOverlapChoice(false);
  }

  async function loadPatient(targetHn: string, fromBuffer = false) {
    const normalized = targetHn.trim();
    if (!normalized) return;
    setCanopyAdmission(null);
    setCanopyHisBuffered(false);
    setBusy(true);
    setError("");
    try {
      const result = fromBuffer ? await getHisBufferByHn(normalized) : await lookupHisByHn(normalized);
      if (!result.row) throw new Error(t("landing.patientNotFound"));
      setHn(result.row.hn || normalized);
      setLookup(result);
      const incomingPriority = result.exchange?.encounter?.priority?.toLowerCase();
      if (incomingPriority === "elective" || incomingPriority === "urgent" || incomingPriority === "emergency") setSurgicalPriority(incomingPriority);
      setAllergyReviewed(false);
      setNkaConfirmed(false);
    } catch (cause) {
      setLookup(null);
      setError(cause instanceof Error ? cause.message : t("landing.patientLookupFailed"));
    } finally {
      setBusy(false);
    }
  }

  async function selectCanopyAdmission(row: CanopyAdmissionRow) {
    resetPatient();
    setBusy(true);
    const normalizedHn = String(row.hn || "").trim();
    const patient = row.patient || { patient_name: "" };
    let result: CaseHisLookupResult | null = null;
    if (normalizedHn) {
      try {
        const buffered = await getHisBufferByHn(normalizedHn);
        if (buffered.row) result = buffered;
      } catch {
        // Not in the local HIS buffer: the Canopy admission carries the identity.
      }
    }
    setCanopyHisBuffered(Boolean(result));
    setLookup(result ?? {
      ok: true,
      hn: normalizedHn,
      source: "BUFFER",
      offline: true,
      row: {
        hn: normalizedHn,
        an: row.admissionNumber || null,
        patient_name: patient.patient_name || null,
        sex: patient.sex || null,
        dob: patient.dob || null,
        age_text: patient.age_text || null,
        weight_kg: patient.weight_kg ?? null,
        height_cm: patient.height_cm ?? null,
      },
      allergies: [],
      labs: [],
    });
    const details = row.admission || {};
    setCanopyAdmission(row);
    setHn(normalizedHn);
    setProcedure(details.operation || "");
    setDiagnosis(details.diagnosis || "");
    setAnaesthesiaTechnique(details.anaesthesia_technique || "");
    setAsaStatus(normalizeAsa(details.asa_status));
    setAsaEmergency(Boolean(details.asa_emergency));
    const priority = String(details.surgical_priority || "").trim().toLowerCase();
    setSurgicalPriority(SURGICAL_PRIORITIES.includes(priority) ? priority : "elective");
    setBusy(false);
  }

  function useManualPatient() {
    const normalizedHn = hn.trim();
    const name = manual.name.trim();
    if (!normalizedHn && !name) {
      setError(t("admit.manualIdentityRequired"));
      return;
    }
    const temporaryReference = normalizedHn;
    const enteredAge = ageLabel(manual.ageYears, manual.ageMonths);
    const calculatedDob = manual.dob || estimatedDobFromAge(manual.ageYears, manual.ageMonths);
    setLookup({ ok: true, hn: temporaryReference, source: "BUFFER", offline: true, row: {
      hn: temporaryReference,
      an: manual.an.trim() || null,
      patient_name: name || null,
      sex: manual.sex,
      dob: calculatedDob || null,
      age_text: enteredAge || null,
      weight_kg: manual.weight ? Number(manual.weight) : null,
    }, allergies: [], labs: [] });
    setAllergyReviewed(false);
    setNkaConfirmed(false);
    setError("");
  }

  async function completeStart(policy?: StartCaseOverlapPolicy) {
    if (!lookup?.row || (!lookup.row.hn && mode !== "manual") || !safeToStart) return;
    setBusy(true);
    setError("");
    try {
      const admissionSource: AdmissionSource = canopyAdmission || mode === "prepared" ? "prepared" : mode === "manual" ? "manual" : "his";
      const started = await startCase(lookup.row.hn, startTimestamp, {
        overlapPolicy: policy,
        admissionSource,
        admissionNumber: lookup.row.an || undefined,
        patientName: patientName(lookup, patientNameLanguage) || undefined,
        sex: lookup.row.sex || undefined,
        dateOfBirth: lookup.row.dob || undefined,
        dateOfBirthPrecision: mode === "manual" ? manual.dobPrecision || undefined : undefined,
        ageText: lookup.row.age_text || undefined,
        weightKg: lookup.row.weight_kg ?? undefined,
        diagnosis: diagnosis.trim() || undefined,
        operation: procedure.trim() || undefined,
        anaesthesiaTechnique: anaesthesiaTechnique || undefined,
        asaStatus: asaStatus || undefined,
        asaEmergency,
        surgicalPriority,
        canopyAdmissionId: canopyAdmission?.id,
      });
      const caseId = Number(started?.case_id);
      if (!Number.isFinite(caseId) || caseId <= 0) throw new Error(t("landing.startFailed"));

      const preparationWarnings: unknown[] = [];
      // A Canopy admission whose HN is not in the HIS buffer has nothing to sync.
      if (mode !== "manual" && (!canopyAdmission || canopyHisBuffered)) {
        try {
          await syncCaseHis(caseId);
        } catch (syncError) {
          preparationWarnings.push(syncError);
        }
      }
      const followups: Promise<unknown>[] = [];
      const diagnosisCoding = selectedDiagnosis ? preferredCoding(selectedDiagnosis, "diagnosis") : null;
      const procedureCoding = selectedProcedure ? preferredCoding(selectedProcedure, "procedure") : null;
      if (diagnosis.trim()) followups.push(createCaseDiagnosis(caseId, {
        diagnosis_text: diagnosis.trim(),
        event_ts: startTimestamp,
        entry_context: "preoperative",
        concept_id: selectedDiagnosis?.id,
        local_id: selectedDiagnosis?.local_id,
        terminology_entry_id: diagnosisCoding?.terminology_entry_id,
      }));
      if (procedure.trim()) followups.push(createCaseProcedure(caseId, {
        procedure_text: procedure.trim(),
        event_ts: startTimestamp,
        entry_context: "planned",
        concept_id: selectedProcedure?.id,
        local_id: selectedProcedure?.local_id,
        terminology_entry_id: procedureCoding?.terminology_entry_id,
      }));
      if (!hasAllergies && nkaConfirmed) {
        followups.push(createCaseAllergy(caseId, { allergen: "NKA", severity: "None", status: "Active" }));
      }
      const results = await Promise.allSettled(followups);
      const failed = results.filter(result => result.status === "rejected");
      if (failed.length || preparationWarnings.length) {
        console.warn("[CASE] started with preparation sync warnings", [...preparationWarnings, ...failed]);
      }
      window.dispatchEvent(new CustomEvent("flora:case-started", { detail: { caseId, hn: started?.hn || lookup.row.hn } }));
      await onCaseStarted();
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : t("landing.startFailed");
      if (canopyAdmission && isCanopyAdmissionGone(message)) {
        // Someone else started or withdrew it: return to the refreshed list.
        resetPatient();
        setMode("prepared");
        void refreshCanopyAdmissions();
      }
      setError(message);
    } finally {
      setBusy(false);
      setOverlapChoice(false);
    }
  }

  async function completeEmergency(policy?: StartCaseOverlapPolicy) {
    setBusy(true);
    setError("");
    try {
      const started = await startCase("", startTimestamp, { overlapPolicy: policy, admissionSource: "emergency" });
      const caseId = Number(started?.case_id);
      if (!Number.isFinite(caseId) || caseId <= 0) throw new Error(t("landing.startFailed"));
      window.dispatchEvent(new CustomEvent("flora:case-started", { detail: { caseId, hn: started?.hn, admissionSource: "emergency" } }));
      await onCaseStarted();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("landing.startFailed"));
    } finally {
      setBusy(false);
      setEmergencyOverlapChoice(false);
    }
  }

  async function beginEmergency() {
    if (!Number.isFinite(startTimestamp) || busy) return;
    setBusy(true);
    setError("");
    try {
      const overlap = await getCaseStartOverlap(startTimestamp);
      setBusy(false);
      if (overlap) {
        setEmergencyOverlapChoice(true);
        return;
      }
      await completeEmergency();
    } catch (cause) {
      setBusy(false);
      setError(cause instanceof Error ? cause.message : t("landing.startFailed"));
    }
  }

  async function beginStart() {
    if (!safeToStart || !Number.isFinite(startTimestamp)) return;
    setBusy(true);
    setError("");
    try {
      const overlap = await getCaseStartOverlap(startTimestamp);
      if (overlap) {
        setOverlapChoice(true);
        setBusy(false);
        return;
      }
      setBusy(false);
      await completeStart();
    } catch (cause) {
      setBusy(false);
      setError(cause instanceof Error ? cause.message : t("landing.startFailed"));
    }
  }

  return (
    <main className="min-h-full bg-[var(--app-bg)] px-4 py-4 sm:px-6 lg:px-8">
      <div className="mx-auto max-w-[1180px] space-y-4">
        {!patientReady ? (
          <div className="space-y-4">
            <section className="rounded-2xl border border-[var(--app-border)] bg-[var(--app-panel-bg)] p-4 sm:p-5">
              <div className="mb-5 grid gap-4 border-b border-[var(--app-border)] pb-5 lg:grid-cols-[minmax(240px,1fr)_minmax(360px,1.35fr)_auto] lg:items-center">
                <div className="min-w-0">
                  <h1 className="text-sm font-bold uppercase tracking-[0.12em] text-[var(--app-muted)]">{t("admit.patientAdmission")}</h1>
                  <div className="mt-1 truncate text-xl font-bold text-[var(--app-text)]">{workstation?.hospitalName || "Hospital"}</div>
                  <div className="mt-1 text-sm text-[var(--app-muted)]">{workstation?.buildingName || "Building"}</div>
                </div>
                <div className="grid gap-2 sm:grid-cols-2">
                  <div className="rounded-xl border border-[var(--app-accent)]/30 bg-[var(--app-accent)]/10 px-4 py-3">
                    <div className="text-[11px] font-bold uppercase tracking-[0.12em] text-[var(--app-muted)]">{t("landing.careUnit")}</div>
                    <div className="mt-1 truncate text-lg font-bold text-[var(--app-text)]">{workstation?.careUnitName || "—"}</div>
                  </div>
                  <div className="rounded-xl border border-[var(--app-border)] bg-[var(--app-control-bg)] px-4 py-3">
                    <div className="text-[11px] font-bold uppercase tracking-[0.12em] text-[var(--app-muted)]">{t("landing.roomBed")}</div>
                    <div className="mt-1 flex min-w-0 items-baseline gap-2 text-lg font-bold text-[var(--app-text)]"><span className="truncate">{workstation?.roomName || "—"}</span><span className="text-[var(--app-muted)]">·</span><span className="truncate text-[var(--app-accent)]">{workstation?.bedName || "—"}</span></div>
                  </div>
                </div>
                <div className="shrink-0 lg:text-right">
                  <time className="block text-3xl font-bold tabular-nums tracking-tight text-[var(--app-text)] xl:text-4xl">{clock}</time>
                  <div className="mt-1 text-sm text-[var(--app-muted)]">{calendarDate}</div>
                  <div className="text-xs text-[var(--app-muted)]">{displayTimezone}</div>
                </div>
              </div>
              <div className="mb-3 text-sm font-bold uppercase tracking-[0.12em] text-[var(--app-muted)]">{t("admit.admissionPath")}</div>
              <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
                {(["prepared", "his", "manual", "emergency"] as AdmissionMode[]).map(item => (
                  <button key={item} type="button" onClick={() => chooseMode(item)} className={`rounded-xl border p-4 text-left transition ${mode === item ? item === "emergency" ? "border-rose-400/60 bg-rose-500/10" : "border-[var(--app-accent)] bg-[var(--app-accent)]/10" : "border-[var(--app-border)] bg-[var(--app-control-bg)] hover:border-[var(--app-accent)]/60"}`}>
                    <img src={admissionPathIcons[item]} alt="" className="mb-3 h-20 w-20 object-contain" style={{ imageRendering: "pixelated" }} />
                    <strong className="block text-base text-[var(--app-text)]">{t(`admit.${item}`)}</strong>
                    <span className="mt-1 block text-sm leading-5 text-[var(--app-muted)]">{t(`admit.${item}Help`)}</span>
                  </button>
                ))}
              </div>
              <label className="mt-4 block rounded-xl border border-[var(--app-border)] bg-[var(--app-control-bg)] p-3 text-xs font-bold uppercase tracking-[0.1em] text-[var(--app-muted)]">
                {t("landing.startTime")}
                <ClinicalDateTimeInput value={startAt} onChange={setStartAt} dateFormat={workstation?.dateFormat || "DD/MM/YYYY"} timeFormat={workstation?.timeFormat || "24h"} />
              </label>
            </section>

            {mode === "prepared" ? <section className="rounded-2xl border border-[var(--app-border)] bg-[var(--app-panel-bg)] p-5 sm:p-7">
              {error ? <div className="mb-4 rounded-xl border border-amber-400/35 bg-amber-400/10 p-4 text-sm text-[var(--app-text)]" role="alert">{error}</div> : null}
              <div className="grid gap-3 md:grid-cols-2">
                {canopyAdmissions.map(row => {
                  const name = row.patient?.patient_name || row.hn;
                  const scheduled = formatScheduled(row.scheduledAt, displayTimezone, language);
                  return (
                    <button key={`canopy-${row.id}`} type="button" disabled={busy} onClick={() => void selectCanopyAdmission(row)} className="flex w-full items-center gap-3 rounded-xl border border-[var(--app-accent)]/35 bg-[var(--app-control-bg)] p-4 text-left hover:border-[var(--app-accent)] disabled:opacity-60">
                      <span className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-[var(--app-accent)]/12 text-sm font-bold text-[var(--app-accent)]">{name.slice(0, 1).toUpperCase()}</span>
                      <span className="min-w-0 flex-1">
                        <span className="flex flex-wrap items-center gap-1.5">
                          <span className="truncate text-sm font-semibold text-[var(--app-text)]">{name}</span>
                          <span className="rounded-full bg-[var(--app-accent)]/15 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-[var(--app-accent)]">{t("landing.canopyBadge")}</span>
                          {row.preopFilled ? <span className="rounded-full bg-emerald-500/15 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-emerald-600 dark:text-emerald-400">{t("landing.preopFilled")}</span> : null}
                        </span>
                        <span className="block text-xs text-[var(--app-muted)]">HN {row.hn}{row.unitName ? ` · ${row.unitName}` : ""}{scheduled ? ` · ${scheduled}` : ""}</span>
                        {row.admission?.operation ? <span className="block truncate text-xs text-[var(--app-muted)]">{row.admission.operation}</span> : null}
                      </span>
                      <span className="text-[var(--app-accent)]">›</span>
                    </button>
                  );
                })}
                {prepared.length || canopyAdmissions.length ? prepared.map(row => (
                  <button key={row.hn} type="button" onClick={() => void loadPatient(row.hn, true)} className="flex w-full items-center gap-3 rounded-xl border border-[var(--app-border)] bg-[var(--app-control-bg)] p-4 text-left hover:border-[var(--app-accent)]">
                    <span className="inline-flex h-10 w-10 items-center justify-center rounded-full bg-[var(--app-accent)]/12 text-sm font-bold text-[var(--app-accent)]">{preparedPatientName(row, patientNameLanguage).slice(0, 1).toUpperCase()}</span>
                    <span className="min-w-0 flex-1"><span className="block truncate text-sm font-semibold text-[var(--app-text)]">{preparedPatientName(row, patientNameLanguage)}</span><span className="block text-xs text-[var(--app-muted)]">HN {row.hn} · {row.allergy_count || 0} {t("landing.allergies")} · {row.lab_count || 0} {t("landing.labs")}</span></span><span className="text-[var(--app-accent)]">›</span>
                  </button>
                )) : <div className="col-span-full rounded-xl border border-dashed border-[var(--app-border)] p-8 text-center"><div className="text-sm font-semibold text-[var(--app-text)]">{t("landing.noPreparedPatients")}</div><div className="mt-1 text-xs text-[var(--app-muted)]">{t("admit.tryHis")}</div></div>}
              </div>
            </section> : null}

            {mode === "his" ? <section className="rounded-2xl border border-[var(--app-border)] bg-[var(--app-panel-bg)] p-5 sm:p-7">
              <form onSubmit={event => { event.preventDefault(); void loadPatient(hn); }}><label htmlFor="landing-hn" className="mb-2 block text-xs font-bold uppercase tracking-[0.1em] text-[var(--app-muted)]">{t("landing.hn")}</label><div className="flex flex-col gap-2 sm:flex-row"><input id="landing-hn" autoFocus value={hn} onChange={event => setHn(event.target.value)} placeholder={t("landing.hnPlaceholder")} className="h-12 min-w-0 flex-1 rounded-xl border border-[var(--app-border)] bg-[var(--app-control-bg)] px-4 text-base text-[var(--app-text)] outline-none focus:border-[var(--app-accent)]" /><button disabled={!hn.trim() || busy} className="h-12 rounded-xl bg-[var(--app-accent)] px-6 text-sm font-bold text-[var(--app-accent-contrast)] disabled:opacity-50">{busy ? t("landing.searching") : t("landing.search")}</button></div></form>
              {demoPatients.length ? <div className="mt-5 border-t border-[var(--app-border)] pt-4">
                <div className="mb-2 flex items-center justify-between gap-3"><span className="text-xs font-bold uppercase tracking-[0.1em] text-[var(--app-muted)]">{t("landing.demoExchangePatients")}</span><span className="rounded-full border border-amber-400/30 bg-amber-400/10 px-2 py-0.5 text-[10px] font-bold uppercase text-amber-400">{t("landing.synthetic")}</span></div>
                <div className="grid gap-2 md:grid-cols-3">{demoPatients.map(patient => <div key={patient.hn} className="rounded-xl border border-[var(--app-border)] bg-[var(--app-control-bg)] p-3"><div className="flex items-center justify-between gap-2"><span className="inline-flex rounded-md bg-[var(--app-accent)]/12 px-2 py-1 text-[10px] font-bold text-[var(--app-accent)]">{patient.protocol_label}</span><button type="button" onClick={() => setCodePatient(patient)} className="rounded-md border border-[var(--app-border)] px-2 py-1 text-[10px] font-bold text-[var(--app-muted)] hover:border-[var(--app-accent)] hover:text-[var(--app-text)]">{t("landing.showCode")}</button></div><button type="button" disabled={busy} onClick={() => { setHn(patient.hn); void loadPatient(patient.hn); }} className="mt-2 block w-full text-left disabled:opacity-50"><strong className="block truncate text-sm text-[var(--app-text)]">{patientNameLanguage === "english" ? patient.patient_name_en || patient.patient_name : patient.patient_name || patient.patient_name_en}</strong><span className="mt-0.5 block text-xs text-[var(--app-muted)]">HN {patient.hn} · {patient.event}</span></button></div>)}</div>
              </div> : null}
              {error ? <div className="mt-4 rounded-xl border border-amber-400/35 bg-amber-400/10 p-4 text-sm text-[var(--app-text)]">{error}</div> : null}
            </section> : null}

            {mode === "manual" ? <section className="rounded-2xl border border-[var(--app-border)] bg-[var(--app-panel-bg)] p-5 sm:p-7">
              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                <label className="text-xs font-bold text-[var(--app-muted)]">{t("admit.patientNameRequired")}<input value={manual.name} onChange={event => setManual(current => ({ ...current, name: event.target.value }))} className="mt-2 h-11 w-full rounded-xl border border-[var(--app-border)] bg-[var(--app-control-bg)] px-3 text-sm font-normal text-[var(--app-text)] outline-none focus:border-[var(--app-accent)]" /></label>
                <label className="text-xs font-bold text-[var(--app-muted)]">{t("landing.hn")} <span className="font-normal">({t("admit.optional")})</span><input value={hn} onChange={event => setHn(event.target.value)} className="mt-2 h-11 w-full rounded-xl border border-[var(--app-border)] bg-[var(--app-control-bg)] px-3 text-sm font-normal text-[var(--app-text)] outline-none focus:border-[var(--app-accent)]" /></label>
                <label className="text-xs font-bold text-[var(--app-muted)]">AN <span className="font-normal">({t("admit.optional")})</span><input value={manual.an} onChange={event => setManual(current => ({ ...current, an: event.target.value }))} className="mt-2 h-11 w-full rounded-xl border border-[var(--app-border)] bg-[var(--app-control-bg)] px-3 text-sm font-normal text-[var(--app-text)] outline-none focus:border-[var(--app-accent)]" /></label>
                <fieldset className="sm:col-span-2 lg:col-span-3"><legend className="text-xs font-bold text-[var(--app-muted)]">{t("landing.sex")}</legend><div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-4" role="radiogroup">{(["female", "male", "other", "unknown"] as const).map(sex => <button key={sex} type="button" role="radio" aria-checked={manual.sex === sex} onClick={() => setManual(current => ({ ...current, sex }))} className={`h-11 rounded-xl border px-3 text-sm font-semibold transition ${manual.sex === sex ? "border-[var(--app-accent)] bg-[var(--app-accent)] text-[var(--app-accent-contrast)]" : "border-[var(--app-border)] bg-[var(--app-control-bg)] text-[var(--app-text)] hover:border-[var(--app-accent)]"}`}>{t(`admit.${sex}`)}</button>)}</div></fieldset>
                <div className="sm:col-span-1 lg:col-span-2"><div className="text-xs font-bold text-[var(--app-muted)]">{t("admit.age")}</div><div className="mt-2 grid grid-cols-2 gap-2"><label className="relative"><input type="number" min="0" max="130" inputMode="numeric" value={manual.ageYears} onChange={event => setManual(current => { const raw = event.target.value; const ageYears = raw === "" ? "" : String(Math.min(130, Math.max(0, Number.parseInt(raw, 10) || 0))); return { ...current, ageYears, dob: estimatedDobFromAge(ageYears, current.ageMonths), dobPrecision: ageYears || current.ageMonths ? "estimated" : "" }; })} placeholder="0" className="h-11 w-full rounded-xl border border-[var(--app-border)] bg-[var(--app-control-bg)] px-3 pr-10 text-sm text-[var(--app-text)]" /><span className="pointer-events-none absolute right-3 top-3 text-xs text-[var(--app-muted)]">{t("admit.yearsShort")}</span></label><label className="relative"><input type="number" min="0" max="11" inputMode="numeric" value={manual.ageMonths} onChange={event => setManual(current => { const raw = event.target.value; const ageMonths = raw === "" ? "" : String(Math.min(11, Math.max(0, Number.parseInt(raw, 10) || 0))); return { ...current, ageMonths, dob: estimatedDobFromAge(current.ageYears, ageMonths), dobPrecision: current.ageYears || ageMonths ? "estimated" : "" }; })} placeholder="0" className="h-11 w-full rounded-xl border border-[var(--app-border)] bg-[var(--app-control-bg)] px-3 pr-10 text-sm text-[var(--app-text)]" /><span className="pointer-events-none absolute right-3 top-3 text-xs text-[var(--app-muted)]">{t("admit.monthsShort")}</span></label></div></div>
                <label className="text-xs font-bold text-[var(--app-muted)]">{t("admit.birthdate")}<ClinicalDateInput value={manual.dob} format={workstation?.dateFormat || "DD/MM/YYYY"} maxToday onChange={dob => { const age = ageFromDob(dob); setManual(current => ({ ...current, dob, dobPrecision: dob ? "exact" : "", ageYears: age.years, ageMonths: age.months })); }} />{manual.dob ? <span className="mt-1 block text-xs font-normal text-[var(--app-muted)]">{manual.dobPrecision === "estimated" ? `${t("admit.estimated")}: ` : ""}{formattedProfileDate(new Date(`${manual.dob}T12:00:00`), displayTimezone, workstation?.dateFormat || "DD/MM/YYYY")}</span> : null}</label>
                <label className="text-xs font-bold text-[var(--app-muted)]">{t("admit.weightKg")}<input type="number" min="0.1" max="500" step="0.1" value={manual.weight} onChange={event => setManual(current => ({ ...current, weight: event.target.value }))} className="mt-2 h-11 w-full rounded-xl border border-[var(--app-border)] bg-[var(--app-control-bg)] px-3 text-sm font-normal text-[var(--app-text)]" /></label>
              </div>
              {error ? <div className="mt-4 rounded-xl border border-amber-400/35 bg-amber-400/10 p-3 text-sm text-[var(--app-text)]">{error}</div> : null}
              <button type="button" onClick={useManualPatient} className="mt-5 h-11 rounded-xl bg-[var(--app-accent)] px-6 text-sm font-bold text-[var(--app-accent-contrast)]">{t("admit.continuePreparation")}</button>
            </section> : null}

            {mode === "emergency" ? <section className="rounded-2xl border border-rose-400/40 bg-rose-500/8 p-5 sm:p-7">
              {error ? <div className="mt-4 rounded-xl border border-rose-400/35 bg-rose-500/10 p-3 text-sm text-rose-400">{error}</div> : null}
              {emergencyOverlapChoice ? <div className="mt-4 grid gap-2 sm:grid-cols-2"><button type="button" onClick={() => void completeEmergency("exclude")} className="h-11 rounded-xl bg-rose-500 px-4 text-sm font-bold text-white">{t("landing.startAfterPrevious")}</button><button type="button" onClick={() => void completeEmergency("include")} className="h-11 rounded-xl border border-rose-400/40 px-4 text-sm font-bold text-rose-400">{t("landing.includeOverlap")}</button></div> : <button type="button" disabled={busy} onClick={() => void beginEmergency()} className="mt-5 h-12 rounded-xl bg-rose-500 px-6 text-sm font-bold text-white hover:bg-rose-400 disabled:opacity-50">{busy ? t("landing.starting") : t("admit.startEmergency")}</button>}
            </section> : null}
          </div>
        ) : (
          <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_360px]">
            <div className="space-y-5">
              <section className="overflow-hidden rounded-2xl border border-[var(--app-border)] bg-[var(--app-panel-bg)]">
                <div className="flex items-start justify-between gap-4 border-b border-[var(--app-border)] p-5">
                  <div className="flex min-w-0 items-center gap-4">
                    <span className="inline-flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-[var(--app-accent)]/12 text-lg font-bold text-[var(--app-accent)]">{patientName(lookup, patientNameLanguage).slice(0, 1).toUpperCase() || "P"}</span>
                    <div className="min-w-0"><div className="text-xs font-bold uppercase tracking-[0.12em] text-[var(--app-accent)]">{t("landing.patientConfirmed")}</div><h2 className="truncate text-xl font-bold text-[var(--app-text)]">{patientName(lookup, patientNameLanguage) || t("landing.manualPatientName")}</h2><div className="mt-1 text-sm text-[var(--app-muted)]">{lookup?.row?.hn ? `HN ${lookup.row.hn}` : t("admit.localIdOnStart")}{lookup?.row?.an ? ` · AN ${lookup.row.an}` : ""} · {sourceLabel}{lookup?.exchange ? ` · ${lookup.exchange.event}` : ""}</div>{lookup?.exchange ? <div className="mt-1 text-xs text-[var(--app-muted)]">{lookup.exchange.source_system} · {lookup.exchange.message_id} · {t("landing.synthetic")}</div> : null}</div>
                  </div>
                  <button type="button" onClick={resetPatient} className="rounded-lg border border-[var(--app-border)] px-3 py-2 text-xs font-semibold text-[var(--app-muted)] hover:text-[var(--app-text)]">{t("landing.change")}</button>
                </div>
                <div className="grid gap-px bg-[var(--app-border)] sm:grid-cols-4">
                  {[[t("landing.sex"), lookup?.row?.sex || "—"], [t("landing.dob"), mode === "manual" && lookup?.row?.age_text ? `${lookup.row.age_text} · ${lookup.row.dob}${manual.dobPrecision === "estimated" ? ` (${t("admit.estimated")})` : ""}` : lookup?.row?.dob || lookup?.row?.age_text || "—"], [t("landing.bloodGroup"), lookup?.row?.blood_group_text || [lookup?.row?.blood_group_abo, lookup?.row?.blood_group_rh].filter(Boolean).join("") || "—"], [t("landing.labs"), String(lookup?.labs.length || 0)]].map(([label, value]) => <div key={label} className="bg-[var(--app-panel-bg)] px-5 py-4"><div className="text-[10px] font-bold uppercase tracking-[0.1em] text-[var(--app-muted)]">{label}</div><div className="mt-1 text-sm font-semibold text-[var(--app-text)]">{value}</div></div>)}
                </div>
                {lookup?.exchange?.encounter ? <div className="border-t border-[var(--app-border)] p-4"><div className="mb-2 text-[10px] font-bold uppercase tracking-[0.12em] text-[var(--app-muted)]">{t("landing.encounter")}</div><div className="grid gap-2 sm:grid-cols-5">{[[t("landing.encounterClass"), lookup.exchange.encounter.class], [t("landing.service"), lookup.exchange.encounter.service], [t("landing.priority"), lookup.exchange.encounter.priority], [t("landing.encounterLocation"), lookup.exchange.encounter.location], [t("landing.attending"), lookup.exchange.encounter.attending]].map(([label, value]) => <div key={label} className="rounded-lg bg-[var(--app-control-bg)] px-3 py-2"><div className="text-[10px] text-[var(--app-muted)]">{label}</div><div className="mt-0.5 truncate text-xs font-semibold text-[var(--app-text)]">{value || "—"}</div></div>)}</div></div> : null}
              </section>

              <section className={`rounded-2xl border p-5 ${hasAllergies ? "border-rose-400/40 bg-rose-500/8" : "border-amber-400/35 bg-amber-400/8"}`}>
                <div className="flex items-start gap-3">
                  <FieldIcon>!</FieldIcon>
                  <div className="min-w-0 flex-1">
                    <h2 className="text-base font-bold text-[var(--app-text)]">{t("landing.allergyReview")}</h2>
                    {hasAllergies ? <div className="mt-2 flex flex-wrap gap-2">{lookup?.allergies.map(item => <span key={item.id} className="rounded-full border border-rose-400/35 bg-rose-500/12 px-3 py-1 text-xs font-bold text-rose-400">{item.allergen}{item.reaction ? ` · ${item.reaction}` : ""}</span>)}</div> : <p className="mt-1 text-sm text-[var(--app-muted)]">{t("landing.noAllergyRecord")}</p>}
                    {!hasAllergies ? <label className="mt-3 flex cursor-pointer items-center gap-2 text-sm font-semibold text-[var(--app-text)]"><input type="checkbox" checked={nkaConfirmed} onChange={event => { setNkaConfirmed(event.target.checked); setAllergyReviewed(event.target.checked); }} className="h-4 w-4 accent-[var(--app-accent)]" />{t("landing.confirmNka")}</label> : <label className="mt-3 flex cursor-pointer items-center gap-2 text-sm font-semibold text-[var(--app-text)]"><input type="checkbox" checked={allergyReviewed} onChange={event => setAllergyReviewed(event.target.checked)} className="h-4 w-4 accent-[var(--app-accent)]" />{t("landing.confirmAllergyReviewed")}</label>}
                  </div>
                </div>
              </section>

              <section className="rounded-2xl border border-[var(--app-border)] bg-[var(--app-panel-bg)] p-5">
                <div className="flex items-start gap-3"><FieldIcon><span className="text-lg">2</span></FieldIcon><div><h2 className="text-base font-bold text-[var(--app-text)]">{t("landing.plannedCare")}</h2><p className="text-sm text-[var(--app-muted)]">{t("landing.plannedCareHelp")}</p></div></div>
                <div className="mt-5 grid gap-4 sm:grid-cols-2">
                  <label className="relative text-xs font-bold text-[var(--app-muted)]">{t("landing.operationRequired")}<textarea value={procedure} onChange={event => { setProcedure(event.target.value); setSelectedProcedure(null); }} rows={3} className="mt-2 w-full resize-none rounded-xl border border-[var(--app-border)] bg-[var(--app-control-bg)] p-3 text-sm font-normal text-[var(--app-text)] outline-none focus:border-[var(--app-accent)]" />{selectedProcedure ? <span className="mt-1 block text-[10px] text-[var(--app-accent)]">{codingLabel(selectedProcedure, "procedure")}</span> : null}{procedureMatches.length ? <span className="absolute left-0 right-0 top-full z-30 mt-1 max-h-64 overflow-auto rounded-xl border border-[var(--app-border)] bg-[var(--app-panel-bg)] p-1 shadow-2xl">{procedureMatches.map(item => <button key={item.id} type="button" onClick={() => { setProcedure(item.local_name); setSelectedProcedure(item); setProcedureMatches([]); }} className="flex w-full items-start gap-3 rounded-lg px-3 py-2 text-left hover:bg-[var(--app-control-bg)]"><span className="min-w-24 rounded-md bg-[var(--app-accent)]/12 px-2 py-1 text-[10px] font-bold text-[var(--app-accent)]">{codingLabel(item, "procedure")}</span><span className="pt-0.5 text-xs font-semibold text-[var(--app-text)]">{item.local_name}</span></button>)}</span> : null}</label>
                  <label className="relative text-xs font-bold text-[var(--app-muted)]">{t("landing.diagnosis")}<textarea value={diagnosis} onChange={event => { setDiagnosis(event.target.value); setSelectedDiagnosis(null); }} rows={3} className="mt-2 w-full resize-none rounded-xl border border-[var(--app-border)] bg-[var(--app-control-bg)] p-3 text-sm font-normal text-[var(--app-text)] outline-none focus:border-[var(--app-accent)]" />{selectedDiagnosis ? <span className="mt-1 block text-[10px] text-[var(--app-accent)]">{codingLabel(selectedDiagnosis, "diagnosis")}</span> : null}{diagnosisMatches.length ? <span className="absolute left-0 right-0 top-full z-30 mt-1 max-h-64 overflow-auto rounded-xl border border-[var(--app-border)] bg-[var(--app-panel-bg)] p-1 shadow-2xl">{diagnosisMatches.map(item => <button key={item.id} type="button" onClick={() => { setDiagnosis(item.local_name); setSelectedDiagnosis(item); setDiagnosisMatches([]); }} className="flex w-full items-start gap-3 rounded-lg px-3 py-2 text-left hover:bg-[var(--app-control-bg)]"><span className="min-w-24 rounded-md bg-[var(--app-accent)]/12 px-2 py-1 text-[10px] font-bold text-[var(--app-accent)]">{codingLabel(item, "diagnosis")}</span><span className="pt-0.5 text-xs font-semibold text-[var(--app-text)]">{item.local_name}</span></button>)}</span> : null}</label>
                </div>
                <div className="mt-4 grid gap-4 lg:grid-cols-3">
                  <fieldset><legend className="text-xs font-bold text-[var(--app-muted)]">{t("landing.anaesthesiaTechnique")}</legend><div className="mt-2 flex flex-wrap gap-1.5">{["GA", "RA", "MAC", "Local", "Combined"].map(value => <button key={value} type="button" onClick={() => setAnaesthesiaTechnique(value)} className={`rounded-lg border px-3 py-2 text-xs font-bold ${anaesthesiaTechnique === value ? "border-[var(--app-accent)] bg-[var(--app-accent)] text-[var(--app-accent-contrast)]" : "border-[var(--app-border)] bg-[var(--app-control-bg)] text-[var(--app-text)]"}`}>{value}</button>)}</div></fieldset>
                  <fieldset><legend className="text-xs font-bold text-[var(--app-muted)]">{t("landing.asaStatus")}</legend><div className="mt-2 flex flex-wrap gap-1.5">{["I", "II", "III", "IV", "V", "VI"].map(value => <button key={value} type="button" onClick={() => setAsaStatus(value)} className={`h-9 min-w-9 rounded-lg border px-2 text-xs font-bold ${asaStatus === value ? "border-[var(--app-accent)] bg-[var(--app-accent)] text-[var(--app-accent-contrast)]" : "border-[var(--app-border)] bg-[var(--app-control-bg)] text-[var(--app-text)]"}`}>{value}</button>)}<button type="button" onClick={() => setAsaEmergency(value => !value)} className={`h-9 rounded-lg border px-3 text-xs font-bold ${asaEmergency ? "border-rose-400 bg-rose-500/15 text-rose-400" : "border-[var(--app-border)] bg-[var(--app-control-bg)] text-[var(--app-text)]"}`}>E</button></div></fieldset>
                  <fieldset><legend className="text-xs font-bold text-[var(--app-muted)]">{t("landing.surgicalPriority")}</legend><div className="mt-2 flex flex-wrap gap-1.5">{["elective", "urgent", "emergency"].map(value => <button key={value} type="button" onClick={() => setSurgicalPriority(value)} className={`rounded-lg border px-3 py-2 text-xs font-bold ${surgicalPriority === value ? "border-[var(--app-accent)] bg-[var(--app-accent)] text-[var(--app-accent-contrast)]" : "border-[var(--app-border)] bg-[var(--app-control-bg)] text-[var(--app-text)]"}`}>{t(`landing.priority.${value}`)}</button>)}</div></fieldset>
                </div>
              </section>
            </div>

            <aside className="h-fit rounded-2xl border border-[var(--app-border)] bg-[var(--app-panel-bg)] p-5 lg:sticky lg:top-5">
              <h2 className="text-base font-bold text-[var(--app-text)]">{t("landing.startSummary")}</h2>
              <div className="mt-4 space-y-3">
                <div className="rounded-xl bg-[var(--app-control-bg)] p-3"><div className="text-[10px] font-bold uppercase tracking-[0.1em] text-[var(--app-muted)]">{t("landing.location")}</div><div className="mt-1 text-sm font-semibold text-[var(--app-text)]">{t("landing.thisWorkstation")}</div></div>
                <div className="rounded-xl bg-[var(--app-control-bg)] p-3"><div className="text-[10px] font-bold uppercase tracking-[0.1em] text-[var(--app-muted)]">{t("landing.responsibleClinician")}</div><div className="mt-1 text-sm font-semibold text-[var(--app-text)]">{clinician}</div><div className="text-xs text-[var(--app-muted)]">{sessionUser?.role || "—"}</div></div>
                <label className="block rounded-xl bg-[var(--app-control-bg)] p-3"><span className="text-[10px] font-bold uppercase tracking-[0.1em] text-[var(--app-muted)]">{t("landing.startTime")}</span><ClinicalDateTimeInput value={startAt} onChange={setStartAt} dateFormat={workstation?.dateFormat || "DD/MM/YYYY"} timeFormat={workstation?.timeFormat || "24h"} /></label>
              </div>
              <div className="mt-4 space-y-2 text-xs">
                <div className={patientReady ? "text-emerald-500" : "text-[var(--app-muted)]"}>✓ {t("landing.identityChecked")}</div>
                <div className={allergyReviewed ? "text-emerald-500" : "text-amber-500"}>{allergyReviewed ? "✓" : "○"} {t("landing.allergyChecked")}</div>
                <div className={procedure.trim() ? "text-emerald-500" : "text-amber-500"}>{procedure.trim() ? "✓" : "○"} {t("landing.operationChecked")}</div>
              </div>
              {error ? <div className="mt-4 rounded-xl border border-rose-400/35 bg-rose-500/10 p-3 text-xs text-rose-400">{error}</div> : null}
              {overlapChoice ? <div className="mt-4 rounded-xl border border-amber-400/35 bg-amber-400/10 p-3"><div className="text-xs font-semibold text-[var(--app-text)]">{t("landing.overlapWarning")}</div><div className="mt-3 grid gap-2"><button type="button" onClick={() => void completeStart("exclude")} className="rounded-lg bg-[var(--app-accent)] px-3 py-2 text-xs font-bold text-[var(--app-accent-contrast)]">{t("landing.startAfterPrevious")}</button><button type="button" onClick={() => void completeStart("include")} className="rounded-lg border border-[var(--app-border)] px-3 py-2 text-xs font-semibold text-[var(--app-text)]">{t("landing.includeOverlap")}</button></div></div> : <button type="button" disabled={!safeToStart} onClick={() => void beginStart()} className="mt-5 h-12 w-full rounded-xl bg-[var(--app-accent)] text-sm font-bold text-[var(--app-accent-contrast)] shadow-lg shadow-black/10 transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-45">{busy ? t("landing.starting") : t("landing.startCase")}</button>}
              <p className="mt-3 text-center text-[11px] leading-4 text-[var(--app-muted)]">{t("landing.startNote")}</p>
            </aside>
          </div>
        )}
      </div>
      {codePatient ? <div className="app-theme-scope fixed inset-0 z-[1200] flex items-center justify-center bg-black/60 p-3" role="dialog" aria-modal="true" onMouseDown={() => setCodePatient(null)}><div className="flex max-h-[88vh] w-full max-w-4xl flex-col overflow-hidden rounded-2xl border border-[var(--app-border)] bg-[var(--app-panel-bg)] shadow-2xl" onMouseDown={event => event.stopPropagation()}><div className="flex items-center justify-between gap-3 border-b border-[var(--app-border)] p-4"><div><div className="text-xs font-bold uppercase tracking-[0.12em] text-[var(--app-accent)]">{codePatient.protocol_label} · {codePatient.sample_format}</div><h2 className="mt-1 text-lg font-bold text-[var(--app-text)]">{t("landing.exchangeMessage")}</h2></div><div className="flex gap-2"><button type="button" onClick={() => void navigator.clipboard.writeText(codePatient.sample)} className="rounded-lg border border-[var(--app-border)] px-3 py-2 text-xs font-bold text-[var(--app-text)]">{t("landing.copy")}</button><button type="button" onClick={() => setCodePatient(null)} aria-label="Close" className="h-9 w-9 rounded-lg border border-[var(--app-border)] text-lg text-[var(--app-text)]">×</button></div></div><pre className="m-0 overflow-auto whitespace-pre-wrap break-words bg-[var(--app-control-bg)] p-5 font-mono text-xs leading-5 text-[var(--app-text)]">{codePatient.sample}</pre><div className="border-t border-[var(--app-border)] px-5 py-3 text-xs text-[var(--app-muted)]">HN {codePatient.hn} · {codePatient.source_system} · {t("landing.synthetic")}</div></div></div> : null}
    </main>
  );
}
