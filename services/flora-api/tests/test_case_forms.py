"""Workflow forms between Flora Leaf and Canopy (app/case_forms.py), against a disposable PostgreSQL database.

Leaf and Canopy share the one test database, as on the dev stack: the Leaf's routes and outbox/inbox, the sync API's
exchange and Form Studio's sync are called as functions. Run with scripts/test-leaf-writes.sh (or FLORA_DATABASE_URL
pointing to a database ending in _test with every migration applied).
"""
import base64
import os
import secrets
import time
import unittest
import uuid
from urllib.parse import urlparse

URL = os.environ.get("FLORA_DATABASE_URL", "")
if not urlparse(URL).path.endswith("_test"):
    raise unittest.SkipTest("case form tests need a dedicated database ending in _test")
os.environ.setdefault("FLORA_API_MODE", "leaf")

import psycopg  # noqa: E402
from psycopg.rows import dict_row  # noqa: E402
from psycopg.types.json import Jsonb  # noqa: E402

from app import case_forms, case_handover  # noqa: E402
from app.formdev.adapters.postgres import PostgreSQLAdapter  # noqa: E402
from app.formdev.errors import FormDevError  # noqa: E402
from app.routes import case_workflow  # noqa: E402

FORM = "patient_assessment"
FILES = "case_files_test"
FILES_FORM = {"format": "flora.form/1", "form_id": FILES, "schema_version": 1, "title": "Files", "paper": "A4",
              "style_id": "form.a4.medical", "sections": [{"id": "main", "title": "Main", "fields": [
                  {"id": "hn", "type": "text", "label": "HN"}, {"id": "photo", "type": "file", "label": "Photo"},
                  {"id": "nurse_sign", "type": "signature", "label": "Nurse"}]}]}
LEAF, HOSPITAL = "leaf-test-01", "hospital-test"
NURSE = {"username": "nurse_a", "role": "nurse"}
EXAMPLES = os.path.join(os.path.dirname(__file__), "..", "..", "..", "formdev")
os.environ.setdefault("FORMDEV_ROOT", os.path.abspath(EXAMPLES))

from tests.formdev.helpers import example, seed_registry  # noqa: E402


def now() -> int:
    return time.time_ns() // 1_000_000


class Counting:
    """A connection that records the statements run through it (to show a read does not run one query per item)."""

    def __init__(self, database):
        self._database, self.statements = database, []

    def execute(self, sql, *args, **kwargs):
        self.statements.append(str(sql))
        return self._database.execute(sql, *args, **kwargs)

    def __getattr__(self, name):
        return getattr(self._database, name)


class CaseForms(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.db = psycopg.connect(URL, autocommit=True, row_factory=dict_row)
        services = case_forms.formdev_services(cls.db)
        if services.adapter.get_form(FORM) is None:
            try:
                seed_registry(services)
            except FormDevError:
                pass  # the registry migrations seeded it already
            services.schemas.create_form(example(1), "tester")
            services.schemas.publish(FORM, 1, "tester")
        if services.adapter.get_form(FILES) is None:
            services.schemas.create_form(FILES_FORM, "tester")
            services.schemas.publish(FILES, 1, "tester")
        cls.definition = services.schemas.get_version(FORM, 1)["definition"]
        files = services.schemas.get_version(FILES, 1)["definition"]
        cls.entry = {"form_id": FORM, "version": 1, "title": "Assessment", "display": "tab"}
        cls.workflow = {"id": "wf_case_forms_test", "name": "Case forms test", "format": "flora-workflow/1",
                        "anesthesia_record": {"enabled": True, "sections": [], "optional_sections": []},
                        "forms": [cls.entry, {"form_id": FILES, "version": 1, "title": "Files", "display": "tab"}], "packet": [],
                        "bundled_forms": {FORM: {"version": 1, "definition": cls.definition}, FILES: {"version": 1, "definition": files}}}

    @classmethod
    def tearDownClass(cls):
        cls.db.close()

    # ------------------------------------------------------------ helpers

    def new_case(self, workflow=True, admission=None, hn=None):
        hn = hn or f"T{secrets.token_hex(4)}"
        at = now()
        return self.db.execute(
            """INSERT INTO cases (case_code, hn, start_time, status, created_at, updated_at, workflow, canopy_admission_id)
               VALUES (%s,%s,%s,'discharged',%s,%s,%s,%s) RETURNING id""",
            (f"{hn}_T", hn, at, at, at, Jsonb(self.workflow) if workflow else None, admission)).fetchone()["id"]

    def patch(self, case_id, patch, status=None, actor=NURSE, form_id=FORM):
        return case_workflow.patch_workflow_form(case_id, form_id, case_workflow.FormPatch(patch=patch, status=status), actor, self.db)

    def cycle(self, acks=None):
        """One sync worker cycle: outbox → exchange → inbox. Returns (exchange response, inbox result)."""
        outbox = case_forms.leaf_outbox(self.db, now())
        response = case_forms.exchange(self.db, LEAF, HOSPITAL, {**outbox, "acks": acks or []}, now())
        result = case_forms.leaf_inbox(self.db, {"receipts": response["receipts"], "inbound": response["inbound"]}, now())
        return response, result

    def leaf_row(self, case_id):
        return self.db.execute("SELECT * FROM case_form_record WHERE case_id=%s AND form_id=%s", (case_id, FORM)).fetchone()

    def canopy_row(self, case_id):
        return self.db.execute("SELECT * FROM canopy_case_form WHERE case_key=%s AND form_id=%s",
                               (case_forms.global_case_id(HOSPITAL, LEAF, case_id), FORM)).fetchone()

    def record(self, record_id):
        return case_forms.formdev_services(self.db).records.get_raw(record_id)

    def amend(self, record_id, data, reason, base_version=None):
        services = case_forms.formdev_services(self.db)
        current = services.records.get_raw(record_id)
        op = {"op_id": secrets.token_hex(8), "kind": "update", "record_id": record_id, "form_id": FORM, "schema_version": 1,
              "base_version": base_version or current["version"], "data": data, "status": current["status"],
              "client_updated_at": now(), **({"reason": reason} if reason else {})}
        return services.sync.apply([op], "canopy_reviewer", linked=case_forms.amender(self.db))[0]

    # ------------------------------------------------------------ no N+1 queries

    def test_the_sync_reads_take_the_same_number_of_queries_however_many_cases(self):
        def statements(function, *args):
            counting = Counting(self.db)
            function(counting, *args)
            return counting.statements

        for _ in range(4):
            self.patch(self.new_case(), {"hn": "HN1"})
        outbox = case_forms.leaf_outbox(self.db, now())
        self.assertGreaterEqual(len(outbox["cases"]), 4)
        one, many = outbox["cases"][:1], outbox["cases"][:4]
        self.assertEqual(len(statements(case_forms.leaf_outbox, now())), 2, "the cases, then every case's forms at once")
        self.assertEqual(len(statements(case_forms.inbound, LEAF, HOSPITAL, one)), len(statements(case_forms.inbound, LEAF, HOSPITAL, many)))

    def test_a_case_with_several_forms_reads_the_ward_workflows_once(self):
        case_id = self.new_case()
        self.db.execute(
            """INSERT INTO leaf_workflow_state (id, version, payload, synced_at) VALUES (1, 1, %s, %s)
               ON CONFLICT (id) DO UPDATE SET payload = excluded.payload""",
            (Jsonb({"items": [], "forms": {f"{FORM}@1": self.definition}}), now()))
        for route in (case_workflow.case_workflow, case_workflow.report_templates):
            counting = Counting(self.db)
            route(case_id, {}, counting)
            reads = [sql for sql in counting.statements if "leaf_workflow_state" in sql]
            self.assertEqual(len(reads), 1, f"{route.__name__}: not once per form")

    # ------------------------------------------------------------ Leaf → Canopy

    def test_a_leaf_form_reaches_form_studio_with_a_receipt(self):
        case_id = self.new_case()
        saved = self.patch(case_id, {"hn": "HN1", "full_name": "Ann"})
        self.assertEqual(saved["record"]["authors"]["hn"]["by"], "nurse_a")
        response, _ = self.cycle()
        receipt = next(r for r in response["receipts"] if r["case_id"] == case_id)
        self.assertEqual(receipt["state"], "stored")
        record = self.record(receipt["record_id"])
        self.assertEqual((record["status"], record["data"]["full_name"], record["updated_by"]), ("draft", "Ann", f"nurse_a@{LEAF}"))
        row = self.leaf_row(case_id)
        self.assertEqual((row["sync_state"], row["canopy_record_id"]), ("stored", receipt["record_id"]))
        self.assertTrue(case_workflow.public_record(row)["sync"]["current"])
        outbox = case_forms.leaf_outbox(self.db, now())
        self.assertFalse([form for form in outbox["forms"] if form["case_id"] == case_id], "an acknowledged form is not sent again")

    def test_completing_checks_form_studio_rules_on_the_leaf(self):
        case_id = self.new_case()
        refused = self.patch(case_id, {"hn": "HN2"}, status="completed")
        self.assertEqual(refused.status_code, 422)
        self.assertIsNone(self.leaf_row(case_id), "nothing is saved when completion is refused")
        done = self.patch(case_id, {"hn": "HN2", "full_name": "Ben", "assessed_at": "2026-10-16T08:00:00+07:00"}, status="completed")
        self.assertEqual(done["record"]["status"], "completed")
        response, _ = self.cycle()
        receipt = next(r for r in response["receipts"] if r["case_id"] == case_id)
        self.assertEqual((receipt["state"], self.record(receipt["record_id"])["status"]), ("stored", "submitted"))

    def test_a_completed_form_changes_on_the_leaf_only_with_a_reason(self):
        case_id = self.new_case()
        self.patch(case_id, {"hn": "HN12", "full_name": "Hal", "assessed_at": "2026-10-16T08:00:00+07:00"}, status="completed")
        refused = case_workflow.patch_workflow_form(case_id, FORM, case_workflow.FormPatch(patch={"full_name": "Hall"}), NURSE, self.db)
        self.assertEqual(refused.status_code, 422)
        self.assertEqual(self.leaf_row(case_id)["data"]["full_name"], "Hal")
        unchanged = self.patch(case_id, {"full_name": "Hal"})  # saving the same value is not a change
        self.assertEqual(unchanged["record"]["status"], "completed")
        amended = case_workflow.patch_workflow_form(
            case_id, FORM, case_workflow.FormPatch(patch={"full_name": "Hall"}, reason="Spelling per ID card"), NURSE, self.db)
        self.assertEqual(amended["record"]["status"], "completed")
        self.assertEqual(amended["record"]["authors"]["full_name"]["reason"], "Spelling per ID card")
        reopen = case_workflow.patch_workflow_form(case_id, FORM, case_workflow.FormPatch(patch={}, status="draft"), NURSE, self.db)
        self.assertEqual(reopen.status_code, 422, "reopening a completed form is an amendment too")
        audit = self.db.execute("SELECT after_json FROM case_clinical_audit WHERE case_id=%s AND action=%s",
                                (case_id, f"workflow_form.amend:{FORM}")).fetchone()
        self.assertIn("Spelling per ID card", str(audit["after_json"]))

    def test_a_signature_is_signed_with_the_signers_pin_and_then_locked(self):
        from app import directory
        from fastapi import HTTPException

        user = self.db.execute("""INSERT INTO auth_user (username, name, role, is_active, created_at, updated_at)
                                  VALUES (%s, 'Nurse Sign', 'clinician', 1, 1, 1) RETURNING id""",
                               (f"signer_{secrets.token_hex(3)}",)).fetchone()["id"]
        signer = {"id": user, "username": self.db.execute("SELECT username FROM auth_user WHERE id=%s", (user,)).fetchone()["username"],
                  "name": "Nurse Sign", "role": "clinician"}
        case_id = self.new_case()
        PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="
        SVG = "data:image/svg+xml;base64," + base64.b64encode(b"<svg xmlns='http://www.w3.org/2000/svg'><path d='M0 0L9 9'/></svg>").decode()
        sign = lambda pin, reason=None, data=PNG: case_workflow.sign_workflow_form(  # noqa: E731
            case_id, FILES, case_workflow.SignPayload(field="nurse_sign", data=data, pin=pin, reason=reason), signer, self.db)
        with self.assertRaises(HTTPException) as no_pin:
            sign("1234")
        self.assertEqual(no_pin.exception.status_code, 409, "a signing PIN must be set first")
        directory.set_sign_pin(self.db, user, "2468")
        with self.assertRaises(HTTPException) as wrong:
            sign("1111")
        self.assertEqual(wrong.exception.status_code, 403)
        signed = sign("2468")["record"]["data"]["nurse_sign"]
        self.assertEqual((signed["verified"], signed["signer"], signed["signer_name"]), ("pin", signer["username"], "Nurse Sign"))
        forged = case_workflow.patch_workflow_form(case_id, FILES, case_workflow.FormPatch(
            patch={"nurse_sign": {**signed, "signer": "someone_else"}}), NURSE, self.db)
        self.assertEqual(forged.status_code, 422, "a confirmed signature is made only by signing")
        cleared = case_workflow.patch_workflow_form(case_id, FILES, case_workflow.FormPatch(patch={"nurse_sign": None}), NURSE, self.db)
        self.assertEqual(cleared.status_code, 422, "removing a confirmed signature is an amendment")
        resigned = sign("2468", "Signed in the wrong box", SVG)["record"]["authors"]["nurse_sign"]
        self.assertEqual(resigned["reason"], "Signed in the wrong box")
        record = directory.record(self.db, self.db.execute("SELECT * FROM auth_user WHERE id=%s", (user,)).fetchone())
        self.assertTrue(record["sign_pin_hash"], "the signing PIN travels with the user directory")
        self.cycle()
        record_id = self.db.execute("SELECT record_id FROM canopy_case_form WHERE form_id=%s AND source_case_id=%s",
                                    (FILES, str(case_id))).fetchone()["record_id"]
        services = case_forms.formdev_services(self.db)
        current = services.records.get_raw(record_id)
        op = {"op_id": secrets.token_hex(8), "kind": "update", "record_id": record_id, "base_version": current["version"],
              "data": {**current["data"], "nurse_sign": None}, "status": current["status"], "client_updated_at": now(), "reason": "Wrong person"}
        ack = services.sync.apply([op], "canopy_reviewer", linked=case_forms.amender(self.db))[0]
        self.assertEqual((ack["status"], ack["error"]["code"]), ("rejected", "signature_locked"))
        for _ in range(4):
            with self.assertRaises(HTTPException):
                sign("0000")
        with self.assertRaises(HTTPException):
            sign("0000")
        with self.assertRaises(HTTPException) as locked:
            sign("2468", "x" * 5)
        self.assertEqual(locked.exception.status_code, 429, "five wrong PINs lock signing for a while")
        case_workflow.SIGN_ATTEMPTS.clear()

    def test_review_then_approve_holds_only_for_the_copy_reviewed(self):
        case_id = self.new_case()
        self.patch(case_id, {"hn": "HN13", "full_name": "Ida"})
        self.cycle()
        key = case_forms.global_case_id(HOSPITAL, LEAF, case_id)
        with self.assertRaises(FormDevError):  # still a draft on the Leaf
            case_forms.review(self.db, key, FORM, "reviewed", "reviewer", None, now())
        self.patch(case_id, {"assessed_at": "2026-10-16T08:00:00+07:00"}, status="completed")
        self.cycle()
        with self.assertRaises(FormDevError):  # not reviewed yet
            case_forms.review(self.db, key, FORM, "approved", "approver", None, now())
        row = case_forms.review(self.db, key, FORM, "reviewed", "reviewer", "checked against the chart", now())
        self.assertEqual(case_forms.review_status(row)["state"], "reviewed")
        row = case_forms.review(self.db, key, FORM, "approved", "approver", None, now())
        self.assertEqual(case_forms.review_status(row), {**case_forms.review_status(row), "state": "approved", "approvedBy": "approver"})
        case_workflow.patch_workflow_form(case_id, FORM, case_workflow.FormPatch(patch={"full_name": "Ida K"}, reason="Surname added"), NURSE, self.db)
        self.cycle()
        self.assertEqual(case_forms.review_status(self.canopy_row(case_id))["state"], "changed_since_review")
        kinds = [item["kind"] for item in case_forms.history(self.db, self.canopy_row(case_id))]
        self.assertIn("approved", kinds)
        self.assertIn("reviewed", kinds)
        self.assertGreaterEqual(kinds.count("version"), 2)
        versions = [item for item in case_forms.history(self.db, self.canopy_row(case_id)) if item["kind"] == "version"]
        self.assertEqual(versions[0]["changes"]["full_name"], {"from": "Ida", "to": "Ida K"})

    def test_a_completed_form_form_studio_refuses_is_kept_as_draft_and_the_leaf_is_told(self):
        case_id = self.new_case()
        # As a Leaf without the server check would send it: completed but a required field missing.
        self.db.execute(
            """INSERT INTO case_form_record (case_id, form_id, form_version, data, field_versions, status, updated_at, updated_by)
               VALUES (%s,%s,1,%s,%s,'completed',%s,'old_leaf')""", (case_id, FORM, Jsonb({"hn": "HN3"}), Jsonb({"hn": 1}), now()))
        response, _ = self.cycle()
        receipt = next(r for r in response["receipts"] if r["case_id"] == case_id)
        self.assertEqual(receipt["state"], "kept_as_draft")
        self.assertTrue(receipt["issues"])
        self.assertEqual(self.record(receipt["record_id"])["status"], "draft")
        row = self.leaf_row(case_id)
        self.assertEqual(row["sync_state"], "kept_as_draft")
        self.assertTrue(row["sync_issues"])

    def test_files_go_up_when_canopy_asks_for_them(self):
        case_id = self.new_case()
        content = secrets.token_bytes(32)
        import hashlib
        sha = hashlib.sha256(content).hexdigest()
        self.patch(case_id, {"hn": "HN4", "photo": {"name": "a.bin", "mime": "application/octet-stream", "size": 32, "ref": f"att:{sha}"}},
                   form_id=FILES)
        response, _ = self.cycle()
        receipt = next(r for r in response["receipts"] if r["case_id"] == case_id and r["form_id"] == FILES)
        self.assertEqual(receipt["state"], "waiting_files")
        self.assertIn(sha, response["need_files"])
        # The worker uploads it (Leaf and Canopy share the store in this test database).
        case_forms.formdev_services(self.db).records.attachments.put(sha, "application/octet-stream", content, "leaf")
        response, _ = self.cycle()
        receipt = next(r for r in response["receipts"] if r["case_id"] == case_id and r["form_id"] == FILES)
        self.assertEqual(receipt["state"], "stored")
        row = self.db.execute("SELECT * FROM case_form_record WHERE case_id=%s AND form_id=%s", (case_id, FILES)).fetchone()
        self.assertEqual(row["sync_state"], "stored")

    # ------------------------------------------------------------ Canopy → Leaf

    def test_a_canopy_change_is_an_amendment_with_a_reason_and_reaches_the_leaf(self):
        case_id = self.new_case()
        self.patch(case_id, {"hn": "HN5", "full_name": "Cara"})
        response, _ = self.cycle()
        record_id = next(r for r in response["receipts"] if r["case_id"] == case_id)["record_id"]
        record = self.record(record_id)

        refused = self.amend(record_id, {**record["data"], "full_name": "Carla"}, None)
        self.assertEqual((refused["status"], refused["error"]["code"]), ("rejected", "amendment_reason_required"))
        applied = self.amend(record_id, {**self.record(record_id)["data"], "full_name": "Carla"}, "Name misspelt on the ward sheet")
        self.assertEqual(applied["status"], "applied")
        self.assertEqual(self.record(record_id)["data"]["full_name"], "Carla")
        amendment = self.db.execute("SELECT * FROM canopy_case_form_amendment WHERE record_id=%s", (record_id,)).fetchone()
        self.assertEqual((amendment["changes"]["full_name"], amendment["amended_by"]), ({"from": "Cara", "to": "Carla"}, "canopy_reviewer"))

        response, result = self.cycle()
        self.assertTrue([item for item in response["inbound"] if item["case_id"] == case_id])
        row = self.leaf_row(case_id)
        self.assertEqual(row["data"]["full_name"], "Carla")
        self.assertEqual((row["field_authors"]["full_name"]["via"], row["field_authors"]["full_name"]["reason"]),
                         ("canopy", "Name misspelt on the ward sheet"))
        self.assertEqual(row["data"]["hn"], "HN5", "fields not amended stay as the Leaf had them")
        response, _ = self.cycle(result["acks"])
        self.assertFalse([item for item in response["inbound"] if item["case_id"] == case_id], "confirmed changes are not sent again")
        self.assertEqual(self.canopy_row(case_id)["leaf_state"], "applied")

    def test_an_amendment_on_an_older_copy_does_not_put_older_values_back(self):
        case_id = self.new_case()
        self.patch(case_id, {"hn": "HN6", "full_name": "Dan"})
        response, _ = self.cycle()
        record_id = next(r for r in response["receipts"] if r["case_id"] == case_id)["record_id"]
        old = self.record(record_id)
        self.patch(case_id, {"full_name": "Daniel"})  # the bedside changes the name meanwhile
        self.cycle()
        self.amend(record_id, {**old["data"], "hn": "HN6-A"}, "HN corrected from the ID card", base_version=old["version"])
        copy = self.canopy_row(case_id)["data"]
        self.assertEqual((copy["hn"], copy["full_name"]), ("HN6-A", "Daniel"))

    def test_both_sides_change_different_fields(self):
        case_id = self.new_case()
        self.patch(case_id, {"hn": "HN7", "full_name": "Eve"})
        response, _ = self.cycle()
        record_id = next(r for r in response["receipts"] if r["case_id"] == case_id)["record_id"]
        self.amend(record_id, {**self.record(record_id)["data"], "full_name": "Eva"}, "Spelling per HIS")
        self.patch(case_id, {"assessed_at": "2026-10-16T09:00:00+07:00"})  # before the Leaf has heard of the amendment
        self.cycle()
        row = self.leaf_row(case_id)
        self.assertEqual((row["data"]["full_name"], row["data"]["assessed_at"]), ("Eva", "2026-10-16T09:00:00+07:00"))
        self.assertEqual(self.canopy_row(case_id)["data"]["assessed_at"], "2026-10-16T09:00:00+07:00")

    def test_canopy_cannot_complete_or_delete_a_leaf_form(self):
        case_id = self.new_case()
        self.patch(case_id, {"hn": "HN8"})
        response, _ = self.cycle()
        record_id = next(r for r in response["receipts"] if r["case_id"] == case_id)["record_id"]
        services = case_forms.formdev_services(self.db)
        current = services.records.get_raw(record_id)
        op = {"op_id": secrets.token_hex(8), "kind": "delete", "record_id": record_id, "base_version": current["version"],
              "client_updated_at": now()}
        ack = services.sync.apply([op], "canopy_reviewer", linked=case_forms.amender(self.db))[0]
        self.assertEqual((ack["status"], ack["error"]["code"]), ("rejected", "leaf_form"))

    # ------------------------------------------------------------ admission, open case, handover

    def test_a_form_filled_for_the_admission_continues_on_the_leaf(self):
        admission = self.db.execute(
            """INSERT INTO canopy_admission (id, unit_key, hn, patient, admission, status, created_at, updated_at)
               VALUES (%s, 'ward-t', 'HN9', '{}', %s, 'pending', 1, 1) RETURNING *""",
            (uuid.uuid4(), Jsonb({"workflow_id": "wf_case_forms_test"}))).fetchone()
        filled = case_forms.patch_admission_form(self.db, admission, FORM, 1, {"full_name": "Fay"}, "ward_nurse", now())
        self.assertTrue(filled["caseKey"].startswith("admission:"))
        case_id = self.new_case(admission=admission["id"], hn="HN9")
        response, _ = self.cycle()
        self.assertTrue([item for item in response["inbound"] if item["case_id"] == case_id])
        self.assertEqual(self.leaf_row(case_id)["data"]["full_name"], "Fay")
        self.assertEqual(self.canopy_row(case_id)["admission_id"], admission["id"])
        # The bedside continues; changing what the bedside filled from Canopy afterwards needs a reason.
        self.patch(case_id, {"hn": "HN9"})
        self.cycle()
        with self.assertRaises(FormDevError):
            case_forms.patch_admission_form(self.db, admission, FORM, 1, {"hn": "HN9-X"}, "ward_nurse", now())
        case_forms.patch_admission_form(self.db, admission, FORM, 1, {"hn": "HN9-X"}, "ward_nurse", now(), "Wrong HN label")
        self.cycle()
        self.assertEqual(self.leaf_row(case_id)["data"]["hn"], "HN9-X")

    def test_a_form_the_case_workflow_does_not_list_is_not_forced_onto_the_leaf(self):
        case_id = self.new_case(workflow=False)
        case_key = case_forms.global_case_id(HOSPITAL, LEAF, case_id)
        case_forms._save(self.db, case_key, FORM, case_forms.copy_of({"hn": "X"}, {"hn": now()}, {}, "draft"), now(),
                         form_version=1, canopy_rev=now(), leaf_id=LEAF, source_case_id=str(case_id))
        inbound = case_forms.inbound(self.db, LEAF, HOSPITAL, [{"case_id": case_id, "wants": [], "have": []}])
        result = case_forms.leaf_inbox(self.db, {"inbound": inbound}, now())
        self.assertEqual(result["acks"][0]["state"], "not_in_workflow")
        self.assertIsNone(self.leaf_row(case_id))

    def test_a_workflow_can_be_attached_to_an_open_case_and_filled_forms_keep_their_version(self):
        self.db.execute(
            """INSERT INTO leaf_workflow_state (id, version, payload, synced_at) VALUES (1, 1, %s, 1)
               ON CONFLICT (id) DO UPDATE SET payload=excluded.payload""",
            (Jsonb({"items": [{"definition": {k: v for k, v in self.workflow.items() if k != "bundled_forms"}, "isDefault": False,
                               "sortOrder": 0}], "forms": {f"{FORM}@1": self.definition}}),))
        case_id = self.new_case(workflow=False)
        self.assertIsNone(case_workflow.case_workflow(case_id, NURSE, self.db)["workflow"])
        attached = case_workflow.attach_workflow(case_id, case_workflow.AttachWorkflow(workflow_id="wf_case_forms_test"), NURSE, self.db)
        self.assertEqual(attached["workflow"]["id"], "wf_case_forms_test")
        self.assertIn(FORM, attached["forms"])
        audit = self.db.execute("SELECT * FROM case_clinical_audit WHERE case_id=%s AND action='workflow.attach'", (case_id,)).fetchone()
        self.assertIsNotNone(audit)
        self.patch(case_id, {"hn": "HN10"})
        again = case_workflow.attach_workflow(case_id, case_workflow.AttachWorkflow(workflow_id="wf_case_forms_test"), NURSE, self.db)
        self.assertEqual(again["forms"][FORM]["record"]["data"]["hn"], "HN10")

    def test_a_repeatable_form_has_copies_each_with_its_own_form_studio_record(self):
        from fastapi import HTTPException

        repeatable = {**self.workflow, "forms": [{**self.entry, "repeatable": True, "max_instances": 3}, self.workflow["forms"][1]]}
        case_id = self.new_case()
        self.db.execute("UPDATE cases SET workflow=%s WHERE id=%s", (Jsonb(repeatable), case_id))
        self.patch(case_id, {"hn": "HN30", "full_name": "First"})
        second = self.patch(case_id, {"hn": "HN30", "full_name": "Second"}, form_id=f"{FORM}~2")
        self.assertEqual((second["form_id"], second["record"]["data"]["full_name"]), (f"{FORM}~2", "Second"))
        for refused in (f"{FORM}~4", f"{FILES}~2"):  # beyond max_instances; a form that is not repeatable
            with self.assertRaises(HTTPException) as caught:
                self.patch(case_id, {"hn": "HN30"}, form_id=refused)
            self.assertEqual(caught.exception.status_code, 404, refused)
        listed = case_workflow.case_workflow(case_id, NURSE, self.db)["forms"]
        self.assertEqual((listed[f"{FORM}~2"]["of"], listed[f"{FORM}~2"]["instance"]), (FORM, 2))
        self.assertEqual(listed[f"{FORM}~2"]["definition"]["form_id"], FORM)

        response, _ = self.cycle()
        receipts = {r["form_id"]: r for r in response["receipts"] if r["case_id"] == case_id}
        self.assertEqual((receipts[FORM]["state"], receipts[f"{FORM}~2"]["state"]), ("stored", "stored"))
        first_id, second_id = receipts[FORM]["record_id"], receipts[f"{FORM}~2"]["record_id"]
        self.assertNotEqual(first_id, second_id)
        record = self.record(second_id)
        self.assertEqual((record["form_id"], record["data"]["full_name"]), (FORM, "Second"), "a copy is a record of the form")
        links = case_forms.links(self.db, FORM)
        self.assertEqual((links[first_id]["instance"], links[second_id]["instance"], links[second_id]["form"]), (1, 2, FORM))

        # An amendment of the second copy in Canopy reaches that copy on the Leaf, not the first.
        self.amend(second_id, {**record["data"], "full_name": "Second B"}, "corrected from the ward list")
        self.cycle()
        rows = {row["form_id"]: row for row in self.db.execute("SELECT * FROM case_form_record WHERE case_id=%s", (case_id,)).fetchall()}
        self.assertEqual((rows[FORM]["data"]["full_name"], rows[f"{FORM}~2"]["data"]["full_name"]), ("First", "Second B"))

        # Attaching a workflow that lists the form once keeps the copies filled reachable.
        self.db.execute(
            """INSERT INTO leaf_workflow_state (id, version, payload, synced_at) VALUES (1, 1, %s, 1)
               ON CONFLICT (id) DO UPDATE SET payload=excluded.payload""",
            (Jsonb({"items": [{"definition": {k: v for k, v in self.workflow.items() if k != "bundled_forms"}, "isDefault": False,
                               "sortOrder": 0}], "forms": {f"{FORM}@1": self.definition}}),))
        attached = case_workflow.attach_workflow(case_id, case_workflow.AttachWorkflow(workflow_id="wf_case_forms_test"), NURSE, self.db)
        entry = next(item for item in attached["workflow"]["forms"] if item["form_id"] == FORM)
        self.assertEqual((entry["repeatable"], entry["max_instances"]), (True, 2))
        self.assertEqual(attached["forms"][f"{FORM}~2"]["record"]["data"]["full_name"], "Second B")

    def test_workflow_studio_checks_a_repeatable_entry(self):
        from app import workflows

        def issues(**entry):
            definition = {k: v for k, v in self.workflow.items() if k != "bundled_forms"}
            definition = {**definition, "forms": [{**self.entry, "phase": "any", **entry}]}
            return sorted(issue["path"] for issue in workflows.validate(self.db, definition) if ".forms[0]" in issue["path"])

        self.assertEqual(issues(repeatable=True), [])
        self.assertEqual(issues(repeatable=True, max_instances=5), [])
        self.assertEqual(workflows.normalize({"forms": [{**self.entry, "repeatable": True, "max_instances": 5}]})["forms"][0]["max_instances"], 5)
        self.assertNotIn("repeatable", workflows.normalize({"forms": [self.entry]})["forms"][0], "an entry that does not repeat is unchanged")
        self.assertEqual(issues(repeatable="yes"), ["$.forms[0].repeatable"])
        self.assertEqual(issues(repeatable=True, max_instances=1), ["$.forms[0].max_instances"])
        self.assertEqual(issues(repeatable=True, max_instances=100), ["$.forms[0].max_instances"])
        self.assertEqual(issues(repeatable=True, display="report"), ["$.forms[0].repeatable"])

    def test_handover_carries_the_forms_under_the_same_global_case(self):
        case_id = self.new_case()
        self.patch(case_id, {"hn": "HN11", "full_name": "Gus"})
        self.cycle()
        export = case_handover.export_case(self.db, case_id)
        self.assertEqual(len(export["tables"]["case_form_record"]), 1)
        global_id = case_forms.global_case_id(HOSPITAL, LEAF, case_id)
        imported = case_handover.import_case(self.db, export, from_leaf_id=LEAF, global_case_id=global_id, actor="test", now=now())
        self.db.execute("UPDATE cases SET status='discharged' WHERE id=%s", (imported["case_id"],))
        row = self.db.execute("SELECT * FROM case_form_record WHERE case_id=%s", (imported["case_id"],)).fetchone()
        self.assertEqual((row["data"]["full_name"], row["sync_state"], row["sent_digest"]), ("Gus", "pending", None))
        outbox = case_forms.leaf_outbox(self.db, now())
        sent = next(form for form in outbox["forms"] if form["case_id"] == imported["case_id"])
        self.assertEqual(sent["global_case_id"], global_id, "the new Leaf sends under the case's global id")


if __name__ == "__main__":
    unittest.main()
