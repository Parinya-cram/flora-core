#!/usr/bin/env python3
"""Opens one active demo case on each Leaf so device data flows into a chart.

Signs in with the default admin / admin and starts a manual-admission case.
Re-running is safe: an existing active case is left alone. If sign-in fails
(password changed, or an install from before the demo default), run
demo/reset-admins.sh.
"""
import json
import time
import urllib.error
import urllib.request

DEMO_PASSWORD = "admin"  # local demo default for every Flora system
LEAVES = [
    {"name": "leaf-or-01", "api": "http://127.0.0.1:7301", "hn": "DEMO-OR-0001", "an": "AN-OR-0001",
     "patient": "Demo Patient OR", "operation": "Laparoscopic cholecystectomy", "diagnosis": "Symptomatic cholelithiasis",
     "location": {"careUnitName": "OR Suite", "roomName": "Operating Room 1", "bedName": "OR-1"}},
    {"name": "leaf-icu-01", "api": "http://127.0.0.1:7311", "hn": "DEMO-ICU-0001", "an": "AN-ICU-0001",
     "patient": "Demo Patient ICU", "operation": "Post-operative ventilation", "diagnosis": "Septic shock",
     "location": {"careUnitName": "ICU", "roomName": "ICU Room 1", "bedName": "ICU Bed 1"}},
]


def call(api, path, body=None, token=None, method=None):
    request = urllib.request.Request(api + path, data=json.dumps(body).encode() if body is not None else None,
                                     method=method or ("POST" if body is not None else "GET"))
    request.add_header("content-type", "application/json")
    if token:
        request.add_header("authorization", f"Bearer {token}")
    try:
        with urllib.request.urlopen(request, timeout=15) as response:
            return response.status, json.loads(response.read() or b"null")
    except urllib.error.HTTPError as error:
        return error.code, json.loads(error.read() or b"null")


def login(api):
    status, body = call(api, "/api/auth/login", {"username": "admin", "password": DEMO_PASSWORD})
    if status != 200 or body["user"].get("mustChangePassword"):
        raise SystemExit(f"cannot sign in to {api} as admin/admin; run demo/reset-admins.sh")
    return body["session_token"]


for leaf in LEAVES:
    token = login(leaf["api"])
    # Ward shown in the Leaf header and browser tab.
    status, body = call(leaf["api"], "/api/workstation/context", {
        "hospitalName": "Demo Hospital", "buildingName": "Main building", **leaf["location"],
        "timezone": "Asia/Bangkok", "dateFormat": "DD/MM/YYYY", "timeFormat": "24h"}, token, method="PUT")
    if status != 200:
        raise SystemExit(f"{leaf['name']}: workstation location failed {status} {body}")
    status, body = call(leaf["api"], "/api/case/start", {
        "start_time": int(time.time() * 1000), "admission_source": "manual", "hn": leaf["hn"],
        "admission_number": leaf["an"],
        "patient_name": leaf["patient"], "sex": "F", "age_text": "54y", "weight_kg": 62,
        "operation": leaf["operation"], "diagnosis": leaf["diagnosis"], "asa_status": "3",
    }, token)
    if status == 409:
        print(f"{leaf['name']}: active case already open ({body.get('active_case_hn')})")
    elif status == 200:
        print(f"{leaf['name']}: started case {leaf['hn']}")
    else:
        raise SystemExit(f"{leaf['name']}: start failed {status} {body}")
