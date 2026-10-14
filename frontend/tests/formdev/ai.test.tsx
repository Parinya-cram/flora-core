/** Template library / AI form builder: client calls, the Leaf placement of a form, and Leaf's tab order. */
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { RestApiAdapter } from "../../src/formdev";
import { base64 } from "../../src/formdev/ai/files";
import { suggestedPlacement, withPlacement } from "../../src/formdev/ai/placement";
import TemplateLibrary from "../../src/formdev/ai/TemplateLibrary";
import { PLACEMENT_KEY } from "../../src/formdev/ai/types";
import { validateDefinition } from "../../src/formdev/core/validate";
import { pacuForm } from "../../src/formdev/designer/templates";
import { DEFAULT_FONTS, DEFAULT_STYLES } from "../../src/formdev/registry/defaults";
import { orderCaseTabs, type WorkflowFormTab } from "../../src/components/workflow/caseWorkflow";

type Call = { url: string; method: string; body: unknown; signal: AbortSignal | null };

function recording(body: unknown, calls: Call[]) {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : undefined, signal: init?.signal ?? null });
    return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
}

const tab = (formId: string, afterSection: string | null): WorkflowFormTab => ({ formId, title: formId, required: false, phase: "any", afterSection, hint: "" });

describe("AI builder and template library: client", () => {
  it("sends documents to /ai/generate and template changes to /templates", async () => {
    const calls: Call[] = [];
    const api = new RestApiAdapter({ baseUrl: "http://canopy.local", fetch: recording({ template: {}, issues: [] }, calls) });
    await api.aiGenerate({ files: [{ name: "pacu.pdf", data: "JVBERi0=" }], instructions: "bilingual", form_id: "pacu_record" });
    await api.updateTemplate("pacu_record", { version: 3, status: "reviewed" });
    await api.formFromTemplate("pacu_record", "pacu_v2", "PACU");
    expect(calls.map(call => `${call.method} ${new URL(call.url).pathname}`)).toEqual([
      "POST /api/formdev/ai/generate", "PUT /api/formdev/templates/pacu_record", "POST /api/formdev/templates/pacu_record/forms"]);
    expect(calls[0].body).toEqual({ files: [{ name: "pacu.pdf", data: "JVBERi0=" }], instructions: "bilingual", form_id: "pacu_record" });
    expect(calls[2].body).toEqual({ form_id: "pacu_v2", title: "PACU" });
  });

  it("encodes large files to base64 in chunks", () => {
    const bytes = new Uint8Array(200_000).map((_, index) => index % 251);
    const decoded = Uint8Array.from(atob(base64(bytes)), char => char.charCodeAt(0));
    expect(decoded).toEqual(bytes);
  });

  it("renders the library while it loads", () => {
    const api = new RestApiAdapter({ fetch: recording({ rows: [] }, []) });
    const html = renderToString(createElement(TemplateLibrary, { remote: api, online: true, language: "th", onEdit: () => undefined, onFormCreated: () => undefined }));
    expect(html).toContain("คลังแม่แบบ");
    expect(html).toContain("สร้างจากเอกสารด้วย AI");
  });
});

describe("Leaf placement of a form", () => {
  it("is kept in the definition's extensions and stays a valid form", () => {
    const definition = withPlacement(pacuForm("pacu_record", "PACU"), { phase: "postop", after_section: "pacu" });
    expect(definition.extensions?.[PLACEMENT_KEY]).toEqual({ phase: "postop", after_section: "pacu" });
    expect(definition.extensions?.["flora.subject_field"]).toBe("hn");
    expect(suggestedPlacement(definition)).toEqual({ phase: "postop", after_section: "pacu" });
    expect(validateDefinition(definition, DEFAULT_STYLES.map(row => row.style_id), DEFAULT_FONTS.map(row => row.font_id))).toEqual([]);
    expect(suggestedPlacement(withPlacement(definition, null))).toBeNull();
  });

  it("ignores malformed suggestions", () => {
    const definition = pacuForm("pacu_record", "PACU");
    expect(suggestedPlacement({ ...definition, extensions: { [PLACEMENT_KEY]: { phase: "later" } } })).toBeNull();
    expect(suggestedPlacement({ ...definition, extensions: { [PLACEMENT_KEY]: { phase: "preop", after_section: "nowhere" } } })).toEqual({ phase: "preop", after_section: null });
  });
});

describe("Leaf case tabs", () => {
  it("puts each workflow form right after its record tab, the rest at the end", () => {
    const order = orderCaseTabs(["caseInfo", "preop", "pacu", "outcome"], [tab("consent", "caseInfo"), tab("aldrete", "pacu"), tab("survey", null), tab("pnb_note", "pnb"), tab("pacu_extra", "pacu")]);
    expect(order.map(entry => (entry.kind === "record" ? entry.id : `form:${entry.tab.formId}`))).toEqual([
      "caseInfo", "form:consent", "preop", "pacu", "form:aldrete", "form:pacu_extra", "outcome", "form:survey", "form:pnb_note"]);
  });

  it("shows only form tabs when the case has no built-in record", () => {
    expect(orderCaseTabs([], [tab("a", "pacu"), tab("b", null)]).map(entry => entry.kind === "form" && entry.tab.formId)).toEqual(["a", "b"]);
  });
});
