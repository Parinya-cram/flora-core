from tests.support import FIXTURES
import struct
import pytest
from device_medical_service.envelope import RawFrame, encode
from device_medical_service.parsers import load_parser
from device_medical_service.parsers.draeger.iacs_m540.blocks import IacsDatagramParser, IacsParseError


def raw(data, pod="serial.medibus", **meta):
    encoding, payload = encode(data)
    return RawFrame(pod, pod.split('.')[0], "gw", 1, 123456, encoding, payload, meta)


def test_m540_vector_fixture_has_flora_values_and_ingress_timestamp():
    parser = load_parser("iacs_m540", "monitor-01", "socket.m540", {"source_ip": "192.0.2.10"})
    data = bytes.fromhex((FIXTURES / "iacs-m540-numeric.hex").read_text())
    frame = raw(data, "socket.m540", source_ip="192.0.2.10")
    rows = parser.feed(frame)
    assert {r['ivy_param']: r['value'] for r in rows} == {
        'hr': 72, 'spo2': 98, 'rr': 14, 'nibp_sys': 121, 'nibp_dia': 76, 'nibp_map': 91, 'temperature': 36.5,
    }
    assert all(r['device_id'] == 'monitor-01' and r['system_ts'] == 123456 and r['device_ts'] is None for r in rows)
    assert parser.feed(raw(data, "socket.m540", source_ip="192.0.2.11")) == []
    assert parser.feed(raw(data, "socket.other", source_ip="192.0.2.10")) == []
    assert parser.feed(raw(bytes(32), "socket.m540", source_ip="192.0.2.10")) == []
    with pytest.raises(IacsParseError, match="truncated"):
        parser.feed(raw(data[:-1], "socket.m540", source_ip="192.0.2.10"))
    with pytest.raises(ValueError, match="unknown IACS"):
        parser.feed(raw(data + b'\xff\xff', "socket.m540", source_ip="192.0.2.10"))


def test_m540_requires_device_identity():
    with pytest.raises(ValueError, match="source_ip"):
        load_parser("iacs_m540", "m", "socket.m540")


def test_m540_waveform_signed_samples_and_opaque_bounds():
    block = bytearray(34)
    block[:2] = b'\x00\x32'
    block[10:12] = bytes((31, 1))
    samples = [-300, -1, 0, 1, 300, 20, 21, 22, 23, 24]
    block[14:] = struct.pack('>10h', *samples)
    assert IacsDatagramParser().parse(bytes(32) + block).waveforms['31-1'] == samples
    with pytest.raises(IacsParseError, match="truncated"):
        IacsDatagramParser().parse(bytes(32) + b'\x00\x0c')


def test_m540_keeps_unmapped_integers_without_inventing_names_or_units():
    data = bytes.fromhex((FIXTURES / 'iacs-m540-numeric.hex').read_text())
    parser = load_parser('iacs_m540', 'monitor', 'socket.m540', {'source_ip': '192.0.2.10', 'parameters': []})
    assert parser.feed(raw(data, 'socket.m540', source_ip='192.0.2.10')) == []
    original = parser.drain_measurements()
    decoded = IacsDatagramParser().parse(data).numeric_values
    assert {r['raw_code']: r['raw_value'] for r in original} == decoded
    assert all(r['definition']['name'] is None and r['definition']['unit'] is None for r in original)
    assert all(r['mapping'] == {} for r in original)
    assert parser.drain_measurements() == []
