/** Phase 2 logic engine: the formula language runs the same fixtures as the Python engine. */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { FormDefinition } from "../../src/formdev/core/types";
import { describePath, fieldMap, validateRecord } from "../../src/formdev/core/validate";
import FormPrint from "../../src/formdev/ui/FormPrint";
import FormRenderer from "../../src/formdev/ui/FormRenderer";
import { CALCULATOR_TEMPLATES } from "../../src/formdev/registry/defaults";
import { instantiateTemplate } from "../../src/formdev/logic/calculators";
import { applyOutput, evaluateRecord } from "../../src/formdev/logic/evaluate";
import { check, FormulaError, parse, references, rename, run } from "../../src/formdev/logic/formula";
import { loadJson } from "./helpers";

type FormulaCase = { name: string; formula: string; values: Record<string, unknown>; value?: unknown; error?: string; position?: number };
const fixture = loadJson<{ today: string; cases: FormulaCase[] }>("spec/fixtures/formula-cases.json");

describe("formula fixtures", () => {
  for (const testCase of fixture.cases) {
    it(testCase.name, () => {
      if (testCase.error) {
        let caught: unknown;
        try {
          run(testCase.formula, testCase.values, fixture.today);
        } catch (error) {
          caught = error;
        }
        expect(caught).toBeInstanceOf(FormulaError);
        expect([(caught as FormulaError).code, (caught as FormulaError).position]).toEqual([testCase.error, testCase.position]);
        return;
      }
      const got = run(testCase.formula, testCase.values, fixture.today);
      if (typeof testCase.value === "number") expect(got as number).toBeCloseTo(testCase.value, 10);
      else expect(got).toEqual(testCase.value);
    });
  }
});

describe("record logic fixtures (Phase 2.1, 2.2, 2.5, 2.6, 2.7)", () => {
  type RecordCase = { name: string; status: string; data: Record<string, unknown>; expect: { data: Record<string, unknown>; codes: string[]; paths: string[]; hidden: string[] } };
  const records = loadJson<{ definition: string; today: string; cases: RecordCase[] }>("spec/fixtures/logic-record-cases.json");
  const definition = loadJson<FormDefinition>(records.definition);
  for (const testCase of records.cases) {
    it(testCase.name, () => {
      const result = evaluateRecord(definition, testCase.data, testCase.status, records.today);
      expect(result.issues.map(item => item.code).sort()).toEqual(testCase.expect.codes);
      expect(result.issues.map(item => item.path).sort()).toEqual(testCase.expect.paths);
      expect(result.hidden).toEqual(testCase.expect.hidden);
      expect(result.data).toEqual(testCase.expect.data);
    });
  }

  it("does not modify its input", () => {
    const data = { hn: "HN1", bmi: 999, has_fever: false, temperature_c: 38 };
    evaluateRecord(definition, data, "draft", records.today);
    expect(data).toEqual({ hn: "HN1", bmi: 999, has_fever: false, temperature_c: 38 });
  });

  it("rule messages written by the designer are marked custom", () => {
    const result = evaluateRecord(definition, { hn: "HN1", bp_sys: 80, bp_dia: 90 }, "draft", records.today);
    expect(result.issues).toContainEqual({ path: "$.data.bp_sys", code: "rule_failed", message: "ความดันตัวบนต้องมากกว่าตัวล่าง", custom: true });
  });
});

describe("calculator templates (Phase 2.5)", () => {
  for (const template of CALCULATOR_TEMPLATES) {
    it(`${template.template_id} gives its examples`, () => {
      for (const example of template.examples ?? []) {
        const got = applyOutput(run(template.formula, example.values, fixture.today), (template.output ?? {}) as Record<string, unknown>);
        if (typeof example.result === "number") expect(got as number).toBeCloseTo(example.result, 10);
        else expect(got).toEqual(example.result);
      }
    });
  }

  it("instantiates into a form calculator with the form's keys", () => {
    const bmi = CALCULATOR_TEMPLATES.find(item => item.template_id === "bmi")!;
    expect(instantiateTemplate(bmi, { weight: "weight_kg", height: "height_cm" }, "bmi_calc")).toEqual({
      id: "bmi_calc", name: bmi.name, description: bmi.description, formula: "weight_kg / ((height_cm / 100) ^ 2)", output: bmi.output,
    });
    expect(rename("weight + COUNT('weight')", { weight: "w" })).toBe("w + COUNT('weight')");
    expect(() => instantiateTemplate(bmi, { weight: "weight_kg" })).toThrow(FormulaError);
  });
});

describe("live logic in the renderers", () => {
  const definition = loadJson<FormDefinition>("examples/phase2-logic/v1.form.json");
  const value = { hn: "HN1", birth_date: "1950-01-01", weight_kg: 60, height_cm: 160, has_fever: false, temperature_c: 38, symptoms: ["other"],
    _other: { symptoms: "ปวดเข่า" }, falls: [{ fall_date: "2026-09-01", injury: "yes" }, { fall_date: "2026-08-01", injury: "no" }] };
  const screen = renderToStaticMarkup(createElement(FormRenderer, { definition, value, mode: "desktop", onChange: () => undefined }));
  const paper = renderToStaticMarkup(createElement(FormPrint, { definition, value, printedAt: "06/10/2569" }));

  it("shows calculated values as the user types", () => {
    expect(screen).toMatch(/data-field="bmi"[^>]*>.*?23\.4/s);
    expect(screen).toMatch(/data-field="bmi_class"[^>]*>.*?น้ำหนักเกิน/s);
    expect(screen).toMatch(/data-field="fall_count"[^>]*>.*?>2</s);
  });

  it("hides fields whose condition is false", () => {
    expect(screen).not.toContain('data-field="temperature_c"');
    expect(screen).not.toContain('data-field="packs_per_day"');
    expect(screen.match(/data-field="injury_detail"/g)).toHaveLength(1); // only the injured fall
  });

  it("asks for the Other text and renders the repeat section", () => {
    expect(screen).toContain('value="ปวดเข่า"');
    expect(screen.match(/data-item="/g)).toHaveLength(2);
  });

  it("prints the evaluated record", () => {
    expect(paper).toContain("23.4");
    expect(paper).toContain("อื่นๆ (ระบุ): ปวดเข่า");
    expect(paper).not.toContain('data-field="temperature_c"');
    expect(paper).toContain("บาดเจ็บ");
    expect(paper).not.toContain(">yes<");
  });
});

describe("categories (Phase 2.0)", () => {
  const definition = {
    format: "flora.form/1", form_id: "vitals", schema_version: 1, title: "Vitals", paper: "A4", style_id: "form.a4.medical",
    sections: [{ id: "vitals", title: "สัญญาณชีพ", fields: [{ id: "pulse", type: "number", label: "ชีพจร" }],
      categories: [{ id: "bp", title: "ความดันโลหิต", fields: [{ id: "bp_sys", type: "number", label: "ตัวบน" }] }] }],
  } as unknown as FormDefinition;

  it("category fields share the section scope and paths name the category", () => {
    expect([...fieldMap(definition).keys()]).toEqual(["pulse", "bp_sys"]);
    expect(validateRecord(definition, { pulse: 80, bp_sys: 120 }, "submitted")).toEqual([]);
    expect(describePath(definition, "$.sections[0].categories[0].fields[0].layout")).toBe('Section "สัญญาณชีพ" › Category "ความดันโลหิต" › Field "ตัวบน" (bp_sys) › layout');
  });

  it("renders on screen and in print", () => {
    const screen = renderToStaticMarkup(createElement(FormRenderer, { definition, value: { bp_sys: 120 }, mode: "desktop", onChange: () => undefined }));
    expect(screen).toContain('data-category="bp"');
    expect(screen).toContain('data-field="bp_sys"');
    const paper = renderToStaticMarkup(createElement(FormPrint, { definition, value: { bp_sys: 120 }, printedAt: "06/10/2569" }));
    expect(paper).toContain('data-category="bp"');
    expect(paper).toContain("ความดันโลหิต");
  });
});

describe("formula analysis", () => {
  it("lists references and checks keys", () => {
    expect(references(parse("ROUND(weight_kg / ((height_cm / 100) ^ 2), 1) + SUM(meds.dose)")).map(([name]) => name)).toEqual(["weight_kg", "height_cm", "meds.dose"]);
    expect(check("weight_kg + height", key => key === "weight_kg").map(problem => [problem.code, problem.position])).toEqual([["unknown_field_reference", 13]]);
  });
});
