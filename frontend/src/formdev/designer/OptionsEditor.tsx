/**
 * Choices of a select / radio / multiselect: a list typed by hand (with "Other, please specify" and per-option
 * conditions) or a registered lookup table filtered by other fields (Phase 2.3).
 */
import { useState } from "react";
import type { FieldDefinition, FieldOption, LookupSource } from "../core/types";
import { fieldKey } from "../core/validate";
import { tr, type Lang } from "./catalog";
import ConditionEditor from "./ConditionEditor";
import { Toggle } from "./controls";
import { input, label, small } from "./styles";

export type LookupInfo = { lookup_id: string; metadata: { title: string; columns: Array<{ name: string; label?: string }>; authoritative?: boolean; notice?: string } };
type Props = {
  field: FieldDefinition; candidates: FieldDefinition[]; lookups: LookupInfo[]; lang: Lang;
  onPatch: (patch: Partial<Record<keyof FieldDefinition, unknown>>) => void;
};

const nextValue = (options: FieldOption[]) => {
  const used = new Set(options.map(option => option.value));
  let n = options.length + 1;
  while (used.has(`opt_${n}`)) n += 1;
  return `opt_${n}`;
};

export default function OptionsEditor({ field, candidates, lookups, lang, onPatch }: Props) {
  const [bulk, setBulk] = useState("");
  const options = field.options ?? [];
  const setOptions = (next: FieldOption[]) => onPatch({ options: next, lookup: undefined });
  const setOption = (index: number, patch: Partial<FieldOption>) =>
    setOptions(options.map((option, i) => {
      if (i !== index) return option;
      const next = { ...option, ...patch } as Record<string, unknown>;
      for (const [name, value] of Object.entries(patch)) if (value === undefined || value === false) delete next[name];
      return next as FieldOption;
    }));
  const move = (index: number, to: number) => {
    if (to < 0 || to >= options.length) return;
    const next = [...options];
    const [item] = next.splice(index, 1);
    next.splice(to, 0, item);
    setOptions(next);
  };
  const addBulk = () => {
    const labels = bulk.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
    if (!labels.length) return;
    const next = [...options];
    for (const text of labels) next.push({ value: nextValue(next), label: text });
    setOptions(next);
    setBulk("");
  };

  const usingLookup = field.lookup !== undefined;
  const table = lookups.find(item => item.lookup_id === field.lookup?.source);
  const setLookup = (patch: Partial<LookupSource>) => {
    const next = { ...(field.lookup ?? { source: lookups[0]?.lookup_id ?? "", value: "" }), ...patch } as LookupSource;
    if (next.filter && !Object.keys(next.filter).length) delete next.filter;
    onPatch({ lookup: next, options: undefined });
  };

  return <div className="space-y-3">
    <div className="flex gap-2 text-xs">
      <button type="button" className={`${small} ${!usingLookup ? "border-[var(--app-accent)]" : ""}`} onClick={() => !usingLookup || setOptions([{ value: "opt_1", label: tr(lang, "ตัวเลือก 1", "Option 1") }])}>
        {tr(lang, "พิมพ์ตัวเลือกเอง", "Type the choices")}
      </button>
      <button type="button" className={`${small} ${usingLookup ? "border-[var(--app-accent)]" : ""}`} disabled={!lookups.length}
        onClick={() => usingLookup || setLookup({ source: lookups[0].lookup_id, value: lookups[0].metadata.columns[0]?.name ?? "" })}>
        {tr(lang, "ดึงจากตารางอ้างอิง", "From a lookup table")}
      </button>
    </div>

    {!usingLookup ? <>
      {options.map((option, index) => <div key={index} className="space-y-1 rounded-lg border border-[var(--app-border)] p-2">
        <div className="flex gap-1">
          <input className={input} value={option.label} onChange={event => setOption(index, { label: event.target.value })} aria-label={tr(lang, "ข้อความตัวเลือก", "Choice text")} />
          <button type="button" className={small} onClick={() => move(index, index - 1)} disabled={index === 0} aria-label="up">↑</button>
          <button type="button" className={small} onClick={() => move(index, index + 1)} disabled={index === options.length - 1} aria-label="down">↓</button>
          <button type="button" className={small} onClick={() => setOptions(options.filter((_, i) => i !== index))} disabled={options.length === 1} aria-label={tr(lang, "ลบ", "Remove")}>✕</button>
        </div>
        <Toggle label={tr(lang, "ให้พิมพ์ข้อความเพิ่ม (เช่น อื่นๆ ระบุ)", "Ask for text (e.g. Other, please specify)")} checked={option.has_input === true}
          onChange={on => setOption(index, on ? { has_input: true } : { has_input: undefined, input_required: undefined })} />
        {option.has_input ? <Toggle label={tr(lang, "ต้องพิมพ์ข้อความนี้", "The text is required")} checked={option.input_required === true}
          onChange={on => setOption(index, { input_required: on || undefined })} /> : null}
        <details>
          <summary className="cursor-pointer text-[11px] text-[var(--app-muted)]">{tr(lang, "ขั้นสูง: รหัสค่า / แสดงเฉพาะเมื่อ", "Advanced: stored value / show only when")}</summary>
          <div className="mt-2 space-y-2">
            <label className="block space-y-1"><span className={label}>{tr(lang, "รหัสที่บันทึก (ภาษาอังกฤษ)", "Stored value")}</span>
              <input className={`${input} font-mono text-xs`} value={option.value} onChange={event => setOption(index, { value: event.target.value.trim() })} /></label>
            <ConditionEditor key={`${fieldKey(field)}-${index}`} condition={option.when} candidates={candidates} lang={lang} onChange={when => setOption(index, { when })} />
          </div>
        </details>
      </div>)}
      <button type="button" className={small} onClick={() => setOptions([...options, { value: nextValue(options), label: tr(lang, `ตัวเลือก ${options.length + 1}`, `Option ${options.length + 1}`) }])}>
        + {tr(lang, "เพิ่มตัวเลือก", "Add choice")}
      </button>
      <label className="block space-y-1">
        <span className={label}>{tr(lang, "เพิ่มหลายข้อพร้อมกัน (บรรทัดละ 1 ข้อ)", "Add many at once (one per line)")}</span>
        <textarea className={`${input} min-h-[60px]`} value={bulk} onChange={event => setBulk(event.target.value)} />
        <button type="button" className={small} onClick={addBulk} disabled={!bulk.trim()}>{tr(lang, "เพิ่มรายการ", "Add lines")}</button>
      </label>
    </> : <>
      <label className="block space-y-1"><span className={label}>{tr(lang, "ตารางอ้างอิง", "Lookup table")}</span>
        <select className={input} value={field.lookup?.source ?? ""} onChange={event => {
          const next = lookups.find(item => item.lookup_id === event.target.value);
          setLookup({ source: event.target.value, value: next?.metadata.columns[0]?.name ?? "", filter: undefined, label: undefined });
        }}>
          {lookups.map(item => <option key={item.lookup_id} value={item.lookup_id}>{item.metadata.title}</option>)}
        </select>
      </label>
      {table?.metadata.authoritative === false ? <p className="text-[11px] text-amber-600 dark:text-amber-300">{table.metadata.notice ?? tr(lang, "ตารางนี้เป็นข้อมูลตัวอย่าง", "This table is sample data")}</p> : null}
      <label className="block space-y-1"><span className={label}>{tr(lang, "ใช้คอลัมน์ใดเป็นตัวเลือก", "Column offered as choices")}</span>
        <select className={input} value={field.lookup?.value ?? ""} onChange={event => setLookup({ value: event.target.value })}>
          {(table?.metadata.columns ?? []).map(column => <option key={column.name} value={column.name}>{column.label ?? column.name}</option>)}
        </select>
      </label>
      <div className="space-y-1">
        <span className={label}>{tr(lang, "กรองตามช่องอื่น (เช่น อำเภอตามจังหวัดที่เลือก)", "Filter by other fields (e.g. districts of the chosen province)")}</span>
        {(table?.metadata.columns ?? []).filter(column => column.name !== field.lookup?.value).map(column => <label key={column.name} className="flex items-center gap-2 text-xs text-[var(--app-text)]">
          <span className="w-28 shrink-0">{column.label ?? column.name} =</span>
          <select className={input} value={field.lookup?.filter?.[column.name] ?? ""} onChange={event => {
            const filter = { ...(field.lookup?.filter ?? {}) };
            if (event.target.value) filter[column.name] = event.target.value;
            else delete filter[column.name];
            setLookup({ filter });
          }}>
            <option value="">{tr(lang, "— ไม่กรอง —", "— no filter —")}</option>
            {candidates.map(other => <option key={fieldKey(other)} value={fieldKey(other)}>{other.label}</option>)}
          </select>
        </label>)}
      </div>
    </>}
  </div>;
}
