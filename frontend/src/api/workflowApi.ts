import { BACKEND_BASE } from "./backendBase";
import { readStoredAuthToken } from "./authApi";
import { wardHeaders } from "./wardSelection";
import type { FormDefinition, RecordData } from "../formdev/core/types";

/** Workflow Studio (docs/workflow-studio.md): format `flora-workflow/1`. */

export type WorkflowPhase = "preop" | "intraop" | "postop" | "any";
export type WorkflowReportMode = "standard" | "smart_fit" | "detail";

export type WorkflowFormRef = {
  form_id: string;
  version: number;
  title?: string;
  phase?: WorkflowPhase;
  required?: boolean;
};

export type WorkflowPacketEntry =
  | { kind: "anesthesia_report"; mode?: WorkflowReportMode }
  | { kind: "form"; form_id: string };

export type WorkflowDefinition = {
  format: "flora-workflow/1";
  id: string;
  name: string;
  description?: string;
  anesthesia_record: {
    enabled: boolean;
    sections: string[];
    optional_sections: string[];
  };
  forms: WorkflowFormRef[];
  packet: WorkflowPacketEntry[];
  /** Itemize (billing) template for the Leaf Billing screen; one template may serve many workflows. */
  billing?: { template_id: string | null };
  bundled_forms?: Record<string, { version: number; definition: unknown }>;
};

export type WorkflowStatus = "draft" | "published" | "archived";

export type WorkflowWard = { unitKey: string; unitName?: string | null; isDefault: boolean; sortOrder: number };

export type WorkflowRow = {
  id: string;
  name: string;
  description?: string | null;
  status: WorkflowStatus;
  version: number;
  /** Epoch ms (or ISO text). */
  updatedAt?: number | string | null;
  updatedBy?: string | null;
  definition: WorkflowDefinition;
  wards: WorkflowWard[];
};

export type WorkflowOptions = {
  sections: Array<{ id: string; label: string; core: boolean }>;
  forms: Array<{ form_id: string; title: string; published_version: number | null; versions: number[] }>;
  wards: Array<{ key: string; name: string; buildingName?: string | null; isDemo?: boolean }>;
};

export type WorkflowImportResult = { row: WorkflowRow; createdForms: string[]; warnings: string[] };

export function emptyWorkflow(): WorkflowDefinition {
  return {
    format: "flora-workflow/1",
    id: "",
    name: "",
    description: "",
    anesthesia_record: { enabled: true, sections: ["caseInfo", "preop", "checklist", "pacu", "outcome"], optional_sections: [] },
    forms: [],
    packet: [{ kind: "anesthesia_report", mode: "standard" }],
    billing: { template_id: null },
  };
}

// ---------------------------------------------------------------- Canopy

function canopyHeaders(json: boolean): Record<string, string> {
  const token = readStoredAuthToken();
  return { ...(json ? { "Content-Type": "application/json" } : {}), ...wardHeaders(), ...(token ? { "X-FLORA-Session": token } : {}) };
}

function errorMessage(data: unknown, status: number): string {
  const body = (data && typeof data === "object" ? data : {}) as { detail?: unknown; error?: unknown; errors?: unknown; issues?: unknown };
  if (Array.isArray(body.errors) && body.errors.length) return body.errors.map(String).join("\n");
  if (Array.isArray(body.issues) && body.issues.length) {
    const lines = body.issues.map(item => (item && typeof item === "object" && "message" in item ? String((item as { message: unknown }).message) : String(item)));
    return [typeof body.error === "string" ? body.error : "", ...lines].filter(Boolean).join("\n");
  }
  if (Array.isArray(body.detail)) return body.detail.map(item => (item && typeof item === "object" && "msg" in item ? String((item as { msg: unknown }).msg) : String(item))).join("\n");
  if (typeof body.detail === "string" && body.detail) return body.detail;
  if (typeof body.error === "string" && body.error) return body.error;
  return `Workflow request failed (${status})`;
}

async function canopyJson<T>(path: string, method: "GET" | "POST" | "PUT" = "GET", body?: unknown): Promise<T> {
  const response = await fetch(`${BACKEND_BASE}${path}`, {
    method,
    headers: canopyHeaders(body !== undefined),
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(errorMessage(data, response.status));
  return data as T;
}

const wf = (id: string) => `/api/fleet/workflows/${encodeURIComponent(id)}`;

export const listWorkflows = () => canopyJson<{ rows: WorkflowRow[] }>("/api/fleet/workflows").then(data => data.rows || []);
export const getWorkflow = (id: string) => canopyJson<WorkflowRow>(wf(id));
export const getWorkflowOptions = () => canopyJson<WorkflowOptions>("/api/fleet/workflows/options");
export const createWorkflow = (definition: WorkflowDefinition) => canopyJson<WorkflowRow>("/api/fleet/workflows", "POST", { definition });
export const updateWorkflow = (id: string, definition: WorkflowDefinition) => canopyJson<WorkflowRow>(wf(id), "PUT", { definition });
export const publishWorkflow = (id: string) => canopyJson<WorkflowRow>(`${wf(id)}/publish`, "POST", {});
export const archiveWorkflow = (id: string) => canopyJson<WorkflowRow>(`${wf(id)}/archive`, "POST", {});
export const setWorkflowWards = (id: string, wards: Array<{ unit_key: string; is_default: boolean; sort_order: number }>) =>
  canopyJson<WorkflowRow>(`${wf(id)}/wards`, "PUT", { wards });
export const exportWorkflow = (id: string) => canopyJson<WorkflowDefinition>(`${wf(id)}/export`);
export const importWorkflow = (file: unknown) => canopyJson<WorkflowImportResult>("/api/fleet/workflows/import", "POST", { file });

// ---------------------------------------------------------------- Leaf

const CASE_BASE = `${BACKEND_BASE}/api/case`;

async function leafJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(errorMessage(data, response.status));
  return data as T;
}

export type LeafWorkflowOption = {
  id: string;
  name: string;
  description?: string | null;
  isDefault: boolean;
  sections?: string[];
  forms?: WorkflowFormRef[];
};

export const listLeafWorkflows = () =>
  leafJson<{ rows?: LeafWorkflowOption[]; syncedAt?: string | null }>(`${CASE_BASE}/workflows`).then(data => ({ rows: data.rows || [], syncedAt: data.syncedAt ?? null }));

export type CaseWorkflowFormRecord = { data: RecordData; status: "draft" | "completed"; updatedAt?: string | null };
export type CaseWorkflowForm = { definition: FormDefinition; record: CaseWorkflowFormRecord | null };
export type CaseWorkflow = { workflow: WorkflowDefinition | null; forms: Record<string, CaseWorkflowForm> };

export const getCaseWorkflow = (caseId: number) =>
  leafJson<Partial<CaseWorkflow>>(`${CASE_BASE}/${caseId}/workflow`).then(data => ({ workflow: data.workflow ?? null, forms: data.forms || {} }) as CaseWorkflow);

export const patchCaseWorkflowForm = (caseId: number, formId: string, patch: RecordData, status?: "draft" | "completed") =>
  leafJson<{ definition?: FormDefinition; record?: CaseWorkflowFormRecord }>(`${CASE_BASE}/${caseId}/workflow-forms/${encodeURIComponent(formId)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ patch, ...(status ? { status } : {}) }),
  });

// ---------------------------------------------------------------- itemize (billing) templates

export type BillingTemplateItem = { code: string; qty?: number | null; preselect?: boolean };
export type BillingTemplateGroup = { key: string; name: string; items: BillingTemplateItem[] };
export type BillingTemplateDefinition = {
  format: "flora-billing-template/1";
  id: string;
  name: string;
  description?: string;
  groups: BillingTemplateGroup[];
  allow_other_items: boolean;
};
export type BillingTemplateRow = {
  id: string; name: string; description?: string | null; status: WorkflowStatus; version: number;
  updatedAt?: number | null; updatedBy?: string | null; publishedAt?: number | null;
  definition: BillingTemplateDefinition; itemCount: number;
  usedBy: Array<{ id: string; name: string; status: WorkflowStatus }>;
};
export type BillingTemplateIssue = { path: string; message: string };

export function emptyBillingTemplate(): BillingTemplateDefinition {
  return { format: "flora-billing-template/1", id: "", name: "", description: "", groups: [], allow_other_items: true };
}

const bt = (id: string) => `/api/fleet/workflows/billing-templates/${encodeURIComponent(id)}`;
export const listBillingTemplates = () =>
  canopyJson<{ rows: BillingTemplateRow[] }>("/api/fleet/workflows/billing-templates").then(data => data.rows || []);
export const getBillingTemplateOptions = () =>
  canopyJson<import("./billingApi").BillingCatalog>("/api/fleet/workflows/billing-templates/options");
export const createBillingTemplate = (definition: BillingTemplateDefinition) =>
  canopyJson<BillingTemplateRow>("/api/fleet/workflows/billing-templates", "POST", { definition });
export const saveBillingTemplate = (id: string, definition: BillingTemplateDefinition) => canopyJson<BillingTemplateRow>(bt(id), "PUT", { definition });
export const publishBillingTemplate = (id: string) => canopyJson<BillingTemplateRow>(`${bt(id)}/publish`, "POST", {});
export const archiveBillingTemplate = (id: string) => canopyJson<BillingTemplateRow>(`${bt(id)}/archive`, "POST", {});
export const duplicateBillingTemplate = (id: string, newId: string, name: string) =>
  canopyJson<BillingTemplateRow>(`${bt(id)}/duplicate`, "POST", { id: newId, name });
export const validateBillingTemplate = (definition: BillingTemplateDefinition) =>
  canopyJson<{ issues: BillingTemplateIssue[] }>("/api/fleet/workflows/billing-templates/validate", "POST", { definition });
