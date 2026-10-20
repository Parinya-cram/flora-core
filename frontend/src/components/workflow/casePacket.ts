import type { CaseWorkflow } from "../../api/workflowApi";
import type { CaseHead } from "../../formdev/leaf/caseData";
import { readStoredUsername } from "../../views/clinical-chart/storage";

/** A4 in PDF points (portrait). */
export const A4_PT: [number, number] = [595.28, 841.89];

/**
 * The case packet: one PDF in the workflow's `packet` order — the anesthesia report PDF (when one
 * could be produced) followed by each workflow form's PDF from Form Studio, merged with pdf-lib.
 * Every page is A4 (a page of another size is scaled to fit, keeping its orientation), each form is
 * filled from the case as on the Reports page, and the packet is numbered across all its pages.
 */
export async function buildCasePacket(input: {
  caseId: number;
  caseWorkflow: CaseWorkflow;
  /** The anesthesia report PDF, or null when it cannot be generated here. */
  reportPdf: Uint8Array | null;
  /** The case, to fill the forms' bound fields (as the Reports page prints them). */
  head?: CaseHead;
  language?: string;
  /** Documents attached to the case (scans put together on the Leaf), after the forms. */
  documents?: Array<{ title: string; bytes: Uint8Array }>;
}): Promise<{ bytes: Uint8Array; skipped: string[] }> {
  const [{ PDFDocument, StandardFonts, rgb }, { buildFormPdf }, caseData] = await Promise.all([
    import("pdf-lib"),
    import("../../formdev/render/formPdf"),
    import("../../formdev/leaf/caseData"),
  ]);
  const { caseWorkflow, reportPdf } = input;
  const packet = caseWorkflow.workflow?.packet || [];
  const out = await PDFDocument.create();
  const skipped: string[] = [];
  const fromCase = input.head ? await caseData.loadCaseData(input.head).catch(() => null) : null;

  const append = async (bytes: Uint8Array) => {
    const source = await PDFDocument.load(bytes);
    for (const index of source.getPageIndices()) {
      const original = source.getPage(index);
      const { width, height } = original.getSize();
      const a4: [number, number] = width > height ? [A4_PT[1], A4_PT[0]] : A4_PT;
      if (Math.abs(width - a4[0]) < 1 && Math.abs(height - a4[1]) < 1) {
        const [copied] = await out.copyPages(source, [index]);
        out.addPage(copied);
        continue;
      }
      // Another size (A5, Letter...): drawn on an A4 sheet, scaled to fit and centred.
      const page = out.addPage(a4);
      try {
        const embedded = await out.embedPage(original);
        const scale = Math.min(a4[0] / width, a4[1] / height);
        page.drawPage(embedded, { x: (a4[0] - width * scale) / 2, y: (a4[1] - height * scale) / 2, width: width * scale, height: height * scale });
      } catch {
        // A page with nothing on it (no content stream) cannot be embedded: it stays a blank A4 sheet.
      }
    }
  };

  for (const entry of packet) {
    if (entry.kind === "anesthesia_report") {
      if (reportPdf) await append(reportPdf);
      else skipped.push("Anesthesia record report");
      continue;
    }
    if (!caseWorkflow.forms[entry.form_id]?.definition) {
      skipped.push(entry.form_id);
      continue;
    }
    // A repeatable form prints every copy filled on the case, in order, after the form itself.
    const copies = Object.entries(caseWorkflow.forms)
      .filter(([, form]) => form.of === entry.form_id && form.record)
      .sort(([, a], [, b]) => (a.instance ?? 0) - (b.instance ?? 0))
      .map(([key]) => key);
    for (const key of [entry.form_id, ...copies]) {
      const form = caseWorkflow.forms[key];
      let value = form.record?.data || {};
      if (fromCase) value = caseData.fillFromCase(form.definition, value, fromCase).data;
      if (input.head) value = await caseData.fillTimelines(form.definition, value, input.head.caseId).catch(() => value);
      const bytes = await buildFormPdf({
        definition: form.definition,
        value,
        recordId: `${input.caseId}-${key}`,
        printedBy: readStoredUsername(),
        language: input.language,
      });
      await append(bytes);
    }
  }
  for (const attached of input.documents ?? []) {
    try {
      await append(attached.bytes);
    } catch {
      skipped.push(attached.title);
    }
  }
  if (!out.getPageCount()) throw new Error("The case packet has no pages.");
  // Numbered across the packet (each part keeps its own page numbers too), at the foot of every sheet.
  const font = await out.embedFont(StandardFonts.Helvetica);
  const pages = out.getPages();
  pages.forEach((page, index) => {
    const text = `Case packet ${index + 1}/${pages.length}`;
    const size = 6.5;
    page.drawText(text, { x: (page.getWidth() - font.widthOfTextAtSize(text, size)) / 2, y: 6, size, font, color: rgb(0.35, 0.39, 0.45) });
  });
  out.setTitle(`Case packet · ${caseWorkflow.workflow?.name || caseWorkflow.workflow?.id || ""}`.trim());
  return { bytes: await out.save(), skipped };
}
