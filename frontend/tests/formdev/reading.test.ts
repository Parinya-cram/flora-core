/** The live reading screen's model (src/formdev/reading/events.ts): what each page shows as events arrive, and a line
 * the plan missed added by the author as a field. */
import { describe, expect, it } from "vitest";
import type { FormDefinition } from "../../src/formdev/core/types";
import { addLineAsField, pagesOf } from "../../src/formdev/reading/events";
import type { ReadingEvent } from "../../src/formdev/reading/types";

let seq = 0;
const event = (kind: string, page: number | null, data: Record<string, unknown> = {}): ReadingEvent => ({ seq: (seq += 1), at: seq * 100, kind, page, data });

describe("reading events", () => {
  it("build each page's state: scan, text, layout, plan and the AI's checked edits", () => {
    const coverage = { lines: 3, used: 2, ignored: 0, missed: ["L3"], share: 0.667 };
    const pages = pagesOf([
      event("started", null, { pages: 1 }),
      event("page", 0, { dpi: 200 }),
      event("text_layer", 0, { quality: "none" }),
      event("prepared", 0, { skew: 1.2, straightened: true }),
      event("ocr_started", 0),
      event("ocr_done", 0, { seconds: 0.8, lines: 3 }),
      event("lines", 0, { lines: [{ id: "L1", text: "WT", box: [0, 0, 0.1, 0.02], score: 0.9 }, { id: "L2", text: "kg", box: [0.2, 0, 0.25, 0.02], score: 0.9 }] }),
      event("lines", 0, { lines: [{ id: "L3", text: "DEPTH", box: [0, 0.1, 0.1, 0.12], score: 0.9 }] }),
      event("layout", 0, { cells: [{ id: "C1", box: [0, 0, 1, 0.5], empty: 0.8 }], grids: [], blanks: [{ id: "B1", box: [0.1, 0, 0.2, 0.02], kind: "underline" }], checkboxes: [] }),
      event("plan", 0, { items: [{ id: "I1.1", kind: "field", type: "decimal", label: "WT", source: ["L1", "B1", "L2"] }], coverage }),
      event("ai_started", 0, { sent: { lines: 3, cells: 1, blanks: 1, grids: 0, checkboxes: 0, items: 1, closeups: 1, page_px: 1600, unused: 1 } }),
    ]);
    const page = pages.get(0)!;
    expect(page.scanning).toBe(false);
    expect(page.dpi).toBe(200);
    expect([page.source, page.skew, page.straightened]).toEqual(["ocr", 1.2, true]);
    expect(page.lines.map(line => line.id)).toEqual(["L1", "L2", "L3"]);
    expect(page.layout?.blanks).toHaveLength(1);
    expect(page.coverage?.missed).toEqual(["L3"]);
    expect(page.aiRunning).toBe(true);
    expect(page.aiSent?.unused).toBe(1);

    const done = pagesOf([event("ai_done", 0, { changes: [{ add: "A1.2", label: "Depth", source: ["L3"] }], rejected: [{ item: "I1.1", why: "unit 'lb' is not printed on the page" }],
      coverage_before: coverage, coverage_after: { ...coverage, used: 3, missed: [], share: 1 } })]).get(0)!;
    expect(done.aiRunning).toBe(false);
    expect(done.aiChanges?.[0].label).toBe("Depth");
    expect(done.aiRejected?.[0].why).toContain("not printed");
    expect(done.aiAfter?.share).toBe(1);
    expect(pagesOf([event("ai_failed", 0, { message: "The AI server cannot be reached right now (530)" })]).get(0)?.aiFailed).toContain("530");
  });

  it("add a missed line as a text field with a free id, leaving the draft it came from unchanged", () => {
    const definition = { format: "flora.form/1", form_id: "f", schema_version: 1, title: "F", sections: [
      { id: "s", title: "S", fields: [{ id: "added_l3", type: "text", label: "x" }] }] } as unknown as FormDefinition;
    const next = addLineAsField(definition, { id: "L3", text: "DEPTH......", box: [0, 0, 1, 1], score: 1 });
    expect(next.sections[0].fields.map(field => [field.id, field.label])).toEqual([["added_l3", "x"], ["added_l3_2", "DEPTH"]]);
    expect(definition.sections[0].fields).toHaveLength(1);
  });
});
