/**
 * Definition, record and index rules. Twin of services/flora-api/app/formdev/definition.py;
 * both are run against formdev/spec/fixtures so offline validation matches the server.
 * Format reference: formdev/spec/FORM-SCHEMA.md.
 */
import { HOSPITAL_LOGO } from "./hospital";
import { allowedProps, allProps, FIELD_TYPE_SPECS, fieldTypeSpec, hasValue, INDEX_FAMILY, INDEXABLE_TYPES, STYLE_COMPONENTS, STYLE_TOKENS, valueKind, type TokenSpec, type ValueKind } from "./fieldTypes";
import { sectionFieldLists } from "./blocks";
import { CASE_BLOCK_IDS, CASE_BLOCK_LIMITS, caseBlockSpec } from "./caseBlocks";
import { RECORD_FIELDS } from "../leaf/recordFields";

/** Fields of the Leaf anesthesia record a form field can share (bind "record.<field>", leaf/record.ts). */
const RECORD_BINDS = new Set(RECORD_FIELDS.map(field => field.bind));
import { check as checkFormula } from "../logic/formula";
import { build as buildModel, cycles as logicCycles } from "../logic/model";
import { MESSAGES } from "./messages";
import type { FieldDefinition, FormDefinition, IndexEntry, Issue, MatrixCell, PaperBand, RecordStatus } from "./types";

export { INDEXABLE_TYPES };
export const FORMAT = "flora.form/1";
/** Offset for datetimes written without one (Asia/Bangkok); index values are epoch ms. */
export const DEFAULT_TZ_OFFSET_MINUTES = 420;
export const SUBJECT_FIELD_KEY = "flora.subject_field";
const SUBJECT_FIELD_TYPES = ["text", "select", "radio", "integer"];
export const PAPERS = ["A4", "A5", "Letter", "screen"];
const REPEAT_VIEWS = ["cards", "table"];
/** Sheet size in mm, portrait. "screen" has no page. */
export const PAPER_SIZES_MM: Readonly<Record<string, [number, number]>> = { A4: [210, 297], A5: [148, 210], Letter: [215.9, 279.4] };
const ORIENTATIONS = ["portrait", "landscape"];
export const PAGE_BREAKS = ["before", "after", "avoid"];
export const LAYOUT_MODES = ["desktop", "tablet", "mobile", "print"] as const;
const SECTION_LAYOUTS = ["grid", "row", "column"];
export const DISPLAY_CONTEXTS = ["form", "table", "detail", "query", "export"] as const;
export const CONDITION_OPERATORS = ["equals", "not_equals", "gt", "gte", "lt", "lte", "in", "not_in", "exists", "empty"];
const VALUELESS_OPERATORS = ["exists", "empty"];
const LIST_OPERATORS = ["in", "not_in"];
const FORM_ACTIONS = ["view", "create", "edit", "delete", "export"];
const SECTION_ACTIONS = ["view", "edit"];
const FIELD_ACTIONS = ["view", "edit", "export"];
// Header / footer tokens: the form and page, and the patient and print (hn, an, patient, dob from the record's fields).
export const TEMPLATE_TOKENS = ["title", "form_id", "version", "page", "pages", "date", "record_id", "hn", "an", "patient", "dob", "printed_at", "printed_by", "hospital"];
const CALCULATOR_OUTPUTS = ["number", "integer", "decimal", "text", "boolean"];
export const RECORD_STATUSES: RecordStatus[] = ["draft", "submitted", "deleted"];
export const MAX_INDEXED_FIELDS = 16;
const MAX_NESTING = 4;
const MAX_CONDITION_DEPTH = 8;
export const DEFAULT_COLUMNS = 12;
const DEFAULT_SIGNATURE_KB = 256;
export const RETIRED_KEY = "_retired";
/** Answer + Other (Phase 2.6): free text of "other" options, {field key: text}, at the top and in each repeat item. */
export const OTHER_KEY = "_other";
const MAX_OTHER_TEXT = 1000;
export { sectionFieldLists };

const FORM_ID = /^[a-z][a-z0-9_]{1,63}$/;
const ITEM_ID = /^[a-z][a-z0-9_]{0,63}$/;
const REGISTRY_ID = /^[a-z][a-z0-9_.-]{1,63}$/;
const ROLE = /^[a-z][a-z0-9_.-]{0,63}$/;
const MIME = /^[a-z]+\/(\*|[a-z0-9.+-]+)$/;
const COLOR = /^(#[0-9a-fA-F]{3}|#[0-9a-fA-F]{6}|transparent)$/;
const TEMPLATE_TOKEN = /\{([a-z_]+)\}/g;
const RELATIVE_DATE = /^today([+-]\d{1,5}d)?$/;
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DATETIME = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,6}))?)?(Z|[+-]\d{2}:\d{2})?$/;
const TIME = /^(\d{2}):(\d{2})(?::(\d{2}))?$/;
const SIGNATURE_DATA = /^data:image\/(png|svg\+xml);base64,[A-Za-z0-9+/=]+$/;

const DEFINITION_KEYS = new Set(["format", "form_id", "schema_version", "title", "description", "paper", "style_id", "style", "font_id", "offline", "metadata",
  "layout", "calculators", "rules", "permission", "sections", "migration", "extensions"]);
const SECTION_KEYS = new Set(["id", "title", "title_en", "description", "fields", "categories", "sections", "layout", "style", "visibility", "permission", "page_break", "repeat",
  "print_style", "hide_title", "repeat_on_pages"]);
const CATEGORY_KEYS = new Set(["id", "title", "title_en", "description", "fields", "layout", "style", "visibility", "permission", "page_break", "repeat", "print_style", "hide_title"]);
// Paper layout (Template phase): bordered cells with "Label: value", and top-level sections drawn on every page.
const PRINT_STYLES = ["plain", "boxed"];
const PAGE_BANDS = ["header", "footer"];
const MATRIX_CELL_TYPES = ["integer", "number", "text", "select"];
const MATRIX_NUMERIC = ["integer", "number"];
const MAX_MATRIX_ITEMS = 60;
// timeline (Form Studio): Flora Leaf's events row, trend chart and parameter table over time.
export const TIMELINE_PARTS = ["events", "chart", "table"] as const;
export const TIMELINE_SERIES = ["hr", "pr", "spo2", "nibp", "art", "cvp", "temperature", "et_co2", "bis"] as const;
const TIMELINE_SOURCES = ["leaf", "manual"];
const TIMELINE_ROW_ID = /^[a-z][a-z0-9_]{0,63}$/;
const MAX_TIMELINE_COLUMNS = 1500;
const MAX_TIMELINE_ROWS = 80;
const MAX_TIMELINE_EVENTS = 300;
const PAPER_KEYS = new Set(["size", "orientation", "margin_mm", "header", "footer", "density"]);
/** Print density: compact = denser type and rows; fit_page = the largest size that fits one page (never below the
 * compact minimum; what still does not fit continues on the next pages). */
export const DENSITIES = ["normal", "compact", "fit_page"] as const;
/** logo / barcode: printed elements. The picture lives in the definition (offline, PDF without fetching); Interleaved
 * 2 of 5 is Flora Leaf's HN barcode (digits only), Code 128 / Code 39 take letters too (e.g. AN "67-00123"). */
/** bind: the case datum (Flora Leaf) a field shows, as domain.name (patient.hn, case.asa, anesthesia.start). */
export const BIND = /^[a-z][a-z0-9_]*(\.[a-z0-9_]+)+$/;
export const LOGO_SRC = /^data:image\/(png|jpeg);base64,[A-Za-z0-9+/=]+$/;
export const MAX_LOGO_CHARS = 400_000;
export const LOGO_HEIGHT_MM = [4, 60] as const;
export const BARCODE_HEIGHT_MM = [5, 30] as const;
export const ALIGNS = ["left", "center", "right"] as const;
export const SYMBOLOGIES = ["i2of5", "code128", "code39"] as const;
/** Printed time columns per page (the print step widens to fit them, as on the paper anesthesia record). */
export const TIMELINE_PRINT_COLUMNS = [8, 48] as const;
const BAND_KEYS = new Set(["left", "center", "right", "height_mm", "first_page"]);
const MARGIN_KEYS = ["top", "right", "bottom", "left"];
const CALCULATOR_KEYS = new Set(["id", "name", "description", "formula", "output"]);
const FIELD_LAYOUT_KEYS = new Set(["col", "row", "span", "row_span", "responsive", "page_break"]);
/** A field may cover several grid rows (row_span), up to this many. */
export const MAX_ROW_SPAN = 50;
export const MAX_PARAGRAPH = 4000;
/** Static elements: no value, shown on screen and on paper. */
export const STATIC_TYPES = new Set(["heading", "paragraph", "divider"]);
const RESPONSIVE_KEYS = new Set(["col", "span", "hidden"]);
const RULE_KEYS = new Set(["required", "min", "max", "min_length", "max_length", "pattern", "email", "numeric", "min_date", "max_date", "message", "rules"]);
const RULES_BY_VALUE: Record<string, Set<string>> = {
  text: new Set(["required", "min_length", "max_length", "pattern", "email", "numeric", "message"]),
  number: new Set(["required", "min", "max", "message"]), integer: new Set(["required", "min", "max", "message"]), decimal: new Set(["required", "min", "max", "message"]),
  date: new Set(["required", "min_date", "max_date", "message"]), datetime: new Set(["required", "min_date", "max_date", "message"]),
};
const CALCULATED_RULES = new Set(["min", "max", "message", "rules"]);
/** Flat field properties that are also validation rules (flora.form/1 before Phase 1). */
const FLAT_RULES = ["required", "min", "max", "max_length"];
const RANGE_RULES: Array<[string, string]> = [["min", "max"], ["min_length", "max_length"], ["min_date", "max_date"]];
const MIGRATION_OPS: Record<string, Set<string>> = {
  rename_field: new Set(["op", "from", "to"]),
  add_field: new Set(["op", "field", "default"]),
  remove_field: new Set(["op", "field"]),
  map_values: new Set(["op", "field", "mapping"]),
  convert_type: new Set(["op", "field", "to"]),
};
const CONVERT_TARGETS = ["text", "number", "integer", "boolean"];

type Obj = Record<string, unknown>;
const isObject = (value: unknown): value is Obj => typeof value === "object" && value !== null && !Array.isArray(value);
const isInt = (value: unknown): value is number => typeof value === "number" && Number.isInteger(value);
const isNumber = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const isText = (value: unknown): value is string => typeof value === "string";
const isScalar = (value: unknown) => isText(value) || typeof value === "boolean" || isNumber(value);
/** Length in code points, like Python len(), so Thai and emoji count the same in both runtimes. */
const textLength = (value: string) => [...value].length;
const issue = (path: string, code: string, message: string): Issue => ({ path, code, message });

function unknownKeys(value: Obj, allowed: Set<string>, path: string): Issue[] {
  return Object.keys(value).filter(key => !allowed.has(key)).sort().map(key => issue(`${path}.${key}`, "unknown_property", `Unknown property '${key}'`));
}

// Traversal. Sections (nestable) hold fields; group fields hold fields in the same data scope;
// repeat fields hold fields in a per-item scope. Record data is keyed by field key. ----------------

/** Data and formula name of a field; defaults to its id (definitions before Phase 1 had no key). */
export const fieldKey = (field: FieldDefinition | Obj): string => ("key" in field ? (field.key as string) : (field.id as string));

export function iterSections(definition: FormDefinition): FormDefinition["sections"] {
  const out: FormDefinition["sections"] = [];
  const walk = (sections: unknown) => {
    for (const section of Array.isArray(sections) ? sections : []) {
      if (!isObject(section)) continue;
      out.push(section as FormDefinition["sections"][number]);
      walk(section.sections);
    }
  };
  walk(definition.sections);
  return out;
}

/** Fields whose values live in one data scope: group children are flattened in, repeat children are not. */
export function scopeFields(fieldList: unknown): FieldDefinition[] {
  const out: FieldDefinition[] = [];
  for (const field of Array.isArray(fieldList) ? fieldList : []) {
    if (!isObject(field)) continue;
    if (field.type === "group") out.push(...scopeFields(field.fields));
    else out.push(field as FieldDefinition);
  }
  return out;
}

/** Fields stored at the top level of record data (repeat fields included, their items not). */
export function fields(definition: FormDefinition): FieldDefinition[] {
  return iterSections(definition).flatMap(section => sectionFieldLists(section).flatMap(scopeFields));
}

/** Top-level fields by data key. */
export function fieldMap(definition: FormDefinition): Map<string, FieldDefinition> {
  return new Map(fields(definition).filter(field => isText(fieldKey(field))).map(field => [fieldKey(field), field]));
}

/** Fields of one repeat item by data key. */
export function itemMap(repeat: FieldDefinition): Map<string, FieldDefinition> {
  return new Map(scopeFields(repeat.fields).filter(field => isText(fieldKey(field))).map(field => [fieldKey(field), field]));
}

/** Rules from the flat properties and the validation object (definitions where both disagree are rejected). */
export function effectiveRules(field: FieldDefinition | Obj): Obj {
  const rules: Obj = {};
  for (const name of FLAT_RULES) if (name in field) rules[name] = (field as Obj)[name];
  if (isObject((field as Obj).validation)) Object.assign(rules, (field as Obj).validation);
  return rules;
}

export function isVisible(field: FieldDefinition): boolean {
  if ("visible" in field) return field.visible !== false;
  return field.hidden !== true;
}

/** Display policy (Phase 1.4): form follows the field's visibility, every other context defaults to shown. */
export function displayed(field: FieldDefinition, context: (typeof DISPLAY_CONTEXTS)[number]): boolean {
  const display = isObject(field.display) ? (field.display as Obj) : {};
  if (context in display) return display[context] === true;
  return context === "form" ? isVisible(field) : true;
}

export type PaperSpec = {
  size: string; orientation: string; width_mm: number | null; height_mm: number | null;
  margin_mm: Partial<Record<"top" | "right" | "bottom" | "left", number>>;
  header?: PaperBand;
  footer?: PaperBand;
  density: (typeof DENSITIES)[number];
};

/** Normalised paper: size, orientation, sheet size and bands. */
export function paperSpec(definition: Pick<FormDefinition, "paper">): PaperSpec {
  const paper = definition.paper as unknown;
  const spec: Obj = isText(paper) ? { size: paper } : isObject(paper) ? { ...paper } : { size: "A4" };
  const size = (spec.size as string) ?? "A4";
  const orientation = (spec.orientation as string) ?? "portrait";
  let [width, height]: Array<number | null> = PAPER_SIZES_MM[size] ?? [null, null];
  if (width !== null && orientation === "landscape") [width, height] = [height, width];
  return { size, orientation, width_mm: width, height_mm: height, margin_mm: (spec.margin_mm as PaperSpec["margin_mm"]) ?? {},
    header: spec.header as PaperBand | undefined, footer: spec.footer as PaperBand | undefined,
    density: (DENSITIES as readonly unknown[]).includes(spec.density) ? spec.density as PaperSpec["density"] : "normal" };
}

export function styleRef(definition: FormDefinition): string | undefined {
  if (isObject(definition.style) && isText(definition.style.id)) return definition.style.id;
  return isText(definition.style_id) ? definition.style_id : undefined;
}

// Definition validation (Phase 1.10) ------------------------------------------------------------

class Scope {
  readonly keys = new Set<string>();
  readonly repeats = new Map<string, Scope>();
  readonly parent: Scope | null;
  constructor(parent: Scope | null = null) {
    this.parent = parent;
  }

  /** A key visible from this scope (item first, then outwards); "meds.dose" names a repeat column. */
  resolves(key: string): boolean {
    const dot = key.indexOf(".");
    if (dot >= 0) {
      const child = this.repeats.get(key.slice(0, dot));
      if (child && child.keys.has(key.slice(dot + 1))) return true;
    } else if (this.keys.has(key)) return true;
    return this.parent?.resolves(key) ?? false;
  }

  /** A key of this scope or of any repeat inside it (calculators may be used in any scope). */
  anywhere(key: string): boolean {
    return this.resolves(key) || [...this.repeats.values()].some(child => child.anywhere(key));
  }
}

class Ctx {
  readonly issues: Issue[] = [];
  readonly sectionIds = new Set<string>();
  readonly categoryIds = new Set<string>();
  readonly fieldIds = new Set<string>();
  readonly calculators = new Set<string>();
  readonly refs: Array<[string, string, Scope]> = [];
  readonly formulas: Array<[string, string, Scope | null]> = [];
  readonly ruleIds = new Set<string>();
  indexed = 0;
  readonly styleIds: Set<string> | null;
  readonly fontIds: Set<string> | null;
  constructor(styleIds: Set<string> | null, fontIds: Set<string> | null) {
    this.styleIds = styleIds;
    this.fontIds = fontIds;
  }

  add(path: string, code: string, message: string) {
    this.issues.push(issue(path, code, message));
  }

  unknown(value: Obj, allowed: Set<string>, path: string) {
    this.issues.push(...unknownKeys(value, allowed, path));
  }
}

export function validateDefinition(definition: unknown, styleIds?: Iterable<string>, fontIds?: Iterable<string>): Issue[] {
  if (!isObject(definition)) return [issue("$", "not_object", "Form definition must be a JSON object")];
  const ctx = new Ctx(styleIds ? new Set(styleIds) : null, fontIds ? new Set(fontIds) : null);
  ctx.unknown(definition, DEFINITION_KEYS, "$");
  if (definition.format !== FORMAT) ctx.add("$.format", "invalid_format", `format must be '${FORMAT}'`);
  if (!isText(definition.form_id) || !FORM_ID.test(definition.form_id)) ctx.add("$.form_id", "invalid_form_id", "form_id must be lower snake case, 2-64 characters");
  const version = definition.schema_version;
  if (!isInt(version) || version < 1) ctx.add("$.schema_version", "invalid_schema_version", "schema_version must be a positive integer");
  const title = definition.title;
  if (!isText(title) || !title.trim() || textLength(title) > 200) ctx.add("$.title", "invalid_title", "title is required (max 200 characters)");
  checkText(ctx, definition, "description", "$", 2000);
  validatePaper(ctx, definition.paper);
  validateFormStyle(ctx, definition);
  if ("font_id" in definition) checkFont(ctx, definition.font_id, "$.font_id");
  if ("offline" in definition && typeof definition.offline !== "boolean") ctx.add("$.offline", "invalid_type", "offline must be a boolean");
  for (const name of ["extensions", "metadata"]) {
    if (name in definition && !isObject(definition[name])) ctx.add(`$.${name}`, "invalid_type", `${name} must be an object`);
  }
  let columns = DEFAULT_COLUMNS;
  if ("layout" in definition) columns = validateContainerLayout(ctx, definition.layout, "$.layout", DEFAULT_COLUMNS, ["grid"]);
  validateCalculators(ctx, definition);
  if ("permission" in definition) validatePermission(ctx, definition.permission, "$.permission", FORM_ACTIONS);

  let sections = definition.sections;
  if (!Array.isArray(sections) || sections.length === 0) {
    ctx.add("$.sections", "no_sections", "At least one section is required");
    sections = [];
  }
  const top = new Scope();
  (sections as unknown[]).forEach((section, sIndex) => validateSection(ctx, section, `$.sections[${sIndex}]`, top, columns, 1));
  if (ctx.indexed > MAX_INDEXED_FIELDS) ctx.add("$.sections", "too_many_indexed", `At most ${MAX_INDEXED_FIELDS} fields may be indexed`);
  validateRulesBlock(ctx, definition, top);
  for (const [path, key, scope] of ctx.refs) {
    if (!scope.resolves(key)) ctx.add(path, "unknown_field_reference", `'${key}' is not a field key of this form`);
  }
  if (checkFormulas(ctx, top)) {
    const model = buildModel(definition);
    const paths = new Map(model.fields.map(item => [item.node, item.path]));
    for (const cycle of logicCycles(model)) ctx.add(paths.get(cycle[0]) ?? "$.sections", "circular_dependency", `Circular dependency: ${[...cycle, cycle[0]].join(" → ")}`);
  }
  ctx.issues.push(...validateMigration(definition, top.keys));
  ctx.issues.push(...validateExtensions(definition as FormDefinition));
  return ctx.issues;
}

/** Parse every formula and resolve its keys (Phase 2.4). Returns false when any formula is broken. */
function checkFormulas(ctx: Ctx, top: Scope): boolean {
  let ok = true;
  for (const [path, text, scope] of ctx.formulas) {
    const known = scope ? (key: string) => scope.resolves(key) : (key: string) => top.anywhere(key);
    for (const problem of checkFormula(text, known)) {
      ok = false;
      ctx.add(path, problem.code, `${problem.message} (column ${problem.position})`);
    }
  }
  return ok;
}

/** Form-level rules: [{id, assert, message, fields}] checked across several fields (Phase 2.1). */
function validateRulesBlock(ctx: Ctx, definition: Obj, top: Scope) {
  if (!("rules" in definition)) return;
  const rules = definition.rules;
  if (!Array.isArray(rules)) {
    ctx.add("$.rules", "invalid_rule", "rules must be an array");
    return;
  }
  rules.forEach((rule: unknown, index) => {
    const path = `$.rules[${index}]`;
    if (!isObject(rule)) {
      ctx.add(path, "invalid_rule", "A rule must be an object");
      return;
    }
    ctx.unknown(rule, new Set(["id", "assert", "message", "fields", "when"]), path);
    const ruleId = rule.id;
    if (!isText(ruleId) || !ITEM_ID.test(ruleId) || ctx.ruleIds.has(ruleId)) ctx.add(`${path}.id`, "invalid_rule", "Rule id must be lower snake case and unique");
    else ctx.ruleIds.add(ruleId);
    const targets = rule.fields;
    if (!Array.isArray(targets) || targets.length === 0 || !targets.every(isText)) ctx.add(`${path}.fields`, "invalid_rule", "fields lists the keys the message belongs to");
    else {
      targets.forEach((key: string, tIndex) => {
        if (!top.resolves(key) || key.includes(".")) ctx.add(`${path}.fields[${tIndex}]`, "unknown_field_reference", `'${key}' is not a field key of this form`);
      });
    }
    checkRuleBody(ctx, rule, path, top);
  });
}

function checkRuleBody(ctx: Ctx, rule: Obj, path: string, scope: Scope) {
  if (!isText(rule.assert) || !rule.assert.trim()) ctx.add(`${path}.assert`, "invalid_rule", "assert is a formula that must be true");
  else ctx.formulas.push([`${path}.assert`, rule.assert, scope]);
  if (!isText(rule.message) || !(textLength(rule.message) > 0 && textLength(rule.message) <= 200)) ctx.add(`${path}.message`, "invalid_rule", "message is required (max 200 characters)");
  if ("when" in rule) validateCondition(ctx, rule.when, `${path}.when`, scope, 1);
}

/** Custom rules of one field: [{assert, message, when?}] (Phase 2.1). */
function validateFieldRules(ctx: Ctx, rules: unknown, path: string, scope: Scope) {
  if (!Array.isArray(rules) || rules.length === 0) {
    ctx.add(path, "invalid_rule", "rules must be a non-empty array");
    return;
  }
  rules.forEach((rule: unknown, index) => {
    const rulePath = `${path}[${index}]`;
    if (!isObject(rule)) {
      ctx.add(rulePath, "invalid_rule", "A rule must be an object");
      return;
    }
    ctx.unknown(rule, new Set(["assert", "message", "when"]), rulePath);
    checkRuleBody(ctx, rule, rulePath, scope);
  });
}

function checkText(ctx: Ctx, owner: Obj, name: string, path: string, limit: number) {
  if (name in owner && (!isText(owner[name]) || textLength(owner[name] as string) > limit)) ctx.add(`${path}.${name}`, "invalid_type", `${name} must be text (max ${limit} characters)`);
}

function checkFont(ctx: Ctx, fontId: unknown, path: string) {
  if (!isText(fontId) || !REGISTRY_ID.test(fontId)) ctx.add(path, "invalid_font_id", "font_id must be a registry id");
  else if (ctx.fontIds && !ctx.fontIds.has(fontId)) ctx.add(path, "unknown_font", `Font '${fontId}' is not in the font registry`);
}

function checkStyleId(ctx: Ctx, styleId: unknown, path: string) {
  if (!isText(styleId) || !REGISTRY_ID.test(styleId)) ctx.add(path, "invalid_style_id", "style id must be a registry id");
  else if (ctx.styleIds && !ctx.styleIds.has(styleId)) ctx.add(path, "unknown_style", `Style '${styleId}' is not in the style registry`);
}

function validatePaper(ctx: Ctx, paper: unknown) {
  if (!isObject(paper)) {
    if (!PAPERS.includes(paper as string)) ctx.add("$.paper", "invalid_paper", `paper must be one of ${PAPERS.join(", ")}`);
    return;
  }
  ctx.unknown(paper, PAPER_KEYS, "$.paper");
  if (!PAPERS.includes(paper.size as string)) ctx.add("$.paper.size", "invalid_paper", `paper.size must be one of ${PAPERS.join(", ")}`);
  if ("orientation" in paper && !ORIENTATIONS.includes(paper.orientation as string)) ctx.add("$.paper.orientation", "invalid_paper", "orientation must be portrait or landscape");
  if ("margin_mm" in paper) {
    const margin = paper.margin_mm;
    if (!isObject(margin) || Object.keys(margin).some(key => !MARGIN_KEYS.includes(key)) || !Object.values(margin).every(v => isNumber(v) && v >= 0 && v <= 60)) {
      ctx.add("$.paper.margin_mm", "invalid_margin", "margin_mm takes top, right, bottom and left in mm (0-60)");
    }
  }
  if ("density" in paper && !(DENSITIES as readonly unknown[]).includes(paper.density)) ctx.add("$.paper.density", "invalid_paper", `density must be one of ${DENSITIES.join(", ")}`);
  for (const band of ["header", "footer"]) if (band in paper) validateBand(ctx, paper[band], `$.paper.${band}`);
}

function validateBand(ctx: Ctx, band: unknown, path: string) {
  if (!isObject(band)) {
    ctx.add(path, "invalid_band", "header and footer must be objects");
    return;
  }
  ctx.unknown(band, BAND_KEYS, path);
  for (const slot of ["left", "center", "right"]) {
    if (!(slot in band)) continue;
    const text = band[slot];
    if (!isText(text) || textLength(text) > 200) {
      ctx.add(`${path}.${slot}`, "invalid_band", `${slot} must be text (max 200 characters)`);
      continue;
    }
    for (const match of text.matchAll(TEMPLATE_TOKEN)) {
      if (!TEMPLATE_TOKENS.includes(match[1])) ctx.add(`${path}.${slot}`, "unknown_template_token", `Unknown token '{${match[1]}}'`);
    }
  }
  if ("height_mm" in band && !(isNumber(band.height_mm) && band.height_mm >= 0 && band.height_mm <= 40)) ctx.add(`${path}.height_mm`, "invalid_band", "height_mm must be 0-40");
  if ("first_page" in band && typeof band.first_page !== "boolean") ctx.add(`${path}.first_page`, "invalid_band", "first_page must be a boolean");
}

function validateFormStyle(ctx: Ctx, definition: Obj) {
  const style = definition.style;
  if ("style" in definition) validateStyleRef(ctx, style, "$.style");
  const nested = isObject(style) ? style.id : undefined;
  if ("style_id" in definition) {
    checkStyleId(ctx, definition.style_id, "$.style_id");
    if (nested !== undefined && nested !== definition.style_id) ctx.add("$.style.id", "style_mismatch", "style.id and style_id name different styles");
  } else if (nested === undefined) {
    ctx.add("$.style_id", "invalid_style_id", "style_id (or style.id) is required");
  }
}

function validateStyleRef(ctx: Ctx, style: unknown, path: string) {
  if (!isObject(style)) {
    ctx.add(path, "invalid_type", "style must be an object {id, override}");
    return;
  }
  ctx.unknown(style, new Set(["id", "override"]), path);
  if ("id" in style) checkStyleId(ctx, style.id, `${path}.id`);
  if ("override" in style) validateTokens(ctx, style.override, `${path}.override`, true);
}

function validateTokens(ctx: Ctx, tokens: unknown, path: string, allowComponents: boolean) {
  if (!isObject(tokens)) {
    ctx.add(path, "invalid_type", "style tokens must be an object");
    return;
  }
  for (const [name, value] of Object.entries(tokens)) {
    const tokenPath = `${path}.${name}`;
    if (allowComponents && (STYLE_COMPONENTS as readonly string[]).includes(name)) {
      validateTokens(ctx, value, tokenPath, false);
      continue;
    }
    const spec = Object.hasOwn(STYLE_TOKENS, name) ? (STYLE_TOKENS as Record<string, TokenSpec>)[name] : undefined;
    if (!spec) ctx.add(tokenPath, "unknown_style_token", `Unknown style token '${name}'`);
    else if (spec.type === "font") checkFont(ctx, value, tokenPath);
    else if (!tokenValueOk(spec, value)) ctx.add(tokenPath, "invalid_style_token", `Invalid value for style token '${name}'`);
  }
}

export function tokenValueOk(spec: TokenSpec, value: unknown): boolean {
  if (spec.type === "color") return isText(value) && COLOR.test(value);
  if (spec.type === "enum") return (spec.values ?? []).includes(value as string);
  if (spec.type === "boolean") return typeof value === "boolean";
  if (spec.type === "font") return isText(value) && REGISTRY_ID.test(value);
  if (spec.type === "integer" && !isInt(value)) return false;
  return isNumber(value) && value >= (spec.min ?? -Infinity) && value <= (spec.max ?? Infinity);
}

function validateContainerLayout(ctx: Ctx, layout: unknown, path: string, inherited: number, types: string[]): number {
  if (!isObject(layout)) {
    ctx.add(path, "invalid_layout", "layout must be an object");
    return inherited;
  }
  ctx.unknown(layout, new Set(["type", "columns", "gap_mm"]), path);
  if ("type" in layout && !types.includes(layout.type as string)) ctx.add(`${path}.type`, "invalid_layout", `layout.type must be one of ${types.join(", ")}`);
  let columns = inherited;
  if ("columns" in layout) {
    if (isInt(layout.columns) && layout.columns >= 1 && layout.columns <= 24) columns = layout.columns;
    else ctx.add(`${path}.columns`, "invalid_columns", "columns must be an integer 1-24");
  }
  if ("gap_mm" in layout && !(isNumber(layout.gap_mm) && layout.gap_mm >= 0 && layout.gap_mm <= 20)) ctx.add(`${path}.gap_mm`, "invalid_layout", "gap_mm must be 0-20");
  return columns;
}

function validateCalculators(ctx: Ctx, definition: Obj) {
  if (!("calculators" in definition)) return;
  const calculators = definition.calculators;
  if (!Array.isArray(calculators)) {
    ctx.add("$.calculators", "invalid_type", "calculators must be an array");
    return;
  }
  calculators.forEach((calculator: unknown, index) => {
    const path = `$.calculators[${index}]`;
    if (!isObject(calculator)) {
      ctx.add(path, "not_object", "Calculator must be an object");
      return;
    }
    ctx.unknown(calculator, CALCULATOR_KEYS, path);
    const id = calculator.id;
    if (!isText(id) || !ITEM_ID.test(id)) ctx.add(`${path}.id`, "invalid_calculator_id", "Calculator id must be lower snake case");
    else if (ctx.calculators.has(id)) ctx.add(`${path}.id`, "duplicate_calculator_id", `Duplicate calculator id '${id}'`);
    else ctx.calculators.add(id);
    const formula = calculator.formula;
    if (!isText(formula) || !formula.trim() || textLength(formula) > 2000) ctx.add(`${path}.formula`, "invalid_formula", "formula is required (max 2000 characters)");
    else ctx.formulas.push([`${path}.formula`, formula, null]);
    checkText(ctx, calculator, "name", path, 200);
    checkText(ctx, calculator, "description", path, 2000);
    if ("output" in calculator && !outputOk(calculator.output)) ctx.add(`${path}.output`, "invalid_type", `output takes type (${CALCULATOR_OUTPUTS.join(", ")}), decimals 0-10 and unit`);
  });
}

function outputOk(output: unknown): boolean {
  return isObject(output) && Object.keys(output).every(key => ["type", "decimals", "unit"].includes(key))
    && CALCULATOR_OUTPUTS.includes((output.type ?? "number") as string)
    && (!("decimals" in output) || (isInt(output.decimals) && output.decimals >= 0 && output.decimals <= 10))
    && (!("unit" in output) || (isText(output.unit) && textLength(output.unit) <= 40));
}

function validatePermission(ctx: Ctx, permission: unknown, path: string, actions: string[]) {
  if (!isObject(permission)) {
    ctx.add(path, "invalid_permission", "permission must be an object of action -> roles");
    return;
  }
  ctx.unknown(permission, new Set(actions), path);
  for (const [action, roles] of Object.entries(permission)) {
    if (!actions.includes(action)) continue;
    if (!Array.isArray(roles) || roles.length === 0) {
      ctx.add(`${path}.${action}`, "invalid_permission", `${action} must be a non-empty list of role codes`);
      continue;
    }
    roles.forEach((role: unknown, rIndex) => {
      if (!isText(role) || !ROLE.test(role)) ctx.add(`${path}.${action}[${rIndex}]`, "invalid_role", "Role codes are lower case letters, digits, '_', '.', '-'");
    });
  }
}

function validateVisibility(ctx: Ctx, visibility: unknown, path: string, scope: Scope) {
  if (!isObject(visibility) || !("when" in visibility)) {
    ctx.add(path, "invalid_condition", "visibility must be {\"when\": condition}");
    return;
  }
  ctx.unknown(visibility, new Set(["when"]), path);
  validateCondition(ctx, visibility.when, `${path}.when`, scope, 1);
}

function validateCondition(ctx: Ctx, condition: unknown, path: string, scope: Scope, depth: number) {
  if (depth > MAX_CONDITION_DEPTH) {
    ctx.add(path, "invalid_condition", `Conditions may nest at most ${MAX_CONDITION_DEPTH} levels`);
    return;
  }
  if (!isObject(condition)) {
    ctx.add(path, "invalid_condition", "A condition must be an object");
    return;
  }
  const groups = ["and", "or"].filter(name => name in condition);
  if (groups.length) {
    if (Object.keys(condition).length !== 1) {
      ctx.add(path, "invalid_condition", "and / or must be the only key of their condition");
      return;
    }
    const parts = condition[groups[0]];
    if (!Array.isArray(parts) || parts.length === 0) {
      ctx.add(`${path}.${groups[0]}`, "invalid_condition", `${groups[0]} needs a non-empty list of conditions`);
      return;
    }
    parts.forEach((part: unknown, index) => validateCondition(ctx, part, `${path}.${groups[0]}[${index}]`, scope, depth + 1));
    return;
  }
  ctx.unknown(condition, new Set(["field", "operator", "value"]), path);
  const key = condition.field;
  if (!isText(key) || !ITEM_ID.test(key)) ctx.add(`${path}.field`, "invalid_condition", "field must name a field key");
  else ctx.refs.push([`${path}.field`, key, scope]);
  const operator = condition.operator;
  if (!CONDITION_OPERATORS.includes(operator as string)) {
    ctx.add(`${path}.operator`, "invalid_operator", `operator must be one of ${CONDITION_OPERATORS.join(", ")}`);
    return;
  }
  if (VALUELESS_OPERATORS.includes(operator as string)) {
    if ("value" in condition) ctx.add(`${path}.value`, "invalid_condition", `${String(operator)} takes no value`);
  } else if (LIST_OPERATORS.includes(operator as string)) {
    const value = condition.value;
    if (!Array.isArray(value) || value.length === 0 || value.length > 100 || !value.every(isScalar)) ctx.add(`${path}.value`, "invalid_condition", `${String(operator)} needs a list of 1-100 values`);
  } else if (!isScalar(condition.value)) {
    ctx.add(`${path}.value`, "invalid_condition", `${String(operator)} needs a text, number or boolean value`);
  }
}

function validateDisplay(ctx: Ctx, field: Obj, path: string) {
  const display = field.display;
  if (!isObject(display)) {
    ctx.add(`${path}.display`, "invalid_type", "display must be an object");
    return;
  }
  ctx.unknown(display, new Set(DISPLAY_CONTEXTS), `${path}.display`);
  for (const [context, flag] of Object.entries(display)) {
    if ((DISPLAY_CONTEXTS as readonly string[]).includes(context) && typeof flag !== "boolean") ctx.add(`${path}.display.${context}`, "invalid_type", `display.${context} must be a boolean`);
  }
  if (typeof display.form === "boolean" && ("visible" in field || "hidden" in field) && display.form !== isVisible(field as FieldDefinition)) {
    ctx.add(`${path}.display.form`, "conflicting_visibility", "display.form disagrees with visible/hidden");
  }
}

/** An explicit placement: row, col, span and row_span (rows covered). */
type Cell = [number, number, number, number];

function validateFieldLayout(ctx: Ctx, layout: unknown, path: string, columns: number): Cell | null {
  if (!isObject(layout)) {
    ctx.add(path, "invalid_layout", "layout must be an object");
    return null;
  }
  ctx.unknown(layout, FIELD_LAYOUT_KEYS, path);
  checkPlacement(ctx, layout, path, columns);
  if ("row" in layout && !(isInt(layout.row) && layout.row >= 1 && layout.row <= 500)) ctx.add(`${path}.row`, "invalid_layout", "row must be an integer 1-500");
  if ("row_span" in layout && !(isInt(layout.row_span) && layout.row_span >= 1 && layout.row_span <= MAX_ROW_SPAN)) {
    ctx.add(`${path}.row_span`, "invalid_layout", `row_span must be an integer 1-${MAX_ROW_SPAN}`);
  }
  if ("page_break" in layout && !PAGE_BREAKS.includes(layout.page_break as string)) ctx.add(`${path}.page_break`, "invalid_page_break", `page_break must be one of ${PAGE_BREAKS.join(", ")}`);
  if ("responsive" in layout) {
    const responsive = layout.responsive;
    if (!isObject(responsive)) {
      ctx.add(`${path}.responsive`, "invalid_layout", "responsive must be an object keyed by desktop, tablet, mobile, print");
    } else {
      ctx.unknown(responsive, new Set(LAYOUT_MODES), `${path}.responsive`);
      for (const [mode, rule] of Object.entries(responsive)) {
        if (!(LAYOUT_MODES as readonly string[]).includes(mode)) continue;
        if (!isObject(rule)) {
          ctx.add(`${path}.responsive.${mode}`, "invalid_layout", "a responsive rule must be an object");
          continue;
        }
        ctx.unknown(rule, RESPONSIVE_KEYS, `${path}.responsive.${mode}`);
        checkPlacement(ctx, rule, `${path}.responsive.${mode}`, columns);
        if ("hidden" in rule && typeof rule.hidden !== "boolean") ctx.add(`${path}.responsive.${mode}.hidden`, "invalid_type", "hidden must be a boolean");
      }
    }
  }
  const cell = [layout.row, layout.col, layout.span];
  if (!cell.every(isInt)) return null;
  return [...cell, isInt(layout.row_span) ? layout.row_span : 1] as Cell;
}

function checkPlacement(ctx: Ctx, rule: Obj, path: string, columns: number) {
  const span = rule.span;
  const col = rule.col;
  const spanOk = !("span" in rule) || (isInt(span) && span >= 1 && span <= columns);
  const colOk = !("col" in rule) || (isInt(col) && col >= 1 && col <= columns);
  if (!spanOk) ctx.add(`${path}.span`, "invalid_span", `span must be an integer 1-${columns}`);
  if (!colOk) ctx.add(`${path}.col`, "invalid_layout", `col must be an integer 1-${columns}`);
  if (spanOk && colOk && isInt(span) && isInt(col) && col + span - 1 > columns) ctx.add(path, "layout_out_of_bounds", `col ${col} + span ${span} goes past column ${columns}`);
}

function checkOverlaps(ctx: Ctx, cells: Array<[string, Cell]>) {
  const taken = new Set<string>();
  for (const [path, [row, col, span, rows]] of cells) {
    const wanted = Array.from({ length: rows }, (_, down) => Array.from({ length: span }, (_, offset) => `${row + down}:${col + offset}`)).flat();
    const clash = wanted.find(cell => taken.has(cell));
    if (clash) ctx.add(`${path}.layout`, "layout_overlap", `Overlaps another field at row ${clash.split(":")[0]}, column ${clash.split(":")[1]}`);
    wanted.forEach(cell => taken.add(cell));
  }
}

function validateRules(ctx: Ctx, field: Obj, path: string, kind: ValueKind | null, scope: Scope) {
  const rules = field.validation;
  if (!isObject(rules)) {
    ctx.add(`${path}.validation`, "invalid_rule", "validation must be an object");
    return;
  }
  ctx.unknown(rules, RULE_KEYS, `${path}.validation`);
  const supported = field.type === "calculated" ? CALCULATED_RULES : new Set([...(RULES_BY_VALUE[kind ?? ""] ?? ["required", "message"]), "rules"]);
  for (const [name, value] of Object.entries(rules)) {
    const rulePath = `${path}.validation.${name}`;
    if (!RULE_KEYS.has(name)) continue;
    if (!supported.has(name)) {
      ctx.add(rulePath, "rule_not_supported", `'${name}' does not apply to ${String(field.type)} fields`);
      continue;
    }
    if (name === "rules") {
      validateFieldRules(ctx, value, rulePath, scope);
      continue;
    }
    if (!ruleValueOk(name, value)) ctx.add(rulePath, "invalid_rule", `Invalid value for rule '${name}'`);
    else if (name === "pattern" && !compiles(value as string)) ctx.add(rulePath, "invalid_pattern", "pattern is not a valid regular expression");
    if (FLAT_RULES.includes(name) && name in field && field[name] !== value) ctx.add(rulePath, "conflicting_rule", `'${name}' is set differently on the field and in validation`);
  }
  const merged = effectiveRules(field);
  for (const [low, high] of RANGE_RULES) {
    if (!(low in rules) && !(high in rules)) continue;
    const a = merged[low];
    const b = merged[high];
    const numbers = isNumber(a) && isNumber(b);
    const dates = isText(a) && isText(b) && validDateText(a) && validDateText(b);
    if ((numbers || dates) && (a as number | string) > (b as number | string)) ctx.add(`${path}.validation`, "invalid_range", `${low} must not be greater than ${high}`);
  }
}

function compiles(pattern: string): boolean {
  try {
    new RegExp(pattern);
    return true;
  } catch {
    return false;
  }
}

function ruleValueOk(name: string, value: unknown): boolean {
  if (name === "required" || name === "email" || name === "numeric") return typeof value === "boolean";
  if (name === "min" || name === "max") return isNumber(value);
  if (name === "min_length") return isInt(value) && value >= 0;
  if (name === "max_length") return isInt(value) && value >= 1;
  if (name === "message") return isText(value) && textLength(value) > 0 && textLength(value) <= 200;
  if (name === "pattern") return isText(value) && textLength(value) > 0 && textLength(value) <= 500;
  return isText(value) && (validDateText(value) || RELATIVE_DATE.test(value));
}

function validateSection(ctx: Ctx, section: unknown, path: string, scope: Scope, columns: number, depth: number) {
  if (!isObject(section)) {
    ctx.add(path, "not_object", "Section must be an object");
    return;
  }
  ctx.unknown(section, SECTION_KEYS, path);
  const sectionId = section.id;
  if (!isText(sectionId) || !ITEM_ID.test(sectionId)) ctx.add(`${path}.id`, "invalid_section_id", "Section id must be lower snake case");
  else if (ctx.sectionIds.has(sectionId)) ctx.add(`${path}.id`, "duplicate_section_id", `Duplicate section id '${sectionId}'`);
  else ctx.sectionIds.add(sectionId);
  if (!isText(section.title) || !section.title.trim()) ctx.add(`${path}.title`, "invalid_title", "Section title is required");
  checkText(ctx, section, "description", path, 2000);
  checkText(ctx, section, "title_en", path, 200);
  if ("layout" in section) columns = validateContainerLayout(ctx, section.layout, `${path}.layout`, columns, SECTION_LAYOUTS);
  if ("style" in section) validateStyleRef(ctx, section.style, `${path}.style`);
  if ("visibility" in section) validateVisibility(ctx, section.visibility, `${path}.visibility`, scope);
  if ("permission" in section) validatePermission(ctx, section.permission, `${path}.permission`, SECTION_ACTIONS);
  if ("page_break" in section && !PAGE_BREAKS.includes(section.page_break as string)) ctx.add(`${path}.page_break`, "invalid_page_break", `page_break must be one of ${PAGE_BREAKS.join(", ")}`);
  validatePaperKeys(ctx, section, path);
  if ("repeat_on_pages" in section) {
    if (!PAGE_BANDS.includes(section.repeat_on_pages as string)) ctx.add(`${path}.repeat_on_pages`, "invalid_layout", "repeat_on_pages is header or footer");
    else if (depth > 1) ctx.add(`${path}.repeat_on_pages`, "invalid_layout", "Only top-level sections repeat on every page");
  }
  let children: unknown[] = [];
  if ("sections" in section) {
    if (!Array.isArray(section.sections)) ctx.add(`${path}.sections`, "invalid_type", "sections must be an array");
    else if (section.sections.length && depth >= MAX_NESTING) ctx.add(`${path}.sections`, "too_deep", `Sections may nest at most ${MAX_NESTING} levels`);
    else children = section.sections;
  }
  let categories: unknown[] = [];
  if ("categories" in section) {
    if (Array.isArray(section.categories)) categories = section.categories;
    else ctx.add(`${path}.categories`, "invalid_type", "categories must be an array");
  }
  let sectionFields = section.fields;
  if (!Array.isArray(sectionFields)) {
    if ("fields" in section || (children.length === 0 && categories.length === 0)) ctx.add(`${path}.fields`, "invalid_type", "fields must be an array");
    sectionFields = [];
  }
  if ("repeat" in section) {
    if (children.length || categories.length) ctx.add(`${path}.repeat`, "invalid_repeat", "A repeatable section holds fields only (no categories or sections)");
    validateRepeatBlock(ctx, section, path, sectionFields as unknown[], scope, columns);
  } else validateFieldList(ctx, sectionFields as unknown[], `${path}.fields`, scope, columns, false, 1);
  categories.forEach((category, index) => validateCategory(ctx, category, `${path}.categories[${index}]`, scope, columns));
  children.forEach((child, index) => validateSection(ctx, child, `${path}.sections[${index}]`, scope, columns, depth + 1));
}

/** A named sub-group of a section (Phase 2.0); its fields share the section's data scope. */
function validateCategory(ctx: Ctx, category: unknown, path: string, scope: Scope, columns: number) {
  if (!isObject(category)) {
    ctx.add(path, "not_object", "Category must be an object");
    return;
  }
  ctx.unknown(category, CATEGORY_KEYS, path);
  const categoryId = category.id;
  if (!isText(categoryId) || !ITEM_ID.test(categoryId)) ctx.add(`${path}.id`, "invalid_category_id", "Category id must be lower snake case");
  else if (ctx.categoryIds.has(categoryId)) ctx.add(`${path}.id`, "duplicate_category_id", `Duplicate category id '${categoryId}'`);
  else ctx.categoryIds.add(categoryId);
  if (!isText(category.title) || !category.title.trim()) ctx.add(`${path}.title`, "invalid_title", "Category title is required");
  checkText(ctx, category, "description", path, 2000);
  checkText(ctx, category, "title_en", path, 200);
  if ("layout" in category) columns = validateContainerLayout(ctx, category.layout, `${path}.layout`, columns, SECTION_LAYOUTS);
  if ("style" in category) validateStyleRef(ctx, category.style, `${path}.style`);
  if ("visibility" in category) validateVisibility(ctx, category.visibility, `${path}.visibility`, scope);
  if ("permission" in category) validatePermission(ctx, category.permission, `${path}.permission`, SECTION_ACTIONS);
  validatePaperKeys(ctx, category, path);
  if ("page_break" in category && !PAGE_BREAKS.includes(category.page_break as string)) ctx.add(`${path}.page_break`, "invalid_page_break", `page_break must be one of ${PAGE_BREAKS.join(", ")}`);
  const categoryFields = category.fields;
  if (!Array.isArray(categoryFields) || categoryFields.length === 0) {
    ctx.add(`${path}.fields`, "container_requires_fields", "A category needs at least one field");
    return;
  }
  if ("repeat" in category) validateRepeatBlock(ctx, category, path, categoryFields, scope, columns);
  else validateFieldList(ctx, categoryFields, `${path}.fields`, scope, columns, false, 1);
}

/** A repeatable section or category (Phase 2.7): its fields become the items of a list stored under repeat.key. */
function validateRepeatBlock(ctx: Ctx, block: Obj, path: string, blockFields: unknown[], scope: Scope, columns: number) {
  const repeat = block.repeat;
  const rPath = `${path}.repeat`;
  if (!isObject(repeat)) {
    ctx.add(rPath, "invalid_repeat", "repeat must be {key, min_items?, max_items?}");
    return;
  }
  ctx.unknown(repeat, new Set(["key", "min_items", "max_items"]), rPath);
  const key = repeat.key;
  if (!isText(key) || !ITEM_ID.test(key)) {
    ctx.add(`${rPath}.key`, "invalid_field_key", "repeat.key must be lower snake case");
    return;
  }
  if (scope.keys.has(key)) ctx.add(`${rPath}.key`, "duplicate_field_key", `Duplicate field key '${key}'`);
  scope.keys.add(key);
  for (const bound of ["min_items", "max_items"]) {
    if (bound in repeat && !(isInt(repeat[bound]) && (repeat[bound] as number) >= 0 && (repeat[bound] as number) <= 1000)) ctx.add(`${rPath}.${bound}`, "invalid_type", `${bound} must be an integer 0-1000`);
  }
  if (isInt(repeat.min_items) && isInt(repeat.max_items) && repeat.min_items > repeat.max_items) ctx.add(rPath, "invalid_range", "min_items must not be greater than max_items");
  if (!blockFields.length) {
    ctx.add(`${path}.fields`, "container_requires_fields", "A repeatable block needs at least one field");
    return;
  }
  const child = new Scope(scope);
  scope.repeats.set(key, child);
  validateFieldList(ctx, blockFields, `${path}.fields`, child, columns, true, 2);
}

function validateFieldList(ctx: Ctx, fieldList: unknown[], path: string, scope: Scope, columns: number, inRepeat: boolean, depth: number) {
  const cells: Array<[string, Cell]> = [];
  fieldList.forEach((field, index) => {
    const fPath = `${path}[${index}]`;
    const cell = validateField(ctx, field, fPath, scope, columns, inRepeat, depth);
    if (cell) cells.push([fPath, cell]);
  });
  checkOverlaps(ctx, cells);
}

function validateField(ctx: Ctx, field: unknown, path: string, scope: Scope, columns: number, inRepeat: boolean, depth: number): Cell | null {
  if (!isObject(field)) {
    ctx.add(path, "not_object", "Field must be an object");
    return null;
  }
  const type = field.type;
  const knownType = fieldTypeSpec(type) !== undefined;
  if (!knownType) ctx.add(`${path}.type`, "invalid_field_type", `Unknown field type '${String(type)}'`);
  const every = allProps();
  const allowed = knownType ? allowedProps(type) : every;
  for (const key of Object.keys(field).sort()) {
    if (!every.has(key)) ctx.add(`${path}.${key}`, "unknown_property", `Unknown property '${key}'`);
    else if (!allowed.has(key)) ctx.add(`${path}.${key}`, "property_not_supported", `'${key}' does not apply to ${String(type)} fields`);
  }
  const kind = valueKind(type);

  const fieldId = field.id;
  let idDuplicate = false;
  if (!isText(fieldId) || !ITEM_ID.test(fieldId)) ctx.add(`${path}.id`, "invalid_field_id", "Field id must be lower snake case and must not start with '_'");
  else if (ctx.fieldIds.has(fieldId)) {
    ctx.add(`${path}.id`, "duplicate_field_id", `Duplicate field id '${fieldId}'`);
    idDuplicate = true;
  } else ctx.fieldIds.add(fieldId);
  if ("key" in field && (!isText(field.key) || !ITEM_ID.test(field.key))) {
    ctx.add(`${path}.key`, "invalid_field_key", "Field key must be lower snake case and must not start with '_'");
  } else if (hasValue(type) || !knownType) {
    const key = fieldKey(field);
    if (isText(key) && ITEM_ID.test(key)) {
      // A duplicate id without an explicit key is already reported once as duplicate_field_id.
      if (scope.keys.has(key) && ("key" in field || !idDuplicate)) ctx.add(`${path}.key`, "duplicate_field_key", `Duplicate field key '${key}'`);
      scope.keys.add(key);
    }
  }
  if (!isText(field.label) || !field.label.trim()) ctx.add(`${path}.label`, "invalid_label", "Field label is required");
  for (const flag of ["required", "readonly", "hidden", "visible", "indexed", "multiple", "clear_when_hidden"]) {
    if (flag in field && typeof field[flag] !== "boolean") ctx.add(`${path}.${flag}`, "invalid_type", `${flag} must be a boolean`);
  }
  if (typeof field.visible === "boolean" && typeof field.hidden === "boolean" && field.visible === field.hidden) ctx.add(`${path}.visible`, "conflicting_visibility", "visible and hidden disagree");
  for (const [name, limit] of [["description", 2000], ["placeholder", 200], ["unit", 40], ["label_en", 200]] as const) checkText(ctx, field, name, path, limit);
  for (const bound of ["min", "max"]) {
    if (bound in field && !isNumber(field[bound])) ctx.add(`${path}.${bound}`, "invalid_type", `${bound} must be a number`);
  }
  if (isNumber(field.min) && isNumber(field.max) && field.min > field.max) ctx.add(path, "invalid_range", "min must not be greater than max");
  if ("max_length" in field && (!isInt(field.max_length) || field.max_length < 1)) ctx.add(`${path}.max_length`, "invalid_max_length", "max_length must be a positive integer");
  if ("decimals" in field && !(isInt(field.decimals) && field.decimals >= 0 && field.decimals <= 10)) ctx.add(`${path}.decimals`, "invalid_decimals", "decimals must be an integer 0-10");
  if (kind === "option" || kind === "options" || (!knownType && "options" in field)) validateOptions(ctx, field, path, scope);
  if (type === "calculated") {
    validateCalculated(ctx, field, path);
    if (isText(field.formula) && field.formula.trim() && !("calculator" in field)) ctx.formulas.push([`${path}.formula`, field.formula, scope]);
  }
  if (kind === "file" || kind === "signature") validateFileProps(ctx, field, path);
  if ("label_width" in field && allowed.has("label_width") && !(isInt(field.label_width) && field.label_width >= 10 && field.label_width <= 90)) {
    ctx.add(`${path}.label_width`, "invalid_layout", "label_width must be an integer 10-90 (percent of the table)");
  }
  if ("option_columns" in field && allowed.has("option_columns") && !(isInt(field.option_columns) && field.option_columns >= 1 && field.option_columns <= 6)) {
    ctx.add(`${path}.option_columns`, "invalid_columns", "option_columns must be an integer 1-6");
  }
  if (field.type === "matrix") validateMatrix(ctx, field, path);
  if (field.type === "timeline" && "timeline" in field) validateTimelineConfig(ctx, field.timeline, `${path}.timeline`);
  if (field.type === "logo" || field.type === "barcode") validatePrintedElement(ctx, field, path, scope);
  if (field.type === "case_block") validateCaseBlock(ctx, field, path);
  if (STATIC_TYPES.has(field.type as string)) validateStaticElement(ctx, field, path);
  if ("bind" in field && !(isText(field.bind) && BIND.test(field.bind))) ctx.add(`${path}.bind`, "invalid_type", "bind names a case datum such as patient.hn or case.asa");
  else if (isText(field.bind) && field.bind.startsWith("record.") && !RECORD_BINDS.has(field.bind)) {
    ctx.add(`${path}.bind`, "invalid_type", `${field.bind} is not a field of the Flora Leaf anesthesia record`);
  }
  if ("derive" in field && allowed.has("derive")) validateDerive(ctx, field, path, scope);

  if (field.indexed === true && allowed.has("indexed")) {
    if (!INDEXABLE_TYPES.includes(type as string)) ctx.add(`${path}.indexed`, "index_not_supported", `Fields of type '${String(type)}' cannot be indexed`);
    else if (inRepeat) ctx.add(`${path}.indexed`, "index_not_supported", "Fields inside a repeat cannot be indexed");
    else ctx.indexed += 1;
  }

  if ("display" in field) validateDisplay(ctx, field, path);
  const cell = "layout" in field ? validateFieldLayout(ctx, field.layout, `${path}.layout`, columns) : null;
  if ("style" in field) validateStyleRef(ctx, field.style, `${path}.style`);
  if ("validation" in field && allowed.has("validation")) validateRules(ctx, field, path, kind, scope);
  if ("visibility" in field) validateVisibility(ctx, field.visibility, `${path}.visibility`, scope);
  if ("permission" in field) validatePermission(ctx, field.permission, `${path}.permission`, FIELD_ACTIONS);
  if (type === "group" || type === "repeat") validateContainerField(ctx, field, path, scope, columns, inRepeat, depth);
  return cell;
}

function validatePaperKeys(ctx: Ctx, block: Obj, path: string) {
  if ("print_style" in block && !PRINT_STYLES.includes(block.print_style as string)) ctx.add(`${path}.print_style`, "invalid_layout", `print_style must be one of ${PRINT_STYLES.join(", ")}`);
  if ("hide_title" in block && typeof block.hide_title !== "boolean") ctx.add(`${path}.hide_title`, "invalid_type", "hide_title must be a boolean");
}

function matrixCellOk(ctx: Ctx, cell: unknown, path: string) {
  if (!isObject(cell)) {
    ctx.add(path, "invalid_type", "cell must be {type, options?, min?, max?}");
    return;
  }
  ctx.unknown(cell, new Set(["type", "options", "min", "max"]), path);
  if (!MATRIX_CELL_TYPES.includes(cell.type as string)) ctx.add(`${path}.type`, "invalid_field_type", `cell type is one of ${MATRIX_CELL_TYPES.join(", ")}`);
  for (const bound of ["min", "max"]) if (bound in cell && !isNumber(cell[bound])) ctx.add(`${path}.${bound}`, "invalid_type", `${bound} must be a number`);
  if (cell.type === "select") {
    const options = cell.options;
    if (!Array.isArray(options) || !options.length || !options.every(option => isObject(option) && isText(option.value) && option.value !== "" && isText(option.label))) {
      ctx.add(`${path}.options`, "invalid_option", "A select cell needs options [{value, label}]");
    } else if (new Set(options.map(option => (option as Obj).value)).size !== options.length) ctx.add(`${path}.options`, "invalid_option", "Option values must be unique");
  }
}

function matrixItems(ctx: Ctx, items: unknown, path: string, name: string): Obj[] {
  if (!Array.isArray(items) || !items.length || items.length > MAX_MATRIX_ITEMS) {
    ctx.add(path, "invalid_type", `${name} must be a list of 1-${MAX_MATRIX_ITEMS} {id, label}`);
    return [];
  }
  const seen = new Set<string>();
  const out: Obj[] = [];
  items.forEach((item, index) => {
    const itemPath = `${path}[${index}]`;
    if (!isObject(item) || !isText(item.id) || !ITEM_ID.test(item.id)) {
      ctx.add(`${itemPath}.id`, "invalid_field_id", "id must be lower snake case");
      return;
    }
    if (seen.has(item.id)) ctx.add(`${itemPath}.id`, "duplicate_field_id", `Duplicate id '${item.id}'`);
    seen.add(item.id);
    if (!isText(item.label) || !item.label.trim()) ctx.add(`${itemPath}.label`, "invalid_label", "label is required");
    out.push(item);
  });
  return out;
}

/** matrix: fixed rows x cols of cells (score sheets such as the Aldrete score); a row may override the cell; totals are
 * computed rows (sums of numeric rows), never stored. */
function validateMatrix(ctx: Ctx, field: Obj, path: string) {
  matrixCellOk(ctx, field.cell, `${path}.cell`);
  const rows = matrixItems(ctx, field.rows, `${path}.rows`, "rows");
  matrixItems(ctx, field.cols, `${path}.cols`, "cols");
  rows.forEach((row, index) => {
    ctx.unknown(row, new Set(["id", "label", "cell"]), `${path}.rows[${index}]`);
    if ("cell" in row) matrixCellOk(ctx, row.cell, `${path}.rows[${index}].cell`);
  });
  const rowIds = new Set(rows.map(row => row.id as string));
  const numeric = new Set(rows.filter(row => matrixNumeric((row.cell ?? field.cell) as Obj | undefined)).map(row => row.id as string));
  if ("totals" in field) {
    matrixItems(ctx, field.totals, `${path}.totals`, "totals").forEach((total, index) => {
      const totalPath = `${path}.totals[${index}]`;
      ctx.unknown(total, new Set(["id", "label", "of"]), totalPath);
      if (rowIds.has(total.id as string)) ctx.add(`${totalPath}.id`, "duplicate_field_id", `'${String(total.id)}' is also a row id`);
      const of = total.of;
      if (!Array.isArray(of) || !of.length || !of.every(key => isText(key) && numeric.has(key))) ctx.add(`${totalPath}.of`, "unknown_field_reference", "of lists the numeric rows to add up");
    });
  }
}

export const matrixCell = (field: FieldDefinition, row: { cell?: MatrixCell }): MatrixCell | Record<string, never> => row.cell ?? field.cell ?? {};

const numberText = (value: unknown): number | null => {
  if (isNumber(value)) return value;
  if (!isText(value) || !value.trim()) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
};

/** Rows a total may add up: numbers, or choices whose values are all numbers (a 0 / 1 / 2 score). */
function matrixNumeric(cell: Obj | undefined): boolean {
  if (!isObject(cell)) return false;
  if (MATRIX_NUMERIC.includes(cell.type as string)) return true;
  const options = cell.type === "select" ? cell.options : undefined;
  return Array.isArray(options) && options.length > 0 && options.every(option => isObject(option) && numberText(option.value) !== null);
}

/** Total rows of a matrix value: per column, the sum of the listed rows (null when none of them has a value). */
export function matrixTotals(field: FieldDefinition, value: unknown): Record<string, Record<string, number | null>> {
  const data = isObject(value) ? value : {};
  const out: Record<string, Record<string, number | null>> = {};
  for (const total of field.totals ?? []) {
    const sums: Record<string, number | null> = {};
    for (const col of field.cols ?? []) {
      const numbers = total.of.map(row => numberText(isObject(data[row]) ? (data[row] as Obj)[col.id] : undefined)).filter((item): item is number => item !== null);
      sums[col.id] = numbers.length ? numbers.reduce((sum, item) => sum + item, 0) : null;
    }
    out[total.id] = sums;
  }
  return out;
}

const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;

/** timeline.colors: {mode?: series | mono, mono?: "#rrggbb", series?: {hr: "#rrggbb", ...}}. */
function validateTimelineColors(ctx: Ctx, colors: unknown, path: string) {
  if (!isObject(colors)) {
    ctx.add(path, "invalid_type", "colors must be {mode?, mono?, series?}");
    return;
  }
  ctx.unknown(colors, new Set(["mode", "mono", "series"]), path);
  if ("mode" in colors && colors.mode !== "series" && colors.mode !== "mono") ctx.add(`${path}.mode`, "invalid_layout", "mode is series or mono");
  if ("mono" in colors && !(typeof colors.mono === "string" && HEX_COLOR.test(colors.mono))) ctx.add(`${path}.mono`, "invalid_type", "mono is a colour like #1f2937");
  if ("series" in colors) {
    const series = colors.series;
    if (!isObject(series)) {
      ctx.add(`${path}.series`, "invalid_type", "series maps a chart series to a colour like #dc2626");
      return;
    }
    for (const [name, color] of Object.entries(series)) {
      if (!(TIMELINE_SERIES as readonly string[]).includes(name)) ctx.add(`${path}.series.${name}`, "invalid_layout", `series is one of ${TIMELINE_SERIES.join(", ")}`);
      else if (!(typeof color === "string" && HEX_COLOR.test(color))) ctx.add(`${path}.series.${name}`, "invalid_type", "colour like #dc2626");
    }
  }
}

/** timeline: which parts show, the table rows, the chart series, the column step (minutes) and the value source. */
/** heading: level 1-3; paragraph: its text (required); all: alignment. */
function validateStaticElement(ctx: Ctx, field: Obj, path: string) {
  if ("level" in field && !(isInt(field.level) && field.level >= 1 && field.level <= 3)) ctx.add(`${path}.level`, "invalid_layout", "level must be 1, 2 or 3");
  if ("align" in field && !(ALIGNS as readonly unknown[]).includes(field.align)) ctx.add(`${path}.align`, "invalid_layout", "align is left, center or right");
  if (field.type === "paragraph" && (!isText(field.content) || !field.content.trim() || textLength(field.content) > MAX_PARAGRAPH)) {
    ctx.add(`${path}.content`, "invalid_type", `content is the paragraph's text (1-${MAX_PARAGRAPH} characters)`);
  }
}

/** logo: a PNG / JPEG picture kept in the definition; barcode: the value of another field of the form. */
function validatePrintedElement(ctx: Ctx, field: Obj, path: string, scope: Scope) {
  const [low, high] = field.type === "logo" ? LOGO_HEIGHT_MM : BARCODE_HEIGHT_MM;
  if ("height_mm" in field && !(isNumber(field.height_mm) && field.height_mm >= low && field.height_mm <= high)) ctx.add(`${path}.height_mm`, "invalid_layout", `height_mm must be ${low}-${high}`);
  if ("align" in field && !(ALIGNS as readonly unknown[]).includes(field.align)) ctx.add(`${path}.align`, "invalid_layout", "align is left, center or right");
  if (field.type === "logo") {
    if (field.src === HOSPITAL_LOGO) return;  // the hospital's logo, set in Canopy (core/hospital.ts)
    if (!isText(field.src) || !LOGO_SRC.test(field.src)) ctx.add(`${path}.src`, "invalid_file", "src is a PNG or JPEG picture (data:image/png;base64,...) or \"hospital\"");
    else if (field.src.length > MAX_LOGO_CHARS) ctx.add(`${path}.src`, "invalid_max_size", `The picture is limited to ${MAX_LOGO_CHARS / 1000} KB (base64); use a smaller image`);
    return;
  }
  if (!isText(field.source) || !ITEM_ID.test(field.source)) ctx.add(`${path}.source`, "unknown_field_reference", "source names the field whose value the barcode shows (e.g. hn)");
  else ctx.refs.push([`${path}.source`, field.source, scope]);
  if ("symbology" in field && !(SYMBOLOGIES as readonly unknown[]).includes(field.symbology)) ctx.add(`${path}.symbology`, "invalid_layout", `symbology is one of ${SYMBOLOGIES.join(", ")}`);
  if ("show_text" in field && typeof field.show_text !== "boolean") ctx.add(`${path}.show_text`, "invalid_type", "show_text must be a boolean");
}

/** case_block: a known block, some of its columns (each once) with widths in percent that together fit the block,
 * and row limits (core/caseBlocks.ts). */
function validateCaseBlock(ctx: Ctx, field: Obj, path: string) {
  const spec = caseBlockSpec(field.block);
  if (!spec) {
    ctx.add(`${path}.block`, "invalid_type", `block is one of ${CASE_BLOCK_IDS.join(", ")}`);
    return;
  }
  if ("block_columns" in field) {
    const columns = field.block_columns;
    const [low, high] = CASE_BLOCK_LIMITS.column_width;
    if (!Array.isArray(columns) || !columns.length || columns.length > CASE_BLOCK_LIMITS.max_columns) {
      ctx.add(`${path}.block_columns`, "invalid_type", `block_columns lists 1-${CASE_BLOCK_LIMITS.max_columns} of the block's columns`);
    } else {
      const seen = new Set<string>();
      let total = 0;
      columns.forEach((column, index) => {
        const at = `${path}.block_columns[${index}]`;
        if (!isObject(column)) { ctx.add(at, "invalid_type", "a column is {key, width?, label?}"); return; }
        ctx.unknown(column, new Set(["key", "width", "label"]), at);
        if (!isText(column.key) || !spec.columns.some(own => own.key === column.key)) {
          ctx.add(`${at}.key`, "invalid_type", `key is one of ${spec.columns.map(own => own.key).join(", ")}`);
        } else if (seen.has(column.key)) ctx.add(`${at}.key`, "duplicate_option", `column '${column.key}' is listed twice`);
        else seen.add(column.key);
        if ("width" in column) {
          if (!(isNumber(column.width) && column.width >= low && column.width <= high)) ctx.add(`${at}.width`, "invalid_layout", `width is ${low}-${high} (percent of the block)`);
          else total += column.width;
        }
        if ("label" in column && !(isText(column.label) && column.label.trim() && textLength(column.label) <= 80)) ctx.add(`${at}.label`, "invalid_label", "label is 1-80 characters");
      });
      if (total > 100.5) ctx.add(`${path}.block_columns`, "invalid_layout", `the column widths add to ${Math.round(total)}%; together they must fit the block (100%)`);
    }
  }
  for (const name of ["max_rows", "min_rows"] as const) {
    const [low, high] = CASE_BLOCK_LIMITS[name];
    if (name in field && !(isInt(field[name]) && field[name] >= low && field[name] <= high)) ctx.add(`${path}.${name}`, "invalid_type", `${name} must be an integer ${low}-${high}`);
  }
  if (isInt(field.max_rows) && isInt(field.min_rows) && field.min_rows > field.max_rows) ctx.add(`${path}.min_rows`, "invalid_range", "min_rows must not be more than max_rows");
  if ("show_header" in field && typeof field.show_header !== "boolean") ctx.add(`${path}.show_header`, "invalid_type", "show_header must be a boolean");
}

function validateTimelineConfig(ctx: Ctx, config: unknown, path: string) {
  if (!isObject(config)) {
    ctx.add(path, "invalid_type", "timeline must be {parts?, rows?, chart?, step_min?, source?, colors?, print_columns?, hide_empty_rows?}");
    return;
  }
  ctx.unknown(config, new Set(["parts", "rows", "chart", "step_min", "source", "colors", "print_columns", "hide_empty_rows"]), path);
  if ("print_columns" in config && !(isInt(config.print_columns) && config.print_columns >= TIMELINE_PRINT_COLUMNS[0] && config.print_columns <= TIMELINE_PRINT_COLUMNS[1])) {
    ctx.add(`${path}.print_columns`, "invalid_type", `print_columns must be an integer ${TIMELINE_PRINT_COLUMNS[0]}-${TIMELINE_PRINT_COLUMNS[1]}`);
  }
  if ("hide_empty_rows" in config && typeof config.hide_empty_rows !== "boolean") ctx.add(`${path}.hide_empty_rows`, "invalid_type", "hide_empty_rows must be a boolean");
  const parts = config.parts;
  if ("parts" in config && (!Array.isArray(parts) || !parts.length || !parts.every(part => (TIMELINE_PARTS as readonly unknown[]).includes(part)) || new Set(parts).size !== parts.length)) {
    ctx.add(`${path}.parts`, "invalid_layout", `parts lists some of ${TIMELINE_PARTS.join(", ")}`);
  }
  const chart = config.chart;
  if ("chart" in config && (!Array.isArray(chart) || !chart.every(series => (TIMELINE_SERIES as readonly unknown[]).includes(series)) || new Set(chart).size !== chart.length)) {
    ctx.add(`${path}.chart`, "invalid_layout", `chart lists some of ${TIMELINE_SERIES.join(", ")}`);
  }
  if ("step_min" in config && !(isInt(config.step_min) && config.step_min >= 1 && config.step_min <= 120)) ctx.add(`${path}.step_min`, "invalid_type", "step_min must be an integer 1-120");
  if ("source" in config && !TIMELINE_SOURCES.includes(config.source as string)) ctx.add(`${path}.source`, "invalid_layout", "source is leaf or manual");
  if ("colors" in config) validateTimelineColors(ctx, config.colors, `${path}.colors`);
  if ("rows" in config) {
    const rows = config.rows;
    if (!Array.isArray(rows) || rows.length > MAX_TIMELINE_ROWS) {
      ctx.add(`${path}.rows`, "invalid_type", `rows must be a list of at most ${MAX_TIMELINE_ROWS} {id, label?, unit?}`);
      return;
    }
    const seen = new Set<string>();
    rows.forEach((row, index) => {
      const rowPath = `${path}.rows[${index}]`;
      if (!isObject(row) || !isText(row.id) || !TIMELINE_ROW_ID.test(row.id)) {
        ctx.add(`${rowPath}.id`, "invalid_field_id", "Row id is a lowercase parameter key (e.g. hr, nibp_sys, et_co2)");
        return;
      }
      ctx.unknown(row, new Set(["id", "label", "unit"]), rowPath);
      if (seen.has(row.id)) ctx.add(`${rowPath}.id`, "duplicate_field_id", `Duplicate row '${row.id}'`);
      seen.add(row.id);
      for (const name of ["label", "unit"]) if (name in row && (!isText(row[name]) || textLength(row[name] as string) > 60)) ctx.add(`${rowPath}.${name}`, "invalid_type", `${name} is text (at most 60 characters)`);
    });
  }
}

function validateCalculated(ctx: Ctx, field: Obj, path: string) {
  if ("formula" in field && "calculator" in field) ctx.add(`${path}.calculator`, "calculated_formula_conflict", "Use either formula or calculator, not both");
  else if ("calculator" in field) {
    if (!ctx.calculators.has(field.calculator as string)) ctx.add(`${path}.calculator`, "unknown_calculator", `Calculator '${String(field.calculator)}' is not defined in calculators`);
  } else if (!isText(field.formula) || !field.formula.trim()) {
    ctx.add(`${path}.formula`, "calculated_requires_formula", "calculated fields need a formula or a calculator");
  }
  if (field.required) ctx.add(`${path}.required`, "calculated_not_required", "calculated fields cannot be required");
}

function validateContainerField(ctx: Ctx, field: Obj, path: string, scope: Scope, columns: number, inRepeat: boolean, depth: number) {
  let inner = columns;
  if ("columns" in field) {
    if (isInt(field.columns) && field.columns >= 1 && field.columns <= 24) inner = field.columns;
    else ctx.add(`${path}.columns`, "invalid_columns", "columns must be an integer 1-24");
  }
  for (const bound of ["min_items", "max_items"]) {
    if (bound in field && !(isInt(field[bound]) && (field[bound] as number) >= 0 && (field[bound] as number) <= 1000)) ctx.add(`${path}.${bound}`, "invalid_type", `${bound} must be an integer 0-1000`);
  }
  if (isInt(field.min_items) && isInt(field.max_items) && field.min_items > field.max_items) ctx.add(path, "invalid_range", "min_items must not be greater than max_items");
  if ("view" in field && !REPEAT_VIEWS.includes(field.view as string)) ctx.add(`${path}.view`, "invalid_repeat", "view is cards (one card per row) or table (a spreadsheet-like grid)");
  const children = field.fields;
  if (!Array.isArray(children) || children.length === 0) ctx.add(`${path}.fields`, "container_requires_fields", `${String(field.type)} fields need at least one child field`);
  else if (depth >= MAX_NESTING) ctx.add(`${path}.fields`, "too_deep", `Groups and repeats may nest at most ${MAX_NESTING} levels`);
  else {
    const repeat = field.type === "repeat";
    const childScope = repeat ? new Scope(scope) : scope;
    if (repeat && isText(fieldKey(field))) scope.repeats.set(fieldKey(field), childScope);
    validateFieldList(ctx, children, `${path}.fields`, childScope, inner, inRepeat || repeat, depth + 1);
  }
}

const LOOKUP_NAME = /^[a-z][a-z0-9_]{0,63}$/;
const lookupName = (value: unknown) => isText(value) && LOOKUP_NAME.test(value);

/** {lookup column: field key} for lookup filters and derive matches. */
function validatePairs(ctx: Ctx, pairs: unknown, path: string, scope: Scope, required: boolean) {
  if (pairs === undefined && !required) return;
  if (!isObject(pairs) || (required && !Object.keys(pairs).length)) {
    ctx.add(path, "invalid_lookup", 'Map lookup columns to field keys: {"column": "field_key"}');
    return;
  }
  for (const [column, key] of Object.entries(pairs)) {
    if (!LOOKUP_NAME.test(column)) ctx.add(`${path}.${column}`, "invalid_lookup", "Lookup columns are lowercase identifiers");
    else if (!isText(key) || !ITEM_ID.test(key)) ctx.add(`${path}.${column}`, "invalid_lookup", "Each column maps to a field key");
    else ctx.refs.push([`${path}.${column}`, key, scope]);
  }
}

/** lookup: {source, value, label?, filter?} (Phase 2.3): options from a registered lookup table. */
function validateLookup(ctx: Ctx, field: Obj, path: string, scope: Scope) {
  const spec = field.lookup;
  if (!isObject(spec)) {
    ctx.add(`${path}.lookup`, "invalid_lookup", "lookup must be {source, value, label?, filter?}");
    return;
  }
  ctx.unknown(spec, new Set(["source", "value", "label", "filter"]), `${path}.lookup`);
  if (!lookupName(spec.source)) ctx.add(`${path}.lookup.source`, "invalid_lookup", "source names a lookup table");
  for (const column of ["value", "label"]) {
    if ((column === "value" || column in spec) && !lookupName(spec[column])) ctx.add(`${path}.lookup.${column}`, "invalid_lookup", `${column} names a lookup column`);
  }
  validatePairs(ctx, spec.filter, `${path}.lookup.filter`, scope, false);
  if ("options" in field) ctx.add(`${path}.lookup`, "invalid_lookup", "Use options or lookup, not both");
}

/** derive: {lookup, column, match} (Phase 2.3): the value comes from a lookup row; the server recomputes it. */
function validateDerive(ctx: Ctx, field: Obj, path: string, scope: Scope) {
  const spec = field.derive;
  if (!isObject(spec)) {
    ctx.add(`${path}.derive`, "invalid_lookup", "derive must be {lookup, column, match}");
    return;
  }
  ctx.unknown(spec, new Set(["lookup", "column", "match"]), `${path}.derive`);
  for (const name of ["lookup", "column"]) {
    if (!lookupName(spec[name])) ctx.add(`${path}.derive.${name}`, "invalid_lookup", `${name} names a lookup ${name === "lookup" ? "table" : "column"}`);
  }
  validatePairs(ctx, spec.match, `${path}.derive.match`, scope, true);
}

function validateOptions(ctx: Ctx, field: Obj, path: string, scope: Scope) {
  if ("lookup" in field) {
    validateLookup(ctx, field, path, scope);
    return;
  }
  const options = field.options;
  if (!Array.isArray(options) || options.length === 0) {
    ctx.add(`${path}.options`, "missing_options", "select fields need at least one option");
    return;
  }
  const values = new Set<string>();
  options.forEach((option: unknown, oIndex) => {
    const value = isObject(option) ? option.value : undefined;
    if (!isText(value) || !value || !isObject(option) || !isText(option.label)) ctx.add(`${path}.options[${oIndex}]`, "invalid_option", "Option needs a string value and label");
    else if (values.has(value)) ctx.add(`${path}.options[${oIndex}]`, "duplicate_option", `Duplicate option '${value}'`);
    else {
      values.add(value);
      const oPath = `${path}.options[${oIndex}]`;
      ctx.unknown(option, new Set(["value", "label", "label_en", "has_input", "input_required", "when"]), oPath);
      checkText(ctx, option, "label_en", oPath, 200);
      for (const flag of ["has_input", "input_required"]) {
        if (flag in option && typeof option[flag] !== "boolean") ctx.add(`${oPath}.${flag}`, "invalid_option", `${flag} must be a boolean`);
      }
      if (option.input_required === true && option.has_input !== true) ctx.add(`${oPath}.input_required`, "invalid_option", "input_required needs has_input");
      if ("when" in option) validateCondition(ctx, option.when, `${oPath}.when`, scope, 1);
    }
  });
}

function validateFileProps(ctx: Ctx, field: Obj, path: string) {
  if ("accept" in field) {
    const accept = field.accept;
    if (!Array.isArray(accept) || accept.length === 0 || !accept.every(item => isText(item) && MIME.test(item))) ctx.add(`${path}.accept`, "invalid_accept", "accept must list MIME types such as image/png or image/*");
  }
  if ("max_size_kb" in field && !(isInt(field.max_size_kb) && field.max_size_kb >= 1 && field.max_size_kb <= 1048576)) ctx.add(`${path}.max_size_kb`, "invalid_max_size", "max_size_kb must be an integer 1-1048576");
}

function validateExtensions(definition: FormDefinition): Issue[] {
  const extensions = definition.extensions;
  if (!isObject(extensions) || !(SUBJECT_FIELD_KEY in extensions)) return [];
  const target = extensions[SUBJECT_FIELD_KEY];
  const field = isText(target) ? fieldMap(definition).get(target) : undefined;
  if (!field || !SUBJECT_FIELD_TYPES.includes(field.type)) return [issue(`$.extensions.${SUBJECT_FIELD_KEY}`, "invalid_subject_field", "Subject field must name a text, select, radio or integer field")];
  return [];
}

function validateMigration(definition: Obj, fieldKeys: Set<string>): Issue[] {
  if (!("migration" in definition)) return [];
  const migration = definition.migration;
  const version = definition.schema_version;
  if (!isObject(migration) || !isInt(version) || version < 2 || migration.from !== version - 1 || !Array.isArray(migration.ops)) {
    return [issue("$.migration", "invalid_migration", "migration.from must be schema_version - 1 and ops must be an array")];
  }
  const issues: Issue[] = [];
  migration.ops.forEach((op: unknown, index: number) => {
    const path = `$.migration.ops[${index}]`;
    const name = isObject(op) ? op.op : undefined;
    const allowed = isText(name) ? MIGRATION_OPS[name] : undefined;
    const keys = isObject(op) ? Object.keys(op) : [];
    const required = allowed ? [...allowed].filter(key => key !== "default") : [];
    if (!allowed || !isObject(op) || !keys.every(key => allowed.has(key)) || !required.every(key => key in op)) {
      issues.push(issue(path, "invalid_migration", `Unknown or malformed migration op '${String(name)}'`));
      return;
    }
    if (name === "rename_field") {
      if (!isText(op.from) || !fieldKeys.has(op.to as string)) issues.push(issue(path, "migration_unknown_field", `rename target '${String(op.to)}' is not a field of this version`));
    } else if (name === "remove_field") {
      if (fieldKeys.has(op.field as string)) issues.push(issue(path, "migration_unknown_field", `removed field '${String(op.field)}' is still defined`));
    } else if (name === "map_values") {
      const mapping = op.mapping;
      if (!fieldKeys.has(op.field as string) || !isObject(mapping) || !Object.values(mapping).every(isText)) issues.push(issue(path, "migration_unknown_field", `map_values field '${String(op.field)}' is not a field of this version`));
    } else if (name === "convert_type") {
      if (!fieldKeys.has(op.field as string) || !CONVERT_TARGETS.includes(op.to as string)) issues.push(issue(path, "migration_unknown_field", `convert_type field '${String(op.field)}' is not a field of this version`));
    } else if (!fieldKeys.has(op.field as string)) {
      issues.push(issue(path, "migration_unknown_field", `added field '${String(op.field)}' is not a field of this version`));
    }
  });
  return issues;
}

// Readable errors and strict parsing (Phase 1.10) -----------------------------------------------

const PATH_TOKEN = /\.([^.[\]]+)|\[(\d+)\]/g;
const CONTAINERS = ["sections", "categories", "fields", "calculators"];
const CONTAINER_LABEL: Record<string, string> = { sections: "Section", categories: "Category", fields: "Field", calculators: "Calculator" };

function label(kind: string, item: unknown, position: number): string {
  if (!isObject(item)) return `${kind} ${position + 1}`;
  if (kind === "Section") return `Section "${(item.title as string) || (item.id as string) || position + 1}"`;
  if (kind === "Calculator") return `Calculator "${(item.id as string) || position + 1}"`;
  if (kind === "Category") return `Category "${(item.title as string) || (item.id as string) || position + 1}"`;
  const key = fieldKey(item);
  const shown = isText(key) && item.type !== "group"; // a group has no data key
  return `Field "${(item.label as string) || key || position + 1}"` + (shown ? ` (${key})` : "");
}

/** '$.sections[0].fields[2].layout.span' -> 'Section "Vitals" › Field "BP" (bp_sys) › layout.span'. Twin of describe_path. */
export function describePath(definition: unknown, path: string): string {
  if (!isText(path) || !path.startsWith("$")) return String(path);
  const parts: string[] = [];
  const pending: string[] = [];
  let node: unknown = definition;
  let kind: string | null = null;
  const flush = () => {
    if (pending.length) parts.push(pending.splice(0).join("."));
  };
  for (const match of path.slice(1).matchAll(PATH_TOKEN)) {
    const [, name, index] = match;
    if (name !== undefined) {
      if (kind === "data" && node instanceof Map && node.has(name)) {
        flush();
        const field = node.get(name) as FieldDefinition;
        parts.push(label("Field", field, 0));
        node = field;
        kind = field.type === "repeat" ? "items" : null;
      } else if (kind === null && CONTAINERS.includes(name) && isObject(node)) {
        node = node[name];
        kind = name;
      } else if (!parts.length && !pending.length && name === "data" && isObject(definition)) {
        node = fieldMap(definition as FormDefinition);
        kind = "data";
      } else {
        pending.push(name);
        node = isObject(node) ? node[name] : undefined;
        kind = null;
      }
      continue;
    }
    const position = Number(index);
    if (kind !== null && CONTAINERS.includes(kind)) {
      const item = Array.isArray(node) && position < node.length ? node[position] : undefined;
      flush();
      parts.push(label(CONTAINER_LABEL[kind], item, position));
      node = item;
      kind = null;
    } else if (kind === "items" && isObject(node)) {
      flush();
      parts.push(`Item ${position + 1}`);
      node = itemMap(node as FieldDefinition);
      kind = "data";
    } else {
      if (pending.length) pending[pending.length - 1] += `[${position}]`;
      else pending.push(`[${position}]`);
      node = Array.isArray(node) && position < node.length ? node[position] : undefined;
      kind = null;
    }
  }
  flush();
  return parts.length ? parts.join(" › ") : "form";
}

/** The message to show for an issue: the Thai catalog text when the language is Thai, else the validator's English message. */
export function issueText(item: Pick<Issue, "code" | "message">, language = "en"): string {
  return language.toLowerCase().startsWith("th") ? MESSAGES[item.code]?.th ?? item.message : item.message;
}

export const describeIssues = (definition: unknown, issues: Issue[]) =>
  issues.map(item => ({ ...item, location: describePath(definition, item.path), message_th: issueText(item, "th") }));

/** JSON.parse plus a report of duplicate object keys (JSON.parse silently keeps the last one). Twin of parse_json_strict. */
export function parseJsonStrict(text: string): { value: unknown; issues: Issue[] } {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    return { value: null, issues: [issue("$", "invalid_json", `Not valid JSON: ${(error as Error).message}`)] };
  }
  const issues: Issue[] = [];
  let at = 0;
  const skip = () => {
    while (at < text.length && " \t\n\r".includes(text[at])) at += 1;
  };
  const readString = (): string => {
    const start = at;
    at += 1;
    while (text[at] !== "\"") at += text[at] === "\\" ? 2 : 1;
    at += 1;
    return JSON.parse(text.slice(start, at)) as string;
  };
  const readValue = (path: string): void => {
    skip();
    const char = text[at];
    if (char === "{") {
      at += 1;
      const seen = new Set<string>();
      const reported = new Set<string>();
      skip();
      if (text[at] === "}") {
        at += 1;
        return;
      }
      for (;;) {
        skip();
        const key = readString();
        if (seen.has(key) && !reported.has(key)) {
          reported.add(key);
          issues.push(issue(`${path}.${key}`, "duplicate_json_key", `Key '${key}' appears more than once`));
        }
        seen.add(key);
        skip();
        at += 1; // ':'
        readValue(`${path}.${key}`);
        skip();
        if (text[at++] === "}") return;
      }
    }
    if (char === "[") {
      at += 1;
      skip();
      if (text[at] === "]") {
        at += 1;
        return;
      }
      for (let index = 0; ; index += 1) {
        readValue(`${path}[${index}]`);
        skip();
        if (text[at++] === "]") return;
      }
    }
    if (char === "\"") {
      readString();
      return;
    }
    while (at < text.length && !",]} \t\n\r".includes(text[at])) at += 1;
  };
  readValue("$");
  return { value, issues };
}

// Record values: one validator per stored value kind (strategy per field type "value"). ----------

const isEmpty = (value: unknown) => value === null || value === undefined || value === "" || (Array.isArray(value) && value.length === 0);

function validDate(year: number, month: number, day: number): boolean {
  if (month < 1 || month > 12 || day < 1 || year < 1) return false;
  return day <= new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function validDateText(text: string): boolean {
  const match = DATE.exec(text);
  return !!match && validDate(Number(match[1]), Number(match[2]), Number(match[3]));
}

function validDateTime(text: string): boolean {
  const match = DATETIME.exec(text);
  if (!match || !validDateText(match[1])) return false;
  return Number(match[2]) < 24 && Number(match[3]) < 60 && Number(match[4] || 0) < 60;
}

/** Instant of an ISO datetime in epoch ms (fractions truncated to ms). Twin of definition.datetime_epoch_ms. */
export function datetimeEpochMs(text: string, defaultOffsetMinutes = DEFAULT_TZ_OFFSET_MINUTES): number | null {
  const match = DATETIME.exec(text);
  if (!match || !validDateTime(text)) return null;
  const [year, month, day] = match[1].split("-").map(Number);
  const millis = Number(`${match[5] ?? ""}000`.slice(0, 3));
  const zone = match[6];
  const offset = zone === "Z" ? 0 : zone === undefined ? defaultOffsetMinutes : (zone[0] === "+" ? 1 : -1) * (Number(zone.slice(1, 3)) * 60 + Number(zone.slice(4, 6)));
  return Date.UTC(year, month - 1, day, Number(match[2]), Number(match[3]), Number(match[4] ?? 0), millis) - offset * 60000;
}

function validTime(text: string): boolean {
  const match = TIME.exec(text);
  return !!match && Number(match[1]) < 24 && Number(match[2]) < 60 && Number(match[3] || 0) < 60;
}

type ValueValidator = (field: FieldDefinition, value: unknown, path: string) => Issue[];

const valueText: ValueValidator = (field, value, path) => {
  if (!isText(value)) return [issue(path, "invalid_type", "Expected text")];
  const maxLength = effectiveRules(field).max_length;
  if (isInt(maxLength) && textLength(value) > maxLength) return [issue(path, "too_long", `Maximum ${maxLength} characters`)];
  return [];
};

const valueNumber: ValueValidator = (field, value, path) => {
  const kind = valueKind(field.type);
  if (!isNumber(value) || (kind === "integer" && !Number.isInteger(value))) return [issue(path, "invalid_type", kind === "integer" ? "Expected an integer" : "Expected a number")];
  const rules = effectiveRules(field);
  if ((isNumber(rules.min) && value < rules.min) || (isNumber(rules.max) && value > rules.max)) return [issue(path, "out_of_range", "Value is outside the allowed range")];
  if (kind === "decimal") {
    const decimals = isInt(field.decimals) ? field.decimals : 2;
    const scaled = value * 10 ** decimals;
    if (Math.abs(scaled - Math.round(scaled)) > 1e-9 * Math.max(1, Math.abs(scaled))) return [issue(path, "too_many_decimals", `At most ${decimals} decimal places`)];
  }
  return [];
};

const valueTemporal: ValueValidator = (field, value, path) => {
  const check = field.type === "date" ? validDateText : field.type === "datetime" ? validDateTime : validTime;
  return isText(value) && check(value) ? [] : [issue(path, "invalid_date", `Expected an ISO ${field.type}`)];
};

const optionValues = (field: FieldDefinition) => new Set((field.options || []).filter(isObject).map(option => option.value));

// Lookup options (Phase 2.3) come from registry data; the record evaluator checks them against the table.
const valueOption: ValueValidator = (field, value, path) => {
  if (field.lookup !== undefined) return isText(value) && value ? [] : [issue(path, "invalid_type", "Expected an option value")];
  return isText(value) && optionValues(field).has(value) ? [] : [issue(path, "invalid_option", "Value is not one of the options")];
};

const valueOptions: ValueValidator = (field, value, path) => {
  if (!Array.isArray(value) || new Set(value.map(String)).size !== value.length) return [issue(path, "invalid_type", "Expected a list of unique options")];
  if (field.lookup !== undefined) return value.every(item => isText(item) && item) ? [] : [issue(path, "invalid_type", "Expected a list of option values")];
  const allowed = optionValues(field);
  return value.every(item => isText(item) && allowed.has(item)) ? [] : [issue(path, "invalid_option", "Value is not one of the options")];
};

const valueBoolean: ValueValidator = (_field, value, path) => (typeof value === "boolean" ? [] : [issue(path, "invalid_type", "Expected true or false")]);

const mimeAllowed = (mime: string, accept: string[]) => accept.some(pattern => pattern === mime || (pattern.endsWith("/*") && mime.startsWith(pattern.slice(0, -1))));

function fileOk(item: unknown): item is { name: string; mime: string; size: number; ref: string } {
  return isObject(item) && Object.keys(item).every(key => ["name", "mime", "size", "ref"].includes(key))
    && isText(item.name) && textLength(item.name) > 0 && textLength(item.name) <= 255
    && isText(item.mime) && MIME.test(item.mime) && !item.mime.includes("*")
    && isInt(item.size) && item.size >= 0
    && isText(item.ref) && textLength(item.ref) > 0 && textLength(item.ref) <= 500;
}

const valueFile: ValueValidator = (field, value, path) => {
  const many = field.multiple === true;
  if (many && !Array.isArray(value)) return [issue(path, "invalid_type", "Expected a list of files")];
  const items = many ? (value as unknown[]) : [value];
  const accept = field.accept || (field.type === "image" ? ["image/*"] : null);
  const issues: Issue[] = [];
  items.forEach((item, index) => {
    const itemPath = many ? `${path}[${index}]` : path;
    if (!fileOk(item)) issues.push(issue(itemPath, "invalid_file", "Expected {name, mime, size, ref}"));
    else if (accept && !mimeAllowed(item.mime, accept)) issues.push(issue(itemPath, "file_type_not_allowed", `File type ${item.mime} is not accepted`));
    else if (isInt(field.max_size_kb) && item.size > field.max_size_kb * 1024) issues.push(issue(itemPath, "file_too_large", `Larger than ${field.max_size_kb} KB`));
  });
  return issues;
};

const valueSignature: ValueValidator = (field, value, path) => {
  // signer / signer_name: who signed; verified "pin": confirmed with the signer's signing PIN on Flora Leaf.
  const ok = isObject(value) && Object.keys(value).every(key => ["data", "signed_at", "signer", "signer_name", "verified"].includes(key))
    && isText(value.data) && SIGNATURE_DATA.test(value.data)
    && (!("signed_at" in value) || (isText(value.signed_at) && validDateTime(value.signed_at)))
    && ["signer", "signer_name"].every(key => !(key in value) || (isText(value[key]) && textLength(value[key] as string) <= 200))
    && (!("verified" in value) || value.verified === "pin");
  if (!ok) return [issue(path, "invalid_signature", "Expected {data: PNG or SVG data URL, signed_at?, signer?, signer_name?, verified?: pin}")];
  const limit = isInt(field.max_size_kb) ? field.max_size_kb : DEFAULT_SIGNATURE_KB;
  return (value.data as string).length > limit * 1024 ? [issue(path, "file_too_large", `Larger than ${limit} KB`)] : [];
};

const valueList: ValueValidator = (field, value, path) => {
  if (!Array.isArray(value) || !value.every(isObject)) return [issue(path, "invalid_type", "Expected a list of items")];
  const issues: Issue[] = [];
  if (isInt(field.max_items) && value.length > field.max_items) issues.push(issue(path, "too_many_items", `At most ${field.max_items} items`));
  const children = itemMap(field);
  value.forEach((item, index) => issues.push(...validateScope(children, item as Obj, `${path}[${index}]`)));
  return issues;
};

const valueMatrix: ValueValidator = (field, value, path) => {
  if (!isObject(value)) return [issue(path, "invalid_type", "Expected {row: {column: value}}")];
  const rows = new Map((field.rows ?? []).map(row => [row.id, row]));
  const cols = new Set((field.cols ?? []).map(col => col.id));
  const issues: Issue[] = [];
  for (const rowId of Object.keys(value).sort()) {
    const rowPath = `${path}.${rowId}`;
    const cells = value[rowId];
    const row = rows.get(rowId);
    if (!row || !isObject(cells)) {
      issues.push(issue(rowPath, "unknown_field", `'${rowId}' is not a row of this matrix`));
      continue;
    }
    const cell = matrixCell(field, row) as Partial<MatrixCell>;
    for (const colId of Object.keys(cells).sort()) {
      const cellPath = `${rowPath}.${colId}`;
      const item = cells[colId];
      if (!cols.has(colId)) issues.push(issue(cellPath, "unknown_field", `'${colId}' is not a column of this matrix`));
      else if (item === null || item === undefined) continue;
      else if (cell.type && MATRIX_NUMERIC.includes(cell.type)) {
        if (!isNumber(item) || (cell.type === "integer" && !Number.isInteger(item))) issues.push(issue(cellPath, "invalid_type", cell.type === "integer" ? "Expected an integer" : "Expected a number"));
        else if ((isNumber(cell.min) && item < cell.min) || (isNumber(cell.max) && item > cell.max)) issues.push(issue(cellPath, "out_of_range", "Value is outside the allowed range"));
      } else if (cell.type === "select") {
        if (!(cell.options ?? []).some(option => option.value === item)) issues.push(issue(cellPath, "invalid_option", "Not one of the options"));
      } else if (!isText(item) || textLength(item) > 200) issues.push(issue(cellPath, "invalid_type", "Expected text (at most 200 characters)"));
    }
  }
  return issues;
};

/** A timeline snapshot: {step_min, axis: [ms], values: {row: {ms: number | text}}, events?, source?, case_id?, captured_at?}. */
const valueTimeline: ValueValidator = (_field, value, path) => {
  if (!isObject(value)) return [issue(path, "invalid_type", "Expected a timeline snapshot {step_min, axis, values}")];
  const issues: Issue[] = [];
  const known = new Set(["step_min", "axis", "values", "events", "source", "case_id", "captured_at"]);
  for (const key of Object.keys(value).filter(item => !known.has(item)).sort()) issues.push(issue(`${path}.${key}`, "unknown_field", `'${key}' is not part of a timeline snapshot`));
  if (!(isInt(value.step_min) && value.step_min >= 1 && value.step_min <= 120)) issues.push(issue(`${path}.step_min`, "invalid_type", "step_min must be an integer 1-120"));
  let axis = value.axis;
  if (!Array.isArray(axis) || axis.length > MAX_TIMELINE_COLUMNS || !axis.every(ts => isInt(ts) && ts >= 0) || axis.some((ts, index) => index > 0 && ts <= (axis as number[])[index - 1])) {
    issues.push(issue(`${path}.axis`, "invalid_type", `axis lists at most ${MAX_TIMELINE_COLUMNS} increasing times (ms)`));
    axis = [];
  }
  const columns = new Set((axis as number[]).map(String));
  const values = value.values;
  if (!isObject(values) || Object.keys(values).length > MAX_TIMELINE_ROWS) {
    issues.push(issue(`${path}.values`, "invalid_type", `values maps at most ${MAX_TIMELINE_ROWS} rows to {time: value}`));
  } else {
    for (const rowId of Object.keys(values).sort()) {
      const cells = values[rowId];
      if (!TIMELINE_ROW_ID.test(rowId) || !isObject(cells)) {
        issues.push(issue(`${path}.values.${rowId}`, "invalid_type", "Each row maps times to values"));
        continue;
      }
      for (const ts of Object.keys(cells).sort()) {
        const cell = cells[ts];
        if (!columns.has(ts)) issues.push(issue(`${path}.values.${rowId}.${ts}`, "unknown_field", "Not a time of this timeline's axis"));
        else if (!(cell === null || isNumber(cell) || (isText(cell) && textLength(cell) <= 40))) issues.push(issue(`${path}.values.${rowId}.${ts}`, "invalid_type", "A value is a number or short text"));
      }
    }
  }
  const events = "events" in value ? value.events : [];
  if (!Array.isArray(events) || events.length > MAX_TIMELINE_EVENTS) {
    issues.push(issue(`${path}.events`, "invalid_type", `events lists at most ${MAX_TIMELINE_EVENTS} {ts, title, code?}`));
  } else {
    events.forEach((event, index) => {
      const ok = isObject(event) && isInt(event.ts) && isText(event.title) && textLength(event.title) <= 200 && Object.keys(event).every(key => ["ts", "title", "code"].includes(key))
        && (!("code" in event) || (isText(event.code) && textLength(event.code) <= 40));
      if (!ok) issues.push(issue(`${path}.events[${index}]`, "invalid_type", "An event is {ts, title, code?}"));
    });
  }
  if ("source" in value && !TIMELINE_SOURCES.includes(value.source as string)) issues.push(issue(`${path}.source`, "invalid_type", "source is leaf or manual"));
  if ("captured_at" in value && !isInt(value.captured_at)) issues.push(issue(`${path}.captured_at`, "invalid_type", "captured_at is a time in ms"));
  if ("case_id" in value && !(isInt(value.case_id) || (isText(value.case_id) && textLength(value.case_id) <= 64))) issues.push(issue(`${path}.case_id`, "invalid_type", "case_id is an id"));
  return issues;
};

const VALUE_VALIDATORS: Record<ValueKind, ValueValidator> = {
  text: valueText, number: valueNumber, integer: valueNumber, decimal: valueNumber,
  date: valueTemporal, datetime: valueTemporal, time: valueTemporal,
  option: valueOption, options: valueOptions, boolean: valueBoolean,
  file: valueFile, signature: valueSignature, list: valueList, matrix: valueMatrix, timeline: valueTimeline,
};

export function validateValue(field: FieldDefinition, value: unknown, path: string): Issue[] {
  if (value === null || value === undefined) return [];
  // Text or boolean calculator output; the server recomputes calculated values anyway.
  if (field.type === "calculated" && (typeof value === "string" || typeof value === "boolean")) return [];
  const kind = valueKind(field.type);
  return kind ? VALUE_VALIDATORS[kind](field, value, path) : [issue(path, "invalid_type", "Unsupported field type")];
}

function validateScope(byKey: Map<string, FieldDefinition>, data: Obj, path: string): Issue[] {
  const issues: Issue[] = [];
  for (const key of Object.keys(data).sort()) {
    if (key === RETIRED_KEY && path === "$.data") {
      if (!isObject(data[key])) issues.push(issue(`${path}.${key}`, "invalid_type", "_retired must be an object"));
      continue;
    }
    if (key === OTHER_KEY) {
      const other = data[key];
      if (!isObject(other) || !Object.values(other).every(text => isText(text) && textLength(text) <= MAX_OTHER_TEXT)) issues.push(issue(`${path}.${key}`, "invalid_type", `_other maps field keys to text (max ${MAX_OTHER_TEXT} characters)`));
      continue;
    }
    const field = byKey.get(key);
    if (!field) {
      issues.push(issue(`${path}.${key}`, "unknown_field", `'${key}' is not a field of this form version`));
      continue;
    }
    issues.push(...validateValue(field, data[key], `${path}.${key}`));
  }
  return issues;
}

function requiredIssues(byKey: Map<string, FieldDefinition>, data: Obj, path: string): Issue[] {
  const issues: Issue[] = [];
  for (const [key, field] of byKey) {
    const value = data[key];
    if (effectiveRules(field).required === true && isEmpty(value)) issues.push(issue(`${path}.${key}`, "required", `'${field.label ?? key}' is required`));
    if (field.type === "repeat" && Array.isArray(value)) {
      if (isInt(field.min_items) && value.length < field.min_items) issues.push(issue(`${path}.${key}`, "too_few_items", `At least ${field.min_items} items`));
      const children = itemMap(field);
      value.forEach((item, index) => {
        if (isObject(item)) issues.push(...requiredIssues(children, item, `${path}.${key}[${index}]`));
      });
    }
  }
  return issues;
}

/** Validate record data against one schema version. Drafts skip required checks. */
export function validateRecord(definition: FormDefinition, data: unknown, status: string): Issue[] {
  if (!RECORD_STATUSES.includes(status as RecordStatus)) return [issue("$.status", "invalid_status", `status must be one of ${RECORD_STATUSES.join(", ")}`)];
  if (!isObject(data)) return [issue("$.data", "not_object", "Record data must be an object")];
  const byKey = fieldMap(definition);
  const issues = validateScope(byKey, data, "$.data");
  if (status === "submitted") issues.push(...requiredIssues(byKey, data, "$.data"));
  return issues;
}

/** Values copied into the record index so filters never scan record JSON. */
export function indexEntries(definition: FormDefinition, data: Record<string, unknown>): IndexEntry[] {
  const entries: IndexEntry[] = [];
  for (const field of fields(definition)) {
    const family = INDEX_FAMILY[field.type];
    if (field.indexed !== true || family === undefined) continue;
    const key = fieldKey(field);
    const value = data[key];
    if (value === null || value === undefined || value === "") continue;
    if (FIELD_TYPE_SPECS[field.type].value === "boolean") entries.push({ field_id: key, value_text: null, value_num: value ? 1 : 0 });
    else if (family === "num") entries.push({ field_id: key, value_text: null, value_num: Number(value) });
    else if (family === "datetime") entries.push({ field_id: key, value_text: String(value), value_num: datetimeEpochMs(String(value)) });
    else entries.push({ field_id: key, value_text: String(value), value_num: null });
  }
  return entries.sort((a, b) => (a.field_id < b.field_id ? -1 : a.field_id > b.field_id ? 1 : 0));
}
