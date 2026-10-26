/** Polling and time helpers for boards that follow a Leaf (see leafCase.tsx). */
import { useEffect, useState } from "react";
import type { LeafContext } from "../../api/aiStudioApi";
import type { Lang } from "../../reportstudio/model";
import { useDashboardData, type BoardLeaf } from "./dataSource";

const POLL_MS = 15_000;

/** Poll the followed Leaf's context (board level; widgets read it through BoardLeafContext). */
export function useLeafPoll(leafId: string | null | undefined, refreshKey: number): BoardLeaf {
  const source = useDashboardData();
  const [state, setState] = useState<{ key: string; context: LeafContext | null; error: string }>({ key: "", context: null, error: "" });
  useEffect(() => {
    if (!leafId) return;
    let live = true;
    const tick = () => source.leafContext(leafId)
      .then(context => { if (live) setState({ key: leafId, context, error: "" }); })
      .catch(error => { if (live) setState(current => ({ ...current, key: leafId, error: error instanceof Error ? error.message : String(error) })); });
    void tick();
    const timer = window.setInterval(tick, POLL_MS);
    return () => { live = false; window.clearInterval(timer); };
  }, [leafId, refreshKey, source]);
  // A different Leaf than the one loaded: show nothing until it arrives.
  return leafId && state.key === leafId ? { leafId, context: state.context, error: state.error } : { leafId: leafId || null, context: null, error: "" };
}

export function useNow(intervalMs = 1000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const timer = window.setInterval(() => setNow(Date.now()), intervalMs); return () => window.clearInterval(timer); }, [intervalMs]);
  return now;
}

export const clockText = (ts: number | null | undefined, lang: Lang) =>
  ts ? new Date(ts).toLocaleTimeString(lang === "th" ? "th-TH" : undefined, { hour: "2-digit", minute: "2-digit", hour12: false }) : "—";

/** 1h 05m / 12m / 45s */
export function span(ms: number) {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600), minutes = Math.floor((totalSeconds % 3600) / 60);
  if (hours) return `${hours}h ${String(minutes).padStart(2, "0")}m`;
  return minutes ? `${minutes}m` : `${totalSeconds}s`;
}

