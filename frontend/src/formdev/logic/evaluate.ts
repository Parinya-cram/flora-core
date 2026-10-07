/**
 * Record evaluation (Phase 2.1, 2.2, 2.5, 2.6, 2.7): run a definition's logic on one record. Twin of
 * services/flora-api/app/formdev/logic/evaluate.py, checked by formdev/spec/fixtures/logic-record-cases.json.
 * Order: visibility -> clear_when_hidden -> offered options (option conditions, lookups; values no longer offered
 * are cleared) -> derived and calculated values -> Answer + Other text -> validation. The client
 * uses it for live feedback and offline saves; the server runs its twin again and its result is stored.
 */
import { fieldTypeSpec } from "../core/fieldTypes";
import type { Condition, FormDefinition, Issue, JsonValue, RecordData } from "../core/types";
import { effectiveRules, OTHER_KEY, validateRecord } from "../core/validate";
import { equal, evaluate, FormulaError, parse, roundHalfAway, truthy, type Node } from "./formula";
import { deriveValue, lookupOptions, type LookupTables, type OfferedOption } from "./lookup";
import { build, formulaOf, order, type FieldNode, type Model, type Scope } from "./model";

type Obj = Record<string, unknown>;
const isObject = (value: unknown): value is Obj => typeof value === "object" && value !== null && !Array.isArray(value);
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const NUMERIC = /^[+-]?[0-9]+(?:\.[0-9]+)?$/;
const RELATIVE_DATE = /^today(?:([+-])([0-9]{1,5})d)?$/;
const DATE_TEXT = /^([0-9]{4})-([0-9]{2})-([0-9]{2})/;
const INDEX = /\[[0-9]+\]/g;
const textLength = (value: string) => [...value].length;

/** Today's date in Asia/Bangkok (UTC+7), as YYYY-MM-DD. */
export const bangkokToday = (now = Date.now()) => new Date(now + 7 * 3600_000).toISOString().slice(0, 10);

/** One data scope instance: the record ("$.data") or one repeat item ("$.data.meds[0]"). */
class Context {
  readonly item: Obj;
  readonly path: string;
  readonly scope: Scope;
  readonly parent: Context | null;

  constructor(item: Obj, path: string, scope: Scope, parent: Context | null = null) {
    this.item = item;
    this.path = path;
    this.scope = scope;
    this.parent = parent;
  }

  lookup = (key: string): unknown => {
    const dot = key.indexOf(".");
    if (dot >= 0) {
      const head = key.slice(0, dot);
      const tail = key.slice(dot + 1);
      const child = this.scope.repeats.get(head);
      if (child && child.keys.has(tail)) {
        const items = this.item[head];
        return Array.isArray(items) ? items.map(entry => (isObject(entry) ? entry[tail] ?? null : null)) : [];
      }
    } else if (this.scope.keys.has(key)) return this.item[key] ?? null;
    return this.parent ? this.parent.lookup(key) : null;
  };
}

/** options: data path -> the options offered now, for fields whose options are dynamic (Phase 2.3). */
export type Evaluation = { data: RecordData; issues: Issue[]; hidden: string[]; options: Record<string, OfferedOption[]> };

class Run {
  readonly hidden = new Set<string>();
  readonly issues: Issue[] = [];
  readonly options: Record<string, OfferedOption[]> = {};
  private readonly asts = new Map<string, Node | null>();
  readonly model: Model;
  readonly data: Obj;
  readonly today: string;
  readonly status: string;
  readonly lookups: LookupTables;

  constructor(model: Model, data: Obj, today: string, status: string, lookups: LookupTables) {
    this.model = model;
    this.data = data;
    this.today = today;
    this.status = status;
    this.lookups = lookups;
  }

  contexts(scope: Scope): Context[] {
    if (scope.parent === null) return [new Context(this.data, "$.data", scope)];
    const key = scope.prefix.slice(scope.parent.prefix.length, -1);
    const out: Context[] = [];
    for (const parent of this.contexts(scope.parent)) {
      const items = parent.item[key];
      (Array.isArray(items) ? items : []).forEach((entry, index) => {
        if (isObject(entry)) out.push(new Context(entry, `${parent.path}.${key}[${index}]`, scope, parent));
      });
    }
    return out;
  }

  run(text: string, context: Context): unknown {
    if (!this.asts.has(text)) {
      try {
        this.asts.set(text, parse(text));
      } catch (error) {
        if (!(error instanceof FormulaError)) throw error;
        this.asts.set(text, null); // the definition validator reports it
      }
    }
    const node = this.asts.get(text);
    return node ? evaluate(node, context.lookup, this.today) : null;
  }
}

const isNumber = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

/** Visibility condition (Phase 2.2) against current values. */
export function conditionTrue(condition: unknown, lookup: (key: string) => unknown): boolean {
  if (!isObject(condition)) return true;
  if (Array.isArray(condition.and)) return condition.and.every(part => conditionTrue(part, lookup));
  if (Array.isArray(condition.or)) return condition.or.some(part => conditionTrue(part, lookup));
  const value = typeof condition.field === "string" ? lookup(condition.field) ?? null : null;
  const operator = condition.operator;
  const expected = condition.value ?? null;
  const empty = value === null || value === "" || (Array.isArray(value) && value.length === 0);
  if (operator === "exists") return !empty;
  if (operator === "empty") return empty;
  if (Array.isArray(value)) {
    const wanted = Array.isArray(expected) ? expected : [expected];
    const hit = value.some(item => wanted.some(target => equal(item, target)));
    if (operator === "equals" || operator === "in") return hit;
    if (operator === "not_equals" || operator === "not_in") return !hit;
    return false;
  }
  if (operator === "equals") return equal(value, expected);
  if (operator === "not_equals") return !equal(value, expected);
  if (operator === "in") return Array.isArray(expected) && expected.some(item => equal(value, item));
  if (operator === "not_in") return Array.isArray(expected) && !expected.some(item => equal(value, item));
  if (operator === "gt" || operator === "gte" || operator === "lt" || operator === "lte") {
    const same = (isNumber(value) && isNumber(expected)) || (typeof value === "string" && typeof expected === "string");
    if (!same) return false;
    const [a, b] = [value as number | string, expected as number | string];
    return operator === "gt" ? a > b : operator === "gte" ? a >= b : operator === "lt" ? a < b : a <= b;
  }
  return false;
}

function resolveDate(text: string, today: string): string {
  const match = RELATIVE_DATE.exec(text);
  if (!match) return text;
  const [year, month, day] = today.split("-").map(Number);
  let time = Date.UTC(year, month - 1, day);
  if (match[1]) time += (match[1] === "+" ? 1 : -1) * Number(match[2]) * 86400_000;
  return new Date(time).toISOString().slice(0, 10);
}

const asText = (value: unknown): string => (typeof value === "boolean" ? (value ? "true" : "false") : String(value));

function calculated(run: Run, item: FieldNode, context: Context): JsonValue {
  const text = formulaOf(run.model, item);
  const value = text ? run.run(text, context) : null;
  const calculator = typeof item.field.calculator === "string" ? run.model.calculatorDefs.get(item.field.calculator) : undefined;
  const output = calculator && isObject(calculator.output) ? calculator.output : {};
  return applyOutput(value, output, Number.isInteger(item.field.decimals) ? (item.field.decimals as number) : null);
}

/** A calculator result in its declared output type, rounded to the field's decimals, else the calculator's. */
export function applyOutput(value: unknown, output: Obj, fieldDecimals: number | null = null): JsonValue {
  const kind = (output.type as string | undefined) ?? "number";
  if (kind === "text") return value === null || value === undefined ? null : typeof value === "string" ? value : asText(value);
  if (kind === "boolean") return value === null || value === undefined ? null : truthy(value);
  if (!isNumber(value)) return null;
  let decimals: unknown = fieldDecimals !== null ? fieldDecimals : output.decimals;
  if (kind === "integer") decimals = 0;
  return Number.isInteger(decimals) ? roundHalfAway(value, decimals as number) : value;
}

/** Options that ask for text: value -> text required. */
function otherInputs(field: FieldNode["field"]): Map<string, boolean> {
  return new Map((field.options ?? []).filter(option => isObject(option) && option.has_input === true && typeof option.value === "string")
    .map(option => [option.value, option.input_required === true]));
}

function cleanOther(run: Run, item: FieldNode, context: Context) {
  const inputs = otherInputs(item.field);
  const other = context.item[OTHER_KEY];
  if (!inputs.size && !(isObject(other) && item.key in other)) return;
  const value = context.item[item.key];
  const chosen = (Array.isArray(value) ? value : [value]).filter(entry => typeof entry === "string" && inputs.has(entry)) as string[];
  const path = `${context.path}.${item.key}`;
  if (isObject(other) && item.key in other && !chosen.length) delete other[item.key];
  const text = isObject(other) ? other[item.key] : undefined;
  if (run.status === "submitted" && !run.hidden.has(path) && chosen.some(entry => inputs.get(entry)) && !(typeof text === "string" && text.trim())) {
    run.issues.push({ path, code: "other_text_required", message: `Please specify '${item.field.label ?? item.key}'` });
  }
  if (isObject(other) && Object.keys(other).length === 0) delete context.item[OTHER_KEY];
}

function compiles(pattern: string): RegExp | null {
  try {
    return new RegExp(`^(?:${pattern})$`);
  } catch {
    return null;
  }
}

/** Phase 2.1 rules beyond Phase 1's types, required, min, max and max_length. */
function extraRules(run: Run, item: FieldNode, context: Context) {
  const path = `${context.path}.${item.key}`;
  const value = context.item[item.key];
  const rules = effectiveRules(item.field);
  const custom = typeof rules.message === "string" ? rules.message : null;
  const fail = (code: string, message: string) => run.issues.push(custom !== null ? { path, code, message: custom, custom: true } : { path, code, message });
  if (typeof value === "string" && value !== "") {
    const kind = fieldTypeSpec(item.field.type)?.value;
    if (kind === "text") {
      if (Number.isInteger(rules.min_length) && textLength(value) < (rules.min_length as number)) fail("too_short", `At least ${String(rules.min_length)} characters`);
      if (typeof rules.pattern === "string") {
        const pattern = compiles(rules.pattern);
        if (pattern && !pattern.test(value)) fail("pattern_mismatch", "Value does not have the required format");
      }
      if (rules.email === true && !EMAIL.test(value)) fail("invalid_email", "Not a valid e-mail address");
      if (rules.numeric === true && !NUMERIC.test(value)) fail("not_numeric", "Digits only");
    }
    if (kind === "date" || kind === "datetime") {
      const match = DATE_TEXT.exec(value);
      const day = match ? `${match[1]}-${match[2]}-${match[3]}` : null;
      const low = typeof rules.min_date === "string" ? resolveDate(rules.min_date, run.today) : null;
      const high = typeof rules.max_date === "string" ? resolveDate(rules.max_date, run.today) : null;
      if (day && low && day < low) fail("date_too_early", `Not before ${low}`);
      if (day && high && day > high) fail("date_too_late", `Not after ${high}`);
    }
  }
  const fieldRules = Array.isArray(rules.rules) ? rules.rules : [];
  for (const rule of fieldRules) {
    if (!isObject(rule) || typeof rule.assert !== "string") continue;
    if ("when" in rule && !conditionTrue(rule.when, context.lookup)) continue;
    const result = run.run(rule.assert, context);
    if (result !== null && result !== undefined && !truthy(result)) run.issues.push({ path, code: "rule_failed", message: String(rule.message || "Rule not met"), custom: true });
  }
}

function formRules(run: Run, definition: Obj) {
  const top = run.contexts(run.model.top)[0];
  const rules = Array.isArray(definition.rules) ? definition.rules : [];
  for (const rule of rules) {
    if (!isObject(rule) || typeof rule.assert !== "string" || !Array.isArray(rule.fields)) continue;
    if ("when" in rule && !conditionTrue(rule.when, top.lookup)) continue;
    const result = run.run(rule.assert, top);
    if (result === null || result === undefined || truthy(result)) continue;
    for (const key of rule.fields) {
      const path = `$.data.${String(key)}`;
      if (typeof key === "string" && !run.hidden.has(path)) run.issues.push({ path, code: "rule_failed", message: String(rule.message || "Rule not met"), custom: true });
    }
  }
}

/** Options offered now (Phase 2.3), or null when they are static or their lookup is not loaded. */
function offered(run: Run, item: FieldNode, context: Context): OfferedOption[] | null {
  const field = item.field as unknown as Obj;
  if (isObject(field.lookup)) {
    const source = field.lookup.source;
    const entries = typeof source === "string" && Object.hasOwn(run.lookups, source) ? run.lookups[source] : undefined;
    return entries === undefined ? null : lookupOptions(entries, field.lookup, context.lookup);
  }
  const options = Array.isArray(field.options) ? field.options as unknown[] : null;
  if (!options || !options.some(option => isObject(option) && "when" in option)) return null;
  return options.filter((option): option is Obj => isObject(option) && (!("when" in option) || conditionTrue(option.when, context.lookup)))
    .map(option => Object.fromEntries(Object.entries(option).filter(([key]) => key !== "when")) as OfferedOption);
}

/** Clear a value (or the selections of a multiselect) that is no longer offered. */
function keepOffered(item: Obj, key: string, options: OfferedOption[]): void {
  const values = new Set<unknown>(options.map(option => option.value));
  const value = item[key];
  if (Array.isArray(value)) {
    const kept = value.filter(entry => values.has(entry));
    if (!kept.length) delete item[key];
    else if (kept.length !== value.length) item[key] = kept;
  } else if (value !== null && value !== undefined && !values.has(value)) delete item[key];
}

const under = (path: string, hidden: Set<string>) => [...hidden].some(prefix => path === prefix || path.startsWith(`${prefix}.`) || path.startsWith(`${prefix}[`));
const nodeOf = (path: string) => (path.startsWith("$.data.") ? path.slice(7).replace(INDEX, "") : path);

/**
 * Run the form's logic on one record. Returns the data to store (calculated values recomputed, hidden values
 * cleared where the definition asks, Other text tidied), the issues, and the hidden data paths.
 */
/** `lookups` maps lookup ids to their entries; a lookup that is not given is skipped (its options are not checked
 * and its derived values are left as they are). */
export function evaluateRecord(definition: FormDefinition, data: unknown, status = "draft", today?: string, lookups: LookupTables = {}): Evaluation {
  if (!isObject(data)) return { data: data as RecordData, issues: validateRecord(definition, data, status), hidden: [], options: {} };
  const work = structuredClone(data) as Obj;
  const model = build(definition);
  const run = new Run(model, work, today ?? bangkokToday(), status, lookups);
  const byNode = new Map(model.fields.map(item => [item.node, item]));
  for (const node of order(model)) {
    const item = byNode.get(node) as FieldNode;
    for (const context of run.contexts(item.scope)) {
      const path = `${context.path}.${item.key}`;
      const visible = item.conditions.every((condition: Condition) => conditionTrue(condition, context.lookup));
      if (!visible) {
        run.hidden.add(path);
        if (item.field.clear_when_hidden === true) {
          delete context.item[item.key];
          const other = context.item[OTHER_KEY];
          if (isObject(other)) delete other[item.key];
          continue;
        }
      }
      const offer = visible ? offered(run, item, context) : null;
      if (offer !== null) {
        run.options[path] = offer;
        keepOffered(context.item, item.key, offer);
      }
      const derive = (item.field as unknown as Obj).derive;
      if (isObject(derive) && typeof derive.lookup === "string" && Object.hasOwn(run.lookups, derive.lookup)) {
        const value = deriveValue(run.lookups[derive.lookup], derive, context.lookup);
        if (value === null) delete context.item[item.key];
        else context.item[item.key] = value;
      }
      if (item.field.type === "calculated") {
        const value = calculated(run, item, context);
        if (value === null) delete context.item[item.key];
        else context.item[item.key] = value;
      }
    }
  }
  for (const item of model.fields) {
    for (const context of run.contexts(item.scope)) {
      cleanOther(run, item, context);
      if (!run.hidden.has(`${context.path}.${item.key}`) && !under(context.path, run.hidden)) extraRules(run, item, context);
    }
  }
  formRules(run, definition as unknown as Obj);
  const customMessages = new Map<string, string>();
  for (const item of model.fields) {
    const message = effectiveRules(item.field).message;
    if (typeof message === "string" && message) customMessages.set(item.node, message);
  }
  const base = validateRecord(definition, work, status).filter(item => !under(item.path, run.hidden)).map(item => {
    const message = customMessages.get(nodeOf(item.path));
    return message !== undefined ? { ...item, message, custom: true } : item;
  });
  return { data: work as RecordData, issues: [...base, ...run.issues], hidden: [...run.hidden].sort(), options: run.options };
}
