/** Form designer model: every edit keeps a valid flora.form/1 definition; blocks are ready to use; publishing a
 * changed form gets a migration that keeps old records readable. */
import { describe, expect, it } from "vitest";
import type { FormDefinition } from "../../src/formdev/core/types";
import { validateDefinition } from "../../src/formdev/core/validate";
import { BLOCKS, PALETTE, paletteField } from "../../src/formdev/designer/catalog";
import {
  allFields, buildMigration, duplicateField, movedRef, emptyForm, fieldAt, fieldRefOfIssuePath, insertFields, moveField, patchField, placeOnGrid, removeField, slug, uniqueName, usedNames,
} from "../../src/formdev/designer/model";
import { DEFAULT_FONTS, DEFAULT_STYLES } from "../../src/formdev/registry/defaults";

const STYLES = DEFAULT_STYLES.map(row => row.style_id);
const FONTS = DEFAULT_FONTS.map(row => row.font_id);
const issues = (definition: FormDefinition) => validateDefinition(definition, STYLES, FONTS).map(item => item.code);
const blank = () => emptyForm("test_form", "แบบทดสอบ", "ส่วนที่ 1", used => paletteField("text", used, "th"));
const FIELDS = ["sections", 0, "fields"];

describe("designer model", () => {
  it("a new form is valid", () => {
    expect(issues(blank())).toEqual([]);
  });

  it("every palette type can be dropped in; a calculated field asks for its formula, a logo for its picture, a barcode for its field", () => {
    let definition = blank();
    for (const item of PALETTE.flatMap(group => group.items)) {
      definition = insertFields(definition, FIELDS, 99, [paletteField(item.type, usedNames(definition), "th")]);
    }
    // The blank form has no hn field for the barcode to show.
    expect(issues(definition).sort()).toEqual(["calculated_requires_formula", "invalid_file", "unknown_field_reference"]);
    const keys = allFields(definition).map(entry => entry.field.id);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("every ready-made block is valid on its own and next to itself", () => {
    for (const block of BLOCKS) {
      let definition = blank();
      for (let round = 0; round < 2; round += 1) {
        const built = block.build(usedNames(definition), "th");
        definition = insertFields(definition, FIELDS, 99, built.fields);
        definition = { ...definition, calculators: [...(definition.calculators ?? []), ...built.calculators] };
      }
      expect(issues(definition), block.id).toEqual([]);
    }
  });

  it("moves within a list, into a repeat, and refuses moving a container into itself", () => {
    const used = new Set<string>();
    let definition = blank();
    definition = insertFields(definition, FIELDS, 1, [paletteField("number", usedNames(definition), "en"), paletteField("repeat", usedNames(definition), "en")]);
    const ids = () => (definition.sections[0].fields).map(field => field.id);
    expect(ids()).toEqual(["text", "number", "repeat"]);
    definition = moveField(definition, { list: FIELDS, index: 0 }, FIELDS, 2);
    expect(ids()).toEqual(["number", "text", "repeat"]);
    definition = moveField(definition, { list: FIELDS, index: 0 }, [...FIELDS, 2, "fields"], 0);
    expect(ids()).toEqual(["text", "repeat"]);
    expect(definition.sections[0].fields[1].fields!.map(field => field.id)).toEqual(["number", "item"]);
    const same = moveField(definition, { list: FIELDS, index: 1 }, [...FIELDS, 1, "fields"], 0);
    expect(same).toBe(definition);
    expect(used.size).toBe(0);
    expect(issues(definition)).toEqual([]);
  });

  it("moving a field into a later group lands in that group", () => {
    let definition = blank();
    definition = insertFields(definition, FIELDS, 1, [paletteField("number", usedNames(definition), "en"), paletteField("group", usedNames(definition), "en")]);
    // text(0) number(1) group(2): move text into the group (its path says index 2 before the move)
    const target = [...FIELDS, 2, "fields"];
    definition = moveField(definition, { list: FIELDS, index: 0 }, target, 1);
    expect(definition.sections[0].fields.map(field => field.id)).toEqual(["number", "group"]);
    expect(definition.sections[0].fields[1].fields!.map(field => field.id)).toEqual(["item", "text"]);
    expect(movedRef({ list: FIELDS, index: 0 }, target, 1)).toEqual({ list: [...FIELDS, 1, "fields"], index: 1 });
  });

  it("duplicates with fresh keys and removes", () => {
    let definition = insertFields(blank(), FIELDS, 1, [paletteField("group", usedNames(blank()), "th")]);
    definition = duplicateField(definition, { list: FIELDS, index: 1 }, " (สำเนา)");
    const copy = fieldAt(definition, { list: FIELDS, index: 2 })!;
    expect(copy.label).toBe("กลุ่มช่อง (สำเนา)");
    expect(copy.id).not.toBe("group");
    expect(copy.fields![0].id).not.toBe(definition.sections[0].fields[1].fields![0].id);
    expect(issues(definition)).toEqual([]);
    definition = removeField(definition, { list: FIELDS, index: 1 });
    expect(definition.sections[0].fields.map(field => field.id)).toEqual(["text", copy.id]);
  });

  it("places on the form's own grid within bounds, per device", () => {
    const ref = { list: FIELDS, index: 0 };
    // A new form has 24 columns.
    let definition = placeOnGrid(blank(), ref, { span: 4, col: 23 });
    expect(fieldAt(definition, ref)!.layout).toEqual({ span: 4, col: 21 });
    definition = placeOnGrid(definition, ref, { span: 30, col: null });
    expect(fieldAt(definition, ref)!.layout).toEqual({ span: 24 });
    definition = placeOnGrid(definition, ref, { span: 6 }, "tablet");
    expect(fieldAt(definition, ref)!.layout).toEqual({ span: 24, responsive: { tablet: { span: 6 } } });
    expect(issues(definition)).toEqual([]);
    // A form made on 12 columns keeps them.
    const twelve = { ...blank(), layout: { type: "grid" as const, columns: 12 } };
    definition = placeOnGrid(twelve, ref, { span: 4, col: 11 });
    expect(fieldAt(definition, ref)!.layout).toEqual({ span: 4, col: 9 });
    definition = placeOnGrid(definition, ref, { span: 20, col: null });
    expect(fieldAt(definition, ref)!.layout).toEqual({ span: 12 });
    expect(issues(definition)).toEqual([]);
  });

  it("patch removes properties set to undefined or empty", () => {
    const ref = { list: FIELDS, index: 0 };
    let definition = patchField(blank(), ref, { required: true, validation: { max_length: 10 } });
    expect(fieldAt(definition, ref)).toMatchObject({ required: true, validation: { max_length: 10 } });
    definition = patchField(definition, ref, { required: undefined, validation: {} });
    expect(fieldAt(definition, ref)).toEqual({ id: "text", type: "text", label: "ข้อความสั้น" });
  });

  it("names: unique, safe identifiers even from Thai text", () => {
    const used = new Set(["hn"]);
    expect(uniqueName("hn", used)).toBe("hn_2");
    expect(uniqueName("hn", used)).toBe("hn_3");
    expect(slug("ชื่อผู้ป่วย", "form")).toBe("form");
    expect(slug("Ward Check 2026")).toBe("ward_check_2026");
    expect(slug("2026 form")).toBe("f_2026_form");
  });

  it("maps validator issue paths back to fields", () => {
    expect(fieldRefOfIssuePath("$.sections[1].categories[0].fields[2].options[1].label")).toEqual({ list: ["sections", 1, "categories", 0, "fields"], index: 2 });
    expect(fieldRefOfIssuePath("$.sections[0].fields[3].fields[1]")).toEqual({ list: ["sections", 0, "fields", 3, "fields"], index: 1 });
    expect(fieldRefOfIssuePath("$.style_id")).toBeNull();
  });
});

describe("publishing a changed form", () => {
  const v1 = (): FormDefinition => {
    const definition = blank();
    return insertFields(definition, FIELDS, 1, [
      { id: "weight", type: "decimal", label: "W", decimals: 1 }, { id: "note", type: "textarea", label: "N" }, { id: "fever", type: "text", label: "F" },
    ]);
  };

  it("renames (same id, new key), retires removed fields and converts changed kinds", () => {
    let v2 = { ...v1(), schema_version: 2 };
    v2 = patchField(v2, { list: FIELDS, index: 1 }, { key: "weight_kg" });
    v2 = removeField(v2, { list: FIELDS, index: 2 });
    v2 = patchField(v2, { list: FIELDS, index: 2 }, { type: "switch" });
    const migration = buildMigration(v1(), v2);
    expect(migration).toEqual({ from: 1, ops: [
      { op: "rename_field", from: "weight", to: "weight_kg" }, { op: "remove_field", field: "note" }, { op: "convert_type", field: "fever", to: "boolean" },
    ] });
    expect(issues({ ...v2, migration })).toEqual([]);
  });

  it("an unchanged form needs no operations", () => {
    expect(buildMigration(v1(), { ...v1(), schema_version: 2 }).ops).toEqual([]);
  });
});

describe("condition rows", async () => {
  const { conditionOf, rowsOf } = await import("../../src/formdev/designer/conditions");
  const fields: Record<string, import("../../src/formdev/core/types").FieldDefinition> = {
    fever: { id: "fever", type: "switch", label: "Fever" }, age: { id: "age", type: "integer", label: "Age" }, sex: { id: "sex", type: "radio", label: "Sex", options: [] },
  };
  const byKey = (key: string) => fields[key];

  it("typed values: yes/no, numbers, lists", () => {
    expect(conditionOf({ join: "and", rows: [{ field: "fever", operator: "equals", value: "true" }, { field: "age", operator: "gte", value: "60" }] }, byKey))
      .toEqual({ and: [{ field: "fever", operator: "equals", value: true }, { field: "age", operator: "gte", value: 60 }] });
    expect(conditionOf({ join: "or", rows: [{ field: "sex", operator: "in", value: "m, f" }] }, byKey)).toEqual({ field: "sex", operator: "in", value: ["m", "f"] });
    expect(conditionOf({ join: "and", rows: [{ field: "age", operator: "exists", value: "" }] }, byKey)).toEqual({ field: "age", operator: "exists" });
  });

  it("incomplete rows give no condition; rows round-trip; nesting is complex", () => {
    expect(conditionOf({ join: "and", rows: [{ field: "age", operator: "gt", value: "" }] }, byKey)).toBeUndefined();
    expect(conditionOf({ join: "and", rows: [] }, byKey)).toBeUndefined();
    const condition = { or: [{ field: "fever", operator: "equals" as const, value: true }, { field: "sex", operator: "in" as const, value: ["m", "f"] }] };
    expect(conditionOf(rowsOf(condition)!, byKey)).toEqual(condition);
    expect(rowsOf({ and: [{ or: [{ field: "age", operator: "exists" }] }] })).toBeNull();
  });
});

describe("starting points", async () => {
  const { STARTERS, starterForm } = await import("../../src/formdev/designer/catalog");
  for (const starter of STARTERS) {
    it(`${starter.id} is a valid form`, () => {
      const definition = starterForm(starter, "starter_form", "แบบทดสอบ", "th");
      expect(issues(definition)).toEqual([]);
    });
  }
});

describe("renaming a key", async () => {
  const { renameKey, renameInFormula } = await import("../../src/formdev/designer/model");
  const { starterForm, STARTERS } = await import("../../src/formdev/designer/catalog");

  it("updates formulas, conditions, rules, lookups and the subject field; the id stays", () => {
    let definition = starterForm(STARTERS.find(item => item.id === "admission")!, "f_test", "T", "en");
    const vitals = definition.sections[1].fields;
    const sysIndex = vitals.findIndex(field => field.id === "bp_sys");
    definition = patchField(definition, { list: ["sections", 1, "fields"], index: 0 }, { visibility: { when: { or: [{ field: "weight_kg", operator: "exists" }] } } });
    const weightRef = { list: ["sections", 1, "fields"], index: vitals.findIndex(field => field.id === "weight_kg") };
    definition = renameKey(definition, weightRef, "body_weight");
    definition = renameKey(definition, { list: ["sections", 0, "fields"], index: 0 }, "hospital_no");
    definition = renameKey(definition, { list: ["sections", 1, "fields"], index: sysIndex }, "systolic");
    expect(issues(definition)).toEqual([]);
    const text = JSON.stringify(definition).replace('"id":"weight_kg"', "");
    expect(text).not.toContain("weight_kg");
    expect(definition.calculators!.find(calc => calc.id === "bmi_calc")!.formula).toContain("body_weight");
    expect(definition.extensions!["flora.subject_field"]).toBe("hospital_no");
    expect(fieldAt(definition, weightRef)).toMatchObject({ id: "weight_kg", key: "body_weight" });
    expect(definition.sections[1].fields[sysIndex].validation!.rules![0].assert).toBe("systolic > bp_dia");
  });

  it("formula renames respect words and repeat columns", () => {
    expect(renameInFormula("SUM(meds.dose) + med + meds", "meds", "drugs")).toBe("SUM(drugs.dose) + med + drugs");
    expect(renameInFormula("(1 +", "a", "b")).toBe("(1 +");
  });
});

describe("designer screens render", async () => {
  const { createElement } = await import("react");
  const { renderToStaticMarkup } = await import("react-dom/server");
  const { default: Canvas } = await import("../../src/formdev/designer/Canvas");
  const { default: FieldInspector } = await import("../../src/formdev/designer/FieldInspector");
  const { default: ContainerInspector } = await import("../../src/formdev/designer/ContainerInspector");
  const { default: DesignerPanel } = await import("../../src/formdev/designer/DesignerPanel");
  const { STARTERS, starterForm } = await import("../../src/formdev/designer/catalog");
  const definition = starterForm(STARTERS.find(item => item.id === "admission")!, "screen_test", "แบบทดสอบ", "th");
  const noop = () => undefined;

  it("canvas shows every field as a card, with the selected card's actions", () => {
    const html = renderToStaticMarkup(createElement(Canvas, { definition, lang: "th", mode: "desktop", selection: { kind: "field", ref: { list: ["sections", 0, "fields"], index: 0 } },
      styleColumns: 2, getDrag: () => null, setDrag: noop, onSelect: noop, onDrop: noop, onResize: noop, onFieldAction: noop, onSectionAction: noop }));
    expect((html.match(/data-card/g) ?? []).length).toBe(allFields(definition).length);
    expect(html).toContain("ข้อมูลผู้ป่วย");
    expect(html).toContain('title="ทำสำเนา (Ctrl+D)"');
    // width, height and both at once (the two-dimensional grid), and each card's variable name
    for (const handle of ["cursor-ew-resize", "cursor-ns-resize", "cursor-nwse-resize"]) expect(html).toContain(handle);
    expect(html).toContain('title="ชื่อตัวแปร">hn</code>');
  });

  it("inspectors render for every field of a template and for the form and a section", () => {
    for (const { ref } of allFields(definition)) {
      const html = renderToStaticMarkup(createElement(FieldInspector, { definition, fieldRef: ref, lang: "th", lookups: [], publishedKeys: new Set(["hn"]), onChange: noop }));
      expect(html).toContain("ข้อมูลพื้นฐาน");
    }
    expect(renderToStaticMarkup(createElement(ContainerInspector, { definition, lang: "en", styles: DEFAULT_STYLES, formIdEditable: true, target: { kind: "form" }, onChange: noop }))).toContain("Form settings");
    expect(renderToStaticMarkup(createElement(ContainerInspector, { definition, lang: "th", styles: DEFAULT_STYLES, formIdEditable: false, target: { kind: "section", path: ["sections", 1] }, onChange: noop }))).toContain("สัญญาณชีพ");
  });

  it("the designer opens on its start screen", () => {
    const html = renderToStaticMarkup(createElement(DesignerPanel, { remote: {} as never, online: false, language: "th" }));
    expect(html).toContain("สร้างแบบฟอร์มใหม่");
    expect(html).toContain("แบบประเมินแรกรับ");
  });
});
