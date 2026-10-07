"""Excel (.xlsx) result files for export and report jobs, written with the standard library only.

Rows are streamed into a deflated zip entry, so a large export never sits in memory. Strings are inline strings
(never formulas, so no spreadsheet formula injection), numbers and booleans keep their type, the first row is bold
and frozen as a header. Twin of frontend/src/formdev/core/xlsx.ts (writer part).
"""
from __future__ import annotations

import math
import re
import zipfile
from collections.abc import Iterable
from pathlib import Path
from typing import Any

MEDIA_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
MAX_ROWS = 1_048_576  # Excel's sheet limit
_ILLEGAL = re.compile("[\x00-\x08\x0b\x0c\x0e-\x1f]")
_NS = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"'
_REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"


def _escape(text: str) -> str:
    return _ILLEGAL.sub("", text).replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;").replace('"', "&quot;")


def column_name(index: int) -> str:
    name = ""
    n = index + 1
    while n > 0:
        n, rest = divmod(n - 1, 26)
        name = chr(65 + rest) + name
    return name


def _cell(ref: str, value: Any, style: str) -> str:
    if value is None or value == "":
        return ""
    if isinstance(value, bool):
        return f'<c r="{ref}"{style} t="b"><v>{int(value)}</v></c>'
    if isinstance(value, (int, float)) and not (isinstance(value, float) and not math.isfinite(value)):
        return f'<c r="{ref}"{style}><v>{value!r}</v></c>' if isinstance(value, float) else f'<c r="{ref}"{style}><v>{value}</v></c>'
    if isinstance(value, list):
        value = ", ".join("" if item is None else str(item) for item in value)
    return f'<c r="{ref}"{style} t="inlineStr"><is><t xml:space="preserve">{_escape(str(value))}</t></is></c>'


def sheet_name(name: str) -> str:
    cleaned = re.sub(r"[\[\]:*?/\\]", " ", name).strip()[:31]
    return cleaned or "Sheet1"


def write_xlsx(path: str | Path, name: str, rows: Iterable[list[Any]], header_rows: int = 1) -> int:
    """Write one sheet; returns the number of rows written. Rows beyond Excel's limit raise ValueError."""
    count = 0
    with zipfile.ZipFile(path, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=6) as archive:
        archive.writestr("[Content_Types].xml", '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
                         '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>'
                         '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'
                         '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>'
                         '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>')
        archive.writestr("_rels/.rels", '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
                         f'<Relationship Id="rId1" Type="{_REL}/officeDocument" Target="xl/workbook.xml"/></Relationships>')
        archive.writestr("xl/workbook.xml", f'<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook {_NS} xmlns:r="{_REL}"><sheets>'
                         f'<sheet name="{_escape(sheet_name(name))}" sheetId="1" r:id="rId1"/></sheets></workbook>')
        archive.writestr("xl/_rels/workbook.xml.rels", '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
                         f'<Relationship Id="rId1" Type="{_REL}/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="{_REL}/styles" Target="styles.xml"/></Relationships>')
        archive.writestr("xl/styles.xml", f'<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet {_NS}><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font>'
                         '<font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>'
                         '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>'
                         '<cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs>'
                         '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>')
        with archive.open("xl/worksheets/sheet1.xml", "w", force_zip64=True) as sheet:
            frozen = (f'<sheetViews><sheetView workbookViewId="0"><pane ySplit="{header_rows}" topLeftCell="A{header_rows + 1}" activePane="bottomLeft" state="frozen"/>'
                      '</sheetView></sheetViews>') if header_rows else ""
            sheet.write(f'<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet {_NS}>{frozen}<sheetData>'.encode())
            for row in rows:
                count += 1
                if count > MAX_ROWS:
                    raise ValueError("more rows than an Excel sheet holds")
                style = ' s="1"' if count <= header_rows else ""
                cells = "".join(_cell(f"{column_name(index)}{count}", value, style) for index, value in enumerate(row))
                sheet.write(f'<row r="{count}">{cells}</row>'.encode())
            sheet.write(b"</sheetData></worksheet>")
    return count
