/** The hospital's name and logo set in Canopy (core/hospital.ts): a logo field with src "hospital" prints it, the
 * {hospital} token prints the name, and nothing prints until one is set. Also the report's signers. */
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import { HOSPITAL_LOGO, hospitalName, setHospitalProfile } from "../../src/formdev/core/hospital";
import { fillTemplate, printContext, resolvePaper } from "../../src/formdev/core/layout";
import type { FormDefinition } from "../../src/formdev/core/types";
import { validateDefinition } from "../../src/formdev/core/validate";
import { layoutPdf } from "../../src/formdev/render/pdfLayout";
import { DEFAULT_FONTS, DEFAULT_STYLES } from "../../src/formdev/registry/defaults";
import PrintedElement from "../../src/formdev/ui/PrintedElement";
import { reportSigners } from "../../src/views/report/pdfModel";

const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const logo = { id: "logo", type: "logo", label: "Logo", src: HOSPITAL_LOGO, height_mm: 12 } as const;
const definition = {
  format: "flora.form/1", form_id: "hospital_logo", title: "Hospital logo", schema_version: 1, style_id: DEFAULT_STYLES[0].style_id,
  paper: { size: "A4", header: { center: "{hospital}" } },
  sections: [{ id: "main", title: "Main", fields: [logo, { id: "note", type: "text", label: "Note" }] }],
} as unknown as FormDefinition;
const measure = (text: string, size: number) => [...text].length * size * 0.5;
const images = () => layoutPdf({
  definition, data: {}, paper: resolvePaper(definition, {}), context: printContext(definition, {}),
  hidden: new Set(), denied: new Set(), styleColumns: 12, measure,
}).pages.flat().filter(op => op.kind === "image");

afterEach(() => setHospitalProfile(null));

describe("the hospital's logo and name in Form Studio", () => {
  it("a logo field may use the hospital's logo instead of a picture of its own", () => {
    expect(validateDefinition(definition, DEFAULT_STYLES.map(s => s.style_id), DEFAULT_FONTS.map(f => f.font_id))).toEqual([]);
  });

  it("prints nothing until a logo is set, then the hospital's logo", () => {
    expect(images()).toEqual([]);
    expect(renderToString(createElement(PrintedElement, { field: logo, data: {} }))).not.toContain("<img");
    setHospitalProfile({ name_th: "โรงพยาบาลทดสอบ", name_en: "Test Hospital", logo: PNG });
    expect(images()).toMatchObject([{ kind: "image", data: PNG }]);
    expect(renderToString(createElement(PrintedElement, { field: logo, data: {} }))).toContain(PNG);
  });

  it("the {hospital} token prints the name in the print language, and nothing before one is set", () => {
    expect(fillTemplate("{hospital}", printContext(definition, {}))).toBe("");
    setHospitalProfile({ name_th: "โรงพยาบาลทดสอบ", name_en: "Test Hospital", logo: null });
    expect(fillTemplate("{hospital}", printContext(definition, {}))).toBe("โรงพยาบาลทดสอบ");
    expect(fillTemplate("{hospital}", printContext(definition, {}, { language: "en" }))).toBe("Test Hospital");
    setHospitalProfile({ name_th: "", name_en: "Test Hospital", logo: null });
    expect(hospitalName("th")).toBe("Test Hospital");
  });

  it("an empty profile counts as none", () => {
    setHospitalProfile({ name_th: "", name_en: "", logo: null });
    expect(hospitalName()).toBe("");
  });
});

describe("the anesthesia report's signature lines", () => {
  it("names the responsible anesthetist and the nurse anesthetist, blank when the case has none", () => {
    expect(reportSigners([
      { role: "Anesthetist Resident", name: "Dr Resident" },
      { role: "Anesthetist", name: " Dr Staff " },
      { role: "Nurse anesthetist", name: "Nurse A" },
      { role: "Surgeon", name: "Dr Surgeon" },
    ])).toEqual({ anesthetist: "Dr Staff", nurse: "Nurse A" });
    expect(reportSigners([{ role: "Anesthetist Resident", name: "Dr Resident" }])).toEqual({ anesthetist: "Dr Resident", nurse: "" });
    expect(reportSigners([])).toEqual({ anesthetist: "", nurse: "" });
  });
});
