/**
 * Calculator templates (Phase 2.5): medical calculators kept as definitions (registry/calculators.json), never as
 * code in the UI. Instantiating one renames its parameters to the form's field keys and adds it to calculators.
 */
import type { CalculatorDefinition, JsonValue } from "../core/types";
import { FormulaError, rename } from "./formula";

export type CalculatorTemplate = {
  template_id: string;
  name: string;
  description?: string;
  params: Array<{ name: string; label: string; unit?: string }>;
  formula: string;
  output?: CalculatorDefinition["output"];
  examples?: Array<{ values: Record<string, JsonValue>; result: JsonValue }>;
};

/** A form calculator from a template: `mapping` names the field key for every parameter. */
export function instantiateTemplate(template: CalculatorTemplate, mapping: Record<string, string>, calculatorId = template.template_id): CalculatorDefinition {
  const missing = template.params.map(param => param.name).filter(name => !mapping[name]);
  if (missing.length) throw new FormulaError("invalid_arguments", `Map every parameter to a field: ${missing.join(", ")}`, 1);
  const calculator: CalculatorDefinition = { id: calculatorId, name: template.name, formula: rename(template.formula, mapping) };
  if (template.description) calculator.description = template.description;
  if (template.output) calculator.output = { ...template.output };
  return calculator;
}
