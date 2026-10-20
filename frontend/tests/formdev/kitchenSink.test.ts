/** The e2e kitchen-sink form (formdev/examples/e2e-kitchen-sink: every field type) on the Leaf side: the definition is
 * valid, every field type renders and prints, and every record gets the same issues as Canopy's Python rules give
 * (record-cases.json, written by formdev/scripts/build_kitchen_sink_cases.py), so a form round-trips between the two. */
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { pageCss, printContext, resolvePaper } from "../../src/formdev/core/layout";
import type { FieldDefinition, FormDefinition, JsonValue, RecordData } from "../../src/formdev/core/types";
import { validateDefinition } from "../../src/formdev/core/validate";
import { evaluateRecord } from "../../src/formdev/logic/evaluate";
import { layoutPdf } from "../../src/formdev/render/pdfLayout";
import { DEFAULT_FONTS, DEFAULT_STYLES } from "../../src/formdev/registry/defaults";
import { FIELD_TYPES } from "../../src/formdev/core/fieldTypes";
import FormRenderer from "../../src/formdev/ui/FormRenderer";

const root = new URL("../../../formdev/examples/e2e-kitchen-sink/", import.meta.url);
const definition = JSON.parse(readFileSync(new URL("v1.form.json", root), "utf8")) as FormDefinition;
const sample = JSON.parse(readFileSync(new URL("sample.record.json", root), "utf8")) as { record: RecordData };
const cases = JSON.parse(readFileSync(new URL("record-cases.json", root), "utf8")) as Array<{
  name: string; status: string; data: RecordData; issues: Array<{ path: string; code: string }>;
}>;

const fields = (list: FieldDefinition[]): FieldDefinition[] => list.flatMap(field => [field, ...fields(field.fields || [])]);
const all = definition.sections.flatMap(section => fields(section.fields));
const measure = (text: string, size: number) => [...text].length * size * 0.5;

describe("every printed page says whose record it is", () => {
  const now = new Date(2026, 9, 16, 9, 45);
  const context = printContext(definition, sample.record as Record<string, JsonValue>, { printedBy: "nurse_a", now });

  it("takes the patient from the form's fields (bind or usual names)", () => {
    expect(context).toMatchObject({ hn: "E2E0001", patient: "E2E Patient", printed_by: "nurse_a" });
    expect(context.dob).toMatch(/2513|1970/);
    expect(context.printed_at).toMatch(/09:45/);
  });

  it("the PDF of a form without a footer prints the patient, the print and the page on every page", () => {
    const long = { ...sample.record, lines: Array.from({ length: 4 }, (_, i) => ({ site: `site ${i}` })), notes: "x ".repeat(4000) } as Record<string, JsonValue>;
    const pages = layoutPdf({
      definition: { ...definition, paper: { size: "A4" } }, data: long, paper: resolvePaper({ ...definition, paper: { size: "A4" } }, {}),
      context: printContext(definition, long, { printedBy: "nurse_a", now }), hidden: new Set(), denied: new Set(), styleColumns: 12, measure,
    }).pages;
    expect(pages.length).toBeGreaterThan(1);
    pages.forEach((ops, index) => {
      const texts = ops.flatMap(op => (op.kind === "text" ? [op.text] : []));
      expect(texts.some(text => text.startsWith("HN E2E0001 · E2E Patient · DOB")), `page ${index + 1}`).toBe(true);
      expect(texts.some(text => text.includes("nurse_a") && text.endsWith(`${index + 1}/${pages.length}`)), `page ${index + 1}`).toBe(true);
    });
  });

  it("the HTML print puts the same footer in the page margin", () => {
    const css = pageCss(resolvePaper({ ...definition, paper: { size: "A4" } }, {}), context, "sans-serif");
    expect(css).toContain("@bottom-left");
    expect(css).toContain("HN E2E0001 · E2E Patient");
    expect(css).toContain("counter(page)");
  });

  it("a footer the author set is kept (and may use the patient tokens)", () => {
    const own = { ...definition, paper: { size: "A4" as const, footer: { left: "{hn} {patient}", right: "{page}" } } };
    const ops = layoutPdf({ definition: own, data: sample.record as Record<string, JsonValue>, paper: resolvePaper(own, {}), context,
      hidden: new Set(), denied: new Set(), styleColumns: 12, measure }).pages.flat();
    expect(ops.some(op => op.kind === "text" && op.text === "E2E0001 E2E Patient")).toBe(true);
    expect(ops.some(op => op.kind === "text" && op.text.includes("nurse_a"))).toBe(false);
  });
});

describe("kitchen-sink form on the Leaf side", () => {
  it("uses every field type of the registry and is valid", () => {
    expect(new Set(all.map(field => field.type))).toEqual(new Set(FIELD_TYPES));
    expect(validateDefinition(definition, DEFAULT_STYLES.map(s => s.style_id), DEFAULT_FONTS.map(f => f.font_id))).toEqual([]);
  });

  for (const item of cases) {
    it(`gives Canopy's answer: ${item.name}`, () => {
      const result = evaluateRecord(definition, item.data, item.status === "submitted" ? "submitted" : "draft", "2026-10-16");
      const issues = [...new Set(result.issues.map(issue => `${issue.path} ${issue.code}`))].sort();
      expect(issues).toEqual(item.issues.map(issue => `${issue.path} ${issue.code}`).sort());
    });
  }

  it("calculates as Canopy does", () => {
    expect(evaluateRecord(definition, sample.record, "submitted", "2026-10-16").data.bmi).toBe(24);
  });

  it("renders every field of a complete record", () => {
    const html = renderToString(createElement(FormRenderer, { definition, value: sample.record, language: "th", onChange: () => undefined }));
    for (const field of all) {
      // Printed elements, a group's own label, a paragraph (its content shows) and a divider (a line) show no label.
      if (["logo", "barcode", "group", "paragraph", "divider"].includes(field.type)) continue;
      // Packs a day shows only for former / current smokers (this record: "other"), as Canopy's rules hide it.
      if (field.id === "packs_per_day") expect(html).not.toContain(String(field.label).split(" / ")[0]);
      else expect(html, `${field.type} ${field.id}`).toContain(String(field.label).split(" / ")[0]);
    }
    expect(html).toContain("E2E0001");
    expect(html).toContain("L hand");
  });

  it("prints a complete record on A4", () => {
    const pages = layoutPdf({
      definition, data: sample.record as Record<string, JsonValue>, paper: resolvePaper(definition, {}),
      context: { title: definition.title, form_id: definition.form_id, version: 1, date: "" },
      hidden: new Set(), denied: new Set(), styleColumns: 12, measure,
    }).pages;
    const ops = pages.flat();
    expect(pages.length).toBeGreaterThan(0);
    expect(ops.some(op => op.kind === "image")).toBe(true);                       // logo
    expect(ops.filter(op => op.kind === "fill").length).toBeGreaterThan(20);      // barcode bars
    expect(ops.some(op => op.kind === "text" && op.text.includes("L hand"))).toBe(true);
  });
});
