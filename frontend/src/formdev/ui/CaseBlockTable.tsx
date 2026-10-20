/**
 * A report component (field type case_block) on screen: its title, then a bordered table with the form's columns at
 * their widths (percent of the block), the case's rows up to max_rows and empty ruled rows up to min_rows — the same
 * table the PDF prints (render/pdfLayout.ts caseBlockTable). Without case rows (the designer, a form filled away from
 * a case) it shows sample rows or empty ones, marked as such.
 */
import type { FieldDefinition, JsonValue } from "../core/types";
import { blockValue, caseBlockSpec, printedRows, resolveColumns, sampleValue } from "../core/caseBlocks";

const cell = { border: "0.3mm solid #94a3b8", padding: "0.6mm 1mm", fontSize: "8.5pt", height: "5mm", verticalAlign: "top" as const, overflowWrap: "anywhere" as const };

export default function CaseBlockTable({ field, value, language = "th", sample = false, title }: {
  field: FieldDefinition; value?: JsonValue; language?: string;
  /** Show example rows when there are none (the designer). */
  sample?: boolean;
  /** The title shown above the table (the field's label in the form's language); hidden when empty. */
  title?: string;
}) {
  const english = language.toLowerCase().startsWith("en");
  const columns = resolveColumns(field, language);
  const spec = caseBlockSpec(field.block);
  const found = blockValue(value);
  const shown = !found && sample ? sampleValue(field.block) : found;
  const { rows, more } = printedRows(field, shown as unknown as JsonValue);
  const body: Array<Record<string, string>> = rows.length ? rows : Array.from({ length: Math.max(1, Math.min(field.min_rows ?? 3, 3)) }, () => ({}));
  if (!spec || !columns.length) return <div data-case-block={field.block ?? ""} style={{ fontSize: "8pt", color: "#94a3b8" }}>{title || field.label}</div>;
  return <div data-case-block={field.block}>
    {title ? <div style={{ fontSize: "8.5pt", fontWeight: 600, marginBottom: "0.8mm" }}>{title}</div> : null}
    <table style={{ width: "100%", borderCollapse: "collapse", tableLayout: "fixed" }}>
      <colgroup>{columns.map(column => <col key={column.key} style={{ width: `${column.width.toFixed(2)}%` }} />)}</colgroup>
      {field.show_header === false ? null : <thead><tr>{columns.map(column =>
        <th key={column.key} style={{ ...cell, background: "#f1f5f9", fontWeight: 600, textAlign: "left" }}>{column.label}</th>)}</tr></thead>}
      <tbody>{body.map((row, index) => <tr key={index}>{columns.map(column => <td key={column.key} style={cell}>{row[column.key] ?? ""}</td>)}</tr>)}</tbody>
    </table>
    {more ? <div style={{ fontSize: "7.5pt", color: "#64748b", marginTop: "0.5mm" }}>{english ? `+${more} more not printed (max ${field.max_rows ?? 20} rows)` : `อีก ${more} รายการไม่ได้พิมพ์ (สูงสุด ${field.max_rows ?? 20} แถว)`}</div> : null}
    {!found ? <div style={{ fontSize: "7.5pt", color: "#94a3b8", marginTop: "0.5mm" }}>
      {sample ? (english ? "Sample rows — the case's own rows are printed from Flora Leaf" : "ข้อมูลตัวอย่าง — เมื่อพิมพ์จาก Flora Leaf จะใช้ข้อมูลจริงของเคส")
        : (english ? `Filled with the case's ${spec.en.toLowerCase()} when printed from Flora Leaf` : `เติม${spec.th}ของเคสเมื่อพิมพ์จาก Flora Leaf`)}
    </div> : null}
  </div>;
}
