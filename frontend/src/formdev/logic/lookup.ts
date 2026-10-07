/**
 * Lookup-driven options and derived values (Phase 2.3). Twin of services/flora-api/app/formdev/logic/lookup.py.
 * Lookup entries are rows of text; a field's `lookup` turns the rows matching its `filter` into options, and a
 * `derive` copies one column of the first row matching its `match`. A filter or match on an empty value matches
 * nothing (no districts until a province is chosen).
 */
import { build } from "./model";

type Obj = Record<string, unknown>;
export type LookupEntries = Array<Record<string, string>>;
export type LookupTables = Record<string, LookupEntries>;
export type OfferedOption = { value: string; label: string; [key: string]: unknown };

const isObject = (value: unknown): value is Obj => typeof value === "object" && value !== null && !Array.isArray(value);
const blank = (value: unknown) => value === null || value === undefined || value === "" || (Array.isArray(value) && value.length === 0);
const text = (value: unknown) => (typeof value === "boolean" ? (value ? "true" : "false") : String(value));

function matching(entries: LookupEntries, pairs: unknown, valueOf: (key: string) => unknown): LookupEntries | null {
  const wanted: Array<[string, string]> = [];
  for (const [column, key] of Object.entries(isObject(pairs) ? pairs : {})) {
    const value = typeof key === "string" ? valueOf(key) : null;
    if (blank(value)) return null;
    wanted.push([column, text(value)]);
  }
  return entries.filter(entry => isObject(entry) && wanted.every(([column, expected]) => entry[column] === expected));
}

/** Distinct {value, label} options in row order. */
export function lookupOptions(entries: LookupEntries, spec: Obj, valueOf: (key: string) => unknown): OfferedOption[] {
  const rows = matching(entries, spec.filter, valueOf);
  if (rows === null) return [];
  const valueColumn = spec.value as string;
  const labelColumn = typeof spec.label === "string" ? spec.label : valueColumn;
  const seen = new Set<string>();
  const out: OfferedOption[] = [];
  for (const entry of rows) {
    const value = entry[valueColumn];
    if (typeof value === "string" && value && !seen.has(value)) {
      seen.add(value);
      const label = entry[labelColumn];
      out.push({ value, label: typeof label === "string" && label ? label : value });
    }
  }
  return out;
}

export function deriveValue(entries: LookupEntries, spec: Obj, valueOf: (key: string) => unknown): string | null {
  const rows = matching(entries, spec.match, valueOf);
  if (!rows || !rows.length) return null;
  const value = rows[0][spec.column as string];
  return typeof value === "string" && value ? value : null;
}

/** Lookups a definition reads (repeat children included). */
export function lookupIds(definition: unknown): Set<string> {
  const out = new Set<string>();
  for (const item of build(definition).fields) {
    const holder = item.field as unknown as Obj;
    if (isObject(holder.lookup) && typeof holder.lookup.source === "string") out.add(holder.lookup.source);
    if (isObject(holder.derive) && typeof holder.derive.lookup === "string") out.add(holder.derive.lookup);
  }
  return out;
}
