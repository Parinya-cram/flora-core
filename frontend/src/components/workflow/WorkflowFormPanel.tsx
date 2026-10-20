import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CaseFormRefused, getCaseFormFile, patchCaseWorkflowForm, putCaseFormFile, signCaseWorkflowForm, type CaseFormAuthor, type CaseFormSync, type CaseWorkflowForm } from "../../api/workflowApi";
import { useLanguage } from "../../context/LanguageContext";
import { attachmentRef, shaOf } from "../../formdev/core/attachments";
import { sha256 } from "../../formdev/core/sha256";
import type { Issue, JsonValue, RecordData } from "../../formdev/core/types";
import { evaluateRecord } from "../../formdev/logic/evaluate";
import { fillFromCase, loadCaseData, type CaseHead } from "../../formdev/leaf/caseData";
import { FormCaseContext } from "../../formdev/leaf/caseContext";
import { AttachmentContext, type AttachmentService } from "../../formdev/ui/attachments";
import FormRenderer from "../../formdev/ui/FormRenderer";
import { SignatureContext, type SigningService } from "../../formdev/ui/signing";
import { CASE_FORMS_CHANGED } from "./caseWorkflow";

/** One workflow form on a Leaf case: Form Studio's renderer, autosaving changed keys. Each saved field carries who
 * changed it; Canopy merges the form field by field, answers with a receipt (shown here) and sends its own changes
 * (amendments, with a reason) back, which appear in the open form without overwriting what is being typed. */

const SAVE_DELAY_MS = 1500;

// "incomplete": saved, but not marked complete because fields need attention (not a failed save).
type SaveState = { status: "idle" | "saving" | "saved" | "error" | "incomplete"; message?: string; at?: number };

const same = (a: JsonValue | undefined, b: JsonValue | undefined) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

function changedKeys(next: RecordData, base: RecordData): RecordData {
  const patch: RecordData = {};
  for (const key of new Set([...Object.keys(next), ...Object.keys(base)])) {
    const value: JsonValue = key in next ? next[key] : null;
    if (!same(value, key in base ? base[key] : null)) patch[key] = value;
  }
  return patch;
}

/** Files of file / image fields: stored on this Leaf by SHA-256 (the sync worker sends them on to Canopy). */
function leafAttachments(caseId: number): AttachmentService {
  const recent = new Map<string, Blob>();
  return {
    save: async file => {
      const bytes = await file.arrayBuffer();
      const sha = await sha256(new Uint8Array(bytes));
      const mime = (file.type || "application/octet-stream").toLowerCase();
      await putCaseFormFile(caseId, sha, bytes, mime);
      recent.set(sha, new Blob([bytes], { type: mime }));
      return { name: file.name, mime, size: file.size, ref: attachmentRef(sha) };
    },
    open: async value => {
      const sha = shaOf(value.ref);
      if (!sha) return null;
      return recent.get(sha) ?? await getCaseFormFile(caseId, sha);
    },
  };
}

type Props = {
  caseId: number;
  formId: string;
  form: CaseWorkflowForm;
  /** Workflow Studio's note for whoever fills the form in. */
  hint?: string;
  readOnly?: boolean;
  hidden?: boolean;
  /** The case, to fill empty fields bound to case data (bind or usual field names) when the form is opened. */
  head?: CaseHead;
};

export default function WorkflowFormPanel({ caseId, formId, form, hint = "", readOnly = false, hidden = false, head }: Props) {
  const { t, language } = useLanguage();
  const [value, setValue] = useState<RecordData>(() => ({ ...(form.record?.data || {}) }));
  const [status, setStatus] = useState<"draft" | "completed">(form.record?.status === "completed" ? "completed" : "draft");
  const [save, setSave] = useState<SaveState>({ status: "idle" });
  const [issues, setIssues] = useState<Issue[]>([]);
  const leafCase = useMemo(() => ({ caseId }), [caseId]);
  const attachments = useMemo(() => leafAttachments(caseId), [caseId]);
  const baseline = useRef<RecordData>({ ...(form.record?.data || {}) });
  const latest = useRef(value);
  const timer = useRef<number | null>(null);
  const inFlight = useRef<Promise<void> | null>(null);
  // A completed form is part of the record: it is changed (or reopened) only as an amendment, with a reason given once
  // for this editing session and kept with every field changed.
  const [amending, setAmending] = useState(false);
  const [reason, setReason] = useState("");
  const amendReason = useRef("");
  const reasonOk = reason.trim().length >= 3;
  const locked = readOnly || (status === "completed" && !(amending && reasonOk));

  // What arrives from Canopy (or another screen) while the form is open: fields not being edited here take the new
  // value; a field typed here and not saved yet keeps what was typed (it is saved, and merged by time, afterwards).
  const incoming = form.record;
  useEffect(() => {
    if (!incoming) return;
    const pending = changedKeys(latest.current, baseline.current);
    const next = { ...latest.current };
    let changed = false;
    for (const key of new Set([...Object.keys(incoming.data), ...Object.keys(baseline.current)])) {
      if (key in pending || same(incoming.data[key], baseline.current[key])) continue;
      if (key in incoming.data) next[key] = incoming.data[key]; else delete next[key];
      changed = true;
    }
    baseline.current = { ...incoming.data };  // what the Leaf has stored; keys typed here stay pending against it
    if (changed) {
      latest.current = next;
      setValue(next);
    }
    if (!inFlight.current && (incoming.status === "draft" || incoming.status === "completed")) setStatus(incoming.status);
  }, [incoming]);

  const flush = useCallback(async (nextStatus?: "draft" | "completed") => {
    if (timer.current != null) { window.clearTimeout(timer.current); timer.current = null; }
    if (inFlight.current) await inFlight.current.catch(() => undefined);
    const sent = { ...latest.current };
    const patch = changedKeys(sent, baseline.current);
    if (!Object.keys(patch).length && !nextStatus) return;
    setSave({ status: "saving" });
    const request = patchCaseWorkflowForm(caseId, formId, patch, nextStatus, amendReason.current || undefined)
      .then(result => {
        baseline.current = { ...baseline.current, ...patch };
        if (result?.record?.status === "completed" || result?.record?.status === "draft") setStatus(result.record.status);
        else if (nextStatus) setStatus(nextStatus);
        setIssues([]);
        setSave({ status: "saved", at: Date.now() });
        window.dispatchEvent(new Event(CASE_FORMS_CHANGED));
      })
      .catch(reason => {
        if (reason instanceof CaseFormRefused) {
          setIssues(reason.issues);
          setSave({ status: "incomplete", message: reason.message });
        } else {
          setSave({ status: "error", message: reason instanceof Error ? reason.message : String(reason) });
        }
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
      if (Object.keys(patch).length) void patchCaseWorkflowForm(caseId, formId, patch, undefined, amendReason.current || undefined).catch(() => undefined);
    }
  }, [caseId, formId]);

  const onChange = (next: RecordData) => {
    if (locked) return;
    latest.current = next;
    setValue(next);
    if (timer.current != null) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => { timer.current = null; void flush().catch(() => undefined); }, SAVE_DELAY_MS);
  };

  // Signing a signature field: the drawing goes to the Leaf with the signer's PIN (asked here); the Leaf stores the
  // confirmed signature, which this panel then shows (and keeps out of autosave, as it is already saved).
  const [pinAsk, setPinAsk] = useState<{ field: string; data: string; resolve: () => void; reject: (error: Error) => void } | null>(null);
  const [pin, setPin] = useState("");
  const [pinError, setPinError] = useState("");
  const signing = useMemo<SigningService>(() => ({
    canResign: amending && reasonOk,
    sign: (field, data) => new Promise<void>((resolve, reject) => { setPin(""); setPinError(""); setPinAsk({ field, data, resolve, reject }); }),
  }), [amending, reasonOk]);
  const submitPin = async () => {
    if (!pinAsk) return;
    try {
      const result = await signCaseWorkflowForm(caseId, formId, { field: pinAsk.field, data: pinAsk.data, pin, reason: amendReason.current || undefined });
      const signed = result.record?.data?.[pinAsk.field];
      if (signed !== undefined) {
        baseline.current = { ...baseline.current, [pinAsk.field]: signed };
        latest.current = { ...latest.current, [pinAsk.field]: signed };
        setValue(latest.current);
      }
      setSave({ status: "saved", at: Date.now() });
      window.dispatchEvent(new Event(CASE_FORMS_CHANGED));
      pinAsk.resolve();
      setPinAsk(null);
    } catch (error) {
      setPinError(error instanceof Error ? error.message : String(error));
    }
  };

  // Fill from the case once: empty fields no one has filled yet (no author), bound to case data. Saved as this user's
  // entries and listed for checking; a field someone cleared stays empty.
  const [prefilled, setPrefilled] = useState<string[]>([]);
  const prefillDone = useRef(false);
  // Only unmounting drops the case data: the case head and the form object change while it loads (status polling,
  // the 15 s refresh), and the fill is tried once.
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  const authorsRef = useRef(form.record?.authors);
  useEffect(() => { authorsRef.current = form.record?.authors; }, [form.record?.authors]);
  useEffect(() => {
    if (prefillDone.current || !head || readOnly || form.record?.status === "completed") return;
    prefillDone.current = true;
    void loadCaseData(head).then(caseData => {
      if (!mounted.current) return;
      const authored = authorsRef.current ?? {};
      const { data, lines } = fillFromCase(form.definition, latest.current, caseData);
      const taken = lines.filter(line => line.status === "filled" && !(line.field in authored) && line.field in data);
      if (!taken.length) return;
      const next = { ...latest.current };
      for (const line of taken) next[line.field] = data[line.field];
      latest.current = next;
      setValue(next);
      setPrefilled(taken.map(line => line.label || line.field));
      if (timer.current != null) window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => { timer.current = null; void flush().catch(() => undefined); }, SAVE_DELAY_MS);
    }).catch(() => undefined);
  }, [head, readOnly, form, flush]);

  const startAmend = () => { setAmending(true); setReason(""); amendReason.current = ""; };
  const finishAmend = async () => {
    await flush().catch(() => undefined);
    setAmending(false);
    setReason("");
    amendReason.current = "";
  };

  const toggleComplete = async () => {
    const next = status === "completed" ? "draft" : "completed";
    if (next === "draft" && !(amending && reasonOk)) {
      startAmend();  // reopening a completed form needs the reason first
      return;
    }
    if (next === "completed") {
      // Form Studio's full rules, as the Leaf server and Canopy apply them: a field hidden by its condition is not
      // required, and patterns, Other text, repeats and matrices are checked here before the server is asked.
      const found = evaluateRecord(form.definition, latest.current, "submitted").issues;
      setIssues(found);
      if (found.length) {
        setSave({ status: "incomplete", message: `${found.length} field(s) need attention before completing.` });
        return;
      }
    } else {
      setIssues([]);
    }
    await flush(next).catch(() => undefined);
    if (next === "draft") {
      setAmending(false);
      setReason("");
      amendReason.current = "";
    }
  };

  const saveLabel = save.status === "saving" ? t("form.saving")
    : save.status === "saved" ? `${t("form.saved")}${save.at ? ` ${new Date(save.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}` : ""}`
      : save.status === "error" ? `${t("form.saveFailed")}${save.message ? `: ${save.message}` : ""}`
        : save.status === "incomplete" ? save.message || "" : "";
  const amended = amendments(form.record?.authors, form.definition);

  return <section className={`space-y-3 rounded-2xl border border-[var(--app-border)] bg-[var(--app-panel-bg)] p-4 shadow-sm ${hidden ? "hidden" : ""}`}>
    <div className="flex flex-wrap items-center justify-between gap-2">
      <div className="min-w-0">
        <h2 className="font-semibold">{form.definition.title || formId}</h2>
        {form.definition.description ? <p className="mt-0.5 text-xs text-[var(--app-muted)]">{form.definition.description}</p> : null}
        {hint ? <p className="mt-1 rounded-lg bg-[var(--app-accent)]/10 px-2 py-1 text-xs text-[var(--app-text)]">ℹ {hint}</p> : null}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {form.record ? <SyncBadge sync={form.record.sync} /> : null}
        {saveLabel ? <span className={`text-xs ${save.status === "error" ? "text-rose-500" : save.status === "incomplete" ? "text-amber-600 dark:text-amber-300" : "text-[var(--app-muted)]"}`}>{saveLabel}</span> : null}
        {save.status === "error" && !readOnly ? <button type="button" onClick={() => void flush().catch(() => undefined)}
          className="rounded-lg border border-[var(--app-border)] bg-[var(--app-control-bg)] px-2 py-1 text-xs font-semibold">Retry</button> : null}
        {status === "completed" && !readOnly && !amending ? <button type="button" onClick={startAmend}
          className="rounded-lg border border-[var(--app-border)] bg-[var(--app-control-bg)] px-2 py-1 text-xs font-semibold">{t("caseForm.amend")}</button> : null}
        <label className={`flex items-center gap-2 rounded-xl border px-3 py-1.5 text-xs font-bold ${status === "completed" ? "border-emerald-400/50 bg-emerald-500/10 text-emerald-600 dark:text-emerald-300" : "border-[var(--app-border)] bg-[var(--app-control-bg)]"}`}>
          <input type="checkbox" checked={status === "completed"} disabled={readOnly || save.status === "saving"} onChange={() => void toggleComplete()} className="h-4 w-4 accent-[var(--app-accent)]" />
          {status === "completed" ? t("form.completed") : t("form.markComplete")}
        </label>
      </div>
    </div>
    {prefilled.length ? (
      <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-emerald-400/40 bg-emerald-500/10 px-3 py-2 text-xs">
        <span><b>{t("caseForm.prefilled")}</b> {prefilled.join(" · ")}</span>
        <button type="button" className="text-[var(--app-muted)]" onClick={() => setPrefilled([])}>✕</button>
      </div>
    ) : null}
    {amending && !readOnly ? (
      <div className="flex flex-wrap items-end gap-2 rounded-lg border border-amber-400/50 bg-amber-500/10 px-3 py-2 text-xs">
        <label className="min-w-64 flex-1">
          <span className="font-semibold">{t("caseForm.amendReason")} *</span>
          <input value={reason} maxLength={500} autoFocus onChange={event => { setReason(event.target.value); amendReason.current = event.target.value.trim(); }}
            className="mt-1 w-full rounded-lg border border-[var(--app-border)] bg-[var(--app-panel-bg)] px-2 py-1.5" />
          <span className="mt-1 block text-[var(--app-muted)]">{t("caseForm.amendHint")}</span>
        </label>
        <button type="button" onClick={() => void finishAmend()}
          className="rounded-lg border border-[var(--app-border)] bg-[var(--app-control-bg)] px-3 py-1.5 font-semibold">{t("caseForm.amendDone")}</button>
      </div>
    ) : null}
    {form.record?.sync && form.record.sync.issues.length && form.record.sync.state !== "waiting_files" ? (
      <details className="rounded-lg border border-amber-400/50 bg-amber-500/10 px-3 py-2 text-xs">
        <summary className="cursor-pointer font-semibold">{t("caseForm.sync.why")} ({form.record.sync.issues.length})</summary>
        <ul className="mt-1 list-disc pl-5">{form.record.sync.issues.map((issue, index) => <li key={index}>{issue.message}{issue.path && issue.path !== "$" ? ` (${issue.path.replace(/^\$\.data\./, "")})` : ""}</li>)}</ul>
      </details>
    ) : null}
    {amended.length ? (
      <div className="rounded-lg border border-sky-400/50 bg-sky-500/10 px-3 py-2 text-xs">
        <div className="font-semibold">{t("caseForm.amended")}</div>
        <ul className="mt-1 space-y-0.5">{amended.map(item => <li key={item.field}><b>{item.label}</b> · {item.author.via === "canopy" ? "Canopy" : "Leaf"} · {item.author.by} · {new Date(item.author.at).toLocaleString()}{item.author.reason ? ` · “${item.author.reason}”` : ""}</li>)}</ul>
      </div>
    ) : null}
    {/* The case the form is filled for: timeline fields pull this case's Flora Leaf data; files are kept on this Leaf. */}
    <FormCaseContext.Provider value={leafCase}>
      <AttachmentContext.Provider value={attachments}>
        <SignatureContext.Provider value={signing}>
          <FormRenderer definition={form.definition} value={value} issues={issues} readOnly={locked} language={language} onChange={onChange} />
        </SignatureContext.Provider>
      </AttachmentContext.Provider>
    </FormCaseContext.Provider>
    {pinAsk ? <div className="fixed inset-0 z-50 grid place-items-center bg-black/40 p-4" role="dialog" aria-modal="true">
      <div className="w-full max-w-sm space-y-3 rounded-2xl border border-[var(--app-border)] bg-[var(--app-panel-bg)] p-4 shadow-xl">
        <div className="font-semibold">{t("caseForm.signTitle")}</div>
        <p className="text-xs text-[var(--app-muted)]">{t("caseForm.signHelp")}</p>
        <input type="password" inputMode="numeric" autoComplete="off" autoFocus maxLength={8} value={pin}
          onChange={event => setPin(event.target.value.replace(/\D/g, "").slice(0, 8))}
          onKeyDown={event => { if (event.key === "Enter" && pin.length >= 4) void submitPin(); }}
          className="w-full rounded-lg border border-[var(--app-border)] bg-[var(--app-control-bg)] px-3 py-2 text-center text-lg tracking-[0.4em]" />
        {pinError ? <p className="text-xs text-rose-500">{pinError}</p> : null}
        <div className="flex justify-end gap-2">
          <button type="button" className="rounded-lg border border-[var(--app-border)] px-3 py-1.5 text-sm"
            onClick={() => { pinAsk.reject(new Error(t("caseForm.signCancelled"))); setPinAsk(null); }}>{t("caseForm.cancel")}</button>
          <button type="button" disabled={pin.length < 4} onClick={() => void submitPin()}
            className="rounded-lg bg-[var(--app-accent)] px-3 py-1.5 text-sm font-semibold text-[var(--app-accent-contrast)] disabled:opacity-50">{t("caseForm.sign")}</button>
        </div>
      </div>
    </div> : null}
  </section>;
}

/** Fields whose latest value is an amendment (made here with a reason, or in Canopy) or came from Canopy (filled for
 * the admission), newest first. */
function amendments(authors: Record<string, CaseFormAuthor> | undefined, definition: CaseWorkflowForm["definition"]) {
  const labels = new Map<string, string>();
  for (const section of definition.sections || []) for (const field of section.fields || []) labels.set(field.id, typeof field.label === "string" ? field.label : field.id);
  return Object.entries(authors || {})
    .filter(([field, author]) => field !== "__status" && (author?.via === "canopy" || Boolean(author?.reason)))
    .map(([field, author]) => ({ field, label: labels.get(field) || field, author }))
    .sort((a, b) => b.author.at - a.author.at)
    .slice(0, 8);
}

function SyncBadge({ sync }: { sync?: CaseFormSync }) {
  const { t } = useLanguage();
  const state = sync && sync.current ? sync.state : "pending";
  const look = {
    pending: ["caseForm.sync.pending", "border-[var(--app-border)] text-[var(--app-muted)]"],
    stored: ["caseForm.sync.stored", "border-emerald-400/50 text-emerald-600 dark:text-emerald-300"],
    kept_as_draft: ["caseForm.sync.keptAsDraft", "border-amber-400/60 text-amber-700 dark:text-amber-300"],
    not_stored: ["caseForm.sync.notStored", "border-rose-400/60 text-rose-600 dark:text-rose-300"],
    waiting_files: ["caseForm.sync.waitingFiles", "border-sky-400/60 text-sky-700 dark:text-sky-300"],
  }[state];
  return <span className={`rounded-full border px-2 py-0.5 text-[11px] font-semibold ${look[1]}`}
    title={sync?.at ? new Date(sync.at).toLocaleString() : undefined}>{t(look[0])}</span>;
}
