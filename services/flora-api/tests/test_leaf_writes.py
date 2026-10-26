"""HTTP checks against a disposable PostgreSQL database with no patient data.

Run inside the API image with FLORA_DATABASE_URL pointing to a database ending
in _test. The schema must already exist. Test rows are rolled back or retained
only in this disposable database, never in the Leaf database.
"""
import concurrent.futures
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

URL = os.environ["FLORA_DATABASE_URL"]
if not urlparse(URL).path.endswith("_test"):
    raise RuntimeError("Write tests require a dedicated database ending in _test")
os.environ["FLORA_LEAF_WRITE_API"] = "true"
os.environ["FLORA_API_MODE"] = "leaf"
os.environ["FLORA_HIS_DEMO_MODE"] = "true"
BASE = "http://127.0.0.1:8008"


def request(path, body=None, token=None, method=None, pin=None):
    headers = {"Content-Type": "application/json"}
    if token:
        headers["X-FLORA-Session"] = token
    if pin:
        # Leaf user-management writes need an administrator's PIN (routes/auth_leaf.py pin_approval).
        headers["X-Flora-Admin-Pin"] = pin
    req = urllib.request.Request(BASE + path, data=json.dumps(body).encode() if body is not None else None,
                                 headers=headers, method=method or ("POST" if body is not None else "GET"))
    try:
        with urllib.request.urlopen(req, timeout=10) as response:
            return response.status, json.load(response)
    except urllib.error.HTTPError as error:
        return error.code, json.load(error)


class LeafWrites(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.database = psycopg.connect(URL, autocommit=True, row_factory=dict_row)
        cls.suffix = secrets.token_hex(6)
        cls.username = "migration_test_" + cls.suffix
        cls.password = secrets.token_urlsafe(18)
        # Same scrypt parameters and binary hex salt as the legacy account records.
        salt = secrets.token_bytes(16)
        hashed = hashlib.scrypt(cls.password.encode(), salt=salt, n=16384,r=8,p=1,dklen=64).hex()
        cls.user_id = cls.database.execute(
            """INSERT INTO auth_user(username,name,role,password_salt,password_hash,is_active,created_at,updated_at)
               VALUES (%s,'Migration test','admin',%s,%s,1,1,1) RETURNING id""",
            (cls.username,salt.hex(),hashed),
        ).fetchone()["id"]
        # The test administrator approves user-management writes with its own PIN, set as the app sets it.
        cls.database.execute(
            """INSERT INTO auth_user_role(user_id,role_code,created_at,updated_at)
               VALUES (%s,'system_admin',1,1) ON CONFLICT DO NOTHING""", (cls.user_id,))
        from app import directory
        cls.pin = str(10_000_000 + secrets.randbelow(89_999_999))
        directory.set_admin_pin(cls.database, cls.user_id, cls.pin)
        for code in ("urine", "bloodLoss"):
            cls.database.execute(
                """INSERT INTO io_item_master(kind,code,name,default_unit,is_active,created_at,updated_at)
                   VALUES ('output',%s,%s,'mL',1,1,1) ON CONFLICT (code) DO NOTHING""",(code,code),
            )
        cls.server = subprocess.Popen([sys.executable,"-m","uvicorn","app.main:app","--host","127.0.0.1","--port","8008","--log-level","warning"])
        for _ in range(100):
            try:
                if request("/health")[0] == 200:
                    break
            except OSError:
                time.sleep(.1)
        else:
            cls.server.terminate()
            raise RuntimeError("Test API failed to start")

    def setUp(self):
        # Every test starts without an active case, whatever an earlier test left behind.
        token = self.login()
        for case in request("/api/case/active", token=token)[1].get("cases", []):
            ends = max(int(case["start_time"]) + 60_000, int(time.time() * 1000))
            request("/api/case/discharge", {"case_id": case["case_id"], "discharge_time": ends}, token)
            request("/api/case/archive", {"case_id": case["case_id"]}, token)

    @classmethod
    def tearDownClass(cls):
        cls.server.terminate()
        cls.server.wait(timeout=10)
        cls.database.close()

    def login(self):
        status,result = request("/api/auth/login",{"username":self.username,"password":self.password})
        self.assertEqual(status,200,result)
        return result["session_token"]

    def test_demo_his_exchange_patients(self):
        token = self.login()
        status, catalog = request("/api/case/his/demo-patients", token=token)
        self.assertEqual(status, 200, catalog)
        self.assertTrue(catalog["enabled"])
        self.assertEqual(
            {row["protocol"] for row in catalog["rows"]},
            {"HL7_V2_ADT", "FHIR_R4", "IHE_PDQm"},
        )
        self.assertTrue(all(row["sample"] for row in catalog["rows"]))
        self.assertTrue(all(row["encounter"]["service"] for row in catalog["rows"]))
        for patient in catalog["rows"]:
            status, lookup = request("/api/case/his/lookup", {"hn": patient["hn"]}, token)
            self.assertEqual(status, 200, lookup)
            self.assertEqual(lookup["source"], "DEMO_HIS")
            self.assertEqual(lookup["exchange"]["protocol"], patient["protocol"])
            self.assertTrue(lookup["exchange"]["synthetic"])
            self.assertEqual(lookup["row"]["hn"], patient["hn"])

    def test_configurable_staff_profile(self):
        token = self.login()
        status, fields = request("/api/case/staff/fields?include_inactive=true", token=token)
        self.assertEqual(status, 200, fields)
        self.assertIn("middle_name", {row["field_key"] for row in fields["rows"]})

        field_key = "credential_" + self.suffix
        status, created = request("/api/case/staff/fields", {
            "field_key": field_key,
            "label": "Professional credential",
            "field_type": "text",
            "is_required": 0,
            "is_active": 1,
            "sort_order": 90,
        }, token)
        self.assertEqual(status, 200, created)

        self.database.execute(
            "INSERT INTO staff_role(id,display_name,sort_order) VALUES ('anesthetist','Anesthetist',1) ON CONFLICT (id) DO NOTHING"
        )
        status, roles = request("/api/case/staff/roles", token=token)
        self.assertEqual(status, 200, roles)
        role = roles["rows"][0]
        staff_name = "Ada M. Lovelace " + self.suffix
        profile = {
            "display_name": staff_name,
            "given_name": "Ada",
            "middle_name": "M.",
            "family_name": "Lovelace",
            field_key: "MD",
        }
        status, staff = request("/api/case/staff/directory", {
            # Doctors and nurses need a staff code (Canopy staff sync, 0085-staff-sync.sql).
            "staff": {"role_id": role["id"], "staff_code": "T" + self.suffix, "profile_data": profile}
        }, token)
        self.assertEqual(status, 200, staff)
        self.assertEqual(staff["row"]["staff_name"], staff_name)
        self.assertEqual(staff["row"]["profile_data"]["middle_name"], "M.")
        self.assertEqual(staff["row"]["profile_data"][field_key], "MD")

        status, linked = request(
            f"/api/auth/users/{self.user_id}/staff-link",
            {"staff_directory_id": staff["row"]["id"]}, token, "PUT", pin=self.pin,
        )
        self.assertEqual(status, 200, linked)
        self.assertEqual(linked["row"]["staffDirectoryId"], staff["row"]["id"])

        status, disabled = request(
            f'/api/case/staff/fields/{created["row"]["id"]}', token=token, method="DELETE"
        )
        self.assertEqual(status, 200, disabled)

    def test_clinical_code_searches_match_the_imported_catalog_schema(self):
        token = self.login()
        status, diagnoses = request("/api/case/icd10/search?q=lung&limit=15", token=token)
        self.assertEqual(status, 200, diagnoses)
        self.assertIn("rows", diagnoses)
        status, procedures = request("/api/case/icd9/search?q=lung&limit=15", token=token)
        self.assertEqual(status, 200, procedures)
        self.assertIn("rows", procedures)

    def test_auth_session_and_access(self):
        status,options = request("/api/auth/preferences/options")
        self.assertEqual(status,200,options)
        self.assertEqual({item["code"] for item in options["languages"]},{"en","th"})
        active_themes = self.database.execute("SELECT count(*) AS n FROM theme_scheme_master WHERE is_active=1").fetchone()["n"]
        self.assertGreater(active_themes, 0)
        self.assertEqual(len(options["themes"]), active_themes)
        self.assertEqual(request("/api/auth/login",{"username":self.username,"password":"wrong"})[0],401)
        self.assertEqual(request("/api/auth/whoami")[0],401)
        token = self.login()
        status,user = request("/api/auth/whoami",token=token)
        self.assertEqual(status,200)
        self.assertEqual(user["user"]["username"],self.username)
        stored = self.database.execute("SELECT token_hash FROM auth_session WHERE user_id=%s ORDER BY id DESC LIMIT 1",(self.user_id,)).fetchone()
        self.assertEqual(stored["token_hash"],hashlib.sha256(token.encode()).hexdigest())
        self.assertEqual(request("/api/auth/self/preferences",{
            "name":"Migration Test Account", "theme_mode":"dark", "theme_color":"warm", "language_code":"th",
            "parameter_preferences":{"timeScaleMin":10,"visibleParameters":["hr","spo2"]},
            "report_preferences":{"patient":True,"chart":True,"forms":False},
        },token,"PUT")[0],200)
        preferences = request("/api/auth/whoami",token=token)[1]["user"]
        self.assertEqual(preferences["themeColor"],"warm")
        self.assertEqual(preferences["languageCode"],"th")
        self.assertEqual(preferences["name"],"Migration Test Account")
        self.assertEqual(preferences["parameterPreferences"]["timeScaleMin"],10)
        self.assertFalse(preferences["reportPreferences"]["forms"])
        self.assertEqual(request("/api/auth/self/preferences",{"theme_mode":"dark","theme_color":"invalid"},token,"PUT")[0],400)
        self.assertEqual(request("/api/auth/self/preferences",{"language_code":"invalid"},token,"PUT")[0],400)
        self.assertEqual(request("/api/auth/logout",{},token)[0],200)
        self.assertEqual(request("/api/auth/whoami",token=token)[0],401)

    def test_access_rbac_user_creation_and_enforcement(self):
        admin_token = self.login()
        status, roles = request("/api/auth/roles", token=admin_token)
        self.assertEqual(status, 200, roles)
        self.assertEqual(
            {"system_admin", "clinical_admin", "clinician", "physician", "viewer", "integration"},  # physician: 0100
            {row["code"] for row in roles["rows"]},
        )
        username = "viewer_" + self.suffix
        password = "Demo-" + self.password
        # Without an administrator's PIN a Leaf may not create accounts.
        refused = request("/api/auth/users", {"username": "nopin_" + self.suffix, "name": "No PIN", "password": "Demo-" + self.password,
                                              "role_codes": ["viewer"], "language_code": "en"}, admin_token)
        self.assertEqual(refused, (403, {"error": "admin PIN required"}))
        status, created = request("/api/auth/users", {
            "username": username,
            "name": "Read-only reviewer",
            "password": password,
            "role_codes": ["viewer"],
            "language_code": "en",
        }, admin_token, pin=self.pin)
        self.assertEqual(status, 200, created)
        self.assertEqual(created["row"]["roleCodes"], ["viewer"])
        self.assertTrue(created["row"]["mustChangePassword"])

        status, login = request("/api/auth/login", {"username": username, "password": password})
        self.assertEqual(status, 200, login)
        viewer_token = login["session_token"]
        self.assertIn("case.read", login["user"]["permissions"])
        self.assertNotIn("case.chart", login["user"]["permissions"])
        check_time = int(time.time() * 1000)
        self.assertEqual(request("/api/case/start-overlap-check", {"start_time": check_time}, viewer_token)[0], 403)
        changed_password = password + "-changed"
        self.assertEqual(request("/api/auth/self/change-password", {
            "current_password": password, "new_password": changed_password,
        }, viewer_token)[0], 200)

        status, updated = request(
            f"/api/auth/users/{created['row']['id']}/access",
            {"role_codes": ["clinician"]}, admin_token, "PUT", pin=self.pin,
        )
        self.assertEqual(status, 200, updated)
        self.assertIn("case.chart", updated["row"]["permissions"])
        self.assertEqual(request("/api/case/start-overlap-check", {"start_time": check_time}, viewer_token)[0], 200)
        self.assertEqual(
            request(f"/api/auth/users/{self.user_id}/access", {"role_codes": ["viewer"]}, admin_token, "PUT", pin=self.pin)[0],
            400,
        )

    def test_configuration_workstation_context(self):
        token = self.login()
        status, masters = request("/api/auth/preferences/master", token=token)
        self.assertEqual(status, 200, masters)
        self.assertGreaterEqual(len(masters["languages"]), 2)
        self.assertEqual(len(masters["themes"]), self.database.execute("SELECT count(*) AS n FROM theme_scheme_master").fetchone()["n"])
        language = masters["languages"][0]
        status, saved_language = request(
            f"/api/auth/preferences/languages/{language['code']}",
            {"name_en": language["name_en"], "name_native": language["name_native"],
             "is_active": bool(language["is_active"]), "sort_order": language["sort_order"]},
            token, "PUT",
        )
        self.assertEqual(status, 200, saved_language)
        theme = masters["themes"][0]
        colors = [theme[f"color_{index}_{name}"] for index, name in enumerate(
            ("canvas", "surface", "border", "text", "muted", "accent"), start=1)]
        status, saved_theme = request(
            f"/api/auth/preferences/themes/{theme['code']}",
            {"display_name": theme["display_name"], "colors": colors,
             "is_active": bool(theme["is_active"]), "sort_order": theme["sort_order"]},
            token, "PUT",
        )
        self.assertEqual(status, 200, saved_theme)
        language_code = "zz-" + self.suffix[:4]
        status, created_language = request("/api/auth/preferences/languages", {
            "code": language_code, "name_en": "Test language", "name_native": "Test",
            "is_active": True, "sort_order": 999,
        }, token)
        self.assertEqual(status, 200, created_language)
        status, saved_words = request(f"/api/auth/preferences/translations/{language_code}", {
            "values": {"login.title": "Test sign in"},
        }, token, "PUT")
        self.assertEqual(status, 200, saved_words)
        self.assertEqual(request(f"/api/auth/preferences/translations/{language_code}")[1]["values"]["login.title"], "Test sign in")
        self.assertEqual(request(f"/api/auth/preferences/languages/{language_code}", token=token, method="DELETE")[0], 200)
        theme_code = "test-" + self.suffix[:6]
        status, created_theme = request("/api/auth/preferences/themes", {
            "code": theme_code, "display_name": "Test scheme", "colors": colors,
            "is_active": True, "sort_order": 999,
        }, token)
        self.assertEqual(status, 200, created_theme)
        self.assertEqual(request(f"/api/auth/preferences/themes/{theme_code}", token=token, method="DELETE")[0], 200)
        status, current = request("/api/workstation/context")
        self.assertEqual(status, 200, current)
        self.assertIn("hospitalName", current)
        payload = {
            "hospitalName": "Test Hospital",
            "buildingName": "Building A",
            "careUnitName": "Operating Theatre",
            "roomName": "OR 1",
            "bedName": "Table 1",
            "timezone": "Asia/Bangkok",
            "dateFormat": "DD/MM/YYYY",
            "timeFormat": "12h",
        }
        status, saved = request("/api/workstation/context", payload, token, "PUT")
        self.assertEqual(status, 200, saved)
        self.assertEqual(saved["roomName"], "OR 1")
        self.assertEqual(saved["dateFormat"], "DD/MM/YYYY")
        self.assertEqual(saved["timeFormat"], "12h")
        self.assertGreater(saved["updatedAt"], 0)

    def test_clinical_terminology_registry(self):
        token = self.login()
        status, releases = request("/api/config/terminology/releases", token=token)
        self.assertEqual(status, 200, releases)
        counts = {row["system_key"]: row["entry_count"] for row in releases["rows"]}
        self.assertGreater(counts.get("ICD_10_WHO", 0), 10000)
        self.assertEqual(counts.get("ICD_9_CM"), 3882)
        self.assertEqual(counts.get("UCUM"), 312)
        status, catalog = request("/api/config/terminology/catalog/search?domain=procedure&q=ultrasound&limit=5", token=token)
        self.assertEqual(status, 200, catalog)
        self.assertTrue(catalog["rows"])
        self.assertTrue(all(row["domain"] == "procedure" for row in catalog["rows"]))
        status, diagnoses = request("/api/config/terminology/catalog/search?domain=diagnosis&q=cholera&limit=5", token=token)
        self.assertEqual(status, 200, diagnoses)
        self.assertTrue(any(row["system_key"] == "ICD_10_WHO" for row in diagnoses["rows"]))
        materialized = self.database.execute(
            """SELECT domain,count(*) AS total
               FROM clinical_concept
               WHERE is_active=1 AND ((domain='diagnosis' AND local_id LIKE 'icd10-%')
                 OR (domain='procedure' AND local_id LIKE 'icd9cm-%'))
               GROUP BY domain"""
        ).fetchall()
        self.assertEqual({row["domain"]: row["total"] for row in materialized}, {
            "diagnosis": counts["ICD_10_WHO"],
            "procedure": counts["ICD_9_CM"],
        })
        cholera = self.database.execute(
            """SELECT concept.local_name,coding.code,coding.terminology_entry_id
               FROM clinical_concept concept
               JOIN clinical_concept_coding coding ON coding.concept_id=concept.id
               WHERE concept.domain='diagnosis' AND concept.local_id='icd10-a00' AND coding.system_key='ICD_10'"""
        ).fetchone()
        self.assertEqual(cholera["local_name"], "Cholera")
        self.assertEqual(cholera["code"], "A00")
        self.assertIsNotNone(cholera["terminology_entry_id"])
        status, listing = request("/api/config/terminology?domain=observation&include_inactive=true", token=token)
        self.assertEqual(status, 200, listing)
        self.assertTrue(any(row["local_id"] == "hr" for row in listing["rows"]))
        local_id = "test-diagnosis-" + self.suffix
        status, created = request("/api/config/terminology", {
            "domain": "diagnosis", "local_id": local_id, "local_name": "Synthetic local diagnosis",
            "snomed_id": "123456789", "snomed_name": "Synthetic SNOMED display", "icd10_id": "Z99.9",
        }, token)
        self.assertEqual(status, 200, created)
        concept = created["row"]
        self.assertEqual(concept["local_name"], "Synthetic local diagnosis")
        self.assertEqual(concept["snomed_id"], "123456789")
        self.assertEqual(concept["icd10_id"], "Z99.9")
        concept["local_name"] = "Updated local diagnosis"
        status, updated = request(f"/api/config/terminology/{concept['id']}", concept, token, "PUT")
        self.assertEqual(status, 200, updated)
        self.assertEqual(updated["row"]["local_name"], "Updated local diagnosis")
        self.assertEqual(request(f"/api/config/terminology/{concept['id']}", {}, token, "DELETE")[0], 200)
        stored = self.database.execute("SELECT is_active FROM clinical_concept WHERE id=%s", (concept["id"],)).fetchone()
        self.assertEqual(stored["is_active"], 0)

    def test_io_group_master(self):
        token = self.login()
        status, listing = request("/api/case/io/groups?kind=med&include_inactive=true", token=token)
        self.assertEqual(status, 200, listing)
        self.assertTrue(any(row["code"] == "opioid" for row in listing["rows"]))
        code = "testGroup" + self.suffix
        status, created = request("/api/case/io/groups", {
            "code": code, "display_name": "Test medication group", "kind": "med",
            "is_active": 1, "sort_order": 999,
        }, token)
        self.assertEqual(status, 200, created)
        group = created["row"]
        status, item = request("/api/case/io/master", {
            "kind": "med", "name": "Test grouped medication " + self.suffix,
            "default_unit": "mg", "group_id": group["id"],
        }, token)
        self.assertEqual(status, 200, item)
        self.assertEqual(item["row"]["group_id"], group["id"])
        self.assertEqual(item["row"]["category"], group["code"])
        concept_code = "test-med-concept-" + self.suffix
        status, concept_result = request("/api/config/terminology", {
            "domain": "medication", "local_id": concept_code,
            "local_name": "Test clinical medication " + self.suffix,
            "group_id": group["id"], "default_unit": "mcg", "is_active": 1,
            "snomed_id": "123456", "rxnorm_id": "654321",
        }, token)
        self.assertEqual(status, 200, concept_result)
        self.assertEqual(concept_result["row"]["group_id"], group["id"])
        linked_item = self.database.execute(
            "SELECT group_id,default_unit,category FROM io_item_master WHERE concept_id=%s",
            (concept_result["row"]["id"],),
        ).fetchone()
        self.assertEqual(linked_item["group_id"], group["id"])
        self.assertEqual(linked_item["default_unit"], "mcg")
        self.assertEqual(request(f"/api/case/io/groups/{group['id']}", token=token, method="DELETE")[0], 200)

    def test_admission_modes(self):
        token = self.login()
        emergency_start = 1740000000000
        status, emergency = request("/api/case/start", {
            "hn":"", "start_time":emergency_start, "admission_source":"emergency"
        }, token)
        self.assertEqual(status,200,emergency)
        self.assertTrue(emergency["hn"].startswith("EMG-"))
        emergency_row = self.database.execute(
            "SELECT admission_source,identity_status,admitted_by FROM cases WHERE id=%s",
            (emergency["case_id"],),
        ).fetchone()
        self.assertEqual(emergency_row["admission_source"],"emergency")
        self.assertEqual(emergency_row["identity_status"],"pending")
        self.assertEqual(emergency_row["admitted_by"],self.username)
        status, masters = request("/api/config/terminology?domain=procedure&q=ultrasound&include_inactive=false&limit=1", token=token)
        self.assertEqual(status, 200, masters)
        master = masters["rows"][0]
        standard = master["codings"]["ICD_9_CM"]
        self.assertIsNotNone(standard["terminology_entry_id"])
        status, procedure = request(f"/api/case/{emergency['case_id']}/procedures", {
            "procedure_text": master["local_name"],
            "concept_id": master["id"],
            "local_id": master["local_id"],
            "terminology_entry_id": standard["terminology_entry_id"],
        }, token)
        self.assertEqual(status, 200, procedure)
        self.assertEqual(procedure["row"]["concept_id"], master["id"])
        self.assertEqual(procedure["row"]["coding_snapshot"]["local_id"], master["local_id"])
        self.assertEqual(procedure["row"]["coding_snapshot"]["terminology_entry_id"], standard["terminology_entry_id"])
        self.assertEqual(procedure["row"]["coding_snapshot"]["terminology_system"], "ICD_9_CM")
        coding = self.database.execute(
            "SELECT terminology_entry_id FROM clinical_concept_coding WHERE concept_id=%s AND system_key='ICD_9_CM'",
            (procedure["row"]["concept_id"],),
        ).fetchone()
        self.assertEqual(coding["terminology_entry_id"], standard["terminology_entry_id"])
        live_status = request("/api/case/status",token=token)[1]
        self.assertEqual(live_status["admission_source"],"emergency")
        self.assertEqual(live_status["identity_status"],"pending")
        self.assertEqual(request("/api/case/discharge",{"case_id":emergency["case_id"],"discharge_time":emergency_start+60000},token)[0],200)
        self.assertEqual(request("/api/case/archive",{"case_id":emergency["case_id"]},token)[0],200)

        manual_start = emergency_start + 3600000
        status, manual = request("/api/case/start", {
            "hn":"", "start_time":manual_start, "admission_source":"manual",
            "patient_name":"Local Patient", "sex":"female", "date_of_birth":"1975-04-01",
            "date_of_birth_precision":"estimated", "age_text":"50y 10m", "operation":"Test procedure",
            "anaesthesia_technique":"GA", "asa_status":"III", "asa_emergency":True,
            "surgical_priority":"urgent"
        }, token)
        self.assertEqual(status,200,manual)
        self.assertTrue(manual["hn"].startswith("LOCAL-"))
        patient = self.database.execute(
            "SELECT patient_name,source FROM case_his_patient WHERE case_id=%s",
            (manual["case_id"],),
        ).fetchone()
        self.assertEqual(patient["patient_name"],"Local Patient")
        self.assertEqual(patient["source"],"MANUAL")
        metadata = self.database.execute("SELECT admission_metadata FROM cases WHERE id=%s", (manual["case_id"],)).fetchone()["admission_metadata"]
        self.assertEqual(metadata["date_of_birth_precision"], "estimated")
        self.assertEqual(metadata["anaesthesia_technique"], "GA")
        self.assertEqual(metadata["asa_status"], "III")
        self.assertTrue(metadata["asa_emergency"])
        self.assertEqual(metadata["surgical_priority"], "urgent")
        self.assertEqual(request("/api/case/discharge",{"case_id":manual["case_id"],"discharge_time":manual_start+60000},token)[0],200)
        self.assertEqual(request("/api/case/archive",{"case_id":manual["case_id"]},token)[0],200)
        self.assertEqual(request("/api/case/start",{"hn":"","start_time":manual_start,"admission_source":"his"},token)[0],400)

    def test_case_lifecycle_and_concurrent_start(self):
        token = self.login()
        start = 1750000000000
        self.assertEqual(request("/api/case/start",{"hn":"test","start_time":start})[0],401)
        # Several cases may be active; two starts on one exclusive device: only one wins.
        link = self.database.execute(
            "INSERT INTO leaf_gateway_link(label,data_api_url,created_at,updated_at) VALUES ('test','http://127.0.0.1:9',1,1) RETURNING id"
        ).fetchone()["id"]
        device = {"gateway_link_id":link,"device_id":"concurrent-"+self.suffix,"mode":"exclusive"}
        def create(_):
            return request("/api/case/start",{"hn":"TEST-"+self.suffix,"start_time":start,"devices":[device]},token)
        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as executor:
            responses = list(executor.map(create,range(2)))
        self.assertEqual(sorted(status for status,_ in responses),[200,409],responses)
        self.assertEqual(next(body for status,body in responses if status == 409)["error"],"device_in_use")
        case = next(body for status,body in responses if status == 200)
        case_id = case["case_id"]
        runs = self.database.execute("SELECT * FROM case_io_run WHERE case_id=%s",(case_id,)).fetchall()
        self.assertEqual(len(runs),2)
        self.assertEqual(self.database.execute("SELECT count(*) AS n FROM case_io_audit WHERE case_id=%s",(case_id,)).fetchone()["n"],2)
        self.assertEqual(request("/api/case/archive",{"case_id":case_id},token)[0],400)
        self.assertEqual(request("/api/case/discharge",{"case_id":case_id,"discharge_time":start-3600000},token)[0],400)
        status,result = request("/api/case/discharge",{"case_id":case_id,"discharge_time":start+3600000},token)
        self.assertEqual(status,200,result)
        self.assertEqual(request("/api/case/status",token=token)[1]["status"],"IDLE")
        self.assertEqual(request("/api/case/archive",{"case_id":case_id},token)[0],200)
        self.assertEqual(request(f"/api/case/{case_id}/start-time",{"start_time":start},token,"PUT")[0],409)
        self.assertEqual(request("/api/case/archive",{"case_id":case_id},token)[0],200)

    def test_password_change_and_self_deactivation_protection(self):
        token = self.login()
        self.assertEqual(request("/api/auth/self/change-password",{"current_password":"wrong","new_password":"test-pass-123"},token)[0],400)
        self.assertEqual(request("/api/auth/self/change-password",{"current_password":self.password,"new_password":"short"},token)[0],400)
        status,result = request("/api/auth/self/change-password",{"current_password":self.password,"new_password":"test-pass-123"},token)
        self.assertEqual(status,200,result)
        self.assertEqual(request("/api/auth/login",{"username":self.username,"password":self.password})[0],401)
        self.__class__.password = "test-pass-123"
        new_token = self.login()
        self.assertEqual(request(f"/api/auth/users/{self.user_id}/active",{"is_active":False},new_token,"PUT",pin=self.pin)[0],400)
        self.assertEqual(request("/api/auth/whoami",token=new_token)[0],200)

    def test_clinical_writes_and_audit_rollback(self):
        token = self.login()
        start = 1760000400000
        status,case = request("/api/case/start",{"hn":"CLINICAL-"+self.suffix,"start_time":start},token)
        self.assertEqual(status,200,case)
        case_id = case["case_id"]
        root = f"/api/case/{case_id}"
        status, concept_result = request("/api/config/terminology", {
            "domain": "diagnosis", "local_id": "case-link-" + self.suffix,
            "local_name": "Mapped diagnosis master", "snomed_id": "987654321",
            "snomed_name": "Mapped SNOMED diagnosis", "icd10_id": "Z01.8",
        }, token)
        self.assertEqual(status, 200, concept_result)
        status, linked = request(root + "/diagnosis", {
            "diagnosis_text": "Patient-specific original wording",
            "concept_id": concept_result["row"]["id"],
        }, token)
        self.assertEqual(status, 200, linked)
        stored_link = self.database.execute("SELECT diagnosis_text,concept_id,coding_snapshot FROM case_diagnosis WHERE id=%s", (linked["id"],)).fetchone()
        self.assertEqual(stored_link["diagnosis_text"], "Patient-specific original wording")
        self.assertEqual(stored_link["coding_snapshot"]["snomed_id"], "987654321")
        for category,field in (("diagnosis","diagnosis_text"),("procedures","procedure_text"),("allergies","allergen")):
            status,result = request(root+"/"+category,{field:"Synthetic test entry"},token)
            self.assertEqual(status,200,result)
            entry = result["id"]
            self.assertEqual(request(root+f"/{category}/{entry}",{field:"Corrected entry"},token,"PUT")[0],200)
        self.assertEqual(request(root+f"/{category}/{entry}",token=token,method="DELETE")[0],200)
        self.assertEqual(request(root+"/detail-draft",{"draft":{"asa":"II","note":"test"}},token,"PUT")[0],200)
        self.assertEqual(request(root+"/detail-draft",token=token)[1]["draft"]["asa"],"II")
        status,patched=request(root+"/detail-draft",{"patch":{"weightKg":"61.4"}},token,"PATCH")
        self.assertEqual(status,200,patched)
        self.assertEqual(patched["draft"]["asa"],"II")
        self.assertEqual(patched["draft"]["weightKg"],"61.4")
        self.assertEqual(request(root+"/events",{"title":"End ANE","event_ts":start},token)[0],400)
        status,event = request(root+"/events",{"title":"Start ANE","event_ts":start},token)
        self.assertEqual(status,200,event)
        self.assertEqual(request(root+"/events",{"title":"Start ANE","event_ts":start+60000},token)[0],400)
        self.assertEqual(request(root+"/events",{"title":"End ANE","event_ts":start+60000},token)[0],200)
        self.assertEqual(request(root+f"/events/{event['id']}",{"detail":"Corrected note"},token,"PUT")[0],200)
        changes=[{"ts_minute":start,"param_key":"hr","value":70,"value_type":"number"}]
        status,result = request(root+"/timeline",{"changes":changes},token,"PUT")
        self.assertEqual(status,200,result)
        self.assertEqual(result["inserted"],1)
        changes[0]["value"]=80
        status,result = request(root+"/timeline",{"changes":changes},token,"PUT")
        self.assertEqual(status,200,result)
        self.assertEqual(result["updated"],1)
        changes[0]["value"]=90
        changes.append({"ts_minute":start,"param_key":"spo2","value":"invalid","value_type":"number"})
        self.assertEqual(request(root+"/timeline",{"changes":changes},token,"PUT")[0],400)
        saved=self.database.execute("SELECT value_num FROM case_timeline_value WHERE case_id=%s AND param_key='hr'",(case_id,)).fetchone()
        self.assertEqual(saved["value_num"],80)
        self.assertEqual(self.database.execute("SELECT count(*) AS n FROM case_timeline_audit WHERE case_id=%s",(case_id,)).fetchone()["n"],2)
        self.assertGreater(self.database.execute("SELECT count(*) AS n FROM case_clinical_audit WHERE case_id=%s",(case_id,)).fetchone()["n"],0)
        self.assertEqual(request("/api/case/discharge",{"case_id":case_id,"discharge_time":start+3600000},token)[0],200)
        self.assertEqual(request("/api/case/archive",{"case_id":case_id},token)[0],200)
        self.assertEqual(request(root+"/detail-draft",{"draft":{}},token,"PUT")[0],409)

    def test_catalog_io_and_ephis_writes(self):
        token = self.login()
        start = 1770000000000
        status, case = request("/api/case/start", {"hn":"IO-"+self.suffix,"start_time":start}, token)
        self.assertEqual(status, 200, case)
        case_id = case["case_id"]
        status, master = request("/api/case/io/master", {
            "kind":"med", "code":"testMed"+self.suffix, "name":"Synthetic medication", "default_unit":"mg"
        }, token)
        self.assertEqual(status, 200, master)
        item_id = master["row"]["id"]
        status, event = request(f"/api/case/{case_id}/io/events", {
            "item_id":item_id, "kind":"med", "event_ts":start, "dose_value":2, "dose_unit":"mg"
        }, token)
        self.assertEqual(status, 200, event)
        status, edited_event = request(f"/api/case/{case_id}/io/events/{event['row']['id']}", {
            "event_ts":start+60000, "dose_value":3, "dose_unit":"mg", "note":"corrected dose"
        }, token, "PUT")
        self.assertEqual(status, 200, edited_event)
        self.assertEqual(edited_event["row"]["dose_value"], 3)
        self.assertEqual(edited_event["row"]["event_ts"], start+60000)
        status, summary = request(f"/api/case/{case_id}/io/summary?from={start}&to={start+60000}", token=token)
        self.assertEqual(status, 200, summary)
        tsv = "HN\tAdmit Date\nEPHIS-"+self.suffix+"\t2026-09-16"
        status, imported = request("/api/ephis/import-daily-cases", {"tsvText":tsv,"replaceExisting":True}, token)
        self.assertEqual(status, 200, imported)
        self.assertEqual(imported["imported_rows"], 1)
        self.assertEqual(request("/api/ephis/import-status", token=token)[1]["total_rows"], 1)
        self.assertEqual(request("/api/case/discharge", {"case_id":case_id,"discharge_time":start+3600000}, token)[0], 200)


if __name__ == "__main__":
    unittest.main(verbosity=2)
