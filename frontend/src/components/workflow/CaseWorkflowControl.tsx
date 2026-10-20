import { useState } from "react";
import { attachCaseWorkflow, type CaseWorkflow, type WorkflowDefinition } from "../../api/workflowApi";
import { useLanguage } from "../../context/LanguageContext";
import { defaultWorkflowId, useLeafWorkflows } from "./leafWorkflows";
import WorkflowPicker from "./WorkflowPicker";
import { CASE_FORMS_CHANGED } from "./caseWorkflow";

type Props = {
  caseId: number;
  workflow: WorkflowDefinition | null;
  onAttached: (value: CaseWorkflow) => void;
};

/** Attach a workflow to an open case (one started before the workflow reached the ward, or without one), or change
 * it. Forms already filled keep their version and stay on the case; the Leaf records the change in the audit trail. */
export default function CaseWorkflowControl({ caseId, workflow, onAttached }: Props) {
  const { t } = useLanguage();
  const rows = useLeafWorkflows();
  const [pick, setPick] = useState("");
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  if (!rows.length) return null;
  const chosen = pick || (workflow?.id && rows.some(row => row.id === workflow.id) ? workflow.id : defaultWorkflowId(rows) || rows[0].id);

  const attach = async () => {
    setBusy(true);
    setError("");
    try {
      onAttached(await attachCaseWorkflow(caseId, chosen));
      window.dispatchEvent(new Event(CASE_FORMS_CHANGED));
      setOpen(false);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  const picker = <div className="flex flex-wrap items-end gap-2">
    <div className="min-w-64 flex-1"><WorkflowPicker rows={rows} value={chosen} onChange={setPick} disabled={busy} /></div>
    <button type="button" onClick={() => void attach()} disabled={busy || (workflow?.id === chosen && !open)}
      className="rounded-lg bg-[var(--app-accent)] px-3 py-2 text-xs font-bold text-[var(--app-accent-contrast)] disabled:opacity-50">
      {busy ? t("caseForm.attaching") : workflow ? t("caseForm.change") : t("caseForm.attach")}
    </button>
    <p className="basis-full text-[11px] text-[var(--app-muted)]">{t("caseForm.attachHelp")}</p>
    {error ? <p className="basis-full text-xs text-rose-500">{error}</p> : null}
  </div>;

  if (!workflow) {
    return <div className="mt-2 space-y-2 rounded-xl border border-amber-400/50 bg-amber-500/10 px-3 py-2 text-xs">
      <div className="font-semibold">{t("caseForm.noWorkflow")}</div>
      {picker}
    </div>;
  }
  return <div className="mt-2 text-xs">
    <button type="button" onClick={() => setOpen(value => !value)} className="font-semibold text-[var(--app-muted)] hover:text-[var(--app-text)]">
      Workflow: {workflow.name || workflow.id} · {t("caseForm.change")} {open ? "▴" : "▾"}
    </button>
    {open ? <div className="mt-2 rounded-xl border border-[var(--app-border)] bg-[var(--app-control-bg)] px-3 py-2">{picker}</div> : null}
  </div>;
}
