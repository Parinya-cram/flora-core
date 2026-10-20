/**
 * Client repositories (offline-first). The UI calls these; they validate with the same
 * rules as the server, write to the local adapter and queue a sync op atomically.
 */
import { migrate } from "./core/migrate";
import { valueKind } from "./core/fieldTypes";
import { datetimeEpochMs, fieldKey, fieldMap, indexEntries, INDEXABLE_TYPES, validateDefinition } from "./core/validate";
import { evaluateRecord } from "./logic/evaluate";
import { lookupIds, type LookupTables } from "./logic/lookup";
import { FormDevError, type FieldDefinition, type FormDefinition, type FormRecord, type FormSummary, type IndexFilter, type Issue, type LocalRecord, type RecordData, type RecordPage, type RecordQuery, type RecordStatus, type SchemaVersion, type SyncOp } from "./core/types";
import type { IndexKeyFn, LocalDataAdapter, QueueItem } from "./data/DataAdapter";

export type RepositoryOptions = {
  user: () => string;
  now?: () => number;
  newId?: () => string;
};

const uuid = () => (typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now().toString(16)}-${Math.random().toString(16).slice(2)}-4000-8000-${Math.random().toString(16).slice(2, 14)}`);

export class StyleRepository {
  private readonly local: LocalDataAdapter;

  constructor(local: LocalDataAdapter) {
    this.local = local;
  }

  listStyles() {
    return this.local.listStyles();
  }

  listFonts() {
    return this.local.listFonts();
  }

  async validate(definition: unknown): Promise<Issue[]> {
    const [styles, fonts] = await Promise.all([this.local.listStyles(), this.local.listFonts()]);
    return validateDefinition(definition, styles.map(style => style.style_id), fonts.map(font => font.font_id));
  }
}

export class FormRepository {
  private readonly local: LocalDataAdapter;

  constructor(local: LocalDataAdapter) {
    this.local = local;
  }

  list(): Promise<FormSummary[]> {
    return this.local.listForms();
  }

  async get(formId: string): Promise<FormSummary> {
    const form = (await this.local.listForms()).find(row => row.form_id === formId);
    if (!form) throw new FormDevError("form_not_found", `Form '${formId}' is not installed on this device`);
    return form;
  }
}

export class SchemaRepository {
  private readonly local: LocalDataAdapter;
  private readonly forms: FormRepository;

  constructor(local: LocalDataAdapter) {
    this.local = local;
    this.forms = new FormRepository(local);
  }

  async get(formId: string, version: number): Promise<SchemaVersion> {
    const row = await this.local.getSchema(formId, version);
    if (!row) throw new FormDevError("version_not_found", `Form '${formId}' v${version} is not installed on this device`);
    return row;
  }

  async latestPublished(formId: string): Promise<SchemaVersion> {
    const form = await this.forms.get(formId);
    if (!form.published_version) throw new FormDevError("form_not_published", `Form '${formId}' has no published version`);
    return this.get(formId, form.published_version);
  }

  /** All installed definitions, for synchronous migration chains. */
  async definitions(formId: string): Promise<Map<number, FormDefinition>> {
    return new Map((await this.local.listSchemas(formId)).map(row => [row.schema_version, row.definition]));
  }
}

/**
 * Local index keys [form_id, field, value]. Datetimes are keyed by their instant (epoch ms, like
 * the server's value_num) so ranges work across offsets; an unparsable datetime keeps its text.
 */
export function indexKeysFor(definition: FormDefinition, record: Pick<FormRecord, "form_id" | "data">): LocalRecord["index_keys"] {
  const types = new Map([...fieldMap(definition)].map(([id, field]) => [id, field.type]));
  return indexEntries(definition, record.data).map(entry => {
    const value = types.get(entry.field_id) === "datetime" ? entry.value_num ?? entry.value_text : entry.value_text ?? entry.value_num;
    return [record.form_id, entry.field_id, value as string | number];
  });
}

function filterValue(field: FieldDefinition, op: IndexFilter["op"], value: IndexFilter["value"]): string | number | boolean {
  const kind = valueKind(field.type);
  const key = fieldKey(field);
  // Number, decimal, integer and calculated fields are keyed by value_num.
  if (kind === "number" || kind === "integer" || kind === "decimal") {
    if (op === "prefix") throw new FormDevError("invalid_filter", "prefix filters only apply to text fields");
    const number = typeof value === "string" ? Number(value) : value;
    if (typeof number !== "number" || !Number.isFinite(number) || (typeof value === "string" && !value.trim())) throw new FormDevError("invalid_filter", `'${key}' needs a numeric filter value`);
    return number;
  }
  if (field.type === "datetime") {
    if (op === "prefix") throw new FormDevError("invalid_filter", "prefix filters do not apply to datetime fields");
    const epoch = typeof value === "string" ? datetimeEpochMs(value) : typeof value === "number" && Number.isInteger(value) ? value : null;
    if (epoch === null) throw new FormDevError("invalid_filter", `'${key}' needs an ISO datetime filter value`);
    return epoch;
  }
  if (kind === "boolean") {
    if (op !== "eq" || !(value === true || value === false || value === "true" || value === "false")) throw new FormDevError("invalid_filter", `'${key}' accepts eq true or false`);
    return value === true || value === "true";
  }
  if (typeof value !== "string") throw new FormDevError("invalid_filter", `'${key}' needs a text filter value`);
  return value;
}

export class RecordRepository {
  private readonly local: LocalDataAdapter;
  private readonly schemas: SchemaRepository;
  private readonly options: RepositoryOptions;
  private readonly now: () => number;
  private readonly newId: () => string;
  private readonly cachedDefinitions = new Map<string, FormDefinition>();

  constructor(local: LocalDataAdapter, schemas: SchemaRepository, options: RepositoryOptions) {
    this.local = local;
    this.schemas = schemas;
    this.options = options;
    this.now = options.now ?? (() => Date.now());
    this.newId = options.newId ?? uuid;
  }

  /** Index keys for server copies (used by sync and pull). */
  readonly indexKeys: IndexKeyFn = record => {
    const definition = this.cachedDefinitions.get(`${record.form_id}:${record.schema_version}`);
    return definition ? indexKeysFor(definition, record) : [];
  };

  /** Load definitions so indexKeys() can run synchronously inside storage transactions. */
  async prepare(formIds: string[]): Promise<void> {
    for (const formId of formIds) {
      for (const [version, definition] of await this.schemas.definitions(formId)) this.cachedDefinitions.set(`${formId}:${version}`, definition);
    }
  }

  /** The cached lookup tables a definition reads (Phase 2.3); a table not cached yet is skipped. */
  async lookupTables(definition: FormDefinition): Promise<LookupTables> {
    const out: LookupTables = {};
    for (const id of lookupIds(definition)) {
      const table = await this.local.getLookup(id);
      if (table) out[id] = table.entries;
    }
    return out;
  }

  /** Run the form's logic (Phase 2) and return the data to store, as the server will: calculated values
   * recomputed, values cleared where the definition asks, Other text tidied. Throws on any issue. */
  private async check(definition: FormDefinition, data: unknown, status: RecordStatus): Promise<RecordData> {
    const result = evaluateRecord(definition, data, status, undefined, await this.lookupTables(definition));
    if (result.issues.length) throw new FormDevError("invalid_record", "Record data is not valid", result.issues);
    return result.data;
  }

  private queueItem(op: SyncOp): QueueItem {
    const at = this.now();
    return { op, state: "pending", attempts: 0, next_attempt_at: at, last_error: null, ack: null, created_at: at, updated_at: at };
  }

  async get(recordId: string, asVersion?: number): Promise<LocalRecord> {
    const record = await this.local.getLocalRecord(recordId);
    if (!record) throw new FormDevError("record_not_found", `Record '${recordId}' not found on this device`);
    if (!asVersion || asVersion === record.schema_version) return record;
    const definitions = await this.schemas.definitions(record.form_id);
    const load = (version: number) => {
      const definition = definitions.get(version);
      if (!definition) throw new FormDevError("version_not_found", `Version ${version} is not installed`);
      return definition;
    };
    return { ...record, data: migrate(record.data, record.schema_version, asVersion, load), schema_version: asVersion, stored_schema_version: record.schema_version, migrated: true };
  }

  async create(formId: string, data: RecordData, status: RecordStatus = "draft"): Promise<LocalRecord> {
    if (status === "deleted") throw new FormDevError("invalid_status", "New records are draft or submitted");
    const version = await this.schemas.latestPublished(formId);
    data = await this.check(version.definition, data, status);
    const at = this.now();
    const user = this.options.user();
    const record: LocalRecord = {
      record_id: this.newId(), form_id: formId, schema_version: version.schema_version, status, data,
      created_at: at, created_by: user, updated_at: at, updated_by: user, sync_id: null, version: 1,
      sync_state: "pending", server_version: 0, index_keys: indexKeysFor(version.definition, { form_id: formId, data }),
    };
    const op: SyncOp = {
      op_id: this.newId(), kind: "create", record_id: record.record_id, form_id: formId, schema_version: record.schema_version,
      base_version: 0, data, status, client_updated_at: at,
    };
    await this.local.writeRecordAndEnqueue(record, null, this.queueItem(op));
    return record;
  }

  private async change(recordId: string, kind: "update" | "submit" | "delete", data: RecordData | null, expectedVersion: number, reason?: string): Promise<LocalRecord> {
    const current = await this.get(recordId);
    if (current.version !== expectedVersion) throw new FormDevError("version_conflict", "The record changed on this device; reload it");
    if (current.status === "deleted") throw new FormDevError("record_deleted", "Deleted records cannot be changed");
    const status: RecordStatus = kind === "delete" ? "deleted" : kind === "submit" ? "submitted" : current.status;
    const definition = (await this.schemas.get(current.form_id, current.schema_version)).definition;
    const nextData = kind === "delete" ? data ?? current.data : await this.check(definition, data ?? current.data, status);
    const at = this.now();
    const record: LocalRecord = {
      ...current, data: nextData, status, updated_at: at, updated_by: this.options.user(), version: current.version + 1,
      sync_state: "pending", index_keys: indexKeysFor(definition, { form_id: current.form_id, data: nextData }),
    };
    const op: SyncOp = {
      op_id: this.newId(), kind, record_id: recordId, form_id: current.form_id, schema_version: current.schema_version,
      base_version: current.version, data: nextData, status, client_updated_at: at, ...(reason ? { reason } : {}),
    };
    await this.local.writeRecordAndEnqueue(record, expectedVersion, this.queueItem(op));
    return record;
  }

  /** Save a draft (or amend a submitted record) while offline or online. `reason`: why a record filled on Flora Leaf
   * is changed (required by the server for those records). */
  update(recordId: string, data: RecordData, expectedVersion: number, reason?: string) {
    return this.change(recordId, "update", data, expectedVersion, reason);
  }

  submit(recordId: string, data: RecordData, expectedVersion: number) {
    return this.change(recordId, "submit", data, expectedVersion);
  }

  remove(recordId: string, expectedVersion: number) {
    return this.change(recordId, "delete", null, expectedVersion);
  }

  async search(query: RecordQuery): Promise<RecordPage<LocalRecord>> {
    const filters = query.filters ?? [];
    if (!filters.length) return this.local.searchLocalRecords(query);
    const fieldsById = fieldMap((await this.schemas.latestPublished(query.formId)).definition);
    const coerced = filters.map(filter => {
      const field = fieldsById.get(filter.field);
      if (!field?.indexed || !INDEXABLE_TYPES.includes(field.type)) throw new FormDevError("field_not_indexed", `Field '${filter.field}' is not indexed`);
      if (!["eq", "prefix", "gte", "lte"].includes(filter.op)) throw new FormDevError("invalid_filter", "Filter op must be eq, prefix, gte or lte");
      return { ...filter, value: filterValue(field, filter.op, filter.value) };
    });
    return this.local.searchLocalRecords({ ...query, filters: coerced });
  }
}
