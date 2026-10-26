import { useMemo, useState } from "react";
import type { ActiveCase } from "../../api/caseApi";
import { setBedDevices, type RegisteredGateway, type WardBed, type WardBedDevice } from "../../api/wardApi";
import { useLanguage } from "../../context/LanguageContext";

const TEXT = {
  en: {
    session: "Session", free: "Free — no session at this bed", open: "Open session", start: "Start session", close: "Close",
    devices: "Devices at this bed", none: "No devices placed at this bed yet.", edit: "Choose devices", save: "Save",
    cancel: "Cancel", saving: "Saving…", hint: "Saved in Canopy; this bed's next session binds them. A device belongs to one bed.",
    atBed: "at", online: "online", offline: "offline", parser: "parser", otherLeaf: "set for another Leaf", noLink: "no link to its gateway",
    started: "Started", hn: "HN", gatewayOff: "gateway offline", search: "Search devices…",
  },
  th: {
    session: "Session", free: "ว่าง — ยังไม่มี session ที่เตียงนี้", open: "เข้า session", start: "เริ่ม session", close: "ปิด",
    devices: "อุปกรณ์ประจำเตียง", none: "ยังไม่มีอุปกรณ์ประจำเตียงนี้", edit: "เลือกอุปกรณ์", save: "บันทึก",
    cancel: "ยกเลิก", saving: "กำลังบันทึก…", hint: "บันทึกที่ Canopy session ถัดไปของเตียงนี้จะผูกอุปกรณ์เหล่านี้ อุปกรณ์หนึ่งตัวอยู่ได้เตียงเดียว",
    atBed: "อยู่ที่", online: "ออนไลน์", offline: "ออฟไลน์", parser: "parser", otherLeaf: "ถูกตั้งให้ Leaf อื่น", noLink: "ยังไม่ได้เชื่อม Gateway นี้",
    started: "เริ่ม", hn: "HN", gatewayOff: "Gateway ออฟไลน์", search: "ค้นหาอุปกรณ์…",
  },
};

type Props = {
  bed: WardBed;
  beds: WardBed[];
  occupant?: ActiveCase;
  gateways: RegisteredGateway[];
  linkedGateways: ReadonlySet<string>;
  leafId: string;
  canStart: boolean;
  canConfigure: boolean;
  onOpen: (caseId: number) => void;
  onStart: (bed: WardBed) => void;
  onSaved: () => void;
  onClose: () => void;
};

const key = (device: { gateway_id?: string | null; device_id: string }) => `${device.gateway_id || ""}/${device.device_id}`;

/** One bed seen from its Leaf: its session, its devices and their state; an administrator chooses the bed's devices. */
export default function BedDialog({ bed, beds, occupant, gateways, linkedGateways, leafId, canStart, canConfigure, onOpen, onStart, onSaved, onClose }: Props) {
  const { language } = useLanguage();
  const L = TEXT[language === "th" ? "th" : "en"];
  const [editing, setEditing] = useState(false);
  const [chosen, setChosen] = useState<Set<string>>(() => new Set(bed.devices.map(key)));
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  // Where each device sits now (another bed of this Leaf), to say so in the picker.
  const placedAt = useMemo(() => new Map(beds.filter(other => other.bed_location_id !== bed.bed_location_id)
    .flatMap(other => other.devices.map(device => [key(device), other.bed_name] as const))), [beds, bed.bed_location_id]);
  const all = useMemo(() => gateways.flatMap(gateway => gateway.devices.map(device => ({ ...device, gateway_id: gateway.gateway_id, gatewayOnline: gateway.online, site: gateway.site_name }))), [gateways]);
  const state = (device: WardBedDevice) => {
    const gateway = gateways.find(item => item.gateway_id === device.gateway_id);
    const info = gateway?.devices.find(item => item.device_id === device.device_id);
    if (!linkedGateways.has(device.gateway_id)) return { tone: "#d97706", text: L.noLink };
    if (!gateway?.online) return { tone: "#e24b4a", text: L.gatewayOff };
    if (info?.leaf_id && info.leaf_id !== leafId) return { tone: "#d97706", text: L.otherLeaf };
    if (info?.parser_status && info.parser_status !== "running") return { tone: "#e24b4a", text: `${L.parser} ${info.parser_status}` };
    return { tone: "#1d9e75", text: L.online };
  };
  const save = async () => {
    setBusy(true); setError("");
    try {
      const devices = all.filter(device => chosen.has(key(device)))
        .map(device => ({ gateway_id: device.gateway_id, device_id: device.device_id, label: device.label || null, device_type: device.device_type }));
      await setBedDevices(bed.bed_location_id, devices);
      setEditing(false);
      onSaved();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };
  const shown = all.filter(device => !query.trim() || [device.label, device.device_id, device.device_type, device.site]
    .join(" ").toLowerCase().includes(query.trim().toLowerCase()));
  const button = "rounded-lg border border-[var(--app-border)] px-3 py-1.5 text-sm font-semibold hover:bg-[var(--app-control-bg-hover)]";
  const primary = "rounded-lg bg-[var(--app-accent)] px-3 py-1.5 text-sm font-bold text-[var(--app-accent-contrast)] disabled:opacity-50";

  return <div className="fixed inset-0 z-[1300] flex items-center justify-center bg-black/50 p-4" role="dialog" aria-modal="true" aria-label={bed.bed_name}
    onClick={event => { if (event.target === event.currentTarget) onClose(); }}>
    <div className="max-h-[90vh] w-full max-w-xl overflow-y-auto rounded-2xl border border-[var(--app-border)] bg-[var(--app-panel-bg)] p-5 text-[var(--app-text)] shadow-2xl">
      <header className="flex items-start justify-between gap-3">
        <div>
          <div className="text-xs text-[var(--app-muted)]">{bed.room_name}{bed.bed_code ? ` · ${bed.bed_code}` : ""}</div>
          <h3 className="text-2xl font-extrabold">{bed.bed_name}</h3>
        </div>
        <button type="button" className={button} onClick={onClose}>{L.close}</button>
      </header>

      <section className="mt-4 rounded-xl border border-[var(--app-border)] p-3">
        <div className="text-[10px] font-bold uppercase tracking-[0.12em] text-[var(--app-muted)]">{L.session}</div>
        {occupant ? <div className="mt-1 flex flex-wrap items-center justify-between gap-2">
          <div>
            <div className="text-lg font-bold">{occupant.patient_name || `${L.hn} ${occupant.hn}`}</div>
            <div className="text-xs text-[var(--app-muted)]">{L.hn} {occupant.hn}{occupant.admission_number ? ` · AN ${occupant.admission_number}` : ""} · {L.started} {new Date(occupant.start_time).toLocaleString()}</div>
          </div>
          <button type="button" className={primary} onClick={() => onOpen(occupant.case_id)}>{L.open}</button>
        </div> : <div className="mt-1 flex flex-wrap items-center justify-between gap-2">
          <div className="text-sm text-[var(--app-muted)]">{L.free}</div>
          {canStart ? <button type="button" className={primary} onClick={() => onStart(bed)}>+ {L.start}</button> : null}
        </div>}
      </section>

      <section className="mt-4">
        <div className="mb-2 flex items-center justify-between gap-2">
          <div className="text-sm font-bold">{L.devices}</div>
          {canConfigure && !editing ? <button type="button" className={button} onClick={() => setEditing(true)}>{L.edit}</button> : null}
        </div>
        {!editing ? (bed.devices.length ? <ul className="space-y-1.5">
          {bed.devices.map(device => {
            const s = state(device);
            const bound = occupant?.devices.find(binding => binding.device_id === device.device_id && !binding.released_at);
            return <li key={key(device)} className="flex items-center justify-between gap-2 rounded-lg border border-[var(--app-border)] px-3 py-2 text-sm">
              <span className="flex min-w-0 items-center gap-2">
                <span className="inline-block h-2 w-2 shrink-0 rounded-full" style={{ background: s.tone }} />
                <span className="truncate"><b>{device.label || device.device_id}</b> <span className="text-[var(--app-muted)]">· {device.device_type || ""}</span></span>
              </span>
              <span className="shrink-0 text-xs text-[var(--app-muted)]">{s.text}{bound?.stream?.connected ? " · live" : ""}</span>
            </li>;
          })}
        </ul> : <div className="text-sm text-[var(--app-muted)]">{L.none}</div>) : <div className="space-y-2">
          <input value={query} onChange={event => setQuery(event.target.value)} placeholder={L.search}
            className="h-9 w-full rounded-lg border border-[var(--app-border)] bg-[var(--app-control-bg)] px-2 text-sm outline-none focus:border-[var(--app-accent)]" />
          <ul className="max-h-72 space-y-1 overflow-y-auto">
            {shown.map(device => {
              const id = key(device), elsewhere = placedAt.get(id);
              return <li key={id}>
                <label className="flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-sm hover:bg-[var(--app-control-bg-hover)]">
                  <input type="checkbox" checked={chosen.has(id)} disabled={busy}
                    onChange={event => setChosen(current => { const next = new Set(current); if (event.target.checked) next.add(id); else next.delete(id); return next; })} />
                  <span className="min-w-0 flex-1 truncate"><b>{device.label || device.device_id}</b> <span className="text-[var(--app-muted)]">· {device.device_type} · {device.site}</span></span>
                  {elsewhere ? <span className="shrink-0 text-[11px] text-amber-600">{L.atBed} {elsewhere}</span> : null}
                </label>
              </li>;
            })}
          </ul>
          <p className="text-xs text-[var(--app-muted)]">{L.hint}</p>
          {error ? <div className="rounded-lg border border-rose-500/40 bg-rose-500/10 px-3 py-2 text-xs text-rose-500">{error}</div> : null}
          <div className="flex justify-end gap-2">
            <button type="button" className={button} disabled={busy} onClick={() => { setEditing(false); setChosen(new Set(bed.devices.map(key))); }}>{L.cancel}</button>
            <button type="button" className={primary} disabled={busy} onClick={() => void save()}>{busy ? L.saving : L.save}</button>
          </div>
        </div>}
      </section>
    </div>
  </div>;
}
