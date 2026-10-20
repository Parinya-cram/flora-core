"""What a PDF already says without OCR: page sizes, page images and the resolution of a scan, the text layer, and
AcroForm fields. pypdfium2 (BSD/Apache) renders and measures pages; pdfplumber (MIT) reads the text layer; pypdf (BSD)
reads form fields. PyMuPDF is not used (AGPL). Ruled lines and boxes are found on the rendered page (layout.py), the
same way for digital PDFs and scans."""
from __future__ import annotations

import io
from typing import Any

from . import thai



def page_count(content: bytes) -> int:
    import pypdfium2 as pdfium

    document = pdfium.PdfDocument(content)
    try:
        return len(document)
    finally:
        document.close()


def render(content: bytes, index: int, dpi: int = 200) -> Any:
    """The page as a PIL image at dpi (200 is enough for OCR of 8 pt Thai; 300 for small print)."""
    import pypdfium2 as pdfium

    document = pdfium.PdfDocument(content)
    try:
        page = document[index]
        image = page.render(scale=dpi / 72).to_pil().convert("RGB")
        page.close()
        return image
    finally:
        document.close()


def page_dpi(content: bytes, index: int) -> int | None:
    """The resolution of a scanned page: its largest picture's pixels over the page's width (None: no picture). Reading
    a scan at its own resolution avoids resampling it twice."""
    import pypdfium2 as pdfium
    import pypdfium2.raw as raw

    document = pdfium.PdfDocument(content)
    try:
        page = document[index]
        width_pt = page.get_size()[0] or 595
        best = 0
        for item in page.get_objects(filter=(raw.FPDF_PAGEOBJ_IMAGE,)):
            try:
                pixels = item.get_px_size()[0]
                left, _, right, _ = item.get_bounds()
            except Exception:  # noqa: BLE001 - an image pdfium cannot measure is not the scan
                continue
            if right - left >= 0.6 * width_pt:
                best = max(best, int(pixels / ((right - left) / 72)))
        return best or None
    finally:
        document.close()


def page_size(content: bytes, index: int) -> tuple[float, float]:
    import pypdfium2 as pdfium

    document = pdfium.PdfDocument(content)
    try:
        width, height = document[index].get_size()
        return float(width), float(height)
    finally:
        document.close()


def _box(x0: float, top: float, x1: float, bottom: float, width: float, height: float) -> list[float]:
    return [round(max(0.0, x0 / width), 5), round(max(0.0, top / height), 5), round(min(1.0, x1 / width), 5), round(min(1.0, bottom / height), 5)]


def _phrases(words: list[dict[str, Any]], width: float, height: float) -> list[dict[str, Any]]:
    """Words on one baseline joined into phrases while the gap between them is a space, not a column gap: a printed
    form puts many cells on one row, and each cell's text is its own line. Each phrase keeps its words, their font
    size and whether they are bold (a filled form prints its labels bold and the answers regular)."""
    rows: list[list[dict[str, Any]]] = []
    for word in sorted(words, key=lambda w: (round(w["top"], 1), w["x0"])):
        size = float(word.get("size") or 8)
        for row in rows:
            if abs(row[0]["top"] - word["top"]) <= 0.35 * size and abs(row[0]["bottom"] - word["bottom"]) <= 0.5 * size:
                row.append(word)
                break
        else:
            rows.append([word])
    out: list[dict[str, Any]] = []
    for row in rows:
        row.sort(key=lambda w: w["x0"])
        phrase: list[dict[str, Any]] = []
        for word in row:
            size = float(word.get("size") or 8)
            if phrase and word["x0"] - phrase[-1]["x1"] > 0.9 * size:
                out.append(_phrase(phrase, width, height))
                phrase = []
            phrase.append(word)
        if phrase:
            out.append(_phrase(phrase, width, height))
    return out


def _joined(words: list[dict[str, Any]], items: list[dict[str, Any]]) -> str:
    """The phrase's text: a space where the words have one between them; pieces that touch (a word cut where the font
    changes, Thai and Latin in different fonts) are joined as printed."""
    out = ""
    for index, (word, item) in enumerate(zip(words, items)):
        if index and word["x0"] - words[index - 1]["x1"] > 0.12 * float(word.get("size") or 8):
            out += " "
        out += item["text"]
    return out.strip()


def _phrase(words: list[dict[str, Any]], width: float, height: float) -> dict[str, Any]:
    items = [{"text": thai.normalize(str(w["text"])), "box": _box(w["x0"], w["top"], w["x1"], w["bottom"], width, height),
              "bold": "bold" in str(w.get("fontname") or "").lower() or "black" in str(w.get("fontname") or "").lower(),
              "size": round(float(w.get("size") or 0), 1)} for w in words]
    return {"box": _box(min(w["x0"] for w in words), min(w["top"] for w in words), max(w["x1"] for w in words), max(w["bottom"] for w in words),
                        width, height),
            "text": _joined(words, items), "score": 1.0, "source": "text_layer", "words": items,
            "bold": all(item["bold"] for item in items), "size": max(item["size"] for item in items)}


def text_layer(content: bytes, index: int) -> dict[str, Any]:
    """{lines: [{box, text, words, bold, size}], chars, quality: good | poor | none, private_use}: the page's own text,
    as phrases (pdf words joined within a column, never across one). Poor: little text, many shifted Private Use glyphs
    or many words the Thai dictionary does not know (fonts that draw Thai with broken encodings): OCR reads such pages."""
    import pdfplumber

    with pdfplumber.open(io.BytesIO(content)) as pdf:
        page = pdf.pages[index]
        width, height = float(page.width), float(page.height)
        words = page.extract_words(x_tolerance=1.5, y_tolerance=2, keep_blank_chars=False, use_text_flow=False, extra_attrs=["fontname", "size"])
        raw_text = " ".join(str(word.get("text") or "") for word in words)
    lines = [line for line in _phrases(words, width, height) if line["text"]]
    joined = " ".join(line["text"] for line in lines)
    private = thai.private_use_share(raw_text)
    unknown = len(thai.unknown_words(joined))
    count = max(1, len(joined.split()))
    quality = "none" if len(joined) < 20 else ("poor" if private > 0.02 or unknown / count > 0.35 else "good")
    return {"lines": lines, "chars": len(joined), "quality": quality, "private_use": round(private, 4)}


def checkboxes(content: bytes, index: int) -> list[dict[str, Any]]:
    """Checkboxes a digital PDF draws: small square paths or rectangles (1.8-6 mm), ticked when a smaller path (the
    tick) lies inside one. Exact, where finding them in the rendered image would miss small ones."""
    import pdfplumber

    mm = 72 / 25.4
    with pdfplumber.open(io.BytesIO(content)) as pdf:
        page = pdf.pages[index]
        width, height = float(page.width), float(page.height)
        shapes = [(float(c["x0"]), float(c["top"]), float(c["x1"]), float(c["bottom"])) for c in page.curves]
        shapes += [(float(r["x0"]), float(r["top"]), float(r["x1"]), float(r["bottom"])) for r in page.rects if r.get("stroke")]
    squares = [shape for shape in shapes if 1.8 * mm <= shape[2] - shape[0] <= 6 * mm and abs((shape[2] - shape[0]) - (shape[3] - shape[1])) <= 0.4 * mm]
    out: list[dict[str, Any]] = []
    for square in squares:
        if any(abs(square[0] - kept[0]) < 0.5 * mm and abs(square[1] - kept[1]) < 0.5 * mm for kept in (o["_pt"] for o in out)):
            continue
        ticked = any(shape is not square and shape[2] - shape[0] < square[2] - square[0]
                     and square[0] - 0.5 * mm <= (shape[0] + shape[2]) / 2 <= square[2] + 0.5 * mm
                     and square[1] - 0.5 * mm <= (shape[1] + shape[3]) / 2 <= square[3] + 0.5 * mm for shape in shapes)
        out.append({"box": _box(*square, width, height), "ticked": ticked, "_pt": square})
    for item in out:
        item.pop("_pt")
    return out


FIELD_KINDS = {"/Tx": "text", "/Btn": "checkbox", "/Ch": "select", "/Sig": "signature"}


def form_fields(content: bytes) -> list[dict[str, Any]]:
    """AcroForm fields of a fillable PDF: [{page, name, kind, box, options}]; exact rectangles, no OCR needed."""
    from pypdf import PdfReader

    reader = PdfReader(io.BytesIO(content))
    out: list[dict[str, Any]] = []
    for number, page in enumerate(reader.pages):
        width, height = float(page.mediabox.width), float(page.mediabox.height)
        for annotation in page.get("/Annots") or []:
            widget = annotation.get_object()
            if widget.get("/Subtype") != "/Widget":
                continue
            parent = widget.get("/Parent")
            source = parent.get_object() if parent is not None and "/T" not in widget else widget
            name = str(source.get("/T") or widget.get("/T") or "")
            kind = FIELD_KINDS.get(str(source.get("/FT") or widget.get("/FT") or ""), "text")
            if kind == "checkbox" and int(source.get("/Ff") or 0) & (1 << 15):
                kind = "radio"
            x0, y0, x1, y1 = (float(value) for value in widget.get("/Rect"))
            options = [str(option[1] if isinstance(option, list) else option) for option in source.get("/Opt") or []]
            out.append({"page": number, "name": name, "kind": kind, "options": options,
                        "box": _box(min(x0, x1), height - max(y0, y1), max(x0, x1), height - min(y0, y1), width, height)})
    return out
