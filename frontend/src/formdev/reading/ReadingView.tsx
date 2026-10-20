/**
 * A reading job watched live on its pages (services/flora-api/app/formdev/reading). The server's events are polled and
 * drawn over the page as they arrive: a scan line while OCR runs, the text lines it read, the layout the tools found
 * (ruled cells, charts, places to write, checkboxes), then the fields made of them. Every field points at the evidence
 * it came from (hover it: its lines light up), and every line of text is accounted for: used by a field (blue), set
 * aside with a reason (grey) or missed (red, with a button to add it as a field). When the AI is on, the screen says
 * exactly what was sent to it, which of its edits were kept and which were refused, and why.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import type { RestApiAdapter } from "../data/RestApiAdapter";
import { addLineAsField, emptyPage, pagesOf } from "./events";
import type { AiSent, Box, Coverage, PlanItem, ReadingEvent, ReadingJob, ReadingResult, ReadLine } from "./types";

type Props = {
  remote: RestApiAdapter;
  jobId: string;
  /** The PDF that was read (drawn here with pdf.js under the overlay). */
  pdf: Uint8Array;
  language: string;
  onOpenInDesigner: (result: ReadingResult) => void;
  onKeepTemplate: (result: ReadingResult) => Promise<void>;
  /** Read the same uploaded document again (no second upload), with or without the AI. */
  onReadAgain?: (ai: boolean) => void;
  aiAvailable?: boolean;
  onClose: () => void;
};

const POLL_MS = 400;
const TONE = { sure: "#16a34a", unsure: "#d97706", ai: "#7c3aed", fixed: "#db2777" };
const LINE_TONE = { used: "#0ea5e9", ignored: "#94a3b8", missed: "#dc2626" };
const button = "rounded-lg border border-[var(--app-border)] bg-[var(--app-control-bg)] px-3 py-1.5 text-xs font-semibold text-[var(--app-text)] disabled:opacity-40";
const primary = "rounded-lg bg-[var(--app-accent)] px-3 py-1.5 text-xs font-bold text-[var(--app-accent-contrast)] disabled:opacity-40";
const card = "rounded-xl border border-[var(--app-border)] p-2";

function itemTone(item: PlanItem): string {
  if (item.fixed_from) return TONE.fixed;
  if (item.by === "ai") return TONE.ai;
  return item.unsure?.length ? TONE.unsure : TONE.sure;
}

const rect = (box: Box) => ({ x: box[0], y: box[1], width: Math.max(0.001, box[2] - box[0]), height: Math.max(0.001, box[3] - box[1]) });

function PageCanvas({ pdf, index, width }: { pdf: Uint8Array; index: number; width: number }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [size, setSize] = useState<{ w: number; h: number }>({ w: width, h: Math.round(width * 1.414) });
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const lib = await import("pdfjs-dist");
      const worker = await import("pdfjs-dist/build/pdf.worker.min.mjs?url");
      lib.GlobalWorkerOptions.workerSrc = worker.default;
      const task = lib.getDocument({ data: pdf.slice() });
      try {
        const doc = await task.promise;
        const page = await doc.getPage(index + 1);
        const base = page.getViewport({ scale: 1 });
        const ratio = Math.min(window.devicePixelRatio || 1, 2);
        const viewport = page.getViewport({ scale: (width / base.width) * ratio });
        const element = canvas.current;
        if (!element || cancelled) return;
        element.width = Math.ceil(viewport.width);
        element.height = Math.ceil(viewport.height);
        setSize({ w: width, h: Math.round((base.height * width) / base.width) });
        const context = element.getContext("2d", { alpha: false });
        if (context) await page.render({ canvas: element, canvasContext: context, viewport }).promise;
      } finally {
        await task.destroy().catch(() => undefined);
      }
    })().catch(() => undefined);
    return () => { cancelled = true; };
  }, [pdf, index, width]);
  return <canvas ref={canvas} style={{ width: size.w, height: size.h, display: "block" }} className="bg-white" />;
}

export default function ReadingView({ remote, jobId, pdf, language, onOpenInDesigner, onKeepTemplate, onReadAgain, aiAvailable, onClose }: Props) {
  const th = !language.toLowerCase().startsWith("en");
  const t = (thai: string, english: string) => (th ? thai : english);
  const [job, setJob] = useState<ReadingJob | null>(null);
  const [events, setEvents] = useState<ReadingEvent[]>([]);
  const [result, setResult] = useState<ReadingResult | null>(null);
  const [error, setError] = useState("");
  const [pageIndex, setPageIndex] = useState(0);
  const [layers, setLayers] = useState({ lines: true, layout: true, fields: true });
  const [hover, setHover] = useState<string | null>(null);
  const [keeping, setKeeping] = useState(false);
  const [added, setAdded] = useState<string[]>([]);
  const after = useRef(0);

  useEffect(() => {
    let stopped = false;
    let timer = 0;
    const tick = async () => {
      try {
        const answer = await remote.readingJob(jobId, after.current);
        if (stopped) return;
        after.current = answer.next;
        setJob(answer.job);
        if (answer.events.length) setEvents(current => [...current, ...answer.events]);
        if (answer.job.status === "done") {
          setResult(await remote.readingResult(jobId));
          return;
        }
        if (answer.job.status === "failed" || answer.job.status === "cancelled") return;
      } catch (caught) {
        if (!stopped) setError(caught instanceof Error ? caught.message : String(caught));
        return;
      }
      timer = window.setTimeout(() => void tick(), POLL_MS);
    };
    void tick();
    return () => { stopped = true; window.clearTimeout(timer); };
  }, [remote, jobId]);

  const pages = useMemo(() => pagesOf(events), [events]);
  const current = pages.get(pageIndex) ?? emptyPage();
  const pageCount = job?.pages ?? 1;
  const width = 620;
  const coverage = result?.coverage[pageIndex] ?? current.coverage;
  const missed = new Set(coverage?.missed ?? []);
  const ignored = new Map((result?.ignored ?? []).map(entry => [entry.source, entry.why]));
  const used = new Set(current.items.flatMap(item => item.source));
  const hovered = current.items.find(item => item.id === hover) ?? null;
  const lit = new Set(hovered?.source ?? []);
  const lineState = (line: ReadLine): keyof typeof LINE_TONE => (missed.has(line.id) && !added.includes(line.id) ? "missed" : used.has(line.id) ? "used" : ignored.has(line.id) ? "ignored" : "used");
  const totals = [...pages.values()].reduce((sum, page) => ({ lines: sum.lines + (page.coverage?.lines ?? 0), missed: sum.missed + (page.coverage?.missed.length ?? 0) }), { lines: 0, missed: 0 });

  const describe = (event: ReadingEvent): string => {
    const d = event.data;
    const p = event.page !== null ? `${t("หน้า", "p.")} ${Number(event.page) + 1}: ` : "";
    switch (event.kind) {
      case "started": return t(`เริ่มอ่าน ${d.pages} หน้า · OCR ${d.ocr ? "พร้อม" : "ไม่มี"} · AI ${d.ai ? "เปิด (ตรวจด้วยหลักฐานครบทุกบรรทัด)" : "ปิด (เครื่องมืออย่างเดียว)"}`,
        `Reading ${d.pages} pages · OCR ${d.ocr ? "ready" : "missing"} · AI ${d.ai ? "on (checks with all the evidence)" : "off (tools only)"}`);
      case "form_fields": return t(`PDF มีช่องกรอก ${d.count} ช่อง (ใช้ตำแหน่งจริง)`, `The PDF has ${d.count} form fields (exact positions used)`);
      case "page": return `${p}${Math.round(Number(d.width_pt) / 72 * 25.4)}×${Math.round(Number(d.height_pt) / 72 * 25.4)} mm · ${d.dpi} dpi`;
      case "text_layer": return `${p}${d.quality === "good" ? t(`ข้อความในไฟล์ใช้ได้ (${d.chars} ตัวอักษร) ไม่ต้อง OCR`, `the file's own text is good (${d.chars} characters): no OCR`) : t("ไม่มีข้อความในไฟล์หรือเสีย → OCR", "no usable text in the file → OCR")}`;
      case "prepared": return `${p}${d.straightened ? t(`จัดหน้าตรง (เอียง ${d.skew}°)`, `straightened (tilted ${d.skew}°)`) : t(`หน้าตรงอยู่แล้ว (${d.skew}°)`, `already straight (${d.skew}°)`)}${d.evened ? t(" · ปรับแสงให้เท่ากัน", " · lighting evened out") : ""}`;
      case "ocr_started": return `${p}${t("กำลังอ่านภาพด้วย OCR (ไทย/อังกฤษ)…", "reading the image with OCR (Thai/English)…")}`;
      case "ocr_done": return `${p}${t(`อ่านได้ ${d.lines} บรรทัด ใน ${d.seconds} วินาที`, `${d.lines} lines in ${d.seconds} s`)}${Array.isArray(d.fixes) && d.fixes.length ? t(` · แก้วรรณยุกต์ ${d.fixes.length} คำ`, ` · ${d.fixes.length} tone marks restored`) : ""}`;
      case "lines": return "";
      case "layout": return `${p}${t("โครงสร้าง", "layout")}: ${(d.cells as unknown[]).length} ${t("เซลล์", "cells")} · ${(d.grids as unknown[]).length} ${t("ตารางกราฟ", "charts")} · ${(d.blanks as unknown[]).length} ${t("ที่เขียน", "places to write")} · ${(d.checkboxes as unknown[]).length} ${t("ช่องติ๊ก", "checkboxes")} (${d.seconds}s)`;
      case "plan": {
        const items = d.items as PlanItem[];
        const cov = d.coverage as Coverage;
        return `${p}${items.filter(item => item.kind === "field").length} ${t("ช่อง", "fields")} · ${items.filter(item => item.unsure?.length).length} ${t("ไม่แน่ใจ", "unsure")} · ${t("ใช้ข้อความ", "text used")} ${Math.round(cov.share * 100)}%`;
      }
      case "ai_started": {
        const s = d.sent as AiSent;
        return `${p}${t(`ส่งให้ AI: ภาพทั้งหน้า + ภาพขยาย ${s.closeups} จุด + ข้อความ ${s.lines} บรรทัด + เซลล์ ${s.cells} + ที่เขียน ${s.blanks} + ตารางกราฟ ${s.grids} + แผนจากเครื่องมือ ${s.items} รายการ`,
          `To the AI: the page + ${s.closeups} close-ups + ${s.lines} text lines + ${s.cells} cells + ${s.blanks} places to write + ${s.grids} charts + the tools' plan of ${s.items} items`)}`;
      }
      case "ai_done": {
        const usage = d.usage as { input_tokens: number; output_tokens: number };
        const before = d.coverage_before as Coverage;
        const afterCov = d.coverage_after as Coverage;
        return `${p}${t(`AI แก้ ${d.applied} จุด · ปฏิเสธ ${(d.rejected as unknown[]).length} จุดที่ไม่ตรงเอกสาร · ใช้ข้อความ ${Math.round(before.share * 100)}% → ${Math.round(afterCov.share * 100)}% · ${usage.input_tokens + usage.output_tokens} tokens · ${d.seconds}s`,
          `AI: ${d.applied} edits kept · ${(d.rejected as unknown[]).length} refused (not on the page) · text used ${Math.round(before.share * 100)}% → ${Math.round(afterCov.share * 100)}% · ${usage.input_tokens + usage.output_tokens} tokens · ${d.seconds}s`)}`;
      }
      case "ai_failed": return `${p}${t(`AI ใช้ไม่ได้: ${d.message} (ใช้ผลจากเครื่องมืออย่างเดียว)`, `AI failed: ${d.message} (the tools' draft stands)`)}`;
      case "note": return String(d.message);
      case "draft": return t(`ได้ร่างฟอร์ม ${d.sections} ส่วน ${d.fields} ช่อง`, `Draft: ${d.sections} sections, ${d.fields} fields`) + ((d.issues as unknown[]).length ? t(` · ต้องแก้ ${(d.issues as unknown[]).length}`, ` · ${(d.issues as unknown[]).length} to fix`) : "");
      case "done": return t("เสร็จ", "Done");
      case "failed": return t(`ล้มเหลว: ${d.message}`, `Failed: ${d.message}`);
      default: return event.kind;
    }
  };

  const keep = async () => {
    if (!result) return;
    setKeeping(true);
    try {
      await onKeepTemplate(result);
    } finally {
      setKeeping(false);
    }
  };
  const addLine = (line: ReadLine) => {
    if (!result) return;
    setResult({ ...result, definition: addLineAsField(result.definition, line) });
    setAdded(list => [...list, line.id]);
  };

  const started = events[0]?.at ?? 0;
  const layout = current.layout;
  const fieldCount = result ? result.definition.sections.reduce((n, section) => n + section.fields.length, 0) : 0;
  return <section className="rounded-2xl border border-[var(--app-border)] bg-[var(--app-panel-bg)] p-3" aria-label={t("การอ่านเอกสาร", "Reading the document")}>
    <style>{`@keyframes flora-scan { from { top: 0% } to { top: 100% } } .flora-scan { animation: flora-scan 1.6s linear infinite alternate; }
      .flora-pop { animation: flora-pop .35s ease-out; } @keyframes flora-pop { from { opacity: 0 } to { opacity: 1 } }`}</style>
    <div className="mb-3 flex flex-wrap items-center gap-2">
      <h3 className="mr-auto text-sm font-bold text-[var(--app-text)]">{job?.name ?? t("กำลังเริ่ม…", "Starting…")}
        <span className={`ml-2 rounded-full px-2 py-0.5 text-[10px] font-bold uppercase ${job?.status === "done" ? "bg-emerald-500/15 text-emerald-600" : job?.status === "failed" ? "bg-rose-500/15 text-rose-600" : "bg-sky-500/15 text-sky-600"}`}>{job?.status ?? "…"}</span>
        {totals.lines ? <span className={`ml-2 rounded-full px-2 py-0.5 text-[10px] font-bold ${totals.missed ? "bg-amber-500/15 text-amber-700" : "bg-emerald-500/15 text-emerald-700"}`}>
          {t("ใช้ข้อความ", "text used")} {totals.lines - totals.missed}/{totals.lines}</span> : null}
      </h3>
      {(["lines", "layout", "fields"] as const).map(layer => <label key={layer} className="flex items-center gap-1 text-xs text-[var(--app-muted)]">
        <input type="checkbox" checked={layers[layer]} onChange={event => setLayers(currentLayers => ({ ...currentLayers, [layer]: event.target.checked }))} />
        {layer === "lines" ? t("ข้อความ", "Text") : layer === "layout" ? t("โครงสร้าง", "Layout") : t("ช่องฟอร์ม", "Fields")}
      </label>)}
      {job && (job.status === "running" || job.status === "queued") ? <button type="button" className={button} onClick={() => void remote.cancelReading(jobId)}>{t("หยุด", "Stop")}</button> : null}
      <button type="button" className={button} onClick={onClose}>{t("ปิด", "Close")}</button>
    </div>
    {error ? <p role="alert" className="mb-2 text-xs text-rose-600">{error}</p> : null}

    <div className="grid gap-3 xl:grid-cols-[auto_minmax(0,1fr)]">
      <div>
        {pageCount > 1 ? <div className="mb-2 flex flex-wrap gap-1">{Array.from({ length: pageCount }, (_, index) => <button key={index} type="button" onClick={() => setPageIndex(index)}
          className={`rounded-md px-2 py-0.5 text-xs ${index === pageIndex ? "bg-[var(--app-accent)] text-[var(--app-accent-contrast)]" : "border border-[var(--app-border)]"}`}>
          {index + 1}{pages.get(index)?.scanning ? " ⟳" : pages.get(index)?.aiRunning ? " ✨" : ""}</button>)}</div> : null}
        <div className="relative overflow-hidden rounded-lg shadow ring-1 ring-black/10" style={{ width }}>
          <PageCanvas pdf={pdf} index={pageIndex} width={width} />
          <svg viewBox="0 0 1 1" preserveAspectRatio="none" className="absolute inset-0 h-full w-full" role="img" aria-label={t("สิ่งที่อ่านได้บนหน้า", "What was read on the page")}>
            {layers.layout && layout ? <g>
              {layout.grids.map(grid => <rect key={grid.id} className="flora-pop" {...rect(grid.box)} fill="rgba(217,70,239,0.07)" stroke="#d946ef" strokeWidth={0.002} vectorEffect="non-scaling-stroke"><title>{`${grid.id}: ${grid.rows}×${grid.cols}`}</title></rect>)}
              {layout.cells.map(cell => <rect key={cell.id} className="flora-pop" {...rect(cell.box)} fill="none" stroke="#64748b" strokeOpacity={0.55} strokeWidth={0.001} vectorEffect="non-scaling-stroke"><title>{cell.id}</title></rect>)}
              {layout.blanks.map(blank => <rect key={blank.id} className="flora-pop" {...rect(blank.box)} fill="rgba(249,115,22,0.12)" stroke="#f97316" strokeWidth={0.0015} strokeDasharray="0.006 0.004" vectorEffect="non-scaling-stroke"><title>{`${blank.id} (${blank.kind})`}</title></rect>)}
              {layout.checkboxes.map(box => <rect key={box.id} className="flora-pop" {...rect(box.box)} fill={box.ticked ? "rgba(14,165,233,0.3)" : "none"} stroke="#0ea5e9" strokeWidth={0.002} vectorEffect="non-scaling-stroke"><title>{box.id}</title></rect>)}
            </g> : null}
            {layers.lines ? current.lines.map(line => {
              const state = lineState(line);
              const on = lit.has(line.id);
              return <rect key={line.id} className="flora-pop" {...rect(line.box)} fill={on ? "rgba(124,58,237,0.25)" : `${LINE_TONE[state]}1f`} stroke={on ? TONE.ai : LINE_TONE[state]}
                strokeWidth={on ? 0.003 : 0.001} vectorEffect="non-scaling-stroke"><title>{`${line.id}: ${line.text} (${Math.round(line.score * 100)}%)${state === "missed" ? t(" — ยังไม่ได้ใช้", " — not used yet") : state === "ignored" ? ` — ${ignored.get(line.id)}` : ""}`}</title></rect>;
            }) : null}
            {layers.fields ? current.items.map(item => <g key={item.id} className="flora-pop" onMouseEnter={() => setHover(item.id)} onMouseLeave={() => setHover(null)}>
              <rect {...rect(item.box)} fill={hover === item.id ? `${itemTone(item)}22` : "none"} stroke={itemTone(item)} strokeWidth={hover === item.id ? 0.004 : 0.0022} vectorEffect="non-scaling-stroke">
                <title>{`${item.type ?? item.kind}: ${item.label}${item.label_en ? ` / ${item.label_en}` : ""} — ${Math.round(item.confidence * 100)}%${item.unsure?.length ? ` (${item.unsure.join(", ")})` : ""}`}</title></rect>
            </g>) : null}
          </svg>
          {current.scanning ? <div className="flora-scan pointer-events-none absolute left-0 right-0 h-1 bg-gradient-to-r from-transparent via-sky-400 to-transparent shadow-[0_0_12px_rgba(56,189,248,0.9)]" /> : null}
          {current.aiRunning ? <div className="pointer-events-none absolute inset-0 animate-pulse bg-violet-500/5 ring-2 ring-inset ring-violet-400/60" /> : null}
        </div>
        <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-[var(--app-muted)]">
          <span><b style={{ color: TONE.sure }}>■</b> {t("ช่องที่แน่ใจ", "sure")}</span><span><b style={{ color: TONE.unsure }}>■</b> {t("ไม่แน่ใจ", "unsure")}</span>
          <span><b style={{ color: TONE.ai }}>■</b> {t("AI ปรับ", "by the AI")}</span><span><b style={{ color: TONE.fixed }}>■</b> {t("AI แก้คำที่ OCR อ่านผิด", "OCR slip fixed by the AI")}</span>
          <span><b style={{ color: LINE_TONE.missed }}>■</b> {t("ข้อความที่ยังไม่ได้ใช้", "text not used")}</span><span><b style={{ color: "#f97316" }}>■</b> {t("ที่เขียน", "place to write")}</span>
          <span><b style={{ color: "#d946ef" }}>■</b> {t("ตารางกราฟ", "chart")}</span>
          {current.source ? <span>· {current.source === "ocr" ? `OCR${current.seconds ? ` ${current.seconds}s` : ""}` : t("ข้อความในไฟล์", "file text")}{current.dpi ? ` · ${current.dpi} dpi` : ""}</span> : null}
        </div>
      </div>

      <div className="min-w-0 space-y-3">
        <div className={card}>
          <div className="mb-1 text-xs font-bold text-[var(--app-muted)]">{t("ขั้นตอน (สด)", "Steps (live)")}</div>
          <ol className="max-h-56 space-y-0.5 overflow-y-auto text-xs" aria-live="polite">
            {events.filter(event => event.kind !== "lines").map(event => <li key={event.seq} className="flex gap-2">
              <span className="w-12 shrink-0 tabular-nums text-[var(--app-muted)]">{((event.at - started) / 1000).toFixed(1)}s</span>
              <span className={event.kind.startsWith("ai") ? "text-violet-600 dark:text-violet-300" : event.kind === "failed" ? "text-rose-600" : "text-[var(--app-text)]"}>{describe(event)}</span>
            </li>)}
          </ol>
        </div>

        {current.aiSent || current.aiFailed ? <div className="rounded-xl border border-violet-400/40 bg-violet-500/5 p-2 text-xs">
          <div className="mb-1 font-bold text-violet-700 dark:text-violet-300">{t("AI: ทุกข้อที่แก้ต้องชี้กลับไปที่เอกสาร", "AI: every edit must point back at the page")}</div>
          {current.aiFailed ? <p className="text-rose-600">{current.aiFailed}</p> : null}
          {current.aiRunning ? <p>{t("AI กำลังตรวจหน้านี้…", "The AI is checking this page…")}</p> : null}
          {current.aiChanges?.length ? <ul className="mt-1 max-h-48 space-y-0.5 overflow-y-auto">{current.aiChanges.map((change, index) => <li key={index}>
            {change.edit ? <><code>{change.edit}</code> {String(change.before?.label ?? "")} → <b>{String(change.after?.label ?? "")}</b>{change.before?.type !== change.after?.type ? ` (${String(change.before?.type ?? "")} → ${String(change.after?.type ?? "")})` : ""}</> : null}
            {change.add ? <>＋ <b>{change.label}</b> <span className="text-[var(--app-muted)]">({change.source?.join(", ")})</span></> : null}
            {change.remove ? <>− <s>{change.label}</s> <span className="text-[var(--app-muted)]">{change.why}</span></> : null}
          </li>)}</ul> : null}
          {current.aiRejected?.length ? <details className="mt-1"><summary className="cursor-pointer text-rose-600">{t(`ไม่รับ ${current.aiRejected.length} ข้อ (ไม่ตรงกับเอกสาร)`, `${current.aiRejected.length} refused (not what the page shows)`)}</summary>
            <ul className="mt-1 space-y-0.5">{current.aiRejected.map((entry, index) => <li key={index}>{entry.item ? <code>{entry.item}</code> : null} {entry.why}</li>)}</ul></details> : null}
        </div> : null}

        {coverage ? <div className={card}>
          <div className="mb-1 flex items-center gap-2 text-xs font-bold text-[var(--app-muted)]">
            <span className="mr-auto">{t("ความครบถ้วน", "Coverage")} · {coverage.used}/{coverage.lines} {t("บรรทัดใช้ในช่อง", "lines in fields")} · {coverage.ignored} {t("ตัดออกพร้อมเหตุผล", "set aside")}</span>
            <span className={coverage.missed.length ? "text-amber-700" : "text-emerald-700"}>{Math.round(coverage.share * 100)}%</span>
          </div>
          {coverage.missed.length ? <ul className="space-y-0.5 text-xs">{current.lines.filter(line => missed.has(line.id)).map(line => <li key={line.id} className="flex items-center gap-2">
            <code className="text-rose-600">{line.id}</code><span className="min-w-0 flex-1 truncate">{line.text}</span>
            {result && !added.includes(line.id) ? <button type="button" className={button} onClick={() => addLine(line)}>{t("+ เพิ่มเป็นช่อง", "+ Add as a field")}</button> : added.includes(line.id) ? <span className="text-emerald-600">✓</span> : null}
          </li>)}</ul> : <p className="text-xs text-emerald-700 dark:text-emerald-300">✓ {t("ทุกบรรทัดของหน้านี้ถูกใช้หรือมีเหตุผลที่ตัดออก", "Every line of this page is used or set aside with a reason")}</p>}
        </div> : null}

        {current.items.length ? <div className={card}>
          <div className="mb-1 text-xs font-bold text-[var(--app-muted)]">{t("ช่องที่ได้ (ชี้เพื่อดูหลักฐานบนหน้า)", "Fields (point to see their evidence)")} · {current.items.length}</div>
          <ul className="max-h-72 space-y-0.5 overflow-y-auto text-xs">{current.items.map(item => <li key={item.id} onMouseEnter={() => setHover(item.id)} onMouseLeave={() => setHover(null)}
            className={`flex items-center gap-2 rounded px-1 ${hover === item.id ? "bg-violet-500/10" : ""}`}>
            <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: itemTone(item) }} />
            <span className="min-w-0 flex-1 truncate"><b>{item.label}</b>{item.label_en ? <span className="text-[var(--app-muted)]"> / {item.label_en}</span> : null}
              {item.fixed_from ? <span className="text-pink-600"> ({t("เดิม", "was")} {item.fixed_from})</span> : null}</span>
            <span className="shrink-0 text-[var(--app-muted)]">{item.type ?? item.kind}{item.unit ? ` · ${item.unit}` : ""}{item.rows.length ? ` · ${item.rows.length} ${t("แถว", "rows")}` : ""}{item.options.length ? ` · ${item.options.length} ${t("ตัวเลือก", "options")}` : ""}</span>
          </li>)}</ul>
        </div> : null}

        {result ? <div className="rounded-xl border border-emerald-500/40 bg-emerald-500/5 p-2 text-xs">
          <div className="mb-1 font-bold text-emerald-700 dark:text-emerald-300">{t(`ได้ร่างฟอร์ม ${result.definition.sections.length} ส่วน ${fieldCount} ช่อง`,
            `Draft: ${result.definition.sections.length} sections, ${fieldCount} fields`)}{result.usage.requests ? ` · AI ${result.usage.input_tokens + result.usage.output_tokens} tokens` : ""}</div>
          {result.issues.length ? <ul className="mb-2 list-disc pl-4 text-amber-700 dark:text-amber-300">{result.issues.slice(0, 6).map((issue, index) => <li key={index}>{issue.message}</li>)}</ul> : null}
          <div className="flex flex-wrap gap-2">
            <button type="button" className={primary} onClick={() => onOpenInDesigner(result)}>{t("เปิดในตัวออกแบบ", "Open in the designer")}</button>
            <button type="button" className={button} disabled={keeping} onClick={() => void keep()}>{keeping ? "…" : t("เก็บเป็นแม่แบบ", "Keep as a template")}</button>
            {onReadAgain && aiAvailable && !result.usage.requests ? <button type="button" className={button} onClick={() => onReadAgain(true)}>✨ {t("อ่านซ้ำโดยให้ AI ช่วยตรวจ (ไม่ต้องส่งไฟล์ใหม่)", "Read again with the AI (no new upload)")}</button> : null}
          </div>
        </div> : null}
      </div>
    </div>
  </section>;
}
