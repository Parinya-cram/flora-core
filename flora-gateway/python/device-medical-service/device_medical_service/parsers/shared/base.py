from __future__ import annotations

import math
from typing import Any

from device_medical_service.envelope import RawFrame, now_ms

# Flora parameter keys (`ivy_param`) understood by the Leaf device writer.
FLORA_PARAMS = {
    "hr", "pr", "art_pr", "spo2", "rr", "etco2", "et_co2", "fi_co2", "temperature",
    "nibp_sys", "nibp_dia", "nibp_map", "art_sys", "art_dia", "art_map", "cvp",
    "set_vent_mode", "tidal_volume_exp", "minute_volume_exp", "fio2", "airway_pressure_peak",
    "airway_pressure_plateau", "airway_pressure_mean", "set_tidal_volume", "set_rr", "set_peep",
    "set_fio2", "set_ie_ratio", "et_o2", "fi_agent", "et_agent", "agent_id", "mac",
    "flow_o2", "flow_air", "flow_n2o", "peep_total", "compliance",
}


class Parser:
    """Turns raw device frames into Flora observations.

    One parser instance serves one device instance on one pod. Subclasses keep any
    partial-frame state they need between `feed` calls.
    """

    name = "base"
    protocol = "raw"
    default_codes: dict[str, str] = {}

    def __init__(self, device_id: str, pod: str, options: dict[str, Any] | None = None):
        self.device_id = device_id
        self.pod = pod
        self.options = options or {}
        self._measurements = []
        codes = {str(k).lower(): v for k, v in self.default_codes.items()}
        codes.update({str(k).lower(): v for k, v in (self.options.get("codes") or {}).items()})
        self.codes = codes
        self.passthrough = bool(self.options.get("passthrough_unmapped", False))

    # Polling devices (many RS-232 units) answer only when asked.
    @property
    def poll_interval(self) -> float | None:
        value = self.options.get("poll_interval_sec")
        return float(value) if value else None

    def poll(self) -> list[dict[str, Any]]:
        return []

    def drain_commands(self) -> list[dict[str, Any]]:
        """Protocol replies produced by feed(), sent through the pod controller."""
        return []

    def drain_measurements(self) -> list[dict[str, Any]]:
        """Original device fields, independently of optional Flora conversions."""
        rows, self._measurements = self._measurements, []
        return rows

    def record_measurement(self, frame, code, raw_value, value, *, definition=None, mapping=None):
        self._measurements.append({
            "device_id": self.device_id, "protocol": self.protocol, "pod": self.pod,
            "raw_code": code, "raw_value": raw_value, "value": value,
            "definition": definition or {}, "mapping": mapping or {},
            "system_ts": frame.ts, "device_ts": None,
            "gateway_id": frame.gateway_id, "seq": frame.seq,
        })

    def feed(self, frame: RawFrame) -> list[dict[str, Any]]:
        raise NotImplementedError

    def map_code(self, *candidates: str) -> str | None:
        for candidate in candidates:
            key = str(candidate or "").strip().lower()
            if not key:
                continue
            if key in self.codes:
                return self.codes[key]
            if key in FLORA_PARAMS:
                return key
        if self.passthrough:
            first = next((c for c in candidates if c), "")
            return str(first).strip().lower() or None
        return None

    def observation(self, raw_code: str, ivy_param: str, value: Any, unit: str = "", device_ts: int | None = None,
                    system_ts: int | None = None) -> dict[str, Any] | None:
        if isinstance(value, float) and not math.isfinite(value):
            return None
        return {
            "device_id": self.device_id,
            "source": "flora-gateway",
            "protocol": self.protocol,
            "raw_code": raw_code,
            "ivy_param": ivy_param,
            "value": value,
            "unit": unit or "",
            "device_ts": device_ts,
            "system_ts": system_ts or now_ms(),
            "pod": self.pod,
        }


def number(value: Any) -> Any:
    """Returns int/float for numeric text, otherwise the trimmed text."""
    if isinstance(value, (int, float)):
        return value
    text = str(value).strip()
    try:
        parsed = float(text)
    except ValueError:
        return text
    return int(parsed) if parsed.is_integer() and "." not in text else parsed
