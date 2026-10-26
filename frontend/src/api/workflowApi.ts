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
  /** Fill the form once per slot (ICU rounds, docs/ICU-ROUNDS.md); absent or null: one record per case. */
  schedule?: WorkflowFormSchedule | null;
};
export type WorkflowFormDisplay = "tab" | "report";

/** daily: at HH:MM every day; every: every N h from the workflow's day_start; per_shift: at each shift start. */
export type WorkflowScheduleKind = "daily" | "every" | "per_shift";
export type WorkflowFormSchedule = {
  kind: WorkflowScheduleKind;
  /** daily only, HH:MM. */
  at?: string;
  /** every only, 1–24. */
  every_hours?: number;
  /** null: until discharge; N: only the first N days of the stay. */
  days?: number | null;
  /** Due until slot + grace, then overdue (default 120; per_shift: the shift length). */
  grace_min?: number | null;
};
export type WorkflowShift = { code: string; label?: string; start: string };

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
  billing?: { template_id: string | null; /** 'daily': ICU billing per billing day (from day_start); default one order per case. */ mode?: "case" | "daily" };
  /** Clinical scores (Workflow Studio → Scores) the Leaf computes for cases of this workflow. */
  scores?: string[];
  /** Day 1 of a stay starts at the first day_start at or before the case start (HH:MM, default 07:00). */
  day_start?: string;
  /** Shifts for per_shift schedules (default D 07:00, E 15:00, N 23:00), ordered by start. */
  shifts?: WorkflowShift[];
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

export type CaseWorkflowFormRecord = { data: RecordData; status: "draft" | "completed"; updatedAt?: string | null };
export type FormScheduleSummary = { due: number; overdue: number; done: number };
export type CaseWorkflowForm = {
  definition: FormDefinition;
  /** Null for a scheduled form: its fills are entries (getFormEntries). */
  record: CaseWorkflowFormRecord | null;
  schedule?: WorkflowFormSchedule | null;
  summary?: FormScheduleSummary | null;
};
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

export const patchCaseWorkflowForm = (caseId: number, formId: string, patch: RecordData, status?: "draft" | "completed") =>
  leafJson<{ definition?: FormDefinition; record?: CaseWorkflowFormRecord }>(`${CASE_BASE}/${caseId}/workflow-forms/${encodeURIComponent(formId)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ patch, ...(status ? { status } : {}) }),
  });

// ---------------------------------------------------------------- scheduled forms (docs/ICU-ROUNDS.md)

export type FormSlotStatus = "done" | "draft" | "due" | "overdue" | "skipped" | "upcoming";
/** A computed slot; slot_ts is epoch ms. */
export type FormSlot = { slot_ts: number; day: number; shift: string | null; label: string; status: FormSlotStatus; entry_id: string | null };
export type FormEntryStatus = "draft" | "completed" | "skipped";
export type FormEntry = {
  id: string;
  /** null: an unscheduled entry. */
  slot_ts: number | null;
  status: FormEntryStatus;
  data: RecordData;
  formVersion?: number | null;
  updatedAt?: string | number | null;
  updatedBy?: string | null;
  completedAt?: string | number | null;
  completedBy?: string | null;
  skipReason?: string | null;
};
export type FormEntries = {
  form_id: string;
  schedule: WorkflowFormSchedule | null;
  timezone?: string | null;
  slots: FormSlot[];
  unscheduled: FormEntry[];
  summary: FormScheduleSummary;
};

const entriesUrl = (caseId: number, formId: string) => `${CASE_BASE}/${caseId}/workflow-forms/${encodeURIComponent(formId)}/entries`;
const jsonInit = (method: string, body: unknown): RequestInit => ({ method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

export const getFormEntries = (caseId: number, formId: string) =>
  leafJson<Partial<FormEntries>>(entriesUrl(caseId, formId)).then(data => ({
    form_id: data.form_id || formId,
    schedule: data.schedule ?? null,
    timezone: data.timezone ?? null,
    slots: data.slots || [],
    unscheduled: data.unscheduled || [],
    summary: data.summary || { due: 0, overdue: 0, done: 0 },
  }) as FormEntries);
/** Idempotent per slot: returns the slot's existing entry. slot_ts null adds an unscheduled entry. */
export const createFormEntry = (caseId: number, formId: string, slotTs: number | null) =>
  leafJson<{ entry: FormEntry }>(entriesUrl(caseId, formId), jsonInit("POST", { slot_ts: slotTs })).then(data => data.entry);
export const getFormEntry = (caseId: number, formId: string, entryId: string) =>
  leafJson<{ definition?: FormDefinition; entry: FormEntry }>(`${entriesUrl(caseId, formId)}/${encodeURIComponent(entryId)}`);
export const patchFormEntry = (caseId: number, formId: string, entryId: string, patch: RecordData, status?: "draft" | "completed") =>
  leafJson<{ entry: FormEntry }>(`${entriesUrl(caseId, formId)}/${encodeURIComponent(entryId)}`, jsonInit("PATCH", { patch, ...(status ? { status } : {}) }));
export const skipFormEntry = (caseId: number, formId: string, entryId: string, reason: string) =>
  leafJson<{ entry: FormEntry }>(`${entriesUrl(caseId, formId)}/${encodeURIComponent(entryId)}/skip`, jsonInit("POST", { reason })).then(data => data.entry);

export type WorklistForm = { form_id: string; title?: string | null; due: number; overdue: number; next_slot_ts?: number | null };
export type WorklistCase = { case_id: number; due: number; overdue: number; forms: WorklistForm[] };
/** Due/overdue scheduled forms of every active case; an empty list when the server has no worklist (older Leaf). */
export const getCaseWorklist = async (): Promise<WorklistCase[]> => {
  const response = await fetch(`${CASE_BASE}/worklist`);
  if (response.status === 404) return [];
  const data = await response.json().catch(() => ({})) as { cases?: WorklistCase[] };
  if (!response.ok) throw new Error(errorMessage(data, response.status));
  return data.cases || [];
};

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
