/**
 * Repeatable sections and categories (Phase 2.7). A block with `repeat: {key, min_items, max_items}` stores its
 * fields as a list of items under `key`, exactly like a repeat field; every traversal sees that synthetic repeat
 * field. Twin of services/flora-api/app/formdev/blocks.py.
 */
import type { FieldDefinition } from "./types";

type Obj = Record<string, unknown>;
const isObject = (value: unknown): value is Obj => typeof value === "object" && value !== null && !Array.isArray(value);

export function repeatKey(block: Obj): string | null {
  return isObject(block.repeat) && typeof block.repeat.key === "string" ? block.repeat.key : null;
}

/** The repeat field a repeatable section or category stands for. */
export function asRepeatField(block: Obj): FieldDefinition {
  const repeat = block.repeat as Obj;
  const field: Obj = { id: repeat.key, key: repeat.key, type: "repeat", label: (block.title as string) || repeat.key, fields: Array.isArray(block.fields) ? block.fields : [] };
  for (const bound of ["min_items", "max_items"]) if (bound in repeat) field[bound] = repeat[bound];
  for (const name of ["visibility", "permission"]) if (name in block) field[name] = block[name];
  return field as FieldDefinition;
}

/** The field list a section or category contributes to its scope. */
export const blockFields = (block: Obj): unknown => (repeatKey(block) ? [asRepeatField(block)] : block.fields);

/** The field lists of a section in render order: its own fields, then each category's (Phase 2.0). */
export function sectionFieldLists(section: Obj): unknown[] {
  const categories = Array.isArray(section.categories) ? section.categories.filter(isObject) : [];
  return [blockFields(section), ...categories.map(blockFields)];
}
