/**
 * Layout engine (Phase 1.5) and A4 print layout (Phase 1.6). Pure functions; the renderers turn the
 * result into CSS grid placement and @page rules.
 *
 * Screen and print are separate layouts: each mode (desktop, tablet, mobile, print) resolves its own
 * span/column/visibility per field, and print additionally paginates into sheets of the paper size.
 */
import { DEFAULT_COLUMNS, displayed, paperSpec, type PaperSpec } from "./validate";
import { conceptOf } from "../leaf/concepts";
import { hospitalName } from "./hospital";
import type { ContainerLayout, FieldDefinition, FormDefinition, LayoutMode, PaperBand, SectionDefinition } from "./types";

export type Placement = { span: number; col?: number; row?: number; rowSpan?: number; hidden: boolean; pageBreak?: "before" | "after" | "avoid" };

/** Viewport width (px) -> layout mode. Print is chosen explicitly, never by width. */
export function modeForWidth(width: number): Exclude<LayoutMode, "print"> {
  return width >= 1024 ? "desktop" : width >= 640 ? "tablet" : "mobile";
}

/** Fields that read best across the whole row unless told otherwise. */
const FULL_WIDTH = new Set(["textarea", "multiselect", "group", "repeat", "signature", "heading", "paragraph", "divider", "case_block"]);

/** Default span: full width for wide types and on mobile, otherwise columns / the style's `columns` token. */
export function defaultSpan(field: FieldDefinition, columns: number, styleColumns: number, mode: LayoutMode): number {
  if (mode === "mobile" || FULL_WIDTH.has(field.type)) return columns;
  return Math.max(1, Math.floor(columns / Math.max(1, styleColumns)));
}

/** Where a field sits in its container for one mode. */
export function placeField(field: FieldDefinition, mode: LayoutMode, columns: number, styleColumns = 2, containerType: ContainerLayout["type"] = "grid", siblings = 1,
  context: "form" | "detail" = "form"): Placement {
  const layout = field.layout ?? {};
  const rule = layout.responsive?.[mode] ?? {};
  // Print is the same form on paper, so the form display policy applies to it as well.
  const hidden = rule.hidden === true || !displayed(field, context);
  let span: number;
  if (rule.span !== undefined) span = rule.span;
  else if (containerType === "column") span = columns;
  else if (containerType === "row" && mode !== "mobile") span = Math.max(1, Math.floor(columns / Math.max(1, siblings)));
  else if (mode === "mobile") span = columns;
  else span = layout.span ?? defaultSpan(field, columns, styleColumns, mode);
  span = Math.min(Math.max(1, span), columns);
  const col = rule.col ?? (mode === "mobile" || containerType !== "grid" ? undefined : layout.col);
  const row = mode === "mobile" || containerType !== "grid" ? undefined : layout.row;
  const rowSpan = mode === "mobile" || containerType !== "grid" ? undefined : layout.row_span;
  const placement: Placement = { span, hidden };
  if (col !== undefined) placement.col = Math.min(col, columns - span + 1);
  if (row !== undefined) placement.row = row;
  if (rowSpan !== undefined && rowSpan > 1) placement.rowSpan = rowSpan;
  if (layout.page_break) placement.pageBreak = layout.page_break;
  return placement;
}

/** CSS grid-column / grid-row values for a placement (a field may cover several rows). */
export function gridArea(placement: Placement): { gridColumn: string; gridRow?: string } {
  const gridColumn = placement.col !== undefined ? `${placement.col} / span ${placement.span}` : `span ${placement.span}`;
  const rows = placement.rowSpan ?? 1;
  if (placement.row !== undefined) return { gridColumn, gridRow: rows > 1 ? `${placement.row} / span ${rows}` : String(placement.row) };
  return rows > 1 ? { gridColumn, gridRow: `span ${rows}` } : { gridColumn };
}

/** An item on a two-dimensional grid: its width and height in cells, and where it is pinned (if it is). */
export type GridItem = { span: number; rows: number; col?: number; row?: number };
export type GridCell = { row: number; col: number; span: number; rows: number };

/**
 * Where every item sits on a grid of `columns`, as CSS grid places them (sparse auto-placement): items with both row
 * and col stay there; the others fill the next free cells in reading order (a fixed row or column narrows the search).
 * The screen (CSS), the PDF (render/pdfLayout.ts) and the designer all use this, so they agree.
 */
export function autoPlace(items: GridItem[], columns: number): GridCell[] {
  const taken = new Set<string>();
  const free = (row: number, col: number, span: number, rows: number) => {
    for (let r = row; r < row + rows; r += 1) for (let c = col; c < col + span; c += 1) if (taken.has(`${r}:${c}`)) return false;
    return true;
  };
  const claim = (row: number, col: number, span: number, rows: number) => {
    for (let r = row; r < row + rows; r += 1) for (let c = col; c < col + span; c += 1) taken.add(`${r}:${c}`);
  };
  const sized = items.map(item => ({ ...item, span: Math.max(1, Math.min(columns, item.span)), rows: Math.max(1, item.rows) }));
  for (const item of sized) if (item.row !== undefined && item.col !== undefined) claim(item.row, Math.min(item.col, columns - item.span + 1), item.span, item.rows);
  let cursorRow = 1;
  let cursorCol = 1;
  return sized.map(item => {
    if (item.row !== undefined && item.col !== undefined) return { row: item.row, col: Math.min(item.col, columns - item.span + 1), span: item.span, rows: item.rows };
    let row = item.row ?? cursorRow;
    let col = item.col ?? (item.row !== undefined ? 1 : cursorCol);
    for (let guard = 0; guard < 10_000; guard += 1) {
      if (col + item.span - 1 > columns) { row += 1; col = item.col ?? 1; continue; }
      if (free(row, col, item.span, item.rows)) break;
      if (item.col !== undefined) row += 1; else col += 1;
    }
    claim(row, col, item.span, item.rows);
    if (item.row === undefined) { cursorRow = row; cursorCol = col + item.span; }
    return { row, col, span: item.span, rows: item.rows };
  });
}

/** Column count children of a container are placed on. */
export function containerColumns(layout: ContainerLayout | undefined, inherited: number): number {
  return layout?.columns ?? inherited;
}

export const formColumns = (definition: FormDefinition) => containerColumns(definition.layout, DEFAULT_COLUMNS);

// Print (A4 first-class) -------------------------------------------------------------------------

export type PrintContext = {
  title: string; form_id: string; version: number; date: string; record_id?: string; page?: number; pages?: number;
  /** Patient identity printed on every page (from the form's own fields: printIdentity), and when / by whom printed. */
  hn?: string; an?: string; patient?: string; dob?: string; printed_at?: string; printed_by?: string;
  /** The hospital's name (set in Canopy: core/hospital.ts). */
  hospital?: string;
};

type IdentityToken = "hn" | "an" | "patient" | "dob";
const IDENTITY: Record<IdentityToken, string> = { hn: "patient.hn", an: "patient.an", patient: "patient.name", dob: "patient.dob" };

const thDate = (date: Date) => date.toLocaleDateString("th-TH", { year: "numeric", month: "2-digit", day: "2-digit" });

/** The patient a record is about, from the form's fields bound to (or named as) HN, AN, patient name and date of birth
 * (leaf/concepts.ts), or the form's subject field for the HN. Only fields on the form itself (not inside repeats). */
export function printIdentity(definition: FormDefinition, data: Record<string, unknown>): Partial<Record<IdentityToken, string>> {
  const out: Partial<Record<IdentityToken, string>> = {};
  const take = (token: IdentityToken, value: unknown) => {
    if (out[token] !== undefined || value === null || value === undefined || typeof value === "object" || !String(value).trim()) return;
    const text = String(value).trim();
    out[token] = token === "dob" && /^\d{4}-\d{2}-\d{2}$/.test(text) ? thDate(new Date(`${text}T00:00:00`)) : text;
  };
  const walk = (fields: FieldDefinition[]) => {
    for (const field of fields) {
      if (field.type === "repeat") continue;
      const concept = conceptOf(field)?.key;
      for (const token of Object.keys(IDENTITY) as IdentityToken[]) if (concept === IDENTITY[token]) take(token, data[field.key ?? field.id]);
      if (field.fields) walk(field.fields);
    }
  };
  for (const section of definition.sections) {
    walk(section.fields || []);
    for (const category of section.categories || []) walk(category.fields || []);
  }
  const subject = definition.extensions?.["flora.subject_field"];
  if (typeof subject === "string") take("hn", data[subject]);
  return out;
}

/** What every page of a printed record shows: the form, the patient (printIdentity), when and by whom it was printed. */
export function printContext(definition: FormDefinition, data: Record<string, unknown>,
  options: { recordId?: string; date?: string; printedBy?: string; now?: Date; language?: string } = {}): PrintContext {
  const now = options.now ?? new Date();
  const hospital = hospitalName(options.language);
  return {
    title: definition.title, form_id: definition.form_id, version: definition.schema_version, date: options.date ?? thDate(now),
    record_id: options.recordId, ...printIdentity(definition, data),
    printed_at: `${thDate(now)} ${now.toLocaleTimeString("th-TH", { hour: "2-digit", minute: "2-digit" })}`,
    ...(options.printedBy ? { printed_by: options.printedBy } : {}),
    ...(hospital ? { hospital } : {}),
  };
}

/** The footer of a form that sets none: the patient on the left (so every page says whose record it is), when and by
 * whom it was printed and the page number on the right. */
export function defaultFooter(context: PrintContext): PaperBand {
  const who = [context.hn ? "HN {hn}" : "", context.patient ? "{patient}" : "", context.dob ? "DOB {dob}" : "", context.an ? "AN {an}" : ""]
    .filter(Boolean).join(" · ");
  const printed = context.printed_at ? `Printed {printed_at}${context.printed_by ? " · {printed_by}" : ""} · ` : "";
  return { ...(who ? { left: who } : {}), right: `${printed}{page}/{pages}` };
}
export type ResolvedPaper = PaperSpec & { margin: { top: number; right: number; bottom: number; left: number } };

/** Paper size and margins; definition margins win over the style's page margin tokens, then 15 mm. */
export function resolvePaper(definition: Pick<FormDefinition, "paper">, styleTokens: Record<string, unknown> = {}): ResolvedPaper {
  const spec = paperSpec(definition);
  const pick = (side: "top" | "right" | "bottom" | "left", token: string) => {
    const fromStyle = styleTokens[token];
    return spec.margin_mm[side] ?? (typeof fromStyle === "number" ? fromStyle : 15);
  };
  return { ...spec, margin: { top: pick("top", "pageMarginTop"), right: pick("right", "pageMarginRight"), bottom: pick("bottom", "pageMarginBottom"), left: pick("left", "pageMarginLeft") } };
}

/** Fill {title} {form_id} {version} {date} {record_id} {page} {pages} {hn} {an} {patient} {dob} {printed_at} {printed_by};
 * unknown tokens stay as written, known ones without a value print empty. */
const OPTIONAL_TOKENS = new Set(["record_id", "hn", "an", "patient", "dob", "printed_at", "printed_by", "hospital"]);

export function fillTemplate(text: string, context: PrintContext): string {
  return text.replace(/\{([a-z_]+)\}/g, (whole, name: string) => {
    const value = (context as Record<string, unknown>)[name];
    return value === undefined || value === null ? (OPTIONAL_TOKENS.has(name) ? "" : whole) : String(value);
  });
}

const cssString = (text: string) => `"${text.replace(/\\/g, "\\\\").replace(/"/g, "\\\"").replace(/\n/g, " ")}"`;

/** A band template as a CSS `content` value: page numbers become counter(page) / counter(pages). */
export function bandContent(text: string, context: PrintContext): string {
  const parts: string[] = [];
  let rest = text;
  for (;;) {
    const match = /\{(page|pages)\}/.exec(rest);
    if (!match) break;
    if (match.index > 0) parts.push(cssString(fillTemplate(rest.slice(0, match.index), context)));
    parts.push(`counter(${match[1]})`);
    rest = rest.slice(match.index + match[0].length);
  }
  if (rest) parts.push(cssString(fillTemplate(rest, context)));
  return parts.length ? parts.join(" ") : "none";
}

const SLOT_BOX: Record<"header" | "footer", Record<"left" | "center" | "right", string>> = {
  header: { left: "@top-left", center: "@top-center", right: "@top-right" },
  footer: { left: "@bottom-left", center: "@bottom-center", right: "@bottom-right" },
};

/** @page rules: sheet size and orientation, margins, header/footer in the page margin boxes. */
export function pageCss(paper: ResolvedPaper, context: PrintContext, fontStack: string): string {
  if (paper.width_mm === null) return "";
  const { top, right, bottom, left } = paper.margin;
  const boxes: string[] = [];
  const first: string[] = [];
  for (const band of ["header", "footer"] as const) {
    const config: PaperBand | undefined = band === "footer" ? paper.footer ?? defaultFooter(context) : paper[band];
    if (!config) continue;
    for (const slot of ["left", "center", "right"] as const) {
      if (!config[slot]) continue;
      boxes.push(`  ${SLOT_BOX[band][slot]} { content: ${bandContent(config[slot] as string, context)}; font-family: ${fontStack}; font-size: 8pt; color: #475569; }`);
      if (config.first_page === false) first.push(`  ${SLOT_BOX[band][slot]} { content: none; }`);
    }
  }
  const size = `${paper.size} ${paper.orientation}`;
  return [`@page { size: ${size}; margin: ${top}mm ${right}mm ${bottom}mm ${left}mm;`, ...boxes, "}", first.length ? `@page :first {\n${first.join("\n")}\n}` : ""].filter(Boolean).join("\n");
}

/** Top-level sections grouped into sheets at page_break before/after. */
export function sheetsOf(sections: SectionDefinition[]): SectionDefinition[][] {
  const sheets: SectionDefinition[][] = [[]];
  for (const section of sections) {
    if (section.page_break === "before" && sheets[sheets.length - 1].length) sheets.push([]);
    sheets[sheets.length - 1].push(section);
    if (section.page_break === "after") sheets.push([]);
  }
  return sheets.filter(sheet => sheet.length);
}
