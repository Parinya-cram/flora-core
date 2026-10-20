/**
 * Flora Leaf → Reports → Form Studio: print a Form Studio template with this case's real data, beside (not instead
 * of) the anesthesia report. Templates come from the case's workflow and the ward's current workflows (Workflow
 * Studio); each field is filled from the case (field.bind, else its usual name — see formdev/leaf/concepts.ts),
 * timelines from Leaf's trends, and what was typed into a workflow form on Leaf wins. Nothing is written: the panel
 * only reads the case. The table shows, field by field, what came from where and what the case does not have.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getReportTemplates, type ReportTemplate } from "../../api/workflowApi";
import type { RecordData } from "../../formdev/core/types";
import { fillFromCase, fillTimelines, loadCaseData, type CaseData, type CaseHead, type FillLine } from "../../formdev/leaf/caseData";
import { CONCEPT_BY_KEY } from "../../formdev/leaf/concepts";
import { caseBlockFields, fillCaseBlocks } from "../../formdev/leaf/caseBlocks";
import { blockValue, CASE_BLOCKS, type CaseBlockId } from "../../formdev/core/caseBlocks";
import { fieldKey } from "../../formdev/core/validate";
import { DEFAULT_FONTS, DEFAULT_STYLES } from "../../formdev/registry/defaults";
import PdfPreview, { type PdfPreviewHandle } from "../../formdev/ui/PdfPreview";
import { readStoredUsername } from "../../views/clinical-chart/storage";

type Props = { head: CaseHead; language?: string };

const STATUS: Record<FillLine["status"], { th: string; en: string; tone: string }> = {
  filled: { th: "ดึงจากเคส", en: "From the case", tone: "text-emerald-700 dark:text-emerald-300" },
  kept: { th: "กรอกไว้ในฟอร์ม", en: "Typed in the form", tone: "text-sky-700 dark:text-sky-300" },
  empty: { th: "เคสยังไม่มีข้อมูลนี้", en: "Not in this case yet", tone: "text-amber-700 dark:text-amber-300" },
  unmatched: { th: "ค่าไม่ตรงกับตัวเลือกของช่อง", en: "Does not match the field's options", tone: "text-rose-700 dark:text-rose-300" },
  none: { th: "ไม่ได้เชื่อมกับข้อมูลเคส", en: "Not linked to case data", tone: "text-[var(--app-muted)]" },
};
const button = "rounded border border-gray-300 px-3 py-1.5 text-xs disabled:opacity-50 dark:border-gray-700";

export default function FormStudioReportPanel({ head, language = "th" }: Props) {
  const thai = language.toLowerCase().startsWith("th");
  const t = (th: string, en: string) => (thai ? th : en);
  const [templates, setTemplates] = useState<ReportTemplate[] | null>(null);
  const [selected, setSelected] = useState("");
  const [caseData, setCaseData] = useState<CaseData | null>(null);
  const [prepared, setPrepared] = useState<{ formId: string; data: RecordData; lines: FillLine[]; failed: string[] } | null>(null);
  const [paper, setPaper] = useState<{ pages: number; scale: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [showTable, setShowTable] = useState(false);
  const [reload, setReload] = useState(0);
  const preview = useRef<PdfPreviewHandle>(null);

  // Templates and the case's data (again on Refresh).
  useEffect(() => {
    let live = true;
    void Promise.all([getReportTemplates(head.caseId), loadCaseData(head)]).then(([found, data]) => {
      if (!live) return;
      setTemplates(found.templates);
      setCaseData(data);
      setSelected(current => (found.templates.some(item => item.form_id === current) ? current : found.templates[0]?.form_id ?? ""));
      setError("");
    }).catch(caught => { if (live) setError(caught instanceof Error ? caught.message : String(caught)); });
    return () => { live = false; };
  }, [head, reload]);

  const template = useMemo(() => templates?.find(item => item.form_id === selected) ?? null, [templates, selected]);

  // The template filled with the case (and its trends).
  const prepare = useCallback(async () => {
    if (!template || !caseData) return;
    setBusy(true);
    try {
      const filled = fillFromCase(template.definition, template.record?.data ?? {}, caseData);
      const withTrends = await fillTimelines(template.definition, filled.data, head.caseId);
      // Report components (case_block): the case's rows, read only for the blocks this template prints.
      const blocks = await fillCaseBlocks(template.definition, withTrends, head);
      const blockLines: FillLine[] = [];
      for (const field of caseBlockFields(template.definition)) {
        const spec = CASE_BLOCKS[field.block as CaseBlockId];
        const rows = blockValue(blocks.data[fieldKey(field)])?.rows.length ?? 0;
        blockLines.push({ field: fieldKey(field), label: field.label, concept: null, how: null, value: rows ? (thai ? `${rows} แถว` : `${rows} row(s)`) : "",
          status: rows ? "filled" : "empty", source: thai ? spec.th : spec.en });
      }
      setPaper(null);
      setPrepared({ formId: template.form_id, data: blocks.data, lines: [...filled.lines, ...blockLines], failed: blocks.failed });
    } finally {
      setBusy(false);
    }
  }, [template, caseData, head, thai]);
  useEffect(() => {
    const timer = setTimeout(() => void prepare(), 0);
    return () => clearTimeout(timer);
  }, [prepare]);

  const download = async () => {
    if (!template || !prepared) return;
    const { buildFormPdf, downloadPdf } = await import("../../formdev/render/formPdf");
    const bytes = await buildFormPdf({ definition: template.definition, value: prepared.data, recordId: `${head.caseId}-${template.form_id}`, printedBy: readStoredUsername(), styles: DEFAULT_STYLES, fonts: DEFAULT_FONTS, language });
    downloadPdf(bytes, `${template.form_id}-${head.hn ?? head.caseId}.pdf`);
  };

  const counts = (prepared?.lines ?? []).reduce<Record<string, number>>((acc, line) => ({ ...acc, [line.status]: (acc[line.status] ?? 0) + 1 }), {});
  const ready = template && prepared?.formId === template.form_id;

  return <section className="mb-4 space-y-3 rounded-xl border border-[var(--app-accent)]/40 bg-[var(--app-panel-bg)] p-4 shadow-sm">
    <div className="flex flex-wrap items-center gap-2">
      <div className="mr-auto">
        <div className="text-sm font-semibold">{t("แบบฟอร์มจาก Form Studio", "Form Studio templates")}</div>
        <div className="text-xs text-[var(--app-muted)]">{t("พิมพ์ด้วยข้อมูลจริงของเคสนี้ — ไม่แก้ไขข้อมูลเคสและไม่แทนรายงานเดิม", "Printed with this case's real data — nothing in the case changes, the anesthesia report stays as it is")}</div>
      </div>
      {templates?.length ? <select aria-label={t("แบบฟอร์ม", "Template")} className="rounded border border-gray-300 bg-[var(--app-control-bg)] px-2 py-1.5 text-xs dark:border-gray-700"
        value={selected} onChange={event => setSelected(event.target.value)}>
        {templates.map(item => <option key={item.form_id} value={item.form_id}>{item.title} · v{item.version}{item.source === "ward" ? t(" (วอร์ด)", " (ward)") : ""}</option>)}
      </select> : null}
      <button type="button" className={button} onClick={() => setReload(value => value + 1)} disabled={busy}>{t("ดึงข้อมูลใหม่", "Refresh data")}</button>
      <button type="button" className={button} onClick={() => preview.current?.print()} disabled={!ready || busy}>{t("พิมพ์", "Print")}</button>
      <button type="button" className={button} onClick={() => void download()} disabled={!ready || busy}>{t("ดาวน์โหลด PDF", "Download PDF")}</button>
    </div>

    {error ? <div role="alert" className="text-xs text-red-500">{error}</div> : null}
    {templates && !templates.length ? <div className="rounded border border-dashed border-[var(--app-border)] p-3 text-xs text-[var(--app-muted)]">
      {t("ยังไม่มีแบบฟอร์มสำหรับวอร์ดนี้: ใน Canopy ให้เผยแพร่แบบฟอร์มใน Form Studio → เพิ่มลงใน workflow ของ Workflow Studio (เลือก \"print from Reports only\" ถ้าไม่ต้องการแท็บกรอก) → กำหนดวอร์ดของเครื่องนี้ → เผยแพร่ แล้วรอการซิงก์ (ประมาณ 10 วินาที)",
        "No templates for this ward yet: in Canopy, publish the form in Form Studio → add it to a Workflow Studio workflow (\"print from Reports only\" for no data-entry tab) → assign this Leaf's ward → publish, then wait for the sync (about 10 s)")}
    </div> : null}
    {prepared?.failed.length ? <div className="text-xs text-amber-600 dark:text-amber-300">{t("อ่านข้อมูลตารางรายงานบางส่วนไม่ได้: ", "Some report tables could not be read: ")}{prepared.failed.join(", ")}</div> : null}
    {caseData?.failed.length ? <div className="text-xs text-amber-600 dark:text-amber-300">{t("อ่านข้อมูลบางส่วนไม่ได้: ", "Some case data could not be read: ")}{caseData.failed.join(", ")}</div> : null}

    {ready ? <>
      <div className="flex flex-wrap items-center gap-2 text-xs">
        {(["filled", "kept", "empty", "unmatched"] as const).map(status => counts[status] ? <span key={status} className={`rounded-full border border-[var(--app-border)] px-2 py-0.5 ${STATUS[status].tone}`}>
          {thai ? STATUS[status].th : STATUS[status].en} {counts[status]}</span> : null)}
        {paper ? <span className={`rounded-full border px-2 py-0.5 ${paper.pages > 1 ? "border-amber-500/50 text-amber-700 dark:text-amber-300" : "border-emerald-500/50 text-emerald-700 dark:text-emerald-300"}`}>
          📄 {paper.pages === 1 ? t("พอดี A4 1 หน้า", "Fits one A4 page") : t(`${paper.pages} หน้า`, `${paper.pages} pages`)}{paper.scale < 0.999 ? ` · ${t("ย่อ", "scaled")} ${Math.round(paper.scale * 100)}%` : ""}</span> : null}
        <button type="button" className="underline" onClick={() => setShowTable(value => !value)}>{showTable ? t("ซ่อนรายละเอียด", "Hide details") : t("ดูว่าแต่ละช่องมาจากไหน", "See where each field came from")}</button>
      </div>
      {showTable ? <div className="max-h-72 overflow-y-auto rounded border border-[var(--app-border)]">
        <table className="w-full text-left text-xs">
          <thead className="sticky top-0 bg-[var(--app-panel-bg)] text-[var(--app-muted)]"><tr>
            <th className="px-2 py-1">{t("ช่อง", "Field")}</th><th className="px-2 py-1">{t("ข้อมูลเคส", "Case datum")}</th><th className="px-2 py-1">{t("ค่า", "Value")}</th><th className="px-2 py-1">{t("ที่มา / สถานะ", "Source / status")}</th></tr></thead>
          <tbody>{prepared.lines.map(line => {
            const concept = line.concept ? CONCEPT_BY_KEY.get(line.concept) : undefined;
            return <tr key={line.field} className="border-t border-[var(--app-border)]">
              <td className="px-2 py-1">{line.label} <code className="text-[10px] text-[var(--app-muted)]">{line.field}</code></td>
              <td className="px-2 py-1">{concept ? (thai ? concept.th : concept.en) : line.concept ?? "—"}{line.how === "name" ? <span className="text-[10px] text-[var(--app-muted)]"> {t("(จากชื่อช่อง)", "(by field name)")}</span> : null}</td>
              <td className="px-2 py-1">{line.value || "—"}</td>
              <td className={`px-2 py-1 ${STATUS[line.status].tone}`}>{line.source ? `${line.source} · ` : ""}{thai ? STATUS[line.status].th : STATUS[line.status].en}</td>
            </tr>;
          })}</tbody>
        </table>
      </div> : null}
      <PdfPreview ref={preview} onInfo={info => setPaper(current => (current?.pages === info.pages && current.scale === info.scale ? current : info))} definition={template.definition} value={prepared.data} recordId={`${head.caseId}-${template.form_id}`} printedBy={readStoredUsername()} styles={DEFAULT_STYLES} fonts={DEFAULT_FONTS} language={language} />
    </> : templates?.length ? <div className="text-xs text-[var(--app-muted)]">{t("กำลังเตรียมแบบฟอร์ม…", "Preparing the form…")}</div> : null}
  </section>;
}
