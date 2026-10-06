"""Live view of each ingress stream (pod) and each device's output for the station admin.

Tails `gw.raw.<pod>` (device → gateway) and `gw.cmd.<pod>` (gateway → device:
polls, ACKs, settings) from Kafka and keeps, per pod, per-second frame/byte
counters for the last WINDOW_SEC and the most recent frames with their payloads.
It also tails `gw.obs` and `gw.measurements` (parser → collector), keyed by device,
so the device monitor can show exactly what is handed to the collector.
Everything is in memory and starts empty when gateway-service restarts; the
consumer reads from the latest offset, so it never replays history into parsers.
"""
from __future__ import annotations

import asyncio
import base64
import json
import logging
import time
from collections import deque
from typing import Any

from aiokafka import AIOKafkaConsumer

from . import settings

log = logging.getLogger("gateway-service.streams")

WINDOW_SEC = 900
RECENT_FRAMES = 200
PAYLOAD_LIMIT = 8192           # characters kept per frame; the size field keeps the real byte count
RECENT_OUTPUT = 300
TOPIC_PATTERN = r"^gw\.(raw|cmd)\..+|^gw\.(obs|measurements)$"


def payload_bytes(encoding: str, payload: str) -> int:
    if encoding == "base64":
        return len(payload) * 3 // 4 - payload[-2:].count("=")
    return len(payload.encode())


class PodStream:
    __slots__ = ("pod", "controller", "seconds", "recent", "totals", "last_ts", "next_id")

    def __init__(self, pod: str) -> None:
        self.pod = pod
        self.controller = pod.split(".", 1)[0]
        self.seconds: deque[list[int]] = deque()   # [epoch_sec, frames_in, bytes_in, frames_out, bytes_out]
        self.recent: deque[dict[str, Any]] = deque(maxlen=RECENT_FRAMES)
        self.totals = {"frames_in": 0, "bytes_in": 0, "frames_out": 0, "bytes_out": 0}
        self.last_ts: int | None = None
        self.next_id = 0

    def add(self, direction: str, frame: dict[str, Any], size: int) -> None:
        now_sec = int(time.time())
        if not self.seconds or self.seconds[-1][0] != now_sec:
            self.seconds.append([now_sec, 0, 0, 0, 0])
        while self.seconds and self.seconds[0][0] <= now_sec - WINDOW_SEC:
            self.seconds.popleft()
        bucket = self.seconds[-1]
        offset = 1 if direction == "in" else 3
        bucket[offset] += 1
        bucket[offset + 1] += size
        self.totals[f"frames_{direction}"] += 1
        self.totals[f"bytes_{direction}"] += size
        self.last_ts = int(time.time() * 1000)
        payload = frame.get("payload") or ""
        self.next_id += 1
        self.recent.append({
            "id": self.next_id, "direction": direction, "seq": frame.get("seq"),
            "ts": frame.get("ts") or frame.get("issued_at") or self.last_ts,
            "encoding": frame.get("encoding", "utf8"), "size": size,
            "payload": payload[:PAYLOAD_LIMIT], "truncated": len(payload) > PAYLOAD_LIMIT,
            "meta": frame.get("meta") or {},
        })

    def series(self, window: int) -> list[list[int]]:
        """Dense per-second series for the last `window` complete seconds, zero-filled."""
        end = int(time.time())          # the current second is still filling, so it is left out
        start = end - window
        by_sec = {row[0]: row for row in self.seconds if row[0] >= start}
        return [by_sec.get(sec, [sec, 0, 0, 0, 0]) for sec in range(start, end)]

    def rate(self, seconds: int = 10) -> dict[str, float]:
        since = int(time.time()) - seconds
        rows = [row for row in self.seconds if row[0] > since]
        return {"frames_in": sum(r[1] for r in rows) / seconds, "bytes_in": sum(r[2] for r in rows) / seconds,
                "frames_out": sum(r[3] for r in rows) / seconds, "bytes_out": sum(r[4] for r in rows) / seconds}

    def summary(self, window: int) -> dict[str, Any]:
        return {"pod": self.pod, "controller": self.controller, "totals": self.totals, "last_ts": self.last_ts,
                "rate": self.rate(), "series": self.series(window)}


class DeviceOutput:
    """What one device's parser sends to the collector: observations and original measurements."""
    __slots__ = ("device_id", "seconds", "recent", "totals", "last_ts", "next_id")

    def __init__(self, device_id: str) -> None:
        self.device_id = device_id
        self.seconds: deque[list[int]] = deque()   # [epoch_sec, observations, measurements]
        self.recent: deque[dict[str, Any]] = deque(maxlen=RECENT_OUTPUT)
        self.totals = {"obs": 0, "measurement": 0}
        self.last_ts: int | None = None
        self.next_id = 0

    def add(self, kind: str, message: dict[str, Any], topic: str) -> None:
        now_sec = int(time.time())
        if not self.seconds or self.seconds[-1][0] != now_sec:
            self.seconds.append([now_sec, 0, 0])
        while self.seconds and self.seconds[0][0] <= now_sec - WINDOW_SEC:
            self.seconds.popleft()
        self.seconds[-1][1 if kind == "obs" else 2] += 1
        self.totals[kind] += 1
        self.last_ts = int(time.time() * 1000)
        self.next_id += 1
        self.recent.append({"id": self.next_id, "kind": kind, "topic": topic, "received_at": self.last_ts,
                            "message": message})

    def rate(self, seconds: int = 60) -> dict[str, float]:
        since = int(time.time()) - seconds
        rows = [row for row in self.seconds if row[0] > since]
        return {"obs_per_min": sum(r[1] for r in rows) * 60 / seconds,
                "measurements_per_min": sum(r[2] for r in rows) * 60 / seconds}


class StreamMonitor:
    def __init__(self) -> None:
        self.pods: dict[str, PodStream] = {}
        self.devices: dict[str, DeviceOutput] = {}
        self.status: dict[str, Any] = {"state": "starting", "error": None, "started_at": int(time.time() * 1000)}
        self._task: asyncio.Task | None = None

    def start(self) -> None:
        self._task = asyncio.create_task(self._run())

    async def stop(self) -> None:
        if self._task:
            self._task.cancel()

    def pod(self, name: str) -> PodStream:
        if name not in self.pods:
            self.pods[name] = PodStream(name)
        return self.pods[name]

    async def _run(self) -> None:
        delay = 2
        while True:
            consumer = AIOKafkaConsumer(
                bootstrap_servers=settings.KAFKA_BROKERS,
                group_id=f"gateway-service-streams-{settings.GATEWAY_ID}",
                auto_offset_reset="latest", enable_auto_commit=False,
                metadata_max_age_ms=15000,          # pick up topics of newly added pods quickly
            )
            try:
                await consumer.start()
                consumer.subscribe(pattern=TOPIC_PATTERN)
                self.status.update(state="running", error=None)
                delay = 2
                async for message in consumer:
                    self._handle(message.topic, message.value)
            except asyncio.CancelledError:
                raise
            except Exception as error:  # Kafka may be down; keep retrying
                self.status.update(state="offline", error=str(error))
                log.warning("stream monitor: %s", error)
            finally:
                try:
                    await consumer.stop()
                except Exception:
                    pass
            await asyncio.sleep(delay)
            delay = min(delay * 2, 30)

    def device(self, device_id: str) -> DeviceOutput:
        if device_id not in self.devices:
            self.devices[device_id] = DeviceOutput(device_id)
        return self.devices[device_id]

    def _handle(self, topic: str, value: bytes | None) -> None:
        if topic in ("gw.obs", "gw.measurements"):
            try:
                message = json.loads(value or b"{}")
            except ValueError:
                return
            if message.get("device_id"):
                self.device(message["device_id"]).add("obs" if topic == "gw.obs" else "measurement", message, topic)
            return
        direction = "in" if topic.startswith("gw.raw.") else "out"
        try:
            frame = json.loads(value or b"{}")
        except ValueError:
            frame = {"encoding": "base64", "payload": base64.b64encode(value or b"").decode()}
        pod = frame.get("pod") or topic.split(".", 2)[2]
        encoding = frame.get("encoding", "utf8")
        self.pod(pod).add(direction, frame, payload_bytes(encoding, frame.get("payload") or ""))


monitor = StreamMonitor()
