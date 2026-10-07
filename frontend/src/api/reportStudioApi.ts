import { readStoredAuthToken } from "./authApi";
import { BACKEND_BASE } from "./backendBase";
import type { ReportCategory, ReportDefinition, ReportResult } from "./reportLibraryApi";
import { wardHeaders } from "./wardSelection";

export type FieldUse = "filter" | "result" | "group" | "measure";
export type FieldDataType = "text" | "category" | "date" | "datetime" | "number" | "boolean" | "duration";

export type CatalogDataset = { id: string; title: string; description: string; grain: string; source_system: string };
export type CatalogField = {
  id: string;
  dataset_id: string;
  label: string;
  description: string;
  section: string;
  data_type: FieldDataType;
  cardinality: "scalar" | "multi";
  allowed_uses: FieldUse[];
  operators: string[];
};
export type FieldValue = { value: string; label: string };

export type Bucket = "day" | "week" | "month" | "quarter" | "year";
export type Aggregate = "count_cases" | "count_patients" | "pct_cases" | "count_filled" | "avg" | "median" | "p90" | "min" | "max" | "sum" | "stddev";
export type StudioColumn = { field: string; label?: string };
export type StudioGroup = { field: string; bucket?: Bucket; label?: string };
export type StudioMeasure = { agg: Aggregate; field?: string; label?: string };
export type StudioFilter = { field: string; op: string; value?: string | number | Array<string | number> | null };
/** definition.studio of a Report Studio report; the server compiles it (app/report_engine.py). */
export type StudioSpec = {
  dataset: string;
  view: "list" | "stats";
  columns: StudioColumn[];
  groups: StudioGroup[];
  measures: StudioMeasure[];
  filters: StudioFilter[];
  sort?: { key: string; dir: "asc" | "desc" } | null;
  limit?: number | null;
};

export type ResultColumn = { key: string; label: string; kind: "column" | "group" | "measure"; field?: string | null; agg?: Aggregate; data_type: string };
export type StudioResult = Omit<ReportResult, "columns"> & { columns?: ResultColumn[]; sql?: string };

function headers(json = false): Record<string, string> {
  const token = readStoredAuthToken();
  return { ...wardHeaders(), ...(token ? { "X-FLORA-Session": token } : {}), ...(json ? { "Content-Type": "application/json" } : {}) };
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${BACKEND_BASE}${path}`, { ...init, headers: headers(Boolean(init?.body)) });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({})) as { detail?: unknown; error?: string };
    const detail = Array.isArray(payload.detail) ? payload.detail.map(item => (item as { msg?: string }).msg).join("; ") : payload.detail;
    throw new Error(String(detail || payload.error || `Request failed (${response.status})`));
  }
  return response.json() as Promise<T>;
}

export const getCatalog = () => request<{ datasets: CatalogDataset[]; fields: CatalogField[] }>("/api/reports/metadata");

export const getFieldValues = (fieldId: string, query = "") =>
  request<{ rows: FieldValue[] }>(`/api/reports/metadata/fields/${encodeURIComponent(fieldId)}/values?${new URLSearchParams({ q: query, limit: "80" })}`).then(result => result.rows);

export const previewReport = (spec: StudioSpec, params: Record<string, string>, signal?: AbortSignal) =>
  request<StudioResult>("/api/reports/studio/preview", { method: "POST", body: JSON.stringify({ spec, params }), signal });

export type StudioReportInput = { title: string; description: string; category: ReportCategory; spec: StudioSpec };

export const createStudioReport = (input: StudioReportInput) =>
  request<ReportDefinition>("/api/reports/studio/reports", { method: "POST", body: JSON.stringify(input) });

export const updateStudioReport = (id: string, input: StudioReportInput) =>
  request<ReportDefinition>(`/api/reports/studio/reports/${encodeURIComponent(id)}`, { method: "PUT", body: JSON.stringify(input) });

export const archiveStudioReport = (id: string) =>
  request<{ archived: boolean }>(`/api/reports/studio/reports/${encodeURIComponent(id)}`, { method: "DELETE" });
