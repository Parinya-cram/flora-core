import { useCallback, useEffect, useRef, useState } from "react";
import { getStaffSyncStatus, requestLeafSync, type StaffSyncStatus } from "../../api/staffDirectoryApi";
import { useWorkstationSettings } from "../../hooks/useWorkstationSettings";
import { formatConfiguredDateTime } from "../../utils/dateTime";

/**
 * Leaf Staff screen: when the staff directory last synced with Canopy, what that sync did, what is still
 * waiting to go up, and Sync now (runs a full sync cycle at once, then shows its result).
 */
export default function StaffSyncPanel({ onSynced }: { onSynced?: () => void }) {
  const workstation = useWorkstationSettings();
  const [status, setStatus] = useState<StaffSyncStatus | null>(null);
  const [waiting, setWaiting] = useState<number | null>(null);
  const [error, setError] = useState("");
  const syncedRef = useRef(onSynced);
  useEffect(() => { syncedRef.current = onSynced; }, [onSynced]);

  const load = useCallback(async () => {
    try {
      const next = await getStaffSyncStatus();
      setStatus(next);
      setError("");
      return next;
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      return null;
    }
  }, []);

  useEffect(() => {
    void Promise.resolve().then(load);
    const timer = window.setInterval(() => void load(), 30_000);
    return () => window.clearInterval(timer);
  }, [load]);

  // After Sync now: poll until the worker has run a staff step after the request.
  useEffect(() => {
    if (waiting == null) return;
    const started = Date.now();
    const timer = window.setInterval(() => {
      void load().then(next => {
        const attempted = next?.last?.last_attempt_at || 0;
        if (attempted >= waiting || Date.now() - started > 60_000) {
          setWaiting(null);
          if (attempted < waiting) setError("No answer from the sync service within a minute; it will retry automatically.");
          else syncedRef.current?.();
        }
      });
    }, 1500);
    return () => window.clearInterval(timer);
  }, [waiting, load]);

  const syncNow = async () => {
    setError("");
    try {
      const { requested_at } = await requestLeafSync();
      setWaiting(requested_at);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  };

  const last = status?.last;
  const detail = last?.detail || {};
  const ok = Boolean(last?.last_ok_at && last.last_ok_at >= (last.last_attempt_at || 0) && !last.last_error);
  const counts = status?.counts;
  const parts = [
    detail.pushed ? `sent ${detail.pushed}` : "",
    detail.created ? `new in Canopy ${detail.created}` : "",
    detail.merged ? `matched existing code ${detail.merged}` : "",
    detail.rejected ? `rejected ${detail.rejected}` : "",
    detail.unchanged ? "directory unchanged" : detail.received != null ? `received ${detail.received}` : "",
    detail.inserted ? `added ${detail.inserted}` : "",
    detail.deactivated ? `removed from ward ${detail.deactivated}` : "",
    detail.conflicts ? `conflicts ${detail.conflicts}` : "",
  ].filter(Boolean);

  return (
    <div className={`rounded-lg border px-3 py-2 text-xs ${!last ? "border-gray-300 dark:border-gray-700" : ok ? "border-emerald-400/60 bg-emerald-500/5" : "border-amber-400/70 bg-amber-400/10"}`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <div className="text-sm font-semibold">
            Canopy staff sync{detail.unit ? ` · ${detail.unit}` : ""}
          </div>
          <div className="text-gray-600 dark:text-gray-300">
            {!last ? "Not synced yet" : <>Last sync {last.last_ok_at ? formatConfiguredDateTime(last.last_ok_at, workstation) : "—"}
              {last.last_attempt_at && last.last_attempt_at !== last.last_ok_at ? ` · last attempt ${formatConfiguredDateTime(last.last_attempt_at, workstation)}` : ""}</>}
          </div>
        </div>
        <button type="button" onClick={() => void syncNow()} disabled={waiting != null}
          className="rounded border border-blue-500 px-3 py-1.5 text-xs font-semibold text-blue-700 hover:bg-blue-50 disabled:opacity-60 dark:text-blue-300 dark:hover:bg-blue-950/40">
          {waiting != null ? "Syncing…" : "Sync now"}
        </button>
      </div>
      {last?.last_error ? <div className="mt-1 text-red-600 dark:text-red-400">Failed: {last.last_error}</div> : null}
      {detail.skipped ? <div className="mt-1 text-amber-700 dark:text-amber-300">{detail.skipped}</div> : null}
      {parts.length ? <div className="mt-1 text-gray-600 dark:text-gray-300">Result: {parts.join(" · ")}</div> : null}
      {detail.rejected_items?.length ? <ul className="mt-1 list-disc pl-5 text-red-600 dark:text-red-400">
        {detail.rejected_items.slice(0, 5).map(item => <li key={item.staff_code}>{item.staff_code}: {item.reason}</li>)}
      </ul> : null}
      {counts ? <div className="mt-1 flex flex-wrap gap-x-3 text-gray-500 dark:text-gray-400">
        <span>From Canopy {counts.canopy}</span>
        <span>Waiting to send {counts.pending}</span>
        {counts.rejected ? <span className="text-red-600 dark:text-red-400">Not accepted {counts.rejected}</span> : null}
        {counts.local_only ? <span>Local only (no code) {counts.local_only}</span> : null}
      </div> : null}
      {error ? <div className="mt-1 text-red-600 dark:text-red-400">{error}</div> : null}
    </div>
  );
}
