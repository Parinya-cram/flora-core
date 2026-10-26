import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLanguage } from "../../context/LanguageContext";
import {
  closeBillingDay, generateBillingDay, getBillingCatalog, getBillingDay, getBillingEstimate, getBillingPeriods, reopenBillingDay,
  saveBillingDay, type BillingCatalog, type BillingDay, type BillingDayDetail, type BillingEstimate, type BillingLine, type BillingPeriods,
} from "../../api/billingApi";

/**
 * ICU daily billing (docs/BILLING.md): one bill per billing day from the workflow's day_start.
 * Standing charges (bed-day, nursing care-day, monitoring-day, device-days) are added by the Leaf ("auto");
 * staff add the day's other items. Close day locks the day and sends it to Canopy.
 */

const TEXT = {
  en: {
    title: "ICU daily billing", days: "Billing days", day: "Day", open: "Open", closed: "Closed", today: "today",
    estimate: "Cost estimate", toDate: "So far", closedTotal: "Closed days", openTotal: "Open days", projected: "Standing to today",
    extra: "More days", perDay: "per day", projectedTotal: "Projected", discharged: "Discharged: no further days",
    lines: "Items", auto: "auto", add: "+ Add item…", empty: "No items on this day yet.", qty: "Qty", amount: "Amount",
    refresh: "Refresh standing charges", close: "Close day", reopen: "Reopen", saving: "Saving…", saved: "Saved", dirty: "Unsaved changes",
    saveFailed: "Save failed", closedNote: "Closed — this day is locked and was sent to billing.", archived: "This case is archived, so its billing can no longer be changed.",
    handover: "Billed under the previous case before the handover.", unknownDevices: "Device type unknown — add its device-day item by hand:",
    readOnly: "Read only: opening a day needs charting permission.", reopenHint: "Reopening a closed day needs the billing.manage permission.",
    caseBilling: "Case billing", loading: "Loading daily billing…", total: "Day total", window: "Window", standingNote: "Standing charges replace themselves when refreshed; a manual line of the same item overrides the auto line.",
  },
  th: {
    title: "ค่าบริการ ICU รายวัน", days: "วันที่คิดค่าบริการ", day: "วันที่", open: "เปิด", closed: "ปิดแล้ว", today: "วันนี้",
    estimate: "ประมาณการค่าใช้จ่าย", toDate: "ถึงปัจจุบัน", closedTotal: "วันที่ปิดแล้ว", openTotal: "วันที่ยังเปิด", projected: "ค่าประจำถึงวันนี้",
    extra: "เพิ่มอีก (วัน)", perDay: "ต่อวัน", projectedTotal: "ประมาณการรวม", discharged: "จำหน่ายแล้ว: ไม่มีวันเพิ่ม",
    lines: "รายการ", auto: "อัตโนมัติ", add: "+ เพิ่มรายการ…", empty: "ยังไม่มีรายการในวันนี้", qty: "จำนวน", amount: "ราคา",
    refresh: "คำนวณค่าประจำใหม่", close: "ปิดวัน", reopen: "เปิดใหม่", saving: "กำลังบันทึก…", saved: "บันทึกแล้ว", dirty: "ยังไม่ได้บันทึก",
    saveFailed: "บันทึกไม่สำเร็จ", closedNote: "ปิดแล้ว — วันนี้ถูกล็อกและส่งไปฝ่ายการเงินแล้ว", archived: "เคสนี้ถูกเก็บถาวร ไม่สามารถแก้ไขค่าบริการได้",
    handover: "เรียกเก็บภายใต้เคสเดิมก่อนการส่งต่อ", unknownDevices: "ไม่ทราบชนิดอุปกรณ์ — เพิ่มรายการค่าอุปกรณ์รายวันเอง:",
    readOnly: "อ่านอย่างเดียว: การเปิดวันต้องมีสิทธิ์บันทึกข้อมูล", reopenHint: "การเปิดวันที่ปิดแล้วต้องมีสิทธิ์ billing.manage",
    caseBilling: "ค่าบริการรายเคส", loading: "กำลังโหลดค่าบริการรายวัน…", total: "รวมวันนี้", window: "ช่วงเวลา", standingNote: "ค่าประจำจะคำนวณใหม่เมื่อกดคำนวณ รายการที่เพิ่มเองของรายการเดียวกันจะใช้แทนรายการอัตโนมัติ",
  },
};

type Manual = { key: string; item_code: string | null; group_code: string; name: string; variant: string | null; qty: string; source: "manual" | "io_suggestion" };
const money = (n: number | null | undefined) => (n == null ? "—" : `${Number(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} THB`);
const input = "rounded-md border border-[var(--app-border)] bg-[var(--app-control-bg,transparent)] px-2 py-1 text-sm";
const button = "rounded-xl border border-[var(--app-border)] px-3 py-1.5 text-sm font-semibold disabled:opacity-50";

function manualOf(lines: BillingLine[]): Manual[] {
  return lines.filter(line => line.source !== "standing").map(line => ({
    key: `m${line.line_no}`, item_code: line.item_code, group_code: line.group_code, name: line.name, variant: line.variant,
    qty: String(line.qty ?? 1), source: line.source === "io_suggestion" ? "io_suggestion" : "manual",
  }));
}

export default function DailyBillingPanel({ caseId, archived, onCaseBilling }: { caseId: number; archived: boolean; onCaseBilling?: () => void }) {
  const { language } = useLanguage();
  const L = TEXT[language === "th" ? "th" : "en"];
  const locale = language === "th" ? "th-TH" : undefined;
  const [catalog, setCatalog] = useState<BillingCatalog | null>(null);
  const [periods, setPeriods] = useState<BillingPeriods | null>(null);
  const [selected, setSelected] = useState<number | null>(null);
  const [detail, setDetail] = useState<BillingDayDetail | null>(null);
  const [manual, setManual] = useState<Manual[]>([]);
  const [estimate, setEstimate] = useState<BillingEstimate | null>(null);
  const [extraDays, setExtraDays] = useState("0");
  const [saveState, setSaveState] = useState<"idle" | "dirty" | "saving" | "saved" | "error">("idle");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const dirtyRef = useRef(false);
  const timerRef = useRef<number | undefined>(undefined);
  const fail = (err: unknown) => setError(err instanceof Error ? err.message : String(err));

  const tz = periods?.timezone;
  const dateText = useCallback((ts: number) => new Date(ts).toLocaleDateString(locale, { day: "2-digit", month: "2-digit", timeZone: tz }), [locale, tz]);
  const timeText = useCallback((ts: number) => new Date(ts).toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: tz }), [locale, tz]);

  const reloadPeriods = useCallback(() => getBillingPeriods(caseId).then(data => { setPeriods(data); return data; }), [caseId]);
  const reloadEstimate = useCallback((days: string) => getBillingEstimate(caseId, Number(days) || 0).then(setEstimate).catch(() => undefined), [caseId]);

  useEffect(() => {
    let alive = true;
    setError("");
    Promise.all([getBillingCatalog(), reloadPeriods()])
      .then(([cat, data]) => {
        if (!alive) return;
        setCatalog(cat);
        const current = data.days.find(d => d.current) || data.days[data.days.length - 1];
        setSelected(current ? current.period_start : null);
      })
      .catch(err => alive && fail(err));
    return () => { alive = false; };
  }, [reloadPeriods]);

  useEffect(() => { void reloadEstimate(extraDays); }, [extraDays, reloadEstimate]);

  const applyDetail = useCallback((data: BillingDayDetail) => {
    setDetail(data);
    setManual(manualOf(data.items));
  }, []);

  // Opening a day creates its order with the standing charges (when the user may chart).
  useEffect(() => {
    if (selected == null) return;
    let alive = true;
    dirtyRef.current = false;
    setSaveState("idle");
    getBillingDay(caseId, selected)
      .then(data => { if (!alive) return; applyDetail(data); void reloadPeriods(); void reloadEstimate(extraDays); })
      .catch(err => alive && fail(err));
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reload on day change only
  }, [caseId, selected, applyDetail]);

  const locked = archived || Boolean(detail?.locked) || !detail?.order;

  const save = useCallback(async () => {
    if (selected == null || !dirtyRef.current) return;
    dirtyRef.current = false;
    setSaveState("saving");
    try {
      const saved = await saveBillingDay(caseId, selected, {
        items: manual.map(line => ({ item_code: line.item_code, group_code: line.group_code, name: line.name, variant: line.variant,
          qty: Number(line.qty) || 0, source: line.source })),
      });
      setDetail(saved);
      setSaveState(dirtyRef.current ? "dirty" : "saved");
      void reloadPeriods();
      void reloadEstimate(extraDays);
    } catch (err) {
      dirtyRef.current = true;
      setSaveState("error");
      fail(err);
    }
  }, [caseId, extraDays, manual, reloadEstimate, reloadPeriods, selected]);

  useEffect(() => {
    if (saveState !== "dirty") return;
    window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(() => void save(), 1000);
    return () => window.clearTimeout(timerRef.current);
  }, [saveState, manual, save]);

  const touch = () => { if (locked) return; dirtyRef.current = true; setSaveState("dirty"); setError(""); };
  const addItem = (code: string) => {
    const item = catalog?.items.find(i => i.code === code);
    if (!item) return;
    setManual(list => {
      const found = list.find(line => line.item_code === code);
      if (found) return list.map(line => line === found ? { ...line, qty: String((Number(line.qty) || 0) + 1) } : line);
      const standing = detail?.items.find(line => line.source === "standing" && line.item_code === code);
      return [...list, { key: `n${Date.now()}`, item_code: code, group_code: item.group_code, name: item.name, variant: null,
        qty: String(standing?.qty ?? 1), source: "manual" }];
    });
    touch();
  };

  const run = async (action: "generate" | "close" | "reopen") => {
    if (selected == null) return;
    setBusy(true); setError("");
    try {
      if (dirtyRef.current) await save();
      const call = action === "generate" ? generateBillingDay : action === "close" ? closeBillingDay : reopenBillingDay;
      applyDetail(await call(caseId, selected));
      await reloadPeriods();
      void reloadEstimate(extraDays);
    } catch (err) {
      fail(err);
    } finally {
      setBusy(false);
    }
  };

  const standing = useMemo(() => {
    const taken = new Set(manual.map(line => line.item_code).filter(Boolean));
    const lines = detail?.order ? detail.items.filter(line => line.source === "standing") : detail?.standing_preview?.items || [];
    return lines.filter(line => !taken.has(line.item_code));
  }, [detail, manual]);
  const priceOf = useMemo(() => new Map((catalog?.items || []).map(i => [i.code, i.unit_price])), [catalog]);

  if (error && !periods) return <div className="p-6 text-sm text-red-600 dark:text-red-400">{error}</div>;
  if (!periods || !catalog) return <div className="p-6 text-sm text-[var(--app-muted)]">{L.loading}</div>;

  const current = periods.days.find(d => d.period_start === selected) || null;
  const dayLabel = (d: Pick<BillingDay, "day" | "period_start">) => `${L.day} ${d.day ?? "—"} · ${dateText(d.period_start)}`;
  const status = current?.status || "open";
  const savedText = saveState === "saving" ? L.saving : saveState === "dirty" ? L.dirty : saveState === "error" ? L.saveFailed : saveState === "saved" ? L.saved : "";
  const shownTotal = detail?.order ? detail.total_amount : detail?.standing_preview?.total_amount;

  return (
    <div className="app-theme-scope w-full space-y-3 p-4 pb-16 text-[var(--app-text)]">
      {/* Cost estimate */}
      <section className="flex flex-wrap items-center gap-x-6 gap-y-2 rounded-2xl border border-[var(--app-border)] bg-[var(--app-panel-bg)] p-3 shadow-sm">
        <div className="min-w-48">
          <div className="text-[10px] font-extrabold uppercase tracking-[0.16em] text-[var(--app-muted)]">{L.title}</div>
          <h1 className="text-lg font-bold">{L.estimate}</h1>
        </div>
        {estimate ? (
          <>
            {([[L.toDate, estimate.to_date_total], [L.closedTotal, estimate.closed_total], [L.openTotal, estimate.open_total], [L.projected, estimate.projected_to_today]] as const).map(([label, value]) => (
              <div key={label}><div className="text-[10px] font-extrabold uppercase tracking-[0.12em] text-[var(--app-muted)]">{label}</div><div className="font-semibold tabular-nums">{money(value)}</div></div>
            ))}
            <label className="grid gap-0.5 text-[10px] font-extrabold uppercase tracking-[0.12em] text-[var(--app-muted)]">{L.extra}
              <input type="number" min={0} max={365} value={extraDays} disabled={estimate.discharged} onChange={e => setExtraDays(e.target.value.replace(/[^0-9]/g, ""))} className={`${input} w-20 text-[var(--app-text)]`} />
            </label>
            <div className="ml-auto text-right">
              <div className="text-[10px] font-extrabold uppercase tracking-[0.12em] text-[var(--app-muted)]">{L.projectedTotal}</div>
              <div className="text-xl font-bold tabular-nums">{money(estimate.grand_total)}</div>
              <div className="text-xs text-[var(--app-muted)]">{estimate.discharged ? L.discharged : `${money(estimate.standing_per_day)} ${L.perDay}`}</div>
            </div>
          </>
        ) : null}
        {onCaseBilling && periods.can_switch ? <button type="button" onClick={onCaseBilling} className={button}>{L.caseBilling}</button> : null}
      </section>

      {error ? <div className="text-sm text-red-600 dark:text-red-400">{error}</div> : null}
      {periods.unknown_devices.length ? (
        <div className="rounded-xl border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:bg-amber-950/40 dark:text-amber-200">
          {L.unknownDevices} {periods.unknown_devices.map(d => d.label || d.device_id).join(", ")}
        </div>
      ) : null}

      <div className="grid gap-3 lg:grid-cols-[16rem_1fr]">
        {/* Day list */}
        <nav aria-label={L.days} className="h-fit overflow-hidden rounded-2xl border border-[var(--app-border)] bg-[var(--app-panel-bg)]">
          <div className="bg-[var(--app-accent)]/10 px-3 py-1.5 text-xs font-extrabold uppercase tracking-[0.1em]">{L.days}</div>
          <ul className="max-h-[60vh] divide-y divide-[var(--app-border)] overflow-auto">
            {[...periods.days].reverse().map(d => (
              <li key={d.period_start}>
                <button type="button" onClick={() => setSelected(d.period_start)} aria-current={d.period_start === selected ? "true" : undefined}
                  className={`flex w-full items-center gap-2 px-3 py-2 text-left text-sm ${d.period_start === selected ? "bg-[var(--app-accent)]/10 font-semibold" : "hover:bg-[var(--app-accent)]/5"}`}>
                  <span className="min-w-0 flex-1 truncate">{dayLabel(d)}{d.current ? <span className="ml-1 text-xs text-[var(--app-accent)]">· {L.today}</span> : null}</span>
                  <span className="tabular-nums text-xs text-[var(--app-muted)]">{d.total != null ? Number(d.total).toLocaleString() : "—"}</span>
                  <span className={`rounded-full px-2 py-0.5 text-[10px] font-bold ${d.status === "closed" ? "bg-emerald-100 text-emerald-800 dark:bg-emerald-950/50 dark:text-emerald-300" : "bg-amber-100 text-amber-800 dark:bg-amber-950/50 dark:text-amber-300"}`}>
                    {d.status === "closed" ? L.closed : L.open}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </nav>

        {/* The selected day */}
        <section className="min-w-0 space-y-3 rounded-2xl border border-[var(--app-border)] bg-[var(--app-panel-bg)] p-3">
          {current ? (
            <div className="flex flex-wrap items-center gap-3">
              <div className="min-w-0">
                <h2 className="text-base font-bold">{dayLabel(current)}</h2>
                <div className="text-xs text-[var(--app-muted)]">{L.window} {dateText(current.period_start)} {timeText(current.period_start)} – {dateText(current.period_end)} {timeText(current.period_end)} · {L.total} {money(shownTotal)}{savedText ? ` · ${savedText}` : ""}</div>
              </div>
              <div className="ml-auto flex flex-wrap gap-2">
                {!archived && status === "open" && detail?.order ? (
                  <>
                    <button type="button" disabled={busy} onClick={() => void run("generate")} className={button}>{L.refresh}</button>
                    <button type="button" disabled={busy} onClick={() => void run("close")}
                      className="rounded-xl bg-[var(--app-accent)] px-4 py-1.5 text-sm font-bold text-[var(--app-accent-contrast)] disabled:opacity-50">{L.close}</button>
                  </>
                ) : null}
                {!archived && status === "closed" && !current.handover_billed ? (
                  <button type="button" disabled={busy} onClick={() => void run("reopen")} title={L.reopenHint} className={button}>{L.reopen}</button>
                ) : null}
              </div>
            </div>
          ) : null}
          {archived ? <div role="status" className="rounded-xl border border-amber-300 bg-amber-50 px-3 py-2 text-sm font-semibold text-amber-800 dark:bg-amber-950/40 dark:text-amber-200">{L.archived}</div>
            : current?.handover_billed ? <div role="status" className="rounded-xl border border-[var(--app-border)] px-3 py-2 text-sm text-[var(--app-muted)]">{L.handover}</div>
            : status === "closed" ? <div role="status" className="rounded-xl border border-amber-300 bg-amber-50 px-3 py-2 text-sm font-semibold text-amber-800 dark:bg-amber-950/40 dark:text-amber-200">{L.closedNote}</div>
            : detail && !detail.order ? <div className="text-sm text-[var(--app-muted)]">{L.readOnly}</div> : null}

          <table className="w-full text-sm">
            <thead className="text-left text-[10px] uppercase tracking-[0.1em] text-[var(--app-muted)]">
              <tr><th className="py-1">{L.lines}</th><th className="w-24 py-1 text-right">{L.qty}</th><th className="w-32 py-1 text-right">{L.amount}</th><th className="w-6" /></tr>
            </thead>
            <tbody>
              {standing.map(line => (
                <tr key={`s-${line.item_code}`} className="border-t border-[var(--app-border)]">
                  <td className="py-1">
                    {line.name}
                    <span className="ml-2 rounded-full bg-sky-100 px-1.5 py-0.5 text-[10px] font-bold text-sky-800 dark:bg-sky-950/60 dark:text-sky-200">{L.auto}</span>
                    {line.note ? <span className="ml-2 text-xs text-[var(--app-muted)]">{line.note}</span> : null}
                  </td>
                  <td className="py-1 text-right tabular-nums">{line.qty} {line.unit || ""}</td>
                  <td className="py-1 text-right tabular-nums">{money(line.amount)}</td>
                  <td />
                </tr>
              ))}
              {manual.map(line => {
                const price = line.item_code ? priceOf.get(line.item_code) : null;
                return (
                  <tr key={line.key} className="border-t border-[var(--app-border)]">
                    <td className="py-1">{line.name}{line.variant ? ` (${line.variant})` : ""}</td>
                    <td className="py-1 text-right">
                      <input type="text" inputMode="decimal" value={line.qty} disabled={locked} aria-label={`${line.name} ${L.qty}`}
                        onChange={e => { const qty = e.target.value.replace(/[^0-9.]/g, ""); setManual(list => list.map(x => x.key === line.key ? { ...x, qty } : x)); touch(); }}
                        className={`${input} w-20 py-0.5 text-right`} />
                    </td>
                    <td className="py-1 text-right tabular-nums">{price != null ? money(price * (Number(line.qty) || 0)) : "—"}</td>
                    <td className="text-right">{!locked ? <button type="button" aria-label="Remove" onClick={() => { setManual(list => list.filter(x => x.key !== line.key)); touch(); }} className="text-[var(--app-muted)]">×</button> : null}</td>
                  </tr>
                );
              })}
              {!standing.length && !manual.length ? <tr><td colSpan={4} className="py-4 text-center text-[var(--app-muted)]">{L.empty}</td></tr> : null}
            </tbody>
          </table>

          {!locked ? (
            <select className={`${input} max-w-md`} value="" aria-label={L.add} onChange={e => addItem(e.target.value)}>
              <option value="">{L.add}</option>
              {[...catalog.groups].sort((a, b) => a.form_column - b.form_column || a.sort_order - b.sort_order).map(g => (
                <optgroup key={g.code} label={g.name}>
                  {catalog.items.filter(i => i.group_code === g.code).map(i => <option key={i.code} value={i.code}>{i.name}</option>)}
                </optgroup>
              ))}
            </select>
          ) : null}
          <p className="text-xs text-[var(--app-muted)]">{L.standingNote}</p>
        </section>
      </div>
    </div>
  );
}
