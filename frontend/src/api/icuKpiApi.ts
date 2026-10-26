import { BACKEND_BASE } from "./backendBase";
import { readStoredAuthToken } from "./authApi";
import { wardHeaders } from "./wardSelection";

/** ICU KPIs and bundle compliance: Canopy /api/fleet/icu-kpis, /api/fleet/bundle-compliance; Leaf /api/case/{id}/bundle-compliance. */

export type Bilingual = { en: string; th: string };
export type Tally = { applicable: number; compliant: number; pct: number | null; missed: number };
export type MissingItem = { bundle_id: string; item: string; label: Bilingual; count: number };
export type BundleInfo = { id: string; label: Bilingual; form_id: string; items: { key: string; label: Bilingual }[] };

export type IcuKpis = {
  cases: number; admissions: number; discharges: number; patient_days: number;
  alos_days: number | null; median_los_days: number | null; deaths: number; mortality_pct: number | null;
  vent_days: number; central_line_days: number; urinary_catheter_days: number;
  vent_utilization: number | null; central_line_utilization: number | null; urinary_catheter_utilization: number | null;
  vap: number; clabsi: number; cauti: number; pressure_injury: number;
  vap_rate: number | null; clabsi_rate: number | null; cauti_rate: number | null;
  readmission_48h_pct: number | null; reintubation_48h_pct: number | null;
  beds: number | null; bed_occupancy_pct: number | null;
};
export type IcuKpiResponse = {
  from: number; to: number; timezone: string; server_time: number; units: string[] | null;
  kpis: IcuKpis; by_unit: (IcuKpis & { unit_key: string; unit_name: string })[];
};

export type BundleComplianceRow = BundleInfo & Tally & {
  cases: number;
  weekly: (Tally & { week: string })[];
  by_shift: (Tally & { shift: string })[];
  top_missing: MissingItem[];
};
export type LowCase = Tally & {
  global_case_id: string; hn: string | null; unit_key: string | null; unit_name?: string | null; leaf_id: string | null;
  case_code?: string | null; patient_name?: string | null; status?: string | null; start_time?: number | null;
  discharge_time?: number | null; bundles: string[];
};
export type FleetBundleCompliance = {
  from: number; to: number; timezone: string; units: string[] | null; count_missed: boolean; bundle_id: string | null;
  overall: Tally; weeks: string[]; bundles: BundleComplianceRow[]; top_missing: MissingItem[]; lowest_cases: LowCase[];
};

export type CaseSlotStatus = "done" | "draft" | "skipped" | "missed" | "pending" | "upcoming";
export type CaseBundle = BundleInfo & Tally & {
  pending: number;
  by_day: (Tally & { date: string })[];
  today: { slot_ts: number; shift: string | null; day: number; status: CaseSlotStatus; applicable: boolean; compliant: boolean; missing: string[] }[];
  missed_slots: { slot_ts: number; shift: string | null; day: number }[];
  top_missing: MissingItem[];
};
export type CaseBundleCompliance = { case_id: number; timezone: string; generated_at: number; count_missed: boolean; bundles: CaseBundle[] };

export type KpiQuery = { from?: string; to?: string; unitKey?: string; bundleId?: string; countMissed?: boolean };

function query(params: KpiQuery): string {
  const search = new URLSearchParams();
  if (params.from) search.set("from", params.from);
  if (params.to) search.set("to", params.to);
  if (params.unitKey) search.set("unit_key", params.unitKey);
  if (params.bundleId) search.set("bundle_id", params.bundleId);
  if (params.countMissed === false) search.set("count_missed", "false");
  const text = search.toString();
  return text ? `?${text}` : "";
}

async function json<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${BACKEND_BASE}${path}`, init);
  const data = await response.json().catch(() => ({})) as { detail?: unknown; error?: unknown };
  if (!response.ok) {
    const detail = typeof data.detail === "string" ? data.detail : typeof data.error === "string" ? data.error : "";
    throw new Error(detail || `ICU KPI request failed (${response.status})`);
  }
  return data as T;
}

function canopyInit(): RequestInit {
  const token = readStoredAuthToken();
  return { headers: { ...wardHeaders(), ...(token ? { "X-FLORA-Session": token } : {}) } };
}

export const getIcuKpis = (params: KpiQuery = {}) => json<IcuKpiResponse>(`/api/fleet/icu-kpis${query(params)}`, canopyInit());

export const getFleetBundleCompliance = (params: KpiQuery = {}) =>
  json<FleetBundleCompliance>(`/api/fleet/bundle-compliance${query(params)}`, canopyInit());

/** Leaf: the open case's own compliance. */
export const getCaseBundleCompliance = (caseId: number, days = 7) =>
  json<CaseBundleCompliance>(`/api/case/${caseId}/bundle-compliance?days=${days}`);
