"""leaf-live stream bookkeeping and the shared vitals mapping (no database).

    python -m pytest tests/test_live_rollup.py
"""
import base64
import os
import struct

from app.live.rollup import GapTracker, MinuteCloser, browser_chunk, decode_samples, minute_of, rollup
from app.vitals_mapping import latest_values, minute_payload


def numeric(param, value, ts, unit=""):
    return {"ivy_param": param, "value": value, "unit": unit, "device_ts": ts, "system_ts": ts}


def test_mapping_first_sample_wins_and_co2_prefers_mmhg():
    rows = [numeric("HR", 80, 1), numeric("heart_rate", 90, 2), numeric("etco2", 5, 3, "%"),
            numeric("et_co2", 4.8, 4, "kPa"), numeric("et_co2", 35, 5, "mmHg"), numeric("et_co2", 36, 6, "mmHg"),
            numeric("unknown::150456", 97, 7), numeric("nonsense", 1, 8)]
    assert minute_payload(rows) == {"hr": 80, "etco2": 5, "et_co2": 35, "spo2": 97}


def test_latest_values_takes_last_sample():
    rows = [numeric("hr", 80, 1), numeric("hr", 82, 2), numeric("spo2", 98, 2)]
    assert latest_values(rows) == {"hr": 82, "spo2": 98}


def test_gap_tracker_counts_missing_seconds():
    tracker = GapTracker(99)
    for seq in (100, 101, 104, 103, 105, 110):
        tracker.add(seq)
    assert tracker.last == 110
    assert tracker.gaps == 2 + 4
    assert tracker.ranges == [(102, 103), (106, 109)]
    fresh = GapTracker()
    fresh.add(5)
    assert (fresh.last, fresh.gaps) == (5, 0)


def test_minute_closes_when_the_stream_moves_past_it():
    closer = MinuteCloser()
    base = minute_of(1_750_000_030)
    assert base % 60 == 0 and base <= 1_750_000_030
    assert all(closer.add(seq) == [] for seq in range(base, base + 60))
    assert closer.add(base + 60) == [base]
    assert closer.add(base + 61) == []
    # A late revision of the closed minute rolls it again at once.
    assert closer.add(base + 30) == [base]
    # Replay after a gap closes every minute it skipped over.
    assert closer.add(base + 200) == [base + 60]


def test_rollup_merges_devices_in_time_order():
    monitor = [[numeric("hr", 70, 2000)], [numeric("hr", 71, 3000), numeric("spo2", 99, 3000)]]
    ventilator = [[numeric("etco2", 34, 1500, "mmHg"), numeric("hr", 120, 1000)]]
    assert rollup(monitor + ventilator) == {"hr": 120, "spo2": 99, "etco2": 34}
    assert rollup([[], None]) == {}


def test_decode_little_endian_int16():
    samples = [0, 1, -1, 32767, -32768, 1234]
    encoded = base64.b64encode(struct.pack("<6h", *samples)).decode()
    assert decode_samples(encoded) == samples
    assert decode_samples(base64.b64encode(b"\x01\x00\x02").decode()) == [1]
    assert decode_samples("") == []


def test_browser_chunk_shape():
    chunk = {"type": "chunk", "device_id": "m540-1", "seq": 1_750_000_000, "rev": 1, "t0": 1_750_000_000_000,
             "t1": 1_750_000_001_000, "numerics": [numeric("hr", 72, 1_750_000_000_100)],
             "waves": [{"channel": "ecg_ii", "rate_hz": 250, "t0": 1_750_000_000_000,
                        "samples_b64": base64.b64encode(struct.pack("<3h", 1, 2, 3)).decode()}]}
    message = browser_chunk(7, chunk)
    assert message["type"] == "chunk" and message["case_id"] == 7 and message["rev"] == 1
    assert message["numerics"] == {"hr": 72}
    assert message["raw"] == chunk["numerics"]
    assert message["waves"] == [{"channel": "ecg_ii", "rate_hz": 250, "t0": 1_750_000_000_000, "samples": [1, 2, 3]}]


def test_queued_chunks_are_stored_together_and_acked_once_per_device(monkeypatch):
    """GatewayClient.handle_batch: one store call per run of chunks, one cumulative ack per device, then fan-out."""
    import asyncio
    import json

    monkeypatch.setenv("FLORA_DATABASE_URL", os.environ.get("FLORA_DATABASE_URL", "postgresql://unused@127.0.0.1:9/unused"))
    from app.live import gateway, store  # the pool opens lazily; store is patched below

    class Hub:
        def __init__(self):
            self.closers, self.events = {}, []

        def closer(self, case_id, device_id):
            return self.closers.setdefault((case_id, device_id), MinuteCloser())

        def expect(self, case_id, device_id, from_seq):
            self.events.append(("expect", case_id, device_id, from_seq))

        def received(self, case_id, device_id, chunk):
            self.events.append(("chunk", case_id, device_id, chunk["seq"]))

    class Socket:
        def __init__(self):
            self.sent = []

        async def send(self, text):
            self.sent.append(json.loads(text))

    stored = []
    monkeypatch.setattr(store, "store_chunks", lambda work: stored.append([(c["seq"], cases) for c, cases in work]))
    monkeypatch.setattr(store, "set_state", lambda *args: None)
    hub, socket = Hub(), Socket()
    client = gateway.GatewayClient(hub, {"id": 1, "stream_url": "ws://x", "token": "t"})
    base = minute_of(1_750_000_000)
    client.bound = {
        "b1": {"case_id": 7, "device_id": "m1", "case_uuid": "u7", "state": "bound", "origin_seq": base},
        "b2": {"case_id": 8, "device_id": "m2", "case_uuid": "u8", "state": "pending", "origin_seq": base},
    }
    chunk = lambda device, seq: {"type": "chunk", "device_id": device, "seq": seq, "numerics": [], "waves": []}
    batch = [chunk("m1", seq) for seq in range(base, base + 61)] + [chunk("m2", base), chunk("m2", base + 1)]
    batch += [{"type": "bound", "case_uuid": "u8", "device_id": "m2", "from_seq": base}, chunk("m2", base + 2), chunk("x", 5)]
    assert asyncio.run(client.handle_batch(socket, batch)) is True
    assert [[seq for seq, _ in call] for call in stored] == [list(range(base, base + 61)) + [base, base + 1], [base + 2]]
    assert stored[0][60] == (base + 60, [(7, [base])])  # the 61st second closes case 7's first minute
    assert socket.sent == [{"type": "ack", "device_id": "m1", "seq": base + 60}, {"type": "ack", "device_id": "m2", "seq": base + 1},
                           {"type": "ack", "device_id": "m2", "seq": base + 2}, {"type": "ack", "device_id": "x", "seq": 5}]
    expect_at = hub.events.index(("expect", 8, "m2", base))
    assert hub.events[expect_at - 1] == ("chunk", 8, "m2", base + 1) and hub.events[expect_at + 1] == ("chunk", 8, "m2", base + 2)
    assert len([e for e in hub.events if e[0] == "chunk"]) == 64
    assert asyncio.run(client.handle_batch(socket, [chunk("m1", base + 61), None])) is False
    assert socket.sent[-1] == {"type": "ack", "device_id": "m1", "seq": base + 61}
