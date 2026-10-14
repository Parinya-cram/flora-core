import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { patchCaseWorkflowForm, type CaseWorkflowForm } from "../../api/workflowApi";
import { useLanguage } from "../../context/LanguageContext";
import type { Issue, JsonValue, RecordData } from "../../formdev/core/types";
import { validateRecord } from "../../formdev/core/validate";
import { FormCaseContext } from "../../formdev/leaf/caseContext";
import FormRenderer from "../../formdev/ui/FormRenderer";

/** One workflow form on a Leaf case: Form Studio's renderer, autosaving changed keys. */

const SAVE_DELAY_MS = 1500;

type SaveState = { status: "idle" | "saving" | "saved" | "error"; message?: string; at?: number };

function changedKeys(next: RecordData, base: RecordData): RecordData {
  const patch: RecordData = {};
  for (const key of new Set([...Object.keys(next), ...Object.keys(base)])) {
    const value: JsonValue = key in next ? next[key] : null;
    if (JSON.stringify(value) !== JSON.stringify(key in base ? base[key] : null)) patch[key] = value;
  }
  return patch;
}

type Props = {
  caseId: number;
  formId: string;
  form: CaseWorkflowForm;
  /** Workflow Studio's note for whoever fills the form in. */
  hint?: string;
  readOnly?: boolean;
  hidden?: boolean;
};

export default function WorkflowFormPanel({ caseId, formId, form, hint = "", readOnly = false, hidden = false }: Props) {
  const { t, language } = useLanguage();
  const [value, setValue] = useState<RecordData>(() => ({ ...(form.record?.data || {}) }));
  const [status, setStatus] = useState<"draft" | "completed">(form.record?.status === "completed" ? "completed" : "draft");
  const [save, setSave] = useState<SaveState>({ status: "idle" });
  const [issues, setIssues] = useState<Issue[]>([]);
  const leafCase = useMemo(() => ({ caseId }), [caseId]);
  const baseline = useRef<RecordData>({ ...(form.record?.data || {}) });
  const latest = useRef(value);
  const timer = useRef<number | null>(null);
  const inFlight = useRef<Promise<void> | null>(null);

  const flush = useCallback(async (nextStatus?: "draft" | "completed") => {
    if (timer.current != null) { window.clearTimeout(timer.current); timer.current = null; }
    if (inFlight.current) await inFlight.current.catch(() => undefined);
    const sent = { ...latest.current };
    const patch = changedKeys(sent, baseline.current);
    if (!Object.keys(patch).length && !nextStatus) return;
    setSave({ status: "saving" });
    const request = patchCaseWorkflowForm(caseId, formId, patch, nextStatus)
      .then(result => {
        baseline.current = { ...baseline.current, ...patch };
        if (result?.record?.status === "completed" || result?.record?.status === "draft") setStatus(result.record.status);
        else if (nextStatus) setStatus(nextStatus);
        setSave({ status: "saved", at: Date.now() });
      })
      .catch(reason => {
        setSave({ status: "error", message: reason instanceof Error ? reason.message : String(reason) });
        throw reason;
      })
      .finally(() => { inFlight.current = null; });
    inFlight.current = request;
    await request;
  }, [caseId, formId]);

  // Save what is pending when the panel goes away (case switch, view change).
  useEffect(() => () => {
    if (timer.current != null) {
      window.clearTimeout(timer.current);
      const patch = changedKeys(latest.current, baseline.current);
      if (Object.keys(patch).length) void patchCaseWorkflowForm(caseId, formId, patch).catch(() => undefined);
    }
  }, [caseId, formId]);

  const onChange = (next: RecordData) => {
    if (readOnly) return;
    latest.current = next;
    setValue(next);
    if (timer.current != null) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => { timer.current = null; void flush().catch(() => undefined); }, SAVE_DELAY_MS);
  };

  const toggleComplete = async () => {
    const next = status === "completed" ? "draft" : "completed";
    if (next === "completed") {
      const found = validateRecord(form.definition, latest.current, "submitted");
      setIssues(found);
      if (found.length) {
        setSave({ status: "error", message: `${found.length} field(s) need attention before completing.` });
        return;
      }
    } else {
      setIssues([]);
    }
    await flush(next).catch(() => undefined);
  };

  const saveLabel = save.status === "saving" ? t("form.saving")
    : save.status === "saved" ? `${t("form.saved")}${save.at ? ` ${new Date(save.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}` : ""}`
      : save.status === "error" ? `${t("form.saveFailed")}${save.message ? `: ${save.message}` : ""}` : "";

  return <section className={`space-y-3 rounded-2xl border border-[var(--app-border)] bg-[var(--app-panel-bg)] p-4 shadow-sm ${hidden ? "hidden" : ""}`}>
    <div className="flex flex-wrap items-center justify-between gap-2">
      <div className="min-w-0">
        <h2 className="font-semibold">{form.definition.title || formId}</h2>
        {form.definition.description ? <p className="mt-0.5 text-xs text-[var(--app-muted)]">{form.definition.description}</p> : null}
        {hint ? <p className="mt-1 rounded-lg bg-[var(--app-accent)]/10 px-2 py-1 text-xs text-[var(--app-text)]">ℹ {hint}</p> : null}
      </div>
      <div className="flex items-center gap-2">
        {saveLabel ? <span className={`text-xs ${save.status === "error" ? "text-rose-500" : "text-[var(--app-muted)]"}`}>{saveLabel}</span> : null}
        {save.status === "error" && !readOnly ? <button type="button" onClick={() => void flush().catch(() => undefined)}
          className="rounded-lg border border-[var(--app-border)] bg-[var(--app-control-bg)] px-2 py-1 text-xs font-semibold">Retry</button> : null}
        <label className={`flex items-center gap-2 rounded-xl border px-3 py-1.5 text-xs font-bold ${status === "completed" ? "border-emerald-400/50 bg-emerald-500/10 text-emerald-600 dark:text-emerald-300" : "border-[var(--app-border)] bg-[var(--app-control-bg)]"}`}>
          <input type="checkbox" checked={status === "completed"} disabled={readOnly || save.status === "saving"} onChange={() => void toggleComplete()} className="h-4 w-4 accent-[var(--app-accent)]" />
          {status === "completed" ? t("form.completed") : t("form.markComplete")}
        </label>
      </div>
    </div>
    {/* The case the form is filled for: timeline fields pull this case's Flora Leaf data. */}
    <FormCaseContext.Provider value={leafCase}>
      <FormRenderer definition={form.definition} value={value} issues={issues} readOnly={readOnly} language={language} onChange={onChange} />
    </FormCaseContext.Provider>
  </section>;
}
