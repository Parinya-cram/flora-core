import { BACKEND_BASE } from "./backendBase";
import type { ScoreBand, ScoreLevel, ScoreOption } from "./workflowApi";

/** Leaf: clinical scores of a case (computed every interval from the chart; see app/score_writer.py). */

const BASE = `${BACKEND_BASE}/api/case`;

export type CaseScoreDefinition = {
  id: string; name: string; description?: string; reference?: string; version: number; mode: "auto" | "manual";
  interval_min: number; bands: ScoreBand[];
  items: Array<{ key: string; label: string; input?: string | null }>;
  inputs: Array<{ key: string; label: string; source: "param" | "manual"; type: "number" | "text" | "bool"; param?: string | null;
    unit?: string | null; default?: unknown; options?: ScoreOption[] | null }>;
};
export type ScoreResultItem = { key: string; label: string; value: unknown; points: number | null };
export type ScoreResult = {
  total: number | null; band: string | null; level: ScoreLevel | null; partial: boolean; missing: string[];
  items: ScoreResultItem[]; flags: Array<{ label: string; level: ScoreLevel }>;
  inputs: Record<string, { value: unknown; param?: string; ts?: number; source?: string; agg?: string; n?: number }>;
};
export type CaseScoreRow = ScoreResult & {
  id: number; score_id: string; score_version: number; ts: number; source: "auto" | "manual"; created_by?: string | null; updated_at: number;
};
export type CaseScores = { definitions: CaseScoreDefinition[]; rows: CaseScoreRow[] };

async function json<T>(response: Response): Promise<T> {
  const data = await response.json().catch(() => ({})) as { error?: unknown; detail?: unknown };
  if (!response.ok) {
    const message = typeof data.error === "string" ? data.error : typeof data.detail === "string" ? data.detail : "";
    throw new Error(message || `Score request failed (${response.status})`);
  }
  return data as T;
}

export async function getCaseScores(caseId: number, range?: { from?: number; to?: number }): Promise<CaseScores> {
  const params = new URLSearchParams();
  if (range?.from) params.set("from", String(range.from));
  if (range?.to) params.set("to", String(range.to));
  const response = await fetch(`${BASE}/${caseId}/scores${params.size ? `?${params}` : ""}`);
  if (response.status === 404) return { definitions: [], rows: [] }; // Leaf API without scores
  const data = await json<Partial<CaseScores>>(response);
  return { definitions: data.definitions || [], rows: data.rows || [] };
}

export const evaluateCaseScore = (caseId: number, scoreId: string, body: { ts?: number; values?: Record<string, unknown>; save?: boolean }) =>
  fetch(`${BASE}/${caseId}/scores/${encodeURIComponent(scoreId)}/evaluate`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  }).then(response => json<ScoreResult & { ts: number; score_version: number; saved: CaseScoreRow | null }>(response));

export const recalculateCaseScores = (caseId: number) =>
  fetch(`${BASE}/${caseId}/scores/recalculate`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" })
    .then(response => json<{ written: number }>(response));

export const deleteManualScore = (caseId: number, resultId: number) =>
  fetch(`${BASE}/${caseId}/scores/results/${resultId}`, { method: "DELETE" }).then(response => json<{ ok: boolean }>(response));
