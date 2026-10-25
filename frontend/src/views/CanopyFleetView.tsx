import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  getActiveFleetCases,
  getFleetCases,
  getFleetCaseSnapshot,
  getLegacyArchiveCases,
  getLegacyArchiveReportOptions,
  getLegacyArchiveSnapshot,
  getLeaves,
  type FleetCase,
  type FleetSnapshot,
  type LegacyArchiveCase,
  type LegacyReportCatalog,
  type LeafNode,
} from "../api/fleetApi";
import CanopyCaseChartView from "./CanopyCaseChartView";
import { groupLegacyReportFamilies } from "./canopy/legacyReportFamilies";

type SelectedCase =
  | { kind: "flora"; entry: FleetCase; snapshot: FleetSnapshot }
  | { kind: "innovian"; entry: FleetCase; archive: LegacyArchiveCase; snapshot: FleetSnapshot };

type CanopySection = "live" | "archive" | "legacy";

type ArchivePeriod = {
  from: string;
  to: string;
  label: string;
  valid: boolean;
  error?: string;
};

const sectionCopy: Record<CanopySection, { title: string; description: string; empty: string }> = {
  live: {
    title: "Live cases",
    description: "Active synchronized cases from Flora Leaf workstations.",
    empty: "No active cases are being synchronized.",
  },
  archive: {
    title: "Flora archive",
    description: "Completed Flora cases retained for central read-only review.",
    empty: "No completed Flora cases are available.",
  },
  legacy: {
    title: "Data archive",
    description: "Historical cases imported specifically from Innovian.",
    empty: "No Innovian cases have been imported yet.",
  },
};

function dateTime(value: string | number | null | undefined) {
  if (value == null) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : new Intl.DateTimeFormat(undefined, {
    day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit",
  }).format(date);
}

function parseArchivePeriod(input: string): ArchivePeriod {
  const raw = input.trim();
  if (!raw) return { from: "", to: "", label: "All dates", valid: true };

  const isoDate = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
  const isoMonth = /^(\d{4})-(\d{2})$/.exec(raw);
  const digits = raw.replace(/[\s./-]/g, "");
  let year: number;
  let month: number | null = null;
  let day: number | null = null;

  if (isoDate) {
    year = Number(isoDate[1]); month = Number(isoDate[2]); day = Number(isoDate[3]);
  } else if (isoMonth) {
    year = Number(isoMonth[1]); month = Number(isoMonth[2]);
  } else if (/^\d{4}$/.test(digits)) {
    year = Number(digits);
  } else if (/^\d{6}$/.test(digits)) {
    month = Number(digits.slice(0, 2)); year = Number(digits.slice(2));
  } else if (/^\d{8}$/.test(digits)) {
    day = Number(digits.slice(0, 2)); month = Number(digits.slice(2, 4)); year = Number(digits.slice(4));
  } else {
    return { from: "", to: "", label: "", valid: false, error: "Use YYYY, MMYYYY, or DDMMYYYY." };
  }

  if (year < 1900 || year > 2100) {
    return { from: "", to: "", label: "", valid: false, error: "Enter a year from 1900 to 2100." };
  }
  if (month == null) {
    return { from: `${year}-01-01`, to: `${year}-12-31`, label: `Entire year ${year}`, valid: true };
  }
  if (month < 1 || month > 12) {
    return { from: "", to: "", label: "", valid: false, error: "Month must be from 01 to 12." };
  }

  const yyyyMm = `${year}-${String(month).padStart(2, "0")}`;
  const monthLabel = new Intl.DateTimeFormat(undefined, { month: "long", year: "numeric", timeZone: "UTC" }).format(new Date(Date.UTC(year, month - 1, 1)));
  if (day == null) {
    const finalDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
    return { from: `${yyyyMm}-01`, to: `${yyyyMm}-${String(finalDay).padStart(2, "0")}`, label: monthLabel, valid: true };
  }

  const date = new Date(Date.UTC(year, month - 1, day));
  if (day < 1 || date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    return { from: "", to: "", label: "", valid: false, error: "That calendar date does not exist." };
  }
  const iso = `${yyyyMm}-${String(day).padStart(2, "0")}`;
  const label = new Intl.DateTimeFormat(undefined, { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" }).format(date);
  return { from: iso, to: iso, label, valid: true };
}

function freshness(value: string) {
  const seconds = Math.max(0, Math.floor((Date.now() - new Date(value).getTime()) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86_400)}d ago`;
}

function legacyFleetEntry(entry: LegacyArchiveCase): FleetCase {
  return {
    global_case_id: entry.id,
    hospital_id: "innovian-archive",
    leaf_id: "innovian-archive",
    leaf_name: "Data archive",
    source_case_id: entry.source_case_id,
    case_code: `Innovian #${entry.source_case_id}`,
    hn: entry.patient?.reference || null,
    status: "ARCHIVED",
    start_time: entry.started_at ? new Date(entry.started_at).getTime() : null,
    discharge_time: entry.completed_at ? new Date(entry.completed_at).getTime() : null,
    admission_source: "innovian",
    source_system: "Innovian",
    last_synced_at: entry.migration?.migrated_at || entry.completed_at || entry.started_at || new Date(0).toISOString(),
    sync_status: "offline",
  };
}

const statusTone: Record<string, string> = {
  ACTIVE: "border-emerald-500/45 bg-emerald-500/10 text-emerald-600 dark:text-emerald-300",
  DISCHARGED: "border-amber-500/45 bg-amber-500/10 text-amber-700 dark:text-amber-300",
  ARCHIVED: "border-[var(--app-border)] bg-[var(--app-control-bg)] text-[var(--app-muted)]",
};

function expectedReportLabels(catalog: LegacyReportCatalog) {
  return groupLegacyReportFamilies(catalog).map(report => report.code);
}

export default function CanopyFleetView() {
  const [section, setSection] = useState<CanopySection>("live");
  const [cases, setCases] = useState<FleetCase[]>([]);
  const [legacyCases, setLegacyCases] = useState<LegacyArchiveCase[]>([]);
  const [legacyReportCatalogs, setLegacyReportCatalogs] = useState<Record<string, LegacyReportCatalog | null>>({});
  const legacyReportCatalogsRef = useRef<Record<string, LegacyReportCatalog | null>>({});
  const [legacyQuery, setLegacyQuery] = useState("");
  // Live / Archive: filters the list (HN, AN, name, case code). Legacy: the archive search below.
  const [patientQuery, setPatientQuery] = useState("");
  // Live / Archive filters: case start date range (yyyy-mm-dd, inclusive) and workstation; applied by Canopy too,
  // so the archive is searched beyond the latest cases.
  const [rangeFrom, setRangeFrom] = useState("");
  const [rangeTo, setRangeTo] = useState("");
  const [leafFilter, setLeafFilter] = useState("");
  const [serverQuery, setServerQuery] = useState("");
  useEffect(() => {
    const timer = window.setTimeout(() => setServerQuery(patientQuery.trim()), 400);
    return () => window.clearTimeout(timer);
  }, [patientQuery]);
  const fromMs = rangeFrom ? new Date(`${rangeFrom}T00:00:00`).getTime() : undefined;
  const toMs = rangeTo ? new Date(`${rangeTo}T00:00:00`).getTime() + 86_400_000 : undefined;
  const [legacyPeriodInput, setLegacyPeriodInput] = useState("");
  const legacyPeriod = useMemo(() => parseArchivePeriod(legacyPeriodInput), [legacyPeriodInput]);
  const [legacyCursor, setLegacyCursor] = useState<string | null>(null);
  const [legacyHasMore, setLegacyHasMore] = useState(false);
  const [legacyLoading, setLegacyLoading] = useState(false);
  const [legacyLoaded, setLegacyLoaded] = useState(false);
  const [leaves, setLeaves] = useState<LeafNode[]>([]);
  const [selected, setSelected] = useState<SelectedCase | null>(null);
  const [loading, setLoading] = useState(true);
  const [openingId, setOpeningId] = useState("");
  const [error, setError] = useState("");
  const selectedRef = useRef<SelectedCase | null>(null);

  useEffect(() => {
    selectedRef.current = selected;
    window.dispatchEvent(new CustomEvent("flora:canopy-case-open-changed", { detail: { open: selected !== null } }));
  }, [selected]);

  useEffect(() => () => {
    window.dispatchEvent(new CustomEvent("flora:canopy-case-open-changed", { detail: { open: false } }));
  }, []);

  const openCase = useCallback(async (entry: FleetCase, quiet = false) => {
    if (!quiet) setOpeningId(entry.global_case_id);
    try {
      const snapshot = await getFleetCaseSnapshot(entry.global_case_id);
      setSelected({ kind: "flora", entry, snapshot });
      setError("");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "The synchronized chart could not be opened.");
    } finally {
      setOpeningId("");
    }
  }, []);

  const openLegacyCase = useCallback(async (archive: LegacyArchiveCase) => {
    setOpeningId(archive.id);
    try {
      const snapshot = await getLegacyArchiveSnapshot(archive.id);
      setSelected({ kind: "innovian", entry: legacyFleetEntry(archive), archive, snapshot });
      setError("");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "The data archive chart could not be opened.");
    } finally {
      setOpeningId("");
    }
  }, []);

  const loadLegacy = useCallback(async (append = false, cursor?: string | null) => {
    if (!legacyPeriod.valid) {
      setError(legacyPeriod.error || "Enter a valid archive period.");
      return;
    }
    setLegacyLoading(true);
    try {
      const result = await getLegacyArchiveCases({
        query: legacyQuery, from: legacyPeriod.from, to: legacyPeriod.to, limit: 50,
        cursor: append ? cursor || undefined : undefined,
      });
      setLegacyCases(current => append ? [...current, ...result.items] : result.items);
      setLegacyCursor(result.next_cursor || null);
      setLegacyHasMore(result.has_more);
      setLegacyLoaded(true);
      setError("");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "The data archive could not be loaded.");
    } finally {
      setLegacyLoading(false);
    }
  }, [legacyPeriod, legacyQuery]);

  const load = useCallback(async (quiet = false) => {
    if (!quiet) setLoading(true);
    try {
      const [active, recent, leafRows] = await Promise.all([
        getActiveFleetCases(), getFleetCases(500, undefined, { from: fromMs, to: toMs, q: serverQuery || undefined, leafId: leafFilter || undefined }), getLeaves(),
      ]);
      const merged = new Map<string, FleetCase>();
      [...active, ...recent].forEach(item => merged.set(item.global_case_id, item));
      const next = Array.from(merged.values()).sort((left, right) => {
        const activeRank = Number(right.status === "ACTIVE") - Number(left.status === "ACTIVE");
        return activeRank || new Date(right.last_synced_at).getTime() - new Date(left.last_synced_at).getTime();
      });
      setCases(next);
      setLeaves(leafRows);
      setError("");
      const currentSelection = selectedRef.current;
      if (currentSelection?.kind === "flora") {
        const current = next.find(item => item.global_case_id === currentSelection.entry.global_case_id);
        if (current) setSelected({ kind: "flora", entry: current, snapshot: await getFleetCaseSnapshot(current.global_case_id) });
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Canopy data could not be loaded.");
    } finally {
      setLoading(false);
    }
  }, [fromMs, toMs, serverQuery, leafFilter]);

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => void load(true), 10_000);
    return () => window.clearInterval(timer);
  }, [load]);

  useEffect(() => {
    if (section === "legacy" && !legacyLoaded && !legacyLoading) void loadLegacy();
  }, [legacyLoaded, legacyLoading, loadLegacy, section]);

  useEffect(() => {
    if (section !== "legacy" || legacyCases.length === 0) return;
    let cancelled = false;
    const pending = legacyCases.filter(entry => !(entry.id in legacyReportCatalogsRef.current));
    if (pending.length === 0) return;
    let nextIndex = 0;
    const worker = async () => {
      while (!cancelled) {
        const entry = pending[nextIndex++];
        if (!entry) return;
        try {
          const catalog = await getLegacyArchiveReportOptions(entry.id);
          if (!cancelled) setLegacyReportCatalogs(current => {
            const next = { ...current, [entry.id]: catalog };
            legacyReportCatalogsRef.current = next;
            return next;
          });
        } catch {
          if (!cancelled) setLegacyReportCatalogs(current => {
            const next = { ...current, [entry.id]: null };
            legacyReportCatalogsRef.current = next;
            return next;
          });
        }
      }
    };
    void Promise.all(Array.from({ length: Math.min(6, pending.length) }, worker));
    return () => { cancelled = true; };
  }, [legacyCases, section]);

  const leafMap = useMemo(() => new Map(leaves.map(leaf => [leaf.leaf_id, leaf])), [leaves]);
  const isInnovian = useCallback((entry: FleetCase) => {
    const source = `${entry.admission_source || ""} ${entry.source_system || ""}`.toLowerCase();
    return source.includes("innovian");
  }, []);
  const sectionCases = useMemo(() => cases.filter(entry => {
    const q = patientQuery.trim().toLowerCase();
    if (q && !`${entry.hn || ""} ${entry.an || ""} ${entry.patient_name || ""} ${entry.case_code || ""}`.toLowerCase().includes(q)) return false;
    if (leafFilter && entry.leaf_id !== leafFilter) return false;
    if (fromMs && (entry.start_time || 0) < fromMs) return false;
    if (toMs && (entry.start_time || 0) >= toMs) return false;
    if (section === "live") return entry.status === "ACTIVE";
    if (section === "legacy") return false;
    return entry.status !== "ACTIVE" && !isInnovian(entry);
  }), [cases, isInnovian, section, patientQuery, leafFilter, fromMs, toMs]);
  const counts = useMemo(() => ({
    live: cases.filter(entry => entry.status === "ACTIVE").length,
    archive: cases.filter(entry => entry.status !== "ACTIVE" && !isInnovian(entry)).length,
    legacy: legacyCases.length,
  }), [cases, isInnovian, legacyCases.length]);
  const changeSection = (next: CanopySection) => {
    setSection(next);
    setSelected(null);
  };
  // Tabs sit under the page title in the list; above an opened chart they stay a top bar.
  const canopyNavigation = (inline: boolean) => (
    <nav className={inline ? "border-b border-[var(--app-border)] pb-3" : "shrink-0 border-b border-[var(--app-border)] bg-[var(--app-panel-bg)] px-3 py-2 sm:px-5"} aria-label="Canopy records">
      <div className="flex w-full items-center gap-2">
        {(["live", "archive", "legacy"] as const).map(item => (
          <button
            key={item}
            type="button"
            onClick={() => changeSection(item)}
            aria-current={section === item ? "page" : undefined}
            className={`inline-flex min-h-10 items-center gap-2 rounded-xl border px-4 py-2 text-sm font-bold transition ${section === item ? "border-[var(--app-accent)] bg-[var(--app-accent)] text-[var(--app-accent-contrast)]" : "border-transparent text-[var(--app-muted)] hover:border-[var(--app-border)] hover:bg-[var(--app-control-bg)] hover:text-[var(--app-text)]"}`}
          >
            <span className={`h-2 w-2 rounded-full ${item === "live" ? "bg-emerald-400" : item === "archive" ? "bg-sky-400" : "bg-amber-400"}`} aria-hidden="true" />
            {item === "live" ? "Live" : item === "archive" ? "Archive" : "Legacy"}
            <span className={`rounded-full px-1.5 py-0.5 text-[10px] ${section === item ? "bg-black/15" : "bg-[var(--app-control-bg)]"}`}>{item === "legacy" && legacyHasMore ? `${counts[item]}+` : counts[item]}</span>
          </button>
        ))}
        <input type="search" value={section === "legacy" ? legacyQuery : patientQuery} aria-label="Search patient"
          onChange={event => (section === "legacy" ? setLegacyQuery : setPatientQuery)(event.target.value)}
          onKeyDown={event => { if (event.key === "Enter" && section === "legacy") void loadLegacy(); }}
          placeholder={section === "legacy" ? "Search archive (Enter)" : "Search patient (HN, AN, name)"}
          className="ml-auto h-10 w-72 max-w-[45vw] rounded-xl border border-[var(--app-border)] bg-[var(--app-control-bg)] px-3 text-sm text-[var(--app-text)] outline-none focus:border-[var(--app-accent)]" />
        <span className="hidden text-[10px] font-extrabold uppercase tracking-[0.14em] text-[var(--app-muted)] xl:block">Canopy · read-only</span>
      </div>
    </nav>
  );

  if (selected) {
    const refreshSelected = selected.kind === "innovian"
      ? () => void openLegacyCase(selected.archive)
      : () => void load();
    return <div className="flex h-full min-h-0 flex-col">{canopyNavigation(false)}<div className="min-h-0 flex-1"><CanopyCaseChartView entry={selected.entry} data={selected.snapshot} onBack={() => setSelected(null)} onRefresh={refreshSelected} refreshing={loading || legacyLoading} /></div></div>;
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-[var(--app-bg)]">
      <div className="min-h-0 flex-1 overflow-y-auto p-3 sm:p-5">
      <div className="w-full space-y-4">
        <header className="flex flex-wrap items-end justify-between gap-3">
          <div><div className="text-xs font-bold uppercase tracking-[0.16em] text-[var(--app-accent)]">{section === "legacy" ? "Historical Innovian records" : "Synchronized Flora records"}</div><h1 className="mt-1 text-2xl font-semibold text-[var(--app-text)]">{sectionCopy[section].title}</h1><p className="mt-1 text-sm text-[var(--app-muted)]">{sectionCopy[section].description}</p></div>
          <button type="button" onClick={() => section === "legacy" ? void loadLegacy() : void load()} disabled={loading || legacyLoading} className="rounded-xl border border-[var(--app-border)] bg-[var(--app-control-bg)] px-4 py-2.5 text-sm font-semibold text-[var(--app-text)] disabled:opacity-50">{loading || legacyLoading ? "Refreshing…" : "Refresh"}</button>
        </header>
        {canopyNavigation(true)}

        {error ? <div className="rounded-xl border border-rose-500/40 bg-rose-500/10 px-4 py-3 text-sm text-rose-600 dark:text-rose-300">{error}</div> : null}

        {section === "legacy" ? (
          <>
            <form className="grid items-start gap-3 rounded-2xl border border-[var(--app-border)] bg-[var(--app-panel-bg)] p-4 lg:grid-cols-[minmax(260px,1.25fr)_minmax(300px,.9fr)_auto]" onSubmit={event => { event.preventDefault(); void loadLegacy(); }}>
              <label className="block text-xs font-bold text-[var(--app-muted)]">Search archive<input value={legacyQuery} onChange={event => setLegacyQuery(event.target.value)} placeholder="HN, AN, patient, procedure or Innovian case" className="mt-1 block h-11 w-full rounded-xl border border-[var(--app-border)] bg-[var(--app-control-bg)] px-3 text-sm font-medium text-[var(--app-text)]" /></label>
              <div>
                <label className="block text-xs font-bold text-[var(--app-muted)]">Procedure period<input aria-label="Archive year, month, or exact date" inputMode="numeric" value={legacyPeriodInput} onChange={event => setLegacyPeriodInput(event.target.value)} placeholder="2023 · 052024 · 23042025" className={`mt-1 block h-11 w-full rounded-xl border bg-[var(--app-control-bg)] px-3 text-sm font-semibold text-[var(--app-text)] outline-none transition ${legacyPeriod.valid ? "border-[var(--app-border)] focus:border-[var(--app-accent)]" : "border-rose-500 focus:border-rose-500"}`} /></label>
                <div className={`mt-1 min-h-4 text-[11px] font-medium ${legacyPeriod.valid ? "text-[var(--app-muted)]" : "text-rose-600 dark:text-rose-300"}`}>{legacyPeriod.valid ? legacyPeriod.label : legacyPeriod.error}</div>
              </div>
              <div className="flex items-center justify-end gap-2 lg:pt-5">
                {legacyPeriodInput ? <button type="button" onClick={() => setLegacyPeriodInput("")} className="h-11 rounded-xl border border-[var(--app-border)] bg-[var(--app-control-bg)] px-4 text-sm font-semibold text-[var(--app-muted)] hover:text-[var(--app-text)]">Clear</button> : null}
                <button type="submit" disabled={legacyLoading || !legacyPeriod.valid} className="h-11 rounded-xl border border-[var(--app-accent)] bg-[var(--app-accent)] px-5 text-sm font-bold text-[var(--app-accent-contrast)] disabled:cursor-not-allowed disabled:opacity-50">Search</button>
              </div>
            </form>
            <section className="overflow-x-auto rounded-2xl border border-[var(--app-border)] bg-[var(--app-panel-bg)]">
              <table className="w-full min-w-[860px] table-fixed border-collapse">
                <colgroup>
                  <col className="w-[23%]" /><col className="w-[24%]" /><col className="w-[13%]" />
                  <col className="w-[20%]" /><col className="w-[10%]" /><col className="w-[10%]" />
                </colgroup>
                <thead><tr className="border-b border-[var(--app-border)] text-left text-[10px] font-extrabold uppercase tracking-[0.12em] text-[var(--app-muted)]">
                  <th className="px-3 py-3">Patient &amp; identifiers</th><th className="px-3 py-3">Procedure &amp; location</th><th className="px-3 py-3">Procedure time</th><th className="px-3 py-3">Available reports</th><th className="px-3 py-3">Migration</th><th className="px-3 py-3"><span className="sr-only">Actions</span></th>
                </tr></thead>
                <tbody>
              {legacyCases.map(entry => {
                const reportCatalog = legacyReportCatalogs[entry.id];
                const reportLabels = reportCatalog ? expectedReportLabels(reportCatalog) : [];
                return (
                <tr key={entry.id} className="border-b border-[var(--app-border)] align-top last:border-b-0 hover:bg-[var(--app-control-bg)]/45">
                  <td className="px-3 py-4"><div className="break-words text-sm font-bold leading-5 text-[var(--app-text)]">{entry.patient?.display_name || `HN ${entry.patient?.reference || "—"}`}</div><div className="mt-2 flex flex-wrap gap-1.5 text-[10px] text-[var(--app-muted)]"><span className="rounded-md bg-[var(--app-control-bg)] px-2 py-1">HN {entry.patient?.reference || "—"}</span><span className="rounded-md bg-[var(--app-control-bg)] px-2 py-1">AN {entry.patient?.encounter_number || "—"}</span><span className="rounded-md bg-[var(--app-control-bg)] px-2 py-1">Case {entry.source_case_id}</span></div></td>
                  <td className="px-3 py-4"><div className="break-words text-sm font-semibold leading-5 text-[var(--app-text)]">{entry.procedure?.name || "Procedure not mapped"}</div><div className="mt-1 text-xs text-[var(--app-muted)]">{entry.procedure?.location || entry.procedure?.care_unit || "Location unavailable"}</div></td>
                  <td className="px-3 py-4 text-xs leading-5 text-[var(--app-muted)]">{dateTime(entry.started_at)}</td>
                  <td className="px-3 py-4">
                    {reportCatalog === undefined ? <span className="text-xs text-[var(--app-muted)]">Checking report evidence…</span> : reportCatalog === null ? <span className="text-xs font-semibold text-amber-700 dark:text-amber-300">Report status unavailable</span> : reportLabels.length ? <><div className="flex flex-wrap gap-1">{reportLabels.map(label => <span key={label} className="rounded-md border border-sky-500/35 bg-sky-500/10 px-2 py-1 text-[10px] font-bold text-sky-700 dark:text-sky-300">{label}</span>)}</div><div className="mt-1 text-[10px] text-[var(--app-muted)]">{reportLabels.length} report type{reportLabels.length === 1 ? "" : "s"} identified from source evidence</div></> : <span className="text-xs font-semibold text-amber-700 dark:text-amber-300">No supported report identified</span>}
                  </td>
                  <td className="px-3 py-4"><span className={`inline-flex rounded-full border px-2 py-1 text-[10px] font-bold uppercase ${entry.migration?.status === "complete" ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-600 dark:text-emerald-300" : "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300"}`}>{entry.migration?.status || "unknown"}</span><div className="mt-1 text-[10px] text-[var(--app-muted)]">Legacy source</div></td>
                  <td className="px-3 py-4 text-right"><button type="button" onClick={() => void openLegacyCase(entry)} disabled={openingId === entry.id} className="min-w-[88px] rounded-lg border border-[var(--app-accent)] bg-[var(--app-accent)] px-2 py-2 text-xs font-bold text-[var(--app-accent-contrast)] disabled:opacity-50">{openingId === entry.id ? "Opening…" : "View chart"}</button></td>
                </tr>
              );})}
              {!legacyLoading && legacyCases.length === 0 ? <tr><td colSpan={6} className="px-6 py-16 text-center"><div className="text-lg font-semibold text-[var(--app-text)]">{sectionCopy.legacy.empty}</div><div className="mt-1 text-sm text-[var(--app-muted)]">Check the archive connection or broaden the search criteria.</div></td></tr> : null}
                </tbody>
              </table>
              {legacyHasMore ? <div className="border-t border-[var(--app-border)] p-4 text-center"><button type="button" disabled={legacyLoading || !legacyCursor} onClick={() => void loadLegacy(true, legacyCursor)} className="rounded-xl border border-[var(--app-border)] bg-[var(--app-control-bg)] px-5 py-2.5 text-sm font-bold text-[var(--app-text)] disabled:opacity-50">{legacyLoading ? "Loading…" : "Load 50 more"}</button></div> : null}
            </section>
          </>
        ) : (
          <>
          <CaseFilters from={rangeFrom} to={rangeTo} leafId={leafFilter} leaves={leaves}
            onChange={next => { setRangeFrom(next.from); setRangeTo(next.to); setLeafFilter(next.leafId); }} />
          <CaseStatistics rows={sectionCases} />
          <section className="overflow-hidden rounded-2xl border border-[var(--app-border)] bg-[var(--app-panel-bg)]">
            <div className="grid grid-cols-[minmax(0,1.5fr)_minmax(180px,.8fr)_140px_150px_96px] gap-3 border-b border-[var(--app-border)] px-4 py-3 text-[10px] font-extrabold uppercase tracking-[0.12em] text-[var(--app-muted)] max-lg:hidden"><span>Patient / case</span><span>Leaf</span><span>Started</span><span>Last sync</span><span /></div>
            {sectionCases.map(entry => {
              const leaf = leafMap.get(entry.leaf_id);
              return (
                <article key={entry.global_case_id} className="grid grid-cols-1 gap-3 border-b border-[var(--app-border)] px-4 py-4 last:border-b-0 lg:grid-cols-[minmax(0,1.5fr)_minmax(180px,.8fr)_140px_150px_96px] lg:items-center">
                  <div className="min-w-0"><div className="flex flex-wrap items-center gap-2"><strong className="truncate text-sm text-[var(--app-text)]">{entry.patient_name ? `${entry.patient_name} · ` : ""}HN {entry.hn || "—"}{entry.an ? ` · AN ${entry.an}` : ""}</strong><span className={`rounded-full border px-2 py-0.5 text-[10px] font-bold ${statusTone[entry.status] || statusTone.ARCHIVED}`}>{entry.status}</span></div><div className="mt-1 truncate text-xs text-[var(--app-muted)]">{entry.case_code || entry.source_case_id}</div></div>
                  <div><div className="text-sm font-semibold text-[var(--app-text)]">{entry.leaf_name || leaf?.display_name || entry.leaf_id}</div><div className="text-xs text-[var(--app-muted)]">{leaf?.connection_status || entry.sync_status}</div></div>
                  <div className="text-xs text-[var(--app-muted)]">{dateTime(entry.start_time)}</div>
                  <div className="text-xs text-[var(--app-muted)]"><span className="font-semibold text-[var(--app-text)]">{entry.sync_status}</span><br />{freshness(entry.last_synced_at)}</div>
                  <button type="button" onClick={() => void openCase(entry)} disabled={openingId === entry.global_case_id} className="rounded-lg border border-[var(--app-accent)] bg-[var(--app-accent)] px-3 py-2 text-xs font-bold text-[var(--app-accent-contrast)] disabled:opacity-50">{openingId === entry.global_case_id ? "Opening…" : "Open chart"}</button>
                </article>
              );
            })}
            {!loading && sectionCases.length === 0 ? <div className="px-6 py-16 text-center"><div className="text-lg font-semibold text-[var(--app-text)]">{sectionCopy[section].empty}</div><div className="mt-1 text-sm text-[var(--app-muted)]">Select another Canopy section or refresh after new records arrive.</div></div> : null}
          </section>
          </>
        )}
      </div>
      </div>
    </div>
  );
}

const isoDate = (ms: number) => { const d = new Date(ms); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };
const filterField = "h-10 rounded-xl border border-[var(--app-border)] bg-[var(--app-control-bg)] px-3 text-sm text-[var(--app-text)] outline-none focus:border-[var(--app-accent)]";

/** Case start period (with quick ranges) and workstation. */
function CaseFilters({ from, to, leafId, leaves, onChange }: {
  from: string; to: string; leafId: string; leaves: LeafNode[]; onChange: (next: { from: string; to: string; leafId: string }) => void;
}) {
  const preset = (days: number) => {
    const end = Date.now();
    onChange({ from: isoDate(end - (days - 1) * 86_400_000), to: isoDate(end), leafId });
  };
  const chip = "h-10 rounded-xl border border-[var(--app-border)] bg-[var(--app-control-bg)] px-3 text-sm font-semibold text-[var(--app-text)] hover:border-[var(--app-accent)]";
  return (
    <div className="flex flex-wrap items-end gap-2 rounded-2xl border border-[var(--app-border)] bg-[var(--app-panel-bg)] p-3">
      <label className="grid gap-1 text-xs font-bold text-[var(--app-muted)]">From<input type="date" data-no-picker className={filterField} value={from} onChange={event => onChange({ from: event.target.value, to, leafId })} /></label>
      <label className="grid gap-1 text-xs font-bold text-[var(--app-muted)]">To<input type="date" data-no-picker className={filterField} value={to} onChange={event => onChange({ from, to: event.target.value, leafId })} /></label>
      <button type="button" className={chip} onClick={() => preset(1)}>Today</button>
      <button type="button" className={chip} onClick={() => preset(7)}>7 days</button>
      <button type="button" className={chip} onClick={() => preset(30)}>30 days</button>
      <label className="grid gap-1 text-xs font-bold text-[var(--app-muted)]">Workstation
        <select className={filterField} value={leafId} onChange={event => onChange({ from, to, leafId: event.target.value })}>
          <option value="">All workstations</option>
          {leaves.map(leaf => <option key={leaf.leaf_id} value={leaf.leaf_id}>{leaf.display_name || leaf.leaf_id}</option>)}
        </select>
      </label>
      {from || to || leafId ? <button type="button" className={`${chip} text-[var(--app-muted)]`} onClick={() => onChange({ from: "", to: "", leafId: "" })}>Clear filters</button> : null}
    </div>
  );
}

/** Numbers for the cases shown: totals, case length and where they ran. */
function CaseStatistics({ rows }: { rows: FleetCase[] }) {
  const closed = rows.filter(row => row.status !== "ACTIVE");
  const lengths = closed.map(row => (row.discharge_time && row.start_time ? row.discharge_time - row.start_time : 0)).filter(ms => ms > 0);
  const average = lengths.length ? lengths.reduce((sum, ms) => sum + ms, 0) / lengths.length : 0;
  const hours = (ms: number) => (ms ? `${Math.floor(ms / 3_600_000)}h ${String(Math.round((ms % 3_600_000) / 60_000)).padStart(2, "0")}m` : "—");
  const byLeaf = new Map<string, number>();
  for (const row of rows) byLeaf.set(row.leaf_name || row.leaf_id, (byLeaf.get(row.leaf_name || row.leaf_id) || 0) + 1);
  const fromHis = rows.filter(row => /hl7|his/i.test(`${row.source_system || ""} ${row.admission_source || ""}`)).length;
  const tiles: Array<[string, string | number]> = [
    ["Cases", rows.length],
    ["Active", rows.filter(row => row.status === "ACTIVE").length],
    ["Discharged", closed.filter(row => row.status === "DISCHARGED").length],
    ["Archived", closed.filter(row => row.status === "ARCHIVED").length],
    ["Avg case length", hours(average)],
    ["Longest", hours(lengths.length ? Math.max(...lengths) : 0)],
    ["From HIS", fromHis],
    ["Workstations", byLeaf.size],
  ];
  return (
    <section className="rounded-2xl border border-[var(--app-border)] bg-[var(--app-panel-bg)] p-3" aria-label="Case statistics">
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 xl:grid-cols-8">
        {tiles.map(([label, value]) => (
          <div key={label} className="rounded-xl border border-[var(--app-border)] px-3 py-2">
            <div className="text-[10px] font-extrabold uppercase tracking-[0.12em] text-[var(--app-muted)]">{label}</div>
            <div className="text-xl font-bold text-[var(--app-text)]">{value}</div>
          </div>
        ))}
      </div>
      {byLeaf.size ? <div className="mt-2 flex flex-wrap gap-1.5 text-xs">
        {[...byLeaf.entries()].sort((a, b) => b[1] - a[1]).map(([name, count]) => (
          <span key={name} className="rounded-full border border-[var(--app-border)] px-2 py-0.5"><span className="text-[var(--app-muted)]">{name}</span> <b>{count}</b></span>
        ))}
      </div> : null}
    </section>
  );
}
