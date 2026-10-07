/** Phase 1: field registry, keys, display policy, layout, A4 print, styles, fonts, readable errors and both renderers. */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { COMMON_CONTAINER_PROPS, COMMON_PROPS, FIELD_TYPE_SPECS, INDEX_FAMILY, QUERY_FAMILY, STYLE_COMPONENTS, STYLE_TOKENS } from "../../src/formdev/core/fieldTypes";
import { FontRegistry, normalizeFont } from "../../src/formdev/core/fonts";
import { bandContent, defaultSpan, fillTemplate, gridArea, modeForWidth, pageCss, placeField, resolvePaper, sheetsOf } from "../../src/formdev/core/layout";
import { normalizeStyle, StyleRegistry } from "../../src/formdev/core/styles";
import type { FieldDefinition, FontEntry, FormDefinition, RecordData, StyleEntry } from "../../src/formdev/core/types";
import { MESSAGES } from "../../src/formdev/core/messages";
import { describeIssues, describePath, displayed, fieldKey, fieldMap, indexEntries, issueText, parseJsonStrict, validateDefinition, validateRecord } from "../../src/formdev/core/validate";
import { DEFAULT_FONTS, DEFAULT_STYLES } from "../../src/formdev/registry/defaults";
import FormPrint from "../../src/formdev/ui/FormPrint";
import FormRenderer from "../../src/formdev/ui/FormRenderer";
import { example, fonts, loadJson, styles } from "./helpers";

const showcase = loadJson<FormDefinition>("examples/phase1-showcase/v1.form.json");
const styleIds = styles.map(style => style.style_id);
const fontIds = fonts.map(font => font.font_id);
const storedFonts: FontEntry[] = (fonts as unknown as Array<{ font_id: string; metadata: Record<string, never>; assets: never[]; fallback: never[] }>)
  .map(font => ({ font_id: font.font_id, metadata: { ...font.metadata, assets: font.assets, fallback: font.fallback } }));
const field = (key: string) => fieldMap(showcase).get(key) as FieldDefinition;

describe("registry twins", () => {
  it("field types equal formdev/spec/field-types.json", () => {
    const spec = loadJson<{ common: string[]; common_container: string[]; types: unknown }>("spec/field-types.json");
    expect([...COMMON_PROPS]).toEqual(spec.common);
    expect([...COMMON_CONTAINER_PROPS]).toEqual(spec.common_container);
    expect(FIELD_TYPE_SPECS).toEqual(spec.types);
  });

  it("style tokens equal formdev/spec/style-tokens.json", () => {
    const spec = loadJson<{ components: string[]; tokens: unknown }>("spec/style-tokens.json");
    expect([...STYLE_COMPONENTS]).toEqual(spec.components);
    expect(STYLE_TOKENS).toEqual(spec.tokens);
  });

  it("the bundled registry copy equals the registry files", () => {
    expect(DEFAULT_STYLES).toEqual(styles);
    expect(DEFAULT_FONTS).toEqual(storedFonts);
  });

  it("families come from the registry", () => {
    expect(QUERY_FAMILY.decimal).toBe("num");
    expect(INDEX_FAMILY.switch).toBe("num");
    expect(QUERY_FAMILY.group).toBeUndefined();
  });
});

describe("shared fixtures", () => {
  it("the showcase is valid", () => {
    expect(validateDefinition(showcase, styleIds, fontIds)).toEqual([]);
  });

  const records = loadJson<{ definition: string; cases: Array<{ name: string; status: string; data: unknown; codes: string[]; paths: string[] }>; index: Array<{ data: Record<string, unknown>; expected: unknown }> }>("spec/fixtures/record-cases-types.json");
  for (const testCase of records.cases) {
    it(`record: ${testCase.name}`, () => {
      const issues = validateRecord(showcase, testCase.data, testCase.status);
      expect(issues.map(item => item.code).sort()).toEqual(testCase.codes);
      expect(issues.map(item => item.path).sort()).toEqual(testCase.paths);
    });
  }
  it("index entries", () => {
    for (const testCase of records.index) expect(indexEntries(showcase, testCase.data)).toEqual(testCase.expected);
  });

  const phase1 = loadJson<{ describe: Array<{ path: string; expected: string }>; strict_json: Array<{ name: string; text: string; issues: string[] }> }>("spec/fixtures/phase1-cases.json");
  for (const testCase of phase1.describe) {
    it(`readable path ${testCase.path}`, () => expect(describePath(showcase, testCase.path)).toBe(testCase.expected));
  }
  for (const testCase of phase1.strict_json) {
    it(`strict JSON: ${testCase.name}`, () => {
      expect(parseJsonStrict(testCase.text).issues.map(item => `${item.code}:${item.path}`).sort()).toEqual(testCase.issues);
    });
  }

  it("issues carry a readable location", () => {
    const broken = structuredClone(showcase);
    broken.sections[0].fields[0].layout = { span: 30 };
    expect(describeIssues(broken, validateDefinition(broken, styleIds, fontIds)).map(item => item.location)).toEqual(['Section "ข้อมูลผู้ป่วย" › Field "HN" (hn) › layout.span']);
  });
});

describe("messages", () => {
  it("the generated catalog equals formdev/spec/messages.json", () => {
    expect(MESSAGES).toEqual(loadJson<{ messages: unknown }>("spec/messages.json").messages);
  });

  it("Thai text for Thai users, the validator's English otherwise", () => {
    const item = { code: "required", message: "'HN' is required" };
    expect(issueText(item, "th")).toBe("ต้องกรอกข้อมูลนี้");
    expect(issueText(item, "en")).toBe("'HN' is required");
    expect(issueText({ code: "not_in_catalog", message: "x" }, "th")).toBe("x");
  });

  it("the form shows Thai messages", () => {
    const issues = validateRecord(showcase, {}, "submitted");
    const html = renderToStaticMarkup(createElement(FormRenderer, { definition: showcase, value: {}, issues, language: "th", mode: "desktop", onChange: () => undefined }));
    expect(html).toContain("ต้องกรอกข้อมูลนี้");
    expect(html).not.toContain("is required");
  });
});

describe("keys and display policy", () => {
  it("data is keyed by key, which defaults to id", () => {
    expect(fieldKey({ id: "fld_001", key: "bp_sys" })).toBe("bp_sys");
    expect(fieldKey({ id: "bp_sys" })).toBe("bp_sys");
    expect(field("hn").id).toBe("fld_hn");
    expect(fieldMap(showcase).has("contact_phone")).toBe(true);
    expect(fieldMap(showcase).has("drug_name")).toBe(false);
  });

  it("display contexts", () => {
    const recorded = field("recorded_by");
    expect((["form", "table", "detail", "query", "export"] as const).map(context => displayed(recorded, context))).toEqual([false, false, false, true, true]);
    expect(displayed({ id: "x", type: "text", label: "X", hidden: true }, "export")).toBe(true);
  });
});

describe("styles", () => {
  const registry = new StyleRegistry(DEFAULT_STYLES);

  it("inherit chains run base first", () => {
    expect(registry.chain("form.a4.medical")).toEqual(["style.base", "style.a4.default", "style.a4.medical", "form.a4.medical"]);
    const medical = registry.resolve("form.a4.medical");
    expect(medical.tokens.fontSize).toBe(10);
    expect(medical.tokens.color).toBe("#1f2937");
    expect(medical.components.label.fontSize).toBe(9);
    expect(medical.components.label.fontWeight).toBe(600);
  });

  it("cascade: form -> section -> field -> instance override", () => {
    const form = registry.apply(registry.resolve("style.a4.medical"), { override: { fontSize: 10.5, label: { color: "#334155" } } });
    const section = registry.apply(form, { id: "section.header" });
    const fieldStyle = registry.apply(section, { id: "field.number.large", override: { color: "#0f766e" } });
    expect(form.tokens.fontSize).toBe(10.5);
    expect(form.components.label.color).toBe("#334155");
    expect(section.tokens.rule).toBe("card");
    expect(fieldStyle.tokens).toMatchObject({ fontSize: 16, fontWeight: 700, align: "right", color: "#0f766e", rule: "card", inputHeight: 8 });
  });

  it("official style uses TH Sarabun New at 16 pt", () => {
    expect(registry.resolve("style.a4.official").tokens).toMatchObject({ fontId: "th-sarabun-new", fontSize: 16, pageMarginLeft: 30 });
  });

  it("cycles end the chain instead of looping", () => {
    const looped = new StyleRegistry([
      { style_id: "a.one", version: 1, definition: { name: "A", category: "form", inherit: "b.two", tokens: { fontSize: 9 } } },
      { style_id: "b.two", version: 1, definition: { name: "B", category: "form", inherit: "a.one", tokens: { color: "#000000" } } },
    ] as StyleEntry[]);
    expect(looped.chain("a.one")).toEqual(["b.two", "a.one"]);
  });

  it("legacy rows read as tokens (twin of normalize_style)", () => {
    const legacy = { title: "Old", paper: "A4", margin_mm: { top: 12 }, font_id: "noto-sans-thai", base_size_pt: 10, label: { weight: 600, size_pt: 9 }, section: { rule: "solid", title_size_pt: 11 }, columns: 2 };
    expect(normalizeStyle(legacy)).toEqual({
      name: "Old", category: "form", paper: "A4", tokens: { fontId: "noto-sans-thai", fontSize: 10, columns: 2, pageMarginTop: 12, rule: "solid" },
      components: { label: { fontWeight: 600, fontSize: 9 }, section: { fontSize: 11 } },
    });
  });
});

describe("fonts", () => {
  const registry = new FontRegistry(DEFAULT_FONTS);

  it("13+1 Thai official fonts, metadata only", () => {
    expect(registry.official()).toHaveLength(14);
    expect(registry.official().every(font => font.assets.every(asset => asset.kind !== "file"))).toBe(true);
  });

  it("stacks fall back to the bundled Thai font", () => {
    expect(registry.stack("th-sarabun-new")).toBe('"TH Sarabun New", "Sarabun", "Noto Sans Thai Variable", "Noto Sans Thai", "Tahoma", sans-serif');
    expect(registry.stack("unknown")).toBe('"Noto Sans Thai Variable", "Noto Sans Thai", "Tahoma", sans-serif');
  });

  it("older stored rows still resolve", () => {
    const legacy = normalizeFont({ font_id: "inter", metadata: { family: "Inter Variable", fallback: ["Inter", "sans-serif"], source: "bundled", package: "@fontsource-variable/inter" } });
    expect(legacy.assets).toEqual([{ kind: "bundled", package: "@fontsource-variable/inter", installed: true }]);
    expect(legacy.fallback).toEqual(["Inter", "sans-serif"]);
  });
});

describe("layout engine", () => {
  it("modes by width", () => {
    expect([1280, 800, 390].map(modeForWidth)).toEqual(["desktop", "tablet", "mobile"]);
  });

  it("placements per mode", () => {
    const name = field("full_name");
    expect(placeField(name, "desktop", 12)).toEqual({ span: 6, hidden: false });
    expect(placeField(name, "tablet", 12)).toEqual({ span: 9, hidden: false });
    expect(placeField(name, "mobile", 12)).toEqual({ span: 12, hidden: false });
    const signature = field("nurse_signature");
    expect(placeField(signature, "desktop", 12)).toEqual({ span: 6, col: 7, hidden: false });
    expect(placeField(signature, "mobile", 12)).toEqual({ span: 12, col: 1, hidden: false });
    expect(gridArea(placeField(signature, "desktop", 12))).toEqual({ gridColumn: "7 / span 6" });
  });

  it("defaults follow the style's columns token; wide types take the row", () => {
    const plain: FieldDefinition = { id: "x", type: "text", label: "X" };
    expect(defaultSpan(plain, 12, 2, "desktop")).toBe(6);
    expect(defaultSpan(plain, 12, 3, "desktop")).toBe(4);
    expect(defaultSpan({ ...plain, type: "textarea" }, 12, 2, "desktop")).toBe(12);
    expect(placeField(plain, "desktop", 12, 2, "row", 4).span).toBe(3);
    expect(placeField(plain, "desktop", 12, 2, "column", 4).span).toBe(12);
  });

  it("hidden fields and responsive hiding", () => {
    expect(placeField(field("recorded_by"), "desktop", 12).hidden).toBe(true);
    expect(placeField({ id: "x", type: "text", label: "X", layout: { responsive: { print: { hidden: true } } } }, "print", 12).hidden).toBe(true);
  });
});

describe("A4", () => {
  const context = { title: "แบบบันทึก", form_id: "admission_note", version: 1, date: "06/10/2569", record_id: "R-1" };

  it("A4 is 210 x 297 mm; landscape swaps; margins come from the definition, then the style", () => {
    const portrait = resolvePaper({ paper: "A4" }, { pageMarginTop: 25 });
    expect([portrait.width_mm, portrait.height_mm, portrait.margin.top, portrait.margin.left]).toEqual([210, 297, 25, 15]);
    const landscape = resolvePaper({ paper: { size: "A4", orientation: "landscape", margin_mm: { top: 10 } } }, { pageMarginTop: 25 });
    expect([landscape.width_mm, landscape.height_mm, landscape.margin.top]).toEqual([297, 210, 10]);
  });

  it("band templates and @page rules", () => {
    expect(fillTemplate("{title} · {record_id} · {unknown}", context)).toBe("แบบบันทึก · R-1 · {unknown}");
    expect(bandContent("หน้า {page}/{pages}", context)).toBe('"หน้า " counter(page) "/" counter(pages)');
    const css = pageCss(resolvePaper(showcase, {}), context, "sans-serif");
    expect(css).toContain("size: A4 portrait; margin: 18mm 12mm 16mm 15mm;");
    expect(css).toContain('@bottom-right { content: "หน้า " counter(page) "/" counter(pages);');
    expect(css).toContain('@top-left { content: "แบบบันทึก";');
  });

  it("page_break splits sheets", () => {
    expect(sheetsOf(showcase.sections).map(sheet => sheet.map(section => section.id))).toEqual([["patient", "assessment"], ["attachments"]]);
  });
});

describe("renderers", () => {
  const value: RecordData = { hn: "HN0001", full_name: "สมชาย ใจดี", recorded_by: "u17", sex: "m", has_fever: true, meds: [{ drug_name: "Paracetamol", frequency: "tid" }, { drug_name: "Omeprazole" }] };
  const screen = (mode: "desktop" | "mobile") => renderToStaticMarkup(createElement(FormRenderer, { definition: showcase, value, mode, onChange: () => undefined }));

  it("screen: layout per mode, hidden fields left out, repeat items shown", () => {
    const desktop = screen("desktop");
    expect(desktop).toContain('data-field="full_name" data-span="6"');
    expect(desktop).not.toContain('data-field="recorded_by"');
    expect(desktop.match(/data-item="/g)).toHaveLength(2);
    expect(desktop).toContain("grid-template-columns:repeat(12, minmax(0, 1fr))");
    expect(screen("mobile")).toContain('data-field="full_name" data-span="12"');
  });

  it("screen: style cascade reaches the field", () => {
    expect(screen("desktop")).toMatch(/data-field="bmi"[^>]*>.*?font-size:16pt/s);
  });

  it("print: A4 sheets with bands, paper marks and the same display policy", () => {
    const html = renderToStaticMarkup(createElement(FormPrint, { definition: showcase, value, recordId: "R-1", printedAt: "06/10/2569" }));
    expect(html.match(/class="fd-sheet"/g)).toHaveLength(2);
    expect(html).toContain("width:210mm;min-height:297mm");
    expect(html).toContain("padding:18mm 12mm 16mm 15mm");
    expect(html).toContain("หน้า 1/2");
    expect(html).toContain("เลขที่ R-1");
    expect(html).toContain("● ชาย");
    expect(html).toContain("○ หญิง");
    expect(html).toContain("☑ มีไข้");
    expect(html).not.toContain('data-field="recorded_by"');
    expect(html).toContain("@page { size: A4 portrait;");
  });

  it("the Phase 3 example still renders", () => {
    expect(renderToStaticMarkup(createElement(FormRenderer, { definition: example(2), value: {}, mode: "desktop", onChange: () => undefined }))).toContain('data-field="hn"');
  });
});
