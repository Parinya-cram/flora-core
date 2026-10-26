import { BACKEND_BASE } from "./backendBase";
import { readStoredAuthToken } from "./authApi";

/** One alert from a gateway, as stored in Canopy's central log (canopy_gateway_alert). */
export type GatewayAlert = {
  gateway_id: string;
  alert_id: number;
  alert_key: string;
  category: "gateway" | "canopy" | "controller" | "device" | string;
  severity: "critical" | "warning" | "info";
  title: string;
  detail?: string | null;
  opened_at: number;
  last_seen_at: number;
  resolved_at?: number | null;
  acknowledged_at?: number | null;
  acknowledged_by?: string | null;
  version: number;
  received_at: number;
  site_name?: string | null;
  site_unit?: string | null;
  gateway_last_seen_at?: number | null;
};

export type GatewayAlertLog = {
  rows: GatewayAlert[];
  counts: { open: number; critical_open: number; gateways_affected: number };
};

export async function getGatewayAlerts(status: "all" | "open" | "resolved" = "all"): Promise<GatewayAlertLog> {
  const token = readStoredAuthToken();
  const response = await fetch(`${BACKEND_BASE}/api/fleet/gateway-alerts?status=${status}&limit=500`, {
    headers: token ? { "X-FLORA-Session": token } : {},
  });
  if (!response.ok) {
    const data = await response.json().catch(() => ({})) as { detail?: string };
    throw new Error(data.detail || `Gateway alerts unavailable (${response.status})`);
  }
  return response.json() as Promise<GatewayAlertLog>;
}

/** One stream-hub binding of a case to a gateway device (canopy_gateway_case_binding). */
export type CaseBinding = {
  gateway_id: string;
  binding_id: number;
  leaf_id: string;
  leaf_name?: string | null;
  case_uuid: string;
  device_id: string;
  device_label?: string | null;
  mode: "exclusive" | "shared";
  bound_at: string;
  unbound_at?: string | null;
  unbind_reason?: string | null;
  last_acked_seq?: number | null;
  hn?: string | null;
  patient_name?: string | null;
  bed_label?: string | null;
};

export async function getCaseBindings(params: { case_uuid?: string; leaf_id?: string; open?: boolean }): Promise<CaseBinding[]> {
  const token = readStoredAuthToken();
  const search = new URLSearchParams();
  if (params.case_uuid) search.set("case_uuid", params.case_uuid);
  if (params.leaf_id) search.set("leaf_id", params.leaf_id);
  if (params.open !== undefined) search.set("open", String(params.open));
  const response = await fetch(`${BACKEND_BASE}/api/fleet/case-bindings?${search.toString()}`, {
    headers: token ? { "X-FLORA-Session": token } : {},
  });
  if (!response.ok) throw new Error(`Device sessions unavailable (${response.status})`);
  return ((await response.json()) as { rows: CaseBinding[] }).rows;
}
