/** Right-hand panel: settings of the selected chip, or of the report itself when nothing is selected. */
import { useEffect, useState } from "react";
import type { ReportCategory } from "../api/reportLibraryApi";
import { getFieldValues, type Aggregate, type Bucket, type CatalogField, type FieldValue, type StudioFilter, type StudioSpec } from "../api/reportStudioApi";
import {
  AGGREGATES, BUCKETS, FIELDLESS_AGGS, OPERATORS, aggregatesFor, emptyValue, isDate, isListOp, isNumeric, isRangeOp, needsValue, tr, updateItem,
  type Lang, type Slot,
} from "./model";
import { danger, input, label, small } from "./styles";

export type ReportMeta = { title: string; description: string; category: ReportCategory };

type Props = {
  lang: Lang;
  spec: StudioSpec;
  meta: ReportMeta;
  selection: Slot | null;
  fields: Map<string, CatalogField>;
  online: boolean;
  onSpec: (next: StudioSpec, mergeKey?: string) => void;
  onMeta: (next: ReportMeta) => void;
  onRemove: (slot: Slot) => void;
  onDeselect: () => void;
};

const SHELF_NAMES: Record<Slot["shelf"], [string, string]> = {
  filters: ["ตัวกรอง", "Filter"], columns: ["คอลัมน์", "Column"], groups: ["จัดกลุ่มตาม", "Group by"], measures: ["สถิติ", "Statistic"],
};

export default function Inspector({ lang, spec, meta, selection, fields, online, onSpec, onMeta, onRemove, onDeselect }: Props) {
  const t = (th: string, en: string) => tr(lang, th, en);
  const item = selection ? (spec[selection.shelf] as Array<Record<string, unknown>>)[selection.index] : undefined;

  if (!selection || !item) return <div className="space-y-3 p-1">
    <div className="text-[11px] font-bold uppercase tracking-[0.12em] text-[var(--app-muted)]">{t("รายงาน", "Report")}</div>
    <label className="block space-y-1"><span className={label}>{t("ชื่อรายงาน", "Title")}</span>
      <input className={input} value={meta.title} maxLength={160} onChange={event => onMeta({ ...meta, title: event.target.value })} /></label>
    <label className="block space-y-1"><span className={label}>{t("คำอธิบาย", "Description")}</span>
      <textarea className={`${input} h-20`} value={meta.description} maxLength={1000} onChange={event => onMeta({ ...meta, description: event.target.value })} /></label>
    <label className="block space-y-1"><span className={label}>{t("หมวดในคลังรายงาน", "Library category")}</span>
      <select className={input} value={meta.category} onChange={event => onMeta({ ...meta, category: event.target.value as ReportCategory })}>
        <option value="clinical_summary">{t("สรุปทางคลินิก", "Clinical summary")}</option>
        <option value="clinical_timing">{t("ระยะเวลาทางคลินิก", "Clinical timing")}</option>
        <option value="operations">{t("การดำเนินงาน", "Operations")}</option>
      </select></label>
    {spec.view === "stats" ? <label className="block space-y-1"><span className={label}>{t("แสดงเฉพาะ N กลุ่มแรก (ตามการเรียงลำดับ)", "Show only the top N groups (by sort order)")}</span>
      <input className={input} type="number" min={1} max={1000} placeholder={t("ทั้งหมด", "All")} value={spec.limit ?? ""}
        onChange={event => onSpec({ ...spec, limit: event.target.value ? Number(event.target.value) : null }, "limit")} /></label> : null}
    <p className="text-[11px] leading-relaxed text-[var(--app-muted)]">
      {t("คลิกหัวคอลัมน์ในตัวอย่างเพื่อเรียงลำดับ ช่วงวันที่ HN และเจ้าหน้าที่ เลือกได้ตอนเปิดรายงานในหน้า Reports",
        "Click a column heading in the preview to sort. Period, HN and staff are chosen when the report is run from Reports.")}
    </p>
  </div>;

  const field = typeof item.field === "string" ? fields.get(item.field) : undefined;
  const slot = selection;
  const patch = (value: Record<string, unknown>, key?: string) => onSpec(updateItem(spec, slot, value as never), key);

  return <div className="space-y-3 p-1">
    <div className="flex items-start justify-between gap-2">
      <div className="min-w-0">
        <div className="text-[11px] font-bold uppercase tracking-[0.12em] text-[var(--app-muted)]">{tr(lang, ...SHELF_NAMES[slot.shelf])}</div>
        <div className="truncate text-sm font-semibold text-[var(--app-text)]">{field?.label ?? AGGREGATES[item.agg as Aggregate]?.[lang === "th" ? 0 : 1]}</div>
        {field?.description ? <p className="mt-0.5 text-[11px] text-[var(--app-muted)]">{field.description}</p> : null}
      </div>
      <button type="button" className={small} onClick={onDeselect}>✕</button>
    </div>

    {slot.shelf === "filters" && field ? <FilterEditor key={`${slot.index}:${field.id}`} lang={lang} field={field} filter={item as StudioFilter} online={online} onChange={value => patch(value, `filter:${slot.index}`)} /> : null}

    {slot.shelf === "groups" && field && isDate(field) ? <label className="block space-y-1"><span className={label}>{t("ช่วงเวลา", "Period")}</span>
      <select className={input} value={String(item.bucket ?? "month")} onChange={event => patch({ bucket: event.target.value as Bucket })}>
        {(Object.keys(BUCKETS) as Bucket[]).map(bucket => <option key={bucket} value={bucket}>{tr(lang, ...BUCKETS[bucket])}</option>)}
      </select></label> : null}

    {slot.shelf === "measures" ? <label className="block space-y-1"><span className={label}>{t("สถิติ", "Statistic")}</span>
      <select className={input} value={String(item.agg)} onChange={event => patch({ agg: event.target.value as Aggregate })}>
        {(field ? aggregatesFor(field) : FIELDLESS_AGGS).map(agg => <option key={agg} value={agg}>{tr(lang, ...AGGREGATES[agg])}</option>)}
      </select>
      {field && isNumeric(field) ? <span className="block text-[11px] text-[var(--app-muted)]">{t("คำนวณจากเคสที่มีค่าในฟิลด์นี้", "Calculated over cases that have a value")}</span> : null}
    </label> : null}

    {slot.shelf !== "filters" ? <label className="block space-y-1"><span className={label}>{t("ชื่อที่แสดง (ไม่บังคับ)", "Heading (optional)")}</span>
      <input className={input} value={String(item.label ?? "")} placeholder={t("ใช้ชื่ออัตโนมัติ", "Automatic")} maxLength={80} onChange={event => patch({ label: event.target.value || undefined }, `label:${slot.shelf}:${slot.index}`)} /></label> : null}

    {field?.cardinality === "multi" ? <p className="rounded-lg bg-[var(--app-control-bg)] px-2 py-1.5 text-[11px] text-[var(--app-muted)]">
      {slot.shelf === "groups" ? t("ฟิลด์นี้มีได้หลายค่าต่อเคส เคสหนึ่งจะถูกนับในทุกกลุ่มที่มีค่า", "This field can hold several values per case; a case is counted in every group it has a value for.")
        : t("ฟิลด์นี้มีได้หลายค่าต่อเคส", "This field can hold several values per case.")}
    </p> : null}

    <button type="button" className={danger} onClick={() => onRemove(slot)}>{t("ลบออก", "Remove")}</button>
  </div>;
}

function FilterEditor({ lang, field, filter, online, onChange }: { lang: Lang; field: CatalogField; filter: StudioFilter; online: boolean; onChange: (value: Partial<StudioFilter>) => void }) {
  const t = (th: string, en: string) => tr(lang, th, en);
  const op = filter.op;
  const value = filter.value;
  const inputType = isDate(field) ? "date" : isNumeric(field) ? "number" : "text";
  return <div className="space-y-2">
    <label className="block space-y-1"><span className={label}>{t("เงื่อนไข", "Condition")}</span>
      <select className={input} value={op} onChange={event => onChange({ op: event.target.value, value: emptyValue(event.target.value) })}>
        {field.operators.map(item => <option key={item} value={item}>{OPERATORS[item] ? tr(lang, ...OPERATORS[item]) : item}</option>)}
      </select></label>
    {!needsValue(op) ? null
      : isRangeOp(op) ? <div className="grid grid-cols-2 gap-2">
        {[0, 1].map(index => <input key={index} className={input} type={inputType} aria-label={index ? t("ถึง", "To") : t("จาก", "From")}
          value={String((Array.isArray(value) ? value[index] : "") ?? "")}
          onChange={event => { const next = Array.isArray(value) ? [...value] : ["", ""]; next[index] = event.target.value; onChange({ value: next }); }} />)}
      </div>
      : isListOp(op) || (op === "equals" && field.data_type === "category") ? <ValuePicker lang={lang} field={field} online={online} multiple={isListOp(op)}
        value={Array.isArray(value) ? value.map(String) : value ? [String(value)] : []}
        onChange={next => onChange({ value: isListOp(op) ? next : next[0] ?? "" })} />
      : <input className={input} type={inputType} value={String(value ?? "")} onChange={event => onChange({ value: event.target.value })} />}
  </div>;
}

function ValuePicker({ lang, field, online, multiple, value, onChange }: { lang: Lang; field: CatalogField; online: boolean; multiple: boolean; value: string[]; onChange: (next: string[]) => void }) {
  const t = (th: string, en: string) => tr(lang, th, en);
  const [query, setQuery] = useState("");
  const [options, setOptions] = useState<FieldValue[]>([]);
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    if (!online) return;
    let live = true;
    const timer = window.setTimeout(() => {
      setLoading(true);
      getFieldValues(field.id, query).then(rows => { if (live) setOptions(rows); }).catch(() => undefined).finally(() => { if (live) setLoading(false); });
    }, query ? 200 : 0);
    return () => { live = false; window.clearTimeout(timer); };
  }, [field.id, query, online]);
  const chosen = new Set(value);
  const toggle = (item: string) => onChange(multiple ? (chosen.has(item) ? value.filter(entry => entry !== item) : [...value, item]) : [item]);
  const extra = value.filter(item => !options.some(option => option.value === item));
  return <div className="space-y-1.5">
    <input className={input} placeholder={t("ค้นหาค่า…", "Search values…")} value={query} onChange={event => setQuery(event.target.value)} />
    <div className="max-h-56 space-y-0.5 overflow-y-auto rounded-lg border border-[var(--app-border)] p-1">
      {[...extra.map(item => ({ value: item, label: item })), ...options].map(option => <label key={option.value} className="flex cursor-pointer items-center gap-2 rounded-md px-1.5 py-1 text-xs text-[var(--app-text)] hover:bg-[var(--app-control-bg)]">
        <input type={multiple ? "checkbox" : "radio"} checked={chosen.has(option.value)} onChange={() => toggle(option.value)} />
        <span className="truncate">{option.label}</span>
      </label>)}
      {!options.length && !extra.length ? <div className="px-2 py-3 text-center text-[11px] text-[var(--app-muted)]">{loading ? "…" : t("ไม่พบค่า", "No values found")}</div> : null}
    </div>
    {query.trim() && !options.some(option => option.label.toLowerCase() === query.trim().toLowerCase()) ? <button type="button" className={small} onClick={() => { toggle(query.trim()); setQuery(""); }}>+ {t(`ใช้ "${query.trim()}"`, `Use "${query.trim()}"`)}</button> : null}
    {value.length ? <div className="text-[11px] text-[var(--app-muted)]">{t(`เลือกแล้ว ${value.length} ค่า`, `${value.length} selected`)}</div> : null}
  </div>;
}
