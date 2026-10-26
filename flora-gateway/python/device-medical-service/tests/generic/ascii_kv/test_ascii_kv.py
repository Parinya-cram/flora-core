from device_medical_service.envelope import RawFrame
from device_medical_service.parsers import load_parser


def frame(payload: str, pod: str = "socket.or-monitor") -> RawFrame:
    return RawFrame(pod=pod, controller="socket", gateway_id="gw", seq=1, ts=1_000, encoding="utf8", payload=payload)


def test_ascii_kv_buffers_partial_lines_and_polls():
    parser = load_parser("ascii_kv", "or-module-01", "serial.COM1", {
        "codes": {"TEMP": "temperature", "MAC": "mac"}, "poll_command": "?\\r\\n", "poll_interval_sec": 5,
    })
    assert parser.feed(frame("TEMP=36.", "serial.COM1")) == []
    rows = parser.feed(frame("8;MAC=1.1\r\n", "serial.COM1"))
    assert [(row["ivy_param"], row["value"]) for row in rows] == [("temperature", 36.8), ("mac", 1.1)]
    assert parser.poll()[0]["payload"] == "?\r\n"
    assert parser.poll()[0]["pod"] == "serial.COM1"


def medibus_x_frame(payload: str) -> str:
    lrc = (-sum(payload.encode())) & 0xFF
    return f"\x02{payload};{lrc:02X}\x03"


def test_ascii_kv_reads_stx_etx_frames_with_lrc():
    parser = load_parser("ascii_kv", "vent-01", "serial.COM1", {
        "codes": {"P_PEAK": "airway_pressure_peak", "FI_O2": "fio2", "MDC_RESP_RATE": "rr"}, "checksum": "lrc",
    })
    good = medibus_x_frame("P_PEAK=22.5;MDC_PRESS_AW_PEEP=5.5;FI_O2=49;MDC_RESP_RATE=11")
    # split across two serial chunks, with line noise before STX
    assert parser.feed(frame("\x00\x00" + good[:20], "serial.COM1")) == []
    rows = parser.feed(frame(good[20:], "serial.COM1"))
    assert [(r["ivy_param"], r["value"]) for r in rows] == [("airway_pressure_peak", 22.5), ("fio2", 49), ("rr", 11)]
    bad = good.replace("49", "48")                       # LRC no longer matches
    assert parser.feed(frame(bad, "serial.COM1")) == []


def test_ascii_kv_etx_frames_without_checksum_ignore_the_trailing_lrc_field():
    parser = load_parser("ascii_kv", "vent-01", "serial.COM1", {"codes": {"V_TE": "tidal_volume_exp"}})
    rows = parser.feed(frame(medibus_x_frame("V_TE=480"), "serial.COM1"))
    assert [(r["ivy_param"], r["value"]) for r in rows] == [("tidal_volume_exp", 480)]
