import { useCallback, useEffect, useMemo, useState } from "react";
import {
  getPhysicalTopology, setLeafBeds,
  type PhysicalDevice, type PhysicalLeaf, type PhysicalTopology, type PhysicalUnit,
} from "../../api/fleetApi";

// Canopy → Topology → Physical: Care unit → Room (zone) → Bed. A bed shows the Leaf serving it (one
// Leaf may serve one bed or several), that Leaf's gateways, and the devices fixed at the bed. Devices
// that are not fixed at a bed (mobile / shared biomed, e.g. IPD or ER non-trauma) appear only under
// the Leaf → gateway connection.

const DOT: Record<string, string> = {
  online: "bg-emerald-500", delayed: "bg-amber-400", offline: "bg-rose-500", pending: "bg-slate-300",
  disabled: "bg-slate-300", not_connected: "bg-slate-300",
};
const SOURCE: Record<PhysicalDevice["source"], { icon: string; title: string }> = {
  both: { icon: "🛏🔗", title: "Fixed at this bed, connected through a gateway" },
  bed: { icon: "🛏", title: "Fixed at this bed, not connected to a gateway" },
  gateway: { icon: "🔗", title: "Connected through a gateway, not fixed at a bed (mobile / shared)" },
};
const ICON: Record<string, string> = { patient_monitor: "📈", ventilator: "🫁", anesthesia_machine: "💨", infusion_pump: "💉" };

function deviceIcon(device: PhysicalDevice) {
  if (device.category && ICON[device.category]) return ICON[device.category];
  const type = device.device_type || "";
  if (/vent/i.test(type)) return "🫁";
  if (/monitor|vista|m540/i.test(type)) return "📈";
  if (/pump|bcc/i.test(type)) return "💉";
  if (/anesth|carestation|aisys/i.test(type)) return "💨";
  return "🔌";
}

function DeviceChip({ device }: { device: PhysicalDevice }) {
  return (
    <span title={`${SOURCE[device.source].title} · ${device.state.replace("_", " ")}${device.gateway_device_id ? ` · ${device.gateway_device_id}` : ""}`}
      className="inline-flex max-w-full items-center gap-1 rounded-lg border border-[var(--app-border)] bg-[var(--app-control-bg)] px-1.5 py-0.5 text-[11px] text-[var(--app-text)]">
      <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${DOT[device.state]}`} />
      <span aria-hidden="true">{deviceIcon(device)}</span>
      <span className="truncate">{device.label}</span>
      <span className="shrink-0 opacity-60" aria-hidden="true">{SOURCE[device.source].icon}</span>
    </span>
  );
}

function LeafBedsEditor({ leaf, unit, onClose, onSaved }: {
  leaf: PhysicalLeaf; unit: PhysicalUnit; onClose: () => void; onSaved: () => void;
}) {
  const [chosen, setChosen] = useState(new Set(leaf.bed_ids.filter(id => id !== leaf.primary_bed_id)));
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    try { await setLeafBeds(leaf.leaf_id, [...chosen]); onSaved(); } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      setBusy(false);
    }
  };
  return (
    <div className="fixed inset-0 z-[1100] flex items-center justify-center bg-black/30 p-4" onClick={onClose}>
      <div role="dialog" aria-label="Beds served" className="max-h-[85vh] w-full max-w-xl overflow-y-auto rounded-2xl bg-[var(--app-panel-bg)] p-5 shadow-2xl" onClick={event => event.stopPropagation()}>
        <h2 className="text-lg font-semibold text-[var(--app-text)]">Beds served by {leaf.display_name}</h2>
        <p className="mt-1 text-sm text-[var(--app-muted)]">The primary bed (★) is set in Infrastructure → assign Leaf. Tick further beds in {unit.name} this workstation serves.</p>
        {error && <div className="mt-3 rounded-lg border border-rose-300 bg-rose-50 px-3 py-2 text-sm text-rose-800">{error}</div>}
        <div className="mt-4 space-y-3">
          {unit.rooms.map(room => (
            <div key={room.id}>
              <div className="text-xs font-bold uppercase tracking-wide text-[var(--app-muted)]">{room.name}{room.zone ? ` · ${room.zone}` : ""}</div>
              <div className="mt-1 flex flex-wrap gap-2">
                {room.beds.map(bed => {
                  const primary = bed.id === leaf.primary_bed_id;
                  const other = bed.leaf_id && bed.leaf_id !== leaf.leaf_id;
                  return (
                    <label key={bed.id} className={`inline-flex items-center gap-1.5 rounded-lg border px-2 py-1 text-sm ${other ? "opacity-50" : ""} border-[var(--app-border)] text-[var(--app-text)]`}
                      title={other ? `Served by ${bed.leaf_id}` : undefined}>
                      <input type="checkbox" disabled={primary || !!other} checked={primary || chosen.has(bed.id)}
                        onChange={event => setChosen(current => {
                          const next = new Set(current);
                          if (event.target.checked) next.add(bed.id); else next.delete(bed.id);
                          return next;
                        })} />
                      {primary ? "★ " : ""}{bed.name}
                    </label>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
        <div className="mt-5 flex gap-2">
          <button className="rounded-lg bg-[var(--app-accent)] px-3 py-1.5 text-sm font-semibold text-[var(--app-accent-contrast)] disabled:opacity-50" disabled={busy} onClick={() => void save()}>Save</button>
          <button className="rounded-lg border border-[var(--app-border)] px-3 py-1.5 text-sm font-semibold text-[var(--app-text)]" onClick={onClose}>Cancel</button>
        </div>
      </div>
    </div>
  );
}

export default function PhysicalTopologyView({ isAdmin }: { isAdmin: boolean }) {
  const [data, setData] = useState<PhysicalTopology | null>(null);
  const [error, setError] = useState("");
  const [unitKey, setUnitKey] = useState("");
  const [editing, setEditing] = useState<{ leaf: PhysicalLeaf; unit: PhysicalUnit } | null>(null);

  const load = useCallback(async () => {
    try { setData(await getPhysicalTopology()); setError(""); } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Physical topology is unavailable.");
    }
  }, []);
  useEffect(() => {
    let cancelled = false;
    const tick = () => getPhysicalTopology()
      .then(result => { if (!cancelled) { setData(result); setError(""); } })
      .catch(reason => { if (!cancelled) setError(reason instanceof Error ? reason.message : String(reason)); });
    void tick();
    const timer = window.setInterval(() => void tick(), 15_000);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, []);

  const units = useMemo(() => (data?.units || []).filter(unit => !unitKey || unit.key === unitKey), [data, unitKey]);
  const bedName = useMemo(() => {
    const names = new Map<number, string>();
    data?.units.forEach(unit => unit.rooms.forEach(room => room.beds.forEach(bed => names.set(bed.id, `${room.name} · ${bed.name}`))));
    return names;
  }, [data]);

  if (error && !data) return <div className="m-4 rounded-xl border border-rose-300 bg-rose-50 px-4 py-3 text-sm text-rose-800">{error}</div>;
  if (!data) return <div className="p-6 text-sm text-[var(--app-muted)]">Loading…</div>;

  return (
    <div className="h-full overflow-y-auto p-3 sm:p-5">
      <div className="w-full space-y-4">
        <div className="flex flex-wrap items-center gap-2">
          <select className="rounded-xl border border-[var(--app-border)] bg-[var(--app-control-bg)] px-3 py-2 text-sm text-[var(--app-text)]"
            value={unitKey} onChange={event => setUnitKey(event.target.value)} aria-label="Care unit">
            <option value="">All care units</option>
            {data.units.map(unit => <option key={unit.key} value={unit.key}>{unit.name}</option>)}
          </select>
          <span className="text-xs text-[var(--app-muted)]">
            {Object.values(SOURCE).map(source => `${source.icon} ${source.title.split(",")[0].toLowerCase()}`).join(" · ")}
          </span>
        </div>

        {units.map(unit => {
          const unitBeds = new Set(unit.rooms.flatMap(room => room.beds.map(bed => bed.id)));
          const unitLeaves = Object.values(data.leaves).filter(leaf => leaf.bed_ids.some(id => unitBeds.has(id)));
          const bedCount = unitBeds.size;
          return (
            <section key={unit.key} className="rounded-2xl border border-[var(--app-border)] bg-[var(--app-panel-bg)]">
              <header className="flex flex-wrap items-baseline justify-between gap-2 border-b border-[var(--app-border)] px-4 py-3">
                <div>
                  <span className="text-lg font-semibold text-[var(--app-text)]">🏬 {unit.name}</span>
                  {unit.building_name && <span className="ml-2 text-sm text-[var(--app-muted)]">{unit.building_name}</span>}
                </div>
                <span className="text-sm text-[var(--app-muted)]">{unit.rooms.length} rooms · {bedCount} beds · {unitLeaves.length} Leafs</span>
              </header>

              {unitLeaves.length > 0 && (
                <div className="border-b border-[var(--app-border)] px-4 py-3">
                  <div className="mb-2 text-[11px] font-bold uppercase tracking-[0.14em] text-[var(--app-muted)]">Leaf workstations → gateways</div>
                  <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-3">
                    {unitLeaves.map(leaf => (
                      <div key={leaf.leaf_id} className="rounded-xl border border-[var(--app-border)] p-3">
                        <div className="flex items-center justify-between gap-2">
                          <span className="inline-flex min-w-0 items-center gap-2 font-semibold text-[var(--app-text)]">
                            <span className={`h-2.5 w-2.5 shrink-0 rounded-full ${DOT[leaf.connection_status]}`} />🖥️
                            <span className="truncate">{leaf.display_name}</span>
                          </span>
                          {isAdmin && <button className="shrink-0 rounded-lg border border-[var(--app-border)] px-2 py-0.5 text-xs text-[var(--app-text)] hover:bg-[var(--app-control-bg-hover)]"
                            onClick={() => setEditing({ leaf, unit })}>Beds…</button>}
                        </div>
                        <div className="mt-1 text-xs text-[var(--app-muted)]">
                          {leaf.bed_ids.length === 1 ? "1 bed" : `${leaf.bed_ids.length} beds (shared workstation)`}: {leaf.bed_ids.map(id => bedName.get(id) || id).join(", ")}
                          {leaf.active_cases ? ` · ${leaf.active_cases} active case${leaf.active_cases === 1 ? "" : "s"}` : ""}
                        </div>
                        <div className="mt-2 flex flex-wrap gap-1.5">
                          {leaf.gateways.length ? leaf.gateways.map(id => {
                            const gateway = data.gateways[id];
                            return <span key={id} className="inline-flex items-center gap-1 rounded-lg bg-orange-500/10 px-1.5 py-0.5 text-[11px] font-semibold text-orange-700 dark:text-orange-300">
                              <span className={`h-1.5 w-1.5 rounded-full ${DOT[gateway?.connection_status || "pending"]}`} />📡 {gateway?.name || id}
                            </span>;
                          }) : <span className="text-[11px] text-[var(--app-muted)]">No gateway connected</span>}
                        </div>
                        {leaf.devices.length > 0 && (
                          <div className="mt-2">
                            <div className="text-[10px] uppercase tracking-wide text-[var(--app-muted)]">Through the gateway (not fixed at a bed)</div>
                            <div className="mt-1 flex flex-wrap gap-1">{leaf.devices.map(device => <DeviceChip key={device.key} device={device} />)}</div>
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              )}

              <div className="space-y-4 px-4 py-3">
                {unit.rooms.map(room => (
                  <div key={room.id}>
                    <div className="mb-2 flex items-center gap-2">
                      <span className="text-sm font-semibold text-[var(--app-text)]">🚪 {room.name}</span>
                      {room.zone && <span className="rounded-full bg-[var(--app-control-bg)] px-2 py-0.5 text-[11px] font-semibold text-[var(--app-text)]">{room.zone}</span>}
                      <span className="text-xs text-[var(--app-muted)]">{room.beds.length} bed{room.beds.length === 1 ? "" : "s"}</span>
                    </div>
                    <div className="grid grid-cols-[repeat(auto-fill,minmax(190px,1fr))] gap-2">
                      {room.beds.map(bed => {
                        const leaf = bed.leaf_id ? data.leaves[bed.leaf_id] : null;
                        return (
                          <div key={bed.id} className={`rounded-xl border p-2.5 ${leaf ? "border-[var(--app-border)]" : "border-dashed border-[var(--app-border)]"}`}>
                            <div className="text-sm font-semibold text-[var(--app-text)]">🛏 {bed.name}</div>
                            {leaf ? (
                              <div className="mt-1 flex items-center gap-1.5 text-xs text-[var(--app-text)]" title={leaf.leaf_id}>
                                <span className={`h-2 w-2 rounded-full ${DOT[leaf.connection_status]}`} />
                                <span className="truncate">{bed.id === leaf.primary_bed_id ? "★ " : ""}{leaf.display_name}</span>
                                {leaf.bed_ids.length > 1 && <span className="shrink-0 rounded bg-cyan-500/10 px-1 text-[10px] font-semibold text-cyan-700 dark:text-cyan-300">shared · {leaf.bed_ids.length}</span>}
                              </div>
                            ) : <div className="mt-1 text-xs text-[var(--app-muted)]">No Leaf</div>}
                            {bed.devices.length > 0 && <div className="mt-2 flex flex-wrap gap-1">{bed.devices.map(device => <DeviceChip key={device.key} device={device} />)}</div>}
                          </div>
                        );
                      })}
                    </div>
                  </div>
                ))}
                {!unit.rooms.length && <p className="text-sm text-[var(--app-muted)]">No rooms yet — add them in Infrastructure → Wards, rooms & beds.</p>}
              </div>
            </section>
          );
        })}
      </div>
      {editing && <LeafBedsEditor leaf={editing.leaf} unit={editing.unit} onClose={() => setEditing(null)}
        onSaved={() => { setEditing(null); void load(); }} />}
    </div>
  );
}
