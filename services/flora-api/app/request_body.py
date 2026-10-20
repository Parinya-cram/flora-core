"""Files sent as they are (the request body is the file), not as base64 inside JSON.

Base64 makes a file a third larger on the wire, and the server then holds the JSON text, the decoded string and the
bytes at once (about three copies). Here the body is read in chunks and refused as soon as it passes the limit (or at
once when Content-Length already says so), and is either kept as bytes or written straight to a file.
"""
from __future__ import annotations

import hashlib
import os
from pathlib import Path

from fastapi import HTTPException, Request


def _too_large(limit: int) -> HTTPException:
    return HTTPException(status_code=413, detail=f"files are limited to {limit // (1024 * 1024)} MB")


def _declared(request: Request, limit: int) -> None:
    length = request.headers.get("content-length")
    if length and length.isdigit() and int(length) > limit:
        raise _too_large(limit)


async def read_limited(request: Request, limit: int) -> bytes:
    """The whole body as bytes (at most limit)."""
    _declared(request, limit)
    chunks: list[bytes] = []
    size = 0
    async for chunk in request.stream():
        size += len(chunk)
        if size > limit:
            raise _too_large(limit)
        chunks.append(chunk)
    return b"".join(chunks)


async def save_limited(request: Request, limit: int, path: Path) -> tuple[int, str]:
    """The body written to path (at most limit): (size, sha256). Nothing is left behind when it is refused."""
    _declared(request, limit)
    digest = hashlib.sha256()
    size = 0
    partial = path.with_name(f"{path.name}.part")
    try:
        with open(partial, "wb") as out:
            async for chunk in request.stream():
                size += len(chunk)
                if size > limit:
                    raise _too_large(limit)
                digest.update(chunk)
                out.write(chunk)
        os.replace(partial, path)
    finally:
        partial.unlink(missing_ok=True)
    return size, digest.hexdigest()
