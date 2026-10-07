/** Preview of a Report Studio result: a sortable table with data bars on statistics, or a cross-tab when grouped by two fields. */
import { useMemo, useState } from "react";
import type { ResultColumn, StudioResult, StudioSpec } from "../api/reportStudioApi";
import { tr, type Lang } from "./model";
import { small } from "./styles";

type Props = {
  lang: Lang;
  result: StudioResult;
  sort: StudioSpec["sort"];
  onSort: (key: string) => void;
  onPage: (page: number) => void;
};

function display(value: unknown, type?: string): string {
  if (value == null || value === "") return "—";
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (typeof value === "number") return value.toLocaleString(undefined, { maximumFractionDigits: 1 });
  const text = String(value);
  if (type === "number" && text.trim() !== "" && !Number.isNaN(Number(text))) return Number(text).toLocaleString(undefined, { maximumFractionDigits: 1 });
  if (/^\d{4}-\d{2}-\d{2}T/.test(text)) {
    const date = new Date(text);
    if (!Number.isNaN(date.getTime())) return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(date);
  }
  return text;
}

const numberOf = (value: unknown) => (value == null || value === "" ? null : Number(value));

export default function ResultView({ lang, result, sort, onSort, onPage }: Props) {
  const t = (th: string, en: string) => tr(lang, th, en);
  const rows = useMemo(() => result.rows ?? [], [result.rows]);
  const columns: ResultColumn[] = useMemo(() => result.columns ?? (rows[0] ? Object.keys(rows[0]).map(key => ({ key, label: key, kind: "column" as const, data_type: "text" })) : []), [result.columns, rows]);
  const groups = columns.filter(column => column.kind === "group");
  const measures = columns.filter(column => column.kind === "measure");
  const canPivot = groups.length === 2 && measures.length >= 1;
  const [pivot, setPivot] = useState(false);
  const [pivotMeasure, setPivotMeasure] = useState(0);
  const pagination = result.pagination;

  // Largest value per statistic, for the data bars.
  const peaks = useMemo(() => Object.fromEntries(measures.map(column => [column.key, Math.max(0, ...rows.map(row => numberOf(row[column.key]) ?? 0))])), [measures, rows]);

  const th = "whitespace-nowrap border-b border-[var(--app-border)] px-3 py-2 text-left text-[11px] font-extrabold uppercase tracking-[0.08em] text-[var(--app-muted)]";
  const td = "max-w-[320px] truncate whitespace-nowrap px-3 py-2 text-[var(--app-text)]";

  return <div className="space-y-2">
    {canPivot ? <div className="flex flex-wrap items-center gap-2 text-xs text-[var(--app-muted)]">
      <div className="flex rounded-lg border border-[var(--app-border)] p-0.5">
        {([[false, t("ตาราง", "Table")], [true, t("ตารางไขว้", "Cross-tab")]] as Array<[boolean, string]>).map(([value, text]) =>
          <button key={text} type="button" onClick={() => setPivot(value)} className={`rounded-md px-2.5 py-1 text-xs font-bold ${pivot === value ? "bg-[var(--app-accent)] text-[var(--app-accent-contrast)]" : "text-[var(--app-muted)]"}`}>{text}</button>)}
      </div>
      {pivot && measures.length > 1 ? <select className="rounded-lg border border-[var(--app-border)] bg-[var(--app-control-bg)] px-2 py-1 text-xs text-[var(--app-text)]" value={pivotMeasure} onChange={event => setPivotMeasure(Number(event.target.value))}>
        {measures.map((column, index) => <option key={column.key} value={index}>{column.label}</option>)}
      </select> : null}
    </div> : null}

    <div className="overflow-auto rounded-xl border border-[var(--app-border)]">
      {pivot && canPivot ? <Pivot rows={rows} row={groups[0]} column={groups[1]} measure={measures[Math.min(pivotMeasure, measures.length - 1)]} th={th} td={td} lang={lang} />
        : <table className="min-w-full text-sm">
          <thead className="sticky top-0 bg-[var(--app-control-bg)]"><tr>
            {columns.map(column => {
              const active = sort?.key === column.key;
              return <th key={column.key} className={`${th} ${column.kind === "measure" ? "text-right" : ""}`}>
                <button type="button" className="inline-flex items-center gap-1 uppercase hover:text-[var(--app-text)]" onClick={() => onSort(column.key)} title={t("คลิกเพื่อเรียงลำดับ", "Click to sort")}>
                  {column.label}<span className="text-[var(--app-accent)]">{active ? (sort?.dir === "desc" ? "↓" : "↑") : ""}</span>
                </button>
              </th>;
            })}
          </tr></thead>
          <tbody>
            {rows.map((row, index) => <tr key={String(row.record_id ?? index)} className="border-b border-[var(--app-border)] last:border-0 hover:bg-[var(--app-control-bg)]">
              {columns.map(column => {
                const value = row[column.key];
                if (column.kind !== "measure") return <td key={column.key} className={td} title={String(value ?? "")}>{display(value, column.data_type)}</td>;
                const peak = peaks[column.key] || 0;
                const share = peak > 0 ? Math.max(0, Math.min(100, ((numberOf(value) ?? 0) / peak) * 100)) : 0;
                return <td key={column.key} className={`${td} relative text-right tabular-nums`}>
                  <span aria-hidden className="absolute inset-y-1 right-1 rounded bg-[var(--app-accent)] opacity-15" style={{ width: `calc(${share}% - 8px)` }} />
                  <span className="relative">{display(value, "number")}{column.agg === "pct_cases" && value != null ? "%" : ""}</span>
                </td>;
              })}
            </tr>)}
          </tbody>
        </table>}
      {!rows.length ? <div className="p-8 text-center text-sm text-[var(--app-muted)]">{t("ไม่มีข้อมูลที่ตรงเงื่อนไข", "No matching records.")}</div> : null}
    </div>

    {pagination && pagination.total_pages > 1 && !pivot ? <div className="flex items-center justify-between text-xs text-[var(--app-muted)]">
      <span>{pagination.total.toLocaleString()} {t("แถว", "rows")}</span>
      <div className="flex items-center gap-2">
        <button type="button" className={small} disabled={pagination.page <= 1} onClick={() => onPage(pagination.page - 1)}>‹</button>
        <span>{pagination.page} / {pagination.total_pages}</span>
        <button type="button" className={small} disabled={pagination.page >= pagination.total_pages} onClick={() => onPage(pagination.page + 1)}>›</button>
      </div>
    </div> : null}
  </div>;
}

function Pivot({ rows, row, column, measure, th, td, lang }: { rows: Array<Record<string, unknown>>; row: ResultColumn; column: ResultColumn; measure: ResultColumn; th: string; td: string; lang: Lang }) {
  const rowKeys = [...new Set(rows.map(item => String(item[row.key] ?? "—")))];
  const columnKeys = [...new Set(rows.map(item => String(item[column.key] ?? "—")))].sort();
  const cells = new Map(rows.map(item => [`${String(item[row.key] ?? "—")}\u0000${String(item[column.key] ?? "—")}`, item[measure.key]]));
  const additive = measure.agg === "count_cases" || measure.agg === "count_patients" || measure.agg === "count_filled" || measure.agg === "sum";
  const peak = Math.max(0, ...rows.map(item => Number(item[measure.key] ?? 0)));
  return <table className="min-w-full text-sm">
    <thead className="sticky top-0 bg-[var(--app-control-bg)]"><tr>
      <th className={th}>{row.label} \ {column.label}</th>
      {columnKeys.map(key => <th key={key} className={`${th} text-right`}>{key}</th>)}
      {additive ? <th className={`${th} text-right`}>{tr(lang, "รวมแถว", "Row sum")}</th> : null}
    </tr></thead>
    <tbody>
      {rowKeys.map(key => {
        const values = columnKeys.map(columnKey => cells.get(`${key}\u0000${columnKey}`));
        return <tr key={key} className="border-b border-[var(--app-border)] last:border-0">
          <td className={`${td} font-semibold`}>{key}</td>
          {values.map((value, index) => {
            const share = peak > 0 ? Number(value ?? 0) / peak : 0;
            return <td key={columnKeys[index]} className={`${td} text-right tabular-nums`} style={{ background: share ? `color-mix(in srgb, var(--app-accent) ${Math.round(share * 28)}%, transparent)` : undefined }}>{display(value, "number")}</td>;
          })}
          {additive ? <td className={`${td} text-right font-semibold tabular-nums`}>{display(values.reduce<number>((sum, value) => sum + Number(value ?? 0), 0), "number")}</td> : null}
        </tr>;
      })}
    </tbody>
  </table>;
}
