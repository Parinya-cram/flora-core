"""A plan (understand.py, or the AI's: assemble.py) → a Form Studio definition laid out like the paper.

- Sections are the plan's (the page cut at its charts); a section without a name gets a plain one.
- Candidates of a section are put on rows by where they sit on the page; each takes the columns of the 24-column grid
  under it (col from its left edge, span from its width), so the form looks like the document and can then be moved
  freely in the designer.
- Names follow the variable-name standard (app/formdev/ids.py); a field whose label names case data is bound to it.
  "ไทย / English" labels are split into label and label_en.
- The result passes the server's own validator; a placement it refuses falls back to flowing in order.

provenance maps every field id to its page, box, the evidence it came from (ids in layout.py), how sure it is and who
made it (the tools or the AI): the screen draws it on the page.
"""
from __future__ import annotations

import re
from typing import Any

from ... import concepts
from .. import case_blocks, ids
from ..definition import FORMAT, PAPER_SIZES_MM, TIMELINE_PARTS, TIMELINE_PRINT_COLUMNS, TIMELINE_SERIES, validate_definition
from . import understand

CONCEPT_KINDS = {concept["key"]: concept["kind"] for concept in concepts.CONCEPTS}

COLUMNS = 24
STYLE_ID = "form.a4.medical"
CELL_TYPES = {"text", "textarea", "number", "decimal", "integer", "date", "time", "datetime", "select", "radio", "checkbox"}
TIMELINE_ROW = re.compile(r"^[a-z][a-z0-9_]{0,63}$")
DEFAULT_SECTIONS = [("ข้อมูลทั่วไป", "General"), ("รายละเอียด", "Details"), ("ส่วนที่ 3", "Part 3"), ("ส่วนที่ 4", "Part 4"), ("ส่วนที่ 5", "Part 5")]
# Field types that can hold each kind of case datum (app/concepts.py): a field is bound only when they fit.
BINDABLE = {"text": {"text", "textarea", "select", "radio"}, "number": {"number", "decimal", "integer"}, "date": {"date"},
            "time": {"time"}, "datetime": {"datetime"}, "list": {"text", "textarea"}}


def _labels(text: str) -> tuple[str, str | None]:
    """("น้ำหนัก / Weight") → ("น้ำหนัก", "Weight"); a label in one language stays as it is."""
    match = re.match(r"^(.*[฀-๿].*?)\s+/\s+([^฀-๿]*[A-Za-z][^฀-๿]*)$", text.strip())
    return (match.group(1).strip(), match.group(2).strip()) if match else (text.strip(), None)


def _option_values(options: list[dict[str, Any]]) -> list[dict[str, Any]]:
    out, taken = [], set()
    for index, option in enumerate(options):
        label, english = _labels(option.get("label") or f"Option {index + 1}")
        english = option.get("label_en") or english
        value = ids.suggest(label, english)["key"] if label else f"option_{index + 1}"
        while value in taken:
            value = f"{value}_{index + 1}"
        taken.add(value)
        out.append({"value": value, "label": label or f"{index + 1}", **({"label_en": english} if english else {})})
    return out


def _rows(items: list[dict[str, Any]]) -> list[list[dict[str, Any]]]:
    """Items whose labels are on the same line of the page share a row (the labels overlap vertically by half the
    smaller height); a tall item (a long text, a box) does not pull the rows beside it into its own."""
    def anchor(item: dict[str, Any]) -> list[float]:
        return item.get("anchor") or item["box"]
    rows: list[list[dict[str, Any]]] = []
    for item in sorted(items, key=lambda c: (c.get("page", 0), anchor(c)[1], anchor(c)[0])):
        box = anchor(item)
        if rows and rows[-1][0].get("page", 0) == item.get("page", 0):
            ref = anchor(rows[-1][0])
            shared = min(ref[3], box[3]) - max(ref[1], box[1])
            if shared > 0.5 * min(ref[3] - ref[1], box[3] - box[1]):
                rows[-1].append(item)
                continue
        rows.append([item])
    return [sorted(row, key=lambda c: c["box"][0]) for row in rows]


def _columns(items: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """The lists of a checklist printed in side-by-side columns (each column its own stack of category tables under a
    header row, list | Qty) become a group per column: the tables stack in their column as on the paper instead of
    lining up across columns. Other items stay as they are."""
    columns: dict[tuple[int, float], list[dict[str, Any]]] = {}
    for item in items:
        if item.get("column"):
            columns.setdefault((item.get("page", 0), item["column"]["x0"]), []).append(item)
    if len(columns) < 2 and not any(len(stack) > 1 for stack in columns.values()):
        return items
    grouped = {id(item) for stack in columns.values() for item in stack}
    out = [item for item in items if id(item) not in grouped]
    for (page, x0), stack in columns.items():
        stack.sort(key=lambda item: (item.get("anchor") or item["box"])[1])
        top = (stack[0].get("anchor") or stack[0]["box"])[1]
        box = [x0, top, stack[0]["column"]["x1"], max(item["box"][3] for item in stack)]
        out.append({"id": f"{stack[0]['id']}-column", "kind": "field", "type": "group", "label": stack[0]["column"]["header"] or "รายการ",
                    "page": page, "box": box, "anchor": [x0, top, box[2], top + 0.01], "children": stack,
                    "source": [i for item in stack for i in item.get("source") or []], "by": "tools", "unsure": [], "confidence": 0.85})
    return out


def _case_block(item: dict[str, Any]) -> dict[str, Any]:
    """A report component from a table on the paper: the block's columns the paper has (in its order), each as wide
    as on the paper when the counts match (else the block's usual widths), the paper's empty ruled rows as min_rows."""
    block = item["block"]
    spec = {column["key"]: column for column in case_blocks.CASE_BLOCKS[block]["columns"]}
    keys = [key for key in dict.fromkeys(item.get("block_columns") or []) if key in spec] or list(spec)
    paper = [column for column in item.get("columns") or [] if isinstance(column, dict)]
    measured = len(paper) == len(keys) and all(isinstance(column.get("width"), (int, float)) and column["width"] > 0 for column in paper)
    raw = [float(paper[index]["width"]) if measured else float(spec[key]["width"]) for index, key in enumerate(keys)]
    total = sum(raw) or 1.0
    widths = [max(case_blocks.LIMITS["column_width"][0], round(width * 100 / total)) for width in raw]
    widths[widths.index(max(widths))] += 100 - sum(widths)
    columns: list[dict[str, Any]] = []
    for index, key in enumerate(keys):
        column: dict[str, Any] = {"key": key, "width": widths[index]}
        heading = _labels(paper[index].get("label") or "")[0] if len(paper) == len(keys) else ""
        if heading and heading not in (spec[key]["th"], spec[key]["en"]):
            column["label"] = heading[:80]
        columns.append(column)
    out: dict[str, Any] = {"block": block, "block_columns": columns}
    rows = item.get("min_rows")
    if isinstance(rows, int) and rows > 0:
        out["min_rows"] = min(case_blocks.LIMITS["min_rows"][1], rows)
        out["max_rows"] = min(case_blocks.LIMITS["max_rows"][1], max(rows, 10))
    return out


def _field(item: dict[str, Any], section: str, taken: set[str]) -> dict[str, Any]:
    label, english = _labels(item.get("label") or "")
    english = item.get("label_en") or english
    kind = item.get("type") or "text"
    if item["kind"] == "heading":
        name = ids.suggest(label, english, None, "heading", section, taken)["key"]
        field: dict[str, Any] = {"id": f"{name}_heading" if not name.endswith("heading") else name, "type": "heading", "label": label or "-",
                                 "level": item.get("level", 2)}
    elif item["kind"] == "paragraph":
        name = ids.suggest(label[:60], english, None, "paragraph", section, taken)["key"]
        field = {"id": f"{name}_text"[:40], "type": "paragraph", "label": (label or "Text")[:60], "content": item.get("label") or "-"}
    else:
        if kind == "case_block" and item.get("block") not in case_blocks.CASE_BLOCKS:
            kind = "repeat"
        suggestion = ids.suggest(label, english, None, kind, section, taken)
        field = {"id": suggestion["key"], "type": kind, "label": label or "Untitled"}
        concept = CONCEPT_KINDS.get(suggestion["concept"] or "")
        if concept and kind in BINDABLE.get(concept, set()) and not (kind in ("select", "radio") and item.get("options")):
            field["bind"] = suggestion["concept"]
        if item.get("unit") and kind in ("number", "decimal", "integer", "text"):
            field["unit"] = item["unit"]
        if kind == "decimal":
            field["decimals"] = 1
        if kind in ("radio", "multiselect", "select"):
            field["options"] = _option_values(item.get("options") or [])
            if not field["options"]:
                field["type"] = "text"
        if kind == "repeat":
            # Column ids are unique in the whole form, the table's own id included.
            children, inner = [], set(taken) | {field["id"]}
            for column in item.get("columns") or [{"label": "Item"}]:
                column = column if isinstance(column, dict) else {"label": str(column)}
                child_label, child_en = _labels(column.get("label") or "Item")
                child_en = column.get("label_en") or child_en
                child_type = column.get("type") if column.get("type") in CELL_TYPES else "text"
                child = ids.suggest(child_label, child_en, None, child_type, None, inner)
                inner.add(child["key"])
                children.append({"id": child["key"], "type": child_type, "label": child_label or "Item", **({"label_en": child_en} if child_en else {}),
                                 **({"unit": column["unit"]} if column.get("unit") and child_type in ("number", "decimal", "integer", "text") else {})})
            # Columns as wide as on the paper (a 24-column grid inside the table).
            widths = [column.get("width") if isinstance(column, dict) else None for column in item.get("columns") or []]
            if children and all(isinstance(width, (int, float)) and width > 0 for width in widths) and len(widths) == len(children):
                spans = [max(2, round(width * COLUMNS)) for width in widths]
                while sum(spans) > COLUMNS and max(spans) > 2:
                    spans[spans.index(max(spans))] -= 1
                if sum(spans) <= COLUMNS:
                    spans[-1] += COLUMNS - sum(spans)
                    for child, span in zip(children, spans):
                        child["layout"] = {"span": span}
                    field["columns"] = COLUMNS
            field.update(fields=children, view="table", min_items=0)
            taken.update(child["id"] for child in children)
        if kind == "case_block":
            field.update(_case_block(item))
        if kind == "group":
            # A column of the paper: its tables one under the other, each the column's whole width.
            field["fields"] = []
            for row, child in enumerate(item.get("children") or [], start=1):
                inner = _field(child, section, taken)
                inner["layout"] = {"row": row, "col": 1, "span": COLUMNS}
                field["fields"].append(inner)
            field["columns"] = COLUMNS
        if kind == "matrix":
            def items(entries: list[dict[str, Any]], prefix: str) -> list[dict[str, Any]]:
                out, seen = [], set()
                for index, entry in enumerate(entries[:60], start=1):
                    item_label, item_en = _labels(entry.get("label") or f"{prefix} {index}")
                    english = entry.get("label_en") or item_en
                    key = ids.snake(english) if english else (ids.thai_name(item_label)[0] if re.search("[฀-๿]", item_label) else ids.snake(item_label))
                    key = key if re.match(r"^[a-z][a-z0-9_]*$", key or "") else f"{prefix}_{index}"
                    while key in seen:
                        key = f"{key}_{index}"
                    seen.add(key)
                    out.append({"id": key[:40].rstrip("_"), "label": item_label[:200]})  # matrix rows and columns have no label_en
                return out
            field["rows"] = items(item.get("rows") or [], "row")
            field["cols"] = items(item.get("columns") or [{"label": "ค่า"}], "col")
            field["cell"] = {"type": item.get("cell") if item.get("cell") in ("integer", "number", "text") else "text"}
            if isinstance(item.get("label_width"), int):
                field["label_width"] = item["label_width"]
            if not field["rows"]:
                field["type"] = "textarea"
                field.pop("rows")
                field.pop("cols")
                field.pop("cell")
        if kind == "timeline":
            rows, seen = [], set()
            for row in item.get("rows") or []:
                row_id = row.get("id") or understand.row_id(row.get("label") or "")
                row_id = row_id if TIMELINE_ROW.match(row_id) else f"row_{len(rows) + 1}"
                while row_id in seen:
                    row_id = f"{row_id}_{len(rows) + 1}"
                seen.add(row_id)
                rows.append({"id": row_id, "label": (row.get("label") or row_id)[:60], **({"unit": row["unit"][:60]} if row.get("unit") else {})})
            config: dict[str, Any] = {"parts": [part for part in item.get("parts") or ["table"] if part in TIMELINE_PARTS] or ["table"],
                                      "source": "manual"}
            if rows:
                config["rows"] = rows
            chart = [series for series in item.get("chart") or [] if series in TIMELINE_SERIES]
            if chart:
                config["chart"] = chart
            elif "chart" in config["parts"]:
                config["parts"] = [part for part in config["parts"] if part != "chart"] or ["table"]
            if isinstance(item.get("time_columns"), int):
                # As many time columns on a printed page as the paper's chart has.
                config["print_columns"] = max(TIMELINE_PRINT_COLUMNS[0], min(TIMELINE_PRINT_COLUMNS[1], item["time_columns"]))
            field["timeline"] = config
    if english:
        field["label_en"] = english
    while field["id"] in taken:
        field["id"] = f"{field['id']}_2"[:40]
    taken.add(field["id"])
    return field


def paper_of(pages: list[dict[str, Any]] | None, items: list[dict[str, Any]]) -> dict[str, Any]:
    """The paper of the document: its size (A4, A5, Letter; A4 when none fits), its orientation, and its margins (where
    the printed content of the first page starts and ends)."""
    if not pages:
        return {"size": "A4"}
    width_mm, height_mm = pages[0]["width_pt"] / 72 * 25.4, pages[0]["height_pt"] / 72 * 25.4
    landscape = width_mm > height_mm
    short, long = sorted((width_mm, height_mm))
    size = next((name for name, (w, h) in PAPER_SIZES_MM.items() if abs(w - short) <= 8 and abs(h - long) <= 8), "A4")
    paper: dict[str, Any] = {"size": size, **({"orientation": "landscape"} if landscape else {})}
    if pages[0].get("text_pt") and pages[0]["text_pt"] < 9:
        # Small print on the paper (a dense checklist): printed at the largest size that keeps the document's pages.
        paper["density"] = "fit_page"
    boxes = [item["box"] for item in items if item.get("page", 0) == 0 and item.get("box")]
    if boxes:
        clamp = lambda value: round(max(5.0, min(30.0, value)))
        paper["margin_mm"] = {"top": clamp(min(b[1] for b in boxes) * height_mm), "bottom": clamp((1 - max(b[3] for b in boxes)) * height_mm),
                              "left": clamp(min(b[0] for b in boxes) * width_mm), "right": clamp((1 - max(b[2] for b in boxes)) * width_mm)}
    return paper


def _row_spans(placed: list[tuple[dict[str, Any], dict[str, Any]]]) -> None:
    """A box taller than its row (DIAGNOSIS, an empty cell to write in) covers the rows beside it, as on the paper, as long
    as nothing else sits in its columns there."""
    tops: dict[int, float] = {}
    for field, item in placed:
        row = field["layout"]["row"]
        anchor = item.get("anchor") or item["box"]
        tops[row] = min(tops.get(row, 1.0), anchor[1])
    for field, item in placed:
        layout = field["layout"]
        if layout["span"] == COLUMNS or field["type"] in ("heading", "paragraph"):
            continue
        cols = set(range(layout["col"], layout["col"] + layout["span"]))
        bottom = item["box"][3]
        rows = 1
        for row in sorted(r for r in tops if r > layout["row"]):
            if row != layout["row"] + rows or tops[row] >= bottom - 0.004:
                break
            if any(other is not field and other["layout"]["row"] == row
                   and cols & set(range(other["layout"]["col"], other["layout"]["col"] + other["layout"]["span"])) for other, _ in placed):
                break
            rows += 1
        if rows > 1:
            layout["row_span"] = rows


def build(plan: dict[str, Any], title: str | None = None, form_id: str | None = None, pages: list[dict[str, Any]] | None = None) -> dict[str, Any]:
    """{definition, provenance, issues}: the draft form of a plan (understand.py, or the AI's: assemble.py) and where
    each field came from, on the document's own paper. plan = {title?, sections: [{title?, title_en?, ruled?, items}]};
    pages = [{width_pt, height_pt}] of the document."""
    title = (title or plan.get("title") or "Form from document").strip()[:200]
    items = [item for section in plan.get("sections") or [] for item in section.get("items") or []]
    taken: set[str] = set()
    provenance: dict[str, Any] = {}
    out_sections = []
    numbers = {item.get("page", 0) for item in items}
    # The printed area of each page (its margins left out) spans the whole grid.
    left = {page: min((c["box"][0] for c in items if c.get("page", 0) == page), default=0.0) for page in numbers}
    right = {page: max((c["box"][2] for c in items if c.get("page", 0) == page), default=1.0) for page in numbers}

    def grid_x(item: dict[str, Any], x: float) -> float:
        page = item.get("page", 0)
        return (x - left[page]) / max(0.2, right[page] - left[page])

    used_sections: set[str] = set()
    for number, section in enumerate(plan.get("sections") or [], start=1):
        name, english = _labels(section.get("title") or "")
        english = section.get("title_en") or english
        if not name:
            name, english = DEFAULT_SECTIONS[min(number, len(DEFAULT_SECTIONS)) - 1] if not section.get("grid") else ("บันทึกตามเวลา", "Record over time")
        section_id = ids.suggest(name, english, None, "section")["key"] or f"section_{number}"
        while section_id in used_sections:
            section_id = f"{section_id}_{number}"
        used_sections.add(section_id)
        fields = []
        placed = _columns([item for item in section.get("items") or [] if item.get("kind") in ("field", "heading", "paragraph") and not item.get("title")])
        # Rows of the grid follow the rows of the paper; an item that does not fit after the ones before it on its row
        # (or that needs the whole width: a table, a record over time, a heading) starts a row of its own.
        state = {"row": 1, "cursor": 1}
        put: list[tuple[dict[str, Any], dict[str, Any]]] = []

        def new_row() -> None:
            if state["cursor"] > 1:
                state["row"] += 1
                state["cursor"] = 1
        for paper_row in _rows(placed):
            new_row()
            for position, item in enumerate(paper_row):
                field = _field(item, english or section_id, taken)
                # A long text alone on its row takes the whole width only when it is that wide on the paper.
                full = item.get("type") in ("repeat", "timeline", "case_block") or item["kind"] in ("heading", "paragraph") \
                    or (item.get("type") == "textarea" and len(paper_row) == 1 and grid_x(item, item["box"][2]) - grid_x(item, item["box"][0]) > 0.6)
                if full:
                    new_row()
                    col, span = 1, COLUMNS
                else:
                    if state["cursor"] > COLUMNS - 1:
                        new_row()
                    want = int(grid_x(item, item["box"][0]) * COLUMNS + 0.25) + 1
                    col = max(state["cursor"], min(COLUMNS - 1, want))
                    last = position == len(paper_row) - 1
                    end = COLUMNS if last and grid_x(item, item["box"][2]) > 0.9 else round(grid_x(item, item["box"][2]) * COLUMNS)
                    span = max(2, min(COLUMNS - col + 1, end - col + 1))
                field["layout"] = {"row": state["row"], "col": col, "span": span}
                state["cursor"] = COLUMNS + 1 if full else col + span
                fields.append(field)
                put.append((field, item))
                provenance[field["id"]] = {"item": item.get("id"), "page": item.get("page", 0), "box": item["box"], "source": item.get("source") or [],
                                           "confidence": item.get("confidence"), "unsure": item.get("unsure") or [], "by": item.get("by", "tools"),
                                           **({"fixed_from": item["fixed_from"]} if item.get("fixed_from") else {})}
                for child, source_item in zip(field.get("fields") or [], item.get("children") or []):
                    provenance[child["id"]] = {"item": source_item.get("id"), "page": source_item.get("page", 0), "box": source_item["box"], "source": source_item.get("source") or [],
                                               "confidence": source_item.get("confidence"), "unsure": source_item.get("unsure") or [], "by": source_item.get("by", "tools"),
                                               **({"fixed_from": source_item["fixed_from"]} if source_item.get("fixed_from") else {})}
        _row_spans(put)
        if fields:
            # A section printed in ruled cells on the paper prints as bordered cells (print_style boxed) here too.
            out_sections.append({"id": section_id, "title": name, **({"title_en": english} if english else {}),
                                 **({"print_style": "boxed"} if section.get("ruled") else {}), "fields": fields})
    if not out_sections:
        out_sections = [{"id": "details", "title": "ข้อมูล", "title_en": "Details", "fields": []}]
    definition = {"format": FORMAT, "form_id": form_id or "form_from_document", "schema_version": 1, "title": title,
                  "style_id": STYLE_ID, "layout": {"type": "grid", "columns": COLUMNS}, "paper": paper_of(pages, items), "sections": out_sections}
    issues = validate_definition(definition)
    if any(issue.code in ("layout_overlap", "layout_out_of_bounds", "invalid_span") for issue in issues):
        for section in definition["sections"]:
            for field in section["fields"]:
                field.get("layout", {}).pop("row_span", None)  # first without the tall boxes
        issues = validate_definition(definition)
    if any(issue.code in ("layout_overlap", "layout_out_of_bounds", "invalid_span") for issue in issues):
        for section in definition["sections"]:
            for field in section["fields"]:
                field.pop("layout", None)  # flow in order rather than refuse the draft
        issues = validate_definition(definition)
    return {"definition": definition, "provenance": provenance, "issues": [{"path": issue.path, "code": issue.code, "message": issue.message} for issue in issues]}


def _walk(fields: list[dict[str, Any]]):
    for field in fields:
        yield field
        yield from _walk(field.get("fields") or [])


def keep_paper(definition: dict[str, Any], measured: dict[str, Any]) -> dict[str, Any]:
    """The AI's form with the paper's geometry put back (the AI builder starting from a measured draft): the paper, the
    sections' bordered printing, and the place and size of every field the AI kept (by id), table columns included.
    Where the result no longer fits the grid, rows and columns are let go and the widths kept."""
    out = {**definition, "paper": measured.get("paper") or definition.get("paper") or {"size": "A4"}}
    out.setdefault("layout", measured.get("layout"))
    styles = {section["id"]: section.get("print_style") for section in measured.get("sections") or []}
    places = {field["id"]: field for section in measured.get("sections") or [] for field in _walk(section.get("fields") or [])}
    for section in out.get("sections") or []:
        if styles.get(section.get("id")) and "print_style" not in section:
            section["print_style"] = styles[section["id"]]
        for field in _walk(section.get("fields") or []):
            source = places.get(field.get("id"))
            if source and source.get("type") == field.get("type") and source.get("layout"):
                field["layout"] = dict(source["layout"])
                if field.get("type") == "repeat" and source.get("columns"):
                    field["columns"] = source["columns"]
            if field.get("type") == "timeline" and source and isinstance(field.get("timeline"), dict) and source.get("timeline", {}).get("print_columns"):
                field["timeline"].setdefault("print_columns", source["timeline"]["print_columns"])
    codes = ("layout_overlap", "layout_out_of_bounds", "invalid_span", "invalid_columns")
    if any(issue.code in codes for issue in validate_definition(out)):
        for section in out.get("sections") or []:
            for field in _walk(section.get("fields") or []):
                for key in ("row", "col", "row_span"):
                    (field.get("layout") or {}).pop(key, None)
    return out
