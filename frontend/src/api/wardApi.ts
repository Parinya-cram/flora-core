import { BACKEND_BASE } from "./backendBase";
import { readStoredAuthToken } from "./authApi";

/** Leaf Ward page: local data first, refreshed from Canopy by the sync worker. */

export type WardCase = {
  case_id: number;
  case_code: string;
  hn: string;
  admission_number?: string | null;
  patient_display_name?: string | null;
  status: "active" | "discharged" | "archived";
  start_time: number;
  discharge_time?: number | null;
  admission_source?: string;
  handover_from_leaf_id?: string | null;
  handover_to_leaf_id?: string | null;
};

export type WardAdmission = {
  id: string;
  hn?: string;
  admissionNumber?: string;
  patient?: { patient_name?: string };
  admission?: { operation?: string; diagnosis?: string };
  scheduledAt?: number | null;
  targetLeafId?: string | null;
};

export type WardPeerCase = {
  global_case_id: string;
  source_case_id: string;
  case_code?: string;
  hn: string;
  admission_number?: string | null;
  patient_name?: string | null;
  start_time: number;
  synced_at?: number | null;
  export_revision?: number | null;
};

export type WardPeer = {
  leaf_id: string;
  name: string;
  last_seen?: number | null;
  online: boolean;
  active_case?: WardPeerCase | null;
};

export type GatewayDevice = {
  gateway_id?: string;
  device_id: string;
  leaf_id?: string | null;
  device_type: string;
  label?: string | null;
  enabled?: boolean;
  status?: string;
  is_online?: boolean;
  last_seen_ts?: number | null;
};

export type RegisteredGateway = {
  gateway_id: string;
  site_name: string;
  data_api_url?: string | null;
  last_seen?: number | null;
  online: boolean;
  config_pending: boolean;
  desired_version?: number | null;
  applied_version?: number | null;
  devices: GatewayDevice[];
};

export type SyncComponent = { component: string; last_attempt_at?: number | null; last_ok_at?: number | null; last_error?: string | null };

export type WardOverview = {
  leaf: { id: string; name: string };
  ward: { key?: string | null; name?: string | null };
  workstation: Record<string, string | null>;
  cases: WardCase[];
  admissions: WardAdmission[];
  peers: WardPeer[];
  gateways: RegisteredGateway[];
  device_source?: { gateway_id?: string | null; data_api_url: string; configured_at: number; configured_by?: string } | null;
  sync: { auto_interval_sec: number; requested_at?: number | null; ward_synced_at?: number | null; last_ok_at?: number | null; components: SyncComponent[] };
};

export type HandoverResult = {
  case_id: number;
  case_code: string;
  rows: Record<string, number>;
  skipped: string[];
  from_leaf_id: string;
  moved_devices: { gateway_id: string; device_ids: string[] }[];
  export_age_sec?: number;
};

export type GatewayTest = { reachable: boolean; error?: string; latency_ms?: number; devices?: GatewayDevice[] };
export type GatewayVerify = {
  reachable: boolean;
  error?: string;
  devices?: GatewayDevice[];
  latest?: Record<string, { value: unknown; unit?: string | null; device_id: string; system_ts: number }>;
  rows?: number;
};

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const token = readStoredAuthToken();
  const response = await fetch(`${BACKEND_BASE}/api/ward${path}`, {
    ...init,
    headers: {
      ...(init.body ? { "Content-Type": "application/json" } : {}),
      ...(token ? { "X-FLORA-Session": token } : {}),
    },
  });
  const data = await response.json().catch(() => ({})) as { error?: unknown; detail?: unknown };
  if (!response.ok) {
    const message = typeof data.error === "string" ? data.error : typeof data.detail === "string" ? data.detail : "";
    throw new Error(message || `Ward request failed (${response.status})`);
  }
  return data as T;
}

const post = <T,>(path: string, body: unknown) => request<T>(path, { method: "POST", body: JSON.stringify(body) });

export const getWardOverview = () => request<WardOverview>("/overview");
export const requestWardSync = () => request<{ requested_at: number }>("/sync", { method: "POST" });
export const takeOverCase = (globalCaseId: string, moveDevices: boolean) =>
  post<HandoverResult>("/handover", { global_case_id: globalCaseId, move_devices: moveDevices });
export const testGateway = (dataApiUrl: string) => post<GatewayTest>("/gateway/test", { data_api_url: dataApiUrl });
export const assignGatewayDevices = (gatewayId: string, deviceIds: string[]) =>
  post<{ desired_version: number }>("/gateway/assign", { gateway_id: gatewayId, device_ids: deviceIds, release_others: true });
export const verifyGateway = (dataApiUrl: string) => post<GatewayVerify>("/gateway/verify", { data_api_url: dataApiUrl });
export const saveDeviceSource = (gatewayId: string | null, dataApiUrl: string) =>
  request<{ device_source: unknown }>("/gateway/source", { method: "PUT", body: JSON.stringify({ gateway_id: gatewayId, data_api_url: dataApiUrl }) });
