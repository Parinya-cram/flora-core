"""AI builder and template routes (/api/formdev/ai, /api/formdev/templates), called as functions on SQLite storage
with a scripted model: documents uploaded once as they are (/api/formdev/uploads) and built from by id, refusal of
unusable documents, .form.json import without AI, PDF pages rendered on the server for OpenAI-compatible hosts, an AI
build kept as a draft template with its source documents, review, and a form created from the template."""
import asyncio
import contextlib
import io
import json
import os
import tempfile
import unittest

os.environ.setdefault("FLORA_DATABASE_URL", "postgresql://unused@localhost/unused")
os.environ.setdefault("FLORA_API_MODE", "canopy")

from app.formdev import ai_builder, uploads  # noqa: E402
from app.formdev.adapters.sqlite import SQLiteAdapter  # noqa: E402
from app.formdev.errors import FormDevError  # noqa: E402
from app.routes import formdev_ai, formdev_reading  # noqa: E402
from app.formdev.reading import ocr  # noqa: E402
from helpers import example, ready_services  # noqa: E402

HAS_OCR = ocr.available() and bool(__import__("glob").glob("/usr/share/fonts/truetype/noto/NotoSansThai-Regular.ttf"))

USER = {"username": "author"}
PDF = b"%PDF-1.7\n1 0 obj<</Type /Page /Resources<</Font<<>>>>>>endobj\n%%EOF\n"


def scanned_pdf():
    """A real one-page PDF (a picture of a page), as a scanner makes it."""
    from PIL import Image

    out = io.BytesIO()
    Image.new("RGB", (400, 566), "white").save(out, format="PDF", resolution=72)
    return out.getvalue()


class Routes(unittest.TestCase):
    def setUp(self):
        self.folder = tempfile.TemporaryDirectory()
        self.fd = ready_services(SQLiteAdapter(f"{self.folder.name}/formdev.db"))
        self.config = {"api_format": "anthropic", "model": "claude-opus-5-5", "api_key": "test", "host": ""}
        self.saved = formdev_ai.checkout, formdev_ai.storage, formdev_ai._ai_config, ai_builder.Conversation.ask
        formdev_ai.checkout = contextlib.nullcontext

        @contextlib.contextmanager
        def storage(_connection):
            yield self.fd

        formdev_ai.storage = storage
        formdev_ai._ai_config = lambda: self.config
        self.saved_dir = os.environ.get("FLORA_UPLOAD_DIR")
        os.environ["FLORA_UPLOAD_DIR"] = f"{self.folder.name}/uploads"

    def tearDown(self):
        formdev_ai.checkout, formdev_ai.storage, formdev_ai._ai_config, ai_builder.Conversation.ask = self.saved
        if self.saved_dir is None:
            os.environ.pop("FLORA_UPLOAD_DIR", None)
        else:
            os.environ["FLORA_UPLOAD_DIR"] = self.saved_dir
        self.fd.adapter.close()
        self.folder.cleanup()

    def upload(self, name, content):
        return uploads.keep(uploads.owner_of(USER), name, content)["upload"]["id"]

    def answer_with(self, definition, report):
        def ask(conversation):
            conversation.usage["requests"] += 1
            return f"<form_json>{json.dumps(definition)}</form_json><report>{json.dumps(report)}</report>"

        ai_builder.Conversation.ask = ask

    def test_unusable_documents_stop_the_build(self):
        with self.assertRaises(FormDevError) as caught:
            formdev_ai.ai_generate(USER, {"uploads": [self.upload("form.pdf", PDF), self.upload("old.doc", b"\xd0\xcf\x11\xe0" + b"0" * 20)]})
        self.assertEqual(caught.exception.code, "invalid_documents")
        self.assertEqual(caught.exception.details["errors"], 1)
        self.assertEqual(self.fd.templates.list(), [])

    def test_a_form_json_file_is_imported_without_ai(self):
        self.config["model"] = ""  # no AI service needed
        result = formdev_ai.ai_generate(USER, {"uploads": [self.upload("pa.form.json", json.dumps(example(1)).encode())], "title": "Imported"})
        template = result["template"]
        self.assertEqual((template["origin"], template["status"], template["title"], result["issues"]), ("import", "draft", "Imported", []))
        self.assertIsNone(template["report"])

    def test_an_ai_build_is_kept_with_its_sources_and_becomes_a_form(self):
        self.answer_with(example(1), {"document_type": "Assessment", "coverage": [{"source": "form.pdf p.1", "item": "HN", "field": "hn"}],
                                      "placement": {"phase": "postop", "after_section": "pacu"}})
        result = formdev_ai.ai_generate(USER, {"uploads": [self.upload("form.pdf", PDF)], "instructions": "bilingual", "form_id": "pacu_record"})
        template = result["template"]
        self.assertEqual((template["template_id"], template["origin"]), ("pacu_record", "ai"))
        self.assertEqual(template["report"]["instructions"], "bilingual")
        self.assertEqual(template["definition"]["extensions"]["flora.leaf_placement"], {"phase": "postop", "after_section": "pacu"})
        self.assertEqual(result["issues"], [])
        source = template["sources"][0]
        response = formdev_ai.template_source("pacu_record", source["sha256"], USER, self.fd)
        self.assertEqual((response.body, response.media_type), (PDF, "application/pdf"))
        with self.assertRaises(FormDevError):
            formdev_ai.template_source("pacu_record", "0" * 64, USER, self.fd)

        reviewed = formdev_ai.update_template("pacu_record", USER, {"version": 1, "status": "reviewed"}, self.fd)
        self.assertEqual(reviewed["template"]["status"], "reviewed")
        made = formdev_ai.form_from_template("pacu_record", USER, {"form_id": "pacu_form", "title": "PACU"}, self.fd)
        self.assertEqual(made["form_id"], "pacu_form")
        self.assertEqual(self.fd.forms.get("pacu_form")["title"], "PACU")
        self.assertEqual(self.fd.schemas.get_version("pacu_form", 1)["definition"]["extensions"]["flora.leaf_placement"]["after_section"], "pacu")

    def test_ai_failures_are_reported_with_the_inspection(self):
        def ask(conversation):
            raise ai_builder.BuildError("Cannot reach the AI service.")

        ai_builder.Conversation.ask = ask
        with self.assertRaises(FormDevError) as caught:
            formdev_ai.ai_generate(USER, {"uploads": [self.upload("form.pdf", PDF)]})
        self.assertEqual((caught.exception.code, caught.exception.status), ("ai_failed", 502))
        self.assertTrue(caught.exception.details["ok"])

    def test_openai_hosts_get_pdf_pages_rendered_by_the_server(self):
        self.config.update(api_format="openai", host="https://ai.example")
        sent = []

        def ask(conversation):
            sent.append(conversation.messages[0]["content"])
            conversation.usage["requests"] += 1
            return f"<form_json>{json.dumps(example(1))}</form_json><report>{{}}</report>"

        ai_builder.Conversation.ask = ask
        formdev_ai.ai_generate(USER, {"uploads": [self.upload("digital.pdf", scanned_pdf())], "instructions": "x"})
        images = [block for block in sent[0] if block["type"] == "image_url"]
        self.assertEqual(len(images), 1, "the page, rendered here: the browser sends only the file")

    @unittest.skipUnless(HAS_OCR, "needs the OCR models and Noto fonts (the API image)")
    def test_a_scan_is_measured_first_and_the_form_keeps_its_paper(self):
        from reading_samples import as_pdf, ruled_form_image

        sent = []

        def ask(conversation):
            sent.append(conversation.messages[0]["content"])
            conversation.usage["requests"] += 1
            start = json.loads(sent[0][-1]["text"].split("print_style) are measured from the paper ---\n", 1)[1].split("\nLook at the pages", 1)[0])
            return f"<form_json>{json.dumps(start)}</form_json><report>{{}}</report>"  # the draft as it came

        ai_builder.Conversation.ask = ask
        result = formdev_ai.ai_generate(USER, {"uploads": [self.upload("record.pdf", as_pdf(ruled_form_image()))], "form_id": "nursing_record"})
        self.assertIn("measured from the paper", sent[0][-1]["text"])
        definition = result["template"]["definition"]
        self.assertIn("margin_mm", definition["paper"])
        self.assertTrue(all(section.get("print_style") == "boxed" for section in definition["sections"]))
        self.assertTrue(any(field["type"] == "matrix" for section in definition["sections"] for field in section["fields"]))
        self.assertEqual(result["issues"], [])

    def test_a_duplicate_file_is_not_sent_twice(self):
        sent = []

        def ask(conversation):
            sent.append(conversation.messages[0]["content"])
            conversation.usage["requests"] += 1
            return f"<form_json>{json.dumps(example(1))}</form_json><report>{{}}</report>"

        ai_builder.Conversation.ask = ask
        same = self.upload("form.pdf", PDF)
        self.assertEqual(self.upload("copy.pdf", PDF), same, "the same bytes are kept once")
        result = formdev_ai.ai_generate(USER, {"uploads": [same, same]})
        self.assertEqual(sum(block["type"] == "document" for block in sent[0]), 1)
        self.assertEqual(len(result["template"]["sources"]), 2, "both names are listed in the inspection")

    def test_an_upload_is_the_file_itself_and_is_checked_when_it_arrives(self):
        broken = example(1)
        broken["sections"][0]["fields"][0]["layout"] = {"span": 30}
        body = json.dumps(broken).encode()

        class Request:  # what the route reads: the body in chunks, as it arrives
            headers = {"content-length": str(len(body))}

            async def stream(self):
                for start in range(0, len(body), 1000):
                    yield body[start:start + 1000]

        received = asyncio.run(formdev_reading.upload_file(Request(), "pa.form.json", USER))
        self.assertEqual((received["upload"]["kind"], received["file"]["kind"]), ("form_json", "form_json"))
        self.assertEqual(received["file"]["issues"][0]["code"], "invalid_span")
        self.assertEqual(uploads.get(uploads.owner_of(USER), received["upload"]["id"])[1], body)
        with self.assertRaises(Exception):
            uploads.get("someone_else", received["upload"]["id"])
        formdev_reading.remove_upload(received["upload"]["id"], USER)
        with self.assertRaises(Exception):
            uploads.get(uploads.owner_of(USER), received["upload"]["id"])

    def test_request_options_are_checked(self):
        for body in ({"uploads": [self.upload("a.pdf", PDF)], "form_id": "Bad Id"}, {"uploads": [self.upload("a.pdf", PDF)], "instructions": "x" * 5000},
                     {"uploads": "not a list"}, {"uploads": ["0" * 64]}):
            with self.assertRaises(FormDevError):
                formdev_ai.ai_generate(USER, body)


if __name__ == "__main__":
    unittest.main()
