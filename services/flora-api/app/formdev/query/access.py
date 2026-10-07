"""Who may do what. A Principal carries the RBAC role and permission codes resolved from the
database (never the stale role in the session token). Access lists in form policies are code
lists that match either a role code or a permission code."""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Iterable

ADMIN_ROLES = frozenset({"system_admin"})
QUERY_PERMISSION = "formdev.query"
EXPORT_PERMISSION = "formdev.export"
DIAGNOSTICS_PERMISSION = "formdev.diagnostics"
MANAGE_PERMISSION = "formdev.manage"


@dataclass(frozen=True)
class Principal:
    user_id: int | None
    username: str
    roles: tuple[str, ...] = ()
    permissions: tuple[str, ...] = ()
    extra: dict[str, Any] = field(default_factory=dict, compare=False, hash=False)

    @property
    def codes(self) -> frozenset[str]:
        return frozenset(self.roles) | frozenset(self.permissions)

    @property
    def is_admin(self) -> bool:
        return bool(ADMIN_ROLES & set(self.roles)) or MANAGE_PERMISSION in self.permissions

    def has(self, permission: str) -> bool:
        return self.is_admin or permission in self.permissions

    def allowed(self, codes: Iterable[str] | None) -> bool:
        """None = no restriction. Administrators pass every list."""
        if codes is None:
            return True
        return self.is_admin or bool(self.codes & set(codes))

    def scope_key(self) -> str:
        """Stable key of everything that can change what this principal may see (cache keys)."""
        return "|".join(sorted(self.codes))

    def as_dict(self) -> dict[str, Any]:
        return {"user_id": self.user_id, "username": self.username, "roles": list(self.roles), "permissions": list(self.permissions)}


def principal_from_dict(value: dict[str, Any]) -> Principal:
    return Principal(value.get("user_id"), str(value.get("username") or "unknown"), tuple(value.get("roles") or ()), tuple(value.get("permissions") or ()))
