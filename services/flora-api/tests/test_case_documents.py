"""Documents attached to a case (0092): put together on the Leaf (the PDF is the request body, no base64), kept with
the case, sent to Canopy once (details first, the file only when Canopy has not got it) and again when removed (details
only); against a disposable PostgreSQL database (scripts/test-leaf-writes.sh)."""
import hashlib
import asyncio
import os
import secrets
import time
import unittest
from urllib.parse import urlparse

URL = os.environ.get("FLORA_DATABASE_URL", "")
if not urlparse(URL).path.endswith("_test"):
    raise unittest.SkipTest("case document tests need a dedicated database ending in _test")
os.environ.setdefault("FLORA_API_MODE", "leaf")

import psycopg  # noqa: E402
from fastapi import HTTPException  # noqa: E402
from psycopg.rows import dict_row  # noqa: E402

from app.routes import case_documents, sync_ingest  # noqa: E402

NURSE = {"username": "nurse_a", "role": "nurse"}
SERVICE = {"username": "service"}
PDF = b"%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n"


class CaseDocuments(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.db = psycopg.connect(URL, autocommit=True, row_factory=dict_row)

    @classmethod
    def tearDownClass(cls):
        cls.db.close()

    def case(self, status="active"):
        hn = f"D{secrets.token_hex(4)}"
        at = int(time.time() * 1000)
        return self.db.execute("INSERT INTO cases (case_code, hn, start_time, status, created_at, updated_at) VALUES (%s,%s,%s,%s,%s,%s) RETURNING id",
                               (f"{hn}_D", hn, at, status, at, at)).fetchone()["id"]

    def attach(self, case_id, content=PDF, title="ใบยินยอม"):
        return case_documents.attach_document(case_id, title, 2, content, NURSE, self.db)["document"]

    def body(self, content):
        """What the routes read from a request: the file itself."""
        class Request:
            headers = {"content-length": str(len(content))}

            async def stream(self):
                yield content[:10]
                yield content[10:]
        return asyncio.run(case_documents.pdf_body(Request()))

    def test_attach_list_open_and_remove_with_a_reason(self):
        case_id = self.case()
        document = self.attach(case_id)
        self.assertEqual((document["title"], document["pages"], document["sha256"]), ("ใบยินยอม", 2, hashlib.sha256(PDF).hexdigest()))
        self.assertEqual([row["id"] for row in case_documents.list_documents(case_id, NURSE, self.db)["documents"]], [document["id"]])
        self.assertEqual(case_documents.document_file(case_id, document["id"], NURSE, self.db).body, PDF)
        with self.assertRaises(Exception):
            case_documents.Removal(reason="x")  # a reason of at least 3 characters
        removed = case_documents.remove_document(case_id, document["id"], case_documents.Removal(reason="สแกนผิดเคส"), NURSE, self.db)["document"]
        self.assertEqual((removed["removed_by"], removed["removed_reason"]), ("nurse_a", "สแกนผิดเคส"))
        audit = [row["action"] for row in self.db.execute("SELECT action FROM case_clinical_audit WHERE case_id=%s ORDER BY id", (case_id,)).fetchall()]
        self.assertEqual(audit, ["document.attach", "document.remove"])

    def test_only_pdfs_and_not_on_an_archived_case(self):
        self.assertEqual(self.body(PDF), PDF)
        with self.assertRaises(HTTPException) as caught:
            self.body(b"not a pdf")
        self.assertEqual(caught.exception.status_code, 422)
        with self.assertRaises(HTTPException) as caught:
            self.attach(self.case(status="archived"))
        self.assertEqual(caught.exception.status_code, 409)

    def test_the_worker_sends_each_document_once_and_again_when_removed(self):
        case_id = self.case()
        document = self.attach(case_id)
        unsent = [row["id"] for row in case_documents.documents_outbox(100, SERVICE, self.db)["documents"]]
        self.assertIn(document["id"], unsent)
        self.assertEqual(case_documents.outbox_file(document["id"], SERVICE, self.db).body, PDF)

        # Canopy keeps the details by the case's global id and asks for the file once; a file that does not match the
        # sha256 sent with the details is refused.
        payload = {"leaf_id": "leaf-doc-01", "hospital_id": "hospital-test", "case_id": case_id, "document_id": document["id"], "title": document["title"],
                   "pages": 2, "bytes": len(PDF), "sha256": document["sha256"], "created_at": document["created_at"], "created_by": "nurse_a"}
        self.db.execute("INSERT INTO sync_leaf_node (leaf_id, hospital_id, display_name) VALUES ('leaf-doc-01', 'hospital-test', 'Doc Leaf') ON CONFLICT DO NOTHING")
        stored = sync_ingest.receive_case_document(sync_ingest.CaseDocument(**payload), self.db)
        self.assertTrue(stored["needs_content"])
        with self.assertRaises(HTTPException) as caught:
            sync_ingest.receive_case_document_content("leaf-doc-01", document["id"], b"%PDF-other", self.db)
        self.assertEqual(caught.exception.status_code, 422)
        with self.assertRaises(HTTPException) as caught:
            sync_ingest.receive_case_document_content("leaf-doc-01", 987654321, PDF, self.db)
        self.assertEqual(caught.exception.status_code, 404, "details first")
        sync_ingest.receive_case_document_content("leaf-doc-01", document["id"], PDF, self.db)
        row = self.db.execute("SELECT global_case_id, title, content FROM canopy_case_document WHERE leaf_id='leaf-doc-01' AND document_id=%s", (document["id"],)).fetchone()
        self.assertEqual((row["global_case_id"], row["title"], bytes(row["content"])), (stored["global_case_id"], "ใบยินยอม", PDF))
        self.assertFalse(sync_ingest.receive_case_document(sync_ingest.CaseDocument(**payload), self.db)["needs_content"], "never sent twice")

        case_documents.mark_synced(document["id"], {}, SERVICE, self.db)
        self.assertNotIn(document["id"], [row["id"] for row in case_documents.documents_outbox(100, SERVICE, self.db)["documents"]])
        case_documents.remove_document(case_id, document["id"], case_documents.Removal(reason="ซ้ำกับฉบับก่อน"), NURSE, self.db)
        self.assertIn(document["id"], [row["id"] for row in case_documents.documents_outbox(100, SERVICE, self.db)["documents"]], "the removal goes to Canopy too")
        removal = sync_ingest.receive_case_document(sync_ingest.CaseDocument(**{**payload, "removed_at": 1, "removed_by": "nurse_a",
                                                                                "removed_reason": "ซ้ำกับฉบับก่อน"}), self.db)
        self.assertFalse(removal["needs_content"], "a removal sends the details only")
        self.assertEqual(self.db.execute("SELECT removed_reason FROM canopy_case_document WHERE leaf_id='leaf-doc-01' AND document_id=%s",
                                         (document["id"],)).fetchone()["removed_reason"], "ซ้ำกับฉบับก่อน")
        case_documents.mark_synced(document["id"], {"error": "refused"}, SERVICE, self.db)
        self.assertEqual(self.db.execute("SELECT sync_error FROM case_document WHERE id=%s", (document["id"],)).fetchone()["sync_error"], "refused")


if __name__ == "__main__":
    unittest.main()
