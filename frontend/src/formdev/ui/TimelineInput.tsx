/**
 * timeline field (Form Studio): Flora Leaf's events row, trend chart and parameter table over time, inside a form.
 * In a case (FormCaseContext) the data is pulled from Leaf (automatically the first time, then on request) and kept
 * with the record; cells stay editable (values Leaf does not record, corrections). Without a case, columns are
 * added by time and everything is typed in.
 */
import { useContext, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import type { JsonValue, TimelineValue } from "../core/types";
import { chartShapes, markerPath } from "../leaf/chartGeometry";
import { FormCaseContext } from "../leaf/caseContext";
import { cellLabel, eventColumn, loadLeafTimeline, neededRows, rowInfo, SERIES, timeLabel, timelineAxis, timelineConfig, asTimeline } from "../leaf/timeline";
import type { InputProps } from "./fieldInputs";

const LABEL = 128;
const COL = 46;
const CHART_HEIGHT = 200;

export function TimelineInput({ field, value, disabled, label, onChange }: InputProps) {
  const config = timelineConfig(field);
  const leafCase = useContext(FormCaseContext);
  const timeline = asTimeline(value);
  const [state, setState] = useState<{ busy: boolean; message: string }>({ busy: false, message: "" });
  const pulledOnce = useRef(false);
  const canPull = Boolean(leafCase) && config.source === "leaf" && !disabled;
  const rows = config.rows.map(row => rowInfo(row.id, row));

  const pull = async () => {
    if (!leafCase) return;
    setState({ busy: true, message: "" });
    try {
      const fresh = await loadLeafTimeline(leafCase, config.step, neededRows(rows.map(row => row.id), config.chart));
      // Leaf's values win; rows Leaf has no data for keep what was typed in, on the columns that still exist.
      const kept: TimelineValue["values"] = {};
      const columns = new Set(fresh.axis.map(String));
      for (const [row, cells] of Object.entries(timeline?.values ?? {})) {
        if (fresh.values[row]) continue;
        const remaining = Object.fromEntries(Object.entries(cells).filter(([ts]) => columns.has(ts)));
        if (Object.keys(remaining).length) kept[row] = remaining;
      }
      onChange({ ...fresh, values: { ...kept, ...fresh.values } } as unknown as JsonValue);
      setState({ busy: false, message: fresh.axis.length ? "" : "ยังไม่มีข้อมูลในเคสนี้ / No data in this case yet" });
    } catch (caught) {
      setState({ busy: false, message: caught instanceof Error ? caught.message : String(caught) });
    }
  };

  useEffect(() => {
    // The first time the form is opened in a case, the timeline fills itself (once; later pulls are on request).
    if (!canPull || timeline || pulledOnce.current) return;
    // The flag is set when the pull starts: a cancelled timer (React's development double run) does not count.
    const timer = setTimeout(() => { pulledOnce.current = true; void pull(); }, 0);
    return () => clearTimeout(timer);
  });

  const addColumn = () => {
    const step = (timeline?.step_min ?? config.step) * 60_000;
    const last = timeline?.axis[timeline.axis.length - 1];
    const next = last !== undefined ? last + step : timelineAxis(Date.now(), Date.now(), config.step)[0];
    onChange({ step_min: timeline?.step_min ?? config.step, axis: [...(timeline?.axis ?? []), next], values: timeline?.values ?? {}, events: timeline?.events ?? [],
      source: timeline?.source ?? "manual" } as unknown as JsonValue);
  };
  const setCell = (row: string, ts: number, text: string) => {
    if (!timeline) return;
    const cells = { ...(timeline.values[row] ?? {}) };
    const trimmed = text.trim();
    if (trimmed === "") delete cells[String(ts)];
    else cells[String(ts)] = Number.isFinite(Number(trimmed)) ? Number(trimmed) : trimmed.slice(0, 40);
    const values = { ...timeline.values, [row]: cells };
    if (!Object.keys(cells).length) delete values[row];
    onChange({ ...timeline, values } as unknown as JsonValue);
  };

  const axis = timeline?.axis ?? [];
  const width = LABEL + axis.length * COL;
  const shapes = useMemo(() => (timeline && config.parts.includes("chart")
    ? chartShapes(timeline, config.chart, { x: LABEL, y: 6, width: axis.length * COL, height: CHART_HEIGHT - 12, columns: axis.length }) : []), [timeline, config.chart, config.parts, axis.length]);
  const events = (timeline?.events ?? []).map((event, index) => ({ ...event, n: index + 1, column: eventColumn(axis, event.ts) }));

  const cell: CSSProperties = { border: "0.3mm solid #cbd5e1", width: COL, minWidth: COL, maxWidth: COL, padding: 0, textAlign: "center", fontSize: "8.5pt" };
  const head: CSSProperties = { ...cell, background: "#f1f5f9", fontWeight: 600, padding: "1mm 0" };
  const name: CSSProperties = { border: "0.3mm solid #cbd5e1", width: LABEL, minWidth: LABEL, padding: "0.5mm 1.5mm", fontSize: "8.5pt", whiteSpace: "nowrap", position: "sticky", left: 0, background: "#ffffff", zIndex: 1 };
  const button: CSSProperties = { fontSize: "9pt", padding: "0.8mm 2.5mm", border: "0.3mm solid #cbd5e1", borderRadius: "1mm", background: "#ffffff", cursor: "pointer" };

  return <div data-timeline={field.id} aria-label={label} style={{ display: "grid", gap: "1.5mm" }}>
    {!disabled ? <div style={{ display: "flex", flexWrap: "wrap", gap: "2mm", alignItems: "center", fontSize: "8.5pt", color: "#475569" }}>
      {canPull ? <button type="button" style={button} disabled={state.busy} onClick={() => void pull()}>{state.busy ? "…" : "⟳ ดึงข้อมูลจาก Flora Leaf"}</button> : null}
      <button type="button" style={button} onClick={addColumn}>+ คอลัมน์เวลา ({timeline?.step_min ?? config.step} นาที)</button>
      {timeline?.captured_at ? <span>Flora Leaf {timeLabel(timeline.captured_at)}</span> : null}
      {!leafCase && config.source === "leaf" ? <span>ไม่ได้เปิดในเคส: กรอกเองได้ / Not opened in a case: type the values in</span> : null}
      {state.message ? <span role="alert" style={{ color: "#b45309" }}>{state.message}</span> : null}
    </div> : null}
    {!axis.length ? <div style={{ border: "0.3mm dashed #cbd5e1", padding: "4mm", textAlign: "center", color: "#94a3b8", fontSize: "9pt" }}>—</div> : <div style={{ overflowX: "auto" }}>
      <table style={{ borderCollapse: "collapse", tableLayout: "fixed", width }}>
        <thead><tr><th style={{ ...name, background: "#f1f5f9" }}>{field.label}</th>{axis.map(ts => <th key={ts} style={head}>{timeLabel(ts)}</th>)}</tr></thead>
        <tbody>
          {config.parts.includes("events") ? <tr><td style={name}>Events</td>{axis.map((ts, index) => <td key={ts} style={cell}>
            {events.filter(event => event.column === index).map(event => <span key={event.n} title={`${timeLabel(event.ts)} ${event.title}`}
              style={{ display: "inline-block", minWidth: "4mm", margin: "0 0.3mm", border: "0.3mm solid #475569", borderRadius: "1mm", fontSize: "7pt" }}>{event.n}</span>)}
          </td>)}</tr> : null}
          {config.parts.includes("chart") ? <tr><td style={{ ...name, verticalAlign: "top" }}>
            {config.chart.map(series => <div key={series} style={{ display: "flex", alignItems: "center", gap: "1.5mm" }}>
              <svg width="12" height="12" aria-hidden="true">{SERIES[series].marker === "range"
                ? <path d={`${markerPath("down", 6, 3.5, 7).d}${markerPath("up", 6, 8.5, 7).d}`} fill={SERIES[series].color} />
                : <path d={markerPath(SERIES[series].marker, 6, 6, 8).d} fill={markerPath(SERIES[series].marker, 6, 6, 8).filled ? SERIES[series].color : "none"} stroke={SERIES[series].color} strokeWidth={1.4} />}</svg>
              {SERIES[series].label}
            </div>)}
          </td><td colSpan={axis.length} style={{ padding: 0, border: "0.3mm solid #cbd5e1" }}>
            <svg width={axis.length * COL} height={CHART_HEIGHT} viewBox={`${LABEL} 0 ${axis.length * COL} ${CHART_HEIGHT}`} role="img" aria-label={`${field.label}: chart`} style={{ display: "block" }}>
              {shapes.map((shape, index) => {
                if (shape.kind === "grid") return <line key={index} x1={shape.x1} y1={shape.y1} x2={shape.x2} y2={shape.y2} stroke={shape.strong ? "#94a3b8" : "#e2e8f0"} strokeWidth={0.8} />;
                // Scale values just inside the left edge (the right scale, temperature, is printed in the PDF).
                if (shape.kind === "label") return shape.anchor === "end" ? <text key={index} x={shape.x + 4} y={shape.y - 1} fontSize="7" fill="#94a3b8">{shape.text}</text> : null;
                if (shape.kind === "bar") return <line key={index} x1={shape.x} y1={shape.y1} x2={shape.x} y2={shape.y2} stroke={shape.color} strokeWidth={1.2} />;
                const path = markerPath(shape.marker, shape.x, shape.y, shape.size);
                return <path key={index} d={path.d} fill={path.filled ? shape.color : "none"} stroke={shape.color} strokeWidth={1.4} />;
              })}
            </svg>
          </td></tr> : null}
          {config.parts.includes("table") ? rows.map(row => <tr key={row.id}>
            <td style={name}><span style={{ display: "flex", justifyContent: "space-between", gap: "2mm" }}><span>{row.label}</span><span style={{ color: "#64748b" }}>{row.unit ?? ""}</span></span></td>
            {axis.map(ts => {
              const current = timeline?.values[row.id]?.[String(ts)];
              return <td key={ts} style={cell}>{disabled ? cellLabel(current) : <input aria-label={`${row.label} ${timeLabel(ts)}`} value={cellLabel(current)} inputMode="decimal"
                onChange={event => setCell(row.id, ts, event.target.value)} style={{ width: "100%", border: 0, background: "transparent", textAlign: "center", fontSize: "8.5pt", padding: "0.8mm 0" }} />}</td>;
            })}
          </tr>) : null}
        </tbody>
      </table>
    </div>}
    {config.parts.includes("events") && events.length ? <ol style={{ margin: 0, paddingLeft: "6mm", fontSize: "8.5pt", columns: 2 }}>
      {events.map(event => <li key={event.n}>{timeLabel(event.ts)} {event.title}</li>)}
    </ol> : null}
  </div>;
}
