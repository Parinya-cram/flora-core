/** Reading documents into forms (services/flora-api/app/formdev/reading): the job, its events and its result. Boxes
 * are page fractions [x0, y0, x1, y1], origin top left. Evidence has short ids: L text line, C ruled cell, G grid (a
 * chart), B blank (a place to write), K checkbox; plan items are I… (the tools) or A… (added by the AI). */
import type { FormDefinition } from "../core/types";

export type Box = [number, number, number, number];
export type ReadLine = { id: string; box: Box; text: string; score: number; cell?: string | null; grid?: string | null };
export type PageLayout = {
  cells: Array<{ id: string; box: Box; empty: number }>;
  grids: Array<{ id: string; box: Box; rows: number; cols: number }>;
  blanks: Array<{ id: string; box: Box; kind: "underline" | "dots" | "form_field" }>;
  checkboxes: Array<{ id: string; box: Box; ticked: boolean }>;
};
export type PlanItem = {
  id: string; kind: "field" | "heading" | "paragraph"; type: string | null; label: string; label_en?: string | null; unit?: string | null;
  box: Box; source: string[]; confidence: number; unsure: string[] | null; by: "tools" | "ai"; fixed_from?: string | null;
  options: string[]; rows: string[]; columns: string[];
};
/** How much of a page's text the plan uses (in an item), sets aside (with a reason) or misses. */
export type Coverage = { lines: number; used: number; ignored: number; missed: string[]; share: number };
/** What one AI request carried about a page. */
export type AiSent = { lines: number; cells: number; blanks: number; grids: number; checkboxes: number; items: number; closeups: number; page_px: number; unused: number };
export type AiChange = {
  edit?: string; before?: Record<string, unknown>; after?: Record<string, unknown>;
  remove?: string; add?: string; label?: string; why?: string; source?: string[];
};
export type AiRejection = { item?: string; edit?: unknown; remove?: unknown; add?: unknown; why: string };
export type ReadingEvent = { seq: number; at: number; kind: string; page: number | null; data: Record<string, unknown> };
export type ReadingJob = {
  id: string; name: string; status: "queued" | "running" | "done" | "failed" | "cancelled"; pages: number; error: string | null;
  createdAt: number; updatedAt: number; usage: { input_tokens: number; output_tokens: number; requests: number }; options: { ai: boolean }; events: number;
};
export type Provenance = { item: string; page: number; box: Box; source: string[]; confidence: number | null; unsure: string[]; by: "tools" | "ai"; fixed_from?: string };
export type ReadingResult = {
  job: ReadingJob; definition: FormDefinition; issues: Array<{ path: string; code: string; message: string }>;
  provenance: Record<string, Provenance>;
  pages: Array<{ index: number; width_pt: number; height_pt: number; dpi: number; source: string; quality: string; lines: number }>;
  evidence: Array<PageLayout & { page: number; lines: ReadLine[] }>;
  ignored: Array<{ source: string; why: string; by?: string }>;
  coverage: Coverage[];
  ai: Array<{ page: number; sent: AiSent; applied: AiChange[]; rejected: AiRejection[]; coverage_before: Coverage; coverage_after: Coverage; asked_again: boolean }>;
  usage: { input_tokens: number; output_tokens: number; requests: number };
};
export type ReadingStatus = { ocr: boolean; ai: boolean; model?: string | null; maxPages: number; maxBytes: number };
export type IdSuggestion = { key: string; concept: string | null; how: "bind" | "english" | "thai" | "type" };
export type IdFinding = { id: string; key: string; label: string; problem: "named_by_type" | "reads_as_case_data" | "id_differs" | "no_english"; message: string; suggestion: string | null; concept: string | null };
