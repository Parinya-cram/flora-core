"""Leaf: Canopy's Central Charting (multi-patient chart review) for the Leafs of this Leaf's ward.

Same paths as Canopy's `/api/fleet/...` so the web view is shared; read from Canopy over the sync channel."""
from __future__ import annotations

import os
import uuid
from typing import Any

from fastapi import APIRouter, Depends, Query

from .auth_leaf import require_permission

router = APIRouter(prefix="/api/fleet", tags=["central charting"])


def _body(**extra: Any) -> dict[str, Any]:
    return {"leaf_id": os.getenv("FLORA_LEAF_ID", ""), **extra}


@router.get("/icu-overview")
def icu_overview(limit_points: int = Query(default=30, ge=12, le=120),
                 _: dict = Depends(require_permission("case.read"))) -> dict[str, Any]:
    from .ward import canopy
    return canopy("POST", "/api/sync/v1/central/overview", _body(limit_points=limit_points))


@router.get("/cases/{global_case_id}/snapshot")
def case_snapshot(global_case_id: uuid.UUID, _: dict = Depends(require_permission("case.read"))) -> dict[str, Any]:
    from .ward import canopy
    return canopy("POST", f"/api/sync/v1/central/cases/{global_case_id}/snapshot", _body())
