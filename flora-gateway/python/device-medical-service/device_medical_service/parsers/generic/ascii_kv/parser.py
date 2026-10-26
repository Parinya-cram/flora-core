"""Line-oriented `KEY=VALUE;KEY=VALUE` output used by many RS-232 modules.

A record ends at CR/LF or at ETX (0x03); an STX (0x02) starts one, so `STX KEY=VALUE;...;LRC ETX`
frames (e.g. Medibus.X-style simulators) work too.

Options:
  poll_command       bytes written to the device every poll_interval_sec (e.g. "?\\r\\n")
  poll_interval_sec  enables polling
  pair_separator     default ";" (commas also accepted)
  units              {"temperature": "Cel", ...}
  checksum           "lrc": the last field is a 2-hex-digit LRC of the record before it (two's complement
                     of the byte sum); records that fail it are dropped
"""
from __future__ import annotations

import re
from typing import Any

from device_medical_service.envelope import RawFrame, command
from device_medical_service.parsers.shared.base import Parser, number


class AsciiKvParser(Parser):
    name = "ascii_kv"
    protocol = "ascii"

    def __init__(self, device_id: str, pod: str, options: dict[str, Any] | None = None):
        super().__init__(device_id, pod, options)
        self.buffer = ""
        separator = re.escape(self.options.get("pair_separator", ";"))
        self.pair_split = re.compile(rf"[{separator},]")
        self.units = self.options.get("units") or {}
        self.separator = self.options.get("pair_separator", ";")
        self.checksum = str(self.options.get("checksum") or "").lower()
        if self.checksum not in ("", "lrc"):
            raise ValueError("ascii_kv checksum must be lrc or empty")

    def poll(self) -> list[dict[str, Any]]:
        poll_command = self.options.get("poll_command")
        if not poll_command:
            return []
        return [command(self.pod, poll_command.encode().decode("unicode_escape"))]

    def feed(self, frame: RawFrame) -> list[dict[str, Any]]:
        self.buffer += frame.text
        *lines, self.buffer = re.split(r"\r?\n|\r|\x03", self.buffer)
        rows: list[dict[str, Any]] = []
        for line in lines:
            line = line.rsplit("\x02", 1)[-1]          # STX starts a record: drop anything before it
            if self.checksum == "lrc":
                line = self._verified(line)
                if line is None:
                    continue
            for pair in self.pair_split.split(line):
                if "=" not in pair and ":" not in pair:
                    continue
                key, value = re.split(r"[=:]", pair, maxsplit=1)
                param = self.map_code(key)
                if not param:
                    continue
                row = self.observation(key.strip(), param, number(value), self.units.get(param, ""), None, frame.ts)
                if row:
                    rows.append(row)
        if len(self.buffer) > 4096:
            self.buffer = ""
        return rows

    def _verified(self, record: str) -> str | None:
        """`payload<sep>XX` with XX the LRC of payload -> payload; None when it does not match."""
        payload, sep, check = record.rpartition(self.separator)
        if not sep or not re.fullmatch(r"[0-9A-Fa-f]{2}", check.strip()):
            return None
        lrc = (-sum(payload.encode("latin-1", errors="replace"))) & 0xFF
        return payload if lrc == int(check.strip(), 16) else None
