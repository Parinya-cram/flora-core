#!/usr/bin/env python3
"""End-to-end HTTP checks of the Phase 4 query API (stdlib only).

Needs a disposable Canopy API started with FORMDEV_TEST_HOOKS=1 against a *_test database that
has the full Flora schema and the QA users 9001 (system_admin), 9002 (clinician), 9003 (viewer)
and 9004 (inactive viewer). Sessions are signed with the test API's session secret:

    FORMDEV_API=http://127.0.0.1:7996 FORMDEV_SESSION_SECRET=... python3 formdev/scripts/smoke_query_api.py
"""
from __future__ import annotations

import base64
import csv
import hashlib
import hmac
import io
import json
import os
import secrets
import sys
import time
import urllib.error
import urllib.request
import uuid

BASE = os.environ.get("FORMDEV_API", "http://127.0.0.1:7996").rstrip("/")
SECRET = os.environ["FORMDEV_SESSION_SECRET"].encode()
USERS = {"admin": (9001, "qa_admin", "admin"), "nurse": (9002, "qa_nurse", "clinician"), "viewer": (9003, "qa_viewer", "viewer"), "gone": (9004, "qa_gone", "viewer")}
PASSED = 0


def token(user: str) -> str:
    sub, username, role = USERS[user]
    part = lambda raw: base64.urlsafe_b64encode(raw).rstrip(b"=").decode()  # noqa: E731
    payload = part(json.dumps({"sub": sub, "username": username, "name": username, "role": role, "exp": int(time.time() * 1000) + 600_000}, separators=(",", ":")).encode())
    return f"{payload}.{part(hmac.new(SECRET, payload.encode(), hashlib.sha256).digest())}"


def call(user: str, method: str, path: str, body=None, raw: bytes | None = None):
    data = raw if raw is not None else (json.dumps(body).encode() if body is not None else None)
    request = urllib.request.Request(BASE + path, data=data, method=method)
    request.add_header("Content-Type", "application/json")
    request.add_header("X-FLORA-Session", token(user))
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            content, status, headers = response.read(), response.status, response.headers
    except urllib.error.HTTPError as error:
        content, status, headers = error.read(), error.code, error.headers
    kind = headers.get("Content-Type", "")
    return status, (json.loads(content) if "json" in kind and content else content), headers


def check(label: str, condition: bool, detail: object = "") -> None:
    global PASSED
    if not condition:
        sys.exit(f"FAIL {label} {str(detail)[:500]}")
    PASSED += 1
    print(f"PASS {label}")


def main() -> None:
    form_id = f"qa_{secrets.token_hex(3)}"
    definition = {"format": "flora.form/1", "form_id": form_id, "schema_version": 1, "title": "QA ward check", "paper": "A4",
                  "style_id": "form.a4.medical", "extensions": {"flora.subject_field": "hn"}, "sections": [{"id": "main", "title": "Main", "fields": [
                      {"id": "hn", "type": "text", "label": "HN", "indexed": True},
                      {"id": "full_name", "type": "text", "label": "Name"},
                      {"id": "ward", "type": "select", "label": "Ward", "indexed": True, "options": [{"value": w, "label": w} for w in ("W1", "W2", "W3")]},
                      {"id": "age", "type": "integer", "label": "Age", "indexed": True}]}]}
    status, _, _ = call("admin", "POST", "/api/formdev/forms", {"definition": definition})
    check("admin creates a form", status == 200, status)
    check("admin publishes it", call("admin", "POST", f"/api/formdev/forms/{form_id}/versions/1/publish")[0] == 200)
    ops = [{"op_id": str(uuid.uuid4()), "kind": "create", "record_id": str(uuid.uuid4()), "form_id": form_id,
            "data": {"hn": f"HN{n:04d}", "full_name": f"=Patient {n}" if n == 3 else f"ผู้ป่วย {n}", "ward": f"W{n % 3 + 1}", "age": 20 + n},
            "client_updated_at": int(time.time() * 1000)} for n in range(60)]
    status, body, _ = call("nurse", "POST", "/api/formdev/sync", {"ops": ops})
    check("nurse syncs 60 records", status == 200 and all(ack["status"] == "applied" for ack in body["acks"]), body)

    status, body, _ = call("admin", "PUT", f"/api/formdev/policies/{form_id}", {"policy": {"fields": {"full_name": ["system_admin", "clinician"]}}})
    check("admin restricts full_name", status == 200, body)
    check("catalog hides restricted fields from the viewer", "full_name" not in call("viewer", "GET", f"/api/formdev/query/catalog/{form_id}")[1]["catalog"]["fields"])
    status, body, _ = call("viewer", "GET", f"/api/formdev/records?form_id={form_id}&limit=5")
    check("Phase 3 /records masks restricted fields", status == 200 and body["rows"] and all("full_name" not in row["data"] for row in body["rows"]), body)
    status, body, _ = call("viewer", "POST", "/api/formdev/query", {"query": {"source": form_id, "select": ["hn", "full_name"], "pagination": {"mode": "cursor", "limit": 5}}})
    check("query refuses a restricted field", status == 422 and "unauthorized_field" in [i["code"] for i in body["details"]], body)

    seen, cursor = [], None
    while True:
        page = {"mode": "cursor", "limit": 25, **({"cursor": cursor} if cursor else {})}
        status, body, _ = call("nurse", "POST", "/api/formdev/query", {"query": {"source": form_id, "select": ["hn", "full_name", "age"], "filter": {"field": "age", "op": "gte", "value": 30}, "pagination": page}})
        check(f"cursor page {len(seen) // 25 + 1}", status == 200, body)
        seen += [row["hn"] for row in body["rows"]]
        cursor = body["next_cursor"]
        if not cursor:
            break
    check("cursor paging returns every match once", sorted(seen) == [f"HN{n:04d}" for n in range(10, 60)], seen)
    status, body, _ = call("nurse", "POST", "/api/formdev/query/validate", {"query": {"source": form_id, "select": ["*"]}})
    check("validate endpoint reports issues", status == 200 and "select_star_not_allowed" in [i["code"] for i in body["issues"]], body)

    status, body, _ = call("viewer", "POST", "/api/formdev/query", {"query": {"source": form_id, "group": ["ward"], "aggregate": [{"fn": "count", "as": "n"}, {"fn": "avg", "field": "age", "as": "avg_age"}]}})
    check("interactive aggregate", status == 200 and sum(row["n"] for row in body["rows"]) == 60, body)
    status, body, _ = call("viewer", "POST", "/api/formdev/jobs", {"kind": "export", "format": "csv", "body": {"query": {"source": form_id, "select": ["hn"], "pagination": {"mode": "cursor", "limit": 50}}}})
    check("viewer may not export", status == 403 and body["code"] == "export_forbidden", body)
    status, body, _ = call("admin", "POST", "/api/formdev/jobs", {"kind": "export", "format": "csv", "body": {"query": {"source": form_id, "select": ["hn", "full_name", "ward"], "pagination": {"mode": "cursor", "limit": 50}}}})
    check("admin creates an export job", status == 200 and body["job"]["status"] == "queued", body)
    job_id = body["job"]["job_id"]
    for _ in range(60):
        status, body, _ = call("admin", "GET", f"/api/formdev/jobs/{job_id}")
        if body["job"]["status"] in ("succeeded", "failed"):
            break
        time.sleep(0.5)
    check("export job succeeds in the background worker", body["job"]["status"] == "succeeded" and body["job"]["rows_processed"] == 60, body)
    status, content, headers = call("admin", "GET", f"/api/formdev/jobs/{job_id}/download")
    text = content.decode("utf-8")
    rows = list(csv.reader(io.StringIO(text.lstrip("﻿"))))
    check("download is a UTF-8 BOM CSV with every record", status == 200 and text.startswith("﻿") and len(rows) == 61, (status, len(rows)))
    check("formula cells are neutralized and Thai text survives", any(row[2] == "'=Patient 3" for row in rows) and any("ผู้ป่วย" in row[2] for row in rows))
    check("another user cannot see the job", call("viewer", "GET", f"/api/formdev/jobs/{job_id}")[0] == 404)
    report = call("viewer", "POST", "/api/formdev/jobs", {"kind": "aggregate", "body": {"query": {"source": form_id, "group": ["ward"], "aggregate": [{"fn": "count", "as": "n"}]}}})
    check("viewer can queue an aggregate job", report[0] == 200, report[1])

    status, body, _ = call("nurse", "POST", "/api/formdev/query?test_sleep_ms=3000", {"query": {"source": form_id, "select": ["hn"], "timeout": 200, "pagination": {"mode": "cursor", "limit": 5}}})
    check("timeout is a friendly 504", status == 504 and body["code"] == "query_timeout" and "select" not in body["message"].lower(), body)
    check("server still answers after the timeout", call("nurse", "GET", "/health")[0] == 200)

    status, body, _ = call("nurse", "POST", "/api/formdev/query", raw=b'{"query": {"source": "x"}, "query": {"source": "y"}}')
    check("duplicate JSON keys are refused", status == 400 and body["code"] == "dangerous_operation", body)
    status, body, _ = call("nurse", "POST", "/api/formdev/query", raw=b'{"query": "' + b"x" * 70000 + b'"}')
    check("oversized bodies are refused", status == 413, status)
    status, body, _ = call("viewer", "POST", "/api/formdev/query?explain=true", {"query": {"source": form_id, "select": ["hn"], "pagination": {"mode": "cursor", "limit": 5}}})
    check("diagnostics need permission", status == 403, body)
    status, body, _ = call("admin", "POST", "/api/formdev/query?explain=true&refresh=true", {"query": {"source": form_id, "select": ["hn"], "filter": {"field": "hn", "op": "eq", "value": "HN0007"}, "pagination": {"mode": "cursor", "limit": 5}}})
    # Index use at scale is asserted by the large-dataset benchmark; a 60-row table is seq-scanned.
    check("admin diagnostics return a plan without values", status == 200 and body["diagnostics"]["plan"]["node_types"]
          and "full_scan" in body["diagnostics"]["plan"] and "HN0007" not in json.dumps(body["diagnostics"]), body.get("diagnostics"))

    for _ in range(4):
        call("nurse", "POST", "/api/formdev/query", {"query": {"source": form_id, "select": ["hn"], "filter": {"field": "full_name", "op": "eq", "value": "x"}, "pagination": {"mode": "cursor", "limit": 5}}})
    status, body, _ = call("admin", "GET", f"/api/formdev/query/advice?source_id={form_id}")
    check("advisor recommends indexing a refused field", status == 200 and any(a["kind"] == "index_field" and a["field"] == "full_name" for a in body["advice"]), body)
    status, body, _ = call("admin", "GET", "/api/formdev/query/audit?limit=50")
    actions = {row["action"] for row in body["rows"]}
    check("audit records job creation and download", {"job_create", "job_download", "denied"} <= actions, actions)
    check("inactive users are refused", call("gone", "POST", "/api/formdev/query", {"query": {"source": form_id, "select": ["hn"], "pagination": {"mode": "cursor", "limit": 5}}})[0] == 401)

    statuses = [call("viewer", "POST", "/api/formdev/query", {"query": {"source": form_id, "select": ["hn"], "cache": False, "pagination": {"mode": "cursor", "limit": 1}}}) for _ in range(30)]
    limited = [headers for status, _, headers in statuses if status == 429]
    check("rate limit answers 429 with Retry-After", limited and limited[0].get("Retry-After"), [s for s, _, _ in statuses])
    print(f"OK {PASSED} checks, form {form_id}")


if __name__ == "__main__":
    main()
