"""Style and font registries (Phase 1.7, 1.8, 1.9).

A style is {name, category, inherit?, paper?, tokens, components?}. Tokens come from
field_types.STYLE_TOKENS; components hold token subsets for label, input, section, header and
footer. Inheritance runs base style -> form style -> section style -> field style -> instance
override; the resolver lives in frontend/src/formdev/core/styles.ts (presentation), this module
validates registry rows so a broken style can never be saved or seeded.
"""
from __future__ import annotations

from typing import Any, Iterable

from .definition import REGISTRY_ID, Issue, iter_sections, section_field_lists, style_ref, token_value_ok
from .field_types import STYLE_COMPONENTS, STYLE_TOKENS

STYLE_CATEGORIES = ("base", "form", "section", "field")
STYLE_KEYS = {"name", "category", "inherit", "paper", "tokens", "components"}
FONT_ASSET_KINDS = ("bundled", "system", "web_alternative", "file")
MAX_INHERIT_DEPTH = 8


def normalize_style(definition: dict[str, Any]) -> dict[str, Any]:
    """Map a pre-Phase-1 style row ({font_id, base_size_pt, label, section, columns, margin_mm})
    onto the token format. Rows already in the token format are returned unchanged."""
    if "tokens" in definition:
        return definition
    tokens: dict[str, Any] = {}
    components: dict[str, dict[str, Any]] = {}
    if isinstance(definition.get("font_id"), str):
        tokens["fontId"] = definition["font_id"]
    if isinstance(definition.get("base_size_pt"), (int, float)):
        tokens["fontSize"] = definition["base_size_pt"]
    if isinstance(definition.get("columns"), int):
        tokens["columns"] = definition["columns"]
    margin = definition.get("margin_mm") if isinstance(definition.get("margin_mm"), dict) else {}
    for side in ("top", "right", "bottom", "left"):
        if isinstance(margin.get(side), (int, float)):
            tokens[f"pageMargin{side.capitalize()}"] = margin[side]
    label = definition.get("label") if isinstance(definition.get("label"), dict) else {}
    if label:
        components["label"] = {k: v for k, v in (("fontWeight", label.get("weight")), ("fontSize", label.get("size_pt"))) if v is not None}
    section = definition.get("section") if isinstance(definition.get("section"), dict) else {}
    if section.get("rule") in ("none", "solid", "card"):
        tokens["rule"] = section["rule"]
    if section.get("title_size_pt") is not None:
        components["section"] = {"fontSize": section["title_size_pt"]}
    out: dict[str, Any] = {"name": definition.get("title") or "Style", "category": "form", "tokens": tokens}
    if definition.get("paper"):
        out["paper"] = definition["paper"]
    if components:
        out["components"] = components
    return out


def _token_issues(tokens: Any, path: str, font_ids: set[str] | None) -> list[Issue]:
    if not isinstance(tokens, dict):
        return [Issue(path, "invalid_type", "tokens must be an object")]
    issues: list[Issue] = []
    for name, value in tokens.items():
        spec = STYLE_TOKENS.get(name)
        if spec is None:
            issues.append(Issue(f"{path}.{name}", "unknown_style_token", f"Unknown style token '{name}'"))
        elif not token_value_ok(spec, value):
            issues.append(Issue(f"{path}.{name}", "invalid_style_token", f"Invalid value for style token '{name}'"))
        elif spec["type"] == "font" and font_ids is not None and value not in font_ids:
            issues.append(Issue(f"{path}.{name}", "unknown_font", f"Font '{value}' is not in the font registry"))
    return issues


def validate_style(style_id: Any, definition: Any, font_ids: Iterable[str] | None = None) -> list[Issue]:
    """Structure of one style row (inheritance targets are checked by validate_style_registry)."""
    fonts = set(font_ids) if font_ids is not None else None
    issues: list[Issue] = []
    if not isinstance(style_id, str) or not REGISTRY_ID.match(style_id):
        issues.append(Issue("$.style_id", "invalid_style_id", "style id must be a registry id"))
    if not isinstance(definition, dict):
        return issues + [Issue("$", "not_object", "Style definition must be an object")]
    issues.extend(Issue(f"$.{key}", "unknown_property", f"Unknown property '{key}'") for key in sorted(set(definition) - STYLE_KEYS))
    if not isinstance(definition.get("name"), str) or not definition["name"].strip():
        issues.append(Issue("$.name", "invalid_type", "name is required"))
    if definition.get("category") not in STYLE_CATEGORIES:
        issues.append(Issue("$.category", "invalid_type", f"category must be one of {', '.join(STYLE_CATEGORIES)}"))
    if "inherit" in definition and (not isinstance(definition["inherit"], str) or not REGISTRY_ID.match(definition["inherit"])):
        issues.append(Issue("$.inherit", "invalid_style_id", "inherit must be a style id"))
    if "paper" in definition and definition["paper"] not in ("A4", "A5", "Letter", "screen"):
        issues.append(Issue("$.paper", "invalid_paper", "paper must be A4, A5, Letter or screen"))
    issues.extend(_token_issues(definition.get("tokens"), "$.tokens", fonts))
    components = definition.get("components", {})
    if not isinstance(components, dict):
        issues.append(Issue("$.components", "invalid_type", "components must be an object"))
    else:
        for name, tokens in components.items():
            if name not in STYLE_COMPONENTS:
                issues.append(Issue(f"$.components.{name}", "unknown_property", f"Unknown component '{name}'"))
            else:
                issues.extend(_token_issues(tokens, f"$.components.{name}", fonts))
    return issues


def validate_style_registry(rows: list[dict[str, Any]], font_ids: Iterable[str] | None = None) -> list[Issue]:
    """Every row valid, every inherit target present, no inheritance cycles."""
    fonts = list(font_ids) if font_ids is not None else None
    issues: list[Issue] = []
    parents: dict[str, str | None] = {}
    for index, row in enumerate(rows):
        definition = normalize_style(row.get("definition") if isinstance(row.get("definition"), dict) else {})
        for item in validate_style(row.get("style_id"), definition, fonts):
            issues.append(Issue(f"$[{index}]{item.path[1:]}", item.code, item.message))
        if isinstance(row.get("style_id"), str):
            if row["style_id"] in parents:
                issues.append(Issue(f"$[{index}].style_id", "duplicate_style_id", f"Duplicate style '{row['style_id']}'"))
            parents[row["style_id"]] = definition.get("inherit")
    for style_id, parent in parents.items():
        if parent is not None and parent not in parents:
            issues.append(Issue(f"$.{style_id}.inherit", "unknown_style", f"'{style_id}' inherits unknown style '{parent}'"))
        seen, current = {style_id}, parent
        for _ in range(MAX_INHERIT_DEPTH + 1):
            if current is None or current not in parents:
                break
            if current in seen:
                issues.append(Issue(f"$.{style_id}.inherit", "style_cycle", f"'{style_id}' inherits from itself through '{current}'"))
                break
            seen.add(current)
            current = parents[current]
        else:
            issues.append(Issue(f"$.{style_id}.inherit", "style_cycle", f"'{style_id}' inherits more than {MAX_INHERIT_DEPTH} levels deep"))
    return issues


def validate_font(font_id: Any, metadata: Any) -> list[Issue]:
    """A font row as stored ({family, ..., assets?, fallback}); font files are never embedded."""
    issues: list[Issue] = []
    if not isinstance(font_id, str) or not REGISTRY_ID.match(font_id):
        issues.append(Issue("$.font_id", "invalid_font_id", "font id must be a registry id"))
    if not isinstance(metadata, dict) or not isinstance(metadata.get("family"), str) or not metadata["family"].strip():
        return issues + [Issue("$.metadata.family", "invalid_type", "metadata.family is required")]
    fallback = metadata.get("fallback")
    if not isinstance(fallback, list) or not fallback or not all(isinstance(item, str) and item for item in fallback):
        issues.append(Issue("$.metadata.fallback", "invalid_type", "fallback must be a non-empty list of family names"))
    assets = metadata.get("assets", [])
    if not isinstance(assets, list) or not all(isinstance(asset, dict) and asset.get("kind") in FONT_ASSET_KINDS for asset in assets):
        issues.append(Issue("$.metadata.assets", "invalid_type", f"assets must be objects with kind {', '.join(FONT_ASSET_KINDS)}"))
    return issues


def stored_font(entry: dict[str, Any]) -> dict[str, Any]:
    """Registry file entry {font_id, metadata, assets, fallback} -> the metadata column stored in the database."""
    return {**entry["metadata"], "assets": entry.get("assets", []), "fallback": entry.get("fallback", [])}


def _all_fields(field_list: Any) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    for field in field_list if isinstance(field_list, list) else []:
        if isinstance(field, dict):
            out.append(field)
            out.extend(_all_fields(field.get("fields")))
    return out


def _holders(section: dict[str, Any]) -> list[dict[str, Any]]:
    """A section, its categories and every field inside them: everything that can carry a style."""
    categories = [category for category in section.get("categories") or [] if isinstance(category, dict)]
    out: list[dict[str, Any]] = [section, *categories]
    for field_list in section_field_lists(section):
        out.extend(_all_fields(field_list))
    return out


def _override_fonts(style: Any) -> set[str]:
    override = style.get("override") if isinstance(style, dict) else None
    if not isinstance(override, dict):
        return set()
    found = {override["fontId"]} if isinstance(override.get("fontId"), str) else set()
    for component in STYLE_COMPONENTS:
        if isinstance(override.get(component), dict) and isinstance(override[component].get("fontId"), str):
            found.add(override[component]["fontId"])
    return found


def styles_used(definition: dict[str, Any]) -> list[str]:
    """Style ids a definition references directly (form, sections, fields), in first-use order."""
    used: list[str] = []
    form_style = style_ref(definition)
    if form_style:
        used.append(form_style)
    for section in iter_sections(definition):
        for holder in _holders(section):
            style = holder.get("style")
            if isinstance(style, dict) and isinstance(style.get("id"), str) and style["id"] not in used:
                used.append(style["id"])
    return used


def style_closure(get_style: Any, style_ids: list[str]) -> list[dict[str, Any]]:
    """Rows for the given styles plus everything they inherit from, parents first."""
    rows: dict[str, dict[str, Any]] = {}
    order: list[str] = []

    def visit(style_id: str, depth: int) -> None:
        if style_id in rows or depth > MAX_INHERIT_DEPTH:
            return
        row = get_style(style_id)
        rows[style_id] = row
        parent = normalize_style(row["definition"]).get("inherit")
        if isinstance(parent, str):
            visit(parent, depth + 1)
        order.append(style_id)

    for style_id in style_ids:
        visit(style_id, 0)
    return [rows[style_id] for style_id in order]


def fonts_used(definition: dict[str, Any], style_rows: list[dict[str, Any]]) -> list[str]:
    """Font ids a definition needs: its font_id, fontId tokens of its styles and of every override."""
    found: set[str] = {definition["font_id"]} if isinstance(definition.get("font_id"), str) else set()
    found |= _override_fonts(definition.get("style"))
    for section in iter_sections(definition):
        for holder in _holders(section):
            found |= _override_fonts(holder.get("style"))
    for row in style_rows:
        style = normalize_style(row["definition"])
        found |= _override_fonts({"override": {**(style.get("tokens") or {}), **(style.get("components") or {})}})
    return sorted(found)


def pack_registry(definition: dict[str, Any], get_style: Any, get_font: Any) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    """Style rows (with everything they inherit, parents first) and font rows a form package must carry
    so the form renders in an empty standalone registry."""
    style_rows = style_closure(get_style, styles_used(definition))
    return style_rows, [get_font(font_id) for font_id in fonts_used(definition, style_rows)]
