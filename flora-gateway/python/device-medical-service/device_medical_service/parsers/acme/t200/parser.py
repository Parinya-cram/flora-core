"""Acme T-200 temperature / CVP module (RS-232, polled). Demo protocol, fictional device.

The gateway sends "R\\r" every poll_interval_sec; the device answers one line:

    $T200,TEMP=36.8,CVP=8*5A\\r\\n

The two hex digits after "*" are the XOR of every byte between "$" and "*".
Frames with a bad checksum are dropped.
"""
from __future__ import annotations

from typing import Any

from device_medical_service.envelope import RawFrame, command
from device_medical_service.parsers.shared.base import Parser, number

UNITS = {"temperature": "Cel", "cvp": "mmHg"}
MAX_BUFFER = 1024


def checksum(body: str) -> str:
    value = 0
    for byte in body.encode():
        value ^= byte
    return f"{value:02X}"


class AcmeT200Parser(Parser):
    name = "acme_t200"
    protocol = "acme-t200"
    default_codes = {"TEMP": "temperature", "CVP": "cvp"}

    def __init__(self, device_id: str, pod: str, options: dict[str, Any] | None = None):
        super().__init__(device_id, pod, options)
        self.buffer = ""

    @property
    def poll_interval(self) -> float | None:
        return float(self.options.get("poll_interval_sec") or 2)

    def poll(self) -> list[dict[str, Any]]:
        return [command(self.pod, "R\r")]

    def feed(self, frame: RawFrame) -> list[dict[str, Any]]:
        self.buffer += frame.text
        *lines, self.buffer = self.buffer.split("\n")
        if len(self.buffer) > MAX_BUFFER:  # a noisy line never grows the buffer without bound
            self.buffer = ""
        rows: list[dict[str, Any]] = []
        for line in (line.strip() for line in lines):
            if not line.startswith("$T200,") or "*" not in line:
                continue
            body, _, received = line[1:].partition("*")
            if checksum(body) != received.strip().upper():
                continue
            for pair in body.split(",")[1:]:
                key, separator, raw = pair.partition("=")
                param = self.map_code(key) if separator else None
                if not param:
                    continue
                value = number(raw)
                if not isinstance(value, (int, float)):
                    continue  # "---" etc.: device has no value right now
                self.record_measurement(frame, key, raw, value, mapping={"ivy_param": param})
                row = self.observation(key, param, value, UNITS.get(param, ""), None, frame.ts)
                if row:
                    rows.append(row)
        return rows
