/**
 * Screen renderer for a form definition (Phase 1.5, 1.11). Layout comes from the 12-column grid and the
 * field placements for the current mode (desktop, tablet, mobile); styles come from the registry cascade
 * base -> form -> section -> field -> override. Fields hidden by visible/hidden or display.form are not
 * shown, but their values are kept. The A4 print layout is a separate renderer (FormPrint).
 */
import { useEffect, useMemo, useRef, useState, type ClipboardEvent, type CSSProperties, type KeyboardEvent, type ReactNode, type RefObject } from "react";
import { asRepeatField, repeatKey } from "../core/blocks";
import { fieldKey, OTHER_KEY, STATIC_TYPES } from "../core/validate";
import { conditionTrue, evaluateRecord } from "../logic/evaluate";
import type { LookupTables, OfferedOption } from "../logic/lookup";
import { fieldPermissions, formAllows, type FieldGrant } from "../logic/permission";
import { containerColumns, formColumns, gridArea, modeForWidth, placeField } from "../core/layout";
import type { ResolvedStyle } from "../core/styles";
import type { CategoryDefinition, ContainerLayout, FieldDefinition, FieldOption, FontEntry, FormDefinition, Issue, JsonValue, LayoutMode, RecordData, SectionDefinition, StyleEntry } from "../core/types";
import { isGridPaste, parseTsv, pasteInto } from "./gridPaste";
import { FIELD_INPUTS } from "./inputRegistry";
import { changeRecord, errorsByPath } from "./renderUtils";
import { formStyle, gridCss, inputCss, registries, rootCss, sectionCss, typeCss, type Registries } from "./formStyle";
import PrintedElement from "./PrintedElement";
import CaseBlockTable from "./CaseBlockTable";
import StaticElement from "./StaticElement";
import { blockTitle, fieldLabel, localized } from "../core/labels";

type Props = {
  definition: FormDefinition;
  value: RecordData;
  issues?: Issue[];
  readOnly?: boolean;
  /** Fixed layout mode (preview); otherwise chosen from the rendered width. */
  mode?: Exclude<LayoutMode, "print">;
  /** "detail" shows the fields display.detail allows, read-only. */
  context?: "form" | "detail";
  /** UI language; "th" shows Thai validation messages. */
  language?: string;
  styles?: StyleEntry[];
  fonts?: FontEntry[];
  /** The user's Flora role codes (Phase 2.8): fields they may not view are hidden, those they may not edit are
   * locked. Omitted (designer previews) = no permission filtering. The server enforces the same rules. */
  roles?: string[];
  isAdmin?: boolean;
  /** Lookup tables the form reads (Phase 2.3), by id. Without one, its options cannot be offered and are not checked. */
  lookups?: LookupTables;
  onChange: (next: RecordData) => void;
};

/** hidden: data paths hidden by visibility conditions; top: the evaluated record (for section conditions). */
type Ctx = {
  regs: Registries; mode: LayoutMode; readOnly: boolean; errors: Map<string, string>; context: "form" | "detail"; hidden: Set<string>; top: Record<string, JsonValue>;
  grants: Record<string, FieldGrant> | null;
  /** Options offered now for fields whose options are dynamic, by data path (Phase 2.3). */
  options: Record<string, OfferedOption[]>;
  /** UI language: labels and titles in English when the form has them (core/labels.ts). */
  language?: string;
};
/** node: the logic-model prefix of keys in this scope ("" for the form, "meds." inside a repeat's items). */
type Scope = { data: Record<string, JsonValue>; path: string; node: string; set: (key: string, value: JsonValue) => void };

const grantOf = (ctx: Ctx, node: string): FieldGrant => ctx.grants?.[node] ?? { view: true, edit: true, export: true };
/** Does any field in this list remain viewable (so its group, category or section is shown)? */
function anyViewable(fields: FieldDefinition[] | undefined, prefix: string, ctx: Ctx): boolean {
  if (!ctx.grants) return true;
  return (fields ?? []).some(field => (field.type === "group" ? anyViewable(field.fields, prefix, ctx) : grantOf(ctx, `${prefix}${fieldKey(field)}`).view));
}
function blockViewable(block: SectionDefinition | CategoryDefinition, ctx: Ctx): boolean {
  if (!ctx.grants) return true;
  if (block.repeat) return grantOf(ctx, repeatKey(block as unknown as Record<string, unknown>) ?? "").view;
  const section = block as SectionDefinition;
  return anyViewable(block.fields, "", ctx) || (section.categories ?? []).some(category => blockViewable(category, ctx))
    || (section.sections ?? []).some(child => blockViewable(child, ctx));
}

const STYLE_COLUMNS_DEFAULT = 2;
const styleColumns = (style: ResolvedStyle) => (typeof style.tokens.columns === "number" ? style.tokens.columns : STYLE_COLUMNS_DEFAULT);

/** Cells of a boxed section (print_style: boxed) touch and carry a border, like the paper form. */
const BOXED_CELL: CSSProperties = { border: "0.3mm solid #94a3b8", padding: "1.2mm 1.8mm", marginRight: "-0.3mm", marginBottom: "-0.3mm" };

function FieldBlock({ field, scope, columns, style, ctx, containerType, siblings, boxed = false }: {
  field: FieldDefinition; scope: Scope; columns: number; style: ResolvedStyle; ctx: Ctx; containerType: ContainerLayout["type"]; siblings: number; boxed?: boolean;
}) {
  const placement = placeField(field, ctx.mode, columns, styleColumns(style), containerType, siblings, ctx.context);
  const dataPath = scope.path ? `${scope.path}.${fieldKey(field)}` : fieldKey(field);
  if (placement.hidden || ctx.hidden.has(`$.data.${dataPath}`)) return null;
  const key = fieldKey(field);
  const grant = grantOf(ctx, `${scope.node}${key}`);
  if (field.type === "group" ? !anyViewable(field.fields, scope.node, ctx) : !grant.view) return null;
  const own = ctx.regs.styles.apply(style, field.style);
  const text = fieldLabel(field, ctx.language);
  const label = field.unit ? `${text} (${field.unit})` : text;
  const required = field.required === true || field.validation?.required === true;
  const disabled = ctx.readOnly || field.readonly === true || field.type === "calculated" || field.derive !== undefined || !grant.edit;
  const path = scope.path ? `${scope.path}.${key}` : key;
  const error = ctx.errors.get(path);
  const labelEl = <span style={{ ...typeCss(own, ctx.regs, "label"), display: "block", marginBottom: "1mm" }}>
    {text}{field.unit ? ` (${field.unit})` : ""}{required ? <span style={{ color: "#e11d48" }}> *</span> : null}
  </span>;
  let body: ReactNode;
  if (field.type === "group") {
    const inner = containerColumns({ columns: field.columns }, columns);
    body = <fieldset style={{ border: "0.3mm solid #e2e8f0", borderRadius: "1.5mm", padding: "2mm", margin: 0 }}>
      <legend style={typeCss(own, ctx.regs, "label")}>{text}</legend>
      <FieldGrid fields={field.fields ?? []} scope={scope} columns={inner} style={own} ctx={ctx} />
    </fieldset>;
  } else if (field.type === "logo" || field.type === "barcode") {
    body = <PrintedElement field={field} data={scope.data} />;
  } else if (field.type === "case_block") {
    body = <CaseBlockTable field={field} value={scope.data[key]} language={ctx.language} title={text} />;
  } else if (STATIC_TYPES.has(field.type)) {
    body = <StaticElement field={field} text={text} css={typeCss(own, ctx.regs, "label")} />;
  } else if (field.type === "repeat") {
    body = <><span style={{ ...typeCss(own, ctx.regs, "label"), display: "block", marginBottom: "1mm" }}>{text}</span>
      {field.view === "table" && tableColumnsOk(field)
        ? <RepeatTable field={field} scope={scope} style={own} ctx={ctx} />
        : <RepeatItems field={field} scope={scope} columns={containerColumns({ columns: field.columns }, columns)} style={own} ctx={ctx} />}</>;
  } else {
    const Input = FIELD_INPUTS[field.type];
    const shown = localized(offeredField(field, ctx.options[`$.data.${dataPath}`], scope.data[key]), ctx.language);
    body = <label style={{ display: "block" }}>
      {labelEl}
      {Input ? <Input field={shown} value={scope.data[key]} disabled={disabled} css={inputCss(own, ctx.regs)} label={label} onChange={next => scope.set(key, next)} /> : null}
      <OtherText field={shown} scope={scope} disabled={disabled} css={inputCss(own, ctx.regs)} />
      {field.description ? <span style={{ display: "block", fontSize: "8pt", color: "#64748b", marginTop: "0.5mm" }}>{field.description}</span> : null}
    </label>;
  }
  return <div data-field={key} data-span={placement.span} style={boxed ? { ...gridArea(placement), ...BOXED_CELL } : gridArea(placement)}>
    {body}
    {error ? <span role="alert" style={{ display: "block", marginTop: "0.5mm", fontSize: "8.5pt", color: "#e11d48" }}>{error}</span> : null}
  </div>;
}

/** The field with the options offered now (Phase 2.3). A lookup field whose table is not loaded offers only its
 * current value, so it still shows. */
function offeredField(field: FieldDefinition, offered: OfferedOption[] | undefined, value: JsonValue | undefined): FieldDefinition {
  if (offered) return { ...field, options: offered as FieldOption[] };
  if (field.lookup === undefined) return field;
  const current = (Array.isArray(value) ? value : [value]).filter((entry): entry is string => typeof entry === "string" && entry !== "");
  return { ...field, options: current.map(entry => ({ value: entry, label: entry })) };
}

/** Answer + Other (Phase 2.6): a text box under the field while an option with has_input is chosen. */
function OtherText({ field, scope, disabled, css }: { field: FieldDefinition; scope: Scope; disabled: boolean; css: CSSProperties }) {
  const key = fieldKey(field);
  const value = scope.data[key];
  const chosen = (Array.isArray(value) ? value : [value]).filter(entry => (field.options ?? []).some(option => option.has_input && option.value === entry));
  if (!chosen.length) return null;
  const other = (scope.data[OTHER_KEY] ?? {}) as Record<string, JsonValue>;
  const labels = (field.options ?? []).filter(option => chosen.includes(option.value)).map(option => option.label).join(", ");
  return <input aria-label={`${field.label}: ${labels}`} placeholder={labels} style={{ ...css, marginTop: "1mm" }} disabled={disabled} value={typeof other[key] === "string" ? other[key] as string : ""}
    onChange={event => scope.set(OTHER_KEY, { ...other, [key]: event.target.value } as JsonValue)} />;
}

function FieldGrid({ fields, scope, columns, style, ctx, containerType = "grid", boxed = false }: {
  fields: FieldDefinition[]; scope: Scope; columns: number; style: ResolvedStyle; ctx: Ctx; containerType?: ContainerLayout["type"]; boxed?: boolean;
}) {
  return <div style={boxed ? { ...gridCss(columns, style), gap: 0, paddingRight: "0.3mm", paddingBottom: "0.3mm" } : gridCss(columns, style)}>
    {fields.map(field => <FieldBlock key={field.id} field={field} scope={scope} columns={columns} style={style} ctx={ctx} containerType={containerType} siblings={fields.length} boxed={boxed} />)}
  </div>;
}

function RepeatItems({ field, scope, columns, style, ctx }: { field: FieldDefinition; scope: Scope; columns: number; style: ResolvedStyle; ctx: Ctx }) {
  const key = fieldKey(field);
  const items = Array.isArray(scope.data[key]) ? (scope.data[key] as Array<Record<string, JsonValue>>) : [];
  const write = (next: Array<Record<string, JsonValue>>) => scope.set(key, next.length ? next : null);
  const move = (from: number, to: number) => {
    const next = [...items];
    const [item] = next.splice(from, 1);
    next.splice(to, 0, item);
    write(next);
  };
  const editable = !ctx.readOnly && field.readonly !== true && grantOf(ctx, `${scope.node}${key}`).edit;
  const full = field.max_items !== undefined && items.length >= field.max_items;
  const button: CSSProperties = { fontSize: "9pt", padding: "0.5mm 2mm", border: "0.3mm solid #cbd5e1", borderRadius: "1mm", background: "#ffffff", cursor: "pointer" };
  return <div style={{ display: "grid", gap: "2mm" }} data-repeat={key}>
    {items.map((item, index) => {
      const itemScope: Scope = {
        data: item, path: `${scope.path ? `${scope.path}.` : ""}${key}[${index}]`, node: `${scope.node}${key}.`,
        set: (childKey, value) => write(items.map((current, i) => (i === index ? withValue(current, childKey, value) : current))),
      };
      return <div key={index} data-item={index} style={{ border: "0.3mm solid #e2e8f0", borderRadius: "1.5mm", padding: "2mm", background: "#f8fafc" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "1.5mm", fontSize: "8.5pt", color: "#475569" }}>
          <span>#{index + 1}</span>
          {editable ? <span style={{ display: "flex", gap: "1mm" }}>
            <button type="button" style={button} aria-label={`Move item ${index + 1} up`} disabled={index === 0} onClick={() => move(index, index - 1)}>↑</button>
            <button type="button" style={button} aria-label={`Move item ${index + 1} down`} disabled={index === items.length - 1} onClick={() => move(index, index + 1)}>↓</button>
            <button type="button" style={button} aria-label={`Remove item ${index + 1}`} onClick={() => write(items.filter((_, i) => i !== index))}>Remove</button>
          </span> : null}
        </div>
        <FieldGrid fields={field.fields ?? []} scope={itemScope} columns={columns} style={style} ctx={ctx} />
      </div>;
    })}
    {editable ? <button type="button" style={{ ...button, justifySelf: "start" }} disabled={full} onClick={() => write([...items, {}])}>+ Add {field.label}</button> : null}
  </div>;
}

/** A table needs one cell per child field: children that are themselves groups or repeats fall back to cards. */
const tableColumnsOk = (field: FieldDefinition) => (field.fields ?? []).every(child => child.type !== "group" && child.type !== "repeat");

/** view: "table" — a spreadsheet-like grid: one row per item, one column per child field. Tab moves across,
 * Enter moves down (adding a row at the end), and cells copied from Excel paste into several rows at once. */
function RepeatTable({ field, scope, style, ctx }: { field: FieldDefinition; scope: Scope; style: ResolvedStyle; ctx: Ctx }) {
  const key = fieldKey(field);
  const tableRef = useRef<HTMLTableElement>(null);
  const items = Array.isArray(scope.data[key]) ? (scope.data[key] as Array<Record<string, JsonValue>>) : [];
  const write = (next: Array<Record<string, JsonValue>>) => scope.set(key, next.length ? next : null);
  const node = `${scope.node}${key}.`;
  const base = `${scope.path ? `${scope.path}.` : ""}${key}`;
  const columns = (field.fields ?? []).filter(child => grantOf(ctx, `${node}${fieldKey(child)}`).view && child.display?.form !== false);
  const editable = !ctx.readOnly && field.readonly !== true && grantOf(ctx, `${scope.node}${key}`).edit;
  const cellEditable = (child: FieldDefinition) => editable && child.readonly !== true && child.type !== "calculated" && child.derive === undefined
    && grantOf(ctx, `${node}${fieldKey(child)}`).edit;
  const full = field.max_items !== undefined && items.length >= field.max_items;
  const focusCell = (row: number, column: number) => requestAnimationFrame(() => {
    tableRef.current?.querySelector<HTMLElement>(`[data-cell="${row}:${column}"] input, [data-cell="${row}:${column}"] select, [data-cell="${row}:${column}"] textarea`)?.focus();
  });
  const onKeyDown = (event: KeyboardEvent, row: number, column: number) => {
    if (event.key !== "Enter" || event.shiftKey || (event.target as HTMLElement).tagName === "TEXTAREA") return;
    event.preventDefault();
    if (row + 1 >= items.length) {
      if (!editable || full) return;
      write([...items, {}]);
    }
    focusCell(row + 1, column);
  };
  const onPaste = (event: ClipboardEvent, row: number, column: number) => {
    const text = event.clipboardData.getData("text/plain");
    if (!editable || !isGridPaste(text)) return;
    event.preventDefault();
    write(pasteInto(items, parseTsv(text), row, column, columns, cellEditable, field.max_items));
  };
  const cell: CSSProperties = { border: "0.3mm solid #e2e8f0", padding: "0.8mm", verticalAlign: "top", minWidth: "28mm" };
  const head: CSSProperties = { ...cell, background: "#f1f5f9", ...typeCss(style, ctx.regs, "label"), textAlign: "left", whiteSpace: "nowrap" };
  const button: CSSProperties = { fontSize: "9pt", padding: "0.3mm 1.5mm", border: "0.3mm solid #cbd5e1", borderRadius: "1mm", background: "#ffffff", cursor: "pointer" };
  const compact: CSSProperties = { ...inputCss(style, ctx.regs), minHeight: 0, width: "100%", boxSizing: "border-box" };
  const rowErrors = (index: number) => [...ctx.errors.entries()].filter(([path]) => path === `${base}[${index}]`).map(([, message]) => message);
  return <div data-repeat={key} data-view="table" style={{ display: "grid", gap: "1.5mm" }}>
    <div style={{ overflowX: "auto" }}>
      <table ref={tableRef} style={{ borderCollapse: "collapse", width: "100%", fontSize: "9.5pt" }}>
        <thead><tr>
          <th style={{ ...head, minWidth: "8mm", width: "8mm" }}>#</th>
          {columns.map(child => <th key={child.id} style={head}>{child.label}{child.unit ? ` (${child.unit})` : ""}{child.required || child.validation?.required ? <span style={{ color: "#e11d48" }}> *</span> : null}</th>)}
          {editable ? <th style={{ ...head, minWidth: "20mm", width: "20mm" }} /> : null}
        </tr></thead>
        <tbody>
          {items.map((item, index) => {
            const set = (childKey: string, value: JsonValue) => write(items.map((current, i) => (i === index ? withValue(current, childKey, value) : current)));
            const itemScope: Scope = { data: item, path: `${base}[${index}]`, node, set };
            const messages = rowErrors(index);
            return <tr key={index} data-item={index}>
              <td style={{ ...cell, minWidth: "8mm", color: "#64748b", textAlign: "right" }} title={messages.join("\n") || undefined}>{index + 1}{messages.length ? <span style={{ color: "#e11d48" }}> !</span> : null}</td>
              {columns.map((child, column) => {
                const childKey = fieldKey(child);
                const dataPath = `${base}[${index}].${childKey}`;
                const hidden = ctx.hidden.has(`$.data.${dataPath}`);
                const Input = FIELD_INPUTS[child.type];
                const shown = offeredField(child, ctx.options[`$.data.${dataPath}`], item[childKey]);
                const error = ctx.errors.get(dataPath);
                return <td key={child.id} data-cell={`${index}:${column}`} style={{ ...cell, background: hidden ? "#f8fafc" : error ? "#fff1f2" : undefined }}
                  onKeyDown={event => onKeyDown(event, index, column)} onPaste={event => onPaste(event, index, column)}>
                  {hidden || !Input ? null : <>
                    <Input field={shown} value={item[childKey]} disabled={!cellEditable(child)} css={compact} label={`${child.label} #${index + 1}`} onChange={next => set(childKey, next)} />
                    <OtherText field={shown} scope={itemScope} disabled={!cellEditable(child)} css={compact} />
                    {error ? <span role="alert" style={{ display: "block", fontSize: "8pt", color: "#e11d48" }}>{error}</span> : null}
                  </>}
                </td>;
              })}
              {editable ? <td style={{ ...cell, whiteSpace: "nowrap", minWidth: "20mm" }}>
                <button type="button" style={button} aria-label={`Move row ${index + 1} up`} disabled={index === 0} onClick={() => write(items.map((current, i) => (i === index - 1 ? items[index] : i === index ? items[index - 1] : current)))}>↑</button>
                <button type="button" style={button} aria-label={`Move row ${index + 1} down`} disabled={index === items.length - 1} onClick={() => write(items.map((current, i) => (i === index + 1 ? items[index] : i === index ? items[index + 1] : current)))}>↓</button>
                <button type="button" style={button} aria-label={`Remove row ${index + 1}`} onClick={() => write(items.filter((_, i) => i !== index))}>✕</button>
              </td> : null}
            </tr>;
          })}
          {!items.length ? <tr><td colSpan={columns.length + (editable ? 2 : 1)} style={{ ...cell, color: "#94a3b8", textAlign: "center" }}>—</td></tr> : null}
        </tbody>
      </table>
    </div>
    {editable ? <span style={{ display: "flex", gap: "2mm", alignItems: "center", fontSize: "8pt", color: "#64748b" }}>
      <button type="button" style={{ ...button, padding: "0.5mm 2mm" }} disabled={full} onClick={() => { write([...items, {}]); focusCell(items.length, 0); }}>+ Add row</button>
      Tab → next cell · Enter → next row · paste cells copied from Excel
    </span> : null}
  </div>;
}

function withValue(data: Record<string, JsonValue>, key: string, value: JsonValue): Record<string, JsonValue> {
  const next = { ...data };
  if (value === null || value === undefined) delete next[key];
  else next[key] = value;
  return next;
}

/** A block hidden by its own visibility condition renders nothing (its fields' values are kept). */
const blockShown = (block: { visibility?: { when: unknown } }, ctx: Ctx) => !block.visibility || conditionTrue(block.visibility.when, key => ctx.top[key] ?? null);

/** Fields of a section or category; a repeatable block (Phase 2.7) renders as a list of items. */
function BlockFields({ block, scope, columns, style, ctx }: { block: SectionDefinition | CategoryDefinition; scope: Scope; columns: number; style: ResolvedStyle; ctx: Ctx }) {
  if (block.repeat) return <RepeatItems field={asRepeatField(block as unknown as Record<string, unknown>)} scope={scope} columns={columns} style={style} ctx={ctx} />;
  return block.fields?.length ? <FieldGrid fields={block.fields} scope={scope} columns={columns} style={style} ctx={ctx} containerType={block.layout?.type ?? "grid"} boxed={block.print_style === "boxed"} /> : null;
}

function SectionBlock({ section, scope, columns, style, ctx, depth }: { section: SectionDefinition; scope: Scope; columns: number; style: ResolvedStyle; ctx: Ctx; depth: number }) {
  if (!blockShown(section, ctx) || !blockViewable(section, ctx)) return null;
  const own = ctx.regs.styles.apply(style, section.style);
  const inner = containerColumns(section.layout, columns);
  const Heading = depth === 1 ? "h3" : "h4";
  return <section data-section={section.id} style={{ ...sectionCss(own), display: "grid", gap: "3mm" }}>
    {section.hide_title ? null : <Heading style={{ ...typeCss(own, ctx.regs, "section"), margin: 0 }}>{blockTitle(section, ctx.language)}</Heading>}
    {section.description ? <p style={{ margin: 0, fontSize: "9pt", color: "#64748b" }}>{section.description}</p> : null}
    <BlockFields block={section} scope={scope} columns={inner} style={own} ctx={ctx} />
    {(section.categories ?? []).map(category => <CategoryBlock key={category.id} category={category} scope={scope} columns={inner} style={own} ctx={ctx} />)}
    {(section.sections ?? []).map(child => <SectionBlock key={child.id} section={child} scope={scope} columns={inner} style={own} ctx={ctx} depth={depth + 1} />)}
  </section>;
}

/** A named sub-group of a section (Phase 2.0): a titled block on the section's grid. */
function CategoryBlock({ category, scope, columns, style, ctx }: { category: CategoryDefinition; scope: Scope; columns: number; style: ResolvedStyle; ctx: Ctx }) {
  if (!blockShown(category, ctx) || !blockViewable(category, ctx)) return null;
  const own = ctx.regs.styles.apply(style, category.style);
  return <div data-category={category.id} style={{ display: "grid", gap: "2mm", borderLeft: "0.6mm solid #cbd5e1", paddingLeft: "3mm" }}>
    {category.hide_title ? null : <div style={{ ...typeCss(own, ctx.regs, "label"), fontWeight: 700 }}>{blockTitle(category, ctx.language)}</div>}
    {category.description ? <p style={{ margin: 0, fontSize: "9pt", color: "#64748b" }}>{category.description}</p> : null}
    <BlockFields block={category} scope={scope} columns={containerColumns(category.layout, columns)} style={own} ctx={ctx} />
  </div>;
}

/** Sections repeated on every printed page come first (header) and last (footer) on screen too. */
const pageOrder = (sections: SectionDefinition[]) => [
  ...sections.filter(section => section.repeat_on_pages === "header"),
  ...sections.filter(section => !section.repeat_on_pages),
  ...sections.filter(section => section.repeat_on_pages === "footer"),
];

/** Width-driven mode for the live form; fixed in previews. */
function useMode(fixed: Props["mode"]): [RefObject<HTMLDivElement | null>, Exclude<LayoutMode, "print">] {
  const ref = useRef<HTMLDivElement | null>(null);
  const [mode, setMode] = useState<Exclude<LayoutMode, "print">>(fixed ?? "desktop");
  useEffect(() => {
    if (fixed || !ref.current || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(entries => setMode(modeForWidth(entries[0].contentRect.width)));
    observer.observe(ref.current);
    return () => observer.disconnect();
  }, [fixed]);
  return [ref, fixed ?? mode];
}

export default function FormRenderer({ definition, value, issues = [], readOnly = false, mode, context = "form", language = "en", styles, fonts, roles, isAdmin = false, lookups, onChange }: Props) {
  const regs = useMemo(() => registries(styles, fonts), [styles, fonts]);
  const style = useMemo(() => formStyle(definition, regs), [definition, regs]);
  const [ref, current] = useMode(mode);
  // Phase 2 logic on every change: calculated values, visibility, Other text (the same engine the server runs).
  const evaluation = useMemo(() => evaluateRecord(definition, value, "draft", undefined, lookups), [definition, value, lookups]);
  const data = evaluation.data;
  const grants = useMemo(() => (roles ? fieldPermissions(definition, roles, isAdmin) : null), [definition, roles, isAdmin]);
  const ctx: Ctx = {
    regs, mode: current, readOnly: readOnly || context === "detail", errors: errorsByPath(issues, language), context, hidden: new Set(evaluation.hidden), top: data, grants,
    options: evaluation.options, language,
  };
  if (roles && !formAllows(definition, "view", roles, isAdmin)) {
    return <div role="alert" style={{ padding: "4mm", color: "#b91c1c" }}>{language === "th" ? "คุณไม่มีสิทธิ์ดูแบบฟอร์มนี้" : "You may not view this form."}</div>;
  }
  const scope: Scope = { data, path: "", node: "", set: (key, next) => onChange(changeRecord(definition, data, key, next, lookups)) };
  const columns = formColumns(definition);
  return <div ref={ref} data-mode={current} style={{ ...rootCss(style, regs), display: "grid", gap: "4mm", padding: "4mm", borderRadius: "3mm" }}>
    {pageOrder(definition.sections).map(section => <SectionBlock key={section.id} section={section} scope={scope} columns={columns} style={style} ctx={ctx} depth={1} />)}
  </div>;
}
