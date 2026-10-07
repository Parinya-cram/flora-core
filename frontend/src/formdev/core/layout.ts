/**
 * Layout engine (Phase 1.5) and A4 print layout (Phase 1.6). Pure functions; the renderers turn the
 * result into CSS grid placement and @page rules.
 *
 * Screen and print are separate layouts: each mode (desktop, tablet, mobile, print) resolves its own
 * span/column/visibility per field, and print additionally paginates into sheets of the paper size.
 */
import { DEFAULT_COLUMNS, displayed, paperSpec, type PaperSpec } from "./validate";
import type { ContainerLayout, FieldDefinition, FormDefinition, LayoutMode, PaperBand, SectionDefinition } from "./types";

export type Placement = { span: number; col?: number; row?: number; hidden: boolean; pageBreak?: "before" | "after" | "avoid" };

/** Viewport width (px) -> layout mode. Print is chosen explicitly, never by width. */
export function modeForWidth(width: number): Exclude<LayoutMode, "print"> {
  return width >= 1024 ? "desktop" : width >= 640 ? "tablet" : "mobile";
}

/** Fields that read best across the whole row unless told otherwise. */
const FULL_WIDTH = new Set(["textarea", "multiselect", "group", "repeat", "signature"]);

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
  const placement: Placement = { span, hidden };
  if (col !== undefined) placement.col = Math.min(col, columns - span + 1);
  if (row !== undefined) placement.row = row;
  if (layout.page_break) placement.pageBreak = layout.page_break;
  return placement;
}

/** CSS grid-column / grid-row values for a placement. */
export function gridArea(placement: Placement): { gridColumn: string; gridRow?: string } {
  const gridColumn = placement.col !== undefined ? `${placement.col} / span ${placement.span}` : `span ${placement.span}`;
  return placement.row !== undefined ? { gridColumn, gridRow: String(placement.row) } : { gridColumn };
}

/** Column count children of a container are placed on. */
export function containerColumns(layout: ContainerLayout | undefined, inherited: number): number {
  return layout?.columns ?? inherited;
}

export const formColumns = (definition: FormDefinition) => containerColumns(definition.layout, DEFAULT_COLUMNS);

// Print (A4 first-class) -------------------------------------------------------------------------

export type PrintContext = { title: string; form_id: string; version: number; date: string; record_id?: string; page?: number; pages?: number };
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

/** Fill {title} {form_id} {version} {date} {record_id} {page} {pages}; unknown tokens stay as written. */
export function fillTemplate(text: string, context: PrintContext): string {
  return text.replace(/\{([a-z_]+)\}/g, (whole, name: string) => {
    const value = (context as Record<string, unknown>)[name];
    return value === undefined || value === null ? (name === "record_id" ? "" : whole) : String(value);
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
    const config: PaperBand | undefined = paper[band];
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
