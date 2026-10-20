"""End-to-end: a form designed in Canopy, sent by Workflow Studio, filled on Flora Leaf and back to Canopy as a record.

Runs the three servers of the system on one disposable PostgreSQL database (Leaf API, Canopy sync API, Canopy API, each
in its own mode, over HTTP) and the real sync worker code (services/flora-sync-worker/sync_worker.py, loaded without its
loop), then walks the whole loop with the kitchen-sink form (formdev/examples/e2e-kitchen-sink: every field type):

  design + publish (Form Studio) → workflow + ward (Workflow Studio) → admission + pre-op filling (Canopy tablet)
  → delivery (ward exchange) → case start on the Leaf → admission form arrives → every field filled → completion checked
  → back to Canopy (receipt, Form Studio record, files) → amendment with a reason → back on the Leaf → print templates
  → Canopy unreachable (the Leaf keeps working) → catch-up → worker restart → discharge + archive → workflow attached
  to an open case.

Each step is recorded in E2E_REPORT (JSON) with what was checked. Run: scripts/test-form-flow.sh
"""
from __future__ import annotations

import base64
import hashlib
import json
import os
import secrets
import subprocess
import sys
import time
import traceback
import unittest
import urllib.error
import urllib.request
from pathlib import Path
from urllib.parse import urlparse

URL = os.environ.get("FLORA_DATABASE_URL", "")  # Canopy's database
# The Leaf has its own database, as in production (E2E_LEAF_DATABASE_URL; scripts/test-form-flow.sh builds both).
LEAF_URL = os.environ.get("E2E_LEAF_DATABASE_URL", "")
if not urlparse(URL).path.endswith("_test") or not urlparse(LEAF_URL).path.endswith("_test") or URL == LEAF_URL:
    raise unittest.SkipTest("the end-to-end flow needs two dedicated databases ending in _test (Canopy and Leaf)")

import psycopg  # noqa: E402
from psycopg.rows import dict_row  # noqa: E402

REPO = Path(__file__).resolve().parents[3]
EXAMPLE = REPO / "formdev" / "examples" / "e2e-kitchen-sink"
WORKER = REPO / "services" / "flora-sync-worker" / "sync_worker.py"
REPORT = Path(os.environ.get("E2E_REPORT", "/tmp/e2e-form-flow.json"))
FORM = "e2e_kitchen_sink"
WORKFLOW = "e2e_flow"
LEAF_ID, HOSPITAL = "leaf-e2e-01", "hospital-e2e"
ACCOUNT = "e2e"
LEAF_SECRET, SYNC_SECRET = "e2e-leaf-service-" + secrets.token_hex(8), "e2e-sync-" + secrets.token_hex(8)
PORTS = {"leaf": 8101, "sync": 8102, "canopy": 8103}
CANOPY_SESSION_SECRET = secrets.token_hex(32)


def now() -> int:
    return time.time_ns() // 1_000_000


def http(port: int, path: str, body=None, token=None, method=None, raw: bytes | None = None, content_type="application/json"):
    headers = {"Content-Type": content_type}
    if token:
        headers["X-FLORA-Session"] = token
    data = raw if raw is not None else (json.dumps(body).encode() if body is not None else None)
    request = urllib.request.Request(f"http://127.0.0.1:{port}{path}", data=data, headers=headers,
                                     method=method or ("POST" if data is not None else "GET"))
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            text = response.read()
            return response.status, (json.loads(text) if text and response.headers.get_content_type() == "application/json" else text)
    except urllib.error.HTTPError as error:
        text = error.read()
        try:
            return error.code, json.loads(text)
        except ValueError:
            return error.code, text


class Flow(unittest.TestCase):
    steps: list[dict] = []

    @classmethod
    def setUpClass(cls):
        cls.db = psycopg.connect(URL, autocommit=True, row_factory=dict_row)          # Canopy
        cls.leaf_db = psycopg.connect(LEAF_URL, autocommit=True, row_factory=dict_row)  # Flora Leaf
        cls.definition = json.loads((EXAMPLE / "v1.form.json").read_text())
        sample = json.loads((EXAMPLE / "sample.record.json").read_text())
        cls.record, cls.files = sample["record"], sample["files"]
        # Canopy is multi-account (app/tenancy.py): this single-hospital database becomes its first account, as an
        # upgraded server does once (adopt-public); the Leaf's sync secret names that account.
        os.environ.setdefault("FLORA_PLATFORM_DATABASE_URL", URL)
        from app import tenancy, tenancy_provision
        tenancy_provision.adopt_public(ACCOUNT, "E2E Hospital", SYNC_SECRET)
        cls.db.execute(f'SET search_path TO "{tenancy.schema_for(ACCOUNT)}"')
        cls.servers: dict[str, subprocess.Popen] = {}
        for mode in PORTS:
            cls.start(mode)
        cls.worker = cls.load_worker()

    @classmethod
    def tearDownClass(cls):
        for process in cls.servers.values():
            process.terminate()
        for process in cls.servers.values():
            process.wait(timeout=10)
        cls.db.close()
        cls.leaf_db.close()
        REPORT.write_text(json.dumps({"finished_at": now(), "steps": cls.steps}, ensure_ascii=False, indent=2, default=str))

    @classmethod
    def start(cls, mode: str) -> None:
        env = {**os.environ, "FLORA_API_MODE": mode, "FLORA_LEAF_SERVICE_SECRET": LEAF_SECRET, "FLORA_SYNC_SHARED_SECRET": SYNC_SECRET,
               "FLORA_HIS_DEMO_MODE": "true", "FLORA_LEAF_ID": LEAF_ID, "FLORA_HOSPITAL_ID": HOSPITAL,
               "FLORA_CANOPY_SESSION_SECRET": CANOPY_SESSION_SECRET,
               "FLORA_CANOPY_SYNC_URL": f"http://127.0.0.1:{PORTS['sync']}"}
        if mode == "leaf":
            env["FLORA_LEAF_WRITE_API"] = "true"
            env["FLORA_DATABASE_URL"] = LEAF_URL
        cls.servers[mode] = subprocess.Popen([sys.executable, "-m", "uvicorn", "app.main:app", "--host", "127.0.0.1",
                                              "--port", str(PORTS[mode]), "--log-level", "warning"], env=env)
        for _ in range(150):
            try:
                if http(PORTS[mode], "/health")[0] == 200:
                    return
            except OSError:
                pass
            time.sleep(0.1)
        raise RuntimeError(f"{mode} API did not start")

    @classmethod
    def load_worker(cls) -> dict:
        """The real worker module without its endless loop (fresh state: as after a restart)."""
        os.environ.update({"FLORA_LEAF_API_URL": f"http://127.0.0.1:{PORTS['leaf']}", "FLORA_CANOPY_SYNC_URL": f"http://127.0.0.1:{PORTS['sync']}",
                           "FLORA_SYNC_SHARED_SECRET": SYNC_SECRET, "FLORA_LEAF_SERVICE_SECRET": LEAF_SECRET,
                           "FLORA_LEAF_ID": LEAF_ID, "FLORA_HOSPITAL_ID": HOSPITAL, "FLORA_LEAF_NAME": "E2E Leaf"})
        source = WORKER.read_text()
        source = source[:source.index("# Automatic sync every INTERVAL_SECONDS")]
        namespace: dict = {"__name__": "sync_worker_e2e"}
        exec(compile(source, str(WORKER), "exec"), namespace)
        return namespace

    # ------------------------------------------------------------ helpers

    def step(self, name: str, check) -> dict:
        started = time.monotonic()
        entry = {"step": len(self.steps) + 1, "name": name}
        try:
            detail = check() or {}
            entry.update(ok=True, detail=detail)
        except Exception as error:
            entry.update(ok=False, error=f"{type(error).__name__}: {error}", trace=traceback.format_exc()[-2500:])
            raise
        finally:
            entry["ms"] = round((time.monotonic() - started) * 1000)
            self.steps.append(entry)
        return entry["detail"]

    def cycle(self, *names: str) -> dict:
        """One sync worker pass (the named steps, in the worker's order)."""
        out = {}
        for name, function, _ in self.worker["STEPS"]:
            if not names or name in names:
                out[name] = function()
        return out

    def expect(self, status_body, status=200, what=""):
        code, body = status_body
        self.assertEqual(code, status, f"{what}: HTTP {code} {str(body)[:400]}")
        return body

    def leaf(self, path, body=None, method=None, **kw):
        return http(PORTS["leaf"], path, body, token=self.leaf_token, method=method, **kw)

    def canopy(self, path, body=None, method=None, **kw):
        return http(PORTS["canopy"], path, body, token=self.canopy_token, method=method, **kw)

    def leaf_form(self, case_id):
        state = self.expect(self.leaf(f"/api/case/{case_id}/workflow"), what="case workflow")
        return state, (state["forms"].get(FORM) or {}).get("record")

    # ------------------------------------------------------------ the loop

    def test_the_whole_loop(self):
        db = self.db
        password = secrets.token_urlsafe(18)
        username = "e2e_canopy_" + secrets.token_hex(3)
        leaf_username = "e2e_leaf_" + secrets.token_hex(3)

        def bootstrap():
            result = self.cycle("ward", "cases")
            node = db.execute("SELECT * FROM sync_leaf_node WHERE leaf_id=%s", (LEAF_ID,)).fetchone()
            self.assertIsNotNone(node, "the Leaf registered with Canopy")
            self.assertEqual(node["metadata"].get("protocol_version"), 2)
            at = now()
            ids = {}
            parent = None
            for kind, name in (("hospital", "E2E Hospital"), ("building", "E2E Building"), ("care_unit", "E2E Ward"),
                               ("room", "E2E OR"), ("bed", "E2E Bed 1")):
                parent = ids[kind] = db.execute(
                    """INSERT INTO canopy_location (parent_id, kind, name, created_at, updated_at) VALUES (%s,%s,%s,%s,%s) RETURNING id""",
                    (parent, kind, name, at, at)).fetchone()["id"]
            db.execute("""INSERT INTO canopy_leaf_assignment (leaf_id, bed_location_id, assigned_at, updated_at) VALUES (%s,%s,%s,%s)""",
                       (LEAF_ID, ids["bed"], at, at))
            for database, name in ((db, username), (self.leaf_db, leaf_username)):
                salt = secrets.token_bytes(16)
                hashed = hashlib.scrypt(password.encode(), salt=salt, n=16384, r=8, p=1, dklen=64).hex()
                user = database.execute("""INSERT INTO auth_user (username, name, role, password_salt, password_hash, is_active, all_units, created_at, updated_at)
                                           VALUES (%s,'E2E admin','admin',%s,%s,1,1,1,1) RETURNING id""", (name, salt.hex(), hashed)).fetchone()["id"]
                database.execute("INSERT INTO auth_user_role (user_id, role_code, created_at, updated_at) VALUES (%s,'system_admin',1,1) ON CONFLICT DO NOTHING", (user,))
            self.unit_key = str(ids["care_unit"])
            unit = db.execute("SELECT * FROM canopy_leaf_unit WHERE leaf_id=%s", (LEAF_ID,)).fetchone()
            self.assertEqual(unit["unit_key"], self.unit_key)
            return {"worker": result, "ward": unit["unit_name"], "unit_key": self.unit_key}
        self.step("Bootstrap: Leaf registers with Canopy (protocol 2), ward → room → bed → Leaf, an administrator", bootstrap)

        def sign_in():
            self.canopy_token = self.expect(http(PORTS["canopy"], "/api/auth/login", {"username": username, "password": password}),
                                            what="Canopy login")["session_token"]
            self.leaf_token = self.expect(http(PORTS["leaf"], "/api/auth/login", {"username": leaf_username, "password": password}),
                                          what="Leaf login")["session_token"]
            return {"canopy": "signed in", "leaf": "signed in"}
        self.step("Sign in on Canopy and on the Leaf", sign_in)

        def design():
            created = self.expect(self.canopy("/api/formdev/forms", {"definition": self.definition}), what="create form")
            published = self.expect(self.canopy(f"/api/formdev/forms/{FORM}/versions/1/publish", {}), what="publish")
            options = self.expect(self.canopy("/api/fleet/workflows/options"), what="workflow options")
            offered = next(item for item in options["forms"] if item["form_id"] == FORM)
            self.assertEqual(offered["published_version"], 1)
            self.assertEqual(offered.get("placement"), {"phase": "intraop", "after_section": "pacu"})
            types = sorted({f["type"] for s in self.definition["sections"] for f in s["fields"]}
                           | {c["type"] for s in self.definition["sections"] for f in s["fields"] for c in f.get("fields") or []})
            return {"created": created["version"]["status"], "published": published["version"]["status"], "field_types": len(types),
                    "placement offered to Workflow Studio": offered["placement"]}
        self.step("Form Studio: create the kitchen-sink form (23 field types) and publish v1", design)

        def workflow():
            definition = {"format": "flora-workflow/1", "id": WORKFLOW, "name": "E2E flow", "description": "end-to-end test",
                          "anesthesia_record": {"enabled": True, "sections": ["caseInfo", "preop", "checklist", "pacu", "outcome"], "optional_sections": []},
                          "forms": [{"form_id": FORM, "version": 1, "title": "E2E every field", "phase": "intraop", "required": True,
                                     "after_section": "pacu", "display": "tab", "hint": "Fill every field"}],
                          "packet": [{"kind": "anesthesia_report", "mode": "standard"}, {"kind": "form", "form_id": FORM}],
                          "billing": {"template_id": None}, "scores": []}
            self.expect(self.canopy("/api/fleet/workflows", {"definition": definition}), what="create workflow")
            published = self.expect(self.canopy(f"/api/fleet/workflows/{WORKFLOW}/publish", {}), what="publish workflow")
            wards = self.expect(self.canopy(f"/api/fleet/workflows/{WORKFLOW}/wards",
                                            {"wards": [{"unit_key": self.unit_key, "is_default": True, "sort_order": 0}]}, method="PUT"),
                                what="assign ward")
            return {"status": published["status"], "wards": wards["wards"]}
        self.step("Workflow Studio: workflow with the form as a required tab after PACU; publish; ward default", workflow)

        def admission():
            body = {"unit_key": self.unit_key, "hn": self.record["hn"], "patient": {"patient_name": self.record["full_name"], "sex": "female", "dob": "1970-01-02"},
                    "admission": {"workflow_id": WORKFLOW, "diagnosis": "E2E test", "operation": "E2E procedure"}}
            created = self.expect(self.canopy("/api/fleet/admissions", body), what="create admission")
            self.admission_id = created["row"]["id"]
            forms = self.expect(self.canopy(f"/api/fleet/admissions/{self.admission_id}/workflow-forms"), what="admission forms")
            self.assertEqual([item["ref"]["form_id"] for item in forms["forms"]], [FORM])
            patched = self.expect(self.canopy(f"/api/fleet/admissions/{self.admission_id}/workflow-forms/{FORM}",
                                              {"patch": {"full_name": self.record["full_name"], "notes": "filled on the ward tablet"}}, method="PATCH"),
                                  what="fill on tablet")
            return {"admission": self.admission_id, "pre-case copy": patched["record"]["caseKey"], "record_state": patched["record"]["recordState"]}
        self.step("Canopy admission with the workflow preset; the form filled on the ward tablet before the case", admission)

        def deliver():
            result = self.cycle("ward", "admissions")
            workflows = self.expect(self.leaf("/api/case/workflows"), what="Leaf workflows")
            row = next(item for item in workflows["rows"] if item["id"] == WORKFLOW)
            self.assertTrue(row["isDefault"])
            inbox = self.expect(self.leaf("/api/case/canopy-admissions"), what="prepared patients")
            self.assertIn(self.admission_id, [item["id"] for item in inbox["rows"]])
            return {"worker": result, "workflow on Leaf": row["name"], "default": row["isDefault"], "prepared patients": len(inbox["rows"])}
        self.step("Delivery: the ward exchange brings the workflow and its pinned form to the Leaf; the admission is offered", deliver)

        def start_case():
            started = self.expect(self.leaf("/api/case/start", {"start_time": now() - 60_000, "canopy_admission_id": self.admission_id,
                                                                  "workflow_id": WORKFLOW}), what="start case")
            self.case_id = started["case_id"]
            self.assertEqual(started["workflow_id"], WORKFLOW)
            return {"case_id": self.case_id, "case_code": started["case_code"], "workflow": started["workflow_id"]}
        self.step("Leaf: start the case from the prepared admission with the workflow", start_case)

        def admission_form_arrives():
            result = self.cycle("admissions", "case_forms")
            state, record = self.leaf_form(self.case_id)
            self.assertIsNotNone(record, "the form filled on the tablet is on the case")
            self.assertEqual(record["data"]["notes"], "filled on the ward tablet")
            self.assertEqual(record["authors"]["notes"]["via"], "canopy")
            ref = next(item for item in state["workflow"]["forms"] if item["form_id"] == FORM)
            return {"worker": result["case_forms"], "data from the tablet": record["data"], "tab": ref["title"], "after": ref["after_section"]}
        self.step("Case forms: the tablet's pre-case form becomes the case's form on the Leaf (field by field)", admission_form_arrives)

        def fill():
            for sha, item in self.files.items():
                self.expect(self.leaf(f"/api/case/{self.case_id}/workflow-forms-files/{sha}", raw=base64.b64decode(item["base64"]),
                                      method="PUT", content_type=item["mime"]), what="upload file")
            data = {key: value for key, value in self.record.items() if key != "consent"}
            saved = self.expect(self.leaf(f"/api/case/{self.case_id}/workflow-forms/{FORM}", {"patch": data}, method="PATCH"), what="save")
            self.assertEqual(saved["record"]["status"], "draft")
            refused = self.leaf(f"/api/case/{self.case_id}/workflow-forms/{FORM}", {"patch": {}, "status": "completed"}, method="PATCH")
            self.assertEqual(refused[0], 422, "completing without the required consent is refused")
            paths = [issue["path"] for issue in refused[1]["issues"]]
            self.assertTrue(any("consent" in path for path in paths), paths)
            done = self.expect(self.leaf(f"/api/case/{self.case_id}/workflow-forms/{FORM}", {"patch": {"consent": True}, "status": "completed"},
                                         method="PATCH"), what="complete")
            self.assertEqual(done["record"]["status"], "completed")
            return {"fields saved": len(data) + 1, "refused completion issues": refused[1]["issues"], "status": done["record"]["status"],
                    "authors": sorted({a["by"] for a in done["record"]["authors"].values()})}
        self.step("Leaf: every field type filled (file stored on the Leaf); completion checked with Form Studio's rules", fill)

        def back_to_canopy():
            result = self.cycle("case_forms")
            _, record = self.leaf_form(self.case_id)
            sync = record["sync"]
            if sync["state"] == "waiting_files":  # files went up after this exchange; the next one stores the record
                result = self.cycle("case_forms")
                _, record = self.leaf_form(self.case_id)
                sync = record["sync"]
            self.assertEqual((sync["state"], sync["current"]), ("stored", True), sync)
            sha = next(iter(self.files))
            in_canopy = db.execute("SELECT size FROM formdev_attachment WHERE sha256=%s", (sha,)).fetchone()
            self.assertIsNotNone(in_canopy, "the Leaf's file reached Canopy's store")
            self.record_id = sync["recordId"]
            stored = self.expect(self.canopy(f"/api/formdev/records/{self.record_id}"), what="Form Studio record")["record"]
            self.assertEqual(stored["status"], "submitted")
            for key in ("hn", "full_name", "aldrete", "trends", "lines", "photo", "nurse_signature", "symptoms", "_other"):
                self.assertEqual(stored["data"].get(key), {**self.record, "notes": "every field type"}.get(key), key)
            self.assertEqual(stored["data"]["bmi"], 24.0, "calculated by Canopy")
            self.assertTrue(stored["updated_by"].endswith(f"@{LEAF_ID}"))
            links = self.expect(self.canopy(f"/api/formdev/leaf-links?form_id={FORM}"), what="leaf links")["links"]
            self.assertEqual(links[self.record_id]["hn"], self.record["hn"])
            sha = next(iter(self.files))
            file_status = self.canopy(f"/api/formdev/attachments/{sha}?record_id={self.record_id}")[0]
            return {"worker": result["case_forms"], "receipt": sync, "record": self.record_id, "status": stored["status"],
                    "updated_by": stored["updated_by"], "bmi (Canopy)": stored["data"]["bmi"], "file in Canopy": file_status}
        self.step("Back to Canopy: receipt on the Leaf, a submitted Form Studio record with every value, the file, the author", back_to_canopy)

        def amend():
            record = self.expect(self.canopy(f"/api/formdev/records/{self.record_id}"), what="record")["record"]
            op = {"op_id": secrets.token_hex(8), "kind": "update", "record_id": self.record_id, "form_id": FORM, "schema_version": 1,
                  "base_version": record["version"], "data": {**record["data"], "notes": "corrected in Canopy"}, "status": record["status"],
                  "client_updated_at": now()}
            refused = self.expect(self.canopy("/api/formdev/sync", {"ops": [op]}), what="sync")["acks"][0]
            self.assertEqual((refused["status"], refused["error"]["code"]), ("rejected", "amendment_reason_required"))
            applied = self.expect(self.canopy("/api/formdev/sync", {"ops": [{**op, "op_id": secrets.token_hex(8), "reason": "Wording per the physician"}]}),
                                  what="sync")["acks"][0]
            self.assertEqual(applied["status"], "applied")
            link = self.expect(self.canopy(f"/api/formdev/leaf-links/{self.record_id}"), what="link")
            self.assertEqual(link["amendments"][0]["reason"], "Wording per the physician")
            self.assertEqual(sorted(link["amendments"][0]["changes"]), ["notes"], "only what the reviewer changed (not the calculated BMI)")
            return {"without reason": refused["error"]["code"], "with reason": applied["status"], "amendment": link["amendments"][0],
                    "pending to Leaf": link["link"]["pendingToLeaf"]}
        self.step("Canopy: changing a Leaf form needs a reason (amendment); it is recorded", amend)

        def amendment_reaches_leaf():
            first = self.cycle("case_forms")["case_forms"]
            _, record = self.leaf_form(self.case_id)
            self.assertEqual(record["data"]["notes"], "corrected in Canopy")
            self.assertEqual(record["authors"]["notes"]["reason"], "Wording per the physician")
            self.assertEqual(record["status"], "completed", "the Leaf's completion stands")
            second = self.cycle("case_forms")["case_forms"]
            self.assertEqual(second.get("received", 0), 0, "a confirmed change is not sent again")
            link = self.expect(self.canopy(f"/api/formdev/leaf-links/{self.record_id}"), what="link")["link"]
            self.assertFalse(link["pendingToLeaf"])
            self.cycle("cases")
            index = db.execute("SELECT global_case_id FROM sync_case_index WHERE leaf_id=%s AND source_case_id=%s",
                               (LEAF_ID, str(self.case_id))).fetchone()
            review = self.expect(self.canopy(f"/api/fleet/cases/{index['global_case_id']}/forms"), what="case forms review")["forms"]
            self.assertEqual([item["formId"] for item in review], [FORM])
            self.assertEqual(review[0]["definition"]["form_id"], FORM)
            self.assertEqual(review[0]["data"]["notes"], "corrected in Canopy")
            self.assertEqual(review[0]["amendments"][0]["reason"], "Wording per the physician")
            self.gcid = str(index["global_case_id"])
            base = f"/api/fleet/cases/{self.gcid}/forms/{FORM}"
            premature = self.canopy(f"{base}/review", {"action": "approved"})
            self.assertEqual(premature[0], 409, f"approval needs a review first: {premature[1]}")
            self.expect(self.canopy(f"{base}/review", {"action": "reviewed", "note": "Checked against the chart"}), what="review")
            approved = self.expect(self.canopy(f"{base}/review", {"action": "approved"}), what="approve")["review"]
            self.assertEqual(approved["state"], "approved")
            history = self.expect(self.canopy(f"{base}/history"), what="history")["history"]
            self.assertEqual([item["kind"] for item in history][:2], ["approved", "reviewed"])
            return {"first pass": first, "second pass": second, "on the Leaf": record["authors"]["notes"],
                    "Canopy case review": {"forms": len(review), "status": review[0]["status"], "receipt": review[0]["recordState"],
                                           "amendments": len(review[0]["amendments"])}}
        self.step("The amendment reaches the Leaf with who/why; not re-sent; Canopy case review: Reviewed → Approved, with history", amendment_reaches_leaf)

        def print_templates():
            templates = self.expect(self.leaf(f"/api/case/{self.case_id}/report-templates"), what="report templates")["templates"]
            mine = next(item for item in templates if item["form_id"] == FORM)
            self.assertEqual(mine["source"], "case")
            self.assertEqual(mine["record"]["data"]["notes"], "corrected in Canopy")
            return {"templates": [(item["form_id"], item["source"], item["display"]) for item in templates]}
        self.step("Leaf Reports: the form is offered to print with the case's data", print_templates)

        def outage():
            self.servers["sync"].terminate()
            self.servers["sync"].wait(timeout=10)
            refused = self.leaf(f"/api/case/{self.case_id}/workflow-forms/{FORM}", {"patch": {"contact_name": "Kin (offline)"}}, method="PATCH")
            self.assertEqual((refused[0], refused[1].get("code")), (422, "amendment_reason_required"), "a completed form changes by amendment")
            saved = self.expect(self.leaf(f"/api/case/{self.case_id}/workflow-forms/{FORM}", {"patch": {"contact_name": "Kin (offline)"},
                                                                                              "reason": "Contact updated by the family"},
                                          method="PATCH"), what="amend offline")
            self.assertEqual(saved["record"]["authors"]["contact_name"]["reason"], "Contact updated by the family")
            errors = []
            for name in ("ward", "cases", "case_forms"):
                try:
                    self.cycle(name)
                except Exception as error:
                    errors.append(f"{name}: {type(error).__name__}")
            self.assertTrue(errors, "the worker could not reach Canopy")
            pending = saved["record"]["sync"]
            self.start("sync")
            caught_up = self.cycle("ward", "cases", "case_forms")
            _, record = self.leaf_form(self.case_id)
            self.assertEqual((record["sync"]["state"], record["sync"]["current"]), ("stored", True))
            stored = self.expect(self.canopy(f"/api/formdev/records/{self.record_id}"), what="record")["record"]
            self.assertEqual(stored["data"]["contact_name"], "Kin (offline)")
            review = self.expect(self.canopy(f"/api/fleet/cases/{self.gcid}/forms"), what="review")["forms"][0]["review"]
            self.assertEqual(review["state"], "changed_since_review", "an approval holds only for the copy approved")
            return {"while Canopy was down": {"saved on Leaf": True, "receipt": pending, "worker": errors}, "after": caught_up}
        self.step("Canopy unreachable: the Leaf keeps saving (an amendment of the completed form, with its reason); the worker catches up", outage)

        def restart():
            before = self.leaf_db.execute("SELECT * FROM leaf_sync_case WHERE case_id=%s", (self.case_id,)).fetchone()
            self.worker = self.load_worker()  # fresh process state
            result = self.cycle("cases")
            after = self.leaf_db.execute("SELECT * FROM leaf_sync_case WHERE case_id=%s", (self.case_id,)).fetchone()
            self.assertIsNotNone(before["snapshot_digest"])
            self.assertIsNone(after["last_error"])
            return {"worker after restart": result["cases"], "kept digest": before["snapshot_digest"] is not None}
        self.step("Worker restart: state is read from the Leaf database (no full re-send)", restart)

        def close_case():
            self.expect(self.leaf("/api/case/discharge", {"case_id": self.case_id}), what="discharge")
            self.expect(self.leaf("/api/case/archive", {"case_id": self.case_id}), what="archive")
            result = self.cycle("cases", "case_forms")
            index = db.execute("SELECT status FROM sync_case_index WHERE leaf_id=%s AND source_case_id=%s", (LEAF_ID, str(self.case_id))).fetchone()
            self.assertEqual(index["status"], "ARCHIVED")
            refused = self.leaf(f"/api/case/{self.case_id}/workflow-forms/{FORM}", {"patch": {"notes": "x"}}, method="PATCH")
            self.assertEqual(refused[0], 409)
            again = self.cycle("cases")["cases"]
            return {"Canopy index": index["status"], "edit after archive": refused[0], "sent again after archive": again}
        self.step("Discharge and archive: Canopy gets the archived case once; the form is read-only", close_case)

        def attach_to_open_case():
            started = self.expect(self.leaf("/api/case/start", {"start_time": now(), "hn": "E2E0002", "admission_source": "manual",
                                                                  "patient_name": "Second patient"}), what="start without workflow")
            case_id = started["case_id"]
            empty = self.expect(self.leaf(f"/api/case/{case_id}/workflow"), what="workflow")
            self.assertIsNone(empty["workflow"])
            attached = self.expect(self.leaf(f"/api/case/{case_id}/workflow", {"workflow_id": WORKFLOW}, method="PUT"), what="attach")
            self.assertIn(FORM, attached["forms"])
            self.expect(self.leaf(f"/api/case/{case_id}/workflow-forms/{FORM}", {"patch": {"hn": "E2E0002", "full_name": "Second patient"}},
                                  method="PATCH"), what="fill")
            self.cycle("case_forms")
            _, record = self.leaf_form(case_id)
            self.assertEqual(record["sync"]["state"], "stored")
            audit = self.leaf_db.execute("SELECT 1 FROM case_clinical_audit WHERE case_id=%s AND action='workflow.attach'", (case_id,)).fetchone()
            self.assertIsNotNone(audit)
            self.expect(self.leaf("/api/case/discharge", {"case_id": case_id}), what="discharge")
            return {"case": case_id, "attached": attached["workflow"]["id"], "receipt": record["sync"]["state"], "audited": True}
        self.step("A workflow attached to a case already open; its form filled and stored in Canopy", attach_to_open_case)

        def summary():
            rows = db.execute("SELECT case_key, form_id, record_state, leaf_state, canopy_rev > leaf_rev AS pending FROM canopy_case_form ORDER BY created_at").fetchall()
            self.assertTrue(all(row["record_state"] == "stored" for row in rows), rows)
            self.assertFalse(any(row["pending"] for row in rows))
            leaf_rows = self.leaf_db.execute("SELECT case_id, form_id, sync_state, status FROM case_form_record ORDER BY case_id").fetchall()
            return {"canopy_case_form": rows, "case_form_record": leaf_rows,
                    "amendments": db.execute("SELECT count(*) AS n FROM canopy_case_form_amendment").fetchone()["n"]}
        self.step("Final state: every case form stored in Form Studio, nothing pending either way", summary)


if __name__ == "__main__":
    unittest.main()
