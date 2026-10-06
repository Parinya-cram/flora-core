"""MEDIBUS numeric protocol port. SPDX-License-Identifier: LGPL-3.0-or-later

Derived from VSCaptureDrgVent, Copyright (C) 2017-20 John George K.
See THIRD_PARTY_NOTICES.md. Transport and storage belong to Flora controllers.
"""
from __future__ import annotations

import json
import math
import re
import time
from pathlib import Path

from device_medical_service.envelope import command
from device_medical_service.parsers.shared.base import FLORA_PARAMS, Parser

ESC, SOH, CR = 0x1B, 0x01, 0x0D
NUMERIC = re.compile(rb"[+-]?(?:\d+(?:\.\d*)?|\.\d+)\Z")


def packet(code: int, data: bytes = b"", *, response: bool = False) -> bytes:
    body = bytes((SOH if response else ESC, code)) + data
    return body + f"{sum(body) & 0xff:02X}".encode("ascii") + bytes((CR,))


class MedibusParser(Parser):
    name = "medibus"
    protocol = "draeger-medibus"

    def __init__(self, device_id, pod, options=None):
        super().__init__(device_id, pod, options)
        self.buffer = bytearray()
        self.outgoing = []
        self.ready = False
        self.pending = None
        self.sent_at = 0.0
        self.last_receive = 0.0
        self.next_page = 0
        self.pages = [0x24, 0x2B, 0x29]
        self.timeout = float(self.options.get("response_timeout_sec", 3))
        self.session_timeout = float(self.options.get("session_timeout_sec", 10))
        self.max_frame = int(self.options.get("max_frame_bytes", 16384))
        if not (0 < self.poll_interval < self.session_timeout and 0 < self.timeout < self.session_timeout):
            raise ValueError("MEDIBUS poll and response timeouts must be positive and below session_timeout_sec")
        if self.max_frame < 5:
            raise ValueError("MEDIBUS max_frame_bytes must be at least 5")
        mapping = json.loads((Path(__file__).parent / "flora_mapping.json").read_text())
        self.parameters = {**mapping["parameters"], **self.options.get("parameters", {})}
        self.definitions = json.loads((Path(__file__).parent / "device_parameters.json").read_text())["parameters"]
        for key, rule in self.parameters.items():
            if not re.fullmatch(r"(?:24|2B|29):[0-9A-F]{2}", key) or rule["ivy_param"] not in FLORA_PARAMS:
                raise ValueError(f"invalid MEDIBUS parameter mapping: {key}")

    @property
    def poll_interval(self):
        return float(self.options.get("poll_interval_sec", 1))

    def _request(self, code):
        self.pending = code
        self.sent_at = time.monotonic()
        return command(self.pod, packet(code))

    def poll(self):
        now = time.monotonic()
        if self.last_receive and now - self.last_receive >= self.session_timeout:
            self.ready = False
            self.pending = None
            self.last_receive = 0
            self.buffer.clear()
            self.next_page = 0
        if self.pending is not None:
            if now - self.sent_at < self.timeout:
                return []
            # A missing response starts a fresh handshake, including after reconnect.
            self.ready = False
            self.next_page = 0
        if not self.ready:
            return [self._request(0x51)]
        code = self.pages[self.next_page]
        self.next_page = (self.next_page + 1) % len(self.pages)
        return [self._request(code)]

    def drain_commands(self):
        result, self.outgoing = self.outgoing, []
        return result

    def feed(self, frame):
        if frame.pod != self.pod:
            return []
        rows = []
        # Serial controller chunks may split or combine protocol messages.
        # Realtime bytes (high bit set) are independent of the ASCII channel.
        for byte in frame.data:
            if byte >= 0x80:
                continue
            if byte in (ESC, SOH):
                self.buffer = bytearray((byte,))
            elif not self.buffer:
                continue
            elif byte == CR:
                complete, self.buffer = bytes(self.buffer), bytearray()
                if len(complete) < 4:
                    continue
                body, checksum = complete[:-2], complete[-2:]
                if checksum != f"{sum(body) & 0xff:02X}".encode():
                    continue
                rows.extend(self._message(body, frame))
            elif len(self.buffer) >= self.max_frame:
                self.buffer.clear()
            else:
                self.buffer.append(byte)
        return rows

    def _message(self, body, frame):
        start, code = body[:2]
        data = body[2:]
        self.last_receive = time.monotonic()
        if start == ESC:
            if code == 0x51:  # Initialize communication, initiated by the device.
                self.ready = False
                self.pending = None
                self.next_page = 0
                self.outgoing.append(command(self.pod, packet(code, response=True)))
                self.outgoing.append(self._request(0x52))
            elif code in (0x30, 0x52, 0x55):  # NOP, ID (empty identity), stop.
                self.outgoing.append(command(self.pod, packet(code, response=True)))
                if code == 0x55:
                    self.ready = False
                    self.pending = None
            return []
        if code == self.pending:
            self.pending = None
            if code == 0x51:
                self.outgoing.append(self._request(0x52))
            elif code == 0x52:
                self.ready = True
                self.next_page = 0
        if code not in self.pages:
            return []
        width = 7 if code == 0x29 else 6
        if len(data) % width:
            return []
        # Reject the whole malformed response before recording any of its fields.
        if any(not re.fullmatch(rb"[0-9A-F]{2}", data[i:i + 2]) for i in range(0, len(data), width)):
            return []
        rows = []
        for offset in range(0, len(data), width):
            raw_code = data[offset:offset + 2].decode("ascii")
            if not re.fullmatch(r"[0-9A-F]{2}", raw_code):
                return []
            key = f"{code:02X}:{raw_code}"
            rule = self.parameters.get(key)
            original = data[offset + 2:offset + width]
            value = original.strip()
            decoded = float(value) if NUMERIC.fullmatch(value) else None
            self.record_measurement(frame, key, original.decode("ascii"), decoded,
                                    definition=self.definitions.get(key, {"name": None, "unit": None, "evidence": "unknown code"}),
                                    mapping=rule)
            if not rule or not NUMERIC.fullmatch(value):
                continue  # blank, unavailable, out-of-range, or unmapped
            numeric = float(value) * rule.get("scale", 1)
            if not math.isfinite(numeric):
                continue
            if "precision" in rule:
                numeric = round(numeric, rule["precision"])
            row = self.observation(key, rule["ivy_param"], numeric, rule["unit"], system_ts=frame.ts)
            if row:
                rows.append(row)
        return rows
