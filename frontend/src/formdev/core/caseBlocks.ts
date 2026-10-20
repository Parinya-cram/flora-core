/**
 * Report components (field type case_block): a table of one kind of Flora Leaf case data — diagnoses, procedures,
 * labs, events, medications, fluids, billing items… — placed on a printed template like any other field. The form
 * says which block, which of its columns and how wide each is (percent of the block), how many rows at most and how
 * many ruled rows at least (a paper table to write on when the case has fewer). The rows are read from the case when
 * the template is printed (leaf/caseBlocks.ts) and never stored with a record.
 *
 * CASE_BLOCKS equals formdev/spec/case-blocks.json (checked by tests); twin of services/flora-api/app/formdev/case_blocks.py.
 */
import type { FieldDefinition, JsonValue } from "./types";

export type CaseBlockColumnSpec = { key: string; th: string; en: string; width: number };
export type CaseBlockSpec = { th: string; en: string; source: string; columns: CaseBlockColumnSpec[] };
/** A column chosen on the form: the block's column, its width (percent of the block) and an optional own heading. */
export type CaseBlockColumn = { key: string; width?: number; label?: string };
/** The rows printed for a case: one {column key: text} per row, read when printing. */
export type CaseBlockValue = { rows: Array<Record<string, string>>; source?: "leaf" | "sample"; captured_at?: number };

export const CASE_BLOCKS = {
  diagnoses: { th: "การวินิจฉัย", en: "Diagnoses", source: "diagnosis", columns: [
    { key: "no", th: "ที่", en: "#", width: 8 },
    { key: "text", th: "การวินิจฉัย", en: "Diagnosis", width: 62 },
    { key: "icd", th: "ICD-10", en: "ICD-10", width: 30 }] },
  procedures: { th: "หัตถการ / การผ่าตัด", en: "Procedures", source: "procedures", columns: [
    { key: "no", th: "ที่", en: "#", width: 8 },
    { key: "text", th: "หัตถการ", en: "Procedure", width: 62 },
    { key: "icd", th: "ICD-9-CM", en: "ICD-9-CM", width: 30 }] },
  allergies: { th: "ประวัติแพ้", en: "Allergies", source: "allergies", columns: [
    { key: "allergen", th: "สิ่งที่แพ้", en: "Allergen", width: 40 },
    { key: "reaction", th: "อาการ", en: "Reaction", width: 40 },
    { key: "severity", th: "ความรุนแรง", en: "Severity", width: 20 }] },
  labs: { th: "ผลแล็บ", en: "Lab results", source: "labs", columns: [
    { key: "test", th: "รายการ", en: "Test", width: 30 },
    { key: "value", th: "ผล", en: "Result", width: 20 },
    { key: "unit", th: "หน่วย", en: "Unit", width: 15 },
    { key: "range", th: "ค่าปกติ", en: "Range", width: 20 },
    { key: "time", th: "วันเวลา", en: "Taken", width: 15 }] },
  events: { th: "เหตุการณ์ระหว่างผ่าตัด", en: "Case events", source: "events", columns: [
    { key: "time", th: "เวลา", en: "Time", width: 15 },
    { key: "title", th: "เหตุการณ์", en: "Event", width: 40 },
    { key: "detail", th: "รายละเอียด", en: "Detail", width: 45 }] },
  staff: { th: "ทีมผู้ดูแล", en: "Care team", source: "staff", columns: [
    { key: "role", th: "หน้าที่", en: "Role", width: 40 },
    { key: "name", th: "ชื่อ", en: "Name", width: 60 }] },
  medications: { th: "ยาที่ให้", en: "Medications given", source: "io", columns: [
    { key: "time", th: "เวลา", en: "Time", width: 15 },
    { key: "name", th: "ยา", en: "Drug", width: 45 },
    { key: "dose", th: "ขนาด", en: "Dose", width: 20 },
    { key: "note", th: "หมายเหตุ", en: "Note", width: 20 }] },
  fluids: { th: "สารน้ำ / เลือด", en: "Fluids and blood", source: "io", columns: [
    { key: "start", th: "เริ่ม", en: "Start", width: 15 },
    { key: "stop", th: "หยุด", en: "Stop", width: 15 },
    { key: "name", th: "รายการ", en: "Item", width: 40 },
    { key: "route", th: "ทาง", en: "Route", width: 15 },
    { key: "volume", th: "ปริมาตร (ml)", en: "Volume (ml)", width: 15 }] },
  outputs: { th: "สิ่งที่ออกจากร่างกาย", en: "Outputs", source: "io", columns: [
    { key: "time", th: "เวลา", en: "Time", width: 20 },
    { key: "name", th: "รายการ", en: "Output", width: 50 },
    { key: "volume", th: "ปริมาตร (ml)", en: "Volume (ml)", width: 30 }] },
  billing: { th: "รายการค่าใช้จ่าย", en: "Billing items", source: "billing", columns: [
    { key: "code", th: "รหัส", en: "Code", width: 15 },
    { key: "name", th: "รายการ", en: "Item", width: 50 },
    { key: "qty", th: "จำนวน", en: "Qty", width: 10 },
    { key: "unit", th: "หน่วย", en: "Unit", width: 10 },
    { key: "amount", th: "จำนวนเงิน", en: "Amount", width: 15 }] },
  scores: { th: "คะแนนประเมิน", en: "Scores", source: "scores", columns: [
    { key: "time", th: "เวลา", en: "Time", width: 15 },
    { key: "name", th: "แบบประเมิน", en: "Score", width: 40 },
    { key: "total", th: "คะแนนรวม", en: "Total", width: 15 },
    { key: "band", th: "แปลผล", en: "Result", width: 30 }] },
} as const satisfies Record<string, CaseBlockSpec>;

export type CaseBlockId = keyof typeof CASE_BLOCKS;
export const CASE_BLOCK_IDS = Object.keys(CASE_BLOCKS) as CaseBlockId[];
export const CASE_BLOCK_LIMITS = { max_rows: [1, 200], min_rows: [0, 60], column_width: [3, 100], max_columns: 12 } as const;
/** Rows printed when the form does not say (a case rarely has more on one report). */
export const DEFAULT_MAX_ROWS = 20;

const SPECS: Readonly<Record<string, CaseBlockSpec>> = CASE_BLOCKS;
export const caseBlockSpec = (block: unknown): CaseBlockSpec | undefined => (typeof block === "string" && Object.hasOwn(SPECS, block) ? SPECS[block] : undefined);

/** The printed columns with their widths in percent, adding to 100: the form's columns (in its order), or the
 * block's own. A column without a width shares what the others leave; widths that do not add to 100 are scaled. */
export function resolveColumns(field: Pick<FieldDefinition, "block" | "block_columns">, language = "th"): Array<{ key: string; label: string; width: number }> {
  const spec = caseBlockSpec(field.block);
  if (!spec) return [];
  const english = language.toLowerCase().startsWith("en");
  const chosen = (field.block_columns?.length ? field.block_columns : spec.columns.map(column => ({ key: column.key, width: column.width })))
    .filter(column => spec.columns.some(own => own.key === column.key));
  if (!chosen.length) return [];
  const fixed = chosen.reduce((sum, column) => sum + (typeof column.width === "number" && column.width > 0 ? column.width : 0), 0);
  const open = chosen.filter(column => !(typeof column.width === "number" && column.width > 0)).length;
  const share = open ? Math.max(0, 100 - fixed) / open || 100 / chosen.length : 0;
  const raw = chosen.map(column => (typeof column.width === "number" && column.width > 0 ? column.width : share));
  const total = raw.reduce((sum, width) => sum + width, 0) || 1;
  return chosen.map((column, index) => {
    const own = spec.columns.find(item => item.key === column.key)!;
    const label = "label" in column && typeof column.label === "string" && column.label.trim() ? column.label : english ? own.en : own.th;
    return { key: column.key, label, width: raw[index] * 100 / total };
  });
}

export const blockValue = (value: JsonValue | undefined): CaseBlockValue | null =>
  value && typeof value === "object" && !Array.isArray(value) && Array.isArray((value as { rows?: unknown }).rows) ? value as unknown as CaseBlockValue : null;

/** The rows to print: the case's rows up to max_rows, then empty rows up to min_rows; `more` = rows left out. */
export function printedRows(field: Pick<FieldDefinition, "max_rows" | "min_rows">, value: JsonValue | undefined): { rows: Array<Record<string, string>>; more: number } {
  const found = blockValue(value)?.rows ?? [];
  const max = field.max_rows ?? DEFAULT_MAX_ROWS;
  const rows = found.slice(0, max);
  while (rows.length < Math.min(field.min_rows ?? 0, max)) rows.push({});
  return { rows, more: Math.max(0, found.length - max) };
}

/** Integer widths adding to exactly 100, in the same proportions (the rounding remainder goes to the widest). */
export function toHundred(widths: number[]): number[] {
  if (!widths.length) return [];
  const total = widths.reduce((sum, width) => sum + Math.max(0, width), 0);
  const scaled = widths.map(width => (total > 0 ? Math.max(CASE_BLOCK_LIMITS.column_width[0], Math.round(Math.max(0, width) * 100 / total)) : Math.round(100 / widths.length)));
  const rest = 100 - scaled.reduce((sum, width) => sum + width, 0);
  const widest = scaled.indexOf(Math.max(...scaled));
  scaled[widest] += rest;
  return scaled;
}

/** Example rows for the designer and previews without a case (clearly sample data). */
export const SAMPLE_ROWS: Record<CaseBlockId, Array<Record<string, string>>> = {
  diagnoses: [{ no: "1", text: "Acute appendicitis", icd: "K35.8" }],
  procedures: [{ no: "1", text: "Laparoscopic appendectomy", icd: "47.01" }],
  allergies: [{ allergen: "Penicillin", reaction: "Rash", severity: "Moderate" }],
  labs: [{ test: "Hb", value: "12.8", unit: "g/dL", range: "12-16", time: "08:10" }, { test: "Plt", value: "245", unit: "10³/µL", range: "150-450", time: "08:10" }],
  events: [{ time: "09:05", title: "Start anesthesia", detail: "" }, { time: "09:20", title: "Start surgery", detail: "" }],
  staff: [{ role: "Anesthesiologist", name: "—" }, { role: "Surgeon", name: "—" }],
  medications: [{ time: "09:02", name: "Propofol", dose: "120 mg", note: "" }, { time: "09:03", name: "Fentanyl", dose: "100 mcg", note: "" }],
  fluids: [{ start: "09:00", stop: "10:30", name: "LRS", route: "IV", volume: "800" }],
  outputs: [{ time: "10:30", name: "Urine", volume: "150" }],
  billing: [{ code: "A001", name: "General anesthesia", qty: "1", unit: "case", amount: "" }],
  scores: [{ time: "10:45", name: "Aldrete", total: "9", band: "Discharge" }],
};

export const sampleValue = (block: unknown): CaseBlockValue => ({ rows: (caseBlockSpec(block) ? SAMPLE_ROWS[block as CaseBlockId] : []) ?? [], source: "sample" });
