/** The two-dimensional grid: fields placed by row and column, covering several rows, static elements and English
 * labels, the same on screen (CSS grid areas) and on paper (render/pdfLayout.ts). */
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { gridArea, placeField, resolvePaper } from "../../src/formdev/core/layout";
import { fieldLabel, localized, splitBilingual } from "../../src/formdev/core/labels";
import type { FieldDefinition, FormDefinition, JsonValue } from "../../src/formdev/core/types";
import { validateDefinition } from "../../src/formdev/core/validate";
import { layoutPdf } from "../../src/formdev/render/pdfLayout";
import { DEFAULT_FONTS, DEFAULT_STYLES } from "../../src/formdev/registry/defaults";
import FormRenderer from "../../src/formdev/ui/FormRenderer";

const measure = (text: string, size: number) => [...text].length * size * 0.5;
const fields: FieldDefinition[] = [
  { id: "title", type: "heading", label: "แบบประเมิน", label_en: "Assessment", level: 1, align: "center" },
  { id: "photo", type: "textarea", label: "AAA", layout: { row: 2, col: 1, span: 8, row_span: 2 } },
  { id: "bbb", type: "text", label: "BBB", layout: { row: 2, col: 9, span: 16 } },
  { id: "ccc", type: "text", label: "CCC", layout: { row: 3, col: 9, span: 16 } },
  { id: "ddd", type: "text", label: "DDD", layout: { span: 12 } },
  { id: "rule", type: "divider", label: "Line", layout: { span: 24 } },
  { id: "note", type: "paragraph", label: "Note", content: "Please check twice." },
  { id: "sex", type: "radio", label: "เพศ", label_en: "Sex", options: [{ value: "f", label: "หญิง", label_en: "Female" }, { value: "m", label: "ชาย" }] },
];
const definition = {
  format: "flora.form/1", form_id: "grid_2d", title: "Grid", schema_version: 1, style_id: DEFAULT_STYLES[0].style_id,
  layout: { type: "grid", columns: 24 }, paper: { size: "A4" }, sections: [{ id: "main", title: "หลัก", title_en: "Main", fields }],
} as unknown as FormDefinition;

describe("the two-dimensional grid", () => {
  it("is a valid definition", () => {
    expect(validateDefinition(definition, DEFAULT_STYLES.map(s => s.style_id), DEFAULT_FONTS.map(f => f.font_id))).toEqual([]);
  });

  it("places a field covering rows on the screen grid", () => {
    expect(gridArea(placeField(fields[1], "desktop", 24))).toEqual({ gridColumn: "1 / span 8", gridRow: "2 / span 2" });
    expect(gridArea(placeField(fields[2], "desktop", 24))).toEqual({ gridColumn: "9 / span 16", gridRow: "2" });
    expect(gridArea(placeField(fields[1], "mobile", 24))).toEqual({ gridColumn: "span 24" });  // phones flow
  });

  it("prints fields where they are placed, a tall field beside the rows it covers", () => {
    const ops = layoutPdf({ definition, data: {} as Record<string, JsonValue>, paper: resolvePaper(definition, {}),
      context: { title: "Grid", form_id: "grid_2d", version: 1, date: "" }, hidden: new Set(), denied: new Set(), styleColumns: 2, measure }).pages.flat();
    const at = (text: string) => {
      const op = ops.find(item => item.kind === "text" && item.text === text);
      if (!op || op.kind !== "text") throw new Error(`no ${text}`);
      return op;
    };
    const [a, b, c, d] = ["AAA", "BBB", "CCC", "DDD"].map(at);
    expect(a.y).toBeCloseTo(b.y, 1);             // same top row
    expect(b.x).toBeGreaterThan(a.x);           // beside it
    expect(c.x).toBeCloseTo(b.x, 1);
    expect(c.y).toBeGreaterThan(b.y);            // the next row, still beside AAA
    expect(d.y).toBeGreaterThan(c.y);            // the next free row
    expect(d.x).toBeCloseTo(a.x, 1);
    expect(at("แบบประเมิน").y).toBeLessThan(a.y); // the heading row first
    expect(ops.some(op => op.kind === "line" && op.color === "#94a3b8")).toBe(true);  // divider
    expect(ops.some(op => op.kind === "text" && op.text.includes("Please check twice."))).toBe(true);
  });
});

describe("English labels", () => {
  it("are shown when the UI is English and the form has them", () => {
    const html = renderToString(createElement(FormRenderer, { definition, value: {}, language: "en", onChange: () => undefined }));
    expect(html).toContain("Assessment");
    expect(html).toContain("Sex");
    expect(html).toContain("Female");
    expect(html).toContain("ชาย");          // an option without English keeps its own label
    expect(html).toContain(">Main<");
    const thai = renderToString(createElement(FormRenderer, { definition, value: {}, language: "th", onChange: () => undefined }));
    expect(thai).toContain("แบบประเมิน");
    expect(thai).toContain("หญิง");
  });

  it("helpers", () => {
    expect(fieldLabel(fields[7], "en-US")).toBe("Sex");
    expect(localized(fields[7], "th")).toBe(fields[7]);
    expect(splitBilingual("น้ำหนัก / Weight")).toEqual({ th: "น้ำหนัก", en: "Weight" });
    expect(splitBilingual("Weight")).toBeNull();
  });
});

import { cellsOf, compactRows, listColumns, placeAt } from "../../src/formdev/designer/model";
import { scaleSpans } from "../../src/formdev/designer/catalog";

describe("the designer on the two-dimensional grid", () => {
  const form = (fields: FieldDefinition[]) => ({ ...definition, sections: [{ id: "main", title: "Main", fields }] }) as FormDefinition;
  const flowing: FieldDefinition[] = [
    { id: "a", type: "text", label: "A", layout: { span: 12 } }, { id: "b", type: "text", label: "B", layout: { span: 12 } },
    { id: "c", type: "text", label: "C", layout: { span: 24 } },
  ];
  const list = ["sections", 0, "fields"];
  const cellOf = (def: FormDefinition, id: string) => {
    const fields = def.sections[0].fields;
    return cellsOf(fields, 24)[fields.findIndex(field => field.id === id)];
  };

  it("drops a field on any row and column, pinning the others where they show", () => {
    const { definition: next, ref } = placeAt(form(flowing), { list, index: 2 }, { row: 1, col: 1, span: 8 }, 24);
    expect(cellOf(next, "c")).toEqual({ row: 1, col: 1, span: 8, rows: 1 });
    expect(next.sections[0].fields[ref.index].id).toBe("c");
    // A and B were in row 1: A is covered (moves down), B (cols 13-24) is not.
    expect(cellOf(next, "b")).toEqual({ row: 1, col: 13, span: 12, rows: 1 });
    expect(cellOf(next, "a").row).toBe(2);
    expect(next.sections[0].fields.map(field => field.id)).toEqual(["c", "b", "a"]);   // reading order
    expect(validateDefinition(next, DEFAULT_STYLES.map(s => s.style_id), DEFAULT_FONTS.map(f => f.font_id))).toEqual([]);
  });

  it("resizes a field over several rows; what it would cover moves down", () => {
    const pinned = placeAt(form(flowing), { list, index: 0 }, { row: 1, col: 1 }, 24).definition;
    const tall = placeAt(pinned, { list, index: 0 }, { rows: 2 }, 24).definition;
    expect(cellOf(tall, "a")).toEqual({ row: 1, col: 1, span: 12, rows: 2 });
    expect(cellOf(tall, "c").row).toBe(3);                    // C (full width, row 2) moved below A
    expect(tall.sections[0].fields.find(field => field.id === "a")?.layout?.row_span).toBe(2);
  });

  it("closes up empty rows", () => {
    const spread = placeAt(form(flowing), { list, index: 2 }, { row: 6, col: 1 }, 24).definition;
    expect(cellOf(spread, "c").row).toBe(6);
    expect(cellOf(compactRows(spread, list, 24), "c").row).toBe(2);
  });

  it("knows the columns of nested containers and scales block widths", () => {
    const nested = form([{ id: "g", type: "group", label: "G", columns: 6, fields: [{ id: "x", type: "text", label: "X" }] }]);
    expect(listColumns(nested, ["sections", 0, "fields", 0, "fields"], 24)).toBe(6);
    expect(listColumns(nested, list, 24)).toBe(24);
    expect(scaleSpans([{ id: "x", type: "text", label: "X", layout: { span: 6 } }], 24)[0].layout?.span).toBe(12);
  });
});
