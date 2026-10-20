"""Source documents for the AI form builder (Form Studio): what each uploaded file is and what can be read from it.

Every file is checked before anything is sent to the AI service: the real type from its first bytes (not the name
or the browser's claim), the size and page limits, encrypted or damaged PDFs, scans without a text layer (read as
images), Word and Excel files (their text is extracted here, with the standard library only), plain text / CSV, and
JSON files that already are flora.form/1 definitions (checked with the validator, no AI needed). The report is shown
to the author; a file with status "error" stops the build.
"""
from __future__ import annotations

import hashlib
import io
import json
import re
import zipfile
from dataclasses import dataclass, field
from typing import Any
from xml.etree import ElementTree

MAX_FILES = 10
MAX_FILE_BYTES = 20 * 1024 * 1024
MAX_TOTAL_BYTES = 30 * 1024 * 1024
MAX_PDF_PAGES = 100
MAX_TEXT_CHARS = 200_000
MAX_PAGE_IMAGES = 40
# Word / Excel are zip archives of XML: what is read is limited after decompression (a 20 MB upload can expand to
# gigabytes), and XML with a DOCTYPE is refused (entity expansion, "billion laughs"; Office files never declare one).
MAX_UNZIPPED_BYTES = 60 * 1024 * 1024
MAX_PART_BYTES = 40 * 1024 * 1024
MAX_SHEET_COLUMNS = 200
MAX_SHEET_ROWS = 20_000
MAX_NAME = 200

IMAGE_TYPES = {"image/png", "image/jpeg", "image/gif", "image/webp"}
WORD_NS = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"
SHEET_NS = "{http://schemas.openxmlformats.org/spreadsheetml/2006/main}"
PAGE = re.compile(rb"/Type\s*/Page(?![a-zA-Z])")
# A JPEG image XObject (what phone scanners and most scan-to-PDF tools embed, one per page).
JPEG_OBJECT = re.compile(rb"<<(?:(?!>>).)*?/Subtype\s*/Image(?:(?!>>).)*?/Filter\s*\[?\s*/DCTDecode(?:(?!>>).)*?>>\s*stream\r?\n", re.S)
MIN_SCAN_IMAGE_BYTES = 10_000  # smaller JPEGs are logos and stamps, not pages


@dataclass
class SourceFile:
    """One uploaded file and what the inspection found."""

    name: str
    content: bytes
    kind: str = "unknown"  # pdf | image | docx | xlsx | text | form_json
    media_type: str = "application/octet-stream"
    status: str = "ok"  # ok | warning | error
    notes: list[str] = field(default_factory=list)
    pages: int | None = None
    text: str = ""  # extracted text (Word, Excel, text files)
    has_text_layer: bool | None = None
    definition: dict[str, Any] | None = None  # a flora.form/1 file
    page_images: list[bytes] = field(default_factory=list)  # PNG renderings of PDF pages (OpenAI-compatible hosts)
    duplicate: bool = False  # the same bytes as an earlier file: reported, not read or sent again
    scan_images: list[bytes] = field(default_factory=list)  # JPEG pages embedded in a scanned PDF

    @property
    def sha256(self) -> str:
        return hashlib.sha256(self.content).hexdigest()

    def note(self, status: str, message: str) -> None:
        self.notes.append(message)
        if status == "error" or (status == "warning" and self.status == "ok"):
            self.status = status

    def report(self) -> dict[str, Any]:
        return {"name": self.name, "kind": self.kind, "media_type": self.media_type, "size": len(self.content), "sha256": self.sha256,
                "status": self.status, "notes": self.notes, "pages": self.pages, "text_chars": len(self.text),
                "has_text_layer": self.has_text_layer, "page_images": len(self.page_images), "duplicate": self.duplicate,
                "scan_images": len(self.scan_images)}


class DocumentError(ValueError):
    """The request itself is unusable (no documents, too many, too large in total); shown to the author."""


def check_request(files: list[SourceFile]) -> list[SourceFile]:
    """The documents of one build (uploaded one by one: formdev/uploads.py), within the limits of one request."""
    if not files:
        raise DocumentError("Add at least one document")
    if len(files) > MAX_FILES:
        raise DocumentError(f"At most {MAX_FILES} documents at a time")
    if sum(len(source.content) for source in files) > MAX_TOTAL_BYTES:
        raise DocumentError(f"Documents are limited to {MAX_TOTAL_BYTES // (1024 * 1024)} MB in total")
    return files


def render_pages(content: bytes, max_pages: int, width_px: int = 1600) -> list[bytes]:
    """PNG pages of a PDF, for AI hosts that cannot read PDF files (rendered here: the browser sends only the file)."""
    import pypdfium2 as pdfium

    pages: list[bytes] = []
    document = pdfium.PdfDocument(content)
    try:
        for index in range(min(len(document), max_pages)):
            page = document[index]
            width_pt = page.get_size()[0] or 595
            image = page.render(scale=width_px / width_pt).to_pil().convert("RGB")
            out = io.BytesIO()
            image.save(out, "PNG", optimize=True)
            pages.append(out.getvalue())
    finally:
        document.close()
    return pages


def sniff(content: bytes) -> tuple[str, str]:
    """(kind, media type) from the file's first bytes."""
    head = content[:16]
    if head.startswith(b"%PDF-"):
        return "pdf", "application/pdf"
    if head.startswith(b"\x89PNG\r\n\x1a\n"):
        return "image", "image/png"
    if head.startswith(b"\xff\xd8\xff"):
        return "image", "image/jpeg"
    if head.startswith((b"GIF87a", b"GIF89a")):
        return "image", "image/gif"
    if head.startswith(b"RIFF") and content[8:12] == b"WEBP":
        return "image", "image/webp"
    if head.startswith(b"PK\x03\x04"):
        try:
            names = set(zipfile.ZipFile(io.BytesIO(content)).namelist())
        except zipfile.BadZipFile:
            return "unknown", "application/zip"
        if "word/document.xml" in names:
            return "docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
        if "xl/workbook.xml" in names:
            return "xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
        return "unknown", "application/zip"
    if head.startswith(b"\xd0\xcf\x11\xe0"):
        return "legacy_office", "application/msword"
    try:
        text = content.decode("utf-8-sig")
    except UnicodeDecodeError:
        return "unknown", "application/octet-stream"
    if "\x00" in text:
        return "unknown", "application/octet-stream"
    stripped = text.lstrip()
    if stripped.startswith("{"):
        return "form_json", "application/json"
    return "text", "text/plain"


def _pdf(source: SourceFile) -> None:
    content = source.content
    if b"/Encrypt" in content:
        source.note("error", "The PDF is password protected or encrypted; save an unprotected copy and upload that")
        return
    if b"%%EOF" not in content[-2048:]:
        source.note("warning", "The PDF looks cut short (no end marker); pages may be missing")
    source.pages = len(PAGE.findall(content)) or None
    if source.pages is None:
        source.note("warning", "The page count could not be read (compressed page tree); the AI reads the file as is")
    elif source.pages > MAX_PDF_PAGES:
        source.note("error", f"{source.pages} pages: at most {MAX_PDF_PAGES} pages per PDF")
    source.has_text_layer = b"/Font" in content
    if not source.has_text_layer:
        source.scan_images = scan_jpegs(content)[:MAX_PAGE_IMAGES]
        source.note("warning", "No text layer (a scan or a photo): the AI reads the page images, so check labels carefully")


def scan_jpegs(content: bytes) -> list[bytes]:
    """The JPEG page images of a scanned PDF, in file order (usually page order)."""
    images: list[bytes] = []
    for match in JPEG_OBJECT.finditer(content):
        length = re.search(rb"/Length\s+(\d+)(?!\s+\d+\s+R)", match.group(0))
        start = match.end()
        end = start + int(length.group(1)) if length else content.find(b"endstream", start)
        if end <= start or end > len(content):
            continue  # no length and no endstream: a cut-short file, not a picture
        data = content[start:end].rstrip(b"\r\n")
        if data.startswith(b"\xff\xd8") and len(data) >= MIN_SCAN_IMAGE_BYTES:
            images.append(data)
    return images


class ArchiveTooLarge(ValueError):
    pass


class _Archive:
    """A zip archive whose parts are read within MAX_PART_BYTES each and MAX_UNZIPPED_BYTES in total, as XML without
    a DOCTYPE (sizes come from the zip directory and are enforced again while reading)."""

    def __init__(self, content: bytes):
        self.zip = zipfile.ZipFile(io.BytesIO(content))
        self.read_total = 0

    def names(self) -> list[str]:
        return self.zip.namelist()

    def read(self, name: str) -> bytes:
        info = self.zip.getinfo(name)
        if info.file_size > MAX_PART_BYTES or self.read_total + info.file_size > MAX_UNZIPPED_BYTES:
            raise ArchiveTooLarge(name)
        with self.zip.open(info) as part:
            data = part.read(MAX_PART_BYTES + 1)
        self.read_total += len(data)
        if len(data) > MAX_PART_BYTES or self.read_total > MAX_UNZIPPED_BYTES:
            raise ArchiveTooLarge(name)
        return data

    def xml(self, name: str) -> ElementTree.Element:
        data = self.read(name)
        if b"<!DOCTYPE" in data[:4096].upper() or b"<!ENTITY" in data.upper():
            raise ElementTree.ParseError("DOCTYPE / ENTITY declarations are not read")
        return ElementTree.fromstring(data)


def _docx(source: SourceFile) -> None:
    try:
        archive = _Archive(source.content)
        root = archive.xml("word/document.xml")
    except ArchiveTooLarge:
        source.note("error", f"The Word file expands to more than {MAX_UNZIPPED_BYTES // (1024 * 1024)} MB of text; split it or save it as PDF")
        return
    except (zipfile.BadZipFile, KeyError, ElementTree.ParseError):
        source.note("error", "The Word file is damaged and cannot be read")
        return
    lines: list[str] = []
    body = root.find(f"{WORD_NS}body")
    for block in list(body) if body is not None else []:
        if block.tag == f"{WORD_NS}p":
            text = "".join(node.text or "" for node in block.iter(f"{WORD_NS}t")).strip()
            if text:
                lines.append(text)
        elif block.tag == f"{WORD_NS}tbl":
            lines.append("[table]")
            for row in block.iter(f"{WORD_NS}tr"):
                cells = ["".join(node.text or "" for node in cell.iter(f"{WORD_NS}t")).strip() for cell in row.iter(f"{WORD_NS}tc")]
                lines.append(" | ".join(cells))
            lines.append("[/table]")
    # Check boxes drawn as symbols (☐ ☑ ■ □) are kept in the text; images inside the document are not read.
    if any(name.startswith("word/media/") for name in archive.names()):
        source.note("warning", "The Word file contains pictures; only its text and tables are read")
    source.text = "\n".join(lines)


def _column_index(ref: str) -> int:
    letters = re.match(r"[A-Z]+", ref or "")
    number = 0
    for char in letters.group(0) if letters else "":
        number = number * 26 + ord(char) - 64
    return max(0, number - 1)


REL_NS = "{http://schemas.openxmlformats.org/officeDocument/2006/relationships}"
PACKAGE_REL_NS = "{http://schemas.openxmlformats.org/package/2006/relationships}"


def _sheet_parts(archive: _Archive) -> list[tuple[str, str]]:
    """(sheet name, part path) in workbook order: each <sheet r:id> resolved through xl/_rels/workbook.xml.rels."""
    workbook = archive.xml("xl/workbook.xml")
    targets: dict[str, str] = {}
    if "xl/_rels/workbook.xml.rels" in archive.names():
        for rel in archive.xml("xl/_rels/workbook.xml.rels").iter(f"{PACKAGE_REL_NS}Relationship"):
            target = (rel.get("Target") or "").lstrip("/")
            targets[rel.get("Id") or ""] = target if target.startswith("xl/") else f"xl/{target}"
    out: list[tuple[str, str]] = []
    for index, sheet in enumerate(workbook.iter(f"{SHEET_NS}sheet")):
        path = targets.get(sheet.get(f"{REL_NS}id") or "") or f"xl/worksheets/sheet{index + 1}.xml"
        if path in archive.names():
            out.append((sheet.get("name") or f"Sheet{index + 1}", path))
    return out


def _xlsx(source: SourceFile) -> None:
    clipped = False
    try:
        archive = _Archive(source.content)
        shared: list[str] = []
        if "xl/sharedStrings.xml" in archive.names():
            for item in archive.xml("xl/sharedStrings.xml").iter(f"{SHEET_NS}si"):
                shared.append("".join(node.text or "" for node in item.iter(f"{SHEET_NS}t")))
        lines: list[str] = []
        rows_read = 0
        for name, path in _sheet_parts(archive):
            lines.append(f"[sheet {name}]")
            for row in archive.xml(path).iter(f"{SHEET_NS}row"):
                rows_read += 1
                if rows_read > MAX_SHEET_ROWS:
                    clipped = True
                    break
                cells: dict[int, str] = {}
                for cell in row.iter(f"{SHEET_NS}c"):
                    column = _column_index(cell.get("r", ""))
                    if column >= MAX_SHEET_COLUMNS:
                        clipped = True
                        continue
                    value = cell.find(f"{SHEET_NS}v")
                    inline = cell.find(f"{SHEET_NS}is")
                    if cell.get("t") == "s" and value is not None and (value.text or "").isdigit():
                        text = shared[int(value.text)] if int(value.text) < len(shared) else ""
                    elif inline is not None:
                        text = "".join(node.text or "" for node in inline.iter(f"{SHEET_NS}t"))
                    else:
                        text = value.text if value is not None and value.text else ""
                    if text.strip():
                        cells[column] = text.strip()
                if cells:
                    lines.append(" | ".join(cells.get(column, "") for column in range(max(cells) + 1)))
            if rows_read > MAX_SHEET_ROWS:
                break
    except ArchiveTooLarge:
        source.note("error", f"The Excel file expands to more than {MAX_UNZIPPED_BYTES // (1024 * 1024)} MB; split it or save the form as PDF")
        return
    except (zipfile.BadZipFile, KeyError, ElementTree.ParseError, ValueError):
        source.note("error", "The Excel file is damaged and cannot be read")
        return
    if clipped:
        source.note("warning", f"Only the first {MAX_SHEET_COLUMNS} columns and {MAX_SHEET_ROWS:,} rows are read")
    source.text = "\n".join(lines)


def _form_json(source: SourceFile) -> None:
    from .definition import FORMAT, parse_json_strict

    value, issues = parse_json_strict(source.content.decode("utf-8-sig"))
    if any(issue.code == "invalid_json" for issue in issues):
        source.kind, source.media_type = "text", "text/plain"
        source.text = source.content.decode("utf-8-sig")
        return
    if isinstance(value, dict) and isinstance(value.get("definition"), dict):
        value = value["definition"]  # an API response or a template export
    if isinstance(value, dict) and value.get("format") == FORMAT:
        source.definition = value
        if issues:
            source.note("warning", "The JSON repeats a key; the last value of each repeated key is used")
        return
    source.kind, source.media_type = "text", "application/json"
    source.text = source.content.decode("utf-8-sig")


def inspect(files: list[SourceFile]) -> list[SourceFile]:
    """Fill in kind, media type, notes and extracted text for every file."""
    seen: set[str] = set()
    for source in files:
        source.kind, source.media_type = sniff(source.content)
        if not source.content:
            source.note("error", "The file is empty")
            continue
        if len(source.content) > MAX_FILE_BYTES:
            source.note("error", f"Larger than {MAX_FILE_BYTES // (1024 * 1024)} MB")
            continue
        if source.sha256 in seen:
            source.duplicate = True
            source.note("warning", "The same file was added twice; it is read once")
            continue
        seen.add(source.sha256)
        if source.kind == "pdf":
            _pdf(source)
        elif source.kind == "image":
            source.pages = 1
            if len(source.content) < 20_000:
                source.note("warning", "A small image: small print may be unreadable, use a scan of at least 150 dpi")
        elif source.kind == "docx":
            _docx(source)
        elif source.kind == "xlsx":
            _xlsx(source)
        elif source.kind == "form_json":
            _form_json(source)
        elif source.kind == "text":
            source.text = source.content.decode("utf-8-sig")
        elif source.kind == "legacy_office":
            source.note("error", "Old Word / Excel format (.doc / .xls): save it as .docx / .xlsx or PDF and upload that")
        else:
            source.note("error", "Unsupported file: use PDF, PNG / JPEG / WEBP / GIF, Word (.docx), Excel (.xlsx), text / CSV or a .form.json")
        if source.kind in {"docx", "xlsx", "text"} and source.status != "error":
            if not source.text.strip():
                source.note("error", "No text could be read from this file")
            elif len(source.text) > MAX_TEXT_CHARS:
                source.note("warning", f"Long text: only the first {MAX_TEXT_CHARS:,} characters are read")
                source.text = source.text[:MAX_TEXT_CHARS]
    definitions = [source for source in files if source.definition is not None]
    if definitions and len(definitions) != len(files):
        for source in definitions:
            source.note("warning", "A form definition next to other documents: the AI uses it as the starting point")
    return files


def summary(files: list[SourceFile]) -> dict[str, Any]:
    reports = [source.report() for source in files]
    return {"files": reports, "ok": all(report["status"] != "error" for report in reports),
            "errors": sum(report["status"] == "error" for report in reports),
            "warnings": sum(report["status"] == "warning" for report in reports)}


def dumps(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))
