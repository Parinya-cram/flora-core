import type { BillingCatalog, BillingItem, BillingLine, BillingSigner } from "../../api/billingApi";

/**
 * Printable "Anesthesia Check List (Billing)" in the layout of the hospital's paper
 * form: patient header, four columns of groups (☑ item · qty), times and signatures.
 * Rendered as a standalone HTML page and printed from a hidden iframe (browser and
 * desktop app alike).
 */

export type BillingSheetHeader = {
  patientName?: string | null; hn?: string | null; an?: string | null; idCard?: string | null; dob?: string | null;
  age?: string | null; gender?: string | null; bloodType?: string | null; weight?: string | null; height?: string | null;
  postOpDx?: string | null; operation?: string | null; allergy?: string | null; admitDate?: string | null; opDate?: string | null;
  room?: string | null; asa?: string | null; caseType?: string | null;
};
/** Display groups in order (an itemize template, or the master groups). */
export type BillingSheetGroup = { code: string; name: string; items: BillingItem[] };
export type BillingSheet = {
  catalog: BillingCatalog; layout?: BillingSheetGroup[]; lines: BillingLine[]; header: BillingSheetHeader; signers: BillingSigner[];
  anesthesia: [number | null, number | null]; surgery: [number | null, number | null]; dischargeLocation?: string | null;
  status?: string; printedBy?: string | null;
};

const esc = (s: unknown) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const pad = (n: number) => String(n).padStart(2, "0");
export const clock = (ts: number | null | undefined) => {
  if (!ts) return "";
  const d = new Date(ts);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
};
export const span = (from: number | null | undefined, to: number | null | undefined) => {
  if (!from || !to || to < from) return "";
  const minutes = Math.round((to - from) / 60000);
  return `${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}`;
};
export const qtyText = (line: BillingLine) =>
  line.qty_mode === "used" ? "used" : Number.isInteger(Number(line.qty)) ? String(Number(line.qty)) : Number(line.qty).toFixed(1);

export function buildBillingSheetHtml(sheet: BillingSheet): string {
  const { catalog, lines, header: h } = sheet;
  const byCode = new Map(lines.filter(l => l.item_code).map(l => [l.item_code as string, l]));
  const extra = lines.filter(l => !l.item_code);
  // Like the paper form: groups in order, flowed evenly over four columns (a long group
  // continues at the top of the next column).
  const groups: BillingSheetGroup[] = sheet.layout || [...catalog.groups]
    .sort((a, b) => a.form_column - b.form_column || a.sort_order - b.sort_order)
    .map(g => ({ code: g.code, name: g.name, items: catalog.items.filter(i => i.group_code === g.code) }));
  const rows: string[] = [];
  for (const group of groups) {
    rows.push(`<tr class="group"><td colspan="3">${esc(group.name)}</td></tr>`);
    for (const item of group.items) {
      const line = byCode.get(item.code);
      const label = item.variant_label && line?.variant ? `${item.name} ${item.variant_label} ${line.variant}` : item.name;
      rows.push(`<tr><td class="box">${line ? "&#9745;" : "&#9744;"}</td><td>${esc(label)}</td><td class="qty">${line ? esc(qtyText(line)) : ""}</td></tr>`);
    }
    for (const line of extra.filter(l => l.group_code === group.code)) {
      rows.push(`<tr><td class="box">&#9745;</td><td>${esc(line.name)}</td><td class="qty">${esc(qtyText(line))}</td></tr>`);
    }
  }
  const perColumn = Math.ceil(rows.length / 4);
  const columns = [0, 1, 2, 3].map(i => rows.slice(i * perColumn, (i + 1) * perColumn).join(""));
  const signer = (role: string, title: string) => {
    const s = sheet.signers.find(x => x.role === role);
    return `<td><div class="sign">(${esc(s?.name || " ".repeat(30))})</div><div class="role">${title}</div></td>`;
  };
  const cell = (label: string, value: unknown) => `<b>${label}:</b> ${esc(value || "")}`;
  return `<!doctype html><html><head><meta charset="utf-8"><title>Anesthesia Check List (Billing) ${esc(h.hn || "")}</title>
<style>
  @page { size: A4; margin: 10mm; }
  * { box-sizing: border-box; }
  body { font-family: "Tahoma", "Segoe UI", Arial, sans-serif; font-size: 8.4pt; color: #000; margin: 0; }
  table { border-collapse: collapse; width: 100%; }
  .hdr td { border: 1px solid #000; padding: 2px 4px; vertical-align: top; }
  .title { text-align: center; font-size: 12pt; font-weight: bold; }
  .grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 0; margin-top: 6px; }
  .grid table { border: 1px solid #000; align-self: start; }
  .grid td { border-bottom: 1px solid #bbb; padding: 1px 3px; }
  .grid th { border: 1px solid #000; font-size: 8pt; }
  .grid .box { width: 14px; font-size: 10pt; line-height: 1; }
  .grid .qty { width: 30px; text-align: right; border-left: 1px solid #bbb; }
  .grid .group td { font-weight: bold; border-bottom: 1px solid #000; }
  .foot { margin-top: 10px; border: 1px solid #000; }
  .foot td { border: 1px solid #000; padding: 6px; text-align: center; vertical-align: bottom; height: 70px; }
  .foot .info { text-align: left; vertical-align: top; width: 24%; }
  .sign { margin-top: 30px; } .role { font-weight: bold; margin-top: 4px; }
  .meta { margin-top: 4px; font-size: 7pt; color: #555; }
</style></head><body>
<table class="hdr">
  <tr><td colspan="3">${cell("Patient name", h.patientName)}</td><td colspan="5" class="title">Anesthesia Check List (Billing)</td></tr>
  <tr><td>${cell("HN", h.hn)}</td><td>${cell("AN", h.an)}</td><td>${cell("ID Card", h.idCard)}</td><td>${cell("D.O.B", h.dob)}</td>
      <td>${cell("Age", h.age)}</td><td>${cell("Gender", h.gender)}</td><td>${cell("Blood Type", h.bloodType)}</td><td>${cell("WT", h.weight)} ${cell("HT", h.height)}</td></tr>
  <tr><td colspan="5">${cell("Post-OP Dx", h.postOpDx)}</td><td colspan="2">${cell("Hospital admit date", h.admitDate)}</td><td>${cell("Op. Date", h.opDate)}</td></tr>
  <tr><td colspan="5">${cell("Operation", h.operation)}<br>${cell("Allergy", h.allergy)}</td><td>${cell("Room", h.room)}</td><td>${cell("ASA Status", h.asa)}</td><td>${cell("Case Type", h.caseType)}</td></tr>
</table>
<div class="grid">${columns.map(body => `<table><tr><th colspan="2">list</th><th>Qty</th></tr>${body}</table>`).join("")}</div>
<table class="foot"><tr>
  ${signer("surgeon", "Surgeon")}${signer("anesthesiologist", "Anesthesiologist")}${signer("nurse1", "Anesthesia nurse 1")}${signer("nurse2", "Anesthesia nurse 2")}
  <td class="info"><b>Discharge Location:</b> ${esc(sheet.dischargeLocation || "")}<br><br>
    Anesthesia time: ${clock(sheet.anesthesia[0])} - ${clock(sheet.anesthesia[1])} (${span(...sheet.anesthesia)})<br>
    <b>Surgery Duration:</b> ${clock(sheet.surgery[0])} - ${clock(sheet.surgery[1])} (${span(...sheet.surgery)})</td>
</tr></table>
<div class="meta">${esc(sheet.status ? `Status: ${sheet.status}` : "")}${sheet.printedBy ? ` · Printed by ${esc(sheet.printedBy)}` : ""} · ${esc(new Date().toLocaleString())}</div>
</body></html>`;
}

export function printHtml(html: string) {
  const frame = document.createElement("iframe");
  frame.style.position = "fixed"; frame.style.right = "0"; frame.style.bottom = "0";
  frame.style.width = "0"; frame.style.height = "0"; frame.style.border = "0";
  document.body.appendChild(frame);
  const doc = frame.contentDocument;
  if (!doc) return;
  doc.open(); doc.write(html); doc.close();
  setTimeout(() => {
    frame.contentWindow?.focus();
    frame.contentWindow?.print();
    setTimeout(() => frame.remove(), 1500);
  }, 250);
}
