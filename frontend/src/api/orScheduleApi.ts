import { BACKEND_BASE } from "./backendBase";
import { readStoredAuthToken } from "./authApi";
import { wardHeaders } from "./wardSelection";
import type { AdmissionPatient } from "./admissionApi";
import type { StaffRoleRow } from "./staffDirectoryApi";

/** Canopy → OR schedule: sessions (admissions booked into OR rooms) and their OR-ward journey. */

export type JourneyState = "booked" | "assigned" | "in_or" | "awaiting_recovery" | "assigned_recovery" | "in_recovery" | "discharged"
  | "cancelled" | "postponed" | "no_show" | "miscreate";
export const CLOSED_STATES = ["cancelled", "postponed", "no_show", "miscreate"] as const;
export type TeamMember = { staff_code: string | null; role_id: string; name: string | null; slot?: string };
export type OrConflict = { kind: "room" | "staff"; with: string; staff_code?: string };
export type SessionDetails = {
  diagnosis?: string | null; operation?: string | null; anaesthesia_technique?: string | null; asa_status?: string | null;
  asa_emergency?: boolean; surgical_priority?: string | null; surgeon?: string | null; workflow_id?: string | null;
  position?: string | null; source_ward?: string | null; post_op_ward?: string | null; emergency?: boolean;
};
export type OrSession = {
  id: string; unitKey: string; unitName: string | null; roomId: number | null; roomName: string | null;
  scheduledAt: number | null; durationMin: number; hn: string; admissionNumber: string | null; patient: AdmissionPatient;
  admission: SessionDetails; orTypeCode: string | null; equipment: string[]; team: TeamMember[]; note: string | null;
  journeyState: JourneyState; stateLabel: string; status: string; caseStatus: string | null; source: string;
  bedName: string | null; leafName: string | null; movedInAt: number | null; movedOutAt: number | null; dischargedAt: number | null;
  dischargeDestination: string | null; preopFilled: boolean; targetLeafId: string | null; bedId: number | null;
  moveInRequestedAt: number | null; moveInRequestedBy: string | null; moveOutRequestedAt: number | null;
  dischargeRequestedAt: number | null; recoveryInAt: number | null; dischargeNote: string | null; updatedAt: number | null; updatedBy: string | null;
  /** OR → Recovery transfer: one combined bill or separate bills; the closed OR case's global id. */
  billingMode?: BillingMode; orGlobalCaseId?: string | null; globalCaseId?: string | null;
  conflicts?: OrConflict[];
};
export type OrBed = { id: number; name: string; leaf_id: string | null; leaf_name: string | null; active_case: { hn: string; case_code: string } | null };
export type OrRoom = { id: number; name: string; room_type: "or" | "recovery" | "other" | null; or_type_code: string | null; zone: string | null; beds: OrBed[] };
export type OrDay = { rooms: OrRoom[]; sessions: OrSession[]; unscheduled: OrSession[]; now: number };
export type OrCodeRow = { code: string; name: string; group_name?: string | null; sort_order: number; is_active: boolean };
export type OrOptions = {
  wards: Array<{ key: string; name: string; buildingName?: string | null }>;
  orTypes: OrCodeRow[]; equipment: OrCodeRow[]; roles: StaffRoleRow[]; positions: string[]; techniques: string[];
  slotMinutes: number; stateLabels: Record<JourneyState, string>;
};
export type SessionEvent = { event: string; at: number; source: string; actor: string | null; detail: Record<string, unknown>; leaf_id: string | null; location_name: string | null };
export type SessionInput = {
  room_location_id: number; scheduled_at: number; duration_min: number; hn: string; admission_number?: string | null;
  patient: AdmissionPatient; admission: SessionDetails & { asa_emergency: boolean; emergency: boolean };
  or_type_code?: string | null; equipment: string[]; team: TeamMember[]; note?: string | null;
};

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const token = readStoredAuthToken();
  const response = await fetch(`${BACKEND_BASE}${path}`, {
    ...init,
    headers: { ...(init.body ? { "Content-Type": "application/json" } : {}), ...wardHeaders(), ...(token ? { "X-FLORA-Session": token } : {}) },
  });
  const data = await response.json().catch(() => ({})) as { error?: unknown; detail?: unknown };
  if (!response.ok) {
    const message = typeof data.error === "string" ? data.error : typeof data.detail === "string" ? data.detail : "";
    throw new Error(message || `OR schedule request failed (${response.status})`);
  }
  return data as T;
}

const OR = "/api/fleet/admissions/or";
export const getOrOptions = () => request<OrOptions>(`${OR}/options`);
export const getOrDay = (unitKey: string, from: number, to: number) =>
  request<OrDay>(`${OR}/day?unit_key=${encodeURIComponent(unitKey)}&from=${from}&to=${to}`);
export const getOrSession = (id: string) => request<{ row: OrSession; events: SessionEvent[] }>(`${OR}/sessions/${encodeURIComponent(id)}`);
export const createOrSession = (body: SessionInput) => request<{ row: OrSession }>(`${OR}/sessions`, { method: "POST", body: JSON.stringify(body) });
export const updateOrSession = (id: string, body: SessionInput) =>
  request<{ row: OrSession }>(`${OR}/sessions/${encodeURIComponent(id)}`, { method: "PUT", body: JSON.stringify(body) });
export const moveOrSlot = (id: string, body: { room_location_id?: number; scheduled_at?: number; duration_min?: number }) =>
  request<{ row: OrSession }>(`${OR}/sessions/${encodeURIComponent(id)}/slot`, { method: "PUT", body: JSON.stringify(body) });
export const cancelOrSession = (id: string, reason: string) =>
  request<{ row: OrSession }>(`${OR}/sessions/${encodeURIComponent(id)}/cancel`, { method: "POST", body: JSON.stringify({ reason }) });
export const closeOrSession = (id: string, state: (typeof CLOSED_STATES)[number], reason: string) =>
  request<{ row: OrSession }>(`${OR}/sessions/${encodeURIComponent(id)}/close`, { method: "POST", body: JSON.stringify({ state, reason }) });
export const assignOrBed = (id: string, bedId: number) =>
  request<{ row: OrSession; warning: string | null }>(`${OR}/sessions/${encodeURIComponent(id)}/assign`, { method: "POST", body: JSON.stringify({ bed_location_id: bedId }) });
export const unassignOrBed = (id: string) => request<{ row: OrSession }>(`${OR}/sessions/${encodeURIComponent(id)}/unassign`, { method: "POST", body: "{}" });
export const requestOrMoveIn = (id: string) => request<{ row: OrSession }>(`${OR}/sessions/${encodeURIComponent(id)}/move-in`, { method: "POST", body: "{}" });
export type BillingMode = "combined" | "separate";
/** Transfer to Recovery: the room's Leaf closes the OR case; the recovery bed starts a new case. */
export const requestOrMoveOut = (id: string, billingMode?: BillingMode) =>
  request<{ row: OrSession }>(`${OR}/sessions/${encodeURIComponent(id)}/move-out`, { method: "POST", body: JSON.stringify(billingMode ? { billing_mode: billingMode } : {}) });
export const setOrBillingMode = (id: string, billingMode: BillingMode) =>
  request<{ row: OrSession }>(`${OR}/sessions/${encodeURIComponent(id)}/billing-mode`, { method: "POST", body: JSON.stringify({ billing_mode: billingMode }) });
export const assignOrRecovery = (id: string, bedId: number) =>
  request<{ row: OrSession; warning: string | null }>(`${OR}/sessions/${encodeURIComponent(id)}/assign-recovery`, { method: "POST", body: JSON.stringify({ bed_location_id: bedId }) });
export const requestOrDischarge = (id: string, destination: string, note: string) =>
  request<{ row: OrSession }>(`${OR}/sessions/${encodeURIComponent(id)}/discharge`, { method: "POST", body: JSON.stringify({ destination, note }) });
/** Where a patient goes when leaving the OR ward. */
export const DESTINATIONS = ["ICU", "IPD ward", "Home", "Other hospital", "Other"];
export const restoreOrSession = (id: string) => request<{ row: OrSession }>(`${OR}/sessions/${encodeURIComponent(id)}/restore`, { method: "POST", body: "{}" });
export const saveOrRoom = (id: number, body: { room_type: string | null; or_type_code: string | null }) =>
  request<{ id: number }>(`/api/fleet/control/or/rooms/${id}`, { method: "PUT", body: JSON.stringify(body) });
export const saveOrType = (code: string, body: Partial<OrCodeRow>) =>
  request<OrCodeRow>(`/api/fleet/control/or/types/${encodeURIComponent(code)}`, { method: "PUT", body: JSON.stringify(body) });
export const saveOrEquipment = (code: string, body: Partial<OrCodeRow>) =>
  request<OrCodeRow>(`/api/fleet/control/or/equipment/${encodeURIComponent(code)}`, { method: "PUT", body: JSON.stringify(body) });

/** Board colours by state (as on the OR status board). */
export const STATE_TONE: Record<string, { block: string; chip: string }> = {
  Appointed: { block: "bg-[var(--app-control-bg)] border-[var(--app-border)] text-[var(--app-text)]", chip: "bg-white text-gray-800 border-gray-300" },
  Waiting: { block: "bg-orange-400/80 border-orange-500 text-gray-950", chip: "bg-orange-400 text-gray-950 border-orange-500" },
  Operation: { block: "bg-rose-500/85 border-rose-600 text-white", chip: "bg-rose-500 text-white border-rose-600" },
  Recovery: { block: "bg-lime-300/90 border-lime-500 text-gray-950", chip: "bg-lime-300 text-gray-950 border-lime-500" },
  Completed: { block: "bg-green-800 border-green-900 text-white", chip: "bg-green-800 text-white border-green-900" },
  Postponed: { block: "bg-transparent border-dashed border-sky-500 text-[var(--app-muted)]", chip: "bg-transparent text-sky-600 border-sky-500" },
  "No-show": { block: "bg-transparent border-dashed border-gray-500 text-[var(--app-muted)]", chip: "bg-transparent text-gray-500 border-gray-500" },
  Miscreate: { block: "bg-transparent border-dashed border-gray-400 text-[var(--app-muted)] line-through", chip: "bg-transparent text-gray-400 border-gray-400" },
  Cancelled: { block: "bg-transparent border-dashed border-[var(--app-border)] text-[var(--app-muted)] line-through", chip: "bg-transparent text-gray-500 border-gray-400" },
};
