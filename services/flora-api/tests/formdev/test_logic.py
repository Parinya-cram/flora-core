"""Phase 2 logic engine: formula language (shared fixtures with the TypeScript engine) and safety."""
import math
import re
import unittest

from app.formdev.logic.formula import FormulaError, check, parse, references, run
from helpers import FORMDEV_ROOT, load_json

FORMULAS = load_json("spec/fixtures/formula-cases.json")


def same(a, b):
    if isinstance(a, (int, float)) and isinstance(b, (int, float)) and not isinstance(a, bool) and not isinstance(b, bool):
        return math.isclose(a, b, rel_tol=1e-12, abs_tol=1e-12)
    return a == b and type(a) is type(b) if isinstance(a, bool) or isinstance(b, bool) else a == b


class Formulas(unittest.TestCase):
    def test_shared_cases(self):
        for case in FORMULAS["cases"]:
            with self.subTest(case["name"]):
                if "error" in case:
                    with self.assertRaises(FormulaError) as caught:
                        run(case["formula"], case["values"], FORMULAS["today"])
                    self.assertEqual((caught.exception.code, caught.exception.position), (case["error"], case["position"]))
                else:
                    self.assertTrue(same(run(case["formula"], case["values"], FORMULAS["today"]), case["value"]))

    def test_references_and_static_check(self):
        node = parse("ROUND(weight_kg / ((height_cm / 100) ^ 2), 1) + SUM(meds.dose)")
        self.assertEqual([name for name, _ in references(node)], ["weight_kg", "height_cm", "meds.dose"])
        problems = check("weight_kg + height", lambda key: key == "weight_kg")
        self.assertEqual([(problem.code, problem.position) for problem in problems], [("unknown_field_reference", 13)])


class CalculatorTemplates(unittest.TestCase):
    """Phase 2.5: calculators are definitions (registry/calculators.json) with checked examples."""

    def test_templates_parse_use_only_their_parameters_and_give_their_examples(self):
        from app.formdev.logic.evaluate import apply_output

        templates = load_json("registry/calculators.json")
        self.assertEqual(len({item["template_id"] for item in templates}), len(templates))
        for template in templates:
            with self.subTest(template["template_id"]):
                params = {param["name"] for param in template["params"]}
                self.assertLessEqual({name for name, _ in references(parse(template["formula"]))}, params)
                for example in template["examples"]:
                    got = apply_output(run(template["formula"], example["values"], FORMULAS["today"]), template.get("output", {}))
                    self.assertTrue(same(got, example["result"]), f"{example} -> {got}")

    def test_rename_maps_parameters_to_field_keys(self):
        from app.formdev.logic.formula import rename

        self.assertEqual(rename("weight / ((height / 100) ^ 2) + 0 * COUNT('weight')", {"weight": "weight_kg", "height": "height_cm"}),
                         "weight_kg / ((height_cm / 100) ^ 2) + 0 * COUNT('weight')")


class RecordLogic(unittest.TestCase):
    """Phase 2.1/2.2/2.5/2.6/2.7 on records, shared with the TypeScript engine."""

    FIXTURE = load_json("spec/fixtures/logic-record-cases.json")

    def test_shared_cases(self):
        from app.formdev.logic.evaluate import evaluate_record

        definition = load_json(self.FIXTURE["definition"])
        for case in self.FIXTURE["cases"]:
            with self.subTest(case["name"]):
                result = evaluate_record(definition, case["data"], case["status"], self.FIXTURE["today"])
                self.assertEqual(sorted(issue.code for issue in result.issues), case["expect"]["codes"])
                self.assertEqual(sorted(issue.path for issue in result.issues), case["expect"]["paths"])
                self.assertEqual(result.hidden, case["expect"]["hidden"])
                self.assertEqual(result.data, case["expect"]["data"])

    def test_input_is_not_modified(self):
        from app.formdev.logic.evaluate import evaluate_record

        data = {"hn": "HN1", "bmi": 999, "has_fever": False, "temperature_c": 38.0}
        evaluate_record(load_json(self.FIXTURE["definition"]), data, "draft", self.FIXTURE["today"])
        self.assertEqual(data, {"hn": "HN1", "bmi": 999, "has_fever": False, "temperature_c": 38.0})

    def test_server_stores_its_own_calculation(self):
        from app.formdev.adapters.sqlite import SQLiteAdapter
        from app.formdev.errors import FormDevError
        from helpers import ready_services

        adapter = SQLiteAdapter(":memory:")
        try:
            fd = ready_services(adapter)
            definition = load_json(self.FIXTURE["definition"])
            fd.schemas.create_form(definition, "tester")
            fd.schemas.publish(definition["form_id"], 1, "tester")
            saved = fd.records.create(definition["form_id"], {"hn": "HN9", "birth_date": "1950-01-01", "weight_kg": 60, "height_cm": 160, "bmi": 999,
                                                               "has_fever": False, "temperature_c": 38.5}, "tester")
            self.assertEqual(saved["data"]["bmi"], 23.4)
            self.assertEqual(saved["data"]["bmi_class"], "น้ำหนักเกิน")
            self.assertNotIn("temperature_c", saved["data"])
            with self.assertRaises(FormDevError) as caught:
                fd.records.create(definition["form_id"], {"hn": "HN8", "birth_date": "1950-01-01", "bp_sys": 80, "bp_dia": 90}, "tester")
            self.assertEqual(caught.exception.details[0]["code"], "rule_failed")
            self.assertEqual(caught.exception.details[0]["message"], "ความดันตัวบนต้องมากกว่าตัวล่าง")
        finally:
            adapter.close()


class Versioning(unittest.TestCase):
    """Phase 2.9: a record is evaluated with its own schema version; a newer version never rewrites it."""

    def test_each_record_keeps_the_logic_of_its_version(self):
        import copy

        from app.formdev.adapters.sqlite import SQLiteAdapter
        from helpers import ready_services

        adapter = SQLiteAdapter(":memory:")
        try:
            fd = ready_services(adapter)
            v1 = load_json("examples/phase2-logic/v1.form.json")
            fd.schemas.create_form(v1, "tester")
            fd.schemas.publish(v1["form_id"], 1, "tester")
            data = {"hn": "HN1", "birth_date": "1950-01-01", "weight_kg": 60, "height_cm": 160}
            old = fd.records.create(v1["form_id"], data, "tester")
            v2 = copy.deepcopy(v1)
            v2["schema_version"] = 2
            v2["calculators"][0]["output"]["decimals"] = 2  # BMI to two decimals from v2 on
            fd.schemas.save_draft(v2, "tester")
            fd.schemas.publish(v1["form_id"], 2, "tester")
            new = fd.records.create(v1["form_id"], data, "tester")
            self.assertEqual((old["schema_version"], old["data"]["bmi"]), (1, 23.4))
            self.assertEqual((new["schema_version"], new["data"]["bmi"]), (2, 23.44))
            # Editing the v1 record recomputes with v1's calculator and leaves it on v1.
            edited = fd.records.update(old["record_id"], {**old["data"], "weight_kg": 61}, old["version"], "tester")
            self.assertEqual((edited["schema_version"], edited["data"]["bmi"]), (1, 23.8))
            self.assertEqual(fd.records.get(old["record_id"], as_version=2)["data"]["bmi"], 23.8)
        finally:
            adapter.close()


class Categories(unittest.TestCase):
    """Phase 2.0: section -> category -> field."""

    DEFINITION = {"format": "flora.form/1", "form_id": "vitals", "schema_version": 1, "title": "Vitals", "paper": "A4", "style_id": "form.a4.medical",
                  "sections": [{"id": "vitals", "title": "สัญญาณชีพ", "fields": [{"id": "pulse", "type": "number", "label": "ชีพจร"}],
                                "categories": [{"id": "bp", "title": "ความดันโลหิต", "style": {"id": "section.header"},
                                                "fields": [{"id": "bp_sys", "type": "number", "label": "ตัวบน", "style": {"id": "field.number.large"}}]}]}]}

    def test_category_fields_live_in_the_section_scope(self):
        from app.formdev.definition import describe_path, field_map, validate_record

        self.assertEqual(list(field_map(self.DEFINITION)), ["pulse", "bp_sys"])
        self.assertEqual(validate_record(self.DEFINITION, {"pulse": 80, "bp_sys": 120}, "submitted"), [])
        self.assertEqual(describe_path(self.DEFINITION, "$.sections[0].categories[0].fields[0].layout"),
                         'Section "สัญญาณชีพ" › Category "ความดันโลหิต" › Field "ตัวบน" (bp_sys) › layout')

    def test_category_styles_are_packed(self):
        from app.formdev.styles import styles_used

        self.assertEqual(styles_used(self.DEFINITION), ["form.a4.medical", "section.header", "field.number.large"])


class NoDynamicCode(unittest.TestCase):
    def test_no_eval_exec_or_new_function_in_formdev(self):
        repo = FORMDEV_ROOT.parent
        roots = [repo / "services/flora-api/app/formdev", repo / "frontend/src/formdev"]
        pattern = re.compile(r"(?<![A-Za-z_.])(eval|exec)\s*\(|new\s+Function\s*\(|\bFunction\s*\(\s*['\"`]")
        offenders = [f"{path.relative_to(repo)}:{number}" for root in roots for path in root.rglob("*") if path.suffix in (".py", ".ts", ".tsx")
                     for number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1) if pattern.search(line)]
        self.assertEqual(offenders, [])


if __name__ == "__main__":
    unittest.main()
