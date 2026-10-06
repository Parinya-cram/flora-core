import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import type { ClinicalTimelineValues } from "../clinical-timeline/types";
import { COL_WIDTH, LABEL_COL_WIDTH } from "../clinical-timeline/layout";
import { useVirtualColumns } from "../../hooks/useVirtualColumns";
import ClinicalReferenceTooltip from "../common/ClinicalReferenceTooltip";
import { formatConfiguredTime, getStoredDateTimePreferences } from "../../utils/dateTime";
import { useTheme } from "../../context/ThemeContext";
import { CHART_PREFERENCES_CHANGED_EVENT } from "../../utils/chartPreferences";
import { mixRgb, parseHexColor, smartContrastColor } from "../../utils/smartContrast";

export type VitalGroup = "spo2" | "hr" | "pr" | "nibp" | "art" | "cvp" | "temp";

export type ChartGroupConfig = {
  key: VitalGroup;
  label: string;
  defaultVisible: boolean;
  tooltip?: string;
  color?: string;
  marker?: ChartMarker;
};

export type ChartMarker = "circle" | "heart" | "diamond" | "square" | "triangle" | "range";

type XY = {
  ts: number;
  x: number;
  y: number;
  value: number;
};

type Props = {
  axis: number[];
  values: ClinicalTimelineValues;
  nowTs: number;
  height?: number;
  colWidth?: number;
  labelColWidth?: number;
  scrollLeft?: number;
  viewportWidth?: number;
  configuredGroups?: ChartGroupConfig[];
  storageKey?: string;
  preferredVisibleGroups?: VitalGroup[];
  preferredSmartContrast?: boolean;
};

const CHART_MIN = 0;
const CHART_MAX = 200;
const CHART_PADDING_Y = 10;
const GRID_STROKE = "var(--chart-grid-line)";
const SPO2_COLOR = "var(--chart-spo2)";
const NIBP_COLOR = "var(--chart-nibp)";
const ART_COLOR = "var(--chart-art)";
const CVP_COLOR = "var(--chart-cvp)";
const TEMP_COLOR = "var(--chart-temp)";
const HR_COLOR = "var(--chart-hr)";
const PR_COLOR = "var(--chart-pr, var(--chart-spo2))";
const MINUTE_MS = 60_000;
const VITAL_LINE_STROKE = 1;
const CONNECTOR_LINE_STROKE = 0.9;
const DOT_RADIUS = 1.6;
const TRIANGLE_HALF_WIDTH = 3;
const TRIANGLE_HALF_HEIGHT = 3;
const Y_TICKS = [200, 180, 160, 140, 120, 100, 80, 60, 40, 20, 0];
// The nonlinear focus scale intentionally compresses both ends. Keep their
// grid lines, but omit the two labels that would collide with 200 and 0.
const Y_LABEL_TICKS = Y_TICKS.filter(value => value !== 180 && value !== 20);

const FALLBACK_GROUPS: ChartGroupConfig[] = [
  { key: "spo2", label: "SpO2", defaultVisible: true, marker: "circle" },
  { key: "hr", label: "HR", defaultVisible: true, marker: "heart" },
  { key: "pr", label: "PR/PLS", defaultVisible: true, marker: "circle" },
  { key: "nibp", label: "NIBP", defaultVisible: true, marker: "range" },
  { key: "art", label: "ART", defaultVisible: false, marker: "range" },
  { key: "cvp", label: "CVP", defaultVisible: false, marker: "diamond" },
  { key: "temp", label: "Temp", defaultVisible: false, marker: "diamond" },
];

function initialVisibleGroups(
  groups: ChartGroupConfig[],
  storageKey?: string,
  preferredVisibleGroups?: VitalGroup[],
): VitalGroup[] {
  const available = new Set(groups.map(group => group.key));
  if (storageKey && typeof window !== "undefined") {
    try {
      // A missing key means "never chosen": fall through to account/configured defaults.
      const stored = window.localStorage.getItem(storageKey);
      const saved = stored == null ? null : JSON.parse(stored) as unknown;
      if (Array.isArray(saved)) {
        const valid = saved.filter((key): key is VitalGroup => typeof key === "string" && available.has(key as VitalGroup));
        return valid;
      }
    } catch {
      // Ignore stale or malformed preferences and use the configured defaults.
    }
  }
  if (preferredVisibleGroups) {
    return preferredVisibleGroups.filter(key => available.has(key));
  }
  return groups.filter(group => group.defaultVisible).map(group => group.key);
}

function smartContrastKey(storageKey?: string) {
  return `${storageKey || "flora.chart"}.smartContrast`;
}

function initialSmartContrast(storageKey?: string, preferred?: boolean) {
  if (typeof window === "undefined") return preferred ?? true;
  const saved = window.localStorage.getItem(smartContrastKey(storageKey));
  return saved == null ? preferred ?? true : saved !== "0";
}

function groupColor(key: VitalGroup) {
  return {
    spo2: SPO2_COLOR, hr: HR_COLOR, pr: PR_COLOR, nibp: NIBP_COLOR,
    art: ART_COLOR, cvp: CVP_COLOR, temp: TEMP_COLOR,
  }[key];
}

function toNumber(value: unknown): number | undefined {
  if (value == null || value === "") return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

function buildPath(points: XY[]): string {
  if (points.length < 2) return "";
  return points
    .map((p, i) => `${i === 0 ? "M" : "L"} ${p.x} ${p.y}`)
    .join(" ");
}

function splitByTimeGap(points: XY[], maxGapMs: number): XY[][] {
  if (points.length === 0) return [];
  const parts: XY[][] = [[points[0]]];

  for (let i = 1; i < points.length; i += 1) {
    const prev = points[i - 1];
    const curr = points[i];
    if (curr.ts - prev.ts > maxGapMs) {
      parts.push([curr]);
    } else {
      parts[parts.length - 1].push(curr);
    }
  }

  return parts;
}

function markerIntervalForAxisStep(stepMs: number) {
  const stepMinutes = stepMs / MINUTE_MS;
  if (stepMinutes <= 5) return MINUTE_MS;
  if (stepMinutes <= 10) return 2 * MINUTE_MS;
  if (stepMinutes <= 20) return 5 * MINUTE_MS;
  if (stepMinutes <= 30) return 10 * MINUTE_MS;
  if (stepMinutes <= 60) return 15 * MINUTE_MS;
  return 30 * MINUTE_MS;
}

function samplePointsByInterval(points: XY[], intervalMs: number, anchorTs: number): XY[] {
  if (points.length < 2 || intervalMs <= MINUTE_MS) return points;

  const sampled: XY[] = [];
  let activeBucket = Number.NaN;
  let lastInBucket: XY | null = null;

  for (const point of points) {
    const bucket = Math.floor((point.ts - anchorTs) / intervalMs);
    if (bucket !== activeBucket) {
      if (lastInBucket) sampled.push(lastInBucket);
      activeBucket = bucket;
    }
    lastInBucket = point;
  }

  if (lastInBucket) sampled.push(lastInBucket);
  return sampled;
}

type VerticalConnector = {
  key: string;
  x: number;
  yMin: number;
  yMax: number;
};

function buildVerticalConnectors(
  label: string,
  sysPoints: XY[],
  mapPoints: XY[],
  diaPoints: XY[],
): VerticalConnector[] {
  const grouped = new Map<number, { x: number; yValues: number[] }>();
  const add = (point: XY) => {
    const existing = grouped.get(point.ts);
    if (existing) {
      existing.yValues.push(point.y);
      return;
    }
    grouped.set(point.ts, { x: point.x, yValues: [point.y] });
  };

  sysPoints.forEach(add);
  mapPoints.forEach(add);
  diaPoints.forEach(add);

  const rows: VerticalConnector[] = [];
  for (const [ts, payload] of grouped.entries()) {
    if (payload.yValues.length < 2) continue;
    const yMin = Math.min(...payload.yValues);
    const yMax = Math.max(...payload.yValues);
    rows.push({
      key: `${label}-${ts}`,
      x: payload.x,
      yMin,
      yMax,
    });
  }
  return rows;
}

function formatPointValue(n: number): string {
  if (!Number.isFinite(n)) return "-";
  if (Math.abs(n) >= 100) return String(Math.round(n));
  if (Math.abs(n) >= 10) return Number(n.toFixed(1)).toString();
  return Number(n.toFixed(2)).toString();
}

function TriangleUp({ x, y, color }: { x: number; y: number; color: string }) {
  return (
    <path
      d={`M ${x} ${y - TRIANGLE_HALF_HEIGHT} L ${x - TRIANGLE_HALF_WIDTH} ${
        y + TRIANGLE_HALF_HEIGHT
      } L ${x + TRIANGLE_HALF_WIDTH} ${y + TRIANGLE_HALF_HEIGHT} Z`}
      fill={color}
      stroke={color}
      strokeWidth={VITAL_LINE_STROKE}
    />
  );
}

function TriangleDown({
  x,
  y,
  color,
}: {
  x: number;
  y: number;
  color: string;
}) {
  return (
    <path
      d={`M ${x} ${y + TRIANGLE_HALF_HEIGHT} L ${x - TRIANGLE_HALF_WIDTH} ${
        y - TRIANGLE_HALF_HEIGHT
      } L ${x + TRIANGLE_HALF_WIDTH} ${y - TRIANGLE_HALF_HEIGHT} Z`}
      fill={color}
      stroke={color}
      strokeWidth={VITAL_LINE_STROKE}
    />
  );
}

function CircleDot({ x, y, color }: { x: number; y: number; color: string }) {
  return <circle cx={x} cy={y} r={DOT_RADIUS} fill={color} stroke={color} />;
}

function HeartDot({ x, y }: { x: number; y: number }) {
  return (
    <text x={x} y={y + 2.5} textAnchor="middle" fontSize={7.5} fill="currentColor">
      {"\u2665"}
    </text>
  );
}

function PointMarker({ x, y, color, marker = "circle" }: { x: number; y: number; color: string; marker?: ChartMarker }) {
  if (marker === "heart") return <g style={{ color }}><HeartDot x={x} y={y} /></g>;
  if (marker === "diamond") return <path d={`M ${x} ${y - 3.5} L ${x + 3.5} ${y} L ${x} ${y + 3.5} L ${x - 3.5} ${y} Z`} fill={color} />;
  if (marker === "square") return <rect x={x - 2.8} y={y - 2.8} width={5.6} height={5.6} rx={0.6} fill={color} />;
  if (marker === "triangle") return <TriangleUp x={x} y={y} color={color} />;
  return <CircleDot x={x} y={y} color={color} />;
}

function SeriesGlyph({ marker = "circle", color, className = "h-3 w-3" }: { marker?: ChartMarker; color: string; className?: string }) {
  return <svg viewBox="0 0 16 16" className={`${className} shrink-0`} aria-hidden="true">
    {marker === "heart" ? <path d="M8 13C6.5 11.5 2 8.8 2 5.3 2 2.4 5.6 1.5 8 4c2.4-2.5 6-1.6 6 1.3 0 3.5-4.5 6.2-6 7.7Z" fill={color} />
      : marker === "diamond" ? <path d="M8 1.8 14.2 8 8 14.2 1.8 8Z" fill={color} />
      : marker === "square" ? <rect x="2.3" y="2.3" width="11.4" height="11.4" rx="1.5" fill={color} />
      : marker === "triangle" ? <path d="M8 2 14 13H2Z" fill={color} />
      : marker === "range" ? <><path d="M8 2v12" stroke={color} strokeWidth="1.8"/><path d="m4.5 4 3.5-2 3.5 2ZM4.5 12l3.5 2 3.5-2Z" fill={color}/><circle cx="8" cy="8" r="1.8" fill={color}/></>
      : <circle cx="8" cy="8" r="5.5" fill={color} />}
  </svg>;
}

export default function VitalSignsTrendChart({
  axis,
  values,
  nowTs,
  height = 150,
  colWidth = COL_WIDTH,
  labelColWidth = LABEL_COL_WIDTH,
  scrollLeft = 0,
  viewportWidth = 0,
  configuredGroups,
  storageKey,
  preferredVisibleGroups,
  preferredSmartContrast,
}: Props) {
  const { color: themeCode, schemes } = useTheme();
  const chartGroups = useMemo(
    () => configuredGroups === undefined ? FALLBACK_GROUPS : configuredGroups,
    [configuredGroups],
  );
  const groupConfig = useMemo(() => new Map(chartGroups.map(group => [group.key, group])), [chartGroups]);
  const [hoverColumnIndex, setHoverColumnIndex] = useState<number | null>(null);
  const [rulerValue, setRulerValue] = useState<number | null>(null);
  const [visibleGroups, setVisibleGroups] = useState<VitalGroup[]>(() => initialVisibleGroups(chartGroups, storageKey, preferredVisibleGroups));
  const [configOpen, setConfigOpen] = useState(false);
  const [draftVisibleGroups, setDraftVisibleGroups] = useState<VitalGroup[]>(visibleGroups);
  const [smartContrast, setSmartContrast] = useState(() => initialSmartContrast(storageKey, preferredSmartContrast));
  const [draftSmartContrast, setDraftSmartContrast] = useState(smartContrast);
  const activeTheme = schemes.find(theme => theme.code === themeCode);
  const themeCanvas = parseHexColor(activeTheme?.colors[0] || "#FFFFFF") || { r: 255, g: 255, b: 255 };
  const themeSurface = parseHexColor(activeTheme?.colors[1] || "#FFFFFF") || themeCanvas;
  const chartBackground = mixRgb(themeCanvas, themeSurface, 0.2);
  useEffect(() => {
    const applyStoredPreferences = () => {
      setVisibleGroups(initialVisibleGroups(chartGroups, storageKey, preferredVisibleGroups));
      setSmartContrast(initialSmartContrast(storageKey, preferredSmartContrast));
    };
    window.addEventListener(CHART_PREFERENCES_CHANGED_EVENT, applyStoredPreferences);
    return () => window.removeEventListener(CHART_PREFERENCES_CHANGED_EVENT, applyStoredPreferences);
  }, [chartGroups, preferredSmartContrast, preferredVisibleGroups, storageKey]);
  const seriesColor = (key: VitalGroup) => {
    const configured = groupConfig.get(key)?.color;
    return configured ? smartContrastColor(configured, chartBackground, smartContrast) : groupColor(key);
  };
  const seriesMarker = (key: VitalGroup) => groupConfig.get(key)?.marker || (key === "hr" ? "heart" : key === "nibp" || key === "art" ? "range" : "circle");
  const spo2Color = seriesColor("spo2");
  const hrColor = seriesColor("hr");
  const prColor = seriesColor("pr");
  const nibpColor = seriesColor("nibp");
  const artColor = seriesColor("art");
  const cvpColor = seriesColor("cvp");
  const tempColor = seriesColor("temp");

  const { startIndex, endIndex } = useVirtualColumns(
    scrollLeft,
    viewportWidth,
    colWidth,
    axis.length,
    10 // larger overscan for chart to handle lines better
  );

  const enabledGroups = new Set(visibleGroups);
  const isVisible = (key: VitalGroup) => enabledGroups.has(key);

  const openConfig = () => {
    setDraftVisibleGroups(visibleGroups);
    setDraftSmartContrast(smartContrast);
    setConfigOpen(true);
  };

  const applyConfig = () => {
    setVisibleGroups(draftVisibleGroups);
    setSmartContrast(draftSmartContrast);
    if (storageKey && typeof window !== "undefined") {
      window.localStorage.setItem(storageKey, JSON.stringify(draftVisibleGroups));
    }
    if (typeof window !== "undefined") {
      window.localStorage.setItem(smartContrastKey(storageKey), draftSmartContrast ? "1" : "0");
    }
    setConfigOpen(false);
  };

  const chartKeys = ["spo2", "hr", "pr", "nibp_sys", "nibp_map", "nibp_dia", "art_sys", "art_map", "art_dia", "cvp", "temperature"];
  const hasChartReadings = chartKeys.some(key =>
    Object.values(values[key] || {}).some(value => value !== "" && value != null && Number.isFinite(Number(value))),
  );

  const stepMs = axis.length > 1 ? Math.max(1, axis[1] - axis[0]) : MINUTE_MS;
  const startTs = axis[0] ?? 0;
  const endExclusiveTs = (axis[axis.length - 1] ?? startTs) + stepMs;
  const chartWidth = axis.length * colWidth;
  const innerHeight = Math.max(0, height - CHART_PADDING_Y * 2);

  const yFor = (value: number) => {
    const clamped = Math.min(CHART_MAX, Math.max(CHART_MIN, value));
    const normalized = (clamped - CHART_MIN) / (CHART_MAX - CHART_MIN);
    // Smoothstep creates a symmetric focus scale: the clinically dense middle
    // receives more room while both extremes are compressed equally.
    const focused = normalized * normalized * (3 - 2 * normalized);
    return CHART_PADDING_Y + (1 - focused) * innerHeight;
  };

  const normalizedSeries = useMemo(() => {
    const keys = [
      "spo2", "hr", "pr", "nibp_sys", "nibp_map", "nibp_dia",
      "art_sys", "art_map", "art_dia", "cvp", "temperature",
    ];
    const result = new Map<string, Array<{ ts: number; value: number }>>();
    for (const key of keys) {
      const row = values[key];
      if (!row) {
        result.set(key, []);
        continue;
      }
      const points = Object.entries(row)
        .map(([tsKey, raw]) => ({ ts: Number(tsKey), value: toNumber(raw) }))
        .filter(
          (point): point is { ts: number; value: number } =>
            Number.isFinite(point.ts) && point.value != null,
        )
        .sort((a, b) => a.ts - b.ts);
      result.set(key, points);
    }
    return result;
  }, [values]);

  const visibleSeries = useMemo(() => {
    const buffer = 5;
    const sIdx = Math.max(0, startIndex - buffer);
    const eIdx = Math.min(axis.length - 1, endIndex + buffer);
    const minTs = axis[sIdx] ?? startTs;
    const maxTs = (axis[eIdx] ?? startTs) + stepMs;
    const pointForValue = (ts: number, value: number): XY => {
      const x = ((ts - startTs + MINUTE_MS / 2) / stepMs) * colWidth;
      const clamped = Math.min(CHART_MAX, Math.max(CHART_MIN, value));
      const normalized = (clamped - CHART_MIN) / (CHART_MAX - CHART_MIN);
      const focused = normalized * normalized * (3 - 2 * normalized);
      return {
        ts,
        x,
        y: CHART_PADDING_Y + (1 - focused) * innerHeight,
        value,
      };
    };
    const pointsFor = (key: string): XY[] =>
      (normalizedSeries.get(key) || [])
        .filter(point => point.ts >= minTs && point.ts < maxTs)
        .map(point => pointForValue(point.ts, point.value))
        .filter(point => point.x >= 0 && point.x <= chartWidth);

    return {
      spo2: pointsFor("spo2"),
      hr: pointsFor("hr"),
      pr: pointsFor("pr"),
      nibpSys: pointsFor("nibp_sys"),
      nibpMap: pointsFor("nibp_map"),
      nibpDia: pointsFor("nibp_dia"),
      artSys: pointsFor("art_sys"),
      artMap: pointsFor("art_map"),
      artDia: pointsFor("art_dia"),
      cvp: pointsFor("cvp"),
      temp: pointsFor("temperature"),
    };
  }, [axis, chartWidth, colWidth, endIndex, innerHeight, normalizedSeries, startIndex, startTs, stepMs]);

  const markerSeries = useMemo(() => {
    const intervalMs = markerIntervalForAxisStep(stepMs);
    const sample = (points: XY[]) => samplePointsByInterval(points, intervalMs, startTs);
    return {
      spo2: sample(visibleSeries.spo2),
      hr: sample(visibleSeries.hr),
      pr: sample(visibleSeries.pr),
      nibpSys: sample(visibleSeries.nibpSys),
      nibpMap: sample(visibleSeries.nibpMap),
      nibpDia: sample(visibleSeries.nibpDia),
      artSys: sample(visibleSeries.artSys),
      artMap: sample(visibleSeries.artMap),
      artDia: sample(visibleSeries.artDia),
      cvp: sample(visibleSeries.cvp),
      temp: sample(visibleSeries.temp),
    };
  }, [startTs, stepMs, visibleSeries]);

  if (axis.length === 0) return null;
  if (!hasChartReadings) {
    return (
      <div className="timechart-empty flex h-12 items-center border-b text-xs" style={{ width: labelColWidth + axis.length * colWidth }}>
        <strong className="timechart-sticky-label timegrid-cell-border sticky left-0 z-[100] shrink-0 border-r px-3 py-4 text-[var(--app-text)]" style={{ width: labelColWidth }}>VITAL SIGNS</strong>
        <span className="px-4">No vital readings in this time window</span>
      </div>
    );
  }

  const spo2Points = visibleSeries.spo2;
  const hrPoints = visibleSeries.hr;
  const prPoints = visibleSeries.pr;
  const nibpSysPoints = visibleSeries.nibpSys;
  const nibpMapPoints = visibleSeries.nibpMap;
  const nibpDiaPoints = visibleSeries.nibpDia;
  const artSysPoints = visibleSeries.artSys;
  const artMapPoints = visibleSeries.artMap;
  const artDiaPoints = visibleSeries.artDia;
  const cvpPoints = visibleSeries.cvp;
  const tempPoints = visibleSeries.temp;
  const nibpConnectors = buildVerticalConnectors(
    "nibp",
    markerSeries.nibpSys,
    markerSeries.nibpMap,
    markerSeries.nibpDia,
  );
  const artConnectors = buildVerticalConnectors(
    "art",
    markerSeries.artSys,
    markerSeries.artMap,
    markerSeries.artDia,
  );

  const hrSegments = splitByTimeGap(hrPoints, 2 * MINUTE_MS);
  const prSegments = splitByTimeGap(prPoints, 2 * MINUTE_MS);
  
  // Only calculate tooltips for visible area
  const tooltipsByColumn: Record<number, string> = {};
  for (let i = startIndex; i <= endIndex; i++) {
    const bucketStart = axis[i];
    const bucketEnd = axis[i + 1] ?? endExclusiveTs;
    const lines: string[] = [];
    const fmtTime = (ts: number) => formatConfiguredTime(ts, getStoredDateTimePreferences());
    lines.push(`Time ${fmtTime(bucketStart)}`);

    const pushLastInBucket = (label: string, points: XY[]) => {
      const inBucket = points.filter(
        p => p.ts >= bucketStart && p.ts < bucketEnd,
      );
      if (inBucket.length === 0) return;
      const last = inBucket[inBucket.length - 1];
      lines.push(`${label}: ${formatPointValue(last.value)}`);
    };

    pushLastInBucket("SpO2", spo2Points);
    pushLastInBucket("HR", hrPoints);
    pushLastInBucket("PR/PLS", prPoints);
    pushLastInBucket("NIBP SYS", nibpSysPoints);
    pushLastInBucket("NIBP MAP", nibpMapPoints);
    pushLastInBucket("NIBP DIA", nibpDiaPoints);
    pushLastInBucket("ART SYS", artSysPoints);
    pushLastInBucket("ART MAP", artMapPoints);
    pushLastInBucket("ART DIA", artDiaPoints);
    pushLastInBucket("CVP", cvpPoints);
    pushLastInBucket("Temp", tempPoints);

    tooltipsByColumn[i] = lines.join("\n");
  }

  const nowIndex = axis.findIndex((ts, i) => {
    const next = axis[i + 1] ?? Infinity;
    return ts <= nowTs && next > nowTs;
  });
  const nowX = nowIndex >= 0
    ? Math.max(0, Math.min(chartWidth, ((nowTs - startTs) / stepMs) * colWidth))
    : null;
  const hoverTooltipLines =
    hoverColumnIndex == null
      ? []
      : (tooltipsByColumn[hoverColumnIndex] || "")
          .split("\n")
          .filter(Boolean);
  const hoverTooltipLeft =
    hoverColumnIndex == null
      ? 0
      : hoverColumnIndex * colWidth + colWidth / 2;

  return (
    <div className="timechart-shell relative z-[101] flex border-b">
      <div
        style={{
          width: labelColWidth,
          minWidth: labelColWidth,
          height,
        }}
        className="timechart-sticky-label timegrid-cell-border sticky left-0 z-[100] shrink-0 border-r"
      >
        <div className="relative z-10 p-2 space-y-1">
          <div className="mb-1 flex items-center gap-2">
            <span className="text-[9px] font-extrabold uppercase tracking-[0.12em] text-[var(--app-muted)]">Chart</span>
            <button
              type="button"
              onClick={openConfig}
              className="app-tooltip inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-[var(--app-border)] bg-[var(--app-control-bg)] text-[var(--app-text)] hover:border-[var(--app-accent)] hover:bg-[var(--app-control-bg-hover)]"
              data-tooltip="Configure chart"
              aria-label="Configure chart parameters"
            >
              <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
                <path d="M4 7h10M18 7h2M4 17h2M10 17h10M14 4v6M6 14v6" strokeLinecap="round" />
              </svg>
            </button>
          </div>
          {chartGroups.filter(group => enabledGroups.has(group.key)).map(group => (
            <ClinicalReferenceTooltip key={group.key} text={group.tooltip || group.label} helpCursor className="timegrid-legend-option flex items-center gap-2 rounded">
              <SeriesGlyph marker={group.marker} color={seriesColor(group.key)} className="h-3 w-3" />
              <span className="truncate text-[11px] font-medium leading-none">{group.label}</span>
            </ClinicalReferenceTooltip>
          ))}
        </div>

        {/* Y-Axis Labels - Absolutely positioned to match SVG yFor logic */}
        <div className="timegrid-cell-border absolute inset-0 border-t mt-[-1px]">
          {Y_LABEL_TICKS.map(val => {
            const y = yFor(val);
            const selected = rulerValue === val;
            return (
              <button
                type="button"
                key={val}
                onClick={() => setRulerValue(current => current === val ? null : val)}
                aria-pressed={selected}
                aria-label={`${selected ? "Remove" : "Draw"} ruler at ${val}`}
                className={`absolute right-0 z-20 flex h-6 min-w-10 -translate-y-1/2 items-center justify-end rounded-l px-1.5 font-mono text-[9px] transition-colors ${selected ? "bg-[var(--app-accent)] font-black text-[var(--app-accent-contrast)]" : "text-[var(--chart-axis-text)] hover:bg-[var(--app-control-bg-hover)] hover:font-extrabold"}`}
                style={{
                  top: y,
                  textShadow: selected ? "none" : "0 1px 0 var(--chart-axis-text-shadow)",
                }}
              >
                {val}
              </button>
            );
          })}
        </div>
      </div>

      {configOpen && typeof document !== "undefined" ? createPortal(
        <div className="app-theme-scope case-modal-backdrop" onMouseDown={() => setConfigOpen(false)}>
          <section
            className="case-modal w-full max-w-sm"
            role="dialog"
            aria-modal="true"
            aria-labelledby="chart-quick-config-title"
            onMouseDown={event => event.stopPropagation()}
          >
            <header className="case-modal__header">
              <div className="case-modal__identity">
                <span className="case-modal__icon" aria-hidden="true">
                  <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M4 7h10M18 7h2M4 17h2M10 17h10M14 4v6M6 14v6" strokeLinecap="round" /></svg>
                </span>
                <div>
                  <div className="case-modal__eyebrow">Chart</div>
                  <h2 id="chart-quick-config-title" className="case-modal__title">Visible parameters</h2>
                </div>
              </div>
              <button type="button" className="case-modal__close" onClick={() => setConfigOpen(false)} aria-label="Close">×</button>
            </header>
            <div className="case-modal__body">
              <div className="grid grid-cols-2 gap-2">
                {chartGroups.map(group => {
                  const selected = draftVisibleGroups.includes(group.key);
                  return (
                    <button
                      key={group.key}
                      type="button"
                      aria-pressed={selected}
                      onClick={() => setDraftVisibleGroups(current => selected ? current.filter(key => key !== group.key) : [...current, group.key])}
                      className={`flex min-h-11 items-center gap-2 rounded-lg border px-3 py-2 text-left text-sm font-semibold transition-colors ${selected ? "border-[var(--app-accent)] bg-[var(--timegrid-focus-bg)] text-[var(--app-text)]" : "border-[var(--app-border)] bg-[var(--app-control-bg)] text-[var(--app-muted)] hover:bg-[var(--app-control-bg-hover)]"}`}
                    >
                      <SeriesGlyph marker={group.marker} color={draftSmartContrast && group.color ? smartContrastColor(group.color, chartBackground, true) : group.color || groupColor(group.key)} className="h-4 w-4" />
                      <span className="truncate">{group.label}</span>
                      <span className="ml-auto text-base leading-none" aria-hidden="true">{selected ? "✓" : ""}</span>
                    </button>
                  );
                })}
              </div>
              <label className="mt-3 flex cursor-pointer items-start gap-3 rounded-lg border border-[var(--app-border)] bg-[var(--app-control-bg)] px-3 py-3">
                <input
                  type="checkbox"
                  checked={draftSmartContrast}
                  onChange={event => setDraftSmartContrast(event.target.checked)}
                  className="mt-0.5 h-4 w-4 accent-[var(--app-accent)]"
                />
                <span className="min-w-0">
                  <span className="block text-sm font-semibold text-[var(--app-text)]">Smart invert color</span>
                  <span className="mt-0.5 block text-xs leading-5 text-[var(--app-muted)]">Automatically darken or lighten chart colors that blend into the current scheme.</span>
                </span>
              </label>
              <footer className="case-modal__actions">
                <button type="button" className="case-modal__button" onClick={() => setDraftVisibleGroups(chartGroups.filter(group => group.defaultVisible).map(group => group.key))}>Defaults</button>
                <button type="button" className="case-modal__button" onClick={() => setConfigOpen(false)}>Cancel</button>
                <button type="button" className="case-modal__button case-modal__button--primary" onClick={applyConfig}>Done</button>
              </footer>
            </div>
          </section>
        </div>,
        document.body,
      ) : null}

      <div
        className="relative shrink-0"
        style={{ width: chartWidth, minWidth: chartWidth }}
      >
        <svg
          width={chartWidth}
          height={height}
          className="block"
          onMouseLeave={() => setHoverColumnIndex(null)}
        >
          {/* Horizontal Grid Lines */}
          {Y_TICKS.map(val => (
            <line
              key={`grid-y-${val}`}
              x1={0}
              y1={yFor(val)}
              x2={chartWidth}
              y2={yFor(val)}
              stroke={val % 40 === 0 ? "var(--chart-grid-line-strong)" : GRID_STROKE}
              strokeWidth={val % 40 === 0 ? 0.85 : 0.65}
            />
          ))}

          {rulerValue != null ? (
            <line
              x1={0}
              y1={yFor(rulerValue)}
              x2={chartWidth}
              y2={yFor(rulerValue)}
              stroke="var(--app-accent)"
              strokeWidth={2}
              opacity={0.95}
              pointerEvents="none"
            />
          ) : null}

          {/* Virtualized Vertical Grid Lines */}
          {axis.slice(startIndex, endIndex + 1).map((ts, i) => {
            const actualIndex = startIndex + i;
            return (
              <line
                key={ts}
                x1={actualIndex * colWidth}
                y1={0}
                x2={actualIndex * colWidth}
                y2={height}
                stroke={GRID_STROKE}
                strokeWidth={1}
              />
            );
          })}

          <line
            x1={chartWidth}
            y1={0}
            x2={chartWidth}
            y2={height}
            stroke="var(--chart-grid-line-strong)"
            strokeWidth={1}
          />

          {nowIndex >= 0 && nowIndex >= startIndex && nowIndex <= endIndex && (
            <rect
              x={nowIndex * colWidth}
              y={0}
              width={colWidth}
              height={height}
              fill="var(--chart-now-col)"
            />
          )}

          {isVisible("spo2") && spo2Points.length > 1 && (
            <path
              d={buildPath(spo2Points)}
              fill="none"
              stroke={spo2Color}
              strokeWidth={VITAL_LINE_STROKE}
            />
          )}

          {isVisible("spo2") &&
            markerSeries.spo2.map((p, i) => (
              <PointMarker
                key={`spo2-dot-${i}-${p.ts}`}
                x={p.x}
                y={p.y}
                color={spo2Color}
                marker={seriesMarker("spo2")}
              />
            ))}

          {isVisible("hr") && (
            <g style={{ color: hrColor }}>
              {hrSegments.map(segment =>
                segment.length > 1 ? (
                  <path
                    key={`hr-seg-${segment[0].ts}`}
                    d={buildPath(segment)}
                    fill="none"
                    stroke="currentColor"
                    strokeWidth={VITAL_LINE_STROKE}
                  />
                ) : null,
              )}
              {markerSeries.hr.map(p => (
                <PointMarker key={`hr-dot-${p.ts}`} x={p.x} y={p.y} color={hrColor} marker={seriesMarker("hr")} />
              ))}
            </g>
          )}

          {isVisible("pr") && (
            <>
              {prSegments.map(segment =>
                segment.length > 1 ? (
                  <path
                    key={`pr-seg-${segment[0].ts}`}
                    d={buildPath(segment)}
                    fill="none"
                    stroke={prColor}
                    strokeWidth={VITAL_LINE_STROKE}
                  />
                ) : null,
              )}
              {markerSeries.pr.map(p => (
                <PointMarker
                  key={`pr-dot-${p.ts}`}
                  x={p.x}
                  y={p.y}
                  color={prColor}
                  marker={seriesMarker("pr")}
                />
              ))}
            </>
          )}

          {isVisible("nibp") &&
            nibpConnectors.map(line => (
              <line
                key={line.key}
                x1={line.x}
                y1={line.yMin}
                x2={line.x}
                y2={line.yMax}
                stroke={nibpColor}
                strokeWidth={CONNECTOR_LINE_STROKE}
                opacity={0.8}
              />
            ))}

          {isVisible("nibp") &&
            markerSeries.nibpSys.map(p => (
              seriesMarker("nibp") === "range"
                ? <TriangleDown key={`nibp-sys-${p.ts}`} x={p.x} y={p.y} color={nibpColor} />
                : <PointMarker key={`nibp-sys-${p.ts}`} x={p.x} y={p.y} color={nibpColor} marker={seriesMarker("nibp")} />
            ))}
          {isVisible("nibp") &&
            markerSeries.nibpMap.map(p => (
              <PointMarker
                key={`nibp-map-${p.ts}`}
                x={p.x}
                y={p.y}
                color={nibpColor}
                marker={seriesMarker("nibp") === "range" ? "circle" : seriesMarker("nibp")}
              />
            ))}
          {isVisible("nibp") &&
            markerSeries.nibpDia.map(p => (
              seriesMarker("nibp") === "range"
                ? <TriangleUp key={`nibp-dia-${p.ts}`} x={p.x} y={p.y} color={nibpColor} />
                : <PointMarker key={`nibp-dia-${p.ts}`} x={p.x} y={p.y} color={nibpColor} marker={seriesMarker("nibp")} />
            ))}

          {isVisible("art") &&
            artConnectors.map(line => (
              <line
                key={line.key}
                x1={line.x}
                y1={line.yMin}
                x2={line.x}
                y2={line.yMax}
                stroke={artColor}
                strokeWidth={CONNECTOR_LINE_STROKE}
                opacity={0.8}
              />
            ))}

          {isVisible("art") &&
            markerSeries.artSys.map(p => (
              seriesMarker("art") === "range"
                ? <TriangleDown key={`art-sys-${p.ts}`} x={p.x} y={p.y} color={artColor} />
                : <PointMarker key={`art-sys-${p.ts}`} x={p.x} y={p.y} color={artColor} marker={seriesMarker("art")} />
            ))}
          {isVisible("art") &&
            markerSeries.artMap.map(p => (
              <PointMarker
                key={`art-map-${p.ts}`}
                x={p.x}
                y={p.y}
                color={artColor}
                marker={seriesMarker("art") === "range" ? "circle" : seriesMarker("art")}
              />
            ))}
          {isVisible("art") &&
            markerSeries.artDia.map(p => (
              seriesMarker("art") === "range"
                ? <TriangleUp key={`art-dia-${p.ts}`} x={p.x} y={p.y} color={artColor} />
                : <PointMarker key={`art-dia-${p.ts}`} x={p.x} y={p.y} color={artColor} marker={seriesMarker("art")} />
            ))}

          {isVisible("cvp") &&
            markerSeries.cvp.map(p => (
              <PointMarker
                key={`cvp-${p.ts}`}
                x={p.x}
                y={p.y}
                color={cvpColor}
                marker={seriesMarker("cvp")}
              />
            ))}

          {isVisible("temp") && tempPoints.length > 1 ? (
            <path
              d={buildPath(tempPoints)}
              fill="none"
              stroke={tempColor}
              strokeWidth={VITAL_LINE_STROKE}
            />
          ) : null}
          {isVisible("temp") &&
            markerSeries.temp.map(p => (
              <PointMarker
                key={`temp-${p.ts}`}
                x={p.x}
                y={p.y}
                color={tempColor}
                marker={seriesMarker("temp")}
              />
            ))}

          {nowX !== null && nowIndex >= startIndex && nowIndex <= endIndex ? (
            <line
              x1={nowX}
              y1={0}
              x2={nowX}
              y2={height}
              stroke="var(--timegrid-now-line)"
              strokeWidth={2}
              pointerEvents="none"
            />
          ) : null}

          {/* Virtualized Tooltip Rects */}
          {axis.slice(startIndex, endIndex + 1).map((ts, i) => {
            const actualIndex = startIndex + i;
            return (
              <rect
                key={`tip-${ts}`}
                x={actualIndex * colWidth}
                y={0}
                width={colWidth}
                height={height}
                fill="transparent"
                onMouseEnter={() => setHoverColumnIndex(actualIndex)}
                onMouseMove={() => setHoverColumnIndex(actualIndex)}
              />
            );
          })}
        </svg>
        {hoverColumnIndex != null && hoverTooltipLines.length > 0 ? (
          <div
            className="chart-tooltip pointer-events-none absolute z-[110] -translate-x-1/2"
            style={{ left: hoverTooltipLeft, top: 4 }}
          >
            {hoverTooltipLines.map((line, index) => (
              <div key={`${hoverColumnIndex}-${index}`} className={index === 0 ? "chart-tooltip__time" : "chart-tooltip__reading"}>{line}</div>
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}
