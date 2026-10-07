import struct

from relay import data_group, frame


def test_frame_carries_length_monitor_ip_and_datagram():
    data = frame("191.1.2.11", b"\x00\x0c" + b"x" * 10)
    length, = struct.unpack(">H", data[:2])
    assert length == 4 + 12 and data[2:6] == bytes([191, 1, 2, 11]) and data[6:] == b"\x00\x0c" + b"x" * 10


def test_data_group_uses_last_octet():
    assert data_group("191.1.2.11") == "224.0.1.11"
    assert data_group("10.0.0.7", "239.1.1.0") == "239.1.1.7"
