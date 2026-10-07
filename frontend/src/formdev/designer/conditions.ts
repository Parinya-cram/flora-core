/**
 * Conditions as rows a non-developer can edit ("show when [field] [is] [value]", all / any of the rows), and
 * back. Only flat conditions round-trip; a nested one is reported as complex and left to the JSON view.
 */
import type { Condition, ConditionOperator, FieldDefinition, JsonValue } from "../core/types";
import { fieldTypeSpec } from "../core/fieldTypes";

export type ConditionRow = { field: string; operator: ConditionOperator; value: string };
export type ConditionRows = { join: "and" | "or"; rows: ConditionRow[] };

const VALUELESS = new Set(["exists", "empty"]);
const isLeaf = (condition: unknown): condition is { field: string; operator: ConditionOperator; value?: JsonValue } =>
  typeof condition === "object" && condition !== null && "field" in condition;

const valueText = (value: JsonValue | undefined) => (value === undefined || value === null ? "" : Array.isArray(value) ? value.join(", ") : String(value));

/** Rows for an editor, or null when the condition nests (edit it as JSON). */
export function rowsOf(condition: Condition | undefined): ConditionRows | null {
  if (!condition) return { join: "and", rows: [] };
  if (isLeaf(condition)) return { join: "and", rows: [{ field: condition.field, operator: condition.operator, value: valueText(condition.value) }] };
  const join = "and" in condition ? "and" : "or";
  const parts = (condition as Record<string, Condition[]>)[join];
  if (!Array.isArray(parts) || !parts.every(isLeaf)) return null;
  return { join, rows: parts.map(part => ({ field: part.field, operator: part.operator, value: valueText(part.value) })) };
}

/** The typed value for the field the row tests: numbers for numeric fields, true/false for yes/no fields, a list for "in". */
export function typedValue(row: ConditionRow, target: FieldDefinition | undefined): JsonValue | undefined {
  if (VALUELESS.has(row.operator)) return undefined;
  const kind = fieldTypeSpec(target?.type)?.value;
  const one = (text: string): JsonValue => {
    const trimmed = text.trim();
    if (kind === "boolean") return trimmed === "true";
    if ((kind === "number" || kind === "integer" || kind === "decimal") && trimmed !== "" && Number.isFinite(Number(trimmed))) return Number(trimmed);
    return trimmed;
  };
  if (row.operator === "in" || row.operator === "not_in") return row.value.split(",").map(part => one(part)).filter(part => part !== "");
  return one(row.value);
}

/** A condition from rows (undefined when there are none or a row is incomplete). */
export function conditionOf(rows: ConditionRows, fieldByKey: (key: string) => FieldDefinition | undefined): Condition | undefined {
  const leaves: Condition[] = [];
  for (const row of rows.rows) {
    if (!row.field) return undefined;
    const value = typedValue(row, fieldByKey(row.field));
    if (!VALUELESS.has(row.operator) && (value === "" || (Array.isArray(value) && !value.length))) return undefined;
    leaves.push(value === undefined ? { field: row.field, operator: row.operator } : { field: row.field, operator: row.operator, value });
  }
  if (!leaves.length) return undefined;
  if (leaves.length === 1) return leaves[0];
  return rows.join === "and" ? { and: leaves } : { or: leaves };
}
