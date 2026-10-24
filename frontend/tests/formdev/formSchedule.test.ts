/** Scheduled workflow forms (ICU rounds, docs/ICU-ROUNDS.md): slot grouping, badges, Studio checks and print order. */
import { describe, expect, it } from "vitest";
import type { FormSlot, WorkflowDefinition } from "../../src/api/workflowApi";
import { emptyWorkflow } from "../../src/api/workflowApi";
import { workflowFormTabs } from "../../src/components/workflow/caseWorkflow";
import { badgeFor, currentDay, groupSlotsByDay, printableEntries, scheduleErrors, scheduleText, slotDate } from "../../src/components/workflow/formSchedule";
import { anesthesiaForm } from "../../src/formdev/designer/templates";

const H = 3_600_000;
const T0 = Date.UTC(2026, 9, 20, 0, 0);
const slot = (day: number, hour: number, status: FormSlot["status"], entry_id: string | null = null): FormSlot =>
  ({ slot_ts: T0 + ((day - 1) * 24 + hour) * H, day, shift: null, label: `Day ${day} · ${hour}`, status, entry_id });

describe("scheduled form slots", () => {
  const slots = [slot(1, 0, "done", "e1"), slot(1, 8, "skipped", "e2"), slot(2, 8, "overdue"), slot(2, 0, "done", "e3"), slot(3, 0, "due"), slot(3, 8, "upcoming")];

  it("group by day, newest day first, slots in time order", () => {
    const days = groupSlotsByDay(slots);
    expect(days.map(group => group.day)).toEqual([3, 2, 1]);
    expect(days[1].slots.map(item => item.status)).toEqual(["done", "overdue"]);
  });

  it("expand the newest day that has started", () => {
    expect(currentDay(slots)).toBe(3);
    expect(currentDay([slot(1, 0, "done"), slot(2, 0, "upcoming")])).toBe(1);
    expect(currentDay([])).toBeNull();
  });

  it("badge the tab: overdue first, then due, nothing when clear", () => {
    expect(badgeFor({ due: 1, overdue: 2 })).toEqual({ tone: "overdue", count: 3, text: "2 overdue · 1 due" });
    expect(badgeFor({ due: 1, overdue: 0 })).toMatchObject({ tone: "due", count: 1 });
    expect(badgeFor({ due: 0, overdue: 0 })).toBeNull();
    expect(badgeFor(null)).toBeNull();
  });

  it("read slot times in ms or seconds", () => {
    expect(slotDate(T0)?.getTime()).toBe(T0);
    expect(slotDate(T0 / 1000)?.getTime()).toBe(T0);
    expect(slotDate(null)).toBeNull();
  });

  it("print completed entries in slot order, unscheduled last", () => {
    const entries = [
      { id: "u", slot_ts: null, status: "completed", completedAt: T0 },
      { id: "b", slot_ts: T0 + 24 * H, status: "completed" },
      { id: "d", slot_ts: T0 + 8 * H, status: "draft" },
      { id: "a", slot_ts: T0, status: "completed" },
    ];
    expect(printableEntries(entries).map(entry => entry.id)).toEqual(["a", "b", "u"]);
  });
});

describe("Workflow Studio schedule checks", () => {
  const withForm = (schedule: WorkflowDefinition["forms"][number]["schedule"], extra: Partial<WorkflowDefinition> = {}): WorkflowDefinition =>
    ({ ...emptyWorkflow(), id: "icu", name: "ICU", forms: [{ form_id: "round", version: 1, title: "Round", schedule }], ...extra });

  it("accept daily, every N h and per shift", () => {
    expect(scheduleErrors(withForm({ kind: "daily", at: "07:00", days: 7 }))).toEqual([]);
    expect(scheduleErrors(withForm({ kind: "every", every_hours: 8, days: null }))).toEqual([]);
    expect(scheduleErrors(withForm({ kind: "per_shift" }, { day_start: "07:00", shifts: [{ code: "D", start: "07:00" }, { code: "N", start: "19:00" }] }))).toEqual([]);
    expect(scheduleText({ kind: "daily", at: "07:00", days: null })).toBe("Daily 07:00 · until discharge");
  });

  it("reject bad times, ranges and shifts", () => {
    expect(scheduleErrors(withForm({ kind: "daily", at: "7am" }))).toHaveLength(1);
    expect(scheduleErrors(withForm({ kind: "every", every_hours: 30 }))).toHaveLength(1);
    expect(scheduleErrors(withForm({ kind: "daily", at: "07:00", days: 0 }))).toHaveLength(1);
    const shifts = scheduleErrors(withForm(null, { shifts: [{ code: "D", start: "15:00" }, { code: "D", start: "07:00" }] }));
    expect(shifts).toContain("Shift code D is used twice.");
    expect(shifts).toContain("Shifts must be ordered by start time.");
  });

  it("carry the schedule and summary onto the Leaf tab", () => {
    const value = { workflow: { forms: [{ form_id: "a", version: 1 }, { form_id: "b", version: 1, schedule: { kind: "daily", at: "07:00" } }] },
      forms: { a: { definition: anesthesiaForm("a", "A"), record: null }, b: { definition: anesthesiaForm("b", "B"), record: null, summary: { due: 1, overdue: 0, done: 2 } } } };
    const tabs = workflowFormTabs(value as never);
    expect(tabs.map(tab => tab.schedule?.kind ?? null)).toEqual([null, "daily"]);
    expect(tabs[1].summary).toEqual({ due: 1, overdue: 0, done: 2 });
  });
});
