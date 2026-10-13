import { describe, expect, it } from "vitest";
import type { Widget } from "../../src/api/aiStudioApi";
import { cellAt, fits, freeSpot, outside, resizeTo } from "../../src/aistudio/dashboard/layout";

const widget = (id: string, x: number, y: number, w = 1, h = 1): Widget => ({ id, type: "text", x, y, w, h, title: "", config: {} });
const grid = { cols: 3, rows: 3 };

describe("dashboard layout", () => {
  it("accepts asymmetric spans that fit and refuses overlaps", () => {
    const board = [widget("a", 0, 0, 2, 1)];
    expect(fits({ x: 2, y: 0, w: 1, h: 2 }, board, grid)).toBe(true);   // 1x2 beside a 2x1
    expect(fits({ x: 1, y: 0, w: 1, h: 1 }, board, grid)).toBe(false);  // overlaps
    expect(fits({ x: 2, y: 2, w: 2, h: 1 }, board, grid)).toBe(false);  // off the grid
    expect(fits({ x: 0, y: 0, w: 2, h: 1 }, board, grid, "a")).toBe(true); // moving onto itself
  });

  it("finds the nearest free spot, falling back to 1x1 when crowded", () => {
    const board = [widget("a", 0, 0, 3, 2), widget("b", 0, 2, 2, 1)];
    expect(freeSpot({ w: 1, h: 1 }, board, grid)).toEqual({ x: 2, y: 2, w: 1, h: 1 });
    expect(freeSpot({ w: 2, h: 2 }, board, grid)).toEqual({ x: 2, y: 2, w: 1, h: 1 });
    expect(freeSpot({ w: 1, h: 1 }, [...board, widget("c", 2, 2)], grid)).toBeNull();
  });

  it("lists widgets a smaller grid would cut off", () => {
    expect(outside([widget("a", 0, 0, 2, 2), widget("b", 2, 2)], { cols: 2, rows: 2 }).map(w => w.id)).toEqual(["b"]);
  });

  it("maps pointer positions to cells and resizes from the top-left", () => {
    const box = { left: 0, top: 0, width: 620, height: 0 } as DOMRect; // 3 columns of 200 + 2 gaps of 10
    expect(cellAt(450, 330, box, grid, 150, 10)).toEqual({ x: 2, y: 2 });
    expect(cellAt(-50, 5, box, grid, 150, 10)).toEqual({ x: 0, y: 0 });
    expect(resizeTo(widget("a", 1, 0), { x: 2, y: 2 }, grid)).toEqual({ x: 1, y: 0, w: 2, h: 3 });
    expect(resizeTo(widget("a", 1, 1), { x: 0, y: 0 }, grid)).toEqual({ x: 1, y: 1, w: 1, h: 1 });
  });
});
