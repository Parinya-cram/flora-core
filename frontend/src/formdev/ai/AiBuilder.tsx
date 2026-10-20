/**
 * AI form builder (Form Studio): drop the source documents, see what the server found in each one, add instructions,
 * and build. Each file is uploaded once, as it is, when it is added (the server checks it then); the build sends only
 * their ids. The result is kept as a draft template and opened for review; nothing is published from here.
 */
import { useEffect, useRef, useState, type DragEvent } from "react";
import type { RestApiAdapter } from "../data/RestApiAdapter";
import { tr, type Lang } from "../designer/catalog";
import { input, label, panel, primary, secondary, small } from "../designer/styles";
import { ACCEPT, errorMessage, sizeLabel } from "./files";
import type { AiStatus, GenerateResult, Inspection, InspectedFile, Upload } from "./types";

type Props = { remote: RestApiAdapter; lang: Lang; onBuilt: (result: GenerateResult) => void; onCancel: () => void };
/** A file added here: uploaded (and checked by the server), or the reason it could not be. */
type Entry = { key: string; file: File; upload?: Upload; report?: InspectedFile; error?: string };
const keyOf = (file: File) => `${file.name}:${file.size}:${file.lastModified}`;

const KIND: Record<string, [string, string]> = {
  pdf: ["PDF", "PDF"], image: ["รูปภาพ", "Image"], docx: ["Word", "Word"], xlsx: ["Excel", "Excel"], text: ["ข้อความ", "Text"],
  form_json: ["ฟอร์ม JSON", "Form JSON"], legacy_office: ["Office รุ่นเก่า", "Old Office"], unknown: ["ไม่รู้จัก", "Unknown"],
};
const TONE = { ok: "text-emerald-600 dark:text-emerald-300", warning: "text-amber-600 dark:text-amber-300", error: "text-rose-600 dark:text-rose-300" };
const ICON = { ok: "✓", warning: "⚠", error: "✕" };

export default function AiBuilder({ remote, lang, onBuilt, onCancel }: Props) {
  const t = (th: string, en: string) => tr(lang, th, en);
  const [status, setStatus] = useState<AiStatus | null>(null);
  const [entries, setEntries] = useState<Entry[]>([]);
  const [built, setBuilt] = useState<Inspection | null>(null);
  const [instructions, setInstructions] = useState("");
  const [title, setTitle] = useState("");
  const [formId, setFormId] = useState("");
  const [building, setBuilding] = useState<number | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [error, setError] = useState("");
  const [dragging, setDragging] = useState(false);
  const picker = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let live = true;
    void remote.aiStatus().then(value => { if (live) setStatus(value); }).catch(caught => { if (live) setError(errorMessage(caught)); });
    return () => { live = false; };
  }, [remote]);

  useEffect(() => {
    if (building === null) return;
    const timer = setInterval(() => setElapsed(Math.round((Date.now() - building) / 1000)), 1000);
    return () => clearInterval(timer);
  }, [building]);

  const update = (key: string, change: Partial<Entry>) => setEntries(current => current.map(entry => entry.key === key ? { ...entry, ...change } : entry));
  const add = (list: FileList | null) => {
    if (!list?.length) return;
    const known = new Set(entries.map(entry => entry.key));
    const fresh = Array.from(list).filter(file => !known.has(keyOf(file))).map(file => ({ key: keyOf(file), file }));
    setEntries(current => [...current, ...fresh]);
    setBuilt(null);
    setError("");
    for (const entry of fresh) {
      void remote.upload(entry.file, entry.file.name)
        .then(result => update(entry.key, { upload: result.upload, report: result.file }))
        .catch(caught => update(entry.key, { error: errorMessage(caught) }));
    }
  };
  const remove = (key: string) => {
    const gone = entries.find(entry => entry.key === key);
    const rest = entries.filter(entry => entry.key !== key);
    setEntries(rest);
    setBuilt(null);
    // The server keeps a file once per content: only drop it when no other entry is the same file.
    if (gone?.upload && !rest.some(entry => entry.upload?.id === gone.upload!.id)) void remote.removeUpload(gone.upload.id).catch(() => undefined);
  };
  const checking = entries.some(entry => !entry.report && !entry.error);
  const reports = entries.map(entry => entry.report);
  const inspection: Inspection | null = built ?? (entries.length && !checking ? {
    files: reports.filter((report): report is InspectedFile => Boolean(report)),
    ok: entries.every(entry => entry.report && entry.report.status !== "error"),
    errors: entries.filter(entry => entry.error || entry.report?.status === "error").length,
    warnings: entries.filter(entry => entry.report?.status === "warning").length,
  } : null);
  const onDrop = (event: DragEvent) => { event.preventDefault(); setDragging(false); add(event.dataTransfer.files); };

  const validId = !formId || /^[a-z][a-z0-9_]{1,63}$/.test(formId);
  const onlyForms = Boolean(inspection?.files.length) && inspection!.files.every(file => file.kind === "form_json");
  const needsAi = !onlyForms || instructions.trim() !== "";
  const blocked = !entries.length || checking || !inspection?.ok || !validId || building !== null || (needsAi && !status?.configured)
    || Boolean(status && entries.length > status.limits.files);

  const build = async () => {
    if (!status) return;
    setError("");
    setBuilding(Date.now());
    setElapsed(0);
    try {
      onBuilt(await remote.aiGenerate({ uploads: entries.map(entry => entry.upload!.id), instructions: instructions.trim() || undefined,
        form_id: formId || undefined, title: title.trim() || undefined }));
    } catch (caught) {
      setError(errorMessage(caught));
      const details = (caught as { details?: unknown }).details;
      if (details && typeof details === "object" && Array.isArray((details as Inspection).files)) setBuilt(details as Inspection);
    } finally {
      setBuilding(null);
    }
  };

  return <div className="grid gap-4 lg:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)]">
    <section className={`${panel} space-y-3 p-4`}>
      <div className="flex items-start justify-between gap-2">
        <div>
          <h2 className="text-lg font-semibold text-[var(--app-text)]">✨ {t("สร้างแบบฟอร์มด้วย AI จากเอกสาร", "Build a form from documents with AI")}</h2>
          <p className="text-xs text-[var(--app-muted)]">{t("PDF, รูปถ่าย/สแกน, Word (.docx), Excel (.xlsx), ข้อความ/CSV หรือไฟล์ .form.json — ตรวจทุกไฟล์ก่อนส่งให้ AI",
            "PDF, photos / scans, Word (.docx), Excel (.xlsx), text / CSV or a .form.json — every file is checked before the AI sees it")}</p>
        </div>
        <button type="button" className={small} onClick={onCancel}>← {t("คลังแม่แบบ", "Template library")}</button>
      </div>

      <div role="button" tabIndex={0} onClick={() => picker.current?.click()} onKeyDown={event => { if (event.key === "Enter" || event.key === " ") picker.current?.click(); }}
        onDragOver={event => { event.preventDefault(); setDragging(true); }} onDragLeave={() => setDragging(false)} onDrop={onDrop}
        className={`cursor-pointer rounded-2xl border-2 border-dashed p-6 text-center text-sm ${dragging ? "border-[var(--app-accent)] bg-[var(--app-accent)]/10" : "border-[var(--app-border)] bg-[var(--app-bg)]"}`}>
        <div className="text-3xl">📄</div>
        <div className="font-semibold text-[var(--app-text)]">{t("ลากไฟล์มาวาง หรือคลิกเพื่อเลือก", "Drop files here or click to choose")}</div>
        {status ? <div className="mt-1 text-[11px] text-[var(--app-muted)]">{t(`สูงสุด ${status.limits.files} ไฟล์ · ไฟล์ละ ${sizeLabel(status.limits.fileBytes)} · รวม ${sizeLabel(status.limits.totalBytes)} · PDF ไม่เกิน ${status.limits.pdfPages} หน้า`,
          `Up to ${status.limits.files} files · ${sizeLabel(status.limits.fileBytes)} each · ${sizeLabel(status.limits.totalBytes)} in total · PDFs up to ${status.limits.pdfPages} pages`)}</div> : null}
        <input ref={picker} type="file" multiple accept={ACCEPT} hidden onChange={event => { add(event.target.files); event.target.value = ""; }} />
      </div>

      {entries.length ? <div className="space-y-1.5" aria-live="polite">
        <div className="flex items-center justify-between text-xs font-semibold text-[var(--app-muted)]">
          <span>{t("ผลการตรวจเอกสาร", "Document check")}</span>
          {checking ? <span>{t("กำลังตรวจ…", "Checking…")}</span> : inspection ? <span className={inspection.ok ? TONE.ok : TONE.error}>
            {inspection.ok ? t(`ใช้ได้ทั้งหมด${inspection.warnings ? ` (ข้อควรระวัง ${inspection.warnings})` : ""}`, `All usable${inspection.warnings ? ` (${inspection.warnings} warning(s))` : ""}`)
              : t(`ใช้ไม่ได้ ${inspection.errors} ไฟล์`, `${inspection.errors} file(s) cannot be used`)}</span> : null}
        </div>
        {entries.map((entry, index) => {
          const { file } = entry;
          const found: InspectedFile | undefined = built?.files[index] ?? entry.report;
          return <div key={entry.key} className="rounded-xl border border-[var(--app-border)] bg-[var(--app-bg)] px-3 py-2">
            <div className="flex items-center gap-2 text-sm">
              <span className={`w-4 text-center font-bold ${found ? TONE[found.status] : entry.error ? TONE.error : "text-[var(--app-muted)]"}`}>{found ? ICON[found.status] : entry.error ? ICON.error : "…"}</span>
              <span className="min-w-0 flex-1 truncate font-semibold text-[var(--app-text)]" title={file.name}>{file.name}</span>
              <span className="shrink-0 text-[11px] text-[var(--app-muted)]">
                {found ? tr(lang, ...(KIND[found.kind] ?? KIND.unknown)) : ""}{found?.pages ? ` · ${found.pages} ${t("หน้า", "p.")}` : ""}{found?.text_chars ? ` · ${found.text_chars.toLocaleString()} ${t("ตัวอักษร", "chars")}` : ""} · {sizeLabel(file.size)}
              </span>
              <button type="button" className="text-xs text-rose-600 dark:text-rose-300" aria-label={t(`นำ ${file.name} ออก`, `Remove ${file.name}`)} onClick={() => remove(entry.key)}>✕</button>
            </div>
            {entry.error ? <div className={`ml-6 text-[11px] ${TONE.error}`}>{entry.error}</div> : !found ? <div className="ml-6 text-[11px] text-[var(--app-muted)]">{t("กำลังส่งและตรวจ…", "Uploading and checking…")}</div> : null}
            {found?.notes.map(note => <div key={note} className={`ml-6 text-[11px] ${TONE[found.status]}`}>{note}</div>)}
            {found?.issues?.length ? <div className="ml-6 text-[11px] text-amber-600 dark:text-amber-300">
              {t(`ฟอร์มมี ${found.issues.length} จุดที่ต้องแก้ — AI จะช่วยแก้ถ้าใส่คำสั่งเพิ่ม หรือแก้ในตัวออกแบบภายหลัง`, `The form has ${found.issues.length} problem(s) — the AI fixes them if you add instructions, or fix them in the designer`)}
            </div> : null}
          </div>;
        })}
      </div> : null}
    </section>

    <section className={`${panel} space-y-3 p-4`}>
      <h3 className="text-sm font-semibold text-[var(--app-text)]">{t("รายละเอียดแบบฟอร์ม", "Form details")}</h3>
      <label className="block space-y-1"><span className={label}>{t("ชื่อแบบฟอร์ม (ว่างไว้ให้ AI ตั้งตามเอกสาร)", "Title (blank: taken from the document)")}</span>
        <input className={input} value={title} maxLength={200} onChange={event => setTitle(event.target.value)} /></label>
      <label className="block space-y-1"><span className={label}>{t("รหัสแบบฟอร์ม (ไม่บังคับ)", "Form id (optional)")}</span>
        <input className={`${input} font-mono`} value={formId} placeholder="pacu_record" onChange={event => setFormId(event.target.value.toLowerCase())} />
        {!validId ? <span className="text-[11px] text-rose-600 dark:text-rose-300">{t("ใช้ a-z ตัวเลข และ _ ขึ้นต้นด้วยตัวอักษร", "Use a-z, digits and _, starting with a letter")}</span> : null}</label>
      <label className="block space-y-1"><span className={label}>{t("คำสั่งเพิ่มเติมถึง AI", "Instructions for the AI")}</span>
        <textarea className={`${input} min-h-[110px]`} value={instructions} maxLength={4000} onChange={event => setInstructions(event.target.value)}
          placeholder={t("เช่น: ใช้หัวกระดาษผู้ป่วยทุกหน้า · คะแนน Aldrete เป็นตารางตามเวลา · ตัดส่วนสำหรับเจ้าหน้าที่การเงินออก · ใช้ป้ายสองภาษา",
            "e.g. patient header on every page · Aldrete scores as a grid over time · leave out the billing part · bilingual labels")} /></label>

      <div className="rounded-xl border border-amber-500/40 bg-amber-500/10 p-3 text-xs text-amber-800 dark:text-amber-200">
        {status?.configured
          ? t(`เอกสารจะถูกส่งไปยังบริการ AI ที่ตั้งค่าไว้ (${status.model}) — ใช้แบบฟอร์มเปล่า ห้ามใช้เอกสารที่มีข้อมูลผู้ป่วยจริง`,
            `The documents are sent to the configured AI service (${status.model}) — use blank forms, never documents with real patient data`)
          : status ? t("ยังไม่ได้ตั้งค่าบริการ AI: ผู้ดูแลระบบตั้งได้ที่ Canopy → บัญชี → AI service (นำเข้าไฟล์ .form.json ได้โดยไม่ต้องใช้ AI)",
            "The AI service is not configured: an administrator sets it in Canopy → Account → AI service (.form.json files import without AI)") : "…"}
      </div>

      {error ? <div role="alert" className="rounded-xl border border-rose-500/40 bg-rose-500/10 px-3 py-2 text-sm text-rose-600 dark:text-rose-300">{error}</div> : null}

      <div className="flex flex-wrap items-center gap-2">
        <button type="button" className={primary} disabled={blocked} onClick={() => void build()}>
          {building !== null ? t(`กำลังสร้าง… ${elapsed} วินาที`, `Building… ${elapsed} s`) : needsAi ? t("✨ สร้างแบบฟอร์มด้วย AI", "✨ Build with AI") : t("นำเข้าเป็นแม่แบบ", "Import as a template")}
        </button>
        <button type="button" className={secondary} disabled={building !== null} onClick={onCancel}>{t("ยกเลิก", "Cancel")}</button>
      </div>
      {building !== null ? <p className="text-xs text-[var(--app-muted)]">{t("AI อ่านเอกสารทุกหน้า สร้างฟอร์ม และตรวจกับตัวตรวจสอบของระบบ (แก้ซ้ำได้สูงสุด 2 รอบ) — อาจใช้เวลา 1-5 นาที",
        "The AI reads every page, writes the form and checks it with the form validator (up to 2 corrections) — this can take 1-5 minutes")}</p> : null}
    </section>
  </div>;
}
