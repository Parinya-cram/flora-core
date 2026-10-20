"""The form a page asks for, from its layout evidence (layout.py), without AI: a plan of sections and items, every item
pointing at the evidence it came from (formdev/docs/FORM-STUDIO-V2.md §5).

In order, each rule taking the evidence it uses so that nothing is used twice:

1. the title: the largest text above the form;
2. grids: a lattice with row names in the cells before it is a record over time (timeline): its rows from those names,
   a chart when a column of numbers (an axis) stands next to it, the series from its legend (BP, pulse), events from
   START / END marks; a lattice without them is a table (repeat);
3. ruled tables: a row of column names (in one cell or a cell each) followed by empty ruled rows is a table (repeat),
   named by the line just above it, its columns as wide as on the paper; one name over empty rows is a long text; a
   table whose first column prints the rows' names over empty cells is a matrix (the paper's grid kept), its columns
   named by the header row above it;
4. blanks: a label on the same baseline before a free underline, dotted leader or underscores, with the unit written
   after it (kg, cm, yr…); a blank under a field's blank continues it (a long text);
5. checkboxes: a box with its text is an option; boxes on one row form a choice, labelled by the text before them;
6. option lists printed to be circled: "TUBE : RAE , DLT , MLT", or a cell of short words with nowhere to write;
7. a label followed by an empty drawn box (the box is the input); a label in a cell with room after it (a text field)
   or under it (a long text), or an empty cell after its own; names of roles at the bottom of the page (surgeon,
   nurse, ผู้บันทึก) with room are signatures;
8. what is left: a symbol or a form number is ignored with the reason; other text is left "missed" for the AI and the
   author to see (it is never silently dropped).

Each item has a confidence and the reasons it is unsure; assemble.py gives the plan and all the evidence to the AI.
"""
from __future__ import annotations

import re
import statistics
from typing import Any

MM_PER_INCH = 25.4
SURE = 0.85

UNIT_WORDS = {
    "yr": "yr", "yrs": "yr", "y": "yr", "ปี": "ปี", "kg": "kg", "กก": "kg", "กก.": "kg", "cm": "cm", "ซม": "cm", "ซม.": "cm",
    "ml": "mL", "ml.": "mL", "มล": "mL", "มล.": "mL", "cc": "mL", "l": "L", "mmhg": "mmHg", "มม.ปรอท": "mmHg", "%": "%",
    "°c": "°C", "c": "°C", "องศา": "°C", "/min": "/min", "ครั้ง/นาที": "/min", "bpm": "/min", "mg": "mg", "mg/dl": "mg/dL",
    "g/dl": "g/dL", "mm": "mm", "min": "min", "นาที": "min", "hr": "h", "ชม": "h", "ชม.": "h", "ชั่วโมง": "h", "วัน": "d",
    "เดือน": "mo", "units": "units", "u": "units", "mcg": "mcg", "meq": "mEq",
}
UNITS_IN_LABEL = [
    (re.compile(r"\(?\s*(กก\.?|kg)\s*\)?\s*$", re.I), "kg"), (re.compile(r"\(?\s*(ซม\.?|cm)\s*\)?\s*$", re.I), "cm"),
    (re.compile(r"\(?\s*(มม\.?\s*ปรอท|mm\s*hg)\s*\)?\s*$", re.I), "mmHg"), (re.compile(r"\(?\s*(ครั้ง\s*/\s*นาที|/\s*min|bpm)\s*\)?\s*$", re.I), "/min"),
    (re.compile(r"\(?\s*(°\s*c|องศา(เซลเซียส)?)\s*\)?\s*$", re.I), "°C"), (re.compile(r"\(?\s*(มล\.?|ml)\s*\)?\s*$", re.I), "mL"),
    (re.compile(r"\(\s*(%)\s*\)\s*$"), "%"), (re.compile(r"\(\s*(ปี|yr|years?)\s*\)\s*$", re.I), "yr"),
]
NUMBER_WORDS = re.compile(r"น้ำหนัก|ส่วนสูง|อายุ|ชีพจร|อุณหภูมิ|คะแนน|จำนวน|ปริมาณ|อัตรา|weight|height|\bage\b|pulse|temp|score|count|amount|"
                          r"\brate\b|spo2|\bhb\b|\bhct\b|\bwbc\b|\bplt\b|\bwt\b|\bht\b|\bbw\b", re.I)
DECIMAL_WORDS = re.compile(r"น้ำหนัก|อุณหภูมิ|weight|temp|\bwt\b|\bhb\b|\bbw\b", re.I)
DATETIME = re.compile(r"วันที่\s*(และ)?\s*เวลา|date\s*(and|&)?\s*time", re.I)
DATE = re.compile(r"วันที่|วัน\s*/\s*เดือน\s*/\s*ปี|วันเกิด|\bdate\b|\bdob\b", re.I)
TIME = re.compile(r"^เวลา|\btime\b", re.I)
SIGNATURE = re.compile(r"ลงชื่อ|ลายมือชื่อ|ลายเซ็น|signature|signed|\bsign\b", re.I)
ROLE = re.compile(r"แพทย์|พยาบาล|ผู้ประเมิน|ผู้บันทึก|ผู้ตรวจ|ผู้รับ|ผู้ส่ง|ผู้ป่วย|ญาติ|พยาน|surgeon|anesthesiologist|anaesthetist|nurse|"
                  r"physician|doctor|witness|recorder|assessor", re.I)
YES_NO = re.compile(r"^(มี|ไม่มี|ใช่|ไม่ใช่|yes|no|ปกติ|ผิดปกติ|normal|abnormal|ได้|ไม่ได้)$", re.I)
NUMERIC = re.compile(r"^\d{1,4}$")
SYMBOL = re.compile(r"^[\W_]{1,3}$|^[a-zA-Z]$")
FORM_CODE = re.compile(r"\d{3,}")
NO_NAME = "(ไม่มีป้าย)"
FILL = re.compile(r"[._…‥·]{2,}|_+")
BOX_GLYPH = re.compile(r"^\s*[☐☑☒□■▢◻◼口0Oo\[\]]\s*(?=\S)")  # a checkbox's square read as a character
SEPARATORS = re.compile(r"\s*(?:,|/|\||\s-\s)\s*")
SERIES = [(re.compile(r"\bn?ibp\b|\bbp\b|ความดัน|blood\s*pressure", re.I), "nibp"), (re.compile(r"\bpulse\b|\bpr\b|ชีพจร", re.I), "pr"),
          (re.compile(r"\bhr\b|heart\s*rate", re.I), "hr"), (re.compile(r"spo\s*2|ออกซิเจน", re.I), "spo2"),
          (re.compile(r"\bart\b|arterial", re.I), "art"), (re.compile(r"\bcvp\b", re.I), "cvp"),
          (re.compile(r"\btemp|\bbt\b|อุณหภูมิ", re.I), "temperature"), (re.compile(r"et\s*co\s*2", re.I), "et_co2"), (re.compile(r"\bbis\b", re.I), "bis")]
EVENTS = re.compile(r"\bstart\b|\bend\b|เริ่ม|สิ้นสุด|induction|incision|intubat", re.I)
ROW_IDS = [(re.compile(r"spo\s*2", re.I), "spo2"), (re.compile(r"et\s*co\s*2", re.I), "et_co2"), (re.compile(r"^\s*bt\b|temp", re.I), "temperature"),
           (re.compile(r"\bhr\b", re.I), "hr"), (re.compile(r"\bcvp\b", re.I), "cvp")]


def clean(text: str) -> str:
    """A label as printed, without the dots, underscores and colons that only show where to write."""
    text = FILL.sub(" ", text or "")
    return re.sub(r"\s+", " ", text).strip(" :.-–=")


def split_unit(label: str) -> tuple[str, str | None]:
    """"น้ำหนัก (กก.)" → ("น้ำหนัก", "kg")."""
    for pattern, unit in UNITS_IN_LABEL:
        match = pattern.search(label)
        if match:
            return label[:match.start()].strip(" :"), unit
    return label.strip(" :"), None


def unit_of(text: str) -> str | None:
    word = clean(text).lower().replace(" ", "")
    return UNIT_WORDS.get(word) or UNIT_WORDS.get(word.rstrip("."))


def guess_type(label: str, unit: str | None, tall: bool) -> tuple[str, float]:
    """(field type, certainty) from the label's words, its unit and the room to write."""
    if SIGNATURE.search(label):
        return "signature", 0.95
    if DATETIME.search(label):
        return "datetime", 0.9
    if DATE.search(label):
        return "date", 0.9
    if TIME.search(label) and not NUMBER_WORDS.search(label):
        return "time", 0.85
    if re.search(r"ความดัน|blood pressure|\bbp\b", label, re.I):
        return "text", 0.85  # 120/80
    if unit or NUMBER_WORDS.search(label):
        return ("decimal" if DECIMAL_WORDS.search(label) or unit in ("kg", "°C") else "number"), (0.9 if unit else 0.75)
    if tall:
        return "textarea", 0.85
    return "text", 0.7


def _union(boxes: list[list[float]]) -> list[float]:
    return [min(b[0] for b in boxes), min(b[1] for b in boxes), max(b[2] for b in boxes), max(b[3] for b in boxes)]


def _overlap_y(a: list[float], b: list[float]) -> float:
    shared = min(a[3], b[3]) - max(a[1], b[1])
    return max(0.0, shared) / max(1e-6, min(a[3] - a[1], b[3] - b[1]))


def _overlap_x(a: list[float], b: list[float]) -> float:
    shared = min(a[2], b[2]) - max(a[0], b[0])
    return max(0.0, shared) / max(1e-6, min(a[2] - a[0], b[2] - b[0]))


class _Page:
    def __init__(self, evidence: dict[str, Any]):
        self.ev = evidence
        width, height = evidence["size"]
        dots = evidence["dpi"] / MM_PER_INCH
        self.mm_x, self.mm_y = dots / width, dots / height
        self.lines = {line["id"]: line for line in evidence["lines"]}
        self.cells = {cell["id"]: cell for cell in evidence["cells"]}
        self.used: set[str] = set()
        self.items: list[dict[str, Any]] = []
        self.ignored: list[dict[str, Any]] = []
        heights = [line["box"][3] - line["box"][1] for line in evidence["lines"]] or [0.012]
        self.text_h = statistics.median(heights)
        self.count = 0

    def item(self, kind: str, label: str, source: list[str], boxes: list[list[float]], **extra: Any) -> dict[str, Any]:
        self.count += 1
        anchor = next((self.lines[i]["box"] for i in source if i in self.lines), None)
        item = {"id": f"I{self.ev['page'] + 1}.{self.count}", "kind": kind, "label": label, "source": source, "page": self.ev["page"],
                "box": _union(boxes), "anchor": anchor or _union(boxes), "by": "tools", "unsure": [], "confidence": SURE, **extra}
        item = {key: value for key, value in item.items() if value is not None}
        self.items.append(item)
        self.used.update(source)
        return item

    def free_lines(self, cell: str | None = None) -> list[dict[str, Any]]:
        return [line for line in self.ev["lines"] if line["id"] not in self.used and (cell is None or line.get("cell") == cell)]


def page_plan(evidence: dict[str, Any]) -> dict[str, Any]:
    """{items, ignored, missed, sections} for one page."""
    page = _Page(evidence)
    _title(page)
    for grid in evidence["grids"]:
        _grid(page, grid)
    _checklists(page)
    _filled_labels(page)
    _ruled_tables(page)
    _blanks(page)
    _checkboxes(page)
    _option_lists(page)
    _signers(page)
    _label_then_box(page)
    _labels_with_room(page)
    _leftovers(page)
    return {"items": page.items, "ignored": page.ignored, "missed": [line["id"] for line in page.free_lines()],
            "sections": _sections(page)}


# 1. title ------------------------------------------------------------------------------------------------
def _title(page: _Page) -> None:
    """The title: the tallest text at the top of the page outside the form's cells when it is clearly larger than the
    rest, else the first line there when it is long and has nowhere to write beside it."""
    # A PDF's own text knows its font sizes: the largest at the top is the title, also inside a cell.
    sized = [line for line in page.ev["lines"] if line.get("size")]
    if sized:
        usual = statistics.median(line["size"] for line in sized)
        top = [line for line in sized if line["box"][1] < 0.25 and line["size"] >= 1.2 * usual]
        if top:
            title = max(top, key=lambda line: (line["size"], -line["box"][1]))
            page.item("heading", clean(title["text"]), [title["id"]], [title["box"]], level=1, title=True)
            return
    outside = [line for line in page.ev["lines"] if not line.get("cell") and not line.get("grid") and line["box"][1] < 0.2]
    if not outside:
        return
    top = min(line["box"][1] for line in outside)
    band = [line for line in outside if line["box"][1] <= top + 2.5 * page.text_h]
    tallest = max(band, key=lambda line: line["box"][3] - line["box"][1])
    if tallest["box"][3] - tallest["box"][1] < 1.15 * page.text_h:
        first = min(band, key=lambda line: (line["box"][1], line["box"][0]))
        beside = any(_overlap_y(blank["box"], first["box"]) > 0.2 or 0 <= blank["box"][1] - first["box"][3] <= 2 * page.text_h
                     for blank in page.ev["blanks"]) or any(_overlap_y(cell["box"], first["box"]) > 0.5 for cell in page.ev["cells"])
        if len(clean(first["text"])) < 12 or beside:
            return
        tallest = first
    page.item("heading", clean(tallest["text"]), [tallest["id"]], [tallest["box"]], level=1, title=True)


# 2. grids ------------------------------------------------------------------------------------------------
def _grid(page: _Page, grid: dict[str, Any]) -> None:
    gx0, gy0, gx1, gy1 = grid["box"]
    near = 3 * page.mm_y
    before = [cell for cell in page.ev["cells"] if cell["box"][2] <= gx0 + 2 * page.mm_x and cell["box"][0] >= gx0 - 0.35
              and cell["box"][1] >= gy0 - near and cell["box"][3] <= gy1 + near]
    # The chart's own header row (TIME…): small cells right on top of it or of its row names, not the blocks above.
    above = [cell for cell in page.ev["cells"] if gy0 - 4 * page.mm_y <= cell["box"][3] <= gy0 + 2 * page.mm_y
             and cell["box"][3] - cell["box"][1] <= 12 * page.mm_y and cell["box"][0] >= gx0 - 0.35 and cell["box"][2] <= gx1 + 2 * page.mm_x
             and cell not in before]
    source = [grid["id"]]
    # The axis: a cell of numbers only. The legend: the cell beside the axis that names the plotted values.
    axis_cell = None
    for cell in before:
        texts = [page.lines[i]["text"].strip() for i in cell["lines"]]
        if len(texts) >= 3 and sum(bool(NUMERIC.match(text)) for text in texts) >= 0.8 * len(texts):
            axis_cell = cell
    chart: list[str] = []
    events = False
    plot = None
    if axis_cell:
        plot = (axis_cell["box"][1], axis_cell["box"][3])
        source += axis_cell["lines"]
        page.ignored += [{"source": i, "why": "chart axis"} for i in axis_cell["lines"]]
        for cell in before:
            if cell is axis_cell or _overlap_y(cell["box"], axis_cell["box"]) < 0.6:
                continue
            legend = " ".join(page.lines[i]["text"] for i in cell["lines"])
            for pattern, series in SERIES:
                if pattern.search(legend) and series not in chart:
                    chart.append(series)
            events = events or bool(EVENTS.search(legend))
            source += cell["lines"]
            source.append(cell["id"])
    time_label = None
    for cell in above + before:
        for i in cell["lines"]:
            if TIME.search(page.lines[i]["text"]):
                time_label = i
    if time_label:
        source.append(time_label)
    # Rows: the cells before the grid, outside the plot, one row per band; their names joined left to right.
    row_cells = [cell for cell in before if cell is not axis_cell and (plot is None or cell["box"][3] <= plot[0] + 2 * page.mm_y)
                 and not (time_label and time_label in cell["lines"])]
    usual = statistics.median([cell["box"][3] - cell["box"][1] for cell in row_cells]) if row_cells else 0

    def spans(cell: dict[str, Any]) -> int:
        return sum(1 for other in row_cells if other is not cell and other["box"][0] >= cell["box"][2] - page.mm_x
                   and cell["box"][1] - page.mm_y <= (other["box"][1] + other["box"][3]) / 2 <= cell["box"][3] + page.mm_y)
    # A cell much taller than the others, beside two or more rows, names them as a group (AGENTS over N2O, O2, …).
    groups = [cell for cell in row_cells if cell["box"][3] - cell["box"][1] > 1.8 * usual and cell["lines"] and spans(cell) >= 2]
    bands: list[list[dict[str, Any]]] = []
    for cell in sorted(row_cells, key=lambda c: ((c["box"][1] + c["box"][3]) / 2, c["box"][0])):
        centre = (cell["box"][1] + cell["box"][3]) / 2
        if cell in groups:
            continue
        for band in bands:
            ref = band[0]["box"]
            if abs((ref[1] + ref[3]) / 2 - centre) <= 1.5 * page.mm_y:
                band.append(cell)
                break
        else:
            bands.append([cell])
    rows: list[dict[str, Any]] = []
    unsure: list[str] = []
    counters: dict[str, int] = {}
    for band in bands:
        band.sort(key=lambda c: c["box"][0])
        stacked = [cell for cell in band if len(cell["lines"]) > 1
                   and all(_overlap_y(page.lines[a]["box"], page.lines[b]["box"]) < 0.3 for a in cell["lines"] for b in cell["lines"] if a < b)]
        if len(band) == 1 and stacked:
            # One cell holding the names of several rows (its dividing line was too faint): a row for each name.
            for i in sorted(stacked[0]["lines"], key=lambda i: page.lines[i]["box"][1]):
                name = clean(page.lines[i]["text"])
                rows.append({"label": name, "source": [i], "id": row_id(name)})
                source.append(i)
                if len(name) <= 2:
                    unsure.append(f"row name '{name}' may be cut (subscripts, symbols)")
            continue
        texts = [page.lines[i]["text"] for cell in band for i in cell["lines"]]
        ids_here = [i for cell in band for i in cell["lines"]]
        group = next((g for g in groups if g not in band and g["box"][1] - page.mm_y <= band[0]["box"][1] and band[0]["box"][3] <= g["box"][3] + page.mm_y), None)
        group_name = clean(" ".join(page.lines[i]["text"] for i in group["lines"])) if group else ""
        name = clean(" ".join(texts))
        if group and group_name and (not name or len(name) <= 3):
            counters[group_name] = counters.get(group_name, 0) + 1
            name = f"{group_name} {name}".strip() if name else f"{group_name} {counters[group_name]}"
            source += group["lines"]
        if not name:
            counters[""] = counters.get("", 0) + 1
            name = f"อื่นๆ {counters['']}"  # a spare row left empty on the paper, for what the case needs
            unsure.append(f"spare row '{name}': keep it or remove it")
        if len(clean(" ".join(texts))) <= 2 and texts:
            unsure.append(f"row name '{name}' may be cut (subscripts, symbols)")
        rows.append({"label": name, "source": ids_here, "id": row_id(name)})
        source += ids_here
    for cell in before + above:
        source.append(cell["id"])
    label = "บันทึกตามเวลา"
    if axis_cell or time_label:
        parts = (["events"] if events else []) + (["chart"] if axis_cell else []) + (["table"] if rows else [])
        if axis_cell and not chart:
            unsure.append("the plotted values are not named: check the chart series")
        page.item("field", label, list(dict.fromkeys(source)), [grid["box"]] + [c["box"] for c in before], type="timeline", time_columns=grid["cols"],
                  label_en="Record over time", rows=_unique_rows(rows), chart=chart, parts=parts or ["table"],
                  unsure=["name the record (the paper has no title for it)"] + unsure, confidence=0.75)
    else:
        columns = [{"label": row["label"], "source": row["source"]} for row in rows] or [{"label": "รายการ", "source": []}]
        page.item("field", "ตาราง", list(dict.fromkeys(source)), [grid["box"]], type="repeat", columns=columns,
                  unsure=["a grid without a time axis: check whether it is a table or a score grid"], confidence=0.5)


def row_id(label: str) -> str:
    """A timeline row's id from its name: the parameters Flora Leaf records by their own ids (spo2, et_co2, …)."""
    for pattern, row_id in ROW_IDS:
        if pattern.search(label):
            return row_id
    from .. import ids

    name = ids.snake(label)[:60]
    return name if re.match(r"^[a-z]", name or "") else f"row_{name}".rstrip("_")


def _unique_rows(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    seen: set[str] = set()
    for row in rows:
        base = row["id"] or "row"
        candidate, n = base, 2
        while candidate in seen:
            candidate, n = f"{base}_{n}", n + 1
        row["id"] = candidate
        seen.add(candidate)
    return rows


# Checklists and filled labels (digital PDFs, filled copies) ------------------------------------------------
DATE_VALUE = re.compile(r"^\d{1,4}[-/.]\d{1,2}[-/.]\d{1,4}$|^\d{1,2}\s+\S+\s+\d{4}$")
TIME_VALUE = re.compile(r"^\d{1,2}[:.]\d{2}(\s*-\s*\d{1,2}[:.]\d{2})?")
NUMBER_VALUE = re.compile(r"^(\d+(?:\.\d+)?)\s*([^\d\s].{0,8})?$")
OWN_LABEL = re.compile(r"^([A-Za-z฀-๿][^:]{1,38}):\s*(?=\S)")


def _checklists(page: _Page) -> None:
    """A column of checkboxes, one item per row, under bold category names (Gas / Inhalation, Induction Agent, …), often
    with a quantity column: a table per category (matrix: the items as its rows, the quantity as its column), as the
    paper prints it. Without a quantity column a category is a multiple choice. Rows whose box has no text are spare
    lines for anything else and are counted, not made into items."""
    boxes = [box for box in page.ev["checkboxes"] if box["id"] not in page.used]
    columns: list[list[dict[str, Any]]] = []
    for box in sorted(boxes, key=lambda b: (b["box"][0], b["box"][1])):
        for column in columns:
            if abs(column[0]["box"][0] - box["box"][0]) <= 2 * page.mm_x:
                column.append(box)
                break
        else:
            columns.append([box])
    lines = page.ev["lines"]
    starts = sorted(column[0]["box"][0] for column in columns if len(column) >= 4)
    previous_heading = None
    for column in sorted((c for c in columns if len(c) >= 4), key=lambda c: c[0]["box"][0]):
        column.sort(key=lambda b: b["box"][1])
        x0 = column[0]["box"][0]
        # The column's band: up to the next checkbox column (or the page's right side).
        x1 = next((start for start in starts if start > x0 + 5 * page.mm_x), 0.99) - page.mm_x
        row_h = statistics.median(b["box"][3] - b["box"][1] for b in column) * 1.6
        top, bottom = column[0]["box"][1] - 3 * row_h, column[-1]["box"][3] + row_h
        band = [line for line in lines if line["id"] not in page.used and x0 - 3 * page.mm_x <= line["box"][0] < x1
                and top <= line["box"][1] <= bottom]
        labels = {b.get("label") for b in column}
        # Category names: bold text at the column's left edge, not on an item's row; pieces on one row are one name.
        pieces = sorted((l for l in band if l["id"] not in labels and l.get("bold") and l["box"][0] <= x0 + 2 * page.mm_x
                         and not any(_overlap_y(l["box"], b["box"]) > 0.3 for b in column)), key=lambda l: l["box"][1])
        categories: list[dict[str, Any]] = []
        for piece in pieces:
            row = [l for l in band if l.get("bold") and l["id"] not in labels and _overlap_y(l["box"], piece["box"]) > 0.5 and l["box"][0] < x1]
            row.sort(key=lambda l: l["box"][0])
            if any(row[0]["id"] == c["parts"][0]["id"] for c in categories):
                continue
            categories.append({"id": row[0]["id"], "text": " ".join(l["text"] for l in row), "box": _union([l["box"] for l in row]), "parts": row})
        first_row = min([column[0]["box"][1]] + [c["box"][1] for c in categories])
        # Header names over the column (list | Qty): the second one names the quantity column.
        part_ids = {l["id"] for c in categories for l in c["parts"]}
        header = sorted((l for l in band if l["box"][3] <= first_row + 0.3 * row_h and l["id"] not in labels and l["id"] not in part_ids
                         and l.get("bold")), key=lambda l: l["box"][0])
        header = [l for l in header if abs(l["box"][1] - header[-1]["box"][1]) <= row_h * 0.6] if header else []
        qty_x = header[1]["box"][0] - 2 * page.mm_x if len(header) >= 2 else None
        # Quantities written on this copy: short text right of an item, in the quantity column.
        values = [l for l in band if l["id"] not in labels and l not in header and l["id"] not in part_ids and len(l["text"]) <= 8
                  and (qty_x is None or l["box"][0] >= qty_x)]
        if qty_x is None and values:
            qty_x = min(v["box"][0] for v in values) - page.mm_x
        groups: list[tuple[dict[str, Any] | None, list[dict[str, Any]]]] = []
        for box in column:
            heading = max((c for c in categories if c["box"][1] < box["box"][1]), key=lambda c: c["box"][1], default=None)
            if not groups or groups[-1][0] is not heading:
                groups.append((heading, []))
            groups[-1][1].append(box)
        used_header = False
        for heading, members in groups:
            # An item's name starts right of its box (a quantity printed just left of it belongs to the column before).
            items = [b for b in members if b.get("label") and page.lines[b["label"]]["box"][0] >= b["box"][0]]
            if not items:
                continue
            spare = len(members) - len(items)
            rows = [{"label": clean(page.lines[b["label"]]["text"]), "source": [b["id"], b["label"]]} for b in items]
            source = [i for row in rows for i in row["source"]] + [b["id"] for b in members]
            boxes_used = [b["box"] for b in members] + [page.lines[b["label"]]["box"] for b in items]
            if heading:
                source += [l["id"] for l in heading["parts"]]
                boxes_used.append(heading["box"])
            # The table is as wide as its column on the paper (names and quantities).
            boxes_used.append([x0, min(b["box"][1] for b in members), x1, max(b["box"][3] for b in members)])
            mine = [v for v in values if any(_overlap_y(v["box"], b["box"]) > 0.3 for b in members)]
            source += [v["id"] for v in mine]
            if not used_header:
                source += [h["id"] for h in header]
                used_header = True
            if heading is None and previous_heading is not None:
                name = f"{clean(previous_heading['text'])} (ต่อ)"  # the list goes on from the column before
            else:
                name = clean(heading["text"]) if heading else NO_NAME
            for value in mine:
                page.ignored.append({"source": value["id"], "why": "a quantity filled in on this copy"})
            unsure = [] if heading or previous_heading is not None else ["a list without a name: name it"]
            if spare:
                unsure.append(f"{spare} spare row(s) on the paper for other items")
            # The table starts where the paper's does (its name, or its first item) and keeps its columns' proportion.
            table_top = heading["box"][1] if heading else min(b["box"][1] for b in members)
            anchor = [x0, table_top, x1, table_top + row_h / 1.6]
            label_width = round(100 * (qty_x - x0) / max(1e-6, x1 - x0)) if qty_x is not None else None
            if qty_x is not None:
                numeric = all(NUMBER_VALUE.match(v["text"].strip()) and not NUMBER_VALUE.match(v["text"].strip()).group(2) for v in mine)
                page.item("field", name, list(dict.fromkeys(source)), boxes_used, type="matrix", rows=rows,
                          columns=[{"label": clean(header[1]["text"]) if len(header) >= 2 else "จำนวน", "source": [header[1]["id"]] if len(header) >= 2 else []}],
                          cell="integer" if numeric else "text", checklist=True, unsure=unsure, confidence=0.85 if heading else 0.7)
                page.items[-1]["anchor"] = anchor
                page.items[-1]["column"] = {"x0": round(x0, 3), "x1": round(x1, 3), "header": " | ".join(clean(h["text"]) for h in header)}
                if label_width:
                    page.items[-1]["label_width"] = max(10, min(90, label_width))
            else:
                page.item("field", name, list(dict.fromkeys(source)), boxes_used, type="multiselect",
                          options=[{"label": row["label"], "source": row["source"]} for row in rows], unsure=unsure, confidence=0.85 if heading else 0.7)
                page.items[-1]["anchor"] = anchor
                page.items[-1]["column"] = {"x0": round(x0, 3), "x1": round(x1, 3), "header": " | ".join(clean(h["text"]) for h in header)}
            page.used.update(b["id"] for b in members)
        last = max((c for c in categories), key=lambda c: c["box"][1], default=None)
        previous_heading = last or previous_heading


def _filled_labels(page: _Page) -> None:
    """A filled copy prints its labels bold and its answers regular: "Age: 64 Y", "Gender: Female". The bold part is the
    field; the answer is set aside (it is this patient's, not the form's) and only tells the type (a date, a number and
    its unit). Other regular text in the same cell is that answer too. Works on a PDF's own text (fonts known)."""
    for line in page.free_lines():
        words = line.get("words") or []
        if not words:
            continue
        bold = []
        for word in words:
            if not word.get("bold"):
                break
            bold.append(word["text"])
        label_text = " ".join(bold)
        if not label_text.rstrip().endswith(":"):
            # A regular "Label: value" in a form's cell (Anesthesia time: 09:10 - 13:35) is a field as well.
            match = OWN_LABEL.match(line["text"])
            if bold or not match or not line.get("cell"):
                continue
            label_text, bold = match.group(1) + ":", match.group(1).split()
            value = line["text"][match.end():].strip()
        else:
            value = " ".join(word["text"] for word in words[len(bold):]).strip()
        cell = page.cells.get(line.get("cell") or "")
        others = [other for other in page.free_lines(line.get("cell")) if other["id"] != line["id"] and cell is not None
                  and not other.get("bold") and not any(w.get("bold") for w in other.get("words") or []) and not OWN_LABEL.match(other["text"])]
        label, unit = split_unit(clean(label_text))
        kind, certainty = guess_type(label, unit, False)
        answer = value or (others[0]["text"] if others else "")
        number = NUMBER_VALUE.match(answer)
        if DATE_VALUE.match(answer):
            kind, certainty = "date", 0.9
        elif TIME_VALUE.match(answer) and "-" in answer:
            kind, certainty = "text", 0.8  # a period: 09:10 - 13:35
        elif number and kind in ("text", "number", "decimal"):
            unit = unit or (unit_of(number.group(2)) if number.group(2) else None) or (number.group(2) or "").strip() or None
            kind = "decimal" if "." in number.group(1) else "number"
            certainty = 0.85
        elif kind == "text" and (len(answer) > 40 or (not answer and cell and cell["box"][3] - cell["box"][1] > 4 * (line["box"][3] - line["box"][1]))):
            kind = "textarea"
        source = [line["id"]] + [other["id"] for other in others] + ([cell["id"]] if cell else [])
        for other in others:
            page.ignored.append({"source": other["id"], "why": "the answer filled in on this copy"})
        page.item("field", label, source, [line["box"]] + ([cell["box"]] if cell else []), type=kind, unit=unit,
                  example=answer[:60] or None, unsure=[] if certainty >= SURE else ["the type is a guess"], confidence=round(certainty, 2))


# 3. ruled tables -----------------------------------------------------------------------------------------
def _spans_table(page: _Page, line: dict[str, Any], left: float, right: float) -> bool:
    """A line above a table names it when it is free text, or sits in a cell about as wide as the table (its title
    row), not in a small cell of its own (a label of something else)."""
    cell = page.cells.get(line.get("cell") or "")
    return cell is None or (cell["box"][2] - cell["box"][0]) >= 0.8 * (right - left)


def _ruled_tables(page: _Page) -> None:
    """A row of header cells (each with one name, or one cell with several names) over two or more rows of empty cells
    with the same columns: a table. One name over empty rows: a long text."""
    free_cells = [cell for cell in page.ev["cells"] if cell["id"] not in page.used]
    rows: list[list[dict[str, Any]]] = []
    for cell in sorted(free_cells, key=lambda c: (c["box"][1], c["box"][0])):
        for row in rows:
            ref = row[0]["box"]
            if abs(ref[1] - cell["box"][1]) <= 2 * page.mm_y and abs(ref[3] - cell["box"][3]) <= 2 * page.mm_y:
                row.append(cell)
                break
        else:
            rows.append([cell])
    for row in rows:
        row.sort(key=lambda c: c["box"][0])

    def same_columns(a: list[dict[str, Any]], b: list[dict[str, Any]]) -> bool:
        return len(a) == len(b) and all(abs(x["box"][0] - y["box"][0]) <= 2.5 * page.mm_x and abs(x["box"][2] - y["box"][2]) <= 2.5 * page.mm_x
                                        for x, y in zip(a, b))
    def stack_below(cell: dict[str, Any]) -> list[dict[str, Any]]:
        """The empty cells right under a cell, as wide as it, one after another."""
        out, bottom = [], cell["box"][3]
        for other in sorted(free_cells, key=lambda c: c["box"][1]):
            b = other["box"]
            if other is cell or other["lines"]:
                continue
            if abs(b[0] - cell["box"][0]) <= 2.5 * page.mm_x and abs(b[2] - cell["box"][2]) <= 2.5 * page.mm_x \
                    and -2 * page.mm_y <= b[1] - bottom <= 2.5 * page.mm_y:
                out.append(other)
                bottom = b[3]
        return out

    def names_on_one_row(cell: dict[str, Any]) -> bool:
        lines = [page.lines[i] for i in cell["lines"]]
        return bool(lines) and not any(i in page.used for i in cell["lines"]) and all(_overlap_y(lines[0]["box"], line["box"]) >= 0.5 for line in lines)

    # A grid whose rows are named on the paper first: its header cells over empty cells would otherwise read as a table.
    _matrices(page, rows, same_columns)
    rows = [[cell for cell in row if cell["id"] not in page.used] for row in rows]
    for row in rows:
        # Header cells side by side, each with the same number of empty rows under it, are one table; a neighbour with
        # a different number (AGENTS | DOSAGE over 6 rows beside TECHNIQUES over 3) is a table of its own.
        groups: list[list[tuple[dict[str, Any], list[dict[str, Any]]]]] = []
        for cell in row:
            stack = stack_below(cell) if names_on_one_row(cell) else []
            if len(stack) < 2:
                groups.append([])
                continue
            last = groups[-1] if groups else []
            if last and len(last[-1][1]) == len(stack) and cell["box"][0] - last[-1][0]["box"][2] <= 2 * page.mm_x:
                last.append((cell, stack))
            else:
                groups.append([(cell, stack)])
        for group in (g for g in groups if g):
            _ruled_table(page, [cell for cell, _ in group], [list(cells) for cells in zip(*(stack for _, stack in group))])


def _ruled_table(page: _Page, header: list[dict[str, Any]], below: list[list[dict[str, Any]]]) -> None:
    """One ruled table: header cells over rows of empty cells."""
    if any(cell["id"] in page.used for cell in header) or any(cell["id"] in page.used for row in below for cell in row):
        return
    heads = [page.lines[i] for cell in header for i in cell["lines"]]
    heads.sort(key=lambda line: line["box"][0])
    source = [line["id"] for line in heads] + [c["id"] for c in header] + [c["id"] for row in below for c in row]
    boxes = [c["box"] for c in header] + [c["box"] for row in below for c in row]
    if len(heads) == 1:
        page.item("field", clean(heads[0]["text"]), source, boxes, type="textarea", lines=len(below) + 1)
        return
    # The table's name: the line just above it, when nothing uses it; else its first column's name.
    top = min(c["box"][1] for c in header)
    title = [line for line in page.free_lines() if 0 <= top - line["box"][3] <= 12 * page.mm_y and line["id"] not in source
             and _overlap_x(line["box"], [header[0]["box"][0], 0, header[-1]["box"][2], 1]) > 0
             and _spans_table(page, line, header[0]["box"][0], header[-1]["box"][2])]
    name = clean(title[-1]["text"]) if title else clean(heads[0]["text"])
    if title:
        source.append(title[-1]["id"])
    # Each column as wide as its header cell on the paper (several names in one cell share it by where they start).
    left, right = header[0]["box"][0], header[-1]["box"][2]
    if len(header) == len(heads):
        widths = [(cell["box"][2] - cell["box"][0]) / max(1e-6, right - left) for cell in header]
    else:
        starts = [line["box"][0] for line in heads] + [right]
        starts[0] = left
        widths = [(starts[i + 1] - starts[i]) / max(1e-6, right - left) for i in range(len(heads))]
    columns = [{"label": clean(line["text"]), "source": [line["id"]], "width": round(width, 3)} for line, width in zip(heads, widths)]
    page.item("field", name, source, boxes, type="repeat", columns=columns, min_rows=len(below),
              unsure=[] if title else ["the table's name is its first column's: check it"], confidence=0.85 if title else 0.75)


def _matrices(page: _Page, rows: list[list[dict[str, Any]]], same_columns: Any) -> None:
    """A ruled table whose first column prints the rows' names and whose other cells are empty: a matrix (the paper's
    grid kept as it is), its columns named by the header row above when there is one. A stack of single cells, each a
    name with room after it (5% D/S ……, Saline ……), is a matrix of one column."""
    def named(row: list[dict[str, Any]]) -> bool:
        if any(cell["id"] in page.used for cell in row) or len(row[0]["lines"]) != 1 or row[0]["lines"][0] in page.used:
            return False
        if len(row) >= 2:
            return all(not cell["lines"] for cell in row[1:])
        line = page.lines[row[0]["lines"][0]]
        one_line = row[0]["box"][3] - row[0]["box"][1] <= 2.2 * (line["box"][3] - line["box"][1])  # a list's row, not a box to write in
        room = row[0]["box"][2] - line["box"][2]
        return one_line and (room >= 0.25 * (row[0]["box"][2] - row[0]["box"][0]) or room >= 20 * page.mm_x)
    taken: set[int] = set()
    for position, first in enumerate(rows):
        if position in taken or not named(first):
            continue
        # The rows under it with the same columns, one after another (rows elsewhere on the page are passed over).
        run, indexes = [first], [position]
        for later in range(position + 1, len(rows)):
            nxt = rows[later]
            if not same_columns(first, nxt):
                continue
            if not named(nxt) or nxt[0]["box"][1] - run[-1][0]["box"][3] > 2.5 * page.mm_y:
                break
            run.append(nxt)
            indexes.append(later)
        if len(run) < (2 if len(first) >= 2 else 3):
            continue
        taken.update(indexes)
        header = None
        above = [row for row in rows if same_columns(row, run[0]) and 0 <= run[0][0]["box"][1] - row[0]["box"][3] <= 2.5 * page.mm_y]
        if above and len(above[0]) >= 2 and all(len(cell["lines"]) == 1 and cell["lines"][0] not in page.used for cell in above[0][1:]):
            header = above[0]
        width = run[0][-1]["box"][2] - run[0][0]["box"][0]
        if len(run[0]) >= 2:
            cols = [{"label": f"ค่า {index}",
                     "source": [header[index]["lines"][0]] if header else [], "width": round((cell["box"][2] - cell["box"][0]) / width, 3)}
                    for index, cell in enumerate(run[0][1:], start=1)]
            if header:
                cols = [{**col, "label": clean(page.lines[header[index]["lines"][0]]["text"])} for index, col in enumerate(cols, start=1)]
        else:
            cols = [{"label": "ค่า", "source": []}]
        rows_out = [{"label": clean(page.lines[row[0]["lines"][0]]["text"]), "source": [row[0]["lines"][0]]} for row in run]
        source = [i for row in rows_out for i in row["source"]] + [i for col in cols for i in col["source"]] \
            + [cell["id"] for row in run for cell in row] + ([cell["id"] for cell in header] if header else [])
        if header and header[0]["lines"] and header[0]["lines"][0] not in page.used:
            name_line = page.lines[header[0]["lines"][0]]
            source.append(name_line["id"])
            name = clean(name_line["text"])
        else:
            top = run[0][0]["box"][1] if not header else header[0]["box"][1]
            title = [line for line in page.free_lines() if 0 <= top - line["box"][3] <= 12 * page.mm_y and line["id"] not in source
                     and _overlap_x(line["box"], [run[0][0]["box"][0], 0, run[0][-1]["box"][2], 1]) > 0
                     and _spans_table(page, line, run[0][0]["box"][0], run[0][-1]["box"][2])]
            name = clean(title[-1]["text"]) if title else NO_NAME
            if title:
                source.append(title[-1]["id"])
        boxes = [cell["box"] for row in run for cell in row] + ([cell["box"] for cell in header] if header else [])
        page.item("field", name, list(dict.fromkeys(source)), boxes, type="matrix", rows=rows_out, columns=cols,
                  unsure=([] if header else ["the paper does not name the columns: name them"]) + ([] if name != NO_NAME else ["a table without a name: name it"]),
                  confidence=0.8 if header else 0.65)


# 4. blanks -----------------------------------------------------------------------------------------------
def _blanks(page: _Page) -> None:
    blanks = [blank for blank in page.ev["blanks"] if blank["id"] not in page.used and (blank.get("cell") is None or blank["cell"] not in page.used)]
    pairs = []
    for blank in blanks:
        base = blank["box"][3]
        for line in page.free_lines():
            if line.get("cell") != blank.get("cell"):
                continue
            h = line["box"][3] - line["box"][1]
            drop = abs(line["box"][3] - base)
            gap = blank["box"][0] - line["box"][2]
            if drop <= max(0.9 * h, 2.5 * page.mm_y) and -4 * page.mm_x <= gap <= 30 * page.mm_x and clean(line["text"]):
                pairs.append((drop / h + gap / (10 * page.mm_x), blank["id"], line["id"]))
    pairs.sort()
    label_of: dict[str, str] = {}
    taken: set[str] = set()
    for _, blank_id, line_id in pairs:
        if blank_id in label_of or line_id in taken:
            continue
        label_of[blank_id] = line_id
        taken.add(line_id)
    fields: list[tuple[dict[str, Any], dict[str, Any]]] = []
    for blank in sorted(blanks, key=lambda b: (b["box"][1], b["box"][0])):
        line_id = label_of.get(blank["id"])
        if blank.get("kind") == "form_field" and line_id is None and blank.get("name"):
            # A fillable PDF's own field: its type and options are known; its internal name stands in for a label.
            kind = {"checkbox": "checkbox", "radio": "radio", "select": "select", "signature": "signature"}.get(blank.get("field_type") or "", "text")
            page.item("field", clean(blank["name"].replace("_", " ")), [blank["id"]], [blank["box"]], type=kind,
                      options=[{"label": option, "source": [blank["id"]]} for option in blank.get("options") or []] or None,
                      unsure=["named after the PDF's internal field name"], confidence=0.7)
            continue
        if line_id is None:
            # A blank under another field's blank continues it: a long answer on several lines.
            width = max(1e-6, blank["box"][2] - blank["box"][0])
            above = [(field, last) for field, last in fields if last.get("cell") == blank.get("cell")
                     and max(0.0, min(field["box"][2], blank["box"][2]) - max(field["box"][0], blank["box"][0])) / width > 0.6
                     and 0 < blank["box"][1] - last["box"][1] <= 14 * page.mm_y]
            if above:
                field, last = min(above, key=lambda pair: blank["box"][1] - pair[1]["box"][1])
                field["type"] = "textarea"
                field["lines"] = field.get("lines", 1) + 1
                field["source"].append(blank["id"])
                field["box"] = _union([field["box"], blank["box"]])
                page.used.add(blank["id"])
                fields = [(f, blank if f is field else l) for f, l in fields]
            continue
        line = page.lines[line_id]
        label, unit = split_unit(clean(line["text"]))
        source, boxes = [line_id, blank["id"]], [line["box"], blank["box"]]
        # What is written right after the blank, on the label's own text row (an underline lies below the text): a unit
        # (kg, ปี) or, after a signature line, the signer's role ("ลงชื่อ ……… ผู้บันทึก").
        after = sorted((other for other in page.free_lines(line.get("cell")) if other["id"] not in taken and other["id"] != line_id
                        and (_overlap_y(other["box"], line["box"]) > 0.4 or _overlap_y(other["box"], blank["box"]) > 0.3)
                        and -2 * page.mm_x <= other["box"][0] - blank["box"][2] <= 6 * page.mm_x), key=lambda other: other["box"][0])
        role = None
        if after and unit_of(after[0]["text"]):
            unit = unit or unit_of(after[0]["text"])
            source.append(after[0]["id"])
            boxes.append(after[0]["box"])
        elif after and SIGNATURE.search(label) and (ROLE.search(after[0]["text"]) or len(clean(after[0]["text"])) <= 30):
            role = clean(after[0]["text"])
            source.append(after[0]["id"])
            boxes.append(after[0]["box"])
            label = f"{label} {role}".strip()
        kind, certainty = guess_type(label, unit, False)
        if blank.get("kind") == "form_field" and blank.get("field_type") in ("checkbox", "radio", "select", "signature"):
            kind, certainty = blank["field_type"], 0.95
        unsure = [] if line.get("score", 1) >= 0.8 else [f"the label was hard to read ({line.get('score', 0):.2f})"]
        if certainty < SURE:
            unsure.append("the type is a guess")
        field = page.item("field", label or "(ไม่มีป้าย)", source, boxes, type=kind, unit=unit, unsure=unsure,
                          confidence=round(min(certainty, line.get("score", 1)), 2))
        fields.append((field, blank))


# 5. checkboxes -------------------------------------------------------------------------------------------
def _checkboxes(page: _Page) -> None:
    boxes = [box for box in page.ev["checkboxes"] if box["id"] not in page.used]
    rows: list[list[dict[str, Any]]] = []
    for box in sorted(boxes, key=lambda b: (b["box"][1], b["box"][0])):
        for row in rows:
            if _overlap_y(row[0]["box"], box["box"]) > 0.5 and row[0].get("cell") == box.get("cell"):
                row.append(box)
                break
        else:
            rows.append([box])
    for row in rows:
        row.sort(key=lambda b: b["box"][0])
        options = [{"label": clean(BOX_GLYPH.sub("", page.lines[b["label"]]["text"])), "source": [b["id"], b["label"]]} for b in row
                   if b.get("label") and b["label"] not in page.used]
        option_lines = {b.get("label") for b in row}
        first = row[0]["box"]
        before = [line for line in page.free_lines() if line["id"] not in option_lines and _overlap_y(line["box"], first) > 0.4
                  and line["box"][2] <= first[0] + page.mm_x and first[0] - line["box"][2] <= 40 * page.mm_x]
        label_line = max(before, key=lambda line: line["box"][2]) if before else None
        source = [b["id"] for b in row] + [i for option in options for i in option["source"]]
        boxes_used = [b["box"] for b in row]
        if label_line:
            source.append(label_line["id"])
            boxes_used.append(label_line["box"])
        if len(row) == 1 and not label_line:
            page.item("field", options[0]["label"] if options else "(ไม่มีป้าย)", source, boxes_used, type="checkbox")
            continue
        label = clean(label_line["text"]) if label_line else "(ไม่มีป้าย)"
        yes_no = len(options) <= 3 and all(YES_NO.match(option["label"]) for option in options)
        kind = "radio" if yes_no or len(options) == 2 else "multiselect"
        page.item("field", label, source, boxes_used, type=kind, options=options,
                  unsure=([] if label_line else ["no label before the boxes"]) + ([] if yes_no else ["one answer or several?"]),
                  confidence=0.9 if label_line and yes_no else 0.7)


# 6. option lists to circle ----------------------------------------------------------------------------------
def _option_lists(page: _Page) -> None:
    for line in page.free_lines():
        text = line["text"]
        if ":" in text:
            head, _, tail = text.partition(":")
            options = [clean(part) for part in SEPARATORS.split(tail) if clean(part)]
            if clean(head) and len(options) >= 2 and not FILL.search(tail):
                page.item("field", clean(head), [line["id"]], [line["box"]], type="radio" if len(options) <= 6 else "multiselect",
                          options=[{"label": option, "source": [line["id"]]} for option in options],
                          unsure=["printed options to circle: one answer or several?"], confidence=0.75)
    # A line of short words between separators, no label: options to circle (UNDERMASK / LMA). Not a bilingual label.
    for line in page.free_lines():
        parts = [clean(part) for part in SEPARATORS.split(line["text"]) if clean(part)]
        thai = [bool(re.search("[฀-๿]", part)) for part in parts]
        bilingual = len(parts) == 2 and thai[0] != thai[1]
        if len(parts) >= 2 and not bilingual and all(len(part) <= 20 for part in parts) and not FILL.search(line["text"]) \
                and (all(YES_NO.match(part) for part in parts) or not any(thai)):
            page.item("field", "(ไม่มีป้าย)", [line["id"]], [line["box"]], type="radio" if len(parts) == 2 else "multiselect",
                      options=[{"label": part, "source": [line["id"]]} for part in parts],
                      unsure=["printed options without a name: name them", "one answer or several?"], confidence=0.6)
    # A cell of short words with nowhere to write in it: a list to tick (monitors, techniques).
    for cell in page.ev["cells"]:
        free = page.free_lines(cell["id"])
        if len(free) < 3 or any(b.get("cell") == cell["id"] for b in page.ev["blanks"]) or cell["empty"] > 0.75:
            continue
        if any(len(clean(line["text"])) > 40 or FILL.search(line["text"]) for line in free):
            continue
        options = []
        for line in sorted(free, key=lambda l: (round(l["box"][1] / (2 * page.mm_y)), l["box"][0])):
            options += [{"label": clean(part), "source": [line["id"]]} for part in SEPARATORS.split(line["text"]) if clean(part)]
        page.item("field", "(ไม่มีป้าย)", [line["id"] for line in free] + [cell["id"]], [cell["box"]], type="multiselect", options=options,
                  unsure=["a list without a name: name it", "one answer or several?"], confidence=0.6)


# 7. labels with room to write ------------------------------------------------------------------------------
def _beside_cell(page: _Page, cell: dict[str, Any]) -> dict[str, Any] | None:
    """An empty cell right after this one on the same row: where the value of the label in this one is written."""
    for other in page.ev["cells"]:
        b = other["box"]
        if other is cell or other["lines"] or other["id"] in page.used:
            continue
        if 0 <= b[0] - cell["box"][2] <= 2 * page.mm_x and _overlap_y(b, cell["box"]) >= 0.6:
            return other
    return None


def _label_then_box(page: _Page) -> None:
    """A label followed on its row by an empty drawn box: the box is where its value is written."""
    for line in sorted(page.free_lines(), key=lambda l: (l["box"][1], l["box"][0])):
        text = clean(line["text"])
        if not text or len(text) > 60 or line.get("grid"):
            continue
        box = line["box"]
        targets = [cell for cell in page.ev["cells"] if not cell["lines"] and cell["id"] not in page.used
                   and -page.mm_x <= cell["box"][0] - box[2] <= 20 * page.mm_x and _overlap_y(cell["box"], box) >= 0.5
                   and cell["box"][2] - cell["box"][0] >= 10 * page.mm_x]
        if not targets:
            continue
        target = min(targets, key=lambda cell: cell["box"][0])
        h = box[3] - box[1]
        label, unit = split_unit(text)
        kind, certainty = guess_type(label, unit, target["box"][3] - target["box"][1] > 2.6 * h)
        page.item("field", label, [line["id"], target["id"]], [box, target["box"]], type=kind, unit=unit,
                  unsure=[] if certainty >= SURE else ["the type is a guess"], confidence=round(min(0.9, certainty), 2))


def _signers(page: _Page) -> None:
    """A role printed at the bottom of a box with room above it (Surgeon, Anesthesia nurse 1, ผู้บันทึก): the box is
    where that person signs."""
    for line in page.free_lines():
        cell = page.cells.get(line.get("cell") or "")
        if not cell or not ROLE.search(line["text"]) or len(clean(line["text"])) > 40 or line["box"][1] < 0.6:
            continue
        h = line["box"][3] - line["box"][1]
        middle = (cell["box"][1] + cell["box"][3]) / 2
        if line["box"][1] - cell["box"][1] >= 2.5 * h and (line["box"][1] + line["box"][3]) / 2 > middle:
            others = [o for o in page.free_lines(cell["id"]) if o["id"] != line["id"]]
            page.item("field", clean(line["text"]), [line["id"], cell["id"]] + [o["id"] for o in others], [cell["box"]], type="signature",
                      confidence=0.8)


def _labels_with_room(page: _Page) -> None:
    for line in sorted(page.free_lines(), key=lambda l: (l["box"][1], l["box"][0])):
        cell = page.cells.get(line.get("cell") or "")
        text = clean(line["text"])
        if not cell or not text or len(text) > 60 or NUMERIC.match(text) or SYMBOL.match(text):
            continue
        box = line["box"]
        h = box[3] - box[1]
        same_row = [other for other in page.ev["lines"] if other.get("cell") == cell["id"] and other["id"] != line["id"] and _overlap_y(other["box"], box) > 0.5
                    and other["box"][0] > box[2]]
        right_edge = min([other["box"][0] for other in same_row] + [cell["box"][2]])
        below = [other for other in page.ev["lines"] if other.get("cell") == cell["id"] and other["box"][1] > box[3] - 0.2 * h and _overlap_x(other["box"], [box[0], 0, right_edge, 1]) > 0]
        bottom_edge = min([other["box"][1] for other in below] + [cell["box"][3]])
        room_right = right_edge - box[2]
        room_below = bottom_edge - box[3]
        label, unit = split_unit(text)
        if room_below >= 2.2 * h and box[1] - cell["box"][1] <= 2.5 * h and not same_row:
            lines = max(2, min(12, int(room_below / (1.6 * h))))
            kind = "signature" if (ROLE.search(text) or SIGNATURE.search(text)) and box[1] > 0.75 else "textarea"
            page.item("field", label, [line["id"], cell["id"]], [box, [box[0], box[3], cell["box"][2], bottom_edge]], type=kind, lines=lines,
                      confidence=0.8)
        elif room_right >= 15 * page.mm_x:
            kind, certainty = guess_type(label, unit, False)
            unsure = [] if certainty >= SURE else ["the type is a guess"]
            if (ROLE.search(text) or SIGNATURE.search(text)) and box[1] > 0.75:
                kind, unsure = "signature", ["a name or a signature?"]
            page.item("field", label, [line["id"]], [box, [box[2], box[1], right_edge, box[3]]], type=kind, unit=unit, unsure=unsure,
                      confidence=round(min(0.8, certainty), 2))
        elif not same_row and (target := _beside_cell(page, cell)) is not None:
            tall = target["box"][3] - target["box"][1] > 3 * h
            kind, certainty = guess_type(label, unit, tall)
            page.item("field", label, [line["id"], cell["id"], target["id"]], [box, target["box"]], type=kind, unit=unit,
                      lines=max(2, min(12, int((target["box"][3] - target["box"][1]) / (1.6 * h)))) if kind == "textarea" else None,
                      unsure=[] if certainty >= SURE else ["the type is a guess"], confidence=round(min(0.8, certainty), 2))


# 8. what is left --------------------------------------------------------------------------------------------
def _leftovers(page: _Page) -> None:
    for line in page.free_lines():
        text = line["text"].strip()
        if SYMBOL.match(text) or len(clean(text)) <= 1:
            page.ignored.append({"source": line["id"], "why": "a mark or symbol"})
            page.used.add(line["id"])
        elif not line.get("cell") and line["box"][1] > 0.9 and FORM_CODE.search(text) and len(text) <= 24:
            page.ignored.append({"source": line["id"], "why": "the form's number (printed on the paper)"})
            page.used.add(line["id"])
        elif len(text.split()) >= 8 or len(text) >= 70:
            page.item("paragraph", text, [line["id"]], [line["box"]], confidence=0.8)


# Sections --------------------------------------------------------------------------------------------------
def _sections(page: _Page) -> list[dict[str, Any]]:
    """The page cut into bands at its grids: what is above a chart, the chart, what is below it."""
    items = sorted((item for item in page.items if not item.get("title")), key=lambda i: (i["box"][1], i["box"][0]))
    sections: list[dict[str, Any]] = []
    current: list[str] = []
    for item in items:
        if any(source.startswith("G") for source in item["source"]):
            if current:
                sections.append({"items": current})
            sections.append({"items": [item["id"]], "grid": True})
            current = []
            continue
        current.append(item["id"])
    if current:
        sections.append({"items": current})
    by_id = {item["id"]: item for item in items}
    for section in sections:
        anchors = [next((page.lines[i] for i in by_id[item_id]["source"] if i in page.lines), None) for item_id in section["items"]]
        in_cells = [bool(line and line.get("cell")) for line in anchors if line]
        section["ruled"] = bool(in_cells) and sum(in_cells) >= 0.6 * len(in_cells)
    return sections


def plan(pages: list[dict[str, Any]]) -> dict[str, Any]:
    """The whole document's plan from its pages' evidence: {title, sections: [{title?, grid?, items}], ignored, missed}."""
    title = None
    sections: list[dict[str, Any]] = []
    ignored: list[dict[str, Any]] = []
    missed: list[str] = []
    for evidence in pages:
        found = page_plan(evidence)
        by_id = {item["id"]: item for item in found["items"]}
        for item in found["items"]:
            if item.get("title") and title is None:
                title = {"text": item["label"], "source": item["source"]}
                found["ignored"] += [{"source": i, "why": "the form's title"} for i in item["source"]]
        for section in found["sections"]:
            sections.append({"title": None, "grid": bool(section.get("grid")), "ruled": bool(section.get("ruled")),
                             "items": [by_id[i] for i in section["items"]]})
        ignored += found["ignored"]
        missed += found["missed"]
    return {"title": title["text"] if title else None, "title_source": title["source"] if title else [], "sections": sections,
            "ignored": ignored, "missed": missed}
