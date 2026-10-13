import { useCallback, useEffect, useMemo, useState } from "react";
import type { AuthUser } from "../auth/useAuth";
import { getDeviceManagement, type DeviceManagement, type DeviceState, type MedicalDevice, type RegistryGateway } from "../api/deviceManagementApi";
import { DeviceDrawer, GatewayDrawer, HourStrip, StateBadge } from "../components/canopy/DeviceManagementPanels";
import DeviceTypesPanel from "../components/canopy/DeviceTypesPanel";
import { CATEGORIES, CONNECTION_DOT, EVENT_LABEL, STATE_STYLE, STATUS_LABEL, ago, percent } from "../components/canopy/deviceManagementFormat";

// Canopy → Devices: the hospital's medical device and gateway registry, by ward, and the device types.
// Canopy is the master record; gateways that connect and devices they report without a
// registration are added automatically and flagged for review. Gateways send hourly activity
// (share of each hour a device sent data) and on/off events through Haber.

type Filter = "all" | "on" | "off" | "review" | "pm";
const PM_SOON_MS = 30 * 86_400_000;
const categoryLabel = Object.fromEntries(CATEGORIES);

type WardGroup = { key: string; name: string; building: string | null; gateways: RegistryGateway[]; devices: MedicalDevice[] };

function matches(device: MedicalDevice, query: string, filter: Filter, now: number): boolean {
  if (filter === "on" && device.state !== "on") return false;
  if (filter === "off" && device.state !== "off") return false;
  if (filter === "review" && device.registry_status !== "auto") return false;
  if (filter === "pm" && !(device.next_pm_at && device.next_pm_at < now + PM_SOON_MS)) return false;
  if (!query) return true;
  return [device.display_name, device.asset_tag, device.serial_number, device.model, device.manufacturer, device.location,
    device.gateway_device_id, device.gateway_id, device.leaf_name].some(value => value?.toLowerCase().includes(query));
}

function Stat({ label, value, tone = "", onClick, active }: { label: string; value: number; tone?: string; onClick: () => void; active: boolean }) {
  return (
    <button onClick={onClick} className={`rounded-xl border px-3 py-2 text-left transition ${active ? "border-[var(--app-accent)] bg-[var(--app-control-bg-hover)]" : "border-[var(--app-border)] bg-[var(--app-panel-bg)] hover:bg-[var(--app-control-bg-hover)]"}`}>
      <div className={`text-xl font-semibold ${tone || "text-[var(--app-text)]"}`}>{value}</div>
      <div className="text-[11px] text-[var(--app-muted)]">{label}</div>
    </button>
  );
}

function GatewayCard({ gateway, start, onOpen }: { gateway: RegistryGateway; start: number; onOpen: () => void }) {
  const site = gateway.site as Record<string, string | null>;
  return (
    <button onClick={onOpen} className="min-w-[240px] flex-1 rounded-xl border border-[var(--app-border)] bg-[var(--app-panel-bg)] p-3 text-left hover:bg-[var(--app-control-bg-hover)]">
      <div className="flex items-center justify-between gap-2">
        <span className="inline-flex min-w-0 items-center gap-2">
          <span className={`h-2.5 w-2.5 shrink-0 rounded-full ${CONNECTION_DOT[gateway.connection_status]}`} title={gateway.connection_status} />
          <span className="truncate font-semibold text-[var(--app-text)]">{gateway.display_name || site.display_name || gateway.gateway_id}</span>
        </span>
        {gateway.registry_status === "auto" && <span className="shrink-0 rounded-full bg-amber-100 px-2 text-[11px] font-semibold text-amber-800">Review</span>}
        {gateway.registry_status === "retired" && <span className="shrink-0 rounded-full bg-slate-200 px-2 text-[11px] font-semibold text-slate-700">Retired</span>}
      </div>
      <div className="mt-1 truncate font-mono text-[11px] text-[var(--app-muted)]">{gateway.gateway_id}</div>
      <div className="mt-2 flex items-center justify-between gap-2">
        <HourStrip cells={gateway.hours} start={start} />
        <span className="text-xs text-[var(--app-muted)]">{percent(gateway.uptime_24h)}</span>
      </div>
      <div className="mt-1 text-xs text-[var(--app-muted)]">
        {gateway.enabled_devices}/{gateway.max_devices ?? "—"} devices · {gateway.connection_status === "pending" ? "never checked in" : `check-in ${ago(gateway.last_seen_at)}`}
      </div>
      {!gateway.in_ward && <div className="mt-1 text-[11px] text-[var(--app-muted)]">Installed in {gateway.unit_name || "another ward"} · serves devices here</div>}
    </button>
  );
}

function DeviceRow({ device, start, now, onOpen }: { device: MedicalDevice; start: number; now: number; onOpen: () => void }) {
  const pmDue = device.next_pm_at && device.next_pm_at < now + PM_SOON_MS;
  return (
    <tr className="cursor-pointer border-t border-[var(--app-border)] hover:bg-[var(--app-control-bg-hover)]" onClick={onOpen}>
      <td className="px-3 py-2 align-top"><StateBadge state={device.state} /></td>
      <td className="px-3 py-2 align-top">
        <div className="font-medium text-[var(--app-text)]">
          {device.display_name}
          {device.registry_status === "auto" && <span className="ml-2 rounded-full bg-amber-100 px-2 text-[11px] font-semibold text-amber-800">Review</span>}
        </div>
        <div className="text-xs text-[var(--app-muted)]">
          {[categoryLabel[device.category || ""] , [device.manufacturer, device.model].filter(Boolean).join(" ")].filter(Boolean).join(" · ") || device.device_type || "—"}
        </div>
      </td>
      <td className="px-3 py-2 align-top text-xs">
        <div className="text-[var(--app-text)]">{device.asset_tag || "—"}</div>
        <div className="text-[var(--app-muted)]">S/N {device.serial_number || "—"}</div>
      </td>
      <td className="px-3 py-2 align-top text-xs text-[var(--app-muted)]">{device.location || "—"}</td>
      <td className="px-3 py-2 align-top text-xs">
        {device.gateway_id ? (
          <>
            <div className="font-mono text-[var(--app-text)]">{device.gateway_device_id}</div>
            <div className="text-[var(--app-muted)]">→ {device.leaf_name || device.leaf_id || "no Leaf"}</div>
          </>
        ) : <span className="text-[var(--app-muted)]">not connected</span>}
      </td>
      <td className="px-3 py-2 align-top"><HourStrip cells={device.hours} start={start} /></td>
      <td className="px-3 py-2 align-top text-xs text-[var(--app-text)]">{percent(device.uptime_24h)}</td>
      <td className="px-3 py-2 align-top text-xs">
        {device.last_event_type ? (
          <>
            <div className="text-[var(--app-text)]">{EVENT_LABEL[device.last_event_type]}</div>
            <div className="text-[var(--app-muted)]">{ago(device.last_event_at)}</div>
          </>
        ) : <span className="text-[var(--app-muted)]">—</span>}
      </td>
      <td className="px-3 py-2 align-top text-xs">
        <div className={device.status === "in_service" ? "text-[var(--app-text)]" : "font-semibold text-amber-700"}>{STATUS_LABEL[device.status]}</div>
        {pmDue && <div className="font-semibold text-rose-600">PM {new Date(device.next_pm_at!).toLocaleDateString()}</div>}
      </td>
    </tr>
  );
}

export default function CanopyDeviceManagementView({ sessionUser }: { sessionUser: AuthUser | null }) {
  const [data, setData] = useState<DeviceManagement | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [openDevice, setOpenDevice] = useState<number | "new" | null>(null);
  const [openGateway, setOpenGateway] = useState<string | "new" | null>(null);
  const [tab, setTab] = useState<"registry" | "types">("registry");
  const now = data?.server_time || 0;
  const isAdmin = ["admin", "system_admin"].includes(String(sessionUser?.role || "").toLowerCase());

  const load = useCallback(async () => {
    try {
      setData(await getDeviceManagement());
      setError("");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Device Management is unavailable.");
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    void load();
    const timer = window.setInterval(() => void load(), 60_000);
    return () => window.clearInterval(timer);
  }, [load]);

  const needle = query.trim().toLowerCase();
  const groups = useMemo<WardGroup[]>(() => {
    if (!data) return [];
    const byKey = new Map<string, WardGroup>(data.wards.map(ward => [ward.key, { key: ward.key, name: ward.name, building: ward.building_name, gateways: [], devices: [] }]));
    const unassigned: WardGroup = { key: "", name: "Unassigned", building: null, gateways: [], devices: [] };
    const other: WardGroup = { key: "other", name: "Gateways in other wards", building: null, gateways: [], devices: [] };
    for (const device of data.devices) {
      if (!matches(device, needle, filter, now)) continue;
      (byKey.get(device.unit_key || "") || unassigned).devices.push(device);
    }
    for (const gateway of data.gateways) {
      if (needle && ![gateway.display_name, gateway.gateway_id, gateway.serial_number, gateway.asset_tag].some(value => value?.toLowerCase().includes(needle))
        && !data.devices.some(device => device.gateway_id === gateway.gateway_id && matches(device, needle, filter, now))) continue;
      if (filter === "review" && gateway.registry_status !== "auto") continue;
      const home = gateway.in_ward ? byKey.get(gateway.unit_key || "") || (gateway.unit_key ? null : unassigned) : null;
      (home || other).gateways.push(gateway);
    }
    return [...byKey.values(), unassigned, other].filter(group => group.devices.length || group.gateways.length);
  }, [data, needle, filter, now]);

  const counts = useMemo(() => {
    const devices = data?.devices || [];
    const count = (state: DeviceState) => devices.filter(device => device.state === state).length;
    return {
      devices: devices.length, gateways: data?.gateways.length || 0, on: count("on"), off: count("off"),
      review: devices.filter(device => device.registry_status === "auto").length + (data?.gateways || []).filter(gateway => gateway.registry_status === "auto").length,
      pm: devices.filter(device => device.next_pm_at && device.next_pm_at < now + PM_SOON_MS).length,
    };
  }, [data, now]);

  const toggle = (key: string) => setCollapsed(current => {
    const next = new Set(current);
    if (next.has(key)) next.delete(key); else next.add(key);
    return next;
  });
  const start = data?.hours_start || 0;
  const control = "rounded-xl border border-[var(--app-border)] bg-[var(--app-control-bg)] px-3 py-2 text-sm text-[var(--app-text)]";

  return (
    <div className="h-full overflow-y-auto bg-[var(--app-bg)] p-3 sm:p-5">
      <div className="mx-auto max-w-[1500px] space-y-4">
        <header className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <div className="text-xs font-bold uppercase tracking-[0.16em] text-[var(--app-accent)]">Registry</div>
            <h1 className="mt-1 text-2xl font-semibold text-[var(--app-text)]">Devices</h1>
            <p className="mt-1 text-sm text-[var(--app-muted)]">Medical devices and the gateways that connect them, by ward. Activity arrives from each gateway every hour.</p>
          </div>
          {tab === "registry" && <div className="flex flex-wrap gap-2">
            <input className={`${control} w-60`} placeholder="Search name, asset tag, S/N…" value={query} onChange={event => setQuery(event.target.value)} aria-label="Search devices" />
            {isAdmin && <button className={control} onClick={() => setOpenGateway("new")}>Register gateway</button>}
            {isAdmin && <button className="rounded-xl bg-[var(--app-accent)] px-3 py-2 text-sm font-semibold text-[var(--app-accent-contrast)]" onClick={() => setOpenDevice("new")}>Register device</button>}
          </div>}
        </header>

        <nav className="flex gap-1 border-b border-[var(--app-border)]" role="tablist">
          {([["registry", "Registry"], ["types", "Device types"]] as const).map(([key, label]) => (
            <button key={key} role="tab" aria-selected={tab === key} onClick={() => setTab(key)}
              className={`-mb-px border-b-2 px-4 py-2 text-sm font-semibold ${tab === key ? "border-[var(--app-accent)] text-[var(--app-text)]" : "border-transparent text-[var(--app-muted)] hover:text-[var(--app-text)]"}`}>
              {label}
            </button>
          ))}
        </nav>

        {tab === "types" ? <DeviceTypesPanel isAdmin={isAdmin} /> : <>

        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
          <Stat label="Medical devices" value={counts.devices} active={filter === "all"} onClick={() => setFilter("all")} />
          <Stat label="Gateways" value={counts.gateways} active={false} onClick={() => setFilter("all")} />
          <Stat label="On now" value={counts.on} tone="text-emerald-600" active={filter === "on"} onClick={() => setFilter(filter === "on" ? "all" : "on")} />
          <Stat label="Off / no data" value={counts.off} tone="text-rose-600" active={filter === "off"} onClick={() => setFilter(filter === "off" ? "all" : "off")} />
          <Stat label="Added automatically — review" value={counts.review} tone="text-amber-600" active={filter === "review"} onClick={() => setFilter(filter === "review" ? "all" : "review")} />
          <Stat label="PM due ≤ 30 days" value={counts.pm} tone="text-rose-600" active={filter === "pm"} onClick={() => setFilter(filter === "pm" ? "all" : "pm")} />
        </div>

        {error && <div className="rounded-xl border border-rose-300 bg-rose-50 px-4 py-3 text-sm text-rose-800">{error}</div>}
        {loading && !data && <div className="text-sm text-[var(--app-muted)]">Loading…</div>}
        {data && !groups.length && <div className="rounded-xl border border-dashed border-[var(--app-border)] p-8 text-center text-sm text-[var(--app-muted)]">No devices or gateways match.</div>}

        {groups.map(group => {
          const open = !collapsed.has(group.key);
          const on = group.devices.filter(device => device.state === "on").length;
          return (
            <section key={group.key || "unassigned"} className="rounded-2xl border border-[var(--app-border)] bg-[var(--app-panel-bg)]">
              <button className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left" onClick={() => toggle(group.key)} aria-expanded={open}>
                <span>
                  <span className="text-lg font-semibold text-[var(--app-text)]">{group.name}</span>
                  {group.building && <span className="ml-2 text-sm text-[var(--app-muted)]">{group.building}</span>}
                </span>
                <span className="text-sm text-[var(--app-muted)]">
                  {group.gateways.length} gateway{group.gateways.length === 1 ? "" : "s"} · {group.devices.length} device{group.devices.length === 1 ? "" : "s"}
                  {group.devices.length ? ` · ${on} on` : ""} <span aria-hidden="true">{open ? "▾" : "▸"}</span>
                </span>
              </button>
              {open && (
                <div className="space-y-3 border-t border-[var(--app-border)] px-4 py-3">
                  {group.gateways.length > 0 && (
                    <div className="flex flex-wrap gap-2">
                      {group.gateways.map(gateway => <GatewayCard key={gateway.gateway_id} gateway={gateway} start={start} onOpen={() => setOpenGateway(gateway.gateway_id)} />)}
                    </div>
                  )}
                  {group.devices.length > 0 && (
                    <div className="overflow-x-auto">
                      <table className="w-full min-w-[1000px] text-sm">
                        <thead>
                          <tr className="text-left text-[11px] uppercase tracking-wide text-[var(--app-muted)]">
                            <th className="px-3 py-1.5 font-semibold">State</th>
                            <th className="px-3 py-1.5 font-semibold">Device</th>
                            <th className="px-3 py-1.5 font-semibold">Asset tag</th>
                            <th className="px-3 py-1.5 font-semibold">Location</th>
                            <th className="px-3 py-1.5 font-semibold">Gateway → Leaf</th>
                            <th className="px-3 py-1.5 font-semibold">Last 24 h</th>
                            <th className="px-3 py-1.5 font-semibold">Uptime</th>
                            <th className="px-3 py-1.5 font-semibold">Last event</th>
                            <th className="px-3 py-1.5 font-semibold">Status</th>
                          </tr>
                        </thead>
                        <tbody>
                          {group.devices.map(device => <DeviceRow key={device.id} device={device} start={start} now={now} onOpen={() => setOpenDevice(device.id)} />)}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              )}
            </section>
          );
        })}

        <p className="text-xs text-[var(--app-muted)]">
          {Object.values(STATE_STYLE).map(style => style.label).join(" · ")} — “On / Off” comes from the device’s own link (TCP connection, answered polls) where the gateway can see it, otherwise from whether data is flowing.
        </p>
        </>}
      </div>

      {openDevice !== null && data && (
        <DeviceDrawer deviceId={openDevice} wards={data.wards} isAdmin={isAdmin} onClose={() => setOpenDevice(null)} onChanged={() => void load()} />
      )}
      {openGateway !== null && data && (
        <GatewayDrawer gatewayId={openGateway} wards={data.wards} isAdmin={isAdmin} onClose={() => setOpenGateway(null)} onChanged={() => void load()}
          onOpenDevice={id => { setOpenGateway(null); setOpenDevice(id); }} />
      )}
    </div>
  );
}
