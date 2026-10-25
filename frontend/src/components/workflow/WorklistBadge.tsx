import type { WorklistCase } from "../../api/workflowApi";
import { worklistTitle } from "./caseWorklist";
import { BADGE_TONE, badgeFor } from "./formSchedule";

/** A case's due/overdue scheduled forms as one small chip (nothing when none are pending). */
export default function WorklistBadge({ item, compact = false }: { item: WorklistCase | undefined; compact?: boolean }) {
  const badge = badgeFor(item);
  if (!badge) return null;
  return <span title={worklistTitle(item)} className={`inline-flex shrink-0 items-center rounded-full border px-1.5 py-0.5 text-[10px] font-bold ${BADGE_TONE[badge.tone]}`}>
    {compact ? badge.count : `${badge.text} form${badge.count === 1 ? "" : "s"}`}
  </span>;
}
