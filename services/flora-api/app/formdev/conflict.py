"""Conflict resolution strategies.

A conflict exists when a client's change was based on a version other than the one
the server holds. Resolvers receive all three sides of a 3-way merge:

- ``base``: the revision the client edited from (may be None if unknown)
- ``local``: the incoming change (data, status, updated_at)
- ``remote``: the current server record

Only last-write-wins is enabled. A field-level merge only has to implement
``resolve`` (merge fields changed on one side, fall back per field when both changed)
and register itself in ``RESOLVERS``; the sync service and storage need no changes.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Literal, Protocol


@dataclass(frozen=True)
class Resolution:
    winner: Literal["local", "remote"]
    reason: str
    data: dict[str, Any] | None = None
    details: dict[str, Any] = field(default_factory=dict)


class ConflictResolver(Protocol):
    name: str

    def resolve(self, base: dict[str, Any] | None, local: dict[str, Any], remote: dict[str, Any]) -> Resolution: ...


class LastWriteWins:
    """The edit with the later edit time wins; ties keep the server copy (deterministic)."""

    name = "last-write-wins"

    def resolve(self, base: dict[str, Any] | None, local: dict[str, Any], remote: dict[str, Any]) -> Resolution:
        if int(local["updated_at"]) > int(remote["updated_at"]):
            return Resolution("local", "local edit is newer", local.get("data"))
        return Resolution("remote", "server copy is newer or equal", remote.get("data"))


RESOLVERS: dict[str, type] = {LastWriteWins.name: LastWriteWins}


def resolver(name: str = LastWriteWins.name) -> ConflictResolver:
    try:
        return RESOLVERS[name]()
    except KeyError:
        raise ValueError(f"Unknown conflict strategy '{name}'") from None
