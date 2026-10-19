import type { Layout, TwinBed, TwinRoom, TwinUnit } from "../../api/twinApi";

// Layout and isometric projection for the Canopy digital twin. World units are grid cells on the
// floor plane: care units sit on the building floor, rooms inside their unit (stored relative to it),
// beds are spread inside their room. Saved layouts win; anything without one is packed automatically.

export const CELL_W = 15.6;   // screen px per cell along x (cos 30° · 18)
export const CELL_H = 9;      // screen px per cell along y (sin 30° · 18)
export const LEVEL = 18;      // screen px per unit of height

export type Rotation = 0 | 1 | 2 | 3;
export type PlacedRoom = { room: TwinRoom; unit: TwinUnit; abs: Layout; rel: Layout; auto: boolean };
export type PlacedBed = { bed: TwinBed; room: TwinRoom; unit: TwinUnit; x: number; y: number };
export type PlacedUnit = { unit: TwinUnit; abs: Layout; auto: boolean };
export type Scene = { units: PlacedUnit[]; rooms: PlacedRoom[]; beds: PlacedBed[]; bounds: Layout };

function roomSize(room: TwinRoom): { w: number; h: number } {
  const n = Math.max(1, room.beds.length);
  const cols = Math.min(4, Math.ceil(Math.sqrt(n)));
  const rows = Math.ceil(n / cols);
  return { w: Math.max(4, cols * 2.4 + 1.2), h: Math.max(4, rows * 2.8 + 1.2) };
}

/** Shelf packing: items left to right, wrapping at maxWidth. */
function pack<T>(items: T[], size: (item: T) => { w: number; h: number }, maxWidth: number, gap: number): Map<T, Layout> {
  const out = new Map<T, Layout>();
  let x = 0, y = 0, rowHeight = 0;
  for (const item of items) {
    const { w, h } = size(item);
    if (x > 0 && x + w > maxWidth) { x = 0; y += rowHeight + gap; rowHeight = 0; }
    out.set(item, { x, y, w, h });
    x += w + gap;
    rowHeight = Math.max(rowHeight, h);
  }
  return out;
}

export function buildScene(units: TwinUnit[], edits: Map<number, Layout>): Scene {
  const roomRel = new Map<number, { rel: Layout; auto: boolean }>();
  const unitSize = new Map<number, { w: number; h: number }>();
  for (const unit of units) {
    const auto = unit.rooms.filter(room => !(edits.get(room.id) || room.layout));
    const packed = pack(auto, roomSize, 22, 1);
    let maxX = 0, maxY = 0;
    for (const room of unit.rooms) {
      const saved = edits.get(room.id) || room.layout;
      const rel = saved || (() => { const p = packed.get(room)!; return { x: p.x + 1, y: p.y + 2, w: p.w, h: p.h }; })();
      roomRel.set(room.id, { rel, auto: !saved });
      maxX = Math.max(maxX, rel.x + rel.w);
      maxY = Math.max(maxY, rel.y + rel.h);
    }
    unitSize.set(unit.id, { w: Math.max(8, maxX + 1), h: Math.max(6, maxY + 1) });
  }
  const autoUnits = units.filter(unit => !(edits.get(unit.id) || unit.layout));
  const packedUnits = pack(autoUnits, unit => unitSize.get(unit.id)!, 60, 4);
  const placedUnits: PlacedUnit[] = units.map(unit => {
    const saved = edits.get(unit.id) || unit.layout;
    const size = unitSize.get(unit.id)!;
    const abs = saved ? { ...saved, w: Math.max(saved.w, 4), h: Math.max(saved.h, 4) } : { ...packedUnits.get(unit)!, ...size };
    return { unit, abs, auto: !saved };
  });
  const rooms: PlacedRoom[] = [];
  const beds: PlacedBed[] = [];
  for (const placed of placedUnits) {
    for (const room of placed.unit.rooms) {
      const { rel, auto } = roomRel.get(room.id)!;
      const abs = { x: placed.abs.x + rel.x, y: placed.abs.y + rel.y, w: rel.w, h: rel.h };
      rooms.push({ room, unit: placed.unit, abs, rel, auto });
      const n = room.beds.length;
      const cols = Math.max(1, Math.min(n, Math.max(1, Math.floor((abs.w - 0.6) / 2.2))));
      const rows = Math.max(1, Math.ceil(n / cols));
      room.beds.forEach((bed, index) => {
        const col = index % cols, row = Math.floor(index / cols);
        beds.push({ bed, room, unit: placed.unit,
          x: abs.x + 0.3 + (col + 0.5) * (abs.w - 0.6) / cols, y: abs.y + 0.3 + (row + 0.5) * (abs.h - 0.6) / rows });
      });
    }
  }
  const xs = placedUnits.flatMap(p => [p.abs.x, p.abs.x + p.abs.w]);
  const ys = placedUnits.flatMap(p => [p.abs.y, p.abs.y + p.abs.h]);
  const bounds = xs.length ? { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) }
    : { x: 0, y: 0, w: 10, h: 10 };
  return { units: placedUnits, rooms, beds, bounds };
}

/** Rotate a floor point by quarter turns around the scene centre. */
export function rotate(x: number, y: number, rotation: Rotation, center: { x: number; y: number }): [number, number] {
  const dx = x - center.x, dy = y - center.y;
  switch (rotation) {
    case 1: return [center.x - dy, center.y + dx];
    case 2: return [center.x - dx, center.y - dy];
    case 3: return [center.x + dy, center.y - dx];
    default: return [x, y];
  }
}

export function project(x: number, y: number, z: number, rotation: Rotation, center: { x: number; y: number }): [number, number] {
  const [rx, ry] = rotate(x, y, rotation, center);
  return [(rx - ry) * CELL_W, (rx + ry) * CELL_H - z * LEVEL];
}

/** Screen-space drag delta (already divided by zoom) → floor delta in world cells. */
export function unproject(dx: number, dy: number, rotation: Rotation): [number, number] {
  const u = (dx / CELL_W + dy / CELL_H) / 2;
  const v = (dy / CELL_H - dx / CELL_W) / 2;
  switch (rotation) {
    case 1: return [v, -u];
    case 2: return [-u, -v];
    case 3: return [-v, u];
    default: return [u, v];
  }
}

/** Painter's order: the far corner first. */
export function depth(layout: Layout, rotation: Rotation, center: { x: number; y: number }): number {
  const corners = [[layout.x, layout.y], [layout.x + layout.w, layout.y], [layout.x, layout.y + layout.h], [layout.x + layout.w, layout.y + layout.h]]
    .map(([x, y]) => rotate(x, y, rotation, center));
  return Math.min(...corners.map(([x, y]) => x + y));
}

export const snap = (value: number) => Math.round(value * 2) / 2;

const ZONE_COLORS: Array<[RegExp, string]> = [
  [/red|resus/i, "#ef4444"], [/pink|acute/i, "#ec4899"], [/yellow|urgent/i, "#eab308"], [/green|fast/i, "#22c55e"],
  [/trauma/i, "#f97316"], [/observ/i, "#8b5cf6"], [/isol/i, "#64748b"], [/pediat|child/i, "#0ea5e9"],
  [/psych/i, "#a855f7"], [/triage/i, "#14b8a6"], [/procedure|minor/i, "#06b6d4"], [/icu|critical/i, "#0d9488"],
  [/or|operat|theatre/i, "#2563eb"],
];
const UNIT_COLORS = ["#0ea5e9", "#f97316", "#10b981", "#8b5cf6", "#ec4899", "#14b8a6", "#eab308", "#6366f1"];

export function zoneColor(zone: string | null, unitIndex: number): string {
  if (zone) for (const [pattern, color] of ZONE_COLORS) if (pattern.test(zone)) return color;
  return UNIT_COLORS[unitIndex % UNIT_COLORS.length];
}
export const unitColor = (unitIndex: number) => UNIT_COLORS[unitIndex % UNIT_COLORS.length];
