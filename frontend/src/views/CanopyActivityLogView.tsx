import { Fragment, useCallback, useEffect, useState } from "react";
import { getActivity, type ActivityPage, type ActivityRow } from "../api/activityApi";

/** Administrator → Logs: every sign-in, write and chart opened on Canopy, filtered by period, user and type. */

const PAGE = 200;
const input = "h-10 rounded-xl border border-[var(--app-border)] bg-[var(--app-control-bg)] px-3 text-sm text-[var(--app-text)] outline-none focus:border-[var(--app-accent)]";
const localDate = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const daysAgo = (days: number) => { const d = new Date(); d.setDate(d.getDate() - days); return localDate(d); };
const stamp = (ts: number) => new Date(ts).toLocaleString([], { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" });
const LABEL: Record<string, string> = {
  "sign-in": "Sign-in", users: "Users", preferences: "Preferences", configuration: "Configuration", admission: "Admission",
  "or-schedule": "OR schedule", billing: "Billing", staff: "Staff", devices: "Devices", integration: "Integration",
  "workflow-studio": "Workflow Studio", "form-studio": "Form Studio", "report-studio": "Report Studio", report: "Reports",
  "chart-view": "Chart opened", "ai-studio": "AI Studio", platform: "Platform", "public-api": "Public API", other: "Other",
};

function Stat({ label, value, tone }: { label: string; value: number; tone?: string }) {
  return <div className="rounded-2xl border border-[var(--app-border)] bg-[var(--app-panel-bg)] px-4 py-3">
    <div className="text-[10px] font-extrabold uppercase tracking-[0.14em] text-[var(--app-muted)]">{label}</div>
    <div className={`mt-1 text-2xl font-semibold ${tone || ""}`}>{value.toLocaleString()}</div>
  </div>;
}

export default function CanopyActivityLogView() {
  const [range, setRange] = useState(() => ({ from: daysAgo(7), to: localDate(new Date()) }));
  const [q, setQ] = useState("");
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("");
  const [outcome, setOutcome] = useState<"" | "ok" | "failed">("");
  const [page, setPage] = useState<ActivityPage | null>(null);
  const [extra, setExtra] = useState<ActivityRow[]>([]);
  const [open, setOpen] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  // Typing searches after a short pause.
  useEffect(() => { const timer = window.setTimeout(() => setQuery(q.trim()), 300); return () => window.clearTimeout(timer); }, [q]);

  const filter = useCallback((offset: number) => ({
    from: range.from ? new Date(`${range.from}T00:00:00`).getTime() : undefined,
    to: range.to ? new Date(`${range.to}T00:00:00`).getTime() + 86400000 : undefined,
    q: query || undefined, category: category || undefined, outcome: outcome || undefined, limit: PAGE, offset,
  }), [category, outcome, query, range]);

  const load = useCallback(() => {
    // Deferred one tick: the effect below must not set state synchronously.
    void Promise.resolve().then(() => { setLoading(true); return getActivity(filter(0)); })
      .then(result => { setPage(result); setExtra([]); setError(""); })
      .catch(err => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setLoading(false));
  }, [filter]);
  useEffect(() => { load(); }, [load]);

  const rows = [...(page?.rows || []), ...extra];
  const more = () => {
    setLoading(true);
    getActivity(filter(rows.length)).then(result => setExtra(current => [...current, ...result.rows]))
      .catch(err => setError(err instanceof Error ? err.message : String(err))).finally(() => setLoading(false));
  };
  const preset = (days: number) => setRange({ from: daysAgo(days), to: localDate(new Date()) });
  const stats = page?.stats;

  return (
    <div className="app-theme-scope w-full space-y-4 p-3 sm:p-5 pb-24 text-[var(--app-text)]">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <div className="text-xs font-extrabold uppercase tracking-[0.16em] text-[var(--app-accent)]">ESM Flora Canopy · administration</div>
          <h1 className="mt-1 text-2xl font-semibold">Activity log</h1>
          <p className="mt-1 text-sm text-[var(--app-muted)]">Sign-ins (also failed ones), sign-outs, every change made on Canopy, charts opened and reports printed, plus user changes from Leafs. Request contents are not stored.</p>
        </div>
        <button type="button" onClick={load} disabled={loading} className="rounded-xl border border-[var(--app-border)] bg-[var(--app-control-bg)] px-4 py-2.5 text-sm font-semibold disabled:opacity-50">{loading ? "Refreshing…" : "Refresh"}</button>
      </header>

      <div className="flex flex-wrap items-end gap-2 rounded-2xl border border-[var(--app-border)] bg-[var(--app-panel-bg)] p-3">
        <label className="grid gap-1 text-xs font-semibold">From<input type="date" data-no-picker value={range.from} onChange={e => setRange(r => ({ ...r, from: e.target.value }))} className={input} /></label>
        <label className="grid gap-1 text-xs font-semibold">To<input type="date" data-no-picker value={range.to} onChange={e => setRange(r => ({ ...r, to: e.target.value }))} className={input} /></label>
        <div className="flex gap-1">
          {([["Today", 0], ["7 days", 7], ["30 days", 30], ["90 days", 90]] as const).map(([label, days]) =>
            <button key={label} type="button" onClick={() => preset(days)} className="h-10 rounded-xl border border-[var(--app-border)] px-3 text-sm font-semibold hover:bg-[var(--app-control-bg)]">{label}</button>)}
        </div>
        <label className="grid min-w-[220px] flex-1 gap-1 text-xs font-semibold">User / search
          <input type="search" value={q} onChange={e => setQ(e.target.value)} placeholder="Username, name, action or IP" className={input} /></label>
        <label className="grid gap-1 text-xs font-semibold">Outcome
          <select value={outcome} onChange={e => setOutcome(e.target.value as "" | "ok" | "failed")} className={input}>
            <option value="">All</option><option value="ok">Succeeded</option><option value="failed">Failed</option>
          </select></label>
        <button type="button" onClick={() => { setQ(""); setCategory(""); setOutcome(""); preset(7); }} className="h-10 rounded-xl px-3 text-sm font-semibold text-[var(--app-muted)] hover:text-[var(--app-text)]">Clear</button>
      </div>

      {stats ? <div className="grid gap-2 sm:grid-cols-3 xl:grid-cols-5">
        <Stat label="Activities" value={stats.total} />
        <Stat label="Users" value={stats.users} />
        <Stat label="Sign-ins" value={stats.sign_ins} />
        <Stat label="Failed sign-ins" value={stats.failed_sign_ins} tone={stats.failed_sign_ins ? "text-rose-500" : ""} />
        <Stat label="Failed actions" value={stats.failed} tone={stats.failed ? "text-amber-500" : ""} />
      </div> : null}

      {page?.categories.length ? <div className="flex flex-wrap gap-1.5">
        <button type="button" onClick={() => setCategory("")} className={`rounded-full border px-3 py-1 text-xs font-bold ${!category ? "border-[var(--app-accent)] bg-[var(--app-accent)] text-[var(--app-accent-contrast)]" : "border-[var(--app-border)]"}`}>All · {stats?.total ?? 0}</button>
        {page.categories.map(c => <button key={c.category} type="button" onClick={() => setCategory(c.category === category ? "" : c.category)}
          className={`rounded-full border px-3 py-1 text-xs font-bold ${category === c.category ? "border-[var(--app-accent)] bg-[var(--app-accent)] text-[var(--app-accent-contrast)]" : "border-[var(--app-border)]"}`}>{LABEL[c.category] || c.category} · {c.count}</button>)}
      </div> : null}

      {error ? <div className="rounded-xl border border-rose-500/40 bg-rose-500/10 px-4 py-3 text-sm text-rose-500">{error}</div> : null}

      <div className="overflow-auto rounded-2xl border border-[var(--app-border)] bg-[var(--app-panel-bg)]">
        <table className="w-full text-sm">
          <thead className="bg-[var(--app-accent)]/10 text-left text-[11px] uppercase tracking-[0.08em]">
            <tr><th className="p-2">Time</th><th className="p-2">User</th><th className="p-2">Type</th><th className="p-2">Activity</th><th className="p-2">Result</th><th className="p-2">From</th></tr>
          </thead>
          <tbody>
            {rows.map(row => {
              const key = `${row.source}:${row.id}`;
              return <Fragment key={key}>
                <tr onClick={() => setOpen(open === key ? null : key)} className="cursor-pointer border-t border-[var(--app-border)] hover:bg-[var(--app-accent)]/5">
                  <td className="whitespace-nowrap p-2 tabular-nums">{stamp(row.at)}</td>
                  <td className="p-2">{row.username || <span className="text-[var(--app-muted)]">—</span>}{row.user_name || row.role ? <div className="text-xs text-[var(--app-muted)]">{[row.user_name, row.role].filter(Boolean).join(" · ")}</div> : null}</td>
                  <td className="p-2"><span className="rounded-full bg-[var(--app-control-bg)] px-2 py-0.5 text-xs font-bold">{LABEL[row.category] || row.category}</span>{row.source === "directory" ? <div className="mt-0.5 text-[10px] text-[var(--app-muted)]">Leaf directory</div> : null}</td>
                  <td className="max-w-[520px] break-words p-2">{row.action}</td>
                  <td className="p-2"><span className={`rounded-full px-2 py-0.5 text-xs font-bold ${row.ok ? "bg-emerald-500/15 text-emerald-600" : "bg-rose-500/15 text-rose-500"}`}>{row.ok ? "OK" : "Failed"}{row.status ? ` · ${row.status}` : ""}</span></td>
                  <td className="p-2 text-xs text-[var(--app-muted)]">{row.ip || "—"}</td>
                </tr>
                {open === key ? <tr className="bg-[var(--app-control-bg)]/40"><td colSpan={6} className="p-3 text-xs">
                  <div className="grid gap-1 sm:grid-cols-2">
                    {row.method ? <div><b>Request</b> {row.method} {row.path}{row.query ? `?${row.query}` : ""}</div> : null}
                    {row.duration_ms != null ? <div><b>Duration</b> {row.duration_ms} ms</div> : null}
                    {row.user_agent ? <div className="sm:col-span-2"><b>Client</b> {row.user_agent}</div> : null}
                    {row.detail ? <pre className="overflow-auto whitespace-pre-wrap rounded-lg bg-[var(--app-panel-bg)] p-2 sm:col-span-2">{JSON.stringify(row.detail, null, 2)}</pre> : null}
                  </div>
                </td></tr> : null}
              </Fragment>;
            })}
            {!rows.length && !loading ? <tr><td colSpan={6} className="p-6 text-center text-[var(--app-muted)]">No activity in this period.</td></tr> : null}
          </tbody>
        </table>
      </div>
      {page && rows.length < page.total ? <div className="flex items-center justify-center gap-3 text-sm">
        <span className="text-[var(--app-muted)]">{rows.length.toLocaleString()} of {page.total.toLocaleString()}</span>
        <button type="button" onClick={more} disabled={loading} className="rounded-xl border border-[var(--app-border)] px-4 py-2 font-semibold disabled:opacity-50">Load more</button>
      </div> : null}
    </div>
  );
}
