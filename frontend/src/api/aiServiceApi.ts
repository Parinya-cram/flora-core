import { BACKEND_BASE } from "./backendBase";

const BASE = `${BACKEND_BASE}/api/auth/preferences/ai-service`;

export type AiApiFormat = "anthropic" | "openai";
export type AiServiceSettings = {
  apiFormat: AiApiFormat;
  host: string;
  model: string;
  hasKey: boolean;
  keyHint: string;
  version: number;
  updatedAt: number;
  updatedBy: string | null;
  configured: boolean;
  managedBy: "canopy" | "leaf-sync";
};
export type AiServiceInput = { api_format: AiApiFormat; host: string; model: string; api_key?: string | null };
export type AiServiceTestResult = { ok: boolean; error?: string; model?: string; displayName?: string | null; latencyMs?: number; models?: string[] };

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers || {}) },
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data?.error || data?.detail || `AI service request failed (${response.status})`);
  return data as T;
}

export const getAiService = () => request<AiServiceSettings>("");
export const saveAiService = (input: AiServiceInput) => request<AiServiceSettings>("", { method: "PUT", body: JSON.stringify(input) });
export const testAiService = (input?: AiServiceInput) =>
  request<AiServiceTestResult>("/test", { method: "POST", body: input ? JSON.stringify(input) : undefined });
