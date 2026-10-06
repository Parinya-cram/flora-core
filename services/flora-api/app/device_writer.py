"""PostgreSQL minute writer for Vector device observations.

This is intentionally owned by the Leaf API process: active cases are discovered
from PostgreSQL, observations are read from Vector, and minute payloads are
upserted directly into PostgreSQL. No local database or companion JS service is
involved.
"""
import json
import math
import os
import threading
import time
import urllib.parse
import urllib.request

from .database import pool

PARAMETERS = {
    "hr":"hr", "heart_rate":"hr", "pulse_rate":"pr", "spo2_pr":"pr", "pr":"pr", "art_pr":"art_pr",
    "spo2":"spo2", "resp_rate":"rr", "rr":"rr", "etco2":"etco2", "temperature":"temperature",
    "temp1":"temperature", "temp2":"temperature", "temp3":"temperature", "temp4":"temperature",
    "nibp_sys":"nibp_sys", "nibp_dia":"nibp_dia", "nibp_mean":"nibp_map", "nibp_map":"nibp_map",
    "art_sys":"art_sys", "art_dia":"art_dia", "art_mean":"art_map", "art_map":"art_map", "cvp":"cvp",
    "vent_mode":"set_vent_mode", "tidal_volume_exp":"tidal_volume_exp", "minute_volume":"minute_volume_exp",
    "minute_volume_exp":"minute_volume_exp", "fio2":"fio2", "airway_pressure_peak":"airway_pressure_peak",
    "airway_pressure_plat":"airway_pressure_plateau", "airway_pressure_plateau":"airway_pressure_plateau",
    "airway_pressure_mean":"airway_pressure_mean", "airway_pressure_min":"airway_pressure_min", "mv_spont":"mv_spont",
    "rr_spont":"rr_spont", "peep_intrinsic":"peep_intrinsic", "compliance":"compliance",
    "peep_extrinsic":"peep_extrinsic", "peep_total":"peep_total", "fio2_meas":"fio2_meas", "et_o2":"et_o2",
    "fi_co2":"fi_co2", "et_co2":"et_co2", "fi_agent":"fi_agent", "et_agent":"et_agent", "agent_id":"agent_id",
    "fi_n2o":"fi_n2o", "et_n2o":"et_n2o", "mac":"mac", "flow_o2":"flow_o2", "flow_n2o":"flow_n2o",
    "flow_air":"flow_air", "set_vent_mode":"set_vent_mode", "tv_set":"set_tidal_volume",
    "set_tidal_volume":"set_tidal_volume", "rr_set":"set_rr", "set_rr":"set_rr", "ie_ratio":"set_ie_ratio",
    "set_ie_ratio":"set_ie_ratio", "peep_set":"set_peep", "set_peep":"set_peep", "peak_limit":"set_peak_limit",
    "set_peak_limit":"set_peak_limit", "insp_pres_set":"set_insp_pressure", "set_insp_pressure":"set_insp_pressure",
    "fio2_set":"set_fio2", "set_fio2":"set_fio2", "fgf_total":"set_fgf_total", "set_fgf_total":"set_fgf_total",
    "psupp":"set_psupp", "set_psupp":"set_psupp", "flow_trigger":"set_flow_trigger",
    "set_flow_trigger":"set_flow_trigger", "end_flow":"set_end_flow", "set_end_flow":"set_end_flow",
    "t_insp_set":"set_t_insp", "set_t_insp":"set_t_insp", "etaa":"et_agent", "fiaa":"fi_agent",
    "unknown::147842":"hr", "unknown::149530":"pr", "unknown::149522":"art_pr", "unknown::150456":"spo2",
    "unknown::150021":"nibp_sys", "unknown::150022":"nibp_dia", "unknown::150023":"nibp_map",
    "unknown::mdc_press_bld_noninv_sys":"nibp_sys", "unknown::mdc_press_bld_noninv_dia":"nibp_dia",
    "unknown::mdc_press_bld_noninv_mean":"nibp_map", "unknown::150087":"cvp",
    "unknown::measured fi anesthetic agent conc fiaa":"fi_agent",
    "unknown::measured end tidal anesthetic agent conc etaa":"et_agent",
}


class DeviceWriter:
    def __init__(self):
        self.enabled = os.getenv("FLORA_DEVICE_INGEST_ENABLED", "true").lower() == "true"
        # Fallback when the gateway wizard has not stored a source (leaf_device_source).
        self.base = os.getenv("VECTOR_READ_URL", "http://host.docker.internal:6789/api/observations").rstrip("/")
        self.leaf_id = os.getenv("FLORA_LEAF_ID", "").strip()
        self.interval = max(.5, float(os.getenv("DEVICE_WRITER_POLL_SECONDS", "2")))
        self.timeout = max(1, float(os.getenv("DEVICE_WRITER_TIMEOUT_SECONDS", "5")))
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
        """(observations URL, extra query) — the wizard's gateway first, else VECTOR_READ_URL."""
        try:
            if database is not None:
                row = database.execute("SELECT data_api_url FROM leaf_device_source WHERE id=1").fetchone()
            else:
                with pool.connection() as connection:
                    row = connection.execute("SELECT data_api_url FROM leaf_device_source WHERE id=1").fetchone()
        except Exception:
            row = None
        if row and row["data_api_url"]:
            return row["data_api_url"].rstrip("/") + "/api/observations", ({"leaf_id": self.leaf_id} if self.leaf_id else {})
        return self.base, {}

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
            now_minute = int(time.time()*1000)//60000*60000
            for case in cases:
                state = self.states.setdefault(case["id"], {"running": False, "startedAt": int(time.time()*1000),
                    "lastTickTs": None, "lastWrittenMinute": None, "lastError": None, "consecutiveErrors": 0,
                    "currentMinute": None})
                if state["currentMinute"] is None:
                    last = database.execute("SELECT max(ts_minute) AS value FROM vital_minutes WHERE case_id=%s", (case["id"],)).fetchone()["value"]
                    capture = case["device_capture_start_time"] or case["start_time"]
                    state["currentMinute"] = (last + 60000) if last else capture//60000*60000
                state["running"], state["lastTickTs"] = True, int(time.time()*1000)
                try:
                    rounds = 0
                    while state["currentMinute"] < now_minute and rounds < 60:
                        if self._write_minute(database, case, state["currentMinute"]):
                            state["lastWrittenMinute"] = state["currentMinute"]
                        state["currentMinute"] += 60000
                        rounds += 1
                    state["lastError"], state["consecutiveErrors"] = None, 0
                except Exception as error:
                    state["lastError"] = str(error)
                    state["consecutiveErrors"] += 1
                finally:
                    state["running"] = False

    def _write_minute(self, database, case, minute):
        base, extra = self.source(database)
        url = base + "?" + urllib.parse.urlencode({"from": minute, "to": minute + 60000, **extra})
        created = int(time.time()*1000)
        try:
            with urllib.request.urlopen(url, timeout=self.timeout) as response:
                rows = json.load(response)
            if not isinstance(rows, list):
                raise ValueError("Vector response is not an array")
            selected = {}
            for row in rows:
                key = PARAMETERS.get(str(row.get("ivy_param", "")).strip().lower())
                if not key:
                    continue
                value, priority = row.get("value"), 0
                if key in {"et_co2", "fi_co2"} and isinstance(value, (int, float)) and math.isfinite(value):
                    unit = str(row.get("unit", "")).strip().lower()
                    if unit == "mmhg": priority = 3
                    elif unit == "kpa": value, priority = round(value * 7.50062, 1), 2
                    elif unit == "%": value, priority = round(value * 7.6, 1), 1
                if key not in selected or priority > selected[key][1]:
                    selected[key] = (value, priority)
            payload = {key: value[0] for key, value in selected.items()}
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

    @staticmethod
    def _audit(database, case, url, minute, raw, written, status, detail):
        database.execute("""INSERT INTO case_device_ingest_audit(case_id,hn,source_service,source_endpoint,fetch_mode,
          minute_ts,from_ts,to_ts,raw_row_count,written_row_count,status,detail_json,created_at)
          VALUES (%s,%s,'vector',%s,'minute',%s,%s,%s,%s,%s,%s,%s,%s)""",
          (case["id"], case["hn"], url, minute, minute, minute+60000, raw, written, status,
           json.dumps({"message": detail}) if detail else None, int(time.time()*1000)))


device_writer = DeviceWriter()
