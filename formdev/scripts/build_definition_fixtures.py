#!/usr/bin/env python3
"""Build the Phase 1 cases of the shared definition and record fixtures.

Each case states its expected codes by hand. The script runs the Python validator and refuses to
write if any case disagrees; the TypeScript suite then has to agree with the same files.

    PYTHONPATH=services/flora-api python3 formdev/scripts/build_definition_fixtures.py

Writes:
  spec/fixtures/definition-cases.json   cases named "p1: ..." (hand-written older cases are kept)
  spec/fixtures/record-cases-types.json record and index cases against examples/phase1-showcase
  spec/fixtures/phase1-cases.json       readable paths and strict JSON parsing
"""
from __future__ import annotations

import copy
import json
import sys
from pathlib import Path
from typing import Any, Callable

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT.parent / "services/flora-api"))

from app.formdev.definition import describe_path, index_entries, parse_json_strict, validate_definition, validate_record  # noqa: E402

PREFIX = "p1: "
GENERATED = ("p1: ", "p2: ")
STYLES = [row["style_id"] for row in json.loads((ROOT / "registry/styles.json").read_text(encoding="utf-8"))]
FONTS = [row["font_id"] for row in json.loads((ROOT / "registry/fonts.json").read_text(encoding="utf-8"))]
SHOWCASE = "examples/phase1-showcase/v1.form.json"
PNG_1PX = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="
BASE = {"format": "flora.form/1", "form_id": "demo_form", "schema_version": 1, "title": "Demo", "paper": "A4", "style_id": "form.a4.medical",
        "sections": [{"id": "main", "title": "Main", "fields": [{"id": "name", "type": "text", "label": "Name"}]}]}


def form(edit: Callable[[dict[str, Any]], Any]) -> dict[str, Any]:
    definition = copy.deepcopy(BASE)
    edit(definition)
    return definition


def with_fields(*extra: dict[str, Any]) -> dict[str, Any]:
    return form(lambda d: d["sections"][0]["fields"].extend(copy.deepcopy(list(extra))))


def field(**props: Any) -> dict[str, Any]:
    return props


def setter(path: list[Any], value: Any) -> Callable[[dict[str, Any]], None]:
    def edit(definition: dict[str, Any]) -> None:
        node: Any = definition
        for part in path[:-1]:
            node = node[part]
        node[path[-1]] = value
    return edit


def remove(key: str) -> Callable[[dict[str, Any]], None]:
    return lambda definition: definition.pop(key)


TEXT = field(id="other", type="text", label="Other")
OPTIONS = [{"value": "a", "label": "A"}, {"value": "b", "label": "B"}]
CALC = [{"id": "bmi", "formula": "ROUND(70 / ((175 / 100) ^ 2), 1)"}]

DEFINITION_CASES: list[tuple[str, dict[str, Any], list[str]]] = [
    # 1.2 ID system: key defaults to id; keys are unique per data scope.
    ("key differs from id", with_fields(field(id="fld_001", key="bp_sys", type="number", label="BP")), []),
    ("invalid key", with_fields(field(id="fld_001", key="BP-Sys", type="number", label="BP")), ["invalid_field_key"]),
    ("duplicate key", with_fields(field(id="fld_001", key="bp", type="number", label="BP"), field(id="fld_002", key="bp", type="number", label="BP 2")), ["duplicate_field_key"]),
    ("key may equal another field's id", with_fields(field(id="fld_001", key="other", type="number", label="A"), field(id="other", key="b2", type="text", label="B")), []),
    # 1.3 Field types
    ("every new type", with_fields(
        field(id="dec", type="decimal", label="Dec", decimals=2, min=0, max=10),
        field(id="rad", type="radio", label="Radio", options=OPTIONS),
        field(id="sw", type="switch", label="Switch", indexed=True),
        field(id="doc", type="file", label="File", accept=["application/pdf"], max_size_kb=100),
        field(id="pic", type="image", label="Image", multiple=True),
        field(id="sig", type="signature", label="Sign", max_size_kb=64),
        field(id="grp", type="group", label="Group", columns=6, fields=[field(id="g1", type="text", label="G1")]),
        field(id="rep", type="repeat", label="Repeat", min_items=1, max_items=3, fields=[field(id="r1", type="text", label="R1")])), []),
    ("property not supported by type", with_fields(field(id="n", type="number", label="N", options=OPTIONS), field(id="t", type="text", label="T", min=1)),
     ["property_not_supported", "property_not_supported"]),
    ("radio needs options", with_fields(field(id="r", type="radio", label="R")), ["missing_options"]),
    ("option with unknown property", with_fields(field(id="r", type="radio", label="R", options=[{"value": "a", "label": "A", "color": "red"}])), ["unknown_property"]),
    ("decimals out of range", with_fields(field(id="d", type="decimal", label="D", decimals=11)), ["invalid_decimals"]),
    ("bad accept list", with_fields(field(id="f", type="file", label="F", accept=["pdf"])), ["invalid_accept"]),
    ("bad max size", with_fields(field(id="f", type="image", label="F", max_size_kb=0)), ["invalid_max_size"]),
    ("group needs children", with_fields(field(id="g", type="group", label="G")), ["container_requires_fields"]),
    ("group has no key, index or validation", with_fields(field(id="g", key="g", type="group", label="G", indexed=True, fields=[TEXT])),
     ["property_not_supported", "property_not_supported"]),
    ("repeat min above max", with_fields(field(id="r", type="repeat", label="R", min_items=3, max_items=1, fields=[TEXT])), ["invalid_range"]),
    ("repeat shown as a table", with_fields(field(id="r", type="repeat", label="R", view="table", fields=[TEXT])), []),
    ("repeat with an unknown view", with_fields(field(id="r", type="repeat", label="R", view="sheet", fields=[TEXT])), ["invalid_repeat"]),
    ("view only on repeat", with_fields(field(id="t", type="text", label="T", view="table")), ["property_not_supported"]),
    ("matrix with totals", with_fields(field(id="m", type="matrix", label="M", cell={"type": "integer", "min": 0, "max": 2}, rows=[{"id": "a", "label": "A"}, {"id": "b", "label": "B"}], cols=[{"id": "x", "label": "X"}], totals=[{"id": "t", "label": "T", "of": ["a", "b"]}])), []),
    ("matrix needs rows and cols", with_fields(field(id="m", type="matrix", label="M", cell={"type": "text"}, rows=[], cols="x")), ["invalid_type", "invalid_type"]),
    ("matrix cell type", with_fields(field(id="m", type="matrix", label="M", cell={"type": "date"}, rows=[{"id": "a", "label": "A"}], cols=[{"id": "x", "label": "X"}])), ["invalid_field_type"]),
    ("matrix select cell needs options", with_fields(field(id="m", type="matrix", label="M", cell={"type": "select"}, rows=[{"id": "a", "label": "A"}], cols=[{"id": "x", "label": "X"}])), ["invalid_option"]),
    ("matrix duplicate row", with_fields(field(id="m", type="matrix", label="M", cell={"type": "text"}, rows=[{"id": "a", "label": "A"}, {"id": "a", "label": "B"}], cols=[{"id": "x", "label": "X"}])), ["duplicate_field_id"]),
    ("matrix total of a text row", with_fields(field(id="m", type="matrix", label="M", cell={"type": "text"}, rows=[{"id": "a", "label": "A"}], cols=[{"id": "x", "label": "X"}], totals=[{"id": "t", "label": "T", "of": ["a"]}])), ["unknown_field_reference"]),
    ("matrix total of score choices", with_fields(field(id="m", type="matrix", label="M", cell={"type": "select", "options": [{"value": "0", "label": "0"}, {"value": "2", "label": "2"}]}, rows=[{"id": "a", "label": "A"}], cols=[{"id": "x", "label": "X"}], totals=[{"id": "t", "label": "T", "of": ["a"]}])), []),
    ("matrix total of a non-numeric choice", with_fields(field(id="m", type="matrix", label="M", cell={"type": "select", "options": [{"value": "1", "label": "1"}, {"value": "s", "label": "S"}]}, rows=[{"id": "a", "label": "A"}], cols=[{"id": "x", "label": "X"}], totals=[{"id": "t", "label": "T", "of": ["a"]}])), ["unknown_field_reference"]),
    ("timeline defaults", with_fields(field(id="tl", type="timeline", label="T")), []),
    ("timeline settings", with_fields(field(id="tl", type="timeline", label="T", timeline={"parts": ["chart", "table"], "rows": [{"id": "hr"}, {"id": "bis", "label": "BIS", "unit": ""}], "chart": ["nibp", "hr"], "step_min": 20, "source": "manual"})), []),
    ("timeline settings are checked", with_fields(field(id="tl", type="timeline", label="T", timeline={"parts": ["graph"], "chart": ["ecg"], "step_min": 0, "source": "monitor", "extra": 1})), ["invalid_layout", "invalid_layout", "invalid_layout", "invalid_type", "unknown_property"]),
    ("bind to case data", with_fields(field(id="weight", type="decimal", label="WT", bind="patient.weight_kg")), []),
    ("bind is checked", with_fields(field(id="weight", type="decimal", label="WT", bind="Patient Weight"), field(id="grp", type="group", label="G", bind="patient.hn", fields=[TEXT])),
        ["invalid_type", "property_not_supported"]),
    ("logo and barcode", with_fields(field(id="hn", type="text", label="HN"), field(id="logo", type="logo", label="Logo", src=PNG_1PX, height_mm=12, align="left"),
        field(id="hn_barcode", type="barcode", label="HN barcode", source="hn", symbology="code128", height_mm=10, show_text=False, align="right")), []),
    ("logo and barcode are checked", with_fields(field(id="logo", type="logo", label="Logo", src="https://example.com/logo.png", height_mm=80, align="middle"),
        field(id="hn_barcode", type="barcode", label="HN barcode", source="nowhere", symbology="qr", height_mm=2, show_text="yes")),
        ["invalid_file", "invalid_layout", "invalid_layout", "unknown_field_reference", "invalid_layout", "invalid_layout", "invalid_type"]),
    ("printed elements take no value properties", with_fields(field(id="hn_barcode", type="barcode", label="HN", required=True, indexed=True)), ["property_not_supported", "property_not_supported", "unknown_field_reference"]),
    ("timeline print settings", with_fields(field(id="tl", type="timeline", label="T", timeline={"print_columns": 24, "hide_empty_rows": True})), []),
    ("timeline print settings are checked", with_fields(field(id="tl", type="timeline", label="T", timeline={"print_columns": 60, "hide_empty_rows": "yes"})), ["invalid_type", "invalid_type"]),
    ("timeline rows", with_fields(field(id="tl", type="timeline", label="T", timeline={"rows": [{"id": "HR"}, {"id": "hr"}, {"id": "hr"}]})), ["invalid_field_id", "duplicate_field_id"]),
    ("option columns", with_fields(field(id="c", type="multiselect", label="C", option_columns=4, options=[{"value": "a", "label": "A"}])), []),
    ("option columns range", with_fields(field(id="c", type="radio", label="C", option_columns=9, options=[{"value": "a", "label": "A"}])), ["invalid_columns"]),
    ("option columns only on choices", with_fields(field(id="t", type="text", label="T", option_columns=2)), ["property_not_supported"]),
    ("no index inside a repeat", with_fields(field(id="r", type="repeat", label="R", fields=[field(id="x", type="text", label="X", indexed=True)])), ["index_not_supported"]),
    ("repeat item keys are their own scope", with_fields(field(id="r", type="repeat", label="R", fields=[field(id="x", key="name", type="text", label="X")])), []),
    ("group children share the form scope", with_fields(field(id="g", type="group", label="G", fields=[field(id="x", key="name", type="text", label="X")])), ["duplicate_field_key"]),
    ("containers nest at most four levels", with_fields(field(id="g1", type="group", label="1", fields=[field(id="g2", type="group", label="2", fields=[
        field(id="g3", type="group", label="3", fields=[field(id="g4", type="group", label="4", fields=[TEXT])])])])), ["too_deep"]),
    ("switch value is indexable", with_fields(field(id="s", type="switch", label="S", indexed=True)), []),
    # 1.4 Display
    ("display policy", with_fields(field(id="uid", type="text", label="User", visible=False, display={"form": False, "table": False, "detail": False, "query": True, "export": True})), []),
    ("display context unknown", with_fields(field(id="u", type="text", label="U", display={"print": True})), ["unknown_property"]),
    ("display flag not boolean", with_fields(field(id="u", type="text", label="U", display={"table": "yes"})), ["invalid_type"]),
    ("display.form disagrees with visible", with_fields(field(id="u", type="text", label="U", visible=False, display={"form": True})), ["conflicting_visibility"]),
    ("visible disagrees with hidden", with_fields(field(id="u", type="text", label="U", visible=True, hidden=True)), ["conflicting_visibility"]),
    # 1.5 Layout
    ("layout with responsive rules", form(lambda d: (d.update(layout={"type": "grid", "columns": 12, "gap_mm": 2}),
        d["sections"][0]["fields"].append(field(id="a", type="text", label="A", layout={"col": 1, "row": 2, "span": 6, "responsive": {"mobile": {"span": 12}, "print": {"span": 4, "hidden": False}}, "page_break": "before"})))), []),
    ("span wider than the grid", with_fields(field(id="a", type="text", label="A", layout={"span": 13})), ["invalid_span"]),
    ("placement past the last column", with_fields(field(id="a", type="text", label="A", layout={"col": 10, "span": 4})), ["layout_out_of_bounds"]),
    ("fields overlap", with_fields(field(id="a", type="text", label="A", layout={"row": 1, "col": 1, "span": 6}), field(id="b", type="text", label="B", layout={"row": 1, "col": 5, "span": 4})), ["layout_overlap"]),
    ("form grid columns out of range", form(setter(["layout"], {"type": "grid", "columns": 30})), ["invalid_columns"]),
    ("section layout type", form(setter(["sections", 0, "layout"], {"type": "masonry"})), ["invalid_layout"]),
    ("responsive mode unknown", with_fields(field(id="a", type="text", label="A", layout={"responsive": {"watch": {"span": 1}}})), ["unknown_property"]),
    ("page break value", form(setter(["sections", 0, "page_break"], "always")), ["invalid_page_break"]),
    ("group grid bounds its children", with_fields(field(id="g", type="group", label="G", columns=6, fields=[field(id="x", type="text", label="X", layout={"span": 8})])), ["invalid_span"]),
    ("nested sections", form(setter(["sections", 0, "sections"], [{"id": "sub", "title": "Sub", "fields": [TEXT]}])), []),
    ("section of subsections only", form(lambda d: d["sections"].append({"id": "outer", "title": "Outer", "sections": [{"id": "inner", "title": "Inner", "fields": [TEXT]}]})), []),
    ("paper header and boxed sections", form(lambda d: d["sections"][0].update({"print_style": "boxed", "hide_title": True, "repeat_on_pages": "header"})), []),
    ("paper keys are checked", form(lambda d: d["sections"][0].update({"print_style": "framed", "hide_title": "yes", "repeat_on_pages": "side"})), ["invalid_layout", "invalid_layout", "invalid_type"]),
    ("only top-level sections repeat on pages", form(lambda d: d["sections"].append({"id": "outer", "title": "Outer", "sections": [{"id": "inner", "title": "Inner", "fields": [TEXT], "repeat_on_pages": "footer"}]})), ["invalid_layout"]),
    ("categories cannot repeat on pages", form(lambda d: d["sections"][0].update({"categories": [{"id": "c1", "title": "C", "fields": [TEXT], "repeat_on_pages": "header", "print_style": "boxed"}]})), ["unknown_property"]),
    ("sections nest at most four levels", form(setter(["sections", 0, "sections"], [{"id": "s2", "title": "2", "fields": [], "sections": [{"id": "s3", "title": "3", "fields": [], "sections": [
        {"id": "s4", "title": "4", "fields": [], "sections": [{"id": "s5", "title": "5", "fields": [TEXT]}]}]}]}])), ["too_deep"]),
    ("duplicate id in a nested section", form(setter(["sections", 0, "sections"], [{"id": "main", "title": "Again", "fields": []}])), ["duplicate_section_id"]),
    # 1.6 A4
    ("A4 landscape with bands", form(setter(["paper"], {"size": "A4", "orientation": "landscape", "margin_mm": {"top": 20, "left": 25},
        "header": {"left": "{title}", "right": "{date}", "height_mm": 10}, "footer": {"center": "{page}/{pages}", "first_page": False}})), []),
    ("orientation", form(setter(["paper"], {"size": "A4", "orientation": "sideways"})), ["invalid_paper"]),
    ("paper size", form(setter(["paper"], {"size": "B5"})), ["invalid_paper"]),
    ("margin out of range", form(setter(["paper"], {"size": "A4", "margin_mm": {"top": 80}})), ["invalid_margin"]),
    ("unknown template token", form(setter(["paper"], {"size": "A4", "footer": {"left": "{patient}"}})), ["unknown_template_token"]),
    ("print density", form(setter(["paper"], {"size": "A4", "density": "fit_page"})), []),
    ("print density is checked", form(setter(["paper"], {"size": "A4", "density": "tiny"})), ["invalid_paper"]),
    ("band height", form(setter(["paper"], {"size": "A4", "header": {"height_mm": 50}})), ["invalid_band"]),
    # 1.7 - 1.9 Styles and fonts
    ("style object instead of style_id", form(lambda d: (d.pop("style_id"), d.update(style={"id": "style.a4.official", "override": {"fontSize": 14}}))), []),
    ("style and style_id disagree", form(setter(["style"], {"id": "style.a4.compact"})), ["style_mismatch"]),
    ("style missing", form(remove("style_id")), ["invalid_style_id"]),
    ("section style unknown", form(setter(["sections", 0, "style"], {"id": "section.fancy"})), ["unknown_style"]),
    ("override token unknown", form(setter(["style"], {"override": {"fontFamily": "Arial"}})), ["unknown_style_token"]),
    ("override token value", with_fields(field(id="a", type="text", label="A", style={"override": {"fontSize": 200, "color": "red"}})), ["invalid_style_token", "invalid_style_token"]),
    ("override font must be registered", form(setter(["style"], {"override": {"fontId": "comic-sans"}})), ["unknown_font"]),
    ("component override", with_fields(field(id="a", type="number", label="A", style={"id": "field.number.large", "override": {"label": {"fontWeight": 700}}})), []),
    ("official Thai font", form(setter(["font_id"], "th-sarabun-new")), []),
    # 1.1 calculators, visibility, permission, validation, metadata
    ("calculator reference", form(lambda d: (d.update(calculators=CALC), d["sections"][0]["fields"].append(field(id="b", type="calculated", label="BMI", calculator="bmi")))), []),
    ("unknown calculator", with_fields(field(id="b", type="calculated", label="BMI", calculator="bmi")), ["unknown_calculator"]),
    ("formula and calculator", form(lambda d: (d.update(calculators=CALC), d["sections"][0]["fields"].append(field(id="b", type="calculated", label="BMI", calculator="bmi", formula="1")))),
     ["calculated_formula_conflict"]),
    ("calculator ids", form(setter(["calculators"], [{"id": "Bad", "formula": "1"}, {"id": "ok", "formula": " "}, {"id": "ok", "formula": "2"}])),
     ["invalid_calculator_id", "invalid_formula", "duplicate_calculator_id"]),
    ("calculator output", form(setter(["calculators"], [{"id": "c", "formula": "1", "output": {"type": "date"}}])), ["invalid_type"]),
    ("visibility and/or", with_fields(field(id="fever", type="switch", label="Fever"), field(id="age", type="integer", label="Age"),
        field(id="t", type="decimal", label="Temp", visibility={"when": {"and": [{"field": "fever", "operator": "equals", "value": True},
                                                                               {"or": [{"field": "age", "operator": "gte", "value": 60}, {"field": "age", "operator": "empty"}]}]}})), []),
    ("visibility refers to a missing field", with_fields(field(id="t", type="text", label="T", visibility={"when": {"field": "nope", "operator": "exists"}})), ["unknown_field_reference"]),
    ("visibility operator", with_fields(field(id="t", type="text", label="T", visibility={"when": {"field": "name", "operator": "like", "value": "a"}})), ["invalid_operator"]),
    ("visibility values", with_fields(field(id="t", type="text", label="T", visibility={"when": {"or": [{"field": "name", "operator": "in", "value": "a"},
                                                                                                         {"field": "name", "operator": "exists", "value": True}]}})),
     ["invalid_condition", "invalid_condition"]),
    ("visibility needs when", with_fields(field(id="t", type="text", label="T", visibility={"field": "name"})), ["invalid_condition"]),
    ("repeat child sees its siblings and the form", with_fields(field(id="r", type="repeat", label="R", fields=[field(id="kind", type="text", label="K"),
        field(id="x", type="text", label="X", visibility={"when": {"and": [{"field": "kind", "operator": "exists"}, {"field": "name", "operator": "exists"}]}})])), []),
    ("form cannot see inside a repeat", with_fields(field(id="r", type="repeat", label="R", fields=[field(id="kind", type="text", label="K")]),
        field(id="x", type="text", label="X", visibility={"when": {"field": "kind", "operator": "exists"}})), ["unknown_field_reference"]),
    ("section visibility", form(lambda d: d["sections"].append({"id": "more", "title": "More", "visibility": {"when": {"field": "name", "operator": "not_equals", "value": ""}},
                                                                 "fields": [{"id": "note", "type": "text", "label": "Note"}]})), []),
    ("permissions at every level", form(lambda d: (d.update(permission={"view": ["doctor", "nurse"], "delete": ["admin"]}),
        d["sections"][0].update(permission={"edit": ["nurse"]}), d["sections"][0]["fields"][0].update(permission={"view": ["doctor"], "export": ["admin"]}))), []),
    ("permission role code", form(setter(["permission"], {"view": ["Doctor"]})), ["invalid_role"]),
    ("permission list empty", form(setter(["permission"], {"edit": []})), ["invalid_permission"]),
    ("field permission has no create", form(setter(["sections", 0, "fields", 0, "permission"], {"create": ["nurse"]})), ["unknown_property"]),
    ("validation rules", with_fields(field(id="email", type="text", label="E", validation={"required": True, "email": True, "max_length": 80, "message": "อีเมลไม่ถูกต้อง"}),
        field(id="when", type="date", label="D", validation={"min_date": "today-30d", "max_date": "today"}),
        field(id="n", type="integer", label="N", validation={"min": 0, "max": 10})), []),
    ("rule does not apply", with_fields(field(id="n", type="number", label="N", validation={"pattern": "^1$"})), ["rule_not_supported"]),
    ("rule value", with_fields(field(id="t", type="text", label="T", validation={"min_length": -1, "min_date": "yesterday"})), ["invalid_rule", "rule_not_supported"]),
    ("pattern compiles", with_fields(field(id="t", type="text", label="T", validation={"pattern": "("})), ["invalid_pattern"]),
    ("flat and nested rule disagree", with_fields(field(id="t", type="text", label="T", required=True, validation={"required": False})), ["conflicting_rule"]),
    ("nested range", with_fields(field(id="t", type="text", label="T", validation={"min_length": 5, "max_length": 2})), ["invalid_range"]),
    ("calculated may not be required in validation", with_fields(field(id="c", type="calculated", label="C", formula="1", validation={"required": True})), ["rule_not_supported"]),
    ("metadata must be an object", form(setter(["metadata"], "x")), ["invalid_type"]),
    ("subject field may be a radio", form(lambda d: (d["sections"][0]["fields"].append(field(id="sex", type="radio", label="Sex", options=OPTIONS)),
                                                     d.update(extensions={"flora.subject_field": "sex"}))), []),
    ("subject field names a key", with_fields(field(id="fld_hn", key="hn", type="text", label="HN")) | {"extensions": {"flora.subject_field": "hn"}}, []),
]

CATEGORY = {"id": "bp", "title": "ความดันโลหิต", "layout": {"columns": 12}, "fields": [{"id": "bp_sys", "type": "number", "label": "ตัวบน", "layout": {"span": 6}},
                                                                             {"id": "bp_dia", "type": "number", "label": "ตัวล่าง", "layout": {"span": 6}}]}

# Phase 2 schema additions (generated with the "p2: " prefix).
PHASE2_CASES: list[tuple[str, dict[str, Any], list[str]]] = [
    ("category", form(setter(["sections", 0, "categories"], [CATEGORY])), []),
    ("section of categories only", form(lambda d: d["sections"].append({"id": "vitals", "title": "Vitals", "categories": [CATEGORY]})), []),
    ("category with style, visibility and permission", form(setter(["sections", 0, "categories"], [{**CATEGORY, "style": {"id": "section.header"}, "page_break": "avoid",
        "visibility": {"when": {"field": "name", "operator": "exists"}}, "permission": {"view": ["clinician"]}}])), []),
    ("duplicate category id", form(setter(["sections", 0, "categories"], [CATEGORY, {**CATEGORY, "fields": [{"id": "pulse", "type": "number", "label": "ชีพจร"}]}])), ["duplicate_category_id"]),
    ("category id", form(setter(["sections", 0, "categories"], [{**CATEGORY, "id": "BP"}])), ["invalid_category_id"]),
    ("category needs fields", form(setter(["sections", 0, "categories"], [{"id": "bp", "title": "BP", "fields": []}])), ["container_requires_fields"]),
    ("category unknown property", form(setter(["sections", 0, "categories"], [{**CATEGORY, "repeatable": True}])), ["unknown_property"]),
    ("category fields share the section scope", form(setter(["sections", 0, "categories"], [{**CATEGORY, "fields": [{"id": "fld_n", "key": "name", "type": "text", "label": "N"}]}])),
     ["duplicate_field_key"]),
    # 2.4 formulas are parsed and their keys resolved
    ("formula reads an unknown key", with_fields(field(id="c", type="calculated", label="C", formula="weight * 2")), ["unknown_field_reference"]),
    ("formula syntax", with_fields(field(id="c", type="calculated", label="C", formula="(1 + 2")), ["formula_syntax"]),
    ("calculator with an unknown function", form(setter(["calculators"], [{"id": "x", "formula": "EVAL(1)"}])), ["unknown_function"]),
    ("calculator arity", form(setter(["calculators"], [{"id": "x", "formula": "IF(TRUE, 1)"}])), ["invalid_arguments"]),
    ("repeat item formula sees its item and the form", with_fields(field(id="rate", type="number", label="Rate"),
        field(id="items", type="repeat", label="Items", fields=[field(id="qty", type="integer", label="Qty"), field(id="price", type="number", label="Price"),
                                                                  field(id="total", type="calculated", label="Total", formula="qty * price * rate")])), []),
    ("repeat column in a form formula", with_fields(field(id="meds", type="repeat", label="Meds", fields=[field(id="dose", type="number", label="Dose")]),
        field(id="total_dose", type="calculated", label="Total", formula="SUM(meds.dose)")), []),
    ("unknown repeat column", with_fields(field(id="meds", type="repeat", label="Meds", fields=[field(id="dose", type="number", label="Dose")]),
        field(id="total_dose", type="calculated", label="Total", formula="SUM(meds.nope)")), ["unknown_field_reference"]),
    # 2.10 logic graph
    ("calculated fields in a circle", with_fields(field(id="a", type="calculated", label="A", formula="b + 1"), field(id="b", type="calculated", label="B", formula="a + 1")),
     ["circular_dependency"]),
    ("visibility that depends on itself", with_fields(field(id="x", type="text", label="X", visibility={"when": {"field": "x", "operator": "exists"}})), ["circular_dependency"]),
    ("a chain is fine: weight -> BMI -> class", with_fields(field(id="weight", type="number", label="W"), field(id="height", type="number", label="H"),
        field(id="bmi", type="calculated", label="BMI", formula="weight / ((height / 100) ^ 2)"),
        field(id="bmi_class", type="text", label="Class", visibility={"when": {"field": "bmi", "operator": "gte", "value": 25}})), []),
    # 2.1 custom rules
    ("field rule", with_fields(field(id="bp_sys", type="number", label="Sys", validation={"rules": [{"assert": "bp_sys > bp_dia", "message": "ตัวบนต้องมากกว่าตัวล่าง"}]}),
        field(id="bp_dia", type="number", label="Dia")), []),
    ("field rule formula and message", with_fields(field(id="t", type="text", label="T", validation={"rules": [{"assert": "t ==", "message": ""}]})),
     ["formula_syntax", "invalid_rule"]),
    ("form rule", form(lambda d: (d["sections"][0]["fields"].extend([field(id="start", type="date", label="Start"), field(id="end", type="date", label="End")]),
        d.update(rules=[{"id": "order", "assert": "DAYS(start, end) >= 0", "message": "วันสิ้นสุดต้องไม่ก่อนวันเริ่ม", "fields": ["end"]}]))), []),
    ("form rule names unknown fields and repeats an id", form(setter(["rules"], [{"id": "r", "assert": "TRUE", "message": "m", "fields": ["nope"]},
                                                                                {"id": "r", "assert": "TRUE", "message": "m", "fields": ["name"]}])),
     ["invalid_rule", "unknown_field_reference"]),
    ("rule condition refers to an unknown field", with_fields(field(id="t", type="text", label="T",
        validation={"rules": [{"assert": "TRUE", "message": "m", "when": {"field": "nope", "operator": "exists"}}]})), ["unknown_field_reference"]),
    ("category span bounded by its grid", form(setter(["sections", 0, "categories"], [{**CATEGORY, "layout": {"columns": 4}}])), ["invalid_span", "invalid_span"]),
    # 2.3 dependency: option conditions, lookups and derived values
    ("lookup options instead of a list", with_fields(field(id="province", type="select", label="P", lookup={"source": "thai_address", "value": "province"}),
        field(id="district", type="select", label="D", lookup={"source": "thai_address", "value": "district", "label": "district", "filter": {"province": "province"}}),
        field(id="postcode", type="text", label="Z", derive={"lookup": "thai_address", "column": "postcode", "match": {"district": "district"}})), []),
    ("lookup and options together", with_fields(field(id="p", type="select", label="P", options=[{"value": "a", "label": "A"}],
        lookup={"source": "thai_address", "value": "province"})), ["invalid_lookup"]),
    ("lookup without a source and with an unknown key", with_fields(field(id="p", type="radio", label="P", lookup={"value": "province", "sort": True})),
     ["invalid_lookup", "unknown_property"]),
    ("lookup filter names an unknown field", with_fields(field(id="d", type="select", label="D",
        lookup={"source": "thai_address", "value": "district", "filter": {"province": "nope"}})), ["unknown_field_reference"]),
    ("derive needs a match and only text fields derive", with_fields(field(id="z", type="text", label="Z", derive={"lookup": "thai_address", "column": "postcode", "match": {}}),
        field(id="n", type="number", label="N", derive={"lookup": "t", "column": "c", "match": {"name": "name"}})), ["invalid_lookup", "property_not_supported"]),
    ("lookups that depend on each other", with_fields(field(id="a", type="select", label="A", lookup={"source": "t", "value": "a", "filter": {"b": "b"}}),
        field(id="b", type="select", label="B", lookup={"source": "t", "value": "b", "filter": {"a": "a"}})), ["circular_dependency"]),
    ("option condition names an unknown field", with_fields(field(id="s", type="radio", label="S",
        options=[{"value": "a", "label": "A", "when": {"field": "nope", "operator": "exists"}}])), ["unknown_field_reference"]),
]

PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="
FULL = {
    "hn": "HN0001", "full_name": "สมชาย ใจดี", "sex": "m", "birth_date": "1960-04-01", "admitted_at": "2026-10-06T09:30:00+07:00", "ward": "7a",
    "recorded_by": "u17", "weight_kg": 70.5, "height_cm": 172, "bmi": 23.8, "pain_score": 3, "has_fever": True, "temperature_c": 38.4,
    "drug_allergy": False, "symptoms": ["fever", "cough"], "contact_name": "สมหญิง", "contact_phone": "0812345678", "note": "-",
    "meds": [{"drug_name": "Paracetamol", "dose": "500 mg", "frequency": "tid"}],
    "xray": [{"name": "cxr.png", "mime": "image/png", "size": 204800, "ref": "asset:cxr-1"}],
    "consent_file": {"name": "consent.pdf", "mime": "application/pdf", "size": 102400, "ref": "asset:consent-1"},
    "nurse_signature": {"data": PNG, "signed_at": "2026-10-06T09:45:00+07:00", "signer": "RN Somsri"},
}


def data(**changes: Any) -> dict[str, Any]:
    out = copy.deepcopy(FULL)
    for key, value in changes.items():
        if value is None:
            out.pop(key, None)
        else:
            out[key] = value
    return out


RECORD_CASES: list[tuple[str, str, dict[str, Any], list[str]]] = [
    ("complete record", "submitted", data(), []),
    ("draft may be empty", "draft", {}, []),
    ("required missing on submit", "submitted", data(hn=None), ["required"]),
    ("decimal places", "draft", data(weight_kg=70.55), ["too_many_decimals"]),
    ("decimal range", "draft", data(weight_kg=401.0), ["out_of_range"]),
    ("validation object range", "draft", data(pain_score=11), ["out_of_range"]),
    ("radio option", "draft", data(sex="x"), ["invalid_option"]),
    ("switch is boolean", "draft", data(has_fever="yes"), ["invalid_type"]),
    ("image type", "draft", data(xray=[{"name": "a.pdf", "mime": "application/pdf", "size": 10, "ref": "r"}]), ["file_type_not_allowed"]),
    ("image size", "draft", data(xray=[{"name": "a.png", "mime": "image/png", "size": 10485761, "ref": "r"}]), ["file_too_large"]),
    ("multiple files need a list", "draft", data(xray={"name": "a.png", "mime": "image/png", "size": 1, "ref": "r"}), ["invalid_type"]),
    ("file shape", "draft", data(consent_file={"name": "c.pdf", "mime": "application/pdf", "size": 1}), ["invalid_file"]),
    ("file accept list", "draft", data(consent_file={"name": "c.doc", "mime": "application/msword", "size": 1, "ref": "r"}), ["file_type_not_allowed"]),
    ("signature data", "draft", data(nurse_signature={"data": "my name"}), ["invalid_signature"]),
    ("signature time", "draft", data(nurse_signature={"data": PNG, "signed_at": "yesterday"}), ["invalid_signature"]),
    ("group children are top-level keys", "draft", {"contact_name": "A", "contact_phone": "0811111111"}, []),
    ("a group has no value of its own", "draft", {"fld_contact": {"contact_name": "A"}}, ["unknown_field"]),
    ("repeat items", "draft", data(meds=[{"drug_name": "A"}, {"drug_name": "B", "frequency": "bid"}]), []),
    ("repeat item unknown key", "draft", data(meds=[{"drug_name": "A", "route": "po"}]), ["unknown_field"]),
    ("repeat item value", "draft", data(meds=[{"drug_name": "A", "frequency": "qid"}]), ["invalid_option"]),
    ("repeat needs a list of objects", "draft", data(meds=["A"]), ["invalid_type"]),
    ("repeat max items", "draft", data(meds=[{"drug_name": str(index)} for index in range(21)]), ["too_many_items"]),
    ("repeat item required on submit", "submitted", data(meds=[{"dose": "1 tab"}]), ["required"]),
    ("text max length from the field", "draft", data(hn="H" * 21), ["too_long"]),
    ("data keyed by id is unknown", "draft", {"fld_hn": "HN1"}, ["unknown_field"]),
    ("matrix values", "draft", data(aldrete={"activity": {"admit": 2, "m15": 1}, "pain": {"admit": 7}, "sedation": {"dc": "s"}}), []),
    ("matrix cell range from the row", "draft", data(aldrete={"pain": {"admit": 11}, "activity": {"admit": 3}}), ["out_of_range", "out_of_range"]),
    ("matrix integer and option cells", "draft", data(aldrete={"activity": {"admit": 1.5}, "sedation": {"admit": "3"}}), ["invalid_type", "invalid_option"]),
    ("matrix unknown row and column", "draft", data(aldrete={"total": {"admit": 4}, "spo2": {"m30": 2}}), ["unknown_field", "unknown_field"]),
    ("matrix shape", "draft", data(aldrete=[1, 2]), ["invalid_type"]),
    ("timeline snapshot", "draft", data(trends={"step_min": 5, "axis": [1790000000000, 1790000300000], "values": {"hr": {"1790000000000": 72, "1790000300000": 75}, "bis": {"1790000300000": "45"}}, "events": [{"ts": 1790000000000, "title": "Induction"}], "source": "leaf", "case_id": 12, "captured_at": 1790000300000}), []),
    ("timeline cells belong to the axis", "draft", data(trends={"step_min": 5, "axis": [1790000000000], "values": {"hr": {"1790000300000": 70, "1790000000000": [1]}}}), ["unknown_field", "invalid_type"]),
    ("timeline axis increases", "draft", data(trends={"step_min": 5, "axis": [1790000300000, 1790000000000], "values": {}}), ["invalid_type"]),
    ("timeline shape", "draft", data(trends={"step_min": 0, "axis": [], "values": {}, "events": [{"ts": "x"}], "note": 1}), ["invalid_type", "invalid_type", "unknown_field"]),
]

DESCRIBE_PATHS = [
    "$.title", "$.paper.header.left", "$.sections[0].fields[1].layout.span", "$.sections[1].fields[8].fields[1].validation.pattern",
    "$.sections[1].sections[0].fields[0].fields[2].options[1]", "$.calculators[0].formula", "$.sections[2]", "$.data.hn", "$.data.meds[1].dose",
    "$.data._retired", "$.sections[9].fields[0]", "$", "$.migration.ops[0]",
]

STRICT_JSON = [
    ("no duplicates", '{"a": 1, "b": [1, {"c": 2}]}', []),
    ("top-level duplicate", '{"a": 1, "a": 2}', ["duplicate_json_key:$.a"]),
    ("nested duplicate reported once", '{"form": {"sections": [{"id": "x", "id": "y", "id": "z"}]}}', ["duplicate_json_key:$.form.sections[0].id"]),
    ("escaped keys", '{"a\\"b": 1, "a\\"b": 2, "s": "{\\"a\\": 1, \\"a\\": 2}"}', ['duplicate_json_key:$.a"b']),
    ("not json", '{"a": }', ["invalid_json:$"]),
]


def main() -> int:
    failures = 0
    path = ROOT / "spec/fixtures/definition-cases.json"
    kept = [case for case in json.loads(path.read_text(encoding="utf-8")) if not case["name"].startswith(GENERATED)]
    generated = []
    for name, definition, codes in [(PREFIX + name, d, c) for name, d, c in DEFINITION_CASES] + [("p2: " + name, d, c) for name, d, c in PHASE2_CASES]:
        got = sorted(issue.code for issue in validate_definition(definition, STYLES, FONTS))
        if got != sorted(codes):
            failures += 1
            print(f"MISMATCH definition {name}: got {got}, want {sorted(codes)}")
            for issue in validate_definition(definition, STYLES, FONTS):
                print("   ", issue.as_dict())
        generated.append({"name": name, "definition": definition, "valid": not codes, "codes": sorted(codes)})

    showcase = json.loads((ROOT / SHOWCASE).read_text(encoding="utf-8"))
    showcase_issues = validate_definition(showcase, STYLES, FONTS)
    if showcase_issues:
        failures += 1
        print("showcase definition is not valid:", [issue.as_dict() for issue in showcase_issues])
    records = []
    for name, status, record, codes in RECORD_CASES:
        got = sorted(issue.code for issue in validate_record(showcase, record, status))
        if got != sorted(codes):
            failures += 1
            print(f"MISMATCH record {name}: got {got}, want {sorted(codes)}")
        records.append({"name": name, "status": status, "data": record, "codes": sorted(codes),
                        "paths": sorted(issue.path for issue in validate_record(showcase, record, status))})
    index = [{"name": "complete record", "data": FULL, "expected": index_entries(showcase, FULL)}]

    strict = []
    for name, text, expected in STRICT_JSON:
        _, issues = parse_json_strict(text)
        got = sorted(f"{issue.code}:{issue.path}" for issue in issues)
        if got != sorted(expected):
            failures += 1
            print(f"MISMATCH strict json {name}: got {got}, want {sorted(expected)}")
        strict.append({"name": name, "text": text, "issues": sorted(expected)})
    describe = [{"path": item, "expected": describe_path(showcase, item)} for item in DESCRIBE_PATHS]

    if failures:
        print(f"{failures} case(s) disagree with their expectation; fixtures not written", file=sys.stderr)
        return 1
    path.write_text(json.dumps(kept + generated, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    (ROOT / "spec/fixtures/record-cases-types.json").write_text(json.dumps(
        {"definition": SHOWCASE, "cases": records, "index": index}, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    (ROOT / "spec/fixtures/phase1-cases.json").write_text(json.dumps(
        {"definition": SHOWCASE, "describe": describe, "strict_json": strict}, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    print(f"wrote {len(generated)} definition cases, {len(records)} record cases, {len(describe)} paths, {len(strict)} JSON cases")
    return 0


if __name__ == "__main__":
    sys.exit(main())
