import { BACKEND_BASE } from "./backendBase";

/** OR billing checklist: master data synced from Canopy, one order per case. */

export type BillingGroup = { code: string; name: string; form_column: number; sort_order: number; is_active: number; updated_at?: number };
export type BillingQtyMode = "count" | "hours" | "used";
export type BillingItem = {
  code: string; group_code: string; name: string; unit: string | null; qty_mode: BillingQtyMode;
  variant_label: string | null; io_item_code: string | null; charge_code: string | null; unit_price: number | null;
  sort_order: number; is_active: number; updated_at?: number;
  /** ICU daily billing: per_day / per_device_day items are standing charges added once per billing day. */
  charge_basis?: "unit" | "per_day" | "per_device_day"; device_kind?: string | null;
};
export type BillingCatalog = { version: number; groups: BillingGroup[]; items: BillingItem[]; synced_version?: number };

export type BillingSignerRole = "surgeon" | "anesthesiologist" | "nurse1" | "nurse2";
export type BillingSigner = { role: BillingSignerRole; name: string; staff_id?: number };
export type BillingLine = {
  line_no?: number; item_code: string | null; group_code: string; name: string; variant: string | null; qty: number;
  unit?: string | null; qty_mode?: BillingQtyMode; unit_price?: number | null; amount?: number | null;
  source?: "manual" | "io_suggestion" | "standing"; note?: string | null;
  /** Combined OR + Recovery bill on Canopy: which case the line came from. */
  part?: "or" | "recovery" | null;
};
export type BillingOrder = {
  id: number; order_uuid: string; status: "draft" | "submitted" | "void";
  anesthesia_start: number | null; anesthesia_end: number | null; surgery_start: number | null; surgery_end: number | null;
  discharge_location: string | null; signers: BillingSigner[]; note: string | null;
  submitted_at: number | null; submitted_by: string | null; updated_at: number; updated_by: string | null;
};
export type BillingSuggestion = { item_code: string; qty: number; reason: string };
export type BillingDefaults = {
  anesthesia_start?: number; anesthesia_end?: number; surgery_start?: number; surgery_end?: number;
  signers: BillingSigner[]; techniques: string[]; discharge_location: string | null; suggestions: BillingSuggestion[];
};
/** Itemize template of the case's workflow (Workflow Studio), when it has one. */
export type BillingTemplate = {
  id: string; name: string; description?: string; allow_other_items?: boolean;
  groups: Array<{ key: string; name: string; items: Array<{ code: string; qty?: number | null; preselect?: boolean }> }>;
};
export type CaseBilling = { order: BillingOrder | null; items: BillingLine[]; total_amount: number | null; defaults?: BillingDefaults; template?: BillingTemplate | null };

export type BillingSave = {
  anesthesia_start: number | null; anesthesia_end: number | null; surgery_start: number | null; surgery_end: number | null;
  discharge_location: string | null; signers: BillingSigner[]; note: string | null;
  items: Array<Pick<BillingLine, "item_code" | "group_code" | "name" | "variant" | "qty" | "source">>;
};

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${BACKEND_BASE}${path}`, {
    ...init,
    headers: { ...(init.body ? { "Content-Type": "application/json" } : {}) },
  });
  const data = await res.json().catch(() => ({})) as { error?: unknown; detail?: unknown };
  if (!res.ok) {
    const message = typeof data.error === "string" ? data.error : typeof data.detail === "string" ? data.detail : "";
    throw new Error(message || `Billing request failed (${res.status})`);
  }
  return data as T;
}

export const getBillingCatalog = () => call<BillingCatalog>("/api/case/billing/catalog");
export const getCaseBilling = (caseId: number) => call<CaseBilling>(`/api/case/${caseId}/billing`);
export const saveCaseBilling = (caseId: number, body: BillingSave) =>
  call<CaseBilling>(`/api/case/${caseId}/billing`, { method: "PUT", body: JSON.stringify(body) });
export const submitCaseBilling = (caseId: number) => call<CaseBilling>(`/api/case/${caseId}/billing/submit`, { method: "POST", body: "{}" });
export const reopenCaseBilling = (caseId: number) => call<CaseBilling>(`/api/case/${caseId}/billing/reopen`, { method: "POST", body: "{}" });

// ---------------------------------------------------------------- ICU daily billing (one order per billing day)
/** A billing day: day 1 from the case start to the next day_start, then whole days (period_start = its id). */
export type BillingDay = {
  day: number | null; period_start: number; period_end: number; date: string | null; current: boolean;
  status: "open" | "closed"; has_order: boolean; order_uuid: string | null; item_count: number; total: number | null;
  closed_at: number | null; closed_by: string | null;
  /** Closed under the previous case before a handover: billed there, read-only here. */
  handover_billed: boolean;
};
export type BillingDevice = { device_id: string; device_type: string | null; label: string | null; kind?: string | null; bound_at?: number; released_at?: number | null };
export type BillingPeriods = {
  /** 'daily' when the workflow bills by day or the case already has billing days. */
  mode: "case" | "daily"; workflow_mode: "case" | "daily";
  /** Daily billing may be switched on by hand (no billing days yet and no case billing with items). */
  can_switch: boolean; case_order_used: boolean;
  timezone: string; day_start: string; case_status: string; days: BillingDay[];
  standing_preview: { period_start: number; items: BillingLine[]; total_amount: number | null };
  devices: BillingDevice[];
  /** Bound devices whose kind is not known: add their device-day item by hand. */
  unknown_devices: BillingDevice[];
};
export type BillingDayOrder = BillingOrder & { kind: "daily"; period_start: number; period_end: number; closed_at: number | null; closed_by: string | null; handover_billed?: boolean };
export type BillingDayDetail = {
  period: { day: number | null; period_start: number; period_end: number; date: string | null; current?: boolean };
  timezone: string; day_start: string; template?: BillingTemplate | null;
  order: BillingDayOrder | null; items: BillingLine[]; total_amount: number | null; locked: boolean;
  /** No order yet (read-only user): what the day's standing charges would be. */
  standing_preview?: { items: BillingLine[]; total_amount: number | null };
};
export type BillingEstimateDay = BillingDay & { source: "order" | "standing_preview" };
export type BillingEstimate = {
  days: Array<Pick<BillingEstimateDay, "day" | "period_start" | "period_end" | "date" | "current" | "status" | "has_order" | "total" | "source">>;
  closed_total: number; open_total: number; projected_to_today: number; to_date_total: number;
  extra_days: number; standing_per_day: number; projected_extra: number; grand_total: number; discharged: boolean;
};
export type BillingDaySave = { items: Array<Pick<BillingLine, "item_code" | "group_code" | "name" | "variant" | "qty" | "source">>; note?: string | null };

const day = (caseId: number, periodStart: number) => `/api/case/${caseId}/billing/periods/${periodStart}`;
export const getBillingPeriods = (caseId: number) => call<BillingPeriods>(`/api/case/${caseId}/billing/periods`);
export const getBillingDay = (caseId: number, periodStart: number) => call<BillingDayDetail>(day(caseId, periodStart));
export const saveBillingDay = (caseId: number, periodStart: number, body: BillingDaySave) =>
  call<BillingDayDetail>(day(caseId, periodStart), { method: "PUT", body: JSON.stringify(body) });
export const generateBillingDay = (caseId: number, periodStart: number) => call<BillingDayDetail>(`${day(caseId, periodStart)}/generate`, { method: "POST", body: "{}" });
export const closeBillingDay = (caseId: number, periodStart: number) => call<BillingDayDetail>(`${day(caseId, periodStart)}/close`, { method: "POST", body: "{}" });
export const reopenBillingDay = (caseId: number, periodStart: number) => call<BillingDayDetail>(`${day(caseId, periodStart)}/reopen`, { method: "POST", body: "{}" });
export const getBillingEstimate = (caseId: number, extraDays = 0) => call<BillingEstimate>(`/api/case/${caseId}/billing/estimate?extra_days=${Math.max(0, Math.floor(extraDays))}`);

// ---------------------------------------------------------------- Canopy
export type CanopyBillingOrder = {
  global_case_id: string; leaf_id: string; leaf_name?: string | null; case_code: string | null; hn: string | null; an: string | null;
  patient_name: string | null; case_status: string | null; status: "draft" | "submitted" | "void";
  anesthesia_start: number | null; anesthesia_end: number | null; surgery_start: number | null; surgery_end: number | null;
  discharge_location: string | null; signers: BillingSigner[]; item_count: number; total_amount: number | null;
  submitted_at: number | null; submitted_by: string | null; order_updated_at: number | null; synced_at: number;
  /** ICU daily billing: one row per billing day (kind daily); the case order has period_start 0. */
  kind?: "case" | "daily"; period_start?: number; period_end?: number | null; closed_at?: number | null; closed_by?: string | null;
  /** OR → Recovery transfer billed as one: the two cases' orders, OR first. */
  combined?: boolean; parts?: CanopyBillingPart[];
};
export type CanopyBillingPart = {
  part: "or" | "recovery" | null; global_case_id: string; leaf_name: string | null; status: string | null;
  item_count: number | null; total_amount: number | null; case_code: string | null;
};
export type CanopyBillingTotal = { item_code: string | null; name: string; group_code: string; unit: string | null; qty: number; cases: number; amount: number | null };

export const getCanopyBillingCatalog = () => call<BillingCatalog>("/api/fleet/billing/catalog");
export const saveCanopyBillingItem = (code: string, item: Partial<BillingItem>) =>
  call<BillingItem>(`/api/fleet/control/billing/items/${encodeURIComponent(code)}`, { method: "PUT", body: JSON.stringify(item) });
export const saveCanopyBillingGroup = (code: string, group: Partial<BillingGroup>) =>
  call<BillingGroup>(`/api/fleet/control/billing/groups/${encodeURIComponent(code)}`, { method: "PUT", body: JSON.stringify(group) });
export function getCanopyBillingOrders(filter: { status?: string; kind?: string; q?: string; from?: number; to?: number }) {
  const params = new URLSearchParams();
  if (filter.status) params.set("status", filter.status);
  if (filter.kind) params.set("kind", filter.kind);
  if (filter.q) params.set("q", filter.q);
  if (filter.from) params.set("from", String(filter.from));
  if (filter.to) params.set("to", String(filter.to));
  return call<{ rows: CanopyBillingOrder[]; item_totals: CanopyBillingTotal[] }>(`/api/fleet/billing/orders?${params}`);
}
export const getCanopyBillingOrder = (globalCaseId: string, periodStart = 0) =>
  call<{ order: CanopyBillingOrder; items: BillingLine[] }>(`/api/fleet/billing/orders/${encodeURIComponent(globalCaseId)}${periodStart ? `?period_start=${periodStart}` : ""}`);
