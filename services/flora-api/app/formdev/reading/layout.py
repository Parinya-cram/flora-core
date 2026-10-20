"""The layout of a form page without AI (OpenCV), as evidence for reading it (formdev/docs/FORM-STUDIO-V2.md §5):

- rules: the ruled lines that close regions (a table's cells, a box, the frame of the form);
- cells: the regions the rules close, each with the text lines inside it and the room left to write;
- grids: regular lattices of small cells (a chart over time, a score grid), told apart from cells so that a chart's
  hundreds of squares are not read as checkboxes;
- blanks: where a value is written: a free underline (one that closes nothing), a dotted leader, a run of underscores
  in the text;
- checkboxes: small squares outside grids, with the text next to them.

Everything is in page fractions with a short id (L text line, C cell, G grid, B blank, K checkbox): the steps after
this one (understand.py, assemble.py), and the AI, point at the evidence instead of describing it again.
"""
from __future__ import annotations

import re
from typing import Any

MM_PER_INCH = 25.4
DOTS = re.compile(r"[.·…‥_]{3,}|_{2,}")


def _box(x0: float, y0: float, x1: float, y1: float, width: int, height: int) -> list[float]:
    return [round(x0 / width, 5), round(y0 / height, 5), round(x1 / width, 5), round(y1 / height, 5)]


class Ids:
    """Ids that stay unique over all the pages of a document."""

    def __init__(self) -> None:
        self.counts: dict[str, int] = {}

    def __call__(self, prefix: str) -> str:
        self.counts[prefix] = self.counts.get(prefix, 0) + 1
        return f"{prefix}{self.counts[prefix]}"


def analyse(image: Any, dpi: int, lines: list[dict[str, Any]], ids: Ids | None = None, page: int = 0,
            drawn_checkboxes: list[dict[str, Any]] | None = None) -> dict[str, Any]:
    """The page's evidence: {lines, cells, grids, blanks, checkboxes, rules}. lines are the OCR / text-layer lines of the
    page (box in page fractions); they get ids and the cell they sit in (a line running over a cell border is cut
    there). drawn_checkboxes: the checkboxes a digital PDF draws (pdf.checkboxes), used instead of finding them in the
    image."""
    import cv2
    import numpy as np

    ids = ids or Ids()
    mm = dpi / MM_PER_INCH
    gray = np.asarray(image.convert("L"))
    height, width = gray.shape
    block = max(15, int(3 * mm) | 1)
    binary = cv2.adaptiveThreshold(gray, 255, cv2.ADAPTIVE_THRESH_MEAN_C, cv2.THRESH_BINARY_INV, block, 12)

    # Ruled lines: long thin runs of ink. Short gaps (a broken scan line) are closed.
    run = max(10, int(4 * mm))
    horizontal = cv2.morphologyEx(binary, cv2.MORPH_OPEN, cv2.getStructuringElement(cv2.MORPH_RECT, (run, 1)))
    horizontal = cv2.morphologyEx(horizontal, cv2.MORPH_CLOSE, cv2.getStructuringElement(cv2.MORPH_RECT, (max(3, int(mm)), 1)))
    vertical = cv2.morphologyEx(binary, cv2.MORPH_OPEN, cv2.getStructuringElement(cv2.MORPH_RECT, (1, run)))
    vertical = cv2.morphologyEx(vertical, cv2.MORPH_CLOSE, cv2.getStructuringElement(cv2.MORPH_RECT, (1, max(3, int(mm)))))
    # Text strokes are not rules: drop the short horizontal runs inside a text line (a letter's bar is never much longer
    # than the text is high). A frame line passing behind the text is longer and stays.
    for line in lines:
        x0, y0, x1, y1 = (int(line["box"][0] * width), int(line["box"][1] * height), int(line["box"][2] * width), int(line["box"][3] * height))
        if DOTS.search(line.get("text") or ""):
            continue  # underscores in the text are blanks: kept
        inner = horizontal[y0 + 1:y1 - 1, x0:x1]
        if inner.size:
            count, labels, stats, _ = cv2.connectedComponentsWithStats(inner, connectivity=8)
            for index in range(1, count):
                if stats[index][2] < 1.5 * (y1 - y0):
                    inner[labels == index] = 0

    # A curved or worn frame leaves small gaps at its corners, which would join a cell to the page outside it: each
    # rule is lengthened along its own direction (never sideways, so the close lines of a chart stay apart).
    reach = max(3, int(2.5 * mm))
    walls = cv2.bitwise_or(cv2.dilate(horizontal, cv2.getStructuringElement(cv2.MORPH_RECT, (reach, 1))),
                           cv2.dilate(vertical, cv2.getStructuringElement(cv2.MORPH_RECT, (1, reach))))
    walls = cv2.dilate(walls, cv2.getStructuringElement(cv2.MORPH_RECT, (3, 3)))
    # Regions: what the rules close. The area outside every frame touches the page edge and is not a cell.
    count, regions, stats, _ = cv2.connectedComponentsWithStats(cv2.bitwise_not(walls), connectivity=4)
    small = 9 * mm  # a lattice square of a chart is smaller than this on both sides
    min_area = (2.2 * mm) ** 2
    outside = set(np.unique(np.concatenate([regions[0, :], regions[-1, :], regions[:, 0], regions[:, -1]])).tolist())
    region_box: dict[int, tuple[int, int, int, int]] = {}
    lattice: list[int] = []
    for index in range(1, count):
        x, y, w, h, area = (int(v) for v in stats[index])
        if index in outside or area < min_area:
            continue
        region_box[index] = (x, y, x + w, y + h)
        if w < small and h < small:
            lattice.append(index)

    # Grids: small regions that touch each other on many sides, in at least 3 rows and 3 columns.
    parent = {index: index for index in lattice}

    def find(index: int) -> int:
        while parent[index] != index:
            parent[index] = parent[parent[index]]
            index = parent[index]
        return index

    touch = 1.6 * mm
    ordered = sorted(lattice, key=lambda index: region_box[index][0])
    for position, a in enumerate(ordered):
        ax0, ay0, ax1, ay1 = region_box[a]
        for b in ordered[position + 1:]:
            bx0, by0, bx1, by1 = region_box[b]
            if bx0 > ax1 + touch:
                break
            side = (abs(bx0 - ax1) <= touch or abs(ax0 - bx1) <= touch) and min(ay1, by1) - max(ay0, by0) > 0.5 * min(ay1 - ay0, by1 - by0)
            above = (abs(by0 - ay1) <= touch or abs(ay0 - by1) <= touch) and min(ax1, bx1) - max(ax0, bx0) > 0.5 * min(ax1 - ax0, bx1 - bx0)
            if side or above:
                parent[find(a)] = find(b)
    groups: dict[int, list[int]] = {}
    for index in lattice:
        groups.setdefault(find(index), []).append(index)
    grid_of: dict[int, str] = {}
    grids: list[dict[str, Any]] = []
    for members in groups.values():
        rows = _bands([(region_box[m][1] + region_box[m][3]) / 2 for m in members], 0.8 * mm)
        cols = _bands([(region_box[m][0] + region_box[m][2]) / 2 for m in members], 0.8 * mm)
        if len(members) < 12 or len(rows) < 2 or len(cols) < 3 or len(rows) * len(cols) < 12:
            continue
        x0 = min(region_box[m][0] for m in members)
        y0 = min(region_box[m][1] for m in members)
        x1 = max(region_box[m][2] for m in members)
        y1 = max(region_box[m][3] for m in members)
        grid = {"id": ids("G"), "page": page, "box": _box(x0, y0, x1, y1, width, height), "rows": len(rows), "cols": len(cols), "lines": [],
                "row_bands": [[round(a / height, 5), round(b / height, 5)] for a, b in _row_extents(members, region_box, rows, 0.8 * mm)]}
        grids.append(grid)
        for m in members:
            grid_of[m] = grid["id"]
    # Grids that sit on top of each other with the same width are one chart (its rows of values, then its plot).
    grids = _merge_stacked(grids, mm / height, mm / width)

    cells: list[dict[str, Any]] = []
    cell_of: dict[int, str] = {}
    for index, (x0, y0, x1, y1) in sorted(region_box.items(), key=lambda item: (item[1][1], item[1][0])):
        if index in grid_of:
            continue
        cell = {"id": ids("C"), "page": page, "box": _box(x0, y0, x1, y1, width, height), "lines": [], "empty": 1.0}
        cells.append(cell)
        cell_of[index] = cell["id"]

    def region_at(fx: float, fy: float) -> int:
        x = min(width - 1, max(0, int(fx * width)))
        y = min(height - 1, max(0, int(fy * height)))
        found = int(regions[y, x])
        if found and not walls[y, x]:
            return found
        # On a rule pixel: the region just next to it.
        for dx, dy in ((0, -3), (0, 3), (-3, 0), (3, 0), (0, -6), (0, 6)):
            xx, yy = min(width - 1, max(0, x + dx)), min(height - 1, max(0, y + dy))
            if regions[yy, xx] and not walls[yy, xx]:
                return int(regions[yy, xx])
        return 0

    grid_by_id = {grid["id"]: grid for grid in grids}
    cell_by_id = {cell["id"]: cell for cell in cells}
    def pieces(line: dict[str, Any]) -> list[dict[str, Any]]:
        """A line whose words sit in different cells, cut at the cell borders (a PDF's text runs on across them)."""
        words = line.get("words") or []
        if len(words) < 2:
            return [line]
        groups: list[list[dict[str, Any]]] = []
        last = None
        for word in words:
            region = region_at((word["box"][0] + word["box"][2]) / 2, (word["box"][1] + word["box"][3]) / 2)
            if groups and region == last:
                groups[-1].append(word)
            else:
                groups.append([word])
            last = region
        if len(groups) == 1:
            return [line]
        return [{**line, "words": group, "text": _text_of(line, group),
                 "box": [min(w["box"][0] for w in group), min(w["box"][1] for w in group), max(w["box"][2] for w in group), max(w["box"][3] for w in group)],
                 "bold": all(w.get("bold") for w in group), "size": max(w.get("size") or 0 for w in group)} for group in groups]

    out_lines: list[dict[str, Any]] = []
    for line in (piece for whole in lines for piece in pieces(whole)):
        item = {key: line[key] for key in ("box", "text", "score", "bold", "size") if key in line}
        item["id"] = ids("L")
        item["page"] = page
        if line.get("words"):
            item["words"] = line["words"]
        cx, cy = (line["box"][0] + line["box"][2]) / 2, (line["box"][1] + line["box"][3]) / 2
        region = region_at(cx, cy)
        # A label in front of a grid (its row names) sits in a cell; text inside the lattice belongs to the grid.
        if region in grid_of:
            item["grid"] = grid_of[region]
            grid_by_id[_merged_id(grids, grid_of[region])]["lines"].append(item["id"])
        elif region in cell_of:
            item["cell"] = cell_of[region]
            cell_by_id[cell_of[region]]["lines"].append(item["id"])
        out_lines.append(item)

    # Room to write in each cell: its area less the text in it.
    for cell in cells:
        x0, y0, x1, y1 = cell["box"]
        area = max(1e-9, (x1 - x0) * (y1 - y0))
        used = sum(max(0.0, min(x1, l["box"][2]) - max(x0, l["box"][0])) * max(0.0, min(y1, l["box"][3]) - max(y0, l["box"][1]))
                   for l in out_lines if l.get("cell") == cell["id"])
        cell["empty"] = round(max(0.0, 1 - used / area), 3)

    blanks = _underlines(horizontal, vertical, regions, region_box, grid_of, cell_of, out_lines, width, height, mm, ids, page)
    blanks += _dotted(binary, out_lines, width, height, mm, ids, page, region_at, cell_of)
    if drawn_checkboxes is not None:
        checkboxes = [{"id": ids("K"), "page": page, "box": box["box"], "ticked": box["ticked"], "label": _beside(box["box"], out_lines, mm / width)}
                      for box in sorted(drawn_checkboxes, key=lambda b: (round(b["box"][1], 3), b["box"][0]))]
    else:
        checkboxes = _checkboxes(binary, grids, out_lines, width, height, mm, ids, page)
    # A checkbox's square closes a tiny region too: it is a checkbox, not a cell to write in.
    boxes = [box["box"] for box in checkboxes]
    cells = [cell for cell in cells if not any(_iou(cell["box"], box) > 0.4 for box in boxes)]
    rules = {"horizontal": int(cv2.connectedComponents(horizontal)[0] - 1), "vertical": int(cv2.connectedComponents(vertical)[0] - 1)}
    return {"page": page, "size": [width, height], "dpi": dpi, "lines": out_lines, "cells": cells,
            "grids": grids, "blanks": blanks, "checkboxes": checkboxes, "rules": rules}


def _iou(a: list[float], b: list[float]) -> float:
    w = max(0.0, min(a[2], b[2]) - max(a[0], b[0]))
    h = max(0.0, min(a[3], b[3]) - max(a[1], b[1]))
    shared = w * h
    return shared / max(1e-12, (a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - shared)


def _text_of(line: dict[str, Any], group: list[dict[str, Any]]) -> str:
    """The text of some of a line's words, spaced as in the line."""
    text = line["text"]
    first, last = group[0]["text"], group[-1]["text"]
    start = text.find(first)
    end = text.rfind(last)
    return text[start:end + len(last)].strip() if start >= 0 and end >= start else " ".join(word["text"] for word in group)


def _bands(values: list[float], tolerance: float) -> list[float]:
    """The distinct positions among values (closer than tolerance counts as the same)."""
    bands: list[float] = []
    for value in sorted(values):
        if not bands or value - bands[-1] > tolerance:
            bands.append(value)
        else:
            bands[-1] = (bands[-1] + value) / 2
    return bands


def _row_extents(members: list[int], region_box: dict[int, tuple[int, int, int, int]], centres: list[float], tolerance: float) -> list[tuple[int, int]]:
    out = []
    for centre in centres:
        tops = [region_box[m][1] for m in members if abs((region_box[m][1] + region_box[m][3]) / 2 - centre) <= tolerance * 1.5]
        bottoms = [region_box[m][3] for m in members if abs((region_box[m][1] + region_box[m][3]) / 2 - centre) <= tolerance * 1.5]
        if tops:
            out.append((min(tops), max(bottoms)))
    return out


def _merge_stacked(grids: list[dict[str, Any]], mm_y: float, mm_x: float) -> list[dict[str, Any]]:
    grids = sorted(grids, key=lambda grid: grid["box"][1])
    merged: list[dict[str, Any]] = []
    for grid in grids:
        last = merged[-1] if merged else None
        if last and grid["box"][1] - last["box"][3] <= 3 * mm_y and abs(grid["box"][0] - last["box"][0]) <= 4 * mm_x \
                and abs(grid["box"][2] - last["box"][2]) <= 4 * mm_x:
            last["box"] = [min(last["box"][0], grid["box"][0]), last["box"][1], max(last["box"][2], grid["box"][2]), grid["box"][3]]
            last["rows"] += grid["rows"]
            last["cols"] = max(last["cols"], grid["cols"])
            last["row_bands"] += grid["row_bands"]
            last.setdefault("parts", [last["id"]]).append(grid["id"])
            continue
        merged.append(grid)
    return merged


def _merged_id(grids: list[dict[str, Any]], grid_id: str) -> str:
    for grid in grids:
        if grid["id"] == grid_id or grid_id in grid.get("parts", []):
            return grid["id"]
    return grid_id


def _underlines(horizontal: Any, vertical: Any, regions: Any, region_box: dict[int, tuple[int, int, int, int]], grid_of: dict[int, str],
                cell_of: dict[int, str], lines: list[dict[str, Any]], width: int, height: int, mm: float, ids: Ids, page: int) -> list[dict[str, Any]]:
    """Free underlines: horizontal rules that close nothing (the same region above and below them)."""
    import cv2

    count, _, stats, _ = cv2.connectedComponentsWithStats(horizontal, connectivity=8)
    out: list[dict[str, Any]] = []
    for index in range(1, count):
        x, y, w, h, _ = (int(v) for v in stats[index])
        # A line drawn a little slanted (or a curved scan) is taller than its stroke: allowed while it stays long and thin.
        if w < 5 * mm or h > max(1.5 * mm, min(4 * mm, w / 12)):
            continue
        probe = max(3, int(0.8 * mm))
        xs = [x + w // 4, x + w // 2, x + 3 * w // 4]
        above = {int(regions[max(0, y - probe), px]) for px in xs}
        below = {int(regions[min(height - 1, y + h + probe), px]) for px in xs}
        if above != below or 0 in above:
            continue  # a cell's top or bottom edge
        region = next(iter(above))
        if region in grid_of:
            continue
        box = _box(x, y - int(1.2 * mm), x + w, y + h, width, height)
        if region not in cell_of and not _words_near(box, lines, mm / width, mm / height):
            continue  # a mark at the paper's edge, a fold: nothing asks for it
        out.append({"id": ids("B"), "page": page, "kind": "underline", "box": box, "cell": cell_of.get(region)})
    return out


def _words_near(box: list[float], lines: list[dict[str, Any]], mm_x: float, mm_y: float) -> bool:
    """Text on the same row within 40 mm before the blank, or just above it."""
    for line in lines:
        b = line["box"]
        same_row = min(box[3], b[3]) - max(box[1], b[1]) > 0 and -2 * mm_x <= box[0] - b[2] <= 40 * mm_x
        above = 0 <= box[1] - b[3] <= 8 * mm_y and min(box[2], b[2]) > max(box[0], b[0])
        if same_row or above:
            return True
    return False


def _dotted(binary: Any, lines: list[dict[str, Any]], width: int, height: int, mm: float, ids: Ids, page: int, region_at: Any,
            cell_of: dict[int, str]) -> list[dict[str, Any]]:
    """Dotted leaders (ชื่อ................): eight or more dots in a row, evenly spaced."""
    import cv2

    count, _, stats, centroids = cv2.connectedComponentsWithStats(binary, connectivity=8)
    dots = [(float(centroids[i][0]), float(centroids[i][1]), int(stats[i][2]), int(stats[i][3])) for i in range(1, count)
            if stats[i][2] <= 1.2 * mm and stats[i][3] <= 1.2 * mm and stats[i][4] >= 2]
    dots.sort(key=lambda dot: (round(dot[1] / (0.6 * mm)), dot[0]))
    rows: list[list[tuple[float, float, int, int]]] = []
    for dot in sorted(dots, key=lambda dot: dot[1]):
        for row in rows:
            if abs(row[-1][1] - dot[1]) <= 0.5 * mm:
                row.append(dot)
                break
        else:
            rows.append([dot])
    out: list[dict[str, Any]] = []
    for row in rows:
        row.sort()
        # A leader broken by a smudge or a lost dot is still one: runs closer than 5 mm are joined.
        runs: list[list[tuple[float, float, int, int]]] = []
        for dot in row:
            if runs and dot[0] - runs[-1][-1][0] <= 3 * mm:
                runs[-1].append(dot)
            elif runs and dot[0] - runs[-1][-1][0] <= 5 * mm and len(runs[-1]) >= 4:
                runs[-1].append(dot)
            else:
                runs.append([dot])
        row[:] = [dot for run in runs for dot in run]
        start = 0
        ends, total = set(), 0
        for run in runs:
            total += len(run)
            ends.add(total)
        for position in range(1, len(row) + 1):
            if position == len(row) or position in ends:
                run = row[start:position]
                if len(run) >= 8:
                    x0, x1 = run[0][0] - 0.5 * mm, run[-1][0] + 0.5 * mm
                    y = sum(dot[1] for dot in run) / len(run)
                    box = _box(x0, y - 3.5 * mm, x1, y + 0.6 * mm, width, height)
                    region = region_at((box[0] + box[2]) / 2, (box[1] + box[3]) / 2)
                    if region not in cell_of and not _words_near(box, lines, mm / width, mm / height):
                        start = position
                        continue
                    out.append({"id": ids("B"), "page": page, "kind": "dots", "box": box, "cell": cell_of.get(region)})
                start = position
    return out


def _checkboxes(binary: Any, grids: list[dict[str, Any]], lines: list[dict[str, Any]], width: int, height: int, mm: float, ids: Ids,
                page: int) -> list[dict[str, Any]]:
    """Small drawn squares (2.5-7 mm, four straight unbroken edges) outside grids, ticked when their inside has ink,
    with the text line just right of them (or left, for a box at the end of its label)."""
    import cv2

    found: list[dict[str, Any]] = []
    seen: list[tuple[int, int, int, int]] = []
    contours, _ = cv2.findContours(binary, cv2.RETR_LIST, cv2.CHAIN_APPROX_SIMPLE)
    for contour in contours:
        x, y, w, h = cv2.boundingRect(contour)
        if not (2 * mm <= w <= 7 * mm and 2 * mm <= h <= 7 * mm and 0.8 <= w / h <= 1.25):
            continue
        if len(cv2.approxPolyDP(contour, 0.08 * cv2.arcLength(contour, True), True)) != 4:
            continue
        if any(abs(x - sx) < w / 2 and abs(y - sy) < h / 2 for sx, sy, _, _ in seen):
            continue
        t = max(2, int(0.1 * min(w, h)))
        edges = (binary[y:y + t, x:x + w], binary[y + h - t:y + h, x:x + w], binary[y:y + h, x:x + t], binary[y:y + h, x + w - t:x + w])
        if min(float((edge.max(axis=0 if index < 2 else 1) > 0).mean()) for index, edge in enumerate(edges)) < 0.9:
            continue
        box = _box(x, y, x + w, y + h, width, height)
        slack_x, slack_y = 1.5 * mm / width, 1.5 * mm / height
        if any(grid["box"][0] - slack_x <= box[0] and box[2] <= grid["box"][2] + slack_x and grid["box"][1] - slack_y <= box[1]
               and box[3] <= grid["box"][3] + slack_y for grid in grids):
            continue  # a square of a chart, also at its edge
        seen.append((x, y, w, h))
        border = max(2, int(0.12 * w))
        inside = binary[y + border:y + h - border, x + border:x + w - border]
        label = _beside(box, lines, mm / width)
        found.append({"id": ids("K"), "page": page, "box": box, "ticked": bool(inside.size and inside.mean() / 255 > 0.12), "label": label})
    return sorted(found, key=lambda item: (round(item["box"][1], 2), item["box"][0]))


def _beside(box: list[float], lines: list[dict[str, Any]], mm_x: float) -> str | None:
    """The text of a checkbox: the line just right of it, or the line the OCR read together with the square (it starts
    at or before the box and goes on after it)."""
    best, best_gap = None, 1e9
    for line in lines:
        b = line["box"]
        shared = min(box[3], b[3]) - max(box[1], b[1])
        if shared < 0.4 * (box[3] - box[1]):
            continue
        if b[0] <= box[0] + mm_x and b[2] > box[2] + 2 * mm_x:
            gap = 0.0  # the square read as part of its line
        else:
            gap = b[0] - box[2] if b[0] >= box[2] - mm_x else box[0] - b[2]
        if -mm_x <= gap <= 4 * mm_x and gap < best_gap:
            best, best_gap = line["id"], gap
    return best
