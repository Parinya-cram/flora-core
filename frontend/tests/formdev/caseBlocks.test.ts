/** Report components (field type case_block): the block catalog, column widths, printed rows, rows read from a case,
 * the PDF table and the designer's ready-made blocks. */
import { PDFDocument } from "pdf-lib";
import { describe, expect, it } from "vitest";
import { CASE_BLOCK_LIMITS, CASE_BLOCKS, printedRows, resolveColumns, toHundred } from "../../src/formdev/core/caseBlocks";
import { resolvePaper } from "../../src/formdev/core/layout";
import type { FieldDefinition, FormDefinition, JsonValue } from "../../src/formdev/core/types";
import { validateDefinition } from "../../src/formdev/core/validate";
import { BLOCKS, caseBlockField } from "../../src/formdev/designer/catalog";
import { blockRows, withSampleBlocks } from "../../src/formdev/leaf/caseBlocks";
import { buildFormPdfInfo } from "../../src/formdev/render/formPdf";
import { layoutPdf, MM, type Op } from "../../src/formdev/render/pdfLayout";
import { loadJson } from "./helpers";

const measure = (text: string, size: number) => [...text].length * size * 0.5;
const texts = (ops: Op[]) => ops.filter((op): op is Extract<Op, { kind: "text" }> => op.kind === "text").map(op => op.text);
const form = (...fields: FieldDefinition[]): FormDefinition => ({ format: "flora.form/1", form_id: "report_test", schema_version: 1, title: "Report", paper: "A4", style_id: "form.a4.medical",
  layout: { type: "grid", columns: 24 }, sections: [{ id: "main", title: "Main", fields }] });
const meds: FieldDefinition = { id: "meds", type: "case_block", label: "ยาที่ให้", block: "medications",
  block_columns: [{ key: "time", width: 20 }, { key: "name", width: 50 }, { key: "dose", width: 30 }], min_rows: 2, max_rows: 3 };

describe("report component catalog", () => {
  it("equals formdev/spec/case-blocks.json; every block's columns add to 100%", () => {
    const spec = loadJson<{ blocks: unknown; limits: unknown }>("spec/case-blocks.json");
    expect(CASE_BLOCKS).toEqual(spec.blocks);
    expect(CASE_BLOCK_LIMITS).toEqual(spec.limits);
    for (const block of Object.values(CASE_BLOCKS)) expect(block.columns.reduce((sum, column) => sum + column.width, 0)).toBe(100);
  });

  it("resolves the form's columns: its order and labels, widths scaled to 100, unset widths share what is left", () => {
    expect(resolveColumns(meds).map(column => [column.key, Math.round(column.width)])).toEqual([["time", 20], ["name", 50], ["dose", 30]]);
    const shared = resolveColumns({ block: "medications", block_columns: [{ key: "time", width: 20 }, { key: "name" }, { key: "dose" }] });
    expect(shared.map(column => column.width)).toEqual([20, 40, 40]);
    const scaled = resolveColumns({ block: "labs", block_columns: [{ key: "test", width: 30 }, { key: "value", width: 30, label: "ผลตรวจ" }] });
    expect(scaled.map(column => column.width)).toEqual([50, 50]);
    expect(scaled[1].label).toBe("ผลตรวจ");
    expect(resolveColumns({ block: "labs" }, "en").map(column => column.label)).toEqual(["Test", "Result", "Unit", "Range", "Taken"]);
    expect(resolveColumns({ block: "nothing" })).toEqual([]);
    expect(toHundred([1, 1, 1])).toEqual([34, 33, 33]);
    expect(toHundred([20, 30]).reduce((a, b) => a + b, 0)).toBe(100);
  });

  it("prints up to max_rows (counting the rest) and pads with ruled rows up to min_rows", () => {
    const value = { rows: [{ name: "a" }, { name: "b" }, { name: "c" }, { name: "d" }, { name: "e" }] } as unknown as JsonValue;
    expect(printedRows({ max_rows: 3 }, value)).toEqual({ rows: [{ name: "a" }, { name: "b" }, { name: "c" }], more: 2 });
    expect(printedRows({ min_rows: 3 }, { rows: [{ name: "a" }] } as unknown as JsonValue).rows).toEqual([{ name: "a" }, {}, {}]);
    expect(printedRows({}, undefined)).toEqual({ rows: [], more: 0 });
  });

  it("is a valid field on both sides' rules; bad blocks, columns and widths are reported", () => {
    expect(validateDefinition(form(meds, caseBlockField("billing", new Set(), "th")))).toEqual([]);
    const bad = validateDefinition(form({ ...meds, block_columns: [{ key: "time", width: 80 }, { key: "nope", width: 40 }] })).map(issue => issue.code).sort();
    expect(bad).toEqual(["invalid_layout", "invalid_type"]);
  });
});

describe("rows read from a Flora Leaf case", () => {
  const at = (h: number, m: number) => new Date(2026, 9, 20, h, m).getTime();
  it("turns each source into the block's columns", () => {
    expect(blockRows("diagnoses", { diagnosis: [{ diagnosis_text: "B", seq: 2 }, { diagnosis_text: "A", icd_code: "K35", seq: 1 }] }))
      .toEqual([{ no: "1", text: "A", icd: "K35" }, { no: "2", text: "B", icd: "" }]);
    const io = { events: [
      { kind: "med", item_name: "Fentanyl", event_ts: at(9, 5), dose_value: 50, dose_unit: "mcg" },
      { kind: "med", item_name: "Propofol", event_ts: at(9, 0), dose_value: 120, dose_unit: "mg" },
      { kind: "fluid", item_id: 7, item_name: "LRS", event_ts: at(9, 30), volume_ml: 500 },
      { kind: "fluid", item_id: 9, item_name: "PRC", event_ts: at(10, 0), volume_ml: 250 },
      { kind: "output", item_name: "Urine", event_ts: at(10, 30), volume_ml: 150 },
    ], runs: [{ kind: "fluid", item_id: 7, item_name: "LRS", route: "IV", started_at: at(9, 0), stopped_at: at(10, 0) }] };
    expect(blockRows("medications", { io })).toEqual([{ time: "09:00", name: "Propofol", dose: "120 mg", note: "" }, { time: "09:05", name: "Fentanyl", dose: "50 mcg", note: "" }]);
    expect(blockRows("fluids", { io })).toEqual([{ start: "09:00", stop: "10:00", name: "LRS", route: "IV", volume: "500" }, { start: "10:00", stop: "", name: "PRC", route: "", volume: "250" }]);
    expect(blockRows("outputs", { io })).toEqual([{ time: "10:30", name: "Urine", volume: "150" }]);
    expect(blockRows("labs", { labs: [{ test_name: "Hb", value_text: "10", collected_at: at(8, 0) }, { test_name: "Hb", value_text: "12", unit: "g/dL", collected_at: at(9, 0) }] }))
      .toEqual([{ test: "Hb", value: "12", unit: "g/dL", range: "", time: "20/10 09:00" }]);
    expect(blockRows("billing", { billing: { items: [{ item_code: "A1", name: "GA", qty: 1, unit: "case", amount: 1500 }] } }))
      .toEqual([{ code: "A1", name: "GA", qty: "1", unit: "case", amount: "1,500" }]);
    expect(blockRows("scores", { scores: { definitions: [{ id: "aldrete", name: "Aldrete" }], rows: [{ score_id: "aldrete", ts: at(11, 0), total: 9, band: "Ready" }] } }))
      .toEqual([{ time: "11:00", name: "Aldrete", total: "9", band: "Ready" }]);
    expect(blockRows("events", { events: [{ event_type: "note", title: "x", event_ts: 1 }, { title: "Start anesthesia", event_ts: at(9, 0) }] }))
      .toEqual([{ time: "09:00", title: "Start anesthesia", detail: "" }]);
  });

  it("the designer preview gets sample rows; rows already there stay", () => {
    const definition = form(meds);
    expect((withSampleBlocks(definition, {}).meds as { source: string }).source).toBe("sample");
    const own = { meds: { rows: [{ name: "x" }] } } as unknown as Record<string, JsonValue>;
    expect(withSampleBlocks(definition, own).meds).toBe(own.meds);
  });
});

describe("printed report components", () => {
  it("a bordered table at the form's column widths with the case's rows and a count of what did not fit", () => {
    const definition = form(meds);
    const value = { rows: [{ time: "09:00", name: "Propofol", dose: "120 mg" }, { time: "09:05", name: "Fentanyl" }, { name: "Rocuronium" }, { name: "Sugammadex" }] };
    const result = layoutPdf({ definition, data: { meds: value as unknown as JsonValue }, paper: resolvePaper(definition), context: { title: "Report", form_id: "report_test", version: 1 },
      hidden: new Set(), denied: new Set(), styleColumns: 2, measure });
    const ops = result.pages.flat();
    const words = texts(ops);
    expect(words).toEqual(expect.arrayContaining(["ยาที่ให้", "เวลา", "ยา", "ขนาด", "Propofol", "120 mg", "Rocuronium", "อีก 1 รายการไม่ได้พิมพ์"]));
    expect(words).not.toContain("Sugammadex");
    // Header cells: 20% / 50% / 30% of the content width.
    const header = ops.filter((op): op is Extract<Op, { kind: "rect" }> => op.kind === "rect" && op.fill === true);
    const width = (210 - 30) * MM;
    expect(header.map(cell => cell.w / width).map(share => Math.round(share * 100))).toEqual([20, 50, 30]);
    // 1 header + 3 rows (max_rows), 3 cells each.
    expect(ops.filter(op => op.kind === "rect").length).toBe(12);
  });

  it("a real PDF keeps the rows through the record's evaluation and says how many pages it took", async () => {
    const definition = form(meds);
    const built = await buildFormPdfInfo({ definition, value: { meds: { rows: [{ time: "09:00", name: "Propofol", dose: "120 mg" }] } as unknown as JsonValue } });
    expect(built.pages).toBe(1);
    expect(built.scale).toBe(1);
    const pdf = await PDFDocument.load(built.bytes);
    expect(pdf.getPageCount()).toBe(1);
  });

  it("the palette offers one ready-made table per block, each a valid full-width field", () => {
    const reports = BLOCKS.filter(block => block.group === "report");
    expect(reports.map(block => block.id)).toEqual(Object.keys(CASE_BLOCKS).map(id => `case_${id}`));
    const built = reports.map(block => block.build(new Set(), "en").fields[0]);
    expect(built.every(field => field.type === "case_block" && field.layout?.span === 12 && field.min_rows === 3)).toBe(true);
    expect(validateDefinition({ ...form(...built), layout: { type: "grid", columns: 12 } })).toEqual([]);
  });
});
