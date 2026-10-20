/**
 * The assembly workspace ("ประกอบร่าง"), like a video editor's timeline: documents dropped in are cut into pages that
 * wait in the tray; pages are dragged into groups (tracks), reordered, turned and cut apart, and each group becomes
 * one document. The host says what a finished group is for (download, read into a form, attach to a case).
 *
 * Everything stays in the browser until the host uses a group: scanned documents are patient data.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent, type ReactNode } from "react";
import { ACCEPT_DOCUMENTS, drawClip, newId, readFiles, thumbStyle, type PageClip, type SourceDocument } from "./pages";

export type ClipGroup = { id: string; name: string; clipIds: string[] };
export type GroupAction = { id: string; label: string; primary?: boolean; disabled?: boolean; run: (group: ClipGroup, clips: PageClip[], sources: Map<string, SourceDocument>) => void | Promise<void> };

type Props = {
  language?: string;
  /** What a group can be used for. */
  actions: GroupAction[];
  /** Shown above the workspace (the host's own controls). */
  header?: ReactNode;
  maxPages?: number;
};

const button = "rounded-lg border border-[var(--app-border)] bg-[var(--app-control-bg)] px-2.5 py-1.5 text-xs font-semibold text-[var(--app-text)] hover:bg-[var(--app-control-bg-hover)] disabled:opacity-40";
const primary = "rounded-lg bg-[var(--app-accent)] px-3 py-1.5 text-xs font-bold text-[var(--app-accent-contrast)] disabled:opacity-40";
const DRAG_TYPE = "application/x-flora-pages";
const TRAY = "tray";

export default function DocumentAssembler({ language = "th", actions, header, maxPages = 200 }: Props) {
  const th = !language.toLowerCase().startsWith("en");
  const t = (thai: string, english: string) => (th ? thai : english);
  const [sources, setSources] = useState<Map<string, SourceDocument>>(new Map());
  const [clips, setClips] = useState<Map<string, PageClip>>(new Map());
  const [tray, setTray] = useState<string[]>([]);
  const [groups, setGroups] = useState<ClipGroup[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [focus, setFocus] = useState<string | null>(null);
  const [busy, setBusy] = useState("");
  const [message, setMessage] = useState("");
  const [drop, setDrop] = useState<{ track: string; index: number } | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const anchor = useRef<string | null>(null);

  const add = useCallback(async (files: File[]) => {
    if (!files.length) return;
    setBusy(t("กำลังแยกหน้า…", "Splitting pages…"));
    try {
      const result = await readFiles(files, Math.max(0, maxPages - clips.size));
      setSources(current => new Map([...current, ...result.documents.map(doc => [doc.id, doc] as const)]));
      setClips(current => new Map([...current, ...result.clips.map(clip => [clip.id, clip] as const)]));
      setTray(current => [...current, ...result.clips.map(clip => clip.id)]);
      setMessage(result.refused.length ? t(`อ่านไม่ได้: ${result.refused.join(", ")} (รับ PDF, PNG, JPEG)`, `Could not read: ${result.refused.join(", ")} (PDF, PNG and JPEG only)`)
        : t(`ได้ ${result.clips.length} หน้า รอจัดกลุ่มในถาด`, `${result.clips.length} pages in the tray, ready to group`));
      if (result.clips[0]) setFocus(result.clips[0].id);
    } finally {
      setBusy("");
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clips.size, maxPages, th]);

  // Where every clip is: the tray or a group.
  const where = useMemo(() => {
    const out = new Map<string, string>();
    tray.forEach(id => out.set(id, TRAY));
    groups.forEach(group => group.clipIds.forEach(id => out.set(id, group.id)));
    return out;
  }, [tray, groups]);

  const listOf = (track: string) => (track === TRAY ? tray : groups.find(group => group.id === track)?.clipIds ?? []);

  /** Move clips to a track at an index (removed from wherever they were, kept in their current order). */
  const move = useCallback((ids: string[], track: string, index: number) => {
    const moving = ids.filter(id => clips.has(id));
    if (!moving.length) return;
    const strip = (list: string[]) => list.filter(id => !moving.includes(id));
    const insert = (list: string[]) => {
      const before = list.slice(0, index).filter(id => !moving.includes(id)).length;
      const kept = strip(list);
      return [...kept.slice(0, before), ...moving, ...kept.slice(before)];
    };
    setTray(current => (track === TRAY ? insert(current) : strip(current)));
    setGroups(current => current.map(group => ({ ...group, clipIds: group.id === track ? insert(group.clipIds) : strip(group.clipIds) })));
  }, [clips]);

  const newGroup = (ids: string[] = [], name?: string) => {
    const id = newId("g");
    setGroups(current => [...current, { id, name: name ?? t(`เอกสาร ${current.length + 1}`, `Document ${current.length + 1}`), clipIds: [] }]);
    if (ids.length) setTimeout(() => move(ids, id, 0), 0);
    return id;
  };

  /** One group per source file, pages in order (a starting point to rearrange). */
  const groupByFile = () => {
    const byFile = new Map<string, string[]>();
    tray.forEach(id => {
      const clip = clips.get(id);
      if (clip) byFile.set(clip.sourceId, [...(byFile.get(clip.sourceId) ?? []), id]);
    });
    const made: ClipGroup[] = [...byFile.entries()].map(([sourceId, ids]) => ({ id: newId("g"), name: (sources.get(sourceId)?.name ?? "Document").replace(/\.[a-z0-9]+$/i, ""), clipIds: ids }));
    setGroups(current => [...current, ...made]);
    setTray([]);
  };

  /** Cut a group in two before the clip at index (the scissors between pages). */
  const cut = (groupId: string, index: number) => {
    setGroups(current => current.flatMap(group => {
      if (group.id !== groupId || index <= 0 || index >= group.clipIds.length) return [group];
      return [{ ...group, clipIds: group.clipIds.slice(0, index) }, { id: newId("g"), name: `${group.name} (2)`, clipIds: group.clipIds.slice(index) }];
    }));
  };

  const joinNext = (groupId: string) => {
    setGroups(current => {
      const index = current.findIndex(group => group.id === groupId);
      if (index < 0 || index === current.length - 1) return current;
      const joined = { ...current[index], clipIds: [...current[index].clipIds, ...current[index + 1].clipIds] };
      return [...current.slice(0, index), joined, ...current.slice(index + 2)];
    });
  };

  const removeGroup = (groupId: string) => {
    const ids = groups.find(group => group.id === groupId)?.clipIds ?? [];
    setGroups(current => current.filter(group => group.id !== groupId));
    setTray(current => [...current, ...ids]);
  };

  const rotate = (ids: string[], by = 90) => setClips(current => new Map([...current].map(([id, clip]) => [id, ids.includes(id) ? { ...clip, rotation: (clip.rotation + by + 360) % 360 } : clip])));

  const discard = (ids: string[]) => {
    setTray(current => current.filter(id => !ids.includes(id)));
    setGroups(current => current.map(group => ({ ...group, clipIds: group.clipIds.filter(id => !ids.includes(id)) })));
    setClips(current => new Map([...current].filter(([id]) => !ids.includes(id))));
    setSelected([]);
  };

  // Selection: click, Shift-click (range in a track), Cmd/Ctrl-click (toggle).
  const select = (id: string, event: { shiftKey: boolean; metaKey: boolean; ctrlKey: boolean }) => {
    setFocus(id);
    if (event.metaKey || event.ctrlKey) {
      setSelected(current => (current.includes(id) ? current.filter(item => item !== id) : [...current, id]));
      anchor.current = id;
      return;
    }
    if (event.shiftKey && anchor.current && where.get(anchor.current) === where.get(id)) {
      const list = listOf(where.get(id) ?? TRAY);
      const [a, b] = [list.indexOf(anchor.current), list.indexOf(id)].sort((x, y) => x - y);
      setSelected(list.slice(a, b + 1));
      return;
    }
    anchor.current = id;
    setSelected([id]);
  };

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)) return;
      if (!selected.length) return;
      if (event.key === "Delete" || event.key === "Backspace") { event.preventDefault(); discard(selected); }
      else if (event.key === "r" || event.key === "R") { event.preventDefault(); rotate(selected, event.shiftKey ? -90 : 90); }
      else if (event.key === "Escape") setSelected([]);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  // Drag and drop: a page (or the selected pages) onto a track; files from the computer anywhere.
  const startDrag = (event: DragEvent, id: string) => {
    const ids = selected.includes(id) ? selected : [id];
    if (!selected.includes(id)) setSelected([id]);
    event.dataTransfer.setData(DRAG_TYPE, JSON.stringify(ids));
    event.dataTransfer.effectAllowed = "move";
  };
  const overClip = (event: DragEvent, track: string, index: number) => {
    if (!event.dataTransfer.types.includes(DRAG_TYPE)) return;
    event.preventDefault();
    event.stopPropagation();
    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
    const horizontal = track !== TRAY;
    const after = horizontal ? event.clientX > rect.left + rect.width / 2 : event.clientY > rect.top + rect.height / 2;
    setDrop({ track, index: index + (after ? 1 : 0) });
  };
  const overTrack = (event: DragEvent, track: string) => {
    if (!event.dataTransfer.types.includes(DRAG_TYPE)) return;
    event.preventDefault();
    if (!drop || drop.track !== track) setDrop({ track, index: listOf(track).length });
  };
  const dropOn = (event: DragEvent, track: string) => {
    const raw = event.dataTransfer.getData(DRAG_TYPE);
    if (!raw) return;
    event.preventDefault();
    event.stopPropagation();
    const ids = JSON.parse(raw) as string[];
    const target = track === "new" ? newGroup() : track;
    move(ids, target, drop && drop.track === track ? drop.index : listOf(target).length);
    setDrop(null);
  };
  const dropFiles = (event: DragEvent) => {
    if (event.dataTransfer.types.includes(DRAG_TYPE)) return;
    event.preventDefault();
    void add([...event.dataTransfer.files]);
  };

  const focused = focus ? clips.get(focus) : undefined;
  const marker = <div className="w-1 shrink-0 self-stretch rounded bg-[var(--app-accent)]" />;

  const clipCard = (id: string, track: string, index: number) => {
    const clip = clips.get(id);
    if (!clip) return null;
    const isSelected = selected.includes(id);
    return <div key={id} className="group relative shrink-0" draggable onDragStart={event => startDrag(event, id)} onDragOver={event => overClip(event, track, index)}
      onDrop={event => dropOn(event, track)} onClick={event => select(id, event)} onDoubleClick={() => setFocus(id)}
      role="button" tabIndex={0} aria-pressed={isSelected} aria-label={`${clip.name} ${t("หน้า", "page")} ${clip.pageIndex + 1}`}
      onKeyDown={event => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); select(id, event); } }}>
      <div className={`flex h-[132px] w-[96px] items-center justify-center overflow-hidden rounded-lg border-2 bg-white shadow-sm ${isSelected ? "border-[var(--app-accent)] ring-2 ring-[var(--app-accent)]/30" : "border-[var(--app-border)]"} ${focus === id ? "outline outline-1 outline-sky-400" : ""}`}>
        <img src={clip.thumb} alt="" draggable={false} className="max-h-full max-w-full object-contain transition-transform" style={thumbStyle(clip)} />
      </div>
      <div className="mt-1 w-[96px] truncate text-center text-[10px] text-[var(--app-muted)]" title={clip.name}>{clip.name.replace(/\.[a-z0-9]+$/i, "")} · {clip.pageIndex + 1}</div>
      <div className="absolute right-1 top-1 hidden gap-0.5 group-hover:flex">
        <button type="button" className="rounded bg-black/60 px-1 text-[10px] text-white" title={t("หมุน (R)", "Rotate (R)")} onClick={event => { event.stopPropagation(); rotate([id]); }}>↻</button>
        <button type="button" className="rounded bg-black/60 px-1 text-[10px] text-white" title={t("ลบหน้า (Delete)", "Remove page (Delete)")} onClick={event => { event.stopPropagation(); discard([id]); }}>✕</button>
      </div>
    </div>;
  };

  return <div className="space-y-3" onDragOver={event => { if (!event.dataTransfer.types.includes(DRAG_TYPE)) event.preventDefault(); }} onDrop={dropFiles}>
    {header}
    <div className="flex flex-wrap items-center gap-2">
      <button type="button" className={primary} onClick={() => fileInput.current?.click()}>{t("+ เพิ่มเอกสาร (PDF / รูป)", "+ Add documents (PDF / pictures)")}</button>
      <input ref={fileInput} type="file" multiple accept={ACCEPT_DOCUMENTS} hidden onChange={event => { void add([...(event.target.files ?? [])]); event.target.value = ""; }} />
      <button type="button" className={button} disabled={!tray.length} onClick={groupByFile}>{t("จัดกลุ่มตามไฟล์", "Group by file")}</button>
      <button type="button" className={button} disabled={!selected.length} onClick={() => newGroup(selected)}>{t("กลุ่มใหม่จากหน้าที่เลือก", "New group from selection")}</button>
      <button type="button" className={button} disabled={!selected.length} onClick={() => rotate(selected)}>{t("หมุน ↻", "Rotate ↻")}</button>
      <button type="button" className={button} disabled={!selected.length} onClick={() => discard(selected)}>{t("ลบหน้าที่เลือก", "Remove selected")}</button>
      <span className="text-xs text-[var(--app-muted)]">{busy || message || t("ลากไฟล์มาวางที่ใดก็ได้ · คลิก/Shift/Ctrl เพื่อเลือกหลายหน้า · ลากหน้าไปยังกลุ่ม", "Drop files anywhere · click, Shift, Ctrl to select pages · drag pages into a group")}</span>
    </div>

    <div className="grid gap-3 xl:grid-cols-[220px_minmax(0,1fr)_340px]">
      {/* The tray: pages waiting to be grouped. */}
      <section aria-label={t("ถาดหน้ารอจัดกลุ่ม", "Pages waiting")} className="rounded-2xl border border-dashed border-[var(--app-border)] bg-[var(--app-panel-bg)] p-2"
        onDragOver={event => overTrack(event, TRAY)} onDrop={event => dropOn(event, TRAY)}>
        <div className="mb-2 flex items-center justify-between px-1 text-xs font-bold text-[var(--app-muted)]">
          <span>{t("ถาด", "Tray")} · {tray.length}</span>
          {tray.length ? <button type="button" className="text-[11px] underline" onClick={() => setSelected([...tray])}>{t("เลือกทั้งหมด", "Select all")}</button> : null}
        </div>
        <div className="grid max-h-[520px] grid-cols-2 gap-2 overflow-y-auto">
          {tray.map((id, index) => <div key={id} className="contents">
            {drop?.track === TRAY && drop.index === index ? <div className="col-span-2 h-1 rounded bg-[var(--app-accent)]" /> : null}
            {clipCard(id, TRAY, index)}
          </div>)}
          {!tray.length ? <p className="col-span-2 px-2 py-10 text-center text-xs text-[var(--app-muted)]">{t("วางไฟล์ PDF หรือรูปสแกนที่นี่ ระบบจะแยกเป็นหน้า ๆ", "Drop PDFs or scans here; they are split into pages")}</p> : null}
        </div>
      </section>

      {/* The timeline: one track per document being put together. */}
      <section aria-label={t("กลุ่มเอกสาร", "Document groups")} className="min-w-0 space-y-2">
        {groups.map((group, groupIndex) => <div key={group.id} className="rounded-2xl border border-[var(--app-border)] bg-[var(--app-panel-bg)] p-2"
          onDragOver={event => overTrack(event, group.id)} onDrop={event => dropOn(event, group.id)}>
          <div className="mb-2 flex flex-wrap items-center gap-2">
            <input className="min-w-40 flex-1 rounded-lg border border-[var(--app-border)] bg-[var(--app-control-bg)] px-2 py-1 text-sm font-semibold text-[var(--app-text)]"
              value={group.name} aria-label={t("ชื่อเอกสาร", "Document name")} onChange={event => setGroups(current => current.map(item => (item.id === group.id ? { ...item, name: event.target.value } : item)))} />
            <span className="text-xs text-[var(--app-muted)]">{group.clipIds.length} {t("หน้า", "pages")}</span>
            {groupIndex < groups.length - 1 ? <button type="button" className={button} onClick={() => joinNext(group.id)} title={t("ต่อกับกลุ่มถัดไป", "Join with the next group")}>⤓ {t("ต่อกลุ่มถัดไป", "Join next")}</button> : null}
            <button type="button" className={button} onClick={() => removeGroup(group.id)}>{t("ยกเลิกกลุ่ม", "Ungroup")}</button>
            {actions.map(action => <button key={action.id} type="button" className={action.primary ? primary : button} disabled={action.disabled || !group.clipIds.length}
              onClick={() => void action.run(group, group.clipIds.map(id => clips.get(id)).filter((clip): clip is PageClip => Boolean(clip)), sources)}>{action.label}</button>)}
          </div>
          <div className="flex min-h-[150px] items-start gap-1 overflow-x-auto pb-2">
            {group.clipIds.map((id, index) => <div key={id} className="flex shrink-0 items-start gap-1">
              {index > 0 ? <button type="button" title={t("ตัดแยกเป็นเอกสารใหม่ตรงนี้", "Cut into a new document here")} aria-label={t("ตัดตรงนี้", "Cut here")}
                className="mt-14 rounded px-0.5 text-sm text-[var(--app-muted)] opacity-40 hover:bg-[var(--app-control-bg)] hover:opacity-100" onClick={() => cut(group.id, index)}>✂</button> : null}
              {drop?.track === group.id && drop.index === index ? marker : null}
              {clipCard(id, group.id, index)}
            </div>)}
            {drop?.track === group.id && drop.index >= group.clipIds.length ? marker : null}
            {!group.clipIds.length ? <p className="px-3 py-12 text-xs text-[var(--app-muted)]">{t("ลากหน้ามาวางที่นี่", "Drag pages here")}</p> : null}
          </div>
        </div>)}
        <div className="rounded-2xl border border-dashed border-[var(--app-border)] p-4 text-center text-xs text-[var(--app-muted)]"
          onDragOver={event => { if (event.dataTransfer.types.includes(DRAG_TYPE)) event.preventDefault(); }} onDrop={event => dropOn(event, "new")}>
          <button type="button" className={button} onClick={() => newGroup()}>{t("+ กลุ่มเอกสารใหม่", "+ New document group")}</button>
          <span className="ml-2">{t("หรือลากหน้ามาวางที่นี่เพื่อสร้างกลุ่มใหม่", "or drop pages here to start one")}</span>
        </div>
      </section>

      {/* The page being looked at, large. */}
      <PagePreview clip={focused} source={focused ? sources.get(focused.sourceId) : undefined} language={language} onRotate={by => focused && rotate([focused.id], by)} />
    </div>
  </div>;
}

function PagePreview({ clip, source, language, onRotate }: { clip?: PageClip; source?: SourceDocument; language: string; onRotate: (by: number) => void }) {
  const th = !language.toLowerCase().startsWith("en");
  const canvas = useRef<HTMLCanvasElement>(null);
  const [zoom, setZoom] = useState(100);
  useEffect(() => {
    if (!clip || !source || !canvas.current) return;
    void drawClip(canvas.current, clip, source, Math.round(300 * zoom / 100)).catch(() => undefined);
  }, [clip, source, zoom]);
  return <aside className="rounded-2xl border border-[var(--app-border)] bg-[var(--app-panel-bg)] p-2" aria-label={th ? "ภาพหน้าเอกสาร" : "Page preview"}>
    <div className="mb-2 flex items-center gap-2 text-xs text-[var(--app-muted)]">
      <span className="flex-1 truncate font-semibold">{clip ? `${clip.name} · ${th ? "หน้า" : "page"} ${clip.pageIndex + 1}` : (th ? "เลือกหน้าเพื่อดู" : "Select a page to view")}</span>
      <button type="button" className="rounded border border-[var(--app-border)] px-1.5" disabled={!clip} onClick={() => onRotate(-90)} aria-label={th ? "หมุนซ้าย" : "Rotate left"}>↺</button>
      <button type="button" className="rounded border border-[var(--app-border)] px-1.5" disabled={!clip} onClick={() => onRotate(90)} aria-label={th ? "หมุนขวา" : "Rotate right"}>↻</button>
      <input type="range" min={50} max={250} step={10} value={zoom} onChange={event => setZoom(Number(event.target.value))} aria-label={th ? "ย่อ/ขยาย" : "Zoom"} className="w-20" />
    </div>
    <div className="max-h-[560px] overflow-auto rounded-lg bg-slate-200 p-2 dark:bg-slate-900">
      {clip ? <canvas ref={canvas} className="mx-auto block bg-white shadow" /> : <div className="py-20 text-center text-xs text-[var(--app-muted)]">—</div>}
    </div>
  </aside>;
}
