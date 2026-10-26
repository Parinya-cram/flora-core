/**
 * Drag & drop form designer (no code): start from a template or an existing form, drag fields and ready-made
 * blocks onto the page, set everything in plain-language panels, try the form, print it on A4, then save and
 * publish it for data entry. The result is an ordinary flora.form/1 definition, checked live by the same validator
 * the server uses; publishing a changed form adds the migration that keeps earlier records readable.
 */
import { useEffect, useMemo, useRef, useState, type DragEvent } from "react";
import { FormDevError, type FontEntry, type FormDefinition, type FormSummary, type Issue, type RecordData, type SchemaVersion, type StyleEntry } from "../core/types";
import { describeIssues, issueText, paperSpec, parseJsonStrict, validateDefinition } from "../core/validate";
import type { RestApiAdapter } from "../data/RestApiAdapter";
import type { Template } from "../ai/types";
import { evaluateRecord } from "../logic/evaluate";
import { lookupIds, type LookupTables } from "../logic/lookup";
import { DEFAULT_FONTS, DEFAULT_STYLES } from "../registry/defaults";
import PdfPreview from "../ui/PdfPreview";
import { withSampleBlocks } from "../leaf/caseBlocks";
import FormRenderer from "../ui/FormRenderer";
import Canvas from "./Canvas";
import Finder, { type FinderPick } from "./Finder";
import IdCheck from "./IdCheck";
import AiPanel from "./AiPanel";
import type { IdFinding } from "../reading/types";
import { splitBilingual } from "../core/labels";
import { BLOCKS, PALETTE, STARTERS, langOf, paletteField, scaleSpans, starterForm, tr, type Lang } from "./catalog";
import ContainerInspector from "./ContainerInspector";
import { DRAG_MIME, type DragItem, type DropTarget } from "./drag";
import FieldInspector from "./FieldInspector";
import { useHistory } from "./history";
import {
  allFields, at, buildMigration, cellsOf, compactRows, duplicateField, fieldAt, fieldPath, fieldRefOfIssuePath, insertAt, insertFields, isPinned, listColumns, moveAt, moveField,
  movedRef, newCategory, newSection, patchField, placeAt, renameKey, placeOnGrid, publishedKeys, removeAt, removeField, samePath, slug, uniqueName, usedNames, type FieldRef, type Path, type Selection,
} from "./model";
import { formColumns } from "../core/layout";
import type { FieldDefinition, PaperConfig } from "../core/types";
import { fieldKey } from "../core/validate";
import type { LookupInfo } from "./OptionsEditor";
import { danger, input, panel, primary, secondary, small } from "./styles";

/** What another Form Studio tab asks the designer to open: a library template (saved back to the template) or a form. */
export type DesignerIncoming = { key: number } & ({ kind: "template"; template: Template } | { kind: "form"; formId: string }
  | { kind: "definition"; definition: FormDefinition; note?: string });
/** onPublished: the form was published (refresh the local catalogue); onUse: open data entry for it; onTemplateSaved: back to its review. */
type Props = {
  remote: RestApiAdapter; online: boolean; language?: string; onPublished?: (formId: string) => void; onUse?: (formId: string) => void;
  incoming?: DesignerIncoming | null; onTemplateSaved?: (templateId: string) => void;
  /** Reading paper or scanned documents into a form happens in the Documents tab. */
  onOpenDocuments?: () => void;
};
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

/** The latest version of a form and where it stands (a draft, or published: edits become the next version). */
async function loadForm(remote: RestApiAdapter, formId: string): Promise<{ definition: FormDefinition; source: Source } | null> {
  const versions: SchemaVersion[] = await remote.listSchemas(formId);
  const latest = versions.reduce<SchemaVersion | null>((best, row) => (!best || row.schema_version > best.schema_version ? row : best), null);
  if (!latest) return null;
  const published = versions.filter(row => row.status === "published").sort((a, b) => b.schema_version - a.schema_version)[0] ?? null;
  return latest.status === "draft"
    ? { definition: latest.definition, source: { exists: true, version: latest.schema_version, status: "draft", previous: published?.definition ?? null } }
    : { definition: latest.definition, source: { exists: true, version: latest.schema_version, status: "published", previous: latest.definition } };
}

const newFormId = () => `form_${new Date().toISOString().slice(0, 10).replace(/-/g, "")}_${Math.random().toString(36).slice(2, 5)}`;

export default function DesignerPanel({ remote, online, language = "th", onPublished, onUse, incoming, onTemplateSaved, onOpenDocuments }: Props) {
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
  const [paperInfo, setPaperInfo] = useState<{ pages: number; scale: number } | null>(null);
  const [showIssues, setShowIssues] = useState(false);
  const [confirming, setConfirming] = useState(false);
  /** Fields selected besides the primary selection (Shift / Ctrl / Cmd-click). */
  const [also, setAlso] = useState<FieldRef[]>([]);
  const [showGrid, setShowGrid] = useState(true);
  const [zoom, setZoom] = useState(100);
  const [searching, setSearching] = useState(false);
  const clipboard = useRef<FieldDefinition[] | null>(null);
  const [idFindings, setIdFindings] = useState<IdFinding[] | null>(null);
  const [idBusy, setIdBusy] = useState(false);
  const [aiOpen, setAiOpen] = useState(false);
  /** Editing a library template: saving writes the template, not a form. */
  const [templateLink, setTemplateLink] = useState<{ id: string; version: number; title: string } | null>(null);
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

  // Keyboard on the selection (outside inputs): arrows move a field one cell, Shift + arrows resize it, Delete,
  // Ctrl/Cmd + C / V / D copy, paste, duplicate, Ctrl/Cmd + K searches, Esc deselects.
  const keyHandler = useRef<(event: KeyboardEvent) => void>(() => undefined);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => keyHandler.current(event);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // The print preview shows sample rows in report components (case_block); the case's own rows print from Leaf.
  const previewData = useMemo(() => (definition ? withSampleBlocks(definition, tryData) : tryData), [definition, tryData]);
  const showPaperInfo = (info: { pages: number; scale: number }) => setPaperInfo(current => (current?.pages === info.pages && current.scale === info.scale ? current : info));
  const checkIssues = useMemo(() => {
    if (!definition) return [];
    const found = validateDefinition(prepared(definition, source), registry.styles.map(row => row.style_id), registry.fonts.map(row => row.font_id));
    return describeIssues(definition, found) as Array<Issue & { location?: string }>;
  }, [definition, source, registry]);

  const commit = (next: FormDefinition, mergeKey: string | null = null) => {
    history.commit(next, mergeKey);
    setAlso([]);
    writeAutosave({ definition: next, source, at: Date.now() });
  };
  /** Click selects; Shift / Ctrl / Cmd-click adds a field to (or takes it from) the selection. */
  const select = (next: Selection, add = false) => {
    if (add && next.kind === "field" && selection.kind === "field") {
      if (samePath(fieldPath(next.ref), fieldPath(selection.ref))) return;
      setAlso(current => (current.some(ref => samePath(fieldPath(ref), fieldPath(next.ref))) ? current.filter(ref => !samePath(fieldPath(ref), fieldPath(next.ref))) : [...current, next.ref]));
      return;
    }
    setAlso([]);
    setSelection(next);
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

  // A template or form sent from another tab (Templates): opened once per request.
  const handled = useRef<number | null>(null);
  useEffect(() => {
    if (!incoming || handled.current === incoming.key) return;
    // Deferred, and marked handled when it runs: a cancelled timer (React's development double run) does not count.
    const timer = setTimeout(() => {
      handled.current = incoming.key;
      if (incoming.kind === "definition") {
        setTemplateLink(null);
        open(structuredClone(incoming.definition), NEW_SOURCE);
        if (incoming.note) setMessage({ tone: "info", text: incoming.note });
        return;
      }
      if (incoming.kind === "template") {
        const { template } = incoming;
        open(structuredClone(template.definition), NEW_SOURCE);
        setTemplateLink({ id: template.template_id, version: template.version, title: template.title });
        return;
      }
      void loadForm(remote, incoming.formId).then(found => {
        if (!found) return;
        setTemplateLink(null);
        open(found.definition, found.source);
        setMessage({ tone: "info", text: t("สร้างแบบฟอร์มจากแม่แบบแล้ว (ร่างเวอร์ชัน 1) — ตรวจแล้วกด เผยแพร่ใช้งาน เพื่อให้เลือกได้ใน Workflow Studio",
          "Form created from the template (draft version 1) — check it, then Publish so Workflow Studio can offer it") });
      }).catch(error => setMessage({ tone: "error", text: error instanceof Error ? error.message : String(error) }));
    }, 0);
    return () => clearTimeout(timer);
  });

  if (!definition) return <StartScreen lang={lang} remote={remote} online={online} onOpen={(next, nextSource) => { setTemplateLink(null); open(next, nextSource); }} />;

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
      next = insertFields(definition, target.list, target.index, scaleSpans(built.fields, target.columns ?? listColumns(definition, target.list, formColumns(definition))));
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
    const list = at(next, ref.list) as FieldDefinition[];
    const pinnedList = isPinned(list.filter((_, index) => index !== ref.index));
    if (target.row !== undefined && target.columns) {
      // Desktop: the two-dimensional grid — the exact row and column under the pointer.
      ({ definition: next, ref } = placeAt(next, ref, { row: target.row, col: target.col ?? undefined, span: target.span }, target.columns));
    } else if (device === "desktop" && pinnedList) {
      // A click in the palette on a pinned grid: the row below the selected field (or a new last row).
      const columns = listColumns(next, ref.list, formColumns(next));
      const cells = cellsOf(list, columns);
      const selected = selection.kind === "field" && samePath(selection.ref.list, ref.list) ? cells[selection.ref.index] : undefined;
      const row = selected ? selected.row + selected.rows : Math.max(0, ...cells.filter((_, index) => index !== ref.index).map(cell => cell.row + cell.rows - 1)) + 1;
      ({ definition: next, ref } = placeAt(next, ref, { row, col: 1 }, columns));
    } else {
      next = placeOnGrid(next, ref, { col: target.col }, device === "tablet" ? "tablet" : "desktop", target.columns ?? listColumns(next, target.list, formColumns(next)));
    }
    commit(next);
    setSelection({ kind: "field", ref });
  };

  // The selection: the primary field and the others Shift / Ctrl-clicked.
  const selectedRefs = (): FieldRef[] => (selection.kind === "field" ? [selection.ref, ...also] : []).filter(ref => fieldAt(definition, ref));
  const columnsOf = (list: Path) => listColumns(definition, list, formColumns(definition));
  const removeMany = (refs: FieldRef[]) => {
    // Later indexes first, so earlier ones stay valid.
    const ordered = [...refs].sort((a, b) => JSON.stringify(a.list).localeCompare(JSON.stringify(b.list)) || b.index - a.index);
    commit(ordered.reduce((current, ref) => removeField(current, ref), definition));
    setSelection({ kind: "form" });
    setMessage({ tone: "info", text: t(`ลบ ${refs.length} ช่องแล้ว — กด เลิกทำ (Ctrl+Z) เพื่อนำกลับ`, `Deleted ${refs.length} field(s) — Undo (Ctrl+Z) brings them back`) });
  };
  /** Paste copied fields after the selected one (or at the end of the last section), with new names. */
  const paste = (fields: FieldDefinition[]) => {
    const used = usedNames(definition);
    const rename = (field: FieldDefinition): FieldDefinition => {
      const copy: FieldDefinition = { ...structuredClone(field), id: uniqueName(fieldKey(field), used) };
      delete copy.key;
      if (copy.layout) { delete copy.layout.row; delete copy.layout.col; }
      if (copy.fields) copy.fields = copy.fields.map(rename);
      return copy;
    };
    const copies = fields.map(rename);
    const at_ = clickTarget();
    let next = insertFields(definition, at_.list, at_.index, copies);
    const columns = columnsOf(at_.list);
    const list = at(next, at_.list) as FieldDefinition[];
    if (isPinned(list.filter((_, index) => index < at_.index || index >= at_.index + copies.length))) {
      // A pinned grid: the copies go on the rows below the selection.
      const below = selection.kind === "field" ? cellsOf(at(definition, at_.list) as FieldDefinition[], columns)[selection.ref.index] : undefined;
      let row = below ? below.row + below.rows : 1;
      copies.forEach((_, offset) => {
        const placed = placeAt(next, { list: at_.list, index: at_.index + offset }, { row, col: 1 }, columns);
        next = placed.definition;
        row += 1;
      });
    }
    commit(next);
    setMessage({ tone: "info", text: t(`วาง ${copies.length} ช่องแล้ว`, `Pasted ${copies.length} field(s)`) });
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

  // The variable-name standard --------------------------------------------------------------------
  const published = publishedKeys(source.previous);
  const findRef = (id: string) => allFields(definition).find(entry => entry.field.id === id)?.ref;
  /** Rename a field's variable; a field never published also takes the name as its id. */
  const renameTo = (current: FormDefinition, ref: FieldRef, to: string): FormDefinition => {
    const field = fieldAt(current, ref);
    if (!field) return current;
    const used = usedNames(current);
    used.delete(field.id);
    used.delete(fieldKey(field));
    const name = uniqueName(to, used);
    let next = fieldKey(field) === name ? current : renameKey(current, ref, name);
    if (!published.has(fieldKey(field))) next = patchField(next, ref, { id: name, key: undefined });
    return next;
  };
  const runIdCheck = async (current = definition) => {
    if (!online) { setMessage({ tone: "error", text: t("ต้องเชื่อมต่อเซิร์ฟเวอร์เพื่อตรวจชื่อ", "Checking names needs the server") }); return; }
    setIdBusy(true);
    try {
      setIdFindings(await remote.checkIds(prepared(current, source)));
    } catch (error) {
      setMessage({ tone: "error", text: failure(error) });
    } finally {
      setIdBusy(false);
    }
  };
  const fixFinding = (current: FormDefinition, finding: IdFinding, how: "rename" | "bind" | "english"): FormDefinition => {
    const ref = allFields(current).find(entry => entry.field.id === finding.id)?.ref;
    const field = ref ? fieldAt(current, ref) : undefined;
    if (!ref || !field) return current;
    if (how === "english") {
      const split = splitBilingual(field.label);
      return split ? patchField(current, ref, { label: split.th, label_en: split.en }) : current;
    }
    if (how === "bind" && finding.concept) return renameTo(patchField(current, ref, { bind: finding.concept }), ref, finding.concept.replace(".", "_"));
    if (finding.problem === "id_differs") return published.has(fieldKey(field)) ? current : patchField(current, ref, { id: fieldKey(field), key: undefined });
    return finding.suggestion ? renameTo(current, ref, finding.suggestion) : current;
  };
  const applyFix = (finding: IdFinding, how: "rename" | "bind" | "english") => {
    const next = fixFinding(definition, finding, how);
    if (next === definition && how === "english") {
      const ref = findRef(finding.id);
      if (ref) setSelection({ kind: "field", ref });
      setMessage({ tone: "info", text: t("พิมพ์ชื่อภาษาอังกฤษในช่อง \"ชื่อภาษาอังกฤษ\" ทางขวา", "Type the English label in the inspector on the right") });
      return;
    }
    commit(next);
    void runIdCheck(next);
  };
  const fixAll = () => {
    const findings = idFindings ?? [];
    let next = definition;
    for (const finding of findings) {
      if (finding.problem === "no_english") next = fixFinding(next, finding, "english");
      else if (finding.suggestion || finding.problem === "id_differs") next = fixFinding(next, finding, "rename");
    }
    commit(next);
    void runIdCheck(next);
  };
  const suggestName = async (field: FieldDefinition) => {
    if (!online) return null;
    const section = selection.kind === "field" ? (at(definition, selection.ref.list.slice(0, 2)) as { title_en?: string; id?: string } | undefined) : undefined;
    const taken = [...usedNames(definition)].filter(name => name !== fieldKey(field) && name !== field.id);
    const [found] = await remote.suggestIds([{ label: field.label, label_en: field.label_en, bind: field.bind, type: field.type, section: section?.title_en ?? section?.id }], taken);
    return found ? { key: found.key, concept: found.concept } : null;
  };

  /** Keep the selected fields (or the selected part's fields) as a block the team finds with Ctrl+K. */
  const saveBlock = async () => {
    const refs = selectedRefs();
    const fields = refs.length ? refs.map(ref => structuredClone(fieldAt(definition, ref)!))
      : selection.kind === "section" || selection.kind === "category" ? structuredClone(((at(definition, [...selection.path, "fields"]) as FieldDefinition[]) ?? [])) : [];
    if (!fields.length) { setMessage({ tone: "info", text: t("เลือกช่อง (หรือส่วน) ที่จะเก็บเป็นชุดก่อน", "Select the fields (or a part) to keep as a block first") }); return; }
    const name = window.prompt(t("ชื่อชุด (เช่น สัญญาณชีพมาตรฐาน)", "Block name (e.g. Standard vital signs)"), fields[0].label)?.trim();
    if (!name) return;
    const id = `block_${slug(name, "") || Date.now().toString(36)}`.slice(0, 60);
    const block: FormDefinition = { format: "flora.form/1", form_id: id, schema_version: 1, title: name, style_id: definition.style_id, paper: definition.paper,
      layout: definition.layout, sections: [{ id: "block", title: name, fields: fields.map(field => ({ ...field, layout: field.layout ? { ...field.layout, row: undefined, col: undefined } : undefined })) }] };
    try {
      await remote.createTemplate({ definition: JSON.parse(JSON.stringify(block)), title: name, origin: "manual", description: t(`ชุดของทีม: ${fields.length} ช่อง`, `Team block: ${fields.length} fields`) });
      setMessage({ tone: "ok", text: t(`เก็บชุด "${name}" แล้ว — ค้นหาได้ด้วย Ctrl+K`, `Block "${name}" kept — find it with Ctrl+K`) });
    } catch (error) {
      setMessage({ tone: "error", text: failure(error) });
    }
  };

  const finderCommands = [
    { id: "add_section", icon: "＋", th: "เพิ่มส่วนใหม่", en: "Add a section" },
    { id: "check_ids", icon: "🔤", th: "ตรวจชื่อตัวแปรตามมาตรฐาน", en: "Check variable names" },
    { id: "save_block", icon: "🧩", th: "เก็บที่เลือกเป็นชุดของทีม", en: "Keep the selection as a team block" },
    { id: "toggle_grid", icon: "▦", th: "เปิด/ปิดเส้นกริด", en: "Show / hide grid lines" },
    { id: "save", icon: "💾", th: "บันทึกร่าง", en: "Save draft" },
    { id: "ai", icon: "✨", th: "ผู้ช่วย AI: สร้าง/แก้ฟอร์มด้วยคำอธิบาย", en: "AI assistant: create / change the form by description" },
  ];
  const pick = (choice: FinderPick) => {
    if (choice.kind === "type") drop({ kind: "new", type: choice.type }, clickTarget());
    else if (choice.kind === "block") drop({ kind: "block", id: choice.id }, clickTarget());
    else if (choice.kind === "concept") {
      const field = paletteField(choice.type, usedNames(definition), lang);
      paste([{ ...field, id: choice.concept.replace(".", "_"), label: tr(lang, choice.th, choice.en), ...(lang === "th" ? { label_en: choice.en } : {}), bind: choice.concept }]);
    } else if (choice.kind === "fields") paste(choice.fields);
    else if (choice.kind === "section") {
      const used = usedNames(definition);
      const rename = (field: FieldDefinition): FieldDefinition => {
        const copy: FieldDefinition = { ...structuredClone(field), id: uniqueName(fieldKey(field), used) };
        delete copy.key;
        if (copy.fields) copy.fields = copy.fields.map(rename);
        return copy;
      };
      const section = { ...structuredClone(choice.section), id: uniqueName(choice.section.id, used), fields: choice.section.fields.map(rename),
        categories: undefined, sections: undefined, repeat: undefined };
      commit(insertAt(definition, ["sections"], definition.sections.length, section));
      setSelection({ kind: "section", path: ["sections", definition.sections.length] });
      setMessage({ tone: "info", text: t(`เพิ่มส่วน "${choice.name}" แล้ว`, `Added "${choice.name}"`) });
    } else if (choice.kind === "jump") setSelection({ kind: "field", ref: choice.ref });
    else if (choice.id === "add_section") addSection();
    else if (choice.id === "check_ids") void runIdCheck();
    else if (choice.id === "save_block") void saveBlock();
    else if (choice.id === "toggle_grid") setShowGrid(value => !value);
    else if (choice.id === "save") void run("save");
    else if (choice.id === "ai") setAiOpen(true);
  };

  keyHandler.current = (event: KeyboardEvent) => {
    const target = event.target as HTMLElement | null;
    if (view !== "design" || (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT" || target.isContentEditable))) return;
    const mod = event.metaKey || event.ctrlKey;
    if (mod && event.key.toLowerCase() === "k") { event.preventDefault(); setSearching(true); return; }
    const refs = selectedRefs();
    if (event.key === "Escape") { setAlso([]); setSelection({ kind: "form" }); return; }
    if (!refs.length || selection.kind !== "field") {
      if (mod && event.key.toLowerCase() === "v" && clipboard.current) { event.preventDefault(); paste(clipboard.current); }
      return;
    }
    if (event.key === "Delete" || event.key === "Backspace") { event.preventDefault(); removeMany(refs); return; }
    if (mod && event.key.toLowerCase() === "c") {
      event.preventDefault();
      clipboard.current = refs.map(ref => structuredClone(fieldAt(definition, ref)!));
      void navigator.clipboard?.writeText(JSON.stringify({ "flora.fields": clipboard.current })).catch(() => undefined);
      setMessage({ tone: "info", text: t(`คัดลอก ${refs.length} ช่อง — Ctrl+V เพื่อวาง`, `Copied ${refs.length} field(s) — Ctrl+V to paste`) });
      return;
    }
    if (mod && event.key.toLowerCase() === "v" && clipboard.current) { event.preventDefault(); paste(clipboard.current); return; }
    if (mod && event.key.toLowerCase() === "d") { event.preventDefault(); fieldAction(selection.ref, "duplicate"); return; }
    const arrows: Record<string, [number, number]> = { ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1] };
    const step = arrows[event.key];
    if (!step || device !== "desktop") return;
    event.preventDefault();
    const ref = selection.ref;
    const columns = columnsOf(ref.list);
    const cell = cellsOf(at(definition, ref.list) as FieldDefinition[], columns)[ref.index];
    const change = event.shiftKey
      ? { span: Math.max(1, cell.span + step[1]), rows: Math.max(1, cell.rows + step[0]) }
      : { row: Math.max(1, cell.row + step[0]), col: Math.max(1, cell.col + step[1]) };
    const placed = placeAt(definition, ref, change, columns);
    commit(placed.definition, `key:${fieldKey(fieldAt(definition, ref)!)}`);
    setSelection({ kind: "field", ref: placed.ref });
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

  /** Library template: the edited definition goes back to the template (problems allowed while it is a draft). */
  const saveTemplate = async () => {
    if (!templateLink) return;
    setBusy(true);
    try {
      const saved = await remote.updateTemplate(templateLink.id, { version: templateLink.version, definition, title: definition.title });
      setTemplateLink({ id: saved.template.template_id, version: saved.template.version, title: saved.template.title });
      writeAutosave(null);
      setMessage({ tone: saved.issues.length ? "info" : "ok", text: saved.issues.length
        ? t(`บันทึกแม่แบบแล้ว — ยังมี ${saved.issues.length} จุดที่ต้องแก้ก่อนทำเครื่องหมายว่าตรวจแล้ว`, `Template saved — ${saved.issues.length} problem(s) left before it can be marked reviewed`)
        : t("บันทึกแม่แบบแล้ว", "Template saved") });
    } catch (error) {
      setMessage({ tone: "error", text: failure(error) });
    } finally {
      setBusy(false);
    }
  };
  const keepAsTemplate = async () => {
    setBusy(true);
    try {
      const saved = await remote.createTemplate({ definition: prepared(definition, NEW_SOURCE), title: definition.title, origin: "manual" });
      setMessage({ tone: "ok", text: t(`เก็บเป็นแม่แบบ "${saved.template.template_id}" ในคลังแล้ว`, `Kept as the template "${saved.template.template_id}"`) });
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
  const paperConfig: PaperConfig = typeof definition.paper === "string" ? { size: definition.paper } : definition.paper ?? { size: "A4" };
  const density = paperConfig.density;
  const setDensity = (next: PaperConfig["density"]) => {
    const { density: _old, ...rest } = paperConfig;
    void _old;
    commit({ ...definition, paper: next ? { ...rest, density: next } : rest });
  };
  const paperName = (() => { const paper = paperSpec(definition); return `${paper.size}${paper.orientation === "landscape" ? t(" แนวนอน", " landscape") : ""}`; })();
  const recordIssues = view === "try" ? evaluateRecord(definition, tryData, "submitted", undefined, tables).issues : [];
  const width = device === "desktop" ? "100%" : device === "tablet" ? "768px" : "390px";
  const migration = source.previous ? buildMigration(source.previous, prepared(definition, source)) : null;

  return <div className="space-y-3">
    <div className={`${panel} flex flex-wrap items-center gap-2 p-2`}>
      <button type="button" className={small} title={t("งานที่ยังไม่บันทึกกู้คืนได้จากหน้าเริ่มต้น", "Unsaved work can be restored from the start screen")} onClick={() => { setTemplateLink(null); history.reset(null); }}>
        ← {t("แบบฟอร์มอื่น", "Other forms")}
      </button>
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-bold text-[var(--app-text)]">{definition.title}</div>
        <div className="text-[11px] text-[var(--app-muted)]"><code>{definition.form_id}</code> · {templateLink
          ? t(`แม่แบบ ${templateLink.id} v${templateLink.version}`, `template ${templateLink.id} v${templateLink.version}`) : versionLabel}</div>
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
      <button type="button" className={small} onClick={() => setAiOpen(value => !value)} title={t("สร้างหรือแก้ฟอร์มด้วยคำอธิบาย", "Create or change the form by description")}>✨ AI</button>
      <button type="button" className={small} disabled={idBusy} onClick={() => void runIdCheck()} title={t("ตรวจชื่อตัวแปรตามมาตรฐาน", "Check variable names by the standard")}>🔤 {t("ชื่อตัวแปร", "Names")}</button>
      <button type="button" onClick={() => setShowIssues(value => !value)}
        className={`rounded-lg px-2.5 py-1 text-xs font-bold ${checkIssues.length ? "bg-rose-500/15 text-rose-600 dark:text-rose-300" : "bg-emerald-500/15 text-emerald-600 dark:text-emerald-300"}`}>
        {checkIssues.length ? t(`⚠ ต้องแก้ ${checkIssues.length} จุด`, `⚠ ${checkIssues.length} to fix`) : t("✓ พร้อมใช้", "✓ Ready")}
      </button>
      {templateLink ? <>
        <button type="button" className={primary} disabled={busy} onClick={() => void saveTemplate()}>{t("บันทึกแม่แบบ", "Save template")}</button>
        {onTemplateSaved ? <button type="button" className={secondary} disabled={busy} onClick={() => onTemplateSaved(templateLink.id)}>{t("กลับไปตรวจแม่แบบ", "Back to the review")}</button> : null}
      </> : <>
        <button type="button" className={small} disabled={busy || !online} title={t("เก็บแบบฟอร์มนี้ไว้ในคลังแม่แบบ เพื่อใช้เริ่มแบบฟอร์มอื่น", "Keep this form in the template library to start other forms from")}
          onClick={() => void keepAsTemplate()}>{t("เก็บเป็นแม่แบบ", "Keep as template")}</button>
        <button type="button" className={secondary} disabled={busy} onClick={() => void run("save")}>{t("บันทึกร่าง", "Save draft")}</button>
        <button type="button" className={primary} disabled={busy} onClick={() => setConfirming(true)}>{t("เผยแพร่ใช้งาน", "Publish")}</button>
      </>}
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

    {idFindings ? <IdCheck lang={lang} findings={idFindings} busy={idBusy} onFix={applyFix} onFixAll={fixAll} onClose={() => setIdFindings(null)}
      onSelect={finding => { const ref = findRef(finding.id); if (ref) { setSelection({ kind: "field", ref }); setView("design"); } }} /> : null}
    {aiOpen ? <AiPanel lang={lang} remote={remote} online={online} definition={definition}
      selectedIds={selectedRefs().map(ref => fieldAt(definition, ref)?.id).filter((id): id is string => Boolean(id))}
      onOpenDocuments={onOpenDocuments} onClose={() => setAiOpen(false)}
      onApply={(next, scope) => {
        if (scope === "new") { setTemplateLink(null); open(next, NEW_SOURCE); setMessage({ tone: "info", text: t("ฟอร์มใหม่จาก AI — ตรวจแล้วบันทึกร่าง", "A new form from the AI — check it, then save a draft") }); }
        else { commit({ ...next, form_id: definition.form_id, schema_version: definition.schema_version }); setMessage({ tone: "info", text: t("ใช้การเปลี่ยนแปลงจาก AI แล้ว — Ctrl+Z เพื่อย้อน", "Applied the AI's changes — Ctrl+Z undoes them") }); }
        setAiOpen(false);
      }} /> : null}
    {searching ? <Finder lang={lang} definition={definition} remote={remote} online={online} commands={finderCommands} onPick={pick} onClose={() => setSearching(false)} /> : null}

    {view === "design" ? <div className="grid gap-3 xl:grid-cols-[230px_minmax(0,1fr)_340px]">
      <Palette lang={lang} setDrag={setDrag} onAdd={item => drop(item, clickTarget())} onSearch={() => setSearching(true)} lookups={lookups} />
      <div className="min-w-0 rounded-2xl bg-[var(--app-bg)] p-1" onClick={() => select({ kind: "form" })}>
        <div className="mb-1 flex flex-wrap items-center gap-2 px-1 text-[11px] text-[var(--app-muted)]" onClick={event => event.stopPropagation()}>
          <label className="flex items-center gap-1"><input type="checkbox" checked={showGrid} onChange={event => setShowGrid(event.target.checked)} />{t("เส้นกริด", "Grid lines")}</label>
          <label className="flex items-center gap-1">{t("ย่อ/ขยาย", "Zoom")}
            <input type="range" min={50} max={150} step={10} value={zoom} onChange={event => setZoom(Number(event.target.value))} className="w-24" aria-label={t("ย่อ/ขยาย", "Zoom")} />{zoom}%</label>
          <button type="button" className={small} onClick={() => setSearching(true)} title="Ctrl+K">🔎 {t("ค้นหาส่วนประกอบ", "Find parts")} <kbd className="ml-1 opacity-60">Ctrl K</kbd></button>
          {selection.kind === "section" || selection.kind === "category" ? <button type="button" className={small} title={t("ลบแถวว่างในส่วนนี้", "Remove the empty rows of this part")}
            onClick={() => commit(compactRows(definition, [...selection.path, "fields"], columnsOf([...selection.path, "fields"])))}>⇡ {t("ชิดแถว", "Close up rows")}</button> : null}
          <span className="ml-auto hidden lg:inline">{device === "desktop" ? t("ลากวางได้ทุกแถว/คอลัมน์ · ลากขอบขวา/ล่าง/มุมเพื่อย่อขยาย · ลูกศรเลื่อน · Shift+ลูกศรย่อขยาย",
            "Drop on any row / column · drag the right / bottom edge or corner to resize · arrows move · Shift+arrows resize") : t("มุมมองนี้จัดลำดับการไหล (แก้ตำแหน่งแบบ 2 มิติที่มุมมองคอมพิวเตอร์)", "This view reorders the flow (place in 2D on the desktop view)")}</span>
        </div>
        <div className="mx-auto transition-all" style={{ maxWidth: width, zoom: zoom / 100 }}>
          <Canvas definition={definition} lang={lang} mode={device} selection={selection} also={also} showGrid={showGrid} styleColumns={2} getDrag={getDrag} setDrag={setDrag}
            onSelect={select} onDrop={drop} onFieldAction={fieldAction} onSectionAction={sectionAction}
            onResize={(ref, size) => {
              if (size.rows !== undefined && device === "desktop") {
                const placed = placeAt(definition, ref, { span: size.span, rows: size.rows }, size.columns);
                commit(placed.definition);
                setSelection({ kind: "field", ref: placed.ref });
              } else commit(placeOnGrid(definition, ref, { span: size.span }, device === "tablet" ? "tablet" : "desktop", size.columns));
            }} />
          <button type="button" className={`${secondary} mt-3 w-full border-dashed`} onClick={event => { event.stopPropagation(); addSection(); }}>+ {t("เพิ่มส่วนใหม่", "Add a section")}</button>
        </div>
      </div>
      <aside className={`${panel} max-h-[calc(100vh-120px)] overflow-y-auto p-2 xl:sticky xl:top-2`}>
        {also.length && selection.kind === "field" ? <BulkPanel lang={lang} refs={selectedRefs()} definition={definition} onDelete={() => removeMany(selectedRefs())}
          onChange={next => commit(next)} onClear={() => setAlso([])} columnsOf={columnsOf} /> : null}
        {also.length ? null : selection.kind === "field" && fieldAt(definition, selection.ref)
          ? <FieldInspector key={JSON.stringify(selection.ref)} definition={definition} fieldRef={selection.ref} lang={lang} lookups={lookups} publishedKeys={publishedKeys(source.previous)}
              onChange={next => commit(next, `field:${JSON.stringify(selection.ref)}`)} suggestName={online ? suggestName : undefined} />
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
      {paperInfo ? <span className={`rounded-full border px-2 py-0.5 font-semibold ${paperInfo.pages > 1 ? "border-amber-500/50 text-amber-700 dark:text-amber-300" : "border-emerald-500/50 text-emerald-700 dark:text-emerald-300"}`}>
        📄 {paperInfo.pages === 1 ? t(`พอดี ${paperName} 1 หน้า`, `Fits one ${paperName} page`) : t(`${paperInfo.pages} หน้า ${paperName}`, `${paperInfo.pages} ${paperName} pages`)}
        {paperInfo.scale < 0.999 ? ` · ${t("ย่อ", "scaled")} ${Math.round(paperInfo.scale * 100)}%` : ""}</span> : null}
      {paperInfo && paperInfo.pages > 1 && density !== "fit_page"
        ? <button type="button" className={small} onClick={() => setDensity("fit_page")}>{t("บีบให้พอดี 1 หน้า", "Fit to one page")}</button> : null}
      {density === "fit_page" ? <button type="button" className={small} onClick={() => setDensity(undefined)}>{t("กลับเป็นขนาดปกติ", "Back to normal size")}</button> : null}
      {paperInfo && paperInfo.pages > 1 && density === "fit_page"
        ? <span className="text-amber-700 dark:text-amber-300">{t("ยังเกิน 1 หน้า: ลดแถวสูงสุด/แถวว่างของตารางรายงาน หรือจัดช่องให้อยู่ข้างกัน", "Still over one page: lower the report tables' rows, or place fields side by side")}</span> : null}
      <span>{t("ค่าที่ลองกรอกในแท็บ \"ทดลองกรอก\" จะอยู่ใน PDF ด้วย · ตารางข้อมูลเคสแสดงข้อมูลตัวอย่าง", "Values typed in \"Try it\" are included · case data tables show sample rows")}</span>
    </div> : null}
    {view === "print" ? <PdfPreview definition={definition} value={previewData} onInfo={showPaperInfo} styles={registry.styles} fonts={registry.fonts} lookups={tables} language={lang} /> : null}

    {view === "json" ? <JsonView key={JSON.stringify(definition).length} definition={definition} lang={lang} onApply={next => commit(next)} /> : null}
  </div>;
}

function Palette({ lang, setDrag, onAdd, onSearch, lookups }: {
  lang: Lang; setDrag: (item: DragItem | null) => void; onAdd: (item: DragItem) => void; onSearch: () => void; lookups: LookupInfo[];
}) {
  const t = (th: string, en: string) => tr(lang, th, en);
  const [query, setQuery] = useState("");
  const words = query.normalize("NFC").toLowerCase().split(/\s+/).filter(Boolean);
  const matches = (...texts: string[]) => { const hay = texts.join(" ").toLowerCase(); return words.every(word => hay.includes(word)); };
  const found = BLOCKS.filter(block => matches(block.th, block.en, block.hintTh, block.hintEn));
  const blocks = found.filter(block => !block.group);
  const reports = found.filter(block => block.group === "report");
  const leafTabs = found.filter(block => block.group === "leaf");
  const groups = PALETTE.map(group => ({ ...group, items: group.items.filter(item => matches(item.th, item.en, item.hintTh, item.hintEn, item.type)) })).filter(group => group.items.length);
  const start = (item: DragItem, text: string) => (event: DragEvent) => {
    setDrag(item);
    event.dataTransfer.effectAllowed = "copy";
    event.dataTransfer.setData(DRAG_MIME, text);
    event.dataTransfer.setData("text/plain", text);
  };
  const tile = "flex w-full cursor-grab items-center gap-2 rounded-lg border border-[var(--app-border)] bg-[var(--app-panel-bg)] px-2 py-1.5 text-left text-xs hover:border-[var(--app-accent)] active:cursor-grabbing";
  return <aside className={`${panel} max-h-72 space-y-3 overflow-y-auto p-2 xl:sticky xl:top-2 xl:max-h-[calc(100vh-120px)]`}>
    <input value={query} onChange={event => setQuery(event.target.value)} placeholder={t("ค้นหาชนิดช่อง / ชุด…", "Find a field type / block…")}
      className="w-full rounded-lg border border-[var(--app-border)] bg-[var(--app-control-bg)] px-2 py-1.5 text-xs text-[var(--app-text)]" aria-label={t("ค้นหาในแถบเครื่องมือ", "Search the palette")} />
    <button type="button" className="w-full text-left text-[11px] text-[var(--app-accent)] underline-offset-2 hover:underline" onClick={onSearch}>
      🔎 {t("ค้นหาทุกอย่าง: ข้อมูลเคส, ชุดของทีม, ส่วนจากฟอร์มอื่น (Ctrl+K)", "Search everything: case data, team blocks, other forms (Ctrl+K)")}</button>
    <p className="text-[11px] text-[var(--app-muted)]">{t("ลากไปวางบนหน้าฟอร์ม หรือคลิกเพื่อเพิ่มต่อจากช่องที่เลือก", "Drag onto the page, or click to add after the selected field")}</p>
    {blocks.length ? <div>
      <div className="mb-1 text-[11px] font-bold uppercase tracking-[0.12em] text-[var(--app-muted)]">{t("ชุดสำเร็จรูป", "Ready-made blocks")}</div>
      <div className="space-y-1">
        {blocks.map(block => {
          const missing = block.needsLookup !== undefined && !lookups.some(row => row.lookup_id === block.needsLookup);
          return <button key={block.id} type="button" draggable className={tile} onDragStart={start({ kind: "block", id: block.id }, block.en)} onDragEnd={() => setDrag(null)}
            onClick={() => onAdd({ kind: "block", id: block.id })} title={tr(lang, block.hintTh, block.hintEn)}>
            <span className="w-5 text-center">{block.icon}</span>
            <span className="min-w-0"><span className="block font-semibold text-[var(--app-text)]">{tr(lang, block.th, block.en)}</span>
              <span className="block truncate text-[10px] text-[var(--app-muted)]">{missing ? t("ต้องมีตารางอ้างอิงในเซิร์ฟเวอร์", "needs a server lookup table") : tr(lang, block.hintTh, block.hintEn)}</span></span>
          </button>;
        })}
      </div>
    </div> : null}
    {leafTabs.length ? <div>
      <div className="mb-1 text-[11px] font-bold uppercase tracking-[0.12em] text-[var(--app-muted)]">{t("ใบบันทึกดมยา Leaf (สองทาง)", "Leaf anesthesia record (both ways)")}</div>
      <p className="mb-1 text-[10px] text-[var(--app-muted)]">{t("ทั้งแท็บพร้อมผูกข้อมูล: กรอกที่ฟอร์มหรือที่แท็บ Leaf ก็ได้ ค่าล่าสุดใช้ทั้งสองที่ · ทีละช่อง: Ctrl+K", "A whole tab, bound: fill it in the form or on the Leaf tab, the newest value is used on both · one field at a time: Ctrl+K")}</p>
      <div className="grid grid-cols-2 gap-1">
        {leafTabs.map(block => <button key={block.id} type="button" draggable className={tile} onDragStart={start({ kind: "block", id: block.id }, block.en)} onDragEnd={() => setDrag(null)}
          onClick={() => onAdd({ kind: "block", id: block.id })} title={tr(lang, block.hintTh, block.hintEn)}>
          <span className="min-w-0"><span className="block truncate font-semibold text-[var(--app-text)]">{block.icon} {tr(lang, block.th, block.en).replace(/^แท็บ |^Tab: /, "")}</span>
            <span className="block truncate text-[10px] text-[var(--app-muted)]">{tr(lang, block.hintTh, block.hintEn)}</span></span>
        </button>)}
      </div>
    </div> : null}
    {reports.length ? <div>
      <div className="mb-1 text-[11px] font-bold uppercase tracking-[0.12em] text-[var(--app-muted)]">{t("ส่วนประกอบรายงาน (ข้อมูลเคส)", "Report components (case data)")}</div>
      <p className="mb-1 text-[10px] text-[var(--app-muted)]">{t("พิมพ์ด้วยข้อมูลจริงของเคสจาก Flora Leaf → รายงาน — ตั้งคอลัมน์และสัดส่วนได้ที่แผงขวา", "Printed with the case's real data from Flora Leaf → Reports — set columns and widths in the right panel")}</p>
      <div className="grid grid-cols-2 gap-1">
        {reports.map(block => <button key={block.id} type="button" draggable className={tile} onDragStart={start({ kind: "block", id: block.id }, block.en)} onDragEnd={() => setDrag(null)}
          onClick={() => onAdd({ kind: "block", id: block.id })} title={tr(lang, block.hintTh, block.hintEn)}>
          <span className="min-w-0 truncate font-semibold text-[var(--app-text)]">{block.icon} {tr(lang, block.th, block.en)}</span>
        </button>)}
      </div>
    </div> : null}
    {groups.map(group => <div key={group.en}>
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
    {!blocks.length && !reports.length && !leafTabs.length && !groups.length ? <p className="py-4 text-center text-xs text-[var(--app-muted)]">{t("ไม่พบ — ลองค้นหาทุกอย่าง (Ctrl+K)", "Nothing here — try searching everything (Ctrl+K)")}</p> : null}
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
      const found = await loadForm(remote, id);
      if (found) onOpen(found.definition, found.source);
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

/** Several fields selected (Shift / Ctrl-click): what can be done to all of them at once. */
function BulkPanel({ lang, refs, definition, onChange, onDelete, onClear, columnsOf }: {
  lang: Lang; refs: FieldRef[]; definition: FormDefinition; onChange: (next: FormDefinition) => void; onDelete: () => void; onClear: () => void;
  columnsOf: (list: Path) => number;
}) {
  const t = (th: string, en: string) => tr(lang, th, en);
  const fields = refs.map(ref => fieldAt(definition, ref)).filter((field): field is FieldDefinition => Boolean(field));
  const primaryRef = refs[0];
  const sameList = refs.every(ref => samePath(ref.list, primaryRef.list));
  const apply = (change: (field: FieldDefinition) => Partial<FieldDefinition>) => {
    let next = definition;
    for (const ref of refs) {
      const field = fieldAt(next, ref);
      if (field) next = patchFieldValues(next, ref, change(field));
    }
    onChange(next);
  };
  const cells = sameList ? cellsOf(at(definition, primaryRef.list) as FieldDefinition[], columnsOf(primaryRef.list)) : [];
  const lineUp = (how: "left" | "width") => {
    let next = definition;
    const lead = cells[primaryRef.index];
    // One at a time, each from its current place (moving one may push the next).
    for (const ref of refs.slice(1)) {
      const field = fieldAt(next, ref);
      if (!field) continue;
      const index = (at(next, ref.list) as FieldDefinition[]).findIndex(item => item.id === field.id);
      next = placeAt(next, { list: ref.list, index }, how === "left" ? { col: lead.col } : { span: lead.span }, columnsOf(ref.list)).definition;
    }
    onChange(next);
  };
  return <div className="space-y-2 text-sm">
    <div className="flex items-center justify-between"><b className="text-[var(--app-text)]">{t(`เลือก ${fields.length} ช่อง`, `${fields.length} fields selected`)}</b>
      <button type="button" className={small} onClick={onClear}>{t("เลือกช่องเดียว", "Select one")}</button></div>
    <ul className="max-h-32 overflow-y-auto text-xs text-[var(--app-muted)]">{fields.map(field => <li key={field.id}>· {field.label} <code>{fieldKey(field)}</code></li>)}</ul>
    <div className="grid grid-cols-2 gap-1">
      <button type="button" className={small} onClick={() => apply(() => ({ required: true }))}>{t("บังคับกรอกทั้งหมด", "All required")}</button>
      <button type="button" className={small} onClick={() => apply(() => ({ required: undefined }))}>{t("ไม่บังคับทั้งหมด", "None required")}</button>
      {sameList ? <button type="button" className={small} onClick={() => lineUp("left")}>{t("ชิดซ้ายเท่าช่องแรก", "Align left with the first")}</button> : null}
      {sameList ? <button type="button" className={small} onClick={() => lineUp("width")}>{t("กว้างเท่าช่องแรก", "Same width as the first")}</button> : null}
    </div>
    <button type="button" className={`${danger} w-full`} onClick={onDelete}>{t(`ลบ ${fields.length} ช่อง (Delete)`, `Delete ${fields.length} fields (Delete)`)}</button>
    <p className="text-[11px] text-[var(--app-muted)]">{t("Ctrl+C คัดลอก · Ctrl+V วาง · Esc ยกเลิกการเลือก", "Ctrl+C copy · Ctrl+V paste · Esc deselect")}</p>
  </div>;
}

/** patchField for a bulk change (undefined removes the property). */
function patchFieldValues(definition: FormDefinition, ref: FieldRef, values: Partial<FieldDefinition>): FormDefinition {
  return patchField(definition, ref, values as Partial<Record<keyof FieldDefinition, unknown>>);
}

