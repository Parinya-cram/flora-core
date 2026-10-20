"""Platform console API: manage Canopy accounts (hospitals). Platform administrators sign in with
account code "platform"; they manage accounts but never see any account's patients or settings
(their requests carry no account, so database connections point at an empty schema)."""
from __future__ import annotations

from typing import Any, Literal

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from .. import tenancy_provision as provision
from .auth_canopy import read_platform_token

router = APIRouter(prefix="/api/platform", tags=["platform"])


def _run(fn, *args, **kwargs):
    try:
        return fn(*args, **kwargs)
    except provision.ProvisionError as error:
        raise HTTPException(status_code=400, detail=str(error)) from None
    except ValueError as error:
        raise HTTPException(status_code=422, detail=str(error)) from None


@router.get("/me")
def me(admin: dict[str, Any] = Depends(read_platform_token)) -> dict[str, Any]:
    return {"username": admin["username"], "name": admin.get("name")}


@router.get("/accounts")
def accounts(admin: dict[str, Any] = Depends(read_platform_token)) -> dict[str, Any]:
    return {"rows": _run(provision.list_accounts), "bundle_files": len(provision.manifest())}


class AccountCreate(BaseModel):
    code: str = Field(min_length=2, max_length=31, pattern=r"^[a-z][a-z0-9_]{1,30}$")
    name: str = Field(min_length=1, max_length=160)
    admin_username: str = Field(default="admin", min_length=2, max_length=80)
    admin_password: str = Field(min_length=8, max_length=200)
    haber_url: str | None = Field(default=None, max_length=300)


@router.post("/accounts")
def create_account(payload: AccountCreate, admin: dict[str, Any] = Depends(read_platform_token)) -> dict[str, Any]:
    """Creates the schema and first administrator; the sync secret is returned this once."""
    return _run(provision.create_account, payload.code, payload.name, payload.admin_username, payload.admin_password,
                f"platform:{admin['username']}", payload.haber_url or None)


class AccountUpdate(BaseModel):
    name: str | None = Field(default=None, max_length=160)
    status: Literal["active", "suspended"] | None = None
    haber_url: str | None = Field(default=None, max_length=300)


@router.put("/accounts/{code}")
def update_account(code: str, payload: AccountUpdate, admin: dict[str, Any] = Depends(read_platform_token)) -> dict[str, Any]:
    _run(provision.update_account, code, f"platform:{admin['username']}", **payload.model_dump())
    return {"ok": True}


@router.post("/accounts/{code}/rotate-secret")
def rotate_secret(code: str, admin: dict[str, Any] = Depends(read_platform_token)) -> dict[str, Any]:
    return {"sync_secret": _run(provision.rotate_secret, code, f"platform:{admin['username']}")}


@router.post("/migrate")
def migrate(admin: dict[str, Any] = Depends(read_platform_token)) -> dict[str, Any]:
    return {"applied": _run(provision.migrate, None, f"platform:{admin['username']}")}
