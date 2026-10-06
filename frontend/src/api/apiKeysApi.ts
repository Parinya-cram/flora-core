import { BACKEND_BASE } from "./backendBase";
import { readStoredAuthToken } from "./authApi";
import { wardHeaders } from "./wardSelection";

export type ApiKeyScope = { code: string; label: string };
export type ApiKeyScopesInfo = {
  scopes: ApiKeyScope[];
  rateLimitPerMinute: number;
  apiBasePath: string;
  docsPath: string;
  mcpPath: string;
};

export type ApiKeyRow = {
  id: string;
  name: string;
  prefix: string;
  scopes: string[];
  unitKeys: string[] | null;
  includeDemo: boolean;
  createdBy: string | null;
  createdAt: number;
  expiresAt: number | null;
  lastUsedAt: number | null;
  revokedAt: number | null;
  status: "active" | "revoked" | "expired";
  requestCount24h: number;
};

export type ApiKeyInput = {
  name: string;
  scopes: string[];
  /** null = all wards */
  unit_keys: string[] | null;
  include_demo: boolean;
  expires_in_days: number | null;
};

export type ApiLogRow = {
  id: number;
  at: number;
  keyId: string | null;
  keyName: string | null;
  keyPrefix: string | null;
  method: string;
  path: string;
  query: string | null;
  status: number;
  durationMs: number | null;
  ip: string | null;
  userAgent: string | null;
  client: string | null;
  tool: string | null;
  caseIds: string[];
  error: string | null;
};

export type ApiLogFilter = { keyId?: string; status?: "ok" | "error" | ""; mcpOnly?: boolean; caseId?: string; limit?: number };

export type ApiWardOption = { key: string; name: string; buildingName?: string | null; isDemo?: boolean };

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
    const message = typeof data.error === "string" ? data.error : typeof data.detail === "string" ? data.detail : "";
    throw new Error(message || `API key request failed (${response.status})`);
  }
  return data as T;
}

const BASE = "/api/fleet/control";

export const getApiKeyScopes = () => request<ApiKeyScopesInfo>(`${BASE}/api-keys/scopes`);
export const listApiKeys = async () => (await request<{ rows: ApiKeyRow[] }>(`${BASE}/api-keys`)).rows || [];
export const createApiKey = (input: ApiKeyInput) =>
  request<{ row: ApiKeyRow; key: string; notice?: string }>(`${BASE}/api-keys`, { method: "POST", body: JSON.stringify(input) });
export const revokeApiKey = (id: string) =>
  request<{ row: ApiKeyRow }>(`${BASE}/api-keys/${encodeURIComponent(id)}/revoke`, { method: "POST" });

export async function listApiLogs(filter: ApiLogFilter = {}): Promise<ApiLogRow[]> {
  const params = new URLSearchParams();
  if (filter.keyId) params.set("key_id", filter.keyId);
  if (filter.status) params.set("status", filter.status);
  if (filter.mcpOnly) params.set("client", "mcp");
  if (filter.caseId?.trim()) params.set("case_id", filter.caseId.trim());
  params.set("limit", String(filter.limit ?? 200));
  const data = await request<{ rows: ApiLogRow[] }>(`${BASE}/api-logs?${params.toString()}`);
  return data.rows || [];
}

/** Wards for an API key's ward limit (keeps the demo flag that authApi.getWardOptions drops). */
export async function listApiWardOptions(): Promise<ApiWardOption[]> {
  const data = await request<{ rows?: ApiWardOption[] }>("/api/auth/ward-options");
  return (data.rows || []).filter(row => row.key);
}
