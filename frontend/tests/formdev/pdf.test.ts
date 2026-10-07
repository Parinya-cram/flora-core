/** PDF output: the page layout (pure, measured with a fake font) and a real PDF built with pdf-lib and read back. */
import { PDFDocument } from "pdf-lib";
import { describe, expect, it } from "vitest";
import { resolvePaper } from "../../src/formdev/core/layout";
import type { FormDefinition, JsonValue } from "../../src/formdev/core/types";
import { STARTERS, starterForm } from "../../src/formdev/designer/catalog";
import { buildFormPdf } from "../../src/formdev/render/formPdf";
import { layoutPdf, MM, wrap, type Op } from "../../src/formdev/render/pdfLayout";
import { loadJson } from "./helpers";

const measure = (text: string, size: number) => [...text].length * size * 0.5;
const texts = (ops: Op[]) => ops.filter((op): op is Extract<Op, { kind: "text" }> => op.kind === "text").map(op => op.text);
const admission = starterForm(STARTERS.find(item => item.id === "admission")!, "pdf_test", "แบบประเมินแรกรับ", "th");
const context = { title: admission.title, form_id: admission.form_id, version: 1, date: "07/10/2569", record_id: "rec-1" };
const layout = (definition: FormDefinition, data: Record<string, JsonValue> = {}, extra: { hidden?: string[]; denied?: string[] } = {}) => layoutPdf({
  definition, data, paper: resolvePaper(definition), context: { ...context, title: definition.title }, hidden: new Set(extra.hidden ?? []),
  denied: new Set(extra.denied ?? []), styleColumns: 2, measure,
});

describe("PDF layout", () => {
  it("wraps by words, then by characters for Thai text without spaces", () => {
    expect(wrap("aa bb cc", 10, 20, measure)).toEqual(["aa", "bb", "cc"]);
    expect(wrap("aa bb cc", 10, 30, measure)).toEqual(["aa bb", "cc"]);
    const thai = wrap("ความดันโลหิตสูงมากผิดปกติ", 10, 40, measure);
    expect(thai.length).toBeGreaterThan(1);
    expect(thai.join("")).toBe("ความดันโลหิตสูงมากผิดปกติ");
    expect(thai.every(line => measure(line, 10) <= 40)).toBe(true);
    expect(wrap("a\n\nb", 10, 100, measure)).toEqual(["a", "", "b"]);
  });

  it("A4 portrait, every op inside the page, title, values and page number", () => {
    const result = layout(admission, { hn: "HN1", full_name: "สมชาย ใจดี", sex: "m", weight_kg: 60, height_cm: 160, bmi: 23.4 });
    expect([Math.round(result.width), Math.round(result.height)]).toEqual([595, 842]);
    const all = result.pages.flat();
    expect(texts(all)).toEqual(expect.arrayContaining(["แบบประเมินแรกรับ", "HN *", "HN1", "สมชาย ใจดี", "23.4 kg/m²", "สัญญาณชีพ"]));
    for (const op of all) {
      const [x, y] = op.kind === "line" ? [op.x1, op.y1] : [op.x, op.y];
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThanOrEqual(result.width);
      expect(y).toBeLessThanOrEqual(result.height);
    }
    expect(texts(result.pages[result.pages.length - 1])).toContain(`${result.pages.length}/${result.pages.length}`);
    // radio "sex": two marks, the chosen one on
    expect(all.filter(op => op.kind === "mark" && op.round).map(op => (op as Extract<Op, { kind: "mark" }>).on)).toEqual([true, false]);
  });

  it("places fields side by side on the grid, then wraps to the next row", () => {
    const definition: FormDefinition = { ...admission, sections: [{ id: "s", title: "S", fields: [
      { id: "a", type: "text", label: "A", layout: { span: 6 } }, { id: "b", type: "text", label: "B", layout: { span: 6 } }, { id: "c", type: "text", label: "C", layout: { span: 4, col: 9 } },
    ] }] };
    const ops = layout(definition).pages[0].filter((op): op is Extract<Op, { kind: "text" }> => op.kind === "text");
    const at = (label: string) => ops.find(op => op.text === label)!;
    expect(at("A").y).toBe(at("B").y);
    expect(at("B").x).toBeGreaterThan(at("A").x);
    expect(at("C").y).toBeGreaterThan(at("A").y);
    const contentWidth = (210 - 30) * MM;
    expect(at("C").x).toBeCloseTo(15 * MM + 8 * ((contentWidth + 3 * MM) / 12), 3);
  });

  it("leaves out hidden and denied fields, and sections with nothing left", () => {
    const all = texts(layout(admission, {}, { hidden: ["$.data.hn"], denied: ["full_name"] }).pages.flat());
    expect(all).not.toContain("HN *");
    expect(all).not.toContain("ชื่อ-นามสกุล *");
    const onlyVitals = texts(layout(admission, {}, { denied: ["recorder_name", "recorded_at", "recorder_signature"] }).pages.flat());
    expect(onlyVitals).not.toContain("ผู้บันทึก");
  });

  it("page breaks and long tables continue on new pages with the header repeated", () => {
    const meds = Array.from({ length: 80 }, (_, index) => ({ drug_name: `Drug ${index + 1}` }));
    const definition: FormDefinition = { ...admission, sections: [
      { id: "a", title: "First", fields: [{ id: "x", type: "text", label: "X" }] },
      { id: "b", title: "Second", page_break: "before", fields: [{ id: "meds", type: "repeat", label: "Meds", fields: [{ id: "drug_name", type: "text", label: "Drug" }] }] },
    ] };
    const result = layout(definition, { meds });
    expect(texts(result.pages[0])).not.toContain("Second");
    expect(texts(result.pages[1])).toContain("Second");
    expect(result.pages.length).toBeGreaterThan(2);
    const last = texts(result.pages[result.pages.length - 1]);
    expect(last).toContain("Drug");
    expect(last).toContain("Drug 80");
  });

  it("header and footer bands fill their tokens", () => {
    const definition: FormDefinition = { ...admission, paper: { size: "A4", header: { center: "{title}" }, footer: { left: "{form_id}", right: "หน้า {page}/{pages}" } } };
    const page = texts(layout(definition).pages[0]);
    expect(page).toEqual(expect.arrayContaining(["แบบประเมินแรกรับ", "pdf_test", `หน้า 1/${layout(definition).pages.length}`]));
  });

  it("landscape swaps the sheet", () => {
    const result = layout({ ...admission, paper: { size: "A4", orientation: "landscape" } });
    expect(Math.round(result.width)).toBe(842);
  });
});

describe("PDF file", () => {
  it("builds a valid A4 PDF with Thai text, marks, tables and a signature image", async () => {
    const showcase = loadJson<FormDefinition>("examples/phase1-showcase/v1.form.json");
    const png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
    const bytes = await buildFormPdf({ definition: showcase, recordId: "rec-42", printedAt: "07/10/2569", value: {
      hn: "HN0001", full_name: "สมชาย ใจดี", sex: "m", symptoms: ["fever"], weight_kg: 70.5, height_cm: 172, has_fever: true, temperature_c: 38.4,
      meds: [{ drug_name: "Paracetamol", dose: "500 mg", frequency: "tid" }], nurse_signature: { data: png, signer: "RN Somsri" },
    } });
    expect(new TextDecoder().decode(bytes.slice(0, 5))).toBe("%PDF-");
    const doc = await PDFDocument.load(bytes);
    expect(doc.getPageCount()).toBeGreaterThanOrEqual(1);
    const { width, height } = doc.getPage(0).getSize();
    expect([Math.round(width), Math.round(height)]).toEqual([595, 842]);
    expect(doc.getTitle()).toBe(showcase.title);
    expect(bytes.length).toBeLessThan(400_000);
  }, 60_000);

  it("applies roles: a role that may not see a section gets a PDF without it", async () => {
    const definition = loadJson<{ definition: FormDefinition }>("spec/fixtures/permission-cases.json").definition;
    const full = await buildFormPdf({ definition, value: { diagnosis: "flu" } });
    const limited = await buildFormPdf({ definition, value: { diagnosis: "flu" }, roles: ["clinical_admin"] });
    expect((await PDFDocument.load(full)).getPageCount()).toBeGreaterThanOrEqual(1);
    expect(limited.length).toBeLessThan(full.length);
  }, 60_000);
});
