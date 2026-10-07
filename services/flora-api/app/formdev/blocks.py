"""Repeatable sections and categories (Phase 2.7).

A section or category with `repeat: {key, min_items, max_items}` stores its fields as a list of items under
`key`, exactly like a repeat field. Every traversal sees it as that synthetic repeat field, so indexing,
queries, record validation and the logic engine need no special case. Twin: frontend/src/formdev/core/blocks.ts.
"""
from __future__ import annotations

from typing import Any


def repeat_key(block: dict[str, Any]) -> str | None:
    repeat = block.get("repeat")
    return repeat["key"] if isinstance(repeat, dict) and isinstance(repeat.get("key"), str) else None


def as_repeat_field(block: dict[str, Any]) -> dict[str, Any]:
    """The repeat field a repeatable section or category stands for."""
    repeat = block["repeat"]
    field: dict[str, Any] = {"id": repeat["key"], "key": repeat["key"], "type": "repeat", "label": block.get("title") or repeat["key"],
                             "fields": block.get("fields") if isinstance(block.get("fields"), list) else []}
    for bound in ("min_items", "max_items"):
        if bound in repeat:
            field[bound] = repeat[bound]
    for name in ("visibility", "permission"):
        if name in block:
            field[name] = block[name]
    return field


def block_fields(block: dict[str, Any]) -> Any:
    """The field list a section or category contributes to its scope."""
    return [as_repeat_field(block)] if repeat_key(block) else block.get("fields")


def section_field_lists(section: dict[str, Any]) -> list[Any]:
    """The field lists of a section in render order: its own fields, then each category's (Phase 2.0)."""
    lists = [block_fields(section)]
    lists.extend(block_fields(category) for category in section.get("categories") or [] if isinstance(category, dict))
    return lists
