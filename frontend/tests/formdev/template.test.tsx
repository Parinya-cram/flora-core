import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { PDFDocument } from "pdf-lib";
import { describe, expect, it } from "vitest";
import { matrixTotals, validateDefinition, validateRecord } from "../../src/formdev/core/validate";
import { STARTERS, starterForm } from "../../src/formdev/designer/catalog";
import { pacuForm } from "../../src/formdev/designer/templates";
import { layoutPdf } from "../../src/formdev/render/pdfLayout";
import { buildFormPdf } from "../../src/formdev/render/formPdf";
import { DEFAULT_FONTS, DEFAULT_STYLES } from "../../src/formdev/registry/defaults";
import FormRenderer from "../../src/formdev/ui/FormRenderer";
import { resolvePaper } from "../../src/formdev/core/layout";

const STYLES = DEFAULT_STYLES.map(style => style.style_id);
const FONTS = DEFAULT_FONTS.map(font => font.font_id);
const score = (...values: string[]) => Object.fromEntries(["preop", "admit", "m15", "m30", "m45", "m60", "dc"].map((col, index) => [col, values[index]]));
const RECORD = {
  hn: "HN0001", patient_name: "ทดสอบ ระบบ", weight: 59.8, gender: "female", asa_status: "3", recovery_start: "13:40",
  mass: { activity: score("2", "2", "2", "2", "2", "2", "2"), spo2: score("2", "1", "1", "1", "2", "2", "1"), pain: { admit: 5 }, sedation: { admit: "S" } },
  post_anesthetic_problems: ["no_complication"], discharge_status: "other", _other: { discharge_status: "Room air" }, continuing_care: ["airway", "vs"],
};

describe("paper templates: PACU", () => {
  const definition = pacuForm("pacu_record", "PACU");

  it("is offered as a starting point and is a valid definition", () => {
    const starter = STARTERS.find(item => item.id === "pacu")!;
    expect(starterForm(starter, "pacu_x", "PACU", "th").form_id).toBe("pacu_x");
    expect(validateDefinition(definition, STYLES, FONTS)).toEqual([]);
    expect(validateRecord(definition, RECORD, "submitted")).toEqual([]);
  });

  it("adds up the Aldrete criteria per time point (score choices count as numbers)", () => {
    const mass = definition.sections.flatMap(section => section.fields).find(field => field.id === "mass")!;
    const totals = matrixTotals(mass, RECORD.mass);
    expect(totals.total.preop).toBe(4);
    expect(totals.total.admit).toBe(3);
    expect(totals.total.m15).toBe(3);
  });

  it("prints on one A4 page with the patient header and signatures on every page", async () => {
    const bytes = await buildFormPdf({ definition, value: RECORD, recordId: "rec-1", printedAt: "07/10/2569" });
    const pdf = await PDFDocument.load(bytes);
    expect(pdf.getPageCount()).toBe(1);
    // Long content flows onto more pages, each with the header and the footer.
    const long = structuredClone(definition);
    long.sections.splice(2, 0, ...Array.from({ length: 4 }, (_, index) => ({ ...structuredClone(definition.sections[2]), id: `copy_${index}`,
      fields: definition.sections[2].fields.map(field => ({ ...field, id: `${field.id}_${index}` })) })));
    const measure = (text: string, size: number) => text.length * size * 0.5;
    const layout = layoutPdf({ definition: long, data: {}, paper: resolvePaper(long, {}), context: { title: "PACU", form_id: "pacu", version: 1, date: "" },
      hidden: new Set(), denied: new Set(), styleColumns: 2, measure });
    expect(layout.pages.length).toBeGreaterThan(1);
    for (const page of layout.pages) {
      const texts = page.filter(op => op.kind === "text").map(op => (op as { text: string }).text);
      expect(texts).toContain("PACU");
      expect(texts.some(text => text.includes("Surgeon"))).toBe(true);
    }
  });

  it("renders for data entry: boxed cells, the score table with its total, options in columns", () => {
    const html = renderToString(createElement(FormRenderer, { definition, value: RECORD, onChange: () => undefined }));
    expect(html).toContain('data-matrix="mass"');
    expect(html).toMatch(/Total<\/td>(<td[^>]*>[^<]*<\/td>)?<td[^>]*>4<\/td>/);
    expect(html.indexOf('data-section="patient_header"')).toBeLessThan(html.indexOf('data-section="recovery"'));
    expect(html.indexOf('data-section="signatures"')).toBeGreaterThan(html.indexOf('data-section="discharge"'));
    expect(html).toContain("grid-template-columns:repeat(auto-fit, minmax(max(34mm, calc(25% - 3mm)), 1fr))");
  });
});
