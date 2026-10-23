"""Pod mode (POD_DEMUX=1): one container splits a shared pod into virtual devices by source_ip."""
import asyncio
from dataclasses import asdict
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch
import json

from device_medical_service.envelope import RawFrame, encode
from tests.support import FIXTURES

POD = "socket.m540-relay"
DATA = bytes.fromhex((FIXTURES / "iacs-m540-numeric.hex").read_text())
DEVICE_MAP = [
    {"device_id": "m540-a", "parser": "iacs_m540", "options": {"source_ip": "10.20.0.11"}},
    {"device_id": "m540-b", "parser": "iacs_m540", "options": {"source_ip": "10.20.0.12"}},
]


def frame(source_ip=None, data=DATA, **meta):
    encoding, payload = encode(data)
    if source_ip:
        meta["source_ip"] = source_ip
    return RawFrame(POD, "socket", "gw", 1, 5000, encoding, payload, meta)


def test_router_picks_the_instance_by_source_ip():
    from device_medical_service.__main__ import PodRouter

    router = PodRouter(POD, DEVICE_MAP)
    assert router.route(frame("10.20.0.11")).device_id == "m540-a"
    assert router.route(frame("10.20.0.12")).device_id == "m540-b"
    assert router.route(frame("10.20.0.99")) is None
    assert router.route(frame()) is None
    rows = router.route(frame("10.20.0.12")).feed(frame("10.20.0.12"))
    assert {row["device_id"] for row in rows} == {"m540-b"}


def test_unregistered_monitor_is_logged_once_a_minute_per_ip_and_transport_events_are_quiet():
    from device_medical_service.__main__ import PodRouter

    router = PodRouter(POD, DEVICE_MAP)
    first = router.unregistered(frame("10.20.0.99", peer="10.9.9.9:5000"), now=100.0)
    assert first["event"] == "unregistered_monitor" and first["source_ip"] == "10.20.0.99" and first["pod"] == POD
    assert router.unregistered(frame("10.20.0.99"), now=130.0) is None
    assert router.unregistered(frame("10.20.0.98"), now=130.0) is not None
    assert router.unregistered(frame("10.20.0.99"), now=161.0) is not None
    assert router.unregistered(frame("10.9.9.9", data=b"", event="connected"), now=200.0) is None
    assert router.unregistered(frame(), now=200.0) is None


def test_bad_instances_are_skipped_not_fatal():
    from device_medical_service.__main__ import PodRouter

    router = PodRouter(POD, DEVICE_MAP + [
        {"device_id": "dup", "parser": "iacs_m540", "options": {"source_ip": "10.20.0.11"}},
        {"device_id": "no-ip", "parser": "iacs_m540", "options": {}},
        {"device_id": "bad-parser", "parser": "nope", "options": {"source_ip": "10.20.0.13"}},
    ])
    assert sorted(router.parsers) == ["m540-a", "m540-b"]
    assert sorted(error["device_id"] for error in router.errors) == ["bad-parser", "dup", "no-ip"]


def test_pod_runtime_routes_publishes_and_commits_after_flush():
    from device_medical_service import __main__ as runtime

    sent, order = [], []
    wave_block = bytearray(94)
    wave_block[:2] = b"\x00\xc8"
    wave_block[10:12] = bytes((1, 1))
    with_wave = DATA + bytes(wave_block)

    class Producer:
        start = AsyncMock()
        stop = AsyncMock()

        async def send(self, topic, *, key, value):
            sent.append((topic, key, value))

        async def flush(self):
            order.append("flush")

    messages = [frame("10.20.0.11"), frame("10.20.0.12", data=with_wave), frame("10.20.0.77"), frame("10.20.0.11", data=b"\x00")]
    stop_after = {"batches": 0}

    class Consumer:
        start = AsyncMock()
        stop = AsyncMock()
        topics = AsyncMock(return_value={"gw.raw.socket.m540-relay"})
        assign = MagicMock()
        committed = AsyncMock(return_value=None)
        seek_to_end = AsyncMock()

        def partitions_for_topic(self, topic):
            return {0}

        async def getmany(self, timeout_ms, max_records):
            stop_after["batches"] += 1
            if stop_after["batches"] == 1:
                return {"tp": [SimpleNamespace(value=asdict(m)) for m in messages]}
            raise asyncio.CancelledError

        async def commit(self):
            order.append("commit")

    async def exercise():
        with patch.object(asyncio.get_running_loop(), "add_signal_handler"):
            await runtime.run()

    consumer = Consumer()
    with patch.dict("os.environ", {"POD_DEMUX": "1", "POD": POD, "DEVICE_MAP": json.dumps(DEVICE_MAP)}), \
         patch.object(runtime, "ensure_topics", AsyncMock()), \
         patch.object(runtime, "AIOKafkaProducer", return_value=Producer()), \
         patch.object(runtime, "AIOKafkaConsumer", return_value=consumer) as make_consumer:
        asyncio.run(exercise())

    assert make_consumer.call_args.kwargs["group_id"] == "gw-parser-pod-socket.m540-relay"
    assert make_consumer.call_args.kwargs["enable_auto_commit"] is False
    consumer.seek_to_end.assert_awaited()          # a new group starts at the end, not 72 h back
    assert order == ["flush", "commit"]
    obs = [(key, value) for topic, key, value in sent if topic == "gw.obs"]
    assert {key for key, _ in obs} == {"m540-a", "m540-b"}
    assert all(value["device_id"] == key for key, value in obs)
    waves = [(key, value) for topic, key, value in sent if topic == "gw.wave"]
    assert [(key, value["channel"], value["rate_hz"], value["t0"], len(value["samples"])) for key, value in waves] == \
        [("m540-b", "1-1", 200.0, 5000, 40)]
    logs = [value for topic, key, value in sent if topic == "gw.logs"]
    assert any(log["detail"].get("event") == "unregistered_monitor" and log["detail"]["source_ip"] == "10.20.0.77" for log in logs)
    assert any(log["message"] == "parse failed" and log["detail"]["device_id"] == "m540-a" for log in logs)
