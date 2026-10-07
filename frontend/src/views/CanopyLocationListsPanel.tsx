import { useMemo, useState } from "react";
import {
  bulkCreateLocations,
  updateControlLocation,
  type ControlPlane,
  type ControlPlaneLeaf,
  type ControlPlaneLocation,
} from "../api/fleetApi";

/** Ward, room and bed lists with inline editing and bulk creation. */

type Level = "care_unit" | "room" | "bed";
type Status = "active" | "inactive" | "all";

const inputClass = "w-full rounded-xl border border-[var(--app-border)] bg-[var(--app-control-bg)] px-3 py-2 text-sm text-[var(--app-text)] outline-none focus:border-[var(--app-accent)]";
const primary = "rounded-xl border border-[var(--app-accent)] bg-[var(--app-accent)] px-4 py-2 text-sm font-bold text-[var(--app-accent-contrast)] disabled:opacity-50";
const secondary = "rounded-xl border border-[var(--app-border)] bg-[var(--app-control-bg)] px-3 py-2 text-sm font-semibold text-[var(--app-text)] disabled:opacity-50";
const levelLabel: Record<Level, { one: string; many: string }> = {
  care_unit: { one: "Ward", many: "Wards" },
  room: { one: "Room", many: "Rooms" },
  bed: { one: "Bed", many: "Beds" },
};
const parentKind: Record<Level, ControlPlaneLocation["kind"]> = { care_unit: "building", room: "care_unit", bed: "room" };

/** The control plane lists Leafs without a status, so derive it from the last heartbeat. */
function heartbeatColor(lastSeen?: string | null) {
  const age = lastSeen ? Date.now() - new Date(lastSeen).getTime() : Infinity;
  return age <= 90_000 ? "bg-emerald-500" : age <= 600_000 ? "bg-amber-500" : "bg-rose-500";
}

function pattern(prefix: string, start: number, count: number, pad: number, suffix: string) {
  return Array.from({ length: Math.max(0, Math.min(count, 200)) }, (_, index) => `${prefix}${String(start + index).padStart(pad, "0")}${suffix}`.trim());
}

export default function CanopyLocationListsPanel({ data, onChanged }: { data: ControlPlane; onChanged: () => Promise<void> | void }) {
  const [level, setLevel] = useState<Level>("care_unit");
  const [search, setSearch] = useState("");
  const [wardFilter, setWardFilter] = useState("");
  const [roomFilter, setRoomFilter] = useState("");
  const [status, setStatus] = useState<Status>("active");
  const [unassignedOnly, setUnassignedOnly] = useState(false);
  const [editing, setEditing] = useState<ControlPlaneLocation | null>(null);
  const [showBulk, setShowBulk] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [note, setNote] = useState("");

  const byId = useMemo(() => new Map(data.locations.map(row => [row.id, row])), [data.locations]);
  const childrenOf = useMemo(() => {
    const map = new Map<number, ControlPlaneLocation[]>();
    for (const row of data.locations) if (row.parent_id) map.set(row.parent_id, [...(map.get(row.parent_id) || []), row]);
    return map;
  }, [data.locations]);
  const leafByBed = useMemo(() => {
    const map = new Map<number, ControlPlaneLeaf>();
    for (const leaf of data.leaves) if (leaf.bed_location_id) map.set(leaf.bed_location_id, leaf);
    return map;
  }, [data.leaves]);

  const ancestor = (row: ControlPlaneLocation | undefined, kind: ControlPlaneLocation["kind"]) => {
    let current = row;
    const seen = new Set<number>();
    while (current && current.kind !== kind && current.parent_id && !seen.has(current.id)) {
      seen.add(current.id);
      current = byId.get(current.parent_id);
    }
    return current?.kind === kind ? current : undefined;
  };
  const descendants = (row: ControlPlaneLocation, kind: ControlPlaneLocation["kind"]): ControlPlaneLocation[] =>
    (childrenOf.get(row.id) || []).flatMap(child => child.kind === kind ? [child] : descendants(child, kind));

  const wards = data.locations.filter(row => row.kind === "care_unit");
  const rooms = data.locations.filter(row => row.kind === "room" && (!wardFilter || String(ancestor(row, "care_unit")?.id) === wardFilter));
  const rows = data.locations
    .filter(row => row.kind === level)
    .filter(row => status === "all" || (status === "active" ? row.is_active : !row.is_active))
    .filter(row => level === "care_unit" || !wardFilter || String(ancestor(row, "care_unit")?.id) === wardFilter)
    .filter(row => level !== "bed" || !roomFilter || String(row.parent_id) === roomFilter)
    .filter(row => level !== "bed" || !unassignedOnly || !leafByBed.has(row.id))
    .filter(row => {
      const text = search.trim().toLowerCase();
      if (!text) return true;
      const leaf = leafByBed.get(row.id);
      return [row.name, row.code, ancestor(row, "care_unit")?.name, ancestor(row, "room")?.name, leaf?.display_name]
        .some(value => String(value || "").toLowerCase().includes(text));
    })
    .sort((a, b) => {
      const path = (row: ControlPlaneLocation) => [ancestor(row, "care_unit")?.name, ancestor(row, "room")?.name].join("/");
      return path(a).localeCompare(path(b)) || a.sort_order - b.sort_order || a.name.localeCompare(b.name, undefined, { numeric: true });
    });

  const counts = {
    care_unit: wards.filter(row => row.is_active).length,
    room: data.locations.filter(row => row.kind === "room" && row.is_active).length,
    bed: data.locations.filter(row => row.kind === "bed" && row.is_active).length,
  };

  const save = async (row: ControlPlaneLocation, change: Partial<ControlPlaneLocation>) => {
    setBusy(true);
    setError("");
    try {
      const next = { ...row, ...change };
      await updateControlLocation(row.id, {
        parent_id: next.parent_id ?? null, kind: next.kind, code: (next.code || "").trim() || null,
        name: next.name.trim(), is_active: next.is_active, sort_order: Number(next.sort_order) || 0,
      });
      setEditing(null);
      setNote(`${levelLabel[level].one} “${next.name}” saved.`);
      await onChanged();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally { setBusy(false); }
  };

  const parentOptions = data.locations.filter(row => row.kind === parentKind[level] && row.is_active);
  const parentName = (row: ControlPlaneLocation) => {
    if (row.kind === "care_unit") return ancestor(row, "building")?.name;
    if (row.kind === "room") return ancestor(row, "care_unit")?.name;
    return [ancestor(row, "care_unit")?.name, ancestor(row, "room")?.name].filter(Boolean).join(" · ");
  };

  return <section className="space-y-3">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <div className="flex rounded-xl border border-[var(--app-border)] bg-[var(--app-control-bg)] p-1">
        {(["care_unit", "room", "bed"] as const).map(item => <button key={item} type="button"
          onClick={() => { setLevel(item); setEditing(null); setShowBulk(false); setNote(""); }}
          className={`rounded-lg px-4 py-2 text-sm font-bold ${level === item ? "bg-[var(--app-accent)] text-[var(--app-accent-contrast)]" : "text-[var(--app-muted)]"}`}>
          {levelLabel[item].many} <span className="opacity-70">{counts[item]}</span>
        </button>)}
      </div>
      <button type="button" className={primary} onClick={() => setShowBulk(value => !value)}>
        {showBulk ? "Close" : `+ Add ${levelLabel[level].many.toLowerCase()}`}
      </button>
    </div>

    {showBulk ? <BulkForm key={level} level={level} parents={parentOptions} parentLabel={row => [parentName(row), row.name].filter(Boolean).join(" · ")}
      onDone={async message => { setShowBulk(false); setNote(message); await onChanged(); }} /> : null}

    <div className="flex flex-wrap gap-2">
      <input className={`${inputClass} max-w-xs`} placeholder={`Search ${levelLabel[level].many.toLowerCase()}…`} value={search} onChange={event => setSearch(event.target.value)} />
      {level !== "care_unit" ? <select className={`${inputClass} max-w-[220px]`} value={wardFilter} onChange={event => { setWardFilter(event.target.value); setRoomFilter(""); }}>
        <option value="">All wards</option>
        {wards.map(ward => <option key={ward.id} value={ward.id}>{ward.name}</option>)}
      </select> : null}
      {level === "bed" ? <select className={`${inputClass} max-w-[220px]`} value={roomFilter} onChange={event => setRoomFilter(event.target.value)}>
        <option value="">All rooms</option>
        {rooms.map(room => <option key={room.id} value={room.id}>{room.name}</option>)}
      </select> : null}
      <select className={`${inputClass} max-w-[150px]`} value={status} onChange={event => setStatus(event.target.value as Status)}>
        <option value="active">Active</option><option value="inactive">Inactive</option><option value="all">All</option>
      </select>
      {level === "bed" ? <label className="flex items-center gap-2 px-2 text-sm text-[var(--app-text)]"><input type="checkbox" checked={unassignedOnly} onChange={event => setUnassignedOnly(event.target.checked)} />Without a Leaf</label> : null}
    </div>

    {error ? <div className="rounded-xl border border-rose-500/40 bg-rose-500/10 px-4 py-2 text-sm text-rose-500">{error}</div> : null}
    {note ? <div className="rounded-xl border border-emerald-500/40 bg-emerald-500/10 px-4 py-2 text-sm text-emerald-700 dark:text-emerald-300">{note}</div> : null}

    <div className="overflow-x-auto rounded-2xl border border-[var(--app-border)] bg-[var(--app-panel-bg)]">
      <table className="w-full min-w-[720px] text-left text-sm">
        <thead className="border-b border-[var(--app-border)] text-[10px] font-extrabold uppercase tracking-[0.12em] text-[var(--app-muted)]">
          <tr>
            <th className="px-3 py-2">{levelLabel[level].one}</th>
            <th className="px-3 py-2">Code</th>
            <th className="px-3 py-2">{level === "care_unit" ? "Building" : level === "room" ? "Ward" : "Ward · room"}</th>
            {level === "care_unit" ? <><th className="px-3 py-2">Rooms</th><th className="px-3 py-2">Beds</th><th className="px-3 py-2">Leafs</th></> : null}
            {level === "room" ? <><th className="px-3 py-2">Beds</th><th className="px-3 py-2">Leafs</th></> : null}
            {level === "bed" ? <th className="px-3 py-2">Leaf</th> : null}
            <th className="px-3 py-2">Order</th>
            <th className="px-3 py-2">Status</th>
            <th className="px-3 py-2 text-right">Actions</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(row => {
            const isEditing = editing?.id === row.id;
            const beds = level === "bed" ? [] : descendants(row, "bed");
            const assigned = beds.filter(bed => leafByBed.has(bed.id)).length;
            const leaf = leafByBed.get(row.id);
            return <tr key={row.id} className={`border-b border-[var(--app-border)] last:border-0 ${row.is_active ? "" : "opacity-60"}`}>
              <td className="px-3 py-2 font-semibold text-[var(--app-text)]">{isEditing
                ? <input className={inputClass} value={editing.name} onChange={event => setEditing({ ...editing, name: event.target.value })} />
                : row.name}</td>
              <td className="px-3 py-2 text-[var(--app-muted)]">{isEditing
                ? <input className={inputClass} value={editing.code || ""} onChange={event => setEditing({ ...editing, code: event.target.value })} />
                : row.code || "—"}</td>
              <td className="px-3 py-2 text-[var(--app-muted)]">{isEditing
                ? <select className={inputClass} value={editing.parent_id ?? ""} onChange={event => setEditing({ ...editing, parent_id: Number(event.target.value) })}>
                    {parentOptions.map(parent => <option key={parent.id} value={parent.id}>{[parentName(parent), parent.name].filter(Boolean).join(" · ")}</option>)}
                  </select>
                : parentName(row) || "—"}</td>
              {level === "care_unit" ? <><td className="px-3 py-2">{descendants(row, "room").length}</td><td className="px-3 py-2">{beds.length}</td><td className="px-3 py-2">{assigned}</td></> : null}
              {level === "room" ? <><td className="px-3 py-2">{beds.length}</td><td className="px-3 py-2">{assigned}</td></> : null}
              {level === "bed" ? <td className="px-3 py-2">{leaf
                ? <span className="inline-flex items-center gap-1.5"><span className={`h-2 w-2 rounded-full ${heartbeatColor(leaf.last_seen_at)}`} title={leaf.last_seen_at ? `Last heartbeat ${new Date(leaf.last_seen_at).toLocaleString()}` : "Never seen"} />{leaf.display_name}</span>
                : <span className="text-[var(--app-muted)]">No Leaf</span>}</td> : null}
              <td className="px-3 py-2 text-[var(--app-muted)]">{isEditing
                ? <input type="number" className={`${inputClass} w-20`} value={editing.sort_order} onChange={event => setEditing({ ...editing, sort_order: Number(event.target.value) || 0 })} />
                : row.sort_order}</td>
              <td className="px-3 py-2"><span className={`rounded-full px-2 py-0.5 text-[10px] font-bold uppercase ${row.is_active ? "bg-emerald-500/12 text-emerald-600 dark:text-emerald-300" : "bg-[var(--app-control-bg)] text-[var(--app-muted)]"}`}>{row.is_active ? "Active" : "Inactive"}</span></td>
              <td className="whitespace-nowrap px-3 py-2 text-right">
                {isEditing ? <>
                  <button type="button" className={`${primary} mr-1`} disabled={busy || !editing.name.trim()} onClick={() => void save(row, editing)}>Save</button>
                  <button type="button" className={secondary} disabled={busy} onClick={() => setEditing(null)}>Cancel</button>
                </> : <>
                  <button type="button" className={`${secondary} mr-1`} onClick={() => setEditing(row)}>Edit</button>
                  <button type="button" className={secondary} disabled={busy || (row.is_active && !!leaf)}
                    title={row.is_active && leaf ? "Move the Leaf to another bed first" : undefined}
                    onClick={() => void save(row, { is_active: !row.is_active })}>{row.is_active ? "Deactivate" : "Activate"}</button>
                </>}
              </td>
            </tr>;
          })}
          {!rows.length ? <tr><td colSpan={9} className="px-3 py-10 text-center text-sm text-[var(--app-muted)]">No {levelLabel[level].many.toLowerCase()} match.</td></tr> : null}
        </tbody>
      </table>
    </div>
  </section>;
}

function BulkForm({ level, parents, parentLabel, onDone }: {
  level: Level;
  parents: ControlPlaneLocation[];
  parentLabel: (row: ControlPlaneLocation) => string;
  onDone: (message: string) => Promise<void> | void;
}) {
  const [parentId, setParentId] = useState(parents[0]?.id ?? 0);
  const [mode, setMode] = useState<"pattern" | "list">("pattern");
  const [prefix, setPrefix] = useState(level === "care_unit" ? "Ward " : level === "room" ? "Room " : "Bed ");
  const [start, setStart] = useState(1);
  const [count, setCount] = useState(level === "care_unit" ? 1 : 4);
  const [pad, setPad] = useState(0);
  const [suffix, setSuffix] = useState("");
  const [list, setList] = useState("");
  const [bedsPerRoom, setBedsPerRoom] = useState(level === "room" ? 1 : 0);
  const [bedPrefix, setBedPrefix] = useState("Bed ");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const names = mode === "list" ? list.split("\n").map(value => value.trim()).filter(Boolean) : pattern(prefix, start, count, pad, suffix);
  const parentKindLabel = level === "care_unit" ? "Building" : level === "room" ? "Ward" : "Room";

  const submit = async () => {
    setBusy(true);
    setError("");
    try {
      const result = await bulkCreateLocations({
        parent_id: parentId, kind: level, names,
        beds_per_room: level === "room" ? bedsPerRoom : 0, bed_prefix: bedPrefix,
      });
      const what = levelLabel[level].many.toLowerCase();
      await onDone(`Created ${result.created.length} ${what}${result.beds_created ? ` and ${result.beds_created} beds` : ""}${result.skipped.length ? `; skipped existing: ${result.skipped.join(", ")}` : ""}.`);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally { setBusy(false); }
  };

  if (!parents.length) {
    return <div className="rounded-2xl border border-amber-500/40 bg-amber-500/10 p-4 text-sm text-amber-700 dark:text-amber-300">
      Create a {parentKindLabel.toLowerCase()} first (Locations tab) before adding {levelLabel[level].many.toLowerCase()}.
    </div>;
  }
  return <div className="space-y-3 rounded-2xl border border-[var(--app-border)] bg-[var(--app-panel-bg)] p-4">
    <div className="text-xs font-extrabold uppercase tracking-[0.12em] text-[var(--app-accent)]">Add {levelLabel[level].many.toLowerCase()}</div>
    <div className="grid gap-3 sm:grid-cols-2">
      <label className="text-xs font-semibold text-[var(--app-muted)]">{parentKindLabel}
        <select className={`${inputClass} mt-1`} value={parentId} onChange={event => setParentId(Number(event.target.value))}>
          {parents.map(parent => <option key={parent.id} value={parent.id}>{parentLabel(parent)}</option>)}
        </select>
      </label>
      <div className="text-xs font-semibold text-[var(--app-muted)]">Names
        <div className="mt-1 flex rounded-xl border border-[var(--app-border)] bg-[var(--app-control-bg)] p-1">
          <button type="button" onClick={() => setMode("pattern")} className={`flex-1 rounded-lg px-3 py-1.5 ${mode === "pattern" ? "bg-[var(--app-accent)] text-[var(--app-accent-contrast)]" : ""}`}>Numbered</button>
          <button type="button" onClick={() => setMode("list")} className={`flex-1 rounded-lg px-3 py-1.5 ${mode === "list" ? "bg-[var(--app-accent)] text-[var(--app-accent-contrast)]" : ""}`}>One per line</button>
        </div>
      </div>
    </div>
    {mode === "pattern" ? <div className="grid gap-3 sm:grid-cols-5">
      <label className="text-xs font-semibold text-[var(--app-muted)]">Prefix<input className={`${inputClass} mt-1`} value={prefix} onChange={event => setPrefix(event.target.value)} /></label>
      <label className="text-xs font-semibold text-[var(--app-muted)]">Start at<input type="number" className={`${inputClass} mt-1`} value={start} min={0} onChange={event => setStart(Number(event.target.value) || 0)} /></label>
      <label className="text-xs font-semibold text-[var(--app-muted)]">How many<input type="number" className={`${inputClass} mt-1`} value={count} min={1} max={200} onChange={event => setCount(Number(event.target.value) || 0)} /></label>
      <label className="text-xs font-semibold text-[var(--app-muted)]">Digits<input type="number" className={`${inputClass} mt-1`} value={pad} min={0} max={6} onChange={event => setPad(Number(event.target.value) || 0)} /></label>
      <label className="text-xs font-semibold text-[var(--app-muted)]">Suffix<input className={`${inputClass} mt-1`} value={suffix} onChange={event => setSuffix(event.target.value)} /></label>
    </div> : <textarea className={`${inputClass} min-h-28`} placeholder={"ICU\nCCU\nPACU"} value={list} onChange={event => setList(event.target.value)} />}
    {level === "room" ? <div className="grid gap-3 sm:grid-cols-2">
      <label className="text-xs font-semibold text-[var(--app-muted)]">Beds in each new room<input type="number" className={`${inputClass} mt-1`} value={bedsPerRoom} min={0} max={20} onChange={event => setBedsPerRoom(Number(event.target.value) || 0)} /></label>
      <label className="text-xs font-semibold text-[var(--app-muted)]">Bed name prefix<input className={`${inputClass} mt-1`} value={bedPrefix} onChange={event => setBedPrefix(event.target.value)} /></label>
    </div> : null}
    <div className="text-xs text-[var(--app-muted)]">Preview ({names.length}): {names.slice(0, 12).join(", ")}{names.length > 12 ? ", …" : ""}{level === "room" && bedsPerRoom ? ` — each with ${bedsPerRoom} bed${bedsPerRoom === 1 ? "" : "s"}` : ""}</div>
    {error ? <div className="text-sm text-rose-500">{error}</div> : null}
    <button type="button" className={primary} disabled={busy || !names.length || !parentId} onClick={() => void submit()}>{busy ? "Creating…" : `Create ${names.length} ${levelLabel[level].many.toLowerCase()}`}</button>
  </div>;
}
