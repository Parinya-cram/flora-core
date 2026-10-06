import pytest
from device_medical_service.envelope import RawFrame, encode
from device_medical_service.parsers import load_parser
from device_medical_service.parsers.draeger.medibus.parser import packet


def raw(data, pod="serial.medibus", **meta):
    encoding, payload = encode(data)
    return RawFrame(pod, pod.split('.')[0], "gw", 1, 123456, encoding, payload, meta)


def command_bytes(item):
    return RawFrame.from_dict(item).data


def medibus(**options):
    return load_parser("medibus", "vent-01", "serial.medibus", options)


def test_medibus_wire_checksum_matches_known_commands():
    assert packet(0x51) == b'\x1bQ6C\r'
    assert packet(0x51, response=True) == b'\x01Q52\r'
    assert packet(0x24) == b'\x1b$3F\r'


def test_medibus_handshake_pages_and_device_requests():
    parser = medibus()
    assert command_bytes(parser.poll()[0]) == b'\x1bQ6C\r'
    assert parser.poll() == []
    parser.feed(raw(b'\x01Q52\r'))
    assert command_bytes(parser.drain_commands()[0]) == b'\x1bR6D\r'
    parser.feed(raw(packet(0x52, b"1234'Test'01.00", response=True)))
    for code in (0x24, 0x2B, 0x29, 0x24):
        assert command_bytes(parser.poll()[0]) == packet(code)
        parser.feed(raw(packet(code, response=True)))
    parser.feed(raw(packet(0x30)))
    assert command_bytes(parser.drain_commands()[0]) == packet(0x30, response=True)
    # A response must not create an endless NOP echo loop.
    parser.feed(raw(packet(0x30, response=True)))
    assert parser.drain_commands() == []
    parser.feed(raw(packet(0x51)))
    assert not parser.ready
    assert [command_bytes(c) for c in parser.drain_commands()] == [packet(0x51, response=True), packet(0x52)]


def test_medibus_timeout_reinitializes_session(monkeypatch):
    clock = [100.0]
    monkeypatch.setattr('device_medical_service.parsers.draeger.medibus.parser.time.monotonic', lambda: clock[0])
    parser = medibus()
    parser.poll()
    parser.feed(raw(packet(0x51, response=True)))
    parser.drain_commands()
    parser.feed(raw(packet(0x52, response=True)))
    assert parser.ready
    parser.poll()
    clock[0] += 4
    assert command_bytes(parser.poll()[0]) == packet(0x51)
    assert not parser.ready
    clock[0] += 20
    assert command_bytes(parser.poll()[0]) == packet(0x51)


@pytest.mark.parametrize('split', range(1, 29))
def test_medibus_fragmented_frames_and_unit_conversion(split):
    data = packet(0x24, b'D6  14F0  40E6  387D20.0', response=True)
    parser = medibus()
    rows = parser.feed(raw(data[:split])) + parser.feed(raw(data[split:]))
    values = {r['ivy_param']: r for r in rows}
    assert values['rr']['value'] == 14
    assert values['fio2']['value'] == 40
    assert values['et_co2']['value'] == 38
    assert values['airway_pressure_peak']['value'] == pytest.approx(20.394)
    assert values['airway_pressure_peak']['unit'] == 'cmH2O'
    assert all(r['system_ts'] == 123456 and r['device_id'] == 'vent-01' for r in rows)


def test_medibus_separates_pages_and_settings_width():
    parser = medibus()
    rows = parser.feed(raw(packet(0x2B, b'21 450', response=True) + packet(0x29, b'04 0.4509   120B  5.0', response=True)))
    assert {r['ivy_param']: r['value'] for r in rows} == {
        'tidal_volume_exp': 450, 'set_tidal_volume': 450, 'set_rr': 12, 'set_peep': pytest.approx(5.099),
    }
    assert parser.feed(raw(packet(0x24, b'21 999', response=True))) == []


def test_medibus_corruption_unavailable_values_and_resynchronization():
    parser = medibus(max_frame_bytes=64)
    good = packet(0x24, b'D6  14', response=True)
    bad = good[:-3] + b'00\r'
    assert parser.feed(raw(bad)) == []
    assert parser.feed(raw(packet(0x24, b'D6----F0    E6  >9', response=True))) == []
    assert parser.feed(raw(packet(0x24, b'D6 14', response=True))) == []
    assert parser.feed(raw(b'\x01' + b'x' * 100)) == []
    rows = parser.feed(raw(b'junk\x01$partial' + good))
    assert len(rows) == 1 and rows[0]['value'] == 14
    assert len(parser.buffer) <= 64
    # Realtime bytes do not break the independent ASCII channel.
    assert parser.feed(raw(good[:4] + b'\xd0\xc0\x80\x81' + good[4:]))[0]['value'] == 14


def test_medibus_options_override_only_the_selected_mapping():
    parser = medibus(parameters={'24:D6': {'ivy_param': 'rr', 'unit': '/min', 'scale': 2}})
    rows = parser.feed(raw(packet(0x24, b'D6  14F0  40', response=True)))
    assert [r['value'] for r in rows] == [28, 40]


@pytest.mark.parametrize('options', [{'poll_interval_sec': 0}, {'response_timeout_sec': -1}, {'session_timeout_sec': 0}])
def test_medibus_rejects_invalid_timers(options):
    with pytest.raises(ValueError):
        medibus(**options)


def test_original_fields_survive_mapping_and_unknown_codes():
    parser = medibus(parameters={'24:D6': {'ivy_param': 'rr', 'unit': '/min', 'scale': 2}})
    rows = parser.feed(raw(packet(0x24, b'D6  14B9 8.5A5----', response=True)))
    assert rows[0]['value'] == 28
    original = parser.drain_measurements()
    assert [r['raw_code'] for r in original] == ['24:D6', '24:B9', '24:A5']
    assert original[0]['raw_value'] == '  14'
    assert original[0]['value'] == 14
    assert original[0]['definition']['name'] == 'RR'
    assert original[0]['mapping']['scale'] == 2
    assert original[1]['definition']['name'] == 'MV'
    assert original[1]['mapping'] == {}
    assert original[2]['raw_value'] == '----' and original[2]['value'] is None
    assert parser.drain_measurements() == []


def test_original_fields_keep_page_identity_and_settings_units():
    parser = medibus()
    parser.feed(raw(packet(0x24, b'21 450', response=True) + packet(0x2B, b'21 450', response=True)
                    + packet(0x29, b'04 0.45', response=True)))
    original = parser.drain_measurements()
    assert [r['raw_code'] for r in original] == ['24:21', '2B:21', '29:04']
    assert original[1]['definition']['name'] == 'VTe'
    assert original[2]['value'] == .45
    assert original[2]['definition']['unit'] == 'L'
    assert original[2]['mapping']['unit'] == 'mL'


def test_invalid_packet_does_not_record_partial_measurements():
    parser = medibus()
    assert parser.feed(raw(packet(0x24, b'D6  14zz  20', response=True))) == []
    assert parser.drain_measurements() == []
    good = packet(0x24, b'D6  14', response=True)
    parser.feed(raw(good[:-3] + b'00\r'))
    assert parser.drain_measurements() == []
