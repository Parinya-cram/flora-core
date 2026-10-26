import { BACKEND_BASE } from "./backendBase";
import { readStoredAuthToken } from "./authApi";
import { wardHeaders } from "./wardSelection";

/** Outbound interface: Canopy sends vitals candles and case records to hospital systems (HL7 v2 or FHIR R4). */
export type OutboundFormat = "hl7v2" | "fhir";
export type OutboundKind = "vitals" | "form" | "discharge";

export type DocumentFeed = { enabled: boolean; timing: "delay" | "daily"; delay_seconds: number; daily_at: string; pdf: boolean };
export type VitalsFeed = { enabled: boolean; interval_minutes: number };
export type OutboundFeeds = { vitals: VitalsFeed; form: DocumentFeed; discharge: DocumentFeed };

export type OutboundDestinationInput = {
  name: string;
  enabled: boolean;
  format: OutboundFormat;
  hl7_version: string;
  host: string;
  port: number | null;
  url: string;
  auth_type: "none" | "basic" | "bearer";
  username: string;
  /** null keeps the stored value. */
  password?: string | null;
  bearer_token?: string | null;
  verify_tls: boolean;
  /** HL7: MLLP over TLS. ca_cert empty = system CAs; client_cert + client_key for mutual TLS. */
  tls: boolean;
  ca_cert: string;
  client_cert: string;
  /** null keeps the stored key. */
  client_key?: string | null;
  identity: "full" | "masked";
  /** Ward keys, or ["*"] for every ward. */
  unit_keys: string[];
  sending_application: string;
  sending_facility: string;
  receiving_application: string;
  receiving_facility: string;
  feeds: OutboundFeeds;
};

export type OutboundDestination = Omit<OutboundDestinationInput, "password" | "bearer_token" | "client_key"> & {
  id: string;
  has_password: boolean;
  has_bearer_token: boolean;
  has_client_key: boolean;
  created_at: number;
  updated_at: number;
  updated_by: string | null;
  queued: number;
  sent_24h: number;
  failed_24h: number;
  last_sent_at: number | null;
};

export type OutboundWard = { key: string; name: string; buildingName?: string | null; isDemo?: boolean };

export type OutboundMessageStatus = "pending" | "sent" | "error" | "failed" | "cancelled";
export type OutboundMessageRow = {
  id: string;
  destination_id: string;
  destination_name: string;
  kind: OutboundKind | "test";
  case_id: string | null;
  period_start: number | null;
  period_end: number | null;
  status: OutboundMessageStatus;
  due_at: number;
  attempts: number;
  next_attempt_at: number;
  control_id: string | null;
  message_type: string | null;
  error: string | null;
  created_at: number;
  sent_at: number | null;
  case_code: string | null;
  hn: string | null;
};
export type OutboundMessageDetail = OutboundMessageRow & { payload: string | null; response: string | null; identity: string };

export type OutboundTestCase = { case_id: string; case_code: string | null; status: string; start_time: number | null; ward: string | null; bed: string | null };
export type OutboundTestResult = { ok: boolean; error?: string; response?: string; note?: string; message: OutboundMessageDetail };

export const DEFAULT_FEEDS: OutboundFeeds = {
  vitals: { enabled: false, interval_minutes: 5 },
  form: { enabled: false, timing: "delay", delay_seconds: 60, daily_at: "00:00", pdf: true },
  discharge: { enabled: false, timing: "delay", delay_seconds: 60, daily_at: "00:00", pdf: true },
};

const BASE = "/api/fleet/control/integrations/outbound";

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
    const detail = Array.isArray(data.detail) ? data.detail.map(item => (item as { msg?: string }).msg).filter(Boolean).join("; ") : data.detail;
    const message = typeof data.error === "string" ? data.error : typeof detail === "string" ? detail : "";
    throw new Error(message || `Outbound interface request failed (${response.status})`);
  }
  return data as T;
}

export const getOutbound = () => request<{ rows: OutboundDestination[]; wards: OutboundWard[] }>(BASE);
export const createOutboundDestination = (input: OutboundDestinationInput) =>
  request<OutboundDestination>(BASE, { method: "POST", body: JSON.stringify(input) });
export const saveOutboundDestination = (id: string, input: OutboundDestinationInput) =>
  request<OutboundDestination>(`${BASE}/${id}`, { method: "PUT", body: JSON.stringify(input) });
export const deleteOutboundDestination = (id: string) => request<unknown>(`${BASE}/${id}`, { method: "DELETE" });
export const getOutboundTestCases = (id: string) => request<{ rows: OutboundTestCase[] }>(`${BASE}/${id}/cases`);
export const testOutboundDestination = (id: string, kind: OutboundKind, caseId?: string) =>
  request<OutboundTestResult>(`${BASE}/${id}/test`, { method: "POST", body: JSON.stringify({ kind, case_id: caseId || null }) });

export function listOutboundMessages(filter: { destination_id?: string; status?: string; kind?: string; limit?: number } = {}) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(filter)) if (value !== undefined && value !== "") params.set(key, String(value));
  return request<{ rows: OutboundMessageRow[] }>(`${BASE}/messages?${params.toString()}`);
}
export const getOutboundMessage = (id: string) => request<OutboundMessageDetail>(`${BASE}/messages/${id}`);
export const resendOutboundMessage = (id: string) => request<unknown>(`${BASE}/messages/${id}/resend`, { method: "POST" });
export const cancelOutboundMessage = (id: string) => request<unknown>(`${BASE}/messages/${id}/cancel`, { method: "POST" });
