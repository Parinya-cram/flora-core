import type { BillingCatalog, BillingLine, BillingSigner, CanopyBillingOrder, CanopyBillingTotal } from "../../api/billingApi";
import { clock, qtyText, span } from "./billingSheet";

/**
 * Standard printed billing (until a hospital's own form is set up): an itemized
 * statement for one case and a period summary of the order list. A4 portrait,
 * printed with `printHtml` like the checklist sheet.
 */

const esc = (s: unknown) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const money = (n: number | null | undefined) => (n == null ? "—" : Number(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
const day = (ts: number | null | undefined) => (ts ? new Date(ts).toLocaleDateString() : "—");
const PART_LABEL = { or: "OR · Anesthesia", recovery: "Recovery · Post-Anesthesia" } as const;
const SIGNER_LABEL: Record<string, string> = { surgeon: "Surgeon", anesthesiologist: "Anesthesiologist", nurse1: "Anesthesia nurse 1", nurse2: "Anesthesia nurse 2" };

const STYLE = `
  @page { size: A4; margin: 12mm; }
  * { box-sizing: border-box; }
  body { font-family: "Tahoma", "Segoe UI", Arial, sans-serif; font-size: 9.5pt; color: #000; margin: 0; }
  h1 { font-size: 14pt; margin: 0; } .sub { color: #444; margin-top: 2px; }
  .top { display: flex; justify-content: space-between; align-items: flex-end; border-bottom: 2px solid #000; padding-bottom: 6px; }
  table { border-collapse: collapse; width: 100%; }
  .info { margin-top: 8px; } .info td { padding: 2px 6px 2px 0; vertical-align: top; width: 25%; }
  .info b { display: inline-block; min-width: 70px; }
  .items { margin-top: 10px; }
  .items th { border-top: 1px solid #000; border-bottom: 1px solid #000; padding: 4px; text-align: left; font-size: 8.5pt; }
  .items td { border-bottom: 1px solid #ddd; padding: 3px 4px; vertical-align: top; }
  .num { text-align: right; white-space: nowrap; }
  .group td { font-weight: bold; background: #f2f2f2; border-bottom: 1px solid #999; }
  .part td { font-weight: bold; text-transform: uppercase; letter-spacing: .06em; padding-top: 8px; border-bottom: 1px solid #000; }
  .subtotal td { font-weight: bold; border-bottom: 1px solid #999; }
  .total td { font-weight: bold; font-size: 11pt; border-top: 2px solid #000; border-bottom: 2px solid #000; padding: 5px 4px; }
  .signs { margin-top: 28px; } .signs td { text-align: center; padding: 0 8px; vertical-align: bottom; }
  .line { border-top: 1px solid #000; margin-top: 34px; padding-top: 3px; }
  .meta { margin-top: 12px; font-size: 7.5pt; color: #555; }
`;

const page = (title: string, body: string) =>
  `<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)}</title><style>${STYLE}</style></head><body>${body}</body></html>`;

const footer = (printedBy?: string | null) =>
  `<div class="meta">${printedBy ? `Printed by ${esc(printedBy)} · ` : ""}${esc(new Date().toLocaleString())} · Flora iCIS Canopy</div>`;

export type BillingStatement = {
  catalog: BillingCatalog | null; order: CanopyBillingOrder; lines: BillingLine[]; signers: BillingSigner[]; printedBy?: string | null;
};

/** One case's itemized bill: lines by group (and by OR / Recovery part when combined), qty, unit price, amount. */
export function buildBillingStatementHtml(sheet: BillingStatement): string {
  const { order: o, lines, catalog } = sheet;
  const groups = new Map((catalog?.groups || []).map(g => [g.code, g]));
  const items = new Map((catalog?.items || []).map(i => [i.code, i]));
  const groupOrder = (code: string) => { const g = groups.get(code); return g ? g.form_column * 1000 + g.sort_order : 1e9; };
  const parts: Array<BillingLine["part"]> = o.combined ? ["or", "recovery"] : [null];
  const rows: string[] = [];
  let no = 0;
  let grand = 0;
  for (const part of parts) {
    const partLines = o.combined ? lines.filter(l => (l.part || "or") === part) : lines;
    if (!partLines.length) continue;
    if (o.combined && part) rows.push(`<tr class="part"><td colspan="7">${PART_LABEL[part]}</td></tr>`);
    const codes = [...new Set(partLines.map(l => l.group_code))].sort((a, b) => groupOrder(a) - groupOrder(b));
    let partTotal = 0;
    for (const code of codes) {
      rows.push(`<tr class="group"><td colspan="7">${esc(groups.get(code)?.name || code || "Other")}</td></tr>`);
      for (const line of partLines.filter(l => l.group_code === code)) {
        no += 1;
        partTotal += Number(line.amount || 0);
        const item = line.item_code ? items.get(line.item_code) : undefined;
        const unit = line.qty_mode === "used" ? "" : line.unit || item?.unit || "";
        rows.push(`<tr><td class="num">${no}</td><td>${esc(item?.charge_code || line.item_code || "")}</td>`
          + `<td>${esc(line.name)}${line.variant ? ` (${esc(line.variant)})` : ""}${line.note ? `<div class="sub">${esc(line.note)}</div>` : ""}</td>`
          + `<td class="num">${esc(qtyText(line))}</td><td>${esc(unit)}</td>`
          + `<td class="num">${money(line.unit_price ?? item?.unit_price)}</td><td class="num">${money(line.amount)}</td></tr>`);
      }
    }
    grand += partTotal;
    if (o.combined && part) rows.push(`<tr class="subtotal"><td colspan="6" class="num">Subtotal · ${PART_LABEL[part]}</td><td class="num">${money(partTotal)}</td></tr>`);
  }
  if (!rows.length) rows.push(`<tr><td colspan="7" style="text-align:center;padding:16px;color:#666">No items.</td></tr>`);
  const total = o.total_amount ?? grand;
  const cell = (label: string, value: unknown) => `<td><b>${label}</b> ${esc(value || "—")}</td>`;
  const signs = (["surgeon", "anesthesiologist", "nurse1", "nurse2"] as const)
    .map(role => { const s = sheet.signers.find(x => x.role === role); return `<td><div>${esc(s?.name || "")}</div><div class="line">${SIGNER_LABEL[role]}</div></td>`; }).join("");
  return page(`Billing statement ${o.hn || ""}`, `
<div class="top"><div><h1>Billing statement</h1><div class="sub">${o.combined ? "Combined bill · OR + Recovery" : esc(o.leaf_name || o.leaf_id)}</div></div>
  <div class="sub">Status: <b>${esc(o.status)}</b>${o.submitted_at ? ` · submitted ${esc(new Date(o.submitted_at).toLocaleString())}` : ""}</div></div>
<table class="info">
  <tr>${cell("Patient", o.patient_name)}${cell("HN", o.hn)}${cell("AN", o.an)}${cell("Case", o.case_code)}</tr>
  <tr>${cell("Date", day(o.anesthesia_start || o.surgery_start || o.order_updated_at))}${cell("Location", o.leaf_name || o.leaf_id)}
    <td><b>Anesthesia</b> ${clock(o.anesthesia_start)}–${clock(o.anesthesia_end)} ${span(o.anesthesia_start, o.anesthesia_end)}</td>
    <td><b>Surgery</b> ${clock(o.surgery_start)}–${clock(o.surgery_end)} ${span(o.surgery_start, o.surgery_end)}</td></tr>
  <tr>${cell("Discharge", o.discharge_location)}</tr>
</table>
<table class="items">
  <thead><tr><th class="num">#</th><th>Code</th><th>Item</th><th class="num">Qty</th><th>Unit</th><th class="num">Unit price</th><th class="num">Amount</th></tr></thead>
  <tbody>${rows.join("")}<tr class="total"><td colspan="6" class="num">Total</td><td class="num">${money(total)}</td></tr></tbody>
</table>
<table class="signs"><tr>${signs}</tr></table>
${footer(sheet.printedBy)}`);
}

export type BillingSummary = {
  from: string; to: string; status?: string; q?: string; rows: CanopyBillingOrder[]; totals: CanopyBillingTotal[]; printedBy?: string | null;
};

/** The order list of a period: one line per case, then the item totals. */
export function buildBillingSummaryHtml(sheet: BillingSummary): string {
  const caseRows = sheet.rows.map((r, i) => `<tr><td class="num">${i + 1}</td><td>${esc(day(r.anesthesia_start || r.order_updated_at))}</td>`
    + `<td>${esc(r.hn || "—")}<div class="sub">${esc(r.an || "")}</div></td><td>${esc(r.patient_name || "—")}</td>`
    + `<td>${esc(r.leaf_name || r.leaf_id)}${r.combined ? `<div class="sub">OR + Recovery</div>` : ""}</td>`
    + `<td class="num">${r.item_count}</td><td class="num">${money(r.total_amount)}</td><td>${esc(r.status)}</td></tr>`).join("");
  const caseTotal = sheet.rows.reduce((sum, r) => sum + Number(r.total_amount || 0), 0);
  const itemRows = sheet.totals.map(t => `<tr><td>${esc(t.item_code || "")}</td><td>${esc(t.name)}</td><td class="num">${Number(t.qty)}</td>`
    + `<td>${esc(t.unit || "")}</td><td class="num">${t.cases}</td><td class="num">${money(t.amount)}</td></tr>`).join("");
  const itemTotal = sheet.totals.reduce((sum, t) => sum + Number(t.amount || 0), 0);
  const filters = [`${sheet.from} – ${sheet.to}`, sheet.status ? `status ${sheet.status}` : "all statuses", sheet.q ? `search “${sheet.q}”` : ""].filter(Boolean).join(" · ");
  return page(`Billing summary ${sheet.from} – ${sheet.to}`, `
<div class="top"><div><h1>Billing summary</h1><div class="sub">${esc(filters)}</div></div>
  <div class="sub"><b>${sheet.rows.length}</b> case${sheet.rows.length === 1 ? "" : "s"} · <b>${money(caseTotal)}</b></div></div>
<table class="items">
  <thead><tr><th class="num">#</th><th>Date</th><th>HN / AN</th><th>Patient</th><th>Location</th><th class="num">Items</th><th class="num">Amount</th><th>Status</th></tr></thead>
  <tbody>${caseRows || `<tr><td colspan="8" style="text-align:center;padding:16px;color:#666">No billing in this period.</td></tr>`}
    <tr class="total"><td colspan="6" class="num">Total</td><td class="num">${money(caseTotal)}</td><td></td></tr></tbody>
</table>
<table class="items" style="margin-top:18px">
  <thead><tr><th>Code</th><th>Item totals</th><th class="num">Qty</th><th>Unit</th><th class="num">Cases</th><th class="num">Amount</th></tr></thead>
  <tbody>${itemRows}<tr class="total"><td colspan="5" class="num">Total</td><td class="num">${money(itemTotal)}</td></tr></tbody>
</table>
${footer(sheet.printedBy)}`);
}
