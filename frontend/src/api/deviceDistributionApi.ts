import { BACKEND_BASE } from "./backendBase";
import { readStoredAuthToken } from "./authApi";

// Device Distribution console (Canopy admin): drives the Root -> Canopy -> node image rollout
// through canopy-api, which proxies to Haber. Read-only on patient data; image rollout only.

export type ReleaseService = { tag: string; digest: string; repository: string };

export type ReleaseRow = {
  release_id: string;
  component: "canopy" | "leaf" | "gateway" | string;
  version: string;
  channel: string;
  services: Record<string, ReleaseService>;
  device_types: number;
  notes?: string | null;
  created_at: number;
  mirror?: { status: "pending" | "mirroring" | "ready" | "failed" | string; error?: string | null; last_run?: number | null } | null;
};

export type DistributionNode = {
  node_id: string;
  component: string;
  project?: string | null;
  release_id: string | null;   // applied
  target: string | null;       // desired
  state: "ok" | "updating" | "unmanaged" | "error" | string;
  detail?: string | null;
  images?: Record<string, string>;
  last_seen: number | null;
};

export type DistributionOverview = {
  server_ts: number;
  tenant_id: string;
  root: { url: string; status: string; error: string | null; last_sync: number | null; verified: boolean };
  license_valid?: boolean;
  releases: {
    channel: string;
    latest: Record<string, string>;
    registry: string;
    mirror: { status: string; error?: string | null; last_run?: number | null };
    approvals: Record<string, string>;   // component -> approved release_id
    rows: ReleaseRow[];
  };
  nodes: DistributionNode[];
  gateway_catalog?: DeviceTypeCatalog[];
  bundle?: { entitlements?: { device_types?: string[]; max_gateway_devices?: number } } | null;
  gateways?: Array<{ gateway_id: string; version?: string; devices?: Array<{ device_id: string; device_type?: string; label?: string | null; enabled?: boolean; parser_status?: string | null }> }>;
};

export type DeviceTypeCatalog = {
  code: string;
  label?: string;
  category?: string;
  protocol?: string;
  parser?: string;
  image?: string;       // parser image (e.g. flora-gateway-parser:dev)
  version?: string;     // device-type definition version
};

const BASE = `${BACKEND_BASE}/api/fleet/distribution`;

function authHeaders(json = false): Record<string, string> {
  const token = readStoredAuthToken();
  const headers: Record<string, string> = token ? { "X-FLORA-Session": token } : {};
  if (json) headers["Content-Type"] = "application/json";
  return headers;
}

async function unwrap<T>(response: Response): Promise<T> {
  if (!response.ok) {
    const data = await response.json().catch(() => ({})) as { detail?: string };
    throw new Error(data.detail || `Request failed (${response.status})`);
  }
  return response.json() as Promise<T>;
}

export async function getDistributionOverview(): Promise<DistributionOverview> {
  return unwrap(await fetch(`${BASE}/overview`, { headers: authHeaders() }));
}

export async function approveRelease(releaseId: string): Promise<unknown> {
  return unwrap(await fetch(`${BASE}/releases/${encodeURIComponent(releaseId)}/approve`, { method: "POST", headers: authHeaders() }));
}

export async function mirrorRelease(releaseId: string): Promise<unknown> {
  return unwrap(await fetch(`${BASE}/releases/${encodeURIComponent(releaseId)}/mirror`, { method: "POST", headers: authHeaders() }));
}

export async function holdComponent(component: string): Promise<unknown> {
  return unwrap(await fetch(`${BASE}/components/${encodeURIComponent(component)}/hold`, { method: "POST", headers: authHeaders() }));
}

export async function rootSync(): Promise<unknown> {
  return unwrap(await fetch(`${BASE}/root-sync`, { method: "POST", headers: authHeaders() }));
}

// Haber Root/registry settings, editable from the Device Distribution UI (via the canopy-api -> Haber proxy).
export type DistSetting = { value?: unknown; overridden?: boolean; set?: boolean; secret?: boolean };
export type DistSettings = { settings: Record<string, DistSetting> };

export async function getDistSettings(): Promise<DistSettings> {
  return unwrap(await fetch(`${BASE}/settings`, { headers: authHeaders() }));
}

export async function saveDistSettings(body: Record<string, unknown>): Promise<unknown> {
  return unwrap(await fetch(`${BASE}/settings`, { method: "PUT", headers: authHeaders(true), body: JSON.stringify(body) }));
}
