import { useCallback, useEffect, useMemo, useState } from "react";
import { getActiveFleetCases, getLeaves, type FleetCase, type LeafNode } from "../api/fleetApi";

function age(value?: string | null) {
  if (!value) return "No heartbeat";
  const seconds = Math.max(0, Math.floor((Date.now() - new Date(value).getTime()) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  return `${Math.floor(seconds / 3600)}h ago`;
}

function Metric({ label, value, detail, tone = "default" }: { label: string; value: number; detail: string; tone?: "default" | "good" | "warn" }) {
  const color = tone === "good" ? "border-emerald-500/35 bg-emerald-500/8" : tone === "warn" ? "border-amber-500/40 bg-amber-500/8" : "border-[var(--app-border)] bg-[var(--app-panel-bg)]";
  return <article className={`rounded-2xl border p-4 ${color}`}><div className="text-[10px] font-extrabold uppercase tracking-[0.14em] text-[var(--app-muted)]">{label}</div><div className="mt-1 text-3xl font-bold text-[var(--app-text)]">{value}</div><div className="mt-1 text-xs text-[var(--app-muted)]">{detail}</div></article>;
}

export default function CanopyHomeView() {
  const [leaves, setLeaves] = useState<LeafNode[]>([]);
  const [cases, setCases] = useState<FleetCase[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const [nextLeaves, nextCases] = await Promise.all([getLeaves(), getActiveFleetCases()]);
      setLeaves(nextLeaves);
      setCases(nextCases);
      setError("");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Canopy dashboard is unavailable.");
    } finally { setLoading(false); }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), 10_000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  const summary = useMemo(() => ({
    online: leaves.filter(item => item.connection_status === "online").length,
    unavailable: leaves.filter(item => item.connection_status !== "online").length,
    attention: leaves.filter(item => item.config_status !== "synced").length + cases.filter(item => item.sync_status !== "live").length,
  }), [cases, leaves]);

  return <main className="h-full overflow-y-auto bg-[var(--app-bg)] p-3 sm:p-5"><div className="mx-auto max-w-7xl space-y-5">
    <header className="flex flex-wrap items-end justify-between gap-3"><div><div className="text-xs font-extrabold uppercase tracking-[0.16em] text-[var(--app-accent)]">Flora iCIS Canopy · control room</div><h1 className="mt-1 text-2xl font-semibold text-[var(--app-text)]">Operations dashboard</h1><p className="mt-1 text-sm text-[var(--app-muted)]">Leaf connectivity, synchronization, and active clinical workload.</p></div><button type="button" onClick={() => void refresh()} disabled={loading} className="rounded-xl border border-[var(--app-border)] bg-[var(--app-control-bg)] px-4 py-2.5 text-sm font-semibold text-[var(--app-text)] disabled:opacity-50">{loading ? "Refreshing…" : "Refresh"}</button></header>
    {error ? <div className="rounded-xl border border-rose-500/40 bg-rose-500/10 px-4 py-3 text-sm text-rose-300">{error}</div> : null}
    <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5"><Metric label="Leaf stations" value={leaves.length} detail="Registered workstations" /><Metric label="Online" value={summary.online} detail="Current heartbeat" tone="good" /><Metric label="Unavailable" value={summary.unavailable} detail="Delayed or offline" tone={summary.unavailable ? "warn" : "good"} /><Metric label="Active cases" value={cases.length} detail="Synchronized now" tone="good" /><Metric label="Needs attention" value={summary.attention} detail="Feed or configuration issue" tone={summary.attention ? "warn" : "good"} /></section>
    <section className="overflow-hidden rounded-2xl border border-[var(--app-border)] bg-[var(--app-panel-bg)]"><div className="border-b border-[var(--app-border)] px-4 py-3"><h2 className="font-semibold text-[var(--app-text)]">Leaf stations</h2><p className="text-xs text-[var(--app-muted)]">ICU bed charts are available from the dedicated Central Charting menu.</p></div><div className="grid gap-3 p-3 md:grid-cols-2 xl:grid-cols-3">{leaves.map(leaf => <article key={leaf.leaf_id} className="rounded-xl border border-[var(--app-border)] bg-[var(--app-control-bg)] p-4"><div className="flex items-start justify-between gap-3"><div className="min-w-0"><strong className="block truncate text-[var(--app-text)]">{leaf.display_name}</strong><span className="text-xs text-[var(--app-muted)]">{[leaf.room_name, leaf.bed_name].filter(Boolean).join(" · ") || leaf.leaf_id}</span></div><span className={`rounded-full px-2 py-1 text-[10px] font-bold uppercase ${leaf.connection_status === "online" ? "bg-emerald-500/12 text-emerald-300" : "bg-amber-500/12 text-amber-300"}`}>{leaf.connection_status}</span></div><div className="mt-3 border-t border-[var(--app-border)] pt-3 text-xs text-[var(--app-muted)]">Last heartbeat <b className="text-[var(--app-text)]">{age(leaf.last_seen_at)}</b></div></article>)}{!loading && leaves.length === 0 ? <div className="col-span-full p-10 text-center text-sm text-[var(--app-muted)]">No Leaf stations registered.</div> : null}</div></section>
  </div></main>;
}
