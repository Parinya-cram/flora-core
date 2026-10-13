import { readStoredAuthToken } from "./authApi";
import { BACKEND_BASE } from "./backendBase";
import type { StudioSpec } from "./reportStudioApi";
import { wardHeaders } from "./wardSelection";

export type Artifact = { title: string; html: string; data: Record<string, StudioSpec>; error?: string };
export type ModelQuery = { name: string; spec?: StudioSpec; rows?: number; error?: string };
export type ChatMessage = {
  id: string;
  seq: number;
  role: "user" | "assistant";
  content: string;
  artifacts: Artifact[];
  queries: ModelQuery[];
  error: string | null;
  created_at: number;
};
export type ChatSummary = { id: string; title: string; created_at: number; updated_at: number; messages?: number };
export type ChatSession = ChatSummary & { messages: ChatMessage[] };

export type DataColumn = { label: string; kind: string; type: string };
export type DataResult = { columns: DataColumn[]; rows: Array<Record<string, unknown>>; truncated?: boolean; error?: string };
export type RenderResult = { data: Record<string, DataResult>; params: { from?: string; to?: string }; ranAt: number };
export type Period = { from?: string; to?: string };

export type KeptArtifact = Artifact & {
  id: string;
  shared: boolean;
  session_id: string | null;
  owner_name: string;
  mine: boolean;
  created_at: number;
  updated_at: number;
  last_run_at: number | null;
};

function headers(json: boolean): Record<string, string> {
  const token = readStoredAuthToken();
  return { ...wardHeaders(), ...(token ? { "X-FLORA-Session": token } : {}), ...(json ? { "Content-Type": "application/json" } : {}) };
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${BACKEND_BASE}/api/ai-studio${path}`, { ...init, headers: headers(Boolean(init?.body)) });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({})) as { detail?: unknown; error?: string };
    const detail = Array.isArray(payload.detail) ? payload.detail.map(item => (item as { msg?: string }).msg).join("; ") : payload.detail;
    throw new Error(String(detail || payload.error || `Request failed (${response.status})`));
  }
  return response.json() as Promise<T>;
}

const send = (method: string, body?: unknown): RequestInit => ({ method, body: body === undefined ? undefined : JSON.stringify(body) });

export const listChats = () => request<{ rows: ChatSummary[] }>("/sessions").then(result => result.rows);
export const createChat = (title = "New chat") => request<ChatSummary>("/sessions", send("POST", { title }));
export const getChat = (id: string) => request<ChatSession>(`/sessions/${id}`);
export const renameChat = (id: string, title: string) => request<ChatSummary>(`/sessions/${id}`, send("PATCH", { title }));
export const deleteChat = (id: string) => request<{ deleted: boolean }>(`/sessions/${id}`, send("DELETE"));
export const sendMessage = (id: string, content: string) => request<ChatSession>(`/sessions/${id}/messages`, send("POST", { content }));

export const renderData = (data: Record<string, StudioSpec>, params: Period) => request<RenderResult>("/render", send("POST", { data, params }));

export const listKept = () => request<{ rows: KeptArtifact[] }>("/artifacts").then(result => result.rows);
export const keepArtifact = (artifact: Artifact, sessionId?: string) =>
  request<KeptArtifact>("/artifacts", send("POST", { title: artifact.title, html: artifact.html, data: artifact.data, session_id: sessionId ?? null }));
export const updateKept = (id: string, patch: { title?: string; shared?: boolean }) => request<KeptArtifact>(`/artifacts/${id}`, send("PATCH", patch));
export const copyKept = (id: string) => request<KeptArtifact>(`/artifacts/${id}/copy`, send("POST"));
export const deleteKept = (id: string) => request<{ deleted: boolean }>(`/artifacts/${id}`, send("DELETE"));
export const runKept = (id: string, params: Period) => request<RenderResult>(`/artifacts/${id}/run`, send("POST", { params }));

export type WidgetType = "snippet" | "html" | "image" | "text" | "system_status" | "active_cases" | "gateway_alerts" | "case_counts" | "clock";
export type Widget = { id: string; type: WidgetType; x: number; y: number; w: number; h: number; title: string; config: Record<string, unknown> };
export type DashboardSummary = {
  id: string; title: string; cols: number; rows: number; row_height: number; shared: boolean; mine: boolean;
  owner_name: string; created_at: number; updated_at: number; widget_count?: number;
};
export type Dashboard = DashboardSummary & { widgets: Widget[] };
export type DashboardInput = { title: string; cols: number; rows: number; row_height: number; widgets: Widget[] };

export const listDashboards = () => request<{ rows: DashboardSummary[] }>("/dashboards").then(result => result.rows);
export const getDashboard = (id: string) => request<Dashboard>(`/dashboards/${id}`);
export const createDashboard = (input: DashboardInput) => request<Dashboard>("/dashboards", send("POST", input));
export const saveDashboard = (id: string, input: DashboardInput) => request<Dashboard>(`/dashboards/${id}`, send("PUT", input));
export const shareDashboard = (id: string, shared: boolean) => request<Dashboard & { snippetsShared: number }>(`/dashboards/${id}/share`, send("PATCH", { shared }));
export const copyDashboard = (id: string) => request<Dashboard>(`/dashboards/${id}/copy`, send("POST"));
export const deleteDashboard = (id: string) => request<{ deleted: boolean }>(`/dashboards/${id}`, send("DELETE"));
