import { useEffect, useMemo, useState } from "react";
import {
  getEphisDailyCases,
  getEphisDailySummary,
  getEphisImportStatus,
  importEphisDailyCases,
  type EphisDailyCaseRow,
  type EphisDailySummaryRow,
  type EphisImportStatus,
} from "../api/ephisApi";
import { useWorkstationSettings } from "../hooks/useWorkstationSettings";
import { formatConfiguredDateTime } from "../utils/dateTime";

function parseDateTime(value: string | null) {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.getTime();
}

export default function EphisView() {
  const workstation = useWorkstationSettings();
  const displayDateTime = (value: string | null) => {
    const timestamp = parseDateTime(value);
    return typeof timestamp === "number" ? formatConfiguredDateTime(timestamp, workstation) : timestamp;
  };
  const [tsvText, setTsvText] = useState("");
  const [replaceExisting, setReplaceExisting] = useState(true);
  const [loading, setLoading] = useState(true);
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [status, setStatus] = useState<EphisImportStatus | null>(null);
  const [summaryRows, setSummaryRows] = useState<EphisDailySummaryRow[]>([]);
  const [selectedDate, setSelectedDate] = useState("");
  const [detailRows, setDetailRows] = useState<EphisDailyCaseRow[]>([]);
  const [hnFilter, setHnFilter] = useState("");
  const [fromDate, setFromDate] = useState("");
  const [toDate, setToDate] = useState("");

  async function loadSummary(nextSelectedDate?: string) {
    const [nextStatus, nextSummary] = await Promise.all([
      getEphisImportStatus(),
      getEphisDailySummary({ from: fromDate, to: toDate }),
    ]);
    setStatus(nextStatus);
    setSummaryRows(nextSummary);

    const pickedDate =
      nextSelectedDate ||
      (nextSummary.some(row => row.admit_date === selectedDate) ? selectedDate : nextSummary[0]?.admit_date || "");
    setSelectedDate(pickedDate);

    if (pickedDate) {
      const rows = await getEphisDailyCases({ admit_date: pickedDate, hn: hnFilter });
      setDetailRows(rows);
    } else {
      setDetailRows([]);
    }
  }

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError("");
    loadSummary()
      .catch(err => {
        if (!alive) return;
        setError(err instanceof Error ? err.message : "Failed to load ePHIS data");
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
    // Initial loading intentionally uses the empty filter values from mount;
    // later filtered refreshes are initiated explicitly by the UI controls.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!selectedDate) {
      setDetailRows([]);
      return;
    }
    let alive = true;
    getEphisDailyCases({ admit_date: selectedDate, hn: hnFilter })
      .then(rows => {
        if (alive) setDetailRows(rows);
      })
      .catch(err => {
        if (alive) setError(err instanceof Error ? err.message : "Failed to load daily cases");
      });
    return () => {
      alive = false;
    };
  }, [selectedDate, hnFilter]);

  const totalVisibleCases = useMemo(
    () => summaryRows.reduce((sum, row) => sum + row.case_count, 0),
    [summaryRows],
  );

  async function handleImport() {
    setImporting(true);
    setError("");
    setSuccess("");
    try {
      const result = await importEphisDailyCases(tsvText, replaceExisting);
      setSuccess(
        `Imported ${result.imported_rows} rows covering ${result.first_admit_date || "-"} to ${
          result.last_admit_date || "-"
        }.`,
      );
      setTsvText("");
      await loadSummary();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Import failed");
    } finally {
      setImporting(false);
    }
  }

  async function handleApplyFilters() {
    setLoading(true);
    setError("");
    try {
      await loadSummary();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to refresh daily summary");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="w-full space-y-4 p-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold text-[var(--app-text)]">ePHIS Daily Cases</h1>
          <p className="text-sm text-[var(--app-muted)]">
            Import SSMS TSV exports first. PDF comparison can layer onto this dataset next.
          </p>
        </div>
        <div className="rounded-lg border border-[var(--app-border)] bg-[var(--app-panel-bg)] px-3 py-2 text-xs text-[var(--app-muted)]">
          <div>Total imported rows: {status?.total_rows || 0}</div>
          <div>Last import: {status?.last_imported_at ? formatConfiguredDateTime(status.last_imported_at, workstation) : "No import yet"}</div>
        </div>
      </div>

      {error ? <div className="rounded border border-red-400/50 bg-red-500/10 px-3 py-2 text-sm text-red-300">{error}</div> : null}
      {success ? <div className="rounded border border-emerald-400/50 bg-emerald-500/10 px-3 py-2 text-sm text-emerald-200">{success}</div> : null}

      <section className="grid gap-4 xl:grid-cols-[1.05fr_1.4fr]">
        <div className="rounded-xl border border-[var(--app-border)] bg-[var(--app-panel-bg)] p-4 shadow-sm">
          <div className="mb-2 flex items-center justify-between gap-3">
            <div>
              <div className="text-sm font-semibold">Import Daily Case TSV</div>
              <div className="text-xs text-[var(--app-muted)]">
                Expected columns: `hn` or `patid`, plus `admit_date` or `admit_datetime`.
              </div>
            </div>
            <label className="flex items-center gap-2 text-xs text-[var(--app-muted)]">
              <input
                type="checkbox"
                checked={replaceExisting}
                onChange={event => setReplaceExisting(event.target.checked)}
              />
              Replace existing data
            </label>
          </div>
          <textarea
            value={tsvText}
            onChange={event => setTsvText(event.target.value)}
            placeholder={"hn\tadmit_datetime\n12345\t2026-06-26 14:34:00"}
            className="min-h-[260px] w-full rounded-lg border border-[var(--app-border)] bg-[var(--app-control-bg)] px-3 py-2 font-mono text-xs text-[var(--app-text)] outline-none"
          />
          <div className="mt-3 flex items-center justify-between gap-3">
            <div className="text-xs text-[var(--app-muted)]">
              Best input for now: result export from your cleaned daily-case query.
            </div>
            <button
              type="button"
              onClick={() => void handleImport()}
              disabled={importing || !tsvText.trim()}
              className="rounded-lg border border-sky-500/40 bg-sky-500/10 px-3 py-2 text-sm text-sky-200 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {importing ? "Importing..." : "Import TSV"}
            </button>
          </div>
        </div>

        <div className="rounded-xl border border-[var(--app-border)] bg-[var(--app-panel-bg)] p-4 shadow-sm">
          <div className="mb-3 flex flex-wrap items-end justify-between gap-3">
            <div>
              <div className="text-sm font-semibold">Daily Summary</div>
              <div className="text-xs text-[var(--app-muted)]">
                {loading ? "Loading..." : `${summaryRows.length} days | ${totalVisibleCases} visible cases`}
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <input
                type="date"
                value={fromDate}
                onChange={event => setFromDate(event.target.value)}
                className="rounded border border-[var(--app-border)] bg-[var(--app-control-bg)] px-2 py-1.5 text-sm"
              />
              <span className="text-xs text-[var(--app-muted)]">to</span>
              <input
                type="date"
                value={toDate}
                onChange={event => setToDate(event.target.value)}
                className="rounded border border-[var(--app-border)] bg-[var(--app-control-bg)] px-2 py-1.5 text-sm"
              />
              <button
                type="button"
                onClick={() => void handleApplyFilters()}
                className="rounded border border-[var(--app-border)] px-3 py-1.5 text-sm"
              >
                Apply
              </button>
            </div>
          </div>

          {summaryRows.length === 0 ? (
            <div className="rounded-lg border border-dashed border-[var(--app-border)] px-4 py-10 text-center text-sm text-[var(--app-muted)]">
              Import a TSV export to start building the ePHIS daily-case dataset.
            </div>
          ) : (
            <div className="max-h-[420px] overflow-auto rounded-lg border border-[var(--app-border)]">
              <table className="w-full text-sm">
                <thead className="sticky top-0 bg-[var(--app-panel-bg)]">
                  <tr className="border-b border-[var(--app-border)] text-left text-[11px] uppercase tracking-wide text-[var(--app-muted)]">
                    <th className="px-3 py-2">Admit Date</th>
                    <th className="px-3 py-2">Case Count</th>
                    <th className="px-3 py-2"></th>
                  </tr>
                </thead>
                <tbody>
                  {summaryRows.map((row, index) => (
                    <tr
                      key={row.admit_date}
                      className={`border-b border-[var(--app-border)] last:border-b-0 ${
                        row.admit_date === selectedDate ? "bg-sky-500/10" : index % 2 ? "bg-[var(--app-control-bg)]/30" : ""
                      }`}
                    >
                      <td className="px-3 py-2.5 font-medium">{row.admit_date}</td>
                      <td className="px-3 py-2.5">{row.case_count}</td>
                      <td className="px-3 py-2.5 text-right">
                        <button
                          type="button"
                          className="rounded border border-[var(--app-border)] px-2.5 py-1 text-xs"
                          onClick={() => setSelectedDate(row.admit_date)}
                        >
                          View HN
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </section>

      <section className="rounded-xl border border-[var(--app-border)] bg-[var(--app-panel-bg)] p-4 shadow-sm">
        <div className="mb-3 flex flex-wrap items-end justify-between gap-3">
          <div>
            <div className="text-sm font-semibold">Daily Case Detail</div>
            <div className="text-xs text-[var(--app-muted)]">
              {selectedDate ? `HN list for ${selectedDate}` : "Pick a day from the summary table"}
            </div>
          </div>
          <input
            value={hnFilter}
            onChange={event => setHnFilter(event.target.value)}
            placeholder="Filter HN"
            className="w-44 rounded border border-[var(--app-border)] bg-[var(--app-control-bg)] px-2 py-1.5 text-sm"
          />
        </div>

        {!selectedDate ? (
          <div className="rounded-lg border border-dashed border-[var(--app-border)] px-4 py-8 text-center text-sm text-[var(--app-muted)]">
            Select a daily summary row first.
          </div>
        ) : detailRows.length === 0 ? (
          <div className="rounded-lg border border-dashed border-[var(--app-border)] px-4 py-8 text-center text-sm text-[var(--app-muted)]">
            No HN rows match the current filter.
          </div>
        ) : (
          <div className="max-h-[420px] overflow-auto rounded-lg border border-[var(--app-border)]">
            <table className="w-full text-sm">
              <thead className="sticky top-0 bg-[var(--app-panel-bg)]">
                <tr className="border-b border-[var(--app-border)] text-left text-[11px] uppercase tracking-wide text-[var(--app-muted)]">
                  <th className="px-3 py-2">HN</th>
                  <th className="px-3 py-2">Admit DateTime</th>
                  <th className="px-3 py-2">Raw Value</th>
                </tr>
              </thead>
              <tbody>
                {detailRows.map((row, index) => (
                  <tr
                    key={`${row.hn}:${row.admit_datetime || row.admit_date}:${index}`}
                    className={`border-b border-[var(--app-border)] last:border-b-0 ${index % 2 ? "bg-[var(--app-control-bg)]/30" : ""}`}
                  >
                    <td className="px-3 py-2.5 font-mono font-medium">{row.hn}</td>
                    <td className="px-3 py-2.5">{displayDateTime(row.admit_datetime)}</td>
                    <td className="px-3 py-2.5 text-[var(--app-muted)]">{row.raw_admit_value || "-"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
