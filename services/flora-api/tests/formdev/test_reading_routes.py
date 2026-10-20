"""Reading and naming routes (/api/formdev/reading, /api/formdev/ids, /api/formdev/ai/jobs), called as functions:
documents read from an upload (sent once, as they are), what a document must be, jobs kept per author, events read in
steps, the draft of a scanned form, the variable-name standard, and the designer's AI job with a scripted model."""
import asyncio
import json
import os
import tempfile
import time
import unittest

os.environ.setdefault("FLORA_DATABASE_URL", "postgresql://unused@localhost/unused")
os.environ.setdefault("FLORA_API_MODE", "canopy")

from fastapi import HTTPException  # noqa: E402

from app.formdev import ai_builder, uploads  # noqa: E402
from app.formdev.errors import FormDevError  # noqa: E402
from app.formdev.reading import ocr  # noqa: E402
from app.routes import formdev_reading  # noqa: E402
from helpers import example  # noqa: E402

AUTHOR = {"username": "author"}
OTHER = {"username": "someone_else"}

try:
    import reading_samples

    reading_samples.form_image()
    FONTS = True
except (ImportError, IndexError, OSError):
    FONTS = False


class Body:
    """What the routes read from a request: its JSON body."""

    def __init__(self, value):
        self.value = json.dumps(value).encode()

    async def body(self):
        return self.value


def post(route, value, user=AUTHOR):
    return asyncio.run(route(Body(value), user))


def finished(job_id, user=AUTHOR, seconds=120):
    deadline = time.time() + seconds
    while time.time() < deadline:
        state = formdev_reading.reading_job(job_id, 0, user)
        if state["job"]["status"] not in ("queued", "running"):
            return state
        time.sleep(0.2)
    raise AssertionError("the job did not finish")


class Documents(unittest.TestCase):
    def setUp(self):
        self.folder = tempfile.TemporaryDirectory()
        self.saved = os.environ.get("FLORA_UPLOAD_DIR")
        os.environ["FLORA_UPLOAD_DIR"] = self.folder.name

    def tearDown(self):
        if self.saved is None:
            os.environ.pop("FLORA_UPLOAD_DIR", None)
        else:
            os.environ["FLORA_UPLOAD_DIR"] = self.saved
        self.folder.cleanup()

    def upload(self, name, content, user=AUTHOR):
        return uploads.keep(uploads.owner_of(user), name, content)["upload"]["id"]

    def test_only_pdf_png_or_jpeg_and_only_the_authors_uploads(self):
        for body, status in (({"upload": self.upload("a.gif", b"GIF89a....")}, 422), ({"upload": "not an id"}, 422), ({"upload": "0" * 64}, 404),
                             ({"upload": self.upload("mine.pdf", b"%PDF-1.4 x", OTHER)}, 404)):
            with self.assertRaises(FormDevError) as caught:
                formdev_reading.start_reading(body, AUTHOR)
            self.assertEqual(caught.exception.status, status, body)

    def test_a_job_belongs_to_its_author(self):
        job = formdev_reading.start_reading({"upload": self.upload("broken.pdf", b"%PDF-1.4 broken")}, AUTHOR)["job"]
        for route in (lambda user: formdev_reading.reading_job(job["id"], 0, user), lambda user: formdev_reading.reading_result(job["id"], user),
                      lambda user: formdev_reading.cancel_reading(job["id"], user)):
            with self.assertRaises(HTTPException) as caught:
                route(OTHER)
            self.assertEqual(caught.exception.status_code, 404)
        state = finished(job["id"])
        self.assertEqual(state["job"]["status"], "failed", "a PDF that cannot be opened fails the job, with the reason")
        self.assertEqual(state["events"][-1]["kind"], "failed")
        with self.assertRaises(HTTPException) as caught:
            formdev_reading.reading_result(job["id"], AUTHOR)
        self.assertEqual(caught.exception.status_code, 409)

    @unittest.skipUnless(FONTS and ocr.available(), "needs the OCR models and Noto fonts (the API image)")
    def test_a_scanned_form_becomes_a_draft_and_the_events_come_in_steps(self):
        upload = self.upload("assessment.pdf", reading_samples.as_pdf(reading_samples.form_image()))
        job = formdev_reading.start_reading({"upload": upload, "title": "แบบประเมิน"}, AUTHOR)["job"]
        seen, after = [], 0
        deadline = time.time() + 120
        while time.time() < deadline:
            state = formdev_reading.reading_job(job["id"], after, AUTHOR)
            self.assertEqual([event["seq"] for event in state["events"]], list(range(after + 1, state["next"] + 1)), "no event twice, none skipped")
            seen += [event["kind"] for event in state["events"]]
            after = state["next"]
            if state["job"]["status"] not in ("queued", "running"):
                break
            time.sleep(0.2)
        self.assertEqual(state["job"]["status"], "done")
        for kind in ("started", "page", "text_layer", "prepared", "ocr_started", "ocr_done", "lines", "layout", "plan", "draft", "done"):
            self.assertIn(kind, seen)
        self.assertNotIn("ai_started", seen, "no AI unless asked")
        result = formdev_reading.reading_result(job["id"], AUTHOR)
        keys = {field.get("key") or field["id"] for section in result["definition"]["sections"] for field in section["fields"]}
        self.assertTrue({"patient_weight_kg", "patient_height_cm"} <= keys, keys)
        self.assertEqual(result["definition"]["title"], "แบบประเมิน")


class Names(unittest.TestCase):
    def test_suggestions_follow_the_standard_and_never_repeat(self):
        out = formdev_reading.suggest_ids({"fields": [{"label": "น้ำหนัก (กก.)", "type": "decimal"}, {"label": "Date", "type": "date", "section": "Consent"},
                                                      {"label": "Date", "type": "date", "section": "Consent"}, "not a field"],
                                           "taken": ["consent_date"]}, AUTHOR)["suggestions"]
        self.assertEqual(out[0]["key"], "patient_weight_kg")
        self.assertEqual(out[0]["concept"], "patient.weight_kg", "bound to the case data it reads as")
        self.assertNotIn(out[1]["key"], ("consent_date",), "a taken name is not given again")
        self.assertNotEqual(out[1]["key"], out[2]["key"])
        self.assertIsNone(out[3])
        with self.assertRaises(FormDevError):
            formdev_reading.suggest_ids({"fields": "x"}, AUTHOR)

    def test_the_check_names_what_breaks_the_standard(self):
        definition = example(1)
        field = definition["sections"][0]["fields"][0]
        field["id"], field["key"] = "text_1", "text_1"
        problems = {(finding["id"], finding["problem"]) for finding in formdev_reading.check_ids({"definition": definition}, AUTHOR)["findings"]}
        self.assertIn(("text_1", "named_by_type"), problems)
        with self.assertRaises(FormDevError):
            formdev_reading.check_ids({"definition": []}, AUTHOR)


class AiJobs(unittest.TestCase):
    def setUp(self):
        self.saved = formdev_reading._ai_config, formdev_reading._validator, ai_builder.Conversation.ask
        formdev_reading._ai_config = lambda: {"api_format": "anthropic", "model": "claude-opus-5-5", "api_key": "test", "host": ""}
        formdev_reading._validator = lambda: (lambda definition: [])
        self.asked = []

        def ask(conversation):
            self.asked.append(conversation)
            conversation.usage["requests"] += 1
            return f"<form_json>{json.dumps(example(1))}</form_json><report>{json.dumps({'document_type': 'Assessment'})}</report>"

        ai_builder.Conversation.ask = ask

    def tearDown(self):
        formdev_reading._ai_config, formdev_reading._validator, ai_builder.Conversation.ask = self.saved

    def test_the_request_is_checked(self):
        for body in ({"mode": "rewrite", "instructions": "x"}, {"mode": "create", "instructions": " "}, {"mode": "create", "instructions": "x" * 4001},
                     {"mode": "revise", "instructions": "add a field"}):
            with self.assertRaises(FormDevError):
                post(formdev_reading.start_ai_job, body)

    def test_a_revise_job_runs_in_the_background_with_the_selected_fields(self):
        start = example(1)
        job = post(formdev_reading.start_ai_job, {"mode": "revise", "instructions": "เพิ่มช่องลายเซ็น", "definition": start, "focus": ["hn", 3]})["job"]
        self.assertEqual(job["options"]["mode"], "revise")
        state = finished(job["id"])
        self.assertEqual(state["job"]["status"], "done", state["job"]["error"])
        self.assertEqual([event["kind"] for event in state["events"]], ["ai_started", "ai_done", "draft", "done"])
        self.assertEqual(state["events"][0]["data"]["check"], ["hn"], "only field ids are passed on")
        self.assertEqual(state["job"]["usage"]["requests"], 1)
        result = formdev_reading.reading_result(job["id"], AUTHOR)
        self.assertEqual(result["definition"]["sections"], example(1)["sections"])
        self.assertEqual(len(self.asked), 1)


if __name__ == "__main__":
    unittest.main()
