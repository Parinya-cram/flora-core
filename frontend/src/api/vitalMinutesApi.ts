import { BACKEND_BASE } from "./backendBase";

const BASE = `${BACKEND_BASE}/api/case`;

export type VitalMinuteRow = {
  ts_minute: number;
  payload: Record<string, unknown>;
  provenance?: Record<string, TimelineCellProvenance>;
  /** Device readings marked invalid: left out of payload, kept here for display. */
  masked?: Record<string, unknown>;
};

/** A clinician's "invalid device data" mark over one parameter, minutes [from_ts, to_ts]. */
export type TimelineMask = {
  id: number;
  param_key: string;
  from_ts: number;
  to_ts: number;
  reason?: string | null;
  created_by?: string | null;
  created_at?: number;
};

export type TimelineCellProvenance = {
  source: "manual" | "override";
  original_value?: unknown;
  original_source?: string | null;
  updated_by?: string | null;
  updated_at?: number | null;
  note?: string | null;
  reason?: string | null;
  actor_username?: string | null;
  actor_name?: string | null;
  actor_role?: string | null;
  edited_at?: number | null;
  audit_count?: number;
};

export type TimelineProvenance = Record<string, Record<number, TimelineCellProvenance>>;

type VitalMinuteResponse = {
  rows: VitalMinuteRow[];
  masks?: TimelineMask[];
};

export type TimelineActor = {
  username: string;
  name?: string;
  role?: string;
};

export type TimelineChange = {
  ts_minute: number;
  param_key: string;
  value?: unknown;
  value_type?: "number" | "text" | "code";
  source?: "manual" | "override";
  action?: "upsert" | "delete";
  note?: string;
  unit?: string;
};

export async function getEffectiveTimeline(
  caseId: number,
  fromTs: number,
  toTs: number,
): Promise<VitalMinuteRow[]> {
  return (await getEffectiveTimelineWithMasks(caseId, fromTs, toTs)).rows;
}

export async function getEffectiveTimelineWithMasks(
  caseId: number,
  fromTs: number,
  toTs: number,
): Promise<{ rows: VitalMinuteRow[]; masks: TimelineMask[] }> {
  const params = new URLSearchParams({
    from: String(fromTs),
    to: String(toTs),
  });

  const res = await fetch(
    `${BASE}/${caseId}/timeline/effective?${params.toString()}`,
  );

  if (!res.ok) {
    throw new Error(`timeline effective fetch failed ${res.status}`);
  }

  const data = (await res.json()) as VitalMinuteResponse;
  return { rows: Array.isArray(data.rows) ? data.rows : [], masks: Array.isArray(data.masks) ? data.masks : [] };
}

async function maskRequest<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
  const data = await res.json().catch(() => ({})) as { detail?: unknown };
  if (!res.ok) throw new Error(typeof data.detail === "string" ? data.detail : `mask request failed ${res.status}`);
  return data as T;
}

export const createTimelineMasks = (caseId: number, masks: Array<Pick<TimelineMask, "param_key" | "from_ts" | "to_ts">>, reason?: string) =>
  maskRequest<{ masks: TimelineMask[] }>(`/${caseId}/timeline/masks`, { masks, reason });
export const revokeTimelineMask = (caseId: number, maskId: number) =>
  maskRequest<{ ok: boolean }>(`/${caseId}/timeline/masks/${maskId}/revoke`);
export const restoreTimelineMask = (caseId: number, maskId: number) =>
  maskRequest<{ ok: boolean }>(`/${caseId}/timeline/masks/${maskId}/restore`);

export async function putTimelineChanges(
  caseId: number,
  actor: TimelineActor,
  changes: TimelineChange[],
  reason?: string,
) {
  const res = await fetch(`${BASE}/${caseId}/timeline`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      actor,
      reason,
      changes,
    }),
  });

  if (!res.ok) {
    throw new Error(`timeline save failed ${res.status}`);
  }

  return res.json();
}
