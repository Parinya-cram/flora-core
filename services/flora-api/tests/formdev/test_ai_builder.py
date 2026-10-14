"""AI form builder (Form Studio): document inspection, the build / correction loop (with a scripted model) and the
template library."""
import base64
import io
import json
import os
import tempfile
import unittest
import zipfile

os.environ.setdefault("FLORA_DATABASE_URL", "postgresql://unused@localhost/unused")
os.environ.setdefault("FLORA_API_MODE", "canopy")

from app.formdev import ai_builder, documents  # noqa: E402
from app.formdev.adapters.sqlite import SQLiteAdapter  # noqa: E402
from app.formdev.errors import FormDevError  # noqa: E402
from app.formdev.query.xlsx import write_xlsx  # noqa: E402
from helpers import USER, example, ready_services  # noqa: E402

PDF = b"%PDF-1.7\n1 0 obj<</Type /Catalog>>endobj\n2 0 obj<</Type /Page /Resources<</Font<<>>>>>>endobj\n3 0 obj<</Type /Page>>endobj\n%%EOF\n"
PNG = b"\x89PNG\r\n\x1a\n" + b"\x00" * 64


def upload(*files):
    return {"files": [{"name": name, "data": base64.b64encode(content).decode("ascii")} for name, content in files]}


def docx(paragraphs, table):
    ns = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"'
    body = "".join(f"<w:p><w:r><w:t>{text}</w:t></w:r></w:p>" for text in paragraphs)
    body += "<w:tbl>" + "".join("<w:tr>" + "".join(f"<w:tc><w:p><w:r><w:t>{cell}</w:t></w:r></w:p></w:tc>" for cell in row) + "</w:tr>" for row in table) + "</w:tbl>"
    out = io.BytesIO()
    with zipfile.ZipFile(out, "w") as archive:
        archive.writestr("[Content_Types].xml", "<Types/>")
        archive.writestr("word/document.xml", f"<w:document {ns}><w:body>{body}</w:body></w:document>")
    return out.getvalue()


def inspect(*files):
    return documents.inspect(documents.read_upload(upload(*files)))


class Inspection(unittest.TestCase):
    def test_types_come_from_the_content_not_the_name(self):
        pdf, image, text = inspect(("form.png", PDF), ("scan.pdf", PNG), ("notes.pdf", "ชื่อ / Name: ______".encode("utf-8")))
        self.assertEqual((pdf.kind, pdf.media_type, pdf.pages, pdf.has_text_layer), ("pdf", "application/pdf", 2, True))
        self.assertEqual((image.kind, image.media_type), ("image", "image/png"))
        self.assertEqual(text.kind, "text")
        self.assertIn("Name", text.text)

    def test_encrypted_pdf_and_old_office_files_are_refused(self):
        locked, old = inspect(("locked.pdf", PDF.replace(b"/Catalog", b"/Catalog /Encrypt 5 0 R")), ("form.doc", b"\xd0\xcf\x11\xe0" + b"\x00" * 40))
        self.assertEqual(locked.status, "error")
        self.assertEqual(old.status, "error")
        self.assertIn(".docx", old.notes[0])

    def test_a_scan_without_text_layer_is_a_warning(self):
        (scan,) = inspect(("scan.pdf", PDF.replace(b"/Font", b"/XObject")))
        self.assertEqual((scan.status, scan.has_text_layer), ("warning", False))

    def test_scanned_pages_are_taken_from_the_pdf(self):
        jpeg = b"\xff\xd8\xff\xe0" + b"\x01" * 20_000 + b"\xff\xd9"
        scan = (b"%PDF-1.3\n1 0 obj<</Type /Page>>endobj\n2 0 obj\n<< /Type /XObject /Subtype /Image /Width 10 /Height 10 /Length "
                + str(len(jpeg)).encode() + b" /Filter\n/DCTDecode >>\nstream\n" + jpeg + b"\nendstream\nendobj\n%%EOF\n")
        (pdf,) = inspect(("scan.pdf", scan))
        self.assertEqual((pdf.has_text_layer, pdf.scan_images), (False, [jpeg]))
        parts = ai_builder._openai_content([pdf], "go")
        self.assertTrue(parts[1]["image_url"]["url"].startswith("data:image/jpeg;base64,"), "an OpenAI-compatible host gets the scanned page")

    def test_archives_are_read_within_a_size_limit(self):
        """A small upload that expands to a huge part (zip bomb) is refused before it is read in full."""
        bomb = io.BytesIO()
        with zipfile.ZipFile(bomb, "w", zipfile.ZIP_DEFLATED) as archive:
            archive.writestr("word/document.xml", b"<w:document>" + b"a" * 2_000_000 + b"</w:document>")
        saved = documents.MAX_PART_BYTES
        documents.MAX_PART_BYTES = 1_000_000
        try:
            (word,) = inspect(("bomb.docx", bomb.getvalue()))
        finally:
            documents.MAX_PART_BYTES = saved
        self.assertLess(len(bomb.getvalue()), 50_000)
        self.assertEqual(word.status, "error")
        self.assertIn("expands", word.notes[0])

    def test_xml_entity_declarations_are_refused(self):
        laughs = io.BytesIO()
        with zipfile.ZipFile(laughs, "w") as archive:
            archive.writestr("word/document.xml", '<?xml version="1.0"?><!DOCTYPE d [<!ENTITY a "aaaaaaaa"><!ENTITY b "&a;&a;&a;&a;">]><d>&b;</d>')
        (word,) = inspect(("laughs.docx", laughs.getvalue()))
        self.assertEqual(word.status, "error")

    def test_excel_sheets_follow_their_relationships_and_wide_rows_are_clipped(self):
        ns = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"'
        book = io.BytesIO()
        with zipfile.ZipFile(book, "w") as archive:
            archive.writestr("xl/workbook.xml", f'<workbook {ns}><sheets><sheet name="Vitals" sheetId="1" r:id="rId9"/><sheet name="Notes" sheetId="2" r:id="rId3"/></sheets></workbook>')
            archive.writestr("xl/_rels/workbook.xml.rels", '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
                             '<Relationship Id="rId9" Target="worksheets/sheet2.xml"/><Relationship Id="rId3" Target="/xl/worksheets/sheet1.xml"/></Relationships>')
            archive.writestr("xl/worksheets/sheet1.xml", f'<worksheet {ns}><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>note</t></is></c></row></sheetData></worksheet>')
            archive.writestr("xl/worksheets/sheet2.xml", f'<worksheet {ns}><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>HR</t></is></c>'
                             '<c r="XFD1" t="inlineStr"><is><t>far</t></is></c></row></sheetData></worksheet>')
        (sheet,) = inspect(("vitals.xlsx", book.getvalue()))
        self.assertEqual(sheet.text.splitlines(), ["[sheet Vitals]", "HR", "[sheet Notes]", "note"])
        self.assertEqual(sheet.status, "warning")

    def test_a_scan_without_end_marker_is_skipped(self):
        cut = b"%PDF-1.3\n1 0 obj<</Type /Page>>endobj\n2 0 obj\n<< /Subtype /Image /Filter /DCTDecode >>\nstream\n\xff\xd8" + b"\x01" * 20_000
        self.assertEqual(documents.scan_jpegs(cut), [])

    def test_a_file_added_twice_is_read_once(self):
        first, second = inspect(("a.txt", b"HN ____"), ("b.txt", b"HN ____"))
        self.assertEqual((first.duplicate, second.duplicate), (False, True))
        self.assertEqual((first.text, second.text), ("HN ____", ""))

    def test_word_paragraphs_and_tables_are_read(self):
        (word,) = inspect(("pacu.docx", docx(["PACU Record", "HN ______"], [["Criteria", "Admit", "D/C"], ["Activity", "", ""]])))
        self.assertEqual(word.kind, "docx")
        self.assertIn("PACU Record", word.text)
        self.assertIn("Criteria | Admit | D/C", word.text)

    def test_excel_cells_are_read(self):
        with tempfile.TemporaryDirectory() as folder:
            write_xlsx(f"{folder}/a.xlsx", "Vitals", [["Time", "HR", "BP"], ["08:00", 72, "120/80"]])
            with open(f"{folder}/a.xlsx", "rb") as handle:
                content = handle.read()
        (sheet,) = inspect(("vitals.xlsx", content))
        self.assertEqual(sheet.kind, "xlsx")
        self.assertIn("Time | HR | BP", sheet.text)
        self.assertIn("08:00 | 72 | 120/80", sheet.text)

    def test_a_form_definition_file_is_recognised(self):
        (form,) = inspect(("pa.form.json", json.dumps(example(1)).encode("utf-8")))
        self.assertEqual(form.kind, "form_json")
        self.assertEqual(form.definition["form_id"], "patient_assessment")

    def test_limits(self):
        with self.assertRaises(documents.DocumentError):
            documents.read_upload({"files": []})
        with self.assertRaises(documents.DocumentError):
            documents.read_upload({"files": [{"name": "x", "data": "not base64!"}]})
        with self.assertRaises(documents.DocumentError):
            documents.read_upload(upload(*[(f"f{n}", b"x") for n in range(documents.MAX_FILES + 1)]))
        (empty,) = inspect(("empty.txt", b""))
        self.assertEqual(empty.status, "error")

    def test_summary(self):
        report = documents.summary(inspect(("a.pdf", PDF), ("b.doc", b"\xd0\xcf\x11\xe0")))
        self.assertFalse(report["ok"])
        self.assertEqual((report["errors"], len(report["files"])), (1, 2))
        self.assertEqual(len(report["files"][0]["sha256"]), 64)


def answer(definition, report=None):
    return f"<form_json>\n{json.dumps(definition, ensure_ascii=False)}\n</form_json>\n<report>{json.dumps(report or {})}</report>"


class Build(unittest.TestCase):
    """build() with a scripted model in place of the AI service."""

    def setUp(self):
        self.folder = tempfile.TemporaryDirectory()
        self.fd = ready_services(SQLiteAdapter(f"{self.folder.name}/formdev.db"))
        self.sent = []
        self.original = ai_builder.Conversation.ask, ai_builder.Conversation.follow_up

    def tearDown(self):
        ai_builder.Conversation.ask, ai_builder.Conversation.follow_up = self.original
        self.fd.adapter.close()
        self.folder.cleanup()

    def script(self, *answers):
        queue = list(answers)
        sent = self.sent

        def ask(conversation):
            conversation.usage["requests"] += 1
            return queue.pop(0)

        def follow_up(conversation, text):
            sent.append(text)

        ai_builder.Conversation.ask, ai_builder.Conversation.follow_up = ask, follow_up

    def build(self, **options):
        config = {"api_format": "anthropic", "model": "claude-opus-5-5", "api_key": "test"}
        return ai_builder.build(config, inspect(("pacu.pdf", PDF)), validate=self.fd.schemas.validate, **options)

    def test_validation_problems_go_back_to_the_model(self):
        broken = example(1)
        broken["sections"][0]["fields"][0]["layout"] = {"span": 30}
        report = {"document_type": "Assessment", "coverage": [{"source": "pacu.pdf p.1", "item": "HN", "field": "hn"},
                                                            {"source": "pacu.pdf p.1", "item": "Ward", "field": None},
                                                            {"source": "pacu.pdf p.1", "item": "Bed", "field": "bed_no"}],
                  "placement": {"phase": "postop", "after_section": "pacu", "reason": "recovery room"}}
        self.script(answer(broken), answer(example(1), report))
        result = self.build()
        self.assertEqual(result["attempts"], 2)
        self.assertIn("invalid_span", self.sent[0])
        self.assertEqual(result["issues"], [])
        self.assertEqual(result["definition"]["extensions"][ai_builder.PLACEMENT_KEY], {"phase": "postop", "after_section": "pacu"})
        self.assertEqual(result["report"]["missing"], 2, "the uncaptured item and the unknown field")
        self.assertEqual(result["report"]["unknown_fields"], ["bed_no"])

    def test_the_placement_is_reported_when_extensions_is_not_an_object(self):
        odd = example(1)
        odd["extensions"] = "nope"
        self.script(answer(odd, {"placement": {"phase": "postop"}}), answer(odd, {}), answer(odd, {}))
        result = self.build()
        self.assertTrue(result["report"]["placement_not_stored"])
        self.assertEqual(result["definition"]["extensions"], "nope")

    def test_unparseable_answers_are_retried_then_give_up(self):
        self.script("no json here", "<form_json>{broken</form_json>", "still nothing")
        with self.assertRaises(ai_builder.BuildError):
            self.build()
        self.assertEqual(len(self.sent), 2)

    def test_remaining_problems_are_returned_after_the_last_correction(self):
        broken = example(1)
        broken["sections"][0]["fields"][0]["layout"] = {"span": 30}
        self.script(answer(broken), answer(broken), answer(broken))
        result = self.build()
        self.assertEqual(result["attempts"], 3)
        self.assertTrue(any(issue["code"] == "invalid_span" for issue in result["issues"]))

    def test_the_authors_form_id_and_title_win(self):
        self.script(answer(example(1), {"placement": {"phase": "nonsense", "after_section": "nowhere"}}))
        result = self.build(form_id="pacu_record", title="บันทึก PACU")
        self.assertEqual((result["definition"]["form_id"], result["definition"]["title"]), ("pacu_record", "บันทึก PACU"))
        self.assertEqual(result["report"]["placement"], {"phase": "any", "after_section": None, "reason": ""})

    def test_an_unconfigured_service_is_refused(self):
        with self.assertRaises(ai_builder.BuildError):
            ai_builder.build({"model": ""}, [], validate=self.fd.schemas.validate)

    def test_the_request_carries_documents_and_extracted_text(self):
        files = inspect(("form.pdf", PDF), ("scan.png", PNG), ("notes.txt", b"Allergy: ____"))
        anthropic = ai_builder.Conversation({"api_format": "anthropic", "model": "m"}, files, "go").messages[0]["content"]
        self.assertEqual([block["type"] for block in anthropic], ["document", "text", "image", "text"])
        files[0].page_images = [PNG, PNG]
        openai = ai_builder.Conversation({"api_format": "openai", "model": "m"}, files, "go").messages[0]["content"]
        self.assertEqual(sum(part["type"] == "image_url" for part in openai), 3, "two PDF pages and the photo")
        self.assertIn("Allergy", ai_builder._request_text(files, "", None, None))

    def test_the_prompt_lists_every_field_type(self):
        from app.formdev.field_types import FIELD_TYPES

        for name in FIELD_TYPES:
            self.assertIn(f"- {name}:", ai_builder.SYSTEM_PROMPT)


class ImageScaling(unittest.TestCase):
    """Self-hosted vision models get pages they can read within a proxy's time limit."""

    def test_large_pages_are_scaled_down_and_small_ones_kept(self):
        from PIL import Image

        big, small = io.BytesIO(), io.BytesIO()
        Image.new("RGB", (1600, 2200), "white").save(big, "PNG")
        Image.new("RGB", (400, 300), "white").save(small, "PNG")
        media, data = ai_builder.fit_image(big.getvalue(), "image/png", 1280)
        self.assertEqual((media, max(Image.open(io.BytesIO(data)).size)), ("image/jpeg", 1280))
        self.assertEqual(ai_builder.fit_image(small.getvalue(), "image/png", 1280), ("image/png", small.getvalue()))
        self.assertEqual(ai_builder.fit_image(b"not an image", "image/png", 1280), ("image/png", b"not an image"))

    def test_more_pages_mean_smaller_pages(self):
        self.assertGreater(ai_builder.image_limit(1), ai_builder.image_limit(3))
        self.assertGreater(ai_builder.image_limit(3), ai_builder.image_limit(8))
        self.assertGreaterEqual(ai_builder.image_limit(40), 768)


class ChatStream(unittest.TestCase):
    """OpenAI-compatible answers arrive as server-sent events (kept flowing through proxies with time limits)."""

    class Response(io.BytesIO):
        def __init__(self, body, content_type):
            super().__init__(body)
            self.headers = {"Content-Type": content_type}

    def test_events_are_joined_and_reasoning_left_out(self):
        events = [{"choices": [{"delta": {"reasoning_content": "thinking"}}]}, {"choices": [{"delta": {"content": "<form_json>{}"}}]},
                  {"choices": [{"delta": {"content": "</form_json>"}, "finish_reason": "stop"}]}, {"choices": [], "usage": {"prompt_tokens": 7, "completion_tokens": 3}}]
        body = "".join(f"data: {json.dumps(event)}\n\n" for event in events) + "data: [DONE]\n\n"
        text, usage, finish = ai_builder.read_chat_stream(self.Response(body.encode(), "text/event-stream; charset=utf-8"))
        self.assertEqual((text, usage["completion_tokens"], finish), ("<form_json>{}</form_json>", 3, "stop"))

    def test_hosts_that_ignore_streaming_still_work(self):
        body = json.dumps({"choices": [{"message": {"content": "hi"}, "finish_reason": "stop"}], "usage": {"prompt_tokens": 1}}).encode()
        self.assertEqual(ai_builder.read_chat_stream(self.Response(body, "application/json"))[0], "hi")

    def test_an_error_event_stops_the_build(self):
        with self.assertRaises(ai_builder.BuildError):
            ai_builder.read_chat_stream(self.Response(b'data: {"error": {"message": "model not loaded"}}\n\n', "text/event-stream"))


class Templates(unittest.TestCase):
    def setUp(self):
        self.folder = tempfile.TemporaryDirectory()
        self.fd = ready_services(SQLiteAdapter(f"{self.folder.name}/formdev.db"))

    def tearDown(self):
        self.fd.adapter.close()
        self.folder.cleanup()

    def test_ids_are_unique_and_lists_leave_out_the_definition(self):
        first = self.fd.templates.create(definition=example(1), user=USER, origin="ai")
        second = self.fd.templates.create(definition=example(1), user=USER)
        self.assertEqual((first["template_id"], second["template_id"]), ("patient_assessment", "patient_assessment_2"))
        rows = self.fd.templates.list()
        self.assertEqual(len(rows), 2)
        self.assertNotIn("definition", rows[0])

    def test_reviewed_needs_a_valid_definition_and_edits_make_it_a_draft_again(self):
        broken = example(1)
        broken["sections"][0]["fields"][0]["layout"] = {"span": 30}
        template = self.fd.templates.create(definition=broken, user=USER, origin="ai")
        with self.assertRaises(FormDevError) as caught:
            self.fd.templates.update(template["template_id"], {"version": 1, "status": "reviewed"}, USER)
        self.assertEqual(caught.exception.code, "template_not_valid")
        fixed = self.fd.templates.update(template["template_id"], {"version": 1, "definition": example(1), "status": "reviewed"}, USER)
        self.assertEqual((fixed["status"], fixed["version"]), ("reviewed", 2))
        changed = example(1)
        changed["title"] = "Changed"
        again = self.fd.templates.update(template["template_id"], {"version": 2, "definition": changed}, USER)
        self.assertEqual(again["status"], "draft")
        with self.assertRaises(FormDevError) as conflict:
            self.fd.templates.update(template["template_id"], {"version": 2, "title": "x"}, USER)
        self.assertEqual(conflict.exception.status, 409)

    def test_a_form_is_created_from_a_template(self):
        template = self.fd.templates.create(definition=example(1), user=USER)
        definition = self.fd.templates.form_definition(template["template_id"], "pacu_record", "PACU")
        self.fd.schemas.create_form(definition, USER)
        self.assertEqual(self.fd.forms.get("pacu_record")["title"], "PACU")
        self.assertEqual(self.fd.templates.get(template["template_id"])["definition"]["form_id"], "patient_assessment", "the template is unchanged")

    def test_delete_and_refusals(self):
        template = self.fd.templates.create(definition=example(1), user=USER)
        self.fd.templates.delete(template["template_id"])
        with self.assertRaises(FormDevError):
            self.fd.templates.get(template["template_id"])
        with self.assertRaises(FormDevError):
            self.fd.templates.create(definition={"format": "other"}, user=USER)
        with self.assertRaises(FormDevError):
            self.fd.templates.create(definition=example(1), user=USER, origin="robot")


class WorkflowPlacement(unittest.TestCase):
    """Workflow Studio keeps where each form is filled in on Leaf; Form Studio's suggestion is read back."""

    def test_forms_keep_their_leaf_tab_and_note(self):
        from app import workflows

        normalized = workflows.normalize({"id": "pacu_flow", "forms": [
            {"form_id": "pacu_record", "version": 1, "phase": "postop", "after_section": "pacu", "hint": "PACU nurse"},
            {"form_id": "survey", "version": 2}]})
        self.assertEqual(normalized["forms"][0] | {}, {"form_id": "pacu_record", "version": 1, "title": "", "phase": "postop", "required": False,
                                                       "after_section": "pacu", "hint": "PACU nurse", "display": "tab"})
        self.assertEqual((normalized["forms"][1]["after_section"], normalized["forms"][1]["hint"], normalized["forms"][1]["phase"]), (None, "", "any"))

    def test_a_form_can_be_printed_from_reports_only(self):
        from app import workflows

        normalized = workflows.normalize({"id": "w", "forms": [{"form_id": "f", "version": 1, "display": "report"}, {"form_id": "g", "version": 1}]})
        self.assertEqual([form["display"] for form in normalized["forms"]], ["report", "tab"])
        self.assertEqual(workflows.DISPLAYS, ("tab", "report"))

    def test_suggested_placement_is_checked(self):
        from app import workflows

        self.assertEqual(workflows.placement({"phase": "intraop", "after_section": "ga_ett"}), {"phase": "intraop", "after_section": "ga_ett"})
        self.assertEqual(workflows.placement({"phase": "intraop", "after_section": "nowhere"}), {"phase": "intraop", "after_section": None})
        self.assertIsNone(workflows.placement({"phase": "later"}))
        self.assertIsNone(workflows.placement(None))
        self.assertEqual(workflows.PLACEMENT_KEY, ai_builder.PLACEMENT_KEY)


if __name__ == "__main__":
    unittest.main()
