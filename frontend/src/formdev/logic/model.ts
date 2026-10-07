/**
 * Compiled view of a definition for the logic engine (Phase 2): every field with its data path, scope, the
 * visibility conditions that apply to it, and the dependency edges between fields. Twin of
 * services/flora-api/app/formdev/logic/model.py; shared by the definition validator and the record evaluator.
 */
import type { Condition, FieldDefinition, FormDefinition } from "../core/types";
import { asRepeatField, repeatKey } from "../core/blocks";
import { FormulaError, parse, references } from "./formula";
import { evaluationOrder, findCycles, type Edges } from "./graph";

type Obj = Record<string, unknown>;
const isObject = (value: unknown): value is Obj => typeof value === "object" && value !== null && !Array.isArray(value);

/** A data scope: the form (prefix "") or one repeat's items (prefix "meds."). */
export class Scope {
  readonly prefix: string;
  readonly parent: Scope | null;
  readonly keys = new Set<string>();
  readonly repeats = new Map<string, Scope>();

  constructor(prefix = "", parent: Scope | null = null) {
    this.prefix = prefix;
    this.parent = parent;
  }

  /** Node path of a key as seen from this scope (item first, then outwards); null when unknown. */
  find(key: string): string | null {
    const dot = key.indexOf(".");
    const head = dot < 0 ? key : key.slice(0, dot);
    const tail = dot < 0 ? "" : key.slice(dot + 1);
    if (tail) {
      const child = this.repeats.get(head);
      if (child && child.keys.has(tail)) return `${this.prefix}${key}`;
    } else if (this.keys.has(key)) return `${this.prefix}${key}`;
    return this.parent ? this.parent.find(key) : null;
  }
}

/** permissions: permission objects that apply, outermost (form) first. */
export type FieldNode = { node: string; key: string; field: FieldDefinition; scope: Scope; path: string; conditions: Condition[]; permissions: Obj[] };
export type Model = { top: Scope; fields: FieldNode[]; calculators: Map<string, string>; calculatorDefs: Map<string, Obj> };

const keyOf = (field: Obj) => ("key" in field ? field.key : field.id);
const permissionOf = (holder: Obj): Obj[] => (isObject(holder.permission) ? [holder.permission] : []);
const conditionOf = (holder: Obj): Condition[] => (isObject(holder.visibility) && "when" in holder.visibility ? [holder.visibility.when as Condition] : []);

export function build(definition: unknown): Model {
  const top = new Scope();
  const out: FieldNode[] = [];
  const calculators = new Map<string, string>();
  const calculatorDefs = new Map<string, Obj>();
  if (isObject(definition) && Array.isArray(definition.calculators)) {
    for (const item of definition.calculators) {
      if (isObject(item) && typeof item.id === "string" && typeof item.formula === "string") {
        calculators.set(item.id, item.formula);
        calculatorDefs.set(item.id, item);
      }
    }
  }
  const walkFields = (fieldList: unknown, path: string, scope: Scope, conditions: Condition[], grants: Obj[]) => {
    (Array.isArray(fieldList) ? fieldList : []).forEach((field: unknown, index) => {
      if (!isObject(field)) return;
      const fieldPath = `${path}[${index}]`;
      const own = [...conditions, ...conditionOf(field)];
      const ownGrants = [...grants, ...permissionOf(field)];
      if (field.type === "group") {
        walkFields(field.fields, `${fieldPath}.fields`, scope, own, ownGrants);
        return;
      }
      const key = keyOf(field);
      if (typeof key !== "string") return;
      scope.keys.add(key);
      out.push({ node: `${scope.prefix}${key}`, key, field: field as FieldDefinition, scope, path: fieldPath, conditions: own, permissions: ownGrants });
      if (field.type === "repeat") {
        const child = new Scope(`${scope.prefix}${key}.`, scope);
        scope.repeats.set(key, child);
        walkFields(field.fields, `${fieldPath}.fields`, child, own, ownGrants);
      }
    });
  };
  /** A section's or category's fields; a repeatable block becomes one list node (Phase 2.7). */
  const walkBlock = (block: Obj, path: string, conditions: Condition[], grants: Obj[]) => {
    const key = repeatKey(block);
    if (key === null) {
      walkFields(block.fields, `${path}.fields`, top, conditions, grants);
      return;
    }
    top.keys.add(key);
    out.push({ node: key, key, field: asRepeatField(block), scope: top, path: `${path}.repeat`, conditions, permissions: grants });
    const child = new Scope(`${key}.`, top);
    top.repeats.set(key, child);
    walkFields(block.fields, `${path}.fields`, child, conditions, grants);
  };
  const walkSections = (sections: unknown, path: string, conditions: Condition[], grants: Obj[]) => {
    (Array.isArray(sections) ? sections : []).forEach((section: unknown, index) => {
      if (!isObject(section)) return;
      const sectionPath = `${path}[${index}]`;
      const own = [...conditions, ...conditionOf(section)];
      const ownGrants = [...grants, ...permissionOf(section)];
      walkBlock(section, sectionPath, own, ownGrants);
      (Array.isArray(section.categories) ? section.categories : []).forEach((category: unknown, cIndex) => {
        if (isObject(category)) walkBlock(category, `${sectionPath}.categories[${cIndex}]`, [...own, ...conditionOf(category)], [...ownGrants, ...permissionOf(category)]);
      });
      walkSections(section.sections, `${sectionPath}.sections`, own, ownGrants);
    });
  };
  if (isObject(definition)) walkSections((definition as FormDefinition).sections, "$.sections", [], permissionOf(definition));
  return { top, fields: out, calculators, calculatorDefs };
}

export function* conditionKeys(condition: unknown): Generator<string> {
  if (!isObject(condition)) return;
  for (const group of ["and", "or"]) {
    if (Array.isArray(condition[group])) {
      for (const part of condition[group] as unknown[]) yield* conditionKeys(part);
      return;
    }
  }
  if (typeof condition.field === "string") yield condition.field;
}

/** The formula a calculated field runs (inline, or its calculator's). */
export function formulaOf(model: Model, item: FieldNode): string | null {
  if (item.field.type !== "calculated") return null;
  if (typeof item.field.formula === "string") return item.field.formula;
  return model.calculators.get(item.field.calculator as string) ?? null;
}

export function formulaRefs(text: string | null): string[] {
  if (!text) return [];
  try {
    return references(parse(text)).map(([name]) => name);
  } catch (error) {
    if (error instanceof FormulaError) return [];
    throw error;
  }
}

/** Keys a field's options or value depend on (Phase 2.3): option conditions, lookup filters, derive matches. */
export function dependencyKeys(field: FieldDefinition): string[] {
  const out: string[] = [];
  for (const option of Array.isArray(field.options) ? field.options : []) {
    if (isObject(option) && "when" in option) out.push(...conditionKeys(option.when));
  }
  const holder = field as unknown as Obj;
  for (const [spec, pairs] of [[holder.lookup, "filter"], [holder.derive, "match"]] as const) {
    if (isObject(spec) && isObject(spec[pairs])) out.push(...Object.values(spec[pairs] as Obj).filter((key): key is string => typeof key === "string"));
  }
  return out;
}

/** node -> nodes it is computed, shown or offered from (formulas, visibility conditions, option conditions,
 * lookup filters and derivations). */
export function edges(model: Model): Edges {
  const out: Edges = new Map(model.fields.map(item => [item.node, new Set<string>()]));
  for (const item of model.fields) {
    const refs = formulaRefs(formulaOf(model, item));
    for (const condition of item.conditions) refs.push(...conditionKeys(condition));
    refs.push(...dependencyKeys(item.field));
    for (const ref of refs) {
      const target = item.scope.find(ref);
      if (target !== null) out.get(item.node)?.add(target);
    }
  }
  return out;
}

export const cycles = (model: Model) => findCycles(edges(model));
export const order = (model: Model) => evaluationOrder(model.fields.map(item => item.node), edges(model));
