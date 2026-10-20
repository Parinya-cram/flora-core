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
  /** Flora Leaf shows the form's tab right after this built-in record tab (null: after every record tab). */
  after_section?: string | null;
  /** A short note shown to whoever fills the form in on Leaf (at most 300 characters). */
  hint?: string;
  /** tab: a data-entry tab on Leaf (default); report: printed from Reports only, filled from the case's data. */
  display?: WorkflowFormDisplay;
  /** Several copies per case (e.g. one per transfusion or per procedure): the first keeps the form's id, the next are
   * "<form_id>~2", "<form_id>~3"... (case_forms.INSTANCE_KEY). */
  repeatable?: boolean;
  /** Most copies of a repeatable form (2-99; none: up to 99). */
  max_instances?: number;
};
export type WorkflowFormDisplay = "tab" | "report";

/** A form's suggested Leaf placement (Form Studio's AI builder, extensions["flora.leaf_placement"]). */
export type WorkflowPlacement = { phase: WorkflowPhase; after_section: string | null };

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
  /** Clinical scores (Workflow Studio → Scores) the Leaf computes for cases of this workflow. */
  scores?: string[];
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
  forms: Array<{ form_id: string; title: string; published_version: number | null; versions: number[]; placement?: WorkflowPlacement | null }>;
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
    scores: [],
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

/** Who changed a field last: on a Leaf, or in Canopy (an amendment, with its reason). */
export type CaseFormAuthor = { by: string; at: number; via: "leaf" | "canopy"; leaf_id?: string; reason?: string };
/** Canopy's receipt for the copy it last took: stored in Form Studio, kept as a draft, not stored (issues say why),
 * or waiting for files; "pending" until the first exchange. `current`: Canopy has the form as it is now. */
export type CaseFormSync = {
  state: "pending" | "stored" | "kept_as_draft" | "not_stored" | "waiting_files";
  issues: Array<{ path: string; code: string; message: string }>; at?: number | null; recordId?: string | null; current: boolean;
};
export type CaseWorkflowFormRecord = {
  data: RecordData; status: "draft" | "completed"; updatedAt?: number | string | null; updatedBy?: string | null;
  createdAt?: number | null; createdBy?: string | null; authors?: Record<string, CaseFormAuthor>; sync?: CaseFormSync;
};
/** A form of the case; a further copy of a repeatable form also names the form it copies (`of`) and its number. */
export type CaseWorkflowForm = { definition: FormDefinition; record: CaseWorkflowFormRecord | null; of?: string; instance?: number };
export type CaseWorkflow = { workflow: WorkflowDefinition | null; forms: Record<string, CaseWorkflowForm> };

export const getCaseWorkflow = (caseId: number) =>
  leafJson<Partial<CaseWorkflow>>(`${CASE_BASE}/${caseId}/workflow`).then(data => ({ workflow: data.workflow ?? null, forms: data.forms || {} }) as CaseWorkflow);

/** A Form Studio template the case can print from Reports (case workflow first, then the ward's workflows). */
export type ReportTemplate = {
  form_id: string; version: number; title: string; display: WorkflowFormDisplay; source: "case" | "ward"; workflow: string;
  definition: FormDefinition; record: CaseWorkflowFormRecord | null;
};
export const getReportTemplates = (caseId: number) =>
  leafJson<{ templates?: ReportTemplate[]; syncedAt?: number | null }>(`${CASE_BASE}/${caseId}/report-templates`)
    .then(data => ({ templates: data.templates || [], syncedAt: data.syncedAt ?? null }));

/** A save the Leaf refused: completing a form Form Studio would not accept (422 with the field issues). */
export class CaseFormRefused extends Error {
  readonly issues: Array<{ path: string; code: string; message: string }>;
  constructor(message: string, issues: Array<{ path: string; code: string; message: string }>) {
    super(message);
    this.issues = issues;
  }
}

/** `reason`: why a completed form is changed or reopened (an amendment; the Leaf refuses it without one). */
export async function patchCaseWorkflowForm(caseId: number, formId: string, patch: RecordData, status?: "draft" | "completed", reason?: string) {
  const response = await fetch(`${CASE_BASE}/${caseId}/workflow-forms/${encodeURIComponent(formId)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ patch, ...(status ? { status } : {}), ...(reason ? { reason } : {}) }),
  });
  const data = await response.json().catch(() => ({}));
  if (response.status === 422 && Array.isArray((data as { issues?: unknown }).issues)) {
    const body = data as { error?: string; issues: Array<{ path: string; code: string; message: string }> };
    throw new CaseFormRefused(body.error || "The form is not complete", body.issues);
  }
  if (!response.ok) throw new Error(errorMessage(data, response.status));
  return data as { definition?: FormDefinition; record?: CaseWorkflowFormRecord };
}

/** Sign a signature field with the drawing and the signer's signing PIN (the Leaf checks it and locks the field). */
export async function signCaseWorkflowForm(caseId: number, formId: string, input: { field: string; data: string; pin: string; reason?: string }) {
  const response = await fetch(`${CASE_BASE}/${caseId}/workflow-forms/${encodeURIComponent(formId)}/sign`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(errorMessage(data, response.status));
  return data as { record?: CaseWorkflowFormRecord };
}

/** Attach a workflow to an open case, or change it (forms already filled keep their version). */
export const attachCaseWorkflow = (caseId: number, workflowId: string) =>
  leafJson<Partial<CaseWorkflow>>(`${CASE_BASE}/${caseId}/workflow`, {
    method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ workflow_id: workflowId }),
  }).then(data => ({ workflow: data.workflow ?? null, forms: data.forms || {} }) as CaseWorkflow);

/** Files of file / image fields: stored on the Leaf (by SHA-256) before the form refers to them. */
export async function putCaseFormFile(caseId: number, sha256: string, bytes: ArrayBuffer, mime: string): Promise<void> {
  const response = await fetch(`${CASE_BASE}/${caseId}/workflow-forms-files/${sha256}`, {
    method: "PUT", headers: { "Content-Type": mime || "application/octet-stream" }, body: bytes,
  });
  if (!response.ok) throw new Error(errorMessage(await response.json().catch(() => ({})), response.status));
}

export async function getCaseFormFile(caseId: number, sha256: string): Promise<Blob | null> {
  const response = await fetch(`${CASE_BASE}/${caseId}/workflow-forms-files/${sha256}`);
  return response.ok ? await response.blob() : null;
}

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

// ---------------------------------------------------------------- clinical scores (app/scoring.py)

export type ScoreLevel = "info" | "warning" | "critical";
export type ScoreBand = { min?: number; max?: number; points?: number; label?: string; level?: ScoreLevel; action?: string };
export type ScoreOption = { value: string | number | boolean; points: number; label?: string };
export type ScoreInput = {
  source: "param" | "manual"; param?: string; fallback?: string[]; window_min?: number; agg?: "latest" | "min" | "max" | "avg";
  type?: "number" | "text" | "bool"; round?: number; default?: unknown; label?: string; unit?: string;
};
export type ScoreItem = { key: string; label: string; input?: string; formula?: string; requires?: string[]; bands?: ScoreBand[]; options?: ScoreOption[] };
export type ScoreDefinition = {
  format: "flora-score/1"; id: string; name: string; description?: string; reference?: string; version?: number;
  mode: "auto" | "manual"; interval_min: number; missing: "partial" | "none";
  inputs: Record<string, ScoreInput>; items: ScoreItem[]; total?: { formula?: string };
  bands: ScoreBand[]; flags: Array<{ when: string; label: string; level: ScoreLevel }>;
};
export type ScoreRow = {
  id: string; name: string; description?: string | null; status: WorkflowStatus; version: number;
  updatedAt?: number | null; updatedBy?: string | null; publishedAt?: number | null;
  definition: ScoreDefinition; itemCount: number; mode: "auto" | "manual";
  usedBy: Array<{ id: string; name: string; status: WorkflowStatus }>;
};
export type ScoreOptions = {
  parameters: Array<{ param_key: string; label: string; display_name: string; value_type: string; unit?: string | null }>;
  library: Array<{ id: string; name: string; description?: string; reference?: string; imported: boolean }>;
};
export type ScoreTryResult = {
  total: number | null; band: string | null; level: ScoreLevel | null; partial: boolean; missing: string[];
  items: Array<{ key: string; label: string; value: unknown; points: number | null }>; flags: Array<{ label: string; level: ScoreLevel }>;
};

export function emptyScore(): ScoreDefinition {
  return { format: "flora-score/1", id: "", name: "", description: "", reference: "", mode: "auto", interval_min: 15,
    missing: "partial", inputs: {}, items: [], bands: [], flags: [] };
}

const sc = (id: string) => `/api/fleet/workflows/scores/${encodeURIComponent(id)}`;
export const listScores = () => canopyJson<{ rows: ScoreRow[] }>("/api/fleet/workflows/scores").then(data => data.rows || []);
export const getScoreOptions = () => canopyJson<ScoreOptions>("/api/fleet/workflows/scores/options");
export const createScore = (definition: ScoreDefinition) => canopyJson<ScoreRow>("/api/fleet/workflows/scores", "POST", { definition });
export const importLibraryScore = (libraryId: string) => canopyJson<ScoreRow>(`/api/fleet/workflows/scores/library/${encodeURIComponent(libraryId)}`, "POST", {});
export const saveScore = (id: string, definition: ScoreDefinition) => canopyJson<ScoreRow>(sc(id), "PUT", { definition });
export const publishScore = (id: string) => canopyJson<ScoreRow>(`${sc(id)}/publish`, "POST", {});
export const archiveScore = (id: string) => canopyJson<ScoreRow>(`${sc(id)}/archive`, "POST", {});
export const duplicateScore = (id: string, newId: string, name: string) => canopyJson<ScoreRow>(`${sc(id)}/duplicate`, "POST", { id: newId, name });
export const validateScore = (definition: ScoreDefinition) =>
  canopyJson<{ issues: BillingTemplateIssue[] }>("/api/fleet/workflows/scores/validate", "POST", { definition });
export const tryScore = (definition: ScoreDefinition, values: Record<string, unknown>) =>
  canopyJson<ScoreTryResult>("/api/fleet/workflows/scores/try", "POST", { definition, values });
