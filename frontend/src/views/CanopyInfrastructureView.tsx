import { useCallback, useEffect, useMemo, useState } from "react";
import {
  adoptObservedLeafLocation,
  applyLeafGroupSettings,
  assignLeafLocation,
  createControlLocation,
  createLeafGroup,
  getControlPlane,
  updateControlLocation,
  updateLeafIdentity,
  updateLeafGroup,
  updateLeafGroupMembers,
  type ControlPlane,
  type ControlPlaneGroup,
  type ControlPlaneLocation,
  type ControlPlaneLeaf,
} from "../api/fleetApi";
import { generateDemoWard, getDemoWardStatus, removeDemoWard, type DemoWardStatus } from "../api/demoApi";
import CanopyHl7InterfacePanel from "./CanopyHl7InterfacePanel";

type Tab = "locations" | "leaves" | "groups" | "hl7";
type LocationKind = ControlPlaneLocation["kind"];

const kindLabel: Record<LocationKind, string> = {
  hospital: "Hospital",
  building: "Building",
  care_unit: "Care unit",
  room: "Room",
  bed: "Bed / workstation",
};
const nextKind: Partial<Record<LocationKind, LocationKind>> = {
  hospital: "building",
  building: "care_unit",
  care_unit: "room",
  room: "bed",
};
const emptyLocation = (kind: LocationKind = "hospital", parent_id: number | null = null): Omit<ControlPlaneLocation, "id"> => ({
  parent_id,
  kind,
  code: "",
  name: "",
  is_active: true,
  sort_order: 0,
});

function locationPath(id: number | null | undefined, map: Map<number, ControlPlaneLocation>) {
  if (!id) return "Not assigned";
  const names: string[] = [];
  let current = map.get(id);
  const visited = new Set<number>();
  while (current && !visited.has(current.id)) {
    visited.add(current.id);
    names.unshift(current.name);
    current = current.parent_id ? map.get(current.parent_id) : undefined;
  }
  return names.join(" / ");
}

function statusStyle(status: ControlPlaneLeaf["config_status"]) {
  if (status === "synced") return "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300";
  if (status === "pending" || status === "outdated") return "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300";
  return "border-[var(--app-border)] bg-[var(--app-control-bg)] text-[var(--app-muted)]";
}

function formatDay(value: string | null) {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : date.toLocaleDateString();
}

/** Demo mode: generate or remove the synthetic "Demo Ward" used for example report statistics. */
function DemoModeCard({ onChanged }: { onChanged: () => Promise<void> }) {
  const [status, setStatus] = useState<DemoWardStatus | null>(null);
  const [busy, setBusy] = useState<"" | "generate" | "remove">("");
  const [error, setError] = useState("");
  const [note, setNote] = useState("");

  const refresh = useCallback(async () => {
    try { setStatus(await getDemoWardStatus()); setError(""); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "Unable to load demo mode status."); }
  }, []);
  useEffect(() => { void refresh(); }, [refresh]);

  const run = async (action: "generate" | "remove") => {
    const question = action === "generate"
      ? `${status?.exists ? "Replace the existing demo ward with" : "Create a demo ward with"} 200 synthetic cases from the past 30 days (3 still active today)?`
      : "Remove the demo ward and all of its synthetic Leafs, cases and report data?";
    if (!window.confirm(question)) return;
    setBusy(action); setError(""); setNote("");
    try {
      const result = action === "generate" ? await generateDemoWard({ cases: 200, days: 30, active: 3 }) : await removeDemoWard();
      setStatus(result);
      setNote(action === "generate"
        ? `Demo ward created: ${result.cases} cases (${result.active_cases} active) on ${result.leaves} demo Leafs in ${result.elapsed_seconds ?? "–"} s. Reload to select it in the ward switcher.`
        : "Demo data removed.");
      await onChanged();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Demo mode request failed.");
    } finally { setBusy(""); }
  };

  const button = "rounded-xl border px-4 py-2.5 text-sm font-semibold disabled:opacity-50";
  return <section className="rounded-2xl border border-amber-500/40 bg-[var(--app-panel-bg)] p-5">
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div className="min-w-0">
        <div className="flex items-center gap-2"><h2 className="font-semibold text-[var(--app-text)]">Demo mode</h2><span className="rounded-full border border-amber-500/50 bg-amber-500/15 px-2 py-0.5 text-[10px] font-extrabold uppercase tracking-[0.12em] text-amber-700 dark:text-amber-300">Demo data</span></div>
        <p className="mt-1 max-w-3xl text-xs text-[var(--app-muted)]">Creates a “Demo Ward” with 200 synthetic cases over the past month (vital signs and events from patient in to patient out; 3 cases still active today). It is used only for example report statistics and is excluded from the Canopy centre’s statistics — select the demo ward to view it.</p>
      </div>
      <div className="flex flex-wrap gap-2">
        <button type="button" className={`${button} border-[var(--app-accent)] bg-[var(--app-accent)] font-bold text-[var(--app-accent-contrast)]`} disabled={!!busy} onClick={() => void run("generate")}>{busy === "generate" ? "Generating…" : status?.exists ? "Regenerate demo ward" : "Generate demo ward"}</button>
        <button type="button" className={`${button} border-rose-500/40 bg-rose-500/10 text-rose-700 dark:text-rose-300`} disabled={!!busy || !status?.exists} onClick={() => void run("remove")}>{busy === "remove" ? "Removing…" : "Remove demo data"}</button>
      </div>
    </div>
    <div className="mt-4 grid gap-2 text-xs sm:grid-cols-2 lg:grid-cols-5">
      {[
        ["Status", status ? (status.exists ? status.ward?.name || "Demo Ward" : "Not created") : "Loading…"],
        ["Demo Leafs", status ? String(status.leaves) : "—"],
        ["Cases", status ? `${status.cases} (${status.active_cases} active)` : "—"],
        ["Report records", status ? String(status.archive_cases) : "—"],
        ["Period", status?.exists ? `${formatDay(status.first_case_at)} – ${formatDay(status.last_case_at)}` : "—"],
      ].map(([label, value]) => <div key={label} className="rounded-xl border border-[var(--app-border)] bg-[var(--app-control-bg)] px-3 py-2"><div className="text-[10px] font-bold uppercase tracking-wide text-[var(--app-muted)]">{label}</div><div className="mt-0.5 truncate font-semibold text-[var(--app-text)]">{value}</div></div>)}
    </div>
    {busy === "generate" ? <div className="mt-3 text-xs text-[var(--app-muted)]">Generating cases, vital signs and report records…</div> : null}
    {error ? <div className="mt-3 rounded-xl border border-rose-500/40 bg-rose-500/10 px-4 py-3 text-sm text-rose-600 dark:text-rose-300">{error}</div> : null}
    {note ? <div className="mt-3 flex flex-wrap items-center justify-between gap-2 rounded-xl border border-emerald-500/35 bg-emerald-500/10 px-4 py-3 text-sm text-emerald-700 dark:text-emerald-300"><span>{note}</span><button type="button" className="rounded-lg border border-emerald-500/40 px-3 py-1 text-xs font-bold" onClick={() => window.location.reload()}>Reload</button></div> : null}
  </section>;
}

export default function CanopyInfrastructureView() {
  const [tab, setTab] = useState<Tab>("locations");
  const [data, setData] = useState<ControlPlane>({ locations: [], groups: [], leaves: [] });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [note, setNote] = useState("");
  const [locationId, setLocationId] = useState<number | null>(null);
  const [locationDraft, setLocationDraft] = useState(emptyLocation());
  const [leafId, setLeafId] = useState("");
  const [leafName, setLeafName] = useState("");
  const [bedId, setBedId] = useState("");
  const [timezone, setTimezone] = useState("Asia/Bangkok");
  const [dateFormat, setDateFormat] = useState("DD/MM/YYYY");
  const [timeFormat, setTimeFormat] = useState("24h");
  const [groupId, setGroupId] = useState<number | null>(null);
  const [groupDraft, setGroupDraft] = useState({ name: "", description: "", is_active: true, leaf_ids: [] as string[] });

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setData(await getControlPlane());
      setError("");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Unable to load Canopy infrastructure.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const locationMap = useMemo(() => new Map(data.locations.map(item => [item.id, item])), [data.locations]);
  const orderedLocations = useMemo(() => {
    const result: Array<{ row: ControlPlaneLocation; depth: number }> = [];
    const visit = (parentId: number | null, depth: number) => {
      data.locations
        .filter(row => (row.parent_id || null) === parentId)
        .sort((a, b) => a.sort_order - b.sort_order || a.name.localeCompare(b.name))
        .forEach(row => { result.push({ row, depth }); visit(row.id, depth + 1); });
    };
    visit(null, 0);
    return result;
  }, [data.locations]);
  const beds = useMemo(() => data.locations.filter(row => row.kind === "bed" && row.is_active), [data.locations]);
  const selectedLeaf = data.leaves.find(row => row.leaf_id === leafId);

  const selectLocation = (row: ControlPlaneLocation) => {
    setLocationId(row.id);
    setLocationDraft({ parent_id: row.parent_id, kind: row.kind, code: row.code || "", name: row.name, is_active: row.is_active, sort_order: row.sort_order });
    setNote("");
  };
  const startHospital = () => { setLocationId(null); setLocationDraft(emptyLocation()); setNote(""); };
  const startChild = (parent: ControlPlaneLocation) => {
    const childKind = nextKind[parent.kind];
    if (!childKind) return;
    setLocationId(null);
    setLocationDraft(emptyLocation(childKind, parent.id));
    setNote("");
  };
  const saveLocation = async () => {
    if (!locationDraft.name.trim()) return;
    setSaving(true); setNote("");
    try {
      const payload = { ...locationDraft, name: locationDraft.name.trim(), code: locationDraft.code?.trim() || null };
      const saved = locationId ? await updateControlLocation(locationId, payload) : await createControlLocation(payload);
      await load(); selectLocation(saved); setNote(`${kindLabel[saved.kind]} saved.`);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Unable to save location."); }
    finally { setSaving(false); }
  };

  const selectLeaf = (leaf: ControlPlaneLeaf) => {
    setLeafId(leaf.leaf_id);
    setLeafName(leaf.display_name);
    setBedId(leaf.bed_location_id ? String(leaf.bed_location_id) : "");
    const desired = leaf.desired_config || {};
    setTimezone(String(desired.timezone || "Asia/Bangkok"));
    setDateFormat(String(desired.dateFormat || "DD/MM/YYYY"));
    setTimeFormat(String(desired.timeFormat || "24h"));
    setNote("");
  };
  const saveLeafName = async () => {
    if (!leafId || !leafName.trim()) return;
    setSaving(true); setNote("");
    try {
      await updateLeafIdentity(leafId, leafName.trim());
      await load(); setNote("Leaf name saved in Canopy. Future heartbeats will not overwrite it.");
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Unable to rename Leaf."); }
    finally { setSaving(false); }
  };
  const saveAssignment = async () => {
    if (!leafId || !bedId) return;
    setSaving(true); setNote("");
    try {
      await assignLeafLocation(leafId, { bed_location_id: Number(bedId), timezone, date_format: dateFormat, time_format: timeFormat });
      await load(); setNote("Configuration published. The Leaf will apply it on its next synchronization.");
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Unable to assign Leaf."); }
    finally { setSaving(false); }
  };
  const adoptLeaf = async () => {
    if (!leafId) return;
    setSaving(true); setNote("");
    try {
      await adoptObservedLeafLocation(leafId);
      await load(); setNote("Current Leaf location adopted. Canopy is now the configuration owner.");
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Unable to adopt Leaf location."); }
    finally { setSaving(false); }
  };

  const selectGroup = (group: ControlPlaneGroup) => {
    setGroupId(group.id);
    setGroupDraft({ name: group.name, description: group.description || "", is_active: group.is_active, leaf_ids: group.leaf_ids || [] });
    setNote("");
  };
  const startGroup = () => { setGroupId(null); setGroupDraft({ name: "", description: "", is_active: true, leaf_ids: [] }); setNote(""); };
  const toggleGroupLeaf = (id: string) => setGroupDraft(current => ({
    ...current,
    leaf_ids: current.leaf_ids.includes(id) ? current.leaf_ids.filter(value => value !== id) : [...current.leaf_ids, id],
  }));
  const saveGroup = async () => {
    if (!groupDraft.name.trim()) return;
    setSaving(true); setNote("");
    try {
      const base = { name: groupDraft.name.trim(), description: groupDraft.description.trim(), is_active: groupDraft.is_active };
      const saved = groupId ? await updateLeafGroup(groupId, base) : await createLeafGroup(base);
      await updateLeafGroupMembers(saved.id, groupDraft.leaf_ids);
      await load(); setGroupId(saved.id); setNote("Leaf group saved.");
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Unable to save Leaf group."); }
    finally { setSaving(false); }
  };
  const publishGroupSettings = async () => {
    if (!groupId) return;
    setSaving(true); setNote("");
    try {
      const result = await applyLeafGroupSettings(groupId, { timezone, date_format: dateFormat, time_format: timeFormat });
      await load(); setNote(`Configuration published to ${result.updated} assigned Leaf${result.updated === 1 ? "" : "s"}.`);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Unable to publish group configuration."); }
    finally { setSaving(false); }
  };

  const inputClass = "mt-1 w-full rounded-xl border border-[var(--app-border)] bg-[var(--app-control-bg)] px-3 py-2.5 text-sm text-[var(--app-text)] outline-none focus:border-[var(--app-accent)]";
  const primary = "rounded-xl border border-[var(--app-accent)] bg-[var(--app-accent)] px-4 py-2.5 text-sm font-bold text-[var(--app-accent-contrast)] disabled:opacity-50";
  const secondary = "rounded-xl border border-[var(--app-border)] bg-[var(--app-control-bg)] px-4 py-2.5 text-sm font-semibold text-[var(--app-text)] disabled:opacity-50";

  return (
    <main className="h-full overflow-y-auto bg-[var(--app-bg)] p-3 sm:p-5">
      <div className="mx-auto max-w-7xl space-y-4">
        <header className="flex flex-wrap items-end justify-between gap-3"><div><div className="text-xs font-extrabold uppercase tracking-[0.16em] text-[var(--app-accent)]">Flora Canopy · control plane</div><h1 className="mt-1 text-2xl font-semibold text-[var(--app-text)]">Infrastructure</h1><p className="mt-1 text-sm text-[var(--app-muted)]">Define hospital locations, assign Leafs, and deploy shared configuration.</p></div><button type="button" className={secondary} disabled={loading} onClick={() => void load()}>{loading ? "Refreshing…" : "Refresh"}</button></header>
        <nav className="flex flex-wrap gap-2 border-b border-[var(--app-border)] pb-2" aria-label="Infrastructure sections">{(["locations", "leaves", "groups", "hl7"] as const).map(item => <button key={item} type="button" onClick={() => { setTab(item); setNote(""); }} className={`rounded-xl px-4 py-2 text-sm font-bold ${item === "hl7" ? "" : "capitalize"} ${tab === item ? "bg-[var(--app-accent)] text-[var(--app-accent-contrast)]" : "text-[var(--app-muted)] hover:bg-[var(--app-control-bg)]"}`}>{item === "leaves" ? "Leaf assignments" : item === "hl7" ? "HL7 interface" : item}</button>)}</nav>
        {error ? <div className="rounded-xl border border-rose-500/40 bg-rose-500/10 px-4 py-3 text-sm text-rose-600 dark:text-rose-300">{error}</div> : null}
        {note ? <div className="rounded-xl border border-emerald-500/35 bg-emerald-500/10 px-4 py-3 text-sm text-emerald-700 dark:text-emerald-300">{note}</div> : null}

        {tab === "locations" ? <div className="grid gap-4 lg:grid-cols-[minmax(320px,.9fr)_minmax(420px,1.1fr)]">
          <section className="overflow-hidden rounded-2xl border border-[var(--app-border)] bg-[var(--app-panel-bg)]"><div className="flex items-center justify-between border-b border-[var(--app-border)] px-4 py-3"><div><h2 className="font-semibold text-[var(--app-text)]">Hospital hierarchy</h2><p className="text-xs text-[var(--app-muted)]">Hospital → building → care unit → room → bed</p></div><button type="button" className={secondary} onClick={startHospital}>+ Hospital</button></div><div className="max-h-[62vh] overflow-y-auto p-2">{orderedLocations.map(({ row, depth }) => <div key={row.id} className={`mb-1 flex items-center gap-2 rounded-xl border px-2 py-2 ${locationId === row.id ? "border-[var(--app-accent)] bg-[var(--app-hover-bg)]" : "border-transparent hover:bg-[var(--app-control-bg)]"}`} style={{ marginLeft: depth * 16 }}><button type="button" className="min-w-0 flex-1 text-left" onClick={() => selectLocation(row)}><div className="truncate text-sm font-semibold text-[var(--app-text)]">{row.name}</div><div className="text-[10px] uppercase tracking-wide text-[var(--app-muted)]">{kindLabel[row.kind]}{row.code ? ` · ${row.code}` : ""}</div></button>{nextKind[row.kind] ? <button type="button" className="rounded-lg border border-[var(--app-border)] px-2 py-1 text-xs text-[var(--app-muted)]" onClick={() => startChild(row)}>+ Child</button> : null}</div>)}{!loading && !orderedLocations.length ? <div className="px-4 py-12 text-center text-sm text-[var(--app-muted)]">Create the first hospital to begin.</div> : null}</div></section>
          <section className="rounded-2xl border border-[var(--app-border)] bg-[var(--app-panel-bg)] p-5"><div className="text-xs font-extrabold uppercase tracking-[0.12em] text-[var(--app-accent)]">{locationId ? "Edit location" : "New location"}</div><h2 className="mt-1 text-xl font-semibold text-[var(--app-text)]">{kindLabel[locationDraft.kind]}</h2><div className="mt-5 grid gap-4 sm:grid-cols-2"><label className="text-xs font-semibold text-[var(--app-muted)]">Name<input className={inputClass} value={locationDraft.name} onChange={event => setLocationDraft(current => ({ ...current, name: event.target.value }))} /></label><label className="text-xs font-semibold text-[var(--app-muted)]">Local code<input className={inputClass} value={locationDraft.code || ""} onChange={event => setLocationDraft(current => ({ ...current, code: event.target.value }))} placeholder="Optional" /></label><label className="text-xs font-semibold text-[var(--app-muted)]">Order<input type="number" className={inputClass} value={locationDraft.sort_order} onChange={event => setLocationDraft(current => ({ ...current, sort_order: Number(event.target.value) || 0 }))} /></label><label className="flex items-center gap-2 self-end rounded-xl border border-[var(--app-border)] px-3 py-2.5 text-sm font-semibold text-[var(--app-text)]"><input type="checkbox" checked={locationDraft.is_active} onChange={event => setLocationDraft(current => ({ ...current, is_active: event.target.checked }))} />Active</label></div><div className="mt-5 flex gap-2"><button type="button" className={primary} disabled={saving || !locationDraft.name.trim()} onClick={() => void saveLocation()}>{saving ? "Saving…" : "Save location"}</button>{locationDraft.parent_id ? <span className="self-center text-xs text-[var(--app-muted)]">Inside {locationMap.get(locationDraft.parent_id)?.name}</span> : null}</div></section>
        </div> : null}

        {tab === "leaves" ? <div className="grid gap-4 lg:grid-cols-[minmax(340px,.9fr)_minmax(440px,1.1fr)]">
          <section className="space-y-2">{data.leaves.map(leaf => <button key={leaf.leaf_id} type="button" onClick={() => selectLeaf(leaf)} className={`w-full rounded-2xl border p-4 text-left ${leafId === leaf.leaf_id ? "border-[var(--app-accent)] bg-[var(--app-hover-bg)]" : "border-[var(--app-border)] bg-[var(--app-panel-bg)]"}`}><div className="flex items-start justify-between gap-3"><div className="min-w-0"><div className="truncate font-semibold text-[var(--app-text)]">{leaf.display_name}</div><div className="text-xs text-[var(--app-muted)]">{leaf.leaf_id}</div></div><span className={`rounded-full border px-2 py-0.5 text-[10px] font-bold uppercase ${statusStyle(leaf.config_status)}`}>{leaf.config_status}</span></div><div className="mt-3 truncate text-xs text-[var(--app-muted)]">{locationPath(leaf.bed_location_id, locationMap)}</div></button>)}{!loading && !data.leaves.length ? <div className="rounded-2xl border border-dashed border-[var(--app-border)] px-6 py-12 text-center text-sm text-[var(--app-muted)]">No registered Leafs.</div> : null}</section>
          <section className="rounded-2xl border border-[var(--app-border)] bg-[var(--app-panel-bg)] p-5">{selectedLeaf ? <><div className="flex items-start justify-between gap-3"><div><div className="text-xs font-extrabold uppercase tracking-[0.12em] text-[var(--app-accent)]">Desired configuration</div><h2 className="mt-1 text-xl font-semibold text-[var(--app-text)]">{selectedLeaf.display_name}</h2></div><span className={`rounded-full border px-2.5 py-1 text-xs font-bold uppercase ${statusStyle(selectedLeaf.config_status)}`}>{selectedLeaf.config_status}</span></div><div className="mt-5 rounded-xl border border-[var(--app-border)] bg-[var(--app-control-bg)] p-4"><label className="block text-xs font-semibold text-[var(--app-muted)]">Leaf name<input className={inputClass} value={leafName} onChange={event => setLeafName(event.target.value)} maxLength={160} /></label><div className="mt-2 text-xs text-[var(--app-muted)]">Leaf ID: {selectedLeaf.leaf_id} · Reported name: {selectedLeaf.reported_display_name || selectedLeaf.display_name}</div><button type="button" className={`${secondary} mt-3`} disabled={saving || !leafName.trim()} onClick={() => void saveLeafName()}>Save Leaf name</button></div>{selectedLeaf.config_status === "unassigned" ? <div className="mt-5 rounded-xl border border-sky-500/35 bg-sky-500/10 p-4"><div className="font-semibold text-[var(--app-text)]">Existing Leaf configuration detected</div><p className="mt-1 text-xs text-[var(--app-muted)]">Adopt its current hospital and workstation location to create the hierarchy automatically.</p><button type="button" className={`${secondary} mt-3`} disabled={saving} onClick={() => void adoptLeaf()}>{saving ? "Adopting…" : "Adopt current location"}</button></div> : null}<div className="mt-5 space-y-4"><label className="block text-xs font-semibold text-[var(--app-muted)]">Assigned bed<select className={inputClass} value={bedId} onChange={event => setBedId(event.target.value)}><option value="">Select a bed</option>{beds.map(bed => <option key={bed.id} value={bed.id}>{locationPath(bed.id, locationMap)}</option>)}</select></label><div className="grid gap-3 sm:grid-cols-3"><label className="text-xs font-semibold text-[var(--app-muted)]">Timezone<input className={inputClass} value={timezone} onChange={event => setTimezone(event.target.value)} /></label><label className="text-xs font-semibold text-[var(--app-muted)]">Date format<select className={inputClass} value={dateFormat} onChange={event => setDateFormat(event.target.value)}><option>DD/MM/YYYY</option><option>MM/DD/YYYY</option><option>YYYY-MM-DD</option></select></label><label className="text-xs font-semibold text-[var(--app-muted)]">Time format<select className={inputClass} value={timeFormat} onChange={event => setTimeFormat(event.target.value)}><option>24h</option><option>12h</option></select></label></div><div className="rounded-xl border border-[var(--app-border)] bg-[var(--app-control-bg)] p-3 text-xs text-[var(--app-muted)]"><div>Desired version: <strong className="text-[var(--app-text)]">{selectedLeaf.desired_version || "—"}</strong></div><div className="mt-1">Applied version: <strong className="text-[var(--app-text)]">{selectedLeaf.applied_version || "—"}</strong></div></div><button type="button" className={primary} disabled={saving || !bedId} onClick={() => void saveAssignment()}>{saving ? "Publishing…" : "Publish to Leaf"}</button></div></> : <div className="py-20 text-center text-sm text-[var(--app-muted)]">Select a Leaf to assign its location.</div>}</section>
        </div> : null}

        {tab === "hl7" ? <CanopyHl7InterfacePanel /> : <DemoModeCard onChanged={load} />}

        {tab === "groups" ? <div className="grid gap-4 lg:grid-cols-[minmax(300px,.75fr)_minmax(460px,1.25fr)]"><section className="overflow-hidden rounded-2xl border border-[var(--app-border)] bg-[var(--app-panel-bg)]"><div className="flex items-center justify-between border-b border-[var(--app-border)] px-4 py-3"><div><h2 className="font-semibold text-[var(--app-text)]">Leaf groups</h2><p className="text-xs text-[var(--app-muted)]">Deploy shared settings together.</p></div><button type="button" className={secondary} onClick={startGroup}>+ Group</button></div><div className="p-2">{data.groups.map(group => <button key={group.id} type="button" onClick={() => selectGroup(group)} className={`mb-1 w-full rounded-xl border px-3 py-3 text-left ${groupId === group.id ? "border-[var(--app-accent)] bg-[var(--app-hover-bg)]" : "border-transparent hover:bg-[var(--app-control-bg)]"}`}><div className="font-semibold text-[var(--app-text)]">{group.name}</div><div className="mt-1 text-xs text-[var(--app-muted)]">{group.leaf_ids.length} Leaf{group.leaf_ids.length === 1 ? "" : "s"}</div></button>)}</div></section><section className="rounded-2xl border border-[var(--app-border)] bg-[var(--app-panel-bg)] p-5"><div className="text-xs font-extrabold uppercase tracking-[0.12em] text-[var(--app-accent)]">{groupId ? "Edit group" : "New group"}</div><div className="mt-4 grid gap-3 sm:grid-cols-2"><label className="text-xs font-semibold text-[var(--app-muted)]">Group name<input className={inputClass} value={groupDraft.name} onChange={event => setGroupDraft(current => ({ ...current, name: event.target.value }))} /></label><label className="text-xs font-semibold text-[var(--app-muted)]">Description<input className={inputClass} value={groupDraft.description} onChange={event => setGroupDraft(current => ({ ...current, description: event.target.value }))} /></label></div><div className="mt-5"><div className="mb-2 text-xs font-bold uppercase tracking-[0.12em] text-[var(--app-muted)]">Members</div><div className="grid gap-2 sm:grid-cols-2">{data.leaves.map(leaf => <label key={leaf.leaf_id} className="flex items-center gap-3 rounded-xl border border-[var(--app-border)] bg-[var(--app-control-bg)] px-3 py-3 text-sm text-[var(--app-text)]"><input type="checkbox" checked={groupDraft.leaf_ids.includes(leaf.leaf_id)} onChange={() => toggleGroupLeaf(leaf.leaf_id)} /><span className="min-w-0"><span className="block truncate font-semibold">{leaf.display_name}</span><span className="block truncate text-xs text-[var(--app-muted)]">{locationPath(leaf.bed_location_id, locationMap)}</span></span></label>)}</div></div><div className="mt-5 flex gap-2"><button type="button" className={primary} disabled={saving || !groupDraft.name.trim()} onClick={() => void saveGroup()}>{saving ? "Saving…" : "Save group"}</button></div>{groupId ? <div className="mt-6 border-t border-[var(--app-border)] pt-5"><div className="text-xs font-extrabold uppercase tracking-[0.12em] text-[var(--app-accent)]">Group configuration</div><p className="mt-1 text-xs text-[var(--app-muted)]">Publish common regional settings while retaining each Leaf’s assigned bed.</p><div className="mt-3 grid gap-3 sm:grid-cols-3"><label className="text-xs font-semibold text-[var(--app-muted)]">Timezone<input className={inputClass} value={timezone} onChange={event => setTimezone(event.target.value)} /></label><label className="text-xs font-semibold text-[var(--app-muted)]">Date format<select className={inputClass} value={dateFormat} onChange={event => setDateFormat(event.target.value)}><option>DD/MM/YYYY</option><option>MM/DD/YYYY</option><option>YYYY-MM-DD</option></select></label><label className="text-xs font-semibold text-[var(--app-muted)]">Time format<select className={inputClass} value={timeFormat} onChange={event => setTimeFormat(event.target.value)}><option>24h</option><option>12h</option></select></label></div><button type="button" className={`${secondary} mt-3`} disabled={saving} onClick={() => void publishGroupSettings()}>Publish to group</button></div> : null}</section></div> : null}
      </div>
    </main>
  );
}
