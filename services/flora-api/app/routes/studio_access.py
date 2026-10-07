"""Who may author in the Canopy studios (Form Studio, Report Studio, Workflow Studio).

Authoring is granted by the studio.manage permission (system_admin and clinical_admin by
default, see 0075-report-studio.sql), so other roles can be given it from the role master.
The legacy admin / system_admin session roles keep access for databases that predate it.
"""
from typing import Any

from fastapi import Depends, HTTPException

from .canopy_preferences import current_canopy_user

STUDIO_PERMISSION = "studio.manage"
LEGACY_ADMIN_ROLES = {"admin", "system_admin"}


def can_author(user: dict[str, Any]) -> bool:
    if str(user.get("role") or "").strip().lower() in LEGACY_ADMIN_ROLES:
        return True
    return STUDIO_PERMISSION in user.get("_permissions", []) or bool(LEGACY_ADMIN_ROLES & set(user.get("_role_codes", [])))


def require_studio_author(user: dict[str, Any] = Depends(current_canopy_user)) -> dict[str, Any]:
    if user.get("must_change_password"):
        raise HTTPException(status_code=403, detail="password change required")
    if not can_author(user):
        raise HTTPException(status_code=403, detail=f"{STUDIO_PERMISSION} permission required")
    return user
