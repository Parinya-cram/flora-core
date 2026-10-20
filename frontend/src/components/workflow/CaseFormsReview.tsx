import { useEffect, useState } from "react";
import { getCaseFormHistory, getCaseFormsReview, reviewCaseForm, type CaseFormHistoryItem, type CaseFormReview } from "../../api/fleetApi";
import type { FieldDefinition } from "../../formdev/core/types";
import FormRenderer from "../../formdev/ui/FormRenderer";

const RECEIPT: Record<CaseFormReview["recordState"], [string, string]> = {
  pending: ["Not in Form Studio yet", "text-[var(--app-muted)]"],
  stored: ["Stored in Form Studio", "text-emerald-600 dark:text-emerald-300"],
  kept_as_draft: ["Kept as a draft in Form Studio", "text-amber-700 dark:text-amber-300"],
  not_stored: ["Not stored in Form Studio", "text-rose-600 dark:text-rose-300"],
  waiting_files: ["Waiting for files from the Leaf", "text-sky-700 dark:text-sky-300"],
};

const fieldsOf = (list: FieldDefinition[]): FieldDefinition[] => list.flatMap(field => [field, ...fieldsOf(field.fields || [])]);

/** The case's Workflow Studio forms in Canopy, read-only: what was filled at the bedside (or for the admission), who
 * changed each field, the amendments made in Canopy and on the Leaf (with reasons), and where each form stands in Form
 * Studio. Changes are made as amendments in Form Studio (Records), which sends them back to the Leaf. */
const REVIEW: Record<NonNullable<CaseFormReview["review"]>["state"], [string, string]> = {
  none: ["Not reviewed", "border-[var(--app-border)] text-[var(--app-muted)]"],
  reviewed: ["Reviewed", "border-sky-400/60 text-sky-700 dark:text-sky-300"],
  approved: ["Approved", "border-emerald-500/60 text-emerald-700 dark:text-emerald-300"],
  changed_since_review: ["Changed since review", "border-amber-500/60 text-amber-700 dark:text-amber-300"],
};

const short = (value: unknown) => {
  const text = value === null || value === undefined ? "—" : typeof value === "object" ? JSON.stringify(value) : String(value);
  return text.length > 60 ? `${text.slice(0, 57)}…` : text;
};

/** Reviewed → Approved for one form, and its history (record versions, amendments, review actions). */
function ReviewBar({ globalCaseId, form, onChanged }: { globalCaseId: string; form: CaseFormReview; onChanged: () => void }) {
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [history, setHistory] = useState<CaseFormHistoryItem[] | null>(null);
  const review = form.review ?? { state: "none" as const, reviewedBy: null, reviewedAt: null, approvedBy: null, approvedAt: null };
  const act = async (action: "reviewed" | "approved") => {
    setBusy(true);
    setError("");
    try {
      await reviewCaseForm(globalCaseId, form.formId, action, note.trim() || undefined);
      setNote("");
      setHistory(null);
      onChanged();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };
  const [label, tone] = REVIEW[review.state] ?? REVIEW.none;
  const canReview = form.status === "completed" && review.state !== "reviewed" && review.state !== "approved";
  return <div className="space-y-2 rounded-lg border border-[var(--app-border)] p-2">
    <div className="flex flex-wrap items-center gap-2">
      <span className={`rounded-full border px-2 py-0.5 font-semibold ${tone}`}>{label}</span>
      {review.reviewedBy ? <span className="text-[var(--app-muted)]">Reviewed by {review.reviewedBy} · {new Date(review.reviewedAt ?? 0).toLocaleString()}</span> : null}
      {review.approvedBy ? <span className="text-[var(--app-muted)]">Approved by {review.approvedBy} · {new Date(review.approvedAt ?? 0).toLocaleString()}</span> : null}
      {form.status !== "completed" ? <span className="text-[var(--app-muted)]">Review once it is completed on the Leaf.</span> : null}
    </div>
    {canReview || review.state === "reviewed" ? <div className="flex flex-wrap items-end gap-2">
      <input value={note} onChange={event => setNote(event.target.value)} maxLength={500} placeholder="Note (optional)"
        className="min-w-56 flex-1 rounded-lg border border-[var(--app-border)] bg-[var(--app-panel-bg)] px-2 py-1" />
      {canReview ? <button type="button" disabled={busy} onClick={() => void act("reviewed")}
        className="rounded-lg border border-sky-500 px-3 py-1 font-semibold text-sky-700 disabled:opacity-50 dark:text-sky-300">Mark reviewed</button> : null}
      {review.state === "reviewed" ? <button type="button" disabled={busy} onClick={() => void act("approved")}
        className="rounded-lg bg-emerald-600 px-3 py-1 font-semibold text-white disabled:opacity-50">Approve</button> : null}
    </div> : null}
    {error ? <p className="text-rose-600">{error}</p> : null}
    <details onToggle={event => {
      if ((event.target as HTMLDetailsElement).open && history === null) void getCaseFormHistory(globalCaseId, form.formId).then(setHistory).catch(() => setHistory([]));
    }}>
      <summary className="cursor-pointer font-semibold">History</summary>
      {history === null ? <p className="text-[var(--app-muted)]">Loading…</p> : <ul className="mt-1 space-y-1">
        {history.map((item, index) => <li key={index}>
          <b>{new Date(item.at).toLocaleString()}</b> · {item.by} · {item.kind === "version" ? `version ${item.version} (${item.status})`
            : item.kind === "amendment" ? `amendment “${item.reason}”` : `${item.kind}${item.note ? ` “${item.note}”` : ""}`}
          {item.changes && Object.keys(item.changes).length ? <span className="text-[var(--app-muted)]"> · {Object.entries(item.changes).slice(0, 12)
            .map(([key, change]) => `${key}: ${short(change.from)} → ${short(change.to)}`).join("; ")}</span> : null}
        </li>)}
        {!history.length ? <li className="text-[var(--app-muted)]">No history yet.</li> : null}
      </ul>}
    </details>
  </div>;
}

export default function CaseFormsReview({ globalCaseId }: { globalCaseId: string }) {
  const [forms, setForms] = useState<CaseFormReview[] | null>(null);
  const [error, setError] = useState("");
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let cancelled = false;
    void getCaseFormsReview(globalCaseId)
      .then(rows => { if (!cancelled) setForms(rows); })
      .catch(reason => { if (!cancelled) setError(reason instanceof Error ? reason.message : String(reason)); });
    return () => { cancelled = true; };
  }, [globalCaseId, tick]);
  if (error) return <div className="rounded-xl border border-rose-500/40 bg-rose-500/10 px-3 py-2 text-xs text-rose-600">Workflow forms: {error}</div>;
  if (!forms?.length) return null;
  return <section className="space-y-3">
    <h2 className="text-xs font-extrabold uppercase tracking-[0.14em] text-[var(--app-muted)]">Workflow forms (Form Studio) · {forms.length}</h2>
    {forms.map((form, index) => {
      const labels = new Map(fieldsOf((form.definition?.sections || []).flatMap(section => section.fields)).map(field => [field.id, String(field.label || field.id)]));
      const label = (key: string) => (key === "__status" ? "status" : labels.get(key) || key);
      const leafAmendments = Object.entries(form.authors || {}).filter(([, author]) => author?.via === "leaf" && author.reason).sort(([, a], [, b]) => b.at - a.at);
      const filledBy = [...new Set(Object.values(form.authors || {}).map(author => `${author.by}${author.via === "canopy" ? " (Canopy)" : ""}`))];
      const [receipt, tone] = RECEIPT[form.recordState] || RECEIPT.pending;
      return <details key={`${form.formId}-${form.caseKey}`} open={index === 0} className="overflow-hidden rounded-2xl border border-[var(--app-border)] bg-[var(--app-panel-bg)]">
        <summary className="flex cursor-pointer list-none flex-wrap items-center justify-between gap-2 bg-[var(--app-control-bg)] px-4 py-3">
          <div>
            <div className="font-bold text-[var(--app-text)]">{form.definition?.title || form.form || form.formId}{form.instance && form.instance > 1 ? ` (${form.instance})` : ""} <span className="text-xs font-normal text-[var(--app-muted)]">v{form.formVersion}</span></div>
            <div className="text-xs text-[var(--app-muted)]">{filledBy.length ? `Filled by ${filledBy.join(", ")}` : "Not filled yet"} · updated {new Date(form.updatedAt).toLocaleString()}</div>
          </div>
          <div className="flex flex-wrap items-center gap-2 text-xs font-semibold">
            <span className={`rounded-full border px-2 py-0.5 ${form.status === "completed" ? "border-emerald-400/50 text-emerald-600 dark:text-emerald-300" : "border-[var(--app-border)] text-[var(--app-muted)]"}`}>
              {form.status === "completed" ? "Completed on the Leaf" : "Draft on the Leaf"}</span>
            <span className={tone}>{receipt}</span>
            {form.pendingToLeaf ? <span className="text-amber-700 dark:text-amber-300">Amendment on its way to the Leaf</span> : null}
            {form.review && form.review.state !== "none" ? <span className={`rounded-full border px-2 py-0.5 ${REVIEW[form.review.state][1]}`}>{REVIEW[form.review.state][0]}</span> : null}
          </div>
        </summary>
        <div className="space-y-3 p-4 text-xs">
          <ReviewBar globalCaseId={globalCaseId} form={form} onChanged={() => setTick(value => value + 1)} />
          {form.recordIssues.length && form.recordState !== "stored" ? <ul className="list-disc rounded-lg bg-amber-500/10 py-2 pl-6 pr-2 text-amber-800 dark:text-amber-200">
            {form.recordIssues.slice(0, 10).map((issue, i) => <li key={i}>{label(issue.path.replace(/^\$\.data\./, "").split(/[.[]/)[0])}: {issue.message}</li>)}
          </ul> : null}
          {form.amendments.length || leafAmendments.length ? <div className="rounded-lg border border-sky-400/40 bg-sky-500/5 p-2">
            <div className="font-semibold">Amendments</div>
            <ul className="mt-1 space-y-0.5">
              {form.amendments.map((item, i) => <li key={`c${i}`}><b>{new Date(item.at).toLocaleString()}</b> · Canopy · {item.by} · “{item.reason}”: {Object.entries(item.changes).map(([key, change]) => `${label(key)} ${JSON.stringify(change.from ?? "")} → ${JSON.stringify(change.to ?? "")}`).join("; ")}</li>)}
              {leafAmendments.map(([key, author]) => <li key={`l${key}`}><b>{new Date(author.at).toLocaleString()}</b> · Leaf · {author.by} · {label(key)} · “{author.reason}”</li>)}
            </ul>
          </div> : null}
          {form.definition ? <FormRenderer definition={form.definition} value={form.data} readOnly context="detail" onChange={() => undefined} />
            : <p className="text-[var(--app-muted)]">The form definition (v{form.formVersion}) is not in Form Studio.</p>}
          <p className="text-[var(--app-muted)]">Record {form.recordId}: to change a value, amend it with a reason in Form Studio → Records.</p>
        </div>
      </details>;
    })}
  </section>;
}
