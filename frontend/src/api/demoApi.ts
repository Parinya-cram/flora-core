import { BACKEND_BASE } from "./backendBase";
import { readStoredAuthToken } from "./authApi";
import { wardHeaders } from "./wardSelection";

/** Canopy demo mode: a synthetic "Demo Ward" used only for example report statistics. */
export type DemoWardStatus = {
  exists: boolean;
  ward: { key: string; name: string } | null;
  created_at: number | null;
  leaves: number;
  cases: number;
  active_cases: number;
  archive_cases: number;
  first_case_at: string | null;
  last_case_at: string | null;
  seed?: number;
  elapsed_seconds?: number;
};

export type DemoWardOptions = { cases?: number; days?: number; active?: number; seed?: number };

const PATH = "/api/fleet/control/demo-ward";

async function request<T>(method: "GET" | "POST" | "DELETE", body?: unknown): Promise<T> {
  const token = readStoredAuthToken();
  const response = await fetch(`${BACKEND_BASE}${PATH}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      ...wardHeaders(),
      ...(token ? { "X-FLORA-Session": token } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = typeof data?.error === "string" ? data.error : typeof data?.detail === "string" ? data.detail : "";
    throw new Error(message || `Demo mode request failed (${response.status})`);
  }
  return data as T;
}

export const getDemoWardStatus = () => request<DemoWardStatus>("GET");
export const generateDemoWard = (options: DemoWardOptions = {}) => request<DemoWardStatus>("POST", options);
export const removeDemoWard = () => request<DemoWardStatus>("DELETE");
