import { useEffect, useState } from "react";
import { getCaseBindings, type CaseBinding } from "../../api/gatewayAlertsApi";

function time(value?: string | null) {
  return value ? new Date(value).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "";
}

/** Gateway stream-hub device sessions of one case; hidden when the case never streamed. */
export default function CaseDeviceSessions({ caseUuid }: { caseUuid: string }) {
  const [rows, setRows] = useState<CaseBinding[]>([]);

  useEffect(() => {
    let cancelled = false;
    getCaseBindings({ case_uuid: caseUuid })
      .then(result => { if (!cancelled) setRows(result); })
      .catch(() => { if (!cancelled) setRows([]); });
    return () => { cancelled = true; };
  }, [caseUuid]);

  if (!rows.length) return null;
  return (
    <div className="mb-2 flex flex-wrap items-center gap-2 rounded-xl border border-[var(--app-border)] bg-[var(--app-panel-bg)] px-3 py-2 text-xs">
      <strong className="text-[var(--app-text)]">Device sessions</strong>
      {rows.map(row => {
        const open = !row.unbound_at;
        return (
          <span
            key={`${row.gateway_id}:${row.binding_id}`}
            title={`${row.gateway_id} · ${row.device_id} · ${row.mode}${row.unbind_reason ? ` · ${row.unbind_reason}` : ""}`}
            className={`rounded-full border px-2.5 py-1 ${open ? "border-emerald-500/45 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300" : "border-[var(--app-border)] text-[var(--app-muted)]"}`}
          >
            {row.device_label || row.device_id}{row.mode === "shared" ? " (shared)" : ""} · {time(row.bound_at)}{open ? " · live" : ` → ${time(row.unbound_at)}`}
          </span>
        );
      })}
    </div>
  );
}
