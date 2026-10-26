import { useEffect, useMemo, useState } from "react";
import {
  exportReport,
  getReportLibrary,
  getReportStaffOptions,
  runReport,
  type ReportCategory,
  type ReportDefinition,
  type ReportResult,
} from "../api/reportLibraryApi";

type Period = { from: string; to: string; label: string; valid: boolean; error?: string };

const categories: Array<{ id: "all" | ReportCategory; label: string }> = [
  { id: "all", label: "All reports" },
  { id: "clinical_timing", label: "Clinical timing" },
  { id: "clinical_summary", label: "Clinical summaries" },
  { id: "operations", label: "Operations" },
];

const categoryLabel: Record<ReportCategory, string> = {
  clinical_timing: "Clinical timing",
  clinical_summary: "Clinical summary",
  operations: "Operations",
};

/** dd/mm/yyyy (or ddmmyyyy) → ISO yyyy-mm-dd; "" when blank; null when invalid. */
function parseDayText(text: string): string | null {
  const raw = text.trim();
  if (!raw) return "";
  const match = /^(\d{1,2})[\s./-]?(\d{1,2})[\s./-]?(\d{4})$/.exec(raw);
  if (!match) return null;
  const [day, month, year] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const date = new Date(Date.UTC(year, month - 1, day));
  if (year < 1900 || year > 2100 || date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

const dayLabel = (iso: string) =>
  new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }).format(new Date(`${iso}T00:00:00Z`));
const dayText = (date: Date) =>
  `${String(date.getDate()).padStart(2, "0")}/${String(date.getMonth() + 1).padStart(2, "0")}/${date.getFullYear()}`;

/** Start and end dates (either may be blank for an open range). */
function parsePeriod(startText: string, endText: string): Period {
  const from = parseDayText(startText);
  const to = parseDayText(endText);
  if (from === null) return { from: "", to: "", label: "", valid: false, error: "Start date: use dd/mm/yyyy." };
  if (to === null) return { from: "", to: "", label: "", valid: false, error: "End date: use dd/mm/yyyy." };
  if (from && to && from > to) return { from: "", to: "", label: "", valid: false, error: "Start date is after the end date." };
  if (!from && !to) return { from: "", to: "", label: "All dates", valid: true };
  if (!to) return { from, to: "", label: `From ${dayLabel(from)}`, valid: true };
  if (!from) return { from: "", to, label: `Up to ${dayLabel(to)}`, valid: true };
  return { from, to, label: from === to ? dayLabel(from) : `${dayLabel(from)} – ${dayLabel(to)}`, valid: true };
}

/** One-click ranges for the period fields. */
function presetRange(preset: "month" | "lastMonth" | "year" | "all"): [string, string] {
  const now = new Date();
  if (preset === "all") return ["", ""];
  if (preset === "year") return [dayText(new Date(now.getFullYear(), 0, 1)), dayText(new Date(now.getFullYear(), 11, 31))];
  const offset = preset === "lastMonth" ? -1 : 0;
  return [dayText(new Date(now.getFullYear(), now.getMonth() + offset, 1)), dayText(new Date(now.getFullYear(), now.getMonth() + offset + 1, 0))];
}

function label(value: string) {
  return value.replace(/_/g, " ").replace(/\b\w/g, character => character.toUpperCase());
}

function display(value: unknown) {
  if (value == null || value === "") return "—";
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (typeof value === "number") return value.toLocaleString();
  const text = String(value);
  if (/^\d{4}-\d{2}-\d{2}T/.test(text)) {
    const date = new Date(text);
    if (!Number.isNaN(date.getTime())) return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(date);
  }
  return text;
}

export default function CanopyReportsView() {
  const [reports, setReports] = useState<ReportDefinition[]>([]);
  const [selected, setSelected] = useState<ReportDefinition | null>(null);
  const [category, setCategory] = useState<"all" | ReportCategory>("all");
  const [query, setQuery] = useState("");
  const [periodStart, setPeriodStart] = useState("");
  const [periodEnd, setPeriodEnd] = useState("");
  const [hn, setHn] = useState("");
  const [staff, setStaff] = useState("");
  const [role, setRole] = useState("");
  const [staffOptions, setStaffOptions] = useState<Array<{ name: string; role?: string | null }>>([]);
  const [staffRoles, setStaffRoles] = useState<string[]>([]);
  const [staffOpen, setStaffOpen] = useState(false);
  const [completeness, setCompleteness] = useState("all");
  const [result, setResult] = useState<ReportResult | null>(null);
  const [selection, setSelection] = useState<{ month: string; category: string } | null>(null);
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState("");
  const period = useMemo(() => parsePeriod(periodStart, periodEnd), [periodStart, periodEnd]);

  useEffect(() => {
    getReportLibrary().then(setReports).catch(reason => setError(reason instanceof Error ? reason.message : "Unable to load reports.")).finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      getReportStaffOptions(staff, role).then(options => {
        setStaffOptions(options.staff);
        setStaffRoles(options.roles);
        setStaffOpen(staff.trim().length >= 2 && options.staff.length > 0);
      }).catch(() => undefined);
    }, staff.trim() ? 180 : 0);
    return () => window.clearTimeout(timer);
  }, [role, staff]);

  const filtered = useMemo(() => reports.filter(report => {
    if (category !== "all" && report.category !== category) return false;
    const needle = query.trim().toLowerCase();
    return !needle || `${report.title} ${report.description}`.toLowerCase().includes(needle);
  }), [category, query, reports]);

  function params(page = 1, drilldown = selection) {
    const values = new URLSearchParams({ page: String(page), page_size: "50", completeness });
    if (period.from) values.set("from", period.from);
    if (period.to) values.set("to", period.to);
    if (hn.trim()) values.set("hn", hn.trim());
    if (staff.trim()) values.set("staff", staff.trim());
    if (role) values.set("role", role);
    if (selected?.definition.mode === "monthly_drilldown") {
      values.set("mode", drilldown ? "detail" : "summary");
      if (drilldown) {
        values.set("month", drilldown.month);
        values.set("category", drilldown.category);
      }
    }
    return values;
  }

  async function execute(page = 1, drilldown = selection) {
    if (!selected || !period.valid) return;
    setRunning(true); setError("");
    try {
      setResult(await runReport(selected.id, params(page, drilldown)));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Unable to run report.");
    } finally {
      setRunning(false);
    }
  }

  function openReport(report: ReportDefinition) {
    setSelected(report); setResult(null); setSelection(null); setError("");
  }

  if (!selected) {
    return <div className="h-full overflow-auto p-4 sm:p-6">
      <div className="w-full space-y-5">
        <header className="flex flex-wrap items-end justify-between gap-4">
          <div><div className="text-xs font-extrabold uppercase tracking-[0.16em] text-[var(--app-accent)]">Flora iCIS Canopy · reporting platform</div><h1 className="mt-1 text-3xl font-semibold text-[var(--app-text)]">Reports</h1><p className="mt-1 max-w-3xl text-sm text-[var(--app-muted)]">Run the prebuilt NIT reports and the reports your team builds in Report Studio. Both use the same report-definition model.</p></div>
          <div className="flex gap-2"><button type="button" disabled className="rounded-xl border border-[var(--app-border)] bg-[var(--app-control-bg)] px-4 py-2.5 text-sm font-bold text-[var(--app-muted)] opacity-70">Ask Flora · next</button><button type="button" disabled className="rounded-xl border border-[var(--app-accent)] bg-[var(--app-accent)] px-4 py-2.5 text-sm font-bold text-[var(--app-accent-contrast)] opacity-70">Create report · next</button></div>
        </header>
        <section className="grid gap-3 sm:grid-cols-3">
          <div className="rounded-2xl border border-[var(--app-border)] bg-[var(--app-panel-bg)] p-4"><div className="text-3xl font-bold text-[var(--app-text)]">{reports.filter(report => report.is_system).length}</div><div className="text-sm text-[var(--app-muted)]">Prebuilt definitions</div></div>
          <div className="rounded-2xl border border-[var(--app-border)] bg-[var(--app-panel-bg)] p-4"><div className="text-3xl font-bold text-[var(--app-text)]">{reports.filter(report => report.category !== "operations").length}</div><div className="text-sm text-[var(--app-muted)]">Clinical reports</div></div>
          <div className="rounded-2xl border border-[var(--app-border)] bg-[var(--app-panel-bg)] p-4"><div className="text-3xl font-bold text-[var(--app-text)]">{reports.filter(report => !report.is_system).length}</div><div className="text-sm text-[var(--app-muted)]">Built in Report Studio</div></div>
        </section>
        <section className="rounded-2xl border border-[var(--app-border)] bg-[var(--app-panel-bg)] p-4">
          <div className="grid gap-3 lg:grid-cols-[1fr_auto]">
            <input value={query} onChange={event => setQuery(event.target.value)} placeholder="Search reports" className="h-11 rounded-xl border border-[var(--app-border)] bg-[var(--app-control-bg)] px-3 text-sm text-[var(--app-text)]" />
            <div className="flex flex-wrap gap-2">{categories.map(item => <button key={item.id} type="button" onClick={() => setCategory(item.id)} className={`h-11 rounded-xl border px-3 text-sm font-semibold ${category === item.id ? "border-[var(--app-accent)] bg-[var(--app-accent)] text-[var(--app-accent-contrast)]" : "border-[var(--app-border)] bg-[var(--app-control-bg)] text-[var(--app-text)]"}`}>{item.label}</button>)}</div>
          </div>
        </section>
        {error ? <div className="rounded-xl border border-rose-500/40 bg-rose-500/10 p-3 text-sm text-rose-600 dark:text-rose-300">{error}</div> : null}
        <section className="overflow-hidden rounded-2xl border border-[var(--app-border)] bg-[var(--app-panel-bg)]">
          <div className="grid grid-cols-[minmax(0,1fr)_180px_120px] gap-3 border-b border-[var(--app-border)] px-4 py-3 text-xs font-extrabold uppercase tracking-[0.12em] text-[var(--app-muted)]"><span>Report</span><span>Category</span><span className="text-right">Action</span></div>
          {loading ? <div className="p-8 text-center text-sm text-[var(--app-muted)]">Loading report library…</div> : filtered.map(report => <div key={report.id} className="grid grid-cols-1 gap-3 border-b border-[var(--app-border)] px-4 py-4 last:border-0 sm:grid-cols-[minmax(0,1fr)_180px_120px] sm:items-center"><div><div className="flex flex-wrap items-center gap-2"><strong className="text-base text-[var(--app-text)]">{report.title}</strong>{report.is_system ? <span className="rounded-full border border-sky-500/35 bg-sky-500/10 px-2 py-0.5 text-[10px] font-bold text-sky-700 dark:text-sky-300">PREBUILT</span> : <span className="rounded-full border border-emerald-500/35 bg-emerald-500/10 px-2 py-0.5 text-[10px] font-bold text-emerald-700 dark:text-emerald-300">REPORT STUDIO</span>}</div><p className="mt-1 text-sm text-[var(--app-muted)]">{report.description}</p></div><span className="text-sm font-semibold text-[var(--app-muted)]">{categoryLabel[report.category]}</span><button type="button" onClick={() => openReport(report)} className="h-10 rounded-xl border border-[var(--app-accent)] bg-[var(--app-accent)] px-4 text-sm font-bold text-[var(--app-accent-contrast)]">Open</button></div>)}
        </section>
      </div>
    </div>;
  }

  const rows = result?.rows || [];
  // Report Studio results name their columns; prebuilt reports use the row keys.
  const columnLabels = Object.fromEntries((result?.columns || []).map(column => [column.key, column.label]));
  const columns = result?.columns?.length ? result.columns.map(column => column.key) : rows.length ? Object.keys(rows[0]) : [];
  const pagination = result?.pagination;
  return <div className="h-full overflow-auto p-4 sm:p-6"><div className="w-full space-y-4">
    <header className="sticky top-0 z-20 -mx-4 -mt-4 flex flex-wrap items-start justify-between gap-3 border-b border-[var(--app-border)] bg-[var(--app-bg)] px-4 py-4 shadow-sm sm:-mx-6 sm:-mt-6 sm:px-6"><div><button type="button" onClick={() => setSelected(null)} className="mb-2 text-sm font-bold text-[var(--app-accent)]">← Report library</button><div className="text-xs font-extrabold uppercase tracking-[0.14em] text-[var(--app-accent)]">{categoryLabel[selected.category]} · Prebuilt definition</div><h1 className="mt-1 text-2xl font-semibold text-[var(--app-text)]">{selected.title}</h1><p className="mt-1 text-sm text-[var(--app-muted)]">{selected.description}</p></div><div className="flex gap-2"><button type="button" disabled={!result || running} onClick={() => void exportReport(selected.id, params(), "csv")} className="rounded-xl border border-[var(--app-border)] bg-[var(--app-control-bg)] px-3 py-2 text-sm font-bold text-[var(--app-text)] disabled:opacity-40">CSV</button><button type="button" disabled={!result || running} onClick={() => void exportReport(selected.id, params(), "xlsx")} className="rounded-xl border border-[var(--app-border)] bg-[var(--app-control-bg)] px-3 py-2 text-sm font-bold text-[var(--app-text)] disabled:opacity-40">Excel</button></div></header>
    <section className="rounded-2xl border border-[var(--app-border)] bg-[var(--app-panel-bg)] p-4">
      <div className="grid gap-x-3 gap-y-4 md:grid-cols-3 2xl:grid-cols-[minmax(190px,1.05fr)_minmax(160px,.8fr)_minmax(210px,1fr)_minmax(180px,.8fr)_170px_auto]">
        <div className="text-xs font-bold text-[var(--app-muted)]">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span>Report period</span>
            {/* Quick ranges; the date fields open a calendar on desktop (DateTimePickerAssist). */}
            <span className="flex gap-1">{([["month", "This month"], ["lastMonth", "Last month"], ["year", "This year"], ["all", "All dates"]] as const).map(([preset, label]) =>
              <button key={preset} type="button" onClick={() => { const [start, end] = presetRange(preset); setPeriodStart(start); setPeriodEnd(end); }}
                className="rounded-full border border-[var(--app-border)] px-2 py-0.5 text-[10px] font-semibold text-[var(--app-muted)] hover:border-[var(--app-accent)] hover:text-[var(--app-text)]">{label}</button>)}</span>
          </div>
          <div className="mt-1 grid grid-cols-[1fr_auto_1fr] items-center gap-2">
            <input aria-label="Start date" value={periodStart} onChange={event => setPeriodStart(event.target.value)} placeholder="dd/mm/yyyy" inputMode="numeric"
              className={`block h-11 w-full rounded-xl border bg-[var(--app-control-bg)] px-3 text-sm tabular-nums text-[var(--app-text)] ${period.valid || period.error?.startsWith("End") ? "border-[var(--app-border)]" : "border-rose-500"}`} />
            <span className="text-[var(--app-muted)]">to</span>
            <input aria-label="End date" value={periodEnd} onChange={event => setPeriodEnd(event.target.value)} placeholder="dd/mm/yyyy" inputMode="numeric"
              className={`block h-11 w-full rounded-xl border bg-[var(--app-control-bg)] px-3 text-sm tabular-nums text-[var(--app-text)] ${period.valid || period.error?.startsWith("Start date:") ? "border-[var(--app-border)]" : "border-rose-500"}`} />
          </div>
          <span className={`mt-1 block min-h-[18px] font-medium ${period.valid ? "text-[var(--app-muted)]" : "text-rose-500"}`}>{period.valid ? period.label : period.error}</span>
        </div>
        <label className="text-xs font-bold text-[var(--app-muted)]">HN<input value={hn} onChange={event => setHn(event.target.value)} placeholder="HN or part of HN" className="mt-1 block h-11 w-full rounded-xl border border-[var(--app-border)] bg-[var(--app-control-bg)] px-3 text-sm text-[var(--app-text)]" /><span className="mt-1 block min-h-[18px] font-medium">Partial match</span></label>
        <label className="relative text-xs font-bold text-[var(--app-muted)]">Staff name<input value={staff} onChange={event => { setStaff(event.target.value); setStaffOpen(event.target.value.trim().length >= 2); }} onFocus={() => setStaffOpen(staff.trim().length >= 2 && staffOptions.length > 0)} onBlur={() => window.setTimeout(() => setStaffOpen(false), 120)} placeholder="Type at least 2 characters" autoComplete="off" className="mt-1 block h-11 w-full rounded-xl border border-[var(--app-border)] bg-[var(--app-control-bg)] px-3 text-sm text-[var(--app-text)]" />{staffOpen ? <div className="absolute left-0 right-0 top-[66px] z-30 max-h-64 overflow-auto rounded-xl border border-[var(--app-border)] bg-[var(--app-panel-bg)] p-1.5 shadow-2xl">{staffOptions.slice(0, 8).map(option => <button key={`${option.name}-${option.role || ""}`} type="button" onMouseDown={event => event.preventDefault()} onClick={() => { setStaff(option.name); setStaffOpen(false); }} className="flex w-full items-center justify-between gap-3 rounded-lg px-3 py-2 text-left hover:bg-[var(--app-control-bg)]"><span className="truncate text-sm font-semibold text-[var(--app-text)]">{option.name}</span><span className="shrink-0 rounded-full border border-[var(--app-border)] px-2 py-0.5 text-[10px] font-bold text-[var(--app-muted)]">{option.role || "No role"}</span></button>)}</div> : null}<span className="mt-1 block min-h-[18px] font-medium">Searches staff master and archive</span></label>
        <label className="text-xs font-bold text-[var(--app-muted)]">Staff role<select value={role} onChange={event => { setRole(event.target.value); setStaff(""); setStaffOpen(false); }} className="mt-1 block h-11 w-full rounded-xl border border-[var(--app-border)] bg-[var(--app-control-bg)] px-3 text-sm text-[var(--app-text)]"><option value="">Any role</option>{staffRoles.map(item => <option key={item} value={item}>{item}</option>)}</select><span className="mt-1 block min-h-[18px] font-medium">Assigned role in case</span></label>
        <label className="text-xs font-bold text-[var(--app-muted)]">Data status<select value={completeness} onChange={event => setCompleteness(event.target.value)} className="mt-1 block h-11 w-full rounded-xl border border-[var(--app-border)] bg-[var(--app-control-bg)] px-3 text-sm text-[var(--app-text)]"><option value="all">All records</option><option value="complete">Complete</option><option value="incomplete">Incomplete</option></select><span className="mt-1 block min-h-[18px] font-medium">Completeness filter</span></label>
        <div><span className="block text-xs font-bold text-transparent" aria-hidden="true">Action</span><button type="button" disabled={running || !period.valid} onClick={() => { setSelection(null); void execute(1, null); }} className="mt-1 h-11 w-full whitespace-nowrap rounded-xl border border-[var(--app-accent)] bg-[var(--app-accent)] px-5 text-sm font-bold text-[var(--app-accent-contrast)] disabled:opacity-50">{running ? "Running…" : "Run report"}</button><span className="mt-1 block min-h-[18px]" aria-hidden="true">&nbsp;</span></div>
      </div>
    </section>
    {selection ? <div className="flex items-center justify-between rounded-xl border border-sky-500/30 bg-sky-500/10 px-4 py-3 text-sm"><span><strong>{selection.month}</strong> · {selection.category}</span><button type="button" onClick={() => { setSelection(null); void execute(1, null); }} className="font-bold text-[var(--app-accent)]">Back to summary</button></div> : null}
    {error ? <div className="rounded-xl border border-rose-500/40 bg-rose-500/10 p-3 text-sm text-rose-600 dark:text-rose-300">{error}</div> : null}
    {result?.summary ? <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">{Object.entries(result.summary).map(([key, value]) => <div key={key} className="rounded-2xl border border-[var(--app-border)] bg-[var(--app-panel-bg)] p-4"><div className="text-2xl font-bold text-[var(--app-text)]">{display(value)}</div><div className="mt-1 text-xs font-bold uppercase tracking-[0.1em] text-[var(--app-muted)]">{label(key)}</div></div>)}</section> : null}
    {result ? <section className="overflow-hidden rounded-2xl border border-[var(--app-border)] bg-[var(--app-panel-bg)]"><div className="overflow-auto"><table className="min-w-full text-left text-sm"><thead className="sticky top-0 bg-[var(--app-control-bg)]"><tr>{columns.map(column => <th key={column} className="whitespace-nowrap border-b border-[var(--app-border)] px-3 py-3 text-xs font-extrabold uppercase tracking-[0.08em] text-[var(--app-muted)]">{columnLabels[column] ?? label(column)}</th>)}</tr></thead><tbody>{rows.map((row, index) => <tr key={String(row.record_id || row.poid || `${index}`)} className="border-b border-[var(--app-border)] last:border-0 hover:bg-[var(--app-control-bg)]" onClick={() => { if (selected.definition.mode === "monthly_drilldown" && result.mode === "summary" && row.month && row.category) { const next = { month: String(row.month), category: String(row.category) }; setSelection(next); void execute(1, next); } }}>{columns.map(column => <td key={column} className="max-w-[360px] whitespace-nowrap px-3 py-3 text-[var(--app-text)]">{display(row[column])}</td>)}</tr>)}</tbody></table></div>{rows.length === 0 ? <div className="p-10 text-center text-sm text-[var(--app-muted)]">No matching records.</div> : null}{pagination ? <footer className="flex items-center justify-between border-t border-[var(--app-border)] px-4 py-3 text-sm text-[var(--app-muted)]"><span>{pagination.total.toLocaleString()} rows</span><div className="flex items-center gap-3"><button type="button" disabled={running || pagination.page <= 1} onClick={() => void execute(pagination.page - 1)} className="font-bold disabled:opacity-30">Previous</button><span>{pagination.page} / {pagination.total_pages}</span><button type="button" disabled={running || pagination.page >= pagination.total_pages} onClick={() => void execute(pagination.page + 1)} className="font-bold disabled:opacity-30">Next</button></div></footer> : null}</section> : <div className="rounded-2xl border border-dashed border-[var(--app-border)] p-12 text-center text-sm text-[var(--app-muted)]">Choose a period or leave it blank for all dates, then run the report.</div>}
  </div></div>;
}
