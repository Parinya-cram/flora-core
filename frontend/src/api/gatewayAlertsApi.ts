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
