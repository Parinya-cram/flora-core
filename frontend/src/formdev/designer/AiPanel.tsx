/**
 * The designer's one place to ask the AI (Form Studio's other AI use, reading documents, keeps the AI to the unsure
 * parts: Documents tab). Describe a new form, or what to change in this form or in the selected fields; the AI works
 * in the background and its answer is shown as a change list to apply (undo brings the form back) or discard.
 */
import { useEffect, useRef, useState } from "react";
import type { FormDefinition } from "../core/types";
import type { RestApiAdapter } from "../data/RestApiAdapter";
import type { ReadingEvent, ReadingJob, ReadingResult } from "../reading/types";
import { tr, type Lang } from "./catalog";
import { changesOf } from "./model";
import { input, primary, secondary, small } from "./styles";

type Scope = "selected" | "form" | "new";
type Props = {
  lang: Lang; remote: RestApiAdapter; online: boolean; definition: FormDefinition; selectedIds: string[];
  onApply: (definition: FormDefinition, scope: Scope) => void; onOpenDocuments?: () => void; onClose: () => void;
};

export default function AiPanel({ lang, remote, online, definition, selectedIds, onApply, onOpenDocuments, onClose }: Props) {
  const t = (th: string, en: string) => tr(lang, th, en);
  const [scope, setScope] = useState<Scope>(selectedIds.length ? "selected" : "form");
  const [text, setText] = useState("");
  const [job, setJob] = useState<ReadingJob | null>(null);
  const [events, setEvents] = useState<ReadingEvent[]>([]);
  const [result, setResult] = useState<ReadingResult | null>(null);
  const [error, setError] = useState("");
  const [elapsed, setElapsed] = useState(0);
  const after = useRef(0);

  useEffect(() => {
    if (!job || job.status === "done" || job.status === "failed" || job.status === "cancelled") return;
    let stopped = false;
    const timer = window.setInterval(() => {
      setElapsed(Math.round((Date.now() - job.createdAt) / 1000));
      void remote.readingJob(job.id, after.current).then(async answer => {
        if (stopped) return;
        after.current = answer.next;
        if (answer.events.length) setEvents(current => [...current, ...answer.events]);
        setJob(answer.job);
        if (answer.job.status === "done") setResult(await remote.readingResult(job.id));
        if (answer.job.status === "failed") setError(answer.job.error ?? "failed");
      }).catch(caught => { if (!stopped) setError(caught instanceof Error ? caught.message : String(caught)); });
    }, 1000);
    return () => { stopped = true; window.clearInterval(timer); };
  }, [job, remote]);

  const ask = async () => {
    setError("");
    setResult(null);
    setEvents([]);
    after.current = 0;
    try {
      const started = await remote.startAiJob(scope === "new"
        ? { mode: "create", instructions: text }
        : { mode: "revise", instructions: text, definition, focus: scope === "selected" ? selectedIds : undefined });
      setJob(started);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  };

  const running = job !== null && (job.status === "queued" || job.status === "running");
  const changes = result && scope !== "new" ? changesOf(definition, result.definition) : null;
  const usage = job?.usage;
  return <div className="space-y-3 rounded-2xl border border-violet-400/40 bg-violet-500/5 p-3 text-sm" role="dialog" aria-label={t("ผู้ช่วย AI", "AI assistant")}>
    <div className="flex flex-wrap items-center gap-2">
      <b className="mr-auto text-[var(--app-text)]">✨ {t("ผู้ช่วย AI", "AI assistant")}</b>
      {onOpenDocuments ? <button type="button" className={small} onClick={onOpenDocuments}>{t("📄 สร้างจากเอกสาร/สแกน → แท็บเอกสาร", "📄 From documents / scans → Documents tab")}</button> : null}
      <button type="button" className={small} onClick={onClose}>{t("ปิด", "Close")}</button>
    </div>
    <div className="flex flex-wrap gap-3 text-xs">
      {([["selected", t(`แก้ช่องที่เลือก (${selectedIds.length})`, `Change the selected fields (${selectedIds.length})`)], ["form", t("แก้ทั้งฟอร์มนี้", "Change this whole form")],
        ["new", t("สร้างฟอร์มใหม่จากคำอธิบาย", "A new form from a description")]] as Array<[Scope, string]>).map(([id, label]) =>
        <label key={id} className={`flex items-center gap-1 ${id === "selected" && !selectedIds.length ? "opacity-40" : ""}`}>
          <input type="radio" name="ai-scope" checked={scope === id} disabled={id === "selected" && !selectedIds.length} onChange={() => setScope(id)} />{label}</label>)}
    </div>
    <textarea className={`${input} min-h-[90px]`} value={text} maxLength={4000} onChange={event => setText(event.target.value)}
      placeholder={scope === "new" ? t("เช่น แบบประเมินความเสี่ยงการพลัดตกหกล้ม (Morse) มีคะแนน 6 ข้อ รวมคะแนนอัตโนมัติ และลายเซ็นผู้ประเมิน", "e.g. A Morse fall-risk assessment: 6 scored items, an automatic total and the assessor's signature")
        : t("เช่น เพิ่มช่องหมายเหตุใต้ความดันโลหิต, ทำให้ช่องวันที่เป็นบังคับ, แปลป้ายเป็นภาษาอังกฤษ", "e.g. Add a note under blood pressure, make the dates required, give every label its English")} />
    <div className="flex flex-wrap items-center gap-2">
      <button type="button" className={primary} disabled={!online || !text.trim() || running} onClick={() => void ask()}>{running ? t(`AI กำลังทำงาน… ${elapsed}s`, `AI working… ${elapsed}s`) : t("ส่งให้ AI", "Ask the AI")}</button>
      {running && job ? <button type="button" className={secondary} onClick={() => void remote.cancelReading(job.id)}>{t("หยุด", "Stop")}</button> : null}
      {usage && usage.requests ? <span className="text-xs text-[var(--app-muted)]">{usage.input_tokens + usage.output_tokens} tokens · {usage.requests} {t("ครั้ง", "requests")}</span> : null}
    </div>
    {events.length ? <ol className="space-y-0.5 text-xs text-[var(--app-muted)]">{events.map(event => <li key={event.seq}>
      {event.kind === "ai_started" ? t("ส่งคำขอแล้ว AI กำลังเขียนฟอร์ม…", "Sent; the AI is writing the form…")
        : event.kind === "ai_done" ? t(`AI ตอบแล้ว (${event.data.attempts} รอบ, ${event.data.seconds} วินาที)`, `The AI answered (${event.data.attempts} rounds, ${event.data.seconds} s)`)
        : event.kind === "draft" ? t(`ตรวจกับตัวตรวจแล้ว: ${(event.data.issues as unknown[]).length} จุดต้องแก้`, `Checked: ${(event.data.issues as unknown[]).length} to fix`)
        : event.kind === "failed" ? `✗ ${String(event.data.message)}` : event.kind === "done" ? "✓" : event.kind}</li>)}</ol> : null}
    {error ? <p role="alert" className="text-xs text-rose-600 dark:text-rose-300">{error}</p> : null}
    {result ? <div className="space-y-2 rounded-xl border border-[var(--app-border)] bg-[var(--app-panel-bg)] p-2 text-xs">
      {changes ? <div>
        <b>{t("สิ่งที่จะเปลี่ยน", "What changes")}</b>: +{changes.added.length} · −{changes.removed.length} · ✎{changes.changed.length}
        <ul className="mt-1 max-h-40 overflow-y-auto">
          {changes.added.map(field => <li key={`a${field.id}`} className="text-emerald-700 dark:text-emerald-300">+ {field.label} <code>{field.id}</code> ({field.type})</li>)}
          {changes.removed.map(field => <li key={`r${field.id}`} className="text-rose-600 dark:text-rose-300">− {field.label} <code>{field.id}</code></li>)}
          {changes.changed.map(([before, after_]) => <li key={`c${after_.id}`}>✎ <code>{after_.id}</code>: {before.label !== after_.label ? `${before.label} → ${after_.label}` : t("รายละเอียด", "details")}</li>)}
        </ul>
      </div> : <div><b>{result.definition.title}</b> · {result.definition.sections.length} {t("ส่วน", "sections")}</div>}
      {result.issues.length ? <p className="text-amber-700 dark:text-amber-300">{t(`ยังมี ${result.issues.length} จุดที่ตัวตรวจแจ้ง (แก้ต่อในตัวออกแบบได้)`, `${result.issues.length} problems the validator reports (fix them in the designer)`)}</p> : null}
      <div className="flex gap-2">
        <button type="button" className={primary} onClick={() => { onApply(result.definition, scope); setResult(null); setJob(null); }}>{scope === "new" ? t("เปิดฟอร์มใหม่นี้", "Open this new form") : t("ใช้การเปลี่ยนแปลง (ย้อนได้ด้วย Ctrl+Z)", "Apply (Ctrl+Z undoes)")}</button>
        <button type="button" className={secondary} onClick={() => { setResult(null); setJob(null); }}>{t("ทิ้ง", "Discard")}</button>
      </div>
    </div> : null}
  </div>;
}
