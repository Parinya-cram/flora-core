import { ECG_CLEAR_VALUE, ECG_OPTIONS, ecgValueToCode } from "./ecgOptions";
import { COL_WIDTH, LABEL_COL_WIDTH } from "./layout";
import type { ClinicalTimelineRow, ClinicalTimelineValues } from "./types";
import type { TimelineCellProvenance, TimelineProvenance } from "../../api/vitalMinutesApi";
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type MouseEvent as ReactMouseEvent } from "react";
import { createPortal } from "react-dom";
import { useVirtualColumns } from "../../hooks/useVirtualColumns";
import { useWorkstationSettings } from "../../hooks/useWorkstationSettings";
import { formatConfiguredDateTime, formatConfiguredTime, type DateTimePreferences } from "../../utils/dateTime";
import {
  NoteIcon,
} from "../../assets/icons";
import { getEventIconByTitle } from "../../views/clinical-chart/constants";
import ClinicalReferenceTooltip from "../common/ClinicalReferenceTooltip";
import { useTheme } from "../../context/ThemeContext";
import {
  DEFAULT_DRIP_GROUP_COLORS,
  type DripGroupColors,
  type DripGroupTone,
} from "../../utils/chartPreferences";
import { mixRgb, parseHexColor, smartContrastColor, type Rgb } from "../../utils/smartContrast";

export type ClinicalTimelineEventMarker = {
  id: number;
  event_ts: number;
  event_type: "event" | "note";
  title: string;
};

export type ClinicalTimelineIoMarker = {
  run_id: number;
  item_id: number;
  kind: "fluid" | "med" | "output";
  item_name: string;
  item_category?: string;
  item_code?: string;
  item_unit?: string;
  note?: string | null;
  marker_code?: "i" | "o" | "d";
  marker_label?: string;
};

interface Props {
  columns: number[];
  ivyRows: ClinicalTimelineRow[];
  rowsAfterEvent?: ClinicalTimelineRow[];
  values: ClinicalTimelineValues;
  cellProvenance?: TimelineProvenance;
  ioDripRateByRowTs?: Record<string, Record<number, number>>;
  eventMarkersByTs?: Record<number, ClinicalTimelineEventMarker[]>;
  preparedMarkersByTs?: Record<number, ClinicalTimelineIoMarker[]>;
  includeSystemRows?: boolean;
  displaySection?: "all" | "events-io" | "vitals";
  nowTs: number;
  scrollLeft?: number;
  viewportWidth?: number;
  onChange?: (rowId: string, ts: number, value: unknown) => void;
  onPreparedMarkerClick?: (ts: number, marker: ClinicalTimelineIoMarker) => void;
  onIoCellClick?: (rowId: string, ts: number) => void;
  onIoHeaderClick?: () => void;
  onIoHeaderColumnClick?: (ts: number) => void;
  onEventCellClick?: (ts: number) => void;
  onEventMarkerClick?: (marker: ClinicalTimelineEventMarker) => void;
  sectionCollapseState?: {
    ioCollapsed: boolean;
    vitalCollapsed: boolean;
  };
  onSectionCollapseToggle?: (section: "io" | "vital") => void;
  colWidth?: number;
  labelColWidth?: number;
  dripGroupColors?: DripGroupColors;
  smartContrast?: boolean;
  /** Render values without edit controls or entry affordances. */
  readOnly?: boolean;
  /** Device readings marked invalid (shown grey, left out of graphs and reports). */
  maskedValues?: ClinicalTimelineValues;
  /** Mark device readings in [fromTs, toTs] (minutes, inclusive) of one row invalid. */
  onMaskRange?: (rowId: string, fromTs: number, toTs: number) => void;
  /** Make masked readings in [fromTs, toTs] of one row count again. */
  onUnmaskRange?: (rowId: string, fromTs: number, toTs: number) => void;
}

/** The selected vital cell and, after a second ⊘ press, the start of a range. */
type MaskSelection = { rowId: string; rowLabel: string; columnIndex: number; element: HTMLElement; armed: boolean };

function InvalidIcon({ className = "h-3.5 w-3.5" }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" className={className} aria-hidden="true">
      <circle cx="12" cy="12" r="9" /><path d="M5.6 5.6l12.8 12.8" />
    </svg>
  );
}

const SYSTEM_ROWS: ClinicalTimelineRow[] = [
  { id: "event", label: "Event", type: "event" },
  { id: "ecg", label: "ECG", type: "ecg" },
];

const CORE_ROW_IDS = new Set([
  "hr",
  "pr",
  "spo2",
  // rr removed so it shows [M] badge
  "nibp_sys",
  "nibp_map",
  "nibp_dia",
  "art_sys",
  "art_map",
  "art_dia",
  "art_pr",
  "cvp",
  "temperature",
  "etco2",
]);

const MINUTE_MS = 60_000;

type DisplayCell = {
  value: unknown;
  isFallback: boolean;
  sourceTs: number | null;
};

type IoDripPart = "start" | "mid" | "end" | "single";

type IoDisplayCellValue = {
  kind: "io_cell";
  amount?: number;
  dripPart?: IoDripPart;
  dripGroupTone?: string;
  dripRateMlPerHr?: number;
  dripCarrierMlPerHr?: number;
  dripBucketVolumeMl?: number;
  dripCumulativeVolumeMl?: number;
  segmentDoseValue?: number | null;
  segmentDoseUnit?: string | null;
  segmentRateUnit?: string | null;
  minuteValues?: Array<{ ts: number; amount: number }>;
};

function EditableCellInput({ value, numeric, fallback, editedDeviceValue, masked, ariaLabel, onCommit, onFocusCell, onBlurCell }: {
  value: string;
  numeric: boolean;
  fallback: boolean;
  editedDeviceValue?: boolean;
  masked?: boolean;
  ariaLabel: string;
  onCommit: (value: unknown) => void;
  onFocusCell?: (element: HTMLInputElement) => void;
  onBlurCell?: () => void;
}) {
  const [draft, setDraft] = useState(value);
  const [focused, setFocused] = useState(false);

  const commit = () => {
    const trimmed = draft.trim();
    if (!trimmed) return onCommit(undefined);
    if (!numeric) return onCommit(trimmed);
    const parsed = Number(trimmed);
    if (!Number.isFinite(parsed)) return setDraft(value);
    onCommit(parsed);
  };

  return (
    <input
      type="text"
      inputMode={numeric ? "decimal" : "text"}
      aria-label={ariaLabel}
      className={`timegrid-edit-input h-full w-full bg-transparent text-center text-[10px] leading-none font-inherit focus:outline-none relative z-10 ${masked ? "timegrid-masked-value text-gray-400 dark:text-gray-500" : fallback ? "text-amber-600 dark:text-amber-400 font-medium" : "text-[var(--app-text)]"} ${editedDeviceValue ? "underline decoration-dotted decoration-2 underline-offset-2" : ""}`}
      value={focused ? draft : value}
      placeholder="—"
      onFocus={event => { setDraft(value); setFocused(true); event.currentTarget.select(); onFocusCell?.(event.currentTarget); }}
      onChange={event => setDraft(event.target.value)}
      onBlur={() => { if (draft !== value) commit(); setFocused(false); onBlurCell?.(); }}
      onKeyDown={event => {
        if (event.key === "Enter") event.currentTarget.blur();
        if (event.key === "Escape") { setDraft(value); event.currentTarget.blur(); }
      }}
    />
  );
}

function EcgPicker({ value, displayCode, onChange }: {
  value: string;
  displayCode: string;
  onChange: (value: string) => void;
}) {
  const isExplicitlyCleared = value === ECG_CLEAR_VALUE;
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const [position, setPosition] = useState<CSSProperties>({});
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const filtered = ECG_OPTIONS.filter(option => `${option.code} ${option.value}`.toLowerCase().includes(query.trim().toLowerCase()));

  const close = () => {
    setOpen(false);
    setQuery("");
    setActiveIndex(0);
  };

  const openPicker = () => {
    const rect = buttonRef.current?.getBoundingClientRect();
    if (rect) {
      const width = Math.min(380, window.innerWidth - 16);
      const left = Math.max(8, Math.min(window.innerWidth - width - 8, rect.left + rect.width / 2 - width / 2));
      const openAbove = window.innerHeight - rect.bottom < 420 && rect.top > window.innerHeight - rect.bottom;
      setPosition(openAbove
        ? { left, width, bottom: window.innerHeight - rect.top + 6 }
        : { left, width, top: rect.bottom + 6 });
    }
    setOpen(true);
    setActiveIndex(Math.max(0, ECG_OPTIONS.findIndex(option => option.value === value)));
  };

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!buttonRef.current?.contains(target) && !menuRef.current?.contains(target)) close();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    const onViewportChange = (event: Event) => {
      const target = event.target;
      if (target instanceof Node && menuRef.current?.contains(target)) return;
      close();
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    window.addEventListener("resize", onViewportChange);
    window.addEventListener("scroll", onViewportChange, true);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("resize", onViewportChange);
      window.removeEventListener("scroll", onViewportChange, true);
    };
  }, [open]);

  const choose = (nextValue: string) => {
    onChange(nextValue);
    close();
    requestAnimationFrame(() => buttonRef.current?.focus());
  };

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        onClick={() => open ? close() : openPicker()}
        className={`flex h-full w-full items-center justify-center gap-1 bg-transparent px-1 text-[10px] font-semibold outline-none transition-colors hover:bg-[var(--app-control-bg-hover)] focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--app-accent)] ${displayCode ? "text-[var(--app-text)]" : "text-[var(--app-muted)]"}`}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={`ECG rhythm: ${displayCode || "not recorded"}`}
      >
        <span>{displayCode || "–"}</span>
        <svg viewBox="0 0 12 12" className={`h-2.5 w-2.5 transition-transform ${open ? "rotate-180" : ""}`} fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><path d="m2 4 4 4 4-4" strokeLinecap="round" strokeLinejoin="round" /></svg>
      </button>
      {open && typeof document !== "undefined" ? createPortal(
        <div
          ref={menuRef}
          className="app-theme-scope fixed z-[1000] overflow-hidden rounded-xl border border-[var(--app-tooltip-border)] bg-[var(--app-panel-bg)] text-[var(--app-text)] shadow-2xl"
          style={position}
          role="dialog"
          aria-label="Choose ECG rhythm"
        >
          <div className="border-b border-[var(--app-border)] p-2">
            <div className="text-[9px] font-extrabold uppercase tracking-[0.12em] text-[var(--app-muted)]">ECG rhythm</div>
            <input
              autoFocus
              value={query}
              onChange={event => { setQuery(event.target.value); setActiveIndex(0); }}
              onKeyDown={event => {
                if (event.key === "ArrowDown") { event.preventDefault(); setActiveIndex(index => Math.min(filtered.length - 1, index + 1)); }
                if (event.key === "ArrowUp") { event.preventDefault(); setActiveIndex(index => Math.max(0, index - 1)); }
                if (event.key === "Enter" && filtered[activeIndex]) { event.preventDefault(); choose(filtered[activeIndex].value); }
              }}
              placeholder="Search code or rhythm…"
              className="mt-1.5 h-9 w-full rounded-lg border border-[var(--app-border)] bg-[var(--app-control-bg)] px-3 text-xs outline-none focus:border-[var(--app-accent)]"
            />
          </div>
          <div className="max-h-80 overflow-y-auto overscroll-contain p-1.5" role="listbox">
            <button
              type="button"
              onClick={() => choose(ECG_CLEAR_VALUE)}
              className={`flex w-full items-center gap-3 rounded-lg px-2.5 py-2 text-left text-xs ${isExplicitlyCleared ? "bg-[var(--timegrid-focus-bg)] text-[var(--app-text)]" : "text-[var(--app-muted)] hover:bg-[var(--app-control-bg-hover)]"}`}
            >
              <span className="w-10 text-center font-mono font-bold">–</span>
              <span>Clear recorded rhythm</span>
              {isExplicitlyCleared ? <span className="ml-auto text-[var(--app-accent)]">✓</span> : null}
            </button>
            {filtered.map((option, index) => {
              const selected = value === option.value;
              return (
                <button
                  key={option.value}
                  type="button"
                  role="option"
                  aria-selected={selected}
                  onMouseEnter={() => setActiveIndex(index)}
                  onClick={() => choose(option.value)}
                  className={`flex w-full items-center gap-3 rounded-lg px-2.5 py-2 text-left text-xs transition-colors ${index === activeIndex ? "bg-[var(--timegrid-focus-bg)]" : "hover:bg-[var(--app-control-bg-hover)]"}`}
                >
                  <span className={`w-10 rounded-md px-1.5 py-1 text-center font-mono font-black ${selected ? "bg-[var(--app-accent)] text-[var(--app-accent-contrast)]" : "bg-[var(--app-control-bg)] text-[var(--app-accent)]"}`}>{option.code}</span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium">{option.value}</span>
                    <svg viewBox="0 0 120 32" preserveAspectRatio="none" className="mt-1 h-7 w-full" aria-hidden="true">
                      <path d="M0 18H120" fill="none" stroke="var(--app-border)" strokeWidth="0.8" />
                      <path d={option.waveform} fill="none" stroke="var(--app-accent)" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
                    </svg>
                  </span>
                  {selected ? <span className="text-[var(--app-accent)]">✓</span> : null}
                </button>
              );
            })}
            {filtered.length === 0 ? <div className="px-3 py-5 text-center text-xs text-[var(--app-muted)]">No matching rhythm</div> : null}
          </div>
        </div>,
        document.body,
      ) : null}
    </>
  );
}

function clinicalCellTooltip(value: string, fallbackHint: string, preferences: DateTimePreferences, detail?: TimelineCellProvenance) {
  if (!detail || detail.source !== "override") return fallbackHint ? `${value} (${fallbackHint})` : value;
  const original = detail.original_value == null || detail.original_value === "" ? "No device reading" : String(detail.original_value);
  const source = String(detail.original_source || "medical device").replace(/^./, character => character.toUpperCase());
  const actor = detail.actor_name || detail.updated_by || detail.actor_username || "Unknown user";
  const editedAt = Number(detail.edited_at || detail.updated_at);
  const lines = [
    `Edited value: ${value || "—"}`,
    `Original ${source}: ${original}`,
    `Edited by: ${actor}`,
  ];
  if (Number.isFinite(editedAt)) lines.push(`Edited: ${formatConfiguredDateTime(editedAt, preferences)}`);
  if (detail.reason) lines.push(`Reason: ${detail.reason}`);
  if (detail.note) lines.push(`Note: ${detail.note}`);
  if ((detail.audit_count || 0) > 0) lines.push(`Audit entries: ${detail.audit_count}`);
  if (fallbackHint) lines.push(fallbackHint);
  return lines.join("\n");
}

function dripToneStyle(
  tone: string | undefined,
  colors: DripGroupColors,
  background: Rgb,
  smartContrast: boolean,
): CSSProperties {
  const configured = colors[tone as DripGroupTone] || colors.other;
  const visibleColor = smartContrastColor(configured, background, smartContrast);
  return {
    "--io-drip-fill": visibleColor,
    "--io-drip-glow": `${visibleColor}59`,
  } as CSSProperties;
}

const isIoDisplayCellValue = (value: unknown): value is IoDisplayCellValue =>
  Boolean(
    value &&
      typeof value === "object" &&
      "kind" in (value as Record<string, unknown>) &&
      (value as { kind?: unknown }).kind === "io_cell",
  );

export default function ClinicalTimelineGrid({
  columns,
  ivyRows,
  rowsAfterEvent = [],
  values,
  cellProvenance,
  ioDripRateByRowTs = {},
  eventMarkersByTs = {},
  preparedMarkersByTs = {},
  includeSystemRows = true,
  displaySection = "all",
  nowTs,
  scrollLeft = 0,
  viewportWidth = 0,
  onChange,
  onPreparedMarkerClick,
  onIoCellClick,
  onIoHeaderClick,
  onIoHeaderColumnClick,
  onEventCellClick,
  onEventMarkerClick,
  sectionCollapseState,
  onSectionCollapseToggle,
  colWidth = COL_WIDTH,
  labelColWidth = LABEL_COL_WIDTH,
  dripGroupColors = DEFAULT_DRIP_GROUP_COLORS,
  smartContrast = true,
  readOnly = false,
  maskedValues,
  onMaskRange,
  onUnmaskRange,
}: Props) {
  const workstation = useWorkstationSettings();
  const { color: themeCode, schemes } = useTheme();
  const activeTheme = schemes.find(theme => theme.code === themeCode);
  const themeCanvas = parseHexColor(activeTheme?.colors[0] || "#121212") || { r: 18, g: 18, b: 18 };
  const themeSurface = parseHexColor(activeTheme?.colors[1] || "#1C1C1C") || themeCanvas;
  const timelineBackground = mixRgb(themeCanvas, themeSurface, 0.2);
  const [activeRowId, setActiveRowId] = useState<string | null>(null);
  const [maskSelection, setMaskSelection] = useState<MaskSelection | null>(null);
  const [, setToolbarTick] = useState(0);
  const maskSelectionRef = useRef<MaskSelection | null>(null);
  useLayoutEffect(() => { maskSelectionRef.current = maskSelection; });
  const masking = Boolean(onMaskRange) && !readOnly;

  useEffect(() => {
    if (!maskSelection) return;
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") setMaskSelection(null); };
    const reposition = () => setToolbarTick(tick => tick + 1);
    window.addEventListener("keydown", onKey);
    window.addEventListener("scroll", reposition, true);
    window.addEventListener("resize", reposition);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", reposition, true);
      window.removeEventListener("resize", reposition);
    };
  }, [maskSelection]);
  const [eventStack, setEventStack] = useState<{
    ts: number;
    markers: ClinicalTimelineEventMarker[];
    position: CSSProperties;
  } | null>(null);

  const openEventStack = (
    event: ReactMouseEvent<HTMLButtonElement>,
    ts: number,
    markers: ClinicalTimelineEventMarker[],
  ) => {
    event.stopPropagation();
    const rect = event.currentTarget.getBoundingClientRect();
    const width = Math.min(320, window.innerWidth - 16);
    const left = Math.max(8, Math.min(window.innerWidth - width - 8, rect.left + rect.width / 2 - width / 2));
    const roomBelow = window.innerHeight - rect.bottom;
    setEventStack({
      ts,
      markers,
      position: roomBelow >= 280
        ? { position: "fixed", left, top: rect.bottom + 8, width, maxHeight: Math.min(360, roomBelow - 16) }
        : { position: "fixed", left, bottom: window.innerHeight - rect.top + 8, width, maxHeight: Math.min(360, rect.top - 16) },
    });
  };

  useEffect(() => {
    if (!eventStack) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setEventStack(null);
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [eventStack]);

  const { startIndex, endIndex } = useVirtualColumns(
    scrollLeft,
    viewportWidth,
    colWidth,
    columns.length
  );

  if (columns.length === 0) return null;

  const baseRows = !includeSystemRows
    ? ivyRows
    : displaySection === "events-io"
      ? [SYSTEM_ROWS[0], ...rowsAfterEvent.filter(row => row.id !== "__vital_agent_header__")]
      : displaySection === "vitals"
        ? [rowsAfterEvent.find(row => row.id === "__vital_agent_header__"), SYSTEM_ROWS[1], ...ivyRows].filter((row): row is ClinicalTimelineRow => Boolean(row))
        : [SYSTEM_ROWS[0], ...rowsAfterEvent, SYSTEM_ROWS[1], ...ivyRows];
  const rows = baseRows.filter(row => {
    if (sectionCollapseState?.ioCollapsed && row.type === "io" && row.id.startsWith("io_run_")) {
      return false;
    }
    if (sectionCollapseState?.vitalCollapsed && (row.id === "ecg" || row.type === "vital")) {
      return false;
    }
    return true;
  });
  const tableWidth = labelColWidth + columns.length * colWidth;
  const stepMs =
    columns.length > 1 ? Math.max(1, columns[1] - columns[0]) : MINUTE_MS;
  const rowEntriesById = new Map<string, Array<{ ts: number; value: unknown }>>();

  for (const [rowId, rowValues] of Object.entries(values)) {
    const entries = Object.entries(rowValues)
      .map(([tsKey, value]) => ({
        ts: Number(tsKey),
        value,
      }))
      .filter(item => Number.isFinite(item.ts))
      .sort((a, b) => a.ts - b.ts);
    rowEntriesById.set(rowId, entries);
  }

  const getECGCodeAt = (ts: number) => {
    let last: string | undefined;
    for (const t of columns) {
      if (t > ts) break;
      const v = values.ecg?.[t];
      if (typeof v === "string" && v) last = v;
    }
    return ecgValueToCode(last);
  };

  const formatHHMM = (ts: number) => formatConfiguredTime(ts, workstation);

  const formatAmount = (value: number) => {
    if (!Number.isFinite(value)) return "";
    if (Math.abs(value - Math.round(value)) < 0.0001) return String(Math.round(value));
    return value.toFixed(2).replace(/\.?0+$/, "");
  };

  const getDisplayCell = (
    rowId: string,
    ts: number,
    columnIndex: number,
  ): DisplayCell => {
    const rowValues = values[rowId];
    if (rowValues && Object.prototype.hasOwnProperty.call(rowValues, ts)) {
      return {
        value: rowValues[ts],
        isFallback: false,
        sourceTs: ts,
      };
    }

    if (stepMs <= MINUTE_MS) {
      return { value: undefined, isFallback: false, sourceTs: null };
    }

    const entries = rowEntriesById.get(rowId);
    if (!entries || entries.length === 0) {
      return { value: undefined, isFallback: false, sourceTs: null };
    }

    const windowStart =
      columnIndex > 0 ? columns[columnIndex - 1] : ts - stepMs;
    for (let i = entries.length - 1; i >= 0; i -= 1) {
      const item = entries[i];
      if (item.ts >= ts) continue;
      if (item.ts <= windowStart) break;
      return {
        value: item.value,
        isFallback: true,
        sourceTs: item.ts,
      };
    }

    return { value: undefined, isFallback: false, sourceTs: null };
  };

  // A column summarises the minutes in (previous column, column]; a mask covers all of them.
  const columnWindow = (columnIndex: number): [number, number] => {
    const ts = columns[columnIndex];
    const previous = columnIndex > 0 ? columns[columnIndex - 1] : ts - stepMs;
    return [Math.min(ts, previous + MINUTE_MS), ts];
  };

  const maskedInWindow = (rowId: string, columnIndex: number): { value: unknown; sourceTs: number } | null => {
    const rowMasked = maskedValues?.[rowId];
    if (!rowMasked) return null;
    const [from, to] = columnWindow(columnIndex);
    let best: { value: unknown; sourceTs: number } | null = null;
    for (const [key, value] of Object.entries(rowMasked)) {
      const minute = Number(key);
      if (minute >= from && minute <= to && (!best || minute > best.sourceTs)) best = { value, sourceTs: minute };
    }
    return best;
  };

  const maskRange = (selection: MaskSelection, otherIndex = selection.columnIndex) => {
    const [from] = columnWindow(Math.min(selection.columnIndex, otherIndex));
    const [, to] = columnWindow(Math.max(selection.columnIndex, otherIndex));
    onMaskRange?.(selection.rowId, from, to);
  };

  const focusVitalCell = (row: ClinicalTimelineRow, columnIndex: number, element: HTMLElement) => {
    const current = maskSelectionRef.current;
    if (current?.armed && current.rowId === row.id && current.columnIndex !== columnIndex) {
      // Second value in the same channel: mask everything between the two.
      maskRange(current, columnIndex);
      setMaskSelection({ rowId: row.id, rowLabel: row.label, columnIndex, element, armed: false });
      return;
    }
    setMaskSelection({ rowId: row.id, rowLabel: row.label, columnIndex, element, armed: false });
  };

  const blurVitalCell = () => {
    // Keep an armed range alive while the clinician picks the second value.
    window.setTimeout(() => {
      const current = maskSelectionRef.current;
      if (!current || current.armed) return;
      if (document.activeElement && current.element.contains(document.activeElement)) return;
      setMaskSelection(null);
    }, 0);
  };


  const normalizeEventTitle = (title: string) =>
    title.toLowerCase().replace(/\s+/g, " ").trim();

  const markerForEvent = (marker: ClinicalTimelineEventMarker) => {
    if (marker.event_type === "note") {
      return {
        label: "Note",
        iconSrc: NoteIcon,
        className: "badge-note",
      };
    }

    const title = normalizeEventTitle(marker.title);
    const eventIcon = getEventIconByTitle(marker.title);
    if (eventIcon) {
      const ending = title.startsWith("end ") || title === "patient out" || title === "extubation" || title === "reversal";
      const starting = title.startsWith("start ") || title === "patient in";
      return {
        label: marker.title,
        iconSrc: eventIcon,
        className: title === "time out" ? "badge-timeout" : ending ? "badge-end" : starting ? "badge-start" : "badge-mid",
      };
    }

    return {
      label: "E",
      className: "badge-event",
    };
  };
  const markerForPrepared = (marker: ClinicalTimelineIoMarker) => {
    const category = String(marker.item_category || "").toLowerCase();
    if (marker.kind === "med") return marker.marker_code === "d" ? "#9B6DFF" : "#5B8FF9";
    if (marker.kind === "fluid") return category === "bloodproduct" ? "#E05252" : "#39C6C8";
    if (category === "bloodlossoutput") return "#8B2635";
    return category === "urineoutput" ? "#D99A24" : "var(--badge-output-text)";
  };

  const markerForRowType = (row: ClinicalTimelineRow) => {
    if (row.type !== "vital") return null;
    if (row.id.startsWith("set_")) {
      return {
        label: "S",
        className: "badge-setting",
      };
    }
    if (CORE_ROW_IDS.has(row.id)) return null;
    return {
      label: "M",
      className: "badge-measure",
    };
  };

  const isNumericLike = (value: unknown) => {
    if (typeof value === "number") return Number.isFinite(value);
    if (typeof value !== "string") return false;
    const trimmed = value.trim();
    if (!trimmed) return false;
    const n = Number(trimmed);
    return Number.isFinite(n);
  };

  const visibleColumns = columns.slice(startIndex, endIndex + 1);

  return (
    <>
    <table
      className="timegrid-compact border-collapse table-fixed text-[11px] leading-none"
      style={{ width: tableWidth, minWidth: tableWidth }}
    >
      <tbody>
        {rows.map((row, rowIndex) => {
          const rowTypeMarker = markerForRowType(row);
          const fullLabel = row.referenceTooltip || [
            row.unit ? `${row.label} (${row.unit})` : row.label,
            row.ioStatus ? `status: ${row.ioStatus}` : "",
            row.ioDetail || "",
            row.ioTotal
              ? `${row.ioKind === "output" ? "Total recorded" : row.ioKind === "fluid" ? "Total input" : "Total given"}: ${row.ioTotal}`
              : "",
          ].filter(Boolean).join("\n");
          const isEventRowLabel = row.id === "event";
          const isIoHeaderRowLabel = row.id === "__io_header__";
          const isVitalAgentHeaderRowLabel = row.id === "__vital_agent_header__";
          const isIoDataRow = row.type === "io" && row.id.startsWith("io_run_");
          const isBloodProductIoRow =
            isIoDataRow &&
            row.displayMode === "bolus" &&
            row.ioKind === "fluid" &&
            row.ioCategory?.toLowerCase() === "bloodproduct";
          const ioRowAccent = !isIoDataRow
            ? undefined
            : row.ioKind === "med"
              ? row.displayMode === "drip" ? "#9B6DFF" : "#5B8FF9"
              : row.ioKind === "fluid"
                ? row.ioCategory?.toLowerCase() === "bloodproduct" ? "#E05252" : "#39C6C8"
                : row.ioCategory?.toLowerCase() === "bloodlossoutput"
                  ? "#8B2635"
                  : row.ioCategory?.toLowerCase() === "urineoutput" ? "#D99A24" : "var(--badge-output-text)";
          const isExpandedIoRow =
            isIoDataRow && (row.displayMode === "drip" || isBloodProductIoRow);
          const isIoSectionHeaderRow = row.id === "__io_header__";
          const isVitalSectionHeaderRow = row.id === "__vital_agent_header__";
          const isSectionHeaderRow = isIoSectionHeaderRow || isVitalSectionHeaderRow;
          const sectionCollapsed = isIoSectionHeaderRow
            ? Boolean(sectionCollapseState?.ioCollapsed)
            : isVitalSectionHeaderRow
              ? Boolean(sectionCollapseState?.vitalCollapsed)
              : false;
          const isSpecialRow =
            isEventRowLabel || isIoHeaderRowLabel || isVitalAgentHeaderRowLabel;
          const isRowActive = activeRowId === row.id;
          const rowToneClass =
            rowIndex % 2 === 0 ? "timegrid-row-even" : "timegrid-row-odd";
          const rowCellToneClass = isSpecialRow
            ? isEventRowLabel
              ? "timegrid-row-event-header"
              : isIoHeaderRowLabel
                ? "timegrid-row-io-header"
                : "timegrid-row-vital-header"
            : rowToneClass === "timegrid-row-even"
              ? "timegrid-cell-even"
              : "timegrid-cell-odd";
          const baseLabelClass =
            isRowActive
              ? "font-semibold text-[var(--app-accent)]"
              : "";
          const specialLabelClass = isEventRowLabel
            ? "badge-event font-semibold"
            : isIoHeaderRowLabel
              ? "badge-start font-semibold"
              : isVitalAgentHeaderRowLabel
                ? "badge-measure font-semibold"
              : "";
          const labelClass = `${specialLabelClass || baseLabelClass}`;

          const labelToneClass = `${rowToneClass === "timegrid-row-even" ? "timegrid-label-even" : "timegrid-label-odd"} ${isSpecialRow ? rowCellToneClass : ""}`;
          const rowClass = isSpecialRow
            ? "transition-colors"
            : `timegrid-row ${rowToneClass} ${isRowActive ? "timegrid-row-active" : ""} transition-colors`;
          const rowHeightClass = isEventRowLabel || isExpandedIoRow ? "h-11" : "h-7";

          return (
            <tr
              key={row.id}
              className={rowClass}
              onFocusCapture={() => setActiveRowId(row.id)}
              onPointerDown={() => setActiveRowId(row.id)}
              onBlurCapture={e => {
                const next = e.relatedTarget as Node | null;
                if (!next || !e.currentTarget.contains(next)) {
                  setActiveRowId(null);
                }
              }}
            >
              <td
                style={{
                  width: labelColWidth,
                  minWidth: labelColWidth,
                  boxShadow: ioRowAccent ? `inset 3px 0 0 ${ioRowAccent}` : undefined,
                }}
                className={`
                  sticky left-0 z-[100] timegrid-sticky-label
                  ${labelToneClass}
                  timegrid-cell-border border-r
                  px-2 py-1
                  text-[11px] leading-none
                  text-[var(--app-text)]
                  whitespace-nowrap
                `}
              >
                <ClinicalReferenceTooltip
                  text={fullLabel}
                  helpCursor={Boolean(row.referenceTooltip || isIoDataRow)}
                  className={`rounded px-1 py-0.5 w-full flex items-center gap-1 min-w-0 ${labelClass}`}
                >
                  {rowTypeMarker ? (
                    <span
                      className={`inline-flex h-4 min-w-[16px] items-center justify-center rounded px-1 text-[9px] leading-none font-bold ${rowTypeMarker.className}`}
                    >
                      {rowTypeMarker.label}
                    </span>
                  ) : null}
                  {isIoSectionHeaderRow ? (
                    <div className="flex flex-1 min-w-0 items-center gap-1">
                      {readOnly ? (
                        <span className="min-w-0 flex-1 truncate px-1 py-0.5 text-[11px] font-medium text-[var(--app-text)]">{row.label}</span>
                      ) : (
                        <>
                          <button
                            type="button"
                            onClick={event => {
                              event.stopPropagation();
                              onIoHeaderClick?.();
                            }}
                            className="timegrid-section-button flex-1 min-w-0 rounded px-1 py-0.5 text-left hover:bg-[var(--app-control-bg-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--app-accent)]"
                            aria-label="Add I/O entry"
                            title="Add I/O entry"
                          >
                            <span className="truncate block text-[11px] font-medium text-[var(--app-text)]">{row.label}</span>
                          </button>
                          <button
                            type="button"
                            onClick={event => {
                              event.stopPropagation();
                              onIoHeaderClick?.();
                            }}
                            className="app-tooltip timegrid-section-button flex h-6 w-7 shrink-0 items-center justify-center gap-[2px] rounded border border-[var(--app-border)] bg-[var(--app-control-bg)] hover:bg-[var(--app-control-bg-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--app-accent)]"
                            aria-label="Add I/O entry"
                            data-tooltip="Add I/O entry"
                          >
                            {["#5B8FF9", "#9B6DFF", "#39C6C8", "#E05252"].map(color => (
                              <span key={color} className="h-3.5 w-[3px] rounded-full" style={{ backgroundColor: color }} aria-hidden="true" />
                            ))}
                          </button>
                        </>
                      )}
                      <button
                        type="button"
                        onClick={event => {
                          event.stopPropagation();
                          onSectionCollapseToggle?.("io");
                        }}
                        className="timegrid-section-button grid h-6 w-6 shrink-0 place-items-center rounded hover:bg-[var(--app-control-bg-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--app-accent)]"
                        aria-label={`${sectionCollapsed ? "Show" : "Hide"} ${row.label}`}
                        aria-expanded={!sectionCollapsed}
                        title={`${sectionCollapsed ? "Show" : "Hide"} I/O rows`}
                      >
                        <svg viewBox="0 0 16 16" className={`h-3.5 w-3.5 transition-transform ${sectionCollapsed ? "" : "rotate-90"}`} fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                          <path d="m6 3 5 5-5 5" strokeLinecap="round" strokeLinejoin="round" />
                        </svg>
                      </button>
                    </div>
                  ) : isSectionHeaderRow ? (
                    <button
                      type="button"
                      onClick={event => {
                        event.stopPropagation();
                        onSectionCollapseToggle?.("vital");
                      }}
                      className="timegrid-section-button flex-1 min-w-0 inline-flex items-center justify-between rounded px-1 py-0.5"
                      aria-label={`${sectionCollapsed ? "Show" : "Hide"} ${row.label}`}
                      aria-expanded={!sectionCollapsed}
                    >
                      <span className={`truncate block text-[var(--app-text)] ${isVitalSectionHeaderRow ? "timegrid-group-title" : "text-[11px] font-medium"}`}>
                        {row.label}
                      </span>
                      <svg viewBox="0 0 16 16" className={`ml-1 h-3.5 w-3.5 shrink-0 transition-transform ${sectionCollapsed ? "" : "rotate-90"}`} fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                        <path d="m6 3 5 5-5 5" strokeLinecap="round" strokeLinejoin="round" />
                      </svg>
                    </button>
                  ) : (
                    <div className={`flex-1 min-w-0 flex ${isExpandedIoRow ? "flex-col items-start gap-0.5" : "items-center gap-1"}`}>
                      <span className={`truncate text-[var(--app-text)] max-w-full ${isEventRowLabel ? "timegrid-group-title" : "text-[11px] font-bold"}`}>
                        {row.label}
                      </span>
                      <div className="min-w-0 flex items-center gap-1">
                        {isBloodProductIoRow && row.ioStatus ? (
                          <span
                            className={`shrink-0 rounded px-1 text-[8px] font-bold leading-none py-0.5 ${
                              row.ioStatus === "warmed"
                                ? "bg-amber-500/20 text-amber-300"
                                : "bg-cyan-500/20 text-cyan-300"
                            }`}
                          >
                            {row.ioStatus}
                          </span>
                        ) : null}
                        {row.displayMode === "drip" && row.ioDetail ? (
                          <span className="truncate text-[9px] leading-none font-medium text-[var(--app-muted)]">
                            {row.ioDetail}
                          </span>
                        ) : null}
                      </div>
                    </div>
                  )}
                </ClinicalReferenceTooltip>
            </td>

            {startIndex > 0 && (
              <td style={{ width: startIndex * colWidth }} />
            )}

            {visibleColumns.map((ts, i) => {
              const actualIndex = startIndex + i;
              const next = columns[actualIndex + 1] ?? Infinity;
              const isNow = ts <= nowTs && next > nowTs;

              const cellClass = `
                timegrid-row-cell
                timegrid-cell-border border-r
                text-center ${rowHeightClass}
                relative
                ${rowCellToneClass}
                ${isNow ? "timegrid-now-cell" : ""}
                transition-colors
              `;

              if (row.type === "event") {
                const isPrimaryEventRow = row.id === "event";
                const isFluidMedHeaderRow = row.id === "__io_header__";
                const isVitalAgentHeaderRow = row.id === "__vital_agent_header__";
                const markers = isPrimaryEventRow ? eventMarkersByTs[ts] ?? [] : [];
                const prepared = isFluidMedHeaderRow ? preparedMarkersByTs[ts] ?? [] : [];
                const visibleEventCount = colWidth < 88 ? 1 : 2;
                const canOpenEvent = !readOnly && isPrimaryEventRow && Boolean(onEventCellClick);
                const canOpenIo = !readOnly && isFluidMedHeaderRow && Boolean(onIoHeaderColumnClick);
                const cellActionClass = canOpenEvent || canOpenIo
                  ? "timegrid-cell-action cursor-pointer"
                  : "";
                const emptyTooltip = isPrimaryEventRow
                  ? "Add Event/Note"
                  : isFluidMedHeaderRow
                    ? `Add I/O at ${formatHHMM(ts)}`
                    : isVitalAgentHeaderRow
                      ? "Params segment"
                      : "";

                return (
                  <td
                    key={ts}
                    style={{ width: colWidth, minWidth: colWidth }}
                    className={`app-tooltip ${cellClass} px-0.5 ${cellActionClass}`}
                    onClick={() => {
                      if (canOpenEvent) onEventCellClick?.(ts);
                      if (canOpenIo) onIoHeaderColumnClick?.(ts);
                    }}
                    data-tooltip={
                      markers.length > 0 || prepared.length > 0
                        ? ""
                        : emptyTooltip
                    }
                  >
                    {markers.length > 0 || prepared.length > 0 ? (
                      <div className="h-full w-full flex items-center justify-center gap-0.5">
                        {markers.slice(0, visibleEventCount).map(marker => {
                          const token = markerForEvent(marker);
                          return (
                            <button
                              key={marker.id}
                              type="button"
                              disabled={readOnly || !onEventMarkerClick}
                              className={`app-tooltip inline-flex h-8 min-w-8 items-center justify-center rounded px-0.5 leading-none font-semibold ${token.className}`}
                              data-tooltip={`${marker.event_type === "note" ? "NOTE" : "EVENT"} · ${formatHHMM(marker.event_ts)}\n${marker.title}${readOnly ? "" : "\nClick to view or edit"}`}
                              onClick={event => {
                                event.stopPropagation();
                                onEventMarkerClick?.(marker);
                              }}
                            >
                              {token.iconSrc ? (
                                (() => {
                                  const TokenIcon = token.iconSrc;
                                  return <TokenIcon className="h-5 w-5" />;
                                })()
                              ) : (
                                <span className="text-[11px]">{token.label}</span>
                              )}
                            </button>
                          );
                        })}
                        {prepared.map((marker, markerIndex) => {
                          const markerColor = markerForPrepared(marker);
                          const preparedTooltip =
                            marker.marker_code === "d"
                              ? marker.item_name || "Drip change"
                              : marker.item_name;
                          return (
                            <button
                              key={`prepared-${marker.run_id}-${marker.item_id}-${markerIndex}`}
                              type="button"
                              disabled={readOnly || !onPreparedMarkerClick}
                              className="app-tooltip inline-flex h-5 w-2 min-w-0 appearance-none items-center justify-center border-0 bg-transparent p-0 shadow-none hover:bg-[var(--app-hover-bg)]"
                              data-tooltip={preparedTooltip}
                              onClick={event => {
                                event.stopPropagation();
                                onPreparedMarkerClick?.(ts, marker);
                              }}
                            >
                              <span className="block h-4 w-[3px] rounded-full" style={{ backgroundColor: markerColor }} aria-hidden="true" />
                            </button>
                          );
                        })}
                        {markers.length > visibleEventCount ? (
                          <button
                            type="button"
                            className="app-tooltip inline-flex h-7 min-w-7 shrink-0 items-center justify-center rounded-md border border-[var(--app-border)] bg-[var(--app-control-bg)] px-1 text-[9px] font-extrabold leading-none text-[var(--app-text)] hover:border-[var(--app-accent)] hover:bg-[var(--app-control-bg-hover)]"
                            data-tooltip={[
                              `${markers.length} EVENTS · ${formatHHMM(ts)}`,
                              ...markers.slice(0, 4).map((marker, index) => `${index + 1}. ${marker.title}`),
                              ...(markers.length > 4 ? [`+${markers.length - 4} more`] : []),
                            ].join("\n")}
                            aria-label={`Show all ${markers.length} events at ${formatHHMM(ts)}`}
                            onClick={event => openEventStack(event, ts, markers)}
                          >
                            +{markers.length - visibleEventCount}
                          </button>
                        ) : null}
                      </div>
                    ) : null}
                  </td>
                );
              }

              if (row.type === "ecg") {
                const displayCode = getECGCodeAt(ts);

                return (
                  <td
                    key={ts}
                    style={{ width: colWidth, minWidth: colWidth }}
                    className={`app-tooltip ${cellClass}`}
                    data-tooltip={values.ecg?.[ts] === ECG_CLEAR_VALUE ? "Rhythm cleared at this time" : (values.ecg?.[ts] as string) ?? ""}
                  >
                    {readOnly ? (
                      <span className="block h-full w-full px-1 text-center text-[10px] leading-[var(--timegrid-row-height)] text-[var(--app-text)]">{displayCode || "—"}</span>
                    ) : (
                      <EcgPicker
                        value={(values.ecg?.[ts] as string) ?? ""}
                        displayCode={displayCode}
                        onChange={value => onChange?.("ecg", ts, value)}
                      />
                    )}
                  </td>
                );
              }

              if (row.type === "io") {
                const rawValue = values[row.id]?.[ts];
                const ioCell = isIoDisplayCellValue(rawValue) ? rawValue : null;
                const hasFallbackRateAt = (columnTs: number) =>
                  Number.isFinite(Number(ioDripRateByRowTs[row.id]?.[columnTs]));
                const fallbackHasDrip = hasFallbackRateAt(ts);
                const fallbackDripPart: IoDripPart | undefined = fallbackHasDrip
                  ? (() => {
                      const prevTs = columns[actualIndex - 1];
                      const nextTs = columns[actualIndex + 1];
                      const hasPrev = prevTs != null ? hasFallbackRateAt(prevTs) : false;
                      const hasNext = nextTs != null ? hasFallbackRateAt(nextTs) : false;
                      if (hasPrev && hasNext) return "mid";
                      if (hasPrev) return "end";
                      if (hasNext) return "start";
                      return "single";
                    })()
                  : undefined;
                const fallbackRateValue = (() => {
                  const rawRate = ioDripRateByRowTs[row.id]?.[ts];
                  return Number.isFinite(Number(rawRate)) ? Number(rawRate) : null;
                })();
                const numericAmount =
                  ioCell && Number.isFinite(Number(ioCell.amount))
                    ? Number(ioCell.amount)
                    : null;
                const bucketVolumeMl =
                  ioCell && Number.isFinite(Number(ioCell.dripBucketVolumeMl))
                    ? Number(ioCell.dripBucketVolumeMl)
                    : null;
                const dripDoseValue =
                  ioCell && Number.isFinite(Number(ioCell.segmentDoseValue))
                    ? Number(ioCell.segmentDoseValue)
                    : null;
                const dripPart = ioCell?.dripPart ?? fallbackDripPart;
                const hasDrip = Boolean(dripPart);
                const legacyValue =
                  ioCell || rawValue == null ? "" : String(rawValue);
                const shouldShowAmount =
                  numericAmount != null &&
                  !hasDrip;
                const displayValue = shouldShowAmount
                  ? formatAmount(numericAmount)
                  : hasDrip
                    ? dripDoseValue != null
                      ? formatAmount(dripDoseValue)
                      : ""
                    : fallbackRateValue != null
                      ? formatAmount(fallbackRateValue)
                      : legacyValue;
                const tooltipParts: string[] = [];
                if (!hasDrip && numericAmount != null) {
                  const unitText = row.unit ? ` ${row.unit}` : "";
                  tooltipParts.push(`${formatAmount(numericAmount)}${unitText}`);
                }
                if (!hasDrip && fallbackRateValue != null) {
                  tooltipParts.push(`Rate ${formatAmount(fallbackRateValue)} mL/hr`);
                }
                
                // Add minute-by-minute breakdown to tooltip if multiple entries exist
                if (ioCell?.minuteValues && ioCell.minuteValues.length > 0) {
                  const activeMins = ioCell.minuteValues.filter(mv => mv.amount > 0);
                  if (activeMins.length > 1) {
                    const breakdown = activeMins
                      .map(mv => `${formatHHMM(mv.ts)}: ${formatAmount(mv.amount)}${row.unit ? ` ${row.unit}` : ""}`)
                      .join("\n");
                    tooltipParts.push(`\nBreakdown:\n${breakdown}`);
                  }
                }

                if (hasDrip) {
                  const resolvedRateMlHr =
                    Number.isFinite(Number(ioCell?.dripRateMlPerHr))
                      ? Number(ioCell?.dripRateMlPerHr)
                      : fallbackRateValue;
                  if (resolvedRateMlHr != null) {
                    tooltipParts.push(`Rate ${formatAmount(resolvedRateMlHr)} mL/hr`);
                  }
                  if (
                    Number.isFinite(Number(ioCell?.segmentDoseValue)) &&
                    String(ioCell?.segmentDoseUnit || "").trim()
                  ) {
                    tooltipParts.push(
                      `Dose ${formatAmount(Number(ioCell?.segmentDoseValue))} ${String(ioCell?.segmentDoseUnit)}`,
                    );
                  }
                  if (bucketVolumeMl != null) {
                    tooltipParts.push(`Volume ${formatAmount(bucketVolumeMl)} mL in this bucket`);
                  }
                  if (Number.isFinite(Number(ioCell?.dripCumulativeVolumeMl))) {
                    tooltipParts.push(
                      `Cumulative ${formatAmount(Number(ioCell?.dripCumulativeVolumeMl))} mL by this time`,
                    );
                  }
                  if (Number.isFinite(Number(ioCell?.dripCarrierMlPerHr))) {
                    tooltipParts.push(
                      `Carrier ${formatAmount(Number(ioCell?.dripCarrierMlPerHr))} mL/hr`,
                    );
                  }
                }
                const tooltipText =
                  tooltipParts.length > 0
                    ? tooltipParts.join("\n")
                    : displayValue || "Input value";
                const dripClass =
                  dripPart === "single"
                    ? "io-drip-bar io-drip-single"
                    : dripPart === "start"
                      ? "io-drip-bar io-drip-start"
                      : dripPart === "end"
                        ? "io-drip-bar io-drip-end"
                        : dripPart === "mid"
                          ? "io-drip-bar io-drip-mid"
                          : "";
                const dripStyle = dripToneStyle(ioCell?.dripGroupTone, dripGroupColors, timelineBackground, smartContrast);
                return (
                  <td
                    key={ts}
                    style={{ width: colWidth, minWidth: colWidth }}
                    className={`app-tooltip group ${cellClass} px-0.5 ${readOnly ? "" : "cursor-pointer hover:bg-emerald-500/10"}`}
                    onClick={() => { if (!readOnly) onIoCellClick?.(row.id, ts); }}
                    data-tooltip={tooltipText}
                  >
                    <div
                      className={`
                        h-full w-full
                        px-1
                        relative
                        flex ${hasDrip ? "flex-col items-center justify-center gap-0.5" : "items-center justify-center"}
                        text-[10px] leading-none
                        text-[var(--app-text)]
                        truncate
                      `}
                    >
                      {hasDrip ? <span className={dripClass} style={dripStyle} /> : null}
                      {hasDrip && displayValue ? (
                        <span className="io-drip-rate-label relative z-10 max-w-full truncate">
                          {displayValue}
                        </span>
                      ) : displayValue ? (
                        <span className="relative z-10">{displayValue}</span>
                      ) : !hasDrip && !readOnly ? (
                        <span className="relative z-10 opacity-0 group-hover:opacity-70 group-focus-within:opacity-70">+</span>
                      ) : null}
                    </div>
                  </td>
                );
              }

              let displayCell = getDisplayCell(row.id, ts, actualIndex);
              const maskedCell = displayCell.value == null || displayCell.value === "" ? maskedInWindow(row.id, actualIndex) : null;
              if (maskedCell) displayCell = { value: maskedCell.value, isFallback: maskedCell.sourceTs !== ts, sourceTs: maskedCell.sourceTs };
              const raw = displayCell.value;
              const value = raw == null ? "" : String(raw);
              const fallbackHint = maskedCell
                ? "Invalid device data (masked)"
                : displayCell.isFallback && displayCell.sourceTs != null
                  ? `Nearest from ${formatHHMM(displayCell.sourceTs)}`
                  : "";
              const canMask = masking && row.type === "vital";
              const selectedForMask = canMask && maskSelection?.rowId === row.id && maskSelection.columnIndex === actualIndex;
              const armedRow = canMask && maskSelection?.armed && maskSelection.rowId === row.id;
              const provenanceTs = displayCell.sourceTs ?? ts;
              const provenance = cellProvenance?.[row.id]?.[provenanceTs];
              const editedDeviceValue = provenance?.source === "override";

              return (
                <td
                  key={ts}
                  style={{ width: colWidth, minWidth: colWidth }}
                  className={`app-tooltip ${cellClass} ${editedDeviceValue ? "timegrid-edited-device-cell" : ""} ${maskedCell ? "timegrid-masked-cell" : ""} ${selectedForMask ? "timegrid-mask-selected" : ""} ${armedRow && !selectedForMask ? "timegrid-mask-armed-row" : ""}`}
                  data-tooltip={clinicalCellTooltip(value, fallbackHint, workstation, provenance)}
                >
                  {readOnly ? (
                    <span
                      className={`relative z-10 block h-full w-full px-1 text-center text-[10px] leading-[var(--timegrid-row-height)] ${maskedCell ? "timegrid-masked-value text-gray-400 dark:text-gray-500" : displayCell.isFallback ? "font-medium text-amber-600 dark:text-amber-400" : "text-[var(--app-text)]"} ${editedDeviceValue ? "underline decoration-dotted decoration-2 underline-offset-2" : ""}`}
                      aria-label={`${row.label} at ${formatHHMM(ts)}`}
                    >
                      {value || "—"}
                    </span>
                  ) : (
                    <EditableCellInput
                      value={value}
                      numeric={value === "" || isNumericLike(raw)}
                      fallback={displayCell.isFallback}
                      editedDeviceValue={editedDeviceValue}
                      masked={Boolean(maskedCell)}
                      ariaLabel={`${row.label} at ${formatHHMM(ts)}`}
                      onCommit={nextValue => onChange?.(row.id, ts, nextValue)}
                      onFocusCell={canMask ? element => focusVitalCell(row, actualIndex, element.closest("td") || element) : undefined}
                      onBlurCell={canMask ? blurVitalCell : undefined}
                    />
                  )}
                </td>
              );
            })}

            {endIndex < columns.length - 1 && (
              <td style={{ width: (columns.length - 1 - endIndex) * colWidth }} />
            )}
          </tr>
          );
        })}
      </tbody>
    </table>
    {eventStack && typeof document !== "undefined" ? createPortal(
      <div className="app-theme-scope">
        <button
          type="button"
          className="fixed inset-0 z-[1190] cursor-default bg-transparent"
          aria-label="Close event list"
          onClick={() => setEventStack(null)}
        />
        <section
          role="dialog"
          aria-modal="true"
          aria-label={`Events at ${formatHHMM(eventStack.ts)}`}
          className="fixed z-[1200] flex flex-col overflow-hidden rounded-xl border border-[var(--app-tooltip-border)] bg-[var(--app-tooltip-bg)] text-[var(--app-tooltip-text)] shadow-2xl"
          style={eventStack.position}
        >
          <header className="flex shrink-0 items-center justify-between gap-3 border-b border-[var(--app-border)] px-3 py-2.5">
            <div>
              <div className="text-[10px] font-extrabold uppercase tracking-[0.12em] text-[var(--app-muted)]">Event stack</div>
              <div className="text-sm font-bold">{formatHHMM(eventStack.ts)} · {eventStack.markers.length} events</div>
            </div>
            <button type="button" onClick={() => setEventStack(null)} className="grid h-8 w-8 place-items-center rounded-lg text-lg text-[var(--app-muted)] hover:bg-[var(--app-control-bg-hover)] hover:text-[var(--app-text)]" aria-label="Close">×</button>
          </header>
          <div className="min-h-0 overflow-y-auto p-2">
            {eventStack.markers.map(marker => {
              const token = markerForEvent(marker);
              return (
                <button
                  key={marker.id}
                  type="button"
                  onClick={() => {
                    setEventStack(null);
                    onEventMarkerClick?.(marker);
                  }}
                  className="flex w-full items-center gap-3 rounded-lg px-2.5 py-2 text-left hover:bg-[var(--app-control-bg-hover)]"
                >
                  <span className={`inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg ${token.className}`}>
                    {token.iconSrc ? (() => { const TokenIcon = token.iconSrc; return <TokenIcon className="h-6 w-6" />; })() : <span className="text-xs font-bold">{token.label}</span>}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-semibold text-[var(--app-text)]">{marker.title}</span>
                    <span className="block text-[10px] uppercase tracking-wide text-[var(--app-muted)]">{marker.event_type === "note" ? "Note" : "Clinical event"} · {formatHHMM(marker.event_ts)}</span>
                  </span>
                  <span aria-hidden="true" className="text-[var(--app-muted)]">›</span>
                </button>
              );
            })}
          </div>
          {onEventCellClick ? (
            <footer className="shrink-0 border-t border-[var(--app-border)] p-2">
              <button type="button" onClick={() => { const ts = eventStack.ts; setEventStack(null); onEventCellClick(ts); }} className="w-full rounded-lg border border-[var(--app-border)] bg-[var(--app-control-bg)] px-3 py-2 text-sm font-semibold text-[var(--app-text)] hover:border-[var(--app-accent)] hover:bg-[var(--app-control-bg-hover)]">+ Add another event</button>
            </footer>
          ) : null}
        </section>
      </div>,
      document.body,
    ) : null}
    {maskSelection && masking && maskSelection.element.isConnected && typeof document !== "undefined" ? (() => {
      const rect = maskSelection.element.getBoundingClientRect();
      const selectionMasked = Boolean(maskedInWindow(maskSelection.rowId, maskSelection.columnIndex));
      const [from, to] = columnWindow(maskSelection.columnIndex);
      const keep = (event: ReactMouseEvent) => event.preventDefault();  // keep the cell focused
      return createPortal(
        <div
          className="app-theme-scope fixed z-[1150] flex items-center gap-1 rounded-xl border border-[var(--app-tooltip-border)] bg-[var(--app-tooltip-bg)] p-1 text-[var(--app-tooltip-text)] shadow-xl"
          style={{ left: Math.max(8, rect.left + rect.width / 2 - 20), top: Math.max(8, rect.top - 40) }}
          role="toolbar"
          aria-label={`${maskSelection.rowLabel} data quality`}
          onMouseDown={keep}
        >
          <button
            type="button"
            onMouseDown={keep}
            onClick={() => {
              if (!selectionMasked) {
                maskRange(maskSelection);
                return;
              }
              // Pressing ⊘ again: pick a second value in this channel to mask the range.
              setMaskSelection({ ...maskSelection, armed: !maskSelection.armed });
            }}
            title={selectionMasked ? "Mask a range: press, then click another value in this row" : "Mark invalid (artifact)"}
            className={`inline-flex h-7 items-center gap-1 rounded-lg px-2 text-xs font-semibold ${maskSelection.armed ? "bg-red-600 text-white" : "text-red-600 hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-950/40"}`}
          >
            <InvalidIcon /> {maskSelection.armed ? "Range…" : selectionMasked ? "Range" : "Invalid"}
          </button>
          {selectionMasked && !maskSelection.armed ? (
            <button
              type="button"
              onMouseDown={keep}
              onClick={() => onUnmaskRange?.(maskSelection.rowId, from, to)}
              title="Mark valid again"
              className="inline-flex h-7 items-center rounded-lg px-2 text-xs font-semibold text-[var(--app-text)] hover:bg-[var(--app-control-bg-hover)]"
            >
              Valid
            </button>
          ) : null}
          {maskSelection.armed ? (
            <span className="px-1 text-[10px] text-[var(--app-muted)]">Click another {maskSelection.rowLabel} value · Esc</span>
          ) : null}
        </div>,
        document.body,
      );
    })() : null}
    </>
  );
}
