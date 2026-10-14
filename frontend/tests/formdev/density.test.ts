/** Print density (paper.density) and timeline print settings: compact and fit-one-page layouts, the printed step that
 * widens so a case fits the page's columns, empty rows left out — and nothing cut: what does not fit continues. */
import { describe, expect, it } from "vitest";
import { resolvePaper } from "../../src/formdev/core/layout";
import type { FormDefinition, JsonValue, TimelineValue } from "../../src/formdev/core/types";
import { validateDefinition } from "../../src/formdev/core/validate";
import { anesthesiaForm, pacuForm } from "../../src/formdev/designer/templates";
import { layoutPdf, MIN_FONT, printStep, rebucket, type Op } from "../../src/formdev/render/pdfLayout";
import { DEFAULT_FONTS, DEFAULT_STYLES } from "../../src/formdev/registry/defaults";
import { rowInfo } from "../../src/formdev/leaf/timeline";

const measure = (text: string, size: number) => [...text].length * size * 0.5;
const textOps = (ops: Op[]) => ops.filter((op): op is Extract<Op, { kind: "text" }> => op.kind === "text");
const layout = (definition: FormDefinition, data: Record<string, JsonValue> = {}) => layoutPdf({
  definition, data, paper: resolvePaper(definition, {}), context: { title: definition.title, form_id: definition.form_id, version: 1, date: "" },
  hidden: new Set(), denied: new Set(), styleColumns: 2, measure,
});
const withDensity = (definition: FormDefinition, density: "normal" | "compact" | "fit_page"): FormDefinition =>
  ({ ...definition, paper: { ...(typeof definition.paper === "object" ? definition.paper : { size: "A4" }), density } });

const START = Date.UTC(2026, 9, 14, 1, 0);
/** A recorded timeline: `hours` of 5-minute columns, heart rate in every column, BIS only in the first hour. */
function recorded(hours: number): TimelineValue {
  const axis = Array.from({ length: hours * 12 + 1 }, (_, index) => START + index * 5 * 60_000);
  return {
    step_min: 5, axis,
    values: {
      hr: Object.fromEntries(axis.map((ts, index) => [String(ts), 70 + (index % 10)])),
      bis: Object.fromEntries(axis.slice(0, 12).map(ts => [String(ts), 45])),
    },
    events: [{ ts: START + 7 * 60_000, title: "Induction" }],
  };
}

describe("printed step", () => {
  it("widens to the smallest step that fits the case in the page's columns", () => {
    expect(printStep(recorded(1), 24)).toBe(5);
    expect(printStep(recorded(3), 24)).toBe(10);
    expect(printStep(recorded(5), 24)).toBe(15);
    expect(printStep(recorded(8), 24)).toBe(30);
    expect(printStep(recorded(14), 24)).toBe(30);
    expect(printStep(recorded(3), undefined)).toBe(5);
  });

  it("keeps the first value of each wider column and every event", () => {
    const wide = rebucket(recorded(1), 15);
    expect(wide.axis).toEqual([0, 1, 2, 3, 4].map(index => START + index * 15 * 60_000));
    expect(wide.values.hr[String(START)]).toBe(70);
    expect(wide.values.hr[String(START + 15 * 60_000)]).toBe(73);
    expect(wide.events).toEqual(recorded(1).events);
    expect(rebucket(recorded(1), 5)).toEqual(recorded(1));
  });
});

describe("print density", () => {
  it("validates density and the timeline print settings on both sides of the schema", () => {
    const definition = anesthesiaForm("anes", "Anesthesia");
    const trends = definition.sections[1].fields[0];
    trends.timeline = { ...trends.timeline, print_columns: 24, hide_empty_rows: true };
    const styles = DEFAULT_STYLES.map(style => style.style_id);
    const fonts = DEFAULT_FONTS.map(font => font.font_id);
    expect(validateDefinition(withDensity(definition, "fit_page"), styles, fonts)).toEqual([]);
    trends.timeline = { ...trends.timeline, print_columns: 4 };
    expect(validateDefinition({ ...definition, paper: { size: "A4", density: "tiny" as never } }, styles, fonts).map(issue => issue.code))
      .toEqual(expect.arrayContaining(["invalid_paper", "invalid_type"]));
  });

  it("compact sets smaller type, never below the minimum, and needs no more pages", () => {
    const pacu = pacuForm("pacu", "PACU");
    const normal = layout(pacu);
    const compact = layout(withDensity(pacu, "compact"));
    expect(compact.pages.length).toBeLessThanOrEqual(normal.pages.length);
    const sizes = (pages: Op[][]) => textOps(pages.flat()).map(op => op.size);
    expect(Math.max(...sizes(compact.pages))).toBeLessThan(Math.max(...sizes(normal.pages)));
    expect(Math.min(...sizes(compact.pages))).toBeGreaterThanOrEqual(MIN_FONT);
  });

  it("fit_page keeps one page when a smaller size fits", () => {
    const pacu = pacuForm("pacu", "PACU");
    // Longer than one page at normal size: the problems list printed twice as long.
    const long: FormDefinition = { ...pacu, sections: pacu.sections.map(section => section.id === "problems"
      ? { ...section, fields: section.fields.map(field => ({ ...field, option_columns: 1 })) } : section) };
    expect(layout(long).pages.length).toBeGreaterThan(1);
    const fitted = layout(withDensity(long, "fit_page"));
    expect(fitted.pages).toHaveLength(1);
    expect(fitted.scale).toBeLessThan(1);
    expect(layout(withDensity(pacu, "fit_page")).scale).toBe(1);
  });

  it("fit_page continues on the next pages instead of cutting when nothing fits", () => {
    const pacu = pacuForm("pacu", "PACU");
    const many: FormDefinition = { ...pacu, sections: [...pacu.sections, ...Array.from({ length: 6 }, (_, n) => ({ ...pacu.sections[2], id: `aldrete_${n}`, title: `Round ${n + 1}`,
      fields: pacu.sections[2].fields.map(field => ({ ...field, id: `mass_${n}` })) }))] };
    const result = layout(withDensity(many, "fit_page"));
    expect(result.pages.length).toBeGreaterThan(1);
    expect(result.scale).toBe(0.74);
    const all = textOps(result.pages.flat()).map(op => op.text);
    for (let n = 1; n <= 6; n += 1) expect(all).toContain(`Round ${n}`);
    // The patient header and the signatures are on every page.
    for (const page of result.pages) expect(textOps(page).map(op => op.text)).toEqual(expect.arrayContaining(["HN:", "Surgeon"]));
  });
});

describe("timeline print settings", () => {
  const anesthesia = (columns?: number, hideEmpty?: boolean) => {
    const definition = anesthesiaForm("anes", "Anesthesia");
    const trends = definition.sections[1].fields[0];
    trends.timeline = { ...trends.timeline, chart: ["nibp", "hr"], rows: [{ id: "hr" }, { id: "bis" }, { id: "spo2" }], print_columns: columns, hide_empty_rows: hideEmpty };
    return definition;
  };
  const timeHeads = (ops: Op[]) => textOps(ops).filter(op => /^\d\d:\d\d$/.test(op.text)).map(op => op.text);

  it("prints a 3-hour case in 10-minute columns on one page", () => {
    const result = layout(anesthesia(24), { trends: recorded(3) as unknown as JsonValue });
    const heads = timeHeads(result.pages.flat());
    expect(heads.length).toBe(19);
    expect(result.pages).toHaveLength(1);
  });

  it("continues a long case on the next page in 30-minute columns, the header on each page", () => {
    const result = layout(anesthesia(24), { trends: recorded(14) as unknown as JsonValue });
    expect(timeHeads(result.pages.flat())).toHaveLength(29);
    expect(result.pages.length).toBeGreaterThanOrEqual(2);
    for (const page of result.pages) expect(textOps(page).map(op => op.text)).toContain("HN:");
  });

  it("leaves out rows with no value on the page", () => {
    const labels = (definition: FormDefinition) => textOps(layout(definition, { trends: recorded(3) as unknown as JsonValue }).pages.flat()).map(op => op.text);
    const spo2 = rowInfo("spo2").label;
    expect(labels(anesthesia(24, false))).toContain(spo2);
    expect(labels(anesthesia(24, true))).not.toContain(spo2);
    expect(labels(anesthesia(24, true))).toContain("BIS");
  });
});
