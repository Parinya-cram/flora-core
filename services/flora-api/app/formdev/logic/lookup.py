"""Lookup-driven options and derived values (Phase 2.3). Twin: frontend/src/formdev/logic/lookup.ts.

Lookup entries are rows of text ({"province": "เชียงใหม่", "district": ...}). A field's `lookup` turns the rows
matching its `filter` into options; a `derive` copies one column of the first row matching its `match`.
A filter or match on an empty value matches nothing (no districts until a province is chosen).
"""
from __future__ import annotations

from typing import Any, Callable

Entries = list[dict[str, Any]]


def _blank(value: Any) -> bool:
    return value is None or value == "" or value == []


def _text(value: Any) -> str:
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, float) and value.is_integer():
        return str(int(value))
    return str(value)


def _matching(entries: Entries, pairs: Any, value_of: Callable[[str], Any]) -> Entries | None:
    """Rows whose columns equal the referenced field values; None when a referenced value is blank."""
    wanted: dict[str, str] = {}
    for column, key in (pairs.items() if isinstance(pairs, dict) else []):
        value = value_of(key) if isinstance(key, str) else None
        if _blank(value):
            return None
        wanted[column] = _text(value)
    return [entry for entry in entries if isinstance(entry, dict) and all(entry.get(column) == text for column, text in wanted.items())]


def lookup_options(entries: Entries, spec: dict[str, Any], value_of: Callable[[str], Any]) -> list[dict[str, str]]:
    """Distinct {value, label} options in row order."""
    rows = _matching(entries, spec.get("filter"), value_of)
    if rows is None:
        return []
    value_column = spec.get("value")
    label_column = spec.get("label") if isinstance(spec.get("label"), str) else value_column
    seen: set[str] = set()
    out: list[dict[str, str]] = []
    for entry in rows:
        value = entry.get(value_column)
        if isinstance(value, str) and value and value not in seen:
            seen.add(value)
            label = entry.get(label_column)
            out.append({"value": value, "label": label if isinstance(label, str) and label else value})
    return out


def derive_value(entries: Entries, spec: dict[str, Any], value_of: Callable[[str], Any]) -> Any:
    rows = _matching(entries, spec.get("match"), value_of)
    if not rows:
        return None
    value = rows[0].get(spec.get("column"))
    return value if isinstance(value, str) and value else None


def lookup_ids(definition: Any) -> set[str]:
    """Lookups a definition reads (repeat children included)."""
    from .model import build

    out: set[str] = set()
    for item in build(definition).fields:
        lookup, derive = item.field.get("lookup"), item.field.get("derive")
        if isinstance(lookup, dict) and isinstance(lookup.get("source"), str):
            out.add(lookup["source"])
        if isinstance(derive, dict) and isinstance(derive.get("lookup"), str):
            out.add(derive["lookup"])
    return out
