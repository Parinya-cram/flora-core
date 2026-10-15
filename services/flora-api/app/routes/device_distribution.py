"""Canopy admin passthrough to Haber for the Device Distribution console.

The hospital admin drives the Root -> Canopy -> node image rollout from inside the Canopy
app: see releases, mirror status, approvals and each node's applied version, then approve /
mirror / hold / force a Root sync. Every call proxies to Haber with the admin credentials
canopy-api already holds, so Haber's own Basic-auth page is never exposed to operators.
Canopy stays read-only on patient data; this only drives image distribution.
"""
from __future__ import annotations

import base64
import json
import os
import re
import urllib.error
import urllib.request
from typing import Any

from fastapi import APIRouter, Depends, HTTPException

from .fleet_control import require_admin

router = APIRouter(prefix="/api/fleet/distribution", tags=["canopy-distribution"],
                   dependencies=[Depends(require_admin)])

HABER_URL = os.getenv("FLORA_HABER_URL", "http://haber:8000").rstrip("/")
# Release ids and component names are reflected into the Haber URL path; keep them strict.
SAFE_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")
COMPONENTS = {"canopy", "leaf", "gateway"}


def _safe(value: str, what: str) -> str:
    if not SAFE_ID.match(value or ""):
        raise HTTPException(status_code=422, detail=f"invalid {what}")
    return value


def _haber(method: str, path: str, body: dict[str, Any] | None = None) -> Any:
    credentials = f"{os.getenv('HABER_ADMIN_USERNAME', 'admin')}:{os.getenv('HABER_ADMIN_PASSWORD', 'admin')}"
    data = json.dumps(body).encode() if body is not None else None
    headers = {"Authorization": "Basic " + base64.b64encode(credentials.encode()).decode(), "Accept": "application/json"}
    if data is not None:
        headers["Content-Type"] = "application/json"
    request = urllib.request.Request(f"{HABER_URL}{path}", data=data, method=method, headers=headers)
    try:
        with urllib.request.urlopen(request, timeout=15) as response:
            raw = response.read()
            return json.loads(raw) if raw else {}
    except urllib.error.HTTPError as error:
        detail = error.read(500).decode("utf-8", "replace").strip()
        code = error.code if error.code in {400, 401, 403, 404, 409, 422, 502, 503} else 502
        raise HTTPException(status_code=code, detail=f"Haber refused the request: {detail or error.reason}") from None
    except Exception as error:  # Haber unreachable
        raise HTTPException(status_code=503, detail=f"Cannot reach Haber ({type(error).__name__})") from None


@router.get("/overview")
def overview() -> Any:
    """Full rollout state: releases (channel, latest, mirror status, approvals), nodes (applied
    version per node), gateways, catalog, and Root sync status."""
    return _haber("GET", "/api/haber/v1/overview")


@router.post("/releases/{release_id}/approve")
def approve(release_id: str) -> Any:
    """Roll a mirrored release out (or roll back to it) for its component."""
    return _haber("POST", f"/api/haber/v1/releases/{_safe(release_id, 'release_id')}/approve")


@router.post("/releases/{release_id}/mirror")
def mirror(release_id: str) -> Any:
    """Retry / trigger the Root -> haber-registry image mirror for a release."""
    return _haber("POST", f"/api/haber/v1/releases/{_safe(release_id, 'release_id')}/mirror")


@router.post("/components/{component}/hold")
def hold(component: str) -> Any:
    """Clear a component's approval so its nodes freeze on the image they run now."""
    if component not in COMPONENTS:
        raise HTTPException(status_code=422, detail=f"component is one of {', '.join(sorted(COMPONENTS))}")
    return _haber("POST", f"/api/haber/v1/components/{component}/hold")


@router.post("/root-sync")
def root_sync() -> Any:
    """Pull the latest bundle + releases from Root now (instead of waiting for the poll)."""
    return _haber("POST", "/api/haber/v1/root/sync")
