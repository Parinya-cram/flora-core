/**
 * Records <-> spreadsheet rows (Excel export and import of the records list).
 *
 * Export: one sheet of records (a column per table field, labelled, plus record_id, status, updated) and one sheet
 * per repeat field (record_id, row number, a column per child field). Choices are written as their labels.
 * Import: the first sheet's header row is matched to fields by key or label; each row becomes record data typed per
 * field (numbers, yes/no, option values or labels, dates as ISO or d/m/yyyy, Buddhist years included). A row whose
 * record_id names an existing record updates it; other rows create records. Repeat fields are not imported.
 */
import type { FieldDefinition, FormDefinition, JsonValue, LocalRecord, RecordData } from "../core/types";
import { displayed, fieldKey, fields as fieldsOf } from "../core/validate";
import type { XlsxCell, XlsxSheet } from "../core/xlsx";
import { cellValue } from "./gridPaste";

export const SHEET_TYPES = new Set(["text", "textarea", "number", "decimal", "integer", "date", "datetime", "time", "select", "radio", "multiselect", "checkbox", "switch", "calculated"]);
const META = { record_id: "record_id", status: "status", updated: "updated_at" } as const;

/** Top-level fields that a sheet holds (simple values the display policy shows in tables or exports). */
export function sheetFields(definition: FormDefinition, purpose: "form" | "table" | "export" = "table"): FieldDefinition[] {
  return fieldsOf(definition).filter(field => SHEET_TYPES.has(field.type) && displayed(field, purpose));
}

export function exportCell(field: FieldDefinition, value: JsonValue | undefined): XlsxCell {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) return value.map(item => exportCell(field, item as JsonValue)).join(", ");
  if (typeof value === "object") return JSON.stringify(value);
  if (typeof value === "string" && field.options?.length) return field.options.find(option => option.value === value)?.label ?? value;
  return value;
}

const header = (field: FieldDefinition) => (field.unit ? `${field.label} (${field.unit})` : field.label);

export function recordSheets(definition: FormDefinition, records: LocalRecord[], canExport: (key: string) => boolean = () => true): XlsxSheet[] {
  const columns = sheetFields(definition, "export").filter(field => canExport(fieldKey(field)));
  const main: XlsxSheet = {
    name: definition.title || definition.form_id, header: true,
    rows: [
      [...columns.map(header), META.record_id, META.status, META.updated],
      ...records.map(record => [...columns.map(field => exportCell(field, record.data[fieldKey(field)])), record.record_id, record.status,
        new Date(record.updated_at).toISOString()]),
    ],
  };
  const repeats = fieldsOf(definition).filter(field => field.type === "repeat" && displayed(field, "export") && canExport(fieldKey(field)));
  return [main, ...repeats.map(repeat => {
    const children = (repeat.fields ?? []).filter(child => SHEET_TYPES.has(child.type));
    const rows: XlsxCell[][] = [[META.record_id, "#", ...children.map(header)]];
    for (const record of records) {
      const items = record.data[fieldKey(repeat)];
      if (!Array.isArray(items)) continue;
      items.forEach((item, index) => {
        const data = (item ?? {}) as Record<string, JsonValue>;
        rows.push([record.record_id, index + 1, ...children.map(child => exportCell(child, data[fieldKey(child)]))]);
      });
    }
    return { name: repeat.label, header: true, rows };
  })];
}

/** A cell as the records sheet shows it (✓/✗, option labels, lists joined). */
export function cellText(field: FieldDefinition, value: JsonValue | undefined): string {
  if (value === null || value === undefined || value === "") return "";
  if (typeof value === "boolean") return value ? "✓" : "✗";
  if (Array.isArray(value)) return value.map(item => cellText(field, item as JsonValue)).join(", ");
  if (typeof value === "object") return JSON.stringify(value);
  return field.options?.find(option => option.value === value)?.label ?? String(value);
}

// Import --------------------------------------------------------------------------------------------------
const normal = (text: string) => text.toLowerCase().replace(/\s*\*$/, "").replace(/\s+/g, " ").trim();

/** Column index -> field key (or a META name), by key, label, or "label (unit)". Unknown columns map to null. */
export function matchColumns(headers: string[], fields: FieldDefinition[]): Array<string | null> {
  const byName = new Map<string, string>();
  for (const field of fields) {
    for (const name of [fieldKey(field), field.label, header(field)]) if (name && !byName.has(normal(name))) byName.set(normal(name), fieldKey(field));
  }
  const taken = new Set<string>();
  return headers.map(text => {
    const name = normal(text ?? "");
    const key = name === "record_id" || name === "status" ? name : byName.get(name) ?? null;
    if (!key || taken.has(key)) return null;
    taken.add(key);
    return key;
  });
}

/** A date cell as YYYY-MM-DD: ISO, or d/m/yyyy (also with - or .), Buddhist years (> 2400) converted. */
export function dateText(raw: string): string | null {
  const text = raw.trim();
  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(text);
  const dmy = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})/.exec(text);
  const [year, month, day] = iso ? [Number(iso[1]), Number(iso[2]), Number(iso[3])] : dmy ? [Number(dmy[3]), Number(dmy[2]), Number(dmy[1])] : [NaN, NaN, NaN];
  if (!Number.isFinite(year)) return null;
  const gregorian = year > 2400 ? year - 543 : year;
  const date = new Date(Date.UTC(gregorian, month - 1, day));
  if (date.getUTCFullYear() !== gregorian || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return date.toISOString().slice(0, 10);
}

function importValue(field: FieldDefinition, raw: string): JsonValue | undefined {
  const text = raw.trim();
  if (text === "") return undefined;
  if (field.type === "date") return dateText(text) ?? text;
  if (field.type === "datetime") {
    const day = dateText(text);
    const time = /(\d{1,2}):(\d{2})(?::(\d{2}))?/.exec(text.slice(10)) ?? /T(\d{1,2}):(\d{2})(?::(\d{2}))?/.exec(text);
    return day ? `${day}T${(time?.[1] ?? "00").padStart(2, "0")}:${time?.[2] ?? "00"}:${time?.[3] ?? "00"}` : text;
  }
  if (field.type === "time") {
    const time = /^(\d{1,2}):(\d{2})/.exec(text);
    return time ? `${time[1].padStart(2, "0")}:${time[2]}` : text;
  }
  return cellValue(field, text);
}

export type ImportRow = { line: number; recordId: string | null; data: RecordData; status: "draft" | "submitted" | null };

/** Sheet rows (header first) -> record data per row; blank rows are skipped. `line` is the spreadsheet row number. */
export function importRows(rows: string[][], mapping: Array<string | null>, fields: FieldDefinition[]): ImportRow[] {
  const byKey = new Map(fields.map(field => [fieldKey(field), field]));
  const out: ImportRow[] = [];
  rows.slice(1).forEach((cells, index) => {
    if (cells.every(cell => (cell ?? "").trim() === "")) return;
    const data: RecordData = {};
    let recordId: string | null = null;
    let status: ImportRow["status"] = null;
    mapping.forEach((key, column) => {
      const raw = cells[column] ?? "";
      if (!key) return;
      if (key === "record_id") recordId = raw.trim() || null;
      else if (key === "status") status = /^submit/i.test(raw.trim()) ? "submitted" : /^draft/i.test(raw.trim()) ? "draft" : null;
      else {
        const field = byKey.get(key);
        const value = field ? importValue(field, raw) : undefined;
        if (value !== undefined) data[key] = value;
      }
    });
    out.push({ line: index + 2, recordId, data, status });
  });
  return out;
}
