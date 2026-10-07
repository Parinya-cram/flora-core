/**
 * Form designer model: pure, immutable edits of a flora.form/1 definition. The drag & drop designer only ever
 * changes a definition through these functions, so every result is an ordinary definition that the validators,
 * the renderers and the server already understand (no designer-only format).
 *
 * Addressing: a field list is a path into the definition ("sections", 0, "fields") — sections, nested sections,
 * categories and the children of group / repeat fields all hold field lists — and a field is a list plus an index.
 */
import { fieldTypeSpec } from "../core/fieldTypes";
import type { CategoryDefinition, FieldDefinition, FieldType, FormDefinition, MigrationOp, SectionDefinition } from "../core/types";
import { fieldMap, fieldKey } from "../core/validate";
import { FormulaError, rename as renameNames, tokenize } from "../logic/formula";

export type Path = Array<string | number>;
export type FieldRef = { list: Path; index: number };
/** What the designer has selected: the form itself, a section / category (by path), or a field. */
export type Selection = { kind: "form" } | { kind: "section"; path: Path } | { kind: "category"; path: Path } | { kind: "field"; ref: FieldRef };

type Obj = Record<string, unknown>;
const ITEM_ID = /^[a-z][a-z0-9_]{0,63}$/;
export const GRID_COLUMNS = 12;

/** The value at a path (undefined when it does not exist). */
export function at(root: unknown, path: Path): unknown {
  let node: unknown = root;
  for (const step of path) {
    if (node === null || typeof node !== "object") return undefined;
    node = (node as Obj)[step as string];
  }
  return node;
}

/** A changed copy: `change` mutates a deep clone, the original is never touched. */
export function edit(definition: FormDefinition, change: (draft: FormDefinition) => void): FormDefinition {
  const draft = structuredClone(definition);
  change(draft);
  return draft;
}

const listAt = (draft: FormDefinition, path: Path): FieldDefinition[] => {
  const parent = at(draft, path.slice(0, -1)) as Obj | undefined;
  if (!parent) throw new Error(`No container at ${path.join(".")}`);
  const name = path[path.length - 1] as string;
  if (!Array.isArray(parent[name])) parent[name] = [];
  return parent[name] as FieldDefinition[];
};

export const fieldAt = (definition: FormDefinition, ref: FieldRef) => (at(definition, ref.list) as FieldDefinition[] | undefined)?.[ref.index];
export const fieldPath = (ref: FieldRef): Path => [...ref.list, ref.index];
export const samePath = (a: Path, b: Path) => a.length === b.length && a.every((step, index) => step === b[index]);
const startsWith = (path: Path, prefix: Path) => prefix.length <= path.length && prefix.every((step, index) => path[index] === step);

// Every field, section and category ----------------------------------------------------------

/** Every field with its reference, children of groups and repeats included. */
export function allFields(definition: FormDefinition): Array<{ ref: FieldRef; field: FieldDefinition; depth: number }> {
  const out: Array<{ ref: FieldRef; field: FieldDefinition; depth: number }> = [];
  const walkList = (list: Path, depth: number) => {
    ((at(definition, list) as FieldDefinition[] | undefined) ?? []).forEach((field, index) => {
      out.push({ ref: { list, index }, field, depth });
      if (Array.isArray(field.fields)) walkList([...list, index, "fields"], depth + 1);
    });
  };
  const walkSections = (path: Path) => {
    ((at(definition, path) as SectionDefinition[] | undefined) ?? []).forEach((section, index) => {
      walkList([...path, index, "fields"], 0);
      (section.categories ?? []).forEach((_, c) => walkList([...path, index, "categories", c, "fields"], 0));
      walkSections([...path, index, "sections"]);
    });
  };
  walkSections(["sections"]);
  return out;
}

/** Ids and keys in use (fields, sections, categories, repeat blocks, calculators): new names must avoid them all. */
export function usedNames(definition: FormDefinition): Set<string> {
  const used = new Set<string>();
  for (const { field } of allFields(definition)) {
    used.add(field.id);
    used.add(fieldKey(field));
  }
  const walk = (sections: SectionDefinition[] | undefined) => (sections ?? []).forEach(section => {
    used.add(section.id);
    if (section.repeat?.key) used.add(section.repeat.key);
    (section.categories ?? []).forEach(category => {
      used.add(category.id);
      if (category.repeat?.key) used.add(category.repeat.key);
    });
    walk(section.sections);
  });
  walk(definition.sections);
  (definition.calculators ?? []).forEach(calculator => used.add(calculator.id));
  return used;
}

/** A lowercase identifier from any text (Thai text gives the fallback). */
export function slug(text: string, fallback = "field"): string {
  const ascii = text.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").replace(/^([0-9])/, "f_$1");
  return (ascii && ITEM_ID.test(ascii.slice(0, 48)) ? ascii.slice(0, 48) : fallback).replace(/_+$/, "") || fallback;
}

/** `base`, or `base_2`, `base_3`, ... — the first name not in `used` (which is updated). */
export function uniqueName(base: string, used: Set<string>): string {
  const root = ITEM_ID.test(base) ? base : slug(base);
  let name = root;
  for (let n = 2; used.has(name); n += 1) name = `${root}_${n}`;
  used.add(name);
  return name;
}

// New items ------------------------------------------------------------------------------------

const BASE_NAME: Partial<Record<FieldType, string>> = { textarea: "note", multiselect: "choices", checkbox: "check", switch: "yes_no", calculated: "result" };

/** A field of `type` with working defaults and a unique id/key. */
export function newField(type: FieldType, used: Set<string>, label: string, defaults: { option: (n: number) => string; child: string } = { option: n => `Option ${n}`, child: "Item" }): FieldDefinition {
  const key = uniqueName(BASE_NAME[type] ?? type, used);
  const field: FieldDefinition = { id: key, type, label };
  const value = fieldTypeSpec(type)?.value;
  if (value === "option" || value === "options") field.options = [1, 2, 3].map(n => ({ value: `opt_${n}`, label: defaults.option(n) }));
  if (type === "decimal") field.decimals = 1;
  if (type === "group" || type === "repeat") {
    const child = uniqueName("item", used);
    field.fields = [{ id: child, type: "text", label: defaults.child }];
  }
  if (type === "repeat") field.max_items = 20;
  if (type === "matrix") {
    field.cell = { type: "select", options: ["0", "1", "2"].map(value => ({ value, label: value })) };
    field.rows = [1, 2, 3].map(n => ({ id: `row${n}`, label: `${defaults.child} ${n}` }));
    field.cols = [1, 2, 3].map(n => ({ id: `col${n}`, label: String(n) }));
    field.totals = [{ id: "total", label: "Total", of: ["row1", "row2", "row3"] }];
    field.layout = { span: 12 };
  }
  return field;
}

export function newSection(used: Set<string>, title: string): SectionDefinition {
  return { id: uniqueName("section", used), title, fields: [] };
}

export function newCategory(used: Set<string>, title: string, firstField: FieldDefinition): CategoryDefinition {
  return { id: uniqueName("group", used), title, fields: [firstField] };
}

/** A minimal valid form. */
export function emptyForm(formId: string, title: string, sectionTitle: string, firstField: (used: Set<string>) => FieldDefinition): FormDefinition {
  const used = new Set<string>();
  const section = newSection(used, sectionTitle);
  section.fields.push(firstField(used));
  return { format: "flora.form/1", form_id: formId, schema_version: 1, title, paper: { size: "A4", orientation: "portrait" }, style_id: "style.a4.medical", sections: [section] };
}

// Field edits ----------------------------------------------------------------------------------

export function insertFields(definition: FormDefinition, list: Path, index: number, fields: FieldDefinition[]): FormDefinition {
  return edit(definition, draft => {
    const target = listAt(draft, list);
    target.splice(Math.max(0, Math.min(index, target.length)), 0, ...structuredClone(fields));
  });
}

/** Where a field moved to `toList` / `toIndex` ends up once it has left `from` (later siblings shift up by one). */
export function movedRef(from: FieldRef, toList: Path, toIndex: number): FieldRef {
  const list = [...toList];
  const depth = from.list.length;
  // The target list sits inside a later sibling of the moved field: that sibling's index drops by one.
  if (startsWith(list, from.list) && list.length > depth && typeof list[depth] === "number" && (list[depth] as number) > from.index) list[depth] = (list[depth] as number) - 1;
  const index = samePath(from.list, toList) && from.index < toIndex ? toIndex - 1 : toIndex;
  return { list, index };
}

/** Move a field to another list / position. Moving a group or repeat into itself is refused (unchanged). */
export function moveField(definition: FormDefinition, from: FieldRef, toList: Path, toIndex: number): FormDefinition {
  if (startsWith(toList, fieldPath(from))) return definition;
  const to = movedRef(from, toList, toIndex);
  return edit(definition, draft => {
    const [field] = listAt(draft, from.list).splice(from.index, 1);
    if (!field) return;
    const target = listAt(draft, to.list);
    target.splice(Math.max(0, Math.min(to.index, target.length)), 0, field);
  });
}

export function removeField(definition: FormDefinition, ref: FieldRef): FormDefinition {
  return edit(definition, draft => {
    listAt(draft, ref.list).splice(ref.index, 1);
  });
}

/** A copy right after the original, with new ids/keys (children too). */
export function duplicateField(definition: FormDefinition, ref: FieldRef, copySuffix = " (copy)"): FormDefinition {
  const original = fieldAt(definition, ref);
  if (!original) return definition;
  const used = usedNames(definition);
  const rename = (field: FieldDefinition): FieldDefinition => {
    const key = uniqueName(fieldKey(field), used);
    const next: FieldDefinition = { ...structuredClone(field), id: key };
    delete next.key;
    if (next.fields) next.fields = next.fields.map(rename);
    return next;
  };
  const copy = rename(original);
  copy.label = `${original.label}${copySuffix}`;
  return insertFields(definition, ref.list, ref.index + 1, [copy]);
}

/** A value with undefined entries removed from plain objects (recursively); an object left empty becomes undefined. */
export function clean(value: unknown): unknown {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return value;
  const out: Obj = {};
  for (const [name, inner] of Object.entries(value as Obj)) {
    const kept = clean(inner);
    if (kept !== undefined) out[name] = kept;
  }
  return Object.keys(out).length ? out : undefined;
}

/** Set (or, with undefined, remove) properties of a field; nested objects are replaced as given, minus unset entries. */
export function patchField(definition: FormDefinition, ref: FieldRef, patch: Partial<Record<keyof FieldDefinition, unknown>>): FormDefinition {
  return edit(definition, draft => {
    const field = listAt(draft, ref.list)[ref.index] as unknown as Obj | undefined;
    if (!field) return;
    for (const [name, value] of Object.entries(patch)) {
      const kept = clean(value);
      if (kept === undefined) delete field[name];
      else field[name] = kept;
    }
  });
}

/** Width and start column on the 12-column grid (or for one device). col undefined = flow after the previous field. */
export function placeOnGrid(definition: FormDefinition, ref: FieldRef, place: { span?: number; col?: number | null }, mode: "desktop" | "tablet" = "desktop"): FormDefinition {
  const field = fieldAt(definition, ref);
  if (!field) return definition;
  const layout = structuredClone(field.layout ?? {});
  const span = place.span === undefined ? undefined : Math.max(1, Math.min(GRID_COLUMNS, Math.round(place.span)));
  if (mode === "desktop") {
    if (span !== undefined) layout.span = span;
    if (place.col === null) delete layout.col;
    else if (place.col !== undefined) layout.col = Math.max(1, Math.min(GRID_COLUMNS - (span ?? layout.span ?? 1) + 1, Math.round(place.col)));
  } else {
    const rule = { ...(layout.responsive?.tablet ?? {}) };
    if (span !== undefined) rule.span = span;
    if (place.col === null) delete rule.col;
    else if (place.col !== undefined) rule.col = Math.max(1, Math.min(GRID_COLUMNS - (span ?? rule.span ?? 1) + 1, Math.round(place.col)));
    layout.responsive = { ...(layout.responsive ?? {}), tablet: rule };
  }
  return patchField(definition, ref, { layout });
}

// Sections and categories ----------------------------------------------------------------------

export function patchAt(definition: FormDefinition, path: Path, patch: Obj): FormDefinition {
  return edit(definition, draft => {
    const node = at(draft, path) as Obj | undefined;
    if (!node) return;
    for (const [name, value] of Object.entries(patch)) {
      const kept = clean(value);
      if (kept === undefined) delete node[name];
      else node[name] = kept;
    }
  });
}

/** Insert into, move within, or remove from an array at `listPath` (sections or categories). */
export function insertAt(definition: FormDefinition, listPath: Path, index: number, item: unknown): FormDefinition {
  return edit(definition, draft => {
    const parent = at(draft, listPath.slice(0, -1)) as Obj;
    const name = listPath[listPath.length - 1] as string;
    if (!Array.isArray(parent[name])) parent[name] = [];
    const list = parent[name] as unknown[];
    list.splice(Math.max(0, Math.min(index, list.length)), 0, structuredClone(item));
  });
}

export function moveAt(definition: FormDefinition, listPath: Path, from: number, to: number): FormDefinition {
  const list = at(definition, listPath) as unknown[] | undefined;
  if (!list || to < 0 || to >= list.length || from === to) return definition;
  return edit(definition, draft => {
    const target = at(draft, listPath) as unknown[];
    const [item] = target.splice(from, 1);
    target.splice(to, 0, item);
  });
}

export function removeAt(definition: FormDefinition, listPath: Path, index: number): FormDefinition {
  return edit(definition, draft => {
    const parent = at(draft, listPath.slice(0, -1)) as Obj;
    const name = listPath[listPath.length - 1] as string;
    const list = parent[name] as unknown[];
    list.splice(index, 1);
    if (!list.length && name !== "sections" && name !== "fields") delete parent[name];
  });
}

// Publishing a new version ---------------------------------------------------------------------

const FAMILY: Record<string, string> = {
  text: "text", textarea: "text", select: "text", radio: "text",
  number: "number", integer: "number", decimal: "number", calculated: "number", checkbox: "boolean", switch: "boolean",
};
const CONVERT_TO: Record<string, "text" | "number" | "integer" | "boolean"> = { number: "number", decimal: "number", calculated: "number", integer: "integer", checkbox: "boolean", switch: "boolean" };

/**
 * The migration from the published `previous` version to `current`, so old records stay readable: a field whose
 * key changed (same id) is renamed, a removed field is retired (its values move to _retired, nothing is deleted),
 * and a field whose kind of value changed is converted (values that cannot be converted are retired too).
 */
export function buildMigration(previous: FormDefinition, current: FormDefinition): { from: number; ops: MigrationOp[] } {
  const ops: MigrationOp[] = [];
  const oldByKey = fieldMap(previous);
  const newByKey = fieldMap(current);
  const oldKeyById = new Map([...oldByKey].map(([key, field]) => [field.id, key]));
  const renamedFrom = new Set<string>();
  const renamedTo = new Map<string, string>();
  for (const [key, field] of newByKey) {
    const oldKey = oldKeyById.get(field.id);
    if (oldKey && oldKey !== key && !newByKey.has(oldKey) && !oldByKey.has(key)) {
      ops.push({ op: "rename_field", from: oldKey, to: key });
      renamedFrom.add(oldKey);
      renamedTo.set(key, oldKey);
    }
  }
  for (const key of oldByKey.keys()) {
    if (!newByKey.has(key) && !renamedFrom.has(key)) ops.push({ op: "remove_field", field: key });
  }
  for (const [key, field] of newByKey) {
    const before = oldByKey.get(renamedTo.get(key) ?? key);
    if (!before) continue;
    if ((FAMILY[before.type] ?? before.type) !== (FAMILY[field.type] ?? field.type)) ops.push({ op: "convert_type", field: key, to: CONVERT_TO[field.type] ?? "text" });
  }
  return { from: previous.schema_version, ops };
}

/** Keys of fields that existed in the published version (their key should not change casually). */
export function publishedKeys(previous: FormDefinition | null): Set<string> {
  return previous ? new Set(fieldMap(previous).keys()) : new Set();
}

/** Issue path ("$.sections[0].fields[2].label") -> the field it is about, if any. */
export function fieldRefOfIssuePath(path: string): FieldRef | null {
  const steps: Path = [];
  for (const match of path.matchAll(/\.([a-z_]+)|\[(\d+)\]/g)) steps.push(match[1] ?? Number(match[2]));
  let last = -1;
  for (let index = 0; index < steps.length - 1; index += 1) if (steps[index] === "fields" && typeof steps[index + 1] === "number") last = index;
  return last < 0 ? null : { list: steps.slice(0, last + 1), index: steps[last + 1] as number };
}

// Renaming a key everywhere it is used ---------------------------------------------------------

/** A formula with `from` (and repeat columns "from.child") renamed to `to`; unparsable text is left as it is. */
export function renameInFormula(text: string, from: string, to: string): string {
  try {
    const mapping: Record<string, string> = {};
    for (const token of tokenize(text)) {
      const name = token.kind === "name" ? String(token.value) : "";
      if (name === from) mapping[name] = to;
      else if (name.startsWith(`${from}.`)) mapping[name] = `${to}${name.slice(from.length)}`;
    }
    return Object.keys(mapping).length ? renameNames(text, mapping) : text;
  } catch (error) {
    if (error instanceof FormulaError) return text;
    throw error;
  }
}

function renameInCondition(condition: unknown, from: string, to: string): void {
  if (!condition || typeof condition !== "object") return;
  const node = condition as Obj;
  for (const group of ["and", "or"]) if (Array.isArray(node[group])) (node[group] as unknown[]).forEach(part => renameInCondition(part, from, to));
  if (node.field === from) node.field = to;
}

/**
 * Give the field at `ref` the data key `to` and update every reference to its old key: conditions (visibility,
 * options, rules), formulas (fields, calculators, rules), form rules, lookup filters, derivations and the
 * patient identifier setting. The field id stays, so publishing turns this into a rename_field migration.
 */
export function renameKey(definition: FormDefinition, ref: FieldRef, to: string): FormDefinition {
  const field = fieldAt(definition, ref);
  if (!field) return definition;
  const from = fieldKey(field);
  if (from === to) return definition;
  return edit(definition, draft => {
    const target = listAt(draft, ref.list)[ref.index] as unknown as Obj;
    if (to === target.id) delete target.key;
    else target.key = to;
    const fixHolder = (holder: Obj) => {
      const visibility = holder.visibility as Obj | undefined;
      if (visibility) renameInCondition(visibility.when, from, to);
    };
    for (const { ref: each } of allFields(draft)) {
      const item = listAt(draft, each.list)[each.index] as unknown as Obj;
      fixHolder(item);
      for (const option of (item.options as Obj[] | undefined) ?? []) renameInCondition(option.when, from, to);
      if (typeof item.formula === "string") item.formula = renameInFormula(item.formula, from, to);
      const validation = item.validation as Obj | undefined;
      for (const rule of (validation?.rules as Obj[] | undefined) ?? []) {
        if (typeof rule.assert === "string") rule.assert = renameInFormula(rule.assert, from, to);
        renameInCondition(rule.when, from, to);
      }
      for (const spec of [item.lookup && (item.lookup as Obj).filter, item.derive && (item.derive as Obj).match] as Array<Obj | undefined>) {
        if (spec) for (const [column, key] of Object.entries(spec)) if (key === from) spec[column] = to;
      }
    }
    const walkSections = (sections: SectionDefinition[] | undefined) => (sections ?? []).forEach(section => {
      fixHolder(section as unknown as Obj);
      (section.categories ?? []).forEach(category => fixHolder(category as unknown as Obj));
      walkSections(section.sections);
    });
    walkSections(draft.sections);
    for (const calculator of draft.calculators ?? []) calculator.formula = renameInFormula(calculator.formula, from, to);
    for (const rule of draft.rules ?? []) {
      rule.assert = renameInFormula(rule.assert, from, to);
      rule.fields = rule.fields.map(key => (key === from ? to : key));
      renameInCondition(rule.when, from, to);
    }
    if (draft.extensions?.["flora.subject_field"] === from) draft.extensions["flora.subject_field"] = to;
  });
}
