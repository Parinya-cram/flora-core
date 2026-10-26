import { BACKEND_BASE } from "./backendBase";
import { readStoredAuthToken } from "./authApi";

/** Administrator → Logs: the Canopy activity log (sign-ins, writes, charts opened) and Leaf directory audit. */

export type ActivityRow = {
  source: "canopy" | "directory"; id: number; at: number; user_id: number | null; username: string | null; user_name: string | null;
  role: string | null; category: string; action: string; method: string | null; path: string | null; query: string | null;
  status: number | null; ok: boolean; duration_ms: number | null; ip: string | null; user_agent: string | null;
  detail: Record<string, unknown> | null;
};
export type ActivityStats = { total: number; failed: number; users: number; sign_ins: number; failed_sign_ins: number };
export type ActivityFilter = { from?: number; to?: number; q?: string; category?: string; outcome?: "ok" | "failed"; limit?: number; offset?: number };
export type ActivityPage = { rows: ActivityRow[]; total: number; stats: ActivityStats; categories: Array<{ category: string; count: number }> };

export async function getActivity(filter: ActivityFilter): Promise<ActivityPage> {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(filter)) if (value !== undefined && value !== "") params.set(key, String(value));
  const token = readStoredAuthToken();
  const response = await fetch(`${BACKEND_BASE}/api/fleet/activity?${params}`, { headers: token ? { "X-FLORA-Session": token } : {} });
  if (!response.ok) {
    const data = await response.json().catch(() => ({})) as { detail?: string; error?: string };
    throw new Error(data.detail || data.error || `Activity log request failed (${response.status})`);
  }
  return response.json() as Promise<ActivityPage>;
}
