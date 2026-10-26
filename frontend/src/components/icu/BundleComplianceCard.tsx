import { useCallback, useEffect, useState } from "react";
import { getCaseBundleCompliance, type CaseBundle, type CaseBundleCompliance, type CaseSlotStatus } from "../../api/icuKpiApi";
import { useLanguage } from "../../context/LanguageContext";

/** Leaf: care-bundle compliance of the open case (GET /api/case/{id}/bundle-compliance): per bundle %, today's
 *  slots per shift and the items most often missing. Renders nothing when the case's workflow has no bundle form. */

const TEXT = {
  en: {
    title: "Bundle compliance", refresh: "Refresh", loading: "Loading…", today: "Today", missing: "Often missing",
    missed: "missed", slots: "slots", last7: "Last 7 days", none: "Nothing missing", error: "Bundle compliance is unavailable.",
    status: { done: "Done", draft: "Draft", skipped: "Skipped", missed: "Missed", pending: "Due", upcoming: "Later" } as Record<CaseSlotStatus, string>,
    notApplicable: "n/a", compliant: "compliant",
  },
  th: {
    title: "การปฏิบัติตาม bundle", refresh: "รีเฟรช", loading: "กำลังโหลด…", today: "วันนี้", missing: "รายการที่ขาดบ่อย",
    missed: "ไม่ได้บันทึก", slots: "ครั้ง", last7: "7 วันล่าสุด", none: "ไม่มีรายการที่ขาด", error: "ไม่สามารถโหลดข้อมูล bundle ได้",
    status: { done: "บันทึกแล้ว", draft: "ร่าง", skipped: "ข้าม", missed: "ไม่ได้บันทึก", pending: "ถึงเวลา", upcoming: "ภายหลัง" } as Record<CaseSlotStatus, string>,
    notApplicable: "ไม่เกี่ยวข้อง", compliant: "ผ่าน",
  },
};

function tone(pct: number | null | undefined) {
  if (pct == null) return "var(--app-muted)";
  return pct >= 90 ? "rgb(16 185 129)" : pct >= 75 ? "rgb(245 158 11)" : "rgb(244 63 94)";
}

function slotTone(slot: CaseBundle["today"][number]) {
  if (slot.status === "pending" || slot.status === "upcoming") return "border-[var(--app-border)] text-[var(--app-muted)]";
  if (!slot.applicable) return "border-[var(--app-border)] text-[var(--app-muted)]";
  return slot.compliant ? "border-emerald-500/50 bg-emerald-500/10 text-emerald-500" : "border-rose-500/50 bg-rose-500/10 text-rose-500";
}

function slotTime(ts: number) {
  return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

export default function BundleComplianceCard({ caseId }: { caseId: number }) {
  const { language: current } = useLanguage();
  const language = current === "th" ? "th" : "en";
  const L = TEXT[language];
  const [data, setData] = useState<CaseBundleCompliance | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      setData(await getCaseBundleCompliance(caseId));
      setError("");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : L.error);
    } finally { setLoading(false); }
  }, [caseId, L.error]);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), 120_000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  if (!error && data && !data.bundles.length) return null;
  const labelOf = (bundle: CaseBundle, key: string) => bundle.items.find(item => item.key === key)?.label[language] || key;

  return <section className="rounded-2xl border border-[var(--app-border)] bg-[var(--app-panel-bg)] p-3 text-[var(--app-text)]">
    <header className="mb-2 flex items-center justify-between gap-2">
      <h3 className="text-xs font-extrabold uppercase tracking-[0.12em] text-[var(--app-muted)]">{L.title}</h3>
      <button type="button" onClick={() => void refresh()} disabled={loading} className="rounded-lg border border-[var(--app-border)] bg-[var(--app-control-bg)] px-2 py-1 text-[11px] font-semibold hover:border-[var(--app-accent)] disabled:opacity-50">{loading ? L.loading : L.refresh}</button>
    </header>
    {error ? <div className="rounded-lg border border-rose-500/40 bg-rose-500/10 px-3 py-2 text-xs text-rose-500">{error}</div> : null}
    <div className="space-y-3">
      {(data?.bundles || []).map(bundle => <article key={bundle.id} className="rounded-xl border border-[var(--app-border)] bg-[var(--app-control-bg)] p-2.5">
        <div className="flex items-baseline justify-between gap-2">
          <div className="truncate text-sm font-semibold">{bundle.label[language]}</div>
          <div className="shrink-0 text-right"><b className="text-base tabular-nums" style={{ color: tone(bundle.pct) }}>{bundle.pct == null ? "—" : `${bundle.pct}%`}</b>
            <span className="ml-1 text-[10px] tabular-nums text-[var(--app-muted)]">{bundle.compliant}/{bundle.applicable}{bundle.missed ? ` · ${bundle.missed} ${L.missed}` : ""}</span></div>
        </div>
        <div className="mt-1.5 h-2 overflow-hidden rounded-full bg-[var(--app-border)]"><div className="h-full rounded-full" style={{ width: `${Math.max(0, Math.min(100, bundle.pct ?? 0))}%`, background: tone(bundle.pct) }} /></div>
        <div className="mt-2 flex items-end gap-0.5" title={L.last7} aria-label={L.last7}>
          {bundle.by_day.map(day => <div key={day.date} className="flex-1" title={`${day.date}: ${day.pct == null ? "—" : `${day.pct}%`} (${day.compliant}/${day.applicable})`}>
            <div className="mx-auto w-full rounded-sm" style={{ height: `${day.pct == null ? 2 : 4 + (day.pct / 100) * 14}px`, background: day.pct == null ? "var(--app-border)" : tone(day.pct) }} />
          </div>)}
        </div>
        {bundle.today.length ? <div className="mt-2">
          <div className="text-[10px] font-extrabold uppercase tracking-wide text-[var(--app-muted)]">{L.today}</div>
          <div className="mt-1 flex flex-wrap gap-1">{bundle.today.map(slot => <span key={slot.slot_ts} className={`rounded-md border px-1.5 py-0.5 text-[11px] ${slotTone(slot)}`}
            title={slot.missing.length ? slot.missing.map(key => labelOf(bundle, key)).join(", ") : slot.applicable && slot.compliant ? L.compliant : ""}>
            <b>{slot.shift || slotTime(slot.slot_ts)}</b> {slot.applicable || slot.status === "pending" || slot.status === "upcoming" ? L.status[slot.status] : L.notApplicable}
            {slot.missing.length ? ` · −${slot.missing.length}` : ""}</span>)}</div>
        </div> : null}
        <div className="mt-2">
          <div className="text-[10px] font-extrabold uppercase tracking-wide text-[var(--app-muted)]">{L.missing}</div>
          {bundle.top_missing.length ? <ul className="mt-1 space-y-0.5">{bundle.top_missing.slice(0, 3).map(item => <li key={item.item} className="flex justify-between gap-2 text-xs"><span className="truncate">{item.label[language]}</span><span className="tabular-nums text-[var(--app-muted)]">{item.count} {L.slots}</span></li>)}</ul>
            : <div className="mt-1 text-xs text-[var(--app-muted)]">{L.none}</div>}
        </div>
      </article>)}
    </div>
  </section>;
}
