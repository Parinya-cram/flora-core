/**
 * Report Studio: build Canopy reports without code, the way Form Studio builds forms. Drag catalog fields
 * (canopy_report_field) onto Filters, Columns, Group by and Statistics; the preview runs live on the
 * archive; saving adds the report to the Reports library. Reports are stored as a StudioSpec that names
 * fields only; the server turns it into SQL (app/report_engine.py).
 */
import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent, type ReactNode } from "react";
import { getReportLibrary, type ReportDefinition } from "../api/reportLibraryApi";
import {
  archiveStudioReport, createStudioReport, getCatalog, previewReport, updateStudioReport,
  type Aggregate, type CatalogField, type StudioResult, type StudioSpec,
} from "../api/reportStudioApi";
import Inspector, { type ReportMeta } from "./Inspector";
import {
  AGGREGATES, BUCKETS, DRAG_MIME, OPERATORS, TEMPLATES, TYPE_ICON, addMeasure, canDrop, defaultShelf, emptySpec, insertField, langOf, moveItem,
  problems, removeItem, shelvesFor, specOf, switchView, tr, type DragItem, type Lang, type Shelf, type Slot,
} from "./model";
import ResultView from "./ResultView";
import { input, panel, primary, secondary, small } from "./styles";

type Props = { language?: string };
type Draft = { id: string | null; meta: ReportMeta; spec: StudioSpec };
type View = "design" | "sql" | "json";

const AUTOSAVE = "reportstudio.autosave.v1";
const NEW_META: ReportMeta = { title: "", description: "", category: "clinical_summary" };

function readAutosave(): Draft | null {
  try {
    const raw = localStorage.getItem(AUTOSAVE);
    return raw ? JSON.parse(raw) as Draft : null;
  } catch {
    return null;
  }
}
function writeAutosave(value: Draft | null) {
  try {
    if (value) localStorage.setItem(AUTOSAVE, JSON.stringify(value));
    else localStorage.removeItem(AUTOSAVE);
  } catch {
    // Browser storage is a convenience only.
  }
}

/** Undo/redo over the spec; edits that share a mergeKey (typing in one box) become one step. */
function useHistory(initial: StudioSpec) {
  const [state, setState] = useState({ past: [] as StudioSpec[], present: initial, future: [] as StudioSpec[], key: "" });
  const commit = useCallback((next: StudioSpec, mergeKey = "") => setState(current => (
    mergeKey && mergeKey === current.key
      ? { ...current, present: next, future: [] }
      : { past: [...current.past.slice(-80), current.present], present: next, future: [], key: mergeKey }
  )), []);
  const reset = useCallback((next: StudioSpec) => setState({ past: [], present: next, future: [], key: "" }), []);
  const undo = useCallback(() => setState(current => current.past.length ? { past: current.past.slice(0, -1), present: current.past[current.past.length - 1], future: [current.present, ...current.future], key: "" } : current), []);
  const redo = useCallback(() => setState(current => current.future.length ? { past: [...current.past, current.present], present: current.future[0], future: current.future.slice(1), key: "" } : current), []);
  return { spec: state.present, commit, reset, undo, redo, canUndo: state.past.length > 0, canRedo: state.future.length > 0 };
}

export default function ReportStudio({ language = "en" }: Props) {
  const lang = langOf(language);
  const t = (th: string, en: string) => tr(lang, th, en);
  const [fields, setFields] = useState<CatalogField[]>([]);
  const [catalogError, setCatalogError] = useState("");
  const fieldMap = useMemo(() => new Map(fields.map(field => [field.id, field])), [fields]);
  const [saved, setSaved] = useState<ReportDefinition[]>([]);
  const [draft, setDraft] = useState<{ id: string | null; meta: ReportMeta } | null>(null);
  const history = useHistory(emptySpec("stats"));
  const { spec } = history;
  const [selection, setSelection] = useState<Slot | null>(null);
  const [view, setView] = useState<View>("design");
  const [message, setMessage] = useState<{ tone: "ok" | "error" | "info"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmArchive, setConfirmArchive] = useState(false);
  const [period, setPeriod] = useState({ from: "", to: "" });
  const [page, setPage] = useState(1);
  const [result, setResult] = useState<StudioResult | null>(null);
  const [running, setRunning] = useState(false);
  const [runError, setRunError] = useState("");
  const dragRef = useRef<DragItem | null>(null);
  const [dragItem, setDragItem] = useState<DragItem | null>(null);
  const setDrag = (item: DragItem | null) => { dragRef.current = item; setDragItem(item); };

  const loadSaved = useCallback(() => getReportLibrary().then(rows => setSaved(rows.filter(row => row.definition.engine === "studio"))).catch(() => undefined), []);
  useEffect(() => {
    getCatalog().then(catalog => setFields(catalog.fields.filter(field => field.dataset_id === spec.dataset)))
      .catch(error => setCatalogError(error instanceof Error ? error.message : String(error)));
    void loadSaved();
    const restored = readAutosave();
    if (restored) {
      setDraft({ id: restored.id, meta: restored.meta });
      history.reset(specOf(restored.spec));
    }
    // Load once; the dataset is fixed for now.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => { if (draft) writeAutosave({ ...draft, spec }); }, [draft, spec]);

  // Keyboard undo / redo outside text inputs.
  const { undo, redo } = history;
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (!draft || (target && ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName))) return;
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "z") {
        event.preventDefault();
        if (event.shiftKey) redo(); else undo();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [draft, undo, redo]);

  const issues = useMemo(() => (fields.length ? problems(spec, fieldMap) : []), [spec, fieldMap, fields.length]);

  // Live preview: re-run shortly after every change once the report is runnable.
  const specKey = JSON.stringify(spec);
  useEffect(() => { setPage(1); }, [specKey, period.from, period.to]);
  useEffect(() => {
    if (!draft || !fields.length || issues.length) { setResult(null); setRunError(""); return; }
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      setRunning(true);
      const params: Record<string, string> = { page: String(page), page_size: "50" };
      if (period.from) params.from = period.from;
      if (period.to) params.to = period.to;
      previewReport(JSON.parse(specKey) as StudioSpec, params, controller.signal)
        .then(next => { setResult(next); setRunError(""); })
        .catch(error => { if (!controller.signal.aborted) setRunError(error instanceof Error ? error.message : String(error)); })
        .finally(() => { if (!controller.signal.aborted) setRunning(false); });
    }, 450);
    return () => { controller.abort(); window.clearTimeout(timer); };
  }, [draft, fields.length, issues.length, specKey, page, period.from, period.to]);

  const commit = (next: StudioSpec, mergeKey?: string) => history.commit(next, mergeKey);

  const open = (id: string | null, meta: ReportMeta, next: StudioSpec) => {
    setDraft({ id, meta });
    history.reset(next);
    setSelection(null);
    setView("design");
    setMessage(null);
    setConfirmArchive(false);
  };

  const close = () => { setDraft(null); writeAutosave(null); setResult(null); };

  const save = async (asNew: boolean) => {
    if (!draft) return;
    const title = draft.meta.title.trim();
    if (!title) { setSelection(null); setMessage({ tone: "error", text: t("ตั้งชื่อรายงานก่อนบันทึก", "Give the report a title before saving.") }); return; }
    setBusy(true);
    try {
      const body = { ...draft.meta, title, spec };
      const row = draft.id && !asNew ? await updateStudioReport(draft.id, body) : await createStudioReport(body);
      setDraft({ id: row.id, meta: { ...draft.meta, title } });
      setMessage({ tone: "ok", text: t(`บันทึก "${title}" แล้ว เปิดใช้ได้ที่หน้า Reports`, `Saved "${title}". It is now in the Reports library.`) });
      void loadSaved();
    } catch (error) {
      setMessage({ tone: "error", text: error instanceof Error ? error.message : String(error) });
    } finally {
      setBusy(false);
    }
  };

  const archive = async () => {
    if (!draft?.id) return;
    setBusy(true);
    try {
      await archiveStudioReport(draft.id);
      setConfirmArchive(false);
      close();
      void loadSaved();
    } catch (error) {
      setMessage({ tone: "error", text: error instanceof Error ? error.message : String(error) });
    } finally {
      setBusy(false);
    }
  };

  // Drag and drop ------------------------------------------------------------------------------
  const drop = (item: DragItem, to: Slot) => {
    if (item.kind === "field") {
      const field = fieldMap.get(item.fieldId);
      if (!field || !canDrop(field, to.shelf)) return;
      commit(insertField(spec, field, to));
      // A new filter needs a value, so open it in the inspector.
      setSelection(to.shelf === "filters" ? { shelf: "filters", index: Math.min(to.index, spec.filters.length) } : null);
    } else {
      commit(moveItem(spec, item.from, to, fieldMap));
      setSelection(null);
    }
  };
  const addByClick = (field: CatalogField) => {
    const shelf = defaultShelf(field, spec.view);
    if (shelf) drop({ kind: "field", fieldId: field.id }, { shelf, index: (spec[shelf] as unknown[]).length });
  };
  const dragging = () => dragRef.current;
  const dragField = dragItem?.kind === "field" ? fieldMap.get(dragItem.fieldId) : undefined;

  if (catalogError) return <div className="rounded-xl border border-rose-500/40 bg-rose-500/10 p-4 text-sm text-rose-600 dark:text-rose-300">{t("โหลดรายการฟิลด์ไม่ได้: ", "Could not load the field catalog: ")}{catalogError}</div>;

  if (!draft) return <StartScreen lang={lang} saved={saved} onNew={kind => open(null, NEW_META, emptySpec(kind))}
    onTemplate={template => open(null, { ...NEW_META, title: template.title }, template.spec)}
    onOpen={row => open(row.id, { title: row.title, description: row.description, category: row.category }, specOf(row.definition.studio))} />;

  const sortBy = (key: string) => commit({ ...spec, sort: spec.sort?.key === key ? (spec.sort.dir === "asc" ? { key, dir: "desc" } : null) : { key, dir: "asc" } });

  return <div className="space-y-3">
    <div className={`${panel} flex flex-wrap items-center gap-2 p-2`}>
      <button type="button" className={small} onClick={close}>← {t("รายงานทั้งหมด", "All reports")}</button>
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-bold text-[var(--app-text)]">{draft.meta.title || t("รายงานใหม่", "Untitled report")}</div>
        <div className="text-[11px] text-[var(--app-muted)]">{draft.id ? <code>{draft.id}</code> : t("ยังไม่ได้บันทึก", "Not saved yet")}</div>
      </div>
      <button type="button" className={small} disabled={!history.canUndo} onClick={history.undo} title="Ctrl+Z">↶ {t("เลิกทำ", "Undo")}</button>
      <button type="button" className={small} disabled={!history.canRedo} onClick={history.redo} title="Ctrl+Shift+Z">↷ {t("ทำซ้ำ", "Redo")}</button>
      <div className="flex rounded-lg border border-[var(--app-border)] p-0.5">
        {([["design", t("ออกแบบ", "Design")], ["sql", "SQL"], ["json", "JSON"]] as Array<[View, string]>).map(([id, text]) =>
          <button key={id} type="button" onClick={() => setView(id)} className={`rounded-md px-2.5 py-1 text-xs font-bold ${view === id ? "bg-[var(--app-accent)] text-[var(--app-accent-contrast)]" : "text-[var(--app-muted)]"}`}>{text}</button>)}
      </div>
      <span className={`rounded-lg px-2.5 py-1 text-xs font-bold ${issues.length ? "bg-rose-500/15 text-rose-600 dark:text-rose-300" : "bg-emerald-500/15 text-emerald-600 dark:text-emerald-300"}`}>
        {issues.length ? t(`⚠ ต้องแก้ ${issues.length} จุด`, `⚠ ${issues.length} to fix`) : t("✓ พร้อมใช้", "✓ Ready")}
      </span>
      {draft.id ? <button type="button" className={secondary} disabled={busy} onClick={() => setConfirmArchive(true)}>{t("เก็บเข้าคลัง", "Archive")}</button> : null}
      {draft.id ? <button type="button" className={secondary} disabled={busy || issues.length > 0} onClick={() => void save(true)}>{t("บันทึกเป็นรายงานใหม่", "Save as new")}</button> : null}
      <button type="button" className={primary} disabled={busy || issues.length > 0} onClick={() => void save(false)}>{draft.id ? t("บันทึก", "Save") : t("บันทึกลงคลังรายงาน", "Save to Reports")}</button>
    </div>

    {confirmArchive ? <div role="alertdialog" className="rounded-xl border border-rose-500/40 bg-[var(--app-panel-bg)] p-3 text-sm text-[var(--app-text)]">
      <div className="font-semibold">{t(`นำ "${draft.meta.title}" ออกจากหน้า Reports?`, `Remove "${draft.meta.title}" from the Reports library?`)}</div>
      <p className="mt-1 text-xs text-[var(--app-muted)]">{t("รายงานจะถูกซ่อน ข้อมูลไม่ถูกลบ", "The report is hidden; no data is deleted.")}</p>
      <div className="mt-2 flex gap-2">
        <button type="button" className={primary} disabled={busy} onClick={() => void archive()}>{t("ยืนยัน", "Archive")}</button>
        <button type="button" className={secondary} onClick={() => setConfirmArchive(false)}>{t("ยกเลิก", "Cancel")}</button>
      </div>
    </div> : null}

    {message ? <div className={`rounded-xl border px-3 py-2 text-sm ${message.tone === "error" ? "border-rose-500/40 bg-rose-500/10 text-rose-600 dark:text-rose-300"
      : message.tone === "ok" ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300" : "border-[var(--app-border)] bg-[var(--app-control-bg)] text-[var(--app-text)]"}`}>
      {message.text}<button type="button" className="ml-2 text-xs underline" onClick={() => setMessage(null)}>{t("ปิด", "dismiss")}</button>
    </div> : null}

    {view === "sql" ? <pre className={`${panel} max-h-[70vh] overflow-auto whitespace-pre-wrap p-3 font-mono text-xs text-[var(--app-text)]`}>{result?.sql ?? t("SQL จะแสดงเมื่อรายงานพร้อมรัน", "The SQL appears once the report can run.")}</pre> : null}
    {view === "json" ? <pre className={`${panel} max-h-[70vh] overflow-auto p-3 font-mono text-xs text-[var(--app-text)]`}>{JSON.stringify(spec, null, 2)}</pre> : null}

    {view === "design" ? <div className="grid gap-3 xl:grid-cols-[240px_minmax(0,1fr)_320px]">
      <Palette lang={lang} fields={fields} view={spec.view} onAdd={addByClick} onDrag={setDrag} />

      <div className="min-w-0 space-y-3">
        <div className={`${panel} space-y-2 p-3`}>
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs font-semibold text-[var(--app-muted)]">{t("รูปแบบรายงาน", "Report type")}</span>
            <div className="flex rounded-lg border border-[var(--app-border)] p-0.5">
              {([["stats", t("สถิติ / สรุป", "Statistics")], ["list", t("รายการเคส", "Case list")]] as Array<[StudioSpec["view"], string]>).map(([id, text]) =>
                <button key={id} type="button" onClick={() => { commit(switchView(spec, id, fieldMap)); setSelection(null); }}
                  className={`rounded-md px-3 py-1 text-xs font-bold ${spec.view === id ? "bg-[var(--app-accent)] text-[var(--app-accent-contrast)]" : "text-[var(--app-muted)]"}`}>{text}</button>)}
            </div>
            <span className="text-[11px] text-[var(--app-muted)]">{spec.view === "stats" ? t("หนึ่งแถวต่อกลุ่ม", "One row per group") : t("หนึ่งแถวต่อเคส", "One row per case")}</span>
          </div>
          {shelvesFor(spec.view).map(shelf => <ShelfZone key={shelf} lang={lang} shelf={shelf} spec={spec} fields={fieldMap} selection={selection} dragField={dragField}
            getDrag={dragging} setDrag={setDrag} onDrop={drop} onSelect={setSelection}
            onRemove={slot => { commit(removeItem(spec, slot)); setSelection(null); }}
            extra={shelf === "measures" ? <div className="flex flex-wrap gap-1">
              {(["count_cases", "count_patients", "pct_cases"] as Aggregate[]).map(agg => <button key={agg} type="button" className={small} onClick={() => commit(addMeasure(spec, agg))}>+ {tr(lang, ...AGGREGATES[agg])}</button>)}
            </div> : null} />)}
        </div>

        <div className={`${panel} space-y-2 p-3`}>
          <div className="flex flex-wrap items-center gap-2">
            <div className="text-sm font-semibold text-[var(--app-text)]">{t("ตัวอย่างผลลัพธ์", "Preview")}</div>
            <label className="flex items-center gap-1 text-xs text-[var(--app-muted)]">{t("ตั้งแต่", "From")}
              <input type="date" className={`${input} w-auto py-1`} value={period.from} onChange={event => setPeriod(current => ({ ...current, from: event.target.value }))} /></label>
            <label className="flex items-center gap-1 text-xs text-[var(--app-muted)]">{t("ถึง", "To")}
              <input type="date" className={`${input} w-auto py-1`} value={period.to} onChange={event => setPeriod(current => ({ ...current, to: event.target.value }))} /></label>
            {result?.summary ? <span className="text-xs text-[var(--app-muted)]">
              {Number(result.summary.cases ?? 0).toLocaleString()} {t("เคส", "cases")} · {Number(result.summary.patients ?? 0).toLocaleString()} {t("ผู้ป่วย", "patients")}
            </span> : null}
            {running ? <span className="text-xs text-[var(--app-accent)]">{t("กำลังคำนวณ…", "Running…")}</span> : null}
          </div>
          {issues.length ? <ul className="space-y-1">{issues.map((issue, index) => <li key={index}>
            <button type="button" className="text-left text-xs text-rose-600 hover:underline dark:text-rose-300" onClick={() => issue.slot && setSelection(issue.slot)}>⚠ {tr(lang, issue.th, issue.en)}</button>
          </li>)}</ul> : null}
          {runError ? <div className="rounded-lg border border-rose-500/40 bg-rose-500/10 px-3 py-2 text-xs text-rose-600 dark:text-rose-300">{runError}</div> : null}
          {result && !issues.length ? <div className={running ? "opacity-60 transition-opacity" : ""}>
            <ResultView lang={lang} result={result} sort={spec.sort} onSort={sortBy} onPage={setPage} />
          </div> : null}
        </div>
      </div>

      <aside className={`${panel} max-h-[calc(100vh-120px)] overflow-y-auto p-2 xl:sticky xl:top-2`}>
        <Inspector lang={lang} spec={spec} meta={draft.meta} selection={selection} fields={fieldMap} online
          onSpec={commit} onMeta={meta => setDraft(current => current && { ...current, meta })}
          onRemove={slot => { commit(removeItem(spec, slot)); setSelection(null); }} onDeselect={() => setSelection(null)} />
      </aside>
    </div> : null}
  </div>;
}

function Palette({ lang, fields, view, onAdd, onDrag }: { lang: Lang; fields: CatalogField[]; view: StudioSpec["view"]; onAdd: (field: CatalogField) => void; onDrag: (item: DragItem | null) => void }) {
  const t = (th: string, en: string) => tr(lang, th, en);
  const [query, setQuery] = useState("");
  const sections = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const groups = new Map<string, CatalogField[]>();
    for (const field of fields) {
      if (needle && !`${field.label} ${field.description} ${field.section}`.toLowerCase().includes(needle)) continue;
      groups.set(field.section, [...(groups.get(field.section) ?? []), field]);
    }
    return [...groups.entries()];
  }, [fields, query]);
  const start = (field: CatalogField) => (event: DragEvent) => {
    onDrag({ kind: "field", fieldId: field.id });
    event.dataTransfer.effectAllowed = "copy";
    event.dataTransfer.setData(DRAG_MIME, field.id);
    event.dataTransfer.setData("text/plain", field.label);
  };
  const tile = "flex w-full cursor-grab items-center gap-2 rounded-lg border border-[var(--app-border)] bg-[var(--app-panel-bg)] px-2 py-1.5 text-left text-xs hover:border-[var(--app-accent)] active:cursor-grabbing";
  return <aside className={`${panel} max-h-72 space-y-3 overflow-y-auto p-2 xl:sticky xl:top-2 xl:max-h-[calc(100vh-120px)]`}>
    <p className="text-[11px] text-[var(--app-muted)]">{t("ลากฟิลด์ไปวางในช่องตรงกลาง หรือคลิกเพื่อเพิ่ม", "Drag a field onto a box in the middle, or click to add it")}</p>
    <input className={input} placeholder={t("ค้นหาฟิลด์…", "Search fields…")} value={query} onChange={event => setQuery(event.target.value)} />
    {sections.map(([section, items]) => <div key={section}>
      <div className="mb-1 text-[11px] font-bold uppercase tracking-[0.12em] text-[var(--app-muted)]">{section}</div>
      <div className="space-y-1">
        {items.map(field => <button key={field.id} type="button" draggable className={tile} onDragStart={start(field)} onDragEnd={() => onDrag(null)}
          onClick={() => onAdd(field)} title={field.description} disabled={!defaultShelf(field, view)}>
          <span className="w-5 shrink-0 text-center font-mono text-[11px] text-[var(--app-accent)]">{TYPE_ICON[field.data_type] ?? "•"}</span>
          <span className="min-w-0 flex-1"><span className="block truncate font-semibold text-[var(--app-text)]">{field.label}</span>
            <span className="block truncate text-[10px] text-[var(--app-muted)]">{field.description}</span></span>
          {field.cardinality === "multi" ? <span className="rounded bg-[var(--app-control-bg)] px-1 text-[9px] font-bold text-[var(--app-muted)]" title={t("หลายค่าต่อเคส", "Several values per case")}>1:n</span> : null}
        </button>)}
      </div>
    </div>)}
    {!sections.length ? <div className="py-6 text-center text-xs text-[var(--app-muted)]">{t("ไม่พบฟิลด์", "No fields found")}</div> : null}
  </aside>;
}

const SHELF_COPY: Record<Shelf, { th: string; en: string; hintTh: string; hintEn: string }> = {
  filters: { th: "ตัวกรอง", en: "Filters", hintTh: "เลือกเฉพาะเคสที่ตรงทุกเงื่อนไข", hintEn: "Only cases matching every condition" },
  columns: { th: "คอลัมน์", en: "Columns", hintTh: "ฟิลด์ที่แสดงในแต่ละแถว", hintEn: "Fields shown on each row" },
  groups: { th: "จัดกลุ่มตาม", en: "Group by", hintTh: "แต่ละแถวคือหนึ่งกลุ่ม (ไม่เกิน 3)", hintEn: "Each row is one group (up to 3)" },
  measures: { th: "สถิติ", en: "Statistics", hintTh: "ลากฟิลด์ตัวเลขมาเพื่อหาค่าเฉลี่ย มัธยฐาน ฯลฯ", hintEn: "Drop a number field for average, median and more" },
};

function chipText(lang: Lang, shelf: Shelf, item: Record<string, unknown>, field: CatalogField | undefined): { main: string; sub: string } {
  const name = String(item.label || field?.label || item.field || "");
  if (shelf === "filters") {
    const op = OPERATORS[String(item.op)];
    const value = item.value;
    const shown = Array.isArray(value) ? value.filter(part => String(part ?? "") !== "").join(String(item.op) === "between" ? " – " : ", ") : String(value ?? "");
    return { main: field?.label ?? String(item.field), sub: `${op ? tr(lang, ...op) : String(item.op)}${shown ? ` ${shown.length > 40 ? `${shown.slice(0, 40)}…` : shown}` : ""}` };
  }
  if (shelf === "groups") return { main: name, sub: item.bucket ? tr(lang, ...BUCKETS[item.bucket as keyof typeof BUCKETS]) : "" };
  if (shelf === "measures") {
    const agg = AGGREGATES[item.agg as Aggregate];
    return { main: String(item.label || (agg ? tr(lang, ...agg) : String(item.agg))), sub: field ? field.label : "" };
  }
  return { main: name, sub: "" };
}

function ShelfZone({ lang, shelf, spec, fields, selection, dragField, getDrag, setDrag, onDrop, onSelect, onRemove, extra }: {
  lang: Lang; shelf: Shelf; spec: StudioSpec; fields: Map<string, CatalogField>; selection: Slot | null; dragField: CatalogField | undefined;
  getDrag: () => DragItem | null; setDrag: (item: DragItem | null) => void; onDrop: (item: DragItem, to: Slot) => void;
  onSelect: (slot: Slot) => void; onRemove: (slot: Slot) => void; extra?: ReactNode;
}) {
  const copy = SHELF_COPY[shelf];
  const items = spec[shelf] as Array<Record<string, unknown>>;
  const [target, setTarget] = useState<number | null>(null);
  const accepts = (item: DragItem | null) => {
    if (!item) return false;
    if (item.kind === "field") { const field = fields.get(item.fieldId); return Boolean(field && canDrop(field, shelf)); }
    if (item.from.shelf === shelf) return true;
    const source = (spec[item.from.shelf] as Array<Record<string, unknown>>)[item.from.index];
    const field = source && typeof source.field === "string" ? fields.get(source.field) : undefined;
    return Boolean(field && canDrop(field, shelf));
  };
  const blocked = dragField && !canDrop(dragField, shelf);
  return <div
    className={`rounded-xl border-2 border-dashed p-2 transition-colors ${target !== null ? "border-[var(--app-accent)] bg-[var(--app-hover-bg)]" : blocked ? "border-[var(--app-border)] opacity-50" : "border-[var(--app-border)]"}`}
    onDragOver={event => {
      if (!accepts(getDrag())) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = getDrag()?.kind === "chip" ? "move" : "copy";
      if (event.target === event.currentTarget) setTarget(items.length);
    }}
    onDragLeave={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setTarget(null); }}
    onDrop={event => {
      event.preventDefault();
      const item = getDrag();
      const index = target ?? items.length;
      setTarget(null);
      setDrag(null);
      if (item && accepts(item)) onDrop(item, { shelf, index });
    }}>
    <div className="mb-1.5 flex flex-wrap items-baseline gap-2">
      <span className="text-[11px] font-bold uppercase tracking-[0.12em] text-[var(--app-text)]">{tr(lang, copy.th, copy.en)}</span>
      <span className="text-[11px] text-[var(--app-muted)]">{tr(lang, copy.hintTh, copy.hintEn)}</span>
    </div>
    <div className="flex min-h-[38px] flex-wrap items-center gap-1.5" onDragOver={event => { if (event.target === event.currentTarget && accepts(getDrag())) setTarget(items.length); }}>
      {items.map((item, index) => {
        const field = typeof item.field === "string" ? fields.get(item.field) : undefined;
        const text = chipText(lang, shelf, item, field);
        const selected = selection?.shelf === shelf && selection.index === index;
        return <div key={`${index}:${String(item.field ?? item.agg)}`} className="flex items-center">
          {target === index ? <span className="mr-1 h-7 w-0.5 rounded bg-[var(--app-accent)]" /> : null}
          <div draggable role="button" tabIndex={0}
            onDragStart={event => { setDrag({ kind: "chip", from: { shelf, index } }); event.dataTransfer.effectAllowed = "move"; event.dataTransfer.setData(DRAG_MIME, `${shelf}:${index}`); event.stopPropagation(); }}
            onDragEnd={() => setDrag(null)}
            onDragOver={event => {
              if (!accepts(getDrag())) return;
              event.preventDefault();
              event.stopPropagation();
              const box = event.currentTarget.getBoundingClientRect();
              setTarget(event.clientX < box.left + box.width / 2 ? index : index + 1);
            }}
            onClick={() => onSelect({ shelf, index })}
            onKeyDown={event => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); onSelect({ shelf, index }); } if (event.key === "Delete" || event.key === "Backspace") onRemove({ shelf, index }); }}
            className={`group flex max-w-[280px] cursor-grab items-center gap-1.5 rounded-lg border px-2 py-1 text-xs active:cursor-grabbing ${selected ? "border-[var(--app-accent)] bg-[var(--app-hover-bg)] ring-1 ring-[var(--app-accent)]" : "border-[var(--app-border)] bg-[var(--app-panel-bg)] hover:border-[var(--app-accent)]"}`}>
            <span className="font-mono text-[10px] text-[var(--app-accent)]">{field ? TYPE_ICON[field.data_type] ?? "•" : "Σ"}</span>
            <span className="min-w-0"><span className="block truncate font-semibold text-[var(--app-text)]">{text.main}</span>
              {text.sub ? <span className="block truncate text-[10px] text-[var(--app-muted)]">{text.sub}</span> : null}</span>
            <button type="button" aria-label="Remove" className="ml-0.5 rounded px-1 text-[var(--app-muted)] hover:bg-rose-500/15 hover:text-rose-600" onClick={event => { event.stopPropagation(); onRemove({ shelf, index }); }}>×</button>
          </div>
        </div>;
      })}
      {target === items.length ? <span className="h-7 w-0.5 rounded bg-[var(--app-accent)]" /> : null}
      {!items.length && target === null ? <span className="text-[11px] italic text-[var(--app-muted)]">{tr(lang, "ลากฟิลด์มาวางที่นี่", "Drop fields here")}</span> : null}
    </div>
    {extra ? <div className="mt-1.5">{extra}</div> : null}
  </div>;
}

function StartScreen({ lang, saved, onNew, onTemplate, onOpen }: {
  lang: Lang; saved: ReportDefinition[]; onNew: (kind: StudioSpec["view"]) => void; onTemplate: (template: typeof TEMPLATES[number]) => void; onOpen: (row: ReportDefinition) => void;
}) {
  const t = (th: string, en: string) => tr(lang, th, en);
  const card = "rounded-xl border border-[var(--app-border)] bg-[var(--app-panel-bg)] p-3 text-left hover:border-[var(--app-accent)]";
  return <div className="space-y-4">
    <section className="space-y-2">
      <div className="text-[11px] font-bold uppercase tracking-[0.12em] text-[var(--app-muted)]">{t("เริ่มรายงานใหม่", "Start a new report")}</div>
      <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
        <button type="button" className={card} onClick={() => onNew("stats")}>
          <div className="text-sm font-semibold text-[var(--app-text)]">Σ {t("รายงานสถิติ", "Statistics report")}</div>
          <div className="text-xs text-[var(--app-muted)]">{t("นับ เฉลี่ย มัธยฐาน แยกตามกลุ่ม", "Counts, averages and medians by group")}</div>
        </button>
        <button type="button" className={card} onClick={() => onNew("list")}>
          <div className="text-sm font-semibold text-[var(--app-text)]">☰ {t("รายการเคส", "Case list")}</div>
          <div className="text-xs text-[var(--app-muted)]">{t("หนึ่งแถวต่อเคส เลือกคอลัมน์เอง", "One row per case with the columns you choose")}</div>
        </button>
      </div>
    </section>
    <section className="space-y-2">
      <div className="text-[11px] font-bold uppercase tracking-[0.12em] text-[var(--app-muted)]">{t("แม่แบบ", "Templates")}</div>
      <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
        {TEMPLATES.map(template => <button key={template.id} type="button" className={card} onClick={() => onTemplate(template)}>
          <div className="text-sm font-semibold text-[var(--app-text)]">{tr(lang, template.th, template.en)}</div>
          <div className="text-xs text-[var(--app-muted)]">{tr(lang, template.hintTh, template.hintEn)}</div>
        </button>)}
      </div>
    </section>
    <section className="space-y-2">
      <div className="text-[11px] font-bold uppercase tracking-[0.12em] text-[var(--app-muted)]">{t("รายงานที่สร้างไว้", "Your reports")}</div>
      {saved.length ? <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
        {saved.map(row => <button key={row.id} type="button" className={card} onClick={() => onOpen(row)}>
          <div className="truncate text-sm font-semibold text-[var(--app-text)]">{row.title}</div>
          <div className="truncate text-xs text-[var(--app-muted)]">{row.description || row.id}</div>
          <div className="mt-1 text-[10px] text-[var(--app-muted)]">{row.created_by ? `${row.created_by} · ` : ""}{new Date(row.updated_at).toLocaleDateString()}</div>
        </button>)}
      </div> : <div className="rounded-xl border border-dashed border-[var(--app-border)] p-6 text-center text-xs text-[var(--app-muted)]">{t("ยังไม่มีรายงานที่สร้างใน Report Studio", "No Report Studio reports yet.")}</div>}
    </section>
  </div>;
}
