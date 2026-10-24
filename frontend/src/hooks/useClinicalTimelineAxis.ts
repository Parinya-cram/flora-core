import { useEffect, useState } from "react";
import { getClinicalTimelineAxis } from "../api/clinicalTimelineApi";

type CaseStatus = "IDLE" | "ACTIVE" | "DISCHARGED" | "ARCHIVED";

const MINUTE_MS = 60_000;

function reserveFutureColumns(
  axis: number[],
  serverTime: number,
  stepMin: number,
  futureColumnCount: number,
): number[] {
  if (axis.length === 0 || !Number.isFinite(serverTime)) return axis;

  const stepMs = axis.length > 1
    ? Math.max(1, axis[1] - axis[0])
    : Math.max(1, stepMin) * MINUTE_MS;
  const startTs = axis[0];
  const currentIndex = Math.max(0, Math.floor((serverTime - startTs) / stepMs));
  const safeFutureColumnCount = Math.min(12, Math.max(0, Math.round(futureColumnCount)));
  const requiredLastIndex = currentIndex + safeFutureColumnCount;
  if (axis.length > requiredLastIndex) return axis;

  const extended = [...axis];
  while (extended.length <= requiredLastIndex) {
    extended.push(startTs + extended.length * stepMs);
  }
  return extended;
}

export type TimelineAxisWindow = {
  /** Window bounds (ms, inclusive); null = case start / case end. */
  from?: number | null;
  to?: number | null;
  /** Grid anchor (coarse steps align to the clinical day); null = case start. */
  anchor?: number | null;
  /** The window contains now: poll and reserve future columns (active case only). */
  live?: boolean;
};

export function useClinicalTimelineAxis(
  caseId: number | null,
  status: CaseStatus,
  stepMin = 1,
  futureColumnCount = 2,
  axisWindow: TimelineAxisWindow = {},
) {
  const windowFrom = axisWindow.from ?? null;
  const windowTo = axisWindow.to ?? null;
  const windowAnchor = axisWindow.anchor ?? null;
  const windowLive = axisWindow.live ?? true;
  const [axis, setAxis] = useState<number[]>([]);
  const [loading, setLoading] = useState(false);
  const [serverOffsetMs, setServerOffsetMs] = useState(0);
  const [lastSyncedAt, setLastSyncedAt] = useState<number | null>(null);

  useEffect(() => {
    if (caseId == null || status === "IDLE") {
      setAxis([]);
      setLoading(false);
      return;
    }

    const activeCaseId = caseId;
    let alive = true;

    async function fetchAxis(showLoading = false) {
      if (showLoading) setLoading(true);
      try {
        const receivedAt = Date.now();
        const result = await getClinicalTimelineAxis(activeCaseId, stepMin, {
          from: windowFrom,
          to: windowTo,
          anchor: windowAnchor,
        });
        const next = status === "ACTIVE" && windowLive
          ? reserveFutureColumns(result.axis, result.serverTime, stepMin, futureColumnCount)
          : result.axis;
        if (!alive) return;

        if (Number.isFinite(result.serverTime)) {
          setServerOffsetMs(result.serverTime - (receivedAt + Date.now()) / 2);
        }
        setLastSyncedAt(Date.now());

        setAxis(prev => {
          if (prev.length !== next.length) return next;
          for (let i = 0; i < prev.length; i += 1) {
            if (prev[i] !== next[i]) return next;
          }
          return prev;
        });
      } catch (err) {
        console.error("[useClinicalTimelineAxis] fetch failed", err);
      } finally {
        if (alive) setLoading(false);
      }
    }

    // always fetch once, show loading only on initial/scale change
    fetchAxis(true);

    // poll only when ACTIVE and the window contains now (a past day of a long stay is static)
    if (status === "ACTIVE" && windowLive) {
      const onStartTimeUpdated = (event: Event) => {
        const custom = event as CustomEvent<{ caseId?: number }>;
        const changedCaseId = Number(custom.detail?.caseId);
        if (!Number.isFinite(changedCaseId) || changedCaseId !== activeCaseId) return;
        void fetchAxis(true);
      };
      const timer = setInterval(() => fetchAxis(false), 60_000);
      window.addEventListener("flora:case-start-time-updated", onStartTimeUpdated);
      return () => {
        alive = false;
        clearInterval(timer);
        window.removeEventListener("flora:case-start-time-updated", onStartTimeUpdated);
      };
    }

    return () => {
      alive = false;
    };
  }, [caseId, status, stepMin, futureColumnCount, windowFrom, windowTo, windowAnchor, windowLive]);

  return { axis, loading, serverOffsetMs, lastSyncedAt };
}
