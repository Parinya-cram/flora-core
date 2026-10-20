import { useCallback, useEffect, useRef, useState } from "react";
import { getAdmissionWorkflowForms, patchAdmissionWorkflowForm, type AdmissionWorkflowForm } from "../../api/admissionApi";
import { useLanguage } from "../../context/LanguageContext";
import type { JsonValue, RecordData } from "../../formdev/core/types";
import FormRenderer from "../../formdev/ui/FormRenderer";

const SAVE_DELAY_MS = 1500;

/** The Form Studio forms of the admission's workflow, filled on a ward tablet before the case starts: they continue
 * at the bedside as the case's forms (field by field, both ways). Changing a field filled at the bedside afterwards is
 * an amendment and asks for a reason. */
export default function AdmissionWorkflowForms({ admissionId, readOnly }: { admissionId: string; readOnly: boolean }) {
  const [state, setState] = useState<Awaited<ReturnType<typeof getAdmissionWorkflowForms>> | null>(null);
  useEffect(() => {
    let cancelled = false;
    void getAdmissionWorkflowForms(admissionId).then(value => { if (!cancelled) setState(value); }).catch(() => undefined);
    return () => { cancelled = true; };
  }, [admissionId]);
  if (!state?.forms.length) return null;
  return <section className="mx-auto max-w-[1500px] space-y-3 px-4 pb-24">
    <h2 className="text-sm font-bold uppercase tracking-[0.12em] text-[var(--app-muted)]">Workflow forms · {state.workflowName || state.workflowId}</h2>
    {state.forms.map(form => <AdmissionForm key={form.ref.form_id} admissionId={admissionId} form={form} readOnly={readOnly || !state.editable} />)}
  </section>;
}

function AdmissionForm({ admissionId, form, readOnly }: { admissionId: string; form: AdmissionWorkflowForm; readOnly: boolean }) {
  const { language } = useLanguage();
  const [value, setValue] = useState<RecordData>(() => ({ ...(form.record?.data || {}) }));
  const [message, setMessage] = useState("");
  const [needsReason, setNeedsReason] = useState(false);
  const [reason, setReason] = useState("");
  const saved = useRef<RecordData>({ ...(form.record?.data || {}) });
  const latest = useRef(value);
  const timer = useRef<number | null>(null);

  const flush = useCallback(async (why?: string) => {
    const patch: Record<string, JsonValue> = {};
    for (const key of new Set([...Object.keys(latest.current), ...Object.keys(saved.current)])) {
      if (JSON.stringify(latest.current[key] ?? null) !== JSON.stringify(saved.current[key] ?? null)) patch[key] = latest.current[key] ?? null;
    }
    if (!Object.keys(patch).length) return;
    try {
      await patchAdmissionWorkflowForm(admissionId, form.ref.form_id, patch, why);
      saved.current = { ...saved.current, ...patch };
      setNeedsReason(false);
      setReason("");
      setMessage(`Saved ${new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`);
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      // Changing what the bedside filled is an amendment: the server asks for a reason.
      if (/reason/i.test(text)) setNeedsReason(true);
      setMessage(text);
    }
  }, [admissionId, form.ref.form_id]);

  const onChange = (next: RecordData) => {
    latest.current = next;
    setValue(next);
    if (timer.current != null) window.clearTimeout(timer.current);
    if (!needsReason) timer.current = window.setTimeout(() => { timer.current = null; void flush(); }, SAVE_DELAY_MS);
  };

  return <details className="rounded-2xl border border-[var(--app-border)] bg-[var(--app-panel-bg)] p-4 shadow-sm" open>
    <summary className="cursor-pointer font-semibold">
      {form.ref.title || form.definition.title}{form.ref.required ? <span className="ml-1 text-rose-500">*</span> : null}
      <span className="ml-2 text-xs font-normal text-[var(--app-muted)]">
        {form.record?.leafId ? `· continues at ${form.record.leafId}` : "· copied to the bedside when the case starts"}{message ? ` · ${message}` : ""}
      </span>
    </summary>
    {needsReason ? <div className="mt-2 flex flex-wrap items-end gap-2 rounded-lg border border-amber-400/50 bg-amber-500/10 p-2 text-xs">
      <label className="min-w-64 flex-1">Reason for changing what was filled at the bedside *
        <input value={reason} onChange={event => setReason(event.target.value)} maxLength={500}
          className="mt-1 w-full rounded-lg border border-[var(--app-border)] bg-[var(--app-panel-bg)] px-2 py-1.5" />
      </label>
      <button type="button" disabled={reason.trim().length < 3} onClick={() => void flush(reason.trim())}
        className="rounded-lg bg-[var(--app-accent)] px-3 py-1.5 font-bold text-[var(--app-accent-contrast)] disabled:opacity-50">Save amendment</button>
    </div> : null}
    <div className="mt-3">
      <FormRenderer definition={form.definition} value={value} readOnly={readOnly} language={language} onChange={onChange} />
    </div>
  </details>;
}
