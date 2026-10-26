/**
 * Flora Leaf's anesthesia record in Form Studio: every field of the record (recordFields.ts, generated from FormView.tsx)
 * as a ready field to add to a form, bound with field.bind "record.<field>". A bound field shares its value with the
 * record both ways on the Leaf (services/flora-api/app/record_link.py: the newest change wins), and fills itself from the
 * record when a template is printed (caseData.ts).
 */
import type { FieldDefinition, FieldOption, JsonValue } from "../core/types";
import { RECORD_FIELDS, type RecordField } from "./recordFields";

export { RECORD_FIELDS, type RecordField };
export const RECORD_PREFIX = "record.";
export const RECORD_BY_BIND = new Map(RECORD_FIELDS.map(field => [field.bind, field]));
export const RECORD_BY_KEY = new Map(RECORD_FIELDS.map(field => [field.key, field]));
export const isRecordBind = (bind: unknown): boolean => typeof bind === "string" && RECORD_BY_BIND.has(bind);

/** The record's tabs in the Leaf's order, each with its fields. */
export const RECORD_TABS: Array<{ id: string; th: string; en: string; fields: RecordField[] }> = (() => {
  const tabs = new Map<string, { id: string; th: string; en: string; fields: RecordField[] }>();
  for (const field of RECORD_FIELDS) {
    const tab = tabs.get(field.tab) ?? { id: field.tab, th: field.tab_th, en: field.tab_en, fields: [] };
    tab.fields.push(field);
    tabs.set(field.tab, tab);
  }
  return [...tabs.values()];
})();

const slug = (text: string) => text.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 60);

function optionsOf(field: RecordField): FieldOption[] {
  const used = new Set<string>();
  return (field.options ?? []).map((option, index) => {
    let value = slug(option.value) || slug(option.label) || `opt_${index + 1}`;
    while (used.has(value)) value = `${value}_${index + 1}`;
    used.add(value);
    return { value, label: option.label };
  });
}

/** A form field that shares this record field (its type, options and label from the Leaf), with a unique id. */
export function fieldFromRecord(record: RecordField, used: Set<string>, lang: "th" | "en" = "th"): FieldDefinition {
  let id = record.bind.slice(RECORD_PREFIX.length).replace(/[^a-z0-9_]/g, "_").slice(0, 60);
  if (!/^[a-z]/.test(id)) id = `r_${id}`;
  for (let n = 2; used.has(id); n += 1) id = `${id.replace(/_\d+$/, "")}_${n}`;
  used.add(id);
  const base: FieldDefinition = { id, type: "text", label: record.label, bind: record.bind, ...(lang === "th" ? { label_en: record.label } : {}) };
  const options = optionsOf(record);
  switch (record.kind) {
    case "textarea": return { ...base, type: "textarea", layout: { span: 12 } };
    case "number": return { ...base, type: "decimal", decimals: 1, layout: { span: 4 } };
    case "integer": return { ...base, type: "integer", ...(record.max !== undefined ? { min: 0, max: record.max } : {}), layout: { span: 4 } };
    case "date": return { ...base, type: "date", layout: { span: 4 } };
    case "time": return { ...base, type: "time", layout: { span: 4 } };
    case "boolean": return { ...base, type: "checkbox", layout: { span: 6 } };
    case "choice":
      if (!options.length) return { ...base, layout: { span: 6 } };
      return options.length <= 6
        ? { ...base, type: "radio", options, option_columns: Math.min(options.length, 3), layout: { span: 12 } }
        : { ...base, type: "select", options, layout: { span: 6 } };
    case "multi":
      return options.length
        ? { ...base, type: "multiselect", options, option_columns: Math.min(options.length, 3), layout: { span: 12 } }
        : { ...base, type: "textarea", layout: { span: 12 } };
    default: return { ...base, layout: { span: 6 } };
  }
}

/** Every field of one tab of the record: a heading, then its fields (spans on a 12-column grid; scaled when added). */
export function tabFields(tabId: string, used: Set<string>, lang: "th" | "en" = "th"): FieldDefinition[] {
  const tab = RECORD_TABS.find(item => item.id === tabId);
  if (!tab) return [];
  let heading = `${tabId.toLowerCase()}_heading`;
  for (let n = 2; used.has(heading); n += 1) heading = `${tabId.toLowerCase()}_heading_${n}`;
  used.add(heading);
  return [{ id: heading, type: "heading", label: lang === "th" ? tab.th : tab.en, level: 2, layout: { span: 12 } },
    ...tab.fields.map(field => fieldFromRecord(field, used, lang))];
}

const fold = (value: unknown) => String(value ?? "").toLowerCase().normalize("NFKC").replace(/[^a-z0-9ก-๙+-]/g, "");

/** The record value as the form field stores it (as record_link.to_form), or undefined when it does not fit. */
export function recordToForm(value: unknown, field: FieldDefinition): JsonValue | undefined {
  if (value === null || value === undefined || value === "" || (Array.isArray(value) && !value.length)) return undefined;
  const option = (item: unknown) => (field.options ?? []).find(choice => fold(item) && [fold(choice.value), fold(choice.label)].includes(fold(item)));
  switch (field.type) {
    case "checkbox": case "switch": return typeof value === "boolean" ? value : ["true", "yes", "1"].includes(fold(value));
    case "number": case "decimal": case "integer": {
      const number = Number.parseFloat(String(value).replace(",", "."));
      return Number.isFinite(number) ? (field.type === "integer" ? Math.round(number) : number) : undefined;
    }
    case "date": {
      const raw = String(value).trim();
      const iso = raw.match(/^(\d{4})-(\d{2})-(\d{2})/);
      if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
      const dmy = raw.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/);
      if (!dmy) return undefined;
      const year = Number(dmy[3]) > 2400 ? Number(dmy[3]) - 543 : Number(dmy[3]);
      return `${year}-${dmy[2].padStart(2, "0")}-${dmy[1].padStart(2, "0")}`;
    }
    case "time": { const match = String(value).match(/^(\d{1,2})[:.](\d{2})/); return match ? `${match[1].padStart(2, "0")}:${match[2]}` : undefined; }
    case "select": case "radio": return option(Array.isArray(value) && value.length === 1 ? value[0] : value)?.value;
    case "multiselect": {
      const items = Array.isArray(value) ? value : String(value).split(",").map(item => item.trim()).filter(Boolean);
      const chosen = items.map(option);
      return chosen.every(Boolean) ? chosen.map(choice => choice!.value) : undefined;
    }
    default: return Array.isArray(value) ? value.join(", ") : typeof value === "boolean" ? (value ? "Yes" : "No") : String(value);
  }
}
