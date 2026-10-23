"""M540 waveforms → gw.wave, and the demo simulator's datagrams through the real decoder."""
import struct
import sys
from pathlib import Path

from device_medical_service.envelope import RawFrame, encode
from device_medical_service.parsers import load_parser

SIMULATOR = Path(__file__).resolve().parents[4] / "device-simulator"
sys.path.insert(0, str(SIMULATOR))
from simulator import iacs  # noqa: E402


def raw(data, source_ip="10.20.0.11", ts=123_000):
    encoding, payload = encode(data)
    return RawFrame("socket.m540-relay", "socket", "gw", 1, ts, encoding, payload, {"source_ip": source_ip})


def wave_block(tag, key, samples):
    block = bytearray({200: 94, 100: 54, 50: 34}[tag])
    block[:2] = bytes((0, tag))
    block[10:12] = bytes(key)
    block[14:14 + 2 * len(samples)] = struct.pack(f">{len(samples)}h", *samples)
    return bytes(block)


def test_waveforms_are_recorded_with_tag_rate_and_frame_time():
    parser = load_parser("iacs_m540", "m540-sim-1", "socket.m540-relay", {"source_ip": "10.20.0.11"})
    ecg = list(range(-20, 20))
    pleth = list(range(20))
    parser.feed(raw(bytes(32) + wave_block(200, (1, 1), ecg) + wave_block(100, (25, 1), pleth)))
    waves = parser.drain_waves()
    assert [(w["device_id"], w["channel"], w["rate_hz"], w["t0"], w["samples"]) for w in waves] == [
        ("m540-sim-1", "1-1", 200.0, 123_000, ecg), ("m540-sim-1", "25-1", 100.0, 123_000, pleth)]
    assert parser.drain_waves() == []


def test_wave_channel_names_and_rate_overrides():
    parser = load_parser("iacs_m540", "m", "socket.m540-relay", {
        "source_ip": "10.20.0.11", "wave_channels": {"1-1": "ecg"}, "wave_rate_hz": {"1-1": 250, "100": 125}})
    parser.feed(raw(bytes(32) + wave_block(200, (1, 1), [0] * 40) + wave_block(100, (25, 1), [0] * 20)))
    assert [(w["channel"], w["rate_hz"]) for w in parser.drain_waves()] == [("ecg", 250.0), ("25-1", 125.0)]
    quiet = load_parser("iacs_m540", "m", "socket.m540-relay", {"source_ip": "10.20.0.11", "publish_waves": False})
    quiet.feed(raw(bytes(32) + wave_block(200, (1, 1), [0] * 40)))
    assert quiet.drain_waves() == []


def test_simulator_datagrams_decode_to_the_values_it_sent():
    vitals = {"hr": 74, "pr": 75, "spo2": 98, "rr": 14, "etco2": 37.5, "nibp_sys": 121, "nibp_dia": 76,
              "nibp_map": 91, "temperature": 36.6}
    ecg = [round(iacs.ecg(i / 200, 74)) for i in range(40)]
    pleth = [round(iacs.pleth(i / 100, 74)) for i in range(20)]
    data = iacs.datagram(vitals, [(200, iacs.ECG_KEY, ecg), (100, iacs.PLETH_KEY, pleth)])
    parser = load_parser("iacs_m540", "m540-sim-1", "socket.m540-relay",
                         {"source_ip": "10.20.0.11", "wave_channels": {"1-1": "ecg", "25-1": "pleth"}})
    rows = parser.feed(raw(data))
    assert {r["ivy_param"]: r["value"] for r in rows} == vitals
    waves = {w["channel"]: w for w in parser.drain_waves()}
    assert waves["ecg"]["samples"] == ecg and waves["ecg"]["rate_hz"] == 200.0
    assert waves["pleth"]["samples"] == pleth and waves["pleth"]["rate_hz"] == 100.0
    assert max(ecg) > 150, "the QRS peak is in the first beat window"


def test_simulator_relay_framing_carries_the_monitor_ip():
    data = iacs.datagram({"hr": 60})
    framed = iacs.relay_frame("10.20.0.12", data)
    length, = struct.unpack(">H", framed[:2])
    assert length == len(framed) - 2 == 4 + len(data)
    assert framed[2:6] == bytes((10, 20, 0, 12)) and framed[6:] == data
