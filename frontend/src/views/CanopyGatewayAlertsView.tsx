import { useCallback, useEffect, useMemo, useState } from "react";
import { getGatewayAlerts, type GatewayAlert, type GatewayAlertLog } from "../api/gatewayAlertsApi";

// Central log of every gateway's alerts (connection lost, controller down, device silent).
// Gateways keep alerts while Canopy is unreachable and send them later, so an alert can
// arrive after it has already been resolved.

const severityStyle: Record<string, { icon: string; label: string; badge: string; edge: string }> = {
  critical: { icon: "✕", label: "Critical", badge: "bg-rose-600 text-white", edge: "border-l-rose-600" },
  warning: { icon: "!", label: "Warning", badge: "bg-amber-400 text-black", edge: "border-l-amber-400" },
  info: { icon: "i", label: "Info", badge: "bg-slate-500 text-white", edge: "border-l-slate-400" },
};
const categoryLabel: Record<string, string> = {
  canopy: "Canopy connection", controller: "Controller", device: "Device", gateway: "Gateway service",
};

const when = (ms?: number | null) => (ms ? new Date(ms).toLocaleString() : "—");
const duration = (from: number, to?: number | null) => {
  const ms = (to ?? Date.now()) - from;
  return ms < 3_600_000 ? `${Math.max(1, Math.round(ms / 60_000))} min` : `${(ms / 3_600_000).toFixed(1)} h`;
};
const gatewayName = (alert: GatewayAlert) =>
  [alert.site_name || alert.gateway_id, alert.site_unit].filter(Boolean).join(" · ");

function Severity({ value }: { value: string }) {
  const style = severityStyle[value] || severityStyle.info;
  return (
    <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-[var(--app-text)]">
      <span className={`inline-grid h-4 w-4 place-items-center rounded-full text-[10px] font-bold ${style.badge}`} aria-hidden="true">{style.icon}</span>
      {style.label}
    </span>
  );
}

export default function CanopyGatewayAlertsView() {
  const [log, setLog] = useState<GatewayAlertLog | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [gateway, setGateway] = useState("");
  const [category, setCategory] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setLog(await getGatewayAlerts("all"));
      setError("");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Gateway alerts are unavailable.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => void load(), 30_000);
    return () => window.clearInterval(timer);
  }, [load]);

  const gateways = useMemo(() => [...new Map((log?.rows || []).map(row => [row.gateway_id, gatewayName(row)])).entries()], [log]);
  const rows = (log?.rows || []).filter(row => (!gateway || row.gateway_id === gateway) && (!category || row.category === category));
  const open = rows.filter(row => !row.resolved_at);
  const resolved = rows.filter(row => row.resolved_at);
  const select = "rounded-xl border border-[var(--app-border)] bg-[var(--app-control-bg)] px-3 py-2 text-sm text-[var(--app-text)]";

  return (
    <div className="h-full overflow-y-auto bg-[var(--app-bg)] p-3 sm:p-5">
      <div className="mx-auto max-w-7xl space-y-4">
        <header className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <div className="text-xs font-bold uppercase tracking-[0.16em] text-[var(--app-accent)]">Central log</div>
            <h1 className="mt-1 text-2xl font-semibold text-[var(--app-text)]">Gateway alerts</h1>
            <p className="mt-1 text-sm text-[var(--app-muted)]">Connection lost, controllers down and silent devices, reported by every gateway in the hospital.</p>
          </div>
          <div className="flex flex-wrap gap-2">
            <select className={select} value={gateway} onChange={event => setGateway(event.target.value)} aria-label="Gateway">
              <option value="">All gateways</option>
              {gateways.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
            </select>
            <select className={select} value={category} onChange={event => setCategory(event.target.value)} aria-label="Category">
              <option value="">All categories</option>
              {Object.entries(categoryLabel).map(([key, label]) => <option key={key} value={key}>{label}</option>)}
            </select>
            <button type="button" onClick={() => void load()} disabled={loading}
              className="rounded-xl border border-[var(--app-border)] bg-[var(--app-control-bg)] px-4 py-2 text-sm font-semibold text-[var(--app-text)] disabled:opacity-50">
              {loading ? "Refreshing…" : "Refresh"}
            </button>
          </div>
        </header>

        {error ? <div className="rounded-xl border border-rose-500/40 bg-rose-500/10 px-4 py-3 text-sm text-rose-600 dark:text-rose-300">{error}</div> : null}

        <div className="grid gap-3 sm:grid-cols-3">
          {[
            [log?.counts.open ?? 0, "open alerts"],
            [log?.counts.critical_open ?? 0, "critical open"],
            [log?.counts.gateways_affected ?? 0, "gateways affected"],
          ].map(([value, label]) => (
            <div key={label} className="rounded-2xl border border-[var(--app-border)] bg-[var(--app-panel-bg)] px-4 py-3">
              <div className="text-2xl font-semibold tabular-nums text-[var(--app-text)]">{value}</div>
              <div className="text-xs text-[var(--app-muted)]">{label}</div>
            </div>
          ))}
        </div>

        <section className="rounded-2xl border border-[var(--app-border)] bg-[var(--app-panel-bg)] p-4">
          <h2 className="mb-3 text-xs font-bold uppercase tracking-[0.12em] text-[var(--app-muted)]">Active</h2>
          {open.length === 0 ? (
            <div className="text-sm text-emerald-600 dark:text-emerald-400">✓ No active alerts{gateway || category ? " for this filter" : ""}.</div>
          ) : (
            <ul className="space-y-2">
              {open.map(alert => (
                <li key={`${alert.gateway_id}:${alert.alert_id}`}
                  className={`grid gap-1 rounded-xl border border-l-4 border-[var(--app-border)] px-3 py-2 sm:grid-cols-[auto_1fr_auto] sm:items-start sm:gap-4 ${(severityStyle[alert.severity] || severityStyle.info).edge}`}>
                  <Severity value={alert.severity} />
                  <div>
                    <div className="font-semibold text-[var(--app-text)]">{alert.title}</div>
                    <div className="text-sm text-[var(--app-muted)]">{gatewayName(alert)}{alert.detail ? ` — ${alert.detail}` : ""}</div>
                  </div>
                  <div className="text-xs text-[var(--app-muted)] sm:text-right">
                    since {when(alert.opened_at)} ({duration(alert.opened_at)})
                    <div>{alert.acknowledged_by ? `acknowledged by ${alert.acknowledged_by}` : "not acknowledged"}</div>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="rounded-2xl border border-[var(--app-border)] bg-[var(--app-panel-bg)] p-4">
          <h2 className="mb-3 text-xs font-bold uppercase tracking-[0.12em] text-[var(--app-muted)]">History</h2>
          {resolved.length === 0 ? (
            <div className="text-sm text-[var(--app-muted)]">No resolved alerts yet.</div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead className="text-xs text-[var(--app-muted)]">
                  <tr>{["Severity", "Alert", "Gateway", "From", "Duration", "Acknowledged"].map(head => <th key={head} className="border-b border-[var(--app-border)] px-2 py-2 font-semibold">{head}</th>)}</tr>
                </thead>
                <tbody>
                  {resolved.map(alert => (
                    <tr key={`${alert.gateway_id}:${alert.alert_id}`} className="align-top">
                      <td className="border-b border-[var(--app-border)] px-2 py-2"><Severity value={alert.severity} /></td>
                      <td className="border-b border-[var(--app-border)] px-2 py-2">
                        <div className="font-medium text-[var(--app-text)]">{alert.title}</div>
                        {alert.detail ? <div className="text-xs text-[var(--app-muted)]">{alert.detail}</div> : null}
                      </td>
                      <td className="border-b border-[var(--app-border)] px-2 py-2 text-[var(--app-text)]">{gatewayName(alert)}</td>
                      <td className="whitespace-nowrap border-b border-[var(--app-border)] px-2 py-2 text-[var(--app-text)]">{when(alert.opened_at)}</td>
                      <td className="whitespace-nowrap border-b border-[var(--app-border)] px-2 py-2 text-[var(--app-text)]">{duration(alert.opened_at, alert.resolved_at)}</td>
                      <td className="border-b border-[var(--app-border)] px-2 py-2 text-[var(--app-muted)]">{alert.acknowledged_by || "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
