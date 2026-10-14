import { useEffect, useMemo, useState } from "react";
import {
  createDevice, deleteDevice, getDeviceDetail, getGatewayDetail, getLinkOptions, linkDevice, registerGateway,
  updateDevice, updateRegistryGateway,
  type ActivityHour, type DeviceDetail, type DeviceEvent, type DeviceState, type GatewayDetail,
  type GatewayRegistryInput, type HourCell, type LinkOption, type MedicalDevice, type RegistryFields, type WardInfo,
} from "../../api/deviceManagementApi";

import { getPhysicalTopology } from "../../api/fleetApi";
import {
  CATEGORIES, CONNECTION_DOT, EVENT_LABEL, HOUR_MS, STATE_STYLE, STATUS_LABEL, ago, cellClass, emptyRegistry, percent,
} from "./deviceManagementFormat";

// Shared pieces of Canopy → Device Management: activity strips, the device / gateway drawers
// and the registry forms.

const toDate = (ms: number | null) => {
  if (!ms) return "";
  const date = new Date(ms);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
};
const fromDate = (text: string) => (text ? new Date(`${text}T00:00:00`).getTime() : null);

const cellTitle = (value: HourCell) =>
  value == null ? "no data from the gateway" : value < 0 ? "disabled" : `sending data ${Math.round(value * 100)}% of the hour`;

/** 24 hourly cells, oldest first. */
export function HourStrip({ cells, start }: { cells?: HourCell[]; start: number }) {
  return (
    <div className="flex gap-[2px]" role="img" aria-label="Last 24 hours">
      {(cells || Array(24).fill(null)).map((value, index) => (
        <span key={index} className={`h-4 w-[6px] rounded-[2px] ${cellClass(value)}`}
          title={`${new Date(start + index * HOUR_MS).toLocaleString([], { hour: "2-digit", minute: "2-digit", day: "numeric", month: "short" })} – ${cellTitle(value)}`} />
      ))}
    </div>
  );
}

function hourValue(row: ActivityHour): HourCell {
  const live = row.samples_ok + row.samples_down;
  return live ? row.samples_ok / live : row.samples_stopped ? -1 : null;
}

/** Days × 24 hours grid, newest day on top. */
export function HeatGrid({ hours, start, now }: { hours: ActivityHour[]; start: number; now: number }) {
  const byHour = useMemo(() => new Map(hours.map(row => [row.hour_start, row])), [hours]);
  const days = Math.ceil((now - start) / (24 * HOUR_MS));
  const firstMidnight = new Date(start);
  firstMidnight.setHours(0, 0, 0, 0);
  const rows = Array.from({ length: days + 1 }, (_, index) => firstMidnight.getTime() + index * 24 * HOUR_MS)
    .filter(day => day + 24 * HOUR_MS > start).reverse();
  return (
    <div className="overflow-x-auto">
      <div className="ml-24 flex gap-[2px] text-[9px] text-[var(--app-muted)]">
        {Array.from({ length: 24 }, (_, hour) => <span key={hour} className="w-3 text-center">{hour % 3 === 0 ? hour : ""}</span>)}
      </div>
      {rows.map(day => (
        <div key={day} className="mt-[2px] flex items-center gap-[2px]">
          <span className="w-24 shrink-0 whitespace-nowrap text-[11px] text-[var(--app-muted)]">
            {new Date(day).toLocaleDateString([], { weekday: "short", day: "numeric", month: "short" })}
          </span>
          {Array.from({ length: 24 }, (_, hour) => {
            const at = day + hour * HOUR_MS;
            const row = byHour.get(at);
            const value = row ? hourValue(row) : null;
            const future = at > now;
            return (
              <span key={hour} className={`h-3 w-3 rounded-[2px] ${future ? "opacity-0" : cellClass(value)}`}
                title={row ? `${new Date(at).toLocaleString()} – ${cellTitle(value)}; ${row.observations} values` +
                  (row.power_on || row.power_off ? `; on ${row.power_on}× off ${row.power_off}×` : "") : new Date(at).toLocaleString()} />
            );
          })}
        </div>
      ))}
      <div className="mt-2 flex flex-wrap gap-3 text-[11px] text-[var(--app-muted)]">
        {[["bg-emerald-500", "≥ 95%"], ["bg-amber-400", "50–95%"], ["bg-orange-500", "< 50%"], ["bg-rose-500", "no data"],
          ["bg-slate-300", "disabled"]].map(([color, label]) => (
          <span key={label} className="inline-flex items-center gap-1"><span className={`h-3 w-3 rounded-[2px] ${color}`} />{label}</span>
        ))}
      </div>
    </div>
  );
}

export function StateBadge({ state }: { state: DeviceState }) {
  const style = STATE_STYLE[state];
  return (
    <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-[var(--app-text)]">
      <span className={`h-2.5 w-2.5 rounded-full ${style.dot}`} aria-hidden="true" />{style.label}
    </span>
  );
}

function EventList({ events, showDevice = false }: { events: DeviceEvent[]; showDevice?: boolean }) {
  if (!events.length) return <p className="text-sm text-[var(--app-muted)]">No on/off events reported yet.</p>;
  return (
    <ul className="divide-y divide-[var(--app-border)] text-sm">
      {events.map(event => (
        <li key={`${event.gateway_id || ""}-${event.event_id}`} className="flex items-start gap-3 py-2">
          <span className={`mt-1.5 h-2.5 w-2.5 shrink-0 rounded-full ${event.event_type === "power_on" || event.event_type === "data_resumed" ? "bg-emerald-500" : "bg-rose-500"}`} />
          <div className="min-w-0 flex-1">
            <div className="font-medium text-[var(--app-text)]">
              {showDevice && <span className="mr-1">{event.display_name || event.device_id} ·</span>}
              {EVENT_LABEL[event.event_type]}
              <span className="ml-2 text-xs font-normal text-[var(--app-muted)]">
                {event.basis === "connection" ? "device link" : "data flow — the device may be off, unplugged or idle"}
              </span>
            </div>
            {event.detail && <div className="truncate text-xs text-[var(--app-muted)]">{event.detail}</div>}
          </div>
          <time className="shrink-0 text-xs text-[var(--app-muted)]">{new Date(event.occurred_at).toLocaleString()}</time>
        </li>
      ))}
    </ul>
  );
}

const input = "w-full rounded-lg border border-[var(--app-border)] bg-[var(--app-control-bg)] px-2.5 py-1.5 text-sm text-[var(--app-text)] disabled:opacity-70";
const button = "rounded-lg border border-[var(--app-border)] px-3 py-1.5 text-sm font-semibold text-[var(--app-text)] hover:bg-[var(--app-control-bg-hover)] disabled:opacity-50";
const primary = "rounded-lg bg-[var(--app-accent)] px-3 py-1.5 text-sm font-semibold text-[var(--app-accent-contrast)] hover:opacity-90 disabled:opacity-50";

function Field({ label, children, wide = false }: { label: string; children: React.ReactNode; wide?: boolean }) {
  return (
    <label className={`block ${wide ? "sm:col-span-2" : ""}`}>
      <span className="mb-1 block text-xs font-semibold text-[var(--app-muted)]">{label}</span>
      {children}
    </label>
  );
}

export type BedOption = { id: number; unitKey: string; label: string };

export function RegistryForm({ value, wards, beds = [], editable, onChange }: {
  value: RegistryFields; wards: WardInfo[]; beds?: BedOption[]; editable: boolean; onChange: (next: RegistryFields) => void;
}) {
  const set = <K extends keyof RegistryFields>(key: K, next: RegistryFields[K]) => onChange({ ...value, [key]: next });
  const text = (key: keyof RegistryFields) => (
    <input className={input} disabled={!editable} value={(value[key] as string | null) ?? ""}
      onChange={event => set(key, (event.target.value || null) as never)} />
  );
  const date = (key: "acquired_at" | "warranty_until" | "last_pm_at" | "next_pm_at") => (
    <input type="date" className={input} disabled={!editable} value={toDate(value[key])}
      onChange={event => set(key, fromDate(event.target.value))} />
  );
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <Field label="Name *" wide>
        <input className={input} disabled={!editable} value={value.display_name} onChange={event => set("display_name", event.target.value)} />
      </Field>
      <Field label="Category">
        <select className={input} disabled={!editable} value={value.category ?? ""} onChange={event => set("category", event.target.value || null)}>
          <option value="">—</option>
          {CATEGORIES.map(([code, label]) => <option key={code} value={code}>{label}</option>)}
        </select>
      </Field>
      <Field label="Gateway device type">{text("device_type")}</Field>
      <Field label="Manufacturer">{text("manufacturer")}</Field>
      <Field label="Model">{text("model")}</Field>
      <Field label="Serial number">{text("serial_number")}</Field>
      <Field label="Asset tag">{text("asset_tag")}</Field>
      <Field label="Ward">
        <select className={input} disabled={!editable} value={value.unit_id ?? ""}
          onChange={event => {
            const unit = event.target.value ? Number(event.target.value) : null;
            const keep = beds.some(option => option.id === value.bed_id && option.unitKey === String(unit));
            onChange({ ...value, unit_id: unit, bed_id: keep ? value.bed_id : null });
          }}>
          <option value="">Unassigned</option>
          {wards.map(ward => <option key={ward.key} value={ward.key}>{ward.name}{ward.building_name ? ` · ${ward.building_name}` : ""}</option>)}
        </select>
      </Field>
      <Field label="Fixed at bed">
        <select className={input} disabled={!editable} value={value.bed_id ?? ""}
          onChange={event => {
            const bed = beds.find(option => option.id === Number(event.target.value));
            onChange({ ...value, bed_id: bed ? bed.id : null, unit_id: bed ? Number(bed.unitKey) : value.unit_id });
          }}>
          <option value="">Not fixed — mobile / shared (shown through its gateway)</option>
          {beds.filter(option => value.unit_id == null || option.unitKey === String(value.unit_id))
            .map(option => <option key={option.id} value={option.id}>{option.label}</option>)}
        </select>
      </Field>
      <Field label="Room / bed / station (note)">{text("location")}</Field>
      <Field label="Status">
        <select className={input} disabled={!editable} value={value.status} onChange={event => set("status", event.target.value as RegistryFields["status"])}>
          {Object.entries(STATUS_LABEL).map(([code, label]) => <option key={code} value={code}>{label}</option>)}
        </select>
      </Field>
      <Field label="Acquired">{date("acquired_at")}</Field>
      <Field label="Warranty until">{date("warranty_until")}</Field>
      <Field label="Last preventive maintenance">{date("last_pm_at")}</Field>
      <Field label="Next PM due">{date("next_pm_at")}</Field>
      <Field label="Vendor / service contact" wide>{text("vendor_contact")}</Field>
      <Field label="Notes" wide>
        <textarea className={`${input} min-h-20`} disabled={!editable} value={value.notes ?? ""} onChange={event => set("notes", event.target.value || null)} />
      </Field>
    </div>
  );
}

function Drawer({ title, subtitle, onClose, children }: { title: string; subtitle?: React.ReactNode; onClose: () => void; children: React.ReactNode }) {
  useEffect(() => {
    const close = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-[1100] flex justify-end bg-black/30" onClick={onClose}>
      <aside role="dialog" aria-label={title} className="flex h-full w-full max-w-2xl flex-col bg-[var(--app-panel-bg)] shadow-2xl"
        onClick={event => event.stopPropagation()}>
        <header className="flex items-start justify-between gap-3 border-b border-[var(--app-border)] px-5 py-4">
          <div className="min-w-0">
            <h2 className="truncate text-lg font-semibold text-[var(--app-text)]">{title}</h2>
            {subtitle && <div className="mt-0.5 text-sm text-[var(--app-muted)]">{subtitle}</div>}
          </div>
          <button className={button} onClick={onClose}>Close</button>
        </header>
        <div className="flex-1 space-y-5 overflow-y-auto px-5 py-4">{children}</div>
      </aside>
    </div>
  );
}

function Section({ title, children, action }: { title: string; children: React.ReactNode; action?: React.ReactNode }) {
  return (
    <section>
      <div className="mb-2 flex items-center justify-between gap-2">
        <h3 className="text-xs font-bold uppercase tracking-[0.14em] text-[var(--app-muted)]">{title}</h3>
        {action}
      </div>
      {children}
    </section>
  );
}

const registryOf = (device: MedicalDevice): RegistryFields => ({
  display_name: device.display_name, category: device.category, device_type: device.device_type,
  manufacturer: device.manufacturer, model: device.model, serial_number: device.serial_number, asset_tag: device.asset_tag,
  unit_id: device.unit_id, bed_id: device.bed_id ?? null, location: device.location, status: device.status, acquired_at: device.acquired_at,
  warranty_until: device.warranty_until, last_pm_at: device.last_pm_at, next_pm_at: device.next_pm_at,
  vendor_contact: device.vendor_contact, notes: device.notes,
});

export function DeviceDrawer({ deviceId, wards, isAdmin, onClose, onChanged }: {
  deviceId: number | "new"; wards: WardInfo[]; isAdmin: boolean; onClose: () => void; onChanged: () => void;
}) {
  const [detail, setDetail] = useState<DeviceDetail | null>(null);
  const [loadedAt, setLoadedAt] = useState(0);
  const [form, setForm] = useState<RegistryFields>(emptyRegistry(wards.length === 1 ? Number(wards[0].key) : null));
  const [days, setDays] = useState(7);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [options, setOptions] = useState<LinkOption[] | null>(null);
  const [linkChoice, setLinkChoice] = useState("");
  const [beds, setBeds] = useState<BedOption[]>([]);

  useEffect(() => {
    let cancelled = false;
    getPhysicalTopology().then(data => {
      if (cancelled) return;
      setBeds(data.units.flatMap(unit => unit.rooms.flatMap(room => room.beds.map(bed => ({
        id: bed.id, unitKey: unit.key, label: `${room.name}${room.zone ? ` (${room.zone})` : ""} · ${bed.name}`,
      })))));
    }).catch(() => undefined);
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (deviceId === "new") return;
    let cancelled = false;
    getDeviceDetail(deviceId, days).then(result => {
      if (cancelled) return;
      setLoadedAt(Date.now());
      setDetail(result);
      setForm(registryOf(result.device));
    }).catch(reason => !cancelled && setError(reason instanceof Error ? reason.message : String(reason)));
    return () => { cancelled = true; };
  }, [deviceId, days]);

  const save = async () => {
    if (!form.display_name.trim()) { setError("Name is required."); return; }
    setBusy(true);
    setError("");
    try {
      if (deviceId === "new") await createDevice(form);
      else await updateDevice(deviceId, form);
      onChanged();
      onClose();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };
  const remove = async () => {
    if (deviceId === "new" || !window.confirm("Remove this device from the registry? Its activity history stays with the gateway link; retiring keeps the record.")) return;
    setBusy(true);
    try { await deleteDevice(deviceId); onChanged(); onClose(); } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); setBusy(false); }
  };
  const loadOptions = async () => {
    try { setOptions((await getLinkOptions()).rows); } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
  };
  const relink = async (unlink: boolean) => {
    if (deviceId === "new") return;
    const [gatewayId, gatewayDeviceId] = unlink ? [null, null] : linkChoice.split("\u0000");
    if (!unlink && !gatewayDeviceId) return;
    setBusy(true);
    try {
      await linkDevice(deviceId, gatewayId, gatewayDeviceId);
      setDetail(await getDeviceDetail(deviceId, days));
      setOptions(null);
      onChanged();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  const device = detail?.device;
  const title = deviceId === "new" ? "Register medical device" : device?.display_name || "Device";
  const subtitle = device ? (
    <span className="inline-flex flex-wrap items-center gap-2">
      <StateBadge state={device.state} />
      {device.registry_status === "auto" && <span className="rounded-full bg-amber-100 px-2 text-xs font-semibold text-amber-800">Added automatically — review</span>}
      <span>{[device.manufacturer, device.model].filter(Boolean).join(" ") || device.device_type || ""}</span>
    </span>
  ) : null;

  return (
    <Drawer title={title} subtitle={subtitle} onClose={onClose}>
      {error && <div className="rounded-lg border border-rose-300 bg-rose-50 px-3 py-2 text-sm text-rose-800">{error}</div>}
      {device && detail && (
        <>
          <Section title="Activity" action={
            <select className="rounded-lg border border-[var(--app-border)] bg-[var(--app-control-bg)] px-2 py-1 text-xs" value={days}
              onChange={event => setDays(Number(event.target.value))} aria-label="Range">
              {[1, 7, 14, 30].map(value => <option key={value} value={value}>{value === 1 ? "24 hours" : `${value} days`}</option>)}
            </select>}>
            <div className="mb-3 grid grid-cols-3 gap-2 text-center">
              <div className="rounded-lg bg-[var(--app-bg)] p-2"><div className="text-lg font-semibold">{percent(detail.uptime)}</div><div className="text-[11px] text-[var(--app-muted)]">sending data</div></div>
              <div className="rounded-lg bg-[var(--app-bg)] p-2"><div className="text-lg font-semibold">{detail.hours.reduce((sum, row) => sum + row.power_on, 0)} / {detail.hours.reduce((sum, row) => sum + row.power_off, 0)}</div><div className="text-[11px] text-[var(--app-muted)]">powered on / off</div></div>
              <div className="rounded-lg bg-[var(--app-bg)] p-2"><div className="text-lg font-semibold">{detail.hours.reduce((sum, row) => sum + row.observations, 0).toLocaleString()}</div><div className="text-[11px] text-[var(--app-muted)]">values received</div></div>
            </div>
            {device.gateway_id ? <HeatGrid hours={detail.hours} start={detail.hours_start} now={loadedAt} />
              : <p className="text-sm text-[var(--app-muted)]">Not connected to a gateway, so there is no activity.</p>}
          </Section>
          <Section title="On / off events"><EventList events={detail.events} /></Section>
          <Section title="Gateway connection">
            {device.gateway_id ? (
              <div className="rounded-lg border border-[var(--app-border)] p-3 text-sm">
                <div className="font-medium">{detail.gateway?.display_name || detail.gateway?.gateway_id} · <span className="font-mono text-xs">{device.gateway_device_id}</span></div>
                <div className="mt-1 text-[var(--app-muted)]">
                  {device.reported ? <>Pod {device.pod || "—"} → Leaf {device.leaf_name || device.leaf_id || "none"} · parser {device.parser_status || "—"} · {device.enabled ? "enabled" : "disabled"}</>
                    : "The gateway no longer reports this device."}
                </div>
              </div>
            ) : <p className="text-sm text-[var(--app-muted)]">Not linked to a gateway device.</p>}
            {isAdmin && (
              <div className="mt-2 flex flex-wrap items-center gap-2">
                {options === null ? <button className={button} onClick={() => void loadOptions()}>{device.gateway_id ? "Change link…" : "Link to gateway device…"}</button> : (
                  <>
                    <select className={`${input} max-w-md`} value={linkChoice} onChange={event => setLinkChoice(event.target.value)} aria-label="Gateway device">
                      <option value="">Choose a device a gateway reports…</option>
                      {options.map(option => (
                        <option key={`${option.gateway_id}/${option.device_id}`} value={`${option.gateway_id}\u0000${option.device_id}`}
                          disabled={option.registry_id === device.id}>
                          {option.gateway_name} · {option.label || option.device_id} ({option.device_id})
                          {option.registry_id && option.registry_id !== device.id ? ` — linked to ${option.registry_name}` : ""}
                        </option>
                      ))}
                    </select>
                    <button className={primary} disabled={busy || !linkChoice} onClick={() => void relink(false)}>Link</button>
                  </>
                )}
                {device.gateway_id && <button className={button} disabled={busy} onClick={() => void relink(true)}>Unlink</button>}
              </div>
            )}
          </Section>
        </>
      )}
      <Section title="Registry">
        <RegistryForm value={form} wards={wards} beds={beds} editable={isAdmin} onChange={setForm} />
        {device && <p className="mt-2 text-xs text-[var(--app-muted)]">Updated {new Date(device.updated_at).toLocaleString()} by {device.updated_by || "—"}</p>}
        {isAdmin && (
          <div className="mt-3 flex flex-wrap gap-2">
            <button className={primary} disabled={busy} onClick={() => void save()}>
              {deviceId === "new" ? "Register device" : device?.registry_status === "auto" ? "Save and mark reviewed" : "Save"}
            </button>
            {deviceId !== "new" && <button className={button} disabled={busy} onClick={() => void remove()}>Remove from registry</button>}
          </div>
        )}
      </Section>
    </Drawer>
  );
}

const gatewayForm = (detail?: GatewayDetail | null): GatewayRegistryInput => ({
  display_name: detail?.gateway.display_name ?? null, serial_number: detail?.gateway.serial_number ?? null,
  asset_tag: detail?.gateway.asset_tag ?? null, registry_notes: detail?.gateway.registry_notes ?? null,
  registry_status: detail?.gateway.registry_status === "retired" ? "retired" : "registered",
  unit_id: detail?.gateway.unit_id ?? null,
});

export function GatewayDrawer({ gatewayId, wards, isAdmin, onClose, onChanged, onOpenDevice }: {
  gatewayId: string | "new"; wards: WardInfo[]; isAdmin: boolean; onClose: () => void; onChanged: () => void;
  onOpenDevice: (id: number) => void;
}) {
  const [detail, setDetail] = useState<GatewayDetail | null>(null);
  const [loadedAt, setLoadedAt] = useState(0);
  const [form, setForm] = useState<GatewayRegistryInput>(gatewayForm());
  const [newId, setNewId] = useState("");
  const [days, setDays] = useState(7);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (gatewayId === "new") return;
    let cancelled = false;
    getGatewayDetail(gatewayId, days).then(result => {
      if (cancelled) return;
      setLoadedAt(Date.now());
      setDetail(result);
      setForm(gatewayForm(result));
    }).catch(reason => !cancelled && setError(reason instanceof Error ? reason.message : String(reason)));
    return () => { cancelled = true; };
  }, [gatewayId, days]);

  const save = async () => {
    setBusy(true);
    setError("");
    try {
      if (gatewayId === "new") await registerGateway({ ...form, gateway_id: newId.trim() });
      else await updateRegistryGateway(gatewayId, form);
      onChanged();
      onClose();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };
  const set = <K extends keyof GatewayRegistryInput>(key: K, value: GatewayRegistryInput[K]) => setForm(current => ({ ...current, [key]: value }));
  const gateway = detail?.gateway;
  const site = (gateway?.site || {}) as Record<string, string | null>;

  return (
    <Drawer title={gatewayId === "new" ? "Register gateway" : gateway?.display_name || site.display_name || gatewayId}
      subtitle={gateway ? (
        <span className="inline-flex flex-wrap items-center gap-2">
          <span className={`h-2.5 w-2.5 rounded-full ${CONNECTION_DOT[gateway.connection_status]}`} />
          <span className="capitalize">{gateway.connection_status}</span> · last check-in {ago(gateway.last_seen_at)}
          <span className="font-mono text-xs">{gateway.gateway_id}</span>
          {gateway.registry_status === "auto" && <span className="rounded-full bg-amber-100 px-2 text-xs font-semibold text-amber-800">Connected without registration — review</span>}
        </span>) : null}
      onClose={onClose}>
      {error && <div className="rounded-lg border border-rose-300 bg-rose-50 px-3 py-2 text-sm text-rose-800">{error}</div>}
      {gateway && detail && (
        <>
          <Section title="Gateway service activity" action={
            <select className="rounded-lg border border-[var(--app-border)] bg-[var(--app-control-bg)] px-2 py-1 text-xs" value={days}
              onChange={event => setDays(Number(event.target.value))} aria-label="Range">
              {[1, 7, 14, 30].map(value => <option key={value} value={value}>{value === 1 ? "24 hours" : `${value} days`}</option>)}
            </select>}>
            <p className="mb-2 text-sm text-[var(--app-muted)]">Running {percent(detail.uptime)} of the time · version {gateway.version || "—"} · licence {gateway.enabled_devices}/{gateway.max_devices ?? gateway.license?.max_devices ?? "—"} devices</p>
            <HeatGrid hours={detail.hours} start={detail.hours_start} now={loadedAt} />
          </Section>
          <Section title={`Devices (${detail.devices.length})`}>
            {detail.devices.length ? (
              <ul className="divide-y divide-[var(--app-border)] text-sm">
                {detail.devices.map(device => (
                  <li key={device.id}>
                    <button className="flex w-full items-center justify-between gap-3 py-2 text-left hover:bg-[var(--app-control-bg-hover)]" onClick={() => onOpenDevice(device.id)}>
                      <span className="min-w-0 truncate"><span className="font-medium">{device.display_name}</span> <span className="text-[var(--app-muted)]">· {device.unit_name || "Unassigned"}</span></span>
                      <span className="font-mono text-xs text-[var(--app-muted)]">{device.gateway_device_id}</span>
                    </button>
                  </li>
                ))}
              </ul>
            ) : <p className="text-sm text-[var(--app-muted)]">No registered devices on this gateway.</p>}
          </Section>
          <Section title="Recent on / off events"><EventList events={detail.events} showDevice /></Section>
        </>
      )}
      <Section title="Registry">
        <div className="grid gap-3 sm:grid-cols-2">
          {gatewayId === "new" && (
            <Field label="Gateway ID * (FLORA_GATEWAY_ID on the gateway)" wide>
              <input className={input} value={newId} onChange={event => setNewId(event.target.value)} placeholder="gateway-hospital-01-b" />
            </Field>
          )}
          <Field label="Name" wide><input className={input} disabled={!isAdmin} value={form.display_name ?? ""} onChange={event => set("display_name", event.target.value || null)} placeholder={site.display_name || ""} /></Field>
          <Field label="Serial number"><input className={input} disabled={!isAdmin} value={form.serial_number ?? ""} onChange={event => set("serial_number", event.target.value || null)} /></Field>
          <Field label="Asset tag"><input className={input} disabled={!isAdmin} value={form.asset_tag ?? ""} onChange={event => set("asset_tag", event.target.value || null)} /></Field>
          <Field label="Ward (installed in)">
            <select className={input} disabled={!isAdmin} value={form.unit_id ?? ""} onChange={event => set("unit_id", event.target.value ? Number(event.target.value) : null)}>
              <option value="">Unassigned</option>
              {wards.map(ward => <option key={ward.key} value={ward.key}>{ward.name}</option>)}
            </select>
          </Field>
          <Field label="Status">
            <select className={input} disabled={!isAdmin} value={form.registry_status} onChange={event => set("registry_status", event.target.value as GatewayRegistryInput["registry_status"])}>
              <option value="registered">Registered</option>
              <option value="retired">Retired</option>
            </select>
          </Field>
          <Field label="Notes" wide><textarea className={`${input} min-h-20`} disabled={!isAdmin} value={form.registry_notes ?? ""} onChange={event => set("registry_notes", event.target.value || null)} /></Field>
        </div>
        {gateway && <p className="mt-2 text-xs text-[var(--app-muted)]">First check-in {gateway.first_seen_at ? new Date(gateway.first_seen_at).toLocaleString() : "not yet"}{gateway.registered_at ? ` · registered ${new Date(gateway.registered_at).toLocaleDateString()} by ${gateway.registered_by || "—"}` : ""}. The physical location (room, floor) is set in Topology → Set location.</p>}
        {isAdmin && (
          <div className="mt-3">
            <button className={primary} disabled={busy || (gatewayId === "new" && newId.trim().length < 3)} onClick={() => void save()}>
              {gatewayId === "new" ? "Register gateway" : gateway?.registry_status === "auto" ? "Register" : "Save"}
            </button>
          </div>
        )}
      </Section>
    </Drawer>
  );
}
