import { BACKEND_BASE } from "./backendBase";
import { readStoredAuthToken } from "./authApi";

/** Platform console: manage Canopy accounts. Platform administrators never read hospital data. */
const BASE = `${BACKEND_BASE}/api/platform`;

export type PlatformAccount = {
  code: string;
  name: string;
  schema_name: string;
  status: "active" | "suspended" | string;
  haber_url: string | null;
  has_sync_secret: boolean;
  migrations: number;
  migrations_total: number;
};

export type NewAccount = { code: string; name: string; admin_username: string; admin_password: string; haber_url?: string };

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  const token = readStoredAuthToken();
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", ...(token ? { "X-FLORA-Session": token } : {}), ...(init.headers || {}) },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(typeof data?.error === "string" ? data.error : `request failed (${res.status})`);
  return data as T;
}

export const listAccounts = () => call<{ rows: PlatformAccount[]; bundle_files: number }>("/accounts");

export const createAccount = (body: NewAccount) =>
  call<{ code: string; schema: string; sync_secret: string; files: number }>("/accounts", { method: "POST", body: JSON.stringify(body) });

export const updateAccount = (code: string, body: { name?: string; status?: "active" | "suspended"; haber_url?: string | null }) =>
  call<{ ok: boolean }>(`/accounts/${encodeURIComponent(code)}`, { method: "PUT", body: JSON.stringify(body) });

export const rotateSecret = (code: string) =>
  call<{ sync_secret: string }>(`/accounts/${encodeURIComponent(code)}/rotate-secret`, { method: "POST" });

export const migrateAccounts = () => call<{ applied: Record<string, string[]> }>("/migrate", { method: "POST" });
