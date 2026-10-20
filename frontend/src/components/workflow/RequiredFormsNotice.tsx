import { useEffect, useState } from "react";
import { getCaseWorkflow } from "../../api/workflowApi";
import { useLanguage } from "../../context/LanguageContext";
import { incompleteRequiredForms, type WorkflowFormTab } from "./caseWorkflow";

/** At discharge: the case's required workflow forms (Workflow Studio "required") not completed yet. A reminder;
 * discharge stays possible (documentation may be finished after it until the case is archived). */
export default function RequiredFormsNotice({ caseId }: { caseId: number }) {
  const { t } = useLanguage();
  const [missing, setMissing] = useState<WorkflowFormTab[]>([]);
  useEffect(() => {
    let cancelled = false;
    void getCaseWorkflow(caseId).then(value => { if (!cancelled) setMissing(incompleteRequiredForms(value)); }).catch(() => undefined);
    return () => { cancelled = true; };
  }, [caseId]);
  if (!missing.length) return null;
  return <div className="rounded-xl border border-amber-500/50 bg-amber-500/10 px-3 py-2 text-sm">
    <div className="font-bold">{t("caseForm.requiredMissing")} · {missing.length}</div>
    <div className="mt-1 flex flex-wrap gap-1.5">
      {missing.map(tab => <span key={tab.formId} className="rounded-full border border-amber-500/40 bg-[var(--app-panel-bg)] px-2 py-1 text-xs font-semibold">
        {tab.title}{tab.status === "draft" ? " · draft" : ""}
      </span>)}
    </div>
  </div>;
}
