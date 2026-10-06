import { BACKEND_BASE } from "./backendBase";
import { readStoredAuthToken } from "./authApi";

/** Where a gateway is installed. Canopy owns it; the gateway applies it at its next check-in. */
export type GatewaySiteInput = {
  unit_id: number | null;
  display_name?: string | null;
  unit_type?: "or" | "icu" | "er" | "ward" | "other" | null;
  floor?: string | null;
  room?: string | null;
  contact?: string | null;
  notes?: string | null;
};

export async function setGatewaySite(gatewayId: string, input: GatewaySiteInput) {
  const token = readStoredAuthToken();
  const response = await fetch(`${BACKEND_BASE}/api/fleet/control/gateways/${encodeURIComponent(gatewayId)}/site`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", ...(token ? { "X-FLORA-Session": token } : {}) },
    body: JSON.stringify(input),
  });
  const data = await response.json().catch(() => ({})) as { detail?: string; desired_version?: number };
  if (!response.ok) throw new Error(data.detail || `Could not set the gateway location (${response.status})`);
  return data;
}
