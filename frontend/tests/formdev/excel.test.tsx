import { deflateRawSync } from "node:zlib";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { FieldDefinition, FormDefinition, LocalRecord } from "../../src/formdev/core/types";
import { validateDefinition } from "../../src/formdev/core/validate";
import { columnName, crc32, readCsv, readXlsx, serialToIso, writeXlsx } from "../../src/formdev/core/xlsx";
import { BLOCKS } from "../../src/formdev/designer/catalog";
import FormRenderer from "../../src/formdev/ui/FormRenderer";
import { cellValue, isGridPaste, parseTsv, pasteInto } from "../../src/formdev/ui/gridPaste";
import { dateText, importRows, matchColumns, recordSheets, sheetFields } from "../../src/formdev/ui/sheetIO";

const COLUMNS: FieldDefinition[] = [
  { id: "drug", type: "text", label: "Drug" },
  { id: "dose", type: "number", label: "Dose" },
  { id: "route", type: "select", label: "Route", options: [{ value: "po", label: "Oral" }, { value: "iv", label: "IV" }] },
  { id: "prn", type: "checkbox", label: "PRN" },
];

describe("Excel-style table entry: paste", () => {
  it("parses Excel clipboard text, quoted cells included", () => {
    expect(parseTsv("a\tb\r\nc\td\r\n")).toEqual([["a", "b"], ["c", "d"]]);
    expect(parseTsv('"two\nlines"\t"say ""hi"""\n')).toEqual([["two\nlines", 'say "hi"']]);
    expect(isGridPaste("single value")).toBe(false);
    expect(isGridPaste("single value\n")).toBe(false);
    expect(isGridPaste("a\tb")).toBe(true);
  });

  it("types cell text by field", () => {
    expect(cellValue(COLUMNS[1], "1,250.5")).toBe(1250.5);
    expect(cellValue(COLUMNS[1], "abc")).toBe("abc");
    expect(cellValue(COLUMNS[2], "IV")).toBe("iv");
    expect(cellValue(COLUMNS[3], "ใช่")).toBe(true);
    expect(cellValue(COLUMNS[3], "FALSE")).toBe(false);
    expect(cellValue(COLUMNS[0], "  ")).toBeUndefined();
  });

  it("fills rows from the focused cell, adds rows up to the limit, skips locked columns", () => {
    const items = [{ drug: "Paracetamol" }];
    const grid = parseTsv("500\tOral\tyes\n250\tIV\tno\n100\tOral\tno\n");
    const locked = (field: FieldDefinition) => field.id !== "prn";
    expect(pasteInto(items, grid, 0, 1, COLUMNS, locked, 2)).toEqual([
      { drug: "Paracetamol", dose: 500, route: "po" },
      { dose: 250, route: "iv" },
    ]);
    expect(items).toEqual([{ drug: "Paracetamol" }], "the input is not changed");
  });
});

describe("Excel-style table entry: rendering", () => {
  const form = (): FormDefinition => {
    const block = BLOCKS.find(item => item.id === "excel_table")!.build(new Set(), "en");
    return {
      format: "flora.form/1", form_id: "table_form", schema_version: 1, title: "Table", paper: "A4", style_id: "form.a4.medical",
      sections: [{ id: "main", title: "Main", fields: block.fields }],
    } as FormDefinition;
  };

  it("the ready-made block is a valid repeat shown as a table", () => {
    const definition = form();
    expect(definition.sections[0].fields?.[0]).toMatchObject({ type: "repeat", view: "table" });
    expect(validateDefinition(definition).filter(issue => issue.severity !== "warning")).toEqual([]);
  });

  it("renders one table row per item with a header per column", () => {
    const definition = form();
    const key = definition.sections[0].fields![0].id;
    const html = renderToString(createElement(FormRenderer, { definition, value: { [key]: [{ item: "Gauze", amount: 3 }, { item: "Tape" }] }, onChange: () => undefined }));
    expect(html).toContain('data-view="table"');
    expect(html.match(/data-item="/g)).toHaveLength(2);
    for (const label of ["Item", "Date", "Amount", "Note"]) expect(html).toContain(`>${label}`);
    expect(html).toContain('value="Gauze"');
  });

  it("a table with a nested group or repeat falls back to cards", () => {
    const definition = form();
    const repeat = definition.sections[0].fields![0];
    repeat.fields = [...(repeat.fields ?? []), { id: "inner", type: "group", label: "Inner", fields: [{ id: "x", type: "text", label: "X" }] }];
    const html = renderToString(createElement(FormRenderer, { definition, value: {}, onChange: () => undefined }));
    expect(html).not.toContain('data-view="table"');
  });
});

// .xlsx --------------------------------------------------------------------------------------------------

/** A zip with deflated entries, as Excel writes them. */
function deflatedZip(files: Record<string, string>): Uint8Array {
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const [name, text] of Object.entries(files)) {
    const data = Buffer.from(text, "utf8");
    const packed = deflateRawSync(data);
    const nameBytes = Buffer.from(name, "utf8");
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(8, 8);
    local.writeUInt32LE(crc32(data), 14); local.writeUInt32LE(packed.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(nameBytes.length, 26);
    parts.push(local, nameBytes, packed);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0); entry.writeUInt16LE(20, 4); entry.writeUInt16LE(20, 6); entry.writeUInt16LE(8, 10);
    entry.writeUInt32LE(crc32(data), 16); entry.writeUInt32LE(packed.length, 20); entry.writeUInt32LE(data.length, 24); entry.writeUInt16LE(nameBytes.length, 28); entry.writeUInt32LE(offset, 42);
    central.push(entry, nameBytes);
    offset += 30 + nameBytes.length + packed.length;
  }
  const size = central.reduce((total, part) => total + part.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(central.length / 2, 8); end.writeUInt16LE(central.length / 2, 10); end.writeUInt32LE(size, 12); end.writeUInt32LE(offset, 16);
  return new Uint8Array(Buffer.concat([...parts, ...central, end]));
}

describe(".xlsx", () => {
  it("writes a workbook that reads back with types, Thai text and escaping", async () => {
    const bytes = writeXlsx([
      { name: "Records", header: true, rows: [["HN", "ชื่อ", "อายุ", "แพ้ยา", "หมายเหตุ"], ["HN001", "สมชาย ใจดี", 42, true, 'a < b & "c"'], ["HN002", null, 7.5, false, ""]] },
      { name: "Records", rows: [["second sheet, same name"]] },
    ]);
    expect(String.fromCharCode(bytes[0], bytes[1])).toBe("PK");
    const sheets = await readXlsx(bytes);
    expect(sheets.map(sheet => sheet.name)).toEqual(["Records", "Records 2"]);
    expect(sheets[0].rows).toEqual([["HN", "ชื่อ", "อายุ", "แพ้ยา", "หมายเหตุ"], ["HN001", "สมชาย ใจดี", "42", "TRUE", 'a < b & "c"'], ["HN002", "", "7.5", "FALSE"]]);
  });

  it("reads what Excel writes: deflated entries, shared strings, dates, formulas, gaps", async () => {
    const ns = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
    const bytes = deflatedZip({
      "xl/workbook.xml": `<workbook ${ns}><sheets><sheet name="ข้อมูล" sheetId="1" r:id="rId7"/></sheets></workbook>`,
      "xl/_rels/workbook.xml.rels": '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId7" Type="worksheet" Target="worksheets/data.xml"/></Relationships>',
      "xl/sharedStrings.xml": '<sst><si><t>HN</t></si><si><t>Seen</t></si><si><r><t>สม</t></r><r><t xml:space="preserve">ชาย </t></r></si></sst>',
      "xl/styles.xml": '<styleSheet><numFmts><numFmt numFmtId="164" formatCode="dd/mm/yyyy hh:mm"/></numFmts><cellXfs count="3"><xf numFmtId="0"/><xf numFmtId="14"/><xf numFmtId="164"/></cellXfs></styleSheet>',
      "xl/worksheets/data.xml": `<worksheet ${ns}><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="D1" t="s"><v>2</v></c></row>`
        + '<row r="3"><c r="A3"><v>12</v></c><c r="B3" s="1"><v>45566</v></c><c r="C3" s="2"><v>45566.5</v></c><c r="D3"><f>A3*2</f><v>24</v></c></row></sheetData></worksheet>',
    });
    const [sheet] = await readXlsx(bytes);
    expect(sheet.name).toBe("ข้อมูล");
    expect(sheet.rows).toEqual([["HN", "Seen", "", "สมชาย "], [], ["12", "2024-10-01", "2024-10-01T12:00:00", "24"]]);
  });

  it("helpers", () => {
    expect([0, 25, 26, 701, 702].map(columnName)).toEqual(["A", "Z", "AA", "ZZ", "AAA"]);
    expect(serialToIso(45566)).toBe("2024-10-01");
    expect(readCsv('\uFEFFhn;name\nHN1;"a;b"\r\nHN2;"say ""hi"""\n')).toEqual([["hn", "name"], ["HN1", "a;b"], ["HN2", 'say "hi"']]);
  });
});

// Records sheet: export and import -------------------------------------------------------------------------

describe("records <-> Excel", () => {
  const definition = {
    format: "flora.form/1", form_id: "ward_check", schema_version: 1, title: "Ward check", paper: "A4", style_id: "form.a4.medical",
    sections: [{ id: "main", title: "Main", fields: [
      { id: "hn", type: "text", label: "HN" },
      { id: "seen", type: "date", label: "วันที่ตรวจ" },
      { id: "weight", type: "number", label: "น้ำหนัก", unit: "kg" },
      { id: "ward", type: "select", label: "Ward", options: [{ value: "w1", label: "อายุรกรรม" }, { value: "w2", label: "ศัลยกรรม" }] },
      { id: "fever", type: "checkbox", label: "มีไข้" },
      { id: "secret", type: "text", label: "Secret", display: { export: false } },
      { id: "meds", type: "repeat", label: "ยา", fields: [{ id: "drug", type: "text", label: "Drug" }, { id: "dose", type: "number", label: "Dose" }] },
    ] }],
  } as unknown as FormDefinition;
  const record = (id: string, data: Record<string, unknown>) => ({ record_id: id, form_id: "ward_check", schema_version: 1, status: "submitted", data, updated_at: 1_790_000_000_000 } as unknown as LocalRecord);

  it("exports a labelled sheet per form and per repeat field, choices as labels, no hidden columns", async () => {
    const records = [record("rec-1", { hn: "HN1", seen: "2026-10-01", weight: 61.5, ward: "w2", fever: true, secret: "x", meds: [{ drug: "Para", dose: 500 }, { drug: "ORS" }] })];
    const sheets = await readXlsx(writeXlsx(recordSheets(definition, records)));
    expect(sheets.map(sheet => sheet.name)).toEqual(["Ward check", "ยา"]);
    expect(sheets[0].rows[0]).toEqual(["HN", "วันที่ตรวจ", "น้ำหนัก (kg)", "Ward", "มีไข้", "record_id", "status", "updated_at"]);
    expect(sheets[0].rows[1].slice(0, 7)).toEqual(["HN1", "2026-10-01", "61.5", "ศัลยกรรม", "TRUE", "rec-1", "submitted"]);
    expect(sheets[1].rows).toEqual([["record_id", "#", "Drug", "Dose"], ["rec-1", "1", "Para", "500"], ["rec-1", "2", "ORS"]]);
  });

  it("an exported sheet imports back to the same data (round trip)", async () => {
    const data = { hn: "HN1", seen: "2026-10-01", weight: 61.5, ward: "w2", fever: true };
    const [sheet] = await readXlsx(writeXlsx(recordSheets(definition, [record("rec-1", data)])));
    const fields = sheetFields(definition, "form");
    const mapping = matchColumns(sheet.rows[0], fields);
    expect(mapping).toEqual(["hn", "seen", "weight", "ward", "fever", "record_id", "status", null]);
    expect(importRows(sheet.rows, mapping, fields)).toEqual([{ line: 2, recordId: "rec-1", status: "submitted", data }]);
  });

  it("reads Thai sheets: labels with units and asterisks, d/m/yyyy and Buddhist years, option labels, blank rows", () => {
    const fields = sheetFields(definition, "form");
    const rows = [["วันที่ตรวจ *", "HN", "น้ำหนัก (kg)", "WARD", "มีไข้", "อื่น ๆ"], ["7/10/2569", "HN2", "1,050", "อายุรกรรม", "ใช่", "?"], ["", "", "", "", "", ""], ["31/02/2026", "HN3", "", "w9", "no", ""]];
    const mapping = matchColumns(rows[0], fields);
    expect(mapping).toEqual(["seen", "hn", "weight", "ward", "fever", null]);
    expect(importRows(rows, mapping, fields)).toEqual([
      { line: 2, recordId: null, status: null, data: { seen: "2026-10-07", hn: "HN2", weight: 1050, ward: "w1", fever: true } },
      { line: 4, recordId: null, status: null, data: { seen: "31/02/2026", hn: "HN3", ward: "w9", fever: false } },
    ]);
    expect(dateText("2026-10-07T10:00")).toBe("2026-10-07");
    expect(dateText("7.10.2569")).toBe("2026-10-07");
  });
});
