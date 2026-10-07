import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { paletteField } from "../../src/formdev/designer/catalog";
import FieldInspector from "../../src/formdev/designer/FieldInspector";
import { emptyForm, patchField } from "../../src/formdev/designer/model";

const FIELDS = ["sections", 0, "fields"];
const ADDRESS = { lookup_id: "thai_address", metadata: { title: "Thai address", columns: [{ name: "province" }, { name: "district" }, { name: "postcode" }] } };

describe("FieldInspector", () => {
  it("renders an auto-fill whose match was dropped (turning auto-fill on stores an empty match, which clean() removes)", () => {
    const blank = emptyForm("test_form", "Test", "Part 1", used => paletteField("text", used, "en"));
    const ref = { list: FIELDS, index: 0 };
    const definition = patchField(blank, ref, { derive: { lookup: "thai_address", column: "postcode", match: {} } });
    const field = (definition.sections[0].fields ?? [])[0];
    expect(field.derive).toEqual({ lookup: "thai_address", column: "postcode" });
    const html = renderToString(createElement(FieldInspector, { definition, fieldRef: ref, lang: "en", lookups: [ADDRESS], publishedKeys: new Set<string>(), onChange: () => undefined }));
    expect(html).toMatch(/province(<!-- -->)? =/);
  });
});
