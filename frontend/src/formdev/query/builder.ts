/**
 * Query builders. Both produce a flora.query/1 body (JSON data, never SQL):
 *  - a fluent builder for code: query("patient_list").from("patient_assessment").select("hn").where(eq("fall_risk", "yes")).cursor(50).build()
 *  - a pure reducer for the visual builder UI (builderReducer + stateToQuery).
 */
import type { JsonValue } from "../core/types";
import type { Aggregate, AggregateFn, ExportOptions, Filter, FilterLeaf, FilterOp, GroupKey, QueryBody, QueryDefinition, QueryPrincipal, SortKey } from "./types";
import { FIELD_FAMILY, isAdmin, METADATA, QUERY_FORMAT } from "./validate";

// Filter helpers ------------------------------------------------------------------------------
const leaf = (field: string, op: FilterOp, value?: JsonValue): FilterLeaf => (value === undefined ? { field, op } : { field, op, value });

export const eq = (field: string, value: JsonValue) => leaf(field, "eq", value);
export const ne = (field: string, value: JsonValue) => leaf(field, "ne", value);
export const lt = (field: string, value: JsonValue) => leaf(field, "lt", value);
export const lte = (field: string, value: JsonValue) => leaf(field, "lte", value);
export const gt = (field: string, value: JsonValue) => leaf(field, "gt", value);
export const gte = (field: string, value: JsonValue) => leaf(field, "gte", value);
export const inList = (field: string, values: JsonValue[]) => leaf(field, "in", [...values]);
export const between = (field: string, low: JsonValue, high: JsonValue) => leaf(field, "between", [low, high]);
export const prefix = (field: string, text: string) => leaf(field, "prefix", text);
export const isNull = (field: string) => leaf(field, "is_null");
export const isNotNull = (field: string) => leaf(field, "is_not_null");
/** and()/or() need at least one filter (the validator rejects an empty list); one filter is returned as is, like the reducer does. */
function combine(combinator: "and" | "or", filters: Filter[]): Filter {
  if (!filters.length) throw new Error(`${combinator}() needs at least one filter`);
  return filters.length === 1 ? filters[0] : combinator === "and" ? { and: [...filters] } : { or: [...filters] };
}
export const and = (...filters: Filter[]): Filter => combine("and", filters);
export const or = (...filters: Filter[]): Filter => combine("or", filters);
export const not = (filter: Filter): Filter => ({ not: filter });

// Aggregate helpers ---------------------------------------------------------------------------
/** count(alias) counts rows; count(alias, field) counts rows where field is set. */
export const count = (as: string, field?: string): Aggregate => (field === undefined ? { fn: "count", as } : { fn: "count", field, as });
export const sum = (field: string, as: string): Aggregate => ({ fn: "sum", field, as });
export const avg = (field: string, as: string): Aggregate => ({ fn: "avg", field, as });
export const min = (field: string, as: string): Aggregate => ({ fn: "min", field, as });
export const max = (field: string, as: string): Aggregate => ({ fn: "max", field, as });

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

// Fluent builder ------------------------------------------------------------------------------
export class QueryBuilder {
  private readonly draft: Partial<QueryDefinition> & { source?: string };

  constructor(id?: string) {
    this.draft = id === undefined ? {} : { id };
  }

  from(source: string): this {
    this.draft.source = source;
    return this;
  }

  select(...fields: string[]): this {
    this.draft.select = [...(this.draft.select ?? []), ...fields];
    return this;
  }

  /** Replaces the filter; combine conditions with and()/or()/not(). */
  where(filter: Filter): this {
    this.draft.filter = filter;
    return this;
  }

  orderBy(field: string, dir: "asc" | "desc" = "asc"): this {
    const key: SortKey = { field, dir };
    this.draft.sort = [key];
    return this;
  }

  /** Keyset pagination; pass the previous page's next_cursor to continue. */
  cursor(limit: number, cursor?: string | null): this {
    this.draft.pagination = cursor ? { mode: "cursor", limit, cursor } : { mode: "cursor", limit };
    return this;
  }

  /** Offset pagination: limit rows starting at offset. */
  offset(limit: number, offset = 0): this {
    this.draft.pagination = { mode: "offset", limit, offset };
    return this;
  }

  groupBy(...keys: GroupKey[]): this {
    this.draft.group = [...(this.draft.group ?? []), ...keys];
    return this;
  }

  aggregate(...aggregates: Aggregate[]): this {
    this.draft.aggregate = [...(this.draft.aggregate ?? []), ...aggregates];
    return this;
  }

  /** Ask for a capped total row count. */
  withCount(capped = true): this {
    this.draft.count = capped ? "capped" : "none";
    return this;
  }

  timeout(ms: number): this {
    this.draft.timeout = ms;
    return this;
  }

  /** Seconds to cache the result, or false to bypass the cache. */
  cache(ttl: number | false): this {
    this.draft.cache = ttl === false ? false : { ttl };
    return this;
  }

  export(options: ExportOptions = {}): this {
    this.draft.export = { ...options };
    return this;
  }

  build(): QueryBody {
    if (!this.draft.source) throw new Error("query: call .from(source) before .build()");
    return { format: QUERY_FORMAT, query: clone(this.draft as QueryDefinition) };
  }
}

export const query = (id?: string) => new QueryBuilder(id);

// Visual builder state ------------------------------------------------------------------------
export type Combinator = "and" | "or";
export type BuilderCondition = { field: string; op: FilterOp; value?: JsonValue };
export type BuilderConditionGroup = { combinator: Combinator; conditions: BuilderCondition[] };
export type BuilderSort = { field: string; dir: "asc" | "desc" };
export type BuilderAggregate = { fn: AggregateFn; field?: string; as: string };

/** Condition groups are combined with AND at the top level. */
export type BuilderState = {
  id?: string;
  source: string;
  select: string[];
  groups: BuilderConditionGroup[];
  sort: BuilderSort | null;
  mode: "cursor" | "offset";
  limit: number;
  offset: number;
  group: string[];
  aggregates: BuilderAggregate[];
  count: "none" | "capped";
};

export type BuilderAction =
  | { type: "setSource"; source: string }
  | { type: "toggleField"; field: string }
  | { type: "addGroup"; combinator?: Combinator }
  | { type: "removeGroup"; group: number }
  | { type: "setCombinator"; group: number; combinator: Combinator }
  | { type: "addCondition"; group: number; condition?: BuilderCondition }
  | { type: "updateCondition"; group: number; index: number; patch: Partial<BuilderCondition> }
  | { type: "removeCondition"; group: number; index: number }
  | { type: "setSort"; sort: BuilderSort | null }
  | { type: "setPagination"; mode?: "cursor" | "offset"; limit?: number; offset?: number }
  | { type: "setGroupBy"; fields: string[] }
  | { type: "addAggregate"; aggregate: BuilderAggregate }
  | { type: "removeAggregate"; index: number }
  | { type: "setCount"; count: "none" | "capped" }
  | { type: "reset"; source?: string };

export const DEFAULT_PAGE_SIZE = 50;

export function initialBuilderState(source = ""): BuilderState {
  return { source, select: [], groups: [], sort: null, mode: "cursor", limit: DEFAULT_PAGE_SIZE, offset: 0, group: [], aggregates: [], count: "none" };
}

const NULL_OPS: FilterOp[] = ["is_null", "is_not_null"];
const blankCondition = (): BuilderCondition => ({ field: "", op: "eq", value: "" });

function mapGroup(state: BuilderState, index: number, change: (group: BuilderConditionGroup) => BuilderConditionGroup): BuilderState {
  if (index < 0 || index >= state.groups.length) return state;
  return { ...state, groups: state.groups.map((group, position) => (position === index ? change(group) : group)) };
}

/** Pure reducer (useReducer-compatible). Unknown indexes leave the state unchanged. */
export function builderReducer(state: BuilderState, action: BuilderAction): BuilderState {
  switch (action.type) {
    case "setSource":
      // Field names belong to a source: switching source clears everything that names fields.
      return action.source === state.source ? state : { ...initialBuilderState(action.source), id: state.id, mode: state.mode, limit: state.limit, offset: state.offset, count: state.count };
    case "toggleField":
      return { ...state, select: state.select.includes(action.field) ? state.select.filter(field => field !== action.field) : [...state.select, action.field] };
    case "addGroup":
      return { ...state, groups: [...state.groups, { combinator: action.combinator ?? "and", conditions: [] }] };
    case "removeGroup":
      return { ...state, groups: state.groups.filter((_, index) => index !== action.group) };
    case "setCombinator":
      return mapGroup(state, action.group, group => ({ ...group, combinator: action.combinator }));
    case "addCondition":
      return mapGroup(state, action.group, group => ({ ...group, conditions: [...group.conditions, { ...(action.condition ?? blankCondition()) }] }));
    case "updateCondition":
      return mapGroup(state, action.group, group => {
        if (action.index < 0 || action.index >= group.conditions.length) return group;
        return {
          ...group,
          conditions: group.conditions.map((condition, index) => {
            if (index !== action.index) return condition;
            const next = { ...condition, ...action.patch };
            if (NULL_OPS.includes(next.op)) delete next.value;
            return next;
          }),
        };
      });
    case "removeCondition":
      return mapGroup(state, action.group, group => ({ ...group, conditions: group.conditions.filter((_, index) => index !== action.index) }));
    case "setSort":
      return { ...state, sort: action.sort ? { ...action.sort } : null };
    case "setPagination": {
      const mode = action.mode ?? state.mode;
      return { ...state, mode, limit: action.limit ?? state.limit, offset: mode === "cursor" ? 0 : action.offset ?? state.offset };
    }
    case "setGroupBy":
      return { ...state, group: [...action.fields] };
    case "addAggregate":
      return { ...state, aggregates: [...state.aggregates, { ...action.aggregate }] };
    case "removeAggregate":
      return { ...state, aggregates: state.aggregates.filter((_, index) => index !== action.index) };
    case "setCount":
      return { ...state, count: action.count };
    case "reset":
      return initialBuilderState(action.source ?? state.source);
    default:
      return state;
  }
}

function conditionToLeaf(condition: BuilderCondition): FilterLeaf {
  if (NULL_OPS.includes(condition.op)) return { field: condition.field, op: condition.op };
  return { field: condition.field, op: condition.op, value: condition.value ?? null };
}

/** The filter of a builder state: empty groups are dropped, one condition is a leaf, groups are ANDed. */
export function stateToFilter(state: Pick<BuilderState, "groups">): Filter | undefined {
  const nodes: Filter[] = [];
  for (const group of state.groups) {
    const leaves = group.conditions.filter(condition => condition.field).map(conditionToLeaf);
    if (!leaves.length) continue;
    nodes.push(leaves.length === 1 ? leaves[0] : group.combinator === "or" ? { or: leaves } : { and: leaves });
  }
  if (!nodes.length) return undefined;
  return nodes.length === 1 ? nodes[0] : { and: nodes };
}

export function stateToQuery(state: BuilderState): QueryBody {
  const grouped = state.group.length > 0 || state.aggregates.length > 0;
  const query: QueryDefinition = { source: state.source };
  if (state.id) query.id = state.id;
  if (!grouped) query.select = [...state.select];
  const filter = stateToFilter(state);
  if (filter) query.filter = filter;
  if (state.sort) query.sort = [{ ...state.sort }];
  // Grouped results only page with offset.
  query.pagination = grouped || state.mode === "offset" ? { mode: "offset", limit: state.limit, offset: state.offset } : { mode: "cursor", limit: state.limit };
  if (state.group.length) query.group = [...state.group];
  if (state.aggregates.length) query.aggregate = state.aggregates.map(aggregate => ({ ...aggregate }));
  if (state.count === "capped") query.count = "capped";
  return { format: QUERY_FORMAT, query };
}

// Visual builder conditions ---------------------------------------------------------------------
/** Metadata the condition editor offers (when the catalog lets the caller read it). */
export const CONDITION_METADATA = ["$status", "$created_at", "$updated_at", "$ingested_at", "$subject_id"] as const;

/** Operators per value family, in menu order; mirrors the validator's OPS_BY_FAMILY (longtext and multi cannot be filtered). */
const CONDITION_OPS: Record<string, FilterOp[]> = {
  text: ["eq", "ne", "in", "prefix", "lt", "lte", "gt", "gte", "between", "is_null", "is_not_null"],
  num: ["eq", "ne", "in", "lt", "lte", "gt", "gte", "between", "is_null", "is_not_null"],
  datetime: ["gte", "lte", "between", "eq", "ne", "lt", "gt", "in", "is_null", "is_not_null"],
  bool: ["eq", "ne", "is_null", "is_not_null"],
  time: ["gte", "lte", "between", "eq", "ne", "lt", "gt", "in"],
  int: ["eq", "ne", "in", "lt", "lte", "gt", "gte", "between"],
  status: ["eq", "ne", "in"],
  user: ["eq", "ne", "in"],
  id: ["eq", "ne", "in"],
  subject: ["eq", "ne", "in", "prefix", "is_null", "is_not_null"],
};

/** The value family of a condition field: $metadata uses its own family (status, time, subject...), a form field its type's. */
export function conditionFamily(field: string, fieldType?: string): string {
  if (field.startsWith("$")) return field === "$subject_id" ? "subject" : METADATA[field]?.family ?? "text";
  return fieldType === undefined ? "text" : FIELD_FAMILY[fieldType] ?? "text";
}

export const conditionOperators = (family: string): FilterOp[] => [...(CONDITION_OPS[family] ?? [])];

/** Fixed value choices for a family (null means free text). */
export function conditionChoices(family: string, principal: QueryPrincipal): string[] | null {
  if (family === "status") return isAdmin(principal) ? ["draft", "submitted", "deleted"] : ["draft", "submitted"];
  return family === "bool" ? ["true", "false"] : null;
}

/** Types what was typed into the Value box: numbers for num/int, booleans for bool, comma lists for in/between. */
export function conditionValue(family: string, op: FilterOp, raw: string): JsonValue {
  const one = (text: string): JsonValue => {
    if (family === "num" || family === "int") return text.trim() === "" ? text : Number(text);
    if (family === "bool") return text === "true" ? true : text === "false" ? false : text;
    // A datetime-local input gives minutes only.
    if ((family === "datetime" || family === "time") && text.length === 16) return `${text}:00`;
    return text;
  };
  if (op === "in") return raw.split(",").map(item => one(item.trim())).filter(item => item !== "");
  if (op === "between") return raw.split(",").slice(0, 2).map(item => one(item.trim()));
  return one(raw);
}

/** The updateCondition patch for a field/operator change or new Value text; an operator the new field does not take falls back to its first. */
export function editCondition(condition: BuilderCondition, patch: Partial<BuilderCondition>, raw: string, fieldType?: string): Partial<BuilderCondition> {
  const field = patch.field ?? condition.field;
  const ops = conditionOperators(conditionFamily(field, fieldType));
  const op = patch.op ?? (ops.length === 0 || ops.includes(condition.op) ? condition.op : ops[0]);
  return { ...patch, field, op, value: conditionValue(conditionFamily(field, fieldType), op, raw) };
}
