import { lazy, Suspense, useCallback, useEffect, useMemo, useState } from "react";
import {
  CANOPY_TABLET_FORM_TABS,
  formatAdmissionTime,
  getAdmissionForm,
  patchAdmissionForm,
  type Admission,
} from "../api/admissionApi";
import type { FormDataSource, FormSaveState } from "./FormView";
import { AdmissionStatusBadge } from "./CanopyAdmissionStatusBadge";

const FormView = lazy(() => import("./FormView"));

type Props = {
  admission: Admission;
  onClose: () => void;
  /** Latest admission row seen by the editor (status, form field count). */
  onChanged?: (admission: Admission) => void;
};

function saveLabel(state: FormSaveState, readOnly: boolean): { text: string; tone: string } {
  if (readOnly) return { text: "Read-only", tone: "text-[var(--app-muted)]" };
  if (state.status === "saving") return { text: "Saving…", tone: "text-[var(--app-muted)]" };
  if (state.status === "error") return { text: state.message ? `Not saved: ${state.message}` : "Not saved – will retry", tone: "text-rose-500" };
  if (state.status === "saved") return { text: `Saved ${state.at ? formatAdmissionTime(state.at, true) : ""}`.trim(), tone: "text-emerald-600 dark:text-emerald-400" };
  return { text: "Changes save automatically", tone: "text-[var(--app-muted)]" };
}

/** Full-screen tablet editor for the forms of a Canopy admission (e.g. pre-op). */
export default function CanopyAdmissionFormEditor({ admission, onClose, onChanged }: Props) {
  const [current, setCurrent] = useState<Admission>(admission);
  const [saveState, setSaveState] = useState<FormSaveState>({ status: "idle" });
  const readOnly = !current.formEditable;
  const admissionId = admission.id;

  const remember = useCallback((row: Admission) => {
    setCurrent(row);
    onChanged?.(row);
  }, [onChanged]);

  const source = useMemo<FormDataSource>(() => ({
    key: `doctor_form_canopy_${admissionId}`,
    hn: admission.hn,
    readOnly,
    patientFieldsReadOnly: true,
    load: async () => {
      const result = await getAdmissionForm(admissionId);
      remember(result.admission);
      return { draft: result.draft, updated_at: result.updated_at };
    },
    patch: patch => patchAdmissionForm(admissionId, patch),
  }), [admissionId, admission.hn, readOnly, remember]);

  const handleSaveState = useCallback((state: FormSaveState) => {
    setSaveState(state);
    // A rejected save usually means the case was archived or cancelled meanwhile.
    if (state.status === "error") {
      void getAdmissionForm(admissionId).then(result => remember(result.admission)).catch(() => {});
    }
  }, [admissionId, remember]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !(event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement || event.target instanceof HTMLSelectElement)) onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  const status = saveLabel(saveState, readOnly);
  const patient = current.patient || { patient_name: "" };
  const demographics = [patient.sex, patient.age_text, patient.weight_kg ? `${patient.weight_kg} kg` : "", patient.height_cm ? `${patient.height_cm} cm` : ""]
    .filter(Boolean).join(" · ");
  const syncHint = current.status === "started"
    ? `Synced with ${current.claimedLeafName || current.claimedLeafId || "the bedside Leaf"} – edits on either side merge field by field.`
    : current.status === "pending" || current.status === "conflict"
      ? "Copied to the bedside Leaf when the case starts, then kept in sync."
      : "This admission was cancelled; the form is read-only.";

  return (
    <div className="app-theme-scope fixed inset-0 z-[1100] flex flex-col bg-[var(--app-bg)] text-[var(--app-text)]" role="dialog" aria-modal="true" aria-label={`Forms for ${patient.patient_name || current.hn}`}>
      <header className="shrink-0 border-b border-[var(--app-border)] bg-[var(--app-panel-bg)] px-4 py-3 shadow-sm">
        <div className="mx-auto flex max-w-[1500px] flex-wrap items-center gap-3">
          <button type="button" onClick={onClose} className="inline-flex h-12 min-w-12 items-center justify-center gap-2 rounded-xl border border-[var(--app-border)] bg-[var(--app-control-bg)] px-4 text-sm font-bold hover:bg-[var(--app-control-bg-hover)]" aria-label="Close form">
            <span aria-hidden="true" className="text-lg">‹</span><span>Done</span>
          </button>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="truncate text-lg font-bold">{patient.patient_name || "Unnamed patient"}</h1>
              <AdmissionStatusBadge admission={current} />
            </div>
            <div className="mt-0.5 truncate text-sm text-[var(--app-muted)]">
              HN {current.hn}{current.admissionNumber ? ` · AN ${current.admissionNumber}` : ""}{demographics ? ` · ${demographics}` : ""}
            </div>
            <div className="truncate text-sm text-[var(--app-muted)]">
              {current.unitName} · {current.targetLeafName || "Any bed in ward"}{current.scheduledAt ? ` · ${formatAdmissionTime(current.scheduledAt)}` : ""}
            </div>
          </div>
          <div className="w-full text-left sm:w-auto sm:max-w-sm sm:text-right">
            <div className={`text-sm font-semibold ${status.tone}`} aria-live="polite">{status.text}</div>
            <div className="text-xs text-[var(--app-muted)]">{syncHint}</div>
          </div>
        </div>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <Suspense fallback={<div className="p-6 text-sm text-[var(--app-muted)]">Loading form…</div>}>
          <FormView
            source={source}
            allowedTabs={CANOPY_TABLET_FORM_TABS}
            onSaveStateChange={handleSaveState}
          />
        </Suspense>
      </div>
    </div>
  );
}
