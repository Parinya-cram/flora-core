import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import type { AuthUser } from "../auth/useAuth";
import { getJourney, getTwin, saveTwinLayout, type JourneyStep, type Layout, type Twin, type TwinBed, type TwinUnit } from "../api/twinApi";
import {
  buildScene, depth, project, rotate, snap, unitColor, unproject, zoneColor,
  type PlacedBed, type PlacedRoom, type PlacedUnit, type Rotation, type Scene,
} from "../components/canopy/twinLayout";

// Canopy → Digital twin: an isometric map of care units → rooms (zones) → beds with live patients,
// waiting admissions and patient journeys. Admins can drag units and rooms (and resize them) to match
// the real floor; anything never placed is laid out automatically.

type View = { x: number; y: number; k: number };
type Drag =
  | { kind: "pan"; sx: number; sy: number; view: View }
  | { kind: "unit" | "room"; mode: "move" | "resize"; id: number; sx: number; sy: number; orig: Layout };
type Selection = { kind: "bed"; bed: PlacedBed } | { kind: "unit"; unit: PlacedUnit } | null;

const TRIAGE_FILL: Record<string, string> = { red: "#ef4444", pink: "#ec4899", yellow: "#eab308", green: "#22c55e", white: "#e2e8f0" };
const STATUS_FILL = { in_care: "#0d9488", transfer: "#f97316" };
const JOURNEY_COLORS = ["#7c3aed", "#0ea5e9", "#f97316", "#10b981", "#ec4899", "#eab308", "#ef4444", "#14b8a6"];

const hours = (ms: number | null | undefined) =>
  ms == null ? "—" : ms < 3_600_000 ? `${Math.max(1, Math.round(ms / 60_000))} min` : `${(ms / 3_600_000).toFixed(1)} h`;
const clock = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
const points = (list: Array<[number, number]>) => list.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(" ");

function corners(layout: Layout): Array<[number, number]> {
  return [[layout.x, layout.y], [layout.x + layout.w, layout.y], [layout.x + layout.w, layout.y + layout.h], [layout.x, layout.y + layout.h]];
}

export default function CanopyDigitalTwinView({ sessionUser }: { sessionUser: AuthUser | null }) {
  const [data, setData] = useState<Twin | null>(null);
  const [error, setError] = useState("");
  const [rotation, setRotation] = useState<Rotation>(0);
  const [view, setView] = useState<View>({ x: 400, y: 120, k: 1 });
  const [showJourneys, setShowJourneys] = useState(true);
  const [showLabels, setShowLabels] = useState(true);
  const [showPanel, setShowPanel] = useState(true);
  const [editing, setEditing] = useState(false);
  const [edits, setEdits] = useState<Map<number, Layout>>(new Map());
  const [drag, setDrag] = useState<Drag | null>(null);
  const [selection, setSelection] = useState<Selection>(null);
  const [journey, setJourney] = useState<{ hn: string; steps: JourneyStep[] } | null>(null);
  const [notice, setNotice] = useState("");
  const canvas = useRef<HTMLDivElement>(null);
  const fitted = useRef(false);
  const isAdmin = ["admin", "system_admin"].includes(String(sessionUser?.role || "").toLowerCase());

  const load = useCallback(async () => {
    try { setData(await getTwin()); setError(""); } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
  }, []);
  useEffect(() => {
    let cancelled = false;
    const tick = () => getTwin().then(result => { if (!cancelled) { setData(result); setError(""); } })
      .catch(reason => { if (!cancelled) setError(reason instanceof Error ? reason.message : String(reason)); });
    void tick();
    const timer = window.setInterval(() => { if (!editing) void tick(); }, 20_000);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [editing]);

  const scene: Scene | null = useMemo(() => data ? buildScene(data.units, edits) : null, [data, edits]);
  const center = useMemo(() => scene ? { x: scene.bounds.x + scene.bounds.w / 2, y: scene.bounds.y + scene.bounds.h / 2 } : { x: 0, y: 0 },
    [scene]);
  const P = useCallback((x: number, y: number, z = 0) => project(x, y, z, rotation, center), [rotation, center]);
  const unitIndex = useMemo(() => new Map((data?.units || []).map((unit, index) => [unit.id, index])), [data]);

  const fit = useCallback(() => {
    const box = canvas.current?.getBoundingClientRect();
    if (!box || !scene) return;
    const projected = scene.units.flatMap(placed => corners(placed.abs).flatMap(([x, y]) => [P(x, y, 0), P(x, y, 3)]));
    if (!projected.length) return;
    const xs = projected.map(p => p[0]), ys = projected.map(p => p[1]);
    const minX = Math.min(...xs) - 40, maxX = Math.max(...xs) + 40, minY = Math.min(...ys) - 70, maxY = Math.max(...ys) + 40;
    const k = Math.min(2.2, Math.max(0.25, Math.min(box.width / (maxX - minX), box.height / (maxY - minY))));
    setView({ k, x: (box.width - (maxX - minX) * k) / 2 - minX * k, y: (box.height - (maxY - minY) * k) / 2 - minY * k });
  }, [scene, P]);
  useEffect(() => {
    if (fitted.current || !scene?.units.length) return;
    // After layout, so the canvas has its size; marked only once it ran (StrictMode re-runs effects).
    const frame = requestAnimationFrame(() => { fitted.current = true; fit(); });
    return () => cancelAnimationFrame(frame);
  }, [fit, scene]);

  // Wheel zoom around the pointer.
  useEffect(() => {
    const element = canvas.current;
    if (!element) return;
    const wheel = (event: WheelEvent) => {
      event.preventDefault();
      const box = element.getBoundingClientRect();
      const px = event.clientX - box.left, py = event.clientY - box.top;
      setView(current => {
        const k = Math.min(4, Math.max(0.2, current.k * (event.deltaY < 0 ? 1.12 : 1 / 1.12)));
        return { k, x: px - (px - current.x) * (k / current.k), y: py - (py - current.y) * (k / current.k) };
      });
    };
    element.addEventListener("wheel", wheel, { passive: false });
    return () => element.removeEventListener("wheel", wheel);
  }, []);

  const startDrag = (event: ReactPointerEvent, next: Drag) => {
    event.stopPropagation();
    // Capture only while moving a unit / room: a captured pan would swallow clicks on beds.
    if (next.kind !== "pan") (event.currentTarget as Element).setPointerCapture?.(event.pointerId);
    setDrag(next);
  };
  const onMove = (event: ReactPointerEvent) => {
    if (!drag) return;
    const dx = event.clientX - drag.sx, dy = event.clientY - drag.sy;
    if (drag.kind === "pan") { setView({ ...drag.view, x: drag.view.x + dx, y: drag.view.y + dy }); return; }
    const [du, dv] = unproject(dx / view.k, dy / view.k, rotation);
    const next = drag.mode === "move"
      ? { ...drag.orig, x: snap(drag.orig.x + du), y: snap(drag.orig.y + dv) }
      : { ...drag.orig, w: Math.max(3, snap(drag.orig.w + du)), h: Math.max(3, snap(drag.orig.h + dv)) };
    setEdits(current => new Map(current).set(drag.id, next));
  };

  const save = async () => {
    try {
      await saveTwinLayout([...edits].map(([location_id, layout]) => ({ location_id, ...layout })));
      setEdits(new Map()); setEditing(false); setNotice("Layout saved."); await load();
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
  };
  const resetAuto = async () => {
    if (!data || !window.confirm("Place every unit and room automatically again?")) return;
    try {
      await saveTwinLayout([], data.units.flatMap(unit => [unit.id, ...unit.rooms.map(room => room.id)]));
      setEdits(new Map()); setNotice("Layout reset to automatic."); fitted.current = false; await load();
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
  };
  const openJourney = async (hn: string) => {
    try { setJourney(await getJourney(hn)); setShowJourneys(true); } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
  };

  // Where a journey step sits on the map: bed, else room, else unit centre.
  const anchor = useCallback((step: JourneyStep): [number, number] | null => {
    if (!scene) return null;
    const bed = scene.beds.find(item => item.bed.id === step.location_id);
    if (bed) return [bed.x, bed.y];
    const room = scene.rooms.find(item => item.room.id === step.location_id);
    if (room) return [room.abs.x + room.abs.w / 2, room.abs.y + room.abs.h / 2];
    const unit = scene.units.find(item => item.unit.id === step.unit_id);
    return unit ? [unit.abs.x + unit.abs.w / 2, unit.abs.y + 1] : null;
  }, [scene]);
  const journeyPaths = useMemo(() => {
    if (!data || !showJourneys) return [];
    const list = journey ? [{ key: "selected", label: journey.hn, steps: journey.steps, color: "#7c3aed", strong: true }]
      : data.journeys.map((item, index) => ({ key: item.global_case_id, label: item.initials, steps: item.steps,
          color: JOURNEY_COLORS[index % JOURNEY_COLORS.length], strong: false }));
    return list.map(item => {
      const pts: Array<[number, number]> = [];
      for (const step of item.steps) {
        const at = anchor(step);
        if (at && (!pts.length || pts[pts.length - 1][0] !== at[0] || pts[pts.length - 1][1] !== at[1])) pts.push(at);
      }
      return { ...item, pts };
    }).filter(item => item.pts.length > 1);
  }, [data, journey, showJourneys, anchor]);

  if (!data || !scene) {
    return <div className="flex h-full items-center justify-center bg-[var(--app-bg)] text-sm text-[var(--app-muted)]">{error || "Loading the digital twin…"}</div>;
  }
  const now = data.server_time;
  const ground: Layout = { x: scene.bounds.x - 3, y: scene.bounds.y - 3, w: scene.bounds.w + 6, h: scene.bounds.h + 6 };
  const sortedUnits = [...scene.units].sort((a, b) => depth(a.abs, rotation, center) - depth(b.abs, rotation, center));
  const roomsByUnit = new Map<number, PlacedRoom[]>();
  scene.rooms.forEach(room => roomsByUnit.set(room.unit.id, [...(roomsByUnit.get(room.unit.id) || []), room]));
  const bedsByRoom = new Map<number, PlacedBed[]>();
  scene.beds.forEach(bed => bedsByRoom.set(bed.room.id, [...(bedsByRoom.get(bed.room.id) || []), bed]));
  const tool = "flex h-9 items-center gap-1.5 rounded-xl px-2.5 text-sm font-semibold text-[var(--app-text)] hover:bg-[var(--app-control-bg-hover)]";

  const wall = (a: [number, number], b: [number, number], height: number, color: string, opacity: number, key: string) => (
    <polygon key={key} points={points([P(a[0], a[1], 0), P(b[0], b[1], 0), P(b[0], b[1], height), P(a[0], a[1], height)])}
      fill={color} fillOpacity={opacity} stroke={color} strokeOpacity={0.9} strokeWidth={1} pointerEvents="none" />
  );
  /** Room walls split into the two far edges (drawn before beds) and the two near ones (after). */
  const roomWalls = (layout: Layout, color: string, key: string) => {
    const c = corners(layout);
    const edges = [0, 1, 2, 3].map(i => ({ a: c[i], b: c[(i + 1) % 4], d: (() => {
      const [ax, ay] = rotate(c[i][0], c[i][1], rotation, center), [bx, by] = rotate(c[(i + 1) % 4][0], c[(i + 1) % 4][1], rotation, center);
      return (ax + ay + bx + by) / 2;
    })() })).sort((x, y) => x.d - y.d);
    return {
      back: edges.slice(0, 2).map((edge, i) => wall(edge.a, edge.b, 1.7, color, 0.16, `${key}-b${i}`)),
      front: edges.slice(2).map((edge, i) => wall(edge.a, edge.b, 0.45, color, 0.28, `${key}-f${i}`)),
    };
  };
  const bedShape = (placed: PlacedBed) => {
    const { bed } = placed;
    const s = 0.62, h = 0.35;
    const base: Layout = { x: placed.x - s, y: placed.y - s * 1.2, w: s * 2, h: s * 2.4 };
    const c = corners(base);
    const occupant = bed.occupant;
    const selected = selection?.kind === "bed" && selection.bed.bed.id === bed.id;
    const top = points(c.map(([x, y]) => P(x, y, h)));
    const [px, py] = P(placed.x, placed.y, h + 1.15);
    const [lx, ly] = P(c[0][0], c[0][1], h);
    return (
      <g key={`bed-${bed.id}`} className="cursor-pointer" pointerEvents={editing ? "none" : undefined}
        onClick={event => { event.stopPropagation(); setSelection({ kind: "bed", bed: placed }); }}>
        {[[0, 1], [1, 2], [2, 3], [3, 0]].map(([i, j]) => (
          <polygon key={`${i}`} points={points([P(c[i][0], c[i][1], 0), P(c[j][0], c[j][1], 0), P(c[j][0], c[j][1], h), P(c[i][0], c[i][1], h)])}
            fill="#94a3b8" fillOpacity={0.55} stroke="#64748b" strokeWidth={0.6} />
        ))}
        <polygon points={top} fill={occupant ? "#ccfbf1" : "#f8fafc"} stroke={selected ? "#7c3aed" : bed.leaf ? "#64748b" : "#94a3b8"}
          strokeWidth={selected ? 2.2 : 0.8} strokeDasharray={bed.leaf ? undefined : "3 2"} />
        {bed.leaf && <circle cx={lx} cy={ly} r={2.6} fill={bed.leaf.status === "online" ? "#10b981" : bed.leaf.status === "delayed" ? "#f59e0b" : "#ef4444"}>
          <title>{`Leaf ${bed.leaf.name} · ${bed.leaf.status}`}</title></circle>}
        {occupant && <g>
          <line x1={px} y1={py} x2={px} y2={py + 13} stroke="#334155" strokeWidth={1} />
          <circle cx={px} cy={py} r={9.5} fill={occupant.triage_color ? TRIAGE_FILL[occupant.triage_color] : STATUS_FILL[occupant.status]}
            stroke={occupant.status === "transfer" ? "#f97316" : "#ffffff"} strokeWidth={2} />
          <text x={px} y={py + 3.2} textAnchor="middle" fontSize={8.5} fontWeight={700}
            fill={occupant.triage_color === "white" || occupant.triage_color === "yellow" ? "#0f172a" : "#ffffff"}>{occupant.initials}</text>
          <title>{`${occupant.initials} · HN ${occupant.hn_masked} · ${hours(occupant.started_at ? now - occupant.started_at : null)}${occupant.triage_level ? ` · triage ${occupant.triage_level}` : ""}`}</title>
        </g>}
        {showLabels && view.k > 0.9 && <text x={P(placed.x, placed.y + s * 1.2 + 0.3, 0)[0]} y={P(placed.x, placed.y + s * 1.2 + 0.3, 0)[1] + 8}
          textAnchor="middle" fontSize={6.5} fill="#475569">{bed.name}</text>}
      </g>
    );
  };

  const selectedBed = selection?.kind === "bed" ? selection.bed : null;
  const selectedUnit: TwinUnit | null = selection?.kind === "unit" ? selection.unit.unit : selectedBed?.unit || null;

  return (
    <div className="relative flex h-full overflow-hidden bg-[radial-gradient(ellipse_at_top_left,#fdf2f8,transparent_55%),radial-gradient(ellipse_at_bottom_right,#e0f2fe,transparent_55%)] dark:bg-[var(--app-bg)]">
      <style>{"@keyframes twin-dash { to { stroke-dashoffset: -40; } }"}</style>
      <div ref={canvas} className={`relative min-w-0 flex-1 ${drag?.kind === "pan" ? "cursor-grabbing" : "cursor-grab"}`}
        onPointerDown={event => startDrag(event, { kind: "pan", sx: event.clientX, sy: event.clientY, view })}
        onPointerMove={onMove} onPointerUp={() => setDrag(null)} onPointerLeave={() => setDrag(null)}
        onClick={() => { if (!drag) setSelection(null); }}>
        <svg className="h-full w-full select-none" role="img" aria-label="Hospital digital twin">
          <g transform={`translate(${view.x} ${view.y}) scale(${view.k})`}>
            {/* building slab */}
            <polygon points={points([...corners(ground).map(([x, y]) => P(x, y, 0))])} fill="#ffffff" fillOpacity={0.85} stroke="#cbd5e1" strokeWidth={1.2} />
            {[[0, 1], [1, 2], [2, 3], [3, 0]].map(([i, j]) => {
              const c = corners(ground);
              return <polygon key={`slab-${i}`} points={points([P(c[i][0], c[i][1], 0), P(c[j][0], c[j][1], 0), P(c[j][0], c[j][1], -0.7), P(c[i][0], c[i][1], -0.7)])}
                fill="#e2e8f0" stroke="#cbd5e1" strokeWidth={0.8} />;
            })}

            {sortedUnits.map(placed => {
              const color = unitColor(unitIndex.get(placed.unit.id) || 0);
              const rooms = [...(roomsByUnit.get(placed.unit.id) || [])].sort((a, b) => depth(a.abs, rotation, center) - depth(b.abs, rotation, center));
              const [hx, hy] = P(placed.abs.x + placed.abs.w, placed.abs.y + placed.abs.h, 0);
              return (
                <g key={`unit-${placed.unit.id}`}>
                  <polygon points={points(corners(placed.abs).map(([x, y]) => P(x, y, 0.02)))} fill={color} fillOpacity={0.08}
                    stroke={color} strokeOpacity={0.7} strokeWidth={1.4} strokeDasharray="6 4"
                    className={editing ? "cursor-move" : "cursor-pointer"}
                    onPointerDown={editing ? event => startDrag(event, { kind: "unit", mode: "move", id: placed.unit.id, sx: event.clientX, sy: event.clientY, orig: placed.abs }) : undefined}
                    onClick={event => { event.stopPropagation(); setSelection({ kind: "unit", unit: placed }); }} />
                  {placed.unit.waiting.slice(0, 10).map((person, index) => {
                    const [wx, wy] = P(placed.abs.x + 1 + index * 0.9, placed.abs.y + 0.9, 0.9);
                    return <g key={person.id}><circle cx={wx} cy={wy} r={6} fill="#f59e0b" stroke="#fff" strokeWidth={1.5} />
                      <title>{`Waiting: ${person.initials} · HN ${person.hn_masked} · ${hours(now - person.waiting_since)}`}</title></g>;
                  })}
                  {rooms.map(placedRoom => {
                    const roomColor = zoneColor(placedRoom.room.zone, unitIndex.get(placed.unit.id) || 0);
                    const walls = roomWalls(placedRoom.abs, roomColor, `room-${placedRoom.room.id}`);
                    const [rx, ry] = P(placedRoom.abs.x + placedRoom.abs.w, placedRoom.abs.y + placedRoom.abs.h, 0);
                    const label = P(placedRoom.abs.x + 0.4, placedRoom.abs.y + 0.4, 1.9);
                    return (
                      <g key={`room-${placedRoom.room.id}`}>
                        <polygon points={points(corners(placedRoom.abs).map(([x, y]) => P(x, y, 0.04)))} fill={roomColor} fillOpacity={0.14}
                          stroke={roomColor} strokeWidth={1}
                          className={editing ? "cursor-move" : undefined}
                          onPointerDown={editing ? event => startDrag(event, { kind: "room", mode: "move", id: placedRoom.room.id, sx: event.clientX, sy: event.clientY, orig: placedRoom.rel }) : undefined} />
                        {walls.back}
                        {(bedsByRoom.get(placedRoom.room.id) || []).map(bedShape)}
                        {walls.front}
                        {showLabels && view.k > 0.55 && <text x={label[0]} y={label[1]} fontSize={8} fontWeight={700} fill="#0f172a" pointerEvents="none">
                          {placedRoom.room.name}{placedRoom.room.zone && !placedRoom.room.name.toLowerCase().includes(placedRoom.room.zone.split(/[\s(]/)[0].toLowerCase())
                            ? ` · ${placedRoom.room.zone}` : ""}</text>}
                        {editing && <circle cx={rx} cy={ry} r={5} fill="#7c3aed" stroke="#fff" strokeWidth={1.5} className="cursor-nwse-resize"
                          onPointerDown={event => startDrag(event, { kind: "room", mode: "resize", id: placedRoom.room.id, sx: event.clientX, sy: event.clientY, orig: placedRoom.rel })} />}
                      </g>
                    );
                  })}
                  {editing && <circle cx={hx} cy={hy} r={6} fill={color} stroke="#fff" strokeWidth={1.5} className="cursor-nwse-resize"
                    onPointerDown={event => startDrag(event, { kind: "unit", mode: "resize", id: placed.unit.id, sx: event.clientX, sy: event.clientY, orig: placed.abs })} />}
                </g>
              );
            })}

            {journeyPaths.map(path => (
              <g key={path.key} pointerEvents="none">
                <polyline points={points(path.pts.map(([x, y]) => P(x, y, 0.15)))} fill="none" stroke={path.color}
                  strokeWidth={path.strong ? 3.5 : 2} strokeOpacity={0.85} strokeDasharray="8 6" strokeLinecap="round"
                  style={{ animation: "twin-dash 1.6s linear infinite" }} />
                {path.pts.map(([x, y], index) => {
                  const [cx, cy] = P(x, y, 0.15);
                  return <circle key={index} cx={cx} cy={cy} r={index === path.pts.length - 1 ? 4.5 : 3} fill={path.color} stroke="#fff" strokeWidth={1.2} />;
                })}
              </g>
            ))}

            {/* unit cards float above the scene */}
            {showLabels && sortedUnits.map(placed => {
              const [cx, cy] = P(placed.abs.x + placed.abs.w / 2, placed.abs.y, 3.4);
              const color = unitColor(unitIndex.get(placed.unit.id) || 0);
              const kpi = placed.unit.kpi;
              const width = Math.max(120, placed.unit.name.length * 7 + 40);
              return (
                <g key={`card-${placed.unit.id}`} className="cursor-pointer" onClick={event => { event.stopPropagation(); setSelection({ kind: "unit", unit: placed }); }}>
                  <rect x={cx - width / 2} y={cy - 30} width={width} height={34} rx={8} fill="#ffffff" stroke={color} strokeWidth={1.2}
                    style={{ filter: "drop-shadow(0 2px 4px rgb(0 0 0 / 0.12))" }} />
                  <rect x={cx - width / 2 + 8} y={cy - 22} width={7} height={7} rx={2} fill={color} />
                  <text x={cx - width / 2 + 20} y={cy - 15} fontSize={10.5} fontWeight={700} fill="#0f172a">{placed.unit.name}</text>
                  <text x={cx - width / 2 + 8} y={cy - 2} fontSize={8} fill="#475569">
                    {kpi.occupied}/{kpi.beds} beds · {kpi.patients} pts{kpi.waiting ? ` · ${kpi.waiting} waiting` : ""}{kpi.critical ? ` · ${kpi.critical} critical` : ""}
                  </text>
                </g>
              );
            })}
          </g>
        </svg>

        {/* toolbar */}
        <div className="absolute right-3 top-3 flex flex-wrap items-center gap-1 rounded-2xl border border-[var(--app-border)] bg-[var(--app-panel-bg)]/95 p-1 shadow-lg backdrop-blur"
          onPointerDown={event => event.stopPropagation()} onClick={event => event.stopPropagation()}>
          <button className={tool} title="Rotate left" onClick={() => setRotation(r => ((r + 3) % 4) as Rotation)}>↺</button>
          <button className={tool} title="Rotate right" onClick={() => setRotation(r => ((r + 1) % 4) as Rotation)}>↻</button>
          <button className={tool} title="Zoom out" onClick={() => setView(v => ({ ...v, k: Math.max(0.2, v.k / 1.2) }))}>−</button>
          <button className={tool} title="Zoom in" onClick={() => setView(v => ({ ...v, k: Math.min(4, v.k * 1.2) }))}>+</button>
          <button className={tool} title="Fit" onClick={fit}>⤢</button>
          <button className={`${tool} ${showJourneys ? "bg-violet-500/15" : ""}`} onClick={() => { setShowJourneys(v => !v); setJourney(null); }}>🧭 Journeys</button>
          <button className={`${tool} ${showLabels ? "bg-[var(--app-control-bg)]" : ""}`} onClick={() => setShowLabels(v => !v)}>🏷 Labels</button>
          <button className={`${tool} ${showPanel ? "bg-[var(--app-accent)] text-[var(--app-accent-contrast)]" : ""}`} onClick={() => setShowPanel(v => !v)}>📊 Dashboard</button>
          {isAdmin && (editing ? <>
            <button className={`${tool} bg-emerald-500/15`} onClick={() => void save()} disabled={!edits.size}>Save layout</button>
            <button className={tool} onClick={() => { setEdits(new Map()); setEditing(false); }}>Cancel</button>
            <button className={tool} onClick={() => void resetAuto()}>Auto</button>
          </> : <button className={tool} onClick={() => {
            // Freeze the current (partly automatic) placement so moving one item does not reflow the others.
            setEdits(new Map([...scene.units.map(item => [item.unit.id, item.abs] as const),
              ...scene.rooms.map(item => [item.room.id, item.rel] as const)]));
            setEditing(true);
          }}>✏️ Edit layout</button>)}
        </div>
        {editing && <div className="absolute bottom-12 left-3 rounded-xl border border-violet-300 bg-violet-50 px-3 py-2 text-sm text-violet-900">
          Drag a unit or room to move it; drag the round handle to resize. Save when done.</div>}
        {(error || notice) && <div className="absolute bottom-3 left-3 rounded-xl border border-[var(--app-border)] bg-[var(--app-panel-bg)] px-3 py-2 text-sm text-[var(--app-text)]"
          onClick={() => { setNotice(""); setError(""); }}>{error || notice}</div>}
        <div className="pointer-events-none absolute bottom-3 right-3 flex flex-wrap gap-3 rounded-xl bg-[var(--app-panel-bg)]/90 px-3 py-1.5 text-[11px] text-[var(--app-text)]">
          {[["#0d9488", "In care"], ["#f97316", "Transfer pending"], ["#f59e0b", "Waiting (admission)"], ["#ef4444", "Triage 1"], ["#ec4899", "Triage 2"],
            ["#eab308", "Triage 3"]].map(([color, label]) => (
            <span key={label} className="inline-flex items-center gap-1"><span className="h-2.5 w-2.5 rounded-full" style={{ background: color }} />{label}</span>
          ))}
          <span className="inline-flex items-center gap-1"><span className="h-2.5 w-2.5 rounded-sm border border-dashed border-slate-400" />Bed without Leaf</span>
        </div>
      </div>

      {showPanel && (
        <aside className="w-[320px] shrink-0 space-y-3 overflow-y-auto border-l border-[var(--app-border)] bg-[var(--app-panel-bg)]/95 p-3">
          <div>
            <div className="text-xs font-bold uppercase tracking-[0.16em] text-[var(--app-accent)]">Digital twin</div>
            <div className="mt-1 text-3xl font-semibold text-[var(--app-text)]">{clock(now)}</div>
            <div className="text-xs text-[var(--app-muted)]">{data.buildings.map(b => b.name).join(" · ") || "Hospital"} · live, refreshes every 20 s</div>
          </div>
          <div className="grid grid-cols-2 gap-2">
            {[["🧑‍⚕️", "Patients", data.totals.patients], ["🛏", "Beds occupied", `${data.totals.occupied}/${data.totals.beds}`],
              ["⏳", "Waiting", data.totals.waiting], ["🔁", "Transfer pending", data.totals.transfer], ["🚨", "Triage 1–2", data.totals.critical],
              ["🧭", "Journeys (24 h)", data.journeys.length]].map(([icon, label, value]) => (
              <div key={String(label)} className="rounded-xl border border-[var(--app-border)] bg-[var(--app-bg)] p-2">
                <div className="text-[11px] text-[var(--app-muted)]">{icon} {label}</div>
                <div className="text-xl font-semibold text-[var(--app-text)]">{value}</div>
              </div>
            ))}
          </div>

          {selectedBed ? (
            <div className="rounded-xl border border-violet-300 p-3">
              <div className="text-xs text-[var(--app-muted)]">{selectedBed.unit.name} · {selectedBed.room.name}{selectedBed.room.zone ? ` (${selectedBed.room.zone})` : ""}</div>
              <div className="text-lg font-semibold text-[var(--app-text)]">🛏 {selectedBed.bed.name}</div>
              <BedDetail bed={selectedBed.bed} now={now} onJourney={hn => void openJourney(hn)} />
            </div>
          ) : null}
          {journey && (
            <div className="rounded-xl border border-[var(--app-border)] p-3">
              <div className="flex items-center justify-between"><span className="font-semibold text-[var(--app-text)]">Journey · HN {journey.hn}</span>
                <button className="text-xs text-[var(--app-muted)]" onClick={() => setJourney(null)}>Close</button></div>
              <ol className="mt-2 space-y-1.5 border-l-2 border-violet-300 pl-3 text-sm">
                {journey.steps.map((step, index) => (
                  <li key={index}><div className="font-medium text-[var(--app-text)]">{step.label}</div>
                    <div className="text-xs text-[var(--app-muted)]">{new Date(step.at).toLocaleString()} · {[step.unit_name, step.location_name].filter(Boolean).join(" · ") || "—"}</div></li>
                ))}
                {!journey.steps.length && <li className="text-xs text-[var(--app-muted)]">No recorded steps in the last 30 days.</li>}
              </ol>
            </div>
          )}

          <div>
            <div className="mb-1.5 text-[11px] font-bold uppercase tracking-[0.14em] text-[var(--app-muted)]">Care units</div>
            <div className="space-y-1.5">
              {data.units.map((unit, index) => {
                const share = unit.kpi.beds ? unit.kpi.occupied / unit.kpi.beds : 0;
                return (
                  <button key={unit.id} className={`w-full rounded-xl border p-2 text-left ${selectedUnit?.id === unit.id ? "border-[var(--app-accent)]" : "border-[var(--app-border)]"}`}
                    onClick={() => { const placed = scene.units.find(item => item.unit.id === unit.id); if (placed) setSelection({ kind: "unit", unit: placed }); }}>
                    <div className="flex items-center justify-between text-sm">
                      <span className="inline-flex items-center gap-1.5 font-semibold text-[var(--app-text)]"><span className="h-2.5 w-2.5 rounded-sm" style={{ background: unitColor(index) }} />{unit.name}</span>
                      <span className="text-xs text-[var(--app-muted)]">{unit.kpi.occupied}/{unit.kpi.beds}</span>
                    </div>
                    <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-[var(--app-control-bg)]"><div className="h-full rounded-full" style={{ width: `${share * 100}%`, background: unitColor(index) }} /></div>
                    <div className="mt-1 text-[11px] text-[var(--app-muted)]">
                      {unit.kpi.patients} patients · avg stay {hours(unit.kpi.avg_stay_ms)}{unit.kpi.waiting ? ` · ${unit.kpi.waiting} waiting` : ""}{unit.kpi.transfer ? ` · ${unit.kpi.transfer} transfer` : ""}
                    </div>
                  </button>
                );
              })}
            </div>
          </div>
          <p className="text-[11px] text-[var(--app-muted)]">Patients show as initials with a masked HN; names appear only in the bed detail. Journeys are built from admissions, cases, handovers, ER form times and recorded moves.</p>
        </aside>
      )}
    </div>
  );
}

function BedDetail({ bed, now, onJourney }: { bed: TwinBed; now: number; onJourney: (hn: string) => void }) {
  const occupant = bed.occupant;
  return (
    <div className="mt-2 space-y-2 text-sm">
      <div className="text-[var(--app-text)]">{bed.leaf ? <>🖥️ {bed.leaf.name} <span className="text-xs text-[var(--app-muted)]">({bed.leaf.status})</span></> : <span className="text-[var(--app-muted)]">No Leaf serves this bed</span>}</div>
      {occupant ? (
        <div className="rounded-lg bg-[var(--app-bg)] p-2">
          <div className="font-semibold text-[var(--app-text)]">{occupant.name}</div>
          <div className="text-xs text-[var(--app-muted)]">HN {occupant.hn} · in unit {hours(occupant.started_at ? now - occupant.started_at : null)}</div>
          <div className="mt-1 flex flex-wrap gap-1 text-[11px]">
            <span className="rounded bg-teal-500/15 px-1.5 text-teal-700 dark:text-teal-300">{occupant.status === "transfer" ? "Transfer pending" : "In care"}</span>
            {occupant.triage_level && <span className="rounded px-1.5" style={{ background: `${TRIAGE_FILL[occupant.triage_color || "white"]}33` }}>Triage {occupant.triage_level}</span>}
          </div>
          <button className="mt-2 rounded-lg border border-[var(--app-border)] px-2 py-1 text-xs font-semibold text-[var(--app-text)]" onClick={() => onJourney(occupant.hn)}>🧭 Show journey</button>
        </div>
      ) : <div className="text-xs text-[var(--app-muted)]">Empty bed</div>}
    </div>
  );
}
