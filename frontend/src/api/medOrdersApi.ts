import { BACKEND_BASE } from "./backendBase";
import { readStoredAuthToken } from "./authApi";

/** Medication orders + MAR (routes/med_orders_leaf.py, migration 0100). Times are epoch ms. */

export type MedCoding = { system: string; code: string; display?: string | null };
export type ApprovalRule = "none" | "order" | "admin" | "both";
export type MedSchedule =
  | { kind: "every"; every_hours: number; anchor?: string }
  | { kind: "times"; times: string[] }
  | { kind: "infusion"; rate: number; rate_unit?: string };
export type MedOrderStatus = "pending_approval" | "active" | "held" | "discontinued" | "completed";
export type MedAdminStatus = "given" | "held" | "refused" | "missed" | "not_given";
export type MarSlotStatus = MedAdminStatus | "due" | "overdue" | "upcoming";

export type MedApproval = {
  id: string; order_id: string; admin_id: string | null; kind: "order" | "admin";
  approver_code: string | null; approver_name: string | null; approver_role: string | null;
  approved_at: number; recorded_by: string | null; note: string | null;
};

export type MedOrder = {
  id: string; case_id: number; item_id: number | null; item_code?: string | null; drug_name: string; codings: MedCoding[];
  order_type: "continue" | "once"; prn: boolean;
  dose: number | null; dose_unit: string | null; route: string | null; form: string | null;
  schedule: MedSchedule | null; start_at: number; end_at: number | null; duration_days: number | null;
  instructions: string | null; indication: string | null; status: MedOrderStatus;
  holds: { from: number; to: number | null; by?: string; reason?: string | null }[];
  approval_required: ApprovalRule; activated_at: number | null;
  source: "leaf" | "his"; his_ref: string | null; his_state: string | null;
  ordered_by: string | null; ordered_at: number; verified_by: string | null; verified_at: number | null;
  discontinued_by: string | null; discontinued_at: number | null; discontinue_reason: string | null;
  updated_at: number; approvals?: MedApproval[];
};

export type MedAdmin = {
  id: string; order_id: string; due_at: number | null; status: MedAdminStatus; given_at: number | null;
  dose: number | null; dose_unit: string | null; route: string | null; site: string | null; note: string | null;
  io_event_id: number | null; io_run_id: number | null; recorded_by: string | null; recorded_at: number; witness_by: string | null;
};

export type MarSlot = { due_at: number; status: MarSlotStatus; admin_id: string | null };
export type RunningInfusion = { order_id: string; run_id: number; started_at: number; rate_value: number | null; rate_unit: string | null };
export type MarOrder = MedOrder & { slots: MarSlot[]; admins: MedAdmin[]; approvals: MedApproval[]; infusion: RunningInfusion | null };
export type Mar = { timezone: string; day_start: string; from: number; to: number; now: number; grace_min: number; orders: MarOrder[] };

export type CatalogDrug = {
  id: number; code: string; name: string; default_unit: string | null; category: string | null;
  approval_required: ApprovalRule; codings: MedCoding[];
};
export type TmtEntry = { code: string; display: string; display_th: string | null; level: string | null; codings: MedCoding[] };

export type MedApprover = {
  staff_id: number; staff_code: string; name: string; role: string | null; seniority: number;
  has_pin: boolean; locked: boolean; is_owner: boolean;
};
export type PinApproval = { staff_code: string; pin: string; note?: string };

export type NewMedOrder = {
  item_id?: number | null; drug_name?: string; codings?: MedCoding[];
  order_type: "continue" | "once"; prn?: boolean; dose?: number | null; dose_unit?: string | null;
  route?: string | null; form?: string | null; schedule?: MedSchedule | null;
  start_at?: number; end_at?: number | null; duration_days?: number | null;
  instructions?: string | null; indication?: string | null; approval_required?: ApprovalRule; approval?: PinApproval;
};

export type MarEntry = {
  order_id: string; due_at: number | null; status: MedAdminStatus; given_at?: number; dose?: number | null;
  dose_unit?: string | null; route?: string | null; site?: string | null; note?: string | null; witness_by?: string | null;
  approval?: PinApproval;
};

/** Error with the server's code (pin_invalid, pin_locked, not_authorized_level, no_pin_set, approval_required, ...). */
export class MedApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const token = readStoredAuthToken();
  const response = await fetch(`${BACKEND_BASE}/api/case${path}`, {
    ...init,
    headers: {
      ...(init.body ? { "Content-Type": "application/json" } : {}),
      ...(token ? { "X-FLORA-Session": token } : {}),
    },
  });
  const data = await response.json().catch(() => ({})) as { error?: unknown; detail?: unknown };
  if (!response.ok) {
    const message = typeof data.error === "string" ? data.error : typeof data.detail === "string" ? data.detail : "";
    throw new MedApiError(response.status, message || `Medication request failed (${response.status})`);
  }
  return data as T;
}

const send = <T,>(method: string, path: string, body?: unknown) =>
  request<T>(path, { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });

type OrderResult = { ok: true; order: MedOrder };

export const searchMedCatalog = (q: string) =>
  request<{ items: CatalogDrug[]; tmt: TmtEntry[] }>(`/med-catalog?q=${encodeURIComponent(q)}`);
export const listMedOrders = (caseId: number) => request<{ orders: MedOrder[] }>(`/${caseId}/med-orders`);
export const createMedOrder = (caseId: number, order: NewMedOrder) => send<OrderResult>("POST", `/${caseId}/med-orders`, order);
export const patchMedOrder = (caseId: number, orderId: string, patch: Partial<NewMedOrder>) =>
  send<OrderResult>("PATCH", `/${caseId}/med-orders/${orderId}`, patch);
export const holdMedOrder = (caseId: number, orderId: string, reason?: string) =>
  send<OrderResult>("POST", `/${caseId}/med-orders/${orderId}/hold`, { reason });
export const resumeMedOrder = (caseId: number, orderId: string) => send<OrderResult>("POST", `/${caseId}/med-orders/${orderId}/resume`, {});
export const discontinueMedOrder = (caseId: number, orderId: string, reason: string) =>
  send<OrderResult>("POST", `/${caseId}/med-orders/${orderId}/discontinue`, { reason });
export const verifyMedOrder = (caseId: number, orderId: string) => send<OrderResult>("POST", `/${caseId}/med-orders/${orderId}/verify`, {});
export const approveMedOrder = (caseId: number, orderId: string, approval: PinApproval & { kind: "order" | "admin"; admin_id?: string }) =>
  send<OrderResult & { approval: MedApproval }>("POST", `/${caseId}/med-orders/${orderId}/approve`, approval);
export const getMedApprovers = (caseId: number) =>
  request<{ owner_seniority: number | null; approvers: MedApprover[] }>(`/${caseId}/med-approvers`);

/** Default window: the day (workflow day_start, else midnight) containing now. */
export const getMar = (caseId: number, from?: number, to?: number) =>
  request<Mar>(`/${caseId}/mar${from === undefined ? "" : `?from=${from}${to === undefined ? "" : `&to=${to}`}`}`);
export const recordMar = (caseId: number, entry: MarEntry) =>
  send<{ ok: true; admin: MedAdmin; approval: MedApproval | null }>("POST", `/${caseId}/mar`, entry);
export const correctMar = (caseId: number, adminId: string, patch: Partial<MarEntry>) =>
  send<{ ok: true; admin: MedAdmin }>("PATCH", `/${caseId}/mar/${adminId}`, patch);
export const voidMar = (caseId: number, adminId: string, reason?: string) =>
  send<{ ok: true }>("DELETE", `/${caseId}/mar/${adminId}`, { reason });

/** The signed-in user's own staff PIN (PIN in the body only, never in a URL). */
export const getOwnPinState = () =>
  request<{ linked: boolean; pin_set: boolean; pin_set_at: number | null; locked_until: number | null }>("/staff-pin");
export const setOwnPin = (pin: string, currentPin?: string) =>
  send<{ ok: true }>("PUT", "/staff-pin", { pin, ...(currentPin ? { current_pin: currentPin } : {}) });
export const resetStaffPin = (staffId: number) => send<{ ok: true }>("DELETE", `/staff-pin/${staffId}`);

export const needsOrderApproval = (rule: ApprovalRule | null | undefined) => rule === "order" || rule === "both";
export const needsAdminApproval = (rule: ApprovalRule | null | undefined) => rule === "admin" || rule === "both";
