import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import type { AuthUser } from "../auth/useAuth";
import {
  getCanopyBillingCatalog, getCanopyBillingOrder, getCanopyBillingOrders, saveCanopyBillingItem,
  type BillingCatalog, type BillingItem, type BillingLine, type CanopyBillingOrder, type CanopyBillingTotal,
} from "../api/billingApi";
import { buildBillingSheetHtml, clock, printHtml, qtyText, span } from "../components/billing/billingSheet";
import { buildBillingStatementHtml, buildBillingSummaryHtml } from "../components/billing/billingStatement";

const PART_LABEL = { or: "OR · Anesthesia", recovery: "Recovery · Post-Anesthesia" } as const;

/** Combined OR + Recovery bill for the printed sheet: one line per item (quantities and amounts summed). */
function sumByItem(lines: BillingLine[]): BillingLine[] {
  const out: BillingLine[] = [];
  const byCode = new Map<string, BillingLine>();
  for (const line of lines) {
    const found = line.item_code ? byCode.get(line.item_code) : undefined;
    if (!found) {
      const copy = { ...line };
      if (line.item_code) byCode.set(line.item_code, copy);
      out.push(copy);
      continue;
    }
    found.qty = Number(found.qty || 0) + Number(line.qty || 0);
    if (found.amount != null || line.amount != null) found.amount = Number(found.amount || 0) + Number(line.amount || 0);
  }
  return out;
}

/**
 * Canopy billing: orders sent by every Leaf (OR billing checklist) and the item master
 * that Canopy owns and syncs to every Leaf with the directory exchange.
 */

type Tab = "orders" | "master";
const money = (n: number | null | undefined) => (n == null ? "—" : Number(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
const day = (ts: number | null | undefined) => (ts ? new Date(ts).toLocaleDateString() : "—");
const localDate = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const input = "rounded-md border border-[var(--app-border)] bg-[var(--app-control-bg,transparent)] px-2 py-1 text-sm";

export default function CanopyBillingView({ sessionUser }: { sessionUser: AuthUser | null }) {
  const canManage = (sessionUser?.permissions ?? []).includes("billing.manage") || ["admin", "system_admin"].includes(String(sessionUser?.role || "").toLowerCase());
  const [tab, setTab] = useState<Tab>("orders");
  const [catalog, setCatalog] = useState<BillingCatalog | null>(null);
  const reloadCatalog = useCallback(() => getCanopyBillingCatalog().then(setCatalog).catch(() => undefined), []);
  useEffect(() => { void reloadCatalog(); }, [reloadCatalog]);

  return (
    <div className="app-theme-scope w-full space-y-4 p-3 sm:p-5 text-[var(--app-text)]">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <div className="text-xs font-extrabold uppercase tracking-[0.16em] text-[var(--app-accent)]">ESM Flora Canopy · billing</div>
          <h1 className="mt-1 text-2xl font-semibold">Billing</h1>
          <p className="mt-1 text-sm text-[var(--app-muted)]">Charge orders from every Leaf case and the billing item master.</p>
        </div>
      </header>
      <nav className="flex items-center gap-2 border-b border-[var(--app-border)] pb-3" role="tablist" aria-label="Billing">
        {([["orders", "Orders"], ["master", "Item master"]] as const).map(([key, label]) => (
          <button key={key} type="button" role="tab" aria-selected={tab === key} onClick={() => setTab(key)}
            className={`inline-flex min-h-10 items-center rounded-xl border px-4 py-2 text-sm font-bold transition ${tab === key ? "border-[var(--app-accent)] bg-[var(--app-accent)] text-[var(--app-accent-contrast)]" : "border-transparent text-[var(--app-muted)] hover:border-[var(--app-border)] hover:bg-[var(--app-control-bg)] hover:text-[var(--app-text)]"}`}>{label}</button>
        ))}
      </nav>
      {tab === "orders" ? <Orders catalog={catalog} /> : <Master catalog={catalog} canManage={canManage} onSaved={reloadCatalog} />}
    </div>
  );
}

function Orders({ catalog }: { catalog: BillingCatalog | null }) {
  const [status, setStatus] = useState("");
  const [q, setQ] = useState("");
  const [range, setRange] = useState(() => {
    const today = new Date();
    const from = new Date(today); from.setDate(from.getDate() - 7);
    return { from: localDate(from), to: localDate(today) };
  });
  const [rows, setRows] = useState<CanopyBillingOrder[]>([]);
  const [totals, setTotals] = useState<CanopyBillingTotal[]>([]);
  const [selected, setSelected] = useState<{ order: CanopyBillingOrder; items: BillingLine[] } | null>(null);
  const [error, setError] = useState("");

  const load = useCallback(() => {
    const from = new Date(`${range.from}T00:00:00`).getTime();
    const to = new Date(`${range.to}T00:00:00`).getTime() + 86400000;
    getCanopyBillingOrders({ status: status || undefined, q: q.trim() || undefined, from, to })
      .then(data => { setRows(data.rows); setTotals(data.item_totals); setError(""); })
      .catch(err => setError(err instanceof Error ? err.message : String(err)));
  }, [q, range, status]);
  useEffect(() => { load(); }, [load]);

  const open = (row: CanopyBillingOrder) => getCanopyBillingOrder(row.global_case_id).then(setSelected).catch(err => setError(String(err)));
  const print = () => {
    if (!selected || !catalog) return;
    const o = selected.order;
    printHtml(buildBillingSheetHtml({
      catalog, lines: o.combined ? sumByItem(selected.items) : selected.items, signers: o.signers || [], dischargeLocation: o.discharge_location, status: o.status,
      anesthesia: [o.anesthesia_start, o.anesthesia_end], surgery: [o.surgery_start, o.surgery_end],
      header: { patientName: o.patient_name, hn: o.hn, an: o.an, opDate: day(o.anesthesia_start || o.surgery_start), room: o.leaf_name || o.leaf_id },
    }));
  };
  const printStatement = () => {
    if (!selected) return;
    printHtml(buildBillingStatementHtml({ catalog, order: selected.order, lines: selected.items, signers: selected.order.signers || [] }));
  };
  const printSummary = () => printHtml(buildBillingSummaryHtml({ from: range.from, to: range.to, status, q: q.trim(), rows, totals }));
  const grand = totals.reduce((sum, t) => sum + (t.amount || 0), 0);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-end gap-2 rounded-2xl border border-[var(--app-border)] bg-[var(--app-panel-bg)] p-3">
        <label className="grid gap-1 text-xs font-semibold">From<input type="date" data-no-picker value={range.from} onChange={e => setRange(r => ({ ...r, from: e.target.value }))} className={input} /></label>
        <label className="grid gap-1 text-xs font-semibold">To<input type="date" data-no-picker value={range.to} onChange={e => setRange(r => ({ ...r, to: e.target.value }))} className={input} /></label>
        <label className="grid gap-1 text-xs font-semibold">Status
          <select value={status} onChange={e => setStatus(e.target.value)} className={input}>
            <option value="">All</option><option value="submitted">Submitted</option><option value="draft">Draft</option>
          </select>
        </label>
        <label className="grid flex-1 gap-1 text-xs font-semibold">Search<input value={q} onChange={e => setQ(e.target.value)} placeholder="HN, AN, name, case" className={input} /></label>
        <button type="button" onClick={load} className="rounded-xl border border-[var(--app-border)] px-3 py-1.5 text-sm font-semibold">Refresh</button>
        <button type="button" onClick={printSummary} className="rounded-xl border border-[var(--app-border)] px-3 py-1.5 text-sm font-semibold">Print summary</button>
      </div>
      {error ? <div className="text-sm text-red-600">{error}</div> : null}
      <div className="grid gap-3 xl:grid-cols-[3fr_2fr]">
        <div className="overflow-auto rounded-2xl border border-[var(--app-border)] bg-[var(--app-panel-bg)]">
          <table className="w-full text-sm">
            <thead className="bg-[var(--app-accent)]/10 text-left text-[11px] uppercase tracking-[0.08em]">
              <tr><th className="p-2">Date</th><th className="p-2">HN / AN</th><th className="p-2">Patient</th><th className="p-2">Leaf</th><th className="p-2">Anesthesia</th><th className="p-2 text-right">Items</th><th className="p-2 text-right">Amount</th><th className="p-2">Status</th></tr>
            </thead>
            <tbody>
              {rows.map(row => (
                <tr key={row.global_case_id} onClick={() => void open(row)}
                  className={`cursor-pointer border-t border-[var(--app-border)] hover:bg-[var(--app-accent)]/5 ${selected?.order.global_case_id === row.global_case_id ? "bg-[var(--app-accent)]/10" : ""}`}>
                  <td className="p-2">{day(row.anesthesia_start || row.order_updated_at)}</td>
                  <td className="p-2">{row.hn || "—"}<div className="text-xs text-[var(--app-muted)]">{row.an || ""}</div></td>
                  <td className="p-2">{row.patient_name || "—"}</td>
                  <td className="p-2">{row.leaf_name || row.leaf_id}{row.combined ? <div><span className="rounded-full bg-sky-100 px-2 py-0.5 text-[10px] font-bold text-sky-800">OR + Recovery</span></div> : null}</td>
                  <td className="p-2">{clock(row.anesthesia_start)}–{clock(row.anesthesia_end)} <span className="text-xs text-[var(--app-muted)]">{span(row.anesthesia_start, row.anesthesia_end)}</span></td>
                  <td className="p-2 text-right">{row.item_count}</td>
                  <td className="p-2 text-right">{money(row.total_amount)}</td>
                  <td className="p-2"><span className={`rounded-full px-2 py-0.5 text-xs font-bold ${row.status === "submitted" ? "bg-emerald-100 text-emerald-800" : "bg-amber-100 text-amber-800"}`}>{row.status}</span></td>
                </tr>
              ))}
              {!rows.length ? <tr><td colSpan={8} className="p-6 text-center text-[var(--app-muted)]">No billing in this period.</td></tr> : null}
            </tbody>
          </table>
        </div>
        <div className="space-y-3">
          {selected ? (
            <div className="rounded-2xl border border-[var(--app-border)] bg-[var(--app-panel-bg)] p-3">
              <div className="mb-2 flex items-center gap-2">
                <div className="min-w-0 flex-1"><div className="font-bold">{selected.order.patient_name || selected.order.hn}</div>
                  <div className="text-xs text-[var(--app-muted)]">HN {selected.order.hn} · AN {selected.order.an || "—"} · {selected.order.signers?.map(s => s.name).join(", ")}</div></div>
                <button type="button" onClick={printStatement} className="rounded-xl border border-[var(--app-accent)] bg-[var(--app-accent)] px-3 py-1 text-sm font-semibold text-[var(--app-accent-contrast)]">Print bill</button>
                <button type="button" onClick={print} disabled={!catalog} title="Hospital paper form layout" className="rounded-xl border border-[var(--app-border)] px-3 py-1 text-sm font-semibold disabled:opacity-50">Print checklist</button>
              </div>
              {selected.order.combined ? <div className="mb-2 text-xs text-[var(--app-muted)]">Combined bill: {selected.order.parts?.map(part => `${PART_LABEL[part.part || "or"]} (${part.leaf_name || part.case_code || "case"}, ${part.status})`).join(" + ")}</div> : null}
              <table className="w-full text-sm">
                <tbody>{selected.items.map((line, index) => <Fragment key={`${line.part || ""}-${line.line_no ?? index}`}>
                  {selected.order.combined && line.part !== selected.items[index - 1]?.part ? <tr><td colSpan={3} className="pt-2 text-[11px] font-extrabold uppercase tracking-[0.1em] text-[var(--app-muted)]">{PART_LABEL[line.part || "or"]}</td></tr> : null}
                  <tr className="border-t border-[var(--app-border)]">
                    <td className="py-1">{line.name}{line.variant ? ` (${line.variant})` : ""}</td>
                    <td className="py-1 text-right">{qtyText(line)} {line.qty_mode === "used" ? "" : line.unit || ""}</td>
                    <td className="py-1 text-right">{money(line.amount)}</td>
                  </tr>
                </Fragment>)}</tbody>
              </table>
            </div>
          ) : null}
          <div className="rounded-2xl border border-[var(--app-border)] bg-[var(--app-panel-bg)] p-3">
            <div className="mb-2 flex items-center"><h2 className="flex-1 text-sm font-bold">Item totals ({rows.length} case{rows.length === 1 ? "" : "s"})</h2><span className="text-sm font-bold">{money(grand)}</span></div>
            <table className="w-full text-sm">
              <tbody>{totals.map(t => (
                <tr key={t.item_code || t.name} className="border-t border-[var(--app-border)]">
                  <td className="py-1">{t.name}</td><td className="py-1 text-right">{Number(t.qty)} {t.unit || ""}</td>
                  <td className="py-1 text-right text-[var(--app-muted)]">{t.cases} case{t.cases === 1 ? "" : "s"}</td><td className="py-1 text-right">{money(t.amount)}</td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  );
}

function Master({ catalog, canManage, onSaved }: { catalog: BillingCatalog | null; canManage: boolean; onSaved: () => void }) {
  const [group, setGroup] = useState("");
  const [filter, setFilter] = useState("");
  const [edits, setEdits] = useState<Record<string, Partial<BillingItem>>>({});
  const [message, setMessage] = useState("");
  const [adding, setAdding] = useState<Partial<BillingItem> | null>(null);
  const items = useMemo(() => (catalog?.items || []).filter(i => (!group || i.group_code === group) && (!filter || `${i.code} ${i.name}`.toLowerCase().includes(filter.toLowerCase()))), [catalog, group, filter]);
  if (!catalog) return <div className="text-sm text-[var(--app-muted)]">Loading…</div>;

  const save = async (item: BillingItem | Partial<BillingItem>) => {
    const code = String(item.code || "").trim();
    try {
      await saveCanopyBillingItem(code, { ...item, ...(edits[code] || {}) });
      setEdits(e => { const next = { ...e }; delete next[code]; return next; });
      setMessage(`Saved ${code}. Leafs receive it at their next sync.`);
      setAdding(null);
      onSaved();
    } catch (err) {
      setMessage(err instanceof Error ? err.message : String(err));
    }
  };
  const field = (item: BillingItem, key: keyof BillingItem, width = "w-24", type = "text") => {
    const value = edits[item.code]?.[key] ?? item[key] ?? "";
    return <input type={type} disabled={!canManage} value={String(value)} className={`${input} ${width} py-0.5`}
      onChange={e => setEdits(x => ({ ...x, [item.code]: { ...x[item.code], [key]: type === "number" ? (e.target.value === "" ? null : Number(e.target.value)) : e.target.value } }))} />;
  };

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-end gap-2 rounded-2xl border border-[var(--app-border)] bg-[var(--app-panel-bg)] p-3">
        <label className="grid gap-1 text-xs font-semibold">Group
          <select value={group} onChange={e => setGroup(e.target.value)} className={input}>
            <option value="">All groups</option>{catalog.groups.map(g => <option key={g.code} value={g.code}>{g.name}</option>)}
          </select>
        </label>
        <label className="grid flex-1 gap-1 text-xs font-semibold">Search<input value={filter} onChange={e => setFilter(e.target.value)} className={input} placeholder="Code or name" /></label>
        <span className="text-xs text-[var(--app-muted)]">{catalog.items.length} items · version {new Date(catalog.version).toLocaleString()}</span>
        {canManage ? <button type="button" onClick={() => setAdding({ group_code: group || catalog.groups[0]?.code, qty_mode: "count", is_active: 1 })}
          className="rounded-xl bg-[var(--app-accent)] px-3 py-1.5 text-sm font-bold text-[var(--app-accent-contrast)]">+ Add item</button> : null}
      </div>
      {!canManage ? <div className="text-xs text-[var(--app-muted)]">Read only: editing needs the billing.manage permission.</div> : null}
      {message ? <div className="text-sm text-[var(--app-accent)]">{message}</div> : null}
      {adding ? (
        <div className="flex flex-wrap items-end gap-2 rounded-2xl border border-[var(--app-accent)] bg-[var(--app-panel-bg)] p-3 text-sm">
          {(["code", "name", "unit", "charge_code"] as const).map(key => (
            <label key={key} className="grid gap-1 text-xs font-semibold">{key}<input value={String(adding[key] || "")} onChange={e => setAdding(a => ({ ...a, [key]: e.target.value }))} className={input} /></label>
          ))}
          <label className="grid gap-1 text-xs font-semibold">group<select value={adding.group_code} onChange={e => setAdding(a => ({ ...a, group_code: e.target.value }))} className={input}>{catalog.groups.map(g => <option key={g.code} value={g.code}>{g.name}</option>)}</select></label>
          <label className="grid gap-1 text-xs font-semibold">qty<select value={adding.qty_mode} onChange={e => setAdding(a => ({ ...a, qty_mode: e.target.value as BillingItem["qty_mode"] }))} className={input}><option value="count">count</option><option value="hours">hours</option><option value="used">used</option></select></label>
          <label className="grid gap-1 text-xs font-semibold">price<input type="number" value={adding.unit_price ?? ""} onChange={e => setAdding(a => ({ ...a, unit_price: e.target.value === "" ? null : Number(e.target.value) }))} className={`${input} w-24`} /></label>
          <button type="button" onClick={() => void save(adding)} className="rounded-xl bg-[var(--app-accent)] px-3 py-1.5 font-bold text-[var(--app-accent-contrast)]">Save</button>
          <button type="button" onClick={() => setAdding(null)} className="rounded-xl border border-[var(--app-border)] px-3 py-1.5">Cancel</button>
        </div>
      ) : null}
      <div className="overflow-auto rounded-2xl border border-[var(--app-border)] bg-[var(--app-panel-bg)]">
        <table className="w-full text-sm">
          <thead className="bg-[var(--app-accent)]/10 text-left text-[11px] uppercase tracking-[0.08em]">
            <tr><th className="p-2">Code</th><th className="p-2">Name</th><th className="p-2">Group</th><th className="p-2">Unit</th><th className="p-2">Qty</th><th className="p-2">Charge code</th><th className="p-2">Price (THB)</th><th className="p-2">I/O link</th><th className="p-2">Active</th><th className="p-2" /></tr>
          </thead>
          <tbody>
            {items.map(item => {
              const dirty = Boolean(edits[item.code]);
              const active = (edits[item.code]?.is_active ?? item.is_active) ? 1 : 0;
              return (
                <tr key={item.code} className="border-t border-[var(--app-border)]">
                  <td className="p-2 font-mono text-xs">{item.code}</td>
                  <td className="p-2">{field(item, "name", "w-56")}</td>
                  <td className="p-2 text-xs">{catalog.groups.find(g => g.code === item.group_code)?.name}</td>
                  <td className="p-2">{field(item, "unit", "w-16")}</td>
                  <td className="p-2 text-xs">{item.qty_mode}</td>
                  <td className="p-2">{field(item, "charge_code", "w-28")}</td>
                  <td className="p-2">{field(item, "unit_price", "w-24", "number")}</td>
                  <td className="p-2">{field(item, "io_item_code", "w-28")}</td>
                  <td className="p-2"><input type="checkbox" disabled={!canManage} checked={Boolean(active)} onChange={e => setEdits(x => ({ ...x, [item.code]: { ...x[item.code], is_active: e.target.checked ? 1 : 0 } }))} /></td>
                  <td className="p-2">{dirty ? <button type="button" onClick={() => void save(item)} className="rounded-lg bg-[var(--app-accent)] px-2 py-0.5 text-xs font-bold text-[var(--app-accent-contrast)]">Save</button> : null}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
