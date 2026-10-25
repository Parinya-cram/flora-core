import { useEffect, useState } from "react";
import { useLanguage } from "../../context/LanguageContext";
import { getCaseDevices, type CaseDeviceBinding } from "../../api/caseApi";
import type { LiveConnection, LiveDeviceNumerics, LiveDeviceStatus, LiveHealth } from "../../hooks/useLiveCase";
import { BindingStateBadge } from "../case/CaseDevicesPanel";
import { LIVE_PARAMS as PARAMS, paramValue } from "./liveParams";

/** Compact "Live" strip above the chart grid: latest values per bound device + stream health. */

const TEXT = {
  en: {
    live: "Live", devices: "Devices", noDevices: "No devices bound to this case", waiting: "waiting for data",
    health: { offline: "Offline", waiting: "Waiting", ok: "Connected", lag: "Lagging", gaps: "Gaps" } as Record<LiveHealth, string>,
    reconnecting: "Reconnecting…", lag: "lag", gaps: "gaps", stale: "no data",
  },
  th: {
    live: "สด", devices: "อุปกรณ์", noDevices: "ยังไม่ได้ผูกอุปกรณ์กับเคสนี้", waiting: "รอข้อมูล",
    health: { offline: "ออฟไลน์", waiting: "รอข้อมูล", ok: "เชื่อมต่อ", lag: "ล่าช้า", gaps: "ข้อมูลขาด" } as Record<LiveHealth, string>,
    reconnecting: "กำลังเชื่อมต่อใหม่…", lag: "ล่าช้า", gaps: "ขาด", stale: "ไม่มีข้อมูล",
  },
};

export function HealthBadge({ health, connection }: { health: LiveHealth; connection: LiveConnection }) {
  const { language } = useLanguage();
  const L = TEXT[language === "th" ? "th" : "en"];
  const tone = health === "ok" ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-600"
    : health === "lag" || health === "waiting" ? "border-amber-500/40 bg-amber-500/10 text-amber-600"
      : health === "gaps" ? "border-rose-500/40 bg-rose-500/10 text-rose-500"
        : "border-[var(--app-border)] text-[var(--app-muted)]";
  const label = connection === "reconnecting" ? L.reconnecting : L.health[health];
  return <span className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[10px] font-bold ${tone}`}>
    <span className={`h-1.5 w-1.5 rounded-full ${health === "ok" ? "animate-pulse bg-emerald-500" : "bg-current"}`} />{label}
  </span>;
}

type Props = {
  caseId: number;
  connection: LiveConnection;
  health: LiveHealth;
  numerics: Record<string, LiveDeviceNumerics>;
  deviceStatus: LiveDeviceStatus[];
  onOpenDevices?: () => void;
  /** Bumped by the parent after the binding dialog saves. */
  bindingsVersion?: number;
  /** Replaces the default bar look (border-b, panel background), e.g. when shown inside a card. */
  className?: string;
};

export default function LiveStrip({ caseId, connection, health, numerics, deviceStatus, onOpenDevices, bindingsVersion = 0, className = "border-b border-[var(--app-border)] bg-[var(--app-panel-bg)]" }: Props) {
  const { language } = useLanguage();
  const L = TEXT[language === "th" ? "th" : "en"];
  const [bindings, setBindings] = useState<CaseDeviceBinding[]>([]);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    let alive = true;
    const load = () => void getCaseDevices(caseId).then(rows => { if (alive) setBindings(rows.filter(row => !row.released_at)); }).catch(() => {});
    load();
    const timer = window.setInterval(load, 15_000);
    return () => { alive = false; window.clearInterval(timer); };
  }, [caseId, bindingsVersion]);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, []);

  // One row per bound device, plus any device that streams without a known binding.
  const deviceIds = Array.from(new Set([...bindings.map(row => row.device_id), ...Object.keys(numerics)]));
  const statusById = new Map(deviceStatus.map(row => [row.device_id, row]));

  return <div className={`live-strip flex shrink-0 flex-wrap items-stretch gap-2 px-2 py-1.5 text-[var(--app-text)] ${className}`}>
    <div className="flex items-center gap-2 pr-1">
      <span className="text-[10px] font-extrabold uppercase tracking-[0.16em] text-[var(--app-muted)]">{L.live}</span>
      <HealthBadge health={health} connection={connection} />
    </div>
    {!deviceIds.length ? <div className="flex items-center text-xs text-[var(--app-muted)]">{L.noDevices}</div> : null}
    {deviceIds.map(deviceId => {
      const reading = numerics[deviceId];
      const status = statusById.get(deviceId);
      const binding = bindings.find(row => row.device_id === deviceId);
      const stale = !reading || now - reading.receivedAt > 5_000;
      const shown = PARAMS.map(param => ({ ...param, text: reading ? paramValue(reading.values, param.key) : null })).filter(param => param.text);
      return <div key={deviceId} className={`flex min-w-0 items-center gap-3 rounded-lg border border-[var(--app-border)] bg-[var(--app-control-bg)] px-2.5 py-1 ${stale ? "opacity-70" : ""}`}>
        <div className="min-w-0 leading-tight">
          <div className="flex items-center gap-1.5 text-[11px] font-bold">
            <span className={`inline-block h-1.5 w-1.5 rounded-full ${status?.connected || (!stale && reading) ? "bg-emerald-500" : "bg-gray-400"}`} />
            <span className="max-w-[140px] truncate">{deviceId}</span>
            {binding && binding.gateway_state !== "bound" ? <BindingStateBadge binding={binding} /> : null}
          </div>
          <div className="text-[10px] text-[var(--app-muted)]">
            {status?.lag_ms != null ? `${L.lag} ${(status.lag_ms / 1000).toFixed(1)} s` : stale ? L.stale : ""}
            {status?.gaps ? ` · ${L.gaps} ${status.gaps}` : ""}
          </div>
        </div>
        {shown.length ? shown.map(param => <div key={param.key} className="leading-tight">
          <div className="text-[9px] font-bold uppercase text-[var(--app-muted)]">{param.label}</div>
          <div className={`font-mono text-base font-extrabold tabular-nums ${param.tone}`}>{param.text}</div>
        </div>) : <div className="text-[11px] text-[var(--app-muted)]">{L.waiting}</div>}
      </div>;
    })}
    {onOpenDevices ? <button type="button" onClick={onOpenDevices}
      className="ml-auto self-center rounded-lg border border-[var(--app-border)] bg-[var(--app-control-bg)] px-2.5 py-1 text-[11px] font-semibold hover:border-[var(--app-accent)]">
      {L.devices}…
    </button> : null}
  </div>;
}
