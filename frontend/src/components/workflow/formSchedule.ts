import type { FormSlot, FormSlotStatus, WorkflowDefinition, WorkflowFormSchedule, WorkflowShift } from "../../api/workflowApi";

/** Scheduled workflow forms (ICU rounds, docs/ICU-ROUNDS.md): pure helpers shared by Studio, Leaf and print. */

export const DEFAULT_DAY_START = "07:00";
export const DEFAULT_SHIFTS: WorkflowShift[] = [
  { code: "D", label: "Day", start: "07:00" },
  { code: "E", label: "Evening", start: "15:00" },
  { code: "N", label: "Night", start: "23:00" },
];
export const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

/** A slot or entry time as a Date (the server sends epoch ms; epoch seconds are accepted too). */
export function slotDate(ts: number | string | null | undefined): Date | null {
  if (ts == null || ts === "") return null;
  if (typeof ts === "string" && !/^\d+$/.test(ts)) {
    const parsed = new Date(ts);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }
  const value = Number(ts);
  if (!Number.isFinite(value)) return null;
  return new Date(value < 1e12 ? value * 1000 : value);
}

/** A short description of a schedule, e.g. "Daily 07:00 · 7 days". */
export function scheduleText(schedule: WorkflowFormSchedule | null | undefined): string {
  if (!schedule) return "";
  const head = schedule.kind === "daily" ? `Daily ${schedule.at || DEFAULT_DAY_START}`
    : schedule.kind === "every" ? `Every ${schedule.every_hours || 8} h` : "Every shift";
  return `${head} · ${schedule.days ? `${schedule.days} day${schedule.days === 1 ? "" : "s"}` : "until discharge"}`;
}

/** Client-side checks matching the server's validate (HH:MM, ranges, unique ordered shifts). */
export function scheduleErrors(def: WorkflowDefinition): string[] {
  const out: string[] = [];
  if (def.day_start != null && !HHMM.test(def.day_start)) out.push("Day start must be HH:MM (00:00–23:59).");
  if (def.shifts) {
    const codes = new Set<string>();
    def.shifts.forEach((shift, index) => {
      if (!shift.code.trim()) out.push(`Shift ${index + 1} needs a code.`);
      else if (codes.has(shift.code)) out.push(`Shift code ${shift.code} is used twice.`);
      codes.add(shift.code);
      if (!HHMM.test(shift.start)) out.push(`Shift ${shift.code || index + 1} start must be HH:MM.`);
    });
    const starts = def.shifts.map(shift => shift.start);
    if (starts.some((start, index) => index > 0 && start <= starts[index - 1])) out.push("Shifts must be ordered by start time.");
  }
  for (const form of def.forms) {
    const schedule = form.schedule;
    if (!schedule) continue;
    const name = form.title || form.form_id;
    if (schedule.kind === "daily" && !HHMM.test(schedule.at || "")) out.push(`${name}: daily time must be HH:MM.`);
    if (schedule.kind === "every" && !(Number.isInteger(schedule.every_hours) && schedule.every_hours! >= 1 && schedule.every_hours! <= 24))
      out.push(`${name}: every must be 1–24 hours.`);
    if (schedule.days != null && !(Number.isInteger(schedule.days) && schedule.days >= 1)) out.push(`${name}: days must be a whole number of at least 1 (or empty for until discharge).`);
    if (schedule.grace_min != null && !(Number.isInteger(schedule.grace_min) && schedule.grace_min >= 0)) out.push(`${name}: grace must be whole minutes.`);
  }
  return out;
}

export type SlotDay = { day: number; slots: FormSlot[] };

/** Slots grouped by stay day, newest day first; slots inside a day in time order. */
export function groupSlotsByDay(slots: readonly FormSlot[]): SlotDay[] {
  const byDay = new Map<number, FormSlot[]>();
  for (const slot of slots) {
    const list = byDay.get(slot.day) ?? [];
    list.push(slot);
    byDay.set(slot.day, list);
  }
  return [...byDay.entries()]
    .sort((a, b) => b[0] - a[0])
    .map(([day, list]) => ({ day, slots: [...list].sort((a, b) => a.slot_ts - b.slot_ts) }));
}

/** The day to show expanded: the newest day with a slot that has started (else the newest day). */
export function currentDay(slots: readonly FormSlot[]): number | null {
  const started = slots.filter(slot => slot.status !== "upcoming");
  const pool = started.length ? started : slots;
  return pool.length ? Math.max(...pool.map(slot => slot.day)) : null;
}

export function slotCounts(slots: readonly FormSlot[]): Record<FormSlotStatus, number> {
  const out: Record<FormSlotStatus, number> = { done: 0, draft: 0, due: 0, overdue: 0, skipped: 0, upcoming: 0 };
  for (const slot of slots) out[slot.status] = (out[slot.status] ?? 0) + 1;
  return out;
}

/** The form-tab / case badge: overdue wins (red), else due (amber); null when nothing is pending. */
export function badgeFor(summary: { due?: number; overdue?: number } | null | undefined): { tone: "overdue" | "due"; count: number; text: string } | null {
  const overdue = summary?.overdue ?? 0;
  const due = summary?.due ?? 0;
  if (overdue > 0) return { tone: "overdue", count: overdue + due, text: due ? `${overdue} overdue · ${due} due` : `${overdue} overdue` };
  if (due > 0) return { tone: "due", count: due, text: `${due} due` };
  return null;
}

export const BADGE_TONE: Record<"overdue" | "due", string> = {
  overdue: "border-rose-400/50 bg-rose-500/15 text-rose-600 dark:text-rose-300",
  due: "border-amber-400/50 bg-amber-400/15 text-amber-700 dark:text-amber-300",
};

export const SLOT_TONE: Record<FormSlotStatus, string> = {
  done: "border-emerald-400/50 bg-emerald-500/10 text-emerald-600 dark:text-emerald-300",
  draft: "border-sky-400/50 bg-sky-500/10 text-sky-700 dark:text-sky-300",
  due: BADGE_TONE.due,
  overdue: BADGE_TONE.overdue,
  skipped: "border-[var(--app-border)] bg-[var(--app-control-bg)] text-[var(--app-muted)] line-through",
  upcoming: "border-[var(--app-border)] bg-transparent text-[var(--app-muted)]",
};

/** Completed entries in print order: slots by time, then unscheduled entries by completion time. */
export function printableEntries<E extends { slot_ts: number | null; status: string; completedAt?: string | number | null; updatedAt?: string | number | null }>(entries: readonly E[]): E[] {
  const time = (entry: E) => slotDate(entry.slot_ts ?? entry.completedAt ?? entry.updatedAt ?? null)?.getTime() ?? 0;
  return entries.filter(entry => entry.status === "completed").sort((a, b) => {
    if ((a.slot_ts == null) !== (b.slot_ts == null)) return a.slot_ts == null ? 1 : -1;
    return time(a) - time(b);
  });
}
