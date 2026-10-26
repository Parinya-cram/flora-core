"""Synthetic Dräger M540 (IACS) datagrams for the demo. Every value is fictional.

Block layout follows the gateway's decoder (device-medical-service
parsers/draeger/iacs_m540/blocks.py), not a vendor document:
  header   32 bytes (ignored by the decoder)
  numeric  tag 00 00, 36 bytes: key = 5 bytes at +14, value = int16 BE at +30
  wave     tag 00 C8 (200), 94 bytes: key = 2 bytes at +10, 40 int16 BE samples at +14
           tag 00 64 (100), 54 bytes: 20 samples
The relay framing (socket pod framing = "udp_relay", tools/iacs-relay) is
  [u16 BE length][4-byte IPv4 of the monitor][datagram], length covering IP + datagram.
"""
from __future__ import annotations

import ipaddress
import math
import struct

# Numeric keys and scales from iacs_m540/flora_mapping.json.
NUMERIC_KEYS = {
    "hr": ((1, 1, 0, 1, 26), 1),
    "pr": ((25, 5, 0, 1, 26), 1),
    "spo2": ((25, 14, 0, 0, 28), 1),
    "rr": ((2, 6, 0, 1, 27), 1),
    "etco2": ((31, 15, 0, 0, 9), 10),
    "nibp_sys": ((30, 8, 0, 1, 9), 10),
    "nibp_dia": ((30, 7, 0, 1, 9), 10),
    "nibp_map": ((30, 9, 0, 1, 9), 10),
    "temperature": ((26, 11, 0, 1, 17), 10),
}
# Waveform keys; demo instances name them with options.wave_channels.
ECG_KEY = (1, 1)
PLETH_KEY = (25, 1)
WAVE_SAMPLES = {200: 40, 100: 20, 50: 10}
WAVE_BLOCK = {200: 94, 100: 54, 50: 34}


def numeric_block(key: tuple[int, ...], raw: int) -> bytes:
    block = bytearray(36)
    block[14:19] = bytes(key)
    block[30:32] = struct.pack(">h", max(-32768, min(32767, int(raw))))
    return bytes(block)


def wave_block(rate_tag: int, key: tuple[int, int], samples: list[int]) -> bytes:
    count = WAVE_SAMPLES[rate_tag]
    if len(samples) != count:
        raise ValueError(f"tag {rate_tag} carries {count} samples")
    block = bytearray(WAVE_BLOCK[rate_tag])
    block[0:2] = bytes((0, rate_tag))
    block[10:12] = bytes(key)
    block[14:14 + 2 * count] = struct.pack(f">{count}h", *(max(-32768, min(32767, int(s))) for s in samples))
    return bytes(block)


def datagram(numerics: dict[str, float] | None = None, waves: list[tuple[int, tuple[int, int], list[int]]] = ()) -> bytes:
    """numerics: Flora key → value in display units; waves: (rate tag, key, samples)."""
    body = bytearray(32)
    for name, value in (numerics or {}).items():
        key, scale = NUMERIC_KEYS[name]
        body += numeric_block(key, round(value * scale))
    for rate_tag, key, samples in waves:
        body += wave_block(rate_tag, key, samples)
    return bytes(body)


def relay_frame(source_ip: str, data: bytes) -> bytes:
    return struct.pack(">H", 4 + len(data)) + ipaddress.IPv4Address(source_ip).packed + data


def ecg(t: float, hr: float) -> float:
    """Lead-II-like beat from Gaussian P, Q, R, S and T waves; t in seconds. Units ≈ 5 µV."""
    rr = 60.0 / max(hr, 20.0)
    phase = (t % rr) - 0.25 * rr          # R peak a quarter of the way into each beat
    waves = ((-0.16, 0.025, 30), (-0.03, 0.010, -25), (0.0, 0.012, 240), (0.03, 0.010, -50), (0.24, 0.045, 60))
    return sum(amplitude * math.exp(-((phase - centre) ** 2) / (2 * width ** 2)) for centre, width, amplitude in waves)


def pleth(t: float, hr: float) -> float:
    """Pulse oximeter curve: a fundamental plus a dicrotic harmonic, 0..~1000."""
    beat = 2 * math.pi * t * hr / 60.0
    return 500 + 380 * math.sin(beat) + 90 * math.sin(2 * beat + 0.8)
