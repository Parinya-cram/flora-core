"""Reading documents into forms (app/formdev/reading) and the variable-name standard (app/formdev/ids.py).

The page tests draw synthetic Thai forms (reading_samples.py) and need the Noto fonts; the OCR tests also need the
models (scripts/fetch_ocr_models.py). Both are in the API image and the CI job; without them those tests are skipped.
The AI is never called: its answers are scripted, and what is tested is how they are checked against the evidence."""
import glob
import io
import re
import sys
import time
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from app.formdev import ai_builder, ids  # noqa: E402
from app.formdev.definition import validate_definition  # noqa: E402
from app.formdev.reading import assemble, draft, jobs, layout, ocr, pdf, preprocess, thai  # noqa: E402

FONTS = bool(glob.glob("/usr/share/fonts/truetype/noto/NotoSansThai-Regular.ttf"))
HAS_OCR = ocr.available() and FONTS
CONFIG = {"api_format": "anthropic", "model": "m", "api_key": "k", "host": ""}


class ThaiText(unittest.TestCase):
    def test_shifted_glyphs_and_sara_am(self):
        # Escapes: old Thai fonts put shifted marks in the Private Use Area, characters an editor may not keep.
        self.assertEqual(thai.normalize("\u0e19\u0e49\u0e4d\u0e32"), "\u0e19\u0e49\u0e33")  # น้ + ํ + า → น้ำ
        self.assertEqual(thai.normalize("\u0e1b\uf710\u0e19"), "\u0e1b\u0e31\u0e19")         # a shifted MAI HAN-AKAT → ปัน
        self.assertGreater(thai.private_use_share("\uf701\uf702b"), 0.4)

    def test_a_lost_tone_mark_is_restored_only_when_one_word_fits(self):
        fixed, fixes = thai.fix_marks("ชือ-นามสกุล")
        self.assertEqual(fixed, "ชื่อ-นามสกุล")
        self.assertEqual(fixes, [("ชือ", "ชื่อ")])
        self.assertEqual(thai.fix_marks("ความดันโลหิต")[0], "ความดันโลหิต")  # known words are left alone


class VariableNames(unittest.TestCase):
    def test_names_say_what_the_value_is(self):
        cases = [
            (("น้ำหนัก",), "patient_weight_kg", "patient.weight_kg"),
            (("คะแนนความปวด",), "pain_score", None),
            (("ผู้ประเมิน",), "assessor", None),
            (("วันที่", None, None, "date", "Consent"), "consent_date", None),     # generic: the section's name first
            (("Name", None, None, "text", "Witness"), "witness_name", None),     # an alias of case data without a bind
            (("HN",), "patient_hn", "patient.hn"),
            (("ประเมินความเสี่ยงต่อการพลัดตกหกล้ม",), "assessment_fall_risk", None),
            (("ความอิ่มตัวของออกซิเจน (SpO2)",), "spo2", None),
            (("ความดันโลหิต / Blood pressure",), "blood_pressure", None),
            (("x", None, "patient.hn"), "patient_hn", None),                      # bound already: no suggestion
            (("อายุ", None, None, "number", "General"), "patient_age_years", "patient.age_years"),
            (("ชื่อ-สกุล",), "patient_name", "patient.name"),
        ]
        for args, key, concept in cases:
            got = ids.suggest(*args)
            self.assertEqual((got["key"], got["concept"]), (key, concept), args)
        self.assertEqual(ids.suggest("วันที่", None, None, "date", "Consent", {"consent_date"})["key"], "consent_date_2")
        self.assertIsNone(ids.suggest("อายุครรภ์")["concept"], "only the whole label อายุ is the patient's age")

    def test_check_lists_what_breaks_the_standard(self):
        definition = {"sections": [{"id": "main", "title": "Main", "fields": [
            {"id": "text_2", "type": "text", "label": "Pain score"},
            {"id": "date", "type": "date", "label": "Date"},
            {"id": "f1", "key": "weight", "type": "decimal", "label": "น้ำหนัก"},
            {"id": "intro", "type": "heading", "label": "หัวข้อ"},
            {"id": "pain_score_note", "type": "text", "label": "Note"},
        ]}]}
        found = {(item["id"], item["problem"]): item for item in ids.check(definition)}
        self.assertEqual(found[("text_2", "named_by_type")]["suggestion"], "pain_score")
        self.assertEqual(found[("date", "reads_as_case_data")]["suggestion"], "main_date")
        self.assertIn(("f1", "id_differs"), found)
        self.assertIn(("f1", "no_english"), found)
        self.assertEqual(found[("f1", "reads_as_case_data")]["concept"], "patient.weight_kg")
        self.assertFalse([key for key in found if key[0] in ("intro", "pain_score_note")], "static elements and good names pass")


@unittest.skipUnless(FONTS, "needs Noto Thai fonts")
class Pages(unittest.TestCase):
    """Straightening and layout on the drawn ruled form, without OCR (layout needs no text to find its structure)."""

    def test_a_crooked_scan_is_straightened_and_a_straight_one_left_alone(self):
        from reading_samples import ruled_form_image

        page, prepared = preprocess.prepare(ruled_form_image(tilt=1.2), 200)
        self.assertTrue(prepared["straightened"])
        self.assertAlmostEqual(prepared["skew"], 1.2, delta=0.15)
        mm = 200 / 25.4
        self.assertLess(abs(preprocess.skew_from_rules(preprocess._binary(preprocess._gray(page), mm), mm)), 0.15)
        _, untouched = preprocess.prepare(ruled_form_image(tilt=0), 200)
        self.assertFalse(untouched["straightened"])

    def test_the_layout_tells_charts_cells_blanks_and_checkboxes_apart(self):
        from reading_samples import ruled_form_image

        evidence = layout.analyse(ruled_form_image(tilt=0), 200, [])
        self.assertEqual(len(evidence["grids"]), 1, "the chart is one grid")
        grid = evidence["grids"][0]
        self.assertGreaterEqual(grid["cols"], 25)
        self.assertEqual(len(evidence["checkboxes"]), 2, "a chart's squares are not checkboxes")
        self.assertEqual([box["ticked"] for box in evidence["checkboxes"]], [False, True])
        kinds = sorted(blank["kind"] for blank in evidence["blanks"])
        self.assertEqual(kinds.count("dots"), 2, "the name's and the signature's dotted leaders")
        self.assertGreaterEqual(kinds.count("underline"), 3, "HN, weight and age")
        self.assertGreater(len(evidence["cells"]), 15)
        self.assertTrue(all(re.match(r"^[CGBK]\d+$", item["id"]) for key in ("cells", "grids", "blanks", "checkboxes") for item in evidence[key]))


def sample_pdf_with_text() -> bytes:
    """A digital PDF: a text layer, a drawn box, a fill-in line and one AcroForm field."""
    from reportlab.lib.pagesizes import A4
    from reportlab.pdfbase import pdfmetrics
    from reportlab.pdfbase.ttfonts import TTFont
    from reportlab.pdfgen import canvas

    pdfmetrics.registerFont(TTFont("NotoThai", glob.glob("/usr/share/fonts/truetype/noto/NotoSansThai-Regular.ttf")[0]))
    pdfmetrics.registerFont(TTFont("NotoLatin", glob.glob("/usr/share/fonts/truetype/noto/NotoSans-Regular.ttf")[0]))
    buffer = io.BytesIO()
    page = canvas.Canvas(buffer, pagesize=A4)

    def write(x, y, text):  # Thai and Latin runs each in a font that has them
        for run in re.findall("[฀-๿]+|[^฀-๿]+", text):
            font = "NotoThai" if "฀" <= run[0] <= "๿" else "NotoLatin"
            page.setFont(font, 14)
            page.drawString(x, y, run)
            x += pdfmetrics.stringWidth(run, font, 14)

    write(60, 760, "แบบบันทึกทางการพยาบาล ผู้ป่วยหลังผ่าตัด")
    write(60, 720, "น้ำหนัก (กก.)")
    page.rect(160, 712, 120, 22)
    write(60, 680, "ลงชื่อผู้บันทึก")
    page.line(160, 676, 360, 676)
    page.acroForm.textfield(name="hn", x=400, y=712, width=120, height=22)
    page.save()
    return buffer.getvalue()


def run_job(content, options, owner="tester"):
    job = jobs.start(owner, "sample", content, options, lambda: CONFIG)
    for _ in range(900):
        if job.status in ("done", "failed", "cancelled"):
            break
        time.sleep(0.1)
    assert job.status == "done", job.error
    return job


def fields_of(definition):
    return {field["id"]: field for section in definition["sections"] for field in section["fields"]}


@unittest.skipUnless(FONTS, "needs Noto Thai fonts")
class DigitalPdf(unittest.TestCase):
    def test_the_text_layer_and_form_fields_need_no_ocr(self):
        content = sample_pdf_with_text()
        layer = pdf.text_layer(content, 0)
        self.assertIn("น้ำหนัก (กก.)", [item["text"] for item in layer["lines"]])
        self.assertEqual(layer["quality"], "good")
        fields = pdf.form_fields(content)
        self.assertEqual([(field["name"], field["kind"]) for field in fields], [("hn", "text")])
        self.assertLess(fields[0]["box"][1], 0.2)

    def test_a_digital_pdf_is_read_without_ocr_or_straightening(self):
        job = run_job(sample_pdf_with_text(), {"ai": False})
        kinds = {event["kind"] for event in job.events}
        self.assertFalse(kinds & {"ocr_started", "prepared"}, "its own text is used as drawn")
        found = fields_of(job.result["definition"])
        self.assertEqual(found["patient_weight_kg"]["unit"], "kg")
        self.assertEqual(found["patient_weight_kg"]["type"], "decimal")
        self.assertIn("signature_recorder", found)
        self.assertEqual(found["signature_recorder"]["type"], "signature")
        self.assertEqual(found["patient_hn"]["bind"], "patient.hn", "the PDF's own form field, named by the standard")


@unittest.skipUnless(FONTS, "needs Noto fonts")
class DigitalChecklist(unittest.TestCase):
    """A digital, filled-in checklist (like a billing sheet) read from its own vectors and fonts, no OCR, no AI."""

    @classmethod
    def setUpClass(cls):
        from reading_samples import billing_pdf

        cls.content = billing_pdf()
        cls.job = run_job(cls.content, {"ai": False})
        cls.definition = cls.job.result["definition"]
        cls.found = {field["id"]: field for section in cls.definition["sections"] for field in section["fields"]}
        cls.inner = {child["id"]: child for field in cls.found.values() for child in field.get("fields") or []}

    def test_words_stay_in_their_cells_and_checkboxes_come_from_the_drawing(self):
        texts = {line["text"] for line in self.job.result["evidence"][0]["lines"]}
        self.assertIn("Age: 64 Y", texts)
        self.assertIn("Gender: Female", texts, "each cell's text is its own line, not the whole row")
        drawn = pdf.checkboxes(self.content, 0)
        self.assertEqual(len(drawn), 12)
        self.assertEqual(sum(box["ticked"] for box in drawn), 3)

    def test_bold_labels_are_fields_and_the_answers_of_this_copy_are_set_aside(self):
        self.assertEqual(self.definition["title"], "Anesthesia Check List (Billing)")
        self.assertEqual((self.found["patient_age_years"]["type"], self.found["patient_age_years"]["unit"]), ("number", "yr"))
        self.assertEqual((self.found["patient_weight_kg"]["type"], self.found["patient_weight_kg"]["unit"]), ("decimal", "kg"))
        self.assertIn("patient_hn", self.found)
        labels = {field["label"] for field in list(self.found.values()) + list(self.inner.values())}
        self.assertFalse({"Female", "64 Y", "Spondylolisthesis L4-5"} & labels, "an answer is not a label")
        why = {entry["why"] for entry in self.job.result["ignored"]}
        self.assertIn("the answer filled in on this copy", why)
        self.assertIn("a quantity filled in on this copy", why)
        self.assertEqual(self.job.result["coverage"][0]["missed"], [])

    def test_each_category_is_a_table_in_its_column_as_on_the_paper(self):
        columns = [field for field in self.found.values() if field["type"] == "group"]
        self.assertEqual([column["label"] for column in columns], ["list | Qty", "list | Qty"])
        tables = {child["label"]: child for column in columns for child in column["fields"]}
        self.assertEqual(set(tables), {"Gas / Inhalation", "Narcotics", "Fluids", "Other Equipment"})
        fluids = tables["Fluids"]
        self.assertEqual([row["label"] for row in fluids["rows"]], ["Water 10 ml", "0.9 NSS 100 ml", "Acetar 1000 ml", "Voluven"])
        self.assertEqual(([col["label"] for col in fluids["cols"]], fluids["cell"]["type"]), (["Qty"], "integer"))
        self.assertTrue(75 <= fluids["label_width"] <= 90, fluids["label_width"])
        self.assertEqual({column["layout"]["span"] for column in columns}, {12})

    def test_signatures_and_the_paper(self):
        signers = [field["label"] for field in self.found.values() if field["type"] == "signature"]
        self.assertEqual(signers, ["Surgeon", "Anesthesiologist", "Anesthesia nurse 1"])
        self.assertEqual(self.definition["paper"]["density"], "fit_page", "small print keeps to its pages")
        self.assertEqual(self.job.result["issues"], [])


@unittest.skipUnless(HAS_OCR, "needs the OCR models and Noto fonts (the API image)")
class ScannedForms(unittest.TestCase):
    def test_the_simple_form_becomes_its_draft_without_ai(self):
        from reading_samples import as_pdf, form_image

        job = run_job(as_pdf(form_image()), {"ai": False})
        kinds = [event["kind"] for event in job.events]
        for kind in ("started", "page", "text_layer", "prepared", "ocr_started", "ocr_done", "lines", "layout", "plan", "draft", "done"):
            self.assertIn(kind, kinds)
        self.assertNotIn("ai_started", kinds)
        self.assertEqual(job.content, b"", "the document is not kept")
        definition = job.result["definition"]
        self.assertEqual(definition["title"], "แบบประเมินผู้ป่วยก่อนผ่าตัด")
        found = fields_of(definition)
        self.assertEqual(set(found), {"patient_name", "patient_weight_kg", "patient_height_cm", "patient_allergy", "vital_signs",
                                      "signature_nurse_assessor"})
        self.assertEqual(found["signature_nurse_assessor"]["type"], "signature")
        self.assertEqual([option["value"] for option in found["patient_allergy"]["options"]], ["no", "yes"])
        self.assertEqual([column["label"] for column in found["vital_signs"]["fields"]], ["เวลา", "ชีพจร", "ความดันโลหิต"])
        self.assertEqual(job.result["coverage"][0]["missed"], [])
        self.assertEqual(job.usage["requests"], 0)
        self.assertIsNone(jobs.get(job.id, "someone else"), "a job is its author's")

    def test_a_crooked_ruled_form_is_read_whole(self):
        from reading_samples import as_pdf, ruled_form_image

        job = run_job(as_pdf(ruled_form_image(tilt=1.2)), {"ai": False})
        prepared = next(event["data"] for event in job.events if event["kind"] == "prepared")
        self.assertTrue(prepared["straightened"])
        result = job.result
        self.assertEqual(result["issues"], [])
        self.assertEqual(result["coverage"][0]["missed"], [], "every line is used or set aside with a reason")
        why = {entry["why"] for entry in result["ignored"]}
        self.assertTrue({"chart axis", "the form's title", "the form's number (printed on the paper)"} <= why, why)
        found = fields_of(result["definition"])
        self.assertEqual(found["patient_name"]["bind"], "patient.name")
        self.assertEqual(found["patient_hn"]["bind"], "patient.hn")
        self.assertEqual((found["patient_weight_kg"]["type"], found["patient_weight_kg"]["unit"]), ("decimal", "kg"))
        self.assertEqual((found["patient_age_years"]["bind"], found["patient_age_years"]["unit"]), ("patient.age_years", "ปี"))
        self.assertEqual(found["case_diagnosis"]["type"], "textarea")
        timeline = next(field for field in found.values() if field["type"] == "timeline")["timeline"]
        self.assertEqual([row["label"] for row in timeline["rows"]][:2], ["ชีพจร", "ความดันโลหิต"])
        self.assertEqual(set(timeline["chart"]), {"nibp", "pr"})
        self.assertIn("chart", timeline["parts"])
        table = next(field for field in found.values() if field["type"] == "repeat")
        self.assertEqual(len(table["fields"]), 3)
        allergy = next(field for field in found.values() if field["type"] == "radio" and "แพ้" in field["label"])
        self.assertEqual([option["label"] for option in allergy["options"]], ["ไม่มี", "มี"])
        conscious = next(field for field in found.values() if field["type"] == "radio" and "ความรู้สึกตัว" in field["label"])
        self.assertEqual(len(conscious["options"]), 3)
        signature = next(field for field in found.values() if field["type"] == "signature")
        self.assertIn("ผู้บันทึก", signature["label"])
        # The paper's own layout: its size and margins, ruled sections printed as bordered cells, the table's column
        # widths, the chart's time columns, and the printed grid of rows by shift kept as a grid.
        definition = result["definition"]
        self.assertEqual(definition["paper"]["size"], "A4")
        self.assertTrue(10 <= definition["paper"]["margin_mm"]["left"] <= 20, definition["paper"])
        self.assertTrue(all(section.get("print_style") == "boxed" for section in definition["sections"]))
        self.assertEqual([column["layout"]["span"] for column in table["fields"]], [12, 6, 6])
        self.assertEqual(timeline["print_columns"], 28)
        grid = next(field for field in found.values() if field["type"] == "matrix")
        self.assertEqual([row["label"] for row in grid["rows"]], ["ความปวด", "การหายใจ"])
        self.assertEqual([col["label"] for col in grid["cols"]], ["เช้า", "บ่าย", "ดึก"])
        self.assertIn("การประเมิน", grid["label"])
        diagnosis = found["case_diagnosis"]["layout"]
        self.assertEqual((diagnosis["col"], diagnosis["span"]), (1, 24))
        for name, place in result["provenance"].items():
            self.assertTrue(place["source"], f"{name} points at its evidence")


def page_evidence():
    """A small page as layout.py describes it: a labelled blank, a cell with a list, a symbol."""
    lines = [
        {"id": "L1", "text": "WT_", "box": [0.10, 0.10, 0.15, 0.12], "score": 0.95, "cell": "C1"},
        {"id": "L2", "text": "_kg", "box": [0.26, 0.10, 0.29, 0.12], "score": 0.95, "cell": "C1"},
        {"id": "L3", "text": "NO/AIR", "box": [0.10, 0.30, 0.16, 0.32], "score": 0.9, "cell": "C2"},
        {"id": "L4", "text": "NIBP SpO2 EKG", "box": [0.10, 0.50, 0.30, 0.52], "score": 0.97, "cell": "C3"},
        {"id": "L5", "text": "DEPTH", "box": [0.40, 0.50, 0.45, 0.52], "score": 0.97, "cell": "C3"},
        {"id": "L6", "text": "x", "box": [0.60, 0.60, 0.61, 0.61], "score": 0.5, "cell": "C3"},
    ]
    return {"page": 0, "size": [1654, 2339], "dpi": 200, "lines": lines,
            "cells": [{"id": "C1", "box": [0.05, 0.05, 0.4, 0.2], "lines": ["L1", "L2"], "empty": 0.8},
                      {"id": "C2", "box": [0.05, 0.25, 0.4, 0.35], "lines": ["L3"], "empty": 0.7},
                      {"id": "C3", "box": [0.05, 0.45, 0.7, 0.7], "lines": ["L4", "L5", "L6"], "empty": 0.6}],
            "grids": [], "checkboxes": [], "blanks": [{"id": "B1", "kind": "underline", "box": [0.16, 0.115, 0.25, 0.125], "cell": "C1"}]}


def page_sections():
    return [{"title": None, "items": [
        {"id": "I1.1", "kind": "field", "type": "decimal", "label": "WT", "unit": "kg", "source": ["L1", "B1", "L2"], "page": 0,
         "box": [0.1, 0.1, 0.29, 0.125], "by": "tools", "unsure": [], "confidence": 0.9},
        {"id": "I1.2", "kind": "field", "type": "text", "label": "NO/AIR", "source": ["L3", "C2"], "page": 0, "box": [0.1, 0.3, 0.16, 0.32],
         "by": "tools", "unsure": ["the type is a guess"], "confidence": 0.7},
        {"id": "I1.3", "kind": "field", "type": "multiselect", "label": assemble.NO_NAME, "source": ["L4"], "page": 0,
         "box": [0.1, 0.5, 0.3, 0.52], "options": [{"label": "NIBP", "source": ["L4"]}, {"label": "SpO2", "source": ["L4"]}, {"label": "EKG", "source": ["L4"]}],
         "by": "tools", "unsure": ["a list without a name: name it"], "confidence": 0.6},
    ]}]


class AiEdits(unittest.TestCase):
    """The AI's answer is applied only where the page supports it."""

    def apply(self, answer):
        evidence, sections, ignored = page_evidence(), page_sections(), [{"source": "L6", "why": "a mark or symbol"}]
        result = assemble.apply(answer, evidence, sections, ignored)
        items = {item["id"]: item for item in sections[0]["items"]}
        return result, items, ignored

    def test_misreads_are_fixed_and_meanings_become_english_labels(self):
        result, items, _ = self.apply({"edit": [
            {"item": "I1.2", "label": "N2O/AIR", "label_en": "Nitrous oxide / air"},     # an OCR slip: corrected
            {"item": "I1.1", "label": "Body weight"},                                    # a meaning, not the print
            {"item": "I1.3", "label": "Monitoring", "label_en": "Monitoring"},          # no printed name: named
        ]})
        self.assertEqual((items["I1.2"]["label"], items["I1.2"]["fixed_from"]), ("N2O/AIR", "NO/AIR"))
        self.assertEqual((items["I1.1"]["label"], items["I1.1"]["label_en"]), ("WT", "Body weight"))
        self.assertEqual(items["I1.3"]["label"], "Monitoring")
        self.assertNotIn("fixed_from", items["I1.3"])
        self.assertTrue(all(items[i]["by"] == "ai" for i in ("I1.1", "I1.2", "I1.3")))

    def test_what_the_page_does_not_show_is_refused(self):
        result, items, _ = self.apply({
            "edit": [{"item": "I1.1", "unit": "lb"}, {"item": "I1.3", "label": "NIBP SpO2 EKG"}, {"item": "I9.9", "label": "x"},
                     {"item": "I1.2", "label": "Something else entirely", "label_en": "Other"}],
            "remove": [{"item": "I1.1", "why": "duplicate"}],
            "add": [{"kind": "field", "type": "text", "label": "Anaesthetist"}, {"kind": "field", "type": "text", "label": "Operation", "source": ["L5"]}],
        })
        reasons = " | ".join(entry["why"] for entry in result["rejected"])
        self.assertIn("unit 'lb' is not printed", reasons)
        self.assertIn("repeats the options", reasons)
        self.assertIn("no such item", reasons)
        self.assertIn("place to write it (B1)", reasons, "a field with a blank on the page stays")
        self.assertIn("must point at printed evidence", reasons)
        self.assertIn("not what the page says", reasons)
        self.assertEqual(items["I1.1"]["unit"], "kg")
        self.assertEqual(items["I1.2"]["label"], "NO/AIR")
        self.assertEqual(len(items), 3, "nothing added that the page does not show")

    def test_additions_point_at_evidence_and_removals_set_their_text_aside(self):
        result, items, ignored = self.apply({
            "add": [{"kind": "field", "type": "text", "label": "Depth", "source": ["L5"], "after": "I1.3", "label_en": "Tube depth"}],
            "remove": [{"item": "I1.2", "why": "a chart label, not a field"}],
            "sections": [{"section": 1, "title": "Anaesthesia", "title_en": "Anaesthesia"}],
        })
        added = next(item for item in items.values() if item["id"].startswith("A"))
        self.assertEqual((added["label"], added["source"], added["by"]), ("Depth", ["L5"], "ai"))
        self.assertNotIn("I1.2", items)
        self.assertIn({"source": "L3", "why": "a chart label, not a field", "by": "ai"}, ignored)
        coverage = assemble.coverage(page_evidence(), [{"items": list(items.values())}], ignored)
        self.assertEqual((coverage["missed"], coverage["share"]), ([], 1.0))

    def test_similarity_reads_like_the_print(self):
        self.assertGreaterEqual(assemble.similar("Cuff details", "CUFF__ml. , PACK , SIZE"), 0.5)
        self.assertGreaterEqual(assemble.similar("N2O/AIR", "NO/AIR"), 0.6)
        self.assertLess(assemble.similar("Weight", "WT_ _kg"), 0.5)


class AiPage(unittest.TestCase):
    """One page with the AI: what it is sent, the second question about lines left over, a busy server asked again."""

    def setUp(self):
        self.saved = ai_builder.Conversation.ask, assemble.RETRY_S
        assemble.RETRY_S = 0
        self.prompts = []

    def tearDown(self):
        ai_builder.Conversation.ask, assemble.RETRY_S = self.saved

    def script(self, *answers):
        replies = list(answers)

        def ask(conversation):
            conversation.usage["requests"] += 1
            self.prompts.append(conversation.messages[-1]["content"])
            reply = replies.pop(0)
            if isinstance(reply, Exception):
                raise reply
            return reply
        ai_builder.Conversation.ask = ask

    def run_page(self):
        from PIL import Image

        evidence, sections = page_evidence(), page_sections()
        ignored = [{"source": "L6", "why": "a mark or symbol"}]
        missed = assemble.coverage(evidence, sections, ignored)["missed"]
        events = []
        result = assemble.assemble_page(CONFIG, Image.new("RGB", (400, 566), "white"), evidence, sections, ignored, missed,
                                        emit=lambda kind, page=None, **data: events.append((kind, data)))
        return result, sections, events

    def test_all_the_evidence_is_sent_and_lines_left_over_are_asked_about_once(self):
        self.script(ai_builder.BuildError("The AI service did not answer in time (502)"),
                    '<answer>{"edit": [{"item": "I1.3", "label": "Monitoring"}]}</answer>',
                    '<answer>{"ignore": [{"source": "L5", "why": "a column heading of the airway list"}]}</answer>')
        result, sections, events = self.run_page()
        first = self.prompts[0]
        told = next(block["text"] for block in first if block.get("type") == "text" and block["text"].startswith("{"))
        for evidence_id in ("L1", "L4", "B1", "C3", "I1.1"):
            self.assertIn(evidence_id, told)
        self.assertEqual(sum(block.get("type") == "image" for block in first), 1 + result["sent"]["closeups"], "the page and its close-ups")
        self.assertEqual(result["sent"]["unused"], 1)
        self.assertEqual(events[0][0], "ai_started")
        self.assertTrue(result["asked_again"])
        self.assertIn("L5", self.prompts[-1], "the second question names the line left over")
        self.assertEqual((result["coverage_before"]["share"] < 1, result["coverage_after"]["share"]), (True, 1.0))
        self.assertEqual(result["usage"]["requests"], 3, "a busy server is asked once more")


@unittest.skipUnless(HAS_OCR, "needs the OCR models and Noto fonts (the API image)")
class ReadingWithAi(unittest.TestCase):
    def setUp(self):
        self.saved = ai_builder.Conversation.ask

    def tearDown(self):
        ai_builder.Conversation.ask = self.saved

    def test_the_ai_edits_the_tools_plan_and_the_draft_shows_who_did_what(self):
        def ask(conversation):
            conversation.usage["requests"] += 1
            return ('<answer>{"title_en": "Pre-operative assessment", "sections": [{"section": 1, "title": "ข้อมูลผู้ป่วย", "title_en": "Patient"}],'
                    ' "edit": [{"item": "I1.2", "label_en": "Full name"}], "remove": [{"item": "I1.3", "why": "not a field"}]}</answer>')
        ai_builder.Conversation.ask = ask
        from reading_samples import as_pdf, form_image

        job = run_job(as_pdf(form_image()), {"ai": True})
        kinds = [event["kind"] for event in job.events]
        self.assertLess(kinds.index("plan"), kinds.index("ai_started"))
        self.assertLess(kinds.index("ai_started"), kinds.index("ai_done"))
        ai = job.result["ai"][0]
        self.assertGreater(ai["sent"]["lines"], 5)
        self.assertTrue(any("place to write" in entry["why"] for entry in ai["rejected"]), ai["rejected"])
        definition = job.result["definition"]
        self.assertEqual(definition["sections"][0]["title"], "ข้อมูลผู้ป่วย")
        by = {place["by"] for place in job.result["provenance"].values()}
        self.assertEqual(by, {"tools", "ai"})
        self.assertGreater(job.usage["requests"], 0)


class Plans(unittest.TestCase):
    def test_a_plan_compiles_to_a_valid_draft_with_its_record_over_time(self):
        plan = {"title": "Record", "sections": [{"items": [
            {"id": "I1.1", "kind": "field", "type": "decimal", "label": "WT", "unit": "kg", "page": 0, "box": [0.1, 0.1, 0.3, 0.12], "source": ["L1"]},
            {"id": "I1.2", "kind": "field", "type": "repeat", "label": "AGENTS", "page": 0, "box": [0.1, 0.2, 0.9, 0.3], "source": ["L2"],
             "columns": [{"label": "AGENTS"}, {"label": "DOSAGE"}]},
        ]}, {"grid": True, "items": [
            {"id": "I1.3", "kind": "field", "type": "timeline", "label": "Intra-op", "page": 0, "box": [0.1, 0.4, 0.9, 0.7], "source": ["G1"],
             "rows": [{"label": "SpO2"}, {"label": "2"}, {"label": "2"}], "chart": ["nibp", "pr", "nonsense"], "parts": ["chart", "table"]},
        ]}]}
        result = draft.build(plan)
        self.assertEqual(result["issues"], [])
        found = fields_of(result["definition"])
        self.assertEqual(found["patient_weight_kg"]["unit"], "kg")
        agents = found["agents"]
        self.assertNotIn("agents", [column["id"] for column in agents["fields"]], "column ids are unique in the form")
        timeline = next(field for field in found.values() if field["type"] == "timeline")["timeline"]
        self.assertEqual([row["id"] for row in timeline["rows"]][0], "spo2")
        self.assertEqual(len({row["id"] for row in timeline["rows"]}), 3)
        self.assertEqual(timeline["chart"], ["nibp", "pr"])
        self.assertEqual(result["definition"]["sections"][1]["title"], "บันทึกตามเวลา")

    def test_a_printed_table_of_case_data_becomes_a_report_component_as_wide_as_on_paper(self):
        plan = {"title": "Report", "sections": [{"items": [
            {"id": "I1.1", "kind": "field", "type": "case_block", "block": "medications", "block_columns": ["time", "name", "dose", "nope"],
             "label": "ยาที่ให้", "page": 0, "box": [0.1, 0.2, 0.9, 0.4], "source": ["L1"], "min_rows": 6,
             "columns": [{"label": "เวลา", "width": 0.1}, {"label": "ชื่อยา", "width": 0.6}, {"label": "ขนาด", "width": 0.3}]},
            {"id": "I1.2", "kind": "field", "type": "case_block", "block": "vitals", "label": "ตาราง", "page": 0, "box": [0.1, 0.5, 0.9, 0.6],
             "source": ["L2"], "columns": [{"label": "A"}]},
        ]}]}
        result = draft.build(plan)
        self.assertEqual(result["issues"], [])
        found = fields_of(result["definition"])
        meds = next(field for field in found.values() if field["type"] == "case_block")
        self.assertEqual(meds["block"], "medications")
        self.assertEqual(meds["block_columns"], [{"key": "time", "width": 10}, {"key": "name", "width": 60, "label": "ชื่อยา"}, {"key": "dose", "width": 30}])
        self.assertEqual((meds["min_rows"], meds["max_rows"]), (6, 10))
        self.assertEqual(meds["layout"]["span"], 24, "a table takes the whole row")
        self.assertTrue(any(field["type"] == "repeat" for field in found.values()), "an unknown block stays a table")

    def test_the_ai_may_turn_a_table_into_a_report_component_but_only_a_known_block(self):
        item = {"id": "I1.1", "type": "case_block"}
        rejected: list = []
        assemble._block_edit(item, {"block": "labs", "block_columns": ["test", "value", "value", "bogus"]}, rejected)
        self.assertEqual((item["block"], item["block_columns"], rejected), ("labs", ["test", "value"], []))
        other = {"id": "I1.2", "type": "case_block"}
        assemble._block_edit(other, {"block": "weather"}, rejected)
        self.assertEqual(other["type"], "repeat")
        self.assertEqual(len(rejected), 1)
        self.assertIn("case_block", assemble.SYSTEM)
        self.assertIn("medications", assemble.SYSTEM)

    def test_tall_boxes_cover_the_rows_beside_them_and_the_paper_is_the_documents(self):
        item = lambda id_, label, box, anchor=None, kind="text": {"id": id_, "kind": "field", "type": kind, "label": label, "page": 0, "box": box,
                                                                   "anchor": anchor or box, "source": ["L1"]}
        plan = {"title": "Record", "sections": [{"ruled": True, "items": [
            item("I1", "DATE", [0.05, 0.10, 0.30, 0.12]), item("I2", "DIAGNOSIS", [0.60, 0.10, 0.95, 0.20], [0.60, 0.10, 0.75, 0.12], "textarea"),
            item("I3", "NAME", [0.05, 0.13, 0.30, 0.15]), item("I4", "AGE", [0.05, 0.16, 0.30, 0.18]),
            item("I5", "ASA", [0.05, 0.22, 0.30, 0.24]), item("I6", "NOTE", [0.60, 0.22, 0.95, 0.24]),
        ]}]}
        result = draft.build(plan, pages=[{"width_pt": 842, "height_pt": 595}])
        self.assertEqual(result["issues"], [])
        found = fields_of(result["definition"])
        self.assertEqual(found["case_diagnosis"]["layout"]["row_span"], 3, "beside DATE, NAME and AGE, up to ASA's row")
        self.assertNotIn("row_span", found["general_note"]["layout"])
        paper = result["definition"]["paper"]
        self.assertEqual((paper["size"], paper["orientation"]), ("A4", "landscape"))
        self.assertEqual(result["definition"]["sections"][0]["print_style"], "boxed")

    def test_the_ai_builders_form_keeps_the_measured_paper(self):
        measured = {"paper": {"size": "A4", "margin_mm": {"top": 18, "right": 5, "bottom": 15, "left": 10}}, "layout": {"type": "grid", "columns": 24},
                    "sections": [{"id": "general", "print_style": "boxed", "fields": [
                        {"id": "patient_hn", "type": "text", "label": "HN", "layout": {"row": 1, "col": 17, "span": 4}},
                        {"id": "case_diagnosis", "type": "textarea", "label": "DIAGNOSIS", "layout": {"row": 1, "col": 1, "span": 16, "row_span": 2}},
                        {"id": "agents", "type": "repeat", "label": "AGENTS", "columns": 24, "layout": {"row": 3, "col": 1, "span": 24},
                         "fields": [{"id": "agent", "type": "text", "label": "AGENTS", "layout": {"span": 15}},
                                    {"id": "dosage", "type": "text", "label": "DOSAGE", "layout": {"span": 9}}]}]}]}
        ai = {"format": "flora.form/1", "form_id": "anesthetic_record", "schema_version": 1, "title": "Anesthetic record", "style_id": "form.a4.medical",
              "layout": {"type": "grid", "columns": 24}, "sections": [{"id": "general", "title": "Pre-op", "fields": [
                  {"id": "patient_hn", "type": "text", "label": "HN", "label_en": "Hospital number"},
                  {"id": "case_diagnosis", "type": "textarea", "label": "Diagnosis"},
                  {"id": "agents", "type": "repeat", "label": "Agents", "fields": [{"id": "agent", "type": "text", "label": "Agent"},
                                                                                     {"id": "dosage", "type": "text", "label": "Dosage"}]},
                  {"id": "new_field", "type": "text", "label": "Added by the AI"}]}]}
        kept = draft.keep_paper(ai, measured)
        section = kept["sections"][0]
        found = {field["id"]: field for field in section["fields"]}
        self.assertEqual(kept["paper"]["margin_mm"]["left"], 10)
        self.assertEqual(section["print_style"], "boxed")
        self.assertEqual(found["patient_hn"]["layout"], {"row": 1, "col": 17, "span": 4})
        self.assertEqual(found["case_diagnosis"]["layout"]["row_span"], 2)
        self.assertEqual([child["layout"]["span"] for child in found["agents"]["fields"]], [15, 9])
        self.assertEqual(found["patient_hn"]["label_en"], "Hospital number", "the AI's corrections stay")
        self.assertNotIn("layout", found["new_field"])
        self.assertEqual(validate_definition(kept), [])


if __name__ == "__main__":
    unittest.main()
