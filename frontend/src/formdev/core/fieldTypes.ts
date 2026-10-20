/**
 * Field type registry (Phase 1.3) and style tokens (Phase 1.8). Equal to formdev/spec/field-types.json
 * and formdev/spec/style-tokens.json (checked by tests); twin of services/flora-api/app/formdev/field_types.py.
 * Adding a field type means a row here, a value validator in validate.ts and an input in the renderer.
 */

export type ValueKind = "text" | "number" | "integer" | "decimal" | "date" | "datetime" | "time" | "option" | "options" | "boolean" | "file" | "signature" | "list" | "matrix" | "timeline";
export type FieldTypeSpec = { value: ValueKind | null; query: string | null; index: "text" | "num" | "datetime" | null; props: readonly string[] };

export const COMMON_PROPS = ["id", "key", "type", "label", "label_en", "description", "required", "readonly", "hidden", "visible", "display", "layout", "style",
  "validation", "visibility", "clear_when_hidden", "permission", "indexed", "bind"] as const;
export const COMMON_CONTAINER_PROPS = ["id", "type", "label", "label_en", "description", "readonly", "hidden", "visible", "display", "layout", "style", "visibility",
  "clear_when_hidden", "permission"] as const;

export const FIELD_TYPE_SPECS = {
  text: { value: "text", query: "text", index: "text", props: ["unit", "max_length", "placeholder", "derive"] },
  textarea: { value: "text", query: "longtext", index: null, props: ["max_length", "placeholder"] },
  number: { value: "number", query: "num", index: "num", props: ["unit", "min", "max", "placeholder"] },
  decimal: { value: "decimal", query: "num", index: "num", props: ["unit", "min", "max", "decimals", "placeholder"] },
  integer: { value: "integer", query: "num", index: "num", props: ["unit", "min", "max", "placeholder"] },
  date: { value: "date", query: "text", index: "text", props: [] },
  datetime: { value: "datetime", query: "datetime", index: "datetime", props: [] },
  time: { value: "time", query: "text", index: "text", props: [] },
  select: { value: "option", query: "text", index: "text", props: ["options", "placeholder", "lookup", "option_columns"] },
  radio: { value: "option", query: "text", index: "text", props: ["options", "lookup", "option_columns"] },
  multiselect: { value: "options", query: "multi", index: null, props: ["options", "lookup", "option_columns"] },
  checkbox: { value: "boolean", query: "bool", index: "num", props: [] },
  switch: { value: "boolean", query: "bool", index: "num", props: [] },
  file: { value: "file", query: "blob", index: null, props: ["accept", "max_size_kb", "multiple"] },
  image: { value: "file", query: "blob", index: null, props: ["accept", "max_size_kb", "multiple"] },
  signature: { value: "signature", query: "blob", index: null, props: ["max_size_kb"] },
  calculated: { value: "number", query: "num", index: "num", props: ["unit", "formula", "calculator", "decimals"] },
  group: { value: null, query: null, index: null, props: ["fields", "columns"] },
  repeat: { value: "list", query: "list", index: null, props: ["fields", "columns", "min_items", "max_items", "view"] },
  matrix: { value: "matrix", query: null, index: null, props: ["rows", "cols", "cell", "totals", "label_width"] },
  timeline: { value: "timeline", query: null, index: null, props: ["timeline"] },
  // Printed elements without a value: a picture kept in the definition (hospital logo) and a barcode of another
  // field's value (the patient's HN, as on wristbands and Flora Leaf).
  logo: { value: null, query: null, index: null, props: ["src", "height_mm", "align"] },
  barcode: { value: null, query: null, index: null, props: ["source", "symbology", "height_mm", "show_text", "align"] },
  // A report component: a table of one kind of Flora Leaf case data, read when the template is printed.
  case_block: { value: null, query: null, index: null, props: ["block", "block_columns", "max_rows", "min_rows", "show_header"] },
  // Static elements without a value: a heading (its label), a paragraph of text and a dividing line.
  heading: { value: null, query: null, index: null, props: ["level", "align"] },
  paragraph: { value: null, query: null, index: null, props: ["content", "align"] },
  divider: { value: null, query: null, index: null, props: [] },
} as const satisfies Record<string, FieldTypeSpec>;

export type FieldType = keyof typeof FIELD_TYPE_SPECS;
export const FIELD_TYPES = Object.keys(FIELD_TYPE_SPECS) as FieldType[];

export const STYLE_COMPONENTS = ["label", "input", "section", "header", "footer"] as const;
export type StyleComponent = (typeof STYLE_COMPONENTS)[number];
export type TokenSpec = { type: "font" | "number" | "integer" | "color" | "enum" | "boolean"; min?: number; max?: number; values?: readonly string[] };

export const STYLE_TOKENS = {
  fontId: { type: "font" },
  fontSize: { type: "number", min: 6, max: 72 },
  fontWeight: { type: "integer", min: 100, max: 900 },
  lineHeight: { type: "number", min: 0.8, max: 3 },
  color: { type: "color" },
  background: { type: "color" },
  align: { type: "enum", values: ["left", "center", "right"] },
  labelPosition: { type: "enum", values: ["top", "left"] },
  border: { type: "enum", values: ["none", "solid", "dashed", "underline"] },
  borderColor: { type: "color" },
  radius: { type: "number", min: 0, max: 10 },
  padding: { type: "number", min: 0, max: 20 },
  gap: { type: "number", min: 0, max: 20 },
  columns: { type: "integer", min: 1, max: 24 },
  inputHeight: { type: "number", min: 4, max: 30 },
  rule: { type: "enum", values: ["none", "solid", "card"] },
  uppercase: { type: "boolean" },
  pageMarginTop: { type: "number", min: 0, max: 60 },
  pageMarginRight: { type: "number", min: 0, max: 60 },
  pageMarginBottom: { type: "number", min: 0, max: 60 },
  pageMarginLeft: { type: "number", min: 0, max: 60 },
} as const satisfies Record<string, TokenSpec>;

export type StyleToken = keyof typeof STYLE_TOKENS;

const SPECS: Readonly<Record<string, FieldTypeSpec>> = FIELD_TYPE_SPECS;

export const fieldTypeSpec = (type: unknown): FieldTypeSpec | undefined => (typeof type === "string" && Object.hasOwn(SPECS, type) ? SPECS[type] : undefined);
export const valueKind = (type: unknown): ValueKind | null => fieldTypeSpec(type)?.value ?? null;
export const hasValue = (type: unknown): boolean => valueKind(type) !== null;

/** Query family per type (types without one cannot be queried). */
export const QUERY_FAMILY: Readonly<Record<string, string>> = Object.fromEntries(
  Object.entries(SPECS).filter(([, spec]) => spec.query !== null).map(([name, spec]) => [name, spec.query as string]));
export const INDEX_FAMILY: Readonly<Record<string, string>> = Object.fromEntries(
  Object.entries(SPECS).filter(([, spec]) => spec.index !== null).map(([name, spec]) => [name, spec.index as string]));
export const INDEXABLE_TYPES: readonly string[] = Object.keys(INDEX_FAMILY);

const EVERY_PROP = new Set<string>([...COMMON_PROPS, ...Object.values(SPECS).flatMap(spec => spec.props)]);
export const allProps = (): Set<string> => new Set(EVERY_PROP);

export function allowedProps(type: unknown): Set<string> {
  const spec = fieldTypeSpec(type);
  if (!spec) return new Set(COMMON_PROPS);
  return new Set<string>([...(spec.value !== null ? COMMON_PROPS : COMMON_CONTAINER_PROPS), ...spec.props]);
}
