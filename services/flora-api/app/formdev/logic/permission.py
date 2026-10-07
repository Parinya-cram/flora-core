"""Form, section, category and field permissions (Phase 2.8).

Codes are Flora's RBAC role (or permission) codes. For each action the innermost level that sets a list decides (field ->
group -> category -> section -> form); a level without the action inherits it, and nothing set anywhere means
allowed. Administrators pass everything. Twin: frontend/src/formdev/logic/permission.ts.
"""
from __future__ import annotations

from typing import Any, Iterable

from .model import FieldNode, build

OTHER_KEY = "_other"  # definition.OTHER_KEY
FIELD_ACTIONS = ("view", "edit", "export")
FORM_ACTIONS = ("view", "create", "edit", "delete", "export")


def effective(grants: list[Any], action: str) -> list[str] | None:
    """The innermost list set for `action`, or None (no restriction)."""
    for grant in reversed(grants):
        if isinstance(grant, dict) and isinstance(grant.get(action), list):
            return [code for code in grant[action] if isinstance(code, str)]
    return None


def _allowed(grants: list[Any], action: str, roles: set[str]) -> bool:
    codes = effective(grants, action)
    return codes is None or bool(roles & set(codes))


def access_lists(definition: Any) -> dict[str, Any]:
    """Access lists for the query catalog: {"form": {action: codes|None}, "fields": {key: {action: [lists]}}}.
    Every list in a field's action must allow the caller (edit and export also need view)."""
    permission = definition.get("permission") if isinstance(definition, dict) else None
    form = {action: effective([permission] if isinstance(permission, dict) else [], action) for action in FORM_ACTIONS}
    fields: dict[str, dict[str, list[list[str]]]] = {}
    for item in build(definition).fields:
        if "." in item.node:
            continue
        view = effective(item.permissions, "view")
        lists = {"view": [view] if view is not None else []}
        for action in ("edit", "export"):
            codes = effective(item.permissions, action)
            lists[action] = lists["view"] + ([codes] if codes is not None else [])
        fields[item.node] = lists
    return {"form": form, "fields": fields}


def form_allows(definition: Any, action: str, roles: Iterable[str], is_admin: bool = False) -> bool:
    if is_admin:
        return True
    permission = definition.get("permission") if isinstance(definition, dict) else None
    return _allowed([permission] if isinstance(permission, dict) else [], action, set(roles))


RECORD_ACTIONS = ("create", "edit", "delete")


def record_allows(definition: Any, action: str, roles: Iterable[str], is_admin: bool = False) -> bool:
    """May the roles create / edit / delete a record? Editing is allowed when at least one field is editable:
    fields inherit the form's `edit`, and a field-level grant (innermost wins) lets that role change that field."""
    if action != "edit":
        return form_allows(definition, action, roles, is_admin)
    granted = [item for node, item in field_permissions(definition, roles, is_admin).items() if "." not in node]
    return any(item["edit"] for item in granted) if granted else form_allows(definition, "edit", roles, is_admin)


def field_permissions(definition: Any, roles: Iterable[str], is_admin: bool = False) -> dict[str, dict[str, bool]]:
    """node ("bmi", "meds.dose") -> {view, edit, export}. Editing needs viewing, and a repeat can be edited only
    when every child in it can (items are added, removed and reordered as a whole)."""
    role_set = set(roles)
    out: dict[str, dict[str, bool]] = {}
    for item in build(definition).fields:
        out[item.node] = _field(item, role_set, is_admin)
    for node, granted in out.items():
        prefix = node + "."
        if granted["edit"] and any(not child["edit"] for name, child in out.items() if name.startswith(prefix)):
            granted["edit"] = False
    return out


def _field(item: FieldNode, roles: set[str], is_admin: bool) -> dict[str, bool]:
    if is_admin:
        return {action: True for action in FIELD_ACTIONS}
    view = _allowed(item.permissions, "view", roles)
    return {"view": view, "edit": view and _allowed(item.permissions, "edit", roles), "export": view and _allowed(item.permissions, "export", roles)}


def denied(definition: Any, action: str, roles: Iterable[str], is_admin: bool = False, nested: bool = False) -> set[str]:
    """Data keys the roles may not `action`: top-level keys (repeats as a whole), plus repeat children as
    "repeat.child" when `nested`."""
    return {node for node, granted in field_permissions(definition, roles, is_admin).items()
            if (nested or "." not in node) and not granted[action]}


def mask(data: Any, hidden: set[str]) -> Any:
    """Remove hidden keys ("bmi", or "meds.cost" inside each item) and their Other text."""
    if not hidden or not isinstance(data, dict):
        return data
    top = {key for key in hidden if "." not in key}
    children: dict[str, set[str]] = {}
    for key in hidden:
        if "." in key:
            parent, child = key.split(".", 1)
            children.setdefault(parent, set()).add(child)
    out: dict[str, Any] = {}
    for key, value in data.items():
        if key in top:
            continue
        if key == OTHER_KEY and isinstance(value, dict):
            value = {name: text for name, text in value.items() if name not in top}
        elif key in children and isinstance(value, list):
            value = [mask(item, children[key]) for item in value]
        out[key] = value
    return out
