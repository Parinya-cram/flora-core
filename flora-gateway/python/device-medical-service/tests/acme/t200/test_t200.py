from device_medical_service.envelope import RawFrame
from device_medical_service.parsers import load_parser
from device_medical_service.parsers.acme.t200.parser import checksum


def frame(payload: str) -> RawFrame:
    return RawFrame(pod="serial.COM2", controller="serial", gateway_id="gw", seq=1, ts=1_000, encoding="utf8", payload=payload)


def line(body: str) -> str:
    return f"${body}*{checksum(body)}\r\n"


def test_values_units_and_poll():
    parser = load_parser("acme_t200", "or-t200-01", "serial.COM2", {})
    rows = parser.feed(frame(line("T200,TEMP=36.8,CVP=8")))
    assert [(r["ivy_param"], r["value"], r["unit"]) for r in rows] == [("temperature", 36.8, "Cel"), ("cvp", 8, "mmHg")]
    assert parser.poll()[0]["pod"] == "serial.COM2"
    assert [m["raw_code"] for m in parser.drain_measurements()] == ["TEMP", "CVP"]


def test_partial_frames_are_joined():
    parser = load_parser("acme_t200", "or-t200-01", "serial.COM2", {})
    text = line("T200,TEMP=37.1,CVP=9")
    assert parser.feed(frame(text[:9])) == []
    assert [r["value"] for r in parser.feed(frame(text[9:]))] == [37.1, 9]


def test_bad_checksum_and_missing_values_are_dropped():
    parser = load_parser("acme_t200", "or-t200-01", "serial.COM2", {})
    assert parser.feed(frame("$T200,TEMP=36.8,CVP=8*00\r\n")) == []
    assert [r["ivy_param"] for r in parser.feed(frame(line("T200,TEMP=---,CVP=7")))] == ["cvp"]


def test_unbounded_noise_is_discarded():
    parser = load_parser("acme_t200", "or-t200-01", "serial.COM2", {})
    parser.feed(frame("x" * 5000))
    assert parser.buffer == ""
