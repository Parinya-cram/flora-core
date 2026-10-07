import struct

import pytest

from device_medical_service.envelope import RawFrame, encode
from device_medical_service.parsers import load_parser
from device_medical_service.parsers.draeger.vista_s.parser import GREETING, parse_frame, resync

POD = "socket.vista"


def frame(records, position=10, remaining=100):
    """A synthetic vitals message: header + [uint16 id][float32 value] records."""
    body = b"".join(struct.pack("<Hf", record_id, value) for record_id, value in records)
    return struct.pack("<6H", 12 + len(body), 0x51, position, remaining, len(records), 0) + body


def other(kind=0x52, payload=b"\x01" * 20):
    return struct.pack("<2H", 4 + len(payload), kind) + payload


def raw(data=b"", ts=1_000_000, **meta):
    encoding, payload = encode(data)
    return RawFrame(POD, "socket", "gateway-test", 1, ts, encoding, payload, {"connection": 1, **meta})


VITALS = [(0, 72.0), (3, 0.12), (14, 16.0), (15, 120.0), (16, 80.0), (17, 93.0), (18, 70.0),
          (19, 97.0), (20, 71.0), (53, 36.6), (54, -1000.0), (7, 5.0)]


def values(rows):
    return {row["ivy_param"]: (row["value"], row["unit"]) for row in rows}


def parser(**options):
    return load_parser("draeger_vista_s", "vista-1", POD, options)


def test_full_frame_maps_vitals_and_keeps_original_records():
    p = parser()
    rows = p.feed(raw(frame(VITALS)))
    assert values(rows) == {"hr": (72, "/min"), "rr": (16, "/min"), "nibp_sys": (120, "mmHg"), "nibp_dia": (80, "mmHg"),
                            "nibp_map": (93, "mmHg"), "spo2": (97, "%"), "pr": (71, "/min"), "temperature": (36.6, "Cel")}
    rows = p.drain_measurements()
    measured = {m["raw_code"]: m["value"] for m in rows}
    assert measured["3"] == 0.12 and measured["54"] is None  # ST kept; T2 not connected
    assert {m["raw_code"]: m["raw_value"] for m in rows}["54"] == -1000.0  # original marker kept
    assert all(m["raw_value"] is not None for m in rows)  # gateway_measurement.raw_value is NOT NULL
    assert "7" not in measured  # unidentified record ids are dropped unless record_unmapped


def test_record_unmapped_keeps_unknown_ids():
    p = parser(record_unmapped=True)
    p.feed(raw(frame(VITALS)))
    assert "7" in {m["raw_code"] for m in p.drain_measurements()}


def test_frame_split_across_reads_and_other_messages_skipped():
    data = other() + frame(VITALS) + other(0x60)
    p = parser()
    for split in range(1, len(data)):
        p = parser()
        rows = p.feed(raw(data[:split])) + p.feed(raw(data[split:]))
        assert values(rows)["hr"] == (72, "/min"), split


def test_resync_after_garbage_and_header_must_prove_itself():
    garbage = b"\xff\xff\x51\x00" + b"\x00" * 7
    assert resync(garbage + frame(VITALS)) == len(garbage)
    p = parser()
    assert values(p.feed(raw(garbage + frame(VITALS))))["spo2"] == (97, "%")
    bad = bytearray(frame([(0, 60.0)]))
    bad[10] = 1  # reserved must be zero
    assert parse_frame(bytes(bad)) is None
    assert parse_frame(frame([(0, 60.0)])[:-1]) is None
    assert parse_frame(frame([(54, -1000.0)]))["values"] == {54: -1000.0}


def test_no_reading_marker_is_not_charted():
    rows = parser().feed(raw(frame([(0, -1000.0), (19, 98.0)])))
    assert values(rows) == {"spo2": (98, "%")}


def test_throttle_one_frame_per_second_but_new_nibp_goes_through():
    p = parser()
    assert p.feed(raw(frame(VITALS), ts=1_000))
    assert p.feed(raw(frame(VITALS), ts=1_400)) == []          # within a second, same NIBP
    later = values(p.feed(raw(frame(VITALS), ts=2_100)))
    assert "hr" in later and "nibp_sys" not in later            # NIBP charted only when it changes
    new_bp = [(r, v) for r, v in VITALS if r not in (15, 16)] + [(15, 130.0), (16, 85.0)]
    assert values(p.feed(raw(frame(new_bp), ts=2_300)))["nibp_sys"] == (130, "mmHg")


def test_greeting_on_connect_targets_that_connection():
    p = parser()
    assert p.feed(raw(event="connected", connection=7, source_ip="192.168.1.20")) == []
    [cmd] = p.drain_commands()
    assert RawFrame.from_dict(cmd).data == GREETING and cmd["meta"] == {"connection": 7}
    assert parser(greeting_hex="").feed(raw(event="connected")) == []


def test_source_ip_selects_one_monitor_on_a_shared_port():
    p = parser(source_ip="192.168.1.21")
    assert p.feed(raw(frame(VITALS), source_ip="192.168.1.20")) == []
    assert p.feed(raw(event="connected", source_ip="192.168.1.20")) == [] and p.drain_commands() == []
    assert p.feed(raw(frame(VITALS), source_ip="192.168.1.21"))


def test_new_connection_drops_half_read_frame():
    p = parser()
    data = frame(VITALS)
    p.feed(raw(data[:20], connection=1))
    rows = p.feed(raw(data, connection=2))
    assert values(rows)["hr"] == (72, "/min")


def test_invalid_mapping_rejected():
    with pytest.raises(ValueError):
        parser(records={"0": {"name": "HR", "unit": "/min", "ivy_param": "not_a_param"}})
