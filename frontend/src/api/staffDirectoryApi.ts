import { BACKEND_BASE } from "./backendBase";

/** Canopy staff directory (synced to Leafs by ward) and the Leaf's staff sync status. */

export type StaffType = "doctor" | "nurse" | "other";
export type StaffRoleRow = { id: string; display_name: string; sort_order: number | null; staff_type: StaffType; is_active: number };
export type StaffWard = { key: string; name: string; buildingName?: string | null };
export type CanopyStaff = {
  id: number; staff_code: string | null; staff_name: string; staff_role_id: string; staff_role: string;
  hospital_id: string | null; personal_id: string | null; email: string | null;
  th_first_name: string | null; th_last_name: string | null; en_first_name: string | null; en_last_name: string | null;
  innovian_id: string | null; entry_year: number | null; is_active: number; all_units: boolean;
  units: Array<{ key: string; name: string }>; origin_leaf: string | null; needs_review: boolean; updated_at: number | null;
};
export type CanopyStaffSave = Partial<Omit<CanopyStaff, "id" | "units" | "origin_leaf" | "updated_at">> & { unit_keys?: string[] };
export type StaffImportReport = { rows: Array<{ row: number; staff_code: string | null; status: "created" | "updated" | "error"; error?: string }>; created: number; updated: number; errors: number };

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${BACKEND_BASE}${path}`, { ...init, headers: { ...(init.body ? { "Content-Type": "application/json" } : {}) } });
  const data = await res.json().catch(() => ({})) as { error?: unknown; detail?: unknown };
  if (!res.ok) {
    const message = typeof data.error === "string" ? data.error : typeof data.detail === "string" ? data.detail : "";
    throw new Error(message || `Staff request failed (${res.status})`);
  }
  return data as T;
}

export function listCanopyStaff(filter: { q?: string; unit?: string; role_id?: string; review?: boolean; include_inactive?: boolean }) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(filter)) if (value) params.set(key, String(value));
  return call<{ rows: CanopyStaff[]; totals: { active: number; review: number; no_code: number } }>(`/api/fleet/staff?${params}`);
}
export const getCanopyStaffOptions = () => call<{ roles: StaffRoleRow[]; wards: StaffWard[] }>("/api/fleet/staff/options");
export const createCanopyStaff = (body: CanopyStaffSave) => call<CanopyStaff>("/api/fleet/control/staff", { method: "POST", body: JSON.stringify(body) });
export const saveCanopyStaff = (id: number, body: CanopyStaffSave) => call<CanopyStaff>(`/api/fleet/control/staff/${id}`, { method: "PUT", body: JSON.stringify(body) });
export const markCanopyStaffReviewed = (id: number) => call<CanopyStaff>(`/api/fleet/control/staff/${id}/reviewed`, { method: "POST", body: "{}" });
export const importCanopyStaff = (rows: Array<Record<string, string>>) =>
  call<StaffImportReport>("/api/fleet/control/staff/import", { method: "POST", body: JSON.stringify({ rows }) });
export const saveStaffRole = (id: string, body: Omit<StaffRoleRow, "id">) =>
  call<{ roles: StaffRoleRow[] }>(`/api/fleet/control/staff-roles/${encodeURIComponent(id)}`, { method: "PUT", body: JSON.stringify(body) });

// ---------------------------------------------------------------- Leaf
export type StaffSyncDetail = {
  pushed?: number; created?: number; merged?: number; rejected?: number; received?: number; inserted?: number; updated?: number;
  deactivated?: number; conflicts?: number; unchanged?: boolean; unit?: string | null; skipped?: string;
  rejected_items?: Array<{ staff_code: string; reason: string }>;
};
export type StaffSyncStatus = {
  last: { last_attempt_at: number | null; last_ok_at: number | null; last_error: string | null; detail: StaffSyncDetail | null } | null;
  requested_at: number | null;
  counts: { canopy: number; pending: number; rejected: number; local_only: number };
};
export const getStaffSyncStatus = () => call<StaffSyncStatus>("/api/case/staff/sync");
export const requestLeafSync = () => call<{ requested_at: number }>("/api/ward/sync", { method: "POST", body: "{}" });
