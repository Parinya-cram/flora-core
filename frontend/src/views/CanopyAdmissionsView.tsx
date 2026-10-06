import { useCallback, useEffect, useMemo, useState, type FormEvent, type ReactNode } from "react";
import {
  cancelAdmission,
  createAdmission,
  formatAdmissionTime,
  getAdmissionOptions,
  listAdmissions,
  updateAdmission,
  type Admission,
  type AdmissionInput,
  type AdmissionListFilter,
  type AdmissionWardOption,
} from "../api/admissionApi";
import { lookupHl7Patient, type AdmissionSourceFields } from "../api/hl7InterfaceApi";
import type { AuthUser } from "../auth/useAuth";
import ConfirmDialog from "../components/common/ConfirmDialog";
import CanopyAdmissionFormEditor from "./CanopyAdmissionFormEditor";
import { AdmissionCaseBadge, AdmissionStatusBadge } from "./CanopyAdmissionStatusBadge";

type Props = { sessionUser: AuthUser | null };

const FILTERS: Array<{ id: AdmissionListFilter; label: string }> = [
  { id: "open", label: "Open" },
  { id: "all", label: "All" },
  { id: "cancelled", label: "Cancelled" },
];
const LIST_REFRESH_MS = 15_000;
const TECHNIQUES = ["GA", "RA", "MAC", "Local", "Combined"];
const ASA_CLASSES = ["I", "II", "III", "IV", "V", "VI"];
const PRIORITIES = ["elective", "urgent", "emergency"];
const SEXES = [
  { value: "female", label: "Female" },
  { value: "male", label: "Male" },
  { value: "other", label: "Other" },
  { value: "unknown", label: "Unknown" },
];

type Draft = {
  unitKey: string;
  targetLeafId: string;
  hn: string;
  an: string;
  name: string;
  sex: string;
  dob: string;
  ageText: string;
  weight: string;
  height: string;
  diagnosis: string;
  operation: string;
  technique: string;
  asa: string;
  asaEmergency: boolean;
  priority: string;
  surgeon: string;
  scheduledAt: string;
  note: string;
};

const fieldClass = "mt-1.5 h-12 w-full rounded-xl border border-[var(--app-control-border)] bg-[var(--app-control-bg)] px-3 text-base font-normal text-[var(--app-text)] outline-none transition focus:border-[var(--app-accent)] focus:ring-2 focus:ring-[var(--app-accent)]/15";
const labelClass = "block text-xs font-bold uppercase tracking-[0.08em] text-[var(--app-muted)]";
const primaryButton = "inline-flex h-12 items-center justify-center rounded-xl bg-[var(--app-accent)] px-5 text-sm font-bold text-[var(--app-accent-contrast)] hover:brightness-105 disabled:cursor-not-allowed disabled:opacity-50";
const secondaryButton = "inline-flex h-12 items-center justify-center rounded-xl border border-[var(--app-border)] bg-[var(--app-control-bg)] px-4 text-sm font-semibold text-[var(--app-text)] hover:bg-[var(--app-control-bg-hover)] disabled:cursor-not-allowed disabled:opacity-50";

function toLocalInput(ms: number | null | undefined): string {
  if (!ms) return "";
  const date = new Date(ms);
  return new Date(ms - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}

function emptyDraft(unitKey: string): Draft {
  return {
    unitKey, targetLeafId: "", hn: "", an: "", name: "", sex: "", dob: "", ageText: "", weight: "", height: "",
    diagnosis: "", operation: "", technique: "", asa: "", asaEmergency: false, priority: "elective", surgeon: "",
    scheduledAt: "", note: "",
  };
}

function draftFromAdmission(row: Admission): Draft {
  return {
    unitKey: row.unitKey,
    targetLeafId: row.targetLeafId || "",
    hn: row.hn,
    an: row.admissionNumber || "",
    name: row.patient?.patient_name || "",
    sex: row.patient?.sex || "",
    dob: row.patient?.dob || "",
    ageText: row.patient?.age_text || "",
    weight: row.patient?.weight_kg != null ? String(row.patient.weight_kg) : "",
    height: row.patient?.height_cm != null ? String(row.patient.height_cm) : "",
    diagnosis: row.admission?.diagnosis || "",
    operation: row.admission?.operation || "",
    technique: row.admission?.anaesthesia_technique || "",
    asa: row.admission?.asa_status || "",
    asaEmergency: Boolean(row.admission?.asa_emergency),
    priority: row.admission?.surgical_priority || "",
    surgeon: row.admission?.surgeon || "",
    scheduledAt: toLocalInput(row.scheduledAt),
    note: row.note || "",
  };
}

function positiveNumber(value: string): number | null {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function inputFromDraft(draft: Draft): AdmissionInput {
  const optional = (value: string) => value.trim() || null;
  const scheduled = draft.scheduledAt ? new Date(draft.scheduledAt).getTime() : NaN;
  return {
    unit_key: draft.unitKey,
    target_leaf_id: draft.targetLeafId || null,
    hn: draft.hn.trim(),
    admission_number: optional(draft.an),
    patient: {
      patient_name: draft.name.trim(),
      sex: optional(draft.sex),
      dob: optional(draft.dob),
      age_text: optional(draft.ageText),
      weight_kg: positiveNumber(draft.weight),
      height_cm: positiveNumber(draft.height),
    },
    admission: {
      diagnosis: optional(draft.diagnosis),
      operation: optional(draft.operation),
      anaesthesia_technique: optional(draft.technique),
      asa_status: optional(draft.asa),
      asa_emergency: draft.asaEmergency,
      surgical_priority: optional(draft.priority),
      surgeon: optional(draft.surgeon),
    },
    scheduled_at: Number.isFinite(scheduled) && scheduled > 0 ? scheduled : null,
    note: optional(draft.note),
  };
}

function normalizeHisSex(value: string | null | undefined): string {
  const code = String(value || "").trim().toLowerCase();
  if (code === "f" || code === "female") return "female";
  if (code === "m" || code === "male") return "male";
  if (code === "o" || code === "other" || code === "a") return "other";
  if (code === "u" || code === "unknown") return "unknown";
  return "";
}

function AdmissionSourceBadges({ row }: { row: Admission }) {
  const extra = row as Admission & AdmissionSourceFields;
  const source = String(extra.source || "").toLowerCase();
  const badge = source === "hl7" ? "HL7" : source === "api" ? "API" : "";
  if (!badge && !extra.accessionNumber && !extra.appointmentId) return null;
  return (
    <div className="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-[var(--app-muted)]">
      {badge ? <span className="rounded-full border border-sky-500/40 bg-sky-500/10 px-2 py-0.5 text-[10px] font-extrabold uppercase tracking-[0.1em] text-sky-700 dark:text-sky-300" title={badge === "HL7" ? "Created from an HL7 message" : "Created through the public API"}>{badge}</span> : null}
      {extra.accessionNumber ? <span>Accession <span className="font-mono text-[var(--app-text)]">{extra.accessionNumber}</span></span> : null}
      {extra.accessionNumber && extra.appointmentId ? <span aria-hidden="true">·</span> : null}
      {extra.appointmentId ? <span>Appointment <span className="font-mono text-[var(--app-text)]">{extra.appointmentId}</span></span> : null}
    </div>
  );
}

function ChoiceRow({ options, value, onChange, label }: { options: Array<{ value: string; label: string }>; value: string; onChange: (value: string) => void; label: string }) {
  return (
    <div className="mt-1.5 flex flex-wrap gap-2" role="radiogroup" aria-label={label}>
      {options.map(option => (
        <button
          key={option.value}
          type="button"
          role="radio"
          aria-checked={value === option.value}
          onClick={() => onChange(value === option.value ? "" : option.value)}
          className={`h-12 min-w-12 rounded-xl border px-4 text-sm font-bold transition ${value === option.value ? "border-[var(--app-accent)] bg-[var(--app-accent)] text-[var(--app-accent-contrast)]" : "border-[var(--app-border)] bg-[var(--app-control-bg)] text-[var(--app-text)] hover:border-[var(--app-accent)]"}`}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

function Field({ label, children, className = "" }: { label: string; children: ReactNode; className?: string }) {
  return <label className={`${labelClass} ${className}`}>{label}{children}</label>;
}

type AdmitFormProps = {
  wards: AdmissionWardOption[];
  editing: Admission | null;
  onClose: () => void;
  onSaved: (row: Admission) => void;
};

function AdmitPatientForm({ wards, editing, onClose, onSaved }: AdmitFormProps) {
  const [draft, setDraft] = useState<Draft>(() => editing ? draftFromAdmission(editing) : emptyDraft(wards.length === 1 ? wards[0].key : ""));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [hisBusy, setHisBusy] = useState(false);
  const [hisNote, setHisNote] = useState<{ tone: "ok" | "warn" | "error"; text: string } | null>(null);
  const set = <K extends keyof Draft>(key: K, value: Draft[K]) => setDraft(current => ({ ...current, [key]: value }));
  const ward = wards.find(item => item.key === draft.unitKey) || null;
  const missing = [
    !draft.unitKey ? "ward" : "",
    !draft.hn.trim() ? "HN" : "",
    !draft.name.trim() ? "patient name" : "",
  ].filter(Boolean);

  const fetchFromHis = async () => {
    const hn = draft.hn.trim();
    if (!hn) {
      setHisNote({ tone: "warn", text: "Enter the HN first." });
      return;
    }
    setHisBusy(true);
    setHisNote(null);
    try {
      const result = await lookupHl7Patient(hn);
      if (!result.found || !result.patient) {
        setHisNote({ tone: "warn", text: "Not found in HIS." });
        return;
      }
      const patient = result.patient;
      setDraft(current => ({
        ...current,
        name: patient.patient_name || current.name,
        sex: normalizeHisSex(patient.sex) || current.sex,
        dob: patient.dob || current.dob,
      }));
      setHisNote({ tone: "ok", text: `Filled from HIS: ${[patient.patient_name, patient.sex, patient.dob].filter(Boolean).join(" · ")}` });
    } catch (cause) {
      setHisNote({ tone: "error", text: cause instanceof Error ? cause.message : "HIS lookup failed." });
    } finally {
      setHisBusy(false);
    }
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (missing.length) {
      setError(`Enter the ${missing.join(", ")}.`);
      return;
    }
    if (draft.weight && positiveNumber(draft.weight) == null) {
      setError("Weight must be a positive number.");
      return;
    }
    if (draft.height && positiveNumber(draft.height) == null) {
      setError("Height must be a positive number.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const input = inputFromDraft(draft);
      const row = editing ? await updateAdmission(editing.id, input) : await createAdmission(input);
      onSaved(row);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not save the admission.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="app-theme-scope fixed inset-0 z-[1100] flex items-stretch justify-center bg-black/55 sm:items-center sm:p-4" role="dialog" aria-modal="true" aria-label={editing ? "Edit admission" : "Admit patient"}>
      <form onSubmit={event => void submit(event)} className="flex h-full w-full max-w-3xl flex-col overflow-hidden bg-[var(--app-panel-bg)] text-[var(--app-text)] shadow-2xl sm:h-auto sm:max-h-[94vh] sm:rounded-2xl sm:border sm:border-[var(--app-border)]">
        <div className="flex items-center justify-between gap-3 border-b border-[var(--app-border)] px-5 py-4">
          <div>
            <div className="text-xs font-bold uppercase tracking-[0.12em] text-[var(--app-muted)]">Canopy admission</div>
            <h2 className="text-lg font-bold">{editing ? "Edit admission" : "Admit patient"}</h2>
          </div>
          <button type="button" onClick={onClose} className="inline-flex h-12 w-12 items-center justify-center rounded-xl border border-[var(--app-border)] bg-[var(--app-control-bg)] text-xl" aria-label="Close">×</button>
        </div>

        <div className="min-h-0 flex-1 space-y-6 overflow-y-auto px-5 py-5">
          <section className="space-y-4">
            <h3 className="text-sm font-bold">Where</h3>
            <div className="grid gap-4 md:grid-cols-2">
              <Field label="Ward *">
                <select className={fieldClass} value={draft.unitKey} onChange={event => setDraft(current => ({ ...current, unitKey: event.target.value, targetLeafId: "" }))}>
                  <option value="">Choose ward…</option>
                  {wards.map(item => <option key={item.key} value={item.key}>{item.name}{item.isDemo ? " (demo)" : ""}{item.buildingName ? ` – ${item.buildingName}` : ""}</option>)}
                </select>
              </Field>
              <Field label="Bed / Leaf">
                <select className={fieldClass} value={draft.targetLeafId} disabled={!ward} onChange={event => set("targetLeafId", event.target.value)}>
                  <option value="">Any bed in ward</option>
                  {(ward?.leaves || []).map(leaf => <option key={leaf.leafId} value={leaf.leafId}>{leaf.bedName && leaf.bedName !== leaf.name ? `${leaf.bedName} (${leaf.name})` : leaf.name}</option>)}
                </select>
              </Field>
              <Field label="Scheduled">
                <input type="datetime-local" className={fieldClass} value={draft.scheduledAt} onChange={event => set("scheduledAt", event.target.value)} />
              </Field>
            </div>
          </section>

          <section className="space-y-4">
            <h3 className="text-sm font-bold">Patient</h3>
            <div className="grid gap-4 md:grid-cols-2">
              <div>
                <Field label="HN *">
                  <div className="flex gap-2">
                    <input className={fieldClass} value={draft.hn} onChange={event => { set("hn", event.target.value); setHisNote(null); }} autoComplete="off" />
                    <button type="button" onClick={() => void fetchFromHis()} disabled={hisBusy || !draft.hn.trim()} className={`${secondaryButton} mt-1.5 shrink-0 whitespace-nowrap normal-case tracking-normal`} title="Look up name, sex and date of birth in the HIS through the HL7 gateway">{hisBusy ? "Fetching…" : "Fetch from HIS"}</button>
                  </div>
                </Field>
                {hisNote ? <div className={`mt-1.5 text-xs ${hisNote.tone === "ok" ? "text-emerald-600 dark:text-emerald-300" : hisNote.tone === "warn" ? "text-amber-600 dark:text-amber-300" : "text-rose-600 dark:text-rose-300"}`} role="status">{hisNote.text}</div> : null}
              </div>
              <Field label="AN"><input className={fieldClass} value={draft.an} onChange={event => set("an", event.target.value)} autoComplete="off" /></Field>
              <Field label="Patient name *" className="md:col-span-2"><input className={fieldClass} value={draft.name} onChange={event => set("name", event.target.value)} autoComplete="off" /></Field>
            </div>
            <div>
              <div className={labelClass}>Sex</div>
              <ChoiceRow label="Sex" options={SEXES} value={draft.sex} onChange={value => set("sex", value)} />
            </div>
            <div className="grid gap-4 sm:grid-cols-2 md:grid-cols-4">
              <Field label="Date of birth"><input type="date" className={fieldClass} value={draft.dob} max={new Date().toISOString().slice(0, 10)} onChange={event => set("dob", event.target.value)} /></Field>
              <Field label="or age"><input className={fieldClass} value={draft.ageText} placeholder="e.g. 54y" onChange={event => set("ageText", event.target.value)} /></Field>
              <Field label="Weight (kg)"><input type="number" inputMode="decimal" min="0.1" max="500" step="0.1" className={fieldClass} value={draft.weight} onChange={event => set("weight", event.target.value)} /></Field>
              <Field label="Height (cm)"><input type="number" inputMode="decimal" min="1" max="300" step="0.1" className={fieldClass} value={draft.height} onChange={event => set("height", event.target.value)} /></Field>
            </div>
          </section>

          <section className="space-y-4">
            <h3 className="text-sm font-bold">Planned care</h3>
            <div className="grid gap-4 md:grid-cols-2">
              <Field label="Diagnosis"><textarea rows={2} className={`${fieldClass} h-auto py-2`} value={draft.diagnosis} onChange={event => set("diagnosis", event.target.value)} /></Field>
              <Field label="Operation"><textarea rows={2} className={`${fieldClass} h-auto py-2`} value={draft.operation} onChange={event => set("operation", event.target.value)} /></Field>
            </div>
            <div>
              <div className={labelClass}>Anaesthesia technique</div>
              <ChoiceRow label="Anaesthesia technique" options={TECHNIQUES.map(value => ({ value, label: value }))} value={draft.technique} onChange={value => set("technique", value)} />
            </div>
            <div>
              <div className={labelClass}>ASA status</div>
              <div className="flex flex-wrap items-center gap-2">
                <ChoiceRow label="ASA status" options={ASA_CLASSES.map(value => ({ value, label: value }))} value={draft.asa} onChange={value => set("asa", value)} />
                <button type="button" aria-pressed={draft.asaEmergency} onClick={() => set("asaEmergency", !draft.asaEmergency)} className={`mt-1.5 h-12 min-w-12 rounded-xl border px-4 text-sm font-bold ${draft.asaEmergency ? "border-rose-400 bg-rose-500/15 text-rose-500" : "border-[var(--app-border)] bg-[var(--app-control-bg)] text-[var(--app-text)]"}`}>E</button>
              </div>
            </div>
            <div>
              <div className={labelClass}>Surgical priority</div>
              <ChoiceRow label="Surgical priority" options={PRIORITIES.map(value => ({ value, label: value[0].toUpperCase() + value.slice(1) }))} value={draft.priority} onChange={value => set("priority", value)} />
            </div>
            <div className="grid gap-4 md:grid-cols-2">
              <Field label="Surgeon"><input className={fieldClass} value={draft.surgeon} onChange={event => set("surgeon", event.target.value)} /></Field>
              <Field label="Note for the bedside team"><input className={fieldClass} value={draft.note} onChange={event => set("note", event.target.value)} /></Field>
            </div>
          </section>
        </div>

        <div className="border-t border-[var(--app-border)] px-5 py-4">
          {error ? <div className="mb-3 rounded-xl border border-rose-400/35 bg-rose-500/10 p-3 text-sm text-rose-600 dark:text-rose-300" role="alert">{error}</div> : null}
          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <button type="button" onClick={onClose} className={secondaryButton}>Cancel</button>
            <button type="submit" disabled={busy} className={primaryButton}>{busy ? "Saving…" : editing ? "Save changes" : "Admit patient"}</button>
          </div>
        </div>
      </form>
    </div>
  );
}

function AdmissionCard({ row, canManage, onEdit, onCancel, onOpenForm }: {
  row: Admission;
  canManage: boolean;
  onEdit: () => void;
  onCancel: () => void;
  onOpenForm: () => void;
}) {
  const patient = row.patient || { patient_name: "" };
  const demographics = [patient.sex, patient.age_text, patient.weight_kg ? `${patient.weight_kg} kg` : ""].filter(Boolean).join(" · ");
  const plan = [row.admission?.operation, row.admission?.diagnosis].filter(Boolean).join(" — ");
  const pending = row.status === "pending";
  const asa = row.admission?.asa_status ? `ASA ${row.admission.asa_status}${row.admission.asa_emergency ? "E" : ""}` : "";
  return (
    <article className="flex flex-col gap-3 rounded-2xl border border-[var(--app-border)] bg-[var(--app-panel-bg)] p-4 shadow-sm">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 className="truncate text-base font-bold text-[var(--app-text)]">{patient.patient_name || "Unnamed patient"}</h3>
          <div className="mt-0.5 text-sm text-[var(--app-muted)]">HN {row.hn}{row.admissionNumber ? ` · AN ${row.admissionNumber}` : ""}{demographics ? ` · ${demographics}` : ""}</div>
          <AdmissionSourceBadges row={row} />
        </div>
        <div className="flex flex-wrap gap-1.5">
          <AdmissionStatusBadge admission={row} />
          <AdmissionCaseBadge caseStatus={row.caseStatus} />
        </div>
      </div>
      <dl className="grid gap-2 text-sm sm:grid-cols-2">
        <div className="rounded-xl bg-[var(--app-control-bg)] px-3 py-2">
          <dt className="text-[10px] font-bold uppercase tracking-[0.1em] text-[var(--app-muted)]">Ward · bed</dt>
          <dd className="truncate font-semibold text-[var(--app-text)]">{row.unitName} · {row.targetLeafName || "Any bed in ward"}</dd>
        </div>
        <div className="rounded-xl bg-[var(--app-control-bg)] px-3 py-2">
          <dt className="text-[10px] font-bold uppercase tracking-[0.1em] text-[var(--app-muted)]">Scheduled</dt>
          <dd className="truncate font-semibold text-[var(--app-text)]">{formatAdmissionTime(row.scheduledAt) || "Not scheduled"}</dd>
        </div>
      </dl>
      {plan || asa ? <p className="text-sm text-[var(--app-text)]">{plan}{plan && asa ? " · " : ""}{asa ? <span className="font-semibold">{asa}</span> : null}</p> : null}
      {row.note ? <p className="rounded-xl border border-dashed border-[var(--app-border)] px-3 py-2 text-sm text-[var(--app-muted)]">{row.note}</p> : null}
      <div className="text-xs text-[var(--app-muted)]">
        {row.formFieldCount > 0 ? `${row.formFieldCount} form field${row.formFieldCount === 1 ? "" : "s"} filled` : "No form fields filled yet"}
        {row.formUpdatedAt ? ` · updated ${formatAdmissionTime(row.formUpdatedAt)}` : ""}
        {row.createdBy ? ` · admitted by ${row.createdBy}` : ""}
      </div>
      <div className="mt-auto flex flex-wrap gap-2 pt-1">
        <button type="button" onClick={onOpenForm} className={`${primaryButton} flex-1 sm:flex-none`}>{row.formEditable ? "Open form" : "View form"}</button>
        {pending && canManage ? <button type="button" onClick={onEdit} className={secondaryButton}>Edit</button> : null}
        {pending && canManage ? <button type="button" onClick={onCancel} className={`${secondaryButton} text-rose-600 dark:text-rose-300`}>Cancel admission</button> : null}
      </div>
    </article>
  );
}

/** Canopy ward admissions: admit patients ahead of the bedside Leaf and fill their pre-op forms from a tablet. */
export default function CanopyAdmissionsView({ sessionUser }: Props) {
  const permissions = sessionUser?.permissions;
  const canManage = !permissions || permissions.includes("case.create") || String(sessionUser?.role || "").toLowerCase() === "admin";
  const [filter, setFilter] = useState<AdmissionListFilter>("open");
  const [rows, setRows] = useState<Admission[]>([]);
  const [wards, setWards] = useState<AdmissionWardOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [formTarget, setFormTarget] = useState<{ editing: Admission | null } | null>(null);
  const [cancelTarget, setCancelTarget] = useState<Admission | null>(null);
  const [cancelBusy, setCancelBusy] = useState(false);
  const [editorRow, setEditorRow] = useState<Admission | null>(null);

  const load = useCallback(async () => {
    try {
      const next = await listAdmissions(filter);
      setRows(next);
      setError("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not load admissions.");
    } finally {
      setLoading(false);
    }
  }, [filter]);

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => void load(), LIST_REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [load]);

  useEffect(() => {
    let cancelled = false;
    void getAdmissionOptions().then(next => {
      if (!cancelled) setWards(next);
    }).catch(() => {
      if (!cancelled) setWards([]);
    });
    return () => { cancelled = true; };
  }, []);

  const counts = useMemo(() => ({
    waiting: rows.filter(row => row.status === "pending").length,
    started: rows.filter(row => row.status === "started").length,
    conflict: rows.filter(row => row.status === "conflict").length,
  }), [rows]);

  const changeFilter = (next: AdmissionListFilter) => {
    setLoading(true);
    setFilter(next);
  };

  const upsert = useCallback((row: Admission) => {
    setRows(current => current.some(item => item.id === row.id)
      ? current.map(item => item.id === row.id ? row : item)
      : [row, ...current]);
  }, []);

  const confirmCancel = async () => {
    if (!cancelTarget) return;
    setCancelBusy(true);
    try {
      const row = await cancelAdmission(cancelTarget.id);
      upsert(row);
      setNotice(`Admission for ${row.patient?.patient_name || row.hn} cancelled.`);
      setCancelTarget(null);
      void load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not cancel the admission.");
      setCancelTarget(null);
      void load();
    } finally {
      setCancelBusy(false);
    }
  };

  const closeEditor = useCallback(() => {
    setEditorRow(null);
    void load();
  }, [load]);

  return (
    <main className="min-h-full bg-[var(--app-bg)] px-4 py-4 text-[var(--app-text)] sm:px-6">
      <div className="mx-auto max-w-[1280px] space-y-4">
        <header className="flex flex-wrap items-end justify-between gap-3">
          <div className="min-w-0">
            <div className="text-xs font-bold uppercase tracking-[0.12em] text-[var(--app-muted)]">Ward admissions</div>
            <h1 className="text-2xl font-bold">Admissions</h1>
            <p className="mt-1 max-w-2xl text-sm text-[var(--app-muted)]">Admit a patient here and fill the pre-op form from a ward tablet. The bedside Leaf starts the case; both sides keep editing the same form.</p>
          </div>
          {canManage ? <button type="button" onClick={() => { setNotice(""); setFormTarget({ editing: null }); }} disabled={wards.length === 0} className={primaryButton} title={wards.length === 0 ? "No ward available to admit to" : undefined}>+ Admit patient</button> : null}
        </header>

        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="inline-flex rounded-xl border border-[var(--app-border)] bg-[var(--app-control-bg)] p-1" role="tablist" aria-label="Admission filter">
            {FILTERS.map(item => (
              <button key={item.id} type="button" role="tab" aria-selected={filter === item.id} onClick={() => changeFilter(item.id)} className={`h-11 min-w-20 rounded-lg px-4 text-sm font-bold transition ${filter === item.id ? "bg-[var(--app-accent)] text-[var(--app-accent-contrast)]" : "text-[var(--app-muted)] hover:text-[var(--app-text)]"}`}>{item.label}</button>
            ))}
          </div>
          {filter !== "cancelled" ? <div className="flex flex-wrap gap-2 text-xs font-semibold text-[var(--app-muted)]">
            <span>{counts.waiting} waiting</span><span aria-hidden="true">·</span><span>{counts.started} started</span>
            {counts.conflict ? <><span aria-hidden="true">·</span><span className="text-rose-500">{counts.conflict} conflict</span></> : null}
          </div> : null}
        </div>

        {notice ? <div className="rounded-xl border border-emerald-400/35 bg-emerald-500/10 p-3 text-sm" role="status">{notice}</div> : null}
        {error ? <div className="rounded-xl border border-rose-400/35 bg-rose-500/10 p-3 text-sm text-rose-600 dark:text-rose-300" role="alert">{error}</div> : null}

        {loading && rows.length === 0 ? (
          <div className="rounded-2xl border border-[var(--app-border)] bg-[var(--app-panel-bg)] p-8 text-center text-sm text-[var(--app-muted)]">Loading admissions…</div>
        ) : rows.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-[var(--app-border)] bg-[var(--app-panel-bg)] p-10 text-center">
            <div className="text-base font-semibold">{filter === "cancelled" ? "No cancelled admissions" : "No admissions yet"}</div>
            {filter !== "cancelled" && canManage ? <div className="mt-1 text-sm text-[var(--app-muted)]">Use “Admit patient” to prepare a case for a bedside Leaf.</div> : null}
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-3 lg:grid-cols-2 2xl:grid-cols-3">
            {rows.map(row => (
              <AdmissionCard
                key={row.id}
                row={row}
                canManage={canManage}
                onEdit={() => { setNotice(""); setFormTarget({ editing: row }); }}
                onCancel={() => setCancelTarget(row)}
                onOpenForm={() => setEditorRow(row)}
              />
            ))}
          </div>
        )}
      </div>

      {formTarget ? (
        <AdmitPatientForm
          wards={wards}
          editing={formTarget.editing}
          onClose={() => setFormTarget(null)}
          onSaved={row => {
            upsert(row);
            setNotice(formTarget.editing ? "Admission updated." : `${row.patient?.patient_name || row.hn} admitted to ${row.unitName}.`);
            setFormTarget(null);
            void load();
          }}
        />
      ) : null}

      <ConfirmDialog
        open={Boolean(cancelTarget)}
        title="Cancel this admission?"
        message={cancelTarget ? `${cancelTarget.patient?.patient_name || cancelTarget.hn} will be removed from the bedside Leaf's prepared list. Forms already filled stay read-only.` : ""}
        confirmLabel="Cancel admission"
        cancelLabel="Keep"
        busy={cancelBusy}
        onCancel={() => setCancelTarget(null)}
        onConfirm={() => void confirmCancel()}
      />

      {editorRow ? <CanopyAdmissionFormEditor admission={editorRow} onClose={closeEditor} onChanged={upsert} /> : null}
    </main>
  );
}
