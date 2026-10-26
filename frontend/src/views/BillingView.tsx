import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CaseStatus } from "../api/caseApi";
import {
  getBillingCatalog, getBillingPeriods, getCaseBilling, reopenCaseBilling, saveCaseBilling, submitCaseBilling,
  type BillingCatalog, type BillingDefaults, type BillingItem, type BillingLine, type BillingSave, type BillingSigner,
  type BillingSignerRole, type CaseBilling,
} from "../api/billingApi";
import { getCaseAllergies, getCasePatientInfo, type CasePatientInfo } from "../api/caseHisApi";
import { getCaseDiagnosis, getCaseProcedures } from "../api/caseClinicalApi";
import { buildBillingSheetHtml, printHtml, span, type BillingSheetGroup, type BillingSheetHeader } from "../components/billing/billingSheet";
import DailyBillingPanel from "../components/billing/DailyBillingPanel";

/**
 * OR billing checklist ("Anesthesia Check List (Billing)") for the open case.
 * Items come from the billing master synced from Canopy; the order syncs back to Canopy.
 * Times, signers, technique and doses charted in I/O are offered from the chart.
 */

type Tick = { qty: string; variant: string; source: "manual" | "io_suggestion" };
type Extra = { key: string; group_code: string; name: string; qty: string };
type Header = { anesthesia_start: number | null; anesthesia_end: number | null; surgery_start: number | null; surgery_end: number | null; discharge_location: string };
const SIGNERS: Array<[BillingSignerRole, string]> = [["surgeon", "Surgeon"], ["anesthesiologist", "Anesthesiologist"], ["nurse1", "Anesthesia nurse 1"], ["nurse2", "Anesthesia nurse 2"]];
const EMPTY_HEADER: Header = { anesthesia_start: null, anesthesia_end: null, surgery_start: null, surgery_end: null, discharge_location: "" };

const pad = (n: number) => String(n).padStart(2, "0");
function toLocalInput(ts: number | null): string {
  if (!ts) return "";
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
function fromLocalInput(value: string): number | null {
  if (!value) return null;
  const ts = new Date(value).getTime();
  return Number.isFinite(ts) ? ts : null;
}
const defaultQty = (item: BillingItem) => (item.qty_mode === "used" ? "1" : "1");

export default function BillingView({ caseStatus }: { caseStatus: CaseStatus }) {
  const caseId = caseStatus.status === "IDLE" ? null : caseStatus.case_id;
  const caseArchived = caseStatus.status === "ARCHIVED";
  const [catalog, setCatalog] = useState<BillingCatalog | null>(null);
  const [billing, setBilling] = useState<CaseBilling | null>(null);
  const [ticks, setTicks] = useState<Record<string, Tick>>({});
  const [extras, setExtras] = useState<Extra[]>([]);
  const [header, setHeader] = useState<Header>(EMPTY_HEADER);
  const [signers, setSigners] = useState<Record<string, string>>({});
  const [patient, setPatient] = useState<CasePatientInfo | null>(null);
  const [clinical, setClinical] = useState<{ dx: string; op: string; allergy: string }>({ dx: "", op: "", allergy: "" });
  const [error, setError] = useState("");
  const [saveState, setSaveState] = useState<"idle" | "dirty" | "saving" | "saved" | "error">("idle");
  const [busy, setBusy] = useState(false);
  const [lockPing, setLockPing] = useState(0);
  const dirtyRef = useRef(false);
  const timerRef = useRef<number | undefined>(undefined);
  // ICU daily billing: the workflow bills by day (or the case has billing days), or switched on by hand.
  const [daily, setDaily] = useState<{ mode: "case" | "daily"; canSwitch: boolean; on: boolean } | null>(null);

  const status = billing?.order?.status || "draft";
  const readOnly = caseArchived || status === "submitted";
  const defaults: BillingDefaults | undefined = billing?.defaults;
  const suggestions = useMemo(() => new Map((defaults?.suggestions || []).map(s => [s.item_code, s])), [defaults]);

  const applyBilling = useCallback((data: CaseBilling, prefill: boolean) => {
    setBilling(data);
    const nextTicks: Record<string, Tick> = {};
    const nextExtras: Extra[] = [];
    for (const line of data.items) {
      if (line.item_code) nextTicks[line.item_code] = { qty: String(line.qty ?? 1), variant: line.variant || "", source: line.source === "io_suggestion" ? "io_suggestion" : "manual" };
      else nextExtras.push({ key: `x${line.line_no}`, group_code: line.group_code, name: line.name, qty: String(line.qty ?? 1) });
    }
    const order = data.order;
    const d = data.defaults;
    if (order) {
      setHeader({ anesthesia_start: order.anesthesia_start, anesthesia_end: order.anesthesia_end, surgery_start: order.surgery_start,
        surgery_end: order.surgery_end, discharge_location: order.discharge_location || "" });
      setSigners(Object.fromEntries((order.signers || []).map(s => [s.role, s.name])));
    } else if (prefill && d) {
      // First open: take what the chart already knows (not saved until something changes).
      setHeader({ anesthesia_start: d.anesthesia_start ?? null, anesthesia_end: d.anesthesia_end ?? null,
        surgery_start: d.surgery_start ?? null, surgery_end: d.surgery_end ?? null, discharge_location: d.discharge_location || "" });
      setSigners(Object.fromEntries(d.signers.map(s => [s.role, s.name])));
      for (const code of d.techniques) nextTicks[code] = { qty: "1", variant: "", source: "manual" };
      // Standing order: the template's preselected items start ticked with their quantity.
      for (const group of data.template?.groups || []) {
        for (const entry of group.items) if (entry.preselect) nextTicks[entry.code] = { qty: String(entry.qty ?? 1), variant: "", source: "manual" };
      }
    }
    setTicks(nextTicks);
    setExtras(nextExtras);
  }, []);

  useEffect(() => {
    if (caseId == null) return;
    let alive = true;
    setError("");
    Promise.all([getBillingCatalog(), getCaseBilling(caseId)])
      .then(([cat, data]) => { if (!alive) return; setCatalog(cat); applyBilling(data, true); })
      .catch(err => alive && setError(err instanceof Error ? err.message : String(err)));
    getCasePatientInfo(caseId).then(p => alive && setPatient(p)).catch(() => undefined);
    Promise.all([getCaseDiagnosis(caseId).catch(() => []), getCaseProcedures(caseId).catch(() => []), getCaseAllergies(caseId).catch(() => [])])
      .then(([dx, op, allergy]) => alive && setClinical({
        dx: dx.filter(r => r.entry_context === "postoperative").concat(dx.filter(r => r.entry_context !== "postoperative")).slice(0, 2).map(r => r.diagnosis_text).join("; "),
        op: op.filter(r => r.entry_context === "performed").concat(op.filter(r => r.entry_context !== "performed")).slice(0, 2).map(r => r.procedure_text).join("; "),
        allergy: allergy.map(a => a.allergen).join(", ") || "NONE",
      }));
    return () => { alive = false; };
  }, [caseId, applyBilling]);

  useEffect(() => {
    if (caseId == null) return;
    let alive = true;
    setDaily(null);
    getBillingPeriods(caseId)
      .then(p => alive && setDaily({ mode: p.mode, canSwitch: p.can_switch, on: p.mode === "daily" }))
      .catch(() => undefined);  // a Leaf without daily billing: the checklist only
    return () => { alive = false; };
  }, [caseId]);

  const payload = useCallback((): BillingSave => {
    const items: BillingSave["items"] = [];
    for (const [code, tick] of Object.entries(ticks)) {
      const item = catalog?.items.find(i => i.code === code);
      if (!item) continue;
      items.push({ item_code: code, group_code: item.group_code, name: item.name, variant: tick.variant || null,
        qty: item.qty_mode === "used" ? 1 : Number(tick.qty) || 0, source: tick.source });
    }
    for (const extra of extras) {
      if (extra.name.trim()) items.push({ item_code: null, group_code: extra.group_code, name: extra.name.trim(), variant: null, qty: Number(extra.qty) || 0, source: "manual" });
    }
    const signerRows: BillingSigner[] = SIGNERS.map(([role]) => ({ role, name: (signers[role] || "").trim() })).filter(s => s.name);
    return { ...header, discharge_location: header.discharge_location || null, signers: signerRows, note: null, items };
  }, [catalog, extras, header, signers, ticks]);

  const save = useCallback(async () => {
    if (caseId == null || !dirtyRef.current) return;
    dirtyRef.current = false;
    setSaveState("saving");
    try {
      const saved = await saveCaseBilling(caseId, payload());
      setBilling(current => ({ ...saved, defaults: current?.defaults, template: current?.template }));
      setSaveState(dirtyRef.current ? "dirty" : "saved");
    } catch (err) {
      dirtyRef.current = true;
      setSaveState("error");
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [caseId, payload]);

  // Autosave shortly after the last change.
  useEffect(() => {
    if (saveState !== "dirty") return;
    window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(() => void save(), 1200);
    return () => window.clearTimeout(timerRef.current);
  }, [saveState, ticks, extras, header, signers, save]);

  const touch = () => { if (readOnly) return; dirtyRef.current = true; setSaveState("dirty"); setError(""); };
  const templateQty = useMemo(() => new Map((billing?.template?.groups || []).flatMap(g => g.items.filter(i => i.qty != null).map(i => [i.code, Number(i.qty)] as const))), [billing?.template]);
  const toggle = (item: BillingItem, on: boolean, qty?: number, source: Tick["source"] = "manual") => {
    setTicks(current => {
      const next = { ...current };
      if (on) next[item.code] = { qty: String(qty ?? (current[item.code]?.qty || templateQty.get(item.code) || defaultQty(item))), variant: current[item.code]?.variant || "", source };
      else delete next[item.code];
      return next;
    });
    touch();
  };
  const bump = (code: string) => {
    setTicks(current => {
      const tick = current[code];
      if (!tick) return current;
      const next = Math.round(((Number(tick.qty) || 0) + 1) * 100) / 100;
      return { ...current, [code]: { ...tick, qty: String(next) } };
    });
    touch();
  };
  const setTick = (code: string, patch: Partial<Tick>) => { setTicks(current => ({ ...current, [code]: { ...current[code], ...patch } })); touch(); };

  const fillFromChart = () => {
    if (!defaults || !catalog) return;
    setHeader(h => ({
      anesthesia_start: defaults.anesthesia_start ?? h.anesthesia_start, anesthesia_end: defaults.anesthesia_end ?? h.anesthesia_end,
      surgery_start: defaults.surgery_start ?? h.surgery_start, surgery_end: defaults.surgery_end ?? h.surgery_end,
      discharge_location: h.discharge_location || defaults.discharge_location || "",
    }));
    setSigners(s => ({ ...Object.fromEntries(defaults.signers.map(x => [x.role, x.name])), ...Object.fromEntries(Object.entries(s).filter(([, v]) => v)) }));
    setTicks(current => {
      const next = { ...current };
      for (const code of defaults.techniques) if (!next[code]) next[code] = { qty: "1", variant: "", source: "manual" };
      for (const s of defaults.suggestions) if (!next[s.item_code]) next[s.item_code] = { qty: String(s.qty), variant: "", source: "io_suggestion" };
      return next;
    });
    touch();
  };

  const runStatus = async (action: "submit" | "reopen") => {
    if (caseId == null) return;
    setBusy(true); setError("");
    try {
      if (dirtyRef.current) await save();
      const result = action === "submit" ? await submitCaseBilling(caseId) : await reopenCaseBilling(caseId);
      setBilling(current => ({ ...result, defaults: current?.defaults, template: current?.template }));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const sheetHeader = (): BillingSheetHeader => ({
    patientName: patient?.patient_name || [patient?.title_th, patient?.first_name, patient?.last_name].filter(Boolean).join(" "),
    hn: patient?.hn || (caseStatus.status !== "IDLE" ? caseStatus.hn : ""), an: patient?.an || (caseStatus.status !== "IDLE" ? caseStatus.admission_number : ""),
    idCard: patient?.id_card, dob: patient?.dob, age: patient?.age_text, gender: patient?.sex, bloodType: patient?.blood_group_text,
    weight: patient?.weight_kg ? `${patient.weight_kg} kg` : "", height: patient?.height_cm ? `${patient.height_cm} cm` : "",
    postOpDx: clinical.dx, operation: clinical.op, allergy: clinical.allergy, asa: patient?.asa_status,
    opDate: caseStatus.status !== "IDLE" ? new Date(caseStatus.start_time).toLocaleDateString() : "",
  });
  // Display groups: the case's itemize template (Workflow Studio), else the master groups.
  const template = billing?.template || null;
  const layout = useMemo<BillingSheetGroup[]>(() => {
    if (!catalog) return [];
    const masterItems = new Map(catalog.items.map(i => [i.code, i]));
    const groups: BillingSheetGroup[] = template
      ? template.groups.map(g => ({ code: g.key, name: g.name, items: g.items.map(i => masterItems.get(i.code)).filter((i): i is BillingItem => Boolean(i)) }))
      : [...catalog.groups].sort((a, b) => a.form_column - b.form_column || a.sort_order - b.sort_order)
          .map(g => ({ code: g.code, name: g.name, items: catalog.items.filter(i => i.group_code === g.code) }));
    if (template) {
      const shown = new Set(groups.flatMap(g => g.items.map(i => i.code)));
      const others = Object.keys(ticks).filter(code => !shown.has(code)).map(code => masterItems.get(code)).filter((i): i is BillingItem => Boolean(i));
      if (others.length) groups.push({ code: "_additional", name: "Additional items", items: others });
    }
    return groups;
  }, [catalog, template, ticks]);

  const print = () => {
    if (!catalog) return;
    const p = payload();
    printHtml(buildBillingSheetHtml({
      catalog, layout, header: sheetHeader(), signers: p.signers, dischargeLocation: p.discharge_location,
      anesthesia: [p.anesthesia_start, p.anesthesia_end], surgery: [p.surgery_start, p.surgery_end], status,
      lines: p.items.map(i => ({ ...i, qty_mode: catalog.items.find(x => x.code === i.item_code)?.qty_mode })) as BillingLine[],
    }));
  };

  if (caseId == null) return <div className="p-6 text-sm text-[var(--app-muted)]">Open a case to record billing.</div>;
  if (daily?.on) {
    return <DailyBillingPanel caseId={caseId} archived={caseArchived}
      onCaseBilling={daily.mode !== "daily" ? () => setDaily(d => d && { ...d, on: false }) : undefined} />;
  }
  if (error && !catalog) return <div className="p-6 text-sm text-red-600">{error}</div>;
  if (!catalog) return <div className="p-6 text-sm text-[var(--app-muted)]">Loading billing checklist…</div>;

  const inLayout = new Set(layout.flatMap(g => g.items.map(i => i.code)));
  const addable = template && template.allow_other_items !== false ? catalog.items.filter(i => !inLayout.has(i.code)) : [];
  const ticked = Object.keys(ticks).length + extras.filter(e => e.name.trim()).length;
  const pending = (defaults?.suggestions || []).filter(s => !ticks[s.item_code]).length;
  const input = "rounded-md border border-[var(--app-border)] bg-[var(--app-control-bg,transparent)] px-2 py-1 text-sm";

  return (
    <div className="app-theme-scope w-full space-y-3 p-4 pb-16 text-[var(--app-text)]">
      <div className="sticky top-2 z-20 flex flex-wrap items-center gap-3 rounded-2xl border border-[var(--app-border)] bg-[var(--app-panel-bg)]/95 p-3 shadow-sm backdrop-blur">
        <div className="min-w-56">
          <div className="text-[10px] font-extrabold uppercase tracking-[0.16em] text-[var(--app-muted)]">Billing</div>
          <h1 className="text-lg font-bold">Anesthesia Check List (Billing)</h1>
        </div>
        <span className={`rounded-full px-2.5 py-0.5 text-xs font-bold ${status === "submitted" ? "bg-emerald-100 text-emerald-800 dark:bg-emerald-950/50 dark:text-emerald-300" : "bg-amber-100 text-amber-800 dark:bg-amber-950/50 dark:text-amber-300"}`}>
          {status === "submitted" ? "Submitted" : "Draft"}
        </span>
        <span className="text-xs text-[var(--app-muted)]">
          {ticked} item{ticked === 1 ? "" : "s"}{billing?.total_amount != null ? ` · ${billing.total_amount.toLocaleString(undefined, { minimumFractionDigits: 2 })} THB` : ""}
          {" · "}{saveState === "saving" ? "Saving…" : saveState === "dirty" ? "Unsaved changes" : saveState === "error" ? "Save failed" : saveState === "saved" ? "Saved" : billing?.order ? "Saved" : "Not saved yet"}
        </span>
        <div className="ml-auto flex flex-wrap gap-2">
          {!readOnly ? (
            <button type="button" onClick={fillFromChart} className="rounded-xl border border-[var(--app-border)] px-3 py-1.5 text-sm font-semibold">
              Fill from chart{pending ? ` (${pending})` : ""}
            </button>
          ) : null}
          {daily?.canSwitch && !caseArchived && !(billing?.items.length) && saveState !== "dirty" ? (
            <button type="button" title="ICU: one bill per billing day with standing charges"
              onClick={() => { if (window.confirm("Bill this case per day (ICU)? Opening a day creates its bill with the standing charges.")) setDaily(d => d && { ...d, on: true }); }}
              className="rounded-xl border border-[var(--app-border)] px-3 py-1.5 text-sm font-semibold">Daily billing</button>
          ) : null}
          <button type="button" onClick={print} className="rounded-xl border border-[var(--app-border)] px-3 py-1.5 text-sm font-semibold">Print</button>
          {status === "submitted" && !caseArchived ? (
            <button type="button" disabled={busy} onClick={() => void runStatus("reopen")} className="rounded-xl border border-[var(--app-border)] px-3 py-1.5 text-sm font-semibold">Reopen</button>
          ) : !caseArchived ? (
            <button type="button" disabled={busy || ticked === 0} onClick={() => void runStatus("submit")}
              className="rounded-xl bg-[var(--app-accent)] px-4 py-1.5 text-sm font-bold text-[var(--app-accent-contrast)] disabled:opacity-50">Submit</button>
          ) : null}
        </div>
        {error ? <div className="basis-full text-sm text-red-600 dark:text-red-400">{error}</div> : null}
        {readOnly ? (
          <div key={lockPing} role="status"
            className={`basis-full rounded-xl border px-3 py-2 text-sm font-semibold ${lockPing ? "animate-pulse border-amber-500 bg-amber-100 text-amber-900 dark:bg-amber-950/60 dark:text-amber-200" : "border-amber-300 bg-amber-50 text-amber-800 dark:bg-amber-950/40 dark:text-amber-200"}`}>
            {caseArchived
              ? "This case is archived, so its billing can no longer be changed."
              : "Submitted — the checklist is locked. Press Reopen to change items, then Submit again."}
          </div>
        ) : null}
      </div>

      <section className="grid gap-x-4 gap-y-1 rounded-2xl border border-[var(--app-border)] bg-[var(--app-panel-bg)] p-3 text-sm sm:grid-cols-2 xl:grid-cols-4">
        {[
          ["Patient", sheetHeader().patientName], ["HN / AN", `${sheetHeader().hn || "—"} / ${sheetHeader().an || "—"}`],
          ["Age · Gender · Blood", [patient?.age_text, patient?.sex, patient?.blood_group_text].filter(Boolean).join(" · ")],
          ["WT / HT · ASA", `${sheetHeader().weight || "—"} / ${sheetHeader().height || "—"} · ASA ${patient?.asa_status || "—"}`],
          ["Post-op Dx", clinical.dx], ["Operation", clinical.op], ["Allergy", clinical.allergy],
        ].map(([label, value]) => (
          <div key={label} className="min-w-0"><span className="text-[10px] font-extrabold uppercase tracking-[0.12em] text-[var(--app-muted)]">{label}</span><div className="truncate">{value || "—"}</div></div>
        ))}
      </section>

      {template ? (
        <div className="flex flex-wrap items-center gap-2 rounded-2xl border border-[var(--app-border)] bg-[var(--app-panel-bg)] px-3 py-2 text-sm">
          <span className="text-[10px] font-extrabold uppercase tracking-[0.12em] text-[var(--app-muted)]">Itemize template</span>
          <span className="font-semibold">{template.name || template.id}</span>
          {addable.length && !readOnly ? (
            <select className={`${input} ml-auto max-w-xs`} value="" aria-label="Add another item"
              onChange={e => { const item = catalog.items.find(i => i.code === e.target.value); if (item) toggle(item, true); }}>
              <option value="">+ Add another item…</option>
              {catalog.groups.map(g => (
                <optgroup key={g.code} label={g.name}>{addable.filter(i => i.group_code === g.code).map(i => <option key={i.code} value={i.code}>{i.name}</option>)}</optgroup>
              ))}
            </select>
          ) : null}
        </div>
      ) : null}

      {/* Groups flow top to bottom, then into the next column, like the paper form. */}
      <div className="gap-3 md:columns-2 xl:columns-4">
            {layout.map(group => (
              <section key={group.code} className="mb-3 break-inside-avoid overflow-hidden rounded-2xl border border-[var(--app-border)] bg-[var(--app-panel-bg)]">
                <div className="flex items-center justify-between bg-[var(--app-accent)]/10 px-3 py-1.5">
                  <h2 className="text-xs font-extrabold uppercase tracking-[0.1em]">{group.name}</h2>
                  <span className="text-[10px] font-bold text-[var(--app-muted)]">Qty</span>
                </div>
                <div className="divide-y divide-[var(--app-border)]">
                  {group.items.map(item => {
                    const tick = ticks[item.code];
                    const hint = suggestions.get(item.code);
                    return (
                      <div key={item.code} className={`flex items-center gap-2 px-3 py-1 text-sm ${tick ? "bg-[var(--app-accent)]/5" : ""}`}>
                        {/* Tapping the name ticks the item; tapping it again adds one (the box itself unticks). */}
                        <label className={`flex min-w-0 flex-1 items-center gap-2 ${readOnly ? "" : "cursor-pointer"}`}
                          title={tick && item.qty_mode !== "used" ? `${item.name} — tap again for +1` : item.name}
                          onClick={e => {
                            if (readOnly) { setLockPing(n => n + 1); return; }  // locked: point at the banner
                            if (!tick || e.target instanceof HTMLInputElement) return;
                            e.preventDefault();  // keep it ticked
                            if (item.qty_mode !== "used") bump(item.code);
                          }}>
                          <input type="checkbox" checked={Boolean(tick)} disabled={readOnly} onChange={e => toggle(item, e.target.checked)}
                            className="h-4 w-4 shrink-0 accent-[var(--app-accent)]" />
                          <span className="min-w-0 flex-1 truncate select-none">{item.name}</span>
                        </label>
                        {item.variant_label && tick ? (
                          <input value={tick.variant} disabled={readOnly} onChange={e => setTick(item.code, { variant: e.target.value })}
                            placeholder={item.variant_label} className={`${input} w-14 py-0.5 text-xs`} aria-label={`${item.name} ${item.variant_label}`} />
                        ) : null}
                        {hint && !tick && !readOnly ? (
                          <button type="button" onClick={() => toggle(item, true, hint.qty, "io_suggestion")} title={hint.reason}
                            className="rounded-full bg-sky-100 px-1.5 py-0.5 text-[10px] font-bold text-sky-800 dark:bg-sky-950/60 dark:text-sky-200">I/O ×{hint.qty}</button>
                        ) : null}
                        {tick ? (item.qty_mode === "used" ? <span className="w-14 text-right text-xs font-semibold">used</span> : (
                          <input type="text" inputMode="decimal" value={tick.qty} disabled={readOnly}
                            onChange={e => setTick(item.code, { qty: e.target.value.replace(/[^0-9.]/g, "") })} className={`${input} w-14 py-0.5 text-right`} aria-label={`${item.name} quantity`} />
                        )) : <span className="w-14" />}
                      </div>
                    );
                  })}
                  {extras.filter(x => x.group_code === group.code).map(extra => (
                    <div key={extra.key} className="flex items-center gap-2 px-3 py-1 text-sm">
                      <input value={extra.name} disabled={readOnly} placeholder="Other item"
                        onChange={e => { setExtras(list => list.map(x => x.key === extra.key ? { ...x, name: e.target.value } : x)); touch(); }}
                        className={`${input} min-w-0 flex-1 py-0.5`} />
                      <input type="text" inputMode="decimal" value={extra.qty} disabled={readOnly}
                        onChange={e => { setExtras(list => list.map(x => x.key === extra.key ? { ...x, qty: e.target.value.replace(/[^0-9.]/g, "") } : x)); touch(); }}
                        className={`${input} w-14 py-0.5 text-right`} aria-label="Quantity" />
                      {!readOnly ? <button type="button" aria-label="Remove" onClick={() => { setExtras(list => list.filter(x => x.key !== extra.key)); touch(); }} className="text-[var(--app-muted)]">×</button> : null}
                    </div>
                  ))}
                  {!readOnly ? (
                    <button type="button" onClick={() => { setExtras(list => [...list, { key: `n${Date.now()}`, group_code: group.code, name: "", qty: "1" }]); }}
                      className="w-full px-3 py-1 text-left text-xs font-semibold text-[var(--app-accent)]">+ Other</button>
                  ) : null}
                </div>
              </section>
            ))}
      </div>

      <section className="grid gap-3 rounded-2xl border border-[var(--app-border)] bg-[var(--app-panel-bg)] p-3 lg:grid-cols-[2fr_1fr]">
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          {SIGNERS.map(([role, label]) => (
            <label key={role} className="grid gap-1 text-sm">
              <span className="text-[10px] font-extrabold uppercase tracking-[0.12em] text-[var(--app-muted)]">{label}</span>
              <input value={signers[role] || ""} disabled={readOnly} onChange={e => { setSigners(s => ({ ...s, [role]: e.target.value })); touch(); }}
                list="billing-staff-names" className={input} placeholder="Name" />
            </label>
          ))}
          <datalist id="billing-staff-names">{(defaults?.signers || []).map(s => <option key={`${s.role}${s.name}`} value={s.name} />)}</datalist>
        </div>
        <div className="grid gap-2 text-sm">
          {([["Anesthesia time", "anesthesia_start", "anesthesia_end"], ["Surgery duration", "surgery_start", "surgery_end"]] as const).map(([label, from, to]) => (
            <div key={label} className="grid gap-1">
              <span className="text-[10px] font-extrabold uppercase tracking-[0.12em] text-[var(--app-muted)]">{label} {span(header[from], header[to]) ? `(${span(header[from], header[to])})` : ""}</span>
              <div className="flex flex-wrap items-center gap-1">
                <input type="datetime-local" data-no-picker value={toLocalInput(header[from])} disabled={readOnly}
                  onChange={e => { setHeader(h => ({ ...h, [from]: fromLocalInput(e.target.value) })); touch(); }} className={input} aria-label={`${label} start`} />
                <span>–</span>
                <input type="datetime-local" data-no-picker value={toLocalInput(header[to])} disabled={readOnly}
                  onChange={e => { setHeader(h => ({ ...h, [to]: fromLocalInput(e.target.value) })); touch(); }} className={input} aria-label={`${label} end`} />
              </div>
            </div>
          ))}
          <label className="grid gap-1">
            <span className="text-[10px] font-extrabold uppercase tracking-[0.12em] text-[var(--app-muted)]">Discharge location</span>
            <input value={header.discharge_location} disabled={readOnly} onChange={e => { setHeader(h => ({ ...h, discharge_location: e.target.value })); touch(); }}
              className={input} placeholder="RR, ICU, Ward…" />
          </label>
        </div>
      </section>
      {status === "submitted" && billing?.order?.submitted_at ? (
        <p className="text-xs text-[var(--app-muted)]">Submitted by {billing.order.submitted_by} on {new Date(billing.order.submitted_at).toLocaleString()}. Reopen to change it; the change syncs to Canopy.</p>
      ) : null}
    </div>
  );
}
