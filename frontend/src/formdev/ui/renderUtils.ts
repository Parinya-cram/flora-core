/** Small helpers shared by the renderers. */
import type { FormDefinition, Issue, JsonValue, RecordData } from "../core/types";
import { issueText } from "../core/validate";
import { evaluateRecord } from "../logic/evaluate";
import type { LookupTables } from "../logic/lookup";

/** The record after one edit, as the engine leaves it: values no longer offered (Phase 2.3) or hidden with
 * clear_when_hidden are dropped from the state too, so they cannot reappear when a choice is switched back. */
export function changeRecord(definition: FormDefinition, data: Record<string, JsonValue>, key: string, value: JsonValue, lookups?: LookupTables): RecordData {
  const next: Record<string, JsonValue> = { ...data };
  if (value === null || value === undefined) delete next[key];
  else next[key] = value;
  return evaluateRecord(definition, next, "draft", undefined, lookups).data;
}

/** Local time with offset, e.g. 2026-10-06T09:30:00+07:00 (what the validators accept). */
export function localIso(date = new Date()): string {
  const pad = (n: number) => String(Math.abs(n)).padStart(2, "0");
  const offset = -date.getTimezoneOffset();
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
    + `${offset >= 0 ? "+" : "-"}${pad(Math.trunc(offset / 60))}:${pad(offset % 60)}`;
}

/** Today as a Thai (Buddhist era) date, used for {date} in print bands. */
export const thaiDate = (date = new Date()) => date.toLocaleDateString("th-TH", { year: "numeric", month: "2-digit", day: "2-digit" });

/** Issue paths ($.data.meds[0].dose) -> message, keyed by the data path (meds[0].dose). */
export function errorsByPath(issues: Issue[], language = "en"): Map<string, string> {
  const out = new Map<string, string>();
  for (const item of issues) if (item.path.startsWith("$.data.") && !out.has(item.path.slice(7))) out.set(item.path.slice(7), issueText(item, language));
  return out;
}
