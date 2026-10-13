import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FormDefinition, TimelineValue } from "../../src/formdev/core/types";
import { validateRecord } from "../../src/formdev/core/validate";
import { chartShapes } from "../../src/formdev/leaf/chartGeometry";
import { FormCaseContext } from "../../src/formdev/leaf/caseContext";
import { bucketValues, eventColumn, loadLeafTimeline, neededRows, timelineAxis } from "../../src/formdev/leaf/timeline";
import { layoutPdf } from "../../src/formdev/render/pdfLayout";
import { resolvePaper } from "../../src/formdev/core/layout";
import FormRenderer from "../../src/formdev/ui/FormRenderer";

const T0 = Date.UTC(2026, 9, 6, 2, 0);
const MIN = 60_000;

describe("Form Studio timeline: Flora Leaf data", () => {
  it("columns every step minutes; a column shows the latest reading since the previous one", () => {
    const axis = timelineAxis(T0 + 30_000, T0 + 20 * MIN, 5);
    expect(axis).toEqual([T0, T0 + 5 * MIN, T0 + 10 * MIN, T0 + 15 * MIN, T0 + 20 * MIN]);
    const minutes = { hr: { [T0]: 70, [T0 + 3 * MIN]: 80, [T0 + 4 * MIN]: 81.456, [T0 + 12 * MIN]: "AF" }, spo2: {} };
    expect(bucketValues(minutes, axis, ["hr", "spo2", "bis"])).toEqual({ hr: { [String(T0)]: 70, [String(T0 + 5 * MIN)]: 81.46, [String(T0 + 15 * MIN)]: "AF" } });
    expect(eventColumn(axis, T0 + 7 * MIN)).toBe(2);
    expect(eventColumn(axis, T0 + 99 * MIN)).toBe(4);
    expect(neededRows(["hr", "et_co2"], ["nibp", "hr"])).toEqual(["hr", "et_co2", "nibp_sys", "nibp_map", "nibp_dia"]);
  });

  afterEach(() => vi.unstubAllGlobals());

  it("loads a case through Leaf's APIs (axis, effective per-minute values with device keys mapped, events)", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => {
      calls.push(url.replace(/^.*\/api\/case/, ""));
      const json = (body: unknown) => ({ ok: true, json: async () => body, text: async () => "" });
      if (url.includes("/timeaxis")) return json({ axis: Array.from({ length: 11 }, (_, i) => T0 + i * MIN), server_time: T0 + 10 * MIN });
      if (url.includes("/timeline/effective")) return json({ rows: [{ ts_minute: T0 + 2 * MIN, payload: { heart_rate: 66, nibp_sys: 120, nibp_mean: 90, nibp_dia: 70 } }, { ts_minute: T0 + 9 * MIN, payload: { heart_rate: 68 } }] });
      return json({ rows: [{ id: 1, event_ts: T0 + MIN, event_type: "event", title: "Induction", created_by: "x", created_at: 0 }, { id: 2, event_ts: T0, event_type: "note", title: "note", created_by: "x", created_at: 0 }] });
    });
    const value = await loadLeafTimeline({ caseId: 12 }, 5, ["hr", "nibp_sys", "nibp_map", "nibp_dia"]);
    expect(calls[0]).toBe("/12/timeaxis?step=1");
    expect(value.axis).toEqual([T0, T0 + 5 * MIN, T0 + 10 * MIN]);
    expect(value.values).toEqual({ hr: { [String(T0 + 5 * MIN)]: 66, [String(T0 + 10 * MIN)]: 68 }, nibp_sys: { [String(T0 + 5 * MIN)]: 120 }, nibp_map: { [String(T0 + 5 * MIN)]: 90 }, nibp_dia: { [String(T0 + 5 * MIN)]: 70 } });
    expect(value.events).toEqual([{ ts: T0 + MIN, title: "Induction" }]);
    expect(value).toMatchObject({ step_min: 5, source: "leaf", case_id: 12 });
  });

  const snapshot: TimelineValue = {
    step_min: 20, axis: Array.from({ length: 26 }, (_, i) => T0 + i * 20 * MIN),
    values: { nibp_sys: { [String(T0)]: 130 }, nibp_map: { [String(T0)]: 95 }, nibp_dia: { [String(T0)]: 70 }, hr: { [String(T0)]: 72 }, et_co2: { [String(T0)]: 31 } },
    events: [{ ts: T0 + 5 * MIN, title: "Induction" }],
  };
  const definition = {
    format: "flora.form/1", form_id: "anes", schema_version: 1, title: "Anesthesia", paper: { size: "A4", orientation: "portrait" }, style_id: "style.a4.medical",
    sections: [{ id: "trends", title: "Trends", fields: [{ id: "trends", type: "timeline", label: "Trends", timeline: { step_min: 20, chart: ["nibp", "hr"] } }] }],
  } as unknown as FormDefinition;

  it("the chart draws NIBP as a range bar with sys / mean / dia markers, other series as markers", () => {
    const shapes = chartShapes(snapshot, ["nibp", "hr"], { x: 0, y: 0, width: 260, height: 180, columns: 26 });
    expect(shapes.filter(shape => shape.kind === "bar")).toHaveLength(1);
    expect(shapes.filter(shape => shape.kind === "marker").map(shape => (shape as { marker: string }).marker)).toEqual(["down", "square", "up", "x"]);
  });

  it("prints a page per block of columns, each with times, events, chart and table, then the event list", () => {
    expect(validateRecord(definition, { trends: snapshot }, "draft")).toEqual([]);
    const layout = layoutPdf({ definition, data: { trends: snapshot }, paper: resolvePaper(definition, {}), context: { title: "Anesthesia", form_id: "anes", version: 1, date: "" },
      hidden: new Set(), denied: new Set(), styleColumns: 2, measure: (text, size) => text.length * size * 0.5 });
    expect(layout.pages.length).toBe(2);
    const texts = layout.pages.map(page => page.filter(op => op.kind === "text").map(op => (op as { text: string }).text));
    expect(texts[0]).toContain("Trends");
    expect(texts[1]).toContain("Trends (2/2)");
    expect(texts[1].some(text => text.includes("Induction"))).toBe(true);
    expect(layout.pages[0].some(op => op.kind === "path")).toBe(true);
  });

  it("renders for entry: without a case values are typed in; in a case the pull button shows", () => {
    const typed = renderToString(createElement(FormRenderer, { definition, value: { trends: snapshot }, onChange: () => undefined }));
    expect(typed).toContain('data-timeline="trends"');
    expect(typed).toContain("ไม่ได้เปิดในเคส");
    expect(typed).not.toContain("ดึงข้อมูลจาก Flora Leaf");
    const inCase = renderToString(createElement(FormCaseContext.Provider, { value: { caseId: 12 } }, createElement(FormRenderer, { definition, value: { trends: snapshot }, onChange: () => undefined })));
    expect(inCase).toContain("ดึงข้อมูลจาก Flora Leaf");
    expect(inCase).toContain('aria-label="EtCO2 02:00"'.replace("02:00", new Date(T0).getHours().toString().padStart(2, "0") + ":00"));
  });
});
