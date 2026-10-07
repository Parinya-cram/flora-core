/**
 * PDF page layout (Designer phase: PDF output). Pure: given a definition, an evaluated record and a text measure,
 * it returns the drawing operations of every page, in points from the top-left corner. formPdf.ts draws them
 * with pdf-lib. The rules follow the A4 print view (FormPrint): the same 12-column placement (layout "print"),
 * page breaks, hidden and permission-denied fields left out, options as ○/● and ☐/☑ (drawn as shapes), blank
 * lines to write on, repeat tables, header / footer bands with {page}/{pages}.
 */
import { asRepeatField } from "../core/blocks";
import { containerColumns, fillTemplate, formColumns, placeField, type PrintContext, type ResolvedPaper } from "../core/layout";
import type { CategoryDefinition, FieldDefinition, FileValue, FormDefinition, JsonValue, SectionDefinition, SignatureValue } from "../core/types";
import { fieldKey, OTHER_KEY } from "../core/validate";
import { cellText, optionText, printedText } from "./printValues";

export const MM = 72 / 25.4;
export type Measure = (text: string, size: number) => number;
export type Tone = "text" | "muted" | "accent";
export type Op =
  | { kind: "text"; x: number; y: number; size: number; text: string; tone?: Tone }
  | { kind: "line"; x1: number; y1: number; x2: number; y2: number; dotted?: boolean; width?: number }
  | { kind: "rect"; x: number; y: number; w: number; h: number }
  | { kind: "mark"; x: number; y: number; size: number; round: boolean; on: boolean }
  | { kind: "image"; x: number; y: number; w: number; h: number; data: string };
export type PdfLayout = { width: number; height: number; pages: Op[][] };
export type LayoutInput = {
  definition: FormDefinition; data: Record<string, JsonValue>; paper: ResolvedPaper; context: PrintContext;
  /** Data paths hidden by visibility ("$.data.x", "$.data.meds[0].dose") and nodes the user may not view ("x", "meds.dose"). */
  hidden: Set<string>; denied: Set<string>; styleColumns: number; measure: Measure; language?: string;
};

const SIZE = { title: 14, section: 11.5, category: 10, label: 7.5, value: 9.5, table: 8.5, band: 7.5 };
const LINE = 1.45;
const GAP = 2.5 * MM;
const COL_GAP = 3 * MM;
const BLANK = 14;

// Text wrapping (Thai has no spaces between words) -------------------------------------------------

const segmenter = (granularity: "word" | "grapheme") => {
  try {
    return new Intl.Segmenter("th", { granularity });
  } catch {
    return null;
  }
};
const WORDS = segmenter("word");
const GRAPHEMES = segmenter("grapheme");
const pieces = (text: string, by: Intl.Segmenter | null, fallback: RegExp) =>
  by ? [...by.segment(text)].map(part => part.segment) : text.split(fallback).filter(Boolean);

/** Lines of `text` no wider than `width`: words first, then graphemes for a word that does not fit. */
export function wrap(text: string, size: number, width: number, measure: Measure): string[] {
  const out: string[] = [];
  for (const paragraph of text.split(/\r?\n/)) {
    if (!paragraph.trim()) { out.push(""); continue; }
    let line = "";
    const push = () => { out.push(line.trimEnd()); line = ""; };
    for (const word of pieces(paragraph, WORDS, /(\s+)/)) {
      if (measure(line + word, size) <= width) { line += word; continue; }
      if (line.trim()) push();
      if (measure(word, size) <= width) { line = word.trimStart(); continue; }
      for (const glyph of pieces(word, GRAPHEMES, /(?=.)/u)) {
        if (line && measure(line + glyph, size) > width) push();
        line += glyph;
      }
    }
    if (line.trim()) push();
  }
  return out;
}

// Blocks: something with a height that draws itself at (x, y) ------------------------------------

/** repeatHeader: drawn again at the top of a new page before this block (table rows). */
/** gapAfter: space below the block (rows of one table touch: 0). */
type Block = { height: number; draw: (x: number, y: number) => Op[]; breakBefore?: boolean; breakAfter?: boolean; repeatHeader?: Block; gapAfter?: number };
type Ctx = LayoutInput & { contentWidth: number };

function textLines(ctx: Ctx, text: string, size: number, width: number, tone: Tone = "text"): Block {
  const lines = wrap(text, size, width, ctx.measure);
  const step = size * LINE;
  return { height: lines.length * step, draw: (x, y) => lines.map((line, index) => ({ kind: "text", x, y: y + size + index * step, size, text: line, tone })) };
}

/** Inline items (mark + text) that wrap like words. */
function markItems(ctx: Ctx, items: Array<{ text: string; on: boolean; round: boolean }>, width: number): Block {
  const size = SIZE.value;
  const step = size * LINE;
  const box = size * 0.8;
  const placed: Array<{ x: number; row: number; item: (typeof items)[number] }> = [];
  let x = 0;
  let row = 0;
  for (const item of items) {
    const w = box + 3 + ctx.measure(item.text, size);
    if (x > 0 && x + w > width) { row += 1; x = 0; }
    placed.push({ x, row, item });
    x += w + 4 * MM;
  }
  return {
    height: (row + 1) * step,
    draw: (left, top) => placed.flatMap(({ x: dx, row: r, item }) => [
      { kind: "mark" as const, x: left + dx, y: top + r * step + (step - box) / 2, size: box, round: item.round, on: item.on },
      ...wrap(item.text, size, Math.max(width - dx - box - 3, 20), ctx.measure).slice(0, 1)
        .map(text => ({ kind: "text" as const, x: left + dx + box + 3, y: top + r * step + size, size, text })),
    ]),
  };
}

function stack(blocks: Block[], gap = 0): Block {
  const parts = blocks.filter(block => block.height > 0);
  return {
    height: parts.reduce((sum, block) => sum + block.height, 0) + Math.max(0, parts.length - 1) * gap,
    draw: (x, y) => {
      let top = y;
      return parts.flatMap(block => { const ops = block.draw(x, top); top += block.height + gap; return ops; });
    },
  };
}

function valueBlock(ctx: Ctx, field: FieldDefinition, value: JsonValue | undefined, other: string | undefined, width: number): Block {
  switch (field.type) {
    case "select":
    case "radio":
      return field.options?.length
        ? markItems(ctx, field.options.map(option => ({ text: optionText(option, value === option.value, other), on: value === option.value, round: true })), width)
        : underlined(ctx, typeof value === "string" ? value : "", width);
    case "multiselect": {
      const selected = Array.isArray(value) ? value : [];
      return field.options?.length
        ? markItems(ctx, field.options.map(option => ({ text: optionText(option, selected.includes(option.value), other), on: selected.includes(option.value), round: false })), width)
        : underlined(ctx, selected.join(", "), width);
    }
    case "checkbox":
    case "switch":
      return markItems(ctx, [{ text: field.label, on: value === true, round: false }], width);
    case "textarea": {
      const text = typeof value === "string" ? value : "";
      if (text) return textLines(ctx, text, SIZE.value, width);
      return { height: 3 * BLANK, draw: (x, y) => [0, 1, 2].map(line => ({ kind: "line" as const, x1: x, y1: y + (line + 1) * BLANK, x2: x + width, y2: y + (line + 1) * BLANK, dotted: true })) };
    }
    case "file":
    case "image": {
      const files = Array.isArray(value) ? (value as FileValue[]) : value ? [value as FileValue] : [];
      return files.length ? textLines(ctx, files.map(file => `• ${file.name}`).join("\n"), SIZE.value, width)
        : markItems(ctx, [{ text: ctx.language?.startsWith("en") ? "Attached" : "แนบเอกสาร", on: false, round: false }], width);
    }
    case "signature": {
      const signature = value as SignatureValue | undefined;
      const image = typeof signature?.data === "string" && /^data:image\/(png|jpe?g);base64,/.test(signature.data) ? signature.data : null;
      const h = 16 * MM;
      const caption = textLines(ctx, `(${".".repeat(40)})${signature?.signer ? `\n${signature.signer}` : ""}`, SIZE.label + 0.5, width, "muted");
      return {
        height: h + caption.height,
        draw: (x, y) => [
          ...(image ? [{ kind: "image" as const, x: x + width / 2 - 25 * MM, y, w: 50 * MM, h, data: image }] : []),
          ...caption.draw(x + Math.max(0, width / 2 - 30 * MM), y + h),
        ],
      };
    }
    default:
      return underlined(ctx, printedText(field, value), width);
  }
}

/** A value on a line: solid underline when written, dotted (to write on) when empty. */
function underlined(ctx: Ctx, text: string, width: number): Block {
  if (!text) return { height: BLANK, draw: (x, y) => [{ kind: "line", x1: x, y1: y + BLANK - 2, x2: x + width, y2: y + BLANK - 2, dotted: true }] };
  const lines = textLines(ctx, text, SIZE.value, width);
  return { height: lines.height + 2, draw: (x, y) => [...lines.draw(x, y), { kind: "line", x1: x, y1: y + lines.height + 1, x2: x + width, y2: y + lines.height + 1, width: 0.4 }] };
}

// Fields on the grid --------------------------------------------------------------------------------

const visible = (ctx: Ctx, path: string, node: string) => !ctx.hidden.has(path) && !ctx.denied.has(node);

/** Rows of a field list on its grid; repeat fields become full-width tables (each table row its own block). */
function fieldRows(ctx: Ctx, fields: FieldDefinition[], data: Record<string, JsonValue>, columns: number, width: number, containerType: "grid" | "row" | "column" = "grid", prefix = ""): Block[] {
  const colWidth = (width + COL_GAP) / columns;
  const out: Block[] = [];
  let row: Array<{ start: number; span: number; block: Block }> = [];
  let cursor = 1;
  let breakAfterRow = false;
  const flush = () => {
    if (!row.length) return;
    const cells = row;
    const height = Math.max(...cells.map(cell => cell.block.height));
    out.push({ height, breakAfter: breakAfterRow, draw: (x, y) => cells.flatMap(cell => cell.block.draw(x + (cell.start - 1) * colWidth, y)) });
    row = [];
    cursor = 1;
    breakAfterRow = false;
  };
  for (const field of fields) {
    const key = fieldKey(field);
    const placement = placeField(field, "print", columns, ctx.styleColumns, containerType, fields.length);
    if (placement.hidden || !visible(ctx, `$.data.${prefix}${key}`, key)) continue;
    if (placement.pageBreak === "before") { flush(); out.push({ height: 0, breakBefore: true, draw: () => [] }); }
    if (field.type === "repeat") {
      flush();
      out.push(...repeatTable(ctx, field, Array.isArray(data[key]) ? data[key] as Array<Record<string, JsonValue>> : [], width));
      if (placement.pageBreak === "after") out.push({ height: 0, breakAfter: true, draw: () => [] });
      continue;
    }
    const span = Math.min(placement.span, columns);
    let start = placement.col ?? cursor;
    if (start < cursor || start + span - 1 > columns) { flush(); start = placement.col ?? 1; }
    const cellWidth = span * colWidth - COL_GAP;
    const label = field.type === "checkbox" || field.type === "switch" ? null
      : textLines(ctx, `${field.label}${field.unit && field.type !== "decimal" && field.type !== "number" && field.type !== "integer" ? ` (${field.unit})` : ""}${field.required ? " *" : ""}`, SIZE.label, cellWidth, "muted");
    const body = field.type === "group"
      ? stack(fieldRows(ctx, field.fields ?? [], data, containerColumns({ columns: field.columns }, columns), cellWidth, "grid", prefix), 1.5 * MM)
      : valueBlock(ctx, field, data[key], (data[OTHER_KEY] as Record<string, JsonValue> | undefined)?.[key] as string | undefined, cellWidth);
    row.push({ start, span, block: stack(label ? [label, body] : [body], 1) });
    cursor = start + span;
    if (placement.pageBreak === "after") { breakAfterRow = true; flush(); }
  }
  flush();
  return out;
}

function repeatTable(ctx: Ctx, field: FieldDefinition, items: Array<Record<string, JsonValue>>, width: number): Block[] {
  const key = fieldKey(field);
  const children = (field.fields ?? []).filter(child => child.type !== "group" && child.type !== "repeat" && !ctx.denied.has(`${key}.${fieldKey(child)}`));
  const rows = items.length ? items : Array.from({ length: Math.max(field.min_items ?? 0, 3) }, () => ({}));
  const numberWidth = 8 * MM;
  const each = children.length ? (width - numberWidth) / children.length : width - numberWidth;
  const pad = 1.5 * MM;
  const tableRow = (cells: string[], tone: Tone): Block => {
    const blocks = cells.map((text, index) => textLines(ctx, text, SIZE.table, (index === 0 ? numberWidth : each) - 2 * pad, tone));
    const height = Math.max(7 * MM, ...blocks.map(block => block.height + 2 * pad));
    return {
      height,
      draw: (x, y) => blocks.flatMap((block, index) => {
        const left = index === 0 ? x : x + numberWidth + (index - 1) * each;
        const w = index === 0 ? numberWidth : each;
        return [{ kind: "rect" as const, x: left, y, w, h: height }, ...block.draw(left + pad, y + pad)];
      }),
    };
  };
  const header = tableRow(["#", ...children.map(child => child.label)], "muted");
  const title = textLines(ctx, field.label, SIZE.label, width, "muted");
  const body = rows.map((item, index) => tableRow([String(index + 1), ...children.map(child =>
    ctx.hidden.has(`$.data.${key}[${index}].${fieldKey(child)}`) ? "—" : cellText(child, item))], "text"));
  // The title and header stay with the first row; later pages repeat the header (see paginate).
  const blocks: Block[] = [stack([title, stack([header, body[0]])], 1), ...body.slice(1).map(block => ({ ...block, repeatHeader: header }))];
  return blocks.map((block, index) => (index < blocks.length - 1 ? { ...block, gapAfter: 0 } : block));
}

function blockHeading(ctx: Ctx, text: string, size: number, width: number, rule: boolean): Block {
  const lines = textLines(ctx, text, size, width, rule ? "accent" : "text");
  return rule ? { height: lines.height + 3, draw: (x, y) => [...lines.draw(x, y), { kind: "line", x1: x, y1: y + lines.height + 1.5, x2: x + width, y2: y + lines.height + 1.5, width: 0.6 }] } : lines;
}

function sectionBlocks(ctx: Ctx, section: SectionDefinition | CategoryDefinition, columns: number, depth: number, isCategory = false): Block[] {
  const top = ctx.data;
  const out: Block[] = [];
  const holder = section as SectionDefinition;
  if (section.page_break === "before") out.push({ height: 0, breakBefore: true, draw: () => [] });
  const inner = containerColumns(section.layout, columns);
  out.push(blockHeading(ctx, section.title, isCategory ? SIZE.category : depth === 1 ? SIZE.section : SIZE.category, ctx.contentWidth, !isCategory));
  if (section.repeat) {
    out.push(...repeatTable(ctx, asRepeatField(section as unknown as Record<string, unknown>), Array.isArray(top[section.repeat.key]) ? top[section.repeat.key] as Array<Record<string, JsonValue>> : [], ctx.contentWidth));
  } else {
    out.push(...fieldRows(ctx, section.fields ?? [], top, inner, ctx.contentWidth, section.layout?.type ?? "grid"));
  }
  if (!isCategory) {
    for (const category of holder.categories ?? []) if (shown(ctx, category)) out.push(...sectionBlocks(ctx, category, inner, depth + 1, true));
    for (const child of holder.sections ?? []) if (shown(ctx, child)) out.push(...sectionBlocks(ctx, child, inner, depth + 1));
  }
  if (section.page_break === "after") out.push({ height: 0, breakAfter: true, draw: () => [] });
  return out;
}

/** A section or category is left out when every field in it is hidden or denied. */
function shown(ctx: Ctx, block: SectionDefinition | CategoryDefinition): boolean {
  if (block.repeat) return !ctx.denied.has(block.repeat.key);
  const holder = block as SectionDefinition;
  const fieldShown = (field: FieldDefinition): boolean => field.type === "group" ? (field.fields ?? []).some(fieldShown) : visible(ctx, `$.data.${fieldKey(field)}`, fieldKey(field));
  return (block.fields ?? []).some(fieldShown) || (holder.categories ?? []).some(category => shown(ctx, category)) || (holder.sections ?? []).some(child => shown(ctx, child));
}

// Pages -----------------------------------------------------------------------------------------------

export function layoutPdf(input: LayoutInput): PdfLayout {
  const { paper } = input;
  const width = (paper.width_mm ?? 210) * MM;
  const height = (paper.height_mm ?? 297) * MM;
  const left = paper.margin.left * MM;
  const top = paper.margin.top * MM;
  const contentWidth = width - left - paper.margin.right * MM;
  const bottom = height - paper.margin.bottom * MM;
  const ctx: Ctx = { ...input, contentWidth };

  const blocks: Block[] = [
    stack([textLines(ctx, input.definition.title, SIZE.title, contentWidth),
      textLines(ctx, [input.context.record_id ? `#${input.context.record_id}` : "", `${input.definition.form_id} v${input.definition.schema_version}`, input.context.date].filter(Boolean).join(" · "), SIZE.label, contentWidth, "muted")], 2),
  ];
  for (const section of input.definition.sections) if (shown(ctx, section)) blocks.push(...sectionBlocks(ctx, section, formColumns(input.definition), 1));

  const pages: Op[][] = [[]];
  let y = top;
  const newPage = () => { pages.push([]); y = top; };
  for (const block of blocks) {
    const repeated = block.repeatHeader;
    if (block.breakBefore && y > top) newPage();
    if (block.height > 0 && y + block.height > bottom && y > top) {
      newPage();
      if (repeated) { pages[pages.length - 1].push(...repeated.draw(left, y)); y += repeated.height; }
    }
    if (block.height > 0) {
      pages[pages.length - 1].push(...block.draw(left, y));
      y += block.height + (block.gapAfter ?? GAP);
    }
    if (block.breakAfter) newPage();
  }
  while (pages.length > 1 && !pages[pages.length - 1].length) pages.pop();

  // Bands: header / footer slots, {page}/{pages}; a page number at the bottom right when no footer is set.
  const footer = paper.footer ?? { right: "{page}/{pages}" };
  pages.forEach((ops, index) => {
    const context = { ...input.context, page: index + 1, pages: pages.length };
    for (const [config, baseline] of [[paper.header, top / 2 + SIZE.band / 2], [footer, bottom + (height - bottom) / 2 + SIZE.band / 2]] as const) {
      if (!config || (config.first_page === false && index === 0)) continue;
      for (const slot of ["left", "center", "right"] as const) {
        const template = config[slot];
        if (!template) continue;
        const text = fillTemplate(template, context);
        const w = input.measure(text, SIZE.band);
        const x = slot === "left" ? left : slot === "center" ? left + (contentWidth - w) / 2 : left + contentWidth - w;
        ops.push({ kind: "text", x, y: baseline, size: SIZE.band, text, tone: "muted" });
      }
    }
  });
  return { width, height, pages };
}
