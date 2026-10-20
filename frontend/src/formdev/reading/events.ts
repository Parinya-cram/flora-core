/** What a reading job's events say about each page (ReadingView draws it), and the author's own additions to a draft. */
import type { FieldDefinition, FormDefinition } from "../core/types";
import type { AiChange, AiRejection, AiSent, Coverage, PageLayout, PlanItem, ReadingEvent, ReadLine } from "./types";

export type PageState = {
  lines: ReadLine[]; layout: PageLayout | null; items: PlanItem[]; coverage: Coverage | null; scanning: boolean;
  source?: string; quality?: string; seconds?: number; skew?: number; straightened?: boolean; dpi?: number;
  aiSent?: AiSent; aiRunning?: boolean; aiChanges?: AiChange[]; aiRejected?: AiRejection[]; aiBefore?: Coverage; aiAfter?: Coverage; aiFailed?: string;
};

export const emptyPage = (): PageState => ({ lines: [], layout: null, items: [], coverage: null, scanning: false });

/** What the events say about each page so far. */
export function pagesOf(events: ReadingEvent[]): Map<number, PageState> {
  const pages = new Map<number, PageState>();
  const page = (index: number) => {
    if (!pages.has(index)) pages.set(index, emptyPage());
    return pages.get(index) as PageState;
  };
  for (const event of events) {
    if (event.page === null || event.page === undefined) continue;
    const state = page(event.page);
    const d = event.data;
    if (event.kind === "page") state.dpi = Number(d.dpi);
    if (event.kind === "text_layer") { state.quality = String(d.quality); if (d.quality === "good") state.source = "text_layer"; }
    if (event.kind === "prepared") { state.skew = Number(d.skew); state.straightened = Boolean(d.straightened); }
    if (event.kind === "ocr_started") { state.scanning = true; state.source = "ocr"; }
    if (event.kind === "ocr_done") { state.scanning = false; state.seconds = Number(d.seconds); }
    if (event.kind === "lines") state.lines.push(...(d.lines as ReadLine[]));
    if (event.kind === "layout") state.layout = { cells: d.cells as PageLayout["cells"], grids: d.grids as PageLayout["grids"], blanks: d.blanks as PageLayout["blanks"], checkboxes: d.checkboxes as PageLayout["checkboxes"] };
    if (event.kind === "plan") { state.items = d.items as PlanItem[]; state.coverage = d.coverage as Coverage; }
    if (event.kind === "ai_started") { state.aiSent = d.sent as AiSent; state.aiRunning = true; }
    if (event.kind === "ai_done") {
      state.aiRunning = false;
      state.aiChanges = d.changes as AiChange[];
      state.aiRejected = d.rejected as AiRejection[];
      state.aiBefore = d.coverage_before as Coverage;
      state.aiAfter = d.coverage_after as Coverage;
    }
    if (event.kind === "ai_failed") { state.aiRunning = false; state.aiFailed = String(d.message); }
  }
  return pages;
}

/** A line the plan missed, added by the author as a text field at the end of the draft's last section. */
export function addLineAsField(definition: FormDefinition, line: ReadLine): FormDefinition {
  const used = new Set<string>();
  const walk = (fields: FieldDefinition[]) => fields.forEach(field => { used.add(field.id); if (field.fields) walk(field.fields); });
  definition.sections.forEach(section => walk(section.fields));
  let id = `added_${line.id.toLowerCase()}`;
  for (let n = 2; used.has(id); n += 1) id = `added_${line.id.toLowerCase()}_${n}`;
  const label = line.text.replace(/[._…‥·]{2,}|_+/g, " ").replace(/\s+/g, " ").trim().replace(/^[:\-\s]+|[:\-\s]+$/g, "") || line.text;
  const next = structuredClone(definition);
  const last = next.sections[next.sections.length - 1];
  last.fields.push({ id, type: "text", label } as FieldDefinition);
  return next;
}
