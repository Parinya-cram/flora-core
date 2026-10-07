/** FormDev domain types (format flora.form/1). Mirrors formdev/spec/form-definition.schema.json and FORM-SCHEMA.md. */
import type { FieldType, StyleComponent, StyleToken } from "./fieldTypes";

export { FIELD_TYPES, type FieldType } from "./fieldTypes";
export type PaperSize = "A4" | "A5" | "Letter" | "screen";
export type RecordStatus = "draft" | "submitted" | "deleted";
export type SchemaStatus = "draft" | "published" | "archived";
export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
export type RecordData = Record<string, JsonValue>;

export type LayoutMode = "desktop" | "tablet" | "mobile" | "print";
export type DisplayContext = "form" | "table" | "detail" | "query" | "export";
export type PageBreak = "before" | "after" | "avoid";
export type Roles = string[];

/** Header/footer band; text may use {title} {form_id} {version} {page} {pages} {date} {record_id}. */
export type PaperBand = { left?: string; center?: string; right?: string; height_mm?: number; first_page?: boolean };
export type PaperConfig = {
  size: PaperSize;
  orientation?: "portrait" | "landscape";
  margin_mm?: { top?: number; right?: number; bottom?: number; left?: number };
  header?: PaperBand;
  footer?: PaperBand;
};
/** Legacy form: a size name. */
export type Paper = PaperSize | PaperConfig;

export type StyleTokens = { [K in StyleToken]?: JsonValue } & { [C in StyleComponent]?: { [K in StyleToken]?: JsonValue } };
export type StyleRef = { id?: string; override?: StyleTokens };

export type ConditionOperator = "equals" | "not_equals" | "gt" | "gte" | "lt" | "lte" | "in" | "not_in" | "exists" | "empty";
export type Condition = { field: string; operator: ConditionOperator; value?: JsonValue } | { and: Condition[] } | { or: Condition[] };
export type Visibility = { when: Condition };
export type Permission = { view?: Roles; create?: Roles; edit?: Roles; delete?: Roles; export?: Roles };

export type ValidationRules = {
  required?: boolean;
  min?: number;
  max?: number;
  min_length?: number;
  max_length?: number;
  pattern?: string;
  email?: boolean;
  numeric?: boolean;
  /** ISO date, or "today", "today-30d", "today+7d". */
  min_date?: string;
  max_date?: string;
  message?: string;
  /** Custom rules: a formula that must be true (Phase 2.1). */
  rules?: Array<{ assert: string; message: string; when?: Condition }>;
};

export type FieldLayout = {
  col?: number;
  row?: number;
  span?: number;
  page_break?: PageBreak;
  responsive?: Partial<Record<LayoutMode, { col?: number; span?: number; hidden?: boolean }>>;
};
export type ContainerLayout = { type?: "grid" | "row" | "column"; columns?: number; gap_mm?: number };

/** has_input: Answer + Other, the text is stored in data._other.<key> (Phase 2.6). when: show the option only if true (Phase 2.3). */
export type FieldOption = { value: string; label: string; has_input?: boolean; input_required?: boolean; when?: Condition };

/** lookup column -> field key whose value the column must equal. */
export type LookupPairs = Record<string, string>;
export type LookupSource = { source: string; value: string; label?: string; filter?: LookupPairs };
export type LookupDerive = { lookup: string; column: string; match: LookupPairs };
/** A lookup table (Phase 2.3) as the registry stores it. */
export type LookupTable = {
  lookup_id: string;
  version: number;
  metadata: { title: string; columns: Array<{ name: string; label?: string }>; authoritative?: boolean; notice?: string; source?: string };
  entries: Array<Record<string, string>>;
};

export type FieldDefinition = {
  id: string;
  /** Data and formula name; defaults to id. */
  key?: string;
  type: FieldType;
  label: string;
  description?: string;
  placeholder?: string;
  unit?: string;
  required?: boolean;
  readonly?: boolean;
  hidden?: boolean;
  visible?: boolean;
  indexed?: boolean;
  display?: Partial<Record<DisplayContext, boolean>>;
  layout?: FieldLayout;
  style?: StyleRef;
  validation?: ValidationRules;
  visibility?: Visibility;
  clear_when_hidden?: boolean;
  permission?: Pick<Permission, "view" | "edit" | "export">;
  min?: number;
  max?: number;
  max_length?: number;
  decimals?: number;
  options?: FieldOption[];
  /** Options from a registered lookup table (Phase 2.3), filtered by other fields' values. */
  lookup?: LookupSource;
  /** The value is one column of the first lookup row matching `match` (Phase 2.3); the server recomputes it. */
  derive?: LookupDerive;
  formula?: string;
  calculator?: string;
  accept?: string[];
  max_size_kb?: number;
  multiple?: boolean;
  /** Children of group and repeat fields. */
  fields?: FieldDefinition[];
  columns?: number;
  min_items?: number;
  max_items?: number;
};

/** A named sub-group between section and field (Phase 2.0); its fields share the section's data scope. */
export type CategoryDefinition = {
  id: string;
  title: string;
  description?: string;
  fields: FieldDefinition[];
  layout?: ContainerLayout;
  style?: StyleRef;
  visibility?: Visibility;
  permission?: Pick<Permission, "view" | "edit">;
  page_break?: PageBreak;
  repeat?: RepeatBlock;
};

/** Makes a section or category repeatable: its fields are stored as a list of items under key (Phase 2.7). */
export type RepeatBlock = { key: string; min_items?: number; max_items?: number };

export type SectionDefinition = {
  id: string;
  title: string;
  description?: string;
  fields: FieldDefinition[];
  categories?: CategoryDefinition[];
  sections?: SectionDefinition[];
  repeat?: RepeatBlock;
  layout?: ContainerLayout;
  style?: StyleRef;
  visibility?: Visibility;
  permission?: Pick<Permission, "view" | "edit">;
  page_break?: PageBreak;
};

export type CalculatorDefinition = {
  id: string;
  name?: string;
  description?: string;
  formula: string;
  output?: { type?: "number" | "integer" | "decimal" | "text" | "boolean"; decimals?: number; unit?: string };
};

/** Stored value of file and image fields (the bytes live elsewhere; ref points at them). */
export type FileValue = { name: string; mime: string; size: number; ref: string };
export type SignatureValue = { data: string; signed_at?: string; signer?: string };

export type MigrationOp =
  | { op: "rename_field"; from: string; to: string }
  | { op: "add_field"; field: string; default?: JsonValue }
  | { op: "remove_field"; field: string }
  | { op: "map_values"; field: string; mapping: Record<string, string> }
  | { op: "convert_type"; field: string; to: "text" | "number" | "integer" | "boolean" };

export type FormDefinition = {
  format: "flora.form/1";
  form_id: string;
  schema_version: number;
  title: string;
  description?: string;
  paper: Paper;
  /** Style registry id; style.id is the Phase 1 spelling (one of them is required). */
  style_id?: string;
  style?: StyleRef;
  font_id?: string;
  offline?: boolean;
  metadata?: Record<string, JsonValue>;
  layout?: ContainerLayout;
  calculators?: CalculatorDefinition[];
  /** Rules across several fields; failures are reported on each listed field (Phase 2.1). */
  rules?: Array<{ id: string; assert: string; message: string; fields: string[]; when?: Condition }>;
  permission?: Permission;
  sections: SectionDefinition[];
  migration?: { from: number; ops: MigrationOp[] };
  extensions?: Record<string, JsonValue>;
};

export type FormSummary = {
  form_id: string;
  title: string;
  latest_version: number;
  published_version: number | null;
  updated_at: number;
};

export type SchemaVersion = {
  form_id: string;
  schema_version: number;
  status: SchemaStatus;
  definition: FormDefinition;
  checksum: string;
  published_at?: number | null;
};

/** Metadata columns + JSON data, exactly as the server stores them. */
export type FormRecord = {
  record_id: string;
  form_id: string;
  schema_version: number;
  status: RecordStatus;
  data: RecordData;
  created_at: number;
  created_by: string;
  updated_at: number;
  updated_by: string;
  sync_id: string | null;
  version: number;
};

export type SyncState = "pending" | "synced" | "conflict" | "error";

/** A record as held in local (offline) storage. */
export type LocalRecord = FormRecord & {
  sync_state: SyncState;
  server_version: number;
  index_keys: Array<[string, string, string | number]>;
  migrated?: boolean;
  stored_schema_version?: number;
};

export type IndexEntry = { field_id: string; value_text: string | null; value_num: number | null };
export type IndexFilter = { field: string; op: "eq" | "prefix" | "gte" | "lte"; value: string | number | boolean };

export type RecordQuery = {
  formId: string;
  filters?: IndexFilter[];
  statuses?: RecordStatus[];
  cursor?: string | null;
  limit?: number;
};

export type RecordPage<T = FormRecord> = { rows: T[]; next_cursor: string | null };

/** custom: the message was written by the form designer and is shown as is in every language. */
export type Issue = { path: string; code: string; message: string; custom?: boolean };

export type StyleEntry = { style_id: string; version: number; definition: Record<string, JsonValue> };
export type FontEntry = { font_id: string; metadata: Record<string, JsonValue> };

export type OpKind = "create" | "update" | "submit" | "delete";

/** One queued change; op_id is the idempotency key the server acknowledges. */
export type SyncOp = {
  op_id: string;
  kind: OpKind;
  record_id: string;
  form_id: string;
  schema_version: number;
  base_version: number;
  data: RecordData;
  status: RecordStatus;
  client_updated_at: number;
};

export type SyncAck = {
  op_id: string;
  record_id?: string;
  status: "applied" | "conflict" | "rejected";
  duplicate?: boolean;
  record?: FormRecord;
  conflict?: { strategy: string; resolution: "local_wins" | "remote_wins"; base_version: number; server_version: number; reason: string };
  error?: { code: string; message: string; details?: unknown };
};

export class FormDevError extends Error {
  readonly code: string;
  readonly details?: unknown;

  constructor(code: string, message: string, details?: unknown) {
    super(message);
    this.name = "FormDevError";
    this.code = code;
    this.details = details;
  }
}
