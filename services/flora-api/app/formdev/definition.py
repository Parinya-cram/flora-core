"""Form definition (flora.form/1) validation, record value validation and index extraction.

Pure functions with no database or HTTP knowledge. The TypeScript twin lives in
frontend/src/formdev/core/validate.ts; both are exercised by the shared fixtures in
formdev/spec/fixtures so the two runtimes accept and reject the same input.
Format reference: formdev/spec/FORM-SCHEMA.md.
"""
from __future__ import annotations

import hashlib
import json
import math
import re
from dataclasses import dataclass, field as dataclass_field
from datetime import date
from typing import Any, Callable, Iterable

from .blocks import section_field_lists
from .logic import model as logic_model
from .logic.formula import check as check_formula
from .messages import MESSAGES
from .field_types import (
    FIELD_TYPES as FIELD_TYPE_SPECS,
    INDEX_FAMILY,
    INDEXABLE_TYPES,
    STYLE_COMPONENTS,
    STYLE_TOKENS,
    all_props,
    allowed_props,
    has_value,
)

FORMAT = "flora.form/1"
FIELD_TYPES = tuple(FIELD_TYPE_SPECS)
PAPERS = ("A4", "A5", "Letter", "screen")
# Sheet size in mm, portrait. "screen" has no page.
PAPER_SIZES_MM = {"A4": (210.0, 297.0), "A5": (148.0, 210.0), "Letter": (215.9, 279.4)}
ORIENTATIONS = ("portrait", "landscape")
REPEAT_VIEWS = ("cards", "table")
PAGE_BREAKS = ("before", "after", "avoid")
LAYOUT_MODES = ("desktop", "tablet", "mobile", "print")
SECTION_LAYOUTS = ("grid", "row", "column")
DISPLAY_CONTEXTS = ("form", "table", "detail", "query", "export")
CONDITION_OPERATORS = ("equals", "not_equals", "gt", "gte", "lt", "lte", "in", "not_in", "exists", "empty")
VALUELESS_OPERATORS = ("exists", "empty")
LIST_OPERATORS = ("in", "not_in")
FORM_ACTIONS = ("view", "create", "edit", "delete", "export")
SECTION_ACTIONS = ("view", "edit")
FIELD_ACTIONS = ("view", "edit", "export")
TEMPLATE_TOKENS = ("title", "form_id", "version", "page", "pages", "date", "record_id")
CALCULATOR_OUTPUTS = ("number", "integer", "decimal", "text", "boolean")
RECORD_STATUSES = ("draft", "submitted", "deleted")
MAX_INDEXED_FIELDS = 16
MAX_NESTING = 4
MAX_CONDITION_DEPTH = 8
DEFAULT_COLUMNS = 12
DEFAULT_SIGNATURE_KB = 256
RETIRED_KEY = "_retired"
# Answer + Other (Phase 2.6): free text of "other" options, {field key: text}, at the top and in each repeat item.
OTHER_KEY = "_other"
MAX_OTHER_TEXT = 1000

FORM_ID = re.compile(r"^[a-z][a-z0-9_]{1,63}\Z")
ITEM_ID = re.compile(r"^[a-z][a-z0-9_]{0,63}\Z")
REGISTRY_ID = re.compile(r"^[a-z][a-z0-9_.-]{1,63}\Z")
ROLE = re.compile(r"^[a-z][a-z0-9_.-]{0,63}\Z")
MIME = re.compile(r"^[a-z]+/(\*|[a-z0-9.+-]+)\Z")
COLOR = re.compile(r"^(#[0-9a-fA-F]{3}|#[0-9a-fA-F]{6}|transparent)\Z")
TEMPLATE_TOKEN = re.compile(r"\{([a-z_]+)\}")
RELATIVE_DATE = re.compile(r"^today([+-]\d{1,5}d)?\Z")
DATE = re.compile(r"^\d{4}-\d{2}-\d{2}\Z")
DATETIME = re.compile(r"^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,6}))?)?(Z|[+-]\d{2}:\d{2})?\Z")
# Offset applied to datetimes written without one (Asia/Bangkok). Index values are epoch ms.
DEFAULT_TZ_OFFSET_MINUTES = 420
SUBJECT_FIELD_KEY = "flora.subject_field"
SUBJECT_FIELD_TYPES = ("text", "select", "radio", "integer")
TIME = re.compile(r"^(\d{2}):(\d{2})(?::(\d{2}))?\Z")
SIGNATURE_DATA = re.compile(r"^data:image/(png|svg\+xml);base64,[A-Za-z0-9+/=]+\Z")

DEFINITION_KEYS = {"format", "form_id", "schema_version", "title", "description", "paper", "style_id", "style", "font_id", "offline", "metadata",
                   "layout", "calculators", "rules", "permission", "sections", "migration", "extensions"}
SECTION_KEYS = {"id", "title", "description", "fields", "categories", "sections", "layout", "style", "visibility", "permission", "page_break", "repeat"}
CATEGORY_KEYS = {"id", "title", "description", "fields", "layout", "style", "visibility", "permission", "page_break", "repeat"}
PAPER_KEYS = {"size", "orientation", "margin_mm", "header", "footer"}
BAND_KEYS = {"left", "center", "right", "height_mm", "first_page"}
MARGIN_KEYS = ("top", "right", "bottom", "left")
CALCULATOR_KEYS = {"id", "name", "description", "formula", "output"}
FIELD_LAYOUT_KEYS = {"col", "row", "span", "responsive", "page_break"}
RESPONSIVE_KEYS = {"col", "span", "hidden"}
RULE_KEYS = {"required", "min", "max", "min_length", "max_length", "pattern", "email", "numeric", "min_date", "max_date", "message", "rules"}
# Which validation rules apply to which stored value kind (field_types "value").
RULES_BY_VALUE = {
    "text": {"required", "min_length", "max_length", "pattern", "email", "numeric", "message"},
    "number": {"required", "min", "max", "message"}, "integer": {"required", "min", "max", "message"}, "decimal": {"required", "min", "max", "message"},
    "date": {"required", "min_date", "max_date", "message"}, "datetime": {"required", "min_date", "max_date", "message"},
}
CALCULATED_RULES = {"min", "max", "message", "rules"}
# Flat field properties that are also validation rules (flora.form/1 before Phase 1).
FLAT_RULES = ("required", "min", "max", "max_length")
RANGE_RULES = (("min", "max"), ("min_length", "max_length"), ("min_date", "max_date"))
MIGRATION_OPS = {
    "rename_field": {"op", "from", "to"},
    "add_field": {"op", "field", "default"},
    "remove_field": {"op", "field"},
    "map_values": {"op", "field", "mapping"},
    "convert_type": {"op", "field", "to"},
}
CONVERT_TARGETS = ("text", "number", "integer", "boolean")


@dataclass(frozen=True)
class Issue:
    path: str
    code: str
    message: str
    custom: bool = False  # message written by the form designer (shown as is in every language)

    def as_dict(self) -> dict[str, Any]:
        out: dict[str, Any] = {"path": self.path, "code": self.code, "message": self.message}
        if self.custom:
            out["custom"] = True
        return out


def canonical_json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def checksum(definition: dict[str, Any]) -> str:
    return hashlib.sha256(canonical_json(definition).encode("utf-8")).hexdigest()


def is_int(value: Any) -> bool:
    return isinstance(value, int) and not isinstance(value, bool)


def is_number(value: Any) -> bool:
    return (isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value))


def _is_scalar(value: Any) -> bool:
    return isinstance(value, (str, bool)) or is_number(value)


# ---------------------------------------------------------------------------------------------
# Traversal. Sections (nestable) hold fields; group fields hold fields in the same data scope;
# repeat fields hold fields in a per-item scope. Record data is keyed by field key.
# ---------------------------------------------------------------------------------------------

def field_key(field: dict[str, Any]) -> Any:
    """Data and formula name of a field; defaults to its id (definitions before Phase 1 had no key)."""
    return field["key"] if "key" in field else field.get("id")


def iter_sections(definition: dict[str, Any]) -> list[dict[str, Any]]:
    """Every section, depth first, nested ones included."""
    out: list[dict[str, Any]] = []

    def walk(sections: Any) -> None:
        for section in sections if isinstance(sections, list) else []:
            if isinstance(section, dict):
                out.append(section)
                walk(section.get("sections"))

    walk(definition.get("sections"))
    return out


def scope_fields(field_list: Any) -> list[dict[str, Any]]:
    """Fields whose values live in one data scope: group children are flattened in, repeat
    children are not (they live inside each repeat item)."""
    out: list[dict[str, Any]] = []
    for field in field_list if isinstance(field_list, list) else []:
        if not isinstance(field, dict):
            continue
        if field.get("type") == "group":
            out.extend(scope_fields(field.get("fields")))
        else:
            out.append(field)
    return out


def fields(definition: dict[str, Any]) -> list[dict[str, Any]]:
    """Fields stored at the top level of record data (repeat fields included, their items not)."""
    out: list[dict[str, Any]] = []
    for section in iter_sections(definition):
        for field_list in section_field_lists(section):
            out.extend(scope_fields(field_list))
    return out


def field_map(definition: dict[str, Any]) -> dict[str, dict[str, Any]]:
    """Top-level fields by data key."""
    return {field_key(field): field for field in fields(definition) if isinstance(field_key(field), str)}


def item_map(repeat: dict[str, Any]) -> dict[str, dict[str, Any]]:
    """Fields of one repeat item by data key."""
    return {field_key(field): field for field in scope_fields(repeat.get("fields")) if isinstance(field_key(field), str)}


def effective_rules(field: dict[str, Any]) -> dict[str, Any]:
    """Validation rules from the flat properties and the validation object. The validator rejects
    definitions where both name the same rule with different values."""
    rules = {name: field[name] for name in FLAT_RULES if name in field}
    if isinstance(field.get("validation"), dict):
        rules.update(field["validation"])
    return rules


def is_visible(field: dict[str, Any]) -> bool:
    if "visible" in field:
        return field["visible"] is not False
    return field.get("hidden") is not True


def displayed(field: dict[str, Any], context: str) -> bool:
    """Display policy (Phase 1.4): form follows the field's visibility, every other context defaults to shown."""
    display = field.get("display") if isinstance(field.get("display"), dict) else {}
    if context in display:
        return display[context] is True
    return is_visible(field) if context == "form" else True


def paper_spec(definition: dict[str, Any]) -> dict[str, Any]:
    """Normalised paper: {size, orientation, width_mm, height_mm, margin_mm, header, footer}."""
    paper = definition.get("paper")
    spec = {"size": paper} if isinstance(paper, str) else dict(paper) if isinstance(paper, dict) else {"size": "A4"}
    size = spec.get("size", "A4")
    orientation = spec.get("orientation", "portrait")
    width, height = PAPER_SIZES_MM.get(size, (None, None))
    if width is not None and orientation == "landscape":
        width, height = height, width
    return {"size": size, "orientation": orientation, "width_mm": width, "height_mm": height,
            "margin_mm": spec.get("margin_mm") or {}, "header": spec.get("header"), "footer": spec.get("footer")}


def style_ref(definition: dict[str, Any]) -> str | None:
    style = definition.get("style")
    if isinstance(style, dict) and isinstance(style.get("id"), str):
        return style["id"]
    return definition.get("style_id") if isinstance(definition.get("style_id"), str) else None


# ---------------------------------------------------------------------------------------------
# Definition validation (Phase 1.10)
# ---------------------------------------------------------------------------------------------

def _unknown_keys(value: dict[str, Any], allowed: set[str], path: str) -> list[Issue]:
    return [Issue(f"{path}.{key}", "unknown_property", f"Unknown property '{key}'") for key in sorted(set(value) - allowed)]


@dataclass
class _Scope:
    keys: set[str] = dataclass_field(default_factory=set)
    parent: "_Scope | None" = None
    repeats: dict[str, "_Scope"] = dataclass_field(default_factory=dict)

    def resolves(self, key: str) -> bool:
        """A key visible from this scope (item first, then outwards); "meds.dose" names a repeat column."""
        head, _, tail = key.partition(".")
        scope: _Scope | None = self
        while scope is not None:
            if tail:
                child = scope.repeats.get(head)
                if child is not None and tail in child.keys:
                    return True
            elif key in scope.keys:
                return True
            scope = scope.parent
        return False

    def anywhere(self, key: str) -> bool:
        """A key of this scope or of any repeat inside it (calculators may be used in any scope)."""
        return self.resolves(key) or any(child.anywhere(key) for child in self.repeats.values())


@dataclass
class _Ctx:
    style_ids: set[str] | None
    font_ids: set[str] | None
    issues: list[Issue] = dataclass_field(default_factory=list)
    section_ids: set[str] = dataclass_field(default_factory=set)
    category_ids: set[str] = dataclass_field(default_factory=set)
    field_ids: set[str] = dataclass_field(default_factory=set)
    calculators: set[str] = dataclass_field(default_factory=set)
    refs: list[tuple[str, str, _Scope]] = dataclass_field(default_factory=list)
    formulas: list[tuple[str, Any, "_Scope | None"]] = dataclass_field(default_factory=list)
    rule_ids: set[str] = dataclass_field(default_factory=set)
    indexed: int = 0

    def add(self, path: str, code: str, message: str) -> None:
        self.issues.append(Issue(path, code, message))

    def unknown(self, value: dict[str, Any], allowed: set[str], path: str) -> None:
        self.issues.extend(_unknown_keys(value, allowed, path))


def validate_definition(
    definition: Any,
    style_ids: Iterable[str] | None = None,
    font_ids: Iterable[str] | None = None,
) -> list[Issue]:
    """Return every structural and semantic problem. Registry ids are checked when supplied."""
    if not isinstance(definition, dict):
        return [Issue("$", "not_object", "Form definition must be a JSON object")]
    ctx = _Ctx(set(style_ids) if style_ids is not None else None, set(font_ids) if font_ids is not None else None)
    ctx.unknown(definition, DEFINITION_KEYS, "$")
    if definition.get("format") != FORMAT:
        ctx.add("$.format", "invalid_format", f"format must be '{FORMAT}'")
    if not isinstance(definition.get("form_id"), str) or not FORM_ID.match(definition["form_id"]):
        ctx.add("$.form_id", "invalid_form_id", "form_id must be lower snake case, 2-64 characters")
    version = definition.get("schema_version")
    if not is_int(version) or version < 1:
        ctx.add("$.schema_version", "invalid_schema_version", "schema_version must be a positive integer")
    title = definition.get("title")
    if not isinstance(title, str) or not title.strip() or len(title) > 200:
        ctx.add("$.title", "invalid_title", "title is required (max 200 characters)")
    _check_text(ctx, definition, "description", "$", 2000)
    _validate_paper(ctx, definition.get("paper"))
    _validate_form_style(ctx, definition)
    if "font_id" in definition:
        _check_font(ctx, definition["font_id"], "$.font_id")
    if "offline" in definition and not isinstance(definition["offline"], bool):
        ctx.add("$.offline", "invalid_type", "offline must be a boolean")
    for name in ("extensions", "metadata"):
        if name in definition and not isinstance(definition[name], dict):
            ctx.add(f"$.{name}", "invalid_type", f"{name} must be an object")
    columns = DEFAULT_COLUMNS
    if "layout" in definition:
        columns = _validate_container_layout(ctx, definition["layout"], "$.layout", DEFAULT_COLUMNS, ("grid",))
    _validate_calculators(ctx, definition)
    if "permission" in definition:
        _validate_permission(ctx, definition["permission"], "$.permission", FORM_ACTIONS)

    sections = definition.get("sections")
    if not isinstance(sections, list) or not sections:
        ctx.add("$.sections", "no_sections", "At least one section is required")
        sections = []
    top = _Scope()
    for s_index, section in enumerate(sections):
        _validate_section(ctx, section, f"$.sections[{s_index}]", top, columns, 1)
    if ctx.indexed > MAX_INDEXED_FIELDS:
        ctx.add("$.sections", "too_many_indexed", f"At most {MAX_INDEXED_FIELDS} fields may be indexed")
    _validate_rules_block(ctx, definition, top)
    for path, key, scope in ctx.refs:
        if not scope.resolves(key):
            ctx.add(path, "unknown_field_reference", f"'{key}' is not a field key of this form")
    formula_ok = _check_formulas(ctx, top)
    if formula_ok:
        model = logic_model.build(definition)
        for cycle in logic_model.cycles(model):
            where = model.by_node().get(cycle[0])
            ctx.add(where.path if where else "$.sections", "circular_dependency", "Circular dependency: " + " → ".join([*cycle, cycle[0]]))
    ctx.issues.extend(_validate_migration(definition, top.keys))
    ctx.issues.extend(_validate_extensions(definition))
    return ctx.issues


def _check_formulas(ctx: _Ctx, top: _Scope) -> bool:
    """Parse every formula and resolve its keys (Phase 2.4). Returns False when any formula is broken."""
    ok = True
    for path, text, scope in ctx.formulas:
        known = scope.resolves if scope is not None else top.anywhere
        for problem in check_formula(text, known):
            ok = False
            ctx.add(path, problem.code, f"{problem.message} (column {problem.position})")
    return ok


def _validate_rules_block(ctx: _Ctx, definition: dict[str, Any], top: _Scope) -> None:
    """Form-level rules: [{id, assert, message, fields}] checked across several fields (Phase 2.1)."""
    if "rules" not in definition:
        return
    rules = definition["rules"]
    if not isinstance(rules, list):
        ctx.add("$.rules", "invalid_rule", "rules must be an array")
        return
    for index, rule in enumerate(rules):
        path = f"$.rules[{index}]"
        if not isinstance(rule, dict):
            ctx.add(path, "invalid_rule", "A rule must be an object")
            continue
        ctx.unknown(rule, {"id", "assert", "message", "fields", "when"}, path)
        rule_id = rule.get("id")
        if not isinstance(rule_id, str) or not ITEM_ID.match(rule_id) or rule_id in ctx.rule_ids:
            ctx.add(f"{path}.id", "invalid_rule", "Rule id must be lower snake case and unique")
        else:
            ctx.rule_ids.add(rule_id)
        targets = rule.get("fields")
        if not isinstance(targets, list) or not targets or not all(isinstance(key, str) for key in targets):
            ctx.add(f"{path}.fields", "invalid_rule", "fields lists the keys the message belongs to")
        else:
            for t_index, key in enumerate(targets):
                if not top.resolves(key) or "." in key:
                    ctx.add(f"{path}.fields[{t_index}]", "unknown_field_reference", f"'{key}' is not a field key of this form")
        _check_rule_body(ctx, rule, path, top)


def _check_rule_body(ctx: _Ctx, rule: dict[str, Any], path: str, scope: _Scope) -> None:
    if not isinstance(rule.get("assert"), str) or not rule["assert"].strip():
        ctx.add(f"{path}.assert", "invalid_rule", "assert is a formula that must be true")
    else:
        ctx.formulas.append((f"{path}.assert", rule["assert"], scope))
    if not isinstance(rule.get("message"), str) or not 0 < len(rule["message"]) <= 200:
        ctx.add(f"{path}.message", "invalid_rule", "message is required (max 200 characters)")
    if "when" in rule:
        _validate_condition(ctx, rule["when"], f"{path}.when", scope, 1)


def _check_text(ctx: _Ctx, owner: dict[str, Any], name: str, path: str, limit: int) -> None:
    if name in owner and (not isinstance(owner[name], str) or len(owner[name]) > limit):
        ctx.add(f"{path}.{name}", "invalid_type", f"{name} must be text (max {limit} characters)")


def _check_font(ctx: _Ctx, font_id: Any, path: str) -> None:
    if not isinstance(font_id, str) or not REGISTRY_ID.match(font_id):
        ctx.add(path, "invalid_font_id", "font_id must be a registry id")
    elif ctx.font_ids is not None and font_id not in ctx.font_ids:
        ctx.add(path, "unknown_font", f"Font '{font_id}' is not in the font registry")


def _check_style_id(ctx: _Ctx, style_id: Any, path: str) -> None:
    if not isinstance(style_id, str) or not REGISTRY_ID.match(style_id):
        ctx.add(path, "invalid_style_id", "style id must be a registry id")
    elif ctx.style_ids is not None and style_id not in ctx.style_ids:
        ctx.add(path, "unknown_style", f"Style '{style_id}' is not in the style registry")


def _validate_paper(ctx: _Ctx, paper: Any) -> None:
    if not isinstance(paper, dict):
        if paper not in PAPERS:
            ctx.add("$.paper", "invalid_paper", f"paper must be one of {', '.join(PAPERS)}")
        return
    ctx.unknown(paper, PAPER_KEYS, "$.paper")
    if paper.get("size") not in PAPERS:
        ctx.add("$.paper.size", "invalid_paper", f"paper.size must be one of {', '.join(PAPERS)}")
    if "orientation" in paper and paper["orientation"] not in ORIENTATIONS:
        ctx.add("$.paper.orientation", "invalid_paper", "orientation must be portrait or landscape")
    if "margin_mm" in paper:
        margin = paper["margin_mm"]
        if not isinstance(margin, dict) or set(margin) - set(MARGIN_KEYS) or not all(is_number(v) and 0 <= v <= 60 for v in margin.values()):
            ctx.add("$.paper.margin_mm", "invalid_margin", "margin_mm takes top, right, bottom and left in mm (0-60)")
    for band_name in ("header", "footer"):
        if band_name in paper:
            _validate_band(ctx, paper[band_name], f"$.paper.{band_name}")


def _validate_band(ctx: _Ctx, band: Any, path: str) -> None:
    if not isinstance(band, dict):
        ctx.add(path, "invalid_band", "header and footer must be objects")
        return
    ctx.unknown(band, BAND_KEYS, path)
    for slot in ("left", "center", "right"):
        if slot not in band:
            continue
        text = band[slot]
        if not isinstance(text, str) or len(text) > 200:
            ctx.add(f"{path}.{slot}", "invalid_band", f"{slot} must be text (max 200 characters)")
            continue
        for token in TEMPLATE_TOKEN.findall(text):
            if token not in TEMPLATE_TOKENS:
                ctx.add(f"{path}.{slot}", "unknown_template_token", f"Unknown token '{{{token}}}'")
    if "height_mm" in band and not (is_number(band["height_mm"]) and 0 <= band["height_mm"] <= 40):
        ctx.add(f"{path}.height_mm", "invalid_band", "height_mm must be 0-40")
    if "first_page" in band and not isinstance(band["first_page"], bool):
        ctx.add(f"{path}.first_page", "invalid_band", "first_page must be a boolean")


def _validate_form_style(ctx: _Ctx, definition: dict[str, Any]) -> None:
    style = definition.get("style")
    if "style" in definition:
        _validate_style_ref(ctx, style, "$.style")
    nested = style.get("id") if isinstance(style, dict) else None
    if "style_id" in definition:
        _check_style_id(ctx, definition["style_id"], "$.style_id")
        if nested is not None and nested != definition["style_id"]:
            ctx.add("$.style.id", "style_mismatch", "style.id and style_id name different styles")
    elif nested is None:
        ctx.add("$.style_id", "invalid_style_id", "style_id (or style.id) is required")


def _validate_style_ref(ctx: _Ctx, style: Any, path: str) -> None:
    if not isinstance(style, dict):
        ctx.add(path, "invalid_type", "style must be an object {id, override}")
        return
    ctx.unknown(style, {"id", "override"}, path)
    if "id" in style:
        _check_style_id(ctx, style["id"], f"{path}.id")
    if "override" in style:
        _validate_tokens(ctx, style["override"], f"{path}.override", allow_components=True)


def _validate_tokens(ctx: _Ctx, tokens: Any, path: str, allow_components: bool) -> None:
    if not isinstance(tokens, dict):
        ctx.add(path, "invalid_type", "style tokens must be an object")
        return
    for name, value in tokens.items():
        token_path = f"{path}.{name}"
        if allow_components and name in STYLE_COMPONENTS:
            _validate_tokens(ctx, value, token_path, allow_components=False)
            continue
        spec = STYLE_TOKENS.get(name)
        if spec is None:
            ctx.add(token_path, "unknown_style_token", f"Unknown style token '{name}'")
        elif spec["type"] == "font":
            _check_font(ctx, value, token_path)
        elif not token_value_ok(spec, value):
            ctx.add(token_path, "invalid_style_token", f"Invalid value for style token '{name}'")


def token_value_ok(spec: dict[str, Any], value: Any) -> bool:
    kind = spec["type"]
    if kind == "color":
        return isinstance(value, str) and bool(COLOR.match(value))
    if kind == "enum":
        return value in spec["values"]
    if kind == "boolean":
        return isinstance(value, bool)
    if kind == "font":
        return isinstance(value, str) and bool(REGISTRY_ID.match(value))
    if kind == "integer" and not is_int(value):
        return False
    return is_number(value) and spec["min"] <= value <= spec["max"]


def _validate_container_layout(ctx: _Ctx, layout: Any, path: str, inherited: int, types: tuple[str, ...]) -> int:
    """Validate a form or section layout; returns the column count its children are placed on."""
    if not isinstance(layout, dict):
        ctx.add(path, "invalid_layout", "layout must be an object")
        return inherited
    ctx.unknown(layout, {"type", "columns", "gap_mm"}, path)
    if "type" in layout and layout["type"] not in types:
        ctx.add(f"{path}.type", "invalid_layout", f"layout.type must be one of {', '.join(types)}")
    columns = inherited
    if "columns" in layout:
        if is_int(layout["columns"]) and 1 <= layout["columns"] <= 24:
            columns = layout["columns"]
        else:
            ctx.add(f"{path}.columns", "invalid_columns", "columns must be an integer 1-24")
    if "gap_mm" in layout and not (is_number(layout["gap_mm"]) and 0 <= layout["gap_mm"] <= 20):
        ctx.add(f"{path}.gap_mm", "invalid_layout", "gap_mm must be 0-20")
    return columns


def _validate_calculators(ctx: _Ctx, definition: dict[str, Any]) -> None:
    if "calculators" not in definition:
        return
    calculators = definition["calculators"]
    if not isinstance(calculators, list):
        ctx.add("$.calculators", "invalid_type", "calculators must be an array")
        return
    for index, calculator in enumerate(calculators):
        path = f"$.calculators[{index}]"
        if not isinstance(calculator, dict):
            ctx.add(path, "not_object", "Calculator must be an object")
            continue
        ctx.unknown(calculator, CALCULATOR_KEYS, path)
        calculator_id = calculator.get("id")
        if not isinstance(calculator_id, str) or not ITEM_ID.match(calculator_id):
            ctx.add(f"{path}.id", "invalid_calculator_id", "Calculator id must be lower snake case")
        elif calculator_id in ctx.calculators:
            ctx.add(f"{path}.id", "duplicate_calculator_id", f"Duplicate calculator id '{calculator_id}'")
        else:
            ctx.calculators.add(calculator_id)
        formula = calculator.get("formula")
        if not isinstance(formula, str) or not formula.strip() or len(formula) > 2000:
            ctx.add(f"{path}.formula", "invalid_formula", "formula is required (max 2000 characters)")
        else:
            ctx.formulas.append((f"{path}.formula", formula, None))
        _check_text(ctx, calculator, "name", path, 200)
        _check_text(ctx, calculator, "description", path, 2000)
        if "output" in calculator and not _output_ok(calculator["output"]):
            ctx.add(f"{path}.output", "invalid_type", f"output takes type ({', '.join(CALCULATOR_OUTPUTS)}), decimals 0-10 and unit")


def _output_ok(output: Any) -> bool:
    return isinstance(output, dict) and not set(output) - {"type", "decimals", "unit"} \
        and output.get("type", "number") in CALCULATOR_OUTPUTS \
        and ("decimals" not in output or (is_int(output["decimals"]) and 0 <= output["decimals"] <= 10)) \
        and ("unit" not in output or (isinstance(output["unit"], str) and len(output["unit"]) <= 40))


def _validate_permission(ctx: _Ctx, permission: Any, path: str, actions: tuple[str, ...]) -> None:
    if not isinstance(permission, dict):
        ctx.add(path, "invalid_permission", "permission must be an object of action -> roles")
        return
    ctx.unknown(permission, set(actions), path)
    for action, roles in permission.items():
        if action not in actions:
            continue
        if not isinstance(roles, list) or not roles:
            ctx.add(f"{path}.{action}", "invalid_permission", f"{action} must be a non-empty list of role codes")
            continue
        for r_index, role in enumerate(roles):
            if not isinstance(role, str) or not ROLE.match(role):
                ctx.add(f"{path}.{action}[{r_index}]", "invalid_role", "Role codes are lower case letters, digits, '_', '.', '-'")


def _validate_visibility(ctx: _Ctx, visibility: Any, path: str, scope: _Scope) -> None:
    if not isinstance(visibility, dict) or "when" not in visibility:
        ctx.add(path, "invalid_condition", "visibility must be {\"when\": condition}")
        return
    ctx.unknown(visibility, {"when"}, path)
    _validate_condition(ctx, visibility["when"], f"{path}.when", scope, 1)


def _validate_condition(ctx: _Ctx, condition: Any, path: str, scope: _Scope, depth: int) -> None:
    if depth > MAX_CONDITION_DEPTH:
        ctx.add(path, "invalid_condition", f"Conditions may nest at most {MAX_CONDITION_DEPTH} levels")
        return
    if not isinstance(condition, dict):
        ctx.add(path, "invalid_condition", "A condition must be an object")
        return
    groups = [name for name in ("and", "or") if name in condition]
    if groups:
        if len(condition) != 1:
            ctx.add(path, "invalid_condition", "and / or must be the only key of their condition")
            return
        parts = condition[groups[0]]
        if not isinstance(parts, list) or not parts:
            ctx.add(f"{path}.{groups[0]}", "invalid_condition", f"{groups[0]} needs a non-empty list of conditions")
            return
        for index, part in enumerate(parts):
            _validate_condition(ctx, part, f"{path}.{groups[0]}[{index}]", scope, depth + 1)
        return
    ctx.unknown(condition, {"field", "operator", "value"}, path)
    key = condition.get("field")
    if not isinstance(key, str) or not ITEM_ID.match(key):
        ctx.add(f"{path}.field", "invalid_condition", "field must name a field key")
    else:
        ctx.refs.append((f"{path}.field", key, scope))
    operator = condition.get("operator")
    if operator not in CONDITION_OPERATORS:
        ctx.add(f"{path}.operator", "invalid_operator", f"operator must be one of {', '.join(CONDITION_OPERATORS)}")
        return
    if operator in VALUELESS_OPERATORS:
        if "value" in condition:
            ctx.add(f"{path}.value", "invalid_condition", f"{operator} takes no value")
    elif operator in LIST_OPERATORS:
        value = condition.get("value")
        if not isinstance(value, list) or not value or len(value) > 100 or not all(_is_scalar(item) for item in value):
            ctx.add(f"{path}.value", "invalid_condition", f"{operator} needs a list of 1-100 values")
    elif not _is_scalar(condition.get("value")):
        ctx.add(f"{path}.value", "invalid_condition", f"{operator} needs a text, number or boolean value")


def _validate_display(ctx: _Ctx, field: dict[str, Any], path: str) -> None:
    display = field["display"]
    if not isinstance(display, dict):
        ctx.add(f"{path}.display", "invalid_type", "display must be an object")
        return
    ctx.unknown(display, set(DISPLAY_CONTEXTS), f"{path}.display")
    for context, flag in display.items():
        if context in DISPLAY_CONTEXTS and not isinstance(flag, bool):
            ctx.add(f"{path}.display.{context}", "invalid_type", f"display.{context} must be a boolean")
    if isinstance(display.get("form"), bool) and ("visible" in field or "hidden" in field) and display["form"] != is_visible(field):
        ctx.add(f"{path}.display.form", "conflicting_visibility", "display.form disagrees with visible/hidden")


def _validate_field_layout(ctx: _Ctx, layout: Any, path: str, columns: int) -> tuple[int, int, int] | None:
    """Validate a field placement; returns the explicit (row, col, span) cell when all three are given."""
    if not isinstance(layout, dict):
        ctx.add(path, "invalid_layout", "layout must be an object")
        return None
    ctx.unknown(layout, FIELD_LAYOUT_KEYS, path)
    _check_placement(ctx, layout, path, columns)
    if "row" in layout and not (is_int(layout["row"]) and 1 <= layout["row"] <= 500):
        ctx.add(f"{path}.row", "invalid_layout", "row must be an integer 1-500")
    if "page_break" in layout and layout["page_break"] not in PAGE_BREAKS:
        ctx.add(f"{path}.page_break", "invalid_page_break", f"page_break must be one of {', '.join(PAGE_BREAKS)}")
    if "responsive" in layout:
        responsive = layout["responsive"]
        if not isinstance(responsive, dict):
            ctx.add(f"{path}.responsive", "invalid_layout", "responsive must be an object keyed by desktop, tablet, mobile, print")
        else:
            ctx.unknown(responsive, set(LAYOUT_MODES), f"{path}.responsive")
            for mode, rule in responsive.items():
                if mode not in LAYOUT_MODES:
                    continue
                if not isinstance(rule, dict):
                    ctx.add(f"{path}.responsive.{mode}", "invalid_layout", "a responsive rule must be an object")
                    continue
                ctx.unknown(rule, RESPONSIVE_KEYS, f"{path}.responsive.{mode}")
                _check_placement(ctx, rule, f"{path}.responsive.{mode}", columns)
                if "hidden" in rule and not isinstance(rule["hidden"], bool):
                    ctx.add(f"{path}.responsive.{mode}.hidden", "invalid_type", "hidden must be a boolean")
    cell = (layout.get("row"), layout.get("col"), layout.get("span"))
    return cell if all(is_int(part) for part in cell) else None  # type: ignore[return-value]


def _check_placement(ctx: _Ctx, rule: dict[str, Any], path: str, columns: int) -> None:
    span, col = rule.get("span"), rule.get("col")
    span_ok = "span" not in rule or (is_int(span) and 1 <= span <= columns)
    col_ok = "col" not in rule or (is_int(col) and 1 <= col <= columns)
    if not span_ok:
        ctx.add(f"{path}.span", "invalid_span", f"span must be an integer 1-{columns}")
    if not col_ok:
        ctx.add(f"{path}.col", "invalid_layout", f"col must be an integer 1-{columns}")
    if span_ok and col_ok and is_int(span) and is_int(col) and col + span - 1 > columns:
        ctx.add(path, "layout_out_of_bounds", f"col {col} + span {span} goes past column {columns}")


def _check_overlaps(ctx: _Ctx, cells: list[tuple[str, tuple[int, int, int]]]) -> None:
    taken: set[tuple[int, int]] = set()
    for path, (row, col, span) in cells:
        wanted = {(row, column) for column in range(col, col + span)}
        clash = sorted(wanted & taken)
        if clash:
            ctx.add(f"{path}.layout", "layout_overlap", f"Overlaps another field at row {row}, column {clash[0][1]}")
        taken |= wanted


def _validate_rules(ctx: _Ctx, field: dict[str, Any], path: str, value_kind: str | None, scope: _Scope) -> None:
    rules = field["validation"]
    if not isinstance(rules, dict):
        ctx.add(f"{path}.validation", "invalid_rule", "validation must be an object")
        return
    ctx.unknown(rules, RULE_KEYS, f"{path}.validation")
    supported = CALCULATED_RULES if field.get("type") == "calculated" else RULES_BY_VALUE.get(value_kind or "", {"required", "message"}) | {"rules"}
    for name, value in rules.items():
        rule_path = f"{path}.validation.{name}"
        if name not in RULE_KEYS:
            continue
        if name not in supported:
            ctx.add(rule_path, "rule_not_supported", f"'{name}' does not apply to {field.get('type')} fields")
            continue
        if name == "rules":
            _validate_field_rules(ctx, value, rule_path, scope)
            continue
        if not _rule_value_ok(name, value):
            ctx.add(rule_path, "invalid_rule", f"Invalid value for rule '{name}'")
        elif name == "pattern":
            try:
                re.compile(value)
            except re.error:
                ctx.add(rule_path, "invalid_pattern", "pattern is not a valid regular expression")
        if name in FLAT_RULES and name in field and field[name] != value:
            ctx.add(rule_path, "conflicting_rule", f"'{name}' is set differently on the field and in validation")
    merged = effective_rules(field)
    for low, high in RANGE_RULES:
        if low not in rules and high not in rules:
            continue
        a, b = merged.get(low), merged.get(high)
        numbers = is_number(a) and is_number(b)
        dates = isinstance(a, str) and isinstance(b, str) and _valid_date_text(a) and _valid_date_text(b)
        if (numbers or dates) and a > b:
            ctx.add(f"{path}.validation", "invalid_range", f"{low} must not be greater than {high}")


def _validate_field_rules(ctx: _Ctx, rules: Any, path: str, scope: _Scope) -> None:
    """Custom rules of one field: [{assert, message, when?}] (Phase 2.1)."""
    if not isinstance(rules, list) or not rules:
        ctx.add(path, "invalid_rule", "rules must be a non-empty array")
        return
    for index, rule in enumerate(rules):
        rule_path = f"{path}[{index}]"
        if not isinstance(rule, dict):
            ctx.add(rule_path, "invalid_rule", "A rule must be an object")
            continue
        ctx.unknown(rule, {"assert", "message", "when"}, rule_path)
        _check_rule_body(ctx, rule, rule_path, scope)


def _rule_value_ok(name: str, value: Any) -> bool:
    if name in ("required", "email", "numeric"):
        return isinstance(value, bool)
    if name in ("min", "max"):
        return is_number(value)
    if name == "min_length":
        return is_int(value) and value >= 0
    if name == "max_length":
        return is_int(value) and value >= 1
    if name == "message":
        return isinstance(value, str) and 0 < len(value) <= 200
    if name == "pattern":
        return isinstance(value, str) and 0 < len(value) <= 500
    return isinstance(value, str) and (_valid_date_text(value) or bool(RELATIVE_DATE.match(value)))


def _validate_section(ctx: _Ctx, section: Any, path: str, scope: _Scope, columns: int, depth: int) -> None:
    if not isinstance(section, dict):
        ctx.add(path, "not_object", "Section must be an object")
        return
    ctx.unknown(section, SECTION_KEYS, path)
    section_id = section.get("id")
    if not isinstance(section_id, str) or not ITEM_ID.match(section_id):
        ctx.add(f"{path}.id", "invalid_section_id", "Section id must be lower snake case")
    elif section_id in ctx.section_ids:
        ctx.add(f"{path}.id", "duplicate_section_id", f"Duplicate section id '{section_id}'")
    else:
        ctx.section_ids.add(section_id)
    if not isinstance(section.get("title"), str) or not section["title"].strip():
        ctx.add(f"{path}.title", "invalid_title", "Section title is required")
    _check_text(ctx, section, "description", path, 2000)
    if "layout" in section:
        columns = _validate_container_layout(ctx, section["layout"], f"{path}.layout", columns, SECTION_LAYOUTS)
    if "style" in section:
        _validate_style_ref(ctx, section["style"], f"{path}.style")
    if "visibility" in section:
        _validate_visibility(ctx, section["visibility"], f"{path}.visibility", scope)
    if "permission" in section:
        _validate_permission(ctx, section["permission"], f"{path}.permission", SECTION_ACTIONS)
    if "page_break" in section and section["page_break"] not in PAGE_BREAKS:
        ctx.add(f"{path}.page_break", "invalid_page_break", f"page_break must be one of {', '.join(PAGE_BREAKS)}")
    children: list[Any] = []
    if "sections" in section:
        if not isinstance(section["sections"], list):
            ctx.add(f"{path}.sections", "invalid_type", "sections must be an array")
        elif section["sections"] and depth >= MAX_NESTING:
            ctx.add(f"{path}.sections", "too_deep", f"Sections may nest at most {MAX_NESTING} levels")
        else:
            children = section["sections"]
    categories: list[Any] = []
    if "categories" in section:
        if isinstance(section["categories"], list):
            categories = section["categories"]
        else:
            ctx.add(f"{path}.categories", "invalid_type", "categories must be an array")
    section_fields = section.get("fields")
    if not isinstance(section_fields, list):
        if "fields" in section or not (children or categories):
            ctx.add(f"{path}.fields", "invalid_type", "fields must be an array")
        section_fields = []
    if "repeat" in section:
        if children or categories:
            ctx.add(f"{path}.repeat", "invalid_repeat", "A repeatable section holds fields only (no categories or sections)")
        _validate_repeat_block(ctx, section, path, section_fields, scope, columns)
    else:
        _validate_field_list(ctx, section_fields, f"{path}.fields", scope, columns, in_repeat=False, depth=1)
    for index, category in enumerate(categories):
        _validate_category(ctx, category, f"{path}.categories[{index}]", scope, columns)
    for index, child in enumerate(children):
        _validate_section(ctx, child, f"{path}.sections[{index}]", scope, columns, depth + 1)


def _validate_category(ctx: _Ctx, category: Any, path: str, scope: _Scope, columns: int) -> None:
    """A named sub-group of a section (Phase 2.0); its fields share the section's data scope."""
    if not isinstance(category, dict):
        ctx.add(path, "not_object", "Category must be an object")
        return
    ctx.unknown(category, CATEGORY_KEYS, path)
    category_id = category.get("id")
    if not isinstance(category_id, str) or not ITEM_ID.match(category_id):
        ctx.add(f"{path}.id", "invalid_category_id", "Category id must be lower snake case")
    elif category_id in ctx.category_ids:
        ctx.add(f"{path}.id", "duplicate_category_id", f"Duplicate category id '{category_id}'")
    else:
        ctx.category_ids.add(category_id)
    if not isinstance(category.get("title"), str) or not category["title"].strip():
        ctx.add(f"{path}.title", "invalid_title", "Category title is required")
    _check_text(ctx, category, "description", path, 2000)
    if "layout" in category:
        columns = _validate_container_layout(ctx, category["layout"], f"{path}.layout", columns, SECTION_LAYOUTS)
    if "style" in category:
        _validate_style_ref(ctx, category["style"], f"{path}.style")
    if "visibility" in category:
        _validate_visibility(ctx, category["visibility"], f"{path}.visibility", scope)
    if "permission" in category:
        _validate_permission(ctx, category["permission"], f"{path}.permission", SECTION_ACTIONS)
    if "page_break" in category and category["page_break"] not in PAGE_BREAKS:
        ctx.add(f"{path}.page_break", "invalid_page_break", f"page_break must be one of {', '.join(PAGE_BREAKS)}")
    category_fields = category.get("fields")
    if not isinstance(category_fields, list) or not category_fields:
        ctx.add(f"{path}.fields", "container_requires_fields", "A category needs at least one field")
        return
    if "repeat" in category:
        _validate_repeat_block(ctx, category, path, category_fields, scope, columns)
    else:
        _validate_field_list(ctx, category_fields, f"{path}.fields", scope, columns, in_repeat=False, depth=1)


def _validate_repeat_block(ctx: _Ctx, block: dict[str, Any], path: str, block_fields: list[Any], scope: _Scope, columns: int) -> None:
    """A repeatable section or category (Phase 2.7): its fields become the items of a list stored under repeat.key."""
    repeat = block["repeat"]
    r_path = f"{path}.repeat"
    if not isinstance(repeat, dict):
        ctx.add(r_path, "invalid_repeat", "repeat must be {key, min_items?, max_items?}")
        return
    ctx.unknown(repeat, {"key", "min_items", "max_items"}, r_path)
    key = repeat.get("key")
    if not isinstance(key, str) or not ITEM_ID.match(key):
        ctx.add(f"{r_path}.key", "invalid_field_key", "repeat.key must be lower snake case")
        return
    if key in scope.keys:
        ctx.add(f"{r_path}.key", "duplicate_field_key", f"Duplicate field key '{key}'")
    scope.keys.add(key)
    for bound in ("min_items", "max_items"):
        if bound in repeat and not (is_int(repeat[bound]) and 0 <= repeat[bound] <= 1000):
            ctx.add(f"{r_path}.{bound}", "invalid_type", f"{bound} must be an integer 0-1000")
    if is_int(repeat.get("min_items")) and is_int(repeat.get("max_items")) and repeat["min_items"] > repeat["max_items"]:
        ctx.add(r_path, "invalid_range", "min_items must not be greater than max_items")
    if not block_fields:
        ctx.add(f"{path}.fields", "container_requires_fields", "A repeatable block needs at least one field")
        return
    child = _Scope(parent=scope)
    scope.repeats[key] = child
    _validate_field_list(ctx, block_fields, f"{path}.fields", child, columns, in_repeat=True, depth=2)


def _validate_field_list(ctx: _Ctx, field_list: list[Any], path: str, scope: _Scope, columns: int, in_repeat: bool, depth: int) -> None:
    cells: list[tuple[str, tuple[int, int, int]]] = []
    for index, field in enumerate(field_list):
        f_path = f"{path}[{index}]"
        cell = _validate_field(ctx, field, f_path, scope, columns, in_repeat, depth)
        if cell is not None:
            cells.append((f_path, cell))
    _check_overlaps(ctx, cells)


def _validate_field(ctx: _Ctx, field: Any, path: str, scope: _Scope, columns: int, in_repeat: bool, depth: int) -> tuple[int, int, int] | None:
    if not isinstance(field, dict):
        ctx.add(path, "not_object", "Field must be an object")
        return None
    field_type = field.get("type")
    known_type = field_type in FIELD_TYPE_SPECS
    if not known_type:
        ctx.add(f"{path}.type", "invalid_field_type", f"Unknown field type '{field_type}'")
    every = all_props()
    allowed = allowed_props(field_type) if known_type else every
    for key in sorted(field):
        if key not in every:
            ctx.add(f"{path}.{key}", "unknown_property", f"Unknown property '{key}'")
        elif key not in allowed:
            ctx.add(f"{path}.{key}", "property_not_supported", f"'{key}' does not apply to {field_type} fields")
    value_kind = FIELD_TYPE_SPECS[field_type]["value"] if known_type else None

    field_id = field.get("id")
    id_duplicate = False
    if not isinstance(field_id, str) or not ITEM_ID.match(field_id):
        ctx.add(f"{path}.id", "invalid_field_id", "Field id must be lower snake case and must not start with '_'")
    elif field_id in ctx.field_ids:
        ctx.add(f"{path}.id", "duplicate_field_id", f"Duplicate field id '{field_id}'")
        id_duplicate = True
    else:
        ctx.field_ids.add(field_id)
    if "key" in field and (not isinstance(field["key"], str) or not ITEM_ID.match(field["key"])):
        ctx.add(f"{path}.key", "invalid_field_key", "Field key must be lower snake case and must not start with '_'")
    elif has_value(field_type) or not known_type:
        key = field_key(field)
        if isinstance(key, str) and ITEM_ID.match(key):
            # A duplicate id without an explicit key is already reported once as duplicate_field_id.
            if key in scope.keys and ("key" in field or not id_duplicate):
                ctx.add(f"{path}.key", "duplicate_field_key", f"Duplicate field key '{key}'")
            scope.keys.add(key)
    if not isinstance(field.get("label"), str) or not field["label"].strip():
        ctx.add(f"{path}.label", "invalid_label", "Field label is required")
    for flag in ("required", "readonly", "hidden", "visible", "indexed", "multiple", "clear_when_hidden"):
        if flag in field and not isinstance(field[flag], bool):
            ctx.add(f"{path}.{flag}", "invalid_type", f"{flag} must be a boolean")
    if isinstance(field.get("visible"), bool) and isinstance(field.get("hidden"), bool) and field["visible"] == field["hidden"]:
        ctx.add(f"{path}.visible", "conflicting_visibility", "visible and hidden disagree")
    for name, limit in (("description", 2000), ("placeholder", 200), ("unit", 40)):
        _check_text(ctx, field, name, path, limit)
    for bound in ("min", "max"):
        if bound in field and not is_number(field[bound]):
            ctx.add(f"{path}.{bound}", "invalid_type", f"{bound} must be a number")
    if is_number(field.get("min")) and is_number(field.get("max")) and field["min"] > field["max"]:
        ctx.add(path, "invalid_range", "min must not be greater than max")
    if "max_length" in field and (not is_int(field["max_length"]) or field["max_length"] < 1):
        ctx.add(f"{path}.max_length", "invalid_max_length", "max_length must be a positive integer")
    if "decimals" in field and not (is_int(field["decimals"]) and 0 <= field["decimals"] <= 10):
        ctx.add(f"{path}.decimals", "invalid_decimals", "decimals must be an integer 0-10")
    if value_kind in ("option", "options") or (not known_type and "options" in field):
        _validate_options(ctx, field, path, scope)
    if field_type == "calculated":
        _validate_calculated(ctx, field, path)
        if isinstance(field.get("formula"), str) and field["formula"].strip() and "calculator" not in field:
            ctx.formulas.append((f"{path}.formula", field["formula"], scope))
    if value_kind in ("file", "signature"):
        _validate_file_props(ctx, field, path)
    if "derive" in field and "derive" in allowed:
        _validate_derive(ctx, field, path, scope)

    if field.get("indexed") is True and "indexed" in allowed:
        if field_type not in INDEXABLE_TYPES:
            ctx.add(f"{path}.indexed", "index_not_supported", f"Fields of type '{field_type}' cannot be indexed")
        elif in_repeat:
            ctx.add(f"{path}.indexed", "index_not_supported", "Fields inside a repeat cannot be indexed")
        else:
            ctx.indexed += 1

    if "display" in field:
        _validate_display(ctx, field, path)
    cell = _validate_field_layout(ctx, field["layout"], f"{path}.layout", columns) if "layout" in field else None
    if "style" in field:
        _validate_style_ref(ctx, field["style"], f"{path}.style")
    if "validation" in field and "validation" in allowed:
        _validate_rules(ctx, field, path, value_kind, scope)
    if "visibility" in field:
        _validate_visibility(ctx, field["visibility"], f"{path}.visibility", scope)
    if "permission" in field:
        _validate_permission(ctx, field["permission"], f"{path}.permission", FIELD_ACTIONS)
    if field_type in ("group", "repeat"):
        _validate_container_field(ctx, field, path, scope, columns, in_repeat, depth)
    return cell


def _validate_calculated(ctx: _Ctx, field: dict[str, Any], path: str) -> None:
    if "formula" in field and "calculator" in field:
        ctx.add(f"{path}.calculator", "calculated_formula_conflict", "Use either formula or calculator, not both")
    elif "calculator" in field:
        if field["calculator"] not in ctx.calculators:
            ctx.add(f"{path}.calculator", "unknown_calculator", f"Calculator '{field['calculator']}' is not defined in calculators")
    elif not isinstance(field.get("formula"), str) or not field["formula"].strip():
        ctx.add(f"{path}.formula", "calculated_requires_formula", "calculated fields need a formula or a calculator")
    if field.get("required"):
        ctx.add(f"{path}.required", "calculated_not_required", "calculated fields cannot be required")


def _validate_container_field(ctx: _Ctx, field: dict[str, Any], path: str, scope: _Scope, columns: int, in_repeat: bool, depth: int) -> None:
    inner = columns
    if "columns" in field:
        if is_int(field["columns"]) and 1 <= field["columns"] <= 24:
            inner = field["columns"]
        else:
            ctx.add(f"{path}.columns", "invalid_columns", "columns must be an integer 1-24")
    for bound in ("min_items", "max_items"):
        if bound in field and not (is_int(field[bound]) and 0 <= field[bound] <= 1000):
            ctx.add(f"{path}.{bound}", "invalid_type", f"{bound} must be an integer 0-1000")
    if is_int(field.get("min_items")) and is_int(field.get("max_items")) and field["min_items"] > field["max_items"]:
        ctx.add(path, "invalid_range", "min_items must not be greater than max_items")
    if "view" in field and field["view"] not in REPEAT_VIEWS:
        ctx.add(f"{path}.view", "invalid_repeat", "view is cards (one card per row) or table (a spreadsheet-like grid)")
    children = field.get("fields")
    if not isinstance(children, list) or not children:
        ctx.add(f"{path}.fields", "container_requires_fields", f"{field['type']} fields need at least one child field")
    elif depth >= MAX_NESTING:
        ctx.add(f"{path}.fields", "too_deep", f"Groups and repeats may nest at most {MAX_NESTING} levels")
    else:
        repeat = field["type"] == "repeat"
        child_scope = _Scope(parent=scope) if repeat else scope
        if repeat and isinstance(field_key(field), str):
            scope.repeats[field_key(field)] = child_scope
        _validate_field_list(ctx, children, f"{path}.fields", child_scope, inner, in_repeat or repeat, depth + 1)


LOOKUP_NAME = re.compile(r"^[a-z][a-z0-9_]{0,63}\Z")


def _validate_pairs(ctx: _Ctx, pairs: Any, path: str, scope: _Scope, required: bool) -> None:
    """{lookup column: field key} for lookup filters and derive matches."""
    if pairs is None and not required:
        return
    if not isinstance(pairs, dict) or (required and not pairs):
        ctx.add(path, "invalid_lookup", "Map lookup columns to field keys: {\"column\": \"field_key\"}")
        return
    for column, key in pairs.items():
        if not LOOKUP_NAME.match(column):
            ctx.add(f"{path}.{column}", "invalid_lookup", "Lookup columns are lowercase identifiers")
        elif not isinstance(key, str) or not ITEM_ID.match(key):
            ctx.add(f"{path}.{column}", "invalid_lookup", "Each column maps to a field key")
        else:
            ctx.refs.append((f"{path}.{column}", key, scope))


def _validate_lookup(ctx: _Ctx, field: dict[str, Any], path: str, scope: _Scope) -> None:
    """lookup: {source, value, label?, filter?} (Phase 2.3): options from a registered lookup table."""
    spec = field["lookup"]
    if not isinstance(spec, dict):
        ctx.add(f"{path}.lookup", "invalid_lookup", "lookup must be {source, value, label?, filter?}")
        return
    ctx.unknown(spec, {"source", "value", "label", "filter"}, f"{path}.lookup")
    if not isinstance(spec.get("source"), str) or not LOOKUP_NAME.match(spec["source"]):
        ctx.add(f"{path}.lookup.source", "invalid_lookup", "source names a lookup table")
    for column in ("value", "label"):
        if (column == "value" or column in spec) and (not isinstance(spec.get(column), str) or not LOOKUP_NAME.match(spec[column])):
            ctx.add(f"{path}.lookup.{column}", "invalid_lookup", f"{column} names a lookup column")
    _validate_pairs(ctx, spec.get("filter"), f"{path}.lookup.filter", scope, False)
    if "options" in field:
        ctx.add(f"{path}.lookup", "invalid_lookup", "Use options or lookup, not both")


def _validate_derive(ctx: _Ctx, field: dict[str, Any], path: str, scope: _Scope) -> None:
    """derive: {lookup, column, match} (Phase 2.3): the value comes from a lookup row; the server recomputes it."""
    spec = field["derive"]
    if not isinstance(spec, dict):
        ctx.add(f"{path}.derive", "invalid_lookup", "derive must be {lookup, column, match}")
        return
    ctx.unknown(spec, {"lookup", "column", "match"}, f"{path}.derive")
    for name in ("lookup", "column"):
        if not isinstance(spec.get(name), str) or not LOOKUP_NAME.match(spec[name]):
            ctx.add(f"{path}.derive.{name}", "invalid_lookup", f"{name} names a lookup {'table' if name == 'lookup' else 'column'}")
    _validate_pairs(ctx, spec.get("match"), f"{path}.derive.match", scope, True)


def _validate_options(ctx: _Ctx, field: dict[str, Any], path: str, scope: _Scope) -> None:
    if "lookup" in field:
        _validate_lookup(ctx, field, path, scope)
        return
    options = field.get("options")
    if not isinstance(options, list) or not options:
        ctx.add(f"{path}.options", "missing_options", "select fields need at least one option")
        return
    values: set[str] = set()
    for o_index, option in enumerate(options):
        value = option.get("value") if isinstance(option, dict) else None
        if not isinstance(value, str) or not value or not isinstance(option.get("label"), str):
            ctx.add(f"{path}.options[{o_index}]", "invalid_option", "Option needs a string value and label")
        elif value in values:
            ctx.add(f"{path}.options[{o_index}]", "duplicate_option", f"Duplicate option '{value}'")
        else:
            values.add(value)
            o_path = f"{path}.options[{o_index}]"
            ctx.unknown(option, {"value", "label", "has_input", "input_required", "when"}, o_path)
            for flag in ("has_input", "input_required"):
                if flag in option and not isinstance(option[flag], bool):
                    ctx.add(f"{o_path}.{flag}", "invalid_option", f"{flag} must be a boolean")
            if option.get("input_required") is True and option.get("has_input") is not True:
                ctx.add(f"{o_path}.input_required", "invalid_option", "input_required needs has_input")
            if "when" in option:
                _validate_condition(ctx, option["when"], f"{o_path}.when", scope, 1)


def _validate_file_props(ctx: _Ctx, field: dict[str, Any], path: str) -> None:
    if "accept" in field:
        accept = field["accept"]
        if not isinstance(accept, list) or not accept or not all(isinstance(item, str) and MIME.match(item) for item in accept):
            ctx.add(f"{path}.accept", "invalid_accept", "accept must list MIME types such as image/png or image/*")
    if "max_size_kb" in field and not (is_int(field["max_size_kb"]) and 1 <= field["max_size_kb"] <= 1048576):
        ctx.add(f"{path}.max_size_kb", "invalid_max_size", "max_size_kb must be an integer 1-1048576")


def _validate_extensions(definition: dict[str, Any]) -> list[Issue]:
    extensions = definition.get("extensions")
    if not isinstance(extensions, dict) or SUBJECT_FIELD_KEY not in extensions:
        return []
    field = field_map(definition).get(extensions[SUBJECT_FIELD_KEY]) if isinstance(extensions[SUBJECT_FIELD_KEY], str) else None
    if field is None or field.get("type") not in SUBJECT_FIELD_TYPES:
        return [Issue(f"$.extensions.{SUBJECT_FIELD_KEY}", "invalid_subject_field", "Subject field must name a text, select, radio or integer field")]
    return []


def _validate_migration(definition: dict[str, Any], field_keys: set[str]) -> list[Issue]:
    if "migration" not in definition:
        return []
    migration = definition["migration"]
    version = definition.get("schema_version")
    if not isinstance(migration, dict) or not is_int(version) or version < 2 or migration.get("from") != version - 1 or not isinstance(migration.get("ops"), list):
        return [Issue("$.migration", "invalid_migration", "migration.from must be schema_version - 1 and ops must be an array")]
    issues: list[Issue] = []
    for index, op in enumerate(migration["ops"]):
        path = f"$.migration.ops[{index}]"
        name = op.get("op") if isinstance(op, dict) else None
        required = MIGRATION_OPS.get(name)
        if required is None or not set(op) <= required or not (required - {"default"}) <= set(op):
            issues.append(Issue(path, "invalid_migration", f"Unknown or malformed migration op '{name}'"))
            continue
        if name == "rename_field":
            if not isinstance(op["from"], str) or op["to"] not in field_keys:
                issues.append(Issue(path, "migration_unknown_field", f"rename target '{op['to']}' is not a field of this version"))
        elif name == "remove_field":
            if op["field"] in field_keys:
                issues.append(Issue(path, "migration_unknown_field", f"removed field '{op['field']}' is still defined"))
        elif name == "map_values":
            if op["field"] not in field_keys or not isinstance(op["mapping"], dict) or not all(isinstance(v, str) for v in op["mapping"].values()):
                issues.append(Issue(path, "migration_unknown_field", f"map_values field '{op['field']}' is not a field of this version"))
        elif name == "convert_type":
            if op["field"] not in field_keys or op["to"] not in CONVERT_TARGETS:
                issues.append(Issue(path, "migration_unknown_field", f"convert_type field '{op['field']}' is not a field of this version"))
        elif op["field"] not in field_keys:
            issues.append(Issue(path, "migration_unknown_field", f"added field '{op['field']}' is not a field of this version"))
    return issues


# ---------------------------------------------------------------------------------------------
# Readable errors and strict parsing (Phase 1.10)
# ---------------------------------------------------------------------------------------------

PATH_TOKEN = re.compile(r"\.([^.\[\]]+)|\[(\d+)\]")
CONTAINERS = ("sections", "categories", "fields", "calculators")


def _label(kind: str, item: Any, position: int) -> str:
    if not isinstance(item, dict):
        return f"{kind} {position + 1}"
    if kind == "Section":
        return f'Section "{item.get("title") or item.get("id") or position + 1}"'
    if kind == "Calculator":
        return f'Calculator "{item.get("id") or position + 1}"'
    if kind == "Category":
        return f'Category "{item.get("title") or item.get("id") or position + 1}"'
    key = field_key(item)
    shown = isinstance(key, str) and item.get("type") != "group"  # a group has no data key
    return f'Field "{item.get("label") or key or position + 1}"' + (f" ({key})" if shown else "")


def describe_path(definition: Any, path: str) -> str:
    """'$.sections[0].fields[2].layout.span' -> 'Section "Vitals" › Field "BP" (bp_sys) › layout.span'.
    Record paths ('$.data.meds[1].dose') name the field and the repeat item."""
    if not isinstance(path, str) or not path.startswith("$"):
        return str(path)
    parts: list[str] = []
    pending: list[str] = []
    node: Any = definition
    kind: str | None = None

    def flush() -> None:
        if pending:
            parts.append(".".join(pending))
            pending.clear()

    for match in PATH_TOKEN.finditer(path[1:]):
        name, index = match.group(1), match.group(2)
        if name is not None:
            if kind == "data" and isinstance(node, dict) and name in node:
                flush()
                field = node[name]
                parts.append(_label("Field", field, 0))
                node, kind = field, ("items" if field.get("type") == "repeat" else None)
            elif kind is None and name in CONTAINERS and isinstance(node, dict):
                node, kind = node.get(name), name
            elif not parts and not pending and name == "data" and isinstance(definition, dict):
                node, kind = field_map(definition), "data"
            else:
                pending.append(name)
                node, kind = (node.get(name) if isinstance(node, dict) else None), None
            continue
        position = int(index)
        if kind in CONTAINERS:
            item = node[position] if isinstance(node, list) and position < len(node) else None
            flush()
            parts.append(_label({"sections": "Section", "categories": "Category", "fields": "Field", "calculators": "Calculator"}[kind], item, position))
            node, kind = item, None
        elif kind == "items" and isinstance(node, dict):
            flush()
            parts.append(f"Item {position + 1}")
            node, kind = item_map(node), "data"
        else:
            if pending:
                pending[-1] += f"[{position}]"
            else:
                pending.append(f"[{position}]")
            node = node[position] if isinstance(node, list) and position < len(node) else None
            kind = None
    flush()
    return " › ".join(parts) if parts else "form"


def describe_issues(definition: Any, issues: list[Issue]) -> list[dict[str, str]]:
    """Issues with a readable location and the Thai message for their code (formdev/spec/messages.json)."""
    return [{**issue.as_dict(), "location": describe_path(definition, issue.path), "message_th": MESSAGES.get(issue.code, {}).get("th", issue.message)}
            for issue in issues]


class _Pairs(dict):
    """dict that remembers keys it saw more than once while parsing."""
    duplicates: list[str]


def _pairs_hook(pairs: list[tuple[str, Any]]) -> _Pairs:
    out = _Pairs()
    out.duplicates = []
    for key, value in pairs:
        if key in out and key not in out.duplicates:
            out.duplicates.append(key)
        out[key] = value
    return out


def parse_json_strict(text: str) -> tuple[Any, list[Issue]]:
    """Parse JSON and report duplicate object keys, which json.loads would silently collapse."""
    try:
        value = json.loads(text, object_pairs_hook=_pairs_hook)
    except (ValueError, RecursionError) as error:
        return None, [Issue("$", "invalid_json", f"Not valid JSON: {error}")]
    issues: list[Issue] = []

    def walk(node: Any, path: str) -> Any:
        if isinstance(node, _Pairs):
            for key in node.duplicates:
                issues.append(Issue(f"{path}.{key}", "duplicate_json_key", f"Key '{key}' appears more than once"))
            return {key: walk(item, f"{path}.{key}") for key, item in node.items()}
        if isinstance(node, list):
            return [walk(item, f"{path}[{index}]") for index, item in enumerate(node)]
        return node

    return walk(value, "$"), issues


# ---------------------------------------------------------------------------------------------
# Record values. Each stored value kind has one validator (strategy per field_types "value").
# ---------------------------------------------------------------------------------------------

def _empty(value: Any) -> bool:
    return value is None or value == "" or value == []


def _valid_date(text: str) -> bool:
    try:
        date.fromisoformat(text)
        return True
    except ValueError:
        return False


def _valid_date_text(text: str) -> bool:
    return bool(DATE.match(text)) and _valid_date(text)


def _valid_datetime(text: str) -> bool:
    match = DATETIME.match(text)
    if not match or not _valid_date(match.group(1)):
        return False
    hour, minute, second = int(match.group(2)), int(match.group(3)), int(match.group(4) or 0)
    return hour < 24 and minute < 60 and second < 60


def datetime_epoch_ms(text: str, default_offset_minutes: int = DEFAULT_TZ_OFFSET_MINUTES) -> int | None:
    """Instant of an ISO datetime in epoch ms; values without an offset use default_offset_minutes.
    Mirrors datetimeEpochMs() in validate.ts (fractions truncated to milliseconds)."""
    match = DATETIME.match(text) if isinstance(text, str) else None
    if not match or not _valid_datetime(text):
        return None
    year, month, day = (int(part) for part in match.group(1).split("-"))
    millis = int(((match.group(5) or "") + "000")[:3])
    zone = match.group(6)
    offset = 0 if zone == "Z" else default_offset_minutes if zone is None else (1 if zone[0] == "+" else -1) * (int(zone[1:3]) * 60 + int(zone[4:6]))
    days = (date(year, month, day) - date(1970, 1, 1)).days
    seconds = days * 86400 + int(match.group(2)) * 3600 + int(match.group(3)) * 60 + int(match.group(4) or 0)
    return seconds * 1000 + millis - offset * 60000


def _valid_time(text: str) -> bool:
    match = TIME.match(text)
    return bool(match) and int(match.group(1)) < 24 and int(match.group(2)) < 60 and int(match.group(3) or 0) < 60


def _value_text(field: dict[str, Any], value: Any, path: str) -> list[Issue]:
    if not isinstance(value, str):
        return [Issue(path, "invalid_type", "Expected text")]
    max_length = effective_rules(field).get("max_length")
    if is_int(max_length) and len(value) > max_length:
        return [Issue(path, "too_long", f"Maximum {max_length} characters")]
    return []


def _value_number(field: dict[str, Any], value: Any, path: str) -> list[Issue]:
    kind = FIELD_TYPE_SPECS[field["type"]]["value"]
    if not is_number(value) or (kind == "integer" and not (is_int(value) or float(value).is_integer())):
        return [Issue(path, "invalid_type", "Expected an integer" if kind == "integer" else "Expected a number")]
    rules = effective_rules(field)
    if (is_number(rules.get("min")) and value < rules["min"]) or (is_number(rules.get("max")) and value > rules["max"]):
        return [Issue(path, "out_of_range", "Value is outside the allowed range")]
    if kind == "decimal":
        decimals = field["decimals"] if is_int(field.get("decimals")) else 2
        scaled = value * 10 ** decimals
        if abs(scaled - round(scaled)) > 1e-9 * max(1.0, abs(scaled)):
            return [Issue(path, "too_many_decimals", f"At most {decimals} decimal places")]
    return []


def _value_temporal(field: dict[str, Any], value: Any, path: str) -> list[Issue]:
    field_type = field["type"]
    check = {"date": _valid_date_text, "datetime": _valid_datetime, "time": _valid_time}[field_type]
    return [] if isinstance(value, str) and check(value) else [Issue(path, "invalid_date", f"Expected an ISO {field_type}")]


def _options(field: dict[str, Any]) -> set[Any]:
    return {option.get("value") for option in field.get("options") or [] if isinstance(option, dict)}


def _value_option(field: dict[str, Any], value: Any, path: str) -> list[Issue]:
    # Lookup options (Phase 2.3) come from registry data; the record evaluator checks them against the table.
    if "lookup" in field:
        return [] if isinstance(value, str) and value else [Issue(path, "invalid_type", "Expected an option value")]
    return [] if isinstance(value, str) and value in _options(field) else [Issue(path, "invalid_option", "Value is not one of the options")]


def _value_options(field: dict[str, Any], value: Any, path: str) -> list[Issue]:
    if not isinstance(value, list) or len(set(map(str, value))) != len(value):
        return [Issue(path, "invalid_type", "Expected a list of unique options")]
    if "lookup" in field:
        return [] if all(isinstance(item, str) and item for item in value) else [Issue(path, "invalid_type", "Expected a list of option values")]
    allowed = _options(field)
    return [] if all(isinstance(item, str) and item in allowed for item in value) else [Issue(path, "invalid_option", "Value is not one of the options")]


def _value_boolean(field: dict[str, Any], value: Any, path: str) -> list[Issue]:
    return [] if isinstance(value, bool) else [Issue(path, "invalid_type", "Expected true or false")]


def _mime_allowed(mime: str, accept: list[str]) -> bool:
    return any(pattern == mime or (pattern.endswith("/*") and mime.startswith(pattern[:-1])) for pattern in accept)


def _file_ok(item: Any) -> bool:
    return isinstance(item, dict) and not set(item) - {"name", "mime", "size", "ref"} \
        and isinstance(item.get("name"), str) and 0 < len(item["name"]) <= 255 \
        and isinstance(item.get("mime"), str) and bool(MIME.match(item["mime"])) and "*" not in item["mime"] \
        and is_int(item.get("size")) and item["size"] >= 0 \
        and isinstance(item.get("ref"), str) and 0 < len(item["ref"]) <= 500


def _value_file(field: dict[str, Any], value: Any, path: str) -> list[Issue]:
    many = field.get("multiple") is True
    if many and not isinstance(value, list):
        return [Issue(path, "invalid_type", "Expected a list of files")]
    items = value if many else [value]
    accept = field.get("accept") or (["image/*"] if field["type"] == "image" else None)
    issues: list[Issue] = []
    for index, item in enumerate(items):
        item_path = f"{path}[{index}]" if many else path
        if not _file_ok(item):
            issues.append(Issue(item_path, "invalid_file", "Expected {name, mime, size, ref}"))
        elif accept and not _mime_allowed(item["mime"], accept):
            issues.append(Issue(item_path, "file_type_not_allowed", f"File type {item['mime']} is not accepted"))
        elif is_int(field.get("max_size_kb")) and item["size"] > field["max_size_kb"] * 1024:
            issues.append(Issue(item_path, "file_too_large", f"Larger than {field['max_size_kb']} KB"))
    return issues


def _value_signature(field: dict[str, Any], value: Any, path: str) -> list[Issue]:
    ok = isinstance(value, dict) and not set(value) - {"data", "signed_at", "signer"} and isinstance(value.get("data"), str) \
        and bool(SIGNATURE_DATA.match(value["data"])) \
        and ("signed_at" not in value or (isinstance(value["signed_at"], str) and _valid_datetime(value["signed_at"]))) \
        and ("signer" not in value or (isinstance(value["signer"], str) and len(value["signer"]) <= 200))
    if not ok:
        return [Issue(path, "invalid_signature", "Expected {data: PNG or SVG data URL, signed_at?, signer?}")]
    limit = field["max_size_kb"] if is_int(field.get("max_size_kb")) else DEFAULT_SIGNATURE_KB
    return [Issue(path, "file_too_large", f"Larger than {limit} KB")] if len(value["data"]) > limit * 1024 else []


def _value_list(field: dict[str, Any], value: Any, path: str) -> list[Issue]:
    if not isinstance(value, list) or not all(isinstance(item, dict) for item in value):
        return [Issue(path, "invalid_type", "Expected a list of items")]
    issues: list[Issue] = []
    if is_int(field.get("max_items")) and len(value) > field["max_items"]:
        issues.append(Issue(path, "too_many_items", f"At most {field['max_items']} items"))
    children = item_map(field)
    for index, item in enumerate(value):
        issues.extend(_validate_scope(children, item, f"{path}[{index}]"))
    return issues


VALUE_VALIDATORS: dict[str, Callable[[dict[str, Any], Any, str], list[Issue]]] = {
    "text": _value_text, "number": _value_number, "integer": _value_number, "decimal": _value_number,
    "date": _value_temporal, "datetime": _value_temporal, "time": _value_temporal,
    "option": _value_option, "options": _value_options, "boolean": _value_boolean,
    "file": _value_file, "signature": _value_signature, "list": _value_list,
}


def validate_value(field: dict[str, Any], value: Any, path: str) -> list[Issue]:
    if value is None:
        return []
    if field.get("type") == "calculated" and isinstance(value, (str, bool)):
        return []  # text or boolean calculator output; the server recomputes calculated values anyway
    spec = FIELD_TYPE_SPECS.get(field.get("type"))
    validator = VALUE_VALIDATORS.get(spec["value"]) if spec and spec["value"] else None
    return validator(field, value, path) if validator else [Issue(path, "invalid_type", "Unsupported field type")]


def _validate_scope(by_key: dict[str, dict[str, Any]], data: dict[str, Any], path: str) -> list[Issue]:
    issues: list[Issue] = []
    for key in sorted(data):
        if key == RETIRED_KEY and path == "$.data":
            if not isinstance(data[key], dict):
                issues.append(Issue(f"{path}.{key}", "invalid_type", "_retired must be an object"))
            continue
        if key == OTHER_KEY:
            other = data[key]
            if not isinstance(other, dict) or not all(isinstance(text, str) and len(text) <= MAX_OTHER_TEXT for text in other.values()):
                issues.append(Issue(f"{path}.{key}", "invalid_type", f"_other maps field keys to text (max {MAX_OTHER_TEXT} characters)"))
            continue
        field = by_key.get(key)
        if field is None:
            issues.append(Issue(f"{path}.{key}", "unknown_field", f"'{key}' is not a field of this form version"))
            continue
        issues.extend(validate_value(field, data[key], f"{path}.{key}"))
    return issues


def _required_issues(by_key: dict[str, dict[str, Any]], data: dict[str, Any], path: str) -> list[Issue]:
    issues: list[Issue] = []
    for key, field in by_key.items():
        value = data.get(key)
        if effective_rules(field).get("required") is True and _empty(value):
            issues.append(Issue(f"{path}.{key}", "required", f"'{field.get('label', key)}' is required"))
        if field.get("type") == "repeat" and isinstance(value, list):
            if is_int(field.get("min_items")) and len(value) < field["min_items"]:
                issues.append(Issue(f"{path}.{key}", "too_few_items", f"At least {field['min_items']} items"))
            children = item_map(field)
            for index, item in enumerate(value):
                if isinstance(item, dict):
                    issues.extend(_required_issues(children, item, f"{path}.{key}[{index}]"))
    return issues


def validate_record(definition: dict[str, Any], data: Any, status: str) -> list[Issue]:
    """Validate record data against one schema version. Drafts skip required checks."""
    if status not in RECORD_STATUSES:
        return [Issue("$.status", "invalid_status", f"status must be one of {', '.join(RECORD_STATUSES)}")]
    if not isinstance(data, dict):
        return [Issue("$.data", "not_object", "Record data must be an object")]
    by_key = field_map(definition)
    issues = _validate_scope(by_key, data, "$.data")
    if status == "submitted":
        issues.extend(_required_issues(by_key, data, "$.data"))
    return issues


def subject_value(definition: dict[str, Any], data: dict[str, Any]) -> str | None:
    """subject_id metadata from extensions["flora.subject_field"] (None when unset or empty)."""
    extensions = definition.get("extensions")
    key = extensions.get(SUBJECT_FIELD_KEY) if isinstance(extensions, dict) else None
    value = data.get(key) if isinstance(key, str) else None
    if value is None or value == "" or isinstance(value, (bool, list, dict)):
        return None
    return str(int(value)) if isinstance(value, float) and value.is_integer() else str(value)


def index_entries(definition: dict[str, Any], data: dict[str, Any]) -> list[dict[str, Any]]:
    """Values copied into the record index so filters use B-tree indexes instead of JSON scans.
    Datetimes keep their text and also get value_num = epoch ms so ranges and sorts follow time."""
    entries: list[dict[str, Any]] = []
    for field in fields(definition):
        if field.get("indexed") is not True or field.get("type") not in INDEX_FAMILY:
            continue
        key = field_key(field)
        value = data.get(key)
        if value is None or value == "":
            continue
        family, kind = INDEX_FAMILY[field["type"]], FIELD_TYPE_SPECS[field["type"]]["value"]
        if kind == "boolean":
            entries.append({"field_id": key, "value_text": None, "value_num": 1 if value else 0})
        elif family == "num":
            entries.append({"field_id": key, "value_text": None, "value_num": float(value) if not is_int(value) else value})
        elif family == "datetime":
            entries.append({"field_id": key, "value_text": str(value), "value_num": datetime_epoch_ms(str(value))})
        else:
            entries.append({"field_id": key, "value_text": str(value), "value_num": None})
    return sorted(entries, key=lambda entry: entry["field_id"])
