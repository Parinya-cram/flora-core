/**
 * Inspector for a matrix field (score sheet): rows and columns edited by their labels (ids are generated and kept),
 * the kind of value in the cells (scores to choose, numbers, text), a different cell for one row (e.g. a pain score
 * 0-10), and total rows that add up chosen rows per column.
 */
import type { FieldDefinition, MatrixCell, MatrixRow } from "../core/types";
import { tr, type Lang } from "./catalog";
import { NumberField, SelectField, TextField } from "./controls";
import { uniqueName } from "./model";
import { input, label } from "./styles";

type Props = { field: FieldDefinition; lang: Lang; onPatch: (patch: Partial<Record<keyof FieldDefinition, unknown>>) => void };
type Item = { id: string; label: string };

const small = "rounded-lg border border-[var(--app-border)] bg-[var(--app-control-bg)] px-2 py-1 text-xs font-semibold text-[var(--app-text)] hover:bg-[var(--app-hover-bg)] disabled:opacity-40";

/** "0, 1, 2" -> options. */
const optionsFrom = (text: string) => text.split(/[,;\n]/).map(part => part.trim()).filter(Boolean).map(value => ({ value, label: value }));
const optionsText = (cell: MatrixCell | undefined) => (cell?.options ?? []).map(option => option.label).join(", ");

function CellEditor({ cell, lang, onChange, allowInherit }: { cell: MatrixCell | undefined; lang: Lang; onChange: (next: MatrixCell | undefined) => void; allowInherit?: boolean }) {
  const t = (th: string, en: string) => tr(lang, th, en);
  const type = cell?.type ?? "";
  const kinds = [
    ...(allowInherit ? [{ value: "", label: t("เหมือนค่าเริ่มต้น", "Same as the default") }] : []),
    { value: "select", label: t("เลือกคะแนน (เช่น 0, 1, 2)", "Choose a score (e.g. 0, 1, 2)") },
    { value: "integer", label: t("ตัวเลขจำนวนเต็ม", "Whole number") },
    { value: "number", label: t("ตัวเลข", "Number") },
    { value: "text", label: t("ข้อความ", "Text") },
  ];
  return <div className="space-y-2">
    <SelectField label={t("ค่าในช่อง", "Cell value")} value={type} options={kinds}
      onChange={next => onChange(next === "" ? undefined : next === "select" ? { type: "select", options: cell?.options?.length ? cell.options : optionsFrom("0, 1, 2") } : { type: next as MatrixCell["type"] })} />
    {type === "select" ? <TextField label={t("ตัวเลือก (คั่นด้วย ,)", "Choices (separated by ,)")} value={optionsText(cell)} hint={t("ค่าที่เป็นตัวเลขนำไปรวมคะแนนได้", "Number choices can be added up in a total")}
      onChange={text => onChange({ type: "select", options: optionsFrom(text ?? "") })} /> : null}
    {type === "integer" || type === "number" ? <div className="grid grid-cols-2 gap-2">
      <NumberField label={t("ต่ำสุด", "Min")} value={cell?.min} onChange={min => onChange({ ...(cell as MatrixCell), min })} />
      <NumberField label={t("สูงสุด", "Max")} value={cell?.max} onChange={max => onChange({ ...(cell as MatrixCell), max })} />
    </div> : null}
  </div>;
}

/** Labels, one per line, keeping the ids of labels that stay. */
function ItemsEditor({ title, items, prefix, onChange }: { title: string; items: Item[]; prefix: string; onChange: (next: Item[]) => void }) {
  return <label className="block space-y-1">
    <span className={label}>{title}</span>
    <textarea className={`${input} min-h-[90px]`} value={items.map(item => item.label).join("\n")}
      onChange={event => {
        const labels = event.target.value.split("\n");
        const used = new Set<string>();
        onChange(labels.map((text, index) => {
          const keep = items[index] && !used.has(items[index].id) ? items[index].id : uniqueName(`${prefix}${index + 1}`, used);
          used.add(keep);
          return { id: keep, label: text };
        }).filter(item => item.label.trim() !== "" || labels.length === 1));
      }} />
  </label>;
}

export default function MatrixEditor({ field, lang, onPatch }: Props) {
  const t = (th: string, en: string) => tr(lang, th, en);
  const rows = field.rows ?? [];
  const totals = field.totals ?? [];
  const setRows = (next: Item[]) => {
    const kept = next.map(item => ({ ...rows.find(row => row.id === item.id), ...item })) as MatrixRow[];
    const ids = new Set(kept.map(row => row.id));
    onPatch({ rows: kept, totals: totals.length ? totals.map(total => ({ ...total, of: total.of.filter(id => ids.has(id)) })).filter(total => total.of.length) : undefined });
  };
  const setTotal = (index: number, patch: Partial<{ label: string; of: string[] }>) =>
    onPatch({ totals: totals.map((total, i) => (i === index ? { ...total, ...patch } : total)).filter(total => total.of.length) });
  return <div className="space-y-3">
    <ItemsEditor title={t("แถว (1 บรรทัดต่อแถว)", "Rows (one per line)")} items={rows} prefix="row" onChange={setRows} />
    <ItemsEditor title={t("คอลัมน์ (1 บรรทัดต่อคอลัมน์ เช่น Preop, Admit, 15’)", "Columns (one per line, e.g. Preop, Admit, 15’)")} items={field.cols ?? []} prefix="col"
      onChange={cols => onPatch({ cols })} />
    <span className={label}>{t("ค่าเริ่มต้นของทุกช่อง", "Default cell")}</span>
    <CellEditor cell={field.cell} lang={lang} onChange={cell => onPatch({ cell: cell ?? { type: "text" } })} />
    <details>
      <summary className="cursor-pointer text-xs font-semibold text-[var(--app-text)]">{t("ช่องของบางแถวต่างจากค่าเริ่มต้น", "Rows with a different cell")}</summary>
      <div className="mt-2 space-y-3">
        {rows.map((row, index) => <div key={row.id} className="rounded-lg border border-[var(--app-border)] p-2">
          <div className="mb-1 text-xs font-semibold text-[var(--app-text)]">{row.label}</div>
          <CellEditor cell={row.cell} lang={lang} allowInherit onChange={cell => onPatch({ rows: rows.map((item, i) => (i === index ? { ...item, cell } : item)) })} />
        </div>)}
      </div>
    </details>
    <div className="space-y-2">
      <span className={label}>{t("แถวผลรวม (คำนวณให้อัตโนมัติ)", "Total rows (calculated)")}</span>
      {totals.map((total, index) => <div key={total.id} className="space-y-1 rounded-lg border border-[var(--app-border)] p-2">
        <TextField label={t("ชื่อแถว", "Row label")} value={total.label} onChange={text => setTotal(index, { label: text ?? "" })} />
        <div className="flex flex-wrap gap-x-3 gap-y-1">
          {rows.map(row => <label key={row.id} className="flex items-center gap-1 text-xs text-[var(--app-text)]">
            <input type="checkbox" className="accent-[var(--app-accent)]" checked={total.of.includes(row.id)}
              onChange={event => setTotal(index, { of: event.target.checked ? rows.filter(item => item.id === row.id || total.of.includes(item.id)).map(item => item.id) : total.of.filter(id => id !== row.id) })} />{row.label}
          </label>)}
        </div>
        <button type="button" className={small} onClick={() => onPatch({ totals: totals.filter((_, i) => i !== index) })}>{t("ลบแถวผลรวม", "Remove total")}</button>
      </div>)}
      <button type="button" className={small} disabled={!rows.length} onClick={() => onPatch({ totals: [...totals, {
        id: uniqueName("total", new Set([...rows.map(row => row.id), ...totals.map(item => item.id)])), label: t("รวม", "Total"), of: rows.map(row => row.id),
      }] })}>+ {t("แถวผลรวม", "Total row")}</button>
      <p className="text-[11px] text-[var(--app-muted)]">{t("รวมได้เฉพาะแถวที่เป็นตัวเลข หรือเลือกคะแนนที่เป็นตัวเลข", "Only number rows, or score choices that are numbers, can be added up")}</p>
    </div>
  </div>;
}
