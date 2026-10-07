/**
 * Drag & drop form designer (no code): start from a template or an existing form, drag fields and ready-made
 * blocks onto the page, set everything in plain-language panels, try the form, print it on A4, then save and
 * publish it for data entry. The result is an ordinary flora.form/1 definition, checked live by the same validator
 * the server uses; publishing a changed form adds the migration that keeps earlier records readable.
 */
import { useEffect, useMemo, useRef, useState, type DragEvent } from "react";
import { FormDevError, type FontEntry, type FormDefinition, type FormSummary, type Issue, type RecordData, type SchemaVersion, type StyleEntry } from "../core/types";
import { describeIssues, issueText, parseJsonStrict, validateDefinition } from "../core/validate";
import type { RestApiAdapter } from "../data/RestApiAdapter";
import { evaluateRecord } from "../logic/evaluate";
import { lookupIds, type LookupTables } from "../logic/lookup";
import { DEFAULT_FONTS, DEFAULT_STYLES } from "../registry/defaults";
import PdfPreview from "../ui/PdfPreview";
import FormRenderer from "../ui/FormRenderer";
import Canvas from "./Canvas";
import { BLOCKS, PALETTE, STARTERS, langOf, paletteField, starterForm, tr, type Lang } from "./catalog";
import ContainerInspector from "./ContainerInspector";
import { DRAG_MIME, type DragItem, type DropTarget } from "./drag";
import FieldInspector from "./FieldInspector";
import { useHistory } from "./history";
import {
  allFields, at, buildMigration, duplicateField, fieldAt, fieldRefOfIssuePath, insertAt, insertFields, moveAt, moveField, movedRef, newCategory, newSection, placeOnGrid,
  publishedKeys, removeAt, removeField, slug, usedNames, type FieldRef, type Path, type Selection,
} from "./model";
import type { LookupInfo } from "./OptionsEditor";
import { danger, input, panel, primary, secondary, small } from "./styles";

/** onPublished: the form was published (refresh the local catalogue); onUse: open data entry for it. */
type Props = { remote: RestApiAdapter; online: boolean; language?: string; onPublished?: (formId: string) => void; onUse?: (formId: string) => void };
/** Where the form stands on the server: not created yet, a draft version, or a published version (edits become the next version). */
type Source = { exists: boolean; version: number; status: "draft" | "published" | null; previous: FormDefinition | null };
type View = "design" | "try" | "print" | "json";
type Device = "desktop" | "tablet" | "mobile";

const AUTOSAVE = "formdev.designer.autosave.v1";
const NEW_SOURCE: Source = { exists: false, version: 0, status: null, previous: null };

function readAutosave(): { definition: FormDefinition; source: Source; at: number } | null {
  try {
    const raw = localStorage.getItem(AUTOSAVE);
    return raw ? JSON.parse(raw) as { definition: FormDefinition; source: Source; at: number } : null;
  } catch {
    return null;
  }
}
function writeAutosave(value: { definition: FormDefinition; source: Source; at: number } | null) {
  try {
    if (value) localStorage.setItem(AUTOSAVE, JSON.stringify(value));
    else localStorage.removeItem(AUTOSAVE);
  } catch {
    // Browser storage is a convenience only.
  }
}

const selectionKey = (selection: Selection) => (selection.kind === "form" ? "form" : selection.kind === "field" ? JSON.stringify(selection.ref) : JSON.stringify(selection.path));

const targetVersion = (source: Source) => (!source.exists ? 1 : source.status === "draft" ? source.version : source.version + 1);

/** The definition as it will be stored: its version number and, from version 2 on, the migration from the published version. */
function prepared(definition: FormDefinition, source: Source): FormDefinition {
  const version = targetVersion(source);
  const out: FormDefinition = { ...definition, schema_version: version };
  if (source.previous && version > 1) out.migration = buildMigration(source.previous, out);
  else delete out.migration;
  return out;
}

const newFormId = () => `form_${new Date().toISOString().slice(0, 10).replace(/-/g, "")}_${Math.random().toString(36).slice(2, 5)}`;

export default function DesignerPanel({ remote, online, language = "th", onPublished, onUse }: Props) {
  const lang = langOf(language);
  const t = (th: string, en: string) => tr(lang, th, en);
  const history = useHistory();
  const definition = history.definition;
  const [source, setSource] = useState<Source>(NEW_SOURCE);
  const [selection, setSelection] = useState<Selection>({ kind: "form" });
  const [view, setView] = useState<View>("design");
  const [device, setDevice] = useState<Device>("desktop");
  const [message, setMessage] = useState<{ tone: "ok" | "error" | "info"; text: string; use?: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [registry, setRegistry] = useState<{ styles: StyleEntry[]; fonts: FontEntry[] }>({ styles: DEFAULT_STYLES, fonts: DEFAULT_FONTS });
  const [lookups, setLookups] = useState<LookupInfo[]>([]);
  const [tables, setTables] = useState<LookupTables>({});
  const [tryData, setTryData] = useState<RecordData>({});
  const [showIssues, setShowIssues] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const dragRef = useRef<DragItem | null>(null);
  const getDrag = () => dragRef.current;
  const setDrag = (item: DragItem | null) => { dragRef.current = item; };

  // Registry and lookup tables from the server when it is reachable (bundled registry otherwise).
  useEffect(() => {
    if (!online) return;
    let live = true;
    void Promise.all([remote.listStyles(), remote.listFonts(), remote.listLookups().catch(() => [])]).then(([styles, fonts, rows]) => {
      if (!live) return;
      if (styles.length) setRegistry({ styles, fonts });
      setLookups(rows as LookupInfo[]);
    }).catch(() => undefined);
    return () => { live = false; };
  }, [remote, online]);

  // Tables the form reads, for "try it" and print.
  const usedTables = useMemo(() => (definition ? [...lookupIds(definition)].sort().join(",") : ""), [definition]);
  useEffect(() => {
    if (!online || !usedTables) return;
    let live = true;
    void Promise.all(usedTables.split(",").map(id => remote.getLookup(id).catch(() => null))).then(rows => {
      if (live) setTables(Object.fromEntries(rows.filter(row => row !== null).map(row => [row!.lookup_id, row!.entries])));
    });
    return () => { live = false; };
  }, [remote, online, usedTables]);

  // Keyboard: undo / redo outside text inputs.
  const { undo, redo } = history;
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT")) return;
      if (!(event.metaKey || event.ctrlKey)) return;
      if (event.key.toLowerCase() === "z") { event.preventDefault(); if (event.shiftKey) redo(); else undo(); }
      else if (event.key.toLowerCase() === "y") { event.preventDefault(); redo(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [undo, redo]);

  const checkIssues = useMemo(() => {
    if (!definition) return [];
    const found = validateDefinition(prepared(definition, source), registry.styles.map(row => row.style_id), registry.fonts.map(row => row.font_id));
    return describeIssues(definition, found) as Array<Issue & { location?: string }>;
  }, [definition, source, registry]);

  const commit = (next: FormDefinition, mergeKey: string | null = null) => {
    history.commit(next, mergeKey);
    writeAutosave({ definition: next, source, at: Date.now() });
  };
  const open = (next: FormDefinition, nextSource: Source) => {
    history.reset(next);
    setSource(nextSource);
    setSelection({ kind: "form" });
    setView("design");
    setTryData({});
    setMessage(null);
    writeAutosave({ definition: next, source: nextSource, at: Date.now() });
  };

  if (!definition) return <StartScreen lang={lang} remote={remote} online={online} onOpen={open} />;

  // Editing ----------------------------------------------------------------------------------------
  const lastList = (): Path => {
    const last = definition.sections.length - 1;
    return ["sections", last, "fields"];
  };
  /** Where a palette click adds: after the selected field, into the selected section / category, or at the end. */
  const clickTarget = (): DropTarget => {
    if (selection.kind === "field") return { list: selection.ref.list, index: selection.ref.index + 1, col: null };
    if (selection.kind === "section" || selection.kind === "category") {
      const list = [...selection.path, "fields"];
      return { list, index: ((at(definition, list) as unknown[]) ?? []).length, col: null };
    }
    const list = lastList();
    return { list, index: ((at(definition, list) as unknown[]) ?? []).length, col: null };
  };

  const drop = (item: DragItem, target: DropTarget) => {
    let next = definition;
    let ref: FieldRef = { list: target.list, index: target.index };
    if (item.kind === "new") {
      next = insertFields(definition, target.list, target.index, [paletteField(item.type, usedNames(definition), lang)]);
    } else if (item.kind === "block") {
      const block = BLOCKS.find(entry => entry.id === item.id);
      if (!block) return;
      const built = block.build(usedNames(definition), lang);
      next = insertFields(definition, target.list, target.index, built.fields);
      if (built.calculators.length) next = { ...next, calculators: [...(next.calculators ?? []), ...built.calculators] };
      commit(next);
      setSelection({ kind: "field", ref });
      if (block.needsLookup && !lookups.some(row => row.lookup_id === block.needsLookup)) {
        setMessage({ tone: "info", text: t(`บล็อกนี้ใช้ตารางอ้างอิง "${block.needsLookup}" ซึ่งต้องมีในเซิร์ฟเวอร์`, `This block reads the lookup table "${block.needsLookup}", which must exist on the server`) });
      }
      return;
    } else {
      next = moveField(definition, item.ref, target.list, target.index);
      if (next === definition) return;
      ref = movedRef(item.ref, target.list, target.index);
    }
    next = placeOnGrid(next, ref, { col: target.col }, device === "tablet" ? "tablet" : "desktop");
    commit(next);
    setSelection({ kind: "field", ref });
  };

  const fieldAction = (ref: FieldRef, action: "up" | "down" | "duplicate" | "remove") => {
    if (action === "up") { commit(moveField(definition, ref, ref.list, ref.index - 1)); setSelection({ kind: "field", ref: { ...ref, index: ref.index - 1 } }); }
    if (action === "down") { commit(moveField(definition, ref, ref.list, ref.index + 2)); setSelection({ kind: "field", ref: { ...ref, index: ref.index + 1 } }); }
    if (action === "duplicate") { commit(duplicateField(definition, ref, t(" (สำเนา)", " (copy)"))); setSelection({ kind: "field", ref: { ...ref, index: ref.index + 1 } }); }
    if (action === "remove") {
      const label = fieldAt(definition, ref)?.label ?? "";
      commit(removeField(definition, ref));
      setSelection({ kind: "form" });
      setMessage({ tone: "info", text: t(`ลบ "${label}" แล้ว — กด เลิกทำ (Ctrl+Z) เพื่อนำกลับ`, `Deleted "${label}" — Undo (Ctrl+Z) brings it back`) });
    }
  };
  const sectionAction = (path: Path, action: "up" | "down" | "remove" | "add_category") => {
    const listPath = path.slice(0, -1);
    const index = path[path.length - 1] as number;
    if (action === "up" || action === "down") {
      const to = action === "up" ? index - 1 : index + 1;
      commit(moveAt(definition, listPath, index, to));
      setSelection({ kind: listPath[listPath.length - 1] === "categories" ? "category" : "section", path: [...listPath, to] });
    }
    if (action === "remove") {
      commit(removeAt(definition, listPath, index));
      setSelection({ kind: "form" });
      setMessage({ tone: "info", text: t("ลบแล้ว — กด เลิกทำ (Ctrl+Z) เพื่อนำกลับ", "Deleted — Undo (Ctrl+Z) brings it back") });
    }
    if (action === "add_category") {
      const used = usedNames(definition);
      const category = newCategory(used, t("หมวดย่อยใหม่", "New category"), paletteField("text", used, lang));
      const count = ((at(definition, [...path, "categories"]) as unknown[]) ?? []).length;
      commit(insertAt(definition, [...path, "categories"], count, category));
      setSelection({ kind: "category", path: [...path, "categories", count] });
    }
  };
  const addSection = () => {
    const used = usedNames(definition);
    const section = newSection(used, t(`ส่วนที่ ${definition.sections.length + 1}`, `Section ${definition.sections.length + 1}`));
    section.fields.push(paletteField("text", used, lang));
    commit(insertAt(definition, ["sections"], definition.sections.length, section));
    setSelection({ kind: "section", path: ["sections", definition.sections.length] });
  };

  // Saving -----------------------------------------------------------------------------------------
  const failure = (error: unknown) => {
    if (error instanceof FormDevError && Array.isArray(error.details)) {
      const lines = (error.details as Array<Issue | string>).map(item => (typeof item === "string" ? item : issueText(item, language)));
      return `${error.message}: ${lines.slice(0, 5).join("; ")}`;
    }
    return error instanceof Error ? error.message : String(error);
  };
  const save = async (): Promise<{ definition: FormDefinition; source: Source } | null> => {
    if (checkIssues.length) {
      setShowIssues(true);
      setMessage({ tone: "error", text: t(`ยังมี ${checkIssues.length} จุดที่ต้องแก้ก่อนบันทึก`, `${checkIssues.length} problem(s) to fix before saving`) });
      return null;
    }
    const body = prepared(definition, source);
    if (!source.exists) await remote.createForm(body);
    else await remote.saveDraft(body);
    const next: Source = { ...source, exists: true, version: body.schema_version, status: "draft" };
    setSource(next);
    writeAutosave(null);
    return { definition: body, source: next };
  };
  const run = async (action: "save" | "publish") => {
    if (!online) { setMessage({ tone: "error", text: t("ต้องเชื่อมต่อเซิร์ฟเวอร์เพื่อบันทึก (งานที่ทำถูกเก็บไว้ในเครื่องนี้แล้ว)", "Saving needs the server (your work is kept on this device)") }); return; }
    setConfirming(false);
    setBusy(true);
    try {
      const saved = await save();
      if (!saved) return;
      if (action === "save") { setMessage({ tone: "ok", text: t(`บันทึกร่างเวอร์ชัน ${saved.definition.schema_version} แล้ว`, `Draft version ${saved.definition.schema_version} saved`) }); return; }
      await remote.publish(saved.definition.form_id, saved.definition.schema_version);
      setSource({ exists: true, version: saved.definition.schema_version, status: "published", previous: saved.definition });
      setMessage({ tone: "ok", text: t(`เผยแพร่เวอร์ชัน ${saved.definition.schema_version} แล้ว พร้อมใช้กรอกข้อมูล`, `Version ${saved.definition.schema_version} is published and ready for data entry`), use: saved.definition.form_id });
      onPublished?.(saved.definition.form_id);
    } catch (error) {
      setMessage({ tone: "error", text: failure(error) });
    } finally {
      setBusy(false);
    }
  };

  const pdf = async () => {
    setBusy(true);
    try {
      const { buildFormPdf, downloadPdf } = await import("../render/formPdf");
      downloadPdf(await buildFormPdf({ definition, value: tryData, styles: registry.styles, fonts: registry.fonts, lookups: tables, language }), `${definition.form_id}-preview.pdf`);
    } catch (error) {
      setMessage({ tone: "error", text: failure(error) });
    } finally {
      setBusy(false);
    }
  };

  // Layout -----------------------------------------------------------------------------------------
  const versionLabel = source.exists
    ? source.status === "draft" ? t(`ร่างเวอร์ชัน ${source.version}`, `draft v${source.version}`) : t(`แก้ไขเป็นเวอร์ชัน ${source.version + 1} (v${source.version} ใช้งานอยู่)`, `editing v${source.version + 1} (v${source.version} is live)`)
    : t("ยังไม่ได้บันทึก", "not saved yet");
  const recordIssues = view === "try" ? evaluateRecord(definition, tryData, "submitted", undefined, tables).issues : [];
  const width = device === "desktop" ? "100%" : device === "tablet" ? "768px" : "390px";
  const migration = source.previous ? buildMigration(source.previous, prepared(definition, source)) : null;

  return <div className="space-y-3">
    <div className={`${panel} flex flex-wrap items-center gap-2 p-2`}>
      <button type="button" className={small} title={t("งานที่ยังไม่บันทึกกู้คืนได้จากหน้าเริ่มต้น", "Unsaved work can be restored from the start screen")} onClick={() => history.reset(null)}>
        ← {t("แบบฟอร์มอื่น", "Other forms")}
      </button>
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-bold text-[var(--app-text)]">{definition.title}</div>
        <div className="text-[11px] text-[var(--app-muted)]"><code>{definition.form_id}</code> · {versionLabel}</div>
      </div>
      <button type="button" className={small} disabled={!history.canUndo} onClick={history.undo} title="Ctrl+Z">↶ {t("เลิกทำ", "Undo")}</button>
      <button type="button" className={small} disabled={!history.canRedo} onClick={history.redo} title="Ctrl+Shift+Z">↷ {t("ทำซ้ำ", "Redo")}</button>
      <div className="flex rounded-lg border border-[var(--app-border)] p-0.5">
        {([["design", t("ออกแบบ", "Design")], ["try", t("ทดลองกรอก", "Try it")], ["print", "A4"], ["json", "JSON"]] as Array<[View, string]>).map(([id, text]) =>
          <button key={id} type="button" onClick={() => setView(id)} className={`rounded-md px-2.5 py-1 text-xs font-bold ${view === id ? "bg-[var(--app-accent)] text-[var(--app-accent-contrast)]" : "text-[var(--app-muted)]"}`}>{text}</button>)}
      </div>
      {view === "design" || view === "try" ? <div className="flex rounded-lg border border-[var(--app-border)] p-0.5" aria-label={t("ขนาดจอ", "Screen size")}>
        {([["desktop", "🖥", t("คอมพิวเตอร์", "Desktop")], ["tablet", "▭", t("แท็บเล็ต", "Tablet")], ["mobile", "📱", t("มือถือ", "Phone")]] as Array<[Device, string, string]>).map(([id, icon, text]) =>
          <button key={id} type="button" title={text} onClick={() => setDevice(id)} className={`rounded-md px-2 py-1 text-xs ${device === id ? "bg-[var(--app-accent)] text-[var(--app-accent-contrast)]" : "text-[var(--app-muted)]"}`}>{icon}</button>)}
      </div> : null}
      <button type="button" onClick={() => setShowIssues(value => !value)}
        className={`rounded-lg px-2.5 py-1 text-xs font-bold ${checkIssues.length ? "bg-rose-500/15 text-rose-600 dark:text-rose-300" : "bg-emerald-500/15 text-emerald-600 dark:text-emerald-300"}`}>
        {checkIssues.length ? t(`⚠ ต้องแก้ ${checkIssues.length} จุด`, `⚠ ${checkIssues.length} to fix`) : t("✓ พร้อมใช้", "✓ Ready")}
      </button>
      <button type="button" className={secondary} disabled={busy} onClick={() => void run("save")}>{t("บันทึกร่าง", "Save draft")}</button>
      <button type="button" className={primary} disabled={busy} onClick={() => setConfirming(true)}>{t("เผยแพร่ใช้งาน", "Publish")}</button>
    </div>

    {confirming ? <div role="alertdialog" aria-label={t("ยืนยันการเผยแพร่", "Confirm publishing")} className="rounded-xl border border-[var(--app-accent)] bg-[var(--app-panel-bg)] p-3 text-sm text-[var(--app-text)]">
      <div className="font-semibold">{t(`เผยแพร่ "${definition.title}" เวอร์ชัน ${targetVersion(source)} ให้ใช้กรอกข้อมูล?`, `Publish "${definition.title}" version ${targetVersion(source)} for data entry?`)}</div>
      <p className="mt-1 text-xs text-[var(--app-muted)]">{t("เวอร์ชันที่เผยแพร่แล้วจะแก้ไขไม่ได้ ถ้าแก้ภายหลังระบบจะสร้างเวอร์ชันใหม่ และข้อมูลที่กรอกไว้แล้วยังเปิดดูได้ตามเดิม",
        "A published version cannot change; later edits become a new version and records already entered stay readable.")}</p>
      <div className="mt-2 flex gap-2">
        <button type="button" className={primary} disabled={busy} onClick={() => void run("publish")}>{t("ยืนยันเผยแพร่", "Publish now")}</button>
        <button type="button" className={secondary} onClick={() => setConfirming(false)}>{t("ยกเลิก", "Cancel")}</button>
      </div>
    </div> : null}

    {message ? <div className={`rounded-xl border px-3 py-2 text-sm ${message.tone === "error" ? "border-rose-500/40 bg-rose-500/10 text-rose-600 dark:text-rose-300"
      : message.tone === "ok" ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300" : "border-[var(--app-border)] bg-[var(--app-control-bg)] text-[var(--app-text)]"}`}>
      {message.text}
      {message.use && onUse ? <button type="button" className={`${small} ml-2`} onClick={() => onUse(message.use!)}>{t("ไปกรอกข้อมูลแบบฟอร์มนี้ →", "Fill in this form →")}</button> : null}
      <button type="button" className="ml-2 text-xs underline" onClick={() => setMessage(null)}>{t("ปิด", "dismiss")}</button>
    </div> : null}

    {showIssues && checkIssues.length ? <div className={`${panel} max-h-48 space-y-1 overflow-y-auto p-2`}>
      {checkIssues.map((item, index) => <button key={index} type="button" className="block w-full rounded-lg px-2 py-1 text-left text-xs hover:bg-[var(--app-control-bg)]"
        onClick={() => { const ref = fieldRefOfIssuePath(item.path); if (ref && fieldAt(definition, ref)) { setSelection({ kind: "field", ref }); setView("design"); } }}>
        <span className="font-semibold text-[var(--app-text)]">{item.location ?? item.path}</span> — <span className="text-rose-600 dark:text-rose-300">{issueText(item, language)}</span>
      </button>)}
    </div> : null}

    {migration && migration.ops.length ? <div className="rounded-xl border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
      {t("เมื่อเผยแพร่ ข้อมูลเดิมจะถูกปรับให้อัตโนมัติ: ", "On publish, earlier records are adjusted automatically: ")}
      {migration.ops.map(op => op.op === "rename_field" ? t(`เปลี่ยนชื่อ ${op.from} → ${op.to}`, `rename ${op.from} → ${op.to}`)
        : op.op === "remove_field" ? t(`เก็บค่าของ ${op.field} ไว้ในประวัติ (ไม่แสดงในฟอร์ม)`, `keep ${op.field} values aside (no longer shown)`)
        : op.op === "convert_type" ? t(`แปลงชนิดค่าของ ${op.field}`, `convert ${op.field}`) : op.op).join(" · ")}
    </div> : null}

    {view === "design" ? <div className="grid gap-3 xl:grid-cols-[230px_minmax(0,1fr)_340px]">
      <Palette lang={lang} setDrag={setDrag} onAdd={item => drop(item, clickTarget())} onAddSection={addSection} lookups={lookups} />
      <div className="min-w-0 rounded-2xl bg-[var(--app-bg)] p-1" onClick={() => setSelection({ kind: "form" })}>
        <div className="mx-auto transition-all" style={{ maxWidth: width }}>
          <Canvas definition={definition} lang={lang} mode={device} selection={selection} styleColumns={2} getDrag={getDrag} setDrag={setDrag}
            onSelect={setSelection} onDrop={drop} onFieldAction={fieldAction} onSectionAction={sectionAction}
            onResize={(ref, span) => commit(placeOnGrid(definition, ref, { span }, device === "tablet" ? "tablet" : "desktop"))} />
          <button type="button" className={`${secondary} mt-3 w-full border-dashed`} onClick={event => { event.stopPropagation(); addSection(); }}>+ {t("เพิ่มส่วนใหม่", "Add a section")}</button>
        </div>
      </div>
      <aside className={`${panel} max-h-[calc(100vh-120px)] overflow-y-auto p-2 xl:sticky xl:top-2`}>
        {selection.kind === "field" && fieldAt(definition, selection.ref)
          ? <FieldInspector key={JSON.stringify(selection.ref)} definition={definition} fieldRef={selection.ref} lang={lang} lookups={lookups} publishedKeys={publishedKeys(source.previous)}
              onChange={next => commit(next, `field:${JSON.stringify(selection.ref)}`)} />
          : <ContainerInspector key={selectionKey(selection)} definition={definition} lang={lang} styles={registry.styles}
              formIdEditable={!source.exists} target={selection.kind === "field" ? { kind: "form" } : selection}
              onChange={next => commit(next, `container:${selectionKey(selection)}`)} />}
      </aside>
    </div> : null}

    {view === "try" ? <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2 text-xs text-[var(--app-muted)]">
        {t("ลองกรอกเหมือนผู้ใช้จริง (ไม่บันทึกข้อมูล)", "Fill it in like a user would (nothing is saved)")}
        <button type="button" className={small} onClick={() => setTryData({})}>{t("ล้างค่า", "Clear")}</button>
        <span className={recordIssues.length ? "text-rose-600 dark:text-rose-300" : "text-emerald-600 dark:text-emerald-300"}>
          {recordIssues.length ? t(`ถ้ากดส่งตอนนี้จะติด ${recordIssues.length} จุด`, `${recordIssues.length} problem(s) if submitted now`) : t("ส่งได้", "Ready to submit")}
        </span>
      </div>
      <div className="mx-auto" style={{ maxWidth: width }}>
        <FormRenderer definition={definition} value={tryData} issues={recordIssues} mode={device} language={language} styles={registry.styles} fonts={registry.fonts} lookups={tables} onChange={setTryData} />
      </div>
    </div> : null}

    {view === "print" ? <div className="flex flex-wrap items-center gap-2 text-xs text-[var(--app-muted)]">
      <button type="button" className={small} disabled={busy} onClick={() => void pdf()}>⬇ {t("ดาวน์โหลด PDF", "Download PDF")}</button>
      {t("ค่าที่ลองกรอกในแท็บ \"ทดลองกรอก\" จะอยู่ใน PDF ด้วย", "Values typed in \"Try it\" are included")}
    </div> : null}
    {view === "print" ? <PdfPreview definition={definition} value={tryData} styles={registry.styles} fonts={registry.fonts} lookups={tables} language={lang} /> : null}

    {view === "json" ? <JsonView key={JSON.stringify(definition).length} definition={definition} lang={lang} onApply={next => commit(next)} /> : null}
  </div>;
}

function Palette({ lang, setDrag, onAdd, onAddSection, lookups }: {
  lang: Lang; setDrag: (item: DragItem | null) => void; onAdd: (item: DragItem) => void; onAddSection: () => void; lookups: LookupInfo[];
}) {
  const t = (th: string, en: string) => tr(lang, th, en);
  const start = (item: DragItem, text: string) => (event: DragEvent) => {
    setDrag(item);
    event.dataTransfer.effectAllowed = "copy";
    event.dataTransfer.setData(DRAG_MIME, text);
    event.dataTransfer.setData("text/plain", text);
  };
  const tile = "flex w-full cursor-grab items-center gap-2 rounded-lg border border-[var(--app-border)] bg-[var(--app-panel-bg)] px-2 py-1.5 text-left text-xs hover:border-[var(--app-accent)] active:cursor-grabbing";
  return <aside className={`${panel} max-h-72 space-y-3 overflow-y-auto p-2 xl:sticky xl:top-2 xl:max-h-[calc(100vh-120px)]`}>
    <p className="text-[11px] text-[var(--app-muted)]">{t("ลากไปวางบนหน้าฟอร์ม หรือคลิกเพื่อเพิ่มต่อจากช่องที่เลือก", "Drag onto the page, or click to add after the selected field")}</p>
    <div>
      <div className="mb-1 text-[11px] font-bold uppercase tracking-[0.12em] text-[var(--app-muted)]">{t("ชุดสำเร็จรูป", "Ready-made blocks")}</div>
      <div className="space-y-1">
        {BLOCKS.map(block => {
          const missing = block.needsLookup !== undefined && !lookups.some(row => row.lookup_id === block.needsLookup);
          return <button key={block.id} type="button" draggable className={tile} onDragStart={start({ kind: "block", id: block.id }, block.en)} onDragEnd={() => setDrag(null)}
            onClick={() => onAdd({ kind: "block", id: block.id })} title={tr(lang, block.hintTh, block.hintEn)}>
            <span className="w-5 text-center">{block.icon}</span>
            <span className="min-w-0"><span className="block font-semibold text-[var(--app-text)]">{tr(lang, block.th, block.en)}</span>
              <span className="block truncate text-[10px] text-[var(--app-muted)]">{missing ? t("ต้องมีตารางอ้างอิงในเซิร์ฟเวอร์", "needs a server lookup table") : tr(lang, block.hintTh, block.hintEn)}</span></span>
          </button>;
        })}
      </div>
    </div>
    {PALETTE.map(group => <div key={group.en}>
      <div className="mb-1 text-[11px] font-bold uppercase tracking-[0.12em] text-[var(--app-muted)]">{tr(lang, group.th, group.en)}</div>
      <div className="grid grid-cols-1 gap-1">
        {group.items.map(item => <button key={item.type} type="button" draggable className={tile} onDragStart={start({ kind: "new", type: item.type }, item.en)} onDragEnd={() => setDrag(null)}
          onClick={() => onAdd({ kind: "new", type: item.type })} title={tr(lang, item.hintTh, item.hintEn)}>
          <span className="w-5 text-center font-mono text-[11px]">{item.icon}</span>
          <span className="min-w-0"><span className="block font-semibold text-[var(--app-text)]">{tr(lang, item.th, item.en)}</span>
            <span className="block truncate text-[10px] text-[var(--app-muted)]">{tr(lang, item.hintTh, item.hintEn)}</span></span>
        </button>)}
      </div>
    </div>)}
    <button type="button" className={`${small} w-full`} onClick={onAddSection}>+ {t("เพิ่มส่วนใหม่", "Add a section")}</button>
  </aside>;
}

function StartScreen({ lang, remote, online, onOpen }: { lang: Lang; remote: RestApiAdapter; online: boolean; onOpen: (definition: FormDefinition, source: Source) => void }) {
  const t = (th: string, en: string) => tr(lang, th, en);
  const [title, setTitle] = useState(t("แบบฟอร์มใหม่", "New form"));
  const [formId, setFormId] = useState(newFormId);
  const [forms, setForms] = useState<FormSummary[] | null>(null);
  const [json, setJson] = useState("");
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(readAutosave);

  useEffect(() => {
    if (!online) return;
    let live = true;
    void remote.listForms().then(rows => { if (live) setForms(rows); }).catch(() => undefined);
    return () => { live = false; };
  }, [remote, online]);

  const openExisting = async (id: string) => {
    setError("");
    try {
      const versions: SchemaVersion[] = await remote.listSchemas(id);
      const latest = versions.reduce<SchemaVersion | null>((best, row) => (!best || row.schema_version > best.schema_version ? row : best), null);
      if (!latest) return;
      const published = versions.filter(row => row.status === "published").sort((a, b) => b.schema_version - a.schema_version)[0] ?? null;
      if (latest.status === "draft") onOpen(latest.definition, { exists: true, version: latest.schema_version, status: "draft", previous: published?.definition ?? null });
      else onOpen(latest.definition, { exists: true, version: latest.schema_version, status: "published", previous: latest.definition });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  };
  /** A new form laid out like an existing one (a user-made template): the copy gets the id and title above, as version 1. */
  const copyAsNew = async (id: string) => {
    setError("");
    try {
      const versions: SchemaVersion[] = await remote.listSchemas(id);
      const latest = versions.reduce<SchemaVersion | null>((best, row) => (!best || row.schema_version > best.schema_version ? row : best), null);
      if (!latest) return;
      const copy = structuredClone(latest.definition);
      delete copy.migration;
      onOpen({ ...copy, form_id: formId, title: title.trim() || copy.title, schema_version: 1 }, NEW_SOURCE);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  };
  const importJson = () => {
    const { value, issues } = parseJsonStrict(json);
    if (issues.some(item => item.code === "invalid_json") || typeof value !== "object" || value === null || !Array.isArray((value as FormDefinition).sections)) {
      setError(t("JSON ไม่ใช่แบบฟอร์ม flora.form/1", "This JSON is not a flora.form/1 form"));
      return;
    }
    onOpen(value as FormDefinition, NEW_SOURCE);
  };
  const validId = /^[a-z][a-z0-9_]{1,63}$/.test(formId);

  return <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
    <section className={`${panel} space-y-3 p-4`}>
      <h2 className="text-lg font-semibold text-[var(--app-text)]">{t("สร้างแบบฟอร์มใหม่", "Create a form")}</h2>
      <label className="block space-y-1"><span className="text-xs font-semibold text-[var(--app-muted)]">{t("ชื่อแบบฟอร์ม", "Title")}</span>
        <input className={input} value={title} onChange={event => { setTitle(event.target.value); const s = slug(event.target.value, ""); if (/^[\x20-\x7e]+$/.test(event.target.value) && s.length >= 2) setFormId(s); }} /></label>
      <label className="block space-y-1"><span className="text-xs font-semibold text-[var(--app-muted)]">{t("รหัสแบบฟอร์ม (ภาษาอังกฤษตัวเล็ก ใช้อ้างอิงในระบบ)", "Form id (lowercase, used by the system)")}</span>
        <input className={`${input} font-mono`} value={formId} onChange={event => setFormId(event.target.value.toLowerCase())} />
        {!validId ? <span className="text-[11px] text-rose-600 dark:text-rose-300">{t("ใช้ a-z ตัวเลข และ _ ขึ้นต้นด้วยตัวอักษร", "Use a-z, digits and _, starting with a letter")}</span> : null}
        {forms?.some(form => form.form_id === formId) ? <span className="text-[11px] text-rose-600 dark:text-rose-300">{t("มีรหัสนี้แล้ว", "This id is taken")}</span> : null}</label>
      <div className="grid gap-2 sm:grid-cols-3">
        {STARTERS.map(starter => <button key={starter.id} type="button" disabled={!validId || !title.trim() || forms?.some(form => form.form_id === formId)}
          className="rounded-xl border border-[var(--app-border)] bg-[var(--app-bg)] p-3 text-left hover:border-[var(--app-accent)] disabled:opacity-50"
          onClick={() => onOpen(starterForm(starter, formId, title.trim(), lang), NEW_SOURCE)}>
          <div className="text-2xl">{starter.icon}</div>
          <div className="mt-1 text-sm font-semibold text-[var(--app-text)]">{tr(lang, starter.th, starter.en)}</div>
          <div className="text-[11px] text-[var(--app-muted)]">{tr(lang, starter.hintTh, starter.hintEn)}</div>
        </button>)}
      </div>
      {saved ? <div className="rounded-xl border border-amber-500/40 bg-amber-500/10 p-3 text-sm">
        <div className="text-[var(--app-text)]">{t("มีงานที่ยังไม่ได้บันทึก:", "Unsaved work found:")} <b>{saved.definition.title}</b> ({new Date(saved.at).toLocaleString(lang === "th" ? "th-TH" : "en-GB")})</div>
        <div className="mt-2 flex gap-2">
          <button type="button" className={small} onClick={() => onOpen(saved.definition, saved.source)}>{t("ทำต่อ", "Continue")}</button>
          <button type="button" className={danger} onClick={() => { writeAutosave(null); setSaved(null); }}>{t("ทิ้ง", "Discard")}</button>
        </div>
      </div> : null}
    </section>

    <section className={`${panel} space-y-3 p-4`}>
      <h2 className="text-lg font-semibold text-[var(--app-text)]">{t("แก้ไขแบบฟอร์มที่มีอยู่", "Edit an existing form")}</h2>
      {!online ? <p className="text-sm text-[var(--app-muted)]">{t("ต้องเชื่อมต่อเซิร์ฟเวอร์", "Needs the server")}</p> : forms === null ? <p className="text-sm text-[var(--app-muted)]">…</p>
        : <div className="max-h-72 space-y-1 overflow-y-auto">
          {forms.map(form => <div key={form.form_id} className="flex items-stretch gap-1">
            <button type="button" className="min-w-0 flex-1 rounded-xl border border-[var(--app-border)] px-3 py-2 text-left hover:border-[var(--app-accent)]"
              onClick={() => void openExisting(form.form_id)}>
              <div className="text-sm font-semibold text-[var(--app-text)]">{form.title}</div>
              <div className="text-[11px] text-[var(--app-muted)]"><code>{form.form_id}</code> · v{form.latest_version}
                {form.published_version ? t(` · ใช้งาน v${form.published_version}`, ` · live v${form.published_version}`) : t(" · ยังไม่เผยแพร่", " · not published")}</div>
            </button>
            <button type="button" className={small} title={t("สร้างแบบฟอร์มใหม่ตามรูปแบบนี้ โดยใช้ชื่อและรหัสทางซ้าย", "Create a new form laid out like this one, with the title and id on the left")}
              disabled={!validId || forms.some(item => item.form_id === formId)} onClick={() => void copyAsNew(form.form_id)}>{t("ใช้เป็นแม่แบบ", "Use as template")}</button>
          </div>)}
          {!forms.length ? <p className="text-sm text-[var(--app-muted)]">{t("ยังไม่มีแบบฟอร์ม", "No forms yet")}</p> : null}
        </div>}
      <details>
        <summary className="cursor-pointer text-xs text-[var(--app-muted)]">{t("นำเข้าจาก JSON (สำหรับผู้ดูแลระบบ)", "Import JSON (administrators)")}</summary>
        <textarea className={`${input} mt-2 min-h-[120px] font-mono text-xs`} value={json} onChange={event => setJson(event.target.value)} />
        <button type="button" className={`${small} mt-1`} disabled={!json.trim()} onClick={importJson}>{t("เปิดในตัวออกแบบ", "Open in the designer")}</button>
      </details>
      {error ? <p className="text-sm text-rose-600 dark:text-rose-300">{error}</p> : null}
    </section>
  </div>;
}

function JsonView({ definition, lang, onApply }: { definition: FormDefinition; lang: Lang; onApply: (next: FormDefinition) => void }) {
  const t = (th: string, en: string) => tr(lang, th, en);
  const [text, setText] = useState(() => JSON.stringify(definition, null, 2));
  const [error, setError] = useState("");
  const apply = () => {
    const { value, issues } = parseJsonStrict(text);
    if (issues.length || typeof value !== "object" || value === null || !Array.isArray((value as FormDefinition).sections)) {
      setError(issues[0]?.message ?? t("ไม่ใช่แบบฟอร์ม", "Not a form"));
      return;
    }
    setError("");
    onApply(value as FormDefinition);
  };
  const fieldCount = allFields(definition).length;
  return <div className={`${panel} space-y-2 p-3`}>
    <p className="text-xs text-[var(--app-muted)]">{t(`สำหรับผู้ดูแลระบบ: แบบฟอร์มนี้คือ JSON ต่อไปนี้ (${fieldCount} ช่อง) แก้แล้วกด "ใช้ JSON นี้"`, `For administrators: this form as JSON (${fieldCount} fields); edit and apply`)}</p>
    <textarea className={`${input} min-h-[480px] font-mono text-xs`} value={text} onChange={event => setText(event.target.value)} spellCheck={false} />
    <div className="flex items-center gap-2">
      <button type="button" className={small} onClick={apply}>{t("ใช้ JSON นี้", "Apply this JSON")}</button>
      {error ? <span className="text-xs text-rose-600 dark:text-rose-300">{error}</span> : null}
    </div>
  </div>;
}

