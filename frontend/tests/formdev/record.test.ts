/** The Leaf anesthesia record in Form Studio (leaf/record.ts): the generated catalog, ready fields bound both ways,
 * whole tabs as blocks, the print-time fill and the definition rules. */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { FormDefinition } from "../../src/formdev/core/types";
import { validateDefinition } from "../../src/formdev/core/validate";
import { BLOCKS } from "../../src/formdev/designer/catalog";
import { fillFromCase } from "../../src/formdev/leaf/caseData";
import { fieldFromRecord, RECORD_BY_KEY, RECORD_FIELDS, RECORD_TABS, recordToForm, tabFields } from "../../src/formdev/leaf/record";

const form = (fields: FormDefinition["sections"][number]["fields"]): FormDefinition => ({
  format: "flora.form/1", form_id: "record_test", schema_version: 1, title: "Record", paper: "A4", style_id: "form.a4.medical",
  layout: { type: "grid", columns: 12 }, sections: [{ id: "main", title: "Main", fields }],
});

describe("Leaf record catalog", () => {
  it("is the same list as the API's copy, every field once, in the Leaf's 14 tabs", () => {
    const api = JSON.parse(readFileSync(new URL("../../../services/flora-api/app/record_fields.json", import.meta.url), "utf8")) as { fields: unknown };
    expect(RECORD_FIELDS).toEqual(api.fields);
    expect(RECORD_FIELDS.length).toBeGreaterThan(300);
    expect(new Set(RECORD_FIELDS.map(field => field.bind)).size).toBe(RECORD_FIELDS.length);
    expect(RECORD_TABS.map(tab => tab.id)).toEqual(["caseInfo", "preop", "checklist", "ga_ett", "ga_lma", "ga_tubeless", "neuraxial", "pnb", "line",
      "comorbid", "extubation", "pacu", "pain", "outcome"]);
    expect(RECORD_BY_KEY.get("pacuAirway")).toMatchObject({ bind: "record.pacu_airway", tab: "pacu", kind: "choice", label: "Airway" });
  });
});

describe("ready fields", () => {
  it("every tab of the record added as a block is a valid form with every field bound", () => {
    const fields = RECORD_TABS.flatMap(tab => tabFields(tab.id, new Set(), "th"));
    expect(validateDefinition(form(fields))).toEqual([]);
    expect(fields.filter(field => field.type !== "heading").every(field => field.bind?.startsWith("record."))).toBe(true);
    expect(BLOCKS.filter(block => block.group === "leaf").map(block => block.id)).toEqual(RECORD_TABS.map(tab => `leaf_${tab.id}`));
  });

  it("a field takes the Leaf's kind and options", () => {
    const airway = fieldFromRecord(RECORD_BY_KEY.get("pacuAirway")!, new Set());
    expect(airway).toMatchObject({ id: "pacu_airway", type: "radio", bind: "record.pacu_airway" });
    expect(airway.options?.map(option => option.label)).toEqual(["Patent", "Requires support", "Artificial airway", "Obstructed"]);
    expect(fieldFromRecord(RECORD_BY_KEY.get("weightKg")!, new Set()).type).toBe("decimal");
    expect(fieldFromRecord(RECORD_BY_KEY.get("checklistConsent")!, new Set()).type).toBe("checkbox");
    expect(fieldFromRecord(RECORD_BY_KEY.get("anesthesiaTypes")!, new Set()).type).toBe("multiselect");
    const used = new Set(["pacu_airway"]);
    expect(fieldFromRecord(RECORD_BY_KEY.get("pacuAirway")!, used).id).toBe("pacu_airway_2");
  });

  it("a bind to a field the record does not have is reported", () => {
    const issues = validateDefinition(form([{ id: "x", type: "text", label: "X", bind: "record.no_such_field" }]));
    expect(issues.map(issue => issue.code)).toEqual(["invalid_type"]);
  });
});

describe("record values", () => {
  it("convert to the form field: options by label, Leaf dates, times, numbers; what does not fit is left out", () => {
    const airway = fieldFromRecord(RECORD_BY_KEY.get("pacuAirway")!, new Set());
    expect(recordToForm("Requires support", airway)).toBe("requires_support");
    expect(recordToForm("Sideways", airway)).toBeUndefined();
    expect(recordToForm("05/03/1977", { id: "d", type: "date", label: "D" })).toBe("1977-03-05");
    expect(recordToForm("9.05", { id: "t", type: "time", label: "T" })).toBe("09:05");
    expect(recordToForm("62,5", { id: "w", type: "decimal", label: "W" })).toBe(62.5);
    expect(recordToForm("", { id: "w", type: "decimal", label: "W" })).toBeUndefined();
  });

  it("fill a printed template from the record", () => {
    const definition = form([fieldFromRecord(RECORD_BY_KEY.get("pacuAirway")!, new Set()), fieldFromRecord(RECORD_BY_KEY.get("pacuArrivalTime")!, new Set())]);
    const filled = fillFromCase(definition, {}, { values: {}, failed: [], loadedAt: 0, record: { pacuAirway: "Patent", pacuArrivalTime: "" } });
    expect(filled.data).toEqual({ pacu_airway: "patent" });
    expect(filled.lines.map(line => line.status)).toEqual(["filled", "empty"]);
  });
});
