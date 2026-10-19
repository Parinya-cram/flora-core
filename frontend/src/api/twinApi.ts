import { BACKEND_BASE } from "./backendBase";

/** Canopy digital twin: care units → rooms (zones) → beds with live patients and journeys. */

export type Layout = { x: number; y: number; w: number; h: number };
export type TwinOccupant = {
  global_case_id: string;
  hn: string;
  hn_masked: string;
  name: string;
  initials: string;
  started_at: number | null;
  status: "in_care" | "transfer";
  triage_level: string | null;
  triage_color: "red" | "pink" | "yellow" | "green" | "white" | null;
  leaf_id: string;
  bed_id: number;
  unit_id: number;
};
export type TwinBed = {
  id: number;
  name: string;
  leaf: { id: string; name: string; status: "online" | "delayed" | "offline" } | null;
  occupant: TwinOccupant | null;
};
export type TwinRoom = { id: number; name: string; zone: string | null; layout: Layout | null; beds: TwinBed[] };
export type TwinWaiting = { id: string; hn_masked: string; initials: string; name: string; waiting_since: number; scheduled_at: number | null };
export type TwinUnit = {
  id: number;
  key: string;
  name: string;
  building_id: number | null;
  layout: Layout | null;
  rooms: TwinRoom[];
  kpi: { beds: number; occupied: number; patients: number; waiting: number; transfer: number; critical: number; avg_stay_ms: number | null };
  waiting: TwinWaiting[];
};
export type JourneyStep = {
  at: number;
  kind: string;
  label: string;
  unit_id: number | null;
  location_id: number | null;
  unit_name?: string | null;
  location_name?: string | null;
};
export type TwinJourney = { global_case_id: string; initials: string; hn_masked: string; steps: JourneyStep[] };
export type Twin = {
  server_time: number;
  buildings: { id: number; name: string }[];
  units: TwinUnit[];
  journeys: TwinJourney[];
  totals: { patients: number; beds: number; occupied: number; waiting: number; transfer: number; critical: number };
};

async function call<T>(path: string, method = "GET", body?: unknown): Promise<T> {
  const response = await fetch(`${BACKEND_BASE}${path}`, {
    method,
    headers: body === undefined ? {} : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await response.json().catch(() => ({})) as { detail?: unknown };
  if (!response.ok) throw new Error(typeof data.detail === "string" ? data.detail : `Digital twin request failed (${response.status})`);
  return data as T;
}

export const getTwin = () => call<Twin>("/api/fleet/twin");
export const getJourney = (hn: string, days = 30) =>
  call<{ hn: string; steps: JourneyStep[] }>(`/api/fleet/twin/journey?hn=${encodeURIComponent(hn)}&days=${days}`);
export const saveTwinLayout = (items: Array<{ location_id: number } & Layout>, reset: number[] = []) =>
  call<{ ok: boolean }>("/api/fleet/control/twin/layout", "PUT", { items, reset });
