import { useCallback, useEffect, useMemo, useState } from "react";
import {
  getFleetCaseSnapshot,
  getIcuOverview,
  type FleetSnapshot,
  type IcuOverviewBed,
  type IcuOverviewCase,
} from "../api/fleetApi";
import CanopyCaseChartView from "./CanopyCaseChartView";

const connectionTone = {
  online: { dot: "bg-emerald-400", text: "text-emerald-300", border: "border-emerald-500/35" },
  delayed: { dot: "bg-amber-400", text: "text-amber-300", border: "border-amber-500/45" },
  offline: { dot: "bg-rose-500", text: "text-rose-300", border: "border-rose-500/50" },
} as const;

type ChartDensity = "compact" | "comfortable";
type ChartLayout = { columns: number; density: ChartDensity; fitScreen: boolean; showObservations: boolean; slotCount: number; slots: string[] };
const LAYOUT_KEY = "flora.canopy.centralMonitoring.layout";

function initialLayout(): ChartLayout {
  const defaults: ChartLayout = { columns: 2, density: "compact", fitScreen: true, showObservations: true, slotCount: 4, slots: [] };
  if (typeof window === "undefined") return defaults;
  try {
    const saved = JSON.parse(window.localStorage.getItem(LAYOUT_KEY) || "{}") as Partial<ChartLayout> & { showTrends?: boolean };
    return {
      columns: [1, 2, 3, 4].includes(Number(saved.columns)) ? Number(saved.columns) : 2,
      density: saved.density === "comfortable" ? "comfortable" : "compact",
      fitScreen: saved.fitScreen !== false,
      showObservations: saved.showObservations ?? saved.showTrends ?? true,
      slotCount: [1, 2, 4, 6, 8].includes(Number(saved.slotCount)) ? Number(saved.slotCount) : 4,
      slots: Array.isArray(saved.slots) ? saved.slots.map(item => String(item || "")) : [],
    };
  } catch { return defaults; }
}

function elapsed(input: string | number | null | undefined) {
  if (input == null) return "—";
  const timestamp = new Date(input).getTime();
  if (!Number.isFinite(timestamp)) return "—";
  const seconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  return `${Math.floor(seconds / 3600)}h ago`;
}

function caseDuration(start: number | null | undefined) {
  if (!start) return "—";
  const minutes = Math.max(0, Math.floor((Date.now() - start) / 60_000));
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

function value(input: number | null | undefined, digits = 0) {
  return input == null || !Number.isFinite(input) ? "—" : input.toFixed(digits);
}

function chartTime(input: string | number | null | undefined) {
  if (input == null) return "";
  const numeric = typeof input === "number" ? input : Number(input);
  const date = new Date(Number.isFinite(numeric) ? (numeric < 10_000_000_000 ? numeric * 1000 : numeric) : input);
  return Number.isFinite(date.getTime()) ? date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "";
}

function ObservationStrip({ active }: { active: IcuOverviewCase }) {
  const observations = [
    ["HR", value(active.latest.hr), "bpm"],
    ["SpO₂", value(active.latest.spo2), "%"],
    ["BP", `${value(active.latest.sbp)}/${value(active.latest.dbp)}`, "mmHg"],
    ["MAP", value(active.latest.map), "mmHg"],
    ["RR", value(active.latest.rr), "/min"],
    ["Temp", value(active.latest.temperature, 1), "°C"],
  ];
  return <div className="grid grid-cols-3 gap-px overflow-hidden rounded-lg border border-[var(--app-border)] bg-[var(--app-border)] 2xl:grid-cols-6">
    {observations.map(([label, reading, unit]) => <div key={label} className="flex min-w-0 items-baseline gap-1 bg-[var(--app-control-bg)] px-2 py-1"><span className="text-[9px] font-extrabold uppercase tracking-wide text-[var(--app-muted)]">{label}</span><strong className="ml-auto truncate text-xs tabular-nums text-[var(--app-text)]">{reading}</strong><span className="truncate text-[8px] text-[var(--app-muted)]">{unit}</span></div>)}
  </div>;
}

function SectionTitle({ children }: { children: string }) {
  return <div className="text-[9px] font-extrabold uppercase tracking-[0.14em] text-[var(--app-muted)]">{children}</div>;
}

function BedPanel({ bed, opening, onOpen, density, showObservations }: { bed: IcuOverviewBed; opening: boolean; onOpen: (entry: IcuOverviewCase) => void; density: ChartDensity; showObservations: boolean }) {
  const tone = connectionTone[bed.connection_status];
  const active = bed.case;
  const compact = density === "compact";
  const location = [bed.room_name, bed.bed_name].filter(Boolean).join(" · ") || "Location not assigned";
  return <article className={`flex h-full min-h-0 flex-col overflow-hidden rounded-2xl border bg-[var(--app-panel-bg)] shadow-sm ${tone.border}`}>
    <header className={`flex shrink-0 items-start justify-between gap-3 border-b border-[var(--app-border)] ${compact ? "px-3 py-2" : "px-4 py-3"}`}>
      <div className="min-w-0"><div className={`truncate font-bold text-[var(--app-text)] ${compact ? "text-base" : "text-lg"}`}>{bed.display_name}</div><div className="truncate text-[11px] text-[var(--app-muted)]">{location} · {bed.leaf_id}</div></div>
      <span className={`inline-flex shrink-0 items-center gap-2 rounded-full border border-current/20 px-2.5 py-1 text-xs font-bold capitalize ${tone.text}`}><span className={`h-2 w-2 rounded-full ${tone.dot}`} />{bed.connection_status}</span>
    </header>
    {active ? <button type="button" disabled={opening} onClick={() => onOpen(active)} className={`flex min-h-0 flex-1 flex-col overflow-hidden text-left disabled:opacity-70 ${compact ? "gap-2 p-3" : "gap-3 p-4"}`}>
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0"><div className="truncate text-base font-bold text-[var(--app-text)]">{active.patient_name}</div><div className="mt-0.5 text-xs text-[var(--app-muted)]">HN {active.hn || "—"} · {active.gender || "—"} · {active.chart.patient.age || "Age not charted"}</div><div className="mt-1 flex flex-wrap gap-1.5 text-[10px]"><span className="rounded-md bg-[var(--app-control-bg)] px-1.5 py-0.5">ASA {active.chart.patient.asa_status || "—"}</span><span className="rounded-md bg-[var(--app-control-bg)] px-1.5 py-0.5">{active.chart.patient.weight_kg == null ? "Weight —" : `${value(active.chart.patient.weight_kg, 1)} kg`}</span><span className="rounded-md bg-[var(--app-control-bg)] px-1.5 py-0.5">Blood {active.chart.patient.blood_group || "—"}</span></div></div>
        <div className="shrink-0 text-right"><div className="text-[9px] font-extrabold uppercase tracking-wide text-[var(--app-muted)]">Chart duration</div><div className="font-bold tabular-nums text-[var(--app-text)]">{caseDuration(active.start_time)}</div><div className="text-[9px] text-[var(--app-muted)]">Synced {elapsed(active.last_synced_at)}</div></div>
      </div>
      <div className="grid min-h-0 flex-1 grid-cols-2 gap-2 overflow-hidden">
        <div className="min-w-0 rounded-xl border border-[var(--app-border)] bg-[var(--app-control-bg)] p-2">
          <SectionTitle>Clinical context</SectionTitle>
          <div className="mt-1 line-clamp-2 text-xs font-semibold text-[var(--app-text)]">{active.chart.diagnoses[0] || "Diagnosis not charted"}</div>
          <div className="mt-1 line-clamp-2 text-[10px] text-[var(--app-accent)]">{active.procedure || "Procedure not charted"}</div>
          <div className={`mt-1.5 text-[10px] font-semibold ${active.chart.allergies.some(item => item.allergen.toUpperCase() !== "NKA") ? "text-rose-300" : "text-emerald-300"}`}>Allergy: {active.chart.allergies.length ? active.chart.allergies.map(item => item.allergen).join(", ") : "Not charted"}</div>
          <div className="mt-2"><SectionTitle>Latest labs</SectionTitle><div className="mt-1 grid grid-cols-2 gap-x-2 gap-y-0.5">{active.chart.labs.length ? active.chart.labs.slice(0, 4).map(lab => <div key={lab.name} className="flex min-w-0 justify-between gap-1 text-[10px]"><span className="truncate text-[var(--app-muted)]">{lab.name}</span><strong className={lab.flag ? "text-amber-300" : "text-[var(--app-text)]"}>{lab.value || "—"}{lab.unit ? ` ${lab.unit}` : ""}</strong></div>) : <span className="col-span-2 text-[10px] text-[var(--app-muted)]">No laboratory results</span>}</div></div>
        </div>
        <div className="min-w-0 rounded-xl border border-[var(--app-border)] bg-[var(--app-control-bg)] p-2">
          <SectionTitle>Recent charting</SectionTitle>
          <div className="mt-1 space-y-1">{active.chart.recent_events.length ? active.chart.recent_events.slice(0, 2).map((event, index) => <div key={`${event.time}:${index}`} className="flex gap-2 text-[10px]"><span className="shrink-0 tabular-nums text-[var(--app-muted)]">{chartTime(event.time)}</span><span className="truncate text-[var(--app-text)]">{event.title}</span></div>) : <div className="text-[10px] text-[var(--app-muted)]">No charted events</div>}</div>
          <div className="mt-2"><SectionTitle>Therapy / medication</SectionTitle><div className="mt-1 space-y-1">{active.chart.active_infusions.length ? active.chart.active_infusions.slice(0, 2).map(item => <div key={item.name} className="truncate text-[10px] text-[var(--app-text)]">{item.name}{item.rate == null ? " · running" : ` · ${value(item.rate, 1)} ${item.unit || ""}`}</div>) : active.chart.recent_medications.length ? active.chart.recent_medications.slice(0, 2).map((item, index) => <div key={`${item.name}:${index}`} className="truncate text-[10px] text-[var(--app-text)]">{chartTime(item.time)} {item.name}{item.dose == null ? "" : ` · ${value(item.dose, 1)} ${item.unit || ""}`}</div>) : <div className="text-[10px] text-[var(--app-muted)]">No medication entries</div>}</div></div>
          <div className="mt-2"><SectionTitle>Care team</SectionTitle><div className="mt-1 truncate text-[10px] text-[var(--app-text)]">{active.chart.staff.length ? active.chart.staff.map(item => `${item.name}${item.role ? ` (${item.role})` : ""}`).join(", ") : "No staff assigned"}</div></div>
        </div>
      </div>
      <div className="grid grid-cols-5 gap-px overflow-hidden rounded-lg border border-[var(--app-border)] bg-[var(--app-border)] text-center"><div className="bg-[var(--app-control-bg)] px-1 py-1"><SectionTitle>Intake</SectionTitle><strong className="text-[10px] text-[var(--app-text)]">{value(active.chart.io.intake_ml)} mL</strong></div><div className="bg-[var(--app-control-bg)] px-1 py-1"><SectionTitle>Output</SectionTitle><strong className="text-[10px] text-[var(--app-text)]">{value(active.chart.io.output_ml)} mL</strong></div><div className="bg-[var(--app-control-bg)] px-1 py-1"><SectionTitle>Balance</SectionTitle><strong className="text-[10px] text-[var(--app-text)]">{value(active.chart.io.net_ml)} mL</strong></div><div className="bg-[var(--app-control-bg)] px-1 py-1"><SectionTitle>Urine</SectionTitle><strong className="text-[10px] text-[var(--app-text)]">{value(active.chart.io.urine_output_ml)} mL</strong></div><div className="bg-[var(--app-control-bg)] px-1 py-1"><SectionTitle>Blood loss</SectionTitle><strong className="text-[10px] text-[var(--app-text)]">{value(active.chart.io.blood_loss_ml)} mL</strong></div></div>
      {showObservations ? <ObservationStrip active={active} /> : null}
      <div className="flex items-center justify-between gap-2 text-[9px] uppercase tracking-[0.1em] text-[var(--app-muted)]"><span>{active.chart.documentation.events} events · {active.chart.documentation.medications} meds · {active.chart.documentation.forms} forms</span><strong className="text-[var(--app-accent)]">{opening ? "Opening full chart…" : "Open complete chart →"}</strong></div>
    </button> : <div className={`flex min-h-0 flex-1 items-center justify-center text-center ${compact ? "p-3" : "p-8"}`}><div><div className={`mx-auto flex items-center justify-center rounded-2xl border border-[var(--app-border)] bg-[var(--app-control-bg)] text-[var(--app-muted)] ${compact ? "h-10 w-10 text-lg" : "h-14 w-14 text-2xl"}`}>＋</div><div className={`${compact ? "mt-2 text-base" : "mt-4 text-lg"} font-bold text-[var(--app-text)]`}>No active chart</div><p className="mt-1 text-xs text-[var(--app-muted)]">This Leaf has no current patient chart.</p><div className="mt-2 text-[11px] text-[var(--app-muted)]">Last connection {elapsed(bed.last_seen_at)}</div></div></div>}
  </article>;
}

function EmptyChartSlot({ slot, missingLeaf }: { slot: number; missingLeaf?: string }) {
  return <article className="flex h-full min-h-0 items-center justify-center rounded-2xl border border-dashed border-[var(--app-border)] bg-[var(--app-panel-bg)] p-5 text-center"><div><div className="mx-auto flex h-11 w-11 items-center justify-center rounded-xl border border-[var(--app-border)] bg-[var(--app-control-bg)] text-xl text-[var(--app-muted)]">＋</div><div className="mt-2 font-bold text-[var(--app-text)]">Empty chart slot {slot}</div><p className="mt-1 text-xs text-[var(--app-muted)]">{missingLeaf ? `${missingLeaf} is not currently registered.` : "Choose a Leaf from Layout to show it here."}</p></div></article>;
}

/** `wardOnly`: shown on a Leaf, where Canopy limits the view to the Leafs of that Leaf's ward. */
export default function CanopyDashboardView({ wardOnly = false }: { wardOnly?: boolean } = {}) {
  const [beds, setBeds] = useState<IcuOverviewBed[]>([]);
  const [selected, setSelected] = useState<{ entry: IcuOverviewCase; snapshot: FleetSnapshot } | null>(null);
  const [loading, setLoading] = useState(true);
  const [openingId, setOpeningId] = useState("");
  const [error, setError] = useState("");
  const [updatedAt, setUpdatedAt] = useState<Date | null>(null);
  const [layout, setLayout] = useState<ChartLayout>(initialLayout);

  useEffect(() => {
    window.localStorage.setItem(LAYOUT_KEY, JSON.stringify(layout));
  }, [layout]);

  const refresh = useCallback(async (quiet = false) => {
    if (!quiet) setLoading(true);
    try {
      const overview = await getIcuOverview(30);
      setBeds(overview.rows);
      setUpdatedAt(new Date(overview.server_time));
      setError("");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "ICU overview is unavailable.");
    } finally { setLoading(false); }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(true), 30_000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  useEffect(() => {
    if (!beds.length || layout.slots.length) return;
    setLayout(current => ({ ...current, slots: Array.from({ length: current.slotCount }, (_, index) => beds[index]?.leaf_id || "") }));
  }, [beds, layout.slots.length]);

  const openCase = useCallback(async (entry: IcuOverviewCase) => {
    setOpeningId(entry.global_case_id);
    try {
      const snapshot = await getFleetCaseSnapshot(entry.global_case_id);
      setSelected({ entry, snapshot });
      setError("");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "The full ICU chart could not be opened.");
    } finally { setOpeningId(""); }
  }, []);

  const counts = useMemo(() => ({
    live: beds.filter(bed => bed.case).length,
    online: beds.filter(bed => bed.connection_status === "online").length,
    attention: beds.filter(bed => bed.connection_status !== "online" || (bed.case && bed.case.sync_status !== "live")).length,
  }), [beds]);
  const slotAssignments = Array.from({ length: layout.slotCount }, (_, index) => layout.slots[index] || "");
  const chartSlots = slotAssignments.map(leafId => leafId ? beds.find(bed => bed.leaf_id === leafId) || null : null);
  const selectedCount = slotAssignments.filter(Boolean).length;
  const visibleColumns = Math.min(layout.columns, layout.slotCount);
  const visibleRows = Math.max(1, Math.ceil(layout.slotCount / visibleColumns));
  const assignSlot = (slotIndex: number, leafId: string) => setLayout(current => ({
    ...current,
    slots: Array.from({ length: current.slotCount }, (_, index) => index === slotIndex ? leafId : leafId && current.slots[index] === leafId ? "" : current.slots[index] || ""),
  }));

  if (selected) return <CanopyCaseChartView entry={selected.entry} data={selected.snapshot} onBack={() => setSelected(null)} onRefresh={() => void openCase(selected.entry)} refreshing={openingId === selected.entry.global_case_id} />;

  return <main className={`app-theme-scope h-full min-h-0 bg-[var(--app-bg)] p-3 sm:p-5 text-[var(--app-text)] ${layout.fitScreen ? "overflow-hidden" : "overflow-y-auto"}`}>
    <div className="flex h-full min-h-0 w-full flex-col gap-3">
      <header className="flex shrink-0 flex-wrap items-end justify-between gap-3">
        <div><div className="text-xs font-extrabold uppercase tracking-[0.16em] text-[var(--app-accent)]">{wardOnly ? "ESM Flora Leaf · this ward" : "ESM Flora Canopy"} · multi-patient chart review</div><h1 className="mt-1 text-2xl font-semibold">Central Monitor</h1><p className="mt-1 text-sm text-[var(--app-muted)]">Clinical context, documentation, treatment activity and I/O across selected Leaf charts{wardOnly ? " of this ward (read from Canopy)" : ""}.</p></div>
        <div className="flex flex-wrap items-center gap-2 text-sm"><span className="rounded-xl border border-[var(--app-border)] px-3 py-2"><b>{selectedCount}</b> selected</span><span className="rounded-xl border border-sky-500/30 bg-sky-500/10 px-3 py-2 text-sky-500"><b>{counts.live}</b> active {counts.live === 1 ? "chart" : "charts"}</span>{counts.attention ? <span className="rounded-xl border border-amber-500/35 bg-amber-500/10 px-3 py-2 text-amber-500"><b>{counts.attention}</b> connection attention</span> : null}<span className="text-[var(--app-muted)]">Updated {updatedAt ? updatedAt.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "—"}</span>
          <details className="relative"><summary className="cursor-pointer list-none rounded-xl border border-[var(--app-border)] bg-[var(--app-control-bg)] px-3 py-2 font-bold text-[var(--app-text)]">Layout</summary><div className="absolute right-0 z-30 mt-2 max-h-[75vh] w-80 overflow-y-auto rounded-2xl border border-[var(--app-border)] bg-[var(--app-panel-bg)] p-4 shadow-2xl"><div className="text-[10px] font-extrabold uppercase tracking-[0.14em] text-[var(--app-muted)]">Chart slots</div><div className="mt-2 grid grid-cols-5 gap-1.5">{[1, 2, 4, 6, 8].map(slotCount => <button key={slotCount} type="button" onClick={() => setLayout(current => ({ ...current, slotCount, slots: Array.from({ length: slotCount }, (_, index) => current.slots[index] || "") }))} className={`rounded-lg border px-1 py-2 text-xs font-bold ${layout.slotCount === slotCount ? "border-[var(--app-accent)] bg-[var(--app-accent)] text-[var(--app-accent-contrast)]" : "border-[var(--app-border)] bg-[var(--app-control-bg)] text-[var(--app-text)]"}`}>{slotCount}</button>)}</div><div className="mt-3 space-y-2">{slotAssignments.map((leafId, index) => <label key={index} className="block text-[10px] font-bold uppercase tracking-wide text-[var(--app-muted)]">Slot {index + 1}{index === 0 ? " · top left" : index === 1 ? " · top right" : ""}<select value={leafId} onChange={event => assignSlot(index, event.target.value)} className="mt-1 block h-9 w-full rounded-lg border border-[var(--app-border)] bg-[var(--app-control-bg)] px-2 text-xs font-semibold normal-case text-[var(--app-text)]"><option value="">Empty</option>{beds.map(bed => <option key={bed.leaf_id} value={bed.leaf_id} disabled={slotAssignments.some((assigned, assignedIndex) => assignedIndex !== index && assigned === bed.leaf_id)}>{bed.display_name} · {bed.leaf_id}</option>)}</select></label>)}</div><div className="mt-4 text-[10px] font-extrabold uppercase tracking-[0.14em] text-[var(--app-muted)]">Columns</div><div className="mt-2 grid grid-cols-4 gap-2">{[1, 2, 3, 4].map(columns => <button key={columns} type="button" onClick={() => setLayout(current => ({ ...current, columns }))} className={`rounded-lg border px-2 py-2 font-bold ${layout.columns === columns ? "border-[var(--app-accent)] bg-[var(--app-accent)] text-[var(--app-accent-contrast)]" : "border-[var(--app-border)] bg-[var(--app-control-bg)] text-[var(--app-text)]"}`}>{columns}</button>)}</div><div className="mt-4 text-[10px] font-extrabold uppercase tracking-[0.14em] text-[var(--app-muted)]">Density</div><div className="mt-2 grid grid-cols-2 gap-2">{(["compact", "comfortable"] as const).map(density => <button key={density} type="button" onClick={() => setLayout(current => ({ ...current, density }))} className={`rounded-lg border px-2 py-2 text-xs font-bold capitalize ${layout.density === density ? "border-[var(--app-accent)] bg-[var(--app-accent)] text-[var(--app-accent-contrast)]" : "border-[var(--app-border)] bg-[var(--app-control-bg)] text-[var(--app-text)]"}`}>{density}</button>)}</div><label className="mt-4 flex items-center justify-between gap-3 text-sm font-semibold text-[var(--app-text)]"><span>Fit all charts to screen</span><input type="checkbox" checked={layout.fitScreen} onChange={event => setLayout(current => ({ ...current, fitScreen: event.target.checked }))} /></label><label className="mt-3 flex items-center justify-between gap-3 text-sm font-semibold text-[var(--app-text)]"><span>Show latest observations</span><input type="checkbox" checked={layout.showObservations} onChange={event => setLayout(current => ({ ...current, showObservations: event.target.checked }))} /></label></div></details>
          <button type="button" disabled={loading} onClick={() => void refresh()} className="rounded-xl border border-[var(--app-border)] bg-[var(--app-control-bg)] px-3 py-2 font-bold text-[var(--app-text)] disabled:opacity-50">{loading ? "Refreshing…" : "Refresh"}</button></div>
      </header>
      {error ? <div className="shrink-0 rounded-xl border border-rose-500/40 bg-rose-500/10 px-4 py-2 text-sm text-rose-300">{error}</div> : null}
      <section className={`grid min-h-0 gap-2 ${layout.fitScreen ? "flex-1 overflow-hidden" : "auto-rows-[minmax(390px,auto)]"}`} style={{ gridTemplateColumns: `repeat(${visibleColumns}, minmax(0, 1fr))`, ...(layout.fitScreen ? { gridTemplateRows: `repeat(${visibleRows}, minmax(0, 1fr))` } : {}) }} aria-label="Selected patient charts">
        {chartSlots.map((bed, index) => bed ? <BedPanel key={`${index}:${bed.leaf_id}`} bed={bed} opening={openingId === bed.case?.global_case_id} onOpen={entry => void openCase(entry)} density={layout.density} showObservations={layout.showObservations} /> : <EmptyChartSlot key={`empty:${index}`} slot={index + 1} missingLeaf={slotAssignments[index] || undefined} />)}
      </section>
    </div>
  </main>;
}
