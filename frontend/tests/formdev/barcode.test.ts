/** Printed elements: barcode encoding (checked against hand-computed Code 128 checksums and the pattern tables), and
 * logos / barcodes in the PDF layout and on screen. */
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { resolvePaper } from "../../src/formdev/core/layout";
import type { FieldDefinition, FormDefinition, JsonValue } from "../../src/formdev/core/types";
import { validateDefinition } from "../../src/formdev/core/validate";
import { pacuForm } from "../../src/formdev/designer/templates";
import { CODE128, code128Values, encodeBarcode } from "../../src/formdev/render/barcode";
import { layoutPdf, type Op } from "../../src/formdev/render/pdfLayout";
import { DEFAULT_FONTS, DEFAULT_STYLES } from "../../src/formdev/registry/defaults";
import FormRenderer from "../../src/formdev/ui/FormRenderer";

const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const measure = (text: string, size: number) => [...text].length * size * 0.5;

describe("barcode encoding", () => {
  it("Code 128 patterns are 11 modules each", () => {
    expect(CODE128).toHaveLength(106);
    for (const pattern of CODE128) expect([...pattern].reduce((sum, width) => sum + Number(width), 0)).toBe(11);
    expect(new Set(CODE128).size).toBe(106);
  });

  it("Code 128 uses set B for text and set C for even digit runs, with the mod 103 check", () => {
    // Start B 104; A=33 B=34 C=35; (104 + 33 + 2*34 + 3*35) mod 103 = 1.
    expect(code128Values("ABC")).toEqual([104, 33, 34, 35, 1]);
    // Start C 105; 12, 34; (105 + 12 + 2*34) mod 103 = 82.
    expect(code128Values("1234")).toEqual([105, 12, 34, 82]);
    expect(code128Values("67-00123")?.[0]).toBe(104);
    expect(code128Values("ก")).toBeNull();
  });

  it("Interleaved 2 of 5 matches Flora Leaf's HN barcode: digits only, a leading 0 for an odd count", () => {
    const code = encodeBarcode("i2of5", "6512345")!;
    expect(code.text).toBe("06512345");
    expect(code.bars).toHaveLength(2 + 5 * 4 + 2);
    expect(encodeBarcode("i2of5", "65-12345")?.text).toBe("06512345");
    expect(encodeBarcode("i2of5", "")).toBeNull();
  });

  it("prints a value with letters in Code 128 rather than dropping the letters (it would scan as another HN)", () => {
    const code = encodeBarcode("i2of5", "D-HL7-001")!;
    expect(code.text).toBe("D-HL7-001");
    expect(code.bars).toHaveLength(code128Values("D-HL7-001")!.length * 3 + 4);
  });

  it("Code 39 takes capitals, digits and - . space $ / + %", () => {
    expect(encodeBarcode("code39", "an-67/1")?.text).toBe("AN-67/1");
    expect(encodeBarcode("code39", "a#b")).toBeNull();
    // * + 7 characters + * = 9 characters of 5 bars.
    expect(encodeBarcode("code39", "AN-67/1")!.bars).toHaveLength(9 * 5);
  });

  it("empty values have no barcode", () => {
    for (const symbology of ["i2of5", "code128", "code39"] as const) expect(encodeBarcode(symbology, "")).toBeNull();
    expect(encodeBarcode(undefined, null)).toBeNull();
  });
});

describe("logo and barcode on the form", () => {
  const header = (extra: FieldDefinition[]): FormDefinition => ({
    format: "flora.form/1", form_id: "head", schema_version: 1, title: "Head", paper: "A4", style_id: "form.a4.medical",
    sections: [{ id: "main", title: "Main", fields: [{ id: "hn", type: "text", label: "HN" }, ...extra] }],
  });
  const logo: FieldDefinition = { id: "logo", type: "logo", label: "Hospital logo", src: PNG, height_mm: 12, align: "right" };
  const barcode: FieldDefinition = { id: "hn_barcode", type: "barcode", label: "HN barcode", source: "hn", symbology: "code128", height_mm: 10 };
  const ops = (definition: FormDefinition, data: Record<string, JsonValue>): Op[] => layoutPdf({
    definition, data, paper: resolvePaper(definition, {}), context: { title: "Head", form_id: "head", version: 1, date: "" },
    hidden: new Set(), denied: new Set(), styleColumns: 2, measure,
  }).pages.flat();

  it("validates on both runtimes' rules", () => {
    expect(validateDefinition(header([logo, barcode]), DEFAULT_STYLES.map(s => s.style_id), DEFAULT_FONTS.map(f => f.font_id))).toEqual([]);
  });

  it("prints the logo picture and the barcode bars of the HN with its text", () => {
    const all = ops(header([logo, barcode]), { hn: "65-12345" });
    expect(all.filter(op => op.kind === "image")).toEqual([expect.objectContaining({ data: PNG, align: "right", h: expect.closeTo(12 * 72 / 25.4, 3) })]);
    const bars = all.filter(op => op.kind === "fill");
    expect(bars.length).toBe(code128Bars("65-12345"));
    expect(all.some(op => op.kind === "text" && op.text === "65-12345")).toBe(true);
    expect(all.some(op => op.kind === "text" && op.text === "HN barcode")).toBe(false);
  });

  it("prints an empty barcode as a framed blank with its label (to stick a label on)", () => {
    const all = ops(header([barcode]), {});
    expect(all.some(op => op.kind === "fill")).toBe(false);
    expect(all.some(op => op.kind === "text" && op.text === "HN barcode")).toBe(true);
  });

  it("never prints bars thinner than 0.19 mm: a field too narrow for the value prints it as text", () => {
    const MIN = 0.19 * 72 / 25.4;
    const wide = ops(header([{ ...barcode, layout: { span: 12 } }]), { hn: "6512345" }).filter(op => op.kind === "fill");
    expect(Math.min(...wide.map(op => (op as { w: number }).w))).toBeGreaterThanOrEqual(MIN - 1e-9);
    const long = "AN-2026-0000123456789-XYZ";
    const narrow = ops(header([{ ...barcode, source: "hn", layout: { span: 2 } }]), { hn: long });
    expect(narrow.some(op => op.kind === "fill")).toBe(false);
    expect(narrow.some(op => op.kind === "text" && op.text === long)).toBe(true);
    expect(narrow.some(op => op.kind === "text" && op.text.includes("too narrow"))).toBe(true);
  });

  it("the paper templates carry the HN barcode in the patient header", () => {
    const all = ops(pacuForm("pacu", "PACU"), { hn: "6512345" });
    expect(all.filter(op => op.kind === "fill").length).toBe(24);
  });

  it("shows on screen as the same bars", () => {
    const html = renderToString(createElement(FormRenderer, { definition: header([logo, barcode]), value: { hn: "65-12345" }, onChange: () => undefined }));
    expect(html).toContain(`src="${PNG}"`);
    expect(html).toContain("65-12345");
    expect((html.match(/<rect /g) ?? []).length).toBe(code128Bars("65-12345"));
  });
});

/** Bars of a Code 128 value: three per character pattern, four in the stop. */
function code128Bars(text: string): number {
  return (code128Values(text)!.length) * 3 + 4;
}
