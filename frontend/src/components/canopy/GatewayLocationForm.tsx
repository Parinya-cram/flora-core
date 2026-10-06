import { useState } from "react";
import { setGatewaySite, type GatewaySiteInput } from "../../api/gatewaySiteApi";

type Ward = { key: string; name: string; building_name: string | null };

const input = "mt-1 w-full rounded-lg border border-[var(--app-border)] bg-[var(--app-control-bg)] px-3 py-2 text-sm text-[var(--app-text)]";
const label = "block text-[10px] font-bold uppercase tracking-[0.12em] text-[var(--app-muted)]";

/** Sets where a gateway is installed. The gateway shows it read-only and applies it at its next check-in. */
export default function GatewayLocationForm({ gatewayId, site, wards, onSaved }: {
  gatewayId: string;
  site: Record<string, string | number | null | undefined>;
  wards: Ward[];
  onSaved?: (message: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState<GatewaySiteInput>({
    unit_id: site.canopy_unit_id != null ? Number(site.canopy_unit_id) : null,
    display_name: (site.display_name as string) || "",
    unit_type: (site.unit_type as GatewaySiteInput["unit_type"]) || null,
    floor: (site.floor as string) || "",
    room: (site.room as string) || "",
    contact: (site.contact as string) || "",
    notes: (site.notes as string) || "",
  });
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const set = (key: keyof GatewaySiteInput, value: string | number | null) => setForm(current => ({ ...current, [key]: value }));

  const save = async () => {
    setBusy(true);
    setError("");
    try {
      const clean = Object.fromEntries(Object.entries(form).map(([key, value]) => [key, value === "" ? null : value])) as GatewaySiteInput;
      await setGatewaySite(gatewayId, clean);
      const text = "Location saved. The gateway applies it at its next check-in (within about 30 seconds).";
      setMessage(text);
      setOpen(false);
      onSaved?.(text);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  if (!open) {
    return <div className="mt-3">
      <button type="button" onClick={() => setOpen(true)}
        className="rounded-lg border border-[var(--app-border)] bg-[var(--app-control-bg)] px-3 py-1.5 text-sm font-semibold text-[var(--app-text)]">
        Set location…
      </button>
      {message ? <p className="mt-2 text-xs text-emerald-600 dark:text-emerald-400">{message}</p> : null}
    </div>;
  }
  return <div className="mt-3 grid grid-cols-2 gap-3">
    <div className="col-span-2">
      <label className={label}>Ward</label>
      <select className={input} value={form.unit_id ?? ""} onChange={event => set("unit_id", event.target.value ? Number(event.target.value) : null)}>
        <option value="">— Not in a ward —</option>
        {wards.map(ward => <option key={ward.key} value={ward.key}>{ward.name}{ward.building_name ? ` · ${ward.building_name}` : ""}</option>)}
      </select>
    </div>
    <div className="col-span-2">
      <label className={label}>Station name</label>
      <input className={input} value={form.display_name || ""} onChange={event => set("display_name", event.target.value)} placeholder="OR-1 anaesthesia station" />
    </div>
    <div>
      <label className={label}>Unit type</label>
      <select className={input} value={form.unit_type || ""} onChange={event => set("unit_type", event.target.value || null)}>
        <option value="">—</option><option value="or">Operating room</option><option value="icu">ICU</option>
        <option value="er">Emergency</option><option value="ward">Ward</option><option value="other">Other</option>
      </select>
    </div>
    <div><label className={label}>Floor</label><input className={input} value={form.floor || ""} onChange={event => set("floor", event.target.value)} /></div>
    <div><label className={label}>Room / bed</label><input className={input} value={form.room || ""} onChange={event => set("room", event.target.value)} /></div>
    <div><label className={label}>Contact</label><input className={input} value={form.contact || ""} onChange={event => set("contact", event.target.value)} placeholder="Biomed / IT" /></div>
    <div className="col-span-2"><label className={label}>Notes</label><textarea className={input} rows={2} value={form.notes || ""} onChange={event => set("notes", event.target.value)} /></div>
    {error ? <p className="col-span-2 text-sm text-rose-500">{error}</p> : null}
    <div className="col-span-2 flex justify-end gap-2">
      <button type="button" onClick={() => setOpen(false)} disabled={busy} className="rounded-lg border border-[var(--app-border)] px-3 py-1.5 text-sm text-[var(--app-text)]">Cancel</button>
      <button type="button" onClick={() => void save()} disabled={busy} className="rounded-lg bg-[var(--app-accent)] px-3 py-1.5 text-sm font-semibold text-white disabled:opacity-50">{busy ? "Saving…" : "Save location"}</button>
    </div>
  </div>;
}
