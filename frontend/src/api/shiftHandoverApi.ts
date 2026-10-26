import { BACKEND_BASE } from "./backendBase";
import { readStoredAuthToken } from "./authApi";

/** Leaf ICU shift handover (routes/shift_handover_leaf.py): live summary of a shift + ISBAR record per role. */

export type HandoverRole = "nurse" | "doctor";
export type HandoverStatus = "draft" | "handed" | "accepted";

export type ShiftWindow = {
  code: string;
  label: string;
  start: number;
  /** Exclusive. */
  end: number;
  timezone?: string;
  is_current?: boolean;
  /** Stay day (1-based from the workflow's day_start). */
  day?: number;
};

export type HandoverVital = { key: string; latest: number; latest_at: number; min: number; max: number; count: number };

export type HandoverIoTotals = {
  intake_ml: number;
  output_ml: number;
  net_ml: number;
  urine_output_ml: number;
  blood_loss_ml: number;
};

export type HandoverIoItem = { kind: string; item_id?: number | null; item_code: string; item_name: string; item_unit?: string; total_ml: number };

export type HandoverInfusion = {
  run_id: number;
  kind: string;
  item_code: string;
  item_name: string;
  item_unit?: string | null;
  route?: string | null;
  note?: string | null;
  started_at: number;
  rate_since?: number | null;
  rate_value?: number | null;
  rate_unit?: string | null;
  dose_value?: number | null;
  dose_unit?: string | null;
  started_in_shift?: boolean;
};

export type HandoverEvent = { id: number; event_ts: number; event_type?: string | null; title?: string | null; detail?: string | null; created_by?: string | null };

export type HandoverScore = {
  score_id: string;
  name: string;
  ts: number;
  source: string;
  total: number | null;
  band?: string | null;
  level?: string | null;
  partial?: boolean;
};

export type HandoverFormSlot = { form_id: string; title: string; slot_ts: number; label: string; status: "due" | "overdue" | "skipped"; skip_reason?: string | null };

/** Medication section from app/med_orders.handover_section (only when installed); shape owned by that module. */
export type HandoverMedDue = { order_id: string; drug_name: string; dose?: number | string | null; dose_unit?: string | null; route?: string | null; due_at: number; status: "due" | "overdue" };
export type HandoverMedGiven = { id: string; order_id: string; drug_name?: string | null; given_at: number; dose?: number | string | null; dose_unit?: string | null; route?: string | null; recorded_by?: string | null };
export type HandoverMedications = {
  due?: HandoverMedDue[];
  given?: HandoverMedGiven[];
  counts?: { active?: number; due?: number; overdue?: number; given?: number; infusions?: number };
  [key: string]: unknown;
};

export type HandoverSummary = {
  generated_at: number;
  window: ShiftWindow;
  vitals: HandoverVital[];
  io: { shift: HandoverIoTotals; stay: HandoverIoTotals; stay_from: number; items: HandoverIoItem[] };
  infusions: HandoverInfusion[];
  events: HandoverEvent[];
  scores: HandoverScore[];
  forms: { slots: HandoverFormSlot[]; overdue_total: number };
  medications?: HandoverMedications;
};

export const ISBAR_FIELDS = ["identify", "situation", "background", "assessment", "recommendation", "plan"] as const;
export type IsbarField = typeof ISBAR_FIELDS[number];
export type IsbarText = Record<IsbarField, string>;

export type ShiftHandover = IsbarText & {
  id: string;
  case_id: number;
  shift_start: number;
  shift_end: number;
  shift_code: string;
  role: HandoverRole;
  status: HandoverStatus;
  /** Frozen when handed; null while a draft. */
  summary: HandoverSummary | null;
  handed_by?: string | null;
  handed_at?: number | null;
  accepted_by?: string | null;
  accepted_at?: number | null;
  created_by?: string | null;
  created_at: number;
  updated_by?: string | null;
  updated_at: number;
};

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const token = readStoredAuthToken();
  const response = await fetch(`${BACKEND_BASE}/api/case${path}`, {
    ...init,
    headers: {
      ...(init.body ? { "Content-Type": "application/json" } : {}),
      ...(token ? { "X-FLORA-Session": token } : {}),
    },
  });
  const data = await response.json().catch(() => ({})) as { error?: unknown; detail?: unknown };
  if (!response.ok) {
    const message = typeof data.error === "string" ? data.error : typeof data.detail === "string" ? data.detail : "";
    throw new Error(message || `Shift handover request failed (${response.status})`);
  }
  return data as T;
}

export function getShiftHandoverSummary(caseId: number, options: { at?: number; shift?: "current" | "previous" } = {}) {
  const query = new URLSearchParams();
  if (options.at) query.set("at", String(Math.floor(options.at)));
  if (options.shift) query.set("shift", options.shift);
  const suffix = query.toString() ? `?${query}` : "";
  return request<{ window: ShiftWindow; summary: HandoverSummary }>(`/${caseId}/shift-handover/summary${suffix}`);
}

export async function getShiftHandovers(caseId: number): Promise<ShiftHandover[]> {
  return (await request<{ handovers: ShiftHandover[] }>(`/${caseId}/shift-handovers`)).handovers;
}

/** Upserts the draft of (shift_start, role); only the text fields sent are changed. */
export async function saveShiftHandover(caseId: number, body: { shift_start: number; role: HandoverRole } & Partial<IsbarText>): Promise<ShiftHandover> {
  return (await request<{ handover: ShiftHandover }>(`/${caseId}/shift-handovers`, { method: "PUT", body: JSON.stringify(body) })).handover;
}

export async function handOverShift(caseId: number, handoverId: string): Promise<ShiftHandover> {
  return (await request<{ handover: ShiftHandover }>(`/${caseId}/shift-handovers/${handoverId}/hand`, { method: "POST" })).handover;
}

export async function acceptShiftHandover(caseId: number, handoverId: string): Promise<ShiftHandover> {
  return (await request<{ handover: ShiftHandover }>(`/${caseId}/shift-handovers/${handoverId}/accept`, { method: "POST" })).handover;
}
