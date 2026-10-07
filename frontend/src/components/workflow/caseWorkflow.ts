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

export type WorkflowFormTab = { formId: string; title: string; required: boolean; phase: string };

/** Workflow form tabs in the workflow's order (only forms the Leaf has a definition for). */
export function workflowFormTabs(value: CaseWorkflow): WorkflowFormTab[] {
  const refs = value.workflow?.forms || [];
  return refs
    .filter(ref => value.forms[ref.form_id]?.definition)
    .map(ref => ({
      formId: ref.form_id,
      title: ref.title || value.forms[ref.form_id].definition.title || ref.form_id,
      required: Boolean(ref.required),
      phase: ref.phase || "any",
    }));
}
