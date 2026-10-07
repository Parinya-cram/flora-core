/**
 * FormDev query types (format flora.query/1). A query is JSON data, never SQL: the server
 * validates it (services/flora-api/app/formdev/query/validator.py) and compiles it itself.
 */
import type { JsonValue } from "../core/types";

export type FilterOp = "eq" | "ne" | "lt" | "lte" | "gt" | "gte" | "in" | "between" | "prefix" | "is_null" | "is_not_null";
export type ValueOp = Exclude<FilterOp, "is_null" | "is_not_null">;

export type FilterLeaf = { field: string; op: FilterOp; value?: JsonValue };
export type Filter = FilterLeaf | { and: Filter[] } | { or: Filter[] } | { not: Filter };

export type SortKey = { field: string; dir?: "asc" | "desc" };
export type Pagination = { mode?: "cursor" | "offset"; limit: number; offset?: number; cursor?: string | null };
export type GroupKey = string | { field: string; bucket?: "day"; tz_offset_minutes?: number };
export type AggregateFn = "count" | "sum" | "avg" | "min" | "max";
export type Aggregate = { fn: AggregateFn; field?: string; as: string };
export type ExportOptions = { format?: "csv" | "jsonl" | "json" | "xlsx"; headers?: "ids" | "labels"; max_rows?: number };

export type QueryDefinition = {
  id?: string;
  source: string;
  select?: string[];
  filter?: Filter;
  sort?: SortKey[];
  pagination?: Pagination;
  /** Shorthand for pagination.limit. */
  limit?: number;
  group?: GroupKey[];
  aggregate?: Aggregate[];
  count?: "none" | "capped";
  /** Milliseconds; clamped to policy.timeout_ms.max. */
  timeout?: number;
  /** false disables the result cache; ttl is in seconds. */
  cache?: false | { ttl: number };
  export?: ExportOptions;
};

export type QueryBody = { format?: "flora.query/1"; query: QueryDefinition };

export type QuerySeverity = "error" | "warning";
export type QueryIssue = { path: string; code: string; message: string; severity: QuerySeverity };

/** formdev/spec/query-policy.json; the server sends the effective policy with the catalog. */
export type QueryPolicy = {
  format: string;
  max_body_bytes: number;
  max_page_rows: number;
  max_offset: number;
  max_select_fields: number;
  max_sort_keys: number;
  max_filter_depth: number;
  max_filter_leaves: number;
  max_index_terms_per_and: number;
  max_in_values: number;
  max_total_values: number;
  max_string_length: number;
  min_prefix_length: number;
  max_group_keys: number;
  max_aggregates: number;
  max_groups: number;
  timeout_ms: { default: number; max: number };
  max_result_bytes: number;
  cache_ttl_s: { default: number; max: number };
  count_cap: number;
  interactive_aggregate_max_rows: number;
  probe_timeout_ms: number;
  export_max_rows: { default: number; "formdev.manage": number };
  rate: { per_minute: number; burst: number };
  concurrency: { per_user: number; global: number };
  jobs: {
    per_user_open: number;
    per_user_retained_bytes: number;
    global_open: number;
    workers: number;
    batch_rows: number;
    batch_timeout_ms: number;
    aggregate_timeout_ms: number;
    max_runtime_ms: number;
    max_result_bytes: number;
    lease_ms: number;
    poll_ms: number;
    result_ttl_ms: number;
    max_attempts: number;
  };
};

export type IndexState = "ready" | "building";

export type QueryCatalogField = {
  type: string;
  label?: string | null;
  unit?: string | null;
  options?: string[] | null;
  indexed?: boolean | null;
  /** Defaults to "ready" for indexed fields. */
  state?: IndexState | null;
  /** Role or permission codes allowed to read the field; null/absent = everyone who may query. */
  access?: string[] | null;
};

/** Catalog in the shared fixture format (catalog_from_dict in catalog.py). */
export type QueryCatalog = {
  source_id: string;
  form_id?: string;
  title?: string;
  schema_version?: number;
  fields: Record<string, QueryCatalogField>;
  query_access?: string[] | null;
  export_access?: string[] | null;
  metadata_access?: Record<string, string[] | null> | null;
  /** Metadata columns being backfilled ($subject_id after a subject-field change): refused with index_building. */
  metadata_building?: string[] | null;
  relations?: Record<string, { local: string; foreign: string; target: QueryCatalog }> | null;
};

/** Catalog as GET /query/catalog/{id} serves it (SourceCatalog.public): already filtered for the caller. */
export type PublicQueryCatalog = {
  source_id: string;
  form_id: string;
  title: string;
  schema_version: number;
  fields: Record<string, { type: string; label?: string | null; unit?: string | null; indexed?: boolean | null; state?: IndexState | null; options?: string[] | null }>;
  metadata: string[];
  metadata_building?: string[];
  relations: Record<string, { local: string; foreign: string; source_id: string; fields: Record<string, { type: string; label?: string | null }> }>;
  can_export: boolean;
};

export type QuerySource = { source_id: string; form_id?: string; title?: string; [key: string]: unknown };

export type QueryPrincipal = { user_id: number | null; username: string; roles: string[]; permissions: string[] };

export type QueryRow = Record<string, JsonValue>;

export type QueryResult = {
  rows: QueryRow[];
  next_cursor: string | null;
  total: number | null;
  total_is_lower_bound: boolean;
  truncated: boolean;
  warnings: QueryIssue[];
  diagnostics?: Record<string, unknown>;
};

export type JobKind = "export" | "search" | "aggregate" | "report" | "reindex";
export type JobStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled" | "expired";

export type FormDevJob = {
  job_id: string;
  kind: JobKind;
  status: JobStatus;
  format: string;
  progress: number;
  rows_processed: number;
  total_estimate: number | null;
  result_bytes: number;
  error: { code: string; message: string; [key: string]: unknown } | null;
  created_at: number;
  started_at: number | null;
  finished_at: number | null;
  expires_at: number | null;
};
