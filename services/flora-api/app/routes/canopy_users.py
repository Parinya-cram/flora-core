"""Canopy user, role and ward administration, plus the viewer's ward scope.

Changes made here stamp directory_version; Leafs pick them up on their next
sync (or immediately at sign-in).
"""
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Request
from psycopg import Connection

from .. import directory, ldap_auth
from ..database import connection
from . import auth_leaf
from .auth_leaf import (
    ActiveRequest, AdminPinRequest, PasswordResetRequest, UserAccessRequest, UserCreateRequest,
    UserWardsRequest, atomic, attach_entitlements, audit, managed_user,
)
from .canopy_preferences import current_canopy_user, require_canopy_permission
from .auth_canopy import verify_password


router = APIRouter(prefix="/api/auth", tags=["canopy users"])
account_manager = require_canopy_permission("account.manage")


def ward_scope(
    request: Request,
    user: dict[str, Any] = Depends(current_canopy_user),
) -> list[str] | None:
    """Ward keys the request may read; None means every ward (and unassigned Leafs).

    The client picks a ward with the `x-flora-ward` header; without it a user sees
    all wards they are assigned to.
    """
    allowed = None if directory.has_all_units(user) else [unit["key"] for unit in user.get("_units") or []]
    selected = request.headers.get("x-flora-ward", "").strip()
    if selected and selected.lower() != "all":
        if allowed is not None and selected not in allowed:
            raise HTTPException(status_code=403, detail="you are not assigned to this ward")
        return [selected]
    return allowed


@router.get("/wards")
def my_wards(user: dict = Depends(current_canopy_user), database: Connection = Depends(connection)) -> dict:
    rows = directory.ward_options(database)["rows"]
    all_units = directory.has_all_units(user)
    if not all_units:
        keys = {unit["key"] for unit in user.get("_units") or []}
        rows = [row for row in rows if row["key"] in keys]
    return {"allUnits": all_units, "rows": rows}


@router.get("/ward-options")
def ward_options(_: dict = Depends(account_manager), database: Connection = Depends(connection)) -> dict:
    return directory.ward_options(database)


@router.get("/ldap/status")
def ldap_status() -> dict:
    return {"enabled": ldap_auth.enabled(), "autoProvision": ldap_auth.enabled() and ldap_auth.auto_provision()}


@router.get("/roles")
def roles(_: dict = Depends(account_manager), database: Connection = Depends(connection)) -> dict:
    return auth_leaf.roles(_=_, database=database)


@router.get("/users")
def users(
    q: str = "",
    include_inactive: bool = True,
    _: dict = Depends(account_manager),
    database: Connection = Depends(connection),
) -> dict:
    return auth_leaf.users(q=q, include_inactive=include_inactive, _=_, database=database)


@router.post("/users")
def create_user(payload: UserCreateRequest, actor: dict = Depends(account_manager),
                database: Connection = Depends(connection)) -> dict:
    if payload.auth_source == "ldap" and not ldap_auth.enabled():
        raise HTTPException(status_code=400, detail="LDAP authentication is not enabled")
    # Canopy has no staff directory link; staff profiles live on each Leaf.
    return auth_leaf.create_user(payload=payload.model_copy(update={"staff_directory_id": None}),
                                 actor=actor, database=database)


@router.put("/users/{user_id}/access")
def update_user_access(user_id: int, payload: UserAccessRequest, actor: dict = Depends(account_manager),
                       database: Connection = Depends(connection)) -> dict:
    return auth_leaf.update_user_access(user_id=user_id, payload=payload, actor=actor, database=database)


@router.put("/users/{user_id}/active")
def set_active(user_id: int, payload: ActiveRequest, actor: dict = Depends(account_manager),
               database: Connection = Depends(connection)) -> dict:
    return auth_leaf.set_active(user_id=user_id, payload=payload, actor=actor, database=database)


@router.post("/users/{user_id}/reset-password")
def reset_password(user_id: int, payload: PasswordResetRequest, actor: dict = Depends(account_manager),
                   database: Connection = Depends(connection)) -> dict:
    return auth_leaf.reset_password(user_id=user_id, payload=payload, actor=actor, database=database)


@router.put("/users/{user_id}/wards")
def update_user_wards(user_id: int, payload: UserWardsRequest, actor: dict = Depends(account_manager),
                      database: Connection = Depends(connection)) -> dict:
    return auth_leaf.update_user_wards(user_id=user_id, payload=payload, actor=actor, database=database)


@router.put("/self/admin-pin")
@atomic
def set_admin_pin(payload: AdminPinRequest, user: dict = Depends(account_manager),
                  database: Connection = Depends(connection)) -> dict:
    """Administrators approve user changes made at a Leaf with this PIN."""
    row = database.execute("SELECT * FROM auth_user WHERE id=%s", (user["id"],)).fetchone()
    if row.get("auth_source") == "ldap":
        try:
            confirmed = ldap_auth.authenticate(row["username"], payload.current_password) is not None
        except ldap_auth.LdapUnavailable:
            raise HTTPException(status_code=503, detail="directory server unavailable") from None
    else:
        confirmed = verify_password(payload.current_password, row["password_salt"] or "", row["password_hash"] or "")
    if not confirmed:
        raise HTTPException(status_code=400, detail="current password is incorrect")
    directory.set_admin_pin(database, user["id"], (payload.pin or "").strip() or None)
    audit(database, "canopy.self.admin-pin", user, target=row, detail={"cleared": not payload.pin})
    row = attach_entitlements(database, database.execute("SELECT * FROM auth_user WHERE id=%s", (user["id"],)).fetchone())
    return {"user": auth_leaf.public_user(row), "row": managed_user(row)}
