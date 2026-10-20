/**
 * Inspector for report components (field type case_block): which case data the table prints, which of its columns
 * in which order, each column's width in percent of the table (with a bar showing the proportions and a total that
 * must stay at 100%), its own heading, and the rows — at most (the rest is counted under the table) and at least
 * (empty ruled rows to write on, as on a paper form).
 */
import { CASE_BLOCK_IDS, CASE_BLOCK_LIMITS, CASE_BLOCKS, caseBlockSpec, DEFAULT_MAX_ROWS, toHundred, type CaseBlockColumn, type CaseBlockId } from "../core/caseBlocks";
import type { FieldDefinition } from "../core/types";
import { tr, type Lang } from "./catalog";
import { NumberField, SelectField, Toggle } from "./controls";
import { input, label, small } from "./styles";

type Props = { field: FieldDefinition; lang: Lang; onPatch: (patch: Partial<Record<keyof FieldDefinition, unknown>>) => void };

const TONES = ["#0ea5e9", "#22c55e", "#f59e0b", "#a855f7", "#ef4444", "#14b8a6", "#6366f1", "#84cc16", "#ec4899", "#64748b", "#eab308", "#06b6d4"];

export default function CaseBlockEditor({ field, lang, onPatch }: Props) {
  const t = (th: string, en: string) => tr(lang, th, en);
  const spec = caseBlockSpec(field.block);
  const columns: CaseBlockColumn[] = field.block_columns?.length ? field.block_columns : spec?.columns.map(column => ({ key: column.key, width: column.width })) ?? [];
  const total = columns.reduce((sum, column) => sum + (column.width ?? 0), 0);
  const unset = columns.filter(column => column.width === undefined).length;
  const setColumns = (next: CaseBlockColumn[]) => onPatch({ block_columns: next.length ? next : undefined });
  const patchColumn = (index: number, patch: Partial<CaseBlockColumn>) => setColumns(columns.map((column, at) => {
    if (at !== index) return column;
    const merged = { ...column, ...patch };
    if (merged.width === undefined) delete merged.width;
    if (!merged.label) delete merged.label;
    return merged;
  }));
  const move = (index: number, by: number) => {
    const next = [...columns];
    const [item] = next.splice(index, 1);
    next.splice(Math.max(0, Math.min(next.length, index + by)), 0, item);
    setColumns(next);
  };
  const changeBlock = (block: string) => {
    const own = CASE_BLOCKS[block as CaseBlockId];
    onPatch({ block, block_columns: own.columns.map(column => ({ key: column.key, width: column.width })), label: tr(lang, own.th, own.en), ...(lang === "th" ? { label_en: own.en } : {}) });
  };
  const toggle = (key: string, on: boolean) => {
    if (on) {
      const own = spec?.columns.find(column => column.key === key);
      setColumns([...columns, { key, width: own?.width }]);
    } else setColumns(columns.filter(column => column.key !== key));
  };
  const fit = () => {
    const widths = toHundred(columns.map(column => column.width ?? (unset ? Math.max(0, 100 - total) / unset : 0)));
    setColumns(columns.map((column, index) => ({ ...column, width: widths[index] })));
  };
  const even = () => {
    const widths = toHundred(columns.map(() => 1));
    setColumns(columns.map((column, index) => ({ ...column, width: widths[index] })));
  };
  const reset = () => spec && setColumns(spec.columns.map(column => ({ key: column.key, width: column.width })));
  const shown = (column: CaseBlockColumn) => column.width ?? (unset ? Math.max(0, 100 - total) / unset : 0);
  const sum = columns.reduce((acc, column) => acc + shown(column), 0);
  const off = Math.abs(sum - 100) > 0.5;
  const [low, high] = CASE_BLOCK_LIMITS.column_width;

  return <div className="space-y-3">
    <SelectField label={t("ข้อมูลที่แสดง", "Case data shown")} value={field.block ?? ""} onChange={changeBlock}
      options={[...(spec ? [] : [{ value: "", label: t("— เลือก —", "— choose —") }]), ...CASE_BLOCK_IDS.map(id => ({ value: id, label: tr(lang, CASE_BLOCKS[id].th, CASE_BLOCKS[id].en) }))]} />

    {spec ? <>
      <div className="space-y-1">
        <div className="flex items-center justify-between">
          <span className={label}>{t("สัดส่วนคอลัมน์ (% ของความกว้างตาราง)", "Column proportions (% of the table width)")}</span>
          <span className={`text-[11px] font-semibold ${off ? "text-rose-600 dark:text-rose-300" : "text-emerald-700 dark:text-emerald-300"}`}>{t("รวม", "Total")} {Math.round(sum)}%</span>
        </div>
        <div className="flex h-6 w-full overflow-hidden rounded border border-[var(--app-border)]" aria-label={t("สัดส่วนคอลัมน์", "Column proportions")}>
          {columns.map((column, index) => {
            const own = spec.columns.find(item => item.key === column.key);
            return <div key={column.key} title={`${column.label ?? tr(lang, own?.th ?? column.key, own?.en ?? column.key)} ${Math.round(shown(column))}%`}
              style={{ width: `${sum > 0 ? shown(column) * 100 / Math.max(sum, 100) : 0}%`, background: TONES[index % TONES.length] }}
              className="flex items-center justify-center overflow-hidden whitespace-nowrap border-r border-white/60 text-[9px] font-semibold text-white">{Math.round(shown(column))}%</div>;
          })}
        </div>
        {off ? <p className="text-[11px] text-rose-600 dark:text-rose-300">{sum > 100
          ? t("คอลัมน์รวมกันเกิน 100% — กด \"ปรับให้รวม 100%\"", "The columns add to more than 100% — press \"Make it 100%\"")
          : t("ยังเหลือพื้นที่ — ตอนพิมพ์จะขยายตามสัดส่วนให้เต็มตาราง หรือกด \"ปรับให้รวม 100%\"", "Space is left — printing stretches the columns in proportion, or press \"Make it 100%\"")}</p> : null}
        <div className="flex flex-wrap gap-1">
          <button type="button" className={small} onClick={fit} disabled={!columns.length}>{t("ปรับให้รวม 100%", "Make it 100%")}</button>
          <button type="button" className={small} onClick={even} disabled={!columns.length}>{t("แบ่งเท่ากัน", "Equal widths")}</button>
          <button type="button" className={small} onClick={reset}>{t("ค่าเริ่มต้น", "Defaults")}</button>
        </div>
      </div>

      <div className="space-y-1.5">
        {columns.map((column, index) => {
          const own = spec.columns.find(item => item.key === column.key);
          return <div key={column.key} className="rounded-lg border border-[var(--app-border)] p-1.5">
            <div className="flex items-center gap-1">
              <span className="h-3 w-3 shrink-0 rounded-sm" style={{ background: TONES[index % TONES.length] }} />
              <span className="min-w-0 flex-1 truncate text-xs font-semibold text-[var(--app-text)]">{tr(lang, own?.th ?? column.key, own?.en ?? column.key)} <code className="text-[10px] text-[var(--app-muted)]">{column.key}</code></span>
              <button type="button" className={small} aria-label={t("เลื่อนขึ้น", "Move up")} disabled={index === 0} onClick={() => move(index, -1)}>↑</button>
              <button type="button" className={small} aria-label={t("เลื่อนลง", "Move down")} disabled={index === columns.length - 1} onClick={() => move(index, 1)}>↓</button>
              <button type="button" className={small} aria-label={t("เอาคอลัมน์ออก", "Remove the column")} disabled={columns.length === 1} onClick={() => toggle(column.key, false)}>✕</button>
            </div>
            <div className="mt-1 grid grid-cols-[1fr_auto] items-center gap-1">
              <input type="range" min={low} max={high} step={1} value={Math.round(shown(column))} aria-label={t("ความกว้าง %", "Width %")}
                onChange={event => patchColumn(index, { width: Number(event.target.value) })} />
              <label className="flex items-center gap-0.5 text-xs text-[var(--app-text)]">
                <input className={`${input} w-16 px-1 py-0.5 text-right`} type="number" min={low} max={high} value={column.width ?? ""} placeholder={String(Math.round(shown(column)))}
                  aria-label={t("ความกว้าง %", "Width %")}
                  onChange={event => patchColumn(index, { width: event.target.value === "" ? undefined : Math.max(low, Math.min(high, Number(event.target.value))) })} />%
              </label>
            </div>
            <input className={`${input} mt-1 px-1.5 py-0.5 text-xs`} value={column.label ?? ""} placeholder={tr(lang, own?.th ?? "", own?.en ?? "")}
              aria-label={t("หัวคอลัมน์ที่พิมพ์", "Printed heading")} onChange={event => patchColumn(index, { label: event.target.value || undefined })} />
          </div>;
        })}
        {spec.columns.some(own => !columns.some(column => column.key === own.key)) ? <div className="flex flex-wrap gap-1">
          <span className={label}>{t("เพิ่มคอลัมน์:", "Add a column:")}</span>
          {spec.columns.filter(own => !columns.some(column => column.key === own.key)).map(own =>
            <button key={own.key} type="button" className={small} onClick={() => toggle(own.key, true)}>+ {tr(lang, own.th, own.en)}</button>)}
        </div> : null}
      </div>

      <div className="grid grid-cols-2 gap-2">
        <NumberField label={t("พิมพ์สูงสุด (แถว)", "Rows at most")} value={field.max_rows} min={CASE_BLOCK_LIMITS.max_rows[0]} max={CASE_BLOCK_LIMITS.max_rows[1]}
          onChange={value => onPatch({ max_rows: value === undefined ? undefined : Math.round(value) })} />
        <NumberField label={t("แถวว่างอย่างน้อย", "Ruled rows at least")} value={field.min_rows} min={CASE_BLOCK_LIMITS.min_rows[0]} max={CASE_BLOCK_LIMITS.min_rows[1]}
          onChange={value => onPatch({ min_rows: value === undefined ? undefined : Math.round(value) })} />
      </div>
      <p className="text-[11px] text-[var(--app-muted)]">{t(`ไม่กำหนด = สูงสุด ${DEFAULT_MAX_ROWS} แถว · แถวที่เกินจะแจ้งจำนวนไว้ใต้ตาราง · แถวว่างใช้เขียนด้วยมือเมื่อเคสมีข้อมูลน้อย`,
        `Not set = ${DEFAULT_MAX_ROWS} rows at most · rows over the limit are counted under the table · ruled rows are left to write on when the case has fewer`)}</p>
      <Toggle label={t("พิมพ์หัวคอลัมน์", "Print the column headings")} checked={field.show_header !== false} onChange={on => onPatch({ show_header: on ? undefined : false })} />
    </> : null}
  </div>;
}
