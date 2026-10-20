/** The case packet: every page A4 (other sizes scaled to fit, orientation kept), numbered across the packet. */
import { inflateSync } from "node:zlib";
import { PDFDocument } from "pdf-lib";
import { describe, expect, it } from "vitest";
import { A4_PT, buildCasePacket } from "../../src/components/workflow/casePacket";
import type { CaseWorkflow } from "../../src/api/workflowApi";
import { pacuForm } from "../../src/formdev/designer/templates";

describe("case packet", () => {
  it("puts the report and the forms on A4 sheets numbered across the packet", async () => {
    const letter = await PDFDocument.create();
    letter.addPage([612, 792]).drawText("report page 1", { x: 50, y: 700 });  // a Letter report page
    letter.addPage([792, 612]).drawText("report page 2", { x: 50, y: 500 });  // a landscape one
    const a5 = { ...pacuForm("pacu_a5", "PACU A5"), paper: { size: "A5" as const } };
    const workflow = {
      workflow: { id: "wf", name: "WF", packet: [{ kind: "anesthesia_report", mode: "standard" }, { kind: "form", form_id: "pacu_a5" }, { kind: "form", form_id: "missing" }] },
      forms: { pacu_a5: { definition: a5, record: { data: { hn: "6512345" }, status: "draft" } } },
    } as unknown as CaseWorkflow;
    const { bytes, skipped } = await buildCasePacket({ caseId: 7, caseWorkflow: workflow, reportPdf: await letter.save() });
    expect(skipped).toEqual(["missing"]);
    const packet = await PDFDocument.load(bytes);
    const sizes = packet.getPages().map(page => [Math.round(page.getWidth()), Math.round(page.getHeight())]);
    expect(sizes.length).toBeGreaterThanOrEqual(3);
    for (const [width, height] of sizes) expect([width, height].sort((a, b) => a - b)).toEqual([Math.round(A4_PT[0]), Math.round(A4_PT[1])]);
    expect(sizes[1]).toEqual([Math.round(A4_PT[1]), Math.round(A4_PT[0])]);  // landscape kept
    // Content streams are deflated: inflate each and look for the packet number (Helvetica text is written as hex).
    const raw = Buffer.from(bytes).toString("latin1");
    const streams = [...raw.matchAll(/stream\r?\n([\s\S]*?)\r?\nendstream/g)].map(match => {
      try { return inflateSync(Buffer.from(match[1], "latin1")).toString("latin1"); } catch { return match[1]; }
    }).join("\n");
    const hex = (text: string) => Buffer.from(text, "latin1").toString("hex").toUpperCase();
    for (const n of [1, sizes.length]) expect(streams.includes(hex(`Case packet ${n}/${sizes.length}`)), `page ${n}`).toBe(true);
  });

  it("prints every copy of a repeatable form after the form itself", async () => {
    const form = pacuForm("pacu", "PACU");
    const workflow = {
      workflow: { id: "wf", name: "WF", packet: [{ kind: "form", form_id: "pacu" }] },
      forms: {
        "pacu~2": { definition: form, record: { data: { hn: "2" }, status: "draft" }, of: "pacu", instance: 2 },
        pacu: { definition: form, record: { data: { hn: "1" }, status: "draft" } },
      },
    } as unknown as CaseWorkflow;
    const single = await buildCasePacket({ caseId: 7, caseWorkflow: { ...workflow, forms: { pacu: workflow.forms.pacu } }, reportPdf: null });
    const both = await buildCasePacket({ caseId: 7, caseWorkflow: workflow, reportPdf: null });
    const pages = async (bytes: Uint8Array) => (await PDFDocument.load(bytes)).getPageCount();
    expect(await pages(both.bytes)).toBe(2 * await pages(single.bytes));
  });
});
