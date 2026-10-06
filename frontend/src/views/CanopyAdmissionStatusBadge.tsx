import type { Admission } from "../api/admissionApi";

const tones = {
  waiting: "border-amber-400/40 bg-amber-400/12 text-amber-700 dark:text-amber-300",
  started: "border-emerald-400/40 bg-emerald-500/12 text-emerald-700 dark:text-emerald-300",
  conflict: "border-rose-400/40 bg-rose-500/12 text-rose-600 dark:text-rose-300",
  muted: "border-[var(--app-border)] bg-[var(--app-control-bg)] text-[var(--app-muted)]",
};

/** Where a Canopy admission stands relative to the bedside Leaf. */
export function AdmissionStatusBadge({ admission }: { admission: Pick<Admission, "status" | "claimedLeafName" | "claimedLeafId"> }) {
  const [label, tone] = admission.status === "pending"
    ? ["Waiting at Leaf", tones.waiting]
    : admission.status === "started"
      ? [`Started at ${admission.claimedLeafName || admission.claimedLeafId || "Leaf"}`, tones.started]
      : admission.status === "conflict"
        ? ["Conflict", tones.conflict]
        : ["Cancelled", tones.muted];
  return <span className={`inline-flex items-center rounded-full border px-2.5 py-1 text-xs font-bold ${tone}`}>{label}</span>;
}

/** Leaf case lifecycle once an admission has started. */
export function AdmissionCaseBadge({ caseStatus }: { caseStatus: Admission["caseStatus"] }) {
  if (!caseStatus) return null;
  const tone = caseStatus === "active" ? tones.started : tones.muted;
  const label = caseStatus === "active" ? "Case active" : caseStatus === "discharged" ? "Case discharged" : "Case archived";
  return <span className={`inline-flex items-center rounded-full border px-2.5 py-1 text-xs font-semibold ${tone}`}>{label}</span>;
}
