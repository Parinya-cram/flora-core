"""The sync worker's own rules, without servers: the history a snapshot carries, Canopy refusing an old protocol, and
documents attached to cases sent as their details first and their file (as it is) only when Canopy lacks it.
Run in the worker image (it has httpx):
  docker run --rm -v "$PWD":/w -w /w flora-core-flora-leaf-sync python -m unittest discover -s tests"""
import os
import pathlib
import unittest
from urllib.parse import parse_qs, urlparse

import httpx

WORKER = pathlib.Path(__file__).resolve().parents[1] / "sync_worker.py"
DAY = 24 * 3600 * 1000


def load() -> dict:
    """The worker module without its endless loop."""
    os.environ.setdefault("FLORA_LEAF_SERVICE_SECRET", "test")
    os.environ.setdefault("FLORA_SYNC_SHARED_SECRET", "test")
    source = WORKER.read_text()
    namespace: dict = {"__name__": "sync_worker_test"}
    exec(compile(source[:source.index("# Automatic sync every INTERVAL_SECONDS")], str(WORKER), "exec"), namespace)
    return namespace


class Worker(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.worker = load()

    def window(self, case: dict) -> tuple[dict, dict]:
        asked: dict[str, str] = {}

        def get_json(_client, path):
            asked[path.split("?")[0]] = path
            return {"rows": []}

        self.worker["get_json"] = get_json
        snapshot = self.worker["build_snapshot"](None, case)
        query = parse_qs(urlparse(asked["/api/case/1/vitals"]).query)
        return snapshot["window"], {"from": int(query["from"][0]), "events": parse_qs(urlparse(asked["/api/case/1/events"]).query)["limit"][0]}

    def test_an_open_case_carries_its_latest_day_a_closed_one_its_whole_record(self):
        start = 1_790_000_000_000
        window, asked = self.window({"case_id": 1, "status": "active", "start_time": start - 3 * DAY})
        self.assertFalse(window["complete"])
        self.assertAlmostEqual(window["to"] - window["from"], DAY, delta=60_000)
        self.assertEqual(asked["events"], "1000")
        window, asked = self.window({"case_id": 1, "status": "discharged", "start_time": start, "discharge_time": start + 5 * DAY})
        self.assertEqual((window["from"], asked["from"], window["complete"]), (start, start, True), "a closed case goes whole")
        self.assertEqual(asked["events"], "5000")
        window, _ = self.window({"case_id": 1, "status": "archived", "start_time": start, "discharge_time": start + 40 * DAY})
        self.assertEqual((window["to"] - window["from"]) // DAY, self.worker["FINAL_HISTORY_DAYS"])
        self.assertFalse(window["complete"], "beyond FINAL_HISTORY_DAYS the snapshot says it is not the whole case")

    def test_canopy_refusing_the_protocol_is_reported_with_its_reason(self):
        request = httpx.Request("POST", "http://canopy/api/sync/v1/batch")
        refused = httpx.Response(426, request=request, json={"detail": {"code": "protocol_unsupported",
                                                                        "message": "Canopy needs Leaf sync protocol 3 or newer"}})
        with self.assertRaises(self.worker["ProtocolRefused"]) as caught:
            self.worker["check_refused"](refused)
        self.assertIn("protocol 3", str(caught.exception))
        self.worker["check_refused"](httpx.Response(200, request=request, json={}))  # anything else passes through

    def test_a_document_file_is_sent_once_as_it_is_and_a_removal_sends_details_only(self):
        sent: list[tuple[str, str, bytes, str]] = []
        documents = [
            {"id": 1, "case_id": 7, "title": "ใบยินยอม", "pages": 2, "bytes": 6, "sha256": "a" * 64, "created_at": 1, "created_by": "nurse"},
            {"id": 2, "case_id": 7, "title": "สแกนผิด", "pages": 1, "bytes": 6, "sha256": "b" * 64, "created_at": 1, "removed_at": 5,
             "removed_by": "nurse", "removed_reason": "ผิดเคส"},
        ]

        def handler(request: httpx.Request) -> httpx.Response:
            path = request.url.path
            sent.append((request.method, path, request.content, request.headers.get("content-type", "")))
            if path.endswith("/case-documents/outbox"):
                return httpx.Response(200, json={"documents": documents})
            if path == "/api/case-documents/1/file":
                return httpx.Response(200, content=b"%PDF-1", headers={"content-type": "application/pdf"})
            if path == "/api/sync/v1/case-documents":
                body = __import__("json").loads(request.content)
                return httpx.Response(200, json={"ok": True, "needs_content": body["document_id"] == 1})
            return httpx.Response(200, json={"ok": True})

        real = httpx.Client
        self.worker["httpx"] = type("httpx", (), {"Client": staticmethod(lambda **kw: real(transport=httpx.MockTransport(handler), **kw)),
                                                  "HTTPStatusError": httpx.HTTPStatusError})
        self.worker["get_json"] = lambda client, path: client.get(f"{self.worker['LEAF_API']}{path}").json()
        try:
            result = self.worker["synchronize_case_documents"]()
        finally:
            self.worker["httpx"] = httpx
        self.assertEqual(result, {"sent": 2, "files": 1, "failed": 0})
        details = [body for method, path, body, _ in sent if path == "/api/sync/v1/case-documents"]
        self.assertEqual(len(details), 2)
        self.assertTrue(all(b"content_base64" not in body for body in details), "no file inside the details")
        content = [(path, body, kind) for method, path, body, kind in sent if path.endswith("/content")]
        self.assertEqual(content, [(f"/api/sync/v1/case-documents/{self.worker['LEAF_ID']}/1/content", b"%PDF-1", "application/pdf")])
        self.assertNotIn("/api/case-documents/2/file", [path for _, path, _, _ in sent], "a removal does not read the file")


if __name__ == "__main__":
    unittest.main()
