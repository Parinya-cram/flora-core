/**
 * The page being designed: sections, categories and fields on their grid (24 columns for new forms), as the form will
 * look. On the desktop view the grid is two-dimensional: drop a field (from the palette, or a card being moved) on
 * any row and column, and drag a card's right edge, bottom edge or corner to change its width and height in cells;
 * fields it would cover move down. Shift / Ctrl-click selects several cards; arrow keys move the selection, Shift +
 * arrows resize it (DesignerPanel). Tablet and phone views reorder the flow instead. Every drag has a button or key
 * alternative for touch screens and keyboards.
 */
import { useRef, useState, type CSSProperties, type MutableRefObject, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { containerColumns, formColumns, gridArea, placeField, type GridCell } from "../core/layout";
import type { CategoryDefinition, FieldDefinition, FormDefinition, LayoutMode, SectionDefinition } from "../core/types";
import { fieldKey } from "../core/validate";
import { tr, typeIcon, typeName, type Lang } from "./catalog";
import { DRAG_MIME, type DragItem, type DropTarget } from "./drag";
import { cellsOf, fieldPath, samePath, type FieldRef, type Path, type Selection } from "./model";
import { fieldLabel } from "../core/labels";
import { small } from "./styles";
import PrintedElement from "../ui/PrintedElement";
import CaseBlockTable from "../ui/CaseBlockTable";

type Ctx = {
  definition: FormDefinition; lang: Lang; mode: Exclude<LayoutMode, "print">; selection: Selection; styleColumns: number;
  /** The item being dragged (kept by the panel; HTML5 drag events cannot carry it during dragover). */
  getDrag: () => DragItem | null;
  setDrag: (item: DragItem | null) => void;
  /** additive: Shift / Ctrl / Cmd-click adds the card to (or takes it from) the selection. */
  onSelect: (selection: Selection, additive?: boolean) => void;
  /** Cards selected besides the primary selection (multi-select). */
  also: FieldRef[];
  onDrop: (item: DragItem, target: DropTarget) => void;
  /** Width / height (desktop: cells; tablet: width only) of a card resized by its handles. */
  onResize: (ref: FieldRef, size: { span: number; rows?: number; columns: number }) => void;
  /** Show the grid's columns and rows. */
  showGrid: boolean;
  onFieldAction: (ref: FieldRef, action: "up" | "down" | "duplicate" | "remove") => void;
  onSectionAction: (path: Path, action: "up" | "down" | "remove" | "add_category") => void;
};
type Props = Omit<Ctx, "also" | "showGrid"> & Partial<Pick<Ctx, "also" | "showGrid">>;

const startsWith = (path: Path, prefix: Path) => prefix.length <= path.length && prefix.every((step, index) => path[index] === step);
const isSelected = (ctx: Ctx, path: Path, kind: Selection["kind"]) =>
  (ctx.selection.kind === kind && (kind === "field" ? samePath(fieldPath((ctx.selection as { ref: FieldRef }).ref), path) : samePath((ctx.selection as { path: Path }).path, path)))
  || (kind === "field" && ctx.also.some(ref => samePath(fieldPath(ref), path)));
const additive = (event: { shiftKey: boolean; metaKey: boolean; ctrlKey: boolean }) => event.shiftKey || event.metaKey || event.ctrlKey;
/** Smallest height of a grid row in the designer (a one-line field). */
const ROW_PX = 52;

export default function Canvas(input: Props) {
  const props: Ctx = { ...input, also: input.also ?? [], showGrid: input.showGrid ?? false };
  const { definition, lang } = props;
  return <div className="space-y-4">
    <div className="border-b border-[var(--app-border)] pb-2">
      <div className="text-xl font-semibold text-[var(--app-text)]">{definition.title || tr(lang, "(ยังไม่มีชื่อแบบฟอร์ม)", "(untitled form)")}</div>
      {definition.description ? <div className="text-sm text-[var(--app-muted)]">{definition.description}</div> : null}
    </div>
    {definition.sections.map((section, index) => <SectionCard key={section.id} ctx={props} section={section} path={["sections", index]} index={index} count={definition.sections.length}
      columns={formColumns(definition)} depth={1} />)}
  </div>;
}

function SectionCard({ ctx, section, path, index, count, columns, depth }: { ctx: Ctx; section: SectionDefinition; path: Path; index: number; count: number; columns: number; depth: number }) {
  const selected = isSelected(ctx, path, "section");
  const inner = containerColumns(section.layout, columns);
  const t = (th: string, en: string) => tr(ctx.lang, th, en);
  return <section className={`rounded-2xl border-2 bg-[var(--app-panel-bg)] p-3 ${selected ? "border-[var(--app-accent)]" : "border-dashed border-[var(--app-border)]"}`}
    onClick={event => { event.stopPropagation(); ctx.onSelect({ kind: "section", path }); }}>
    <header className="mb-2 flex flex-wrap items-center justify-between gap-2">
      <div className="flex items-center gap-2">
        <span className={`font-semibold text-[var(--app-text)] ${depth === 1 ? "text-base" : "text-sm"}`}>{section.title || t("(ไม่มีหัวข้อ)", "(untitled)")}</span>
        {section.repeat ? <Badge>{t("กรอกซ้ำได้", "repeats")}</Badge> : null}
        {section.visibility ? <Badge>{t("มีเงื่อนไข", "conditional")}</Badge> : null}
        {section.permission ? <Badge>🔒</Badge> : null}
        {section.page_break === "before" ? <Badge>{t("หน้าใหม่", "new page")}</Badge> : null}
      </div>
      {selected ? <div className="flex gap-1" onClick={event => event.stopPropagation()}>
        <button type="button" className={small} disabled={index === 0} onClick={() => ctx.onSectionAction(path, "up")} title={t("เลื่อนขึ้น", "Move up")}>↑</button>
        <button type="button" className={small} disabled={index === count - 1} onClick={() => ctx.onSectionAction(path, "down")} title={t("เลื่อนลง", "Move down")}>↓</button>
        <button type="button" className={small} onClick={() => ctx.onSectionAction(path, "add_category")}>+ {t("หมวดย่อย", "Category")}</button>
        <button type="button" className={small} disabled={count === 1 && depth === 1} onClick={() => ctx.onSectionAction(path, "remove")} title={t("ลบส่วนนี้", "Delete section")}>🗑</button>
      </div> : null}
    </header>
    <FieldList ctx={ctx} fields={section.fields} list={[...path, "fields"]} columns={inner} containerType={section.layout?.type ?? "grid"} emptyHint={(section.categories?.length || section.sections?.length) ? null : undefined} />
    {(section.categories ?? []).map((category, c) => <CategoryCard key={category.id} ctx={ctx} category={category} path={[...path, "categories", c]} columns={inner} />)}
    {(section.sections ?? []).map((child, s) => <div key={child.id} className="mt-3">
      <SectionCard ctx={ctx} section={child} path={[...path, "sections", s]} index={s} count={section.sections!.length} columns={inner} depth={depth + 1} />
    </div>)}
  </section>;
}

function CategoryCard({ ctx, category, path, columns }: { ctx: Ctx; category: CategoryDefinition; path: Path; columns: number }) {
  const selected = isSelected(ctx, path, "category");
  const t = (th: string, en: string) => tr(ctx.lang, th, en);
  return <div className={`mt-3 rounded-xl border-l-4 bg-[var(--app-bg)] p-2 pl-3 ${selected ? "border-[var(--app-accent)] ring-1 ring-[var(--app-accent)]" : "border-[var(--app-border)]"}`}
    onClick={event => { event.stopPropagation(); ctx.onSelect({ kind: "category", path }); }}>
    <div className="mb-2 flex items-center justify-between gap-2">
      <span className="text-sm font-bold text-[var(--app-text)]">{category.title}</span>
      <div className="flex items-center gap-1">
        {category.repeat ? <Badge>{t("กรอกซ้ำได้", "repeats")}</Badge> : null}
        {category.visibility ? <Badge>{t("มีเงื่อนไข", "conditional")}</Badge> : null}
        {selected ? <button type="button" className={small} onClick={event => { event.stopPropagation(); ctx.onSectionAction(path, "remove"); }}>🗑</button> : null}
      </div>
    </div>
    <FieldList ctx={ctx} fields={category.fields} list={[...path, "fields"]} columns={containerColumns(category.layout, columns)} containerType={category.layout?.type ?? "grid"} />
  </div>;
}

/** A field list on its grid: the drop zone. On the desktop view it is a two-dimensional grid of rows and columns. */
function FieldList({ ctx, fields, list, columns, containerType, emptyHint }: {
  ctx: Ctx; fields: FieldDefinition[]; list: Path; columns: number; containerType: "grid" | "row" | "column"; emptyHint?: null;
}) {
  const gridRef = useRef<HTMLDivElement | null>(null);
  const [target, setTarget] = useState<{ index: number; col: number | null; row?: number; x: number; y: number; height: number; span: number } | null>(null);
  const t = (th: string, en: string) => tr(ctx.lang, th, en);
  const free = ctx.mode === "desktop" && containerType === "grid";
  const cells = free ? cellsOf(fields, columns, ctx.styleColumns) : [];
  const lastRow = cells.reduce((most, cell) => Math.max(most, cell.row + cell.rows - 1), 0);

  /** Row r's top and height on screen (from the invisible row markers). */
  const rowBox = (r: number) => {
    const grid = gridRef.current;
    const marker = grid?.querySelector<HTMLElement>(`:scope > [data-row="${r}"]`);
    if (marker) {
      const box = marker.getBoundingClientRect();
      return { top: box.top, height: box.height };
    }
    const last = grid?.querySelector<HTMLElement>(`:scope > [data-row="${lastRow + 1}"]`)?.getBoundingClientRect();
    return { top: (last?.bottom ?? grid?.getBoundingClientRect().bottom ?? 0) + (r - lastRow - 2) * ROW_PX, height: ROW_PX };
  };

  const compute = (clientX: number, clientY: number) => {
    const grid = gridRef.current;
    if (!grid) return null;
    const box = grid.getBoundingClientRect();
    if (free) {
      const colWidth = box.width / columns;
      const item = ctx.getDrag();
      const span = Math.min(spanOf(item, columns), columns);
      let row = lastRow + 1;
      for (let r = 1; r <= lastRow + 1; r += 1) {
        const { top, height } = rowBox(r);
        if (clientY < top + height) { row = r; break; }
      }
      const col = Math.max(1, Math.min(columns - span + 1, Math.floor((clientX - box.left) / colWidth) + 1));
      const top = rowBox(row).top - box.top;
      const rows = item?.kind === "move" ? item.rows : 1;
      let height = 0;
      for (let r = row; r < row + rows; r += 1) height += rowBox(r).height;
      return { index: fields.length, col, row, x: (col - 1) * colWidth, y: top, height: Math.max(ROW_PX - 8, height - 8), span };
    }
    const cards = [...grid.querySelectorAll<HTMLElement>(":scope > [data-card]")].map(card => card.getBoundingClientRect());
    const inside = cards.findIndex(rect => clientX >= rect.left && clientX <= rect.right && clientY >= rect.top && clientY <= rect.bottom);
    if (inside >= 0) {
      const rect = cards[inside];
      const before = clientX < rect.left + rect.width / 2;
      return { index: before ? inside : inside + 1, col: null, x: (before ? rect.left : rect.right) - box.left, y: rect.top - box.top, height: rect.height, span: 0 };
    }
    const index = cards.filter(rect => rect.bottom <= clientY || (rect.top <= clientY && rect.right <= clientX)).length;
    const colWidth = box.width / columns;
    const span = Math.min(spanOf(ctx.getDrag(), columns), columns);
    const tablet = ctx.mode === "tablet" && containerType === "grid";
    const col = tablet ? Math.max(1, Math.min(columns - span + 1, Math.floor((clientX - box.left) / colWidth) + 1)) : null;
    return { index, col, x: col ? (col - 1) * colWidth : 0, y: Math.max(0, clientY - box.top - 18), height: 36, span };
  };
  const accepts = () => {
    const item = ctx.getDrag();
    return item !== null && !(item.kind === "move" && startsWith(list, fieldPath(item.ref)));
  };
  const gridLines: CSSProperties = ctx.showGrid && free ? {
    backgroundImage: `repeating-linear-gradient(90deg, transparent 0 calc(100% / ${columns} - 1px), rgba(99,102,241,0.14) calc(100% / ${columns} - 1px) calc(100% / ${columns}))`,
  } : {};

  return <div
    onDragOver={event => {
      if (!accepts()) return;
      event.preventDefault();
      event.stopPropagation();
      event.dataTransfer.dropEffect = ctx.getDrag()?.kind === "move" ? "move" : "copy";
      setTarget(compute(event.clientX, event.clientY));
    }}
    onDragLeave={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setTarget(null); }}
    onDrop={event => {
      if (!accepts()) return;
      event.preventDefault();
      event.stopPropagation();
      const where = compute(event.clientX, event.clientY);
      setTarget(null);
      const item = ctx.getDrag();
      ctx.setDrag(null);
      if (item && where) ctx.onDrop(item, { list, index: where.index, col: where.col, row: where.row, span: free ? where.span : undefined, columns });
    }}
    className="relative">
    <div ref={gridRef} className="relative grid min-h-[56px] gap-2 rounded-lg" style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`, gridAutoRows: free ? `minmax(${ROW_PX}px, auto)` : undefined, ...gridLines }}>
      {free ? Array.from({ length: lastRow + 1 }, (_, i) => <div key={`row${i + 1}`} data-row={i + 1} aria-hidden className={`pointer-events-none ${ctx.showGrid ? "border-t border-dashed border-indigo-300/40" : ""}`}
        style={{ gridRow: i + 1, gridColumn: "1 / -1" }} />) : null}
      {fields.map((field, index) => <FieldCard key={`${field.id}-${index}`} ctx={ctx} field={field} fieldRef={{ list, index }} count={fields.length}
        columns={columns} containerType={containerType} siblings={fields.length} gridRef={gridRef} cell={free ? cells[index] : undefined} rowBox={rowBox} />)}
      {!fields.length && emptyHint !== null ? <div className="col-span-full flex min-h-[56px] items-center justify-center rounded-xl border-2 border-dashed border-[var(--app-border)] text-sm text-[var(--app-muted)]">
        {t("ลากช่องจากด้านซ้ายมาวางที่นี่ หรือคลิกช่องในแถบด้านซ้าย", "Drag a field here, or click one in the palette")}
      </div> : null}
    </div>
    {target ? (target.col !== null
      ? <div className="pointer-events-none absolute rounded-lg border-2 border-dashed border-[var(--app-accent)] bg-[var(--app-accent)]/10"
          style={{ left: target.x, top: target.y, height: target.height, width: `${(Math.min(target.span, columns - target.col + 1) / columns) * 100}%` }}>
          {target.row ? <span className="absolute -top-5 left-0 rounded bg-[var(--app-accent)] px-1.5 text-[10px] font-bold text-[var(--app-accent-contrast)]">
            {t("แถว", "row")} {target.row} · {t("คอลัมน์", "col")} {target.col} · {target.span}/{columns}</span> : null}
        </div>
      : <div className="pointer-events-none absolute w-1 rounded bg-[var(--app-accent)]" style={{ left: Math.max(0, target.x - 3), top: target.y, height: target.height }} />) : null}
  </div>;
}

/** Width of a dragged item: its own for a card, half the grid for a new field, the whole grid for a block. */
const spanOf = (item: DragItem | null, columns: number) => (item?.kind === "move" ? item.span : item?.kind === "block" ? columns : Math.max(1, Math.round(columns / 2)));

function FieldCard({ ctx, field, fieldRef, count, columns, containerType, siblings, gridRef, cell, rowBox }: {
  ctx: Ctx; field: FieldDefinition; fieldRef: FieldRef; count: number; columns: number; containerType: "grid" | "row" | "column"; siblings: number;
  gridRef: MutableRefObject<HTMLDivElement | null>;
  /** Desktop: the cell it takes on the two-dimensional grid. */
  cell?: GridCell;
  rowBox: (row: number) => { top: number; height: number };
}) {
  const path = fieldPath(fieldRef);
  const selected = isSelected(ctx, path, "field");
  const placement = placeField(field, ctx.mode, columns, ctx.styleColumns, containerType, siblings);
  const [resizing, setResizing] = useState<{ span: number; rows: number } | null>(null);
  const t = (th: string, en: string) => tr(ctx.lang, th, en);
  const span = resizing?.span ?? cell?.span ?? placement.span;
  const rows = resizing?.rows ?? cell?.rows ?? 1;
  const area = cell
    ? { gridColumn: `${cell.col} / span ${Math.min(span, columns - cell.col + 1)}`, gridRow: `${cell.row} / span ${rows}` }
    : gridArea({ ...placement, span, col: placement.col !== undefined ? Math.min(placement.col, columns - span + 1) : undefined });
  const hiddenHere = placement.hidden;
  const label = fieldLabel(field, ctx.lang === "en" ? "en" : "th");

  /** Drag a handle: "x" the right edge (width), "y" the bottom edge (rows covered), "xy" the corner. */
  const startResize = (axis: "x" | "y" | "xy") => (event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();
    const grid = gridRef.current;
    if (!grid) return;
    const colWidth = grid.getBoundingClientRect().width / columns;
    const startX = event.clientX;
    const startSpan = cell?.span ?? placement.span;
    const startRows = cell?.rows ?? 1;
    const top = cell ? rowBox(cell.row).top : 0;
    const handle = event.currentTarget;
    try {
      handle.setPointerCapture(event.pointerId);
    } catch {
      // Some pens / synthetic pointers cannot be captured; moves over the handle still resize.
    }
    let latest = { span: startSpan, rows: startRows };
    const move = (moveEvent: PointerEvent) => {
      const nextSpan = axis === "y" ? startSpan : Math.max(1, Math.min(columns - (cell ? cell.col - 1 : 0), Math.round(startSpan + (moveEvent.clientX - startX) / colWidth)));
      let nextRows = startRows;
      if (axis !== "x" && cell) {
        // The rows whose middle the pointer has passed.
        nextRows = 1;
        for (let r = cell.row + 1; r < cell.row + 50; r += 1) {
          const box = rowBox(r);
          if (moveEvent.clientY > box.top + box.height / 2) nextRows = r - cell.row + 1;
          else break;
        }
        if (moveEvent.clientY < top) nextRows = 1;
      }
      latest = { span: nextSpan, rows: nextRows };
      setResizing(latest);
    };
    const up = () => {
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", up);
      setResizing(null);
      if (latest.span !== startSpan || latest.rows !== startRows) ctx.onResize(fieldRef, cell ? { ...latest, columns } : { span: latest.span, columns });
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", up);
  };

  const style: CSSProperties = { ...area };
  const handles = ctx.mode !== "mobile" && containerType === "grid";
  return <div data-card draggable={resizing === null} style={style}
    onDragStart={event => {
      event.stopPropagation();
      ctx.setDrag({ kind: "move", ref: fieldRef, span: cell?.span ?? placement.span, rows: cell?.rows ?? 1 });
      event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData(DRAG_MIME, fieldKey(field));
      event.dataTransfer.setData("text/plain", field.label);
    }}
    onDragEnd={() => ctx.setDrag(null)}
    onClick={event => { event.stopPropagation(); ctx.onSelect({ kind: "field", ref: fieldRef }, additive(event)); }}
    onKeyDown={event => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); ctx.onSelect({ kind: "field", ref: fieldRef }, additive(event)); } }}
    tabIndex={0} role="button" aria-pressed={selected} aria-label={label}
    className={`group relative cursor-grab rounded-xl border bg-[var(--app-panel-bg)] p-2 text-left shadow-sm transition active:cursor-grabbing
      ${selected ? "border-[var(--app-accent)] ring-2 ring-[var(--app-accent)]/40" : "border-[var(--app-border)] hover:border-[var(--app-accent)]/60"} ${hiddenHere ? "opacity-40" : ""}`}>
    <div className="flex items-start justify-between gap-1">
      <div className="min-w-0">
        <div className="truncate text-sm font-semibold text-[var(--app-text)]">
          {label || t("(ไม่มีชื่อ)", "(no label)")}{field.required || field.validation?.required ? <span className="text-rose-500"> *</span> : null}
          {field.unit ? <span className="font-normal text-[var(--app-muted)]"> ({field.unit})</span> : null}
        </div>
        <div className="flex flex-wrap items-center gap-1 text-[10px] text-[var(--app-muted)]">
          <span>{typeIcon(field.type)} {typeName(field.type, ctx.lang)}</span>
          <code className="rounded bg-[var(--app-control-bg)] px-1" title={t("ชื่อตัวแปร", "Variable name")}>{fieldKey(field)}</code>
          {field.bind ? <Badge>⛓ {field.bind}</Badge> : null}
          {field.visibility ? <Badge>{t("มีเงื่อนไข", "conditional")}</Badge> : null}
          {field.lookup || field.derive ? <Badge>{t("ตารางอ้างอิง", "lookup")}</Badge> : null}
          {field.permission ? <Badge>🔒</Badge> : null}
          {field.indexed ? <Badge>{t("ค้นหาได้", "search")}</Badge> : null}
          {hiddenHere ? <Badge>{t("ซ่อนในโหมดนี้", "hidden here")}</Badge> : null}
        </div>
      </div>
      {selected ? <div className="flex shrink-0 gap-0.5" onClick={event => event.stopPropagation()}>
        {cell ? null : <>
          <button type="button" className={small} disabled={fieldRef.index === 0} onClick={() => ctx.onFieldAction(fieldRef, "up")} title={t("เลื่อนก่อน", "Move earlier")}>↑</button>
          <button type="button" className={small} disabled={fieldRef.index === count - 1} onClick={() => ctx.onFieldAction(fieldRef, "down")} title={t("เลื่อนหลัง", "Move later")}>↓</button>
        </>}
        <button type="button" className={small} onClick={() => ctx.onFieldAction(fieldRef, "duplicate")} title={t("ทำสำเนา (Ctrl+D)", "Duplicate (Ctrl+D)")}>⧉</button>
        <button type="button" className={small} onClick={() => ctx.onFieldAction(fieldRef, "remove")} title={t("ลบ (Delete)", "Delete (Delete)")}>🗑</button>
      </div> : null}
    </div>
    <div className="mt-1.5"><MockInput field={field} ctx={ctx} fieldRef={fieldRef} columns={columns} /></div>
    {handles ? <>
      <div onPointerDown={startResize("x")} draggable={false} onDragStart={event => { event.preventDefault(); event.stopPropagation(); }}
        title={t("ลากเพื่อปรับความกว้าง", "Drag to change the width")} aria-hidden
        className="absolute right-0 top-0 flex h-full w-2.5 cursor-ew-resize items-center justify-center rounded-r-xl opacity-0 transition group-hover:opacity-100 hover:bg-[var(--app-accent)]/20">
        <span className="h-6 w-0.5 rounded bg-[var(--app-accent)]" />
      </div>
      {cell ? <>
        <div onPointerDown={startResize("y")} draggable={false} onDragStart={event => { event.preventDefault(); event.stopPropagation(); }}
          title={t("ลากเพื่อให้สูงหลายแถว", "Drag to cover more rows")} aria-hidden
          className="absolute bottom-0 left-0 flex h-2.5 w-full cursor-ns-resize items-center justify-center rounded-b-xl opacity-0 transition group-hover:opacity-100 hover:bg-[var(--app-accent)]/20">
          <span className="h-0.5 w-6 rounded bg-[var(--app-accent)]" />
        </div>
        <div onPointerDown={startResize("xy")} draggable={false} onDragStart={event => { event.preventDefault(); event.stopPropagation(); }}
          title={t("ลากมุมเพื่อปรับกว้างและสูง", "Drag the corner to change width and height")} aria-hidden
          className="absolute bottom-0 right-0 h-3.5 w-3.5 cursor-nwse-resize rounded-br-xl opacity-0 transition group-hover:opacity-100"
          style={{ background: "linear-gradient(135deg, transparent 50%, var(--app-accent) 50%)" }} />
      </> : null}
    </> : null}
    {resizing !== null ? <div className="absolute -top-6 right-0 rounded bg-[var(--app-accent)] px-1.5 text-[10px] font-bold text-[var(--app-accent-contrast)]">
      {resizing.span}/{columns}{cell ? ` × ${resizing.rows} ${t("แถว", "rows")}` : ""}</div> : null}
  </div>;
}

/** What the field will look like (not interactive), with nested drop zones for groups and repeats. */
function MockInput({ field, ctx, fieldRef, columns }: { field: FieldDefinition; ctx: Ctx; fieldRef: FieldRef; columns: number }) {
  const t = (th: string, en: string) => tr(ctx.lang, th, en);
  const box = "rounded-md border border-[var(--app-border)] bg-[var(--app-bg)] px-2 py-1 text-xs text-[var(--app-muted)]";
  if (field.type === "group" || field.type === "repeat") {
    const inner = containerColumns({ columns: field.columns }, columns);
    return <div className="rounded-lg border border-dashed border-[var(--app-border)] p-1.5">
      {field.type === "repeat" ? <div className="mb-1 text-[10px] text-[var(--app-muted)]">{t("แต่ละแถวประกอบด้วย:", "Each row has:")}</div> : null}
      <FieldList ctx={ctx} fields={field.fields ?? []} list={[...fieldPath(fieldRef), "fields"]} columns={inner} containerType="grid" />
      {field.type === "repeat" ? <div className="mt-1 text-[10px] text-[var(--app-accent)]">+ {t("เพิ่มแถว", "Add row")}</div> : null}
    </div>;
  }
  // Printed elements as they print (a sample HN for the barcode).
  if (field.type === "logo" || field.type === "barcode") return <PrintedElement field={field} data={field.source ? { [field.source]: field.symbology === "i2of5" || !field.symbology ? "6512345" : "67-00123" } : {}} />;
  // Report components with sample rows at their column widths.
  if (field.type === "case_block") return <CaseBlockTable field={field} sample language={ctx.lang} />;
  if (field.lookup) return <div className={box}>▾ {t(`เลือกจากตาราง ${field.lookup.source}`, `from table ${field.lookup.source}`)}</div>;
  if (field.options?.length && (field.type === "radio" || field.type === "multiselect")) {
    const mark = field.type === "radio" ? "○" : "☐";
    return <div className="flex flex-wrap gap-x-3 text-xs text-[var(--app-muted)]">
      {field.options.slice(0, 4).map(option => <span key={option.value}>{mark} {option.label}</span>)}
      {field.options.length > 4 ? <span>+{field.options.length - 4}</span> : null}
    </div>;
  }
  const text: Record<string, string> = {
    select: `▾ ${field.options?.[0]?.label ?? ""}`, date: t("วว/ดด/ปปปป", "dd/mm/yyyy"), datetime: t("วว/ดด/ปปปป --:--", "dd/mm/yyyy --:--"), time: "--:--",
    checkbox: `☐ ${field.label}`, switch: t("◯ ไม่ใช่ / ใช่", "◯ no / yes"), calculated: t("= คำนวณอัตโนมัติ", "= calculated"),
    file: t("📎 แนบไฟล์", "📎 attach a file"), image: t("🖼 แนบรูป", "🖼 attach an image"), signature: t("✍ เซ็นชื่อ", "✍ sign here"),
  };
  const shown = text[field.type] ?? field.placeholder ?? "";
  return <div className={`${box} ${field.type === "textarea" || field.type === "signature" ? "min-h-[44px]" : ""}`}>{shown || " "}</div>;
}

function Badge({ children }: { children: ReactNode }) {
  return <span className="rounded-full border border-[var(--app-border)] px-1.5 py-px text-[10px] text-[var(--app-muted)]">{children}</span>;
}
