import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { FieldDefinition, FormDefinition } from "../../src/formdev/core/types";
import { validateDefinition } from "../../src/formdev/core/validate";
import { BLOCKS } from "../../src/formdev/designer/catalog";
import FormRenderer from "../../src/formdev/ui/FormRenderer";
import { cellValue, isGridPaste, parseTsv, pasteInto } from "../../src/formdev/ui/gridPaste";

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
