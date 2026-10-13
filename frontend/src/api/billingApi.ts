import { BACKEND_BASE } from "./backendBase";

/** OR billing checklist: master data synced from Canopy, one order per case. */

export type BillingGroup = { code: string; name: string; form_column: number; sort_order: number; is_active: number; updated_at?: number };
export type BillingQtyMode = "count" | "hours" | "used";
export type BillingItem = {
  code: string; group_code: string; name: string; unit: string | null; qty_mode: BillingQtyMode;
  variant_label: string | null; io_item_code: string | null; charge_code: string | null; unit_price: number | null;
  sort_order: number; is_active: number; updated_at?: number;
};
export type BillingCatalog = { version: number; groups: BillingGroup[]; items: BillingItem[]; synced_version?: number };

export type BillingSignerRole = "surgeon" | "anesthesiologist" | "nurse1" | "nurse2";
export type BillingSigner = { role: BillingSignerRole; name: string; staff_id?: number };
export type BillingLine = {
  line_no?: number; item_code: string | null; group_code: string; name: string; variant: string | null; qty: number;
  unit?: string | null; qty_mode?: BillingQtyMode; unit_price?: number | null; amount?: number | null;
  source?: "manual" | "io_suggestion"; note?: string | null;
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

// ---------------------------------------------------------------- Canopy
export type CanopyBillingOrder = {
  global_case_id: string; leaf_id: string; leaf_name?: string | null; case_code: string | null; hn: string | null; an: string | null;
  patient_name: string | null; case_status: string | null; status: "draft" | "submitted" | "void";
  anesthesia_start: number | null; anesthesia_end: number | null; surgery_start: number | null; surgery_end: number | null;
  discharge_location: string | null; signers: BillingSigner[]; item_count: number; total_amount: number | null;
  submitted_at: number | null; submitted_by: string | null; order_updated_at: number | null; synced_at: number;
};
export type CanopyBillingTotal = { item_code: string | null; name: string; group_code: string; unit: string | null; qty: number; cases: number; amount: number | null };

export const getCanopyBillingCatalog = () => call<BillingCatalog>("/api/fleet/billing/catalog");
export const saveCanopyBillingItem = (code: string, item: Partial<BillingItem>) =>
  call<BillingItem>(`/api/fleet/control/billing/items/${encodeURIComponent(code)}`, { method: "PUT", body: JSON.stringify(item) });
export const saveCanopyBillingGroup = (code: string, group: Partial<BillingGroup>) =>
  call<BillingGroup>(`/api/fleet/control/billing/groups/${encodeURIComponent(code)}`, { method: "PUT", body: JSON.stringify(group) });
export function getCanopyBillingOrders(filter: { status?: string; q?: string; from?: number; to?: number }) {
  const params = new URLSearchParams();
  if (filter.status) params.set("status", filter.status);
  if (filter.q) params.set("q", filter.q);
  if (filter.from) params.set("from", String(filter.from));
  if (filter.to) params.set("to", String(filter.to));
  return call<{ rows: CanopyBillingOrder[]; item_totals: CanopyBillingTotal[] }>(`/api/fleet/billing/orders?${params}`);
}
export const getCanopyBillingOrder = (globalCaseId: string) =>
  call<{ order: CanopyBillingOrder; items: BillingLine[] }>(`/api/fleet/billing/orders/${encodeURIComponent(globalCaseId)}`);
