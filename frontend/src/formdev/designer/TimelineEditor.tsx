/**
 * Inspector for a timeline field (Form Studio): which parts show (Flora Leaf's events row, trend chart, parameter
 * table), the column step, where values come from, the table rows (Leaf's parameters by group, plus own rows such as
 * BIS or TOF) and the chart series.
 */
import type { FieldDefinition, TimelineConfig, TimelinePart, TimelineSeries } from "../core/types";
import { TIMELINE_SERIES } from "../core/validate";
import { DEFAULT_MONO_COLOR, SERIES, TIMELINE_ROWS, timelineConfig } from "../leaf/timeline";
import { tr, type Lang } from "./catalog";
import { SelectField, TextField } from "./controls";
import { label } from "./styles";

type Props = { field: FieldDefinition; lang: Lang; onPatch: (patch: Partial<Record<keyof FieldDefinition, unknown>>) => void };

const GROUPS: Array<{ id: string; th: string; en: string }> = [
  { id: "vital", th: "สัญญาณชีพ", en: "Vital signs" }, { id: "set", th: "ค่าที่ตั้งเครื่องช่วยหายใจ", en: "Ventilator settings" },
  { id: "measured", th: "ค่าที่วัดได้ (เครื่องช่วยหายใจ / ก๊าซ)", en: "Measured (ventilator, gases)" },
];
const PARTS: Array<{ id: TimelinePart; th: string; en: string }> = [
  { id: "events", th: "แถวเหตุการณ์", en: "Events row" }, { id: "chart", th: "กราฟแนวโน้ม", en: "Trend chart" }, { id: "table", th: "ตารางค่าตามเวลา", en: "Values table" },
];
const STEPS = [1, 5, 10, 15, 20, 30, 60];
const chip = "flex items-center gap-1 text-xs text-[var(--app-text)]";

export default function TimelineEditor({ field, lang, onPatch }: Props) {
  const t = (th: string, en: string) => tr(lang, th, en);
  const config = timelineConfig(field);
  const set = (patch: Partial<TimelineConfig>) => onPatch({ timeline: { ...(field.timeline ?? {}), ...patch } });
  const rowIds = config.rows.map(row => row.id);
  const toggleRow = (id: string, on: boolean) => set({ rows: on ? [...config.rows, { id }] : config.rows.filter(row => row.id !== id) });
  const custom = config.rows.filter(row => !TIMELINE_ROWS.some(known => known.id === row.id));
  return <div className="space-y-3">
    <div className="space-y-1">
      <span className={label}>{t("ส่วนที่แสดง", "Parts")}</span>
      <div className="flex flex-wrap gap-x-3 gap-y-1">
        {PARTS.map(part => <label key={part.id} className={chip}><input type="checkbox" className="accent-[var(--app-accent)]" checked={config.parts.includes(part.id)}
          onChange={event => {
            const next = event.target.checked ? PARTS.map(item => item.id).filter(id => id === part.id || config.parts.includes(id)) : config.parts.filter(id => id !== part.id);
            if (next.length) set({ parts: next });
          }} />{t(part.th, part.en)}</label>)}
      </div>
    </div>
    <div className="grid grid-cols-2 gap-2">
      <SelectField label={t("ช่วงเวลาต่อคอลัมน์", "Minutes per column")} value={String(config.step)} options={STEPS.map(step => ({ value: String(step), label: t(`${step} นาที`, `${step} min`) }))}
        onChange={value => set({ step_min: Number(value) })} />
      <SelectField label={t("ที่มาของค่า", "Values from")} value={config.source} options={[
        { value: "leaf", label: t("Flora Leaf (แก้ไขได้)", "Flora Leaf (editable)") }, { value: "manual", label: t("กรอกเอง", "Typed in") }]}
        onChange={value => set({ source: value as "leaf" | "manual" })} />
    </div>
    {config.parts.includes("chart") ? <div className="space-y-1">
      <span className={label}>{t("เส้นในกราฟ", "Chart series")}</span>
      <div className="flex flex-wrap gap-x-3 gap-y-1">
        {TIMELINE_SERIES.map(series => <label key={series} className={chip}><input type="checkbox" className="accent-[var(--app-accent)]" checked={config.chart.includes(series)}
          onChange={event => set({ chart: event.target.checked ? TIMELINE_SERIES.filter(id => id === series || config.chart.includes(id)) as TimelineSeries[] : config.chart.filter(id => id !== series) })} />
          <span style={{ color: config.colors[series] }}>■</span>{SERIES[series].label}</label>)}
      </div>
      <span className={label}>{t("สีของกราฟ", "Chart colours")}</span>
      <div className="flex flex-wrap gap-x-3 gap-y-1">
        <label className={chip}><input type="radio" className="accent-[var(--app-accent)]" checked={config.colorMode === "series"}
          onChange={() => set({ colors: { ...(field.timeline?.colors ?? {}), mode: "series" } })} />{t("สีตามชนิดค่า", "Colour by value type")}</label>
        <label className={chip}><input type="radio" className="accent-[var(--app-accent)]" checked={config.colorMode === "mono"}
          onChange={() => set({ colors: { ...(field.timeline?.colors ?? {}), mode: "mono" } })} />{t("สีเดียวทั้งกราฟ", "One colour")}</label>
      </div>
      {config.colorMode === "mono" ? <label className={chip}>
        <input type="color" aria-label={t("สีของกราฟ", "Chart colour")} value={field.timeline?.colors?.mono || DEFAULT_MONO_COLOR}
          onChange={event => set({ colors: { ...(field.timeline?.colors ?? {}), mode: "mono", mono: event.target.value } })} />
        <span className="font-mono text-[var(--app-muted)]">{field.timeline?.colors?.mono || DEFAULT_MONO_COLOR}</span>
      </label> : <div className="grid grid-cols-2 gap-x-3 gap-y-1">
        {config.chart.map(series => <label key={series} className={chip}>
          <input type="color" aria-label={`${SERIES[series].label} ${t("สี", "colour")}`} value={config.colors[series]}
            onChange={event => set({ colors: { ...(field.timeline?.colors ?? {}), mode: "series", series: { ...(field.timeline?.colors?.series ?? {}), [series]: event.target.value } } })} />
          {SERIES[series].label}
          {field.timeline?.colors?.series?.[series] ? <button type="button" className="text-[10px] text-[var(--app-muted)] underline" onClick={() => {
            const rest = Object.fromEntries(Object.entries(field.timeline?.colors?.series ?? {}).filter(([name]) => name !== series));
            set({ colors: { ...(field.timeline?.colors ?? {}), series: rest } });
          }}>{t("ค่าเดิม", "default")}</button> : null}
        </label>)}
      </div>}
    </div> : null}
    {config.parts.includes("table") ? <div className="space-y-2">
      <span className={label}>{t("แถวในตาราง (ตามลำดับที่เลือก)", "Table rows (in the order chosen)")}</span>
      {GROUPS.map(group => <details key={group.id} open={group.id === "measured"}>
        <summary className="cursor-pointer text-xs font-semibold text-[var(--app-text)]">{t(group.th, group.en)}</summary>
        <div className="mt-1 grid grid-cols-2 gap-x-3 gap-y-1">
          {TIMELINE_ROWS.filter(row => row.group === group.id).map(row => <label key={row.id} className={chip}>
            <input type="checkbox" className="accent-[var(--app-accent)]" checked={rowIds.includes(row.id)} onChange={event => toggleRow(row.id, event.target.checked)} />
            {row.label}{row.unit ? <span className="text-[var(--app-muted)]">({row.unit})</span> : null}
          </label>)}
        </div>
      </details>)}
      {custom.map(row => <div key={row.id} className="flex items-end gap-2">
        <TextField label={t("แถวของตัวเอง", "Own row")} value={row.label ?? row.id} onChange={text => set({ rows: config.rows.map(item => (item.id === row.id ? { ...item, label: text } : item)) })} />
        <button type="button" className="mb-1 text-xs text-rose-600" onClick={() => toggleRow(row.id, false)}>✕</button>
      </div>)}
      <button type="button" className="rounded-lg border border-[var(--app-border)] bg-[var(--app-control-bg)] px-2 py-1 text-xs font-semibold text-[var(--app-text)]"
        onClick={() => {
          const used = new Set(rowIds);
          let n = 1;
          while (used.has(`custom_${n}`)) n += 1;
          set({ rows: [...config.rows, { id: `custom_${n}`, label: t(`ค่าที่ ${n}`, `Value ${n}`) }] });
        }}>+ {t("แถวของตัวเอง (กรอกเอง)", "Own row (typed in)")}</button>
    </div> : null}
  </div>;
}
