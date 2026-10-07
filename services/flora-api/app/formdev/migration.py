"""Declarative, non-destructive record migration between schema versions.

Each schema version (v >= 2) may carry ``migration = {"from": v - 1, "ops": [...]}``.
Migration never discards a value: removed fields and values that cannot be converted
are moved into ``data["_retired"]``. Stored records are never rewritten by reading;
``RecordRepository.upgrade`` persists an upgrade and keeps the old revision.
The TypeScript twin is frontend/src/formdev/core/migrate.ts.
"""
from __future__ import annotations

import copy
import re
from typing import Any, Callable

from .definition import RETIRED_KEY, field_key, field_map, fields
from .errors import FormDevError

DECIMAL = re.compile(r"^-?\d+(\.\d+)?\Z")
INTEGER = re.compile(r"^-?\d+\Z")
_FAILED = object()


def _number_text(value: float | int) -> str:
    return str(int(value)) if float(value).is_integer() else repr(float(value))


def convert(value: Any, target: str) -> Any:
    """Convert one value or return the _FAILED sentinel. Rules mirror migrate.ts exactly."""
    if value is None:
        return None
    is_bool = isinstance(value, bool)
    is_num = isinstance(value, (int, float)) and not is_bool
    if target == "text":
        if isinstance(value, str):
            return value
        if is_bool:
            return "true" if value else "false"
        return _number_text(value) if is_num else _FAILED
    if target == "number":
        if is_num:
            return value
        if isinstance(value, str) and DECIMAL.match(value.strip()):
            number = float(value.strip())
            return int(number) if number.is_integer() else number
        return _FAILED
    if target == "integer":
        if is_num and float(value).is_integer():
            return int(value)
        if isinstance(value, str) and INTEGER.match(value.strip()):
            return int(value.strip())
        return _FAILED
    if target == "boolean":
        if is_bool:
            return value
        if value in ("true", "1", 1):
            return True
        if value in ("false", "0", 0):
            return False
        return _FAILED
    return _FAILED


def apply_ops(data: dict[str, Any], ops: list[dict[str, Any]]) -> dict[str, Any]:
    out = copy.deepcopy(data)
    retired: dict[str, Any] = dict(out.pop(RETIRED_KEY, None) or {})
    for op in ops:
        name = op["op"]
        if name == "rename_field":
            if op["from"] in out:
                out[op["to"]] = out.pop(op["from"])
        elif name == "add_field":
            if op["field"] not in out:
                out[op["field"]] = copy.deepcopy(op.get("default"))
        elif name == "remove_field":
            if op["field"] in out:
                retired[op["field"]] = out.pop(op["field"])
        elif name == "map_values":
            mapping = op["mapping"]
            if op["field"] in out:
                value = out[op["field"]]
                if isinstance(value, list):
                    out[op["field"]] = [mapping.get(item, item) if isinstance(item, str) else item for item in value]
                elif isinstance(value, str):
                    out[op["field"]] = mapping.get(value, value)
        elif name == "convert_type":
            if op["field"] in out:
                converted = convert(out[op["field"]], op["to"])
                if converted is _FAILED:
                    retired[op["field"]] = out[op["field"]]
                    out[op["field"]] = None
                else:
                    out[op["field"]] = converted
        else:
            raise FormDevError("invalid_migration", f"Unknown migration op '{name}'")
    if retired:
        out[RETIRED_KEY] = retired
    return out


def migrate(
    data: dict[str, Any],
    from_version: int,
    to_version: int,
    load_definition: Callable[[int], dict[str, Any]],
) -> dict[str, Any]:
    """Upgrade record data through every intermediate version (v1 -> v2 -> v3 ...)."""
    if to_version < from_version:
        raise FormDevError("downgrade_not_supported", "Records cannot be migrated to an older schema version")
    out = copy.deepcopy(data)
    for version in range(from_version + 1, to_version + 1):
        migration = load_definition(version).get("migration") or {"ops": []}
        out = apply_ops(out, migration["ops"])
    return out


# Types whose stored values are interchangeable without convert_type.
VALUE_FAMILY = {"text": "text", "textarea": "text", "select": "text", "radio": "text",
                "number": "number", "integer": "number", "decimal": "number", "calculated": "number",
                "checkbox": "boolean", "switch": "boolean"}


def compatibility_issues(previous: dict[str, Any], current: dict[str, Any]) -> list[str]:
    """Fields that would make old records unreadable unless the migration covers them."""
    migration = current.get("migration") or {"ops": []}
    renamed_from = {op["from"] for op in migration["ops"] if op["op"] == "rename_field"}
    removed = {op["field"] for op in migration["ops"] if op["op"] == "remove_field"}
    converted = {op["field"] for op in migration["ops"] if op["op"] == "convert_type"}
    renamed_to = {op["to"]: op["from"] for op in migration["ops"] if op["op"] == "rename_field"}
    old, new = field_map(previous), field_map(current)
    problems: list[str] = []
    for field_id in old:
        if field_id not in new and field_id not in renamed_from and field_id not in removed:
            problems.append(f"Field '{field_id}' was dropped without a rename_field or remove_field op")
    for field in fields(current):
        key = field_key(field)
        source_id = renamed_to.get(key, key)
        source = old.get(source_id)
        if source is None or key in converted:
            continue
        before = VALUE_FAMILY.get(source["type"], source["type"])
        after = VALUE_FAMILY.get(field["type"], field["type"])
        if before != after:
            problems.append(f"Field '{key}' changed type {source['type']} -> {field['type']} without convert_type")
    return problems
