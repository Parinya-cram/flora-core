"""Field type registry (Phase 1.3) and style tokens (Phase 1.8).

The tables equal formdev/spec/field-types.json and formdev/spec/style-tokens.json (a test
compares them); the TypeScript twin is frontend/src/formdev/core/fieldTypes.ts. Adding a field
type means adding a row here, a value validator in definition.VALUE_VALIDATORS and an input in
the renderer; nothing else in the engine lists types.
"""
from __future__ import annotations

from typing import Any

COMMON_PROPS = ("id", "key", "type", "label", "description", "required", "readonly", "hidden", "visible", "display", "layout", "style",
                "validation", "visibility", "clear_when_hidden", "permission", "indexed")
COMMON_CONTAINER_PROPS = ("id", "type", "label", "description", "readonly", "hidden", "visible", "display", "layout", "style", "visibility",
                          "clear_when_hidden", "permission")

FIELD_TYPES: dict[str, dict[str, Any]] = {
    "text": {"value": "text", "query": "text", "index": "text", "props": ["unit", "max_length", "placeholder", "derive"]},
    "textarea": {"value": "text", "query": "longtext", "index": None, "props": ["max_length", "placeholder"]},
    "number": {"value": "number", "query": "num", "index": "num", "props": ["unit", "min", "max", "placeholder"]},
    "decimal": {"value": "decimal", "query": "num", "index": "num", "props": ["unit", "min", "max", "decimals", "placeholder"]},
    "integer": {"value": "integer", "query": "num", "index": "num", "props": ["unit", "min", "max", "placeholder"]},
    "date": {"value": "date", "query": "text", "index": "text", "props": []},
    "datetime": {"value": "datetime", "query": "datetime", "index": "datetime", "props": []},
    "time": {"value": "time", "query": "text", "index": "text", "props": []},
    "select": {"value": "option", "query": "text", "index": "text", "props": ["options", "placeholder", "lookup", "option_columns"]},
    "radio": {"value": "option", "query": "text", "index": "text", "props": ["options", "lookup", "option_columns"]},
    "multiselect": {"value": "options", "query": "multi", "index": None, "props": ["options", "lookup", "option_columns"]},
    "checkbox": {"value": "boolean", "query": "bool", "index": "num", "props": []},
    "switch": {"value": "boolean", "query": "bool", "index": "num", "props": []},
    "file": {"value": "file", "query": "blob", "index": None, "props": ["accept", "max_size_kb", "multiple"]},
    "image": {"value": "file", "query": "blob", "index": None, "props": ["accept", "max_size_kb", "multiple"]},
    "signature": {"value": "signature", "query": "blob", "index": None, "props": ["max_size_kb"]},
    "calculated": {"value": "number", "query": "num", "index": "num", "props": ["unit", "formula", "calculator", "decimals"]},
    "group": {"value": None, "query": None, "index": None, "props": ["fields", "columns"]},
    "repeat": {"value": "list", "query": "list", "index": None, "props": ["fields", "columns", "min_items", "max_items", "view"]},
    "matrix": {"value": "matrix", "query": None, "index": None, "props": ["rows", "cols", "cell", "totals"]},
}

STYLE_COMPONENTS = ("label", "input", "section", "header", "footer")
STYLE_TOKENS: dict[str, dict[str, Any]] = {
    "fontId": {"type": "font"},
    "fontSize": {"type": "number", "min": 6, "max": 72},
    "fontWeight": {"type": "integer", "min": 100, "max": 900},
    "lineHeight": {"type": "number", "min": 0.8, "max": 3},
    "color": {"type": "color"},
    "background": {"type": "color"},
    "align": {"type": "enum", "values": ["left", "center", "right"]},
    "labelPosition": {"type": "enum", "values": ["top", "left"]},
    "border": {"type": "enum", "values": ["none", "solid", "dashed", "underline"]},
    "borderColor": {"type": "color"},
    "radius": {"type": "number", "min": 0, "max": 10},
    "padding": {"type": "number", "min": 0, "max": 20},
    "gap": {"type": "number", "min": 0, "max": 20},
    "columns": {"type": "integer", "min": 1, "max": 24},
    "inputHeight": {"type": "number", "min": 4, "max": 30},
    "rule": {"type": "enum", "values": ["none", "solid", "card"]},
    "uppercase": {"type": "boolean"},
    "pageMarginTop": {"type": "number", "min": 0, "max": 60},
    "pageMarginRight": {"type": "number", "min": 0, "max": 60},
    "pageMarginBottom": {"type": "number", "min": 0, "max": 60},
    "pageMarginLeft": {"type": "number", "min": 0, "max": 60},
}

QUERY_FAMILY = {name: spec["query"] for name, spec in FIELD_TYPES.items() if spec["query"] is not None}
INDEX_FAMILY = {name: spec["index"] for name, spec in FIELD_TYPES.items() if spec["index"] is not None}
INDEXABLE_TYPES = tuple(INDEX_FAMILY)
NUMERIC_INDEX_TYPES = tuple(name for name, family in INDEX_FAMILY.items() if family in ("num", "datetime"))


def has_value(field_type: Any) -> bool:
    return field_type in FIELD_TYPES and FIELD_TYPES[field_type]["value"] is not None


def is_container(field_type: Any) -> bool:
    return field_type in ("group", "repeat")


def allowed_props(field_type: Any) -> set[str]:
    spec = FIELD_TYPES.get(field_type)
    if spec is None:
        return set(COMMON_PROPS)
    return set(COMMON_PROPS if spec["value"] is not None else COMMON_CONTAINER_PROPS) | set(spec["props"])


def all_props() -> set[str]:
    out = set(COMMON_PROPS)
    for spec in FIELD_TYPES.values():
        out |= set(spec["props"])
    return out


def index_column(field_type: Any) -> str:
    """Record index column that holds this type's value (value_num for numbers, booleans and datetimes)."""
    return "value_num" if field_type in NUMERIC_INDEX_TYPES else "value_text"
