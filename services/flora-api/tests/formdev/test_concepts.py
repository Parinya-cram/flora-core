"""The concept layer (app/concepts.py): the fixture the Leaf's tests read (formdev/spec/fixtures/concepts.json, written
by formdev/scripts/build_concept_fixtures.py) is current, and the consumers that read concepts give what they gave when
they read the record draft's keys."""
import unittest

from app import concepts
from tests.formdev.helpers import load_json


class Concepts(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.fixture = load_json("spec/fixtures/concepts.json")

    def test_the_fixture_is_current(self):
        self.assertEqual(self.fixture["concepts"], concepts.CONCEPTS, "run formdev/scripts/build_concept_fixtures.py")
        self.assertEqual(self.fixture["draft_keys"], concepts.DRAFT_KEYS, "run formdev/scripts/build_concept_fixtures.py")
        for case in self.fixture["cases"]:
            self.assertEqual(concepts.case_values(case["head"], case["loaded"], self.fixture["now"]), case["values"], case["name"])

    def test_every_draft_key_names_a_concept(self):
        self.assertEqual(set(concepts.DRAFT_KEYS) - set(concepts.CONCEPT_BY_KEY), set())

    def test_a_snapshot_reads_as_concepts(self):
        case = self.fixture["cases"][0]
        loaded = case["loaded"]
        snapshot = {"case": {"case_id": 1, "hn": case["head"]["hn"], "start_time": case["head"]["startTime"]},
                    "forms": {"draft": loaded["draft"]}, "patient": {"row": loaded["patient"]},
                    **{name: {"rows": loaded[name]} for name in ("diagnosis", "procedures", "allergies", "events", "staff")}}
        values = concepts.from_snapshot(snapshot, self.fixture["now"])
        # Canopy has no workstation or labs in a snapshot: the rest is as on the Leaf.
        expected = {key: value for key, value in case["values"].items() if not key.startswith(("case.room", "case.ward", "lab."))}
        expected["patient.an"] = case["values"]["patient.an"]
        self.assertEqual(values, expected)

    def test_billing_reads_the_technique_concept_as_the_draft_keeps_it(self):
        draft = {"anesthesiaTypes": ["General anesthesia", "Truncal block"]}
        self.assertEqual(concepts.draft_value(draft, "anesthesia.technique"), ["General anesthesia", "Truncal block"])
        self.assertIsNone(concepts.draft_value(draft, "lab.hb"), "a concept the draft has no place for")
        self.assertIsNone(concepts.draft_value(None, "anesthesia.technique"))

    def test_the_public_api_masks_patient_concepts(self):
        from app import phi_mask

        masked = phi_mask.mask({"concepts": {"patient.name": "นายสมชาย ใจดี", "patient.hn": "6512345", "patient.id_card": "1100100100100",
                                             "patient.dob": "1970-05-02", "case.asa": "2E", "staff.surgeon": "Dr Cut"}})["concepts"]
        self.assertEqual(masked["patient.name"], "นายสมช-------- --------")  # a short word is masked whole
        self.assertEqual((masked["patient.hn"], masked["patient.id_card"], masked["patient.dob"]), ("651--------", "110--------", "197--------"))
        self.assertEqual((masked["case.asa"], masked["staff.surgeon"]), ("2E", "Dr Cut"), "clinical data and clinicians stay")


if __name__ == "__main__":
    unittest.main()
