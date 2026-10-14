/**
 * Form Studio <-> Flora Leaf timeline: the parameter catalog a timeline field offers (Leaf's own row ids, labels
 * and units), the chart series styles (as on Leaf's trend chart and the anesthesia record), turning Leaf's
 * per-minute data into the field's columns, and loading a case's data through Leaf's APIs.
 *
 * Pure parts (catalog, buckets) work anywhere; loadLeafTimeline needs a case (see caseContext.ts).
 */
import { BASE_IVY_ROWS } from "../../views/clinical-chart/constants";
import type { FieldDefinition, JsonValue, TimelineColors, TimelineSeries, TimelineValue } from "../core/types";

export type TimelineRowInfo = { id: string; label: string; unit?: string; group: string };

/** Leaf's timeline rows, plus rows the anesthesia record keeps that Leaf does not store per minute (typed in). */
export const TIMELINE_ROWS: TimelineRowInfo[] = [
  ...BASE_IVY_ROWS.map(row => ({ id: row.id, label: row.label, unit: row.unit, group: row.id.startsWith("set_") ? "set" : ["hr", "pr", "spo2", "nibp_sys", "nibp_map", "nibp_dia", "art_sys", "art_map", "art_dia", "cvp", "temperature"].includes(row.id) ? "vital" : "measured" })),
  { id: "bis", label: "BIS", group: "measured" },
  { id: "tof", label: "TOF", group: "measured" },
  { id: "insp_des", label: "Insp DES", unit: "%", group: "measured" },
  { id: "exp_des", label: "Exp DES", unit: "%", group: "measured" },
  { id: "insp_sev", label: "Insp SEV", unit: "%", group: "measured" },
  { id: "exp_sev", label: "Exp SEV", unit: "%", group: "measured" },
];
const ROW_BY_ID = new Map(TIMELINE_ROWS.map(row => [row.id, row]));
export const rowInfo = (id: string, override?: { id?: string; label?: string; unit?: string }): TimelineRowInfo => ({
  ...(ROW_BY_ID.get(id) ?? { id, label: id, group: "custom" }), ...(override?.label ? { label: override.label } : {}), ...(override?.unit ? { unit: override.unit } : {}),
});

/** The rows the anesthesia record shows (in its order) when a timeline is added. */
export const DEFAULT_TABLE_ROWS = ["et_co2", "fio2", "fi_n2o", "insp_des", "exp_des", "insp_sev", "exp_sev", "minute_volume_exp", "airway_pressure_peak", "set_peep", "tidal_volume_exp", "rr", "spo2", "cvp", "tof"];
export const DEFAULT_CHART: TimelineSeries[] = ["nibp", "hr", "spo2", "bis"];

/** Chart series: which rows they read, how they are drawn (Leaf's symbols: NIBP as a range bar with ▼ ■ ▲). */
export type SeriesStyle = { label: string; color: string; rows: string[]; marker: "range" | "x" | "plus" | "circle" | "square" | "triangle"; axis: "left" | "right" };
export const SERIES: Record<TimelineSeries, SeriesStyle> = {
  nibp: { label: "NIBP", color: "#dc2626", rows: ["nibp_sys", "nibp_map", "nibp_dia"], marker: "range", axis: "left" },
  art: { label: "ART", color: "#16a34a", rows: ["art_sys", "art_map", "art_dia"], marker: "range", axis: "left" },
  hr: { label: "HR", color: "#16a34a", rows: ["hr"], marker: "x", axis: "left" },
  pr: { label: "PR", color: "#0d9488", rows: ["pr"], marker: "circle", axis: "left" },
  spo2: { label: "SpO2", color: "#2563eb", rows: ["spo2"], marker: "circle", axis: "left" },
  bis: { label: "BIS", color: "#1d4ed8", rows: ["bis"], marker: "plus", axis: "left" },
  cvp: { label: "CVP", color: "#7c3aed", rows: ["cvp"], marker: "square", axis: "left" },
  et_co2: { label: "EtCO2", color: "#ca8a04", rows: ["et_co2"], marker: "triangle", axis: "left" },
  temperature: { label: "Temp", color: "#9333ea", rows: ["temperature"], marker: "circle", axis: "right" },
};
/** Colour of one-colour charts unless the form sets its own (dark slate: prints well in black and white). */
export const DEFAULT_MONO_COLOR = "#1f2937";

/** The colour each series is drawn in: one colour for all (mono), or each its own (defaults above, overridable). */
export function seriesColors(colors: TimelineColors | undefined): Record<TimelineSeries, string> {
  const out = {} as Record<TimelineSeries, string>;
  for (const name of Object.keys(SERIES) as TimelineSeries[]) {
    out[name] = colors?.mode === "mono" ? colors.mono || DEFAULT_MONO_COLOR : colors?.series?.[name] || SERIES[name].color;
  }
  return out;
}

/** Chart scales: left 20-200 (pressures, rates, %), right 20-40 °C (temperature), as on the anesthesia record. */
export const LEFT_SCALE: [number, number] = [20, 200];
export const RIGHT_SCALE: [number, number] = [20, 40];

const MINUTE = 60_000;

/** Column times from start to end (inclusive) every step minutes, on whole minutes. */
export function timelineAxis(start: number, end: number, stepMin: number): number[] {
  const step = stepMin * MINUTE;
  const first = Math.floor(start / MINUTE) * MINUTE;
  const out: number[] = [];
  for (let ts = first; ts <= end && out.length < 1500; ts += step) out.push(ts);
  return out;
}

/** Per-minute values into columns: a column shows the latest reading in (previous column, this column], as Leaf's
 * flowsheet does when a column spans more than a minute. Only `rows` are kept. */
export function bucketValues(minutes: Record<string, Record<number, unknown>>, axis: number[], rows: string[]): TimelineValue["values"] {
  const out: TimelineValue["values"] = {};
  for (const row of rows) {
    const series = minutes[row];
    if (!series) continue;
    const times = Object.keys(series).map(Number).filter(Number.isFinite).sort((a, b) => a - b);
    const cells: Record<string, number | string | null> = {};
    let cursor = 0;
    axis.forEach((ts, index) => {
      const from = index === 0 ? -Infinity : axis[index - 1];
      let found: unknown;
      while (cursor < times.length && times[cursor] <= ts) {
        if (times[cursor] > from) found = series[times[cursor]];
        cursor += 1;
      }
      if (found === undefined || found === null || found === "") return;
      const number = typeof found === "number" ? found : Number(found);
      cells[String(ts)] = Number.isFinite(number) ? Math.round(number * 100) / 100 : String(found).slice(0, 40);
    });
    if (Object.keys(cells).length) out[row] = cells;
  }
  return out;
}

/** The rows a field reads: its table rows and the rows behind its chart series. */
export function neededRows(tableRows: string[], chart: TimelineSeries[]): string[] {
  return [...new Set([...tableRows, ...chart.flatMap(series => SERIES[series].rows)])];
}

export type LeafCase = { caseId: number; status?: string };

/** A case's timeline from Flora Leaf (axis, per-minute values with clinician edits and masks applied, events),
 * grouped into `stepMin` columns. */
export async function loadLeafTimeline(context: LeafCase, stepMin: number, rows: string[]): Promise<TimelineValue> {
  const [{ getClinicalTimelineAxis }, { getEffectiveTimelineWithMasks }, { getCaseEvents }, { toClinicalTimelineValues }] = await Promise.all([
    import("../../api/clinicalTimelineApi"), import("../../api/vitalMinutesApi"), import("../../api/caseEventApi"), import("../../hooks/useVitalMinutes"),
  ]);
  const minute = await getClinicalTimelineAxis(context.caseId, 1);
  const start = minute.axis[0];
  const end = minute.axis[minute.axis.length - 1];
  if (start === undefined || end === undefined) return { step_min: stepMin, axis: [], values: {}, events: [], source: "leaf", case_id: context.caseId, captured_at: Date.now() };
  const [effective, events] = await Promise.all([getEffectiveTimelineWithMasks(context.caseId, start, end), getCaseEvents(context.caseId, start, end)]);
  const axis = timelineAxis(start, end, stepMin);
  return {
    step_min: stepMin, axis, source: "leaf", case_id: context.caseId, captured_at: Date.now(),
    values: bucketValues(toClinicalTimelineValues(effective.rows) as Record<string, Record<number, unknown>>, axis, rows),
    events: events.filter(event => event.event_type === "event").slice(0, 300).map(event => ({ ts: event.event_ts, title: event.title.slice(0, 200) })),
  };
}

export const timeLabel = (ts: number) => {
  const date = new Date(ts);
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
};

/** A timeline field's settings with defaults. */
export const timelineConfig = (field: FieldDefinition) => {
  const config = field.timeline ?? {};
  return {
    parts: config.parts ?? (["events", "chart", "table"] as const),
    rows: config.rows ?? DEFAULT_TABLE_ROWS.map((id): { id: string; label?: string; unit?: string } => ({ id })),
    chart: (config.chart ?? DEFAULT_CHART) as TimelineSeries[],
    step: config.step_min ?? 5,
    source: config.source ?? "leaf",
    colorMode: config.colors?.mode ?? "series",
    colors: seriesColors(config.colors),
  };
};

/** Which column an event falls in: the first column at or after it (columns show what happened up to their time). */
export const eventColumn = (axis: number[], ts: number) => {
  const index = axis.findIndex(column => column >= ts);
  return index === -1 ? axis.length - 1 : index;
};


/** A stored value as a timeline (null when empty or not one). */
export const asTimeline = (value: JsonValue | undefined): TimelineValue | null =>
  value && typeof value === "object" && !Array.isArray(value) && Array.isArray((value as TimelineValue).axis) ? (value as TimelineValue) : null;

/** A table cell as shown: numbers with at most 2 decimals, text as is, nothing for no value. */
export const cellLabel = (value: number | string | null | undefined): string =>
  value === null || value === undefined ? "" : typeof value === "number" ? String(Math.round(value * 100) / 100) : value;
