"""PostgreSQL minute writer for Vector device observations.

This is intentionally owned by the Leaf API process: active cases are discovered
from PostgreSQL, observations are read from Vector, and minute payloads are
upserted directly into PostgreSQL. No local database or companion JS service is
involved.

A case with gateway device bindings (case_device_binding) reads each bound device from its
gateway link; a case without bindings reads every device of this Leaf, as before. A minute is
read once it is DEVICE_WRITER_SETTLE_SECONDS old, an empty recent minute is read once more, and
minutes the live stream (leaf-live, stream_second) fully covered are skipped.
"""
import json
import os
import threading
import time
import urllib.parse
import urllib.request

from .database import pool
from .vitals_mapping import minute_payload


class DeviceWriter:
    def __init__(self):
        self.enabled = os.getenv("FLORA_DEVICE_INGEST_ENABLED", "true").lower() == "true"
        # Fallback when the gateway wizard has not stored a source (leaf_device_source).
        self.base = os.getenv("VECTOR_READ_URL", "http://host.docker.internal:6789/api/observations").rstrip("/")
        self.leaf_id = os.getenv("FLORA_LEAF_ID", "").strip()
        self.interval = max(.5, float(os.getenv("DEVICE_WRITER_POLL_SECONDS", "2")))
        self.timeout = max(1, float(os.getenv("DEVICE_WRITER_TIMEOUT_SECONDS", "5")))
        self.settle_ms = max(0, int(float(os.getenv("DEVICE_WRITER_SETTLE_SECONDS", "60")) * 1000))
        self.recheck_ms = max(0, int(float(os.getenv("DEVICE_WRITER_RECHECK_MINUTES", "10")) * 60000))
        self.states = {}
        self.stop_event = threading.Event()
        self.thread = None

    def start(self):
        if not self.enabled or self.thread:
            return
        self.thread = threading.Thread(target=self._loop, name="flora-vector-writer", daemon=True)
        self.thread.start()

    def stop(self):
        self.stop_event.set()
        if self.thread:
            self.thread.join(timeout=5)
        self.thread = None

    def refetch(self, case_id):
        self.states.setdefault(case_id, {})["currentMinute"] = None

    def status(self, case_id=None):
        rows = [dict(caseId=key, **value) for key, value in self.states.items()]
        return next((row for row in rows if row["caseId"] == case_id), None) if case_id else rows

    def source(self, database=None):
        """(observations URL, extra query) — the default gateway link (wizard) first, else VECTOR_READ_URL."""
        def read(connection):
            for sql in ("SELECT data_api_url FROM leaf_gateway_link WHERE is_default AND data_api_url IS NOT NULL",
                        "SELECT data_api_url FROM leaf_device_source WHERE id=1"):
                try:
                    with connection.transaction():
                        row = connection.execute(sql).fetchone()
                except Exception:
                    row = None
                if row and row["data_api_url"]:
                    return row
            return None
        try:
            if database is not None:
                row = read(database)
            else:
                with pool.connection() as connection:
                    row = read(connection)
        except Exception:
            row = None
        if row and row["data_api_url"]:
            return row["data_api_url"].rstrip("/") + "/api/observations", ({"leaf_id": self.leaf_id} if self.leaf_id else {})
        return self.base, {}

    def sources(self, database, bindings, links):
        """Where a case's minute comes from: one query per bound device, or the Leaf-wide default."""
        if not bindings:
            return [self.source(database)]
        default = self.source(database)[0]
        return [((links.get(link) or "").rstrip("/") + "/api/observations" if links.get(link) else default,
                 {"device_id": device}) for link, device in bindings]

    def source_status(self, online_window_sec=30):
        base, extra = self.source()
        parsed = urllib.parse.urlsplit(base)
        path = parsed.path
        if path.endswith("/api/observations"):
            path = path[:-len("/api/observations")] + "/api/devices/status"
        else:
            path = "/api/devices/status"
        query = urllib.parse.urlencode({"online_window_sec": online_window_sec, **extra})
        url = urllib.parse.urlunsplit((parsed.scheme, parsed.netloc, path, query, ""))
        with urllib.request.urlopen(url, timeout=self.timeout) as response:
            payload = json.load(response)
        if not isinstance(payload, dict):
            raise ValueError("Vector status response is not an object")
        return payload

    def _loop(self):
        while not self.stop_event.wait(self.interval):
            try:
                self._tick()
            except Exception as error:
                self.states[0] = {"running": False, "lastError": str(error), "lastTickTs": int(time.time()*1000)}

    def _tick(self):
        with pool.connection() as database:
            cases = database.execute("SELECT id,hn,start_time,device_capture_start_time FROM cases WHERE status='active'").fetchall()
            active = {row["id"] for row in cases}
            for stale in set(self.states) - active - {0}:
                self.states.pop(stale, None)
            bound, links = {}, {}
            try:
                with database.transaction():
                    for row in database.execute(
                            "SELECT case_id,gateway_link_id,device_id FROM case_device_binding WHERE released_at IS NULL").fetchall():
                        bound.setdefault(row["case_id"], []).append((row["gateway_link_id"], row["device_id"]))
                    links = {row["id"]: row["data_api_url"] for row in
                             database.execute("SELECT id,data_api_url FROM leaf_gateway_link").fetchall()}
            except Exception:  # before migration 0090: no bindings, the Leaf-wide source
                bound, links = {}, {}
            now = int(time.time()*1000)
            ready = now - self.settle_ms
            for case in cases:
                state = self.states.setdefault(case["id"], {"running": False, "startedAt": now,
                    "lastTickTs": None, "lastWrittenMinute": None, "lastError": None, "consecutiveErrors": 0,
                    "currentMinute": None, "recheck": {}})
                state.setdefault("recheck", {})
                if state["currentMinute"] is None:
                    last = database.execute("SELECT max(ts_minute) AS value FROM vital_minutes WHERE case_id=%s", (case["id"],)).fetchone()["value"]
                    capture = case["device_capture_start_time"] or case["start_time"]
                    state["currentMinute"] = (last + 60000) if last else capture//60000*60000
                state["running"], state["lastTickTs"] = True, now
                bindings = bound.get(case["id"], [])
                try:
                    rounds = 0
                    while state["currentMinute"] + 60000 <= ready and rounds < 60:
                        minute = state["currentMinute"]
                        written = self._write_minute(database, case, minute, bindings, links)
                        if written:
                            state["lastWrittenMinute"] = minute
                        elif minute >= now - self.recheck_ms:
                            # Late frames: an empty recent minute is read once more after another settle delay.
                            state["recheck"][minute] = now + self.settle_ms
                        state["currentMinute"] += 60000
                        rounds += 1
                    for minute, due in sorted(state["recheck"].items()):
                        if due <= now:
                            state["recheck"].pop(minute)
                            if self._write_minute(database, case, minute, bindings, links):
                                state["lastWrittenMinute"] = max(state["lastWrittenMinute"] or 0, minute)
                    state["lastError"], state["consecutiveErrors"] = None, 0
                except Exception as error:
                    state["lastError"] = str(error)
                    state["consecutiveErrors"] += 1
                finally:
                    state["running"] = False

    @staticmethod
    def _stream_covered(database, case, minute, bindings):
        """Every bound device has all 60 seconds of this minute from the live stream."""
        if not bindings:
            return False
        try:
            with database.transaction():
                row = database.execute(
                    """SELECT count(*) AS n FROM stream_second WHERE case_id=%s AND device_id = ANY(%s)
                       AND seq >= %s AND seq < %s""",
                    (case["id"], sorted({device for _, device in bindings}), minute // 1000, minute // 1000 + 60)).fetchone()
        except Exception:
            return False
        return row["n"] >= 60 * len({device for _, device in bindings})

    def _write_minute(self, database, case, minute, bindings=(), links=None):
        if self._stream_covered(database, case, minute, bindings):
            return True
        urls = [base + "?" + urllib.parse.urlencode({"from": minute, "to": minute + 60000, **extra})
                for base, extra in self.sources(database, bindings, links or {})]
        url = " ".join(urls)
        created = int(time.time()*1000)
        try:
            rows = []
            for each in urls:
                with urllib.request.urlopen(each, timeout=self.timeout) as response:
                    part = json.load(response)
                if not isinstance(part, list):
                    raise ValueError("Vector response is not an array")
                rows.extend(part)
            rows.sort(key=lambda row: (row.get("system_ts") or 0))
            payload = minute_payload(rows)
            if payload:
                database.execute("""INSERT INTO vital_minutes(case_id,ivy_source,ts_minute,payload,created_at)
                  VALUES (%s,'vector',%s,%s,%s) ON CONFLICT (case_id,ivy_source,ts_minute)
                  DO UPDATE SET payload=excluded.payload,created_at=excluded.created_at""",
                  (case["id"], minute, json.dumps(payload), created))
            self._audit(database, case, url, minute, len(rows), len(payload), "ok" if payload else "empty", None)
            return bool(payload)
        except Exception as error:
            self._audit(database, case, url, minute, 0, 0, "failed", str(error))
            raise

    # The audit is the import's provenance, not a heartbeat: an empty fetch or the same failure again (a device or the
    # Vector service offline: every minute, for every active case) is written once an hour, a change at once; rows
    # older than AUDIT_KEEP_DAYS are deleted. Without this the table grew by a row per case per minute, for ever.
    AUDIT_REPEAT_MS = 3600 * 1000
    AUDIT_KEEP_DAYS = int(os.getenv("FLORA_DEVICE_AUDIT_KEEP_DAYS", "30"))
    _audit_last: dict[int, tuple[str, str | None, int]] = {}
    _audit_pruned = 0

    @classmethod
    def _audit(cls, database, case, url, minute, raw, written, status, detail):
        now = int(time.time() * 1000)
        last = cls._audit_last.get(case["id"])
        if status in ("empty", "failed") and last and last[0] == status and last[1] == detail and now - last[2] < cls.AUDIT_REPEAT_MS:
            return
        cls._audit_last[case["id"]] = (status, detail, now)
        if now - cls._audit_pruned > cls.AUDIT_REPEAT_MS:
            cls._audit_pruned = now
            database.execute("DELETE FROM case_device_ingest_audit WHERE created_at < %s", (now - cls.AUDIT_KEEP_DAYS * 86400 * 1000,))
        database.execute("""INSERT INTO case_device_ingest_audit(case_id,hn,source_service,source_endpoint,fetch_mode,
          minute_ts,from_ts,to_ts,raw_row_count,written_row_count,status,detail_json,created_at)
          VALUES (%s,%s,'vector',%s,'minute',%s,%s,%s,%s,%s,%s,%s,%s)""",
          (case["id"], case["hn"], url, minute, minute, minute+60000, raw, written, status,
           json.dumps({"message": detail}) if detail else None, int(time.time()*1000)))


device_writer = DeviceWriter()
