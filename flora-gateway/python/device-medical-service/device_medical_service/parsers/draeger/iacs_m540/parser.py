"""One complete IACS UDP datagram per RawFrame; no cross-packet value cache."""
from __future__ import annotations

import ipaddress
import json
from pathlib import Path

from device_medical_service.parsers.shared.base import FLORA_PARAMS, Parser
from device_medical_service.parsers.draeger.iacs_m540.blocks import IacsDatagramParser


class IacsM540Parser(Parser):
    name = "iacs_m540"
    protocol = "draeger-iacs"

    def __init__(self, device_id, pod, options=None):
        super().__init__(device_id, pod, options)
        source = self.options.get("source_ip")
        if not source:
            raise ValueError("iacs_m540 requires source_ip to identify the monitor")
        self.source_ip = str(ipaddress.ip_address(source))
        mapping = json.loads((Path(__file__).parent / "flora_mapping.json").read_text())
        self.rules = self.options.get("parameters", mapping["parameters"])
        for rule in self.rules:
            if rule["ivy_param"] not in FLORA_PARAMS or not rule["source_keys"]:
                raise ValueError("IACS mappings need a Flora parameter and source_keys")
        self.decoder = IacsDatagramParser()

    def feed(self, frame):
        if frame.pod != self.pod:
            return []
        # A shared multicast listener needs one source_ip per device instance.
        if frame.meta.get("source_ip") != self.source_ip:
            return []
        parsed = self.decoder.parse(frame.data)
        if parsed.trailing_offset is not None:
            raise ValueError(f"unknown IACS block at {parsed.trailing_offset}")
        rows = []
        for key, value in parsed.numeric_values.items():
            rule = next((item for item in self.rules if key in item["source_keys"]), None)
            self.record_measurement(frame, key, value, value,
                                    definition={"name": None, "unit": None,
                                                "evidence": "legacy IACS decoder; original name/unit not verified"},
                                    mapping=rule)
        for rule in self.rules:
            key = next((key for key in rule["source_keys"] if key in parsed.numeric_values), None)
            if key is None:
                continue
            raw = parsed.numeric_values[key]
            if raw in rule.get("invalid_values", []):
                continue
            value = raw * rule.get("scale", 1)
            if "precision" in rule:
                value = round(value, rule["precision"])
            row = self.observation(key, rule["ivy_param"], value, rule["unit"], system_ts=frame.ts)
            if row:
                rows.append(row)
        return rows
