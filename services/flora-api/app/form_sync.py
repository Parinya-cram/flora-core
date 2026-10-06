"""Field-level merge for case forms edited on both a Leaf and Canopy (tablet).

A form is a flat dict of field values plus a dict of versions (epoch ms of the
last change per field). The newest version of each field wins; a field with a
version but no value was removed.
"""
import json
from typing import Any


def parse(value: Any) -> dict[str, Any]:
    if isinstance(value, dict):
        return value
    if isinstance(value, str) and value:
        try:
            parsed = json.loads(value)
            return parsed if isinstance(parsed, dict) else {}
        except (TypeError, ValueError):
            return {}
    return {}


def stamp_changes(old: dict[str, Any], new: dict[str, Any], versions: dict[str, Any], now: int,
                  keys: set[str] | None = None) -> dict[str, int]:
    """New versions after a local edit: only fields whose value actually changed get `now`.

    `keys` limits the comparison (a PATCH only touches its own keys); None compares
    every key of both dicts (a full replace, where missing keys were removed).
    """
    result = {key: int(value) for key, value in versions.items() if isinstance(value, (int, float))}
    for key in keys if keys is not None else set(old) | set(new):
        if old.get(key) != new.get(key) or (key in old) != (key in new):
            result[key] = now
    return result


def merge(local_values: dict[str, Any], local_versions: dict[str, Any],
          remote_values: dict[str, Any], remote_versions: dict[str, Any]) -> tuple[dict[str, Any], dict[str, int], bool]:
    """Merge two copies of a form. Returns (values, versions, changed_local)."""
    values = dict(local_values)
    versions = {key: int(value) for key, value in local_versions.items() if isinstance(value, (int, float))}
    changed = False
    for key in set(remote_values) | set(remote_versions):
        remote_version = int(remote_versions.get(key) or 0)
        local_version = int(versions.get(key) or 0)
        if remote_version <= local_version and (key in values or local_version):
            continue
        if remote_version < local_version:
            continue
        if key in remote_values:
            if values.get(key) != remote_values[key] or key not in values:
                values[key] = remote_values[key]
                changed = True
        elif key in values:
            values.pop(key)
            changed = True
        if remote_version:
            versions[key] = remote_version
    return values, versions, changed
