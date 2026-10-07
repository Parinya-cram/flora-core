/**
 * Report Studio model: pure functions over a StudioSpec (no React), so dragging, dropping and editing a
 * report are easy to test. The server compiles the same spec (services/flora-api/app/report_engine.py)
 * and re-checks every rule here.
 */
import type { Aggregate, Bucket, CatalogField, StudioFilter, StudioSpec } from "../api/reportStudioApi";

export type Lang = "th" | "en";
export const langOf = (language: string): Lang => (language.toLowerCase().startsWith("th") ? "th" : "en");
export const tr = (lang: Lang, th: string, en: string) => (lang === "th" ? th : en);

export type Shelf = "filters" | "columns" | "groups" | "measures";
export type Slot = { shelf: Shelf; index: number };
export type DragItem = { kind: "field"; fieldId: string } | { kind: "chip"; from: Slot };
export const DRAG_MIME = "application/x-flora-report-item";

export const DATASET = "innovian_cases";

export const emptySpec = (view: StudioSpec["view"]): StudioSpec => ({ dataset: DATASET, view, columns: [], groups: [], measures: view === "stats" ? [{ agg: "count_cases" }] : [], filters: [], sort: null, limit: null });

export const isNumeric = (field: CatalogField) => field.cardinality === "scalar" && (field.data_type === "number" || field.data_type === "duration");
export const isDate = (field: CatalogField) => field.data_type === "date" || field.data_type === "datetime";

export const shelvesFor = (view: StudioSpec["view"]): Shelf[] => (view === "list" ? ["filters", "columns"] : ["filters", "groups", "measures"]);

export function canDrop(field: CatalogField, shelf: Shelf): boolean {
  if (shelf === "filters") return field.allowed_uses.includes("filter");
  if (shelf === "columns") return field.allowed_uses.includes("result");
  if (shelf === "groups") return field.allowed_uses.includes("group");
  return (isNumeric(field) && field.allowed_uses.includes("measure")) || field.allowed_uses.includes("result");
}

/** Where a click on a palette field puts it. */
export function defaultShelf(field: CatalogField, view: StudioSpec["view"]): Shelf | null {
  const order: Shelf[] = view === "list" ? ["columns", "filters"] : isNumeric(field) ? ["measures", "groups", "filters"] : ["groups", "filters", "measures"];
  return order.find(shelf => canDrop(field, shelf)) ?? null;
}

export const NUMERIC_AGGS: Aggregate[] = ["avg", "median", "p90", "min", "max", "sum", "stddev"];
export const FIELDLESS_AGGS: Aggregate[] = ["count_cases", "count_patients", "pct_cases"];

export function aggregatesFor(field: CatalogField | undefined): Aggregate[] {
  if (!field) return FIELDLESS_AGGS;
  return [...(isNumeric(field) && field.allowed_uses.includes("measure") ? NUMERIC_AGGS : []), ...(field.allowed_uses.includes("result") ? ["count_filled" as Aggregate] : [])];
}

const VALUE_FREE = new Set(["is_empty", "is_not_empty"]);
export const needsValue = (op: string) => !VALUE_FREE.has(op);
export const isListOp = (op: string) => op === "in" || op === "contains_any" || op === "contains_all";
export const isRangeOp = (op: string) => op === "between";

function defaultOperator(field: CatalogField): string {
  const preferred = isDate(field) ? ["between", "after"] : isNumeric(field) ? ["greater_than", "between", "equals"]
    : field.data_type === "category" ? ["in", "contains_any", "equals"] : ["contains", "equals"];
  return preferred.find(op => field.operators.includes(op)) ?? field.operators[0] ?? "equals";
}

export function emptyValue(op: string): StudioFilter["value"] {
  if (!needsValue(op)) return null;
  if (isRangeOp(op)) return ["", ""];
  if (isListOp(op)) return [];
  return "";
}

function newItem(field: CatalogField, shelf: Shelf): AnyItem {
  if (shelf === "filters") {
    const op = defaultOperator(field);
    return { field: field.id, op, value: emptyValue(op) };
  }
  if (shelf === "groups") return isDate(field) ? { field: field.id, bucket: "month" as Bucket } : { field: field.id };
  if (shelf === "measures") return { field: field.id, agg: aggregatesFor(field)[0] ?? "count_filled" };
  return { field: field.id };
}

type AnyItem = StudioSpec["filters"][number] | StudioSpec["columns"][number] | StudioSpec["groups"][number] | StudioSpec["measures"][number];

const list = (spec: StudioSpec, shelf: Shelf) => spec[shelf] as AnyItem[];
const withList = (spec: StudioSpec, shelf: Shelf, items: AnyItem[]): StudioSpec => ({ ...spec, [shelf]: items, sort: null });

export function insertField(spec: StudioSpec, field: CatalogField, to: Slot): StudioSpec {
  if (!canDrop(field, to.shelf)) return spec;
  const items = [...list(spec, to.shelf)];
  items.splice(Math.max(0, Math.min(to.index, items.length)), 0, newItem(field, to.shelf));
  return withList(spec, to.shelf, items);
}

/** Moving a chip within a shelf reorders it; to another shelf it becomes that shelf's kind of item. */
export function moveItem(spec: StudioSpec, from: Slot, to: Slot, fields: Map<string, CatalogField>): StudioSpec {
  const source = list(spec, from.shelf);
  const item = source[from.index];
  if (!item) return spec;
  if (from.shelf === to.shelf) {
    const items = [...source];
    items.splice(from.index, 1);
    const index = to.index > from.index ? to.index - 1 : to.index;
    items.splice(Math.max(0, Math.min(index, items.length)), 0, item);
    return withList(spec, from.shelf, items);
  }
  const fieldId = "field" in item ? item.field : undefined;
  const field = fieldId ? fields.get(fieldId) : undefined;
  if (!field || !canDrop(field, to.shelf)) return spec;
  return insertField(removeItem(spec, from), field, to);
}

export function removeItem(spec: StudioSpec, at: Slot): StudioSpec {
  return withList(spec, at.shelf, list(spec, at.shelf).filter((_, index) => index !== at.index));
}

export function updateItem<T extends AnyItem>(spec: StudioSpec, at: Slot, patch: Partial<T>): StudioSpec {
  const items = list(spec, at.shelf).map((item, index) => (index === at.index ? { ...item, ...patch } : item));
  return { ...spec, [at.shelf]: items };
}

export function addMeasure(spec: StudioSpec, agg: Aggregate): StudioSpec {
  return withList(spec, "measures", [...spec.measures, { agg }]);
}

/** Switching view keeps the filters and carries fields across where they fit. */
export function switchView(spec: StudioSpec, view: StudioSpec["view"], fields: Map<string, CatalogField>): StudioSpec {
  if (spec.view === view) return spec;
  if (view === "list") {
    const columns = spec.groups.filter(item => fields.get(item.field)?.allowed_uses.includes("result")).map(item => ({ field: item.field }));
    return { ...spec, view, columns, sort: null, limit: null };
  }
  const groups = spec.columns.filter(item => fields.get(item.field)?.allowed_uses.includes("group")).slice(0, 2).map(item => {
    const field = fields.get(item.field)!;
    return isDate(field) ? { field: item.field, bucket: "month" as Bucket } : { field: item.field };
  });
  return { ...spec, view, groups, measures: spec.measures.length ? spec.measures : [{ agg: "count_cases" }], sort: null };
}

export type Problem = { slot?: Slot; th: string; en: string };

/** Problems that would stop the report from running; shown before the server is asked. */
export function problems(spec: StudioSpec, fields: Map<string, CatalogField>): Problem[] {
  const out: Problem[] = [];
  if (spec.view === "list" && !spec.columns.length) out.push({ th: "ลากฟิลด์มาใส่ในช่อง คอลัมน์ อย่างน้อย 1 ฟิลด์", en: "Drag at least one field into Columns" });
  if (spec.view === "stats" && spec.groups.length > 3) out.push({ th: "จัดกลุ่มได้ไม่เกิน 3 ฟิลด์", en: "Group by at most 3 fields" });
  (["filters", "columns", "groups", "measures"] as Shelf[]).forEach(shelf => list(spec, shelf).forEach((item, index) => {
    if ("field" in item && item.field && !fields.has(item.field)) out.push({ slot: { shelf, index }, th: `ไม่พบฟิลด์ ${item.field}`, en: `Field ${item.field} is no longer available` });
  }));
  spec.filters.forEach((filter, index) => {
    if (!needsValue(filter.op)) return;
    const value = filter.value;
    const empty = Array.isArray(value) ? (isRangeOp(filter.op) ? value.some(part => String(part ?? "").trim() === "") : value.length === 0) : String(value ?? "").trim() === "";
    if (empty) {
      const label = fields.get(filter.field)?.label ?? filter.field;
      out.push({ slot: { shelf: "filters", index }, th: `ใส่ค่าตัวกรอง "${label}"`, en: `Enter a value for the "${label}" filter` });
    }
  });
  return out;
}

export const OPERATORS: Record<string, [string, string]> = {
  equals: ["เท่ากับ", "is"],
  in: ["เป็นหนึ่งใน", "is any of"],
  contains: ["มีคำว่า", "contains"],
  starts_with: ["ขึ้นต้นด้วย", "starts with"],
  contains_any: ["มีค่าใดค่าหนึ่ง", "has any of"],
  contains_all: ["มีครบทุกค่า", "has all of"],
  is_empty: ["ว่าง", "is blank"],
  is_not_empty: ["ไม่ว่าง", "is not blank"],
  between: ["อยู่ระหว่าง", "is between"],
  before: ["ถึงวันที่", "on or before"],
  after: ["ตั้งแต่วันที่", "on or after"],
  greater_than: ["มากกว่า", "greater than"],
  less_than: ["น้อยกว่า", "less than"],
};

export const AGGREGATES: Record<Aggregate, [string, string]> = {
  count_cases: ["จำนวนเคส", "Cases"],
  count_patients: ["จำนวนผู้ป่วย", "Patients"],
  pct_cases: ["% ของเคสทั้งหมด", "% of cases"],
  count_filled: ["จำนวนเคสที่มีค่า", "Cases with a value"],
  avg: ["ค่าเฉลี่ย", "Average"],
  median: ["มัธยฐาน", "Median"],
  p90: ["เปอร์เซ็นไทล์ 90", "90th percentile"],
  min: ["ต่ำสุด", "Minimum"],
  max: ["สูงสุด", "Maximum"],
  sum: ["ผลรวม", "Total"],
  stddev: ["ส่วนเบี่ยงเบนมาตรฐาน", "Std. deviation"],
};

export const BUCKETS: Record<Bucket, [string, string]> = {
  day: ["รายวัน", "Day"], week: ["รายสัปดาห์", "Week"], month: ["รายเดือน", "Month"], quarter: ["รายไตรมาส", "Quarter"], year: ["รายปี", "Year"],
};

export const TYPE_ICON: Record<string, string> = { text: "Aa", category: "☰", date: "📅", datetime: "📅", number: "#", duration: "⏱", boolean: "✓" };

export type Template = { id: string; th: string; en: string; hintTh: string; hintEn: string; title: string; spec: StudioSpec };

export const TEMPLATES: Template[] = [
  {
    id: "volume", th: "ปริมาณเคสรายเดือน", en: "Case volume by month", hintTh: "เคส ผู้ป่วย และเวลาเฉลี่ยต่อเดือน", hintEn: "Cases, patients and average duration per month",
    title: "Case volume by month",
    spec: { ...emptySpec("stats"), groups: [{ field: "case.started_at", bucket: "month" }], measures: [{ agg: "count_cases" }, { agg: "count_patients" }, { agg: "avg", field: "case.duration_minutes" }, { agg: "median", field: "case.duration_minutes" }] },
  },
  {
    id: "asa", th: "ASA แยกรายเดือน", en: "ASA status by month", hintTh: "ตารางไขว้ เดือน × ASA", hintEn: "Month × ASA cross-tab",
    title: "ASA status by month",
    spec: { ...emptySpec("stats"), groups: [{ field: "case.started_at", bucket: "month" }, { field: "patient.asa_status" }], measures: [{ agg: "count_cases" }] },
  },
  {
    id: "technique", th: "เทคนิคการระงับความรู้สึก", en: "Anaesthesia technique mix", hintTh: "จำนวนและร้อยละของแต่ละเทคนิค", hintEn: "Count and share of each technique",
    title: "Anaesthesia technique mix",
    spec: { ...emptySpec("stats"), groups: [{ field: "anesthesia.technique" }], measures: [{ agg: "count_cases" }, { agg: "pct_cases" }, { agg: "avg", field: "patient.age_years" }], sort: { key: "m0", dir: "desc" } },
  },
  {
    id: "cases", th: "รายชื่อเคส", en: "Case list", hintTh: "หนึ่งแถวต่อเคส พร้อมเทคนิคและทีม", hintEn: "One row per case with technique and team",
    title: "Case list",
    spec: { ...emptySpec("list"), columns: [{ field: "patient.hn" }, { field: "patient.name" }, { field: "case.started_at" }, { field: "case.procedure" }, { field: "patient.asa_status" }, { field: "anesthesia.technique" }, { field: "case.duration_minutes" }] },
  },
];

/** Reads definition.studio from a stored report, filling anything an older spec left out. */
export function specOf(value: unknown): StudioSpec {
  const raw = (value && typeof value === "object" ? value : {}) as Partial<StudioSpec>;
  const view = raw.view === "list" ? "list" : "stats";
  return { ...emptySpec(view), ...raw, view, columns: raw.columns ?? [], groups: raw.groups ?? [], measures: raw.measures ?? [], filters: raw.filters ?? [] };
}
