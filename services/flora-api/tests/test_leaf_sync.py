"""Phase 0 of LEAF-DYNAMIC-STANDALONE-ANALYSIS.md: the sync worker's memory kept on the Leaf, against a disposable
PostgreSQL database (scripts/test-leaf-writes.sh). No 24-hour windows: what Canopy has not taken stays to be sent."""
import os
import secrets
import time
import unittest
import uuid
from urllib.parse import urlparse

URL = os.environ.get("FLORA_DATABASE_URL", "")
if not urlparse(URL).path.endswith("_test"):
    raise unittest.SkipTest("leaf sync tests need a dedicated database ending in _test")
os.environ.setdefault("FLORA_API_MODE", "leaf")

import psycopg  # noqa: E402
from psycopg.rows import dict_row  # noqa: E402
from psycopg.types.json import Jsonb  # noqa: E402

from app import case_forms  # noqa: E402
from app.routes import canopy_inbox, leaf_sync  # noqa: E402

DAY = 24 * 3600 * 1000
SERVICE = {"username": "service"}


def now() -> int:
    return time.time_ns() // 1_000_000


class LeafSync(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.db = psycopg.connect(URL, autocommit=True, row_factory=dict_row)

    @classmethod
    def tearDownClass(cls):
        cls.db.close()

    def case(self, status="discharged", archived_days_ago=None, admission=None):
        hn = f"S{secrets.token_hex(4)}"
        at = now() - 10 * DAY
        archive = now() - archived_days_ago * DAY if archived_days_ago is not None else None
        return self.db.execute(
            """INSERT INTO cases (case_code, hn, start_time, discharge_time, status, created_at, updated_at, archive_time, canopy_admission_id)
               VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s) RETURNING id""",
            (f"{hn}_S", hn, at, at + 3600_000, status, at, at, archive, admission)).fetchone()["id"]

    def planned(self, idle=200):
        return {row["case_id"]: row for row in leaf_sync.plan(self.db, 400, idle)}

    def record(self, case_id, **fields):
        return leaf_sync.sync_results({"results": [{"case_id": case_id, **fields}]}, SERVICE, self.db)

    def test_a_case_discharged_long_ago_is_still_checked_and_archived_ones_are_sent_once(self):
        old = self.case()
        self.assertIn(old, self.planned(), "never sent: in the plan whenever it was discharged")
        self.record(old, sent_digest="d1")
        row = self.planned()[old]
        self.assertEqual(row["sent_digest"], "d1", "the plan carries what Canopy took, so an unchanged case is not re-sent")
        self.db.execute("UPDATE cases SET status='archived', archive_time=%s WHERE id=%s", (now(), old))
        self.assertIn(old, self.planned(idle=0), "archived after the last send: sent once more, before idle cases")
        self.record(old, sent_digest="d2")
        self.assertNotIn(old, self.planned(), "archived and sent: done")

    def test_open_cases_are_checked_in_turn_and_active_ones_always(self):
        active = self.case(status="active")
        first, second = self.case(), self.case()
        for case_id in (first, second):
            self.record(case_id, sent_digest="x")
        self.db.execute("UPDATE leaf_sync_case SET checked_at=1 WHERE case_id=%s", (second,))
        plan = leaf_sync.plan(self.db, 400, 1)
        ids = [row["case_id"] for row in plan]
        self.assertIn(active, ids)
        idle = [row["case_id"] for row in plan if row["status"] == "DISCHARGED" and row["sent_digest"]]
        self.assertEqual(len(idle), 1, "one open case per pass")
        self.assertEqual(idle[0], second, "the longest unchecked first")
        self.db.execute("UPDATE cases SET status='discharged' WHERE id=%s", (active,))

    def test_a_case_that_cannot_be_read_is_recorded_and_cleared_when_it_goes_through(self):
        case_id = self.case()
        self.record(case_id, error="HTTPStatusError: 500")
        stored = self.db.execute("SELECT * FROM leaf_sync_case WHERE case_id=%s", (case_id,)).fetchone()
        self.assertTrue(stored["last_error"].startswith("HTTPStatusError"))
        self.assertIsNone(stored["snapshot_sent_at"])
        self.record(case_id, sent_digest="ok")
        stored = self.db.execute("SELECT * FROM leaf_sync_case WHERE case_id=%s", (case_id,)).fetchone()
        self.assertEqual((stored["last_error"], stored["snapshot_digest"]), (None, "ok"))

    def test_state_survives_the_worker(self):
        leaf_sync.put_state("case_forms.active", True, SERVICE, self.db)
        self.assertIs(leaf_sync.sync_plan(1, 0, SERVICE, self.db)["state"]["case_forms.active"], True)

    # ------------------------------------------------------------ case forms and admissions outboxes

    def form(self, case_id, form_id="sync_test_form", **columns):
        values = {"case_id": case_id, "form_id": form_id, "form_version": 1, "data": Jsonb({"a": 1}),
                  "field_versions": Jsonb({"a": 1}), "status": "draft", "updated_at": now(), **columns}
        names = ", ".join(values)
        self.db.execute(f"INSERT INTO case_form_record ({names}) VALUES ({', '.join(['%s'] * len(values))})", tuple(values.values()))

    def test_forms_of_a_case_archived_days_ago_still_go_to_canopy(self):
        case_id = self.case(status="archived", archived_days_ago=5)
        self.form(case_id)
        outbox = case_forms.leaf_outbox(self.db, now())
        self.assertTrue([form for form in outbox["forms"] if form["case_id"] == case_id])
        self.assertFalse([case for case in outbox["cases"] if case["case_id"] == case_id], "nothing to receive for an archived case")

    def test_the_outbox_is_paged(self):
        case_id = self.case(status="active")
        for index in range(3):
            self.form(case_id, form_id=f"page_test_{index}")
        outbox = case_forms.leaf_outbox(self.db, now(), limit_forms=2)
        self.assertEqual(len(outbox["forms"]), 2)
        self.assertTrue(outbox["more"])
        self.db.execute("UPDATE cases SET status='discharged' WHERE id=%s", (case_id,))

    def test_a_receipt_for_an_older_copy_leaves_the_form_to_be_sent(self):
        case_id = self.case(status="archived", archived_days_ago=1)
        self.form(case_id)
        sent = next(form for form in case_forms.leaf_outbox(self.db, now())["forms"] if form["case_id"] == case_id)
        self.db.execute("UPDATE case_form_record SET data=%s, field_versions=%s WHERE case_id=%s",
                        (Jsonb({"a": 2}), Jsonb({"a": 2}), case_id))  # changed after it was sent
        case_forms.leaf_inbox(self.db, {"receipts": [{"case_id": case_id, "form_id": sent["form_id"], "digest": sent["digest"],
                                                      "state": "stored"}]}, now())
        row = self.db.execute("SELECT * FROM case_form_record WHERE case_id=%s", (case_id,)).fetchone()
        self.assertIsNone(row["synced_at"])
        self.assertTrue([form for form in case_forms.leaf_outbox(self.db, now())["forms"] if form["case_id"] == case_id])
        current = next(form for form in case_forms.leaf_outbox(self.db, now())["forms"] if form["case_id"] == case_id)
        case_forms.leaf_inbox(self.db, {"receipts": [{"case_id": case_id, "form_id": current["form_id"],
                                                      "digest": current["digest"], "state": "stored"}]}, now())
        self.assertFalse([form for form in case_forms.leaf_outbox(self.db, now())["forms"] if form["case_id"] == case_id])

    def test_an_admission_case_archived_while_canopy_was_away_is_sent_until_an_exchange_goes_through(self):
        case_id = self.case(status="archived", archived_days_ago=3, admission=uuid.uuid4())
        canopy_inbox.inbox({"outbox_built_at": now() - 4 * DAY}, SERVICE, self.db)  # last good exchange before archiving
        outbox = canopy_inbox.outbox(SERVICE, self.db)
        self.assertIn(case_id, [case["case_id"] for case in outbox["cases"]])
        canopy_inbox.inbox({"outbox_built_at": outbox["built_at"]}, SERVICE, self.db)
        self.assertNotIn(case_id, [case["case_id"] for case in canopy_inbox.outbox(SERVICE, self.db)["cases"]])

    def test_canopy_turns_away_a_leaf_whose_protocol_is_too_old(self):
        from fastapi import HTTPException

        from app.routes import sync_ingest

        leaf = f"leaf-protocol-{secrets.token_hex(3)}"
        self.db.execute("INSERT INTO sync_leaf_node (leaf_id, hospital_id, display_name) VALUES (%s, 'h', 'Old Leaf')", (leaf,))
        sync_ingest.require_protocol(self.db, leaf, None)  # by default every worker, also one from before the handshake
        minimum = sync_ingest.MIN_PROTOCOL_VERSION
        sync_ingest.MIN_PROTOCOL_VERSION = 3
        try:
            with self.assertRaises(HTTPException) as caught:
                sync_ingest.require_protocol(self.db, leaf, 2)
            self.assertEqual((caught.exception.status_code, caught.exception.detail["minimum"]), (426, 3))
            self.assertIn("Update Flora Leaf", caught.exception.detail["message"])
            sync_ingest.require_protocol(self.db, leaf, 3)
        finally:
            sync_ingest.MIN_PROTOCOL_VERSION = minimum
        refused = self.db.execute("SELECT metadata FROM sync_leaf_node WHERE leaf_id=%s", (leaf,)).fetchone()["metadata"]["protocol_refused"]
        self.assertEqual((refused["protocol_version"], refused["minimum"]), (2, 3), "kept for the fleet view")


if __name__ == "__main__":
    unittest.main()
