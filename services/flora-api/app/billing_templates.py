"""Itemize (billing) templates: Workflow Studio's standing-order lists for the OR billing checklist.

Format `flora-billing-template/1`:
  {format, id, name, description,
   groups: [{key, name, items: [{code, qty?, preselect?, standing?}]}],   # order = display order on the Leaf
   allow_other_items: bool}                                      # Leaf may add items from the whole master

`standing: true` (ICU daily billing, app/billing_periods.py): the item is added once per billing day
with `qty` (default 1). When a template marks no item standing, every active master item whose
charge_basis is per_day / per_device_day is standing.

Items are billing_item codes (master data owned by Canopy). A workflow names one template in
`definition.billing.template_id`; any number of workflows may share it. Leafs receive the
published copy with the ward's workflows and show it on the Billing screen; preselected items
start ticked with their quantity, like a standing order.
"""
from __future__ import annotations

import re
from typing import Any

from psycopg import Connection

FORMAT = "flora-billing-template/1"
TEMPLATE_ID = re.compile(r"^[a-z][a-z0-9_]{1,63}\Z")
GROUP_KEY = re.compile(r"^[a-z0-9_-]{1,40}\Z")


def normalize(definition: dict[str, Any]) -> dict[str, Any]:
    groups = []
    for index, group in enumerate(definition.get("groups") or []):
        if not isinstance(group, dict):
            continue
        items = []
        for item in group.get("items") or []:
            if not isinstance(item, dict) or not item.get("code"):
                continue
            entry: dict[str, Any] = {"code": str(item["code"]).strip()}
            qty = item.get("qty")
            if qty not in (None, ""):
                try:
                    entry["qty"] = round(float(qty), 2)
                except (TypeError, ValueError):
                    entry["qty"] = qty  # reported by validate
            if item.get("preselect"):
                entry["preselect"] = True
            if item.get("standing"):
                entry["standing"] = True
            items.append(entry)
        groups.append({"key": str(group.get("key") or f"g{index + 1}").strip().lower(),
                       "name": str(group.get("name") or "").strip(), "items": items})
    return {
        "format": FORMAT, "id": definition.get("id"), "name": str(definition.get("name") or "").strip(),
        "description": str(definition.get("description") or ""), "groups": groups,
        "allow_other_items": bool(definition.get("allow_other_items", True)),
    }


def structural_issues(definition: Any) -> list[dict[str, str]]:
    if not isinstance(definition, dict):
        return [{"path": "$", "message": "definition must be an object"}]
    issues = []
    if definition.get("format", FORMAT) != FORMAT:
        issues.append({"path": "$.format", "message": f"format must be {FORMAT}"})
    if not isinstance(definition.get("id"), str) or not TEMPLATE_ID.match(definition["id"]):
        issues.append({"path": "$.id", "message": "id must match ^[a-z][a-z0-9_]{1,63}$"})
    if "groups" in definition and not isinstance(definition["groups"], list):
        issues.append({"path": "$.groups", "message": "groups must be a list"})
    return issues


def validate(database: Connection, definition: Any) -> list[dict[str, str]]:
    """Everything that blocks publishing (empty = publishable)."""
    issues = structural_issues(definition)
    if issues:
        return issues
    template = normalize(definition)
    if not template["name"]:
        issues.append({"path": "$.name", "message": "name is required"})
    if not template["groups"]:
        issues.append({"path": "$.groups", "message": "add at least one group"})
    known = {row["code"]: row for row in database.execute("SELECT code, is_active, qty_mode FROM billing_item").fetchall()}
    keys: set[str] = set()
    codes: set[str] = set()
    for g, group in enumerate(template["groups"]):
        path = f"$.groups[{g}]"
        if not GROUP_KEY.match(group["key"]):
            issues.append({"path": f"{path}.key", "message": "group key must be 1-40 of a-z, 0-9, _ or -"})
        if group["key"] in keys:
            issues.append({"path": f"{path}.key", "message": f"group '{group['key']}' is listed twice"})
        keys.add(group["key"])
        if not group["name"]:
            issues.append({"path": f"{path}.name", "message": "group name is required"})
        if not group["items"]:
            issues.append({"path": f"{path}.items", "message": f"group '{group['name'] or group['key']}' has no items"})
        for i, item in enumerate(group["items"]):
            code = item["code"]
            if code not in known:
                issues.append({"path": f"{path}.items[{i}]", "message": f"item '{code}' is not in the billing master"})
            elif not known[code]["is_active"]:
                issues.append({"path": f"{path}.items[{i}]", "message": f"item '{code}' is inactive in the billing master"})
            if code in codes:
                issues.append({"path": f"{path}.items[{i}]", "message": f"item '{code}' appears twice"})
            codes.add(code)
            qty = item.get("qty")
            if qty is not None and (not isinstance(qty, (int, float)) or qty < 0 or qty > 100000):
                issues.append({"path": f"{path}.items[{i}].qty", "message": "qty must be a number of 0 or more"})
    return issues


def published(database: Connection, template_ids: list[str]) -> dict[str, dict[str, Any]]:
    """{id: {definition, updated_at}} of published templates (for the ward exchange)."""
    if not template_ids or database.execute("SELECT to_regclass('canopy_billing_template') AS t").fetchone()["t"] is None:
        return {}
    rows = database.execute(
        """SELECT id, published_definition, updated_at FROM canopy_billing_template
           WHERE id = ANY(%s) AND status <> 'archived' AND published_definition IS NOT NULL""", (template_ids,)).fetchall()
    return {row["id"]: {"definition": row["published_definition"], "updated_at": int(row["updated_at"])} for row in rows}


def template_id_of(workflow: dict[str, Any] | None) -> str | None:
    billing = (workflow or {}).get("billing")
    value = billing.get("template_id") if isinstance(billing, dict) else None
    return value if isinstance(value, str) and value else None
