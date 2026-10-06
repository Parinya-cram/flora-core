"""Copies release images from the Root registry into the hospital's Haber registry.

Images are copied by digest, manifest bytes unchanged, so `repo@sha256:…` means the
same thing in both registries. Every manifest and blob is hashed on the way in;
a digest the signed release names cannot be swapped for different content.
"""
from __future__ import annotations

import hashlib
import json
import tempfile
from typing import AsyncIterator
from urllib.parse import urljoin

import httpx

MANIFEST_TYPES = ", ".join([
    "application/vnd.oci.image.index.v1+json",
    "application/vnd.docker.distribution.manifest.list.v2+json",
    "application/vnd.oci.image.manifest.v1+json",
    "application/vnd.docker.distribution.manifest.v2+json",
])
CHUNK = 1 << 20


def sha256(data: bytes) -> str:
    return "sha256:" + hashlib.sha256(data).hexdigest()


class Mirror:
    def __init__(self, source: str, target: str) -> None:
        self.source = httpx.AsyncClient(base_url=source.rstrip("/"), timeout=60, follow_redirects=True)
        self.target = httpx.AsyncClient(base_url=target.rstrip("/"), timeout=60)

    async def close(self) -> None:
        await self.source.aclose()
        await self.target.aclose()

    async def has_manifest(self, repository: str, digest: str) -> bool:
        response = await self.target.head(f"/v2/{repository}/manifests/{digest}", headers={"accept": MANIFEST_TYPES})
        return response.status_code == 200

    async def copy(self, repository: str, digest: str) -> int:
        """Copies one image (or image index) by digest. Returns bytes transferred."""
        if await self.has_manifest(repository, digest):
            return 0
        response = await self.source.get(f"/v2/{repository}/manifests/{digest}", headers={"accept": MANIFEST_TYPES})
        response.raise_for_status()
        body = response.content
        if sha256(body) != digest:
            raise ValueError(f"{repository}: manifest does not match {digest}")
        document = json.loads(body)
        copied = 0
        if "manifests" in document:  # image index: copy every platform/attestation manifest first
            for child in document["manifests"]:
                copied += await self.copy(repository, child["digest"])
        else:
            for blob in [document["config"], *document.get("layers", [])]:
                copied += await self.copy_blob(repository, blob["digest"])
        media_type = document.get("mediaType") or response.headers["content-type"].split(";")[0]
        put = await self.target.put(f"/v2/{repository}/manifests/{digest}", content=body,
                                    headers={"content-type": media_type})
        put.raise_for_status()
        return copied + len(body)

    async def copy_blob(self, repository: str, digest: str) -> int:
        head = await self.target.head(f"/v2/{repository}/blobs/{digest}")
        if head.status_code == 200:
            return 0
        with tempfile.TemporaryFile() as spool:
            hasher, size = hashlib.sha256(), 0
            async with self.source.stream("GET", f"/v2/{repository}/blobs/{digest}") as response:
                response.raise_for_status()
                async for chunk in response.aiter_bytes(CHUNK):
                    hasher.update(chunk)
                    spool.write(chunk)
                    size += len(chunk)
            if "sha256:" + hasher.hexdigest() != digest:
                raise ValueError(f"{repository}: blob does not match {digest}")
            start = await self.target.post(f"/v2/{repository}/blobs/uploads/")
            start.raise_for_status()
            location = urljoin(str(self.target.base_url) + "/", start.headers["location"])
            separator = "&" if "?" in location else "?"
            spool.seek(0)

            async def body() -> AsyncIterator[bytes]:
                while chunk := spool.read(CHUNK):
                    yield chunk

            put = await self.target.put(f"{location}{separator}digest={digest}", content=body(),
                                        headers={"content-length": str(size), "content-type": "application/octet-stream"})
            put.raise_for_status()
        return size
