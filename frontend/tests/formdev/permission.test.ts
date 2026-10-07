/** Phase 2.8 permissions: the TypeScript twin runs the same fixture as the Python engine, and the renderer and
 * print view apply it. */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { FormDefinition } from "../../src/formdev/core/types";
import { denied, fieldPermissions, formAllows, mask, recordAllows, type FieldGrant } from "../../src/formdev/logic/permission";
import FormPrint from "../../src/formdev/ui/FormPrint";
import FormRenderer from "../../src/formdev/ui/FormRenderer";
import { loadJson } from "./helpers";

type Case = {
  name: string; roles: string[]; is_admin: boolean; form: Record<string, boolean>; record: Record<string, boolean>;
  fields: Record<string, FieldGrant>; denied: Record<"view" | "edit" | "export", string[]>;
};
const fixture = loadJson<{ definition: FormDefinition; cases: Case[] }>("spec/fixtures/permission-cases.json");
const definition = fixture.definition;

describe("permission fixtures", () => {
  for (const testCase of fixture.cases) {
    it(testCase.name, () => {
      const { roles, is_admin: admin } = testCase;
      expect(Object.fromEntries(Object.keys(testCase.form).map(action => [action, formAllows(definition, action, roles, admin)]))).toEqual(testCase.form);
      expect(Object.fromEntries(Object.keys(testCase.record).map(action => [action, recordAllows(definition, action, roles, admin)]))).toEqual(testCase.record);
      expect(fieldPermissions(definition, roles, admin)).toEqual(testCase.fields);
      for (const action of ["view", "edit", "export"] as const) expect([...denied(definition, action, roles, admin)].sort()).toEqual(testCase.denied[action]);
    });
  }

  it("nested denials and masking match the server", () => {
    expect([...denied(definition, "view", ["clinician"], false, true)]).toEqual(["meds.cost"]);
    const data = { hn: "HN1", diagnosis: "x", _other: { diagnosis: "y", hn: "z" }, meds: [{ drug: "A", cost: 10, _other: { cost: "?" } }, { drug: "B" }] };
    expect(mask(data, new Set(["diagnosis", "meds.cost"]))).toEqual({ hn: "HN1", _other: { hn: "z" }, meds: [{ drug: "A", _other: {} }, { drug: "B" }] });
  });
});

describe("renderer and print apply permissions", () => {
  const value = { hn: "HN1", note: "n", diagnosis: "flu", hb: 12.5, meds: [{ drug: "A", cost: 5 }] };
  const render = (roles?: string[], isAdmin = false) =>
    renderToStaticMarkup(createElement(FormRenderer, { definition, value, roles, isAdmin, mode: "desktop", onChange: () => undefined }));

  it("hides what a role may not view and locks what it may not edit", () => {
    const admin = render(["clinical_admin"]);
    expect(admin).not.toContain('data-field="diagnosis"');
    expect(admin).not.toContain('data-category="labs"');
    expect(admin).not.toContain('data-section="clinical"'); // nothing in it is viewable
    expect(admin).toMatch(/data-field="note"[^]*?<textarea(?![^>]*disabled)/);
    expect(admin).toMatch(/data-field="hn"[^]*?<input[^>]*disabled/);
    const clinician = render(["clinician"]);
    expect(clinician).toContain('data-field="diagnosis"');
    expect(clinician).not.toContain('data-field="cost"');
    expect(clinician).not.toContain("Remove"); // the repeat is locked: cost is not theirs to see
    expect(render(["viewer"])).toContain('data-category="labs"');
  });

  it("no roles = designer preview, an unknown role sees a notice", () => {
    expect(render()).toContain('data-field="diagnosis"');
    expect(render(["auditor"])).toContain("You may not view this form.");
    expect(render([], true)).toContain('data-field="cost"');
  });

  it("print leaves out what a role may not view", () => {
    const paper = renderToStaticMarkup(createElement(FormPrint, { definition, value, roles: ["clinician"], printedAt: "x" }));
    expect(paper).toContain('data-field="diagnosis"');
    expect(paper).toContain("ชื่อยา");
    expect(paper).not.toContain("ราคา");
    const admin = renderToStaticMarkup(createElement(FormPrint, { definition, value, roles: ["clinical_admin"], printedAt: "x" }));
    expect(admin).not.toContain('data-field="diagnosis"');
    expect(admin).toContain("ราคา");
  });
});
