"""Process layer: one container per device instance.

Reads `gw.raw.<pod>`, parses with the configured parser, publishes `gw.obs`, and
writes device commands (polls, ACKs) to `gw.cmd.<pod>`.

Environment (set by the Gateway Service when it starts the container):
  FLORA_KAFKA_BROKERS  DEVICE_ID  POD  PARSER  PARSER_OPTIONS (JSON)
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
import signal

from aiokafka import AIOKafkaConsumer, AIOKafkaProducer
from aiokafka.admin import AIOKafkaAdminClient, NewTopic
from aiokafka.errors import KafkaConnectionError, TopicAlreadyExistsError

from .envelope import LOG_TOPIC, OBS_TOPIC, MEASUREMENT_TOPIC, RawFrame, cmd_topic, now_ms, raw_topic
from .parsers import load_parser

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
    brokers = os.environ.get("FLORA_KAFKA_BROKERS", "kafka:9092")
    device_id = os.environ["DEVICE_ID"]
    pod = os.environ["POD"]
    parser = load_parser(os.environ["PARSER"], device_id, pod, json.loads(os.environ.get("PARSER_OPTIONS") or "{}"))
    source, commands = raw_topic(pod), cmd_topic(pod)

    for attempt in range(30):
        try:
            await ensure_topics(brokers, [source, commands, OBS_TOPIC, MEASUREMENT_TOPIC, LOG_TOPIC])
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

    consumer_task = asyncio.create_task(consume())
    await asyncio.wait([consumer_task, asyncio.create_task(stop.wait())], return_when=asyncio.FIRST_COMPLETED)
    for task in (consumer_task, poller):
        if task:
            task.cancel()
    await emit_log("info", "parser stopped")
    await consumer.stop()
    await producer.stop()


def main() -> None:
    logging.basicConfig(level=os.environ.get("LOG_LEVEL", "INFO"), format="%(asctime)s %(levelname)s %(message)s")
    asyncio.run(run())


if __name__ == "__main__":
    main()
