/**
 * "Show when ..." editor: rows of [field] [operator] [value], joined by all / any. Values are picked from the
 * target field's options where it has them. Remount it (key) when the selected item changes.
 */
import { useState } from "react";
import type { Condition, ConditionOperator, FieldDefinition } from "../core/types";
import { fieldKey } from "../core/validate";
import { OPERATORS, tr, type Lang } from "./catalog";
import { conditionOf, rowsOf, type ConditionRows } from "./conditions";
import { input, small } from "./styles";

type Props = { condition: Condition | undefined; candidates: FieldDefinition[]; lang: Lang; onChange: (next: Condition | undefined) => void };

export default function ConditionEditor({ condition, candidates, lang, onChange }: Props) {
  const initial = rowsOf(condition);
  const [state, setState] = useState<ConditionRows>(initial ?? { join: "and", rows: [] });
  if (initial === null) {
    return <p className="text-xs text-amber-600 dark:text-amber-300">{tr(lang, "เงื่อนไขนี้ซับซ้อน (ซ้อนกันหลายชั้น) แก้ไขได้ในส่วน JSON ขั้นสูง", "This condition is nested; edit it in the advanced JSON view.")}</p>;
  }
  const byKey = (key: string) => candidates.find(field => fieldKey(field) === key);
  const update = (next: ConditionRows) => {
    setState(next);
    onChange(conditionOf(next, byKey));
  };
  const setRow = (index: number, patch: Partial<ConditionRows["rows"][number]>) =>
    update({ ...state, rows: state.rows.map((row, i) => (i === index ? { ...row, ...patch } : row)) });

  return <div className="space-y-2">
    {state.rows.length > 1 ? <div className="flex items-center gap-2 text-xs text-[var(--app-muted)]">
      {tr(lang, "แสดงเมื่อ", "Show when")}
      <select className={`${input} w-auto`} value={state.join} onChange={event => update({ ...state, join: event.target.value as "and" | "or" })}>
        <option value="and">{tr(lang, "ตรงทุกข้อ", "all rows match")}</option>
        <option value="or">{tr(lang, "ตรงข้อใดข้อหนึ่ง", "any row matches")}</option>
      </select>
    </div> : null}
    {state.rows.map((row, index) => {
      const target = byKey(row.field);
      const operator = OPERATORS.find(item => item.op === row.operator);
      const yesNo = target?.type === "switch" || target?.type === "checkbox";
      return <div key={index} className="space-y-1 rounded-lg border border-[var(--app-border)] p-2">
        <select className={input} value={row.field} onChange={event => setRow(index, { field: event.target.value, value: "" })} aria-label={tr(lang, "ช่องที่ใช้ตัดสิน", "Field")}>
          <option value="">{tr(lang, "— เลือกช่อง —", "— choose a field —")}</option>
          {candidates.map(field => <option key={fieldKey(field)} value={fieldKey(field)}>{field.label}</option>)}
        </select>
        <div className="flex gap-1">
          <select className={input} value={row.operator} onChange={event => setRow(index, { operator: event.target.value as ConditionOperator })} aria-label={tr(lang, "เงื่อนไข", "Operator")}>
            {OPERATORS.map(item => <option key={item.op} value={item.op}>{tr(lang, item.th, item.en)}</option>)}
          </select>
          <button type="button" className={small} onClick={() => update({ ...state, rows: state.rows.filter((_, i) => i !== index) })} aria-label={tr(lang, "ลบเงื่อนไข", "Remove row")}>✕</button>
        </div>
        {operator?.needsValue ? (yesNo
          ? <select className={input} value={row.value} onChange={event => setRow(index, { value: event.target.value })}>
              <option value="">—</option><option value="true">{tr(lang, "ใช่", "Yes")}</option><option value="false">{tr(lang, "ไม่ใช่", "No")}</option>
            </select>
          : target?.options?.length && row.operator !== "in"
            ? <select className={input} value={row.value} onChange={event => setRow(index, { value: event.target.value })}>
                <option value="">—</option>
                {target.options.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
              </select>
            : <input className={input} value={row.value} onChange={event => setRow(index, { value: event.target.value })}
                placeholder={row.operator === "in" ? tr(lang, "ค่า คั่นด้วย , เช่น sss, csmbs", "values separated by commas") : tr(lang, "ค่า", "value")} />) : null}
      </div>;
    })}
    <button type="button" className={small} onClick={() => setState({ ...state, rows: [...state.rows, { field: "", operator: "equals", value: "" }] })}>
      + {tr(lang, "เพิ่มเงื่อนไข", "Add condition")}
    </button>
    {state.rows.length && !conditionOf(state, byKey) ? <p className="text-[11px] text-amber-600 dark:text-amber-300">{tr(lang, "กรอกให้ครบทุกแถวจึงจะมีผล", "Complete every row for it to apply")}</p> : null}
  </div>;
}
