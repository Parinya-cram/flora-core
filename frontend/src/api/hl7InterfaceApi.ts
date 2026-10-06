import { BACKEND_BASE } from "./backendBase";
import { readStoredAuthToken } from "./authApi";
import { wardHeaders } from "./wardSelection";

/** HL7 trigger events that may create a Canopy admission. */
export type Hl7CreateOn = "SIU^S12" | "ORM^O01" | "ADT^A01";
export const HL7_CREATE_ON_OPTIONS: Array<{ code: Hl7CreateOn; label: string; note: string }> = [
  { code: "SIU^S12", label: "SIU^S12 — appointment booked", note: "A scheduled procedure/appointment creates a pending admission." },
  { code: "ORM^O01", label: "ORM^O01 — new order", note: "A new procedure order creates a pending admission." },
  { code: "ADT^A01", label: "ADT^A01 — inpatient admit", note: "Off by default: creates an admission for every admitted patient." },
];

export type Hl7Settings = {
  enabled: boolean;
  gatewayUrl: string;
  basicUsername: string;
  hasBasicPassword: boolean;
  hasBearerToken: boolean;
  verifyTls: boolean;
  defaultUnitKey: string | null;
  createOn: string[];
  webhookPath: string;
  webhookUrl: string | null;
  updatedAt: number | null;
  updatedBy: string | null;
};

export type Hl7SettingsInput = {
  enabled: boolean;
  gateway_url: string;
  basic_username: string;
  /** null keeps the stored value. */
  basic_password?: string | null;
  bearer_token?: string | null;
  verify_tls: boolean;
  default_unit_key: string | null;
  create_on: string[];
};

export type Hl7TestResult = { ok: boolean; status?: number; health?: unknown; error?: string };

export type Hl7LocationRow = {
  code: string;
  unit_key: string;
  unit_name: string | null;
  target_leaf_id: string | null;
  leaf_name: string | null;
  note: string | null;
  updated_at: number | null;
};
export type Hl7UnmappedLocation = { code: string; messages: number; last_seen: number | null };

export type Hl7MessageStatus = "applied" | "ignored" | "unrouted" | "error";
export type Hl7MessageRow = {
  id: number;
  received_at: number;
  message_type: string | null;
  control_id: string | null;
  mrn: string | null;
  location_code: string | null;
  status: Hl7MessageStatus | string;
  action: string | null;
  admission_id: string | null;
  error: string | null;
};
export type Hl7Segment = { segment: string; fields: unknown[] };
export type Hl7MessageDetail = Hl7MessageRow & { payload: { segments?: Hl7Segment[]; [key: string]: unknown } | null };

export type Hl7PatientLookup = {
  found: boolean;
  patient: { hn: string; patient_name: string; sex: string | null; dob: string | null; pv1?: unknown } | null;
};

/** Admission row fields added by the HL7 / public API integrations. */
export type AdmissionSourceFields = {
  source?: "canopy" | "hl7" | "api" | string | null;
  accessionNumber?: string | null;
  appointmentId?: string | null;
};

const BASE = "/api/fleet/control/integrations/hl7";

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const token = readStoredAuthToken();
  const response = await fetch(`${BACKEND_BASE}${path}`, {
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
    throw new Error(message || `HL7 interface request failed (${response.status})`);
  }
  return data as T;
}

export const getHl7Settings = () => request<Hl7Settings>(BASE);
export const saveHl7Settings = (input: Hl7SettingsInput) =>
  request<Hl7Settings>(BASE, { method: "PUT", body: JSON.stringify(input) });
export const rotateHl7WebhookToken = () => request<Hl7Settings>(`${BASE}/rotate-webhook-token`, { method: "POST" });
export const testHl7Connection = () => request<Hl7TestResult>(`${BASE}/test`, { method: "POST" });

export const getHl7Locations = () => request<{ rows: Hl7LocationRow[]; unmapped: Hl7UnmappedLocation[] }>(`${BASE}/locations`);
export const saveHl7Location = (code: string, input: { unit_key: string; target_leaf_id?: string | null; note?: string }) =>
  request<unknown>(`${BASE}/locations/${encodeURIComponent(code)}`, { method: "PUT", body: JSON.stringify(input) });
export const deleteHl7Location = (code: string) =>
  request<unknown>(`${BASE}/locations/${encodeURIComponent(code)}`, { method: "DELETE" });

export function listHl7Messages(filter: { status?: string; mrn?: string; limit?: number } = {}) {
  const params = new URLSearchParams();
  if (filter.status) params.set("status", filter.status);
  if (filter.mrn) params.set("mrn", filter.mrn);
  params.set("limit", String(filter.limit ?? 100));
  return request<{ rows: Hl7MessageRow[]; last24h: Record<string, number> }>(`${BASE}/messages?${params.toString()}`);
}
export const getHl7Message = (id: number) => request<{ row: Hl7MessageDetail }>(`${BASE}/messages/${id}`);
export const reprocessHl7Message = (id: number) =>
  request<{ status: string; action: string | null; admission_id: string | null; id: number }>(`${BASE}/messages/${id}/reprocess`, { method: "POST" });
export const reprocessUnroutedHl7 = () =>
  request<{ processed: number; applied: number; still_unrouted: number }>(`${BASE}/messages/reprocess-unrouted`, { method: "POST" });

/** Admit form helper: demographics from the HIS via the HL7 gateway (any user who can admit). */
export const lookupHl7Patient = (mrn: string) =>
  request<Hl7PatientLookup>(`/api/fleet/admissions/hl7-lookup?mrn=${encodeURIComponent(mrn)}`);
