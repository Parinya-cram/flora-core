"""Multi-account Canopy: no account can reach another account's data.

Runs against a disposable database whose name ends in _test (it creates and drops schemas):

    FLORA_PLATFORM_DATABASE_URL=postgresql://flora_admin:…@db:5432/flora_mt_test \\
    FLORA_DATABASE_URL=postgresql://flora_view:…@db:5432/flora_mt_test \\
    python -m unittest tests.test_multi_account -v

It provisions two accounts from the schema bundle, puts a different hospital in each, then checks
through a real canopy-mode server that sign-in, sessions, headers, platform administrators and pooled
connections stay inside one account.
"""
import base64
import json
import os
import subprocess
import sys
import time
import unittest
import urllib.error
import urllib.request
from urllib.parse import urlparse

ADMIN_URL = os.environ["FLORA_PLATFORM_DATABASE_URL"]
VIEW_URL = os.environ["FLORA_DATABASE_URL"]
if not urlparse(ADMIN_URL).path.endswith("_test") or not urlparse(VIEW_URL).path.endswith("_test"):
    raise RuntimeError("multi-account tests need a dedicated database ending in _test")
os.environ["FLORA_API_MODE"] = "canopy"
os.environ.setdefault("FLORA_CANOPY_SESSION_SECRET", "multi-account-test-secret")
PORT = 8019
BASE = f"http://127.0.0.1:{PORT}"

import psycopg  # noqa: E402
from psycopg.rows import dict_row  # noqa: E402

from app import tenancy, tenancy_provision as provision  # noqa: E402


def call(method, path, body=None, token=None, account=None):
    headers = {"Content-Type": "application/json"}
    if token:
        headers["X-FLORA-Session"] = token
    if account:
        headers["X-Flora-Account"] = account
    request = urllib.request.Request(BASE + path, method=method, headers=headers,
                                     data=json.dumps(body).encode() if body is not None else None)
    try:
        with urllib.request.urlopen(request, timeout=20) as response:
            return response.status, json.loads(response.read() or b"{}")
    except urllib.error.HTTPError as error:
        return error.code, json.loads(error.read() or b"{}")


class MultiAccountTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        with psycopg.connect(ADMIN_URL, autocommit=True, row_factory=dict_row) as connection:
            provision.ensure_platform(connection)
            for code in ("t1", "t2"):
                connection.execute(f'DROP SCHEMA IF EXISTS "acct_{code}" CASCADE')
                connection.execute("DELETE FROM platform.account WHERE code=%s", (code,))
        cls.secrets = {
            "t1": provision.create_account("t1", "Test One", "admin", "t1-admin-pass")["sync_secret"],
            "t2": provision.create_account("t2", "Test Two", "admin", "t2-admin-pass")["sync_secret"],
        }
        provision.ensure_platform_admin("root", "platform-pass-123")
        now = int(time.time() * 1000)
        with psycopg.connect(ADMIN_URL, autocommit=True) as connection:
            for code, name in (("t1", "T1 Hospital"), ("t2", "T2 Hospital")):
                connection.execute(
                    f'INSERT INTO "acct_{code}".canopy_location (kind, name, created_at, updated_at) VALUES (%s,%s,%s,%s)',
                    ("hospital", name, now, now))
                # The first administrator must change the password: clear it for the API checks.
                connection.execute(f'UPDATE "acct_{code}".auth_user SET must_change_password=0')
        env = {**os.environ, "FLORA_API_MODE": "canopy"}
        cls.server = subprocess.Popen([sys.executable, "-m", "uvicorn", "app.main:app", "--port", str(PORT)],
                                      env=env, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
        for _ in range(60):
            try:
                urllib.request.urlopen(BASE + "/health", timeout=1)
                break
            except Exception:  # noqa: BLE001
                time.sleep(0.5)
        else:
            raise RuntimeError(cls.server.stderr.read().decode()[-2000:])
        cls.t1 = call("POST", "/api/auth/login", {"username": "admin", "password": "t1-admin-pass", "account_code": "t1"})[1]
        cls.t2 = call("POST", "/api/auth/login", {"username": "admin", "password": "t2-admin-pass", "account_code": "t2"})[1]

    @classmethod
    def tearDownClass(cls):
        cls.server.terminate()
        cls.server.wait(10)

    def hospitals(self, token, account=None):
        status, body = call("GET", "/api/fleet/control", token=token, account=account)
        self.assertEqual(status, 200, body)
        return {row["name"] for row in body["locations"] if row["kind"] == "hospital"}

    def test_each_account_sees_only_its_own_data(self):
        self.assertEqual(self.t1["account"]["code"], "t1")
        self.assertEqual(self.hospitals(self.t1["session_token"]), {"T1 Hospital"})
        self.assertEqual(self.hospitals(self.t2["session_token"]), {"T2 Hospital"})

    def test_session_cannot_be_pointed_at_another_account(self):
        # The account header is ignored once a session exists: the token's account wins.
        self.assertEqual(self.hospitals(self.t1["session_token"], account="t2"), {"T1 Hospital"})

    def test_tampered_account_claim_is_refused(self):
        encoded, signature = self.t1["session_token"].split(".", 1)
        claims = json.loads(base64.urlsafe_b64decode(encoded + "=" * (-len(encoded) % 4)))
        claims["acct"] = "t2"
        forged = base64.urlsafe_b64encode(json.dumps(claims, separators=(",", ":")).encode()).rstrip(b"=").decode() + "." + signature
        self.assertEqual(call("GET", "/api/fleet/control", token=forged)[0], 401)

    def test_password_of_one_account_does_not_open_another(self):
        status, _ = call("POST", "/api/auth/login", {"username": "admin", "password": "t1-admin-pass", "account_code": "t2"})
        self.assertEqual(status, 401)

    def test_unknown_account_cannot_sign_in(self):
        status, _ = call("POST", "/api/auth/login", {"username": "admin", "password": "t1-admin-pass", "account_code": "nobody"})
        self.assertEqual(status, 401)

    def test_platform_administrator_manages_accounts_but_reads_no_data(self):
        status, body = call("POST", "/api/auth/login", {"username": "root", "password": "platform-pass-123", "account_code": "platform"})
        self.assertEqual(status, 200, body)
        token = body["session_token"]
        status, accounts = call("GET", "/api/platform/accounts", token=token)
        self.assertEqual(status, 200)
        self.assertTrue({"t1", "t2"} <= {row["code"] for row in accounts["rows"]})
        self.assertEqual(call("GET", "/api/fleet/control", token=token)[0], 401)
        self.assertEqual(call("GET", "/api/fleet/control", token=token, account="t1")[0], 401)
        # Hospital sessions cannot use the platform console.
        self.assertEqual(call("GET", "/api/platform/accounts", token=self.t1["session_token"])[0], 401)

    def test_suspended_account_is_closed(self):
        status, body = call("POST", "/api/auth/login", {"username": "root", "password": "platform-pass-123", "account_code": "platform"})
        token = body["session_token"]
        self.assertEqual(call("PUT", "/api/platform/accounts/t2", {"status": "suspended"}, token=token)[0], 200)
        try:
            self.assertEqual(call("GET", "/api/fleet/control", token=self.t2["session_token"])[0], 401)
            self.assertEqual(call("POST", "/api/auth/login", {"username": "admin", "password": "t2-admin-pass", "account_code": "t2"})[0], 401)
        finally:
            call("PUT", "/api/platform/accounts/t2", {"status": "active"}, token=token)

    def test_sync_secret_names_exactly_one_account(self):
        self.assertEqual(tenancy.by_sync_secret(self.secrets["t1"]).code, "t1")
        self.assertEqual(tenancy.by_sync_secret(self.secrets["t2"]).code, "t2")
        self.assertIsNone(tenancy.by_sync_secret("not-a-secret"))

    def test_leaf_and_haber_writes_land_in_their_own_account(self):
        sync_url = os.environ.get("FLORA_SYNC_DATABASE_URL")
        if not sync_url:
            self.skipTest("FLORA_SYNC_DATABASE_URL not set")
        env = {**os.environ, "FLORA_API_MODE": "sync", "FLORA_DATABASE_URL": sync_url}
        server = subprocess.Popen([sys.executable, "-m", "uvicorn", "app.main:app", "--port", str(PORT + 1)],
                                  env=env, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
        try:
            for _ in range(60):
                try:
                    urllib.request.urlopen(f"http://127.0.0.1:{PORT + 1}/health", timeout=1)
                    break
                except Exception:  # noqa: BLE001
                    time.sleep(0.5)

            def post(secret, gateway):
                request = urllib.request.Request(
                    f"http://127.0.0.1:{PORT + 1}/api/sync/v1/gateways/{gateway}/config", method="POST",
                    headers={"Content-Type": "application/json", "Authorization": f"Bearer {secret}"},
                    data=json.dumps({"site": {}, "license": {}, "devices": []}).encode())
                try:
                    with urllib.request.urlopen(request, timeout=20) as response:
                        return response.status
                except urllib.error.HTTPError as error:
                    return error.code

            self.assertEqual(post(self.secrets["t1"], "gw-t1-only"), 200)
            self.assertEqual(post("forged-secret", "gw-forged"), 401)
            with psycopg.connect(ADMIN_URL, autocommit=True) as connection:
                where = {code: connection.execute(f'SELECT gateway_id FROM "acct_{code}".canopy_gateway').fetchall()
                         for code in ("t1", "t2")}
            self.assertIn(("gw-t1-only",), where["t1"])
            self.assertEqual([row for row in where["t2"] if row[0] in ("gw-t1-only", "gw-forged")], [])
        finally:
            server.terminate()
            server.wait(10)

    def test_pooled_connections_without_an_account_reach_nothing(self):
        from app.database import pool

        pool.open(wait=True, timeout=10)
        with pool.connection() as connection:
            with self.assertRaises(psycopg.errors.UndefinedTable):
                connection.execute("SELECT count(*) FROM canopy_location").fetchone()
        for code, name in (("t1", "T1 Hospital"), ("t2", "T2 Hospital")):
            with tenancy.using(tenancy.by_code(code)), pool.connection() as connection:
                names = {row["name"] for row in connection.execute("SELECT name FROM canopy_location").fetchall()}
                self.assertEqual(names, {name})
        # A connection given back is pointed at the empty schema again.
        with pool.connection() as connection:
            self.assertEqual(connection.execute("SHOW search_path").fetchone()["search_path"], tenancy.ISOLATED_SCHEMA)


if __name__ == "__main__":
    unittest.main()
