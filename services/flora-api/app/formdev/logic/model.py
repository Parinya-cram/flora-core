"""Compiled view of a definition for the logic engine (Phase 2): every field with its data path, scope,
the visibility conditions that apply to it, and the dependency edges between fields.

Shared by the definition validator (cycle checks) and the record evaluator (evaluation order), so both see
the same graph. Defensive: malformed parts are skipped (the validator reports them separately).
Twin: frontend/src/formdev/logic/model.ts.
"""
from __future__ import annotations

from dataclasses import dataclass, field as dataclass_field
from typing import Any, Iterator

from ..blocks import as_repeat_field, repeat_key
from .formula import FormulaError, parse, references
from .graph import evaluation_order, find_cycles


@dataclass
class Scope:
    """A data scope: the form (prefix "") or one repeat's items (prefix "meds.")."""
    prefix: str = ""
    parent: "Scope | None" = None
    keys: set[str] = dataclass_field(default_factory=set)
    repeats: dict[str, "Scope"] = dataclass_field(default_factory=dict)

    def find(self, key: str) -> str | None:
        """Node path of a key as seen from this scope (item first, then outwards); None when unknown.
        "meds.dose" names a repeat column."""
        head, _, tail = key.partition(".")
        scope: Scope | None = self
        while scope is not None:
            if tail:
                child = scope.repeats.get(head)
                if child is not None and tail in child.keys:
                    return f"{scope.prefix}{key}"
            elif key in scope.keys:
                return f"{scope.prefix}{key}"
            scope = scope.parent
        return None


@dataclass
class FieldNode:
    node: str
    key: str
    field: dict[str, Any]
    scope: Scope
    path: str  # definition path, for messages
    conditions: list[Any]  # visibility conditions of the section, category, groups and the field itself
    permissions: list[Any] = dataclass_field(default_factory=list)  # permission objects, outermost (form) first


@dataclass
class Model:
    top: Scope
    fields: list[FieldNode]
    calculators: dict[str, str]  # id -> formula
    calculator_defs: dict[str, dict[str, Any]] = dataclass_field(default_factory=dict)  # id -> full definition

    def by_node(self) -> dict[str, FieldNode]:
        return {item.node: item for item in self.fields}


def _key(field: dict[str, Any]) -> Any:
    return field["key"] if "key" in field else field.get("id")


def _permission(holder: dict[str, Any]) -> list[Any]:
    return [holder["permission"]] if isinstance(holder.get("permission"), dict) else []


def _condition(holder: dict[str, Any]) -> list[Any]:
    visibility = holder.get("visibility")
    return [visibility["when"]] if isinstance(visibility, dict) and "when" in visibility else []


def build(definition: Any) -> Model:
    top = Scope()
    out: list[FieldNode] = []
    calculators: dict[str, str] = {}
    calculator_defs: dict[str, dict[str, Any]] = {}
    if isinstance(definition, dict) and isinstance(definition.get("calculators"), list):
        for item in definition["calculators"]:
            if isinstance(item, dict) and isinstance(item.get("id"), str) and isinstance(item.get("formula"), str):
                calculators[item["id"]] = item["formula"]
                calculator_defs[item["id"]] = item

    def walk_fields(field_list: Any, path: str, scope: Scope, conditions: list[Any], grants: list[Any]) -> None:
        for index, field in enumerate(field_list if isinstance(field_list, list) else []):
            if not isinstance(field, dict):
                continue
            field_path = f"{path}[{index}]"
            own = conditions + _condition(field)
            own_grants = grants + _permission(field)
            if field.get("type") == "group":
                walk_fields(field.get("fields"), f"{field_path}.fields", scope, own, own_grants)
                continue
            key = _key(field)
            if not isinstance(key, str):
                continue
            scope.keys.add(key)
            out.append(FieldNode(f"{scope.prefix}{key}", key, field, scope, field_path, own, own_grants))
            if field.get("type") == "repeat":
                child = Scope(prefix=f"{scope.prefix}{key}.", parent=scope)
                scope.repeats[key] = child
                walk_fields(field.get("fields"), f"{field_path}.fields", child, own, own_grants)

    def walk_block(block: dict[str, Any], path: str, conditions: list[Any], grants: list[Any]) -> None:
        """A section's or category's fields; a repeatable block becomes one list node (Phase 2.7)."""
        key = repeat_key(block)
        if key is None:
            walk_fields(block.get("fields"), f"{path}.fields", top, conditions, grants)
            return
        top.keys.add(key)
        out.append(FieldNode(key, key, as_repeat_field(block), top, f"{path}.repeat", conditions, grants))
        child = Scope(prefix=f"{key}.", parent=top)
        top.repeats[key] = child
        walk_fields(block.get("fields"), f"{path}.fields", child, conditions, grants)

    def walk_sections(sections: Any, path: str, conditions: list[Any], grants: list[Any]) -> None:
        for index, section in enumerate(sections if isinstance(sections, list) else []):
            if not isinstance(section, dict):
                continue
            section_path = f"{path}[{index}]"
            own = conditions + _condition(section)
            own_grants = grants + _permission(section)
            walk_block(section, section_path, own, own_grants)
            categories = section.get("categories") if isinstance(section.get("categories"), list) else []
            for c_index, category in enumerate(categories):
                if isinstance(category, dict):
                    walk_block(category, f"{section_path}.categories[{c_index}]", own + _condition(category), own_grants + _permission(category))
            walk_sections(section.get("sections"), f"{section_path}.sections", own, own_grants)

    if isinstance(definition, dict):
        walk_sections(definition.get("sections"), "$.sections", [], _permission(definition))
    return Model(top, out, calculators, calculator_defs)


def condition_keys(condition: Any) -> Iterator[str]:
    if not isinstance(condition, dict):
        return
    for group in ("and", "or"):
        if isinstance(condition.get(group), list):
            for part in condition[group]:
                yield from condition_keys(part)
            return
    if isinstance(condition.get("field"), str):
        yield condition["field"]


def formula_of(model: Model, item: FieldNode) -> str | None:
    """The formula a calculated field runs (inline, or its calculator's)."""
    if item.field.get("type") != "calculated":
        return None
    if isinstance(item.field.get("formula"), str):
        return item.field["formula"]
    return model.calculators.get(item.field.get("calculator"))


def formula_refs(text: str | None) -> list[str]:
    if not text:
        return []
    try:
        return [name for name, _ in references(parse(text))]
    except FormulaError:
        return []


def dependency_keys(field: dict[str, Any]) -> list[str]:
    """Keys a field's options or value depend on (Phase 2.3): option conditions, lookup filters, derive matches."""
    out: list[str] = []
    options = field.get("options")
    for option in options if isinstance(options, list) else []:
        if isinstance(option, dict) and "when" in option:
            out.extend(condition_keys(option["when"]))
    for spec, pairs in ((field.get("lookup"), "filter"), (field.get("derive"), "match")):
        if isinstance(spec, dict) and isinstance(spec.get(pairs), dict):
            out.extend(key for key in spec[pairs].values() if isinstance(key, str))
    return out


def edges(model: Model) -> dict[str, set[str]]:
    """node -> nodes it is computed, shown or offered from (formulas, visibility conditions, option conditions,
    lookup filters and derivations)."""
    out: dict[str, set[str]] = {item.node: set() for item in model.fields}
    for item in model.fields:
        refs = formula_refs(formula_of(model, item))
        for condition in item.conditions:
            refs.extend(condition_keys(condition))
        refs.extend(dependency_keys(item.field))
        for ref in refs:
            target = item.scope.find(ref)
            if target is not None:
                out[item.node].add(target)
    return out


def cycles(model: Model) -> list[list[str]]:
    return find_cycles(edges(model))


def order(model: Model) -> list[str]:
    return evaluation_order([item.node for item in model.fields], edges(model))
