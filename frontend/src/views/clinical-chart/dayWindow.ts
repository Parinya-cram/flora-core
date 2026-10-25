/** Stay days for long cases (ICU 14–30 days): Day N windows of the chart and the print range. */

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
/** Cases longer than this open on the last 24 h; shorter ones (OR, short stays) show the whole case. */
export const LONG_STAY_MS = 2 * DAY_MS;

/** "auto" = whole case for short cases, last 24 h for long stays; a number is a stay day (1-based). */
export type ChartWindowChoice = "auto" | "all" | "last24" | number;

export type ChartWindow = {
  choice: "all" | "last24" | number;
  /** Axis window bounds (ms, inclusive) or null for the case start / end. */
  from: number | null;
  to: number | null;
  /** Grid anchor for coarse steps (> 120 min): Day 1 start, so columns fall on clinical hours. */
  anchor: number | null;
  /** The window contains now (active case): poll and keep future columns. */
  live: boolean;
};

function parseDayStart(raw: string | null | undefined): [number, number] {
  const match = /^(\d{1,2}):(\d{2})$/.exec(String(raw || "").trim());
  if (!match) return [0, 0];
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  return hours < 24 && minutes < 60 ? [hours, minutes] : [0, 0];
}

/** Day 1 starts at the last day_start (local time, default 00:00) at or before the case start. */
export function stayDayOneStart(caseStartTs: number, dayStart?: string | null): number {
  const [hours, minutes] = parseDayStart(dayStart);
  const date = new Date(caseStartTs);
  date.setHours(hours, minutes, 0, 0);
  if (date.getTime() > caseStartTs) date.setDate(date.getDate() - 1);
  return date.getTime();
}

/** Start of each stay day (Day 1..N) up to endTs; calendar arithmetic so DST days stay aligned. */
export function stayDayStarts(caseStartTs: number, endTs: number, dayStart?: string | null): number[] {
  const first = new Date(stayDayOneStart(caseStartTs, dayStart));
  const starts: number[] = [];
  for (let day = 0; day < 400; day += 1) {
    const date = new Date(first);
    date.setDate(first.getDate() + day);
    const ts = date.getTime();
    if (day > 0 && ts > endTs) break;
    starts.push(ts);
  }
  return starts;
}

function nextDayStart(ts: number): number {
  const date = new Date(ts);
  date.setDate(date.getDate() + 1);
  return date.getTime();
}

/** Columns show (previous column, column]: with step > 1 a window [from, to) maps to columns
 * in (from, to]; with 1-min columns it is [from, to - 1 min]. Each minute lands in one window. */
function windowBounds(from: number, to: number, stepMin: number): { from: number; to: number } {
  return stepMin > 1 ? { from: from + MINUTE_MS, to } : { from, to: to - MINUTE_MS };
}

export function resolveChartWindow(input: {
  choice: ChartWindowChoice;
  caseStartTs: number;
  /** Discharge time, or now for an active case. */
  endTs: number;
  nowTs: number;
  active: boolean;
  stepMin: number;
  dayStart?: string | null;
}): ChartWindow {
  const { caseStartTs, endTs, nowTs, active, stepMin, dayStart } = input;
  const starts = stayDayStarts(caseStartTs, endTs, dayStart);
  const anchor = stepMin > 120 ? starts[0] : null;
  const longStay = endTs - caseStartTs > LONG_STAY_MS;
  let choice: ChartWindow["choice"] = input.choice === "auto" ? (longStay ? "last24" : "all") : input.choice;
  if (typeof choice === "number" && (choice < 1 || choice > starts.length)) choice = "all";

  if (choice === "all") return { choice, from: null, to: null, anchor, live: active };
  if (choice === "last24") {
    // Rounded down to the hour so the window (and the fetch) moves once an hour, not every tick.
    const base = active ? nowTs : endTs;
    const from = Math.max(caseStartTs, Math.floor((base - DAY_MS) / HOUR_MS) * HOUR_MS);
    return { choice, from, to: active ? null : endTs, anchor, live: active };
  }
  const dayFrom = starts[choice - 1];
  const dayTo = nextDayStart(dayFrom);
  const bounds = choice === 1
    ? { from: null, to: windowBounds(dayFrom, dayTo, stepMin).to }
    : windowBounds(dayFrom, dayTo, stepMin);
  return { choice, ...bounds, anchor, live: active && dayTo > nowTs };
}

/** Labels for the Day picker: "Day 3 · 24 Oct". */
export function stayDayLabel(dayIndex: number, dayStartTs: number): string {
  const date = new Date(dayStartTs);
  return `Day ${dayIndex} · ${date.toLocaleDateString(undefined, { day: "numeric", month: "short" })}`;
}
