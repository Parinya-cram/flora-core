"""Attachments (data layer: File storage): the bytes behind file and image fields.

A file value in a record is {name, mime, size, ref}; ref "att:<sha256>" points at content stored here. Content
is addressed by its SHA-256, so an upload is idempotent, the server can verify it, and the same file attached
twice is stored once. Two stores share one interface:

* DatabaseAttachmentStore: the formdev_attachment table (PostgreSQL bytea / SQLite blob), the default;
* FileAttachmentStore: a directory (FORMDEV_ATTACHMENT_DIR), files sharded by hash with a small JSON sidecar.

Clients upload before syncing the record that uses a file; a record that references an attachment the store
does not have is refused (attachment_missing). Downloads go through a record the caller may read.
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import tempfile
import time
from abc import ABC, abstractmethod
from pathlib import Path
from typing import Any, Iterator

from .adapters.base import DataAdapter
from .definition import Issue
from .errors import FormDevError

REF = re.compile(r"^att:([0-9a-f]{64})\Z")
SHA = re.compile(r"^[0-9a-f]{64}\Z")
MEDIA_TYPE = re.compile(r"^[a-z0-9][a-z0-9!#$&^_.+-]{0,126}/[a-z0-9][a-z0-9!#$&^_.+-]{0,126}\Z")
MAX_BYTES = int(os.getenv("FORMDEV_ATTACHMENT_MAX_BYTES", str(25 * 1024 * 1024)))
# Shown in the browser; everything else (including SVG, which can carry scripts) is downloaded.
INLINE_TYPES = {"image/png", "image/jpeg", "image/gif", "image/webp", "application/pdf"}


def refs(value: Any, path: str = "$.data") -> Iterator[tuple[str, str, dict[str, Any]]]:
    """(path, sha256, file value) for every attachment reference in record data."""
    if isinstance(value, dict):
        ref = value.get("ref")
        if isinstance(ref, str) and (match := REF.match(ref)) and isinstance(value.get("name"), str):
            yield path, match.group(1), value
            return
        for key, inner in value.items():
            yield from refs(inner, f"{path}.{key}")
    elif isinstance(value, list):
        for index, inner in enumerate(value):
            yield from refs(inner, f"{path}[{index}]")


def check_upload(sha256: str, media_type: str, content: bytes) -> None:
    if not SHA.match(sha256):
        raise FormDevError("invalid_attachment", "The id is the file's SHA-256 in lowercase hex", 422)
    if not MEDIA_TYPE.match(media_type):
        raise FormDevError("invalid_attachment", "Content-Type must be a media type such as image/png", 422)
    if len(content) > MAX_BYTES:
        raise FormDevError("attachment_too_large", f"Attachments are limited to {MAX_BYTES} bytes", 413)
    if hashlib.sha256(content).hexdigest() != sha256:
        raise FormDevError("attachment_checksum", "The content does not match its SHA-256", 422)


class AttachmentStore(ABC):
    kind: str

    @abstractmethod
    def exists(self, sha256: str) -> bool: ...

    @abstractmethod
    def get(self, sha256: str) -> tuple[dict[str, Any], bytes] | None:
        """(metadata {sha256, media_type, size, created_at, created_by}, content), or None."""

    @abstractmethod
    def _save(self, meta: dict[str, Any], content: bytes) -> None: ...

    def put(self, sha256: str, media_type: str, content: bytes, user: str) -> dict[str, Any]:
        """Store verified content; storing it again is a no-op. Returns the metadata."""
        check_upload(sha256, media_type, content)
        existing = self.get(sha256)
        if existing is not None:
            return {**existing[0], "created": False}
        meta = {"sha256": sha256, "media_type": media_type, "size": len(content), "created_at": int(time.time() * 1000), "created_by": user}
        self._save(meta, content)
        return {**meta, "created": True}

    def missing(self, data: Any) -> list[Issue]:
        return [Issue(path, "attachment_missing", f"The file '{value['name']}' has not been uploaded")
                for path, sha, value in refs(data) if not self.exists(sha)]


class DatabaseAttachmentStore(AttachmentStore):
    kind = "database"

    def __init__(self, adapter: DataAdapter):
        self.adapter = adapter

    def exists(self, sha256: str) -> bool:
        return self.adapter.attachment_exists(sha256)

    def get(self, sha256: str) -> tuple[dict[str, Any], bytes] | None:
        row = self.adapter.get_attachment(sha256)
        if row is None:
            return None
        content = bytes(row.pop("content"))
        return row, content

    def _save(self, meta: dict[str, Any], content: bytes) -> None:
        with self.adapter.transaction():
            self.adapter.save_attachment({**meta, "content": content})


class FileAttachmentStore(AttachmentStore):
    """<root>/<ab>/<cd>/<sha256> plus <sha256>.json; written to a temporary file and renamed into place."""

    kind = "file"

    def __init__(self, root: str | Path):
        self.root = Path(root)

    def _path(self, sha256: str) -> Path:
        if not SHA.match(sha256):
            raise FormDevError("invalid_attachment", "Unknown attachment", 404)
        return self.root / sha256[:2] / sha256[2:4] / sha256

    def exists(self, sha256: str) -> bool:
        return SHA.match(sha256) is not None and self._path(sha256).is_file()

    def get(self, sha256: str) -> tuple[dict[str, Any], bytes] | None:
        if not self.exists(sha256):
            return None
        path = self._path(sha256)
        meta = json.loads(path.with_suffix(".json").read_text(encoding="utf-8"))
        return meta, path.read_bytes()

    def _save(self, meta: dict[str, Any], content: bytes) -> None:
        path = self._path(meta["sha256"])
        path.parent.mkdir(parents=True, exist_ok=True)
        for target, data in ((path.with_suffix(".json"), json.dumps(meta).encode("utf-8")), (path, content)):
            handle, temporary = tempfile.mkstemp(dir=path.parent)
            try:
                with os.fdopen(handle, "wb") as stream:
                    stream.write(data)
                    stream.flush()
                    os.fsync(stream.fileno())
                os.replace(temporary, target)
            except BaseException:
                Path(temporary).unlink(missing_ok=True)
                raise


def attachment_store(adapter: DataAdapter) -> AttachmentStore:
    """The configured store: a directory when FORMDEV_ATTACHMENT_DIR is set, otherwise the database."""
    root = os.getenv("FORMDEV_ATTACHMENT_DIR")
    return FileAttachmentStore(root) if root else DatabaseAttachmentStore(adapter)
