"""Reading jobs: a document read page by page in the background, every step recorded as an event the screen polls
(GET …/jobs/{id}?after=n) and draws on the page as it arrives.

Jobs live in this process's memory only (at most MAX_JOBS, for KEEP_S): the document and what was read from it are
patient data and are not written anywhere unless the author keeps the result (a template, through the template
library, with the document as its source). A restart forgets running jobs; the screen says so.
"""
from __future__ import annotations

import contextvars
import contextvars
import io
import logging
import threading
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from typing import Any, Callable

from ... import ai_service
from . import assemble, draft, layout, ocr, pdf, preprocess, understand

log = logging.getLogger("flora.formdev.reading")
DPI = 200
MAX_DPI = 300
MAX_JOBS = 20
KEEP_S = 2 * 3600
MAX_PAGES = 40
LINES_PER_EVENT = 6

_jobs: dict[str, "Job"] = {}
_lock = threading.Lock()
_pool = ThreadPoolExecutor(max_workers=1, thread_name_prefix="reading")


class Cancelled(Exception):
    pass


class Job:
    def __init__(self, owner: str, name: str, content: bytes, options: dict[str, Any]):
        self.id = uuid.uuid4().hex
        self.owner = owner
        self.name = name
        self.content = content
        self.options = options
        self.status = "queued"
        self.created_at = time.time()
        self.updated_at = self.created_at
        self.events: list[dict[str, Any]] = []
        self.result: dict[str, Any] | None = None
        self.error: str | None = None
        self.cancel = False
        self.pages = 0
        self.usage = {"input_tokens": 0, "output_tokens": 0, "requests": 0}
        self._lock = threading.Lock()

    def emit(self, kind: str, page: int | None = None, **data: Any) -> None:
        if self.cancel:
            raise Cancelled()
        with self._lock:
            self.events.append({"seq": len(self.events) + 1, "at": int(time.time() * 1000), "kind": kind, "page": page, "data": data})
            self.updated_at = time.time()

    def public(self) -> dict[str, Any]:
        return {"id": self.id, "name": self.name, "status": self.status, "pages": self.pages, "error": self.error,
                "createdAt": int(self.created_at * 1000), "updatedAt": int(self.updated_at * 1000), "usage": self.usage,
                "options": {key: self.options.get(key) for key in ("ai", "mode", "title")}, "events": len(self.events)}

    def since(self, after: int) -> list[dict[str, Any]]:
        with self._lock:
            return self.events[after:]


def _forget_old() -> None:
    now = time.time()
    for job_id, job in list(_jobs.items()):
        if now - job.updated_at > KEEP_S and job.status not in ("queued", "running"):
            _jobs.pop(job_id, None)
    while len(_jobs) > MAX_JOBS:
        oldest = min(_jobs.values(), key=lambda job: job.updated_at)
        _jobs.pop(oldest.id, None)


def start(owner: str, name: str, content: bytes, options: dict[str, Any], ai_config: Callable[[], dict[str, Any]]) -> Job:
    job = Job(owner, name, content, options)
    with _lock:
        _forget_old()
        _jobs[job.id] = job
    # The request's context goes with the job: on a multi-account Canopy its account (app/tenancy.py) decides which
    # schema the job's connections see; without it they point at an empty schema.
    _pool.submit(contextvars.copy_context().run, _run, job, ai_config)
    # The request's context goes with the job: on a multi-account Canopy its account (app/tenancy.py) decides which
    # schema the job's connections see; without it they point at an empty schema.
    _pool.submit(contextvars.copy_context().run, _run, job, ai_config)
    return job


def get(job_id: str, owner: str) -> Job | None:
    job = _jobs.get(job_id)
    return job if job is not None and job.owner == owner else None


def _as_pdf(content: bytes) -> bytes:
    """A PNG / JPEG page becomes a one-page PDF (the same path as a scanned PDF)."""
    if content[:5] == b"%PDF-":
        return content
    from PIL import Image

    image = Image.open(io.BytesIO(content)).convert("RGB")
    buffer = io.BytesIO()
    image.save(buffer, format="PDF", resolution=DPI)
    return buffer.getvalue()


def _dpi(content: bytes, index: int) -> int:
    """A scan is read at its own resolution (200-300 dpi); a page of vector text at 200."""
    try:
        native = pdf.page_dpi(content, index)
    except Exception:  # noqa: BLE001 - a page pdfium cannot measure is read at the default
        native = None
    return max(DPI, min(MAX_DPI, native)) if native else DPI


def _shapes(evidence: dict[str, Any]) -> dict[str, Any]:
    """What the screen draws of a page's layout (ids and boxes only)."""
    return {"cells": [{"id": c["id"], "box": c["box"], "empty": c["empty"]} for c in evidence["cells"]],
            "grids": [{"id": g["id"], "box": g["box"], "rows": g["rows"], "cols": g["cols"]} for g in evidence["grids"]],
            "blanks": [{"id": b["id"], "box": b["box"], "kind": b["kind"]} for b in evidence["blanks"]],
            "checkboxes": [{"id": k["id"], "box": k["box"], "ticked": k["ticked"]} for k in evidence["checkboxes"]]}


def _plan_items(sections: list[dict[str, Any]], page: int) -> list[dict[str, Any]]:
    return [{key: item.get(key) for key in ("id", "kind", "type", "label", "label_en", "unit", "box", "source", "confidence", "unsure", "by",
                                            "fixed_from")}
            | {"options": [o["label"] for o in item.get("options") or []], "rows": [r["label"] for r in item.get("rows") or []],
               "columns": [c["label"] for c in item.get("columns") or []]}
            for section in sections for item in section["items"] if item.get("page", 0) == page]


def _run(job: Job, ai_config: Callable[[], dict[str, Any]]) -> None:
    """Read the document: per page its text (the PDF's own, else OCR), its layout (layout.py), then the plan of the
    form (understand.py), then, when asked, the AI's checked edits page by page (assemble.py), then the draft."""
    job.status = "running"
    try:
        content = _as_pdf(job.content)
        job.pages = min(pdf.page_count(content), MAX_PAGES)
        job.emit("started", pages=job.pages, ocr=ocr.available(), ai=bool(job.options.get("ai")))
        acroform: list[dict[str, Any]] = []
        try:
            acroform = pdf.form_fields(content)
            if acroform:
                job.emit("form_fields", count=len(acroform))
        except Exception as error:  # a damaged form dictionary: read the page instead
            log.info("form fields of %s not read: %s", job.id, error)
        ids = layout.Ids()
        pages: list[dict[str, Any]] = []
        evidence_pages: list[dict[str, Any]] = []
        images: dict[int, Any] = {}
        for index in range(job.pages):
            width, height = pdf.page_size(content, index)
            dpi = _dpi(content, index)
            job.emit("page", index, width_pt=round(width, 1), height_pt=round(height, 1), dpi=dpi)
            layer = pdf.text_layer(content, index)
            job.emit("text_layer", index, quality=layer["quality"], chars=layer["chars"], private_use=layer["private_use"])
            image = pdf.render(content, index, dpi)
            if layer["quality"] != "good":
                # A scan or photo: straightened and evened out first (a PDF's own text keeps the page as drawn).
                image, prepared = preprocess.prepare(image, dpi)
                job.emit("prepared", index, **prepared)
            images[index] = image
            if layer["quality"] == "good":
                lines, source = layer["lines"], "text_layer"
            elif ocr.available():
                job.emit("ocr_started", index)
                started = time.time()
                lines, source = ocr.read(image), "ocr"
                job.emit("ocr_done", index, lines=len(lines), seconds=round(time.time() - started, 2),
                         fixes=[fix for line in lines for fix in line.get("fixes") or []])
            else:
                lines, source = layer["lines"], "text_layer"
                job.emit("note", index, message="OCR is not installed on this server: only the PDF's own text is read")
            started = time.time()
            drawn = None
            if layer["quality"] == "good":
                try:
                    drawn = pdf.checkboxes(content, index)  # a digital PDF's own checkboxes: exact, ticks included
                except Exception as error:  # noqa: BLE001 - found in the image instead
                    log.info("drawn checkboxes of %s not read: %s", job.id, error)
            evidence = layout.analyse(image, dpi, lines, ids, index, drawn_checkboxes=drawn)
            for field in (f for f in acroform if f["page"] == index):
                evidence["blanks"].append({"id": ids("B"), "page": index, "kind": "form_field", "box": field["box"], "cell": None,
                                           "field_type": field["kind"], "name": field["name"], "options": field["options"]})
            evidence_pages.append(evidence)
            for start in range(0, len(evidence["lines"]), LINES_PER_EVENT):
                job.emit("lines", index, lines=[{key: line.get(key) for key in ("id", "box", "text", "score", "cell", "grid")}
                                                for line in evidence["lines"][start:start + LINES_PER_EVENT]])
            job.emit("layout", index, seconds=round(time.time() - started, 2), **_shapes(evidence))
            sizes = sorted(line["size"] for line in lines if line.get("size"))
            pages.append({"index": index, "width_pt": width, "height_pt": height, "dpi": dpi, "source": source, "quality": layer["quality"],
                          "lines": len(lines), "text_pt": sizes[len(sizes) // 2] if sizes else None})
        plan = understand.plan(evidence_pages)
        for evidence in evidence_pages:
            page_sections = [s for s in plan["sections"] if any(item.get("page", 0) == evidence["page"] for item in s["items"])]
            job.emit("plan", evidence["page"], items=_plan_items(page_sections, evidence["page"]),
                     coverage=assemble.coverage(evidence, page_sections, plan["ignored"]))
        ai_results: list[dict[str, Any]] = []
        if job.options.get("ai"):
            config = ai_config()
            if not ai_service.public(config)["configured"]:
                job.emit("note", message="The AI service is not set up (Canopy → AI service): the draft is from the tools only")
            else:
                for evidence in evidence_pages:
                    page_sections = [s for s in plan["sections"] if any(item.get("page", 0) == evidence["page"] for item in s["items"])]
                    if not page_sections:
                        continue
                    missed = assemble.coverage(evidence, page_sections, plan["ignored"])["missed"]
                    started = time.time()
                    try:
                        outcome = assemble.assemble_page(config, images[evidence["page"]], evidence, page_sections, plan["ignored"], missed, emit=job.emit)
                    except Cancelled:
                        raise
                    except Exception as error:  # the tools' plan stands for this page
                        job.emit("ai_failed", evidence["page"], message=str(error)[:300])
                        continue
                    for key in ("input_tokens", "output_tokens", "requests"):
                        job.usage[key] += outcome["usage"].get(key, 0)
                    if outcome.get("title") and evidence["page"] == 0:
                        plan["title"] = outcome["title"]
                    ai_results.append({"page": evidence["page"], **{key: outcome[key] for key in ("sent", "applied", "rejected", "coverage_before",
                                                                                                 "coverage_after", "asked_again")}})
                    job.emit("ai_done", evidence["page"], applied=len(outcome["applied"]), rejected=outcome["rejected"][:40],
                             changes=outcome["applied"][:80], coverage_before=outcome["coverage_before"], coverage_after=outcome["coverage_after"],
                             usage=outcome["usage"], seconds=round(time.time() - started, 1))
                    job.emit("plan", evidence["page"], items=_plan_items(page_sections, evidence["page"]), coverage=outcome["coverage_after"])
        result = draft.build(plan, job.options.get("title") or None, job.options.get("form_id") or None, pages)
        coverage = [assemble.coverage(evidence, [s for s in plan["sections"] if any(i.get("page", 0) == evidence["page"] for i in s["items"])],
                                      plan["ignored"]) for evidence in evidence_pages]
        job.result = {**result, "pages": pages, "evidence": [{"page": e["page"], "lines": e["lines"], **_shapes(e)} for e in evidence_pages],
                      "ignored": plan["ignored"], "coverage": coverage, "ai": ai_results, "usage": job.usage}
        job.emit("draft", fields=sum(len(section["fields"]) for section in result["definition"]["sections"]),
                 sections=len(result["definition"]["sections"]), issues=result["issues"],
                 coverage=[{key: value for key, value in c.items() if key != "missed"} | {"missed": len(c["missed"])} for c in coverage])
        job.status = "done"
        job.emit("done")
    except Cancelled:
        job.status = "cancelled"
    except Exception as error:
        log.exception("reading job %s failed", job.id)
        job.status = "failed"
        job.error = f"{type(error).__name__}: {error}"[:500]
        try:
            job.events.append({"seq": len(job.events) + 1, "at": int(time.time() * 1000), "kind": "failed", "page": None, "data": {"message": job.error}})
        except Exception:
            pass
    finally:
        job.content = b""  # the document is not kept once read


def start_ai(owner: str, name: str, options: dict[str, Any], ai_config: Callable[[], dict[str, Any]],
             validate: Callable[[dict[str, Any]], list[dict[str, Any]]]) -> Job:
    """An AI form job (the designer's AI panel): build from a description, or change the current form (only the
    selected fields when given). Watched like a reading job; its result is {definition, report, issues, usage}."""
    job = Job(owner, name, b"", {**options, "ai": True})
    with _lock:
        _forget_old()
        _jobs[job.id] = job
    _pool.submit(contextvars.copy_context().run, _run_ai, job, ai_config, validate)
    _pool.submit(contextvars.copy_context().run, _run_ai, job, ai_config, validate)
    return job


def _run_ai(job: Job, ai_config: Callable[[], dict[str, Any]], validate: Callable[[dict[str, Any]], list[dict[str, Any]]]) -> None:
    from .. import ai_builder

    job.status = "running"
    try:
        options = job.options
        job.emit("ai_started", mode=options.get("mode"), check=list(options.get("focus") or []), english=0)
        started = time.time()
        result = ai_builder.build(ai_config(), [], instructions=options.get("instructions") or "", form_id=options.get("form_id"),
                                  title=options.get("title"), validate=validate, start=options.get("start"), focus=options.get("focus"))
        job.usage = {key: result["usage"].get(key, 0) for key in ("input_tokens", "output_tokens", "requests")}
        job.emit("ai_done", changed=[], english=0, usage=job.usage, seconds=round(time.time() - started, 1), attempts=result["attempts"])
        definition = result["definition"]
        job.result = {"definition": definition, "report": result["report"], "issues": result["issues"], "provenance": {}, "candidates": [],
                      "pages": [], "refined": None, "usage": job.usage}
        job.emit("draft", fields=sum(len(section.get("fields") or []) for section in definition.get("sections") or []),
                 sections=len(definition.get("sections") or []), issues=result["issues"])
        job.status = "done"
        job.emit("done")
    except Cancelled:
        job.status = "cancelled"
    except Exception as error:
        log.info("AI job %s failed: %s", job.id, error)
        job.status = "failed"
        job.error = str(error)[:500]
        job.events.append({"seq": len(job.events) + 1, "at": int(time.time() * 1000), "kind": "failed", "page": None, "data": {"message": job.error}})

