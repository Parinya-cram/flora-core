import { describe, expect, it } from "vitest";
import { clampEditionTimelineScale, editionTimelineScaleOptions } from "../../src/edition/config";
import { resolveChartWindow, stayDayOneStart, stayDayStarts } from "../../src/views/clinical-chart/dayWindow";

const local = (y: number, m: number, d: number, h = 0, min = 0) => new Date(y, m - 1, d, h, min).getTime();
const H = 3_600_000;

describe("stay days", () => {
  it("Day 1 starts at the day_start at or before the case start", () => {
    expect(stayDayOneStart(local(2026, 10, 20, 14, 37))).toBe(local(2026, 10, 20));
    expect(stayDayOneStart(local(2026, 10, 20, 5, 0), "07:00")).toBe(local(2026, 10, 19, 7));
    expect(stayDayOneStart(local(2026, 10, 20, 9, 0), "07:00")).toBe(local(2026, 10, 20, 7));
  });

  it("lists one start per calendar day up to the end", () => {
    const starts = stayDayStarts(local(2026, 10, 20, 14, 37), local(2026, 10, 23, 8));
    expect(starts).toEqual([local(2026, 10, 20), local(2026, 10, 21), local(2026, 10, 22), local(2026, 10, 23)]);
  });
});

describe("chart window", () => {
  const base = { caseStartTs: local(2026, 10, 20, 14, 37), nowTs: local(2026, 10, 23, 8, 10), active: true };

  it("short cases keep the whole case", () => {
    const window = resolveChartWindow({ ...base, choice: "auto", endTs: base.caseStartTs + 5 * H, stepMin: 1 });
    expect(window).toMatchObject({ choice: "all", from: null, to: null, anchor: null, live: true });
  });

  it("long stays default to the last 24 h, rounded to the hour", () => {
    const window = resolveChartWindow({ ...base, choice: "auto", endTs: base.nowTs, stepMin: 15 });
    expect(window.choice).toBe("last24");
    expect(window.from).toBe(Math.floor((base.nowTs - 24 * H) / H) * H);
    expect(window.to).toBeNull();
    expect(window.live).toBe(true);
  });

  it("a past day is a static window; columns cover (day start, next day start]", () => {
    const window = resolveChartWindow({ ...base, choice: 2, endTs: base.nowTs, stepMin: 240 });
    expect(window.from).toBe(local(2026, 10, 21) + 60_000);
    expect(window.to).toBe(local(2026, 10, 22));
    expect(window.live).toBe(false);
    expect(window.anchor).toBe(local(2026, 10, 20));
  });

  it("1-minute columns use [day start, next day start)", () => {
    const window = resolveChartWindow({ ...base, choice: 4, endTs: base.nowTs, stepMin: 1 });
    expect(window.from).toBe(local(2026, 10, 23));
    expect(window.to).toBe(local(2026, 10, 24) - 60_000);
    expect(window.live).toBe(true);
  });
});

describe("edition scales", () => {
  it("offers the listed steps within the edition limits", () => {
    expect(editionTimelineScaleOptions([1, 15])).toEqual([1, 5, 15]);
    expect(editionTimelineScaleOptions([1, 5, 15, 30, 60, 120, 240, 360, 720, 1440])).toHaveLength(10);
  });

  it("snaps a stored value to the nearest option", () => {
    expect(clampEditionTimelineScale(10, [1, 1440])).toBe(5);
    expect(clampEditionTimelineScale(200, [1, 1440])).toBe(240);
    expect(clampEditionTimelineScale(120, [1, 15])).toBe(15);
  });
});
