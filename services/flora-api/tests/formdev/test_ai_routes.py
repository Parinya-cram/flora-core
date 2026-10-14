"""AI builder and template routes (/api/formdev/ai, /api/formdev/templates), called as functions on SQLite storage
with a scripted model: refusal of unusable documents, .form.json import without AI, an AI build kept as a draft
template with its source documents, review, and a form created from the template."""
import base64
import contextlib
import json
import os
import tempfile
import unittest

os.environ.setdefault("FLORA_DATABASE_URL", "postgresql://unused@localhost/unused")
os.environ.setdefault("FLORA_API_MODE", "canopy")

from app.formdev import ai_builder  # noqa: E402
from app.formdev.adapters.sqlite import SQLiteAdapter  # noqa: E402
from app.formdev.errors import FormDevError  # noqa: E402
from app.routes import formdev_ai  # noqa: E402
from helpers import example, ready_services  # noqa: E402

USER = {"username": "author"}
PDF = b"%PDF-1.7\n1 0 obj<</Type /Page /Resources<</Font<<>>>>>>endobj\n%%EOF\n"


def encoded(name, content):
    return {"name": name, "data": base64.b64encode(content).decode("ascii")}


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

    def tearDown(self):
        formdev_ai.checkout, formdev_ai.storage, formdev_ai._ai_config, ai_builder.Conversation.ask = self.saved
        self.fd.adapter.close()
        self.folder.cleanup()

    def answer_with(self, definition, report):
        def ask(conversation):
            conversation.usage["requests"] += 1
            return f"<form_json>{json.dumps(definition)}</form_json><report>{json.dumps(report)}</report>"

        ai_builder.Conversation.ask = ask

    def test_unusable_documents_stop_the_build(self):
        with self.assertRaises(FormDevError) as caught:
            formdev_ai.ai_generate(USER, {"files": [encoded("form.pdf", PDF), encoded("old.doc", b"\xd0\xcf\x11\xe0" + b"0" * 20)]})
        self.assertEqual(caught.exception.code, "invalid_documents")
        self.assertEqual(caught.exception.details["errors"], 1)
        self.assertEqual(self.fd.templates.list(), [])

    def test_a_form_json_file_is_imported_without_ai(self):
        self.config["model"] = ""  # no AI service needed
        result = formdev_ai.ai_generate(USER, {"files": [encoded("pa.form.json", json.dumps(example(1)).encode())], "title": "Imported"})
        template = result["template"]
        self.assertEqual((template["origin"], template["status"], template["title"], result["issues"]), ("import", "draft", "Imported", []))
        self.assertIsNone(template["report"])

    def test_an_ai_build_is_kept_with_its_sources_and_becomes_a_form(self):
        self.answer_with(example(1), {"document_type": "Assessment", "coverage": [{"source": "form.pdf p.1", "item": "HN", "field": "hn"}],
                                      "placement": {"phase": "postop", "after_section": "pacu"}})
        result = formdev_ai.ai_generate(USER, {"files": [encoded("form.pdf", PDF)], "instructions": "bilingual", "form_id": "pacu_record"})
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
            formdev_ai.ai_generate(USER, {"files": [encoded("form.pdf", PDF)]})
        self.assertEqual((caught.exception.code, caught.exception.status), ("ai_failed", 502))
        self.assertTrue(caught.exception.details["ok"])

    def test_openai_hosts_need_pdf_page_images(self):
        self.config["api_format"] = "openai"
        with self.assertRaises(FormDevError) as caught:
            formdev_ai.ai_generate(USER, {"files": [encoded("form.pdf", PDF)]})
        self.assertIn("images", caught.exception.details["files"][0]["notes"][-1])

    def test_inspect_validates_form_files(self):
        broken = example(1)
        broken["sections"][0]["fields"][0]["layout"] = {"span": 30}
        report = formdev_ai.ai_inspect(USER, {"files": [encoded("pa.form.json", json.dumps(broken).encode())]})
        self.assertEqual(report["files"][0]["issues"][0]["code"], "invalid_span")

    def test_request_options_are_checked(self):
        for body in ({"files": [encoded("a.pdf", PDF)], "form_id": "Bad Id"}, {"files": [encoded("a.pdf", PDF)], "instructions": "x" * 5000}):
            with self.assertRaises(FormDevError):
                formdev_ai.ai_generate(USER, body)


if __name__ == "__main__":
    unittest.main()
