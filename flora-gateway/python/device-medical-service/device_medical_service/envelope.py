"""Kafka wire contracts, mirrored from `rust/crates/gateway-core/src/envelope.rs`."""
from __future__ import annotations

import base64
import re
import time
from dataclasses import dataclass, field
from typing import Any

OBS_TOPIC = "gw.obs"
MEASUREMENT_TOPIC = "gw.measurements"
LOG_TOPIC = "gw.logs"
# Waveform runs, keyed by device_id: {device_id, pod, channel, rate_hz, t0 (ms), samples: [int16]}.
WAVE_TOPIC = "gw.wave"


def now_ms() -> int:
    return int(time.time() * 1000)


def sanitize(value: str) -> str:
    return re.sub(r"[^A-Za-z0-9._-]", "_", value)


def raw_topic(pod: str) -> str:
    return f"gw.raw.{sanitize(pod)}"


def cmd_topic(pod: str) -> str:
    return f"gw.cmd.{sanitize(pod)}"


def encode(data: bytes) -> tuple[str, str]:
    try:
        return "utf8", data.decode("utf-8")
    except UnicodeDecodeError:
        return "base64", base64.b64encode(data).decode("ascii")


@dataclass
class RawFrame:
    pod: str
    controller: str
    gateway_id: str
    seq: int
    ts: int
    encoding: str
    payload: str
    meta: dict[str, Any] = field(default_factory=dict)

    @classmethod
    def from_dict(cls, value: dict[str, Any]) -> "RawFrame":
        return cls(
            pod=value["pod"], controller=value.get("controller", ""), gateway_id=value.get("gateway_id", ""),
            seq=int(value.get("seq", 0)), ts=int(value.get("ts", now_ms())), encoding=value.get("encoding", "utf8"),
            payload=value.get("payload", ""), meta=value.get("meta") or {},
        )

    @property
    def data(self) -> bytes:
        return base64.b64decode(self.payload) if self.encoding == "base64" else self.payload.encode("utf-8")

    @property
    def text(self) -> str:
        return self.data.decode("utf-8", errors="replace")


def wave_chunk(device_id: str, pod: str, channel: str, rate_hz: float, t0: int, samples: list[int]) -> dict[str, Any]:
    """`WaveChunk` in envelope.rs; samples must fit int16."""
    return {"device_id": device_id, "pod": pod, "channel": channel, "rate_hz": rate_hz, "t0": int(t0),
            "samples": [max(-32768, min(32767, int(sample))) for sample in samples]}


def command(pod: str, data: bytes | str, **meta: Any) -> dict[str, Any]:
    encoding, payload = encode(data.encode("utf-8") if isinstance(data, str) else data)
    return {"pod": pod, "encoding": encoding, "payload": payload, "meta": meta, "issued_at": now_ms()}
