/** How values read on paper (A4 print and PDF share these). */
import type { FieldDefinition, FieldOption, JsonValue } from "../core/types";
import { fieldKey, OTHER_KEY } from "../core/validate";

/** A plain value as text: decimals as defined, datetimes without seconds, the unit after it. "" when empty. */
export function printedText(field: FieldDefinition, value: JsonValue | undefined): string {
  if (value === null || value === undefined || value === "") return "";
  if (typeof value === "number" && field.decimals !== undefined && (field.type === "decimal" || field.type === "calculated")) return value.toFixed(field.decimals);
  if (field.type === "datetime" && typeof value === "string") return value.slice(0, 16).replace("T", " ");
  return `${String(value)}${field.unit ? ` ${field.unit}` : ""}`;
}

/** An option label, with the Other text after it when the option asks for one (Phase 2.6). */
export const optionText = (option: Pick<FieldOption, "label" | "has_input">, chosen: boolean, other?: string) =>
  option.has_input && chosen && other ? `${option.label}: ${other}` : option.has_input ? `${option.label} ........` : option.label;

/** One cell of a repeat table: the chosen option's label (with Other text) or the plain value. */
export function cellText(child: FieldDefinition, item: Record<string, JsonValue>): string {
  const value = item[fieldKey(child)];
  const option = child.options?.find(entry => entry.value === value);
  if (option) {
    const other = (item[OTHER_KEY] as Record<string, JsonValue> | undefined)?.[fieldKey(child)];
    return option.has_input && typeof other === "string" && other ? `${option.label}: ${other}` : option.label;
  }
  return printedText(child, value);
}
