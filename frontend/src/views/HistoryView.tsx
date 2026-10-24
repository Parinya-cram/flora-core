import { useState, useEffect, useMemo } from "react";
import { getCaseList } from "../api/caseApi";
import type { CaseListRow, CaseStatus } from "../api/caseApi";
import { useWorkstationSettings } from "../hooks/useWorkstationSettings";
import { formatConfiguredDateTime, wallClockInputToTimestamp } from "../utils/dateTime";

type StatusFilter = "all" | "ACTIVE" | "DISCHARGED" | "ARCHIVED";

function formatDuration(startTs: number, endTs?: number) {
  const ms = (endTs ?? Date.now()) - startTs;
  const totalMins = Math.round(ms / 60000);
  if (totalMins < 0) return "—";
  const h = Math.floor(totalMins / 60);
  const m = totalMins % 60;
  if (h === 0) return `${m}m`;
  if (h >= 24) return `${Math.floor(h / 24)}d ${h % 24}h`;
  return `${h}h ${String(m).padStart(2, "0")}m`;
}

const statusBadge: Record<string, string> = {
  ACTIVE:
    "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400",
  DISCHARGED:
    "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400",
  ARCHIVED:
    "bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400",
};

interface Props {
  onOpenCase: (c: Exclude<CaseStatus, { status: "IDLE" }>) => void;
}

export default function HistoryView({ onOpenCase }: Props) {
  const workstation = useWorkstationSettings();
  const [rows, setRows] = useState<CaseListRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [hnQuery, setHnQuery] = useState("");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");

  useEffect(() => {
    getCaseList(200, true)
      .then(setRows)
      .catch(() => setRows([]))
      .finally(() => setLoading(false));
  }, []);

  const filtered = useMemo(() => {
    const hn = hnQuery.trim().toLowerCase();
    const fromTs = dateFrom ? wallClockInputToTimestamp(`${dateFrom}T00:00`, workstation.timezone) ?? 0 : 0;
    const toTs = dateTo ? (wallClockInputToTimestamp(`${dateTo}T23:59`, workstation.timezone) ?? Infinity) + 59_999 : Infinity;
    return rows.filter((r) => {
      if (hn && !r.hn.toLowerCase().includes(hn)) return false;
      if (r.start_time < fromTs || r.start_time > toTs) return false;
      if (statusFilter !== "all" && r.status !== statusFilter) return false;
      return true;
    });
  }, [rows, hnQuery, dateFrom, dateTo, statusFilter, workstation.timezone]);

  const hasFilter = hnQuery || dateFrom || dateTo || statusFilter !== "all";

  function handleOpen(row: CaseListRow) {
    onOpenCase({
      status: row.status as "ACTIVE" | "DISCHARGED" | "ARCHIVED",
      case_id: row.case_id,
      hn: row.hn,
      start_time: row.start_time,
      discharge_time: row.discharge_time,
    });
  }

  return (
    <div className="w-full p-4 space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-base font-semibold text-[var(--app-text)]">Case records</h1>
          <p className="mt-1 text-xs text-[var(--app-muted)]">Discharged cases remain editable until they are archived.</p>
        </div>
        <span className="text-xs text-[var(--app-muted)]">
          {loading
            ? "Loading…"
            : hasFilter
            ? `${filtered.length} of ${rows.length} cases`
            : `${rows.length} cases`}
        </span>
      </div>

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-2">
        <input
          className="rounded border border-[var(--app-border)] bg-[var(--app-control-bg)] px-2 py-1.5 text-sm text-[var(--app-text)] w-36 placeholder:text-[var(--app-muted)]"
          placeholder="Search HN"
          value={hnQuery}
          onChange={(e) => setHnQuery(e.target.value)}
        />
        <input
          type="date"
          className="rounded border border-[var(--app-border)] bg-[var(--app-control-bg)] px-2 py-1.5 text-sm text-[var(--app-text)]"
          value={dateFrom}
          onChange={(e) => setDateFrom(e.target.value)}
        />
        <span className="text-xs text-[var(--app-muted)]">to</span>
        <input
          type="date"
          className="rounded border border-[var(--app-border)] bg-[var(--app-control-bg)] px-2 py-1.5 text-sm text-[var(--app-text)]"
          value={dateTo}
          onChange={(e) => setDateTo(e.target.value)}
        />
        <select
          className="rounded border border-[var(--app-border)] bg-[var(--app-control-bg)] px-2 py-1.5 text-sm text-[var(--app-text)]"
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value as StatusFilter)}
        >
          <option value="all">All Status</option>
          <option value="ACTIVE">Active</option>
          <option value="DISCHARGED">Discharged</option>
          <option value="ARCHIVED">Archived</option>
        </select>
        {hasFilter ? (
          <button
            type="button"
            className="rounded border border-[var(--app-border)] px-2 py-1.5 text-xs text-[var(--app-muted)] hover:text-[var(--app-text)]"
            onClick={() => {
              setHnQuery("");
              setDateFrom("");
              setDateTo("");
              setStatusFilter("all");
            }}
          >
            Clear
          </button>
        ) : null}
      </div>

      {/* Table */}
      {loading ? (
        <div className="text-sm text-[var(--app-muted)]">Loading cases…</div>
      ) : filtered.length === 0 ? (
        <div className="rounded-lg border border-[var(--app-border)] px-4 py-8 text-center text-sm text-[var(--app-muted)]">
          No cases found.
        </div>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-[var(--app-border)]">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-[var(--app-border)] bg-[var(--app-panel-bg)] text-left">
                <th className="px-3 py-2 text-[11px] font-semibold uppercase tracking-wide text-[var(--app-muted)]">
                  HN
                </th>
                <th className="px-3 py-2 text-[11px] font-semibold uppercase tracking-wide text-[var(--app-muted)]">
                  Admit
                </th>
                <th className="px-3 py-2 text-[11px] font-semibold uppercase tracking-wide text-[var(--app-muted)]">
                  Discharge
                </th>
                <th className="px-3 py-2 text-[11px] font-semibold uppercase tracking-wide text-[var(--app-muted)]">
                  Duration
                </th>
                <th className="px-3 py-2 text-[11px] font-semibold uppercase tracking-wide text-[var(--app-muted)]">
                  Status
                </th>
                <th className="px-3 py-2" />
              </tr>
            </thead>
            <tbody>
              {filtered.map((row, i) => (
                <tr
                  key={row.case_id}
                  className={`border-b border-[var(--app-border)] last:border-b-0 cursor-pointer hover:bg-[var(--app-panel-bg)] transition-colors ${
                    i % 2 === 1 ? "bg-[var(--app-control-bg)]/30" : ""
                  }`}
                  onClick={() => handleOpen(row)}
                >
                  <td className="px-3 py-2.5 font-mono font-medium text-[var(--app-text)]">
                    {row.hn}
                  </td>
                  <td className="px-3 py-2.5 text-[var(--app-muted)]">
                    {formatConfiguredDateTime(row.start_time, workstation)}
                  </td>
                  <td className="px-3 py-2.5 text-[var(--app-muted)]">
                    {row.discharge_time
                      ? formatConfiguredDateTime(row.discharge_time, workstation)
                      : "—"}
                  </td>
                  <td className="px-3 py-2.5 text-[var(--app-muted)]">
                    {formatDuration(row.start_time, row.discharge_time)}
                  </td>
                  <td className="px-3 py-2.5">
                    <span
                      className={`inline-block rounded px-2 py-0.5 text-[11px] font-medium ${
                        statusBadge[row.status] ?? ""
                      }`}
                    >
                      {row.status.charAt(0) + row.status.slice(1).toLowerCase()}
                    </span>
                  </td>
                  <td className="px-3 py-2.5 text-right">
                    <button
                      type="button"
                      className="rounded border border-[var(--app-border)] bg-[var(--app-control-bg)] px-2.5 py-1 text-xs hover:bg-[var(--app-panel-bg)]"
                      onClick={(e) => {
                        e.stopPropagation();
                        handleOpen(row);
                      }}
                    >
                      {row.status === "DISCHARGED" ? "Review" : "Open"}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
