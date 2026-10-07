"""Dräger Vista 120 S, as a central station (CMS) sees it.

Ported from the gxt miot-monitor gateway (vista-120-S-gw.rb). The monitor opens a TCP
connection to the CMS port (9500 there) after finding the CMS through a UDP beacon on
9610; the socket controller sends that beacon (pod `beacon`) and this parser answers
each new connection with the CMS greeting.

Every message on the link starts with uint16 length, uint16 type (little endian). The
vitals frame is type 0x51:

    0-1  length = 12 + count * 6     6-7  stream remaining (not a clock)
    2-3  type   = 0x51               8-9  record count
    4-5  stream position             10-11 reserved = 0
    12.. count x [uint16 id][float32 value], -1000.0 = no reading

Other message types (waveforms, status) are skipped by their length. When the cursor
is not on a message boundary (joined mid-stream, dropped byte) the buffer is scanned for
the next header that proves itself: type 0x51, reserved 0, length == 12 + count * 6.
"""
from __future__ import annotations

import ipaddress
import json
import math
import struct
from pathlib import Path
from typing import Any

from device_medical_service.envelope import command
from device_medical_service.parsers.shared.base import FLORA_PARAMS, Parser

FRAME_TYPE = 0x51
HEADER_LEN = 12
RECORD_LEN = 6
NO_READING = -1000.0
LEN_MIN, LEN_MAX = 4, 8192
# What the gxt CMS writes as soon as a monitor connects.
GREETING = bytes.fromhex("100002000000d5a9d907080e113b2605")
SPO2_PR, NIBP_PR = 20, 18


def parse_frame(msg: bytes) -> dict[str, Any] | None:
    """One complete vitals frame, or None when the header does not prove itself."""
    if len(msg) < HEADER_LEN:
        return None
    length, kind, position, remaining, count, reserved = struct.unpack_from("<6H", msg)
    if kind != FRAME_TYPE or count == 0 or reserved != 0 or length != HEADER_LEN + count * RECORD_LEN:
        return None
    if len(msg) < length:
        return None
    values: dict[int, float] = {}
    for index in range(count):
        record_id, value = struct.unpack_from("<Hf", msg, HEADER_LEN + index * RECORD_LEN)
        if math.isfinite(value):
            values[record_id] = value      # raw, including the -1000.0 "no reading" marker
    return {"position": position, "remaining": remaining, "count": count, "values": values}


def reading(raw: float | None) -> float | None:
    """The measured value, or None for the -1000.0 "no reading / not connected" marker."""
    return None if raw is None or raw <= NO_READING + 0.5 else raw


def resync(buffer: bytes | bytearray) -> int | None:
    """Offset of the next header that proves itself as a vitals frame, if any."""
    for offset in range(1, len(buffer) - HEADER_LEN + 1):
        length, kind, _, _, count, reserved = struct.unpack_from("<6H", buffer, offset)
        if kind == FRAME_TYPE and reserved == 0 and count > 0 and length == HEADER_LEN + count * RECORD_LEN:
            return offset
    return None


class DraegerVistaSParser(Parser):
    name = "draeger_vista_s"
    protocol = "draeger-vista-s"

    def __init__(self, device_id, pod, options=None):
        super().__init__(device_id, pod, options)
        source = self.options.get("source_ip")
        # Several monitors may share one CMS port; source_ip picks this device's connection.
        self.source_ip = str(ipaddress.ip_address(source)) if source else None
        greeting = self.options.get("greeting_hex")
        self.greeting = bytes.fromhex("".join(str(greeting).split())) if greeting is not None else GREETING
        self.min_interval_ms = float(self.options.get("min_interval_sec", 1.0)) * 1000
        self.record_unmapped = bool(self.options.get("record_unmapped", False))
        self.max_buffer = int(self.options.get("max_buffer_bytes", 65536))
        mapping = json.loads((Path(__file__).parent / "flora_mapping.json").read_text())["records"]
        self.records = {int(key): rule for key, rule in {**mapping, **self.options.get("records", {})}.items()}
        for rule in self.records.values():
            if rule.get("ivy_param") and rule["ivy_param"] not in FLORA_PARAMS:
                raise ValueError(f"unknown Flora parameter {rule['ivy_param']!r} in Vista 120 S mapping")
        self.outgoing: list[dict[str, Any]] = []
        self.last_nibp: tuple | None = None
        self.reset(None)

    def reset(self, connection):
        self.buffer = bytearray()
        self.connection = connection
        self.last_emit_ms: float | None = None

    def drain_commands(self):
        result, self.outgoing = self.outgoing, []
        return result

    def feed(self, frame):
        if frame.pod != self.pod:
            return []
        if self.source_ip and frame.meta.get("source_ip") != self.source_ip:
            return []
        connection = frame.meta.get("connection")
        event = frame.meta.get("event")
        if event == "connected":
            self.reset(connection)
            if self.greeting:
                target = {"connection": connection} if connection is not None else {}
                self.outgoing.append(command(self.pod, self.greeting, **target))
            return []
        if event == "disconnected":
            if connection == self.connection:
                self.reset(None)
            return []
        if connection is not None and connection != self.connection:
            self.reset(connection)
        self.buffer.extend(frame.data)
        rows: list[dict[str, Any]] = []
        while len(self.buffer) >= HEADER_LEN:
            length, kind = struct.unpack_from("<2H", self.buffer)
            if length < LEN_MIN or length > LEN_MAX:
                skip = resync(self.buffer)
                if skip is None:
                    del self.buffer[:len(self.buffer) - (HEADER_LEN - 1)]
                    break
                del self.buffer[:skip]
                continue
            if len(self.buffer) < length:
                break
            message = bytes(self.buffer[:length])
            del self.buffer[:length]
            if kind != FRAME_TYPE:
                continue
            parsed = parse_frame(message)
            if parsed:
                rows.extend(self.emit(frame, parsed["values"]))
        if len(self.buffer) > self.max_buffer:
            self.buffer.clear()
        return rows

    def emit(self, frame, raw_values: dict[int, float]) -> list[dict[str, Any]]:
        """At most one frame per min_interval_sec, except that a new NIBP reading is never held back."""
        values = {record_id: reading(raw) for record_id, raw in raw_values.items()}
        nibp = tuple(values.get(record_id) for record_id, rule in sorted(self.records.items()) if rule.get("nibp"))
        nibp_changed = any(v is not None for v in nibp) and nibp != self.last_nibp
        if (self.last_emit_ms is not None and not nibp_changed
                and frame.ts - self.last_emit_ms < self.min_interval_ms):
            return []
        self.last_emit_ms = frame.ts
        rows = []
        for record_id, raw in sorted(raw_values.items()):
            rule = self.records.get(record_id)
            if rule is None and not self.record_unmapped:
                continue
            rule = rule or {}
            measured = values[record_id]
            # raw_value is always the device's own number (stored NOT NULL); value is None when no reading.
            value = None if measured is None else round(measured, rule.get("precision", 4))
            if isinstance(value, float) and rule.get("precision") == 0:
                value = int(value)
            self.record_measurement(frame, str(record_id), raw, value,
                                    definition={"name": rule.get("name"), "unit": rule.get("unit"),
                                                "evidence": "gxt vista-120-S-gw.rb" if rule else None},
                                    mapping={"ivy_param": rule.get("ivy_param")} if rule.get("ivy_param") else {})
            param = rule.get("ivy_param")
            if param is None or value is None:
                continue
            if rule.get("nibp") and not nibp_changed:
                continue  # NIBP is a spot reading: chart it once, when it changes
            row = self.observation(str(record_id), param, value, rule["unit"], system_ts=frame.ts)
            if row:
                rows.append(row)
        # Pulse rate from SpO2 when present; otherwise the pulse of a new NIBP reading.
        if nibp_changed and values.get(SPO2_PR) is None and values.get(NIBP_PR) is not None:
            row = self.observation(str(NIBP_PR), "pr", int(round(values[NIBP_PR])), "/min", system_ts=frame.ts)
            if row:
                rows.append(row)
        if nibp_changed:
            self.last_nibp = nibp
        return rows
