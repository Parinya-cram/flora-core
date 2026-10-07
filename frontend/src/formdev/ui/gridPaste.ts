/**
 * Spreadsheet-style entry for repeat fields shown as a table (view: "table"): pasting cells copied from
 * Excel or Google Sheets (tab-separated rows) and turning cell text into typed field values.
 */
import type { FieldDefinition, JsonValue } from "../core/types";
import { fieldKey } from "../core/validate";

/** Tab-separated text (as Excel puts on the clipboard) as rows of cells. Quoted cells may hold tabs, newlines and "". */
export function parseTsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  const source = text.replace(/\r\n?/g, "\n");
  for (let i = 0; i < source.length; i += 1) {
    const char = source[i];
    if (quoted) {
      if (char === '"' && source[i + 1] === '"') {
        cell += '"';
        i += 1;
      } else if (char === '"') quoted = false;
      else cell += char;
    } else if (char === '"' && cell === "") quoted = true;
    else if (char === "\t") {
      row.push(cell);
      cell = "";
    } else if (char === "\n") {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else cell += char;
  }
  if (cell !== "" || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

/** True when pasted text spans more than one cell (single values paste into the focused box as usual). */
export const isGridPaste = (text: string) => /[\t\n]/.test(text.replace(/\r?\n$/, ""));

const TRUE_WORDS = new Set(["true", "yes", "y", "1", "✓", "x", "ใช่", "มี"]);
const FALSE_WORDS = new Set(["false", "no", "n", "0", "✗", "ไม่", "ไม่ใช่", "ไม่มี"]);

/** The value a cell's text gives a field, or undefined to leave the cell empty. Unrecognised text is kept as
 * text so that validation reports it, instead of being dropped silently. */
export function cellValue(field: FieldDefinition, text: string): JsonValue | undefined {
  const raw = text.trim();
  if (raw === "") return undefined;
  switch (field.type) {
    case "number":
    case "integer":
    case "decimal": {
      const number = Number(raw.replace(/,/g, ""));
      return Number.isFinite(number) ? number : raw;
    }
    case "checkbox":
    case "switch": {
      const word = raw.toLowerCase();
      return TRUE_WORDS.has(word) ? true : FALSE_WORDS.has(word) ? false : raw;
    }
    case "select":
    case "radio":
      return optionValue(field, raw);
    case "multiselect":
      return raw.split(/[|,;]/).map(part => part.trim()).filter(Boolean).map(part => optionValue(field, part));
    default:
      return raw;
  }
}

/** An option's value from its value or its label (either may be pasted), case-insensitively. */
function optionValue(field: FieldDefinition, raw: string): string {
  const lower = raw.toLowerCase();
  const found = (field.options ?? []).find(option => option.value.toLowerCase() === lower || option.label.toLowerCase() === lower);
  return found ? found.value : raw;
}

/** Rows after pasting ``grid`` at (row, column): existing items are updated, new items are added up to ``maxItems``.
 * Columns beyond the last field are ignored; cells for fields that cannot be edited are skipped. */
export function pasteInto(
  items: Array<Record<string, JsonValue>>, grid: string[][], row: number, column: number, columns: FieldDefinition[],
  editable: (field: FieldDefinition) => boolean, maxItems?: number,
): Array<Record<string, JsonValue>> {
  const next = items.map(item => ({ ...item }));
  grid.forEach((cells, offset) => {
    const index = row + offset;
    if (index >= next.length) {
      if (maxItems !== undefined && next.length >= maxItems) return;
      next.push({});
    }
    cells.forEach((text, step) => {
      const field = columns[column + step];
      if (!field || !editable(field)) return;
      const key = fieldKey(field);
      const value = cellValue(field, text);
      if (value === undefined) delete next[index][key];
      else next[index][key] = value;
    });
  });
  return next;
}
