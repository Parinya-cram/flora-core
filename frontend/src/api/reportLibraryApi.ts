import { readStoredAuthToken } from "./authApi";
import { BACKEND_BASE } from "./backendBase";
import { wardHeaders } from "./wardSelection";

export type ReportCategory = "clinical_timing" | "clinical_summary" | "operations";

export type ReportDefinition = {
  id: string;
  title: string;
  description: string;
  category: ReportCategory;
  source_system: string;
  definition: {
    engine_report: string;
    dataset: "innovian_archive";
    mode: "detail" | "summary" | "monthly_drilldown";
    filters?: string[];
    columns?: string[];
    dimensions?: string[];
    measures?: string[];
  };
  is_system: boolean;
  is_active: boolean;
  sort_order: number;
  created_by?: string | null;
  created_at: number;
  updated_at: number;
};

export type ReportResult = {
  report?: string;
  mode?: "summary" | "detail";
  summary?: Record<string, unknown>;
  rows?: Array<Record<string, unknown>>;
  pagination?: {
    page: number;
    page_size: number;
    total: number;
    total_pages: number;
  };
};

export type ReportStaffOption = {
  name: string;
  role?: string | null;
  in_master: boolean;
  usage_count: number;
};

function headers(): Record<string, string> {
  const token = readStoredAuthToken();
  return { ...wardHeaders(), ...(token ? { "X-FLORA-Session": token } : {}) };
}

async function errorMessage(response: Response) {
  const payload = await response.json().catch(() => ({})) as { detail?: string; error?: string };
  return payload.detail || payload.error || `Report request failed (${response.status})`;
}

export async function getReportLibrary(): Promise<ReportDefinition[]> {
  const response = await fetch(`${BACKEND_BASE}/api/reports`, { headers: headers() });
  if (!response.ok) throw new Error(await errorMessage(response));
  return ((await response.json()) as { rows?: ReportDefinition[] }).rows || [];
}

export async function getReportStaffOptions(query = "", role = ""): Promise<{ staff: ReportStaffOption[]; roles: string[] }> {
  const params = new URLSearchParams({ limit: "40" });
  if (query.trim()) params.set("q", query.trim());
  if (role) params.set("role", role);
  const response = await fetch(`${BACKEND_BASE}/api/reports/filter-options/staff?${params}`, { headers: headers() });
  if (!response.ok) throw new Error(await errorMessage(response));
  return response.json() as Promise<{ staff: ReportStaffOption[]; roles: string[] }>;
}

export async function runReport(reportId: string, params: URLSearchParams): Promise<ReportResult> {
  const response = await fetch(
    `${BACKEND_BASE}/api/reports/${encodeURIComponent(reportId)}/run?${params.toString()}`,
    { headers: headers() },
  );
  if (!response.ok) throw new Error(await errorMessage(response));
  return response.json() as Promise<ReportResult>;
}

export async function exportReport(reportId: string, params: URLSearchParams, format: "csv" | "xlsx") {
  const exportParams = new URLSearchParams(params);
  exportParams.set("format", format);
  const response = await fetch(
    `${BACKEND_BASE}/api/reports/${encodeURIComponent(reportId)}/export?${exportParams.toString()}`,
    { headers: headers() },
  );
  if (!response.ok) throw new Error(await errorMessage(response));
  const disposition = response.headers.get("content-disposition") || "";
  const fileName = disposition.match(/filename="?([^";]+)"?/i)?.[1] || `${reportId}.${format}`;
  const url = URL.createObjectURL(await response.blob());
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
}
