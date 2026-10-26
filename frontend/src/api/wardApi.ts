import { BACKEND_BASE } from "./backendBase";
import { readStoredAuthToken } from "./authApi";
import type { DeviceBindingInput } from "./caseApi";

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
  /** Multi-case Leaf: bed within the room. */
  bed_label?: string | null;
};

export type WardAdmission = {
  id: string;
  hn?: string;
  admissionNumber?: string;
  patient?: { patient_name?: string };
  admission?: { operation?: string; diagnosis?: string };
  scheduledAt?: number | null;
  targetLeafId?: string | null;
  /** OR schedule booking assigned to this bed by the ward desk. */
  orSession?: {
    room_name?: string | null; bed_name?: string | null; journey_state?: string; duration_min?: number | null;
    /** "recovery": the case moved out of the OR room and continues on this bed. */
    stage?: "or" | "recovery"; global_case_id?: string;
    team?: Array<{ name?: string | null; staff_code?: string | null; role_id: string }>;
    move_in_requested_at?: number | null; move_in_requested_by?: string | null;
  } | null;
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
  /** Multi-case peers report every active case; active_case stays the newest one. */
  active_cases?: (WardPeerCase & { bed_label?: string | null })[] | null;
};

export type GatewayDevice = {
  gateway_id?: string;
  device_id: string;
  leaf_id?: string | null;
  device_type: string;
  label?: string | null;
  enabled?: boolean;
  status?: string;
  parser_status?: string | null;
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

/** A device placed at a bed in Canopy (Devices → bed), as its gateway knows it. */
export type WardBedDevice = { gateway_id: string; device_id: string; label?: string | null; device_type?: string | null; category?: string | null };
/** A bed this Leaf looks after (Canopy → Topology → Physical). One session (patient) per bed. */
export type WardBed = {
  bed_location_id: number;
  bed_name: string;
  bed_code?: string | null;
  room_name?: string | null;
  room_type?: string | null;
  is_primary: boolean;
  devices: WardBedDevice[];
};

export type WardOverview = {
  leaf: { id: string; name: string };
  ward: { key?: string | null; name?: string | null };
  workstation: Record<string, string | null>;
  cases: WardCase[];
  admissions: WardAdmission[];
  peers: WardPeer[];
  gateways: RegisteredGateway[];
  device_source?: { gateway_id?: string | null; data_api_url: string; configured_at: number; configured_by?: string } | null;
  adopted?: string[] | null;   // device-type codes downloaded for this hospital; null = show all
  /** Multi-gateway Leaf (migration 0090); absent on older Leaf APIs. */
  gateway_links?: GatewayLink[] | null;
  /** Beds this Leaf looks after; empty for a Leaf with one bed. Absent on older Leaf APIs. */
  beds?: WardBed[];
  sync: { auto_interval_sec: number; requested_at?: number | null; ward_synced_at?: number | null; last_ok_at?: number | null; components: SyncComponent[] };
  /** Transfer (no discharge): offered to this Leaf, waiting for Receive. Absent on older Leaf APIs. */
  transfers_in?: WardTransfer[];
  /** Cases of this Leaf offered to another bed, waiting there. */
  transfers_out?: WardTransfer[];
};

export type WardTransfer = {
  handover_id: number;
  kind: "transfer" | "bed_move";
  global_case_id: string;
  from_leaf_id: string;
  from_leaf_name?: string | null;
  source_case_id: string;
  to_leaf_id: string;
  to_leaf_name?: string | null;
  to_bed_location_id?: number | null;
  to_bed_label?: string | null;
  from_bed_label?: string | null;
  initiated_from?: "leaf" | "canopy" | null;
  requested_by?: string | null;
  note?: string | null;
  created_at: number;
  hn?: string | null;
  patient_name?: string | null;
  admission_number?: string | null;
};

export type TransferBed = {
  bed_location_id: number;
  bed_name: string;
  bed_code?: string | null;
  room_name?: string | null;
  room_type?: string | null;
  leaf_id: string;
  leaf_name?: string | null;
  is_primary: boolean;
  busy?: { leaf_id: string; hn: string; case_code?: string | null } | null;
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

/** A gateway this Leaf reads from / streams from (leaf_gateway_link). The token is never returned. */
export type GatewayLink = {
  id: number;
  gateway_id?: string | null;
  label?: string | null;
  data_api_url?: string | null;
  stream_url?: string | null;
  has_token: boolean;
  is_default: boolean;
  created_at?: number | string | null;
  updated_at?: number | string | null;
};
export type GatewayLinkInput = {
  gateway_id?: string | null;
  label?: string | null;
  data_api_url?: string | null;
  stream_url?: string | null;
  /** Only sent when changed; empty string clears it. */
  token?: string;
  is_default?: boolean;
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
/** The devices fixed at one of this Leaf's beds, saved in Canopy (needs config.manage). */
export const setBedDevices = (bedLocationId: number, devices: WardBedDevice[]) =>
  request<{ bed: WardBed }>(`/beds/${bedLocationId}/devices`, { method: "PUT", body: JSON.stringify({ devices }) });
export const takeOverCase = (globalCaseId: string, moveDevices: boolean) =>
  post<HandoverResult>("/handover", { global_case_id: globalCaseId, move_devices: moveDevices });
/** Receive a transfer offered to this Leaf: the chart continues here, on this bed, with these devices. */
export const receiveTransfer = (transfer: WardTransfer, bedLabel: string, devices: DeviceBindingInput[]) =>
  post<HandoverResult>("/handover", { global_case_id: transfer.global_case_id, handover_id: transfer.handover_id, bed_label: bedLabel, devices });
export const getTransferTargets = () => request<{ beds: TransferBed[]; leaf_id: string }>("/transfer-targets");
/** Move an active case to a bed without discharging it (this Leaf: at once; another Leaf: offered there). */
export const transferCase = (caseId: number, bed: TransferBed, note?: string) =>
  post<{ kind: "transfer" | "bed_move"; handover_id?: number; bed_label?: string }>(`/cases/${caseId}/transfer`, {
    to_leaf_id: bed.leaf_id, to_bed_location_id: bed.bed_location_id, to_bed_label: bed.bed_name, note });
export const moveCaseBed = (caseId: number, bedLabel: string) =>
  post<{ kind: "bed_move"; bed_label: string }>(`/cases/${caseId}/transfer`, { to_bed_label: bedLabel });
export const withdrawTransfer = (caseId: number, handoverId: number) =>
  post<{ ok: boolean }>(`/cases/${caseId}/transfer/withdraw`, { handover_id: handoverId });
export const testGateway = (dataApiUrl: string) => post<GatewayTest>("/gateway/test", { data_api_url: dataApiUrl });
export const assignGatewayDevices = (gatewayId: string, deviceIds: string[]) =>
  post<{ desired_version: number }>("/gateway/assign", { gateway_id: gatewayId, device_ids: deviceIds, release_others: true });
export const verifyGateway = (dataApiUrl: string) => post<GatewayVerify>("/gateway/verify", { data_api_url: dataApiUrl });
export const saveDeviceSource = (gatewayId: string | null, dataApiUrl: string) =>
  request<{ device_source: unknown }>("/gateway/source", { method: "PUT", body: JSON.stringify({ gateway_id: gatewayId, data_api_url: dataApiUrl }) });

export function gatewayLinkLabel(link: GatewayLink | undefined | null): string {
  if (!link) return "Gateway";
  return link.label || link.gateway_id || link.data_api_url || `Gateway #${link.id}`;
}

/** Builds the stream address the edge serves next to the data-api (wss://<gateway>/stream/v1). */
export function suggestStreamUrl(dataApiUrl: string): string {
  try {
    const url = new URL(dataApiUrl);
    return `${url.protocol === "https:" ? "wss" : "ws"}://${url.host}/stream/v1`;
  } catch {
    return "";
  }
}

function normalizeLink(raw: unknown): GatewayLink | null {
  const row = raw as Partial<GatewayLink> | null;
  const id = Number(row?.id);
  if (!row || !Number.isFinite(id)) return null;
  return { ...row, id, has_token: Boolean(row.has_token), is_default: Boolean(row.is_default) };
}

function pickLink(data: unknown): GatewayLink {
  const value = data as { link?: unknown } | null;
  const link = normalizeLink(value?.link ?? value);
  if (!link) throw new Error("Gateway link response missing id");
  return link;
}

export async function getGatewayLinks(): Promise<GatewayLink[]> {
  const data = await request<unknown>("/gateway/links");
  const rows = Array.isArray(data) ? data : ((data as { links?: unknown })?.links ?? []);
  return (Array.isArray(rows) ? rows : []).map(normalizeLink).filter((row): row is GatewayLink => Boolean(row));
}
export const createGatewayLink = async (input: GatewayLinkInput) => pickLink(await post<unknown>("/gateway/links", input));
export const updateGatewayLink = async (id: number, input: GatewayLinkInput) =>
  pickLink(await request<unknown>(`/gateway/links/${id}`, { method: "PUT", body: JSON.stringify(input) }));
export const deleteGatewayLink = (id: number) => request<unknown>(`/gateway/links/${id}`, { method: "DELETE" });
/** Devices the gateway serves (proxied Gateway /api/devices/status). */
export async function getGatewayLinkDevices(id: number): Promise<GatewayDevice[]> {
  const data = await request<unknown>(`/gateway/links/${id}/devices`);
  const status = data as { reachable?: boolean; error?: unknown } | null;
  if (status && status.reachable === false) throw new Error(typeof status.error === "string" ? status.error : "gateway unreachable");
  const rows = Array.isArray(data) ? data : ((data as { devices?: unknown })?.devices ?? []);
  const devices: GatewayDevice[] = [];
  for (const raw of Array.isArray(rows) ? rows : []) {
    const row = raw as GatewayDevice & { online?: boolean };
    if (!row || row.device_id == null) continue;
    devices.push({ ...row, device_id: String(row.device_id), is_online: row.is_online ?? row.online });
  }
  return devices;
}

/** Settings > Location: Canopy's location tree (fails when Canopy is unreachable). */
export type CanopyLocation = { id: number; parent_id: number | null; kind: "hospital" | "building" | "care_unit" | "room" | "bed"; code?: string | null; name: string };
export type CanopyLocations = {
  leaf_id: string;
  locations: CanopyLocation[];
  assignments: { leaf_id: string; bed_location_id: number; leaf_name?: string | null }[];
  leaves: { leaf_id: string; name: string }[];
  current_bed_id: number | null;
};
export const getCanopyLocations = () => request<CanopyLocations>("/locations");
/** Discharge dialog: the same tree, readable with case.discharge (no config.manage needed). */
export const getCanopyDestinations = () => request<CanopyLocations>("/locations/destinations");
export const assignCanopyLocation = (bedLocationId: number) =>
  post<{ location: Record<string, string>; version: number }>("/locations/assign", { bed_location_id: bedLocationId });
