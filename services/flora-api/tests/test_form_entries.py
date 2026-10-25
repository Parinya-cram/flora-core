"""Scheduled workflow form entries (ICU rounds, docs/ICU-ROUNDS.md) against a disposable database.

Same rules as test_live_cases.py: FLORA_DATABASE_URL must name a database ending in _test with the schema
(incl. 0097-case-form-entry.sql) in place. Starts the Leaf API on :8009 and seeds the cached ward workflows.
"""
import hashlib
import json
import os
import secrets
import subprocess
import sys
import time
import unittest
import urllib.error
import urllib.request
from urllib.parse import urlparse

import psycopg
from psycopg.rows import dict_row
from psycopg.types.json import Jsonb

URL = os.environ["FLORA_DATABASE_URL"]
if not urlparse(URL).path.endswith("_test"):
    raise RuntimeError("Write tests require a dedicated database ending in _test")
os.environ.update(FLORA_LEAF_WRITE_API="true", FLORA_API_MODE="leaf", FLORA_HIS_DEMO_MODE="true",
                  FLORA_DEVICE_INGEST_ENABLED="false", FLORA_LEAF_ID="leaf-entries-test", FLORA_HOSPITAL_ID="hospital-test")
API = "http://127.0.0.1:8009"
DAY = 24 * 3600 * 1000

from app import case_handover, form_schedule  # noqa: E402


def request(path, body=None, token=None, method=None):
    headers = {"Content-Type": "application/json"}
    if token:
        headers["X-FLORA-Session"] = token
    req = urllib.request.Request(API + path, data=json.dumps(body).encode() if body is not None else None,
                                 headers=headers, method=method or ("POST" if body is not None else "GET"))
    try:
        with urllib.request.urlopen(req, timeout=10) as response:
            return response.status, json.load(response)
    except urllib.error.HTTPError as error:
        return error.code, json.load(error)


def wait_for(check, timeout=20.0):
    end = time.time() + timeout
    while time.time() < end:
        if check():
            return True
        time.sleep(.1)
    return check()


class FormEntries(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.database = psycopg.connect(URL, autocommit=True, row_factory=dict_row)
        cls.suffix = secrets.token_hex(6)
        cls.username, cls.password = "entries_test_" + cls.suffix, secrets.token_urlsafe(18)
        salt = secrets.token_bytes(16)
        hashed = hashlib.scrypt(cls.password.encode(), salt=salt, n=16384, r=8, p=1, dklen=64).hex()
        user_id = cls.database.execute(
            """INSERT INTO auth_user(username,name,role,password_salt,password_hash,is_active,created_at,updated_at)
               VALUES (%s,'Entries test','admin',%s,%s,1,1,1) RETURNING id""", (cls.username, salt.hex(), hashed)).fetchone()["id"]
        cls.database.execute("INSERT INTO auth_user_role(user_id,role_code,created_at,updated_at) VALUES (%s,'system_admin',1,1) "
                             "ON CONFLICT DO NOTHING", (user_id,))
        cls.saved_state = cls.database.execute("SELECT * FROM leaf_workflow_state WHERE id=1").fetchone()
        cls.workflow_id = "icu_entries_" + cls.suffix
        definition = {
            "format": "flora-workflow/1", "id": cls.workflow_id, "name": "ICU entries test", "day_start": "07:00",
            "anesthesia_record": {"enabled": False, "sections": [], "optional_sections": []},
            "forms": [{"form_id": "round_t", "version": 2, "title": "Daily round", "phase": "any", "required": True,
                       "display": "tab", "schedule": {"kind": "daily", "at": "07:00", "days": None}},
                      {"form_id": "note_t", "version": 1, "title": "Admission note", "phase": "any", "display": "tab"}],
            "packet": [],
        }
        payload = {"version": 1, "items": [{"definition": definition, "isDefault": False, "sortOrder": 0}],
                   "forms": {"round_t@2": {"form_id": "round_t", "title": "Daily round", "fields": []},
                             "note_t@1": {"form_id": "note_t", "title": "Admission note", "fields": []}}}
        cls.database.execute(
            """INSERT INTO leaf_workflow_state (id, version, payload, synced_at) VALUES (1, 1, %s, 1)
               ON CONFLICT (id) DO UPDATE SET version=1, payload=excluded.payload""", (Jsonb(payload),))
        cls.server = subprocess.Popen([sys.executable, "-m", "uvicorn", "app.main:app", "--host", "127.0.0.1",
                                       "--port", "8009", "--log-level", "warning"])
        if not wait_for(lambda: cls.ok(API + "/health")):
            cls.tearDownClass()
            raise RuntimeError("Leaf API failed to start")

    @staticmethod
    def ok(url):
        try:
            with urllib.request.urlopen(url, timeout=2) as response:
                return response.status == 200
        except OSError:
            return False

    @classmethod
    def tearDownClass(cls):
        cls.server.terminate()
        cls.server.wait(timeout=10)
        if cls.saved_state is None:
            cls.database.execute("DELETE FROM leaf_workflow_state WHERE id=1")
        else:
            cls.database.execute("UPDATE leaf_workflow_state SET version=%s, payload=%s WHERE id=1",
                                 (cls.saved_state["version"], Jsonb(cls.saved_state["payload"])))
        cls.database.close()

    def setUp(self):
        self.token = request("/api/auth/login", {"username": self.username, "password": self.password})[1]["session_token"]
        for case in request("/api/case/active", token=self.token)[1]["cases"]:
            request("/api/case/discharge", {"case_id": case["case_id"],
                                            "discharge_time": max(case["start_time"] + 60_000, int(time.time() * 1000))}, self.token)

    def test_scheduled_round(self):
        start = int(time.time() * 1000) - 3 * DAY
        status, case = request("/api/case/start", {"hn": "ICU-" + self.suffix, "start_time": start,
                                                   "workflow_id": self.workflow_id, "overlap_policy": "include"}, self.token)
        self.assertEqual(status, 200, case)
        case_id = case["case_id"]
        stored = self.database.execute("SELECT start_time, workflow FROM cases WHERE id=%s", (case_id,)).fetchone()
        self.assertEqual(stored["workflow"]["forms"][0]["schedule"]["kind"], "daily")
        base = f"/api/case/{case_id}/workflow-forms/round_t/entries"
        timezone = form_schedule.timezone_of(self.database)

        # Slots: 3 days ago → 3-4 daily 07:00 slots in the past (overdue, the latest maybe due) + 1 upcoming.
        status, listing = request(base, token=self.token)
        self.assertEqual(status, 200, listing)
        expected = form_schedule.slots(stored["workflow"]["forms"][0]["schedule"], stored["start_time"], None,
                                       int(time.time() * 1000), timezone)
        self.assertEqual([s["slot_ts"] for s in listing["slots"]], [s["slot_ts"] for s in expected])
        self.assertEqual(listing["timezone"], timezone)
        self.assertEqual(listing["schedule"]["at"], "07:00")
        past = [s for s in listing["slots"] if s["status"] in ("overdue", "due")]
        self.assertIn(len(past), (3, 4))
        self.assertGreaterEqual(listing["summary"]["overdue"], 2)
        self.assertTrue(all(s["status"] == "overdue" for s in past[:-1]))
        self.assertTrue(listing["slots"][0]["label"].startswith(f"Day {listing['slots'][0]['day']} · 07:00"))
        overdue_before = listing["summary"]["overdue"]

        # Create (idempotent per slot), bad slot → 400.
        first, second = past[0]["slot_ts"], past[1]["slot_ts"]
        status, created = request(base, {"slot_ts": first}, self.token)
        self.assertEqual(status, 200, created)
        self.assertEqual(request(base, {"slot_ts": first}, self.token)[1]["entry"]["id"], created["entry"]["id"])
        self.assertEqual(request(base, {"slot_ts": first + 60_000}, self.token)[0], 400)
        self.assertEqual(request(f"/api/case/{case_id}/workflow-forms/note_t/entries", {"slot_ts": None}, self.token)[0], 400)
        entry_id = created["entry"]["id"]

        # PATCH: shallow merge, then complete.
        status, patched = request(f"{base}/{entry_id}", {"patch": {"gcs": 15}}, self.token, "PATCH")
        self.assertEqual((status, patched["entry"]["status"]), (200, "draft"), patched)
        status, patched = request(f"{base}/{entry_id}", {"patch": {"plan": "wean"}, "status": "completed"}, self.token, "PATCH")
        self.assertEqual(patched["entry"]["data"], {"gcs": 15, "plan": "wean"})
        self.assertEqual(patched["entry"]["status"], "completed")
        self.assertEqual(patched["entry"]["completedBy"], self.username)
        self.assertIsNotNone(patched["entry"]["completedAt"])
        versions = self.database.execute("SELECT field_versions FROM case_form_entry WHERE id=%s", (entry_id,)).fetchone()
        self.assertEqual(set(versions["field_versions"]), {"gcs", "plan"})
        audit = self.database.execute("SELECT count(*) AS n FROM case_clinical_audit WHERE case_id=%s AND action=%s",
                                      (case_id, "workflow_form_entry.patch:round_t")).fetchone()["n"]
        self.assertEqual(audit, 2)
        status, one = request(f"{base}/{entry_id}", token=self.token)
        self.assertEqual((status, one["definition"]["title"], one["entry"]["id"]), (200, "Daily round", entry_id))
        self.assertEqual(request(f"{base}/00000000-0000-0000-0000-000000000000", token=self.token)[0], 404)

        # Skip the second slot.
        skip_id = request(base, {"slot_ts": second}, self.token)[1]["entry"]["id"]
        status, skipped = request(f"{base}/{skip_id}/skip", {"reason": "patient in CT"}, self.token)
        self.assertEqual((status, skipped["entry"]["status"], skipped["entry"]["skipReason"]), (200, "skipped", "patient in CT"))

        # Unscheduled entries: each POST is a new entry.
        extra = [request(base, {"slot_ts": None}, self.token)[1]["entry"]["id"] for _ in range(2)]
        self.assertEqual(len(set(extra)), 2)

        status, listing = request(base, token=self.token)
        by_slot = {s["slot_ts"]: s for s in listing["slots"]}
        self.assertEqual((by_slot[first]["status"], by_slot[first]["entry_id"]), ("done", entry_id))
        self.assertEqual(by_slot[second]["status"], "skipped")
        self.assertEqual(by_slot[second]["skipReason"], "patient in CT")
        self.assertEqual(by_slot[first]["completedBy"], self.username)
        self.assertIsNone(listing["slots"][-1]["completedAt"])
        self.assertEqual(sorted(e["id"] for e in listing["unscheduled"]), sorted(extra))
        self.assertEqual(listing["summary"]["done"], 1)
        self.assertEqual(listing["summary"]["overdue"], overdue_before - 2)

        # Worklist + /workflow summary.
        status, worklist = request("/api/case/worklist", token=self.token)
        self.assertEqual(status, 200, worklist)
        row = next(c for c in worklist["cases"] if c["case_id"] == case_id)
        self.assertEqual(row["overdue"], listing["summary"]["overdue"])
        self.assertEqual(row["forms"][0]["form_id"], "round_t")
        self.assertEqual(row["forms"][0]["title"], "Daily round")
        self.assertIsNotNone(row["forms"][0]["next_slot_ts"])
        status, workflow = request(f"/api/case/{case_id}/workflow", token=self.token)
        round_form, note_form = workflow["forms"]["round_t"], workflow["forms"]["note_t"]
        self.assertIsNone(round_form["record"])
        self.assertEqual(round_form["schedule"]["kind"], "daily")
        self.assertEqual(round_form["summary"], listing["summary"])
        self.assertIsNone(note_form["schedule"])
        self.assertNotIn("summary", note_form)

        # Single-record form still works; sync snapshot and handover export carry both.
        self.assertEqual(request(f"/api/case/{case_id}/workflow-forms/note_t", {"patch": {"text": "hi"}}, self.token, "PATCH")[0], 200)
        status, entries = request(f"/api/case/{case_id}/workflow-entries", token=self.token)
        self.assertEqual((status, len(entries)), (200, 4))
        self.assertEqual({e["form_id"] for e in entries}, {"round_t"})
        export = case_handover.export_case(self.database, case_id)
        self.assertEqual(len(export["tables"]["case_form_entry"]), 4)
        self.assertEqual([r["form_id"] for r in export["tables"]["case_form_record"]], ["note_t"])
        with psycopg.connect(URL, row_factory=dict_row) as other:
            with other.transaction(force_rollback=True):
                result = case_handover.import_case(other, export, from_leaf_id="leaf-x", global_case_id="0" * 32,
                                                   actor="test", now=int(time.time() * 1000))
                self.assertEqual(result["rows"].get("case_form_entry"), 4)
                self.assertEqual(result["rows"].get("case_form_record"), 1)
                copied = other.execute("SELECT count(*) AS n FROM case_form_entry WHERE case_id=%s",
                                       (result["case_id"],)).fetchone()["n"]
                self.assertEqual(copied, 4)

        # Discharged: still editable, no new slots after discharge; archived would be read-only.
        request("/api/case/discharge", {"case_id": case_id, "discharge_time": int(time.time() * 1000)}, self.token)
        status, after = request(base, token=self.token)
        self.assertTrue(all(s["slot_ts"] <= int(time.time() * 1000) for s in after["slots"]))
        self.assertEqual(request(f"{base}/{skip_id}", {"patch": {"late": True}, "status": "completed"}, self.token, "PATCH")[0], 200)


if __name__ == "__main__":
    unittest.main()
