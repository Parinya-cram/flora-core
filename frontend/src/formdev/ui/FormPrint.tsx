/**
 * A4 print layout (Phase 1.6), separate from the screen layout: fixed sheet size in mm, margins,
 * header/footer bands, page breaks, and a paper rendering of values (options as ○/●, check boxes as
 * ☐/☑, blank lines to write on when a value is empty). On screen it shows the sheets; window.print()
 * uses the @page rules it emits (size, margins, bands with page numbers in the page margin boxes).
 */
import { useMemo, type CSSProperties, type ReactNode } from "react";
import { asRepeatField } from "../core/blocks";
import { fieldKey, OTHER_KEY, STATIC_TYPES } from "../core/validate";
import { conditionTrue, evaluateRecord } from "../logic/evaluate";
import type { LookupTables } from "../logic/lookup";
import { denied as deniedFields } from "../logic/permission";
import { containerColumns, defaultFooter, fillTemplate, formColumns, gridArea, pageCss, placeField, printContext, resolvePaper, sheetsOf, type PrintContext, type ResolvedPaper } from "../core/layout";
import type { ResolvedStyle } from "../core/styles";
import type { CategoryDefinition, ContainerLayout, FieldDefinition, FileValue, FontEntry, FormDefinition, JsonValue, PaperBand, RecordData, SectionDefinition, SignatureValue, StyleEntry } from "../core/types";
import { formStyle, gridCss, registries, rootCss, sectionCss, typeCss, type Registries } from "./formStyle";
import { cellText, optionText, printedText } from "../render/printValues";
import PrintedElement from "./PrintedElement";
import CaseBlockTable from "./CaseBlockTable";
import StaticElement from "./StaticElement";

type Props = {
  definition: FormDefinition;
  value?: RecordData;
  recordId?: string;
  /** Text for {date}; defaults to today in Thai (Buddhist era) format. */
  printedAt?: string;
  /** Who prints it (shown in the default footer). */
  printedBy?: string;
  styles?: StyleEntry[];
  fonts?: FontEntry[];
  /** The user's Flora role codes (Phase 2.8): fields they may not view are left out. Omitted = no filtering. */
  roles?: string[];
  isAdmin?: boolean;
  /** Lookup tables the form reads (Phase 2.3); derived values and cleared choices print as the server stores them. */
  lookups?: LookupTables;
};

/** hidden: data paths hidden by visibility conditions (Phase 2.2); top: the evaluated record. */
/** denied: logic-model nodes ("bmi", "meds.cost") the user may not view. */
type Ctx = { regs: Registries; hidden: Set<string>; top: Record<string, JsonValue>; denied: Set<string> };

const BLANK_LINE: CSSProperties = { borderBottom: "0.3mm dotted #64748b", minHeight: "6mm" };
const mark = (on: boolean, round: boolean) => (round ? (on ? "●" : "○") : on ? "☑" : "☐");
const columnsOf = (style: ResolvedStyle) => (typeof style.tokens.columns === "number" ? style.tokens.columns : 2);

function PrintValue({ field, value, other }: { field: FieldDefinition; value: JsonValue | undefined; other?: string }): ReactNode {
  switch (field.type) {
    case "select":
    case "radio":
      return <div style={{ display: "flex", flexWrap: "wrap", gap: "1mm 4mm" }}>{(field.options ?? []).map(option => <span key={option.value}>{mark(value === option.value, true)} {optionText(option, value === option.value, other)}</span>)}</div>;
    case "multiselect": {
      const selected = Array.isArray(value) ? value : [];
      return <div style={{ display: "flex", flexWrap: "wrap", gap: "1mm 4mm" }}>{(field.options ?? []).map(option => <span key={option.value}>{mark(selected.includes(option.value), false)} {optionText(option, selected.includes(option.value), other)}</span>)}</div>;
    }
    case "checkbox":
    case "switch":
      return <span>{mark(value === true, false)} {field.label}</span>;
    case "textarea": {
      const text = typeof value === "string" ? value : "";
      return text ? <div style={{ whiteSpace: "pre-wrap", minHeight: "12mm" }}>{text}</div> : <div>{[0, 1, 2].map(line => <div key={line} style={BLANK_LINE} />)}</div>;
    }
    case "file":
    case "image": {
      const files = Array.isArray(value) ? (value as FileValue[]) : value ? [value as FileValue] : [];
      return files.length ? <div>{files.map(file => <div key={file.ref}>📎 {file.name}</div>)}</div> : <span>{mark(false, false)} แนบเอกสาร</span>;
    }
    case "signature": {
      const signature = value as SignatureValue | undefined;
      return <div style={{ textAlign: "center" }}>
        {signature?.data ? <img alt={field.label} src={signature.data} style={{ maxHeight: "18mm" }} /> : <div style={{ height: "14mm" }} />}
        <div>(.............................................)</div>
        {signature?.signer ? <div style={{ fontSize: "8pt" }}>{signature.signer}</div> : null}
      </div>;
    }
    default: {
      const text = printedText(field, value);
      return <div style={{ ...BLANK_LINE, borderBottomStyle: text ? "solid" : "dotted" }}>{text}</div>;
    }
  }
}

function RepeatTable({ field, items, style, ctx }: { field: FieldDefinition; items: Array<Record<string, JsonValue>>; style: ResolvedStyle; ctx: Ctx }) {
  const children = (field.fields ?? []).filter(child => child.type !== "group" && child.type !== "repeat" && !ctx.denied.has(`${fieldKey(field)}.${fieldKey(child)}`));
  const rows: Array<Record<string, JsonValue>> = items.length ? items : Array.from({ length: Math.max(field.min_items ?? 0, 3) }, () => ({}));
  const cell: CSSProperties = { border: "0.3mm solid #94a3b8", padding: "1mm 1.5mm", verticalAlign: "top", height: "7mm" };
  return <table style={{ width: "100%", borderCollapse: "collapse" }}>
    <thead><tr>
      <th style={{ ...cell, ...typeCss(style, ctx.regs, "label"), width: "8mm" }}>#</th>
      {children.map(child => <th key={child.id} style={{ ...cell, ...typeCss(style, ctx.regs, "label") }}>{child.label}</th>)}
    </tr></thead>
    <tbody>{rows.map((item, index) => <tr key={index}>
      <td style={cell}>{index + 1}</td>
      {children.map(child => <td key={child.id} style={cell}>{ctx.hidden.has(`$.data.${fieldKey(field)}[${index}].${fieldKey(child)}`) ? "—" : cellText(child, item)}</td>)}
    </tr>)}</tbody>
  </table>;
}

function PrintField({ field, data, columns, style, ctx, containerType, siblings }: {
  field: FieldDefinition; data: Record<string, JsonValue>; columns: number; style: ResolvedStyle; ctx: Ctx; containerType: ContainerLayout["type"]; siblings: number;
}) {
  const placement = placeField(field, "print", columns, columnsOf(style), containerType, siblings);
  if (placement.hidden || ctx.hidden.has(`$.data.${fieldKey(field)}`) || ctx.denied.has(fieldKey(field))) return null;
  const own = ctx.regs.styles.apply(style, field.style);
  const css: CSSProperties = { ...gridArea(placement), breakInside: "avoid" };
  if (placement.pageBreak === "before") css.breakBefore = "page";
  if (placement.pageBreak === "after") css.breakAfter = "page";
  const label = <div style={{ ...typeCss(own, ctx.regs, "label"), marginBottom: "0.5mm" }}>{field.label}{field.unit && field.type !== "decimal" && field.type !== "number" ? ` (${field.unit})` : ""}</div>;
  if (field.type === "group") {
    return <div data-field={field.id} style={css}>
      {label}
      <PrintGrid fields={field.fields ?? []} data={data} columns={containerColumns({ columns: field.columns }, columns)} style={own} ctx={ctx} />
    </div>;
  }
  if (field.type === "logo" || field.type === "barcode") return <div data-field={field.id} style={css}><PrintedElement field={field} data={data} /></div>;
  if (field.type === "case_block") return <div data-field={field.id} style={css}><CaseBlockTable field={field} value={data[fieldKey(field)]} title={field.label} /></div>;
  if (STATIC_TYPES.has(field.type)) return <div data-field={field.id} style={css}><StaticElement field={field} text={field.label} css={typeCss(own, ctx.regs, "label")} /></div>;
  const value = data[fieldKey(field)];
  if (field.type === "repeat") {
    return <div data-field={fieldKey(field)} style={css}>{label}<RepeatTable field={field} items={Array.isArray(value) ? (value as Array<Record<string, JsonValue>>) : []} style={own} ctx={ctx} /></div>;
  }
  return <div data-field={fieldKey(field)} data-span={placement.span} style={{ ...css, ...typeCss(own, ctx.regs) }}>
    {field.type === "checkbox" || field.type === "switch" ? null : label}
    <PrintValue field={field} value={value} other={(data[OTHER_KEY] as Record<string, JsonValue> | undefined)?.[fieldKey(field)] as string | undefined} />
  </div>;
}

function PrintGrid({ fields, data, columns, style, ctx, containerType = "grid" }: {
  fields: FieldDefinition[]; data: Record<string, JsonValue>; columns: number; style: ResolvedStyle; ctx: Ctx; containerType?: ContainerLayout["type"];
}) {
  return <div style={gridCss(columns, style)}>
    {fields.map(field => <PrintField key={field.id} field={field} data={data} columns={columns} style={style} ctx={ctx} containerType={containerType} siblings={fields.length} />)}
  </div>;
}

const blockShown = (block: { visibility?: { when: unknown } }, ctx: Ctx) => !block.visibility || conditionTrue(block.visibility.when, key => ctx.top[key] ?? null);

/** A repeatable section or category prints as a table of its items (Phase 2.7). */
function blockGrid(block: SectionDefinition | CategoryDefinition, data: Record<string, JsonValue>, columns: number, style: ResolvedStyle, ctx: Ctx): ReactNode {
  if (block.repeat) {
    if (ctx.denied.has(block.repeat.key)) return null;
    const items = data[block.repeat.key];
    return <RepeatTable field={asRepeatField(block as unknown as Record<string, unknown>)} items={Array.isArray(items) ? (items as Array<Record<string, JsonValue>>) : []} style={style} ctx={ctx} />;
  }
  return block.fields?.length ? <PrintGrid fields={block.fields} data={data} columns={columns} style={style} ctx={ctx} containerType={block.layout?.type ?? "grid"} /> : null;
}

function PrintSection({ section, data, columns, style, ctx, depth }: { section: SectionDefinition; data: Record<string, JsonValue>; columns: number; style: ResolvedStyle; ctx: Ctx; depth: number }) {
  if (!blockShown(section, ctx)) return null;
  const own = ctx.regs.styles.apply(style, section.style);
  const inner = containerColumns(section.layout, columns);
  const css: CSSProperties = { ...sectionCss(own), display: "grid", gap: "2.5mm" };
  if (section.page_break === "avoid") css.breakInside = "avoid";
  if (depth > 1 && section.page_break === "before") css.breakBefore = "page";
  if (depth > 1 && section.page_break === "after") css.breakAfter = "page";
  return <section data-section={section.id} style={css}>
    <div style={{ ...typeCss(own, ctx.regs, "section") }}>{section.title}</div>
    {blockGrid(section, data, inner, own, ctx)}
    {(section.categories ?? []).filter(category => blockShown(category, ctx)).map(category => {
      const categoryStyle = ctx.regs.styles.apply(own, category.style);
      const css: CSSProperties = { display: "grid", gap: "1.5mm", breakInside: category.page_break === "avoid" ? "avoid" : undefined };
      if (category.page_break === "before") css.breakBefore = "page";
      return <div key={category.id} data-category={category.id} style={css}>
        <div style={{ ...typeCss(categoryStyle, ctx.regs, "label"), fontWeight: 700, borderBottom: "0.2mm solid #94a3b8" }}>{category.title}</div>
        {blockGrid(category, data, containerColumns(category.layout, inner), categoryStyle, ctx)}
      </div>;
    })}
    {(section.sections ?? []).map(child => <PrintSection key={child.id} section={child} data={data} columns={inner} style={own} ctx={ctx} depth={depth + 1} />)}
  </section>;
}

function Band({ band, edge, paper, context, style, ctx }: { band?: PaperBand; edge: "top" | "bottom"; paper: ResolvedPaper; context: PrintContext; style: ResolvedStyle; ctx: Ctx }) {
  if (!band || (band.first_page === false && context.page === 1)) return null;
  const height = edge === "top" ? paper.margin.top : paper.margin.bottom;
  const css: CSSProperties = {
    ...typeCss(style, ctx.regs, edge === "top" ? "header" : "footer"), position: "absolute", left: `${paper.margin.left}mm`, right: `${paper.margin.right}mm`,
    ...(edge === "top" ? { top: 0 } : { bottom: 0 }), height: `${height}mm`, display: "grid", gridTemplateColumns: "1fr 1fr 1fr", alignItems: edge === "top" ? "end" : "start",
    padding: edge === "top" ? "0 0 2mm" : "2mm 0 0", boxSizing: "border-box",
  };
  return <div className="fd-band" data-band={edge} style={css}>
    <span>{band.left ? fillTemplate(band.left, context) : ""}</span>
    <span style={{ textAlign: "center" }}>{band.center ? fillTemplate(band.center, context) : ""}</span>
    <span style={{ textAlign: "right" }}>{band.right ? fillTemplate(band.right, context) : ""}</span>
  </div>;
}

/** Only the sheets are printed; the rest of the app is hidden while printing. */
const PRINT_MEDIA = `@media print {
  body * { visibility: hidden !important; }
  .fd-print, .fd-print * { visibility: visible !important; }
  .fd-print { position: absolute; inset: 0 auto auto 0; transform: none !important; }
  .fd-sheet { box-shadow: none !important; margin: 0 !important; padding: 0 !important; width: auto !important; min-height: 0 !important; break-after: page; }
  .fd-sheet:last-child { break-after: auto; }
  .fd-band, .fd-sheet-label { display: none !important; }
}`;

export default function FormPrint({ definition, value = {}, recordId, printedAt, printedBy, styles, fonts, roles, isAdmin = false, lookups }: Props) {
  const regs = useMemo(() => registries(styles, fonts), [styles, fonts]);
  const style = useMemo(() => formStyle(definition, regs), [definition, regs]);
  // Print the record as the engine evaluates it: calculated values, hidden fields left out (Phase 2).
  const evaluation = useMemo(() => evaluateRecord(definition, value, "draft", undefined, lookups), [definition, value, lookups]);
  const denied = useMemo(() => (roles ? deniedFields(definition, "view", roles, isAdmin, true) : new Set<string>()), [definition, roles, isAdmin]);
  const ctx: Ctx = { regs, hidden: new Set(evaluation.hidden), top: evaluation.data, denied };
  const paper = resolvePaper(definition, style.tokens);
  const sheets = sheetsOf(definition.sections);
  const base: PrintContext = printContext(definition, evaluation.data as Record<string, unknown>, { recordId, date: printedAt, printedBy });
  const columns = formColumns(definition);
  const fontStack = regs.fonts.stack(typeof style.tokens.fontId === "string" ? style.tokens.fontId : undefined);
  const width = paper.width_mm ?? 210;
  const height = paper.height_mm ?? 297;
  return <div className="fd-print" data-paper={`${paper.size} ${paper.orientation}`}>
    <style>{`${pageCss(paper, base, fontStack)}\n${PRINT_MEDIA}`}</style>
    {sheets.map((sheet, index) => {
      const context = { ...base, page: index + 1, pages: sheets.length };
      return <div key={index} className="fd-sheet" data-sheet={index + 1}
        style={{ ...rootCss(style, regs), position: "relative", width: `${width}mm`, minHeight: `${height}mm`, boxSizing: "border-box",
          padding: `${paper.margin.top}mm ${paper.margin.right}mm ${paper.margin.bottom}mm ${paper.margin.left}mm`, margin: "0 auto 6mm", boxShadow: "0 1mm 4mm rgba(15,23,42,.25)" }}>
        <Band band={paper.header} edge="top" paper={paper} context={context} style={style} ctx={ctx} />
        <div style={{ display: "grid", gap: "4mm" }}>
          {sheet.map(section => <PrintSection key={section.id} section={section} data={evaluation.data} columns={columns} style={style} ctx={ctx} depth={1} />)}
        </div>
        <Band band={paper.footer ?? defaultFooter(base)} edge="bottom" paper={paper} context={context} style={style} ctx={ctx} />
      </div>;
    })}
  </div>;
}
