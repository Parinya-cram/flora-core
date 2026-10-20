"""Files uploaded to Form Studio once, as they are (POST /api/formdev/uploads; app/request_body.py), then used by id:
reading a document into a form (reading/jobs.py) and building a form with AI from documents (ai_builder.py).

A file is checked when it arrives (documents.inspect) and kept in a folder for two hours after it was last used, under
its SHA-256 and the author's name (one author never sees another's files; the same file uploaded twice is kept once).
Reading the same document again, for example with the AI turned on, needs no second upload.
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import tempfile
import time
from pathlib import Path
from typing import Any

from fastapi import HTTPException, Request
from fastapi.concurrency import run_in_threadpool

from ..request_body import save_limited
from . import documents
from .errors import FormDevError

MAX_FILE_BYTES = 30 * 1024 * 1024
MAX_OWNER_FILES = 40
MAX_OWNER_BYTES = 300 * 1024 * 1024
MAX_TOTAL_BYTES = int(os.environ.get("FLORA_UPLOAD_MAX_TOTAL_MB", "1024")) * 1024 * 1024  # all authors together
KEEP_S = 2 * 3600
UPLOAD_ID = re.compile(r"^[0-9a-f]{64}$")


def root() -> Path:
    folder = Path(os.environ.get("FLORA_UPLOAD_DIR") or Path(tempfile.gettempdir()) / "flora-formdev-uploads")
    folder.mkdir(parents=True, exist_ok=True)
    return folder


def owner_of(user: dict[str, Any]) -> str:
    return str(user.get("username") or user.get("id"))


def _folder(owner: str) -> Path:
    # The author's name is never part of a path as typed.
    folder = root() / hashlib.sha256(owner.encode("utf-8")).hexdigest()[:24]
    folder.mkdir(parents=True, exist_ok=True)
    return folder


def _sweep(now: float | None = None) -> None:
    now = now or time.time()
    for folder in root().iterdir():
        if not folder.is_dir():
            continue
        for path in folder.iterdir():
            try:
                if now - path.stat().st_mtime > KEEP_S:
                    path.unlink(missing_ok=True)
            except FileNotFoundError:
                pass
        if not any(folder.iterdir()):
            shutil.rmtree(folder, ignore_errors=True)


def _owned(folder: Path) -> list[Path]:
    return [path for path in folder.iterdir() if UPLOAD_ID.match(path.name)]


def _room(owner: str) -> Path:
    """The author's folder, when it has room for one more file."""
    _sweep()
    folder = _folder(owner)
    files = _owned(folder)
    if len(files) >= MAX_OWNER_FILES or sum(path.stat().st_size for path in files) >= MAX_OWNER_BYTES:
        raise FormDevError("too_many_uploads", "Too many uploaded files: remove some or wait a while (they are kept for two hours)", 429)
    if sum(path.stat().st_size for path in root().rglob("*") if path.is_file()) >= MAX_TOTAL_BYTES:
        raise FormDevError("too_many_uploads", "The server holds too many uploaded files right now: try again in a while", 429)
    return folder


def keep(owner: str, name: str, content: bytes) -> dict[str, Any]:
    """Bytes already in hand kept as an upload, as receive() keeps a request body: {upload, file, definition}."""
    if not content:
        raise FormDevError("invalid_request", "The file is empty", 422)
    if len(content) > MAX_FILE_BYTES:
        raise FormDevError("body_too_large", f"Files are limited to {MAX_FILE_BYTES // (1024 * 1024)} MB", 413)
    folder = _room(owner)
    sha256 = hashlib.sha256(content).hexdigest()
    partial = folder / f"incoming-{os.getpid()}-{time.monotonic_ns()}"
    partial.write_bytes(content)
    os.replace(partial, folder / sha256)
    return _inspect_saved(folder, sha256, len(content), name)


async def receive(request: Request, owner: str, name: str) -> dict[str, Any]:
    """The request body kept as an upload: its meta and the inspection of the file."""
    folder = _room(owner)
    incoming = folder / f"incoming-{os.getpid()}-{time.monotonic_ns()}"
    try:
        size, sha256 = await save_limited(request, MAX_FILE_BYTES, incoming)
        if not size:
            raise FormDevError("invalid_request", "The file is empty", 422)
        os.replace(incoming, folder / sha256)
    except HTTPException as error:  # larger than the limit
        raise FormDevError("body_too_large", str(error.detail), error.status_code) from None
    finally:
        incoming.unlink(missing_ok=True)
    return await run_in_threadpool(_inspect_saved, folder, sha256, size, name)


def _inspect_saved(folder: Path, sha256: str, size: int, name: str) -> dict[str, Any]:
    source = documents.inspect([documents.SourceFile(name=name.strip()[:documents.MAX_NAME] or "document", content=(folder / sha256).read_bytes())])[0]
    meta = {"id": sha256, "name": source.name, "size": size, "media_type": source.media_type, "kind": source.kind, "pages": source.pages,
            "uploaded_at": int(time.time() * 1000)}
    (folder / f"{sha256}.json").write_text(json.dumps(meta, ensure_ascii=False), encoding="utf-8")
    return {"upload": meta, "file": source.report(), "definition": source.definition}


def get(owner: str, upload_id: str) -> tuple[dict[str, Any], bytes]:
    """(meta, content) of an upload of this author; 404 when it is not (or no longer) kept."""
    if not UPLOAD_ID.match(upload_id or ""):
        raise FormDevError("invalid_request", "An upload id is a SHA-256", 422)
    folder = _folder(owner)
    path, meta_path = folder / upload_id, folder / f"{upload_id}.json"
    if not path.exists() or not meta_path.exists():
        raise FormDevError("upload_not_found", "The uploaded file is no longer kept (files are kept for two hours): add it again", 404)
    now = time.time()
    os.utime(path, (now, now))  # used: kept two more hours
    os.utime(meta_path, (now, now))
    return json.loads(meta_path.read_text(encoding="utf-8")), path.read_bytes()


def source(owner: str, upload_id: str) -> documents.SourceFile:
    meta, content = get(owner, upload_id)
    return documents.SourceFile(name=meta.get("name") or "document", content=content)


def remove(owner: str, upload_id: str) -> None:
    if not UPLOAD_ID.match(upload_id or ""):
        raise FormDevError("invalid_request", "An upload id is a SHA-256", 422)
    folder = _folder(owner)
    (folder / upload_id).unlink(missing_ok=True)
    (folder / f"{upload_id}.json").unlink(missing_ok=True)
