/**
 * Query validator. Twin of services/flora-api/app/formdev/query/validator.py: the same checks
 * in the same order, with the same issue paths, codes and severities (messages may differ).
 * Both runtimes are run against formdev/spec/fixtures/query-cases.json.
 *
 * Python specifics mirrored here: dict.get() treats a missing key and null alike while
 * `"key" in dict` is presence; numbers exclude booleans and are finite with |x| <= 2**53;
 * len() counts code points; Python patterns end with \\Z (no trailing-newline match), like JS $.
 */
import { QUERY_FAMILY } from "../core/fieldTypes";
import { datetimeEpochMs } from "../core/validate";
import type { PublicQueryCatalog, QueryCatalog, QueryIssue, QueryPolicy, QueryPrincipal } from "./types";

export const QUERY_FORMAT = "flora.query/1";

/** Query family per field type (formdev/spec/field-types.json); mirrors catalog.FIELD_FAMILY. */
export const FIELD_FAMILY: Readonly<Record<string, string>> = QUERY_FAMILY;

type MetaInfo = { column: string; family: string; sortable: boolean; groupable: boolean; order_column?: string };

/** Metadata columns ($name); mirrors catalog.METADATA. */
export const METADATA: Readonly<Record<string, MetaInfo>> = {
  $record_id: { column: "record_id", family: "id", sortable: true, groupable: false },
  $status: { column: "status", family: "status", sortable: false, groupable: true },
  $schema_version: { column: "schema_version", family: "int", sortable: false, groupable: true },
  $version: { column: "version", family: "int", sortable: false, groupable: false },
  $created_at: { column: "created_at", family: "time", sortable: true, groupable: true },
  $updated_at: { column: "updated_at", family: "time", sortable: true, groupable: true },
  $ingested_at: { column: "ingested_at", family: "time", sortable: true, groupable: true, order_column: "ingest_seq" },
  $created_by: { column: "created_by", family: "user", sortable: false, groupable: true },
  $updated_by: { column: "updated_by", family: "user", sortable: false, groupable: true },
  $subject_id: { column: "subject_id", family: "text", sortable: false, groupable: false },
};
export const METADATA_NAMES = Object.keys(METADATA);
export const STABLE_CURSOR_KEYS = ["$ingested_at", "$created_at", "$record_id"] as const;
export const CURSOR_KEYS = [...STABLE_CURSOR_KEYS, "$updated_at"] as const;

export const ADMIN_ROLES = ["system_admin"];
export const QUERY_PERMISSION = "formdev.query";
export const EXPORT_PERMISSION = "formdev.export";
export const MANAGE_PERMISSION = "formdev.manage";

const ALIAS = /^[a-z][a-z0-9_]{0,63}$/;
const NAME = /^(\$[a-z_]+|[a-z][a-z0-9_]{0,63}(\.[a-z][a-z0-9_]{0,63})?)$/;
const RECORD_ID = /^[A-Za-z0-9-]{8,64}$/;
const RECORD_STATUSES = ["draft", "submitted", "deleted"];
const MAX_SAFE = 2 ** 53;
const QUERY_KEYS = new Set(["id", "source", "select", "filter", "sort", "pagination", "limit", "group", "aggregate", "count", "timeout", "cache", "export"]);
const LEAF_KEYS = new Set(["field", "op", "value"]);
const VALUE_OPS = new Set(["eq", "ne", "lt", "lte", "gt", "gte", "in", "between", "prefix"]);
const NULL_OPS = new Set(["is_null", "is_not_null"]);
const RANGE_OPS = ["eq", "ne", "lt", "lte", "gt", "gte", "in", "between"];
const NULLS = ["is_null", "is_not_null"];
const OPS_BY_FAMILY: Record<string, Set<string>> = {
  text: new Set([...RANGE_OPS, "prefix", ...NULLS]),
  num: new Set([...RANGE_OPS, ...NULLS]),
  datetime: new Set([...RANGE_OPS, ...NULLS]),
  bool: new Set(["eq", "ne", ...NULLS]),
  time: new Set(RANGE_OPS),
  int: new Set(RANGE_OPS),
  status: new Set(["eq", "ne", "in"]),
  user: new Set(["eq", "ne", "in"]),
  id: new Set(["eq", "ne", "in"]),
  subject: new Set(["eq", "ne", "in", "prefix", ...NULLS]),
};
const AGG_FNS = new Set(["count", "sum", "avg", "min", "max"]);
const AGG_FAMILIES: Record<string, Set<string>> = {
  sum: new Set(["num", "bool"]), avg: new Set(["num", "bool"]), min: new Set(["num", "datetime"]), max: new Set(["num", "datetime"]),
  count: new Set(["num", "bool", "datetime", "text"]),
};
const BUCKETS: Record<string, number> = { day: 86_400_000 };

// Python semantics helpers ------------------------------------------------------------------
type Obj = Record<string, unknown>;
const isObject = (value: unknown): value is Obj => typeof value === "object" && value !== null && !Array.isArray(value);
const has = (value: Obj, key: string) => Object.prototype.hasOwnProperty.call(value, key);
/** dict.get(key): missing and null are both None. */
const get = (value: Obj, key: string): unknown => (has(value, key) ? value[key] ?? null : null);
/** dict.get(key, default): the default only applies when the key is missing. */
const getOr = (value: Obj, key: string, fallback: unknown): unknown => (has(value, key) ? value[key] ?? null : fallback);
const isNone = (value: unknown) => value === null || value === undefined;
const isNumber = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && Math.abs(value) <= MAX_SAFE;
const isInteger = (value: unknown): value is number => isNumber(value) && Number.isInteger(value);
const pyLen = (text: string) => [...text].length;
// Python patterns end with \Z, so a plain test() is the exact twin.
const pyMatch = (pattern: RegExp, text: string) => pattern.test(text);
const isStr = (value: unknown): value is string => typeof value === "string";

/** Python == for JSON values (True == 1, 1 == 1.0, deep lists and dicts). */
function pyEq(a: unknown, b: unknown): boolean {
  const scalar = (value: unknown) => typeof value === "number" || typeof value === "boolean";
  if (scalar(a) && scalar(b)) return Number(a) === Number(b);
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((item, index) => pyEq(item, b[index]));
  if (isObject(a) && isObject(b)) {
    const keys = Object.keys(a);
    return keys.length === Object.keys(b).length && keys.every(key => has(b, key) && pyEq(a[key], b[key]));
  }
  return a === b;
}

/** sorted() on str: code point order. */
function pyCompare(a: string, b: string): number {
  const x = [...a];
  const y = [...b];
  for (let index = 0; index < Math.min(x.length, y.length); index += 1) {
    const diff = (x[index].codePointAt(0) ?? 0) - (y[index].codePointAt(0) ?? 0);
    if (diff) return diff;
  }
  return x.length - y.length;
}

// Principal and catalog ----------------------------------------------------------------------
export function isAdmin(principal: QueryPrincipal): boolean {
  return (principal.roles ?? []).some(role => ADMIN_ROLES.includes(role)) || (principal.permissions ?? []).includes(MANAGE_PERMISSION);
}

export function hasPermission(principal: QueryPrincipal, permission: string): boolean {
  return isAdmin(principal) || (principal.permissions ?? []).includes(permission);
}

/** null = no restriction; administrators pass every list. */
export function allowed(principal: QueryPrincipal, codes: string[] | null | undefined): boolean {
  if (codes === null || codes === undefined) return true;
  const own = new Set([...(principal.roles ?? []), ...(principal.permissions ?? [])]);
  return isAdmin(principal) || codes.some(code => own.has(code));
}

type CatalogField = { type: string; indexed: boolean; state: string | null; access: Array<string[] | null> };
type Catalog = {
  sourceId: string;
  formId: string;
  fields: Map<string, CatalogField>;
  queryAccess: Array<string[] | null>;
  exportAccess: Array<string[] | null>;
  metadataAccess: Map<string, Array<string[] | null>>;
  metadataBuilding: Set<string>;
  relations: Map<string, { local: string; foreign: string; target: Catalog }>;
};

/** catalog_from_dict(). */
function normalizeCatalog(value: QueryCatalog): Catalog {
  const fields = new Map<string, CatalogField>();
  for (const [id, info] of Object.entries(value.fields)) {
    const indexed = !!info.indexed;
    fields.set(id, {
      type: info.type, indexed,
      state: info.state !== undefined ? info.state : indexed ? "ready" : null,
      access: isNone(info.access) ? [] : [info.access as string[]],
    });
  }
  const relations = new Map<string, { local: string; foreign: string; target: Catalog }>();
  for (const [name, relation] of Object.entries(value.relations ?? {})) relations.set(name, { local: relation.local, foreign: relation.foreign, target: normalizeCatalog(relation.target) });
  return {
    sourceId: value.source_id, formId: value.form_id ?? value.source_id, fields,
    queryAccess: isNone(value.query_access) ? [] : [value.query_access as string[]],
    exportAccess: isNone(value.export_access) ? [] : [value.export_access as string[]],
    metadataAccess: new Map(Object.entries(value.metadata_access ?? {}).map(([name, codes]) => [name, [codes]])),
    metadataBuilding: new Set(value.metadata_building ?? []),
    relations,
  };
}

const canQuery = (catalog: Catalog, principal: QueryPrincipal) => hasPermission(principal, QUERY_PERMISSION) && catalog.queryAccess.every(codes => allowed(principal, codes));

function canRead(catalog: Catalog, principal: QueryPrincipal, name: string): boolean {
  const lists = name.startsWith("$") ? catalog.metadataAccess.get(name) ?? [] : catalog.fields.get(name)?.access ?? [];
  return lists.every(codes => allowed(principal, codes));
}

/** True when the principal may export from the catalog (SourceCatalog.can_export). */
export function canExport(catalog: QueryCatalog, principal: QueryPrincipal): boolean {
  const normalized = normalizeCatalog(catalog);
  return hasPermission(principal, EXPORT_PERMISSION) && canQuery(normalized, principal) && normalized.exportAccess.every(codes => allowed(principal, codes));
}

/**
 * Turn the catalog the server serves (already filtered for the caller) into the validator's
 * input. Metadata columns the caller may not read are closed with an empty access list.
 */
export function catalogFromPublic(value: PublicQueryCatalog): QueryCatalog {
  const visible = new Set(value.metadata);
  return {
    source_id: value.source_id, form_id: value.form_id, title: value.title, schema_version: value.schema_version,
    fields: Object.fromEntries(Object.entries(value.fields).map(([id, info]) => [id, { ...info, access: null }])),
    metadata_access: Object.fromEntries(METADATA_NAMES.filter(name => !visible.has(name)).map(name => [name, []])),
    metadata_building: value.metadata_building ?? [],
    relations: Object.fromEntries(Object.entries(value.relations ?? {}).map(([name, relation]) => [name, {
      local: relation.local, foreign: relation.foreign,
      target: { source_id: relation.source_id, fields: Object.fromEntries(Object.entries(relation.fields).map(([id, info]) => [id, { type: info.type, label: info.label }])) },
    }])),
  };
}

// Context --------------------------------------------------------------------------------------
type Ctx = { catalog: Catalog | null; principal: QueryPrincipal; policy: QueryPolicy; issues: QueryIssue[]; leaves: number; values: number };

const error = (ctx: Ctx, path: string, code: string, message: string) => { ctx.issues.push({ path, code, message, severity: "error" }); };
const warn = (ctx: Ctx, path: string, code: string, message: string) => { ctx.issues.push({ path, code, message, severity: "warning" }); };

type Ref = { kind: "field" | "relation" | "meta"; name: string; family: string; type?: string; indexed?: boolean; state?: string | null; relation?: string; field?: string; column?: string };

function scanDangerous(value: unknown, path: string, ctx: Ctx, depth = 0): void {
  if (depth > 12) {
    error(ctx, path, "dangerous_operation", "Query is nested too deeply");
    return;
  }
  if (isStr(value)) {
    if (value.includes("\x00")) error(ctx, path, "dangerous_operation", "NUL characters are not allowed");
    else if (pyLen(value) > ctx.policy.max_string_length && !path.endsWith(".cursor")) error(ctx, path, "invalid_value", `Text values are limited to ${ctx.policy.max_string_length} characters`);
  } else if (isObject(value)) {
    for (const [key, item] of Object.entries(value)) scanDangerous(item, `${path}.${key}`, ctx, depth + 1);
  } else if (Array.isArray(value)) {
    value.forEach((item, index) => scanDangerous(item, `${path}[${index}]`, ctx, depth + 1));
  }
}

function unknownKeys(value: Obj, allowedKeys: Set<string>, path: string, ctx: Ctx): void {
  for (const key of Object.keys(value).filter(key => !allowedKeys.has(key)).sort(pyCompare)) {
    error(ctx, `${path}.${key}`, "dangerous_operation", `Unsupported key '${key}' (raw SQL and unknown clauses are not accepted)`);
  }
}

function distance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    let previous = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const current = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, previous + (a[i - 1] === b[j - 1] ? 0 : 1));
      previous = current;
    }
  }
  return row[b.length];
}

/** Message hint only (the server uses difflib); never changes codes or paths. */
function suggest(name: string, ctx: Ctx): string {
  const catalog = ctx.catalog;
  if (!catalog) return "";
  const choices = [...catalog.fields.keys(), ...METADATA_NAMES].filter(choice => canRead(catalog, ctx.principal, choice));
  let best: string | null = null;
  let bestScore = 0.6;
  for (const choice of choices) {
    const score = 1 - distance(name, choice) / Math.max(name.length, choice.length, 1);
    if (score >= bestScore && (best === null || score > bestScore)) {
      best = choice;
      bestScore = score;
    }
  }
  return best ? ` Did you mean '${best}'?` : "";
}

function resolve(name: unknown, path: string, ctx: Ctx, allowRelation = false): Ref | null {
  const catalog = ctx.catalog;
  if (!catalog) return null;
  if (!isStr(name) || !pyMatch(NAME, name)) {
    error(ctx, path, "invalid_field", "Field references are field ids, $metadata names or relation.field");
    return null;
  }
  if (name.includes(".")) {
    const split = name.indexOf(".");
    const relationName = name.slice(0, split);
    const fieldId = name.slice(split + 1);
    const relation = catalog.relations.get(relationName);
    if (!relation || !canQuery(relation.target, ctx.principal)) {
      error(ctx, path, "invalid_relation", `Unknown relation '${relationName}'`);
      return null;
    }
    if (!allowRelation) {
      error(ctx, path, "invalid_relation", "Relation fields can only be selected");
      return null;
    }
    const target = relation.target;
    const info = target.fields.get(fieldId);
    if (!info) {
      error(ctx, path, "invalid_field", `Relation '${relationName}' has no field '${fieldId}'`);
      return null;
    }
    if (!canRead(target, ctx.principal, fieldId)) {
      error(ctx, path, "unauthorized_field", `You may not read '${name}'`);
      return null;
    }
    return { kind: "relation", name, relation: relationName, field: fieldId, family: FIELD_FAMILY[info.type] ?? "text", type: info.type };
  }
  const info = catalog.fields.get(name);
  if (info) {
    if (!canRead(catalog, ctx.principal, name)) {
      error(ctx, path, "unauthorized_field", `You may not read '${name}'`);
      return null;
    }
    return { kind: "field", name, field: name, type: info.type, family: FIELD_FAMILY[info.type] ?? "text", indexed: info.indexed, state: info.state };
  }
  const metaName = name.startsWith("$") ? name : `$${name}`;
  if (has(METADATA, metaName)) {
    if (!canRead(catalog, ctx.principal, metaName)) {
      error(ctx, path, "unauthorized_field", `You may not read '${metaName}'`);
      return null;
    }
    const meta = METADATA[metaName];
    const ref: Ref = { kind: "meta", name: metaName, column: meta.column, family: metaName === "$subject_id" ? "subject" : meta.family };
    if (catalog.metadataBuilding.has(metaName)) ref.state = "building";
    return ref;
  }
  error(ctx, path, "invalid_field", `Unknown field '${name}'.${suggest(name, ctx)}`);
  return null;
}

function requireIndex(ref: Ref, path: string, ctx: Ctx, purpose: string): boolean {
  if (ref.kind !== "field") {
    if (ref.state !== "building") return true;
    error(ctx, path, "index_building", `'${ref.name}' is being rebuilt; try again shortly`); // $subject_id while it is backfilled
    return false;
  }
  if (ref.family === "longtext" || ref.family === "multi") {
    error(ctx, path, "not_filterable", `${ref.type} fields cannot be used to ${purpose}`);
    return false;
  }
  if (!ref.indexed) {
    error(ctx, path, "not_filterable", `Field '${ref.name}' is not indexed; an administrator can index it to ${purpose}`);
    return false;
  }
  if (ref.state === "building") {
    error(ctx, path, "index_building", `The index for '${ref.name}' is being rebuilt; try again shortly`);
    return false;
  }
  return true;
}

const INVALID = Symbol("invalid");
type Typed = string | number | boolean | typeof INVALID;

function typedValue(ref: Ref, value: unknown, path: string, ctx: Ctx): Typed {
  const family = ref.family;
  if (family === "text" || family === "user" || family === "subject") {
    if (isStr(value)) return value;
  } else if (family === "num") {
    if (isNumber(value)) return value;
  } else if (family === "int") {
    if (isInteger(value)) return value;
  } else if (family === "bool") {
    if (typeof value === "boolean") return value;
  } else if (family === "datetime" || family === "time") {
    if (isStr(value)) {
      const epoch = datetimeEpochMs(value);
      if (epoch !== null) return epoch;
    } else if (isInteger(value)) return value;
  } else if (family === "status") {
    if (isStr(value) && RECORD_STATUSES.includes(value)) return value;
  } else if (family === "id") {
    if (isStr(value) && pyMatch(RECORD_ID, value)) return value;
  }
  error(ctx, path, "invalid_value", `Value does not match the type of '${ref.name}'`);
  return INVALID;
}

type Leaf = { leaf: true; ref: Ref; op: string; values: Typed[] };
type Node = Leaf | { leaf?: false; op: "not"; arg: Node } | { leaf?: false; op: "and" | "or"; args: Node[] };

function leaf(node: Obj, path: string, ctx: Ctx): Leaf | null {
  unknownKeys(node, LEAF_KEYS, path, ctx);
  ctx.leaves += 1;
  const ref = resolve(get(node, "field"), `${path}.field`, ctx);
  const op = get(node, "op");
  if (!isStr(op) || !(VALUE_OPS.has(op) || NULL_OPS.has(op))) {
    error(ctx, `${path}.op`, "invalid_operator", `Unknown operator '${String(op)}'`);
    return null;
  }
  if (!ref) return null;
  const ops = OPS_BY_FAMILY[ref.family];
  if (!ops || !ops.has(op)) {
    if (ref.kind === "field" && (ref.family === "longtext" || ref.family === "multi")) requireIndex(ref, `${path}.field`, ctx, "filter");
    else error(ctx, `${path}.op`, "invalid_operator", `Operator '${op}' does not apply to '${ref.name}'`);
    return null;
  }
  if (!requireIndex(ref, `${path}.field`, ctx, "filter")) return null;
  if (NULL_OPS.has(op)) {
    if (has(node, "value")) error(ctx, `${path}.value`, "invalid_value", `'${op}' takes no value`);
    return { leaf: true, ref, op, values: [] };
  }
  if (!has(node, "value")) {
    error(ctx, `${path}.value`, "invalid_value", `'${op}' needs a value`);
    return null;
  }
  const raw = node.value ?? null;
  let values: Typed[];
  if (op === "in") {
    if (!Array.isArray(raw) || !raw.length) {
      error(ctx, `${path}.value`, "invalid_value", "'in' needs a non-empty list");
      return null;
    }
    if (raw.length > ctx.policy.max_in_values) {
      error(ctx, `${path}.value`, "too_many_values", `'in' accepts at most ${ctx.policy.max_in_values} values`);
      return null;
    }
    values = raw.map((item, index) => typedValue(ref, item, `${path}.value[${index}]`, ctx));
  } else if (op === "between") {
    if (!Array.isArray(raw) || raw.length !== 2) {
      error(ctx, `${path}.value`, "invalid_value", "'between' needs [low, high]");
      return null;
    }
    values = raw.map((item, index) => typedValue(ref, item, `${path}.value[${index}]`, ctx));
  } else {
    values = [typedValue(ref, raw, `${path}.value`, ctx)];
    if (op === "prefix" && isStr(raw) && pyLen(raw) < ctx.policy.min_prefix_length) error(ctx, `${path}.value`, "invalid_value", `prefix needs at least ${ctx.policy.min_prefix_length} character(s)`);
  }
  ctx.values += values.length;
  if (ref.kind === "meta" && ref.family === "status" && values.includes("deleted") && op !== "ne" && !isAdmin(ctx.principal)) {
    error(ctx, `${path}.value`, "deleted_requires_admin", "Only administrators can query deleted records");
  }
  if (values.includes(INVALID)) return null;
  return { leaf: true, ref, op, values };
}

function filter(node: unknown, path: string, ctx: Ctx, depth = 1): Node | null {
  if (!isObject(node)) {
    error(ctx, path, "invalid_filter", "A filter is an object");
    return null;
  }
  if (depth > ctx.policy.max_filter_depth) {
    error(ctx, path, "filter_too_complex", `Filters may nest at most ${ctx.policy.max_filter_depth} levels`);
    return null;
  }
  const groups = (["and", "or", "not"] as const).filter(key => has(node, key));
  if (!groups.length) return leaf(node, path, ctx);
  if (Object.keys(node).length !== 1) {
    unknownKeys(node, new Set([groups[0]]), path, ctx);
    return null;
  }
  const key = groups[0];
  if (key === "not") {
    const child = filter(node.not, `${path}.not`, ctx, depth + 1);
    return child ? { op: "not", arg: child } : null;
  }
  const items = node[key];
  if (!Array.isArray(items) || !items.length) {
    error(ctx, `${path}.${key}`, "invalid_filter", `'${key}' needs a non-empty list`);
    return null;
  }
  const children = items.map((item, index) => filter(item, `${path}.${key}[${index}]`, ctx, depth + 1));
  if (key === "and") {
    const indexTerms = children.filter(child => child && child.leaf && child.ref.kind === "field").length;
    if (indexTerms > ctx.policy.max_index_terms_per_and) error(ctx, `${path}.and`, "filter_too_complex", `At most ${ctx.policy.max_index_terms_per_and} indexed-field conditions per 'and'`);
  }
  if (children.some(child => child === null)) return null;
  return { op: key, args: children as Node[] };
}

type Page = { mode?: string; limit?: number; offset?: number; cursor?: string | null };

function pagination(query: Obj, ctx: Ctx, grouped: boolean): Page {
  const policy = ctx.policy;
  let raw = get(query, "pagination");
  const aliasLimit = get(query, "limit");
  if (raw === null && aliasLimit === null) {
    if (grouped) return { mode: "none", limit: policy.max_groups, offset: 0, cursor: null };
    error(ctx, "$.query.pagination", "missing_limit", "List queries need pagination with a limit");
    return {};
  }
  if (raw === null) raw = { mode: grouped ? "offset" : "cursor", limit: aliasLimit };
  if (!isObject(raw)) {
    error(ctx, "$.query.pagination", "invalid_pagination", "pagination is an object");
    return {};
  }
  unknownKeys(raw, new Set(["mode", "limit", "offset", "cursor"]), "$.query.pagination", ctx);
  const mode = getOr(raw, "mode", grouped ? "offset" : "cursor");
  if (mode !== "cursor" && mode !== "offset") {
    error(ctx, "$.query.pagination.mode", "invalid_pagination", "mode is cursor or offset");
    return {};
  }
  if (grouped && mode === "cursor") {
    error(ctx, "$.query.pagination.mode", "cursor_not_supported_for_group", "Grouped results page with offset");
    return {};
  }
  const limit = getOr(raw, "limit", aliasLimit);
  if (aliasLimit !== null && get(raw, "limit") !== null && !pyEq(aliasLimit, get(raw, "limit"))) error(ctx, "$.query.limit", "invalid_pagination", "limit and pagination.limit disagree");
  const cap = grouped ? policy.max_groups : policy.max_page_rows;
  if (limit === null) {
    error(ctx, "$.query.pagination.limit", "missing_limit", "pagination.limit is required");
    return {};
  }
  if (!isInteger(limit) || limit < 1) {
    error(ctx, "$.query.pagination.limit", "invalid_pagination", "limit is a positive integer");
    return {};
  }
  if (limit > cap) error(ctx, "$.query.pagination.limit", "limit_exceeded", `At most ${cap} rows per page; use an export job for more`);
  let offset = getOr(raw, "offset", 0);
  if (mode === "cursor" && has(raw, "offset")) error(ctx, "$.query.pagination.offset", "invalid_pagination", "Cursor pagination does not take an offset");
  if (!isInteger(offset) || offset < 0) {
    error(ctx, "$.query.pagination.offset", "invalid_pagination", "offset is a non-negative integer");
    offset = 0;
  } else if (offset > policy.max_offset) {
    error(ctx, "$.query.pagination.offset", "offset_exceeded", `offset is limited to ${policy.max_offset}; use cursor pagination`);
  }
  let cursor = get(raw, "cursor");
  if (cursor !== null && (mode !== "cursor" || !isStr(cursor) || pyLen(cursor) > 2048)) {
    error(ctx, "$.query.pagination.cursor", "invalid_cursor", "cursor is an opaque string from a previous page");
    cursor = null;
  }
  return { mode, limit, offset: offset as number, cursor: cursor as string | null };
}

function sort(query: Obj, ctx: Ctx, page: Page, groupedNames: Set<string> | null): void {
  const raw = get(query, "sort");
  if (raw === null) {
    if (groupedNames !== null) return;
    resolve("$ingested_at", "$.query.sort", ctx);
    return;
  }
  if (!Array.isArray(raw)) {
    error(ctx, "$.query.sort", "invalid_sort", "sort is a list of {field, dir}");
    return;
  }
  if (raw.length > ctx.policy.max_sort_keys && groupedNames === null) {
    error(ctx, "$.query.sort", "invalid_sort", `At most ${ctx.policy.max_sort_keys} sort key (record id breaks ties)`);
    return;
  }
  raw.forEach((item: unknown, index) => {
    const path = `$.query.sort[${index}]`;
    if (!isObject(item)) {
      error(ctx, path, "invalid_sort", "sort entries are objects");
      return;
    }
    unknownKeys(item, new Set(["field", "dir"]), path, ctx);
    const direction = getOr(item, "dir", "asc");
    if (direction !== "asc" && direction !== "desc") {
      error(ctx, `${path}.dir`, "invalid_sort", "dir is asc or desc");
      return;
    }
    const name = get(item, "field");
    if (groupedNames !== null) {
      if (!isStr(name) || !groupedNames.has(name)) error(ctx, `${path}.field`, "sort_not_grouped", "Sort grouped results by a group key or aggregate alias");
      return;
    }
    const ref = resolve(name, `${path}.field`, ctx);
    if (!ref) return;
    if (page.mode === "cursor") {
      if (!(CURSOR_KEYS as readonly string[]).includes(ref.name)) {
        error(ctx, `${path}.field`, "cursor_requires_stable_sort", `Cursor pagination sorts by ${CURSOR_KEYS.join(", ")}; use offset pagination to sort by other fields`);
        return;
      }
      if (!(STABLE_CURSOR_KEYS as readonly string[]).includes(ref.name)) warn(ctx, `${path}.field`, "cursor_not_snapshot_stable", "Records edited while paging may move between pages");
    } else if (ref.kind === "meta") {
      if (!METADATA[ref.name].sortable) error(ctx, `${path}.field`, "invalid_sort", `'${ref.name}' cannot be sorted`);
    } else {
      const sortable = ["text", "num", "datetime", "bool"].includes(ref.family);
      if (!sortable || !requireIndex(ref, `${path}.field`, ctx, "sort")) {
        if (!sortable) error(ctx, `${path}.field`, "invalid_sort", `'${ref.name}' cannot be sorted`);
      }
    }
  });
}

function group(query: Obj, ctx: Ctx): string[] {
  const raw = get(query, "group");
  if (raw === null) return [];
  if (!Array.isArray(raw) || !raw.length) {
    error(ctx, "$.query.group", "aggregate_invalid", "group is a non-empty list");
    return [];
  }
  if (raw.length > ctx.policy.max_group_keys) {
    error(ctx, "$.query.group", "too_many_groups", `Group by at most ${ctx.policy.max_group_keys} keys`);
    return [];
  }
  const names: string[] = [];
  raw.forEach((item: unknown, index) => {
    const path = `$.query.group[${index}]`;
    const spec = isStr(item) ? { field: item } : item;
    if (!isObject(spec)) {
      error(ctx, path, "aggregate_invalid", "group keys are names or {field, bucket}");
      return;
    }
    unknownKeys(spec, new Set(["field", "bucket", "tz_offset_minutes"]), path, ctx);
    const ref = resolve(get(spec, "field"), isStr(item) ? path : `${path}.field`, ctx);
    if (!ref) return;
    const bucket = get(spec, "bucket");
    const offset = getOr(spec, "tz_offset_minutes", 420);
    if (bucket !== null && (!isStr(bucket) || !has(BUCKETS, bucket) || ref.kind !== "meta" || ref.family !== "time")) {
      error(ctx, `${path}.bucket`, "aggregate_invalid", "bucket 'day' applies to $created_at, $updated_at and $ingested_at");
      return;
    }
    if (typeof offset !== "number" || !Number.isInteger(offset) || Math.abs(offset) > 14 * 60) {
      error(ctx, `${path}.tz_offset_minutes`, "aggregate_invalid", "tz_offset_minutes is an integer within ±840");
      return;
    }
    if (ref.kind === "meta") {
      if (!METADATA[ref.name].groupable || (ref.family === "time" && bucket === null)) {
        error(ctx, path, "aggregate_invalid", `Group by '${ref.name}'${ref.family === "time" ? " needs bucket 'day'" : " is not supported"}`);
        return;
      }
    } else {
      const groupable = ["text", "num", "bool"].includes(ref.family);
      if (!groupable || !requireIndex(ref, path, ctx, "group")) {
        if (!groupable) error(ctx, path, "aggregate_invalid", `Group by '${ref.name}' is not supported`);
        return;
      }
    }
    names.push(bucket ? `${ref.name}_${String(bucket)}` : ref.name);
  });
  return names;
}

function aggregates(query: Obj, ctx: Ctx, groupNames: Set<string>): string[] {
  const raw = get(query, "aggregate");
  if (raw === null) return [];
  if (!Array.isArray(raw) || !raw.length) {
    error(ctx, "$.query.aggregate", "aggregate_invalid", "aggregate is a non-empty list");
    return [];
  }
  if (raw.length > ctx.policy.max_aggregates) {
    error(ctx, "$.query.aggregate", "aggregate_invalid", `At most ${ctx.policy.max_aggregates} aggregates`);
    return [];
  }
  const out: string[] = [];
  const aliases = new Set<string>();
  raw.forEach((item: unknown, index) => {
    const path = `$.query.aggregate[${index}]`;
    if (!isObject(item)) {
      error(ctx, path, "aggregate_invalid", "aggregates are objects");
      return;
    }
    unknownKeys(item, new Set(["fn", "field", "as"]), path, ctx);
    const fn = get(item, "fn");
    const alias = get(item, "as");
    if (!isStr(fn) || !AGG_FNS.has(fn)) {
      error(ctx, `${path}.fn`, "aggregate_invalid", `fn is one of ${[...AGG_FNS].sort().join(", ")}`);
      return;
    }
    if (!isStr(alias) || !pyMatch(ALIAS, alias) || aliases.has(alias) || groupNames.has(alias)) {
      error(ctx, `${path}.as`, "invalid_alias", "as is a unique lower_snake_case name");
      return;
    }
    aliases.add(alias);
    if (has(item, "field")) {
      const ref = resolve(item.field ?? null, `${path}.field`, ctx);
      if (!ref) return;
      if (ref.kind !== "field" || !AGG_FAMILIES[fn].has(ref.family)) {
        error(ctx, `${path}.field`, "aggregate_invalid", `${fn} does not apply to '${ref.name}'`);
        return;
      }
      if (!requireIndex(ref, `${path}.field`, ctx, "aggregate")) return;
    } else if (fn !== "count") {
      error(ctx, `${path}.field`, "aggregate_invalid", `${fn} needs a field`);
      return;
    }
    out.push(alias);
  });
  return out;
}

function timeout(query: Obj, ctx: Ctx): void {
  const bounds = ctx.policy.timeout_ms;
  const raw = get(query, "timeout");
  if (raw === null) return;
  if (!isInteger(raw) || raw < 1) error(ctx, "$.query.timeout", "invalid_timeout", "timeout is a positive number of milliseconds");
  else if (raw > bounds.max) warn(ctx, "$.query.timeout", "timeout_clamped", `timeout reduced to ${bounds.max} ms`);
}

function cache(query: Obj, ctx: Ctx): void {
  const bounds = ctx.policy.cache_ttl_s;
  const raw = get(query, "cache");
  if (raw === null || raw === false) return;
  if (!isObject(raw) || Object.keys(raw).some(key => key !== "ttl") || !isNumber(get(raw, "ttl")) || (raw.ttl as number) < 0) {
    error(ctx, "$.query.cache", "invalid_cache", "cache is false or {ttl: seconds}");
    return;
  }
  if ((raw.ttl as number) > bounds.max) warn(ctx, "$.query.cache.ttl", "cache_ttl_clamped", `cache ttl reduced to ${bounds.max} s`);
}

function exportOptions(query: Obj, ctx: Ctx): void {
  const raw = get(query, "export");
  if (raw === null) return;
  if (!isObject(raw)) {
    error(ctx, "$.query.export", "invalid_export", "export is an object");
    return;
  }
  unknownKeys(raw, new Set(["format", "headers", "max_rows"]), "$.query.export", ctx);
  const format = getOr(raw, "format", "csv");
  const headers = getOr(raw, "headers", "ids");
  if (!["csv", "jsonl", "json"].includes(format as string) || !["ids", "labels"].includes(headers as string)) {
    error(ctx, "$.query.export", "invalid_export", "format is csv, jsonl or json; headers is ids or labels");
    return;
  }
  const limits = ctx.policy.export_max_rows;
  const cap = isAdmin(ctx.principal) ? limits["formdev.manage"] : limits.default;
  const maxRows = getOr(raw, "max_rows", cap);
  if (!isInteger(maxRows) || maxRows < 1) {
    error(ctx, "$.query.export.max_rows", "invalid_export", "max_rows is a positive integer");
    return;
  }
  if (maxRows > cap) error(ctx, "$.query.export.max_rows", "export_limit_exceeded", `Your export limit is ${cap} rows`);
}

/**
 * Validate a flora.query/1 request against a catalog (null = the source is unknown or hidden).
 * Returns every issue; the query may run when none has severity "error".
 */
export function validateQuery(body: unknown, catalog: QueryCatalog | null, principal: QueryPrincipal, policy: QueryPolicy): QueryIssue[] {
  const normalized = catalog ? normalizeCatalog(catalog) : null;
  const ctx: Ctx = { catalog: normalized, principal, policy, issues: [], leaves: 0, values: 0 };
  if (!isObject(body) || !isObject(body.query)) {
    error(ctx, "$", "invalid_request", "Body must be {\"query\": {...}}");
    return ctx.issues;
  }
  unknownKeys(body, new Set(["format", "query"]), "$", ctx);
  if (has(body, "format") && body.format !== QUERY_FORMAT) error(ctx, "$.format", "invalid_format", `format must be '${QUERY_FORMAT}'`);
  const query = body.query;
  scanDangerous(query, "$.query", ctx);
  unknownKeys(query, QUERY_KEYS, "$.query", ctx);
  if (has(query, "id") && (!isStr(query.id) || !pyMatch(ALIAS, query.id) || pyLen(query.id) < 2)) error(ctx, "$.query.id", "invalid_value", "id is a lower_snake_case name");
  if (!normalized || normalized.sourceId !== get(query, "source") || !canQuery(normalized, principal)) {
    error(ctx, "$.query.source", "unknown_source", "Unknown source");
    return ctx.issues;
  }

  const groupNames = group(query, ctx);
  const aggregateAliases = aggregates(query, ctx, new Set(groupNames));
  const grouped = groupNames.length > 0 || has(query, "group") || aggregateAliases.length > 0 || has(query, "aggregate");
  if (has(query, "filter")) filter(query.filter ?? null, "$.query.filter", ctx);
  if (ctx.leaves > policy.max_filter_leaves) error(ctx, "$.query.filter", "filter_too_complex", `At most ${policy.max_filter_leaves} conditions`);
  if (ctx.values > policy.max_total_values) error(ctx, "$.query.filter", "too_many_values", `At most ${policy.max_total_values} values across the filter`);
  const page = pagination(query, ctx, grouped);

  const rawSelect = get(query, "select");
  if (grouped) {
    const names = new Set([...groupNames, ...aggregateAliases]);
    if (rawSelect !== null) {
      if (!Array.isArray(rawSelect) || !rawSelect.every(isStr) || !rawSelect.every(name => names.has(name))) {
        error(ctx, "$.query.select", "select_not_grouped", "Grouped queries select only group keys and aggregate aliases");
      }
    }
    sort(query, ctx, page, names);
  } else {
    if (rawSelect === null || (Array.isArray(rawSelect) && rawSelect.length === 0)) {
      error(ctx, "$.query.select", "missing_select", "List the fields to return");
    } else if (rawSelect === "*" || (Array.isArray(rawSelect) && rawSelect.includes("*"))) {
      error(ctx, "$.query.select", "select_star_not_allowed", "SELECT * is not allowed; list the fields you need");
    } else if (!Array.isArray(rawSelect)) {
      error(ctx, "$.query.select", "missing_select", "select is a list of field names");
    } else {
      if (rawSelect.length > policy.max_select_fields) error(ctx, "$.query.select", "too_many_fields", `At most ${policy.max_select_fields} fields`);
      rawSelect.forEach((name: unknown, index) => resolve(name, `$.query.select[${index}]`, ctx, true));
    }
    sort(query, ctx, page, null);
    if (!has(query, "filter")) warn(ctx, "$.query.filter", "missing_filter", "No filter: results are paged over the whole source");
  }
  const count = getOr(query, "count", "none");
  if (count !== "none" && count !== "capped") error(ctx, "$.query.count", "invalid_value", "count is none or capped");
  timeout(query, ctx);
  cache(query, ctx);
  exportOptions(query, ctx);
  return ctx.issues;
}

/** True when no issue is an error. */
export function isRunnable(issues: QueryIssue[]): boolean {
  return !issues.some(issue => issue.severity === "error");
}
