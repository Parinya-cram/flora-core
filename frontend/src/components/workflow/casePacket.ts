import type { CaseWorkflow } from "../../api/workflowApi";

/**
 * The case packet: one PDF in the workflow's `packet` order — the anesthesia report PDF (when one
 * could be produced) followed by each workflow form's A4 PDF from Form Studio, merged with pdf-lib.
 */
export async function buildCasePacket(input: {
  caseId: number;
  caseWorkflow: CaseWorkflow;
  /** The anesthesia report PDF, or null when it cannot be generated here. */
  reportPdf: Uint8Array | null;
  language?: string;
}): Promise<{ bytes: Uint8Array; skipped: string[] }> {
  const [{ PDFDocument }, { buildFormPdf }] = await Promise.all([
    import("pdf-lib"),
    import("../../formdev/render/formPdf"),
  ]);
  const { caseWorkflow, reportPdf } = input;
  const packet = caseWorkflow.workflow?.packet || [];
  const out = await PDFDocument.create();
  const skipped: string[] = [];

  const append = async (bytes: Uint8Array) => {
    const source = await PDFDocument.load(bytes);
    const pages = await out.copyPages(source, source.getPageIndices());
    for (const page of pages) out.addPage(page);
  };

  for (const entry of packet) {
    if (entry.kind === "anesthesia_report") {
      if (reportPdf) await append(reportPdf);
      else skipped.push("Anesthesia record report");
      continue;
    }
    const form = caseWorkflow.forms[entry.form_id];
    if (!form?.definition) {
      skipped.push(entry.form_id);
      continue;
    }
    const bytes = await buildFormPdf({
      definition: form.definition,
      value: form.record?.data || {},
      recordId: `${input.caseId}-${entry.form_id}`,
      language: input.language,
    });
    await append(bytes);
  }
  if (!out.getPageCount()) throw new Error("The case packet has no pages.");
  out.setTitle(`Case packet · ${caseWorkflow.workflow?.name || caseWorkflow.workflow?.id || ""}`.trim());
  return { bytes: await out.save(), skipped };
}
