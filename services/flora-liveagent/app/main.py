"""Deterministic Vector-compatible observation source for Flora Leaf demos.

This service is synthetic and must never be presented as a medical device.
It implements the read endpoints consumed by Flora's device minute writer so
the demo follows the same API -> normalization -> PostgreSQL path as Vector.
"""

from __future__ import annotations

import math
import os
import time
from typing import Any

from fastapi import FastAPI, HTTPException, Query
from .bbraun import PUMPS, fields as pump_fields


SERVICE_STARTED_AT = int(time.time() * 1000)
PROFILE = os.getenv("LIVEAGENT_PROFILE", "stable-anes").strip() or "stable-anes"
SEED = int(os.getenv("LIVEAGENT_SEED", "17"))
MAX_WINDOW_MINUTES = max(1, int(os.getenv("LIVEAGENT_MAX_WINDOW_MINUTES", "240")))
PUMP_START_MS = int(os.getenv("LIVEAGENT_PUMP_START_MS") or SERVICE_STARTED_AT // 60_000 * 60_000)


def pumps_enabled():
    return PROFILE in {"bbraun", "stable-anes-bbraun"}

app = FastAPI(title="Flora LiveAgent", version="1.0.0")


def _wave(minute: int, period: float, amplitude: float, phase: float = 0.0) -> float:
    return math.sin((minute + SEED) / period + phase) * amplitude


def _rounded(value: float, digits: int = 0) -> int | float:
    return int(round(value)) if digits == 0 else round(value, digits)


def _row(
    timestamp: int,
    device_id: str,
    protocol: str,
    ivy_param: str,
    value: Any,
    unit: str,
) -> dict[str, Any]:
    return {
        "device_id": device_id,
        "source": "liveagent",
        "protocol": protocol,
        "raw_code": f"DEMO_{ivy_param.upper()}",
        "ivy_param": ivy_param,
        "value": value,
        "unit": unit,
        "device_ts": timestamp,
        "system_ts": timestamp,
        "synthetic": True,
    }

def observations_for_minute(minute_ts: int) -> list[dict[str, Any]]:
    """Return a clinically plausible but explicitly synthetic minute snapshot."""
    minute = minute_ts // 60_000
    timestamp = minute_ts + 55_000
    if PROFILE == "bbraun":
        return pump_observations(timestamp)
    monitor = "LIVEAGENT_MONITOR_01"
    machine = "LIVEAGENT_ANES_01"

    hr = _rounded(72 + _wave(minute, 5.4, 7) + _wave(minute, 2.1, 2))
    pulse = _rounded(hr + _wave(minute, 3.7, 1))
    spo2 = _rounded(98 + _wave(minute, 8.0, 1))
    rr = _rounded(13 + _wave(minute, 6.2, 2))
    etco2 = _rounded(37 + _wave(minute, 5.8, 3), 1)
    temperature = _rounded(36.7 + _wave(minute, 42.0, 0.25), 1)
    art_sys = _rounded(118 + _wave(minute, 7.1, 10))
    art_dia = _rounded(66 + _wave(minute, 7.1, 6, 0.2))
    art_map = _rounded((art_sys + 2 * art_dia) / 3)
    cvp = _rounded(7 + _wave(minute, 4.9, 2))

    rows = [
        _row(timestamp, monitor, "hl7", "hr", hr, "bpm"),
        _row(timestamp, monitor, "hl7", "pr", pulse, "bpm"),
        _row(timestamp, monitor, "hl7", "spo2", spo2, "%"),
        _row(timestamp, monitor, "hl7", "rr", rr, "rpm"),
        _row(timestamp, monitor, "hl7", "etco2", etco2, "mmHg"),
        _row(timestamp, monitor, "hl7", "temperature", temperature, "Cel"),
        _row(timestamp, monitor, "hl7", "art_sys", art_sys, "mmHg"),
        _row(timestamp, monitor, "hl7", "art_dia", art_dia, "mmHg"),
        _row(timestamp, monitor, "hl7", "art_map", art_map, "mmHg"),
        _row(timestamp, monitor, "hl7", "art_pr", pulse, "bpm"),
        _row(timestamp, monitor, "hl7", "cvp", cvp, "mmHg"),
        _row(timestamp, machine, "anes_machine", "set_vent_mode", "VCV", ""),
        _row(timestamp, machine, "anes_machine", "tidal_volume_exp", _rounded(495 + _wave(minute, 3.9, 18)), "mL"),
        _row(timestamp, machine, "anes_machine", "minute_volume_exp", _rounded(6.4 + _wave(minute, 6.0, 0.35), 1), "L/min"),
        _row(timestamp, machine, "anes_machine", "fio2", _rounded(40 + _wave(minute, 12.0, 2)), "%"),
        _row(timestamp, machine, "anes_machine", "airway_pressure_peak", _rounded(21 + _wave(minute, 5.0, 2), 1), "cmH2O"),
        _row(timestamp, machine, "anes_machine", "airway_pressure_plateau", _rounded(17 + _wave(minute, 5.0, 1.5), 1), "cmH2O"),
        _row(timestamp, machine, "anes_machine", "airway_pressure_mean", _rounded(10 + _wave(minute, 6.0, 1), 1), "cmH2O"),
        _row(timestamp, machine, "anes_machine", "peep_extrinsic", 5.0, "cmH2O"),
        _row(timestamp, machine, "anes_machine", "compliance", _rounded(38 + _wave(minute, 8.0, 3)), "mL/cmH2O"),
        _row(timestamp, machine, "anes_machine", "agent_id", "SEVO", ""),
        _row(timestamp, machine, "anes_machine", "fi_agent", _rounded(1.8 + _wave(minute, 15.0, 0.15), 2), "%"),
        _row(timestamp, machine, "anes_machine", "et_agent", _rounded(1.5 + _wave(minute, 15.0, 0.12), 2), "%"),
        _row(timestamp, machine, "anes_machine", "mac", _rounded(0.9 + _wave(minute, 16.0, 0.08), 2), "1"),
        _row(timestamp, machine, "anes_machine", "flow_o2", _rounded(1.0 + _wave(minute, 11.0, 0.08), 1), "L/min"),
        _row(timestamp, machine, "anes_machine", "flow_air", _rounded(1.0 + _wave(minute, 13.0, 0.08), 1), "L/min"),
        _row(timestamp, machine, "anes_machine", "set_tidal_volume", 500, "mL"),
        _row(timestamp, machine, "anes_machine", "set_rr", 12, "rpm"),
        _row(timestamp, machine, "anes_machine", "set_peep", 5, "cmH2O"),
        _row(timestamp, machine, "anes_machine", "set_fio2", 40, "%"),
    ]

    # NIBP is intermittent like a real cuff cycle instead of appearing every minute.
    if minute % 5 == 0:
        nibp_sys = _rounded(116 + _wave(minute, 8.4, 9))
        nibp_dia = _rounded(65 + _wave(minute, 8.4, 5, 0.25))
        rows.extend(
            [
                _row(timestamp, monitor, "hl7", "nibp_sys", nibp_sys, "mmHg"),
                _row(timestamp, monitor, "hl7", "nibp_dia", nibp_dia, "mmHg"),
                _row(timestamp, monitor, "hl7", "nibp_map", _rounded((nibp_sys + 2 * nibp_dia) / 3), "mmHg"),
            ]
        )
    if pumps_enabled():
        rows.extend(pump_observations(timestamp))
    return rows


def pump_observations(timestamp: int) -> list[dict[str, Any]]:
    if timestamp < PUMP_START_MS:
        return []
    rows = []
    for pump in PUMPS:
        for code, param, value, unit in pump_fields(pump, (timestamp - PUMP_START_MS) / 60_000):
            row = _row(timestamp, pump["device_id"], "bbraun-bcc", param, value, unit)
            row["raw_code"] = "BCC_" + code
            if param == "run_state":
                row["status_encoding"] = "synthetic-label"
            rows.append(row)
    return rows


def _validate_window(from_ts: int, to_ts: int) -> tuple[int, int]:
    if to_ts <= from_ts:
        raise HTTPException(status_code=400, detail="to must be greater than from")
    if to_ts - from_ts > MAX_WINDOW_MINUTES * 60_000:
        raise HTTPException(status_code=400, detail=f"window exceeds {MAX_WINDOW_MINUTES} minutes")
    return from_ts // 60_000 * 60_000, (to_ts - 1) // 60_000 * 60_000


@app.get("/health")
def health() -> dict[str, Any]:
    return {
        "status": "OK",
        "service": "flora-liveagent",
        "mode": "synthetic-demo-only",
        "profile": PROFILE,
        "pump_start_ms": PUMP_START_MS if pumps_enabled() else None,
    }


@app.get("/api/observations")
def observations(
    from_ts: int = Query(alias="from"),
    to_ts: int = Query(alias="to"),
) -> list[dict[str, Any]]:
    first, last = _validate_window(from_ts, to_ts)
    rows: list[dict[str, Any]] = []
    for minute_ts in range(first, last + 1, 60_000):
        rows.extend(observations_for_minute(minute_ts))
    return rows


@app.get("/api/observations/bulk")
def observations_bulk(
    from_ts: int = Query(alias="from"),
    to_ts: int = Query(alias="to"),
    limit_minutes: int = Query(default=60, ge=1, le=MAX_WINDOW_MINUTES),
) -> dict[str, list[dict[str, Any]]]:
    first, last = _validate_window(from_ts, to_ts)
    result: dict[str, list[dict[str, Any]]] = {}
    for index, minute_ts in enumerate(range(first, last + 1, 60_000)):
        if index >= limit_minutes:
            break
        result[str(minute_ts)] = observations_for_minute(minute_ts)
    return result


@app.get("/api/devices/status")
def device_status(online_window_sec: int = Query(default=30, ge=1, le=3600)) -> dict[str, Any]:
    now = int(time.time() * 1000)
    latest = observations_for_minute(now // 60_000 * 60_000)
    devices = []
    logical_devices = []
    definitions = [
        ("LIVEAGENT_MONITOR_01", "patient_monitor", "Patient monitor", "hl7"),
        ("LIVEAGENT_ANES_01", "anesthesia_machine", "Anesthesia machine", "anes_machine"),
    ]
    if PROFILE == "bbraun":
        definitions = []
    if pumps_enabled():
        definitions.extend((p["device_id"], "infusion_pump_" + str(i + 1), p["label"], "bbraun-bcc")
                           for i, p in enumerate(PUMPS))
    for device_id, logical_id, label, protocol in definitions:
        samples = [row for row in latest if row["device_id"] == device_id]
        latest_row = samples[-1] if samples else None
        online = bool(samples)
        device = {
            "device_id": device_id,
            "device_key": device_id,
            "source": "liveagent",
            "protocol": protocol,
            "is_online": online,
            "status": "online" if online else "waiting",
            "last_seen_ts": now if online else None,
            "seconds_since_last": 0 if online else None,
            "total_samples": len(samples),
            "samples_in_window": len(samples),
            "latest_observation": latest_row,
            "synthetic": True,
            "category": "infusion_pump" if protocol == "bbraun-bcc" else logical_id,
        }
        devices.append(device)
        logical_devices.append(
            {
                "id": logical_id,
                "label": label,
                "is_online": online,
                "status": "online" if online else "waiting",
                "data_status": "live" if online else "waiting",
                "last_seen_ts": now if online else None,
                "seconds_since_last": 0 if online else None,
                "total_samples": len(samples),
                "samples_in_window": len(samples),
                "device_count": 1,
                "device_ids": [device_id],
                "latest_observation": latest_row,
            }
        )
    return {
        "server_ts": now,
        "server_uptime_sec": max(0, (now - SERVICE_STARTED_AT) // 1000),
        "online_window_sec": online_window_sec,
        "summary": {
            "total_observations": len(latest),
            "last_observation_ts": now,
            "total_devices": len(devices),
            "online_devices": sum(d["is_online"] for d in devices),
        },
        "liveagent": {"online": True, "device_count": len(devices), "last_seen_ts": now},
        "logical_devices": logical_devices,
        "devices": devices,
        "synthetic": True,
    }
