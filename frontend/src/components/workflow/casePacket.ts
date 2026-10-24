import { getFormEntries, getFormEntry, type CaseWorkflow, type FormEntry } from "../../api/workflowApi";
import { printableEntries, slotDate } from "./formSchedule";

/** A scheduled form's completed entries in slot order (unscheduled ones last), each with its slot label. */
export async function completedEntries(caseId: number, formId: string): Promise<Array<{ entry: FormEntry; label: string }>> {
  const found = await getFormEntries(caseId, formId);
  const labels = new Map(found.slots.map(slot => [slot.slot_ts, slot.label]));
  const slotted = await Promise.all(found.slots.filter(slot => slot.status === "done" && slot.entry_id)
    .map(slot => getFormEntry(caseId, formId, slot.entry_id!).then(result => result.entry)));
  return printableEntries([...slotted.filter(Boolean), ...found.unscheduled]).map(entry => ({
    entry,
    label: entry.slot_ts != null ? labels.get(entry.slot_ts) ?? slotDate(entry.slot_ts)?.toLocaleString() ?? ""
      : `Unscheduled · ${slotDate(entry.completedAt ?? entry.updatedAt ?? null)?.toLocaleString() ?? ""}`,
  }));
}

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
    if (form.schedule) {
      // A scheduled form: every completed entry, its slot label in the title.
      const entries = await completedEntries(input.caseId, entry.form_id).catch(() => null);
      if (!entries?.length) { skipped.push(`${form.definition.title || entry.form_id} (no completed entries)`); continue; }
      for (const item of entries) {
        await append(await buildFormPdf({
          definition: { ...form.definition, title: `${form.definition.title || entry.form_id} — ${item.label}` },
          value: item.entry.data || {},
          recordId: `${input.caseId}-${entry.form_id}-${item.entry.id}`,
          language: input.language,
        }));
      }
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
