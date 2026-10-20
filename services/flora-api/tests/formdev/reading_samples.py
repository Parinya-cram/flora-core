"""Synthetic Thai paper forms for the reading tests, drawn with Pillow at 200 dpi (A4):

- form_image(): labels in Thai and English, input boxes, checkboxes (one ticked), a signature line and a 3 × 3 table;
- ruled_form_image(tilt): a nursing record inside a ruled frame, like most hospital forms: a dotted leader, blanks
  with their units after them, an empty box to write in, a chart over time (row names, an axis, a legend), a ruled
  table with empty rows, checkboxes, options printed to be circled, a signature line, a printed grid of rows by shift
  (a matrix) and the form's number, scanned a little crooked (tilt degrees).

as_pdf() wraps a page in a scanned PDF (a JPEG image only, no text layer)."""
from __future__ import annotations

import glob
import io
import re

from PIL import Image, ImageDraw, ImageFont

DPI = 200
MM = DPI / 25.4
WIDTH, HEIGHT = int(210 * MM), int(297 * MM)


def _fonts(size: int):
    thai = ImageFont.truetype(glob.glob("/usr/share/fonts/truetype/noto/NotoSansThai-Regular.ttf")[0], size)
    latin = ImageFont.truetype(glob.glob("/usr/share/fonts/truetype/noto/NotoSans-Regular.ttf")[0], size)
    return thai, latin


def _text(draw: ImageDraw.ImageDraw, x: float, y: float, text: str, size: int = 34) -> float:
    thai, latin = _fonts(size)
    for run in re.findall(r"[฀-๿]+|[^฀-๿]+", text):
        font = thai if "฀" <= run[0] <= "๿" else latin
        draw.text((x, y), run, font=font, fill=0)
        x += draw.textlength(run, font=font)
    return x


def form_image() -> Image.Image:
    image = Image.new("RGB", (WIDTH, HEIGHT), "white")
    draw = ImageDraw.Draw(image)
    _text(draw, 60 * MM, 15 * MM, "แบบประเมินผู้ป่วยก่อนผ่าตัด", 46)
    right = _text(draw, 15 * MM, 35 * MM, "ชื่อ-นามสกุล")
    draw.rectangle((right + 4 * MM, 33 * MM, 195 * MM, 43 * MM), outline=0, width=3)
    right = _text(draw, 15 * MM, 52 * MM, "น้ำหนัก (กก.)")
    draw.rectangle((right + 4 * MM, 50 * MM, 95 * MM, 60 * MM), outline=0, width=3)
    right = _text(draw, 105 * MM, 52 * MM, "ส่วนสูง (ซม.)")
    draw.rectangle((right + 4 * MM, 50 * MM, 195 * MM, 60 * MM), outline=0, width=3)
    _text(draw, 15 * MM, 70 * MM, "ประวัติแพ้ยา")
    for index, (label, ticked) in enumerate((("ไม่มี", False), ("มี", True))):
        x = 60 * MM + index * 40 * MM
        draw.rectangle((x, 70 * MM, x + 5 * MM, 75 * MM), outline=0, width=3)
        if ticked:
            draw.line((x + 1 * MM, 72.5 * MM, x + 2.3 * MM, 74 * MM), fill=0, width=5)
            draw.line((x + 2.3 * MM, 74 * MM, x + 4.2 * MM, 70.8 * MM), fill=0, width=5)
        _text(draw, x + 7 * MM, 69 * MM, label)
    _text(draw, 15 * MM, 88 * MM, "สัญญาณชีพ / Vital signs")
    top = 98 * MM
    for row in range(4):
        draw.line((15 * MM, top + row * 10 * MM, 195 * MM, top + row * 10 * MM), fill=0, width=3)
    for col in range(4):
        x = 15 * MM + col * 60 * MM
        draw.line((x, top, x, top + 30 * MM), fill=0, width=3)
    for col, head in enumerate(("เวลา", "ชีพจร", "ความดันโลหิต")):
        _text(draw, 18 * MM + col * 60 * MM, top + 2 * MM, head)
    right = _text(draw, 15 * MM, 145 * MM, "ลงชื่อพยาบาลผู้ประเมิน")
    draw.line((right + 4 * MM, 152 * MM, 150 * MM, 152 * MM), fill=0, width=3)
    return image


def _dots(draw: ImageDraw.ImageDraw, x0: float, x1: float, y: float) -> None:
    x = x0
    while x < x1:
        draw.ellipse((x, y - 0.3 * MM, x + 0.55 * MM, y + 0.25 * MM), fill=0)
        x += 1.3 * MM


def ruled_form_image(tilt: float = 1.2) -> Image.Image:
    image = Image.new("RGB", (WIDTH, HEIGHT), "white")
    draw = ImageDraw.Draw(image)
    line = lambda x0, y0, x1, y1, w=3: draw.line((x0 * MM, y0 * MM, x1 * MM, y1 * MM), fill=0, width=w)
    _text(draw, 52 * MM, 10 * MM, "บันทึกการพยาบาลผู้ป่วยหลังผ่าตัด", 46)
    draw.rectangle((15 * MM, 25 * MM, 195 * MM, 270 * MM), outline=0, width=4)
    # Row 1: name on a dotted leader | HN on an underline.
    line(105, 25, 105, 65)
    right = _text(draw, 18 * MM, 29 * MM, "ชื่อ-สกุล")
    _dots(draw, right + 2 * MM, 102 * MM, 37 * MM)
    right = _text(draw, 108 * MM, 29 * MM, "HN")
    line(right / MM + 3, 37, 190, 37, 2)
    line(15, 45, 195, 45)
    # Row 2: weight ___ kg | age ___ years.
    right = _text(draw, 18 * MM, 49 * MM, "น้ำหนัก")
    line(right / MM + 3, 57, 70, 57, 2)
    _text(draw, 72 * MM, 49 * MM, "กก.")
    right = _text(draw, 108 * MM, 49 * MM, "อายุ")
    line(right / MM + 3, 57, 160, 57, 2)
    _text(draw, 162 * MM, 49 * MM, "ปี")
    line(15, 65, 195, 65)
    # Row 3: an empty box to write the diagnosis in.
    _text(draw, 18 * MM, 67 * MM, "การวินิจฉัย")
    line(15, 95, 195, 95)
    # Row 4: a chart over time: names of rows, an axis and a legend before a lattice of small squares.
    for y in (102, 109, 116, 123, 130):
        line(15, y, 55, y)
    line(55, 95, 55, 160)
    line(40, 130, 40, 160)
    for k in range(29):
        line(55 + 5 * k, 95, 55 + 5 * k, 160, 2)
    for y in (102, 109, 116, 123, 130, 135, 140, 145, 150, 155):
        line(55, y, 195, y, 2)
    line(15, 160, 195, 160)
    _text(draw, 18 * MM, 96 * MM, "เวลา", 26)
    for y, name in ((103, "ชีพจร"), (110, "ความดันโลหิต"), (117, "SpO2")):
        _text(draw, 18 * MM, y * MM, name, 26)
    for y, value in ((131, "200"), (138, "150"), (145, "100"), (152, "50")):
        _text(draw, 43 * MM, y * MM, value, 24)
    _text(draw, 18 * MM, 134 * MM, "BP", 26)
    _text(draw, 18 * MM, 144 * MM, "ชีพจร", 26)
    # Row 5: a ruled table: column names, then empty rows.
    for y in (168, 175, 182):
        line(15, y, 195, y, 2)
    line(105, 160, 105, 189, 2)
    line(150, 160, 150, 189, 2)
    line(15, 189, 195, 189)
    for x, name in ((18, "ยาที่ได้รับ"), (108, "ขนาด"), (153, "เวลาที่ให้")):
        _text(draw, x * MM, 161 * MM, name, 28)
    # Row 6: checkboxes, and options printed to be circled.
    _text(draw, 18 * MM, 194 * MM, "แพ้ยา")
    for index, (label, ticked) in enumerate((("ไม่มี", False), ("มี", True))):
        x = 45 * MM + index * 35 * MM
        draw.rectangle((x, 195 * MM, x + 5 * MM, 200 * MM), outline=0, width=3)
        if ticked:
            draw.line((x + 1 * MM, 197.5 * MM, x + 2.3 * MM, 199 * MM), fill=0, width=5)
            draw.line((x + 2.3 * MM, 199 * MM, x + 4.2 * MM, 195.8 * MM), fill=0, width=5)
        _text(draw, x + 7 * MM, 194 * MM, label)
    _text(draw, 18 * MM, 207 * MM, "ระดับความรู้สึกตัว : ตื่นดี / ซึม / หมดสติ")
    line(15, 220, 195, 220)
    # Row 7: the signature on a dotted leader.
    right = _text(draw, 18 * MM, 232 * MM, "ลงชื่อ")
    _dots(draw, right + 2 * MM, 110 * MM, 240 * MM)
    _text(draw, 112 * MM, 232 * MM, "ผู้บันทึก")
    # Row 8: a printed grid: the rows' names in the first column, a column per shift, empty cells to fill.
    line(15, 244, 195, 244)
    for y in (251, 259, 267):
        line(15, y, 195, y, 2)
    for x in (105, 135, 165):
        line(x, 244, x, 267, 2)
    for x, name in ((18, "การประเมิน"), (108, "เช้า"), (138, "บ่าย"), (168, "ดึก")):
        _text(draw, x * MM, 245 * MM, name, 26)
    for y, name in ((252, "ความปวด"), (260, "การหายใจ")):
        _text(draw, 18 * MM, y * MM, name, 26)
    _text(draw, 165 * MM, 275 * MM, "FM-NUR-012", 26)
    return image.rotate(-tilt, resample=Image.BICUBIC, fillcolor="white") if tilt else image


def as_pdf(image: Image.Image) -> bytes:
    """A scanned PDF: the page as a JPEG picture (as scanners make them), no text layer."""
    picture = io.BytesIO()
    image.convert("RGB").save(picture, format="JPEG", quality=80)
    buffer = io.BytesIO()
    Image.open(io.BytesIO(picture.getvalue())).save(buffer, format="PDF", resolution=DPI)
    return buffer.getvalue()


def billing_pdf() -> bytes:
    """A digital, filled-in checklist like a hospital's billing sheet (reportlab, vector, with a text layer): bold
    labels with regular answers (Age: 64 Y), two columns of category lists with a checkbox per item (drawn squares, one
    ticked) and a quantity column under a "list | Qty" header row, and signature boxes with the role under them."""
    import glob as _glob

    from reportlab.lib.pagesizes import A4
    from reportlab.pdfbase import pdfmetrics
    from reportlab.pdfbase.ttfonts import TTFont
    from reportlab.pdfgen import canvas

    regular = _glob.glob("/usr/share/fonts/truetype/noto/NotoSans-Regular.ttf")[0]
    pdfmetrics.registerFont(TTFont("Sans", regular))
    pdfmetrics.registerFont(TTFont("Sans-Bold", regular.replace("Regular", "Bold")))
    buffer = io.BytesIO()
    page = canvas.Canvas(buffer, pagesize=A4)
    height = A4[1]
    mm = 72 / 25.4
    y = lambda value: height - value * mm  # top-down millimetres

    def text(x: float, top: float, words: str, bold: bool = False, size: float = 6.5) -> float:
        page.setFont("Sans-Bold" if bold else "Sans", size)
        page.drawString(x * mm, y(top + size * 0.3), words)
        return x + pdfmetrics.stringWidth(words, "Sans-Bold" if bold else "Sans", size) / mm

    def cell(x0: float, top: float, x1: float, bottom: float) -> None:
        page.rect(x0 * mm, y(bottom), (x1 - x0) * mm, (bottom - top) * mm, stroke=1, fill=0)

    def field(x: float, top: float, label: str, answer: str = "") -> None:
        end = text(x, top, label, bold=True)
        if answer:
            text(end + 1, top, answer)

    page.setLineWidth(0.6)
    cell(10, 10, 200, 22)
    text(70, 13, "Anesthesia Check List (Billing)", bold=True, size=10)
    for x0, x1, label, answer in ((10, 50, "HN:", ""), (50, 90, "Age:", "64 Y"), (90, 140, "Gender:", "Female"), (140, 170, "WT:", "59.8 kg"),
                                  (170, 200, "HT:", "155 cm")):
        cell(x0, 22, x1, 30)
        field(x0 + 1, 24, label, answer)
    cell(10, 30, 200, 40)
    field(11, 32, "Post-OP Dx:")
    text(11, 36, "Spondylolisthesis L4-5")
    lists = [
        [("Gas / Inhalation", [("O2/AIR/N2O (hr)", "0", True), ("Desflurane (hr)", "", False), ("Sevoflurane (hr)", "", False)]),
         ("Narcotics", [("Fentanyl", "1", True), ("Morphine", "", False), ("Pethidine", "", False)])],
        [("Fluids", [("Water 10 ml", "1", True), ("0.9 NSS 100 ml", "", False), ("Acetar 1000 ml", "", False), ("Voluven", "", False)]),
         ("Other Equipment", [("Infusion pump", "", False), ("Syringe pump", "", False)])],
    ]
    for column, groups in enumerate(lists):
        x0 = 10 + column * 95
        x1, qty = x0 + 95, x0 + 80
        top = 42
        cell(x0, top, qty, top + 4)
        cell(qty, top, x1, top + 4)
        text(x0 + 35, top + 0.6, "list", bold=True, size=7)
        text(qty + 4, top + 0.6, "Qty", bold=True, size=7)
        top += 4
        for heading, items in groups:
            cell(x0, top, x1, top + 4)
            text(x0 + 0.5, top + 0.6, heading, bold=True, size=7)
            top += 4
            for name, amount, ticked in items:
                cell(x0, top, qty, top + 4)
                cell(qty, top, x1, top + 4)
                page.rect((x0 + 0.8) * mm, y(top + 3.2), 2.4 * mm, 2.4 * mm, stroke=1, fill=0)
                if ticked:
                    path = page.beginPath()
                    path.moveTo((x0 + 1.2) * mm, y(top + 2))
                    path.curveTo((x0 + 1.6) * mm, y(top + 2.6), (x0 + 1.9) * mm, y(top + 2.9), (x0 + 2.0) * mm, y(top + 2.9))
                    path.curveTo((x0 + 2.4) * mm, y(top + 2.2), (x0 + 2.8) * mm, y(top + 1.4), (x0 + 3.0) * mm, y(top + 1.1))
                    page.drawPath(path, stroke=1, fill=0)
                text(x0 + 4, top + 0.6, name)
                if amount:
                    text(qty + 6, top + 0.6, amount)
                top += 4
    for index, role in enumerate(("Surgeon", "Anesthesiologist", "Anesthesia nurse 1")):
        x0 = 10 + index * 50
        cell(x0, 250, x0 + 50, 270)
        text(x0 + 10, 258, "(                    )")
        text(x0 + 12, 264, role, bold=True)
    page.save()
    return buffer.getvalue()
