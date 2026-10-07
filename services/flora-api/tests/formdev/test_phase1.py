"""Phase 1: schema core, field registry, display policy, layout, A4, styles and fonts.

Record, path and strict-JSON cases come from the shared fixtures that the TypeScript suite runs too.
"""
import json
import unittest

from app.formdev import field_types
from app.formdev.definition import (
    describe_issues,
    describe_path,
    displayed,
    field_key,
    field_map,
    index_entries,
    paper_spec,
    parse_json_strict,
    style_ref,
    validate_definition,
    validate_record,
)
from app.formdev.styles import fonts_used, normalize_style, stored_font, style_closure, styles_used, validate_font, validate_style, validate_style_registry
from helpers import FORMDEV_ROOT, load_json

STYLES = load_json("registry/styles.json")
FONTS = load_json("registry/fonts.json")
STYLE_IDS = [row["style_id"] for row in STYLES]
FONT_IDS = [row["font_id"] for row in FONTS]
SHOWCASE = load_json("examples/phase1-showcase/v1.form.json")


class RegistryTwins(unittest.TestCase):
    """The Python tables equal the spec files the TypeScript tables are also checked against."""

    def test_field_types_equal_the_spec(self):
        spec = load_json("spec/field-types.json")
        self.assertEqual(list(field_types.COMMON_PROPS), spec["common"])
        self.assertEqual(list(field_types.COMMON_CONTAINER_PROPS), spec["common_container"])
        self.assertEqual(field_types.FIELD_TYPES, spec["types"])

    def test_style_tokens_equal_the_spec(self):
        spec = load_json("spec/style-tokens.json")
        self.assertEqual(list(field_types.STYLE_COMPONENTS), spec["components"])
        self.assertEqual(field_types.STYLE_TOKENS, spec["tokens"])

    def test_every_phase_1_field_type_is_registered(self):
        required = {"text", "textarea", "number", "decimal", "integer", "date", "datetime", "time", "select", "radio", "checkbox", "switch",
                    "file", "image", "signature", "calculated", "group", "repeat"}
        self.assertLessEqual(required, set(field_types.FIELD_TYPES))

    def test_registry_derived_families(self):
        self.assertEqual(field_types.index_column("switch"), "value_num")
        self.assertEqual(field_types.index_column("radio"), "value_text")
        self.assertNotIn("signature", field_types.INDEXABLE_TYPES)
        self.assertEqual(field_types.QUERY_FAMILY["decimal"], "num")
        self.assertNotIn("group", field_types.QUERY_FAMILY)


class SharedFixtures(unittest.TestCase):
    def test_showcase_is_valid(self):
        self.assertEqual(validate_definition(SHOWCASE, STYLE_IDS, FONT_IDS), [])

    def test_record_cases(self):
        fixture = load_json("spec/fixtures/record-cases-types.json")
        definition = load_json(fixture["definition"])
        for case in fixture["cases"]:
            with self.subTest(case["name"]):
                issues = validate_record(definition, case["data"], case["status"])
                self.assertEqual(sorted(issue.code for issue in issues), case["codes"])
                self.assertEqual(sorted(issue.path for issue in issues), case["paths"])
        for case in fixture["index"]:
            self.assertEqual(index_entries(definition, case["data"]), case["expected"])

    def test_readable_paths(self):
        fixture = load_json("spec/fixtures/phase1-cases.json")
        definition = load_json(fixture["definition"])
        for case in fixture["describe"]:
            with self.subTest(case["path"]):
                self.assertEqual(describe_path(definition, case["path"]), case["expected"])

    def test_strict_json(self):
        for case in load_json("spec/fixtures/phase1-cases.json")["strict_json"]:
            with self.subTest(case["name"]):
                _, issues = parse_json_strict(case["text"])
                self.assertEqual(sorted(f"{issue.code}:{issue.path}" for issue in issues), case["issues"])

    def test_issues_carry_a_readable_location(self):
        broken = json.loads(json.dumps(SHOWCASE))
        broken["sections"][0]["fields"][0]["layout"]["span"] = 30
        described = describe_issues(broken, validate_definition(broken, STYLE_IDS, FONT_IDS))
        self.assertEqual([item["code"] for item in described], ["invalid_span"])
        self.assertEqual(described[0]["location"], 'Section "ข้อมูลผู้ป่วย" › Field "HN" (hn) › layout.span')


class AdminRegistry(unittest.TestCase):
    """Administrators add styles and fonts as data (no core change); the registry stays consistent."""

    def setUp(self):
        from app.formdev.adapters.sqlite import SQLiteAdapter
        from helpers import ready_services

        self.adapter = SQLiteAdapter(":memory:")
        self.fd = ready_services(self.adapter)

    def tearDown(self):
        self.adapter.close()

    def test_new_style_inherits_and_is_usable_by_forms(self):
        row = self.fd.styles.put_style("style.a4.ward7", {"name": "Ward 7", "category": "form", "inherit": "style.a4.medical", "tokens": {"fontSize": 12}})
        self.assertEqual(row["version"], 1)
        self.assertEqual(self.fd.styles.put_style("style.a4.ward7", {"name": "Ward 7", "category": "form", "inherit": "style.a4.medical", "tokens": {"fontSize": 13}})["version"], 2)
        definition = {**SHOWCASE, "style": {"id": "style.a4.ward7"}}
        self.assertEqual(validate_definition(definition, self.fd.styles.style_ids(), self.fd.styles.font_ids()), [])

    def test_broken_styles_are_refused(self):
        from app.formdev.errors import FormDevError

        cases = {
            "unknown parent": ({"name": "X", "category": "form", "inherit": "style.missing", "tokens": {}}, "unknown_style"),
            "cycle": ({"name": "X", "category": "base", "inherit": "style.a4.default", "tokens": {}}, "style_cycle"),
            "bad token": ({"name": "X", "category": "form", "tokens": {"fontSize": 999}}, "invalid_style_token"),
            "unknown font": ({"name": "X", "category": "form", "tokens": {"fontId": "comic-sans"}}, "unknown_font"),
        }
        for name, (definition, code) in cases.items():
            with self.subTest(name):
                style_id = "style.base" if name == "cycle" else "style.x"
                with self.assertRaises(FormDevError) as caught:
                    self.fd.styles.put_style(style_id, definition)
                self.assertIn(code, [item["code"] for item in caught.exception.details])
        self.assertNotIn("style.x", self.fd.styles.style_ids())

    def test_fonts_are_metadata_only(self):
        from app.formdev.errors import FormDevError

        self.fd.styles.put_font("th-local-hospital", {"metadata": {"family": "Hospital Sans", "category": "ui"}, "fallback": ["Hospital Sans", "Tahoma", "sans-serif"],
                                                      "assets": [{"kind": "system", "family": "Hospital Sans"}]})
        self.assertIn("th-local-hospital", self.fd.styles.font_ids())
        with self.assertRaises(FormDevError):
            self.fd.styles.put_font("th-bad", {"metadata": {"family": "Bad"}, "fallback": []})


class Messages(unittest.TestCase):
    def test_every_validator_code_has_thai_and_english_text(self):
        import re

        from app.formdev.messages import MESSAGES

        app = FORMDEV_ROOT.parent / "services/flora-api/app/formdev"
        emitted: set[str] = set()
        for name in ("definition.py", "styles.py", "attachments.py"):
            emitted |= set(re.findall(r'(?:Issue\([^,]+,\s*|ctx\.add\([^,]+,\s*)"([a-z_]+)"', (app / name).read_text(encoding="utf-8")))
        # Formula problems are reported with the code the formula engine raised.
        emitted |= set(re.findall(r'FormulaError\(\s*"([a-z_]+)"', (app / "logic/formula.py").read_text(encoding="utf-8")))
        emitted |= set(re.findall(r'(?:Issue\([^,]+,\s*|fail\()"([a-z_]+)"', (app / "logic/evaluate.py").read_text(encoding="utf-8")))
        self.assertGreater(len(emitted), 70)
        missing = sorted(code for code in emitted if not (MESSAGES.get(code, {}).get("th") and MESSAGES.get(code, {}).get("en")))
        self.assertEqual(missing, [], "add these codes to formdev/spec/messages.json")
        self.assertEqual(sorted(set(MESSAGES) - emitted), [], "catalog has codes no validator emits")

    def test_described_issues_carry_thai(self):
        broken = json.loads(json.dumps(SHOWCASE))
        broken["sections"][0]["fields"][0]["layout"]["span"] = 30
        described = describe_issues(broken, validate_definition(broken, STYLE_IDS, FONT_IDS))
        self.assertEqual(described[0]["message_th"], "ความกว้าง (span) เกินจำนวนคอลัมน์")


class KeysAndDisplay(unittest.TestCase):
    def test_data_is_keyed_by_key_and_key_defaults_to_id(self):
        self.assertEqual(field_key({"id": "fld_001", "key": "bp_sys"}), "bp_sys")
        self.assertEqual(field_key({"id": "bp_sys"}), "bp_sys")
        by_key = field_map(SHOWCASE)
        self.assertEqual(by_key["hn"]["id"], "fld_hn")
        self.assertIn("contact_phone", by_key)  # group children live at the top level
        self.assertNotIn("drug_name", by_key)  # repeat children live in each item
        self.assertNotIn("fld_contact", by_key)  # a group has no value

    def test_display_policy(self):
        recorded_by = field_map(SHOWCASE)["recorded_by"]
        self.assertEqual({context: displayed(recorded_by, context) for context in ("form", "table", "detail", "query", "export")},
                         {"form": False, "table": False, "detail": False, "query": True, "export": True})
        self.assertTrue(displayed({"id": "x", "type": "text"}, "table"))
        self.assertFalse(displayed({"id": "x", "type": "text", "hidden": True}, "form"))
        self.assertTrue(displayed({"id": "x", "type": "text", "hidden": True}, "export"))


class Paper(unittest.TestCase):
    def test_a4_is_210_by_297_and_landscape_swaps(self):
        self.assertEqual(paper_spec({"paper": "A4"})[("width_mm")], 210.0)
        self.assertEqual((paper_spec({"paper": "A4"})["height_mm"]), 297.0)
        landscape = paper_spec({"paper": {"size": "A4", "orientation": "landscape"}})
        self.assertEqual((landscape["width_mm"], landscape["height_mm"]), (297.0, 210.0))
        self.assertIsNone(paper_spec({"paper": "screen"})["width_mm"])

    def test_showcase_paper(self):
        paper = paper_spec(SHOWCASE)
        self.assertEqual(paper["margin_mm"]["top"], 18)
        self.assertEqual(paper["footer"]["right"], "หน้า {page}/{pages}")


class StylesAndFonts(unittest.TestCase):
    def test_style_registry_is_consistent(self):
        self.assertEqual(validate_style_registry(STYLES, FONT_IDS), [])
        for required in ("style.a4.default", "style.a4.medical", "style.a4.official", "style.a4.compact", "field.text.default", "field.number.large", "section.header"):
            self.assertIn(required, STYLE_IDS)

    def test_inheritance_cycles_and_unknown_parents_are_rejected(self):
        rows = [{"style_id": "a.one", "version": 1, "definition": {"name": "A", "category": "form", "inherit": "b.two", "tokens": {}}},
                {"style_id": "b.two", "version": 1, "definition": {"name": "B", "category": "form", "inherit": "a.one", "tokens": {}}},
                {"style_id": "c.three", "version": 1, "definition": {"name": "C", "category": "form", "inherit": "missing.style", "tokens": {}}}]
        codes = sorted(issue.code for issue in validate_style_registry(rows, FONT_IDS))
        self.assertEqual(codes, ["style_cycle", "style_cycle", "unknown_style"])

    def test_style_rows_use_known_tokens(self):
        bad = {"name": "X", "category": "field", "tokens": {"fontSize": 99, "fontFamily": "Arial"}, "components": {"badge": {}}}
        self.assertEqual(sorted(issue.code for issue in validate_style("field.bad", bad, FONT_IDS)), ["invalid_style_token", "unknown_property", "unknown_style_token"])

    def test_legacy_style_rows_are_read_as_tokens(self):
        legacy = {"title": "Old", "paper": "A4", "margin_mm": {"top": 12}, "font_id": "noto-sans-thai", "base_size_pt": 10,
                  "label": {"weight": 600, "size_pt": 9}, "section": {"rule": "solid", "title_size_pt": 11}, "columns": 2}
        style = normalize_style(legacy)
        self.assertEqual(style["tokens"], {"fontId": "noto-sans-thai", "fontSize": 10, "columns": 2, "pageMarginTop": 12, "rule": "solid"})
        self.assertEqual(style["components"], {"label": {"fontWeight": 600, "fontSize": 9}, "section": {"fontSize": 11}})
        self.assertEqual(validate_style("form.old", style, FONT_IDS), [])

    def test_packs_carry_the_whole_inheritance_chain_and_its_fonts(self):
        rows = {row["style_id"]: row for row in STYLES}
        self.assertEqual(styles_used(SHOWCASE), ["style.a4.medical", "section.header", "field.number.large"])
        chain = [row["style_id"] for row in style_closure(rows.__getitem__, styles_used(SHOWCASE))]
        self.assertEqual(chain, ["style.base", "style.a4.default", "style.a4.medical", "section.header", "field.text.default", "field.number.large"])
        official = {**SHOWCASE, "style": {"id": "style.a4.official"}}
        closure = style_closure(rows.__getitem__, styles_used(official))
        self.assertEqual(fonts_used(official, closure), ["noto-sans-thai", "th-sarabun-new"])
        self.assertEqual(style_ref(official), "style.a4.official")

    def test_thai_official_fonts_are_metadata_only(self):
        official = [row for row in FONTS if row["metadata"].get("official")]
        self.assertEqual(len(official), 14)  # 13 national fonts + TH Sarabun New
        for row in FONTS:
            with self.subTest(row["font_id"]):
                self.assertEqual(validate_font(row["font_id"], stored_font(row)), [])
                self.assertTrue(row["fallback"][-1] in ("sans-serif", "serif"))
                self.assertFalse(any(asset["kind"] == "file" for asset in row["assets"]))
        repo = FORMDEV_ROOT.parent
        shipped = [path for folder in ("formdev", "frontend/src", "frontend/public", "services") if (repo / folder).exists()
                   for path in (repo / folder).rglob("*") if path.suffix.lower() in (".ttf", ".otf", ".woff", ".woff2") and "node_modules" not in path.parts]
        self.assertEqual(shipped, [], "font files must not be committed to the repository")


if __name__ == "__main__":
    unittest.main()
