import { BACKEND_BASE } from "./backendBase";
import { readStoredAuthToken } from "./authApi";
import { wardHeaders } from "./wardSelection";

/**
 * Form tabs a ward tablet may fill for a Canopy admission before (and while)
 * the bedside Leaf runs the case. Ids match FormView's tab ids.
 */
export const CANOPY_TABLET_FORM_TABS: readonly string[] = ["preop", "checklist"];

export type AdmissionStatus = "pending" | "started" | "cancelled" | "conflict";
export type AdmissionListFilter = "open" | "pending" | "started" | "cancelled" | "conflict" | "all";

export type AdmissionPatient = {
  patient_name: string;
  sex?: string | null;
  dob?: string | null;
  age_text?: string | null;
  weight_kg?: number | null;
  height_cm?: number | null;
};

export type AdmissionDetails = {
  diagnosis?: string | null;
  operation?: string | null;
  anaesthesia_technique?: string | null;
  asa_status?: string | null;
  asa_emergency?: boolean;
  surgical_priority?: string | null;
  surgeon?: string | null;
};

export type Admission = {
  id: string;
  unitKey: string;
  unitName: string;
  targetLeafId: string | null;
  targetLeafName: string | null;
  hn: string;
  admissionNumber: string | null;
  patient: AdmissionPatient;
  admission: AdmissionDetails;
  scheduledAt: number | null;
  note: string | null;
  status: AdmissionStatus;
  claimedLeafId: string | null;
  claimedLeafName: string | null;
  claimedAt: number | null;
  caseStatus: "active" | "discharged" | "archived" | null;
  globalCaseId: string | null;
  formUpdatedAt: number | null;
  formFieldCount: number;
  createdBy: string | null;
  createdAt: number;
  updatedAt: number;
  formEditable: boolean;
};

export type AdmissionWardOption = {
  key: string;
  name: string;
  buildingName?: string | null;
  hospitalName?: string | null;
  leafCount: number;
  isDemo?: boolean;
  leaves: Array<{ leafId: string; name: string; bedName?: string | null }>;
};

export type AdmissionInput = {
  unit_key: string;
  target_leaf_id?: string | null;
  hn: string;
  admission_number?: string | null;
  patient: AdmissionPatient;
  admission: AdmissionDetails & { asa_emergency: boolean };
  scheduled_at?: number | null;
  note?: string | null;
};

export type AdmissionForm = {
  ok: boolean;
  admission: Admission;
  draft: Record<string, unknown>;
  versions: Record<string, number>;
  updated_at: number | null;
};

const BASE = "/api/fleet/admissions";

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const token = readStoredAuthToken();
  const response = await fetch(`${BACKEND_BASE}${BASE}${path}`, {
    ...init,
    headers: {
      ...(init.body ? { "Content-Type": "application/json" } : {}),
      ...wardHeaders(),
      ...(token ? { "X-FLORA-Session": token } : {}),
    },
  });
  const data = await response.json().catch(() => ({})) as { error?: unknown; detail?: unknown };
  if (!response.ok) {
    const message = typeof data.error === "string" ? data.error : typeof data.detail === "string" ? data.detail : "";
    throw new Error(message || `Admission request failed (${response.status})`);
  }
  return data as T;
}

export async function getAdmissionOptions(): Promise<AdmissionWardOption[]> {
  const data = await request<{ wards?: AdmissionWardOption[] }>("/options");
  return Array.isArray(data.wards) ? data.wards : [];
}

export async function listAdmissions(filter: AdmissionListFilter = "open"): Promise<Admission[]> {
  const query = filter === "all" ? "" : `?status=${encodeURIComponent(filter)}`;
  const data = await request<{ rows?: Admission[] }>(query);
  return Array.isArray(data.rows) ? data.rows : [];
}

export async function createAdmission(input: AdmissionInput): Promise<Admission> {
  const data = await request<{ row: Admission }>("", { method: "POST", body: JSON.stringify(input) });
  return data.row;
}

export async function updateAdmission(id: string, input: AdmissionInput): Promise<Admission> {
  const data = await request<{ row: Admission }>(`/${encodeURIComponent(id)}`, { method: "PUT", body: JSON.stringify(input) });
  return data.row;
}

export async function cancelAdmission(id: string): Promise<Admission> {
  const data = await request<{ row: Admission }>(`/${encodeURIComponent(id)}/cancel`, { method: "POST" });
  return data.row;
}

export async function getAdmissionForm(id: string): Promise<AdmissionForm> {
  const data = await request<AdmissionForm>(`/${encodeURIComponent(id)}/form`);
  return { ...data, draft: data.draft && typeof data.draft === "object" ? data.draft : {} };
}

export async function patchAdmissionForm(
  id: string,
  patch: Record<string, unknown>,
): Promise<{ draft: Record<string, unknown>; updated_at: number | null }> {
  return request(`/${encodeURIComponent(id)}/form`, { method: "PATCH", body: JSON.stringify({ patch }) });
}

/** Short local date/time for admission cards (time only when `timeOnly`). */
export function formatAdmissionTime(ms: number | null | undefined, timeOnly = false): string {
  if (!ms || !Number.isFinite(ms)) return "";
  const date = new Date(ms);
  if (timeOnly) return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return date.toLocaleString([], { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
}
