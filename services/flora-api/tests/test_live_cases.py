"""Multi-case Leaf, device bindings and the leaf-live stream, against a disposable database.

Same rules as test_leaf_writes.py: FLORA_DATABASE_URL must name a database ending in _test with the
schema already in place. Starts the Leaf API (:8009), leaf-live (:8019) and a fake Gateway stream-hub.
"""
import asyncio
import base64
import hashlib
import json
import os
import secrets
import struct
import subprocess
import sys
import threading
import time
import unittest
import urllib.error
import urllib.request
import uuid
from urllib.parse import urlparse

import psycopg
from psycopg.rows import dict_row

URL = os.environ["FLORA_DATABASE_URL"]
if not urlparse(URL).path.endswith("_test"):
    raise RuntimeError("Write tests require a dedicated database ending in _test")
os.environ.update(FLORA_LEAF_WRITE_API="true", FLORA_API_MODE="leaf", FLORA_HIS_DEMO_MODE="true",
                  FLORA_DEVICE_INGEST_ENABLED="false", FLORA_LEAF_ID="leaf-live-test", FLORA_HOSPITAL_ID="hospital-test",
                  LEAF_LIVE_RECONCILE_SECONDS="0.5")
API, LIVE, HUB_PORT = "http://127.0.0.1:8009", "127.0.0.1:8019", 8029
HUB_TOKEN = "hub-token-" + secrets.token_hex(4)


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


def case_uuid(case_id):
    return str(uuid.uuid5(uuid.NAMESPACE_URL, f"flora:hospital-test:leaf-live-test:case:{case_id}"))


def wait_for(check, timeout=15.0):
    end = time.time() + timeout
    while time.time() < end:
        value = check()
        if value:
            return value
        time.sleep(.1)
    return check()


class FakeHub:
    """Gateway stream-hub stand-in: welcome, bound, then chunks once `release` is set.

    max_unacked: flow control like the real hub (stop sending a device until an ack)."""

    def __init__(self, seconds=65, port=HUB_PORT, max_unacked=None):
        self.seconds, self.messages, self.acks = seconds, [], {}
        self.port, self.max_unacked = port, max_unacked
        self.release = threading.Event()
        self.loop = asyncio.new_event_loop()
        threading.Thread(target=self.loop.run_forever, daemon=True).start()
        asyncio.run_coroutine_threadsafe(self.start(), self.loop).result(10)

    async def start(self):
        from websockets.asyncio.server import serve
        self.server = await serve(self.handler, "127.0.0.1", self.port)

    def stop(self):
        self.loop.call_soon_threadsafe(self.server.close)

    async def handler(self, socket):
        hello = json.loads(await socket.recv())
        self.messages.append(hello)
        if hello.get("token") != HUB_TOKEN:
            await socket.send(json.dumps({"type": "error", "code": "unauthorized", "detail": "bad token"}))
            await socket.close(4401)
            return
        await socket.send(json.dumps({"type": "welcome", "session_id": "s1", "devices": []}))
        async for raw in socket:
            message = json.loads(raw)
            self.messages.append(message)
            if message["type"] == "ack":
                self.acks[message["device_id"]] = message["seq"]
            elif message["type"] == "bind":
                await socket.send(json.dumps({"type": "bound", "case_uuid": message["case_uuid"],
                                              "device_id": message["device_id"], "mode": message["mode"],
                                              "from_seq": message["resume_seq"]}))
                asyncio.ensure_future(self.stream(socket, message["device_id"], message["resume_seq"]))

    async def stream(self, socket, device_id, first):
        await asyncio.get_running_loop().run_in_executor(None, self.release.wait)
        wave = base64.b64encode(struct.pack("<4h", 0, 100, -100, 0)).decode()
        for seq in range(first, first + self.seconds):
            while self.max_unacked and seq - self.acks.get(device_id, first - 1) > self.max_unacked:
                await asyncio.sleep(0.001)
            await socket.send(json.dumps({
                "type": "chunk", "device_id": device_id, "seq": seq, "rev": 0, "t0": seq * 1000, "t1": seq * 1000 + 1000,
                "numerics": [{"ivy_param": "hr", "value": 60 + seq % 60, "unit": "bpm", "device_ts": seq * 1000 + 100,
                              "system_ts": seq * 1000 + 100}],
                "waves": [{"channel": "ecg_ii", "rate_hz": 4, "t0": seq * 1000, "samples_b64": wave}]}))


class LiveCases(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.database = psycopg.connect(URL, autocommit=True, row_factory=dict_row)
        cls.suffix = secrets.token_hex(6)
        cls.username, cls.password = "live_test_" + cls.suffix, secrets.token_urlsafe(18)
        salt = secrets.token_bytes(16)
        hashed = hashlib.scrypt(cls.password.encode(), salt=salt, n=16384, r=8, p=1, dklen=64).hex()
        user_id = cls.database.execute(
            """INSERT INTO auth_user(username,name,role,password_salt,password_hash,is_active,created_at,updated_at)
               VALUES (%s,'Live test','admin',%s,%s,1,1,1) RETURNING id""", (cls.username, salt.hex(), hashed)).fetchone()["id"]
        cls.database.execute("INSERT INTO auth_user_role(user_id,role_code,created_at,updated_at) VALUES (%s,'system_admin',1,1) "
                             "ON CONFLICT DO NOTHING", (user_id,))
        cls.link = cls.database.execute(
            "INSERT INTO leaf_gateway_link(label,data_api_url,created_at,updated_at) VALUES ('test','http://127.0.0.1:9',1,1) RETURNING id"
        ).fetchone()["id"]
        cls.servers = [subprocess.Popen([sys.executable, "-m", "uvicorn", app, "--host", "127.0.0.1", "--port", port,
                                         "--log-level", "warning"]) for app, port in
                       (("app.main:app", "8009"), ("app.live.server:app", "8019"))]
        for url in (API + "/health", f"http://{LIVE}/health"):
            if not wait_for(lambda: cls.ok(url), 20):
                cls.tearDownClass()
                raise RuntimeError(f"{url} failed to start")

    @staticmethod
    def ok(url):
        try:
            with urllib.request.urlopen(url, timeout=2) as response:
                return response.status == 200
        except OSError:
            return False

    @classmethod
    def tearDownClass(cls):
        for server in cls.servers:
            server.terminate()
            server.wait(timeout=10)
        cls.database.close()

    def setUp(self):
        self.token = request("/api/auth/login", {"username": self.username, "password": self.password})[1]["session_token"]
        for case in request("/api/case/active", token=self.token)[1]["cases"]:
            request("/api/case/discharge", {"case_id": case["case_id"],
                                            "discharge_time": max(case["start_time"] + 60_000, int(time.time() * 1000))}, self.token)

    def device(self, name, mode="exclusive"):
        return {"gateway_link_id": self.link, "device_id": f"{name}-{self.suffix}", "mode": mode}

    def start(self, *devices, bed=None, start_time=None):
        return request("/api/case/start", {"hn": "LIVE-" + self.suffix, "start_time": start_time or int(time.time() * 1000),
                                           "bed_label": bed, "devices": list(devices)}, self.token)

    def test_two_active_cases_and_active_list(self):
        status, first = self.start(self.device("a"), bed="Bed 1")
        self.assertEqual(status, 200, first)
        status, second = self.start(self.device("b"), bed="Bed 2")
        self.assertEqual(status, 200, second)
        self.assertEqual(second["case_uuid"], case_uuid(second["case_id"]))
        active = request("/api/case/active", token=self.token)[1]["cases"]
        self.assertEqual({case["case_id"] for case in active}, {first["case_id"], second["case_id"]})
        by_id = {case["case_id"]: case for case in active}
        self.assertEqual(by_id[first["case_id"]]["bed_label"], "Bed 1")
        self.assertEqual([d["device_id"] for d in by_id[second["case_id"]]["devices"]], [f"b-{self.suffix}"])
        binding = by_id[first["case_id"]]["devices"][0]
        self.assertEqual((binding["mode"], binding["gateway_state"], binding["stream"]["connected"]), ("exclusive", "pending", False))
        self.assertEqual(request("/api/case/status", token=self.token)[1]["case_id"], max(first["case_id"], second["case_id"]))
        # A start without devices is not blocked by the active cases either.
        self.assertEqual(self.start()[0], 200)

    def test_exclusive_and_shared_conflicts(self):
        status, owner = self.start(self.device("x"), self.device("z", "shared"))
        self.assertEqual(status, 200, owner)
        self.assertEqual(self.start(self.device("z", "shared"))[0], 200)
        status, clash = self.start(self.device("x", "shared"))
        self.assertEqual((status, clash["error"], clash["case_id"], clash["device_id"]),
                         (409, "device_in_use", owner["case_id"], f"x-{self.suffix}"))
        status, clash = self.start(self.device("z"))
        self.assertEqual((status, clash["error"]), (409, "device_in_use"))
        status, other = self.start(self.device("y"))
        self.assertEqual(status, 200, other)
        path = f"/api/case/{other['case_id']}/devices"
        self.assertEqual(request(path, {"devices": [self.device("x")]}, self.token, "PUT")[0], 409)
        status, body = request(path, {"devices": [self.device("y", "shared"), self.device("w")]}, self.token, "PUT")
        self.assertEqual(status, 200, body)
        self.assertEqual(sorted((d["device_id"], d["mode"]) for d in body["devices"]),
                         [(f"w-{self.suffix}", "exclusive"), (f"y-{self.suffix}", "shared")])
        released = request(path + "?include_released=true", token=self.token)[1]["devices"]
        self.assertIn(("exclusive", "edited"), {(d["mode"], d["release_reason"]) for d in released if d["released_at"]})

    def test_discharge_releases_bindings(self):
        status, case = self.start(self.device("d"))
        self.assertEqual(status, 200, case)
        self.assertEqual(self.start(self.device("d"))[0], 409)
        status, _ = request("/api/case/discharge", {"case_id": case["case_id"], "discharge_time": int(time.time() * 1000)}, self.token)
        self.assertEqual(status, 200)
        row = self.database.execute("SELECT released_at, release_reason FROM case_device_binding WHERE case_id=%s",
                                    (case["case_id"],)).fetchone()
        self.assertIsNotNone(row["released_at"])
        self.assertEqual(row["release_reason"], "discharged")
        self.assertEqual(self.start(self.device("d"))[0], 200)

    def test_cancel_discharge_reopens_and_rebinds(self):
        status, case = self.start(self.device("u"), self.device("v"))
        self.assertEqual(status, 200, case)
        path = f"/api/case/{case['case_id']}/cancel-discharge"
        self.assertEqual(request(path, {}, self.token)[0], 409)  # still active
        status, _ = request("/api/case/discharge", {"case_id": case["case_id"], "discharge_time": int(time.time() * 1000),
                                                    "destination": "IPD ward", "destination_note": "Bed 7"}, self.token)
        self.assertEqual(status, 200)
        # Another case takes one of the released devices before the discharge is cancelled.
        status, other = self.start(self.device("v"))
        self.assertEqual(status, 200, other)
        status, body = request(path, {}, self.token)
        self.assertEqual(status, 200, body)
        self.assertEqual(body["rebound_devices"], [f"u-{self.suffix}"])
        self.assertEqual([item["device_id"] for item in body["skipped_devices"]], [f"v-{self.suffix}"])
        row = self.database.execute("SELECT status, discharge_time, discharge_destination FROM cases WHERE id=%s",
                                    (case["case_id"],)).fetchone()
        self.assertEqual((row["status"], row["discharge_time"], row["discharge_destination"]), ("active", None, None))
        active = request("/api/case/active", token=self.token)[1]["cases"]
        self.assertIn(case["case_id"], {item["case_id"] for item in active})
        audit = self.database.execute("SELECT action FROM case_clinical_audit WHERE case_id=%s ORDER BY id DESC LIMIT 1",
                                      (case["case_id"],)).fetchone()
        self.assertEqual(audit["action"], "case.discharge_cancelled")

    def test_gateway_links(self):
        status, body = request("/api/ward/gateway/links", {"label": "GW 2", "data_api_url": "http://127.0.0.1:9/",
                                                           "stream_url": "ws://127.0.0.1:9/stream/v1", "token": "secret"},
                               self.token)
        self.assertEqual(status, 200, body)
        link = body["link"]
        self.assertNotIn("token", link)
        self.assertTrue(link["has_token"])
        self.assertEqual(link["data_api_url"], "http://127.0.0.1:9")
        self.assertEqual(request(f"/api/ward/gateway/links/{link['id']}", {"token": None}, self.token, "PUT")[1]["link"]["has_token"], False)
        self.assertEqual(request("/api/ward/gateway/links", {"stream_url": "http://nope"}, self.token)[0], 400)
        status, case = self.start({"gateway_link_id": link["id"], "device_id": "gw2-" + self.suffix})
        self.assertEqual(status, 200, case)
        self.assertEqual(request(f"/api/ward/gateway/links/{link['id']}", token=self.token, method="DELETE")[0], 409)
        request("/api/case/discharge", {"case_id": case["case_id"], "discharge_time": int(time.time() * 1000)}, self.token)
        self.assertEqual(request(f"/api/ward/gateway/links/{link['id']}", token=self.token, method="DELETE")[0], 200)
        self.assertNotIn(link["id"], [row["id"] for row in request("/api/ward/gateway/links", token=self.token)[1]["links"]])

    def test_device_writer_reads_bound_devices(self):
        """Minute pull per bound device (device_id), merged; seconds the stream covered are not fetched."""
        import http.server
        from urllib.parse import parse_qs
        from app.database import open_pool
        from app.device_writer import DeviceWriter
        seen = []

        class DataApi(http.server.BaseHTTPRequestHandler):
            def do_GET(self):
                query = {key: value[0] for key, value in parse_qs(urlparse(self.path).query).items()}
                seen.append(query)
                start = int(query["from"])
                rows = {f"mon-{LiveCases.suffix}": [{"ivy_param": "hr", "value": 70, "unit": "bpm", "system_ts": start + 5000}],
                        f"vent-{LiveCases.suffix}": [{"ivy_param": "hr", "value": 99, "system_ts": start + 9000},
                                                     {"ivy_param": "etco2", "value": 35, "unit": "mmHg", "system_ts": start + 1000}]
                        }.get(query.get("device_id"), [])
                body = json.dumps(rows).encode()
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(body)

            def log_message(self, *_):
                pass

        server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), DataApi)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        link = self.database.execute(
            "INSERT INTO leaf_gateway_link(label,data_api_url,created_at,updated_at) VALUES ('pull',%s,1,1) RETURNING id",
            (f"http://127.0.0.1:{server.server_address[1]}",)).fetchone()["id"]
        try:
            devices = [{"gateway_link_id": link, "device_id": f"{name}-{self.suffix}"} for name in ("mon", "vent")]
            status, case = self.start(*devices, start_time=int(time.time() * 1000) - 20 * 60_000)
            self.assertEqual(status, 200, case)
            first = case["device_capture_start_time"]
            covered = first + 60_000
            for device in devices:
                for seq in range(covered // 1000, covered // 1000 + 60):
                    self.database.execute("INSERT INTO stream_second(case_id,device_id,seq,numerics,received_at) VALUES (%s,%s,%s,'[]',1)",
                                          (case["case_id"], device["device_id"], seq))
            open_pool()
            writer = DeviceWriter()
            writer.settle_ms = 0
            writer._tick()
            payload = self.database.execute("SELECT payload FROM vital_minutes WHERE case_id=%s AND ts_minute=%s",
                                            (case["case_id"], first)).fetchone()["payload"]
            self.assertEqual(json.loads(payload), {"hr": 70, "etco2": 35})
            self.assertEqual({q.get("device_id") for q in seen}, {d["device_id"] for d in devices})
            self.assertNotIn(str(covered), {q["from"] for q in seen})
            self.assertIn(str(covered + 60_000), {q["from"] for q in seen})
        finally:
            server.shutdown()

    def test_live_stream_stores_acks_and_pushes(self):
        from websockets.sync.client import connect
        hub = FakeHub()
        stream_link = self.database.execute(
            """INSERT INTO leaf_gateway_link(label,stream_url,token,created_at,updated_at)
               VALUES ('hub',%s,%s,1,1) RETURNING id""", (f"ws://127.0.0.1:{HUB_PORT}/stream/v1", HUB_TOKEN)).fetchone()["id"]
        try:
            device = {"gateway_link_id": stream_link, "device_id": "m540-" + self.suffix, "mode": "exclusive"}
            status, case = self.start(device, start_time=int(time.time() * 1000) - 20 * 60_000)
            self.assertEqual(status, 200, case)
            case_id = case["case_id"]
            bind = wait_for(lambda: next((m for m in hub.messages if m.get("type") == "bind"), None))
            self.assertIsNotNone(bind, hub.messages)
            self.assertEqual((bind["case_uuid"], bind["mode"], bind["resume_seq"]),
                             (case_uuid(case_id), "exclusive", case["device_capture_start_time"] // 1000))
            self.assertEqual(hub.messages[0]["leaf_id"], "leaf-live-test")
            self.assertTrue(wait_for(lambda: self.database.execute(
                "SELECT gateway_state FROM case_device_binding WHERE case_id=%s", (case_id,)).fetchone()["gateway_state"] == "bound"))
            with connect(f"ws://{LIVE}/api/live/ws") as browser:
                browser.send(json.dumps({"type": "auth", "token": "wrong"}))
                self.assertEqual(json.loads(browser.recv(5))["code"], "unauthorized")
            with connect(f"ws://{LIVE}/api/live/ws") as browser:
                browser.send(json.dumps({"type": "auth", "token": self.token}))
                self.assertEqual(json.loads(browser.recv(5))["type"], "ready")
                browser.send(json.dumps({"type": "subscribe", "case_id": case_id}))
                self.assertEqual(json.loads(browser.recv(5))["type"], "status")
                hub.release.set()
                received = []
                while len([m for m in received if m["type"] == "chunk"]) < 65:
                    received.append(json.loads(browser.recv(10)))
            first = bind["resume_seq"]
            chunk = next(m for m in received if m["type"] == "chunk")
            self.assertEqual((chunk["case_id"], chunk["seq"], chunk["numerics"]), (case_id, first, {"hr": 60 + first % 60}))
            self.assertEqual(chunk["waves"][0]["samples"], [0, 100, -100, 0])
            self.assertEqual(wait_for(lambda: hub.acks.get(device["device_id"]) == first + 64), True)
            stored = self.database.execute("SELECT count(*) AS n, max(seq) AS last FROM stream_second WHERE case_id=%s",
                                           (case_id,)).fetchone()
            self.assertEqual((stored["n"], stored["last"]), (65, first + 64))
            self.assertEqual(self.database.execute("SELECT count(*) AS n FROM stream_wave WHERE case_id=%s", (case_id,)).fetchone()["n"], 65)
            minute = self.database.execute(
                "SELECT payload FROM vital_minutes WHERE case_id=%s AND ivy_source='vector' AND ts_minute=%s",
                (case_id, first * 1000)).fetchone()
            self.assertEqual(json.loads(minute["payload"]), {"hr": 60})
            binding = request(f"/api/case/{case_id}/devices", token=self.token)[1]["devices"][0]
            self.assertEqual(binding["stream"]["last_seq"], first + 64)
            request("/api/case/discharge", {"case_id": case_id, "discharge_time": int(time.time() * 1000)}, self.token)
            unbind = wait_for(lambda: next((m for m in hub.messages if m.get("type") == "unbind"), None))
            self.assertEqual((unbind["case_uuid"], unbind["reason"]), (case_uuid(case_id), "discharged"))
        finally:
            self.database.execute("UPDATE leaf_gateway_link SET stream_url=NULL WHERE id=%s", (stream_link,))
            hub.stop()

    def test_backlog_catch_up_is_batched(self):
        """A 600 s backlog (case start on the quarter hour) is stored in batches with one cumulative ack each."""
        hub = FakeHub(seconds=600, port=HUB_PORT + 1, max_unacked=int(os.getenv("FAKE_HUB_MAX_UNACKED", "300")))
        stream_link = self.database.execute(
            """INSERT INTO leaf_gateway_link(label,stream_url,token,created_at,updated_at)
               VALUES ('backlog',%s,%s,1,1) RETURNING id""", (f"ws://127.0.0.1:{HUB_PORT + 1}/stream/v1", HUB_TOKEN)).fetchone()["id"]
        try:
            device = {"gateway_link_id": stream_link, "device_id": "backlog-" + self.suffix, "mode": "exclusive"}
            status, case = self.start(device, start_time=int(time.time() * 1000) - 20 * 60_000)
            self.assertEqual(status, 200, case)
            case_id, first = case["case_id"], case["device_capture_start_time"] // 1000
            self.assertTrue(wait_for(lambda: self.database.execute(
                "SELECT gateway_state FROM case_device_binding WHERE case_id=%s", (case_id,)).fetchone()["gateway_state"] == "bound"))
            started = time.time()
            hub.release.set()
            self.assertTrue(wait_for(lambda: hub.acks.get(device["device_id"]) == first + 599, 60), hub.acks)
            elapsed = time.time() - started
            print(f"\nbacklog catch-up: 600 chunks in {elapsed:.2f} s = {600 / elapsed:.0f} chunks/s", file=sys.stderr)
            stored = self.database.execute("SELECT count(*) AS n, min(seq) AS first, max(seq) AS last FROM stream_second "
                                           "WHERE case_id=%s", (case_id,)).fetchone()
            self.assertEqual((stored["n"], stored["first"], stored["last"]), (600, first, first + 599))
            self.assertEqual(self.database.execute("SELECT count(*) AS n FROM stream_wave WHERE case_id=%s",
                                                   (case_id,)).fetchone()["n"], 600)
            minutes = self.database.execute("SELECT count(*) AS n FROM vital_minutes WHERE case_id=%s AND ivy_source='vector'",
                                            (case_id,)).fetchone()["n"]
            self.assertGreaterEqual(minutes, 9)
            acks = [m for m in hub.messages if m.get("type") == "ack" and m["device_id"] == device["device_id"]]
            self.assertLess(len(acks), 600, "acks are cumulative per batch")
            self.assertLess(elapsed, float(os.getenv("BACKLOG_MAX_SECONDS", "6")), f"{600 / elapsed:.0f} chunks/s")
        finally:
            self.database.execute("UPDATE leaf_gateway_link SET stream_url=NULL WHERE id=%s", (stream_link,))
            hub.stop()

    def test_stream_retention_spares_active_cases(self):
        from app.database import open_pool
        from app.live import store
        open_pool()
        now = int(time.time() * 1000)
        status, done = self.start(start_time=now - 7_200_000)
        self.assertEqual(status, 200, done)
        request("/api/case/discharge", {"case_id": done["case_id"], "discharge_time": now}, self.token)
        status, active = self.start()
        self.assertEqual(status, 200, active)
        day = 86_400_000
        for case_id in (done["case_id"], active["case_id"]):
            for age_days in (40, 10, 1):  # second kept 30 d, wave 7 d
                t0 = now - age_days * day
                for offset in range(3):  # three rows per age, batch of 2 below
                    self.database.execute(
                        "INSERT INTO stream_second(case_id,device_id,seq,numerics,received_at) VALUES (%s,'ret',%s,'[]',1)",
                        (case_id, t0 // 1000 + offset))
                    self.database.execute(
                        "INSERT INTO stream_wave(case_id,device_id,channel,t0,rate_hz,samples,received_at) "
                        "VALUES (%s,'ret','ecg',%s,1,'',1)", (case_id, t0 + offset * 1000))
        deleted = store.prune_streams(wave_days=7, second_days=30, now=now, batch=2)
        self.assertGreaterEqual(deleted["stream_wave"], 6)
        self.assertGreaterEqual(deleted["stream_second"], 3)
        count = lambda table, case_id: self.database.execute(
            f"SELECT count(*) AS n FROM {table} WHERE case_id=%s AND device_id='ret'", (case_id,)).fetchone()["n"]
        self.assertEqual((count("stream_wave", done["case_id"]), count("stream_second", done["case_id"])), (3, 6))
        self.assertEqual((count("stream_wave", active["case_id"]), count("stream_second", active["case_id"])), (9, 9))


if __name__ == "__main__":
    unittest.main()
