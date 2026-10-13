/**
 * AI Studio dashboard: a cols x rows board of widgets. In edit mode widgets are dragged from the palette onto
 * cells, moved by their header and resized from the corner (any span such as 2x1 or 1x2); a placement that
 * would overlap or leave the grid is shown in red and refused. View mode is the live board, with a period for
 * snippet widgets, refresh, auto-refresh and full screen.
 */
import { useEffect, useMemo, useRef, useState, type DragEvent, type PointerEvent as ReactPointerEvent } from "react";
import {
  copyDashboard, createDashboard, deleteDashboard, saveDashboard, shareDashboard,
  type Dashboard, type DashboardInput, type KeptArtifact, type Period, type Widget, type WidgetType,
} from "../../api/aiStudioApi";
import { tr, type Lang } from "../../reportstudio/model";
import { danger, inlineInput, input, label, panel, primary, secondary, small } from "../../reportstudio/styles";
import { GRID_PRESETS, MAX_GRID, SIZE_PRESETS, cellAt, fits, freeSpot, outside, resizeTo, type Rect } from "./layout";
import { WIDGETS, catalogItem } from "./catalog";
import { WidgetBody } from "./widgets";

type Props = {
  lang: Lang;
  dashboard: Dashboard | null;
  snippets: KeptArtifact[];
  onSaved: (dashboard: Dashboard) => void;
  onDeleted: () => void;
};
type Drag = { kind: "new"; type: WidgetType } | { kind: "move"; id: string };
type Preview = Rect & { ok: boolean };

const GAP = 10;
const ROW_HEIGHTS: Array<[number, string, string]> = [[160, "เล็ก", "Small"], [220, "กลาง", "Medium"], [300, "ใหญ่", "Large"], [400, "ใหญ่มาก", "X-large"]];
const newId = () => `w${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const blank = (): DashboardInput => ({ title: "", cols: 3, rows: 3, row_height: 220, widgets: [] });
const inputOf = (dashboard: Dashboard): DashboardInput => ({ title: dashboard.title, cols: dashboard.cols, rows: dashboard.rows, row_height: dashboard.row_height, widgets: dashboard.widgets });

export default function DashboardBoard({ lang, dashboard, snippets, onSaved, onDeleted }: Props) {
  const t = (th: string, en: string) => tr(lang, th, en);
  const mine = !dashboard || dashboard.mine;
  const [draft, setDraft] = useState<DashboardInput>(() => (dashboard ? inputOf(dashboard) : blank()));
  const [dirty, setDirty] = useState(!dashboard);
  const [editing, setEditing] = useState(!dashboard);
  const [selected, setSelected] = useState<string | null>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  const [resizing, setResizing] = useState<string | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [message, setMessage] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState<"delete" | "share" | null>(null);
  const [period, setPeriod] = useState<Period>({});
  const [refreshKey, setRefreshKey] = useState(0);
  const [autoRefresh, setAutoRefresh] = useState(0);
  const board = useRef<HTMLDivElement>(null);
  const shell = useRef<HTMLDivElement>(null);
  const grid = { cols: draft.cols, rows: draft.rows };
  const selectedWidget = draft.widgets.find(widget => widget.id === selected) ?? null;
  const shieldFrames = Boolean(drag || resizing); // iframes swallow drag/pointer events

  useEffect(() => {
    if (!autoRefresh) return;
    const timer = window.setInterval(() => setRefreshKey(value => value + 1), autoRefresh * 1000);
    return () => window.clearInterval(timer);
  }, [autoRefresh]);

  const change = (next: Partial<DashboardInput>) => { setDraft(current => ({ ...current, ...next })); setDirty(true); };
  const setWidgets = (update: (widgets: Widget[]) => Widget[]) => { setDraft(current => ({ ...current, widgets: update(current.widgets) })); setDirty(true); };
  const patchWidget = (id: string, patch: Partial<Widget>) => setWidgets(widgets => widgets.map(widget => (widget.id === id ? { ...widget, ...patch } : widget)));
  const patchConfig = (id: string, patch: Record<string, unknown>) => setWidgets(widgets => widgets.map(widget => (widget.id === id ? { ...widget, config: { ...widget.config, ...patch } } : widget)));
  const removeWidget = (id: string) => { setWidgets(widgets => widgets.filter(widget => widget.id !== id)); setSelected(null); };

  const addWidget = (type: WidgetType, at?: { x: number; y: number }) => {
    const item = catalogItem(type);
    const spot = freeSpot({ w: Math.min(item.size[0], grid.cols), h: Math.min(item.size[1], grid.rows) }, draft.widgets, grid, at);
    if (!spot) { setMessage({ tone: "error", text: t("บอร์ดเต็มแล้ว — ขยายกริดหรือย่อวิดเจ็ต", "The board is full; enlarge the grid or shrink a widget.") }); return; }
    const widget: Widget = { id: newId(), type, ...spot, title: "", config: { ...item.config } };
    setWidgets(widgets => [...widgets, widget]);
    setSelected(widget.id);
  };

  // Drag and drop onto the board ------------------------------------------------------------
  const rectFor = (item: Drag, cell: { x: number; y: number }): Preview => {
    if (item.kind === "move") {
      const widget = draft.widgets.find(entry => entry.id === item.id)!;
      const rect = { x: cell.x, y: cell.y, w: widget.w, h: widget.h };
      return { ...rect, ok: fits(rect, draft.widgets, grid, widget.id) };
    }
    const size = catalogItem(item.type).size;
    const rect = { x: cell.x, y: cell.y, w: Math.min(size[0], grid.cols), h: Math.min(size[1], grid.rows) };
    return { ...rect, ok: fits(rect, draft.widgets, grid) };
  };
  const onDragOver = (event: DragEvent) => {
    if (!drag || !board.current) return;
    event.preventDefault();
    const next = rectFor(drag, cellAt(event.clientX, event.clientY, board.current.getBoundingClientRect(), grid, draft.row_height, GAP));
    event.dataTransfer.dropEffect = next.ok ? (drag.kind === "move" ? "move" : "copy") : "none";
    setPreview(current => (current && current.x === next.x && current.y === next.y && current.w === next.w && current.h === next.h && current.ok === next.ok ? current : next));
  };
  const onDrop = (event: DragEvent) => {
    event.preventDefault();
    if (drag && preview) {
      if (drag.kind === "new") addWidget(drag.type, preview.ok ? preview : undefined);
      else if (preview.ok) patchWidget(drag.id, { x: preview.x, y: preview.y });
      else setMessage({ tone: "error", text: t("วางตรงนั้นไม่ได้ — ทับวิดเจ็ตอื่นหรือเกินกริด", "It does not fit there: it would overlap another widget or leave the grid.") });
    }
    setDrag(null);
    setPreview(null);
  };
  const startDrag = (item: Drag, text: string) => (event: DragEvent) => {
    setDrag(item);
    event.dataTransfer.effectAllowed = item.kind === "move" ? "move" : "copy";
    event.dataTransfer.setData("text/plain", text);
  };
  const endDrag = () => { setDrag(null); setPreview(null); };

  // Corner resize -----------------------------------------------------------------------------
  const startResize = (widget: Widget) => (event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();
    // Capture keeps the moves coming while the pointer is over other widgets; resizing still works without it.
    try { event.currentTarget.setPointerCapture(event.pointerId); } catch { /* pointer not capturable */ }
    setResizing(widget.id);
    setSelected(widget.id);
  };
  const moveResize = (widget: Widget) => (event: ReactPointerEvent<HTMLDivElement>) => {
    if (resizing !== widget.id || !board.current) return;
    const rect = resizeTo(widget, cellAt(event.clientX, event.clientY, board.current.getBoundingClientRect(), grid, draft.row_height, GAP), grid);
    setPreview({ ...rect, ok: fits(rect, draft.widgets, grid, widget.id) });
  };
  const endResize = (widget: Widget) => () => {
    if (resizing !== widget.id) return;
    if (preview?.ok) patchWidget(widget.id, { w: preview.w, h: preview.h });
    setResizing(null);
    setPreview(null);
  };

  useEffect(() => {
    if (!editing) return;
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (!selected || (target && ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName))) return;
      if (event.key === "Delete" || event.key === "Backspace") { event.preventDefault(); removeWidget(selected); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // removeWidget only touches state setters
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing, selected]);

  const setGrid = (cols: number, rows: number) => {
    const cut = outside(draft.widgets, { cols, rows });
    if (cut.length) { setMessage({ tone: "error", text: t(`มี ${cut.length} วิดเจ็ตที่จะหลุดกริด ${cols}×${rows} — ย้ายหรือย่อก่อน`, `${cut.length} widget(s) would fall outside a ${cols}×${rows} grid; move or shrink them first.`) }); return; }
    change({ cols, rows });
  };

  // Save / share / copy / delete --------------------------------------------------------------
  const save = async () => {
    const title = draft.title.trim();
    if (!title) { setSelected(null); setEditing(true); setMessage({ tone: "error", text: t("ตั้งชื่อแดชบอร์ดก่อนบันทึก", "Give the dashboard a title before saving.") }); return; }
    setBusy(true);
    try {
      const saved = dashboard ? await saveDashboard(dashboard.id, { ...draft, title }) : await createDashboard({ ...draft, title });
      setDraft(inputOf(saved));
      setDirty(false);
      setMessage({ tone: "ok", text: t("บันทึกแล้ว", "Saved.") });
      onSaved(saved);
    } catch (error) { setMessage({ tone: "error", text: error instanceof Error ? error.message : String(error) }); }
    finally { setBusy(false); }
  };
  const toggleShare = async () => {
    if (!dashboard) return;
    setBusy(true);
    try {
      const next = await shareDashboard(dashboard.id, !dashboard.shared);
      setConfirm(null);
      setMessage({ tone: "ok", text: next.shared ? t(`แชร์แล้ว${next.snippetsShared ? ` (แชร์ snippet เพิ่ม ${next.snippetsShared} รายการ)` : ""}`, `Shared${next.snippetsShared ? `, together with ${next.snippetsShared} snippet(s)` : ""}.`) : t("เลิกแชร์แล้ว", "No longer shared.") });
      onSaved(next);
    } catch (error) { setMessage({ tone: "error", text: error instanceof Error ? error.message : String(error) }); }
    finally { setBusy(false); }
  };
  const copy = async () => {
    if (!dashboard) return;
    try { onSaved(await copyDashboard(dashboard.id)); } catch (error) { setMessage({ tone: "error", text: error instanceof Error ? error.message : String(error) }); }
  };
  const remove = async () => {
    if (!dashboard) return;
    try { await deleteDashboard(dashboard.id); onDeleted(); } catch (error) { setMessage({ tone: "error", text: error instanceof Error ? error.message : String(error) }); }
  };
  const snippetCount = useMemo(() => draft.widgets.filter(widget => widget.type === "snippet" && widget.config.artifactId).length, [draft.widgets]);

  const fullscreen = () => { void shell.current?.requestFullscreen?.().catch(() => undefined); };

  const cells = editing ? Array.from({ length: grid.cols * grid.rows }, (_, index) => ({ x: index % grid.cols, y: Math.floor(index / grid.cols) })) : [];

  return <div className="space-y-3">
    <div className={`${panel} flex flex-wrap items-center gap-2 p-2`}>
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-bold text-[var(--app-text)]">{draft.title || t("แดชบอร์ดใหม่", "New dashboard")}</div>
        <div className="text-[11px] text-[var(--app-muted)]">{draft.cols}×{draft.rows} · {draft.widgets.length} {t("วิดเจ็ต", "widgets")}
          {dashboard && !dashboard.mine ? ` · ${t("แชร์โดย", "shared by")} ${dashboard.owner_name}` : dashboard?.shared ? ` · ${t("แชร์แล้ว", "shared")}` : ""}
          {dirty ? <span className="ml-1 font-semibold text-amber-600 dark:text-amber-300">· {t("ยังไม่บันทึก", "unsaved")}</span> : null}</div>
      </div>
      {!editing ? <>
        <input type="date" aria-label={t("ตั้งแต่", "From")} className={inlineInput} value={period.from ?? ""} onChange={event => setPeriod(current => ({ ...current, from: event.target.value || undefined }))} />
        <span className="text-xs text-[var(--app-muted)]">→</span>
        <input type="date" aria-label={t("ถึง", "To")} className={inlineInput} value={period.to ?? ""} onChange={event => setPeriod(current => ({ ...current, to: event.target.value || undefined }))} />
        <button type="button" className={small} onClick={() => setRefreshKey(value => value + 1)}>↻ {t("รีเฟรช", "Refresh")}</button>
        <select className={inlineInput} value={autoRefresh} onChange={event => setAutoRefresh(Number(event.target.value))} aria-label={t("รีเฟรชอัตโนมัติ", "Auto-refresh")}>
          <option value={0}>{t("ไม่รีเฟรชอัตโนมัติ", "Auto-refresh off")}</option><option value={60}>{t("ทุก 1 นาที", "Every minute")}</option><option value={300}>{t("ทุก 5 นาที", "Every 5 minutes")}</option>
        </select>
        <button type="button" className={small} onClick={fullscreen}>⛶ {t("เต็มจอ", "Full screen")}</button>
      </> : null}
      {mine ? <button type="button" className={editing ? primary : secondary} onClick={() => { setEditing(value => !value); setSelected(null); }}>{editing ? t("ดูผล", "View") : t("แก้ไข", "Edit")}</button> : null}
      {mine && (dirty || editing) ? <button type="button" className={primary} disabled={busy || !dirty} onClick={() => void save()}>{t("บันทึก", "Save")}</button> : null}
      {mine && dashboard ? <button type="button" className={small} disabled={busy} onClick={() => (dashboard.shared ? void toggleShare() : setConfirm("share"))}>{dashboard.shared ? t("เลิกแชร์", "Unshare") : t("แชร์", "Share")}</button> : null}
      {dashboard && !dashboard.mine ? <button type="button" className={small} onClick={() => void copy()}>{t("คัดลอกเป็นของฉัน", "Copy to mine")}</button> : null}
      {mine && dashboard ? <button type="button" className={small} onClick={() => setConfirm("delete")}>🗑</button> : null}
    </div>

    {confirm ? <div role="alertdialog" className={`rounded-xl border p-3 text-sm text-[var(--app-text)] ${confirm === "delete" ? "border-rose-500/40" : "border-[var(--app-accent)]"} bg-[var(--app-panel-bg)]`}>
      <div className="font-semibold">{confirm === "delete" ? t(`ลบแดชบอร์ด "${draft.title}"?`, `Delete the dashboard "${draft.title}"?`) : t(`แชร์ "${draft.title}" ให้ผู้ใช้ AI Studio ทุกคน?`, `Share "${draft.title}" with every AI Studio user?`)}</div>
      <p className="mt-1 text-xs text-[var(--app-muted)]">{confirm === "delete" ? t("snippet ที่ใช้ในแดชบอร์ดไม่ถูกลบ", "The snippets on it are not deleted.")
        : snippetCount ? t(`snippet ของคุณ ${snippetCount} รายการบนบอร์ดนี้จะถูกแชร์ด้วย ผู้ชมจะเห็นข้อมูลตามสิทธิ์วอร์ดของตัวเอง`, `Your ${snippetCount} snippet(s) on this board are shared too. Viewers see data for their own ward access.`)
        : t("ผู้ชมจะเห็นข้อมูลตามสิทธิ์ของตัวเอง", "Viewers see data for their own access.")}</p>
      <div className="mt-2 flex gap-2">
        <button type="button" className={confirm === "delete" ? danger : primary} disabled={busy} onClick={() => void (confirm === "delete" ? remove() : toggleShare())}>{confirm === "delete" ? t("ลบ", "Delete") : t("แชร์", "Share")}</button>
        <button type="button" className={small} onClick={() => setConfirm(null)}>{t("ยกเลิก", "Cancel")}</button>
      </div>
    </div> : null}

    {message ? <div className={`rounded-xl border px-3 py-2 text-sm ${message.tone === "error" ? "border-rose-500/40 bg-rose-500/10 text-rose-600 dark:text-rose-300" : "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"}`}>
      {message.text}<button type="button" className="ml-2 text-xs underline" onClick={() => setMessage(null)}>{t("ปิด", "dismiss")}</button>
    </div> : null}

    <div className={editing ? "grid gap-3 xl:grid-cols-[200px_minmax(0,1fr)_300px]" : ""}>
      {editing ? <aside className={`${panel} max-h-[calc(100vh-160px)] space-y-3 overflow-y-auto p-2 xl:sticky xl:top-2`}>
        <p className="text-[11px] text-[var(--app-muted)]">{t("ลากไปวางบนช่องของบอร์ด หรือคลิกเพื่อเพิ่ม", "Drag onto a cell of the board, or click to add")}</p>
        {WIDGETS.map(group => <div key={group.en}>
          <div className="mb-1 text-[11px] font-bold uppercase tracking-[0.12em] text-[var(--app-muted)]">{tr(lang, group.th, group.en)}</div>
          <div className="space-y-1">{group.items.map(item => <button key={item.type} type="button" draggable onDragStart={startDrag({ kind: "new", type: item.type }, item.en)} onDragEnd={endDrag}
            onClick={() => addWidget(item.type)} title={tr(lang, item.hintTh, item.hintEn)}
            className="flex w-full cursor-grab items-center gap-2 rounded-lg border border-[var(--app-border)] bg-[var(--app-panel-bg)] px-2 py-1.5 text-left text-xs hover:border-[var(--app-accent)] active:cursor-grabbing">
            <span className="w-5 shrink-0 text-center">{item.icon}</span>
            <span className="min-w-0"><span className="block font-semibold text-[var(--app-text)]">{tr(lang, item.th, item.en)}</span>
              <span className="block truncate text-[10px] text-[var(--app-muted)]">{tr(lang, item.hintTh, item.hintEn)} · {item.size[0]}×{item.size[1]}</span></span>
          </button>)}</div>
        </div>)}
      </aside> : null}

      <div ref={shell} className="min-w-0 overflow-auto rounded-2xl bg-[var(--app-bg)] p-1" onClick={() => setSelected(null)}>
        <div ref={board} onDragOver={onDragOver} onDrop={onDrop} onDragLeave={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setPreview(null); }}
          className="relative grid" style={{ gridTemplateColumns: `repeat(${grid.cols}, minmax(0, 1fr))`, gridAutoRows: `${draft.row_height}px`, gap: GAP, minWidth: grid.cols * 140 }}>
          {cells.map(cell => <div key={`${cell.x}:${cell.y}`} aria-hidden className="rounded-xl border-2 border-dashed border-[var(--app-border)]"
            style={{ gridColumn: `${cell.x + 1} / span 1`, gridRow: `${cell.y + 1} / span 1` }} />)}
          {draft.widgets.map(widget => {
            const item = catalogItem(widget.type);
            const isSelected = editing && selected === widget.id;
            const showHeader = editing || widget.title;
            return <div key={widget.id} onClick={event => { event.stopPropagation(); if (editing) setSelected(widget.id); }}
              className={`relative z-10 flex min-h-0 flex-col overflow-hidden rounded-xl border bg-[var(--app-panel-bg)] ${isSelected ? "border-[var(--app-accent)] ring-2 ring-[var(--app-accent)]" : "border-[var(--app-border)]"} ${drag?.kind === "move" && drag.id === widget.id ? "opacity-40" : ""}`}
              style={{ gridColumn: `${widget.x + 1} / span ${widget.w}`, gridRow: `${widget.y + 1} / span ${widget.h}` }}>
              {showHeader ? <div draggable={editing} onDragStart={editing ? startDrag({ kind: "move", id: widget.id }, widget.title || item.en) : undefined} onDragEnd={endDrag}
                className={`flex shrink-0 items-center gap-1.5 border-b border-[var(--app-border)] px-2 py-1 text-xs ${editing ? "cursor-grab active:cursor-grabbing" : ""}`}>
                {editing ? <span className="text-[var(--app-muted)]" aria-hidden>⠿</span> : null}
                <span className="truncate font-semibold text-[var(--app-text)]">{widget.title || tr(lang, item.th, item.en)}</span>
                {editing ? <span className="ml-auto shrink-0 text-[10px] text-[var(--app-muted)]">{widget.w}×{widget.h}</span> : null}
                {editing ? <button type="button" aria-label={t("ลบ", "Remove")} className="shrink-0 rounded px-1 text-[var(--app-muted)] hover:text-rose-600" onClick={event => { event.stopPropagation(); removeWidget(widget.id); }}>×</button> : null}
              </div> : null}
              <div className={`min-h-0 flex-1 ${shieldFrames ? "pointer-events-none" : ""}`}>
                <WidgetBody widget={widget} lang={lang} snippets={snippets} boardPeriod={period} refreshKey={refreshKey} />
              </div>
              {editing ? <div role="separator" aria-label={t("ลากเพื่อปรับขนาด", "Drag to resize")} title={t("ลากเพื่อปรับขนาด", "Drag to resize")}
                onPointerDown={startResize(widget)} onPointerMove={moveResize(widget)} onPointerUp={endResize(widget)} onPointerCancel={endResize(widget)}
                className="absolute bottom-0 right-0 z-20 h-4 w-4 cursor-se-resize rounded-tl bg-[var(--app-accent)] opacity-70 hover:opacity-100" /> : null}
            </div>;
          })}
          {preview ? <div aria-hidden className={`pointer-events-none z-30 rounded-xl border-2 ${preview.ok ? "border-emerald-500 bg-emerald-500/15" : "border-rose-500 bg-rose-500/15"}`}
            style={{ gridColumn: `${preview.x + 1} / span ${preview.w}`, gridRow: `${preview.y + 1} / span ${preview.h}` }} /> : null}
        </div>
        {!draft.widgets.length && !editing ? <div className="p-10 text-center text-sm text-[var(--app-muted)]">{t("ยังไม่มีวิดเจ็ต — กดแก้ไขเพื่อเพิ่ม", "No widgets yet. Choose Edit to add some.")}</div> : null}
      </div>

      {editing ? <aside className={`${panel} max-h-[calc(100vh-160px)] space-y-3 overflow-y-auto p-3 xl:sticky xl:top-2`} onClick={event => event.stopPropagation()}>
        {selectedWidget ? <WidgetInspector lang={lang} widget={selectedWidget} widgets={draft.widgets} grid={grid} snippets={snippets}
          onPatch={patch => patchWidget(selectedWidget.id, patch)} onConfig={patch => patchConfig(selectedWidget.id, patch)} onRemove={() => removeWidget(selectedWidget.id)}
          onError={text => setMessage({ tone: "error", text })} />
          : <div className="space-y-3">
            <div className="text-[11px] font-bold uppercase tracking-[0.12em] text-[var(--app-muted)]">{t("แดชบอร์ด", "Dashboard")}</div>
            <label className="block space-y-1"><span className={label}>{t("ชื่อ", "Title")}</span>
              <input className={input} value={draft.title} maxLength={160} placeholder={t("เช่น ภาพรวมห้องผ่าตัด", "e.g. OR overview")} onChange={event => change({ title: event.target.value })} /></label>
            <div className="space-y-1"><span className={label}>{t("ขนาดกริด (คอลัมน์ × แถว)", "Grid (columns × rows)")}</span>
              <div className="flex flex-wrap gap-1">{GRID_PRESETS.map(([cols, rows]) => <button key={`${cols}x${rows}`} type="button" onClick={() => setGrid(cols, rows)}
                className={`${small} ${grid.cols === cols && grid.rows === rows ? "!border-[var(--app-accent)] !bg-[var(--app-hover-bg)]" : ""}`}>{cols}×{rows}</button>)}</div>
              <div className="flex items-center gap-1 text-xs text-[var(--app-muted)]">
                <select className={inlineInput} value={grid.cols} onChange={event => setGrid(Number(event.target.value), grid.rows)} aria-label={t("คอลัมน์", "Columns")}>
                  {Array.from({ length: MAX_GRID }, (_, index) => index + 1).map(value => <option key={value} value={value}>{value}</option>)}</select>×
                <select className={inlineInput} value={grid.rows} onChange={event => setGrid(grid.cols, Number(event.target.value))} aria-label={t("แถว", "Rows")}>
                  {Array.from({ length: MAX_GRID }, (_, index) => index + 1).map(value => <option key={value} value={value}>{value}</option>)}</select>
              </div>
            </div>
            <label className="block space-y-1"><span className={label}>{t("ความสูงแถว", "Row height")}</span>
              <select className={input} value={draft.row_height} onChange={event => change({ row_height: Number(event.target.value) })}>
                {ROW_HEIGHTS.map(([value, th, en]) => <option key={value} value={value}>{tr(lang, th, en)} ({value}px)</option>)}</select></label>
            <p className="text-[11px] leading-relaxed text-[var(--app-muted)]">{t("คลิกวิดเจ็ตเพื่อตั้งค่า ลากหัววิดเจ็ตเพื่อย้าย ลากมุมขวาล่างเพื่อปรับขนาด (เช่น 2×1, 1×2) กด Delete เพื่อลบ",
              "Click a widget to set it up. Drag its header to move it and its bottom-right corner to resize it (e.g. 2×1, 1×2). Press Delete to remove it.")}</p>
          </div>}
      </aside> : null}
    </div>
  </div>;
}

function WidgetInspector({ lang, widget, widgets, grid, snippets, onPatch, onConfig, onRemove, onError }: {
  lang: Lang; widget: Widget; widgets: Widget[]; grid: { cols: number; rows: number }; snippets: KeptArtifact[];
  onPatch: (patch: Partial<Widget>) => void; onConfig: (patch: Record<string, unknown>) => void; onRemove: () => void; onError: (text: string) => void;
}) {
  const t = (th: string, en: string) => tr(lang, th, en);
  const item = catalogItem(widget.type);
  const upload = (file: File | undefined) => {
    if (!file) return;
    if (!/^image\/(png|jpeg|gif|webp|svg\+xml)$/.test(file.type)) { onError(t("รองรับ PNG, JPEG, GIF, WebP, SVG", "Use a PNG, JPEG, GIF, WebP or SVG picture.")); return; }
    if (file.size > 1_000_000) { onError(t("รูปต้องเล็กกว่า 1 MB", "Pictures must be under 1 MB.")); return; }
    const reader = new FileReader();
    reader.onload = () => onConfig({ src: String(reader.result) });
    reader.readAsDataURL(file);
  };
  return <div className="space-y-3">
    <div className="flex items-center gap-2">
      <span className="text-lg">{item.icon}</span>
      <div><div className="text-sm font-semibold text-[var(--app-text)]">{tr(lang, item.th, item.en)}</div><div className="text-[11px] text-[var(--app-muted)]">{tr(lang, item.hintTh, item.hintEn)}</div></div>
    </div>
    <label className="block space-y-1"><span className={label}>{t("หัวข้อ (ไม่บังคับ)", "Heading (optional)")}</span>
      <input className={input} value={widget.title} maxLength={160} onChange={event => onPatch({ title: event.target.value })} /></label>
    <div className="space-y-1"><span className={label}>{t("ขนาด (กว้าง × สูง)", "Size (wide × tall)")}</span>
      <div className="flex flex-wrap gap-1">{SIZE_PRESETS.filter(([w, h]) => w <= grid.cols && h <= grid.rows).map(([w, h]) => {
        const ok = fits({ x: widget.x, y: widget.y, w, h }, widgets, grid, widget.id);
        return <button key={`${w}x${h}`} type="button" disabled={!ok} title={ok ? "" : t("ไม่พอที่ตำแหน่งนี้", "No room at this position")} onClick={() => onPatch({ w, h })}
          className={`${small} ${widget.w === w && widget.h === h ? "!border-[var(--app-accent)] !bg-[var(--app-hover-bg)]" : ""}`}>{w}×{h}</button>;
      })}</div>
    </div>

    {widget.type === "snippet" ? <label className="block space-y-1"><span className={label}>Snippet</span>
      <select className={input} value={String(widget.config.artifactId ?? "")} onChange={event => onConfig({ artifactId: event.target.value })}>
        <option value="">{t("— เลือก —", "— choose —")}</option>
        {snippets.map(snippet => <option key={snippet.id} value={snippet.id}>{snippet.title}{snippet.mine ? "" : ` (${snippet.owner_name})`}</option>)}
      </select>
      {!snippets.length ? <span className="block text-[11px] text-[var(--app-muted)]">{t("ยังไม่มี snippet — กด Keep ใต้ภาพในแชท", "No snippets yet. Use Keep on a visual in a chat.")}</span> : null}
    </label> : null}
    {widget.type === "html" ? <label className="block space-y-1"><span className={label}>HTML / CSS / JS</span>
      <textarea className={`${input} h-64 font-mono text-xs`} spellCheck={false} value={String(widget.config.html ?? "")} onChange={event => onConfig({ html: event.target.value })} />
      <span className="block text-[11px] text-[var(--app-muted)]">{t("รันใน sandbox ไม่มีเครือข่าย ใช้ FloraChart ได้", "Runs in a sandbox without network access; FloraChart is available.")}</span></label> : null}
    {widget.type === "image" ? <div className="space-y-2">
      <label className="block space-y-1"><span className={label}>URL</span>
        <input className={input} placeholder="https://…" value={String(widget.config.src ?? "").startsWith("data:") ? "" : String(widget.config.src ?? "")} onChange={event => onConfig({ src: event.target.value.trim() })} /></label>
      <label className={`${small} inline-block cursor-pointer`}>{t("อัปโหลดรูป…", "Upload a picture…")}<input type="file" accept="image/png,image/jpeg,image/gif,image/webp,image/svg+xml" className="hidden" onChange={event => upload(event.target.files?.[0])} /></label>
      {String(widget.config.src ?? "").startsWith("data:") ? <span className="ml-2 text-[11px] text-[var(--app-muted)]">{t("ใช้รูปที่อัปโหลด", "Using an uploaded picture")}</span> : null}
      <label className="block space-y-1"><span className={label}>{t("การจัดรูป", "Fit")}</span>
        <select className={input} value={String(widget.config.fit ?? "contain")} onChange={event => onConfig({ fit: event.target.value })}>
          <option value="contain">{t("พอดีกรอบ (ไม่ตัด)", "Fit inside")}</option><option value="cover">{t("เต็มกรอบ (ตัดขอบ)", "Fill (crop)")}</option></select></label>
    </div> : null}
    {widget.type === "text" ? <label className="block space-y-1"><span className={label}>{t("ข้อความ (Markdown)", "Text (Markdown)")}</span>
      <textarea className={`${input} h-48`} value={String(widget.config.text ?? "")} onChange={event => onConfig({ text: event.target.value })} /></label> : null}
    {widget.type === "active_cases" ? <label className="flex items-center gap-2 text-xs text-[var(--app-text)]">
      <input type="checkbox" checked={Boolean(widget.config.showHn)} onChange={event => onConfig({ showHn: event.target.checked })} />
      {t("แสดง HN (ระวังเมื่อแสดงบนจอสาธารณะ)", "Show HN (take care on public screens)")}</label> : null}
    {["system_status", "gateway_alerts", "case_counts", "clock"].includes(widget.type) ? <p className="text-[11px] text-[var(--app-muted)]">{t("อัปเดตอัตโนมัติ ข้อมูลตามสิทธิ์ของผู้ชม", "Updates by itself, using the viewer's own access.")}</p> : null}

    <button type="button" className={danger} onClick={onRemove}>{t("ลบวิดเจ็ต", "Remove widget")}</button>
  </div>;
}
