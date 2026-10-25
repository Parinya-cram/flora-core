import { useCallback, useEffect, useMemo, useState } from "react";
import { getCaseWorkflow, type CaseFormSync, type CaseWorkflow, type FormScheduleSummary, type WorkflowFormSchedule } from "../../api/workflowApi";

const EMPTY: CaseWorkflow = { workflow: null, forms: {} };
/** How often an open case re-reads its forms: Canopy's receipts and amendments arrive through the sync worker. */
export const CASE_FORMS_REFRESH_MS = 15_000;
/** Fired after a form of the case changed here (saved, workflow attached), to re-read at once. */
export const CASE_FORMS_CHANGED = "flora:case-forms-changed";

export type CaseWorkflowState = CaseWorkflow & { reload: () => void; replace: (value: CaseWorkflow) => void };

/** The case's workflow snapshot and its Form Studio forms (empty when the case has none), kept fresh while shown. */
export function useCaseWorkflow(caseId: number | null): CaseWorkflowState {
  const [state, setState] = useState<{ caseId: number | null; value: CaseWorkflow }>({ caseId: null, value: EMPTY });
  const [tick, setTick] = useState(0);
  const reload = useCallback(() => setTick(value => value + 1), []);
  const replace = useCallback((value: CaseWorkflow) => setState({ caseId, value }), [caseId]);
  useEffect(() => {
    if (caseId == null) return;
    let cancelled = false;
    void getCaseWorkflow(caseId)
      .then(value => { if (!cancelled) setState(current => (current.caseId === caseId && same(current.value, value) ? current : { caseId, value })); })
      .catch(() => { if (!cancelled) setState(current => (current.caseId === caseId ? current : { caseId, value: EMPTY })); });
    return () => { cancelled = true; };
  }, [caseId, tick]);
  useEffect(() => {
    if (caseId == null) return;
    const timer = window.setInterval(() => { if (document.visibilityState === "visible") reload(); }, CASE_FORMS_REFRESH_MS);
    window.addEventListener(CASE_FORMS_CHANGED, reload);
    return () => { window.clearInterval(timer); window.removeEventListener(CASE_FORMS_CHANGED, reload); };
  }, [caseId, reload]);
  const value = state.caseId === caseId ? state.value : EMPTY;
  return useMemo(() => ({ ...value, reload, replace }), [value, reload, replace]);
}

function same(a: CaseWorkflow, b: CaseWorkflow): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export type WorkflowFormStatus = "empty" | "draft" | "completed";
export type WorkflowFormTab = {
  formId: string; title: string; required: boolean; phase: string; afterSection: string | null; hint: string;
  status: WorkflowFormStatus; sync: CaseFormSync["state"] | null; synced: boolean;
  /** The form this tab fills (formId without a copy number) and which copy it is (1 = the form itself). */
  of: string; instance: number;
  /** On the last tab of a repeatable form: the key of the next copy it may have, else null. */
  nextCopy: string | null;
  /** Filled once per slot (ScheduledFormPanel); null: one record per case. */
  schedule: WorkflowFormSchedule | null;
  /** Due/overdue counts of a scheduled form when the case's workflow was read. */
  summary: FormScheduleSummary | null;
};

/** Most copies of a repeatable form when the workflow sets no max_instances (case_forms.MAX_INSTANCES). */
export const MAX_COPIES = 99;
/** The key of copy `instance` of a form: the form's id, then "<form_id>~2", "<form_id>~3"... */
export const copyKey = (formId: string, instance: number) => (instance > 1 ? `${formId}~${instance}` : formId);

/** Workflow form tabs in the workflow's order (only forms the Leaf has a definition for). A repeatable form has a tab
 * per copy: the copies filled on the case, then `added` copies opened here and not saved yet. */
export function workflowFormTabs(value: CaseWorkflow, added: readonly string[] = []): WorkflowFormTab[] {
  const refs = value.workflow?.forms || [];
  return refs
    // display "report": printed from Reports only, no data-entry tab.
    .filter(ref => value.forms[ref.form_id]?.definition && ref.display !== "report")
    .flatMap(ref => {
      const title = ref.title || value.forms[ref.form_id].definition.title || ref.form_id;
      const schedule = value.forms[ref.form_id].schedule ?? ref.schedule ?? null;
      const numbers = [1];
      if (ref.repeatable && !schedule) {
        for (const form of Object.values(value.forms)) if (form.of === ref.form_id && form.instance && form.instance > 1) numbers.push(form.instance);
        for (const key of added) {
          const match = /^(.+)~(\d+)$/.exec(key);
          if (match && match[1] === ref.form_id) numbers.push(Number(match[2]));
        }
      }
      const copies = [...new Set(numbers)].sort((a, b) => a - b);
      const limit = Math.min(ref.max_instances ?? MAX_COPIES, MAX_COPIES);
      return copies.map((instance, index): WorkflowFormTab => {
        const record = value.forms[copyKey(ref.form_id, instance)]?.record ?? null;
        const last = index === copies.length - 1;
        return {
          formId: copyKey(ref.form_id, instance),
          title: copies.length > 1 ? `${title} (${instance})` : title,
          required: Boolean(ref.required),
          phase: ref.phase || "any",
          afterSection: ref.after_section || null,
          hint: ref.hint || "",
          status: record ? record.status : "empty",
          sync: record?.sync?.state ?? null,
          synced: Boolean(record?.sync?.current),
          of: ref.form_id,
          instance,
          // A scheduled form has no copies: its fills are entries per slot.
          nextCopy: ref.repeatable && !schedule && last && instance < limit ? copyKey(ref.form_id, instance + 1) : null,
          schedule,
          summary: value.forms[ref.form_id].summary ?? null,
        };
      });
    });
}

/** Required workflow forms of the case not completed yet (warned about at discharge): the form itself, and every
 * further copy of it someone started. */
export function incompleteRequiredForms(value: CaseWorkflow): WorkflowFormTab[] {
  return workflowFormTabs(value).filter(tab => tab.required && !tab.schedule && tab.status !== "completed"
    && (tab.instance === 1 || tab.status !== "empty"));
}

export type CaseTab = { kind: "record"; id: string } | { kind: "form"; tab: WorkflowFormTab };

/** Record tabs and workflow form tabs in one row: each form right after the record tab Workflow Studio placed it
 * after (in workflow order), and forms placed nowhere or after a tab this case does not show at the end. */
export function orderCaseTabs(recordTabs: readonly string[], formTabs: readonly WorkflowFormTab[]): CaseTab[] {
  const shown = new Set(recordTabs);
  const out: CaseTab[] = [];
  for (const id of recordTabs) {
    out.push({ kind: "record", id });
    for (const tab of formTabs) if (tab.afterSection === id) out.push({ kind: "form", tab });
  }
  for (const tab of formTabs) if (!tab.afterSection || !shown.has(tab.afterSection)) out.push({ kind: "form", tab });
  return out;
}
