#!/usr/bin/env python3
"""End-to-end HTTP check of the FormDev API on a running Canopy API (stdlib only).

    FORMDEV_API=http://127.0.0.1:7895 FORMDEV_USER=admin FORMDEV_PASSWORD=... \
        python3 formdev/scripts/smoke_api.py

Against a disposable test API (no user database), pass the test session secret
instead of a password and the script signs its own admin session:

    FORMDEV_API=http://127.0.0.1:7999 FORMDEV_SESSION_SECRET=... FORMDEV_SMOKE_USER_ID=<id of a test admin> \
        python3 formdev/scripts/smoke_api.py

Uses a throwaway form id (smoke_<random>) so it never touches real forms. Exits non-zero
on the first failed check.
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import secrets
import sys
import time
import urllib.error
import urllib.request
import uuid
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
BASE = os.environ.get("FORMDEV_API", "http://127.0.0.1:7895").rstrip("/")
TOKEN = ""


def call(method: str, path: str, body=None, raw: bytes | None = None, expect: int = 200):
    data = raw if raw is not None else (json.dumps(body).encode() if body is not None else None)
    request = urllib.request.Request(BASE + path, data=data, method=method)
    request.add_header("Content-Type", "application/octet-stream" if raw is not None else "application/json")
    if TOKEN:
        request.add_header("X-FLORA-Session", TOKEN)
    try:
        with urllib.request.urlopen(request, timeout=15) as response:
            status, payload, kind = response.status, response.read(), response.headers.get("Content-Type", "")
    except urllib.error.HTTPError as error:
        status, payload, kind = error.code, error.read(), error.headers.get("Content-Type", "")
    if status != expect:
        sys.exit(f"FAIL {method} {path}: expected {expect}, got {status}: {payload[:400]!r}")
    return json.loads(payload) if "json" in kind else payload


def check(label: str, condition: bool) -> None:
    print(("PASS " if condition else "FAIL ") + label)
    if not condition:
        sys.exit(1)


def signed_session(secret: str) -> str:
    """Same format as app.routes.auth_canopy.create_token; for disposable test APIs only."""
    part = lambda raw: base64.urlsafe_b64encode(raw).rstrip(b"=").decode("ascii")  # noqa: E731
    # Endpoints resolve the caller from auth_user, so sign as an existing active test user (FORMDEV_SMOKE_USER_ID).
    payload = {"sub": int(os.environ.get("FORMDEV_SMOKE_USER_ID", "0")), "username": "formdev-smoke", "name": "FormDev smoke", "role": "admin", "exp": int(time.time() * 1000) + 600_000}
    encoded = part(json.dumps(payload, separators=(",", ":")).encode())
    return f"{encoded}.{part(hmac.new(secret.encode(), encoded.encode('ascii'), hashlib.sha256).digest())}"


def main() -> None:
    global TOKEN
    if os.environ.get("FORMDEV_SESSION_SECRET"):
        TOKEN = signed_session(os.environ["FORMDEV_SESSION_SECRET"])
    else:
        login = call("POST", "/api/auth/login", {"username": os.environ.get("FORMDEV_USER", "admin"), "password": os.environ["FORMDEV_PASSWORD"]})
        TOKEN = login["session_token"]
    form_id = f"smoke_{secrets.token_hex(4)}"
    definition = json.loads((ROOT / "examples/patient-assessment/v1.form.json").read_text(encoding="utf-8"))
    definition["form_id"] = form_id

    registry = call("GET", "/api/formdev/registry")
    check(f"registry served from {registry['storage']}", {"form.a4.medical", "form.a4.official"} <= {s["style_id"] for s in registry["styles"]})
    bad = dict(definition, style_id="form.missing")
    check("validator reports unknown style", [i["code"] for i in call("POST", "/api/formdev/validate", {"definition": bad})["issues"]] == ["unknown_style"])

    call("POST", "/api/formdev/forms", {"definition": definition})
    call("POST", f"/api/formdev/forms/{form_id}/versions/1/publish")
    changed = dict(definition, title="changed")
    error = call("PUT", f"/api/formdev/forms/{form_id}/versions/1", {"definition": changed}, expect=409)
    check("published version is immutable over HTTP", error["code"] == "version_immutable")

    record_id = str(uuid.uuid4())
    now = int(time.time() * 1000)
    create = {"op_id": str(uuid.uuid4()), "kind": "create", "record_id": record_id, "form_id": form_id, "data": {"hn": "SMOKE1", "age": 64}, "client_updated_at": now}
    first = call("POST", "/api/formdev/sync", {"ops": [create]})["acks"][0]
    again = call("POST", "/api/formdev/sync", {"ops": [create]})["acks"][0]
    check("sync create applied", first["status"] == "applied" and first["record"]["version"] == 1)
    check("resent op is idempotent", again.get("duplicate") is True)
    update = {"op_id": str(uuid.uuid4()), "kind": "update", "record_id": record_id, "base_version": 1, "data": {"hn": "SMOKE1", "age": 65}, "client_updated_at": now + 1}
    check("sync update applied", call("POST", "/api/formdev/sync", {"ops": [update]})["acks"][0]["record"]["version"] == 2)
    stale = dict(update, op_id=str(uuid.uuid4()), data={"hn": "STALE"}, client_updated_at=now - 60_000)
    conflict = call("POST", "/api/formdev/sync", {"ops": [stale]})["acks"][0]
    check("stale op detected as conflict (server wins)", conflict["status"] == "conflict" and conflict["conflict"]["resolution"] == "remote_wins")
    check("conflict is logged", len(call("GET", f"/api/formdev/records/{record_id}/conflicts")["rows"]) == 1)

    found = call("GET", f"/api/formdev/records?form_id={form_id}&filter=hn:eq:SMOKE1&filter=age:gte:60")
    check("indexed search finds the record", [row["record_id"] for row in found["rows"]] == [record_id])
    error = call("GET", f"/api/formdev/records?form_id={form_id}&filter=full_name:eq:x", expect=400)
    check("non-indexed filter refused", error["code"] == "field_not_indexed")
    check("revisions kept", [row["version"] for row in call("GET", f"/api/formdev/records/{record_id}/revisions")["rows"]] == [1, 2])

    package = call("GET", f"/api/formdev/forms/{form_id}/package")
    check("formpack exported", isinstance(package, bytes) and package[:2] == b"PK")
    result = call("POST", "/api/formdev/packages", raw=package)["result"]
    check("re-importing the same pack is a no-op", result["definition"] == "unchanged")
    print(f"OK smoke form {form_id}")


if __name__ == "__main__":
    main()
