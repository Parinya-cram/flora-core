"""Runtime wiring test with an in-memory broker double; no hardware required."""
import asyncio
from dataclasses import asdict
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock, patch

from device_medical_service.envelope import RawFrame, encode
from device_medical_service.parsers.draeger.medibus.parser import packet


class RuntimeTest(unittest.TestCase):
    def test_medibus_replies_and_observations_use_separate_kafka_topics(self):
        # Import here so the protocol-only suite can run without loading Kafka.
        from device_medical_service import __main__ as runtime

        sent = []

        class Producer:
            start = AsyncMock()
            stop = AsyncMock()

            async def send(self, topic, *, key, value):
                sent.append((topic, key, value))

            send_and_wait = send

        class Consumer:
            start = AsyncMock()
            stop = AsyncMock()

            async def __aiter__(self):
                for data in (packet(0x51), packet(0x52, response=True), packet(0x24, b'D6  14', response=True)):
                    encoding, payload = encode(data)
                    frame = RawFrame('serial.medibus', 'serial', 'gw', 1, 1000, encoding, payload)
                    yield SimpleNamespace(value=asdict(frame))

        async def exercise():
            with patch.object(asyncio.get_running_loop(), 'add_signal_handler'):
                await runtime.run()

        with patch.dict('os.environ', {
            'DEVICE_ID': 'vent-01', 'POD': 'serial.medibus', 'PARSER': 'medibus', 'PARSER_OPTIONS': '{}',
        }), patch.object(runtime, 'ensure_topics', AsyncMock()), \
             patch.object(runtime, 'AIOKafkaProducer', return_value=Producer()), \
             patch.object(runtime, 'AIOKafkaConsumer', return_value=Consumer()):
            asyncio.run(exercise())

        replies = [RawFrame.from_dict(value).data for topic, key, value in sent if topic == 'gw.cmd.serial.medibus']
        assert replies == [packet(0x51, response=True), packet(0x52)]
        observations = [(key, value) for topic, key, value in sent if topic == 'gw.obs']
        assert len(observations) == 1
        assert observations[0][0] == 'vent-01'
        assert observations[0][1]['ivy_param'] == 'rr'
        assert observations[0][1]['value'] == 14
        assert observations[0][1]['system_ts'] == 1000

        measurements = [(key, value) for topic, key, value in sent if topic == 'gw.measurements']
        assert len(measurements) == 1
        assert measurements[0][0] == 'vent-01'
        assert measurements[0][1]['raw_code'] == '24:D6'
        assert measurements[0][1]['raw_value'] == '  14'
        assert measurements[0][1]['definition']['name'] == 'RR'
