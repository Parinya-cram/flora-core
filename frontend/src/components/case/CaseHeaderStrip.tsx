import { useEffect, useState } from "react";
import type { CaseStatus } from "../../api/caseApi";
import { getCaseDiagnosis, getCaseProcedures, type CaseDiagnosisRow, type CaseProcedureRow } from "../../api/caseClinicalApi";
import { getCaseAllergies, getCasePatientInfo, type CaseAllergyRow, type CasePatientInfo } from "../../api/caseHisApi";
import type { AuthUser } from "../../auth/useAuth";
import { useWorkstationSettings } from "../../hooks/useWorkstationSettings";
import { formatConfiguredDateTime } from "../../utils/dateTime";
import { formatPatientDisplayName, normalizePatientNameLanguage } from "../../utils/patientName";
import { readStoredUsername } from "../../views/clinical-chart/storage";
import allergyCardIcon from "../../assets/cards/card-allergy.png";
import patientCardIcon from "../../assets/cards/card-patient.png";
import timeCardIcon from "../../assets/cards/card-time.png";
import diagnosisCardIcon from "../../assets/cards/card-diagnosis.png";
import procedureCardIcon from "../../assets/cards/card-procedure.png";
import HeaderCard from "./HeaderCard";
import { isNkaAllergen, readCaseHeaderOrder } from "./caseHeaderOrder";

type OpenCase = Exclude<CaseStatus, { status: "IDLE" }>;
type Props = {
  caseStatus: OpenCase;
  sessionUser: AuthUser | null;
  onNavigate?: (view: "patient" | "diagnosis" | "io" | "case") => void;
};

const bySeq = <T extends { seq?: unknown; event_ts?: unknown }>(rows: T[]) =>
  [...rows].sort((a, b) => (Number(a.seq) || 0) - (Number(b.seq) || 0) || (Number(a.event_ts) || 0) - (Number(b.event_ts) || 0));

function age(patient: CasePatientInfo | null): string {
  const saved = String(patient?.age_text || "").trim();
  if (saved) return saved;
  const dobText = String(patient?.dob || "").trim();
  const dob = dobText ? new Date(dobText.includes("T") ? dobText : `${dobText}T00:00:00`) : null;
  if (!dob || !Number.isFinite(dob.getTime())) return "Age not recorded";
  const today = new Date();
  let years = today.getFullYear() - dob.getFullYear();
  let months = today.getMonth() - dob.getMonth();
  if (today.getDate() < dob.getDate()) months -= 1;
  if (months < 0) { years -= 1; months += 12; }
  if (years < 0) return "Age not recorded";
  return years > 0 ? `${years} y${months ? ` ${months} m` : ""}` : `${Math.max(0, months)} m`;
}

const elapsed = (ms: number) => {
  const minutes = Math.max(0, Math.floor(ms / 60_000));
  return `${Math.floor(minutes / 60)} hr ${minutes % 60} min`;
};

/**
 * The Chart's case summary cards (LOS, patient, allergy, diagnosis, operation) on every other case page,
 * in the same order, so the clinician always sees which patient and case they are working on.
 * Clicking a card opens the page where it is edited.
 */
export default function CaseHeaderStrip({ caseStatus, sessionUser, onNavigate }: Props) {
  const workstation = useWorkstationSettings();
  const caseId = caseStatus.case_id;
  const [patient, setPatient] = useState<{ caseId: number; patient: CasePatientInfo | null; allergies: CaseAllergyRow[] } | null>(null);
  const [clinical, setClinical] = useState<{ caseId: number; diagnosis: CaseDiagnosisRow[]; operations: CaseProcedureRow[] } | null>(null);
  const [nowTs, setNowTs] = useState(() => Date.now());
  const order = readCaseHeaderOrder(sessionUser?.username || readStoredUsername());

  useEffect(() => {
    let alive = true;
    const loadPatient = async () => {
      const [info, allergies] = await Promise.allSettled([getCasePatientInfo(caseId), getCaseAllergies(caseId)]);
      if (alive) setPatient({ caseId, patient: info.status === "fulfilled" ? info.value : null, allergies: allergies.status === "fulfilled" ? allergies.value : [] });
    };
    const loadClinical = async () => {
      const [diagnosis, operations] = await Promise.allSettled([getCaseDiagnosis(caseId), getCaseProcedures(caseId)]);
      if (alive) setClinical({ caseId, diagnosis: diagnosis.status === "fulfilled" ? bySeq(diagnosis.value) : [], operations: operations.status === "fulfilled" ? bySeq(operations.value) : [] });
    };
    const onPatientChanged = (event: Event) => {
      const changed = Number((event as CustomEvent<{ caseId?: number }>).detail?.caseId);
      if (!Number.isFinite(changed) || changed === caseId) void loadPatient();
    };
    const onClinicalChanged = (event: Event) => {
      if ((event as CustomEvent<{ caseId?: number }>).detail?.caseId === caseId) void loadClinical();
    };
    void loadPatient();
    void loadClinical();
    const patientEvents = ["flora:his-synced", "flora:case-hn-updated", "flora:allergy-changed"];
    patientEvents.forEach(name => window.addEventListener(name, onPatientChanged));
    window.addEventListener("flora:clinical-changed", onClinicalChanged);
    const timer = window.setInterval(() => setNowTs(Date.now()), 30_000);
    return () => {
      alive = false;
      patientEvents.forEach(name => window.removeEventListener(name, onPatientChanged));
      window.removeEventListener("flora:clinical-changed", onClinicalChanged);
      window.clearInterval(timer);
    };
  }, [caseId]);

  const patientLoaded = patient?.caseId === caseId;
  const info = patientLoaded ? patient.patient : null;
  const allergies = patientLoaded ? patient.allergies : [];
  const clinicalLoaded = clinical?.caseId === caseId;
  const diagnosis = clinicalLoaded ? clinical.diagnosis : [];
  const operations = clinicalLoaded ? clinical.operations : [];
  const clock = (ts: number) => formatConfiguredDateTime(ts, workstation);
  const name = patientLoaded
    ? formatPatientDisplayName(info, normalizePatientNameLanguage(sessionUser?.parameterPreferences?.patientNameLanguage)) || "Patient name not recorded"
    : "Loading…";
  const nka = allergies.length > 0 && allergies.every(row => isNkaAllergen(row.allergen));
  const endTs = caseStatus.status === "ACTIVE" ? nowTs : caseStatus.discharge_time || nowTs;
  const statusText = caseStatus.status === "ACTIVE" ? undefined : `${caseStatus.status === "DISCHARGED" ? "Discharged" : "Archived"}${caseStatus.discharge_time ? ` ${clock(caseStatus.discharge_time)}` : ""}`;
  const listTooltip = (title: string, rows: string[]) => rows.length ? [`${title} · ${rows.length}`, ...rows.map((row, i) => `${i + 1}. ${row}`)].join("\n") : `${title}\nNot recorded`;

  const cards = {
    los: <HeaderCard group="Case LOS" icon={timeCardIcon} main={elapsed(endTs - caseStatus.start_time)} emphasis
      sub1={<><b>Started</b> {clock(caseStatus.start_time)}</>} sub2={statusText}
      tooltip={`CASE LOS\nStarted ${clock(caseStatus.start_time)}${statusText ? `\n${statusText}` : ""}\nClick to open the chart`}
      onClick={() => onNavigate?.("case")} ariaLabel="Open the chart" />,
    patient: <HeaderCard group="Patient" icon={patientCardIcon} main={name}
      sub1={<><b>HN {caseStatus.hn}</b> · {patientLoaded ? age(info) : "…"} · {patientLoaded ? String(info?.sex || "Sex not recorded") : "…"}</>}
      sub2={info?.an ? <>AN {info.an}</> : undefined}
      tooltip={`PATIENT\n${name}\nHN ${caseStatus.hn}${info?.an ? ` · AN ${info.an}` : ""}\nClick to view patient information`}
      onClick={() => onNavigate?.("patient")} ariaLabel="Open patient information" />,
    allergy: <HeaderCard group="Allergy" icon={allergyCardIcon} count={nka ? undefined : allergies.length || undefined}
      main={!patientLoaded ? "Loading…" : nka ? "No Known Allergies" : allergies.length ? allergies.map(row => row.allergen).filter(Boolean).join(" · ") : "No allergy recorded"}
      sub1={nka ? "Confirmed NKA" : allergies.length ? allergies.map(row => [row.reaction, row.severity].filter(Boolean).join(" · ")).filter(Boolean).join(" | ") || "Recorded allergy" : "Review patient allergy"}
      tooltip={listTooltip("ALLERGY", allergies.map(row => [row.allergen, row.reaction, row.severity].filter(Boolean).join(" · ")))}
      onClick={() => onNavigate?.("patient")} ariaLabel="Open allergy information" tone={nka ? "success" : allergies.length ? "alert" : "default"} />,
    diagnosis: <HeaderCard group="Diagnosis" icon={diagnosisCardIcon} count={clinicalLoaded ? diagnosis.length : undefined}
      main={diagnosis[0]?.diagnosis_text || (clinicalLoaded ? "Not recorded" : "Loading…")}
      sub1={diagnosis[0] ? <>{diagnosis[0].entry_context === "preoperative" ? "Pre-op" : diagnosis[0].entry_context} · {clock(diagnosis[0].event_ts)} · {diagnosis[0].icd_code || "Local"}</> : undefined}
      sub2={diagnosis.length > 1 ? <><b>2.</b> {diagnosis[1].diagnosis_text}{diagnosis.length > 2 ? ` · +${diagnosis.length - 2} more` : ""}</> : undefined}
      tooltip={listTooltip("DIAGNOSIS", diagnosis.map(row => `${row.diagnosis_text} · ${row.icd_code || "Local"}`))}
      onClick={() => onNavigate?.("diagnosis")} ariaLabel="Open diagnosis records" />,
    operation: <HeaderCard group="Operation" icon={procedureCardIcon} count={clinicalLoaded ? operations.length : undefined}
      main={operations[0]?.procedure_text || (clinicalLoaded ? "Not recorded" : "Loading…")}
      sub1={operations[0] ? <>{operations[0].entry_context === "planned" ? "Planned" : "Performed"} · {clock(operations[0].event_ts)} · {operations[0].icd_code || "Local"}</> : undefined}
      sub2={operations.length > 1 ? <><b>2.</b> {operations[1].procedure_text}{operations.length > 2 ? ` · +${operations.length - 2} more` : ""}</> : undefined}
      tooltip={listTooltip("OPERATION / PROCEDURE", operations.map(row => `${row.procedure_text} · ${row.icd_code || "Local"}`))}
      onClick={() => onNavigate?.("diagnosis")} ariaLabel="Open operation records" />,
  };

  return (
    <div className="case-kronos case-header-strip shrink-0 rounded-xl border px-3 py-2 text-xs" aria-label="Current case">
      <div className="case-header-grid">
        {order.map(id => <div key={id} className="case-header-card-slot">{cards[id]}</div>)}
      </div>
    </div>
  );
}
