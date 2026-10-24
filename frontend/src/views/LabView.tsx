import { useCallback, useEffect, useMemo, useState } from "react";
import type { CaseStatus } from "../api/caseApi";
import { getCaseLabs, syncCaseHisLab, type CaseLabRow } from "../api/caseHisApi";

type LabFilter = "all" | "abnormal" | "critical";
export type LabSummary = { total: number; abnormal: number; critical: number; loaded: boolean };
type Props = { caseStatus: CaseStatus; onSummaryChange?: (summary: LabSummary) => void };

const panel = "rounded-xl border border-[var(--app-border)] bg-[var(--app-panel-bg)] shadow-sm";
const input = "min-h-10 rounded-lg border border-[var(--app-control-border)] bg-[var(--app-control-bg)] px-3 py-2 text-sm text-[var(--app-text)]";
const button = "min-h-9 rounded-lg border border-[var(--app-border)] bg-[var(--app-control-bg)] px-3 py-1.5 text-xs font-bold text-[var(--app-text)] hover:bg-[var(--app-control-bg-hover)] disabled:opacity-50";

function fmt(ts?: number | null, includeDate = true) {
  if (!ts) return "Time unavailable";
  const d = new Date(ts);
  const date = `${String(d.getDate()).padStart(2, "0")}/${String(d.getMonth() + 1).padStart(2, "0")}/${d.getFullYear()}`;
  const time = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  return includeDate ? `${date} ${time}` : time;
}

function flagLevel(raw?: string | null): "normal" | "abnormal" | "critical" {
  const flag = String(raw || "").trim().toUpperCase();
  if (["HH", "LL", "CRITICAL", "PANIC"].includes(flag)) return "critical";
  if (["H", "L", "A", "ABNORMAL", "*", "+"].includes(flag)) return "abnormal";
  return "normal";
}

function flagLabel(raw?: string | null) {
  const flag = String(raw || "").trim().toUpperCase();
  return ({ HH: "Critical high", LL: "Critical low", H: "High", L: "Low", A: "Abnormal", ABNORMAL: "Abnormal", "*": "Abnormal" } as Record<string, string>)[flag] || flag || "Within range";
}

function numericValue(row: CaseLabRow) {
  const value = Number.parseFloat(String(row.value_text || "").replace(/,/g, ""));
  return Number.isFinite(value) ? value : null;
}

function MiniTrend({ rows }: { rows: CaseLabRow[] }) {
  const points = rows.map(row => ({ value: numericValue(row), ts: Number(row.collected_at || 0) }))
    .filter((item): item is { value: number; ts: number } => item.value != null)
    .sort((a, b) => a.ts - b.ts).slice(-12);
  if (points.length < 2) return <div className="flex h-24 items-center justify-center text-xs text-[var(--app-muted)]">More numeric results are needed for a trend.</div>;
  const min = Math.min(...points.map(point => point.value));
  const max = Math.max(...points.map(point => point.value));
  const spread = max - min || 1;
  const coords = points.map((point, index) => `${(index / (points.length - 1)) * 100},${88 - ((point.value - min) / spread) * 70}`);
  return <div><svg viewBox="0 0 100 100" className="h-24 w-full" preserveAspectRatio="none" aria-label="Recent result trend"><line x1="0" y1="88" x2="100" y2="88" stroke="var(--app-border)" /><polyline points={coords.join(" ")} fill="none" stroke="var(--app-accent)" strokeWidth="3" vectorEffect="non-scaling-stroke" />{points.map((point, index) => { const [x, y] = coords[index].split(","); return <circle key={`${point.ts}-${index}`} cx={x} cy={y} r="2.2" fill="var(--app-accent)" />; })}</svg><div className="flex justify-between text-[10px] text-[var(--app-muted)]"><span>{min}</span><span>Last {points.length} results</span><span>{max}</span></div></div>;
}

export default function LabView({ caseStatus, onSummaryChange }: Props) {
  const activeCase = caseStatus.status === "IDLE" ? null : caseStatus;
  const caseId = activeCase?.case_id ?? null;
  const caseStartTime = activeCase?.start_time ?? 0;
  const [labGroup, setLabGroup] = useState("28");
  const [filter, setFilter] = useState<LabFilter>("all");
  const [query, setQuery] = useState("");
  const [selectedTest, setSelectedTest] = useState("");
  const [labs, setLabs] = useState<CaseLabRow[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [note, setNote] = useState("");

  const sorted = useMemo(() => [...labs].sort((a, b) => Number(b.collected_at || 0) - Number(a.collected_at || 0)), [labs]);
  const summary = useMemo<LabSummary>(() => ({ total: labs.length, abnormal: labs.filter(row => flagLevel(row.flag) !== "normal").length, critical: labs.filter(row => flagLevel(row.flag) === "critical").length, loaded }), [labs, loaded]);
  const latest = useMemo(() => { const seen = new Set<string>(); return sorted.filter(row => { const key = row.test_name.trim().toLowerCase(); if (seen.has(key)) return false; seen.add(key); return true; }); }, [sorted]);
  const shown = useMemo(() => { const needle = query.trim().toLowerCase(); return latest.filter(row => { const level = flagLevel(row.flag); if (filter === "critical" && level !== "critical") return false; if (filter === "abnormal" && level === "normal") return false; return !needle || `${row.test_name} ${row.test_group || ""} ${row.value_text || ""}`.toLowerCase().includes(needle); }); }, [filter, latest, query]);
  const history = useMemo(() => { const target = (selectedTest || shown[0]?.test_name || "").toLowerCase(); return sorted.filter(row => row.test_name.toLowerCase() === target); }, [selectedTest, shown, sorted]);
  const selectedName = history[0]?.test_name || "";

  useEffect(() => onSummaryChange?.(summary), [onSummaryChange, summary]);

  const loadLabs = useCallback(async () => {
    if (!caseId) return;
    const toTs = Date.now();
    // Whole stay (+ the day before admission), so a 30-day ICU stay keeps its early labs.
    const fromTs = caseStartTime - 86_400_000;
    setLoading(true); setError("");
    try { const rows = await getCaseLabs(caseId, { fromTs, toTs, limit: 1000 }); setLabs(rows); setNote(rows.length ? `Updated ${fmt(Date.now())}` : "No resulted laboratory data received."); }
    catch (err) { setError(err instanceof Error ? err.message : "Lab results could not be loaded."); }
    finally { setLoading(false); setLoaded(true); }
  }, [caseId, caseStartTime]);

  useEffect(() => { if (!caseId) { setLabs([]); setLoaded(false); return; } setLoaded(false); void loadLabs(); }, [caseId, loadLabs]);
  useEffect(() => { if (!caseId) return; const handler = (event: Event) => { if (Number((event as CustomEvent<{ caseId?: unknown }>).detail?.caseId) === caseId) void loadLabs(); }; window.addEventListener("flora:his-synced", handler); return () => window.removeEventListener("flora:his-synced", handler); }, [caseId, loadLabs]);

  const syncLab = async () => {
    if (!caseId) return;
    setLoading(true); setError("");
    try { const group = labGroup.trim() || "28"; const result = await syncCaseHisLab(caseId, group, { allow_buffer_fallback: true }); setLabs(result.rows); const partial = result.his_errors && Object.keys(result.his_errors).length > 0; setNote(`${result.rows.length} results from ${(result.source || "HIS").toLowerCase()} group ${group}${partial ? " (cached/partial)" : ""}.`); }
    catch (err) { setError(err instanceof Error ? err.message : "Lab synchronization failed."); }
    finally { setLoading(false); setLoaded(true); }
  };

  if (!activeCase || !caseId) return null;
  const stats = [
    { label: "Results", value: summary.total, tone: "text-[var(--app-text)]" },
    { label: "Abnormal", value: summary.abnormal, tone: summary.abnormal ? "text-amber-600 dark:text-amber-300" : "text-emerald-600 dark:text-emerald-300" },
    { label: "Critical", value: summary.critical, tone: summary.critical ? "text-red-600 dark:text-red-300" : "text-emerald-600 dark:text-emerald-300" },
    { label: "Last collected", value: sorted[0]?.collected_at ? fmt(sorted[0].collected_at, false) : "—", tone: "text-[var(--app-text)]" },
  ];

  return <div className="space-y-3">
    <section className={`${panel} p-4`}><div className="flex flex-wrap items-start justify-between gap-3"><div><h2 className="text-base font-bold text-[var(--app-text)]">Laboratory overview</h2><p className="text-xs text-[var(--app-muted)]">Latest results first. Select a test to review its history and trend.</p></div><div className="flex flex-wrap items-center gap-2"><label className="flex items-center gap-2 text-xs text-[var(--app-muted)]">HIS group<input className={`${input} w-20`} value={labGroup} onChange={e => setLabGroup(e.target.value)} inputMode="numeric" aria-label="HIS lab group" /></label><button type="button" className={button} onClick={() => void syncLab()} disabled={loading}>{loading ? "Syncing…" : "Sync HIS labs"}</button></div></div>{error ? <div className="mt-3 rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-xs font-semibold text-red-700 dark:border-red-800 dark:bg-red-950/30 dark:text-red-300">{error}</div> : null}{note ? <div className="mt-2 text-[11px] text-[var(--app-muted)]">{note}</div> : null}</section>
    <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">{stats.map(item => <div key={item.label} className={`${panel} px-4 py-3`}><div className="text-[10px] font-bold uppercase tracking-[0.14em] text-[var(--app-muted)]">{item.label}</div><div className={`mt-1 text-xl font-extrabold ${item.tone}`}>{item.value}</div></div>)}</div>
    <section className={`${panel} overflow-hidden`}>
      <div className="flex flex-wrap items-center gap-2 border-b border-[var(--app-border)] p-3"><input className={`${input} min-w-52 flex-1`} value={query} onChange={e => setQuery(e.target.value)} placeholder="Search test or group…" /><div className="inline-flex overflow-hidden rounded-lg border border-[var(--app-border)]" role="group" aria-label="Lab result filter">{(["all", "abnormal", "critical"] as LabFilter[]).map(item => <button key={item} type="button" onClick={() => setFilter(item)} className={`min-h-9 border-l border-[var(--app-border)] px-3 text-xs font-bold capitalize first:border-l-0 ${filter === item ? "bg-[var(--app-accent)] text-[var(--app-accent-contrast)]" : "bg-[var(--app-control-bg)] text-[var(--app-muted)]"}`}>{item}</button>)}</div></div>
      {shown.length === 0 ? <div className="p-8 text-center"><div className="text-sm font-bold text-[var(--app-text)]">No matching results</div><div className="mt-1 text-xs text-[var(--app-muted)]">Try another filter, or synchronize the patient’s laboratory results.</div></div> : <div className="grid min-h-80 lg:grid-cols-[minmax(0,1.45fr)_minmax(300px,0.75fr)]">
        <div className="overflow-x-auto border-b border-[var(--app-border)] lg:border-b-0 lg:border-r"><table className="w-full border-collapse text-sm"><thead className="bg-[var(--app-control-bg)] text-left text-[10px] font-bold uppercase tracking-wider text-[var(--app-muted)]"><tr><th className="px-4 py-2">Test</th><th className="px-3 py-2">Latest result</th><th className="px-3 py-2">Reference</th><th className="px-3 py-2">Collected</th></tr></thead><tbody>{shown.map(row => { const level = flagLevel(row.flag); const selected = selectedName.toLowerCase() === row.test_name.toLowerCase(); return <tr key={row.id} onClick={() => setSelectedTest(row.test_name)} className={`cursor-pointer border-t border-[var(--app-border)] ${selected ? "bg-blue-50 dark:bg-blue-950/25" : "hover:bg-[var(--app-control-bg-hover)]"}`}><td className="px-4 py-3"><div className="font-bold text-[var(--app-text)]">{row.test_name}</div><div className="text-[10px] text-[var(--app-muted)]">{row.test_group || "Ungrouped"}</div></td><td className="px-3 py-3"><div className={`font-extrabold ${level === "critical" ? "text-red-600 dark:text-red-300" : level === "abnormal" ? "text-amber-600 dark:text-amber-300" : "text-[var(--app-text)]"}`}>{row.value_text || "—"} <span className="text-xs font-medium">{row.unit || ""}</span></div><span className={`mt-1 inline-flex rounded-full px-2 py-0.5 text-[9px] font-bold uppercase ${level === "critical" ? "bg-red-100 text-red-700 dark:bg-red-950/50 dark:text-red-300" : level === "abnormal" ? "bg-amber-100 text-amber-700 dark:bg-amber-950/50 dark:text-amber-300" : "bg-emerald-100 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300"}`}>{flagLabel(row.flag)}</span></td><td className="px-3 py-3 text-xs text-[var(--app-muted)]">{row.ref_range || "—"}</td><td className="whitespace-nowrap px-3 py-3 text-xs text-[var(--app-muted)]">{fmt(row.collected_at)}</td></tr>; })}</tbody></table></div>
        <aside className="p-4">{history.length ? <><div className="flex items-start justify-between gap-2"><div><div className="text-[10px] font-bold uppercase tracking-wider text-[var(--app-muted)]">Selected test</div><h3 className="text-lg font-extrabold text-[var(--app-text)]">{selectedName}</h3></div><span className="rounded-full border border-[var(--app-border)] px-2 py-1 text-[10px] font-bold text-[var(--app-muted)]">{history.length} result{history.length === 1 ? "" : "s"}</span></div><div className="mt-3 rounded-lg bg-[var(--app-control-bg)] p-3"><MiniTrend rows={history} /></div><div className="mt-3 space-y-2">{history.slice(0, 8).map(row => <div key={row.id} className="flex items-center justify-between gap-3 border-b border-[var(--app-border)] pb-2 text-xs"><div><div className="font-bold text-[var(--app-text)]">{row.value_text || "—"} {row.unit || ""}</div><div className="text-[10px] text-[var(--app-muted)]">{fmt(row.collected_at)}</div></div><span className={`font-bold ${flagLevel(row.flag) === "critical" ? "text-red-600 dark:text-red-300" : flagLevel(row.flag) === "abnormal" ? "text-amber-600 dark:text-amber-300" : "text-emerald-600 dark:text-emerald-300"}`}>{flagLabel(row.flag)}</span></div>)}</div></> : null}</aside>
      </div>}
    </section>
    <p className="px-1 text-[10px] text-[var(--app-muted)]">This view shows received results only. Pending orders require an order-status feed from LIS/HIS.</p>
  </div>;
}
