/**
 * Form Studio → Documents: assemble scanned or PDF pages into documents (src/documents/DocumentAssembler.tsx), then
 * download one as a single PDF, or read it into a draft form watched live (ReadingView). Reading is done by tools first
 * (the PDF's own text or OCR, then the page's layout); the AI, when on, gets all of that evidence and the tools' plan,
 * and its edits are checked against the page. The document is uploaded once: reading it again uses the same upload.
 */
import { useEffect, useState } from "react";
import DocumentAssembler, { type GroupAction } from "../../documents/DocumentAssembler";
import { download, mergeClips } from "../../documents/assemble";
import type { FormDefinition } from "../core/types";
import type { RestApiAdapter } from "../data/RestApiAdapter";
import ReadingView from "./ReadingView";
import type { ReadingResult, ReadingStatus } from "./types";

type Props = { remote: RestApiAdapter; online: boolean; language: string; onOpenDraft: (definition: FormDefinition, note: string) => void };

export default function DocumentStudio({ remote, online, language, onOpenDraft }: Props) {
  const th = !language.toLowerCase().startsWith("en");
  const t = (thai: string, english: string) => (th ? thai : english);
  const [status, setStatus] = useState<ReadingStatus | null>(null);
  const [useAi, setUseAi] = useState(true);
  const [reading, setReading] = useState<{ jobId: string; pdf: Uint8Array; name: string; upload: string } | null>(null);
  const [error, setError] = useState("");
  const [note, setNote] = useState("");

  useEffect(() => {
    if (!online) return;
    void remote.readingStatus().then(setStatus).catch(() => setStatus(null));
  }, [remote, online]);

  const actions: GroupAction[] = [
    { id: "download", label: t("ดาวน์โหลด PDF รวม", "Download as one PDF"), run: async (group, clips, sources) => {
      download(await mergeClips(clips, sources, group.name), group.name || "document");
    } },
    { id: "read", label: t("อ่านเป็นฟอร์ม", "Read into a form"), primary: true, disabled: !online || !status, run: async (group, clips, sources) => {
      setError("");
      try {
        const pdf = await mergeClips(clips, sources, group.name);
        // Sent once, as it is; reading it again (e.g. with the AI on) uses the same upload.
        const { upload } = await remote.upload(new Blob([pdf as Uint8Array<ArrayBuffer>], { type: "application/pdf" }), `${group.name || "document"}.pdf`);
        const job = await remote.startReading({ upload: upload.id, ai: useAi && Boolean(status?.ai), title: group.name });
        setReading({ jobId: job.id, pdf, name: group.name, upload: upload.id });
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : String(caught));
      }
    } },
  ];

  const readAgain = async (ai: boolean) => {
    if (!reading) return;
    setError("");
    try {
      const job = await remote.startReading({ upload: reading.upload, ai, title: reading.name });
      setReading({ ...reading, jobId: job.id });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  };

  const keepTemplate = async (result: ReadingResult) => {
    await remote.createTemplate({ definition: result.definition, title: result.definition.title, origin: "import",
      description: result.usage.requests ? t("อ่านจากเอกสาร (OCR + โครงสร้าง + AI ตรวจกับหลักฐาน)", "Read from a document (OCR, layout, AI checked against the page)")
        : t("อ่านจากเอกสาร (OCR + โครงสร้าง ไม่ใช้ AI)", "Read from a document (OCR and layout, no AI)") });
    setNote(t("เก็บเป็นแม่แบบแล้ว ดูได้ที่ตัวออกแบบ → คลัง", "Kept as a template: see Designer → Library"));
  };

  const header = <div className="flex flex-wrap items-center gap-3 rounded-2xl border border-[var(--app-border)] bg-[var(--app-panel-bg)] px-4 py-3 text-sm">
    <div className="mr-auto">
      <div className="font-bold text-[var(--app-text)]">{t("ประกอบร่างเอกสาร", "Assemble documents")}</div>
      <div className="text-xs text-[var(--app-muted)]">{t("แยกหน้า → จัดกลุ่มเหมือนตัดต่อ → รวมเป็นไฟล์เดียว หรืออ่านเป็นฟอร์ม (OCR ไทย/อังกฤษและวิเคราะห์โครงสร้างในเครื่องก่อน AI ช่วยตรวจเฉพาะเมื่อเปิด และทุกข้อที่แก้ต้องตรงกับเอกสาร)",
        "Split into pages → group them like a video edit → one file, or read into a form (Thai/English OCR and layout on the server first; the AI, when on, checks with that evidence and every edit must match the page)")}</div>
    </div>
    <span className={`rounded-full border px-2 py-0.5 text-xs ${status?.ocr ? "border-emerald-500/40 text-emerald-600" : "border-amber-500/40 text-amber-600"}`}>
      OCR {status?.ocr ? t("พร้อม", "ready") : t("ไม่มี", "missing")}</span>
    <label className="flex items-center gap-1 text-xs text-[var(--app-text)]" title={status?.ai ? "" : t("ยังไม่ได้ตั้งค่า AI (Canopy → AI service)", "AI service not set up (Canopy → AI service)")}>
      <input type="checkbox" checked={useAi && Boolean(status?.ai)} disabled={!status?.ai} onChange={event => setUseAi(event.target.checked)} />
      {t("ให้ AI ช่วยตรวจและตั้งชื่อ", "AI checks and names")}{status?.model ? ` (${status.model})` : ""}
    </label>
  </div>;

  return <div className="space-y-3">
    {error ? <div role="alert" className="rounded-xl border border-rose-500/40 bg-rose-500/10 px-4 py-2 text-sm text-rose-600 dark:text-rose-300">{error}</div> : null}
    {note ? <div className="rounded-xl border border-emerald-500/40 bg-emerald-500/10 px-4 py-2 text-sm text-emerald-700 dark:text-emerald-300">{note}</div> : null}
    {reading ? <ReadingView key={reading.jobId} remote={remote} jobId={reading.jobId} pdf={reading.pdf} language={language} onClose={() => setReading(null)}
      onKeepTemplate={keepTemplate} onReadAgain={ai => void readAgain(ai)} aiAvailable={Boolean(status?.ai)}
      onOpenInDesigner={result => onOpenDraft(result.definition, t(`ร่างจากเอกสาร "${reading.name}" — ตรวจช่องสีเหลือง (ไม่แน่ใจ) และสีม่วง (AI ปรับ) ก่อนบันทึก`, `Draft from "${reading.name}" — check the amber (unsure) and violet (AI) items before saving`))} /> : null}
    <DocumentAssembler language={language} actions={actions} header={header} />
  </div>;
}
