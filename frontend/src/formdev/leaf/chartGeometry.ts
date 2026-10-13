/**
 * The timeline trend chart as shapes (Form Studio): grid lines, scale labels, NIBP / ART range bars with ▼ ■ ▲,
 * markers for the other series. Pure geometry in the caller's units, drawn as SVG on screen and as PDF operations,
 * so both look the same. Columns line up with the parameter table below (one column per time).
 */
import type { TimelineSeries, TimelineValue } from "../core/types";
import { LEFT_SCALE, RIGHT_SCALE, SERIES, type SeriesStyle } from "./timeline";

export type ChartShape =
  | { kind: "grid"; x1: number; y1: number; x2: number; y2: number; strong?: boolean }
  | { kind: "label"; x: number; y: number; text: string; anchor: "start" | "end" }
  | { kind: "bar"; x: number; y1: number; y2: number; color: string }
  | { kind: "marker"; x: number; y: number; marker: SeriesStyle["marker"] | "down" | "up"; color: string; size: number };

export type ChartBox = { x: number; y: number; width: number; height: number; columns: number };

const numeric = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value)) ? Number(value) : null);

/** Shapes for `axis.slice(from, from + box.columns)`; each column is box.width / box.columns wide. */
export function chartShapes(value: TimelineValue, series: TimelineSeries[], box: ChartBox, from = 0): ChartShape[] {
  const out: ChartShape[] = [];
  const col = box.width / Math.max(1, box.columns);
  const axis = value.axis.slice(from, from + box.columns);
  const y = (number: number, scale: [number, number]) => {
    const clamped = Math.min(scale[1], Math.max(scale[0], number));
    return box.y + box.height - ((clamped - scale[0]) / (scale[1] - scale[0])) * box.height;
  };
  // Horizontal grid every 20 (left scale), labels on both sides; vertical lines between columns.
  for (let level = LEFT_SCALE[0]; level <= LEFT_SCALE[1]; level += 20) {
    const at = y(level, LEFT_SCALE);
    out.push({ kind: "grid", x1: box.x, y1: at, x2: box.x + box.width, y2: at, strong: level === LEFT_SCALE[0] || level === LEFT_SCALE[1] });
    out.push({ kind: "label", x: box.x - 2, y: at, text: String(level), anchor: "end" });
    const right = RIGHT_SCALE[0] + ((level - LEFT_SCALE[0]) / (LEFT_SCALE[1] - LEFT_SCALE[0])) * (RIGHT_SCALE[1] - RIGHT_SCALE[0]);
    out.push({ kind: "label", x: box.x + box.width + 2, y: at, text: String(Math.round(right)), anchor: "start" });
  }
  for (let index = 0; index <= axis.length; index += 1) out.push({ kind: "grid", x1: box.x + index * col, y1: box.y, x2: box.x + index * col, y2: box.y + box.height });
  const size = Math.max(3, Math.min(7, col * 0.35));
  const cell = (row: string, ts: number) => numeric(value.values[row]?.[String(ts)]);
  axis.forEach((ts, index) => {
    const cx = box.x + index * col + col / 2;
    for (const name of series) {
      const style = SERIES[name];
      const scale = style.axis === "right" ? RIGHT_SCALE : LEFT_SCALE;
      if (style.marker === "range") {
        const [sys, mean, dia] = style.rows.map(row => cell(row, ts));
        if (sys !== null && dia !== null) out.push({ kind: "bar", x: cx, y1: y(sys, scale), y2: y(dia, scale), color: style.color });
        if (sys !== null) out.push({ kind: "marker", x: cx, y: y(sys, scale), marker: "down", color: style.color, size });
        if (mean !== null) out.push({ kind: "marker", x: cx, y: y(mean, scale), marker: "square", color: style.color, size: size * 0.9 });
        if (dia !== null) out.push({ kind: "marker", x: cx, y: y(dia, scale), marker: "up", color: style.color, size });
        continue;
      }
      const number = cell(style.rows[0], ts);
      if (number !== null) out.push({ kind: "marker", x: cx, y: y(number, scale), marker: style.marker, color: style.color, size });
    }
  });
  return out;
}

/** SVG path data of a marker centred on (x, y): the same outlines on screen and in the PDF. */
export function markerPath(marker: Extract<ChartShape, { kind: "marker" }>["marker"], x: number, y: number, size: number): { d: string; filled: boolean } {
  const h = size / 2;
  switch (marker) {
    case "down": return { d: `M${x - h} ${y - h * 0.8}L${x + h} ${y - h * 0.8}L${x} ${y + h * 0.8}Z`, filled: true };
    case "up": return { d: `M${x - h} ${y + h * 0.8}L${x + h} ${y + h * 0.8}L${x} ${y - h * 0.8}Z`, filled: true };
    case "triangle": return { d: `M${x - h} ${y + h * 0.8}L${x + h} ${y + h * 0.8}L${x} ${y - h * 0.8}Z`, filled: false };
    case "square": return { d: `M${x - h * 0.8} ${y - h * 0.8}h${h * 1.6}v${h * 1.6}h${-h * 1.6}Z`, filled: true };
    case "x": return { d: `M${x - h} ${y - h}L${x + h} ${y + h}M${x + h} ${y - h}L${x - h} ${y + h}`, filled: false };
    case "plus": return { d: `M${x - h} ${y}L${x + h} ${y}M${x} ${y - h}L${x} ${y + h}`, filled: false };
    case "circle": return { d: `M${x - h * 0.8} ${y}a${h * 0.8} ${h * 0.8} 0 1 0 ${h * 1.6} 0a${h * 0.8} ${h * 0.8} 0 1 0 ${-h * 1.6} 0Z`, filled: true };
    default: return { d: `M${x - h} ${y}L${x + h} ${y}`, filled: false };
  }
}
