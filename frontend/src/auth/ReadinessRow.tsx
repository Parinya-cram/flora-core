import { useLanguage } from "../context/LanguageContext";

export type Readiness = "ready" | "checking" | "unavailable" | "not-connected";

export function ReadinessRow({ label, state }: { label: string; state: Readiness }) {
  const { t } = useLanguage();
  const tone = state === "ready"
    ? "bg-emerald-500"
    : state === "unavailable"
      ? "bg-rose-500"
      : "bg-amber-400";
  const value = state === "ready"
    ? t("status.ready")
    : state === "checking"
      ? t("status.checking")
      : state === "not-connected"
        ? t("status.notConnected")
        : t("status.unavailable");
  return (
    <div className="flex min-h-[42px] items-center gap-[10px] rounded-lg border border-[var(--app-border)] bg-[var(--app-control-bg)] px-[12px] py-[8px]">
      <span aria-hidden="true" className={`h-[8px] w-[8px] shrink-0 rounded-full ${tone}`} />
      <span className="min-w-0 flex-1 text-[13px] font-medium text-[var(--app-text)]">{label}</span>
      <span className="text-right text-[11px] font-semibold text-[var(--app-muted)]">{value}</span>
    </div>
  );
}
