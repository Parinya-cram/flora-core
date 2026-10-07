/**
 * The page being designed: sections, categories and fields on the 12-column grid, as the form will look.
 * Drag from the palette or move cards; drop onto a card's left / right half to put it before / after, or into
 * empty space to place it at that exact column. Drag a card's right edge to resize it. Every drop also has a
 * button alternative (palette click, ↑ ↓, width presets) for touch screens and keyboards.
 */
import { useRef, useState, type CSSProperties, type MutableRefObject, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { containerColumns, formColumns, gridArea, placeField } from "../core/layout";
import type { CategoryDefinition, FieldDefinition, FormDefinition, LayoutMode, SectionDefinition } from "../core/types";
import { fieldKey } from "../core/validate";
import { tr, typeIcon, typeName, type Lang } from "./catalog";
import { DRAG_MIME, type DragItem, type DropTarget } from "./drag";
import { fieldPath, GRID_COLUMNS, samePath, type FieldRef, type Path, type Selection } from "./model";
import { small } from "./styles";

type Ctx = {
  definition: FormDefinition; lang: Lang; mode: Exclude<LayoutMode, "print">; selection: Selection; styleColumns: number;
  /** The item being dragged (kept by the panel; HTML5 drag events cannot carry it during dragover). */
  getDrag: () => DragItem | null;
  setDrag: (item: DragItem | null) => void;
  onSelect: (selection: Selection) => void;
  onDrop: (item: DragItem, target: DropTarget) => void;
  onResize: (ref: FieldRef, span: number) => void;
  onFieldAction: (ref: FieldRef, action: "up" | "down" | "duplicate" | "remove") => void;
  onSectionAction: (path: Path, action: "up" | "down" | "remove" | "add_category") => void;
};
type Props = Omit<Ctx, never>;

const startsWith = (path: Path, prefix: Path) => prefix.length <= path.length && prefix.every((step, index) => path[index] === step);
const isSelected = (ctx: Ctx, path: Path, kind: Selection["kind"]) =>
  ctx.selection.kind === kind && (kind === "field" ? samePath(fieldPath((ctx.selection as { ref: FieldRef }).ref), path) : samePath((ctx.selection as { path: Path }).path, path));

export default function Canvas(props: Props) {
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

/** A field list on its grid: the drop zone. */
function FieldList({ ctx, fields, list, columns, containerType, emptyHint }: {
  ctx: Ctx; fields: FieldDefinition[]; list: Path; columns: number; containerType: "grid" | "row" | "column"; emptyHint?: null;
}) {
  const gridRef = useRef<HTMLDivElement | null>(null);
  const [target, setTarget] = useState<{ index: number; col: number | null; x: number; y: number; height: number; span: number } | null>(null);
  const t = (th: string, en: string) => tr(ctx.lang, th, en);

  const compute = (clientX: number, clientY: number) => {
    const grid = gridRef.current;
    if (!grid) return null;
    const box = grid.getBoundingClientRect();
    const cards = [...grid.querySelectorAll<HTMLElement>(":scope > [data-card]")].map(card => card.getBoundingClientRect());
    const inside = cards.findIndex(rect => clientX >= rect.left && clientX <= rect.right && clientY >= rect.top && clientY <= rect.bottom);
    if (inside >= 0) {
      const rect = cards[inside];
      const before = clientX < rect.left + rect.width / 2;
      return { index: before ? inside : inside + 1, col: null, x: (before ? rect.left : rect.right) - box.left, y: rect.top - box.top, height: rect.height, span: 0 };
    }
    const index = cards.filter(rect => rect.bottom <= clientY || (rect.top <= clientY && rect.right <= clientX)).length;
    const free = ctx.mode !== "mobile" && containerType === "grid";
    const colWidth = box.width / columns;
    const span = Math.min(spanOf(ctx.getDrag()), columns);
    // The pointer marks where the field starts; keep the whole field on the grid.
    const col = free ? Math.max(1, Math.min(columns - span + 1, Math.floor((clientX - box.left) / colWidth) + 1)) : null;
    return { index, col, x: col ? (col - 1) * colWidth : 0, y: Math.max(0, clientY - box.top - 18), height: 36, span };
  };
  const accepts = () => {
    const item = ctx.getDrag();
    return item !== null && !(item.kind === "move" && startsWith(list, fieldPath(item.ref)));
  };

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
      if (item && where) ctx.onDrop(item, { list, index: where.index, col: where.col });
    }}
    className="relative">
    <div ref={gridRef} className="grid min-h-[56px] gap-2" style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}>
      {fields.map((field, index) => <FieldCard key={`${field.id}-${index}`} ctx={ctx} field={field} fieldRef={{ list, index }} count={fields.length}
        columns={columns} containerType={containerType} siblings={fields.length} gridRef={gridRef} />)}
      {!fields.length && emptyHint !== null ? <div className="col-span-full flex min-h-[56px] items-center justify-center rounded-xl border-2 border-dashed border-[var(--app-border)] text-sm text-[var(--app-muted)]">
        {t("ลากช่องจากด้านซ้ายมาวางที่นี่ หรือคลิกช่องในแถบด้านซ้าย", "Drag a field here, or click one in the palette")}
      </div> : null}
    </div>
    {target ? (target.col !== null
      ? <div className="pointer-events-none absolute rounded-lg border-2 border-dashed border-[var(--app-accent)] bg-[var(--app-accent)]/10"
          style={{ left: target.x, top: target.y, height: target.height, width: `${(Math.min(target.span, columns - target.col + 1) / columns) * 100}%` }} />
      : <div className="pointer-events-none absolute w-1 rounded bg-[var(--app-accent)]" style={{ left: Math.max(0, target.x - 3), top: target.y, height: target.height }} />) : null}
  </div>;
}

const spanOf = (item: DragItem | null) => (item?.kind === "move" ? item.span : item?.kind === "block" ? GRID_COLUMNS : 6);

function FieldCard({ ctx, field, fieldRef, count, columns, containerType, siblings, gridRef }: {
  ctx: Ctx; field: FieldDefinition; fieldRef: FieldRef; count: number; columns: number; containerType: "grid" | "row" | "column"; siblings: number;
  gridRef: MutableRefObject<HTMLDivElement | null>;
}) {
  const path = fieldPath(fieldRef);
  const selected = isSelected(ctx, path, "field");
  const placement = placeField(field, ctx.mode, columns, ctx.styleColumns, containerType, siblings);
  const [resizing, setResizing] = useState<number | null>(null);
  const t = (th: string, en: string) => tr(ctx.lang, th, en);
  const span = resizing ?? placement.span;
  const area = gridArea({ ...placement, span, col: placement.col !== undefined ? Math.min(placement.col, columns - span + 1) : undefined });
  const hiddenHere = placement.hidden;

  const startResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();
    const grid = gridRef.current;
    if (!grid) return;
    const colWidth = grid.getBoundingClientRect().width / columns;
    const startX = event.clientX;
    const startSpan = placement.span;
    const handle = event.currentTarget;
    try {
      handle.setPointerCapture(event.pointerId);
    } catch {
      // Some pens / synthetic pointers cannot be captured; moves over the handle still resize.
    }
    let latest = startSpan;
    const move = (moveEvent: PointerEvent) => {
      latest = Math.max(1, Math.min(columns, Math.round(startSpan + (moveEvent.clientX - startX) / colWidth)));
      setResizing(latest);
    };
    const up = () => {
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", up);
      setResizing(null);
      if (latest !== startSpan) ctx.onResize(fieldRef, latest);
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", up);
  };

  const style: CSSProperties = { ...area };
  return <div data-card draggable={resizing === null} style={style}
    onDragStart={event => {
      event.stopPropagation();
      ctx.setDrag({ kind: "move", ref: fieldRef, span: placement.span });
      event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData(DRAG_MIME, fieldKey(field));
      event.dataTransfer.setData("text/plain", field.label);
    }}
    onDragEnd={() => ctx.setDrag(null)}
    onClick={event => { event.stopPropagation(); ctx.onSelect({ kind: "field", ref: fieldRef }); }}
    onKeyDown={event => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); ctx.onSelect({ kind: "field", ref: fieldRef }); } }}
    tabIndex={0} role="button" aria-pressed={selected} aria-label={field.label}
    className={`group relative cursor-grab rounded-xl border bg-[var(--app-panel-bg)] p-2 text-left shadow-sm transition active:cursor-grabbing
      ${selected ? "border-[var(--app-accent)] ring-2 ring-[var(--app-accent)]/40" : "border-[var(--app-border)] hover:border-[var(--app-accent)]/60"} ${hiddenHere ? "opacity-40" : ""}`}>
    <div className="flex items-start justify-between gap-1">
      <div className="min-w-0">
        <div className="truncate text-sm font-semibold text-[var(--app-text)]">
          {field.label || t("(ไม่มีชื่อ)", "(no label)")}{field.required || field.validation?.required ? <span className="text-rose-500"> *</span> : null}
          {field.unit ? <span className="font-normal text-[var(--app-muted)]"> ({field.unit})</span> : null}
        </div>
        <div className="flex flex-wrap items-center gap-1 text-[10px] text-[var(--app-muted)]">
          <span>{typeIcon(field.type)} {typeName(field.type, ctx.lang)}</span>
          {field.visibility ? <Badge>{t("มีเงื่อนไข", "conditional")}</Badge> : null}
          {field.lookup || field.derive ? <Badge>{t("ตารางอ้างอิง", "lookup")}</Badge> : null}
          {field.permission ? <Badge>🔒</Badge> : null}
          {field.indexed ? <Badge>{t("ค้นหาได้", "search")}</Badge> : null}
          {hiddenHere ? <Badge>{t("ซ่อนในโหมดนี้", "hidden here")}</Badge> : null}
        </div>
      </div>
      {selected ? <div className="flex shrink-0 gap-0.5" onClick={event => event.stopPropagation()}>
        <button type="button" className={small} disabled={fieldRef.index === 0} onClick={() => ctx.onFieldAction(fieldRef, "up")} title={t("เลื่อนก่อน", "Move earlier")}>↑</button>
        <button type="button" className={small} disabled={fieldRef.index === count - 1} onClick={() => ctx.onFieldAction(fieldRef, "down")} title={t("เลื่อนหลัง", "Move later")}>↓</button>
        <button type="button" className={small} onClick={() => ctx.onFieldAction(fieldRef, "duplicate")} title={t("ทำสำเนา", "Duplicate")}>⧉</button>
        <button type="button" className={small} onClick={() => ctx.onFieldAction(fieldRef, "remove")} title={t("ลบ", "Delete")}>🗑</button>
      </div> : null}
    </div>
    <div className="mt-1.5"><MockInput field={field} ctx={ctx} fieldRef={fieldRef} columns={columns} /></div>
    {ctx.mode !== "mobile" && containerType === "grid" ? <div onPointerDown={startResize} draggable={false} onDragStart={event => { event.preventDefault(); event.stopPropagation(); }}
      title={t("ลากเพื่อปรับความกว้าง", "Drag to resize")} aria-hidden
      className="absolute right-0 top-0 flex h-full w-2.5 cursor-ew-resize items-center justify-center rounded-r-xl opacity-0 transition group-hover:opacity-100 hover:bg-[var(--app-accent)]/20">
      <span className="h-6 w-0.5 rounded bg-[var(--app-accent)]" />
    </div> : null}
    {resizing !== null ? <div className="absolute -top-6 right-0 rounded bg-[var(--app-accent)] px-1.5 text-[10px] font-bold text-[var(--app-accent-contrast)]">{resizing}/{columns}</div> : null}
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
