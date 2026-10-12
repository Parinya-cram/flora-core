/**
 * PDF page layout (Designer phase: PDF output). Pure: given a definition, an evaluated record and a text measure,
 * it returns the drawing operations of every page, in points from the top-left corner. formPdf.ts draws them
 * with pdf-lib. The rules follow the A4 print view (FormPrint): the same 12-column placement (layout "print"),
 * page breaks, hidden and permission-denied fields left out, options as ○/● and ☐/☑ (drawn as shapes), blank
 * lines to write on, repeat tables, header / footer bands with {page}/{pages}.
 *
 * Paper layout (Template phase): a boxed section (print_style: boxed) draws its fields as bordered cells that touch,
 * "Label: value" on one line when it fits, group titles and section titles as shaded bars; options can sit in columns
 * (option_columns), a matrix is a bordered score table with its total rows, and top-level sections marked
 * repeat_on_pages header / footer are drawn on every page (the content flows between them).
 */
import { asRepeatField } from "../core/blocks";
import { containerColumns, fillTemplate, formColumns, placeField, type PrintContext, type ResolvedPaper } from "../core/layout";
import type { CategoryDefinition, FieldDefinition, FileValue, FormDefinition, JsonValue, MatrixValue, SectionDefinition, SignatureValue, TimelineValue } from "../core/types";
import { chartShapes, markerPath } from "../leaf/chartGeometry";
import { asTimeline, cellLabel, eventColumn, rowInfo, SERIES, timeLabel, timelineConfig } from "../leaf/timeline";
import { fieldKey, matrixCell, matrixTotals, OTHER_KEY } from "../core/validate";
import { cellText, optionText, printedText } from "./printValues";

export const MM = 72 / 25.4;
export type Measure = (text: string, size: number, bold?: boolean) => number;
export type Tone = "text" | "muted" | "accent";
export type Op =
  | { kind: "text"; x: number; y: number; size: number; text: string; tone?: Tone; bold?: boolean }
  | { kind: "line"; x1: number; y1: number; x2: number; y2: number; dotted?: boolean; width?: number; color?: string }
  /** An SVG path in page coordinates (points, y down): chart markers. */
  | { kind: "path"; d: string; color: string; filled: boolean; width?: number }
  /** fill: a shaded bar (titles, table headers); the border is always drawn. */
  | { kind: "rect"; x: number; y: number; w: number; h: number; fill?: boolean }
  | { kind: "mark"; x: number; y: number; size: number; round: boolean; on: boolean }
  | { kind: "image"; x: number; y: number; w: number; h: number; data: string };
export type PdfLayout = { width: number; height: number; pages: Op[][] };
export type LayoutInput = {
  definition: FormDefinition; data: Record<string, JsonValue>; paper: ResolvedPaper; context: PrintContext;
  /** Data paths hidden by visibility ("$.data.x", "$.data.meds[0].dose") and nodes the user may not view ("x", "meds.dose"). */
  hidden: Set<string>; denied: Set<string>; styleColumns: number; measure: Measure; language?: string;
};

const SIZE = { title: 14, section: 11.5, category: 10, label: 7.5, value: 9.5, table: 8.5, band: 7.5 };
/** Boxed (paper) sections use the denser type of printed hospital forms. */
const BOX = { value: 8, title: 9, section: 10 };
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
export function wrap(text: string, size: number, width: number, measure: Measure, bold = false): string[] {
  const fits = (candidate: string) => measure(candidate, size, bold) <= width;
  const out: string[] = [];
  for (const paragraph of text.split(/\r?\n/)) {
    if (!paragraph.trim()) { out.push(""); continue; }
    let line = "";
    const push = () => { out.push(line.trimEnd()); line = ""; };
    for (const word of pieces(paragraph, WORDS, /(\s+)/)) {
      if (fits(line + word)) { line += word; continue; }
      if (line.trim()) push();
      if (fits(word)) { line = word.trimStart(); continue; }
      for (const glyph of pieces(word, GRAPHEMES, /(?=.)/u)) {
        if (line && !fits(line + glyph)) push();
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

function textLines(ctx: Ctx, text: string, size: number, width: number, tone: Tone = "text", bold = false, align: "left" | "center" = "left"): Block {
  const lines = wrap(text, size, width, ctx.measure, bold);
  const step = size * LINE;
  return {
    height: lines.length * step,
    draw: (x, y) => lines.map((line, index) => ({
      kind: "text", x: align === "center" ? x + Math.max(0, (width - ctx.measure(line, size, bold)) / 2) : x, y: y + size + index * step, size, text: line, tone, bold,
    })),
  };
}

/** Inline items (mark + text) that wrap like words; with `columns`, a grid of equal columns (bordered cells when
 * `boxed`, as on a paper checklist). */
function markItems(ctx: Ctx, items: Array<{ text: string; on: boolean; round: boolean }>, width: number, columns?: number, boxed = false): Block {
  if (columns) return markGrid(ctx, items, width, columns, boxed);
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

function markGrid(ctx: Ctx, items: Array<{ text: string; on: boolean; round: boolean }>, width: number, columns: number, boxed: boolean): Block {
  const size = boxed ? BOX.value : SIZE.value;
  const pad = boxed ? 1.2 * MM : 0;
  const box = size * 0.8;
  const each = width / columns;
  const cells = items.map(item => ({ item, lines: wrap(item.text, size, Math.max(each - box - 3 - 2 * pad, 20), ctx.measure) }));
  const rowHeights: number[] = [];
  cells.forEach((cell, index) => {
    const row = Math.floor(index / columns);
    rowHeights[row] = Math.max(rowHeights[row] ?? 0, cell.lines.length * size * LINE + 2 * pad);
  });
  const tops = rowHeights.map((_, row) => rowHeights.slice(0, row).reduce((sum, h) => sum + h, 0));
  return {
    height: rowHeights.reduce((sum, h) => sum + h, 0),
    draw: (left, top) => cells.flatMap(({ item, lines }, index) => {
      const row = Math.floor(index / columns);
      const x = left + (index % columns) * each;
      const y = top + tops[row];
      return [
        ...(boxed ? [{ kind: "rect" as const, x, y, w: each, h: rowHeights[row] }] : []),
        { kind: "mark" as const, x: x + pad, y: y + pad + (size * LINE - box) / 2, size: box, round: item.round, on: item.on },
        ...lines.map((text, line) => ({ kind: "text" as const, x: x + pad + box + 3, y: y + pad + size + line * size * LINE, size, text })),
      ];
    }),
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

function valueBlock(ctx: Ctx, field: FieldDefinition, value: JsonValue | undefined, other: string | undefined, width: number, boxed = false): Block {
  switch (field.type) {
    case "select":
    case "radio":
      return field.options?.length
        ? markItems(ctx, field.options.map(option => ({ text: optionText(option, value === option.value, other), on: value === option.value, round: true })), width, field.option_columns, boxed)
        : underlined(ctx, typeof value === "string" ? value : "", width);
    case "multiselect": {
      const selected = Array.isArray(value) ? value : [];
      return field.options?.length
        ? markItems(ctx, field.options.map(option => ({ text: optionText(option, selected.includes(option.value), other), on: selected.includes(option.value), round: false })), width, field.option_columns, boxed)
        : underlined(ctx, selected.join(", "), width);
    }
    case "matrix":
      return matrixTable(ctx, field, value, width);
    case "timeline":
      return stack(timelineBlocks(ctx, field, value, width).map(block => ({ ...block, breakBefore: false })));
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
function fieldRows(ctx: Ctx, fields: FieldDefinition[], data: Record<string, JsonValue>, columns: number, width: number, containerType: "grid" | "row" | "column" = "grid", prefix = "", boxed = false): Block[] {
  if (boxed) return boxedRows(ctx, fields, data, columns, width, containerType, prefix);
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
    if (field.type === "timeline") {
      // Full width, one block per page of columns (each starts a new page).
      flush();
      out.push(...timelineBlocks(ctx, field, data[key], width));
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

// Boxed sections (paper layout) ---------------------------------------------------------------------

const PAD = 1.2 * MM;
/** One-line values that read as "Label: value" in a box. */
const INLINE = new Set(["text", "number", "decimal", "integer", "date", "datetime", "time", "calculated", "select"]);

/** A shaded title bar, centred and bold (section titles, group titles, matrix titles). */
function titleBar(ctx: Ctx, text: string, width: number, size = BOX.title): Block {
  const lines = textLines(ctx, text, size, width - 2 * PAD, "text", true, "center");
  const height = lines.height + 2 * PAD;
  return { height, gapAfter: 0, draw: (x, y) => [{ kind: "rect", x, y, w: width, h: height, fill: true }, ...lines.draw(x + PAD, y + PAD)] };
}

/** A boxed cell's label, as printed on paper (no required mark; units of numbers follow the value). */
const fieldLabel = (field: FieldDefinition) => `${field.label}${field.unit && !["decimal", "number", "integer", "calculated"].includes(field.type) ? ` (${field.unit})` : ""}`;

/** "Label: value" on one line when both fit, otherwise the label above the value. */
function labelled(ctx: Ctx, label: string, value: string, width: number): Block {
  const size = BOX.value;
  const head = `${label}:`;
  const headWidth = ctx.measure(head, size, true);
  if (!value) return textLines(ctx, head, size, width, "text", true);
  if (headWidth + 4 + ctx.measure(value, size) <= width) {
    return { height: size * LINE, draw: (x, y) => [{ kind: "text", x, y: y + size, size, text: head, bold: true }, { kind: "text", x: x + headWidth + 4, y: y + size, size, text: value }] };
  }
  return stack([textLines(ctx, head, size, width, "text", true), textLines(ctx, value, size, width)]);
}

/** The content of a boxed cell (without its border). Groups are handled by boxedRows. */
function boxedContent(ctx: Ctx, field: FieldDefinition, data: Record<string, JsonValue>, width: number): Block {
  const key = fieldKey(field);
  const value = data[key];
  const other = (data[OTHER_KEY] as Record<string, JsonValue> | undefined)?.[key] as string | undefined;
  if (INLINE.has(field.type) && !(field.type === "select" && field.option_columns)) {
    const option = field.options?.find(item => item.value === value);
    return labelled(ctx, fieldLabel(field), option ? optionText(option, true, other) : printedText(field, value), width);
  }
  if (field.type === "checkbox" || field.type === "switch") return markGrid(ctx, [{ text: field.label, on: value === true, round: false }], width, 1, false);
  if (field.type === "signature") {
    const signature = value as SignatureValue | undefined;
    const image = typeof signature?.data === "string" && /^data:image\/(png|jpe?g);base64,/.test(signature.data) ? signature.data : null;
    const h = 12 * MM;
    const name = textLines(ctx, signature?.signer ? `( ${signature.signer} )` : `(${".".repeat(28)})`, BOX.value, width, "text", false, "center");
    const role = textLines(ctx, field.label, BOX.value, width, "text", true, "center");
    return {
      height: h + name.height + role.height,
      draw: (x, y) => [
        ...(image ? [{ kind: "image" as const, x: x + width / 2 - 20 * MM, y, w: 40 * MM, h, data: image }] : []),
        ...name.draw(x, y + h), ...role.draw(x, y + h + name.height),
      ],
    };
  }
  const body = field.type === "radio" || field.type === "multiselect"
    ? markGrid(ctx, (field.options ?? []).map(option => {
      const on = Array.isArray(value) ? value.includes(option.value) : value === option.value;
      return { text: optionText(option, on, other), on, round: field.type === "radio" };
    }), width, 1, false)
    : field.type === "textarea" ? textLines(ctx, typeof value === "string" ? value : "", BOX.value, width) : valueBlock(ctx, field, value, other, width, false);
  return stack([textLines(ctx, fieldLabel(field), BOX.value, width, "text", true), body], 1);
}

/** Rows of bordered cells that touch (no column gap); every cell of a row has the row's height. Option grids and
 * matrices draw their own borders; a group is a titled block of boxed rows. */
function boxedRows(ctx: Ctx, fields: FieldDefinition[], data: Record<string, JsonValue>, columns: number, width: number, containerType: "grid" | "row" | "column", prefix: string): Block[] {
  const colWidth = width / columns;
  const out: Block[] = [];
  let row: Array<{ start: number; span: number; content: Block; frame: boolean }> = [];
  let cursor = 1;
  const flush = () => {
    if (!row.length) return;
    const cells = row;
    const height = Math.max(...cells.map(cell => cell.content.height + (cell.frame ? 2 * PAD : 0)));
    out.push({
      height, gapAfter: 0,
      draw: (x, y) => cells.flatMap(cell => {
        const left = x + (cell.start - 1) * colWidth;
        const w = cell.span * colWidth;
        return cell.frame ? [{ kind: "rect" as const, x: left, y, w, h: height }, ...cell.content.draw(left + PAD, y + PAD)] : cell.content.draw(left, y);
      }),
    });
    row = [];
    cursor = 1;
  };
  for (const field of fields) {
    const key = fieldKey(field);
    const placement = placeField(field, "print", columns, ctx.styleColumns, containerType, fields.length);
    if (placement.hidden || (field.type !== "group" && !visible(ctx, `$.data.${prefix}${key}`, key))) continue;
    if (placement.pageBreak === "before") { flush(); out.push({ height: 0, breakBefore: true, draw: () => [] }); }
    if (field.type === "repeat") {
      flush();
      out.push(...repeatTable(ctx, field, Array.isArray(data[key]) ? data[key] as Array<Record<string, JsonValue>> : [], width).map(block => ({ ...block, gapAfter: 0 })));
      continue;
    }
    const span = Math.min(placement.span, columns);
    let start = placement.col ?? cursor;
    if (start < cursor || start + span - 1 > columns) { flush(); start = placement.col ?? 1; }
    const w = span * colWidth;
    let content: Block;
    let frame = true;
    if (field.type === "group") {
      const inner = fieldRows(ctx, field.fields ?? [], data, containerColumns({ columns: field.columns }, columns), w, "grid", prefix, true);
      content = stack([titleBar(ctx, field.label, w, BOX.value + 0.5), ...inner]);
      frame = false;
    } else if (field.type === "matrix") {
      content = matrixTable(ctx, field, data[key], w);
      frame = false;
    } else if (field.type === "timeline") {
      flush();
      out.push(...timelineBlocks(ctx, field, data[key], width).map(block => ({ ...block, gapAfter: block.gapAfter ?? GAP })));
      continue;
    } else if ((field.type === "multiselect" || field.type === "radio" || field.type === "select") && field.option_columns && field.options?.length) {
      const chosen = Array.isArray(data[key]) ? data[key] as JsonValue[] : [data[key]];
      const other = (data[OTHER_KEY] as Record<string, JsonValue> | undefined)?.[key] as string | undefined;
      const grid = markGrid(ctx, field.options.map(option => ({ text: optionText(option, chosen.includes(option.value), other), on: chosen.includes(option.value), round: field.type !== "multiselect" })), w, field.option_columns, true);
      content = stack([titleBar(ctx, fieldLabel(field), w, BOX.value + 0.5), grid]);
      frame = false;
    } else {
      content = boxedContent(ctx, field, data, w - 2 * PAD);
    }
    row.push({ start, span, content, frame });
    cursor = start + span;
    if (placement.pageBreak === "after") { flush(); out.push({ height: 0, breakAfter: true, draw: () => [] }); }
  }
  flush();
  return out;
}

/** matrix: a bordered score table (row labels, a column per time point, total rows in bold after the rows they add). */
function matrixTable(ctx: Ctx, field: FieldDefinition, value: JsonValue | undefined, width: number): Block {
  const data = (value && typeof value === "object" && !Array.isArray(value) ? value : {}) as MatrixValue;
  const totals = matrixTotals(field, data);
  const cols = field.cols ?? [];
  const first = Math.min(width * 0.32, 60 * MM);
  const each = cols.length ? (width - first) / cols.length : width - first;
  const size = BOX.value;
  const pad = 0.9 * MM;
  const tableRow = (cells: string[], bold: boolean, fill: boolean): Block => {
    const blocks = cells.map((text, index) => textLines(ctx, text, size, (index === 0 ? first : each) - 2 * pad, "text", bold, index === 0 ? "left" : "center"));
    const height = Math.max(...blocks.map(block => block.height)) + 2 * pad;
    return {
      height, gapAfter: 0,
      draw: (x, y) => blocks.flatMap((block, index) => {
        const left = index === 0 ? x : x + first + (index - 1) * each;
        const w = index === 0 ? first : each;
        return [{ kind: "rect" as const, x: left, y, w, h: height, fill }, ...block.draw(left + pad, y + pad)];
      }),
    };
  };
  const text = (rowId: string, colId: string) => {
    const row = (field.rows ?? []).find(item => item.id === rowId);
    const raw = data[rowId]?.[colId];
    if (raw === null || raw === undefined) return "";
    const cell = row ? matrixCell(field, row) : {};
    return (cell as { options?: Array<{ value: string; label: string }> }).options?.find(option => option.value === raw)?.label ?? String(raw);
  };
  const rows: Block[] = [tableRow([field.label, ...cols.map(col => col.label)], true, true)];
  for (const row of field.rows ?? []) {
    rows.push(tableRow([row.label, ...cols.map(col => text(row.id, col.id))], false, false));
    for (const total of field.totals ?? []) {
      if (total.of[total.of.length - 1] === row.id) rows.push(tableRow([total.label, ...cols.map(col => { const sum = totals[total.id]?.[col.id]; return sum === null || sum === undefined ? "" : String(sum); })], true, false));
    }
  }
  return stack(rows);
}

// Timeline (Flora Leaf events, trend chart, parameter table) --------------------------------------------

const TL = { label: 38 * MM, col: 9.6 * MM, chart: 58 * MM, row: 5 * MM, size: 7 };

/** A timeline over as many pages as its columns need (about 13 columns on an A4 page, as on the anesthesia record):
 * each page has the times, the event numbers, the chart (both scales, legend in the label column) and the table.
 * An event list follows the last page. */
function timelineBlocks(ctx: Ctx, field: FieldDefinition, value: JsonValue | undefined, width: number): Block[] {
  const config = timelineConfig(field);
  const timeline: TimelineValue = asTimeline(value) ?? { step_min: config.step, axis: [], values: {} };
  const perPage = Math.max(1, Math.floor((width - TL.label - 7 * MM) / TL.col));
  const pages = Math.max(1, Math.ceil(timeline.axis.length / perPage));
  const rows = config.rows.map(row => rowInfo(row.id, row));
  const events = (timeline.events ?? []).map((event, index) => ({ ...event, n: index + 1, column: eventColumn(timeline.axis, event.ts) }));
  const blocks: Block[] = [];
  for (let page = 0; page < pages; page += 1) {
    const from = page * perPage;
    const axis = timeline.axis.slice(from, from + perPage);
    const columns = Math.max(axis.length, timeline.axis.length ? 1 : perPage);
    const gridWidth = columns * TL.col;
    const parts: Block[] = [];
    const rowBlock = (label: string, unit: string | undefined, cells: string[], fill = false, height = TL.row): Block => ({
      height, gapAfter: 0,
      draw: (x, y) => [
        { kind: "rect", x, y, w: TL.label, h: height, fill },
        { kind: "text", x: x + 1.2 * MM, y: y + height / 2 + TL.size / 2.8, size: TL.size, text: label, bold: fill },
        ...(unit ? [{ kind: "text" as const, x: x + TL.label - 1.2 * MM - ctx.measure(unit, TL.size), y: y + height / 2 + TL.size / 2.8, size: TL.size, text: unit }] : []),
        ...Array.from({ length: columns }, (_, index) => {
          const left = x + TL.label + index * TL.col;
          const text = cells[index] ?? "";
          return [{ kind: "rect" as const, x: left, y, w: TL.col, h: height, fill },
            ...(text ? [{ kind: "text" as const, x: left + (TL.col - ctx.measure(text, TL.size, fill)) / 2, y: y + height / 2 + TL.size / 2.8, size: TL.size, text, bold: fill }] : [])];
        }).flat(),
      ],
    });
    parts.push(rowBlock(page === 0 ? field.label : `${field.label} (${page + 1}/${pages})`, undefined, axis.map(timeLabel), true));
    if (config.parts.includes("events")) {
      parts.push(rowBlock("Events", undefined, axis.map((_, index) => events.filter(event => event.column === from + index).map(event => String(event.n)).join(" "))));
    }
    if (config.parts.includes("chart")) {
      const legend = config.chart.map(name => SERIES[name]);
      parts.push({
        height: TL.chart, gapAfter: 0,
        draw: (x, y) => {
          const ops: Op[] = [{ kind: "rect", x, y, w: TL.label, h: TL.chart }, { kind: "rect", x: x + TL.label, y, w: gridWidth, h: TL.chart }];
          legend.forEach((style, index) => {
            const ly = y + 3 * MM + index * 4 * MM;
            const lx = x + 2.5 * MM;
            if (style.marker === "range") {
              for (const [marker, dy] of [["down", -1.2], ["up", 1.2]] as const) {
                const path = markerPath(marker, lx, ly + dy, 2.2 * MM);
                ops.push({ kind: "path", d: path.d, color: style.color, filled: true });
              }
            } else {
              const path = markerPath(style.marker, lx, ly, 2.4 * MM);
              ops.push({ kind: "path", d: path.d, color: style.color, filled: path.filled, width: 0.8 });
            }
            ops.push({ kind: "text", x: lx + 3 * MM, y: ly + TL.size / 2.8, size: TL.size, text: style.label });
          });
          for (const shape of chartShapes({ ...timeline, axis }, config.chart, { x: x + TL.label, y: y + 2 * MM, width: gridWidth, height: TL.chart - 4 * MM, columns })) {
            if (shape.kind === "grid") ops.push({ kind: "line", x1: shape.x1, y1: shape.y1, x2: shape.x2, y2: shape.y2, width: shape.strong ? 0.4 : 0.15, color: "#cbd5e1" });
            else if (shape.kind === "label") ops.push({ kind: "text", x: shape.anchor === "end" ? shape.x - ctx.measure(shape.text, 5) - 0.5 : shape.x + 0.5, y: shape.y + 1.8, size: 5, text: shape.text, tone: "muted" });
            else if (shape.kind === "bar") ops.push({ kind: "line", x1: shape.x, y1: shape.y1, x2: shape.x, y2: shape.y2, width: 0.6, color: shape.color });
            else {
              const path = markerPath(shape.marker, shape.x, shape.y, shape.size);
              ops.push({ kind: "path", d: path.d, color: shape.color, filled: path.filled, width: 0.7 });
            }
          }
          return ops;
        },
      });
    }
    if (config.parts.includes("table")) {
      for (const row of rows) parts.push(rowBlock(row.label, row.unit, axis.map(ts => cellLabel(timeline.values[row.id]?.[String(ts)]))));
    }
    blocks.push({ ...stack(parts), breakBefore: page > 0, gapAfter: GAP });
  }
  if (config.parts.includes("events") && events.length) {
    const half = Math.ceil(events.length / 2);
    const each = width / 2;
    const lines = events.map(event => `${event.n}.  ${timeLabel(event.ts)}  ${event.title}`);
    const columnsOf = [lines.slice(0, half), lines.slice(half)].map(part => part.map(text => textLines(ctx, text, TL.size + 0.5, each - 3 * MM)));
    const heights = Array.from({ length: half }, (_, index) => Math.max(...columnsOf.map(column => column[index]?.height ?? 0)) + 1.6 * MM);
    blocks.push({
      height: heights.reduce((sum, h) => sum + h, 0),
      draw: (x, y) => {
        const ops: Op[] = [];
        let top = y;
        heights.forEach((h, index) => {
          columnsOf.forEach((column, side) => {
            ops.push({ kind: "rect", x: x + side * each, y: top, w: each, h });
            if (column[index]) ops.push(...column[index].draw(x + side * each + 1.5 * MM, top + 0.8 * MM));
          });
          top += h;
        });
        return ops;
      },
    });
  }
  return blocks;
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
  const boxed = section.print_style === "boxed";
  if (!section.hide_title) {
    out.push(boxed ? titleBar(ctx, section.title, ctx.contentWidth, isCategory ? BOX.title : BOX.section)
      : blockHeading(ctx, section.title, isCategory ? SIZE.category : depth === 1 ? SIZE.section : SIZE.category, ctx.contentWidth, !isCategory));
  }
  if (section.repeat) {
    out.push(...repeatTable(ctx, asRepeatField(section as unknown as Record<string, unknown>), Array.isArray(top[section.repeat.key]) ? top[section.repeat.key] as Array<Record<string, JsonValue>> : [], ctx.contentWidth));
  } else {
    out.push(...fieldRows(ctx, section.fields ?? [], top, inner, ctx.contentWidth, section.layout?.type ?? "grid", "", boxed));
  }
  // The last row of a boxed block keeps the normal gap below it.
  if (boxed && out.length && out[out.length - 1].gapAfter === 0) out[out.length - 1] = { ...out[out.length - 1], gapAfter: GAP };
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
  const columns = formColumns(input.definition);
  const band = (kind: "header" | "footer"): Block | null => {
    const parts = input.definition.sections.filter(section => section.repeat_on_pages === kind && shown(ctx, section))
      .flatMap(section => sectionBlocks(ctx, section, columns, 1));
    return parts.length ? stack(parts.map(part => ({ ...part, gapAfter: undefined }))) : null;
  };
  // Sections repeated on every page: the header replaces the default title, the content flows between them.
  const pageHeader = band("header");
  const pageFooter = band("footer");
  const contentTop = pageHeader ? top + pageHeader.height + GAP : top;
  const contentBottom = pageFooter ? bottom - pageFooter.height - GAP : bottom;

  const blocks: Block[] = pageHeader ? [] : [
    stack([textLines(ctx, input.definition.title, SIZE.title, contentWidth),
      textLines(ctx, [input.context.record_id ? `#${input.context.record_id}` : "", `${input.definition.form_id} v${input.definition.schema_version}`, input.context.date].filter(Boolean).join(" · "), SIZE.label, contentWidth, "muted")], 2),
  ];
  for (const section of input.definition.sections) if (!section.repeat_on_pages && shown(ctx, section)) blocks.push(...sectionBlocks(ctx, section, columns, 1));

  const pages: Op[][] = [[]];
  let y = contentTop;
  const newPage = () => { pages.push([]); y = contentTop; };
  for (const block of blocks) {
    const repeated = block.repeatHeader;
    if (block.breakBefore && y > contentTop) newPage();
    if (block.height > 0 && y + block.height > contentBottom && y > contentTop) {
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
  pages.forEach(ops => {
    if (pageHeader) ops.unshift(...pageHeader.draw(left, top));
    if (pageFooter) ops.push(...pageFooter.draw(left, bottom - pageFooter.height));
  });

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
