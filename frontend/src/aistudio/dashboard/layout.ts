/** Grid layout rules for AI Studio dashboards (pure; mirrored by the server's _clean_widgets). */
import type { Widget } from "../../api/aiStudioApi";

export type Rect = { x: number; y: number; w: number; h: number };
export type Grid = { cols: number; rows: number };

export const GRID_PRESETS: Array<[number, number]> = [[2, 2], [3, 3], [4, 4], [3, 2], [4, 3], [6, 4]];
export const SIZE_PRESETS: Array<[number, number]> = [[1, 1], [2, 1], [1, 2], [2, 2], [3, 1], [1, 3], [3, 2], [2, 3], [3, 3], [4, 1], [4, 2]];
export const MAX_GRID = 6;

const overlaps = (a: Rect, b: Rect) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

export const inside = (rect: Rect, grid: Grid) => rect.x >= 0 && rect.y >= 0 && rect.w >= 1 && rect.h >= 1 && rect.x + rect.w <= grid.cols && rect.y + rect.h <= grid.rows;

/** The rectangle fits the grid and touches no other widget (ignoring the one being moved). */
export function fits(rect: Rect, widgets: Widget[], grid: Grid, ignore?: string): boolean {
  return inside(rect, grid) && !widgets.some(widget => widget.id !== ignore && overlaps(rect, widget));
}

/** First free top-left cell (row by row) for a w x h widget, preferring `near`; null when the board is full. */
export function freeSpot(size: { w: number; h: number }, widgets: Widget[], grid: Grid, near?: { x: number; y: number }): Rect | null {
  if (near && fits({ ...near, ...size }, widgets, grid)) return { ...near, ...size };
  for (const [w, h] of [[size.w, size.h], [1, 1]]) {
    for (let y = 0; y < grid.rows; y++) for (let x = 0; x < grid.cols; x++) {
      if (fits({ x, y, w, h }, widgets, grid)) return { x, y, w, h };
    }
  }
  return null;
}

/** Widgets that would fall outside a smaller grid. */
export const outside = (widgets: Widget[], grid: Grid) => widgets.filter(widget => !inside(widget, grid));

/** The cell under a pointer position inside the board element. */
export function cellAt(clientX: number, clientY: number, box: DOMRect, grid: Grid, rowHeight: number, gap: number): { x: number; y: number } {
  const colWidth = (box.width - gap * (grid.cols - 1)) / grid.cols;
  const x = Math.floor((clientX - box.left + gap / 2) / (colWidth + gap));
  const y = Math.floor((clientY - box.top + gap / 2) / (rowHeight + gap));
  return { x: Math.max(0, Math.min(grid.cols - 1, x)), y: Math.max(0, Math.min(grid.rows - 1, y)) };
}

/** Resize from a widget's top-left to the cell under the pointer, clamped to the grid. */
export function resizeTo(widget: Widget, cell: { x: number; y: number }, grid: Grid): Rect {
  return { x: widget.x, y: widget.y, w: Math.max(1, Math.min(grid.cols - widget.x, cell.x - widget.x + 1)), h: Math.max(1, Math.min(grid.rows - widget.y, cell.y - widget.y + 1)) };
}
