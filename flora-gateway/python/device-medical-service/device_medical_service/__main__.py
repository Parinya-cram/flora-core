"""Process layer: one container per device instance, or one per pod for shared pods.

Reads `gw.raw.<pod>`, parses with the configured parser, publishes `gw.obs` (and
`gw.wave`), and writes device commands (polls, ACKs) to `gw.cmd.<pod>`.

Environment (set by the Gateway Service when it starts the container):
  FLORA_KAFKA_BROKERS  DEVICE_ID  POD  PARSER  PARSER_OPTIONS (JSON)
Pod mode (POD_DEMUX=1) replaces DEVICE_ID/PARSER/PARSER_OPTIONS with
  DEVICE_MAP  JSON list of {device_id, parser, options}; each frame goes to the
              instance whose options.source_ip equals the frame's meta.source_ip.
"""
from __future__ import annotations

import asyncio
import ipaddress
import json
import logging
import os
import signal

import time
from typing import Any

from aiokafka import AIOKafkaConsumer, AIOKafkaProducer, TopicPartition
from aiokafka.admin import AIOKafkaAdminClient, NewTopic
from aiokafka.errors import KafkaConnectionError, TopicAlreadyExistsError

from .envelope import (LOG_TOPIC, OBS_TOPIC, MEASUREMENT_TOPIC, WAVE_TOPIC, RawFrame, cmd_topic, now_ms,
                       raw_topic, sanitize)
from .parsers import load_parser
from .parsers.shared.base import Parser

log = logging.getLogger("device-medical-service")


async def ensure_topics(brokers: str, topics: list[str]) -> None:
    admin = AIOKafkaAdminClient(bootstrap_servers=brokers)
    await admin.start()
    try:
        for topic in topics:
            try:
                await admin.create_topics([NewTopic(topic, num_partitions=1, replication_factor=1)])
            except TopicAlreadyExistsError:
                pass
    finally:
        await admin.close()


async def run() -> None:
    if os.environ.get("POD_DEMUX") == "1":
        await run_pod()
        return
    brokers = os.environ.get("FLORA_KAFKA_BROKERS", "kafka:9092")
    device_id = os.environ["DEVICE_ID"]
    pod = os.environ["POD"]
    parser = load_parser(os.environ["PARSER"], device_id, pod, json.loads(os.environ.get("PARSER_OPTIONS") or "{}"))
    source, commands = raw_topic(pod), cmd_topic(pod)

    for attempt in range(30):
        try:
            await ensure_topics(brokers, [source, commands, OBS_TOPIC, MEASUREMENT_TOPIC, WAVE_TOPIC, LOG_TOPIC])
            break
        except (KafkaConnectionError, OSError) as error:
            log.warning("kafka not ready (%s), retrying", error)
            await asyncio.sleep(2)

    producer = AIOKafkaProducer(bootstrap_servers=brokers, linger_ms=5,
                                value_serializer=lambda value: json.dumps(value).encode(),
                                key_serializer=lambda key: key.encode())
    consumer = AIOKafkaConsumer(source, bootstrap_servers=brokers, group_id=f"gw-parser-{device_id}",
                                enable_auto_commit=True, auto_offset_reset="latest",
                                value_deserializer=lambda value: json.loads(value))
    await producer.start()
    await consumer.start()

    async def emit_log(level: str, message: str, **detail) -> None:
        await producer.send(LOG_TOPIC, key=f"parser.{device_id}", value={
            "ts": now_ms(), "component": f"parser.{device_id}", "level": level, "pod": pod,
            "message": message, "detail": detail})

    async def poll_loop() -> None:
        while True:
            await asyncio.sleep(parser.poll_interval)
            for item in parser.poll():
                await producer.send(commands, key=pod, value=item)

    await emit_log("info", "parser started", parser=parser.name, source=source)
    log.info("device %s parsing %s with %s", device_id, source, parser.name)
    poller = asyncio.create_task(poll_loop()) if parser.poll_interval else None
    stop = asyncio.Event()
    loop = asyncio.get_running_loop()
    for signum in (signal.SIGTERM, signal.SIGINT):
        loop.add_signal_handler(signum, stop.set)

    async def consume() -> None:
        async for message in consumer:
            try:
                rows = parser.feed(RawFrame.from_dict(message.value))
            except Exception as error:  # a malformed frame must not stop the device
                log.exception("parse failed")
                await emit_log("warn", "parse failed", error=str(error), seq=message.value.get("seq"))
                continue
            for item in parser.drain_commands():
                await producer.send_and_wait(commands, key=pod, value=item)
            for measurement in parser.drain_measurements():
                await producer.send_and_wait(MEASUREMENT_TOPIC, key=device_id, value=measurement)
            for row in rows:
                await producer.send(OBS_TOPIC, key=device_id, value=row)
            for wave in parser.drain_waves():
                await producer.send(WAVE_TOPIC, key=device_id, value=wave)

    consumer_task = asyncio.create_task(consume())
    await asyncio.wait([consumer_task, asyncio.create_task(stop.wait())], return_when=asyncio.FIRST_COMPLETED)
    for task in (consumer_task, poller):
        if task:
            task.cancel()
    await emit_log("info", "parser stopped")
    await consumer.stop()
    await producer.stop()


# ------------------------------------------------------------------ pod mode (virtual devices)

UNREGISTERED_LOG_SEC = 60.0


class PodRouter:
    """One parser instance per device on a shared pod, chosen by the frame's source_ip.

    Each instance keeps its own state, so parsers need no change for pod mode.
    """

    def __init__(self, pod: str, device_map: list[dict[str, Any]]):
        self.pod = pod
        self.parsers: dict[str, Parser] = {}
        self.by_ip: dict[str, Parser] = {}
        # A bad instance is skipped (and reported) so it cannot stop the other monitors on the pod.
        self.errors: list[dict[str, str]] = []
        for item in device_map:
            device_id = str(item.get("device_id") or "")
            try:
                options = item.get("options") or {}
                source_ip = str(options.get("source_ip") or "").strip()
                if not source_ip:
                    raise ValueError("pod mode needs options.source_ip")
                source_ip = str(ipaddress.ip_address(source_ip))   # frames carry the canonical form
                if source_ip in self.by_ip:
                    raise ValueError(f"source_ip {source_ip} is already used by {self.by_ip[source_ip].device_id}")
                parser = load_parser(item["parser"], device_id, pod, options)
            except (KeyError, ValueError) as error:
                self.errors.append({"device_id": device_id, "error": str(error)})
                continue
            self.parsers[device_id] = parser
            self.by_ip[source_ip] = parser
        self._unregistered: dict[str, float] = {}

    def route(self, frame: RawFrame) -> Parser | None:
        return self.by_ip.get(str(frame.meta.get("source_ip") or ""))

    def unregistered(self, frame: RawFrame, now: float | None = None) -> dict[str, Any] | None:
        """A `gw.logs` detail for a monitor with no instance, at most once a minute per IP.

        Transport events (TCP connected/disconnected of a relay) carry the relay's address,
        not a monitor's, so they are dropped without a log."""
        source_ip = frame.meta.get("source_ip")
        if not source_ip or frame.meta.get("event"):
            return None
        now = time.monotonic() if now is None else now
        last = self._unregistered.get(source_ip)
        if last is not None and now - last < UNREGISTERED_LOG_SEC:
            return None
        self._unregistered[source_ip] = now
        return {"event": "unregistered_monitor", "source_ip": source_ip, "pod": self.pod,
                "peer": frame.meta.get("peer"), "transport": frame.meta.get("transport")}


async def run_pod() -> None:
    """Pod mode: consumer group gw-parser-pod-<pod>, offsets committed only after the
    produced messages are acknowledged, so a restart resumes where it stopped."""
    brokers = os.environ.get("FLORA_KAFKA_BROKERS", "kafka:9092")
    pod = os.environ["POD"]
    router = PodRouter(pod, json.loads(os.environ.get("DEVICE_MAP") or "[]"))
    source, commands = raw_topic(pod), cmd_topic(pod)
    component = f"parser.pod.{pod}"

    for attempt in range(30):
        try:
            await ensure_topics(brokers, [source, commands, OBS_TOPIC, MEASUREMENT_TOPIC, WAVE_TOPIC, LOG_TOPIC])
            break
        except (KafkaConnectionError, OSError) as error:
            log.warning("kafka not ready (%s), retrying", error)
            await asyncio.sleep(2)

    producer = AIOKafkaProducer(bootstrap_servers=brokers, linger_ms=5,
                                value_serializer=lambda value: json.dumps(value).encode(),
                                key_serializer=lambda key: key.encode())
    consumer = AIOKafkaConsumer(bootstrap_servers=brokers, group_id=f"gw-parser-pod-{sanitize(pod)}",
                                enable_auto_commit=False, auto_offset_reset="earliest",
                                value_deserializer=lambda value: json.loads(value))
    await producer.start()
    await consumer.start()
    # Assigned, not subscribed: one pod container per pod. A committed offset resumes there; a new
    # group starts at the end, so switching a pod to this mode does not re-parse 72 h of retained frames.
    await consumer.topics()  # loads metadata so the partition list is known
    partitions = [TopicPartition(source, p) for p in sorted(consumer.partitions_for_topic(source) or {0})]
    consumer.assign(partitions)
    for partition in partitions:
        if await consumer.committed(partition) is None:
            await consumer.seek_to_end(partition)

    async def emit_log(level: str, message: str, **detail) -> None:
        await producer.send(LOG_TOPIC, key=component, value={
            "ts": now_ms(), "component": component, "level": level, "pod": pod, "message": message, "detail": detail})

    async def poll_loop(parser: Parser) -> None:
        while True:
            await asyncio.sleep(parser.poll_interval)
            for item in parser.poll():
                await producer.send(commands, key=pod, value=item)

    async def handle(value: dict[str, Any]) -> None:
        frame = RawFrame.from_dict(value)
        parser = router.route(frame)
        if parser is None:
            detail = router.unregistered(frame)
            if detail:
                await emit_log("warn", "unregistered monitor", **detail)
            return
        try:
            rows = parser.feed(frame)
        except Exception as error:  # a malformed frame must not stop the other devices
            log.exception("parse failed for %s", parser.device_id)
            await emit_log("warn", "parse failed", device_id=parser.device_id, error=str(error), seq=frame.seq)
            return
        for item in parser.drain_commands():
            await producer.send(commands, key=pod, value=item)
        for measurement in parser.drain_measurements():
            await producer.send(MEASUREMENT_TOPIC, key=parser.device_id, value=measurement)
        for row in rows:
            await producer.send(OBS_TOPIC, key=parser.device_id, value=row)
        for wave in parser.drain_waves():
            await producer.send(WAVE_TOPIC, key=parser.device_id, value=wave)

    await emit_log("info", "pod parser started", source=source, devices=sorted(router.parsers))
    for error in router.errors:
        log.error("device %s skipped: %s", error["device_id"], error["error"])
        await emit_log("error", "device skipped", **error)
    log.info("pod %s parsing %s for %s", pod, source, ", ".join(sorted(router.parsers)) or "no devices")
    pollers = [asyncio.create_task(poll_loop(p)) for p in router.parsers.values() if p.poll_interval]
    stop = asyncio.Event()
    loop = asyncio.get_running_loop()
    for signum in (signal.SIGTERM, signal.SIGINT):
        loop.add_signal_handler(signum, stop.set)

    async def consume() -> None:
        while not stop.is_set():
            batches = await consumer.getmany(timeout_ms=500, max_records=500)
            if not batches:
                continue
            for messages in batches.values():
                for message in messages:
                    await handle(message.value)
            await producer.flush()
            await consumer.commit()

    consumer_task = asyncio.create_task(consume())
    await asyncio.wait([consumer_task, asyncio.create_task(stop.wait())], return_when=asyncio.FIRST_COMPLETED)
    for task in (consumer_task, *pollers):
        task.cancel()
    if consumer_task.done() and not consumer_task.cancelled() and consumer_task.exception():
        log.error("pod consumer failed: %s", consumer_task.exception())
    await emit_log("info", "pod parser stopped")
    await consumer.stop()
    await producer.stop()


def main() -> None:
    logging.basicConfig(level=os.environ.get("LOG_LEVEL", "INFO"), format="%(asctime)s %(levelname)s %(message)s")
    asyncio.run(run())


if __name__ == "__main__":
    main()
