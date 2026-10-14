import { useEffect, useState } from "react";
import { getCaseWorkflow, type CaseWorkflow } from "../../api/workflowApi";

const EMPTY: CaseWorkflow = { workflow: null, forms: {} };

/** The case's workflow snapshot and its Form Studio forms (empty when the case has none). */
export function useCaseWorkflow(caseId: number | null): CaseWorkflow {
  const [state, setState] = useState<{ caseId: number | null; value: CaseWorkflow }>({ caseId: null, value: EMPTY });
  useEffect(() => {
    if (caseId == null) return;
    let cancelled = false;
    void getCaseWorkflow(caseId)
      .then(value => { if (!cancelled) setState({ caseId, value }); })
      .catch(() => { if (!cancelled) setState({ caseId, value: EMPTY }); });
    return () => { cancelled = true; };
  }, [caseId]);
  return state.caseId === caseId ? state.value : EMPTY;
}

export type WorkflowFormTab = { formId: string; title: string; required: boolean; phase: string; afterSection: string | null; hint: string };

/** Workflow form tabs in the workflow's order (only forms the Leaf has a definition for). */
export function workflowFormTabs(value: CaseWorkflow): WorkflowFormTab[] {
  const refs = value.workflow?.forms || [];
  return refs
    // display "report": printed from Reports only, no data-entry tab.
    .filter(ref => value.forms[ref.form_id]?.definition && ref.display !== "report")
    .map(ref => ({
      formId: ref.form_id,
      title: ref.title || value.forms[ref.form_id].definition.title || ref.form_id,
      required: Boolean(ref.required),
      phase: ref.phase || "any",
      afterSection: ref.after_section || null,
      hint: ref.hint || "",
    }));
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
