import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getEffectiveTimelineWithMasks, type TimelineMask, type TimelineProvenance, type VitalMinuteRow } from "../api/vitalMinutesApi";
import type { ClinicalTimelineValues } from "../components/clinical-timeline/types";
import { LIVE_MINUTE_CLOSED_EVENT, type LiveMinute } from "./useLiveCase";

/** leaf-live rolls a closed minute into vital_minutes shortly after it closes; refetch after this delay. */
const LIVE_ROLLUP_DELAY_MS = 2_500;

type CaseStatus = "IDLE" | "ACTIVE" | "DISCHARGED" | "ARCHIVED";

const PARAM_KEY_MAP: Record<string, string> = {
  heart_rate: "hr",
  pulse_rate: "pr",
  spo2_pr: "pr",
  pr: "pr",
  spo2: "spo2",
  nibp_sys: "nibp_sys",
  nibp_dia: "nibp_dia",
  nibp_mean: "nibp_map",
  nibp_map: "nibp_map",
  art_sys: "art_sys",
  art_dia: "art_dia",
  art_mean: "art_map",
  art_map: "art_map",
  cvp: "cvp",

  "unknown::147842": "hr",
  "unknown::149530": "pr",
  "unknown::150456": "spo2",
  "unknown::150021": "nibp_sys",
  "unknown::150022": "nibp_dia",
  "unknown::150023": "nibp_map",
  "unknown::hr": "hr",
  "unknown::pr": "pr",
  "unknown::spo2": "spo2",
  "unknown::nibp sys": "nibp_sys",
  "unknown::nibp dia": "nibp_dia",
  "unknown::nibp map": "nibp_map",
  "unknown::ventilation mode": "set_vent_mode",
};

function toRowId(key: string) {
  const normalized = key.trim().toLowerCase();
  return PARAM_KEY_MAP[normalized] || normalized;
}

/** Device per-minute rows as values[rowId][ts] (device keys mapped to Leaf row ids). Also used by Form Studio timelines. */
export function toClinicalTimelineValues(
  rows: VitalMinuteRow[],
): ClinicalTimelineValues {
  const next: ClinicalTimelineValues = {};

  for (const row of rows) {
    const ts = Number(row.ts_minute);
    if (!Number.isFinite(ts)) continue;

    for (const [rawKey, rawValue] of Object.entries(row.payload || {})) {
      if (rawValue == null || rawValue === "") continue;

      const rowId = toRowId(rawKey);
      const byTs = next[rowId] ?? {};
      byTs[ts] = rawValue;
      next[rowId] = byTs;
    }
  }

  return next;
}

function toMaskedValues(rows: VitalMinuteRow[]): ClinicalTimelineValues {
  return toClinicalTimelineValues(rows.map(row => ({ ts_minute: row.ts_minute, payload: row.masked || {} })));
}

function toTimelineProvenance(rows: VitalMinuteRow[]): TimelineProvenance {
  const next: TimelineProvenance = {};
  for (const row of rows) {
    const ts = Number(row.ts_minute);
    if (!Number.isFinite(ts)) continue;
    for (const [rawKey, detail] of Object.entries(row.provenance || {})) {
      const rowId = toRowId(rawKey);
      next[rowId] = { ...(next[rowId] || {}), [ts]: detail };
    }
  }
  return next;
}

function sameValues(left: ClinicalTimelineValues, right: ClinicalTimelineValues): boolean {
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  if (leftKeys.length !== rightKeys.length) return false;
  return leftKeys.every(key => {
    const a = left[key];
    const b = right[key];
    if (!b) return false;
    const stamps = Object.keys(a);
    return stamps.length === Object.keys(b).length && stamps.every(ts => a[Number(ts)] === b[Number(ts)]);
  });
}

export function useVitalMinutes(
  caseId: number | null,
  status: CaseStatus,
  axis: number[],
  /** Values of the minute still streaming in (useLiveCase); shown until the stored minute arrives. */
  liveMinute?: LiveMinute | null,
) {
  const [values, setValues] = useState<ClinicalTimelineValues>({});
  const [provenance, setProvenance] = useState<TimelineProvenance>({});
  const [loading, setLoading] = useState(false);
  const [fetchedAxis, setFetchedAxis] = useState<number[]>([]);
  const [masked, setMasked] = useState<ClinicalTimelineValues>({});
  const [masks, setMasks] = useState<TimelineMask[]>([]);
  const reloadRef = useRef<() => Promise<void>>(async () => undefined);

  useEffect(() => {
    if (
      caseId == null ||
      status === "IDLE" ||
      axis.length === 0
    ) {
      setValues({});
      setProvenance({});
      setMasked({});
      setMasks([]);
      setFetchedAxis([]);
      setLoading(false);
      return;
    }

    const activeCaseId = caseId;
    const currentAxis = axis;
    const fromTs = axis[0];
    const stepMs = axis.length > 1 ? Math.max(1, axis[1] - axis[0]) : 60_000;
    const toTs = axis[axis.length - 1] + stepMs - 1;
    let alive = true;

    async function fetchVitals(showLoading = false) {
      if (showLoading) setLoading(true);
      try {
        const { rows, masks: nextMasks } = await getEffectiveTimelineWithMasks(activeCaseId, fromTs, toTs);
        if (!alive) return;
        const nextValues = toClinicalTimelineValues(rows);
        const nextMasked = toMaskedValues(rows);
        setValues(previous => sameValues(previous, nextValues) ? previous : nextValues);
        setMasked(previous => sameValues(previous, nextMasked) ? previous : nextMasked);
        setMasks(nextMasks);
        setProvenance(toTimelineProvenance(rows));
        setFetchedAxis(currentAxis);
      } catch (err) {
        console.error("[useVitalMinutes] fetch failed", err);
      } finally {
        if (alive) setLoading(false);
      }
    }

    fetchVitals(true);
    reloadRef.current = () => fetchVitals(false);

    if (status === "ACTIVE") {
      const onStartTimeUpdated = (event: Event) => {
        const custom = event as CustomEvent<{ caseId?: number }>;
        const changedCaseId = Number(custom.detail?.caseId);
        if (!Number.isFinite(changedCaseId) || changedCaseId !== activeCaseId) return;
        void fetchVitals(true);
      };
      // A minute closed in the live stream: fetch it now instead of waiting for the 15 s poll.
      let liveTimer: ReturnType<typeof setTimeout> | null = null;
      const onLiveMinuteClosed = (event: Event) => {
        const custom = event as CustomEvent<{ caseId?: number; minute?: number }>;
        if (Number(custom.detail?.caseId) !== activeCaseId) return;
        const minute = Number(custom.detail?.minute);
        if (Number.isFinite(minute) && (minute < fromTs || minute > toTs)) return;
        if (liveTimer) clearTimeout(liveTimer);
        liveTimer = setTimeout(() => void fetchVitals(false), LIVE_ROLLUP_DELAY_MS);
      };
      const timer = setInterval(() => fetchVitals(false), 15_000);
      window.addEventListener("flora:case-start-time-updated", onStartTimeUpdated);
      window.addEventListener(LIVE_MINUTE_CLOSED_EVENT, onLiveMinuteClosed);
      return () => {
        alive = false;
        clearInterval(timer);
        if (liveTimer) clearTimeout(liveTimer);
        window.removeEventListener("flora:case-start-time-updated", onStartTimeUpdated);
        window.removeEventListener(LIVE_MINUTE_CLOSED_EVENT, onLiveMinuteClosed);
      };
    }

    return () => {
      alive = false;
    };
  }, [caseId, status, axis]);

  /** Refetch now (after a mask change), resolving when the new data is in. */
  const reload = useCallback(() => reloadRef.current(), []);

  // Merge the streaming minute into the grid. Stored values always win; the live value
  // only fills a cell the server has not rolled up yet, and only on an axis column.
  const mergedValues = useMemo(() => {
    if (!liveMinute || status !== "ACTIVE" || !axis.length) return values;
    const ts = liveMinute.ts_minute;
    if (!axis.includes(ts)) return values;
    let next: ClinicalTimelineValues | null = null;
    for (const [rawKey, value] of Object.entries(liveMinute.values)) {
      if (value == null || value === "") continue;
      const rowId = toRowId(rawKey);
      if (values[rowId]?.[ts] != null) continue;
      next = next ?? { ...values };
      next[rowId] = { ...(next[rowId] || {}), [ts]: value };
    }
    return next ?? values;
  }, [axis, liveMinute, status, values]);

  return { values: mergedValues, provenance, loading, fetchedAxis, masked, masks, reload };
}
