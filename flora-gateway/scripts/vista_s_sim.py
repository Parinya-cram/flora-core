#!/usr/bin/env python3
"""Simulate a Dräger Vista 120 S patient monitor (device type draeger-vista-120s) over TCP.

The real monitor connects to its central station (CMS) and streams binary messages; the
gateway plays the CMS. This script plays the monitor:

  1. connect to the gateway's raw socket pod (default port 9500, pod socket.vista)
  2. read the 16-byte CMS greeting the parser sends on connect (optional)
  3. every --interval seconds send one vitals message, type 0x51, little endian:

       uint16 length = 12 + count*6   uint16 type = 0x51
       uint16 position                uint16 remaining
       uint16 count                   uint16 reserved = 0
       count x [uint16 record id][float32 value]      (-1000.0 = no reading)

     plus, with --noise, a waveform-like message of another type that the parser must skip.

Records sent (flora_mapping.json): 0 HR, 14 RR, 15/16/17 NIBP sys/dia/mean, 18 NIBP PR,
19 SpO2, 20 SpO2 PR, 53 T1, 54 T2, 3 ST. NIBP changes every --nibp-every seconds, as a
spot reading would.

The pod must use framing "raw" (not "mllp"): add the vista pod to the gateway config and
point the device at socket.vista.

  python vista_s_sim.py --host 172.22.1.233                 # pod socket.vista on 9500
  python vista_s_sim.py --host 172.22.1.233 --port 9500 --interval 1 --noise
  python vista_s_sim.py --host 172.22.1.233 --no-spo2 --no-temp   # sensors unplugged
  python vista_s_sim.py --print                                   # show one frame, no network
"""
from __future__ import annotations

import argparse
import random
import socket
import struct
import sys
import time
from datetime import datetime

FRAME_TYPE = 0x51
NO_READING = -1000.0
GREETING = bytes.fromhex("100002000000d5a9d907080e113b2605")


class Patient:
    """Slow random walk around plausible adult values."""

    def __init__(self, args):
        self.args = args
        self.hr, self.rr, self.spo2, self.t1, self.t2, self.st = 75.0, 14.0, 98.0, 36.8, 36.5, 0.1
        self.nibp = (120.0, 80.0, 93.0, 74.0)
        self.next_nibp = 0.0

    def step(self) -> None:
        walk = lambda value, step, low, high: min(high, max(low, value + random.uniform(-step, step)))
        self.hr = walk(self.hr, 2, 55, 120)
        self.rr = walk(self.rr, 1, 8, 28)
        self.spo2 = walk(self.spo2, 0.5, 90, 100)
        self.t1 = walk(self.t1, 0.05, 35.5, 38.5)
        self.t2 = walk(self.t2, 0.05, 35.0, 38.0)
        self.st = walk(self.st, 0.05, -0.5, 0.5)
        now = time.monotonic()
        if now >= self.next_nibp:
            self.next_nibp = now + self.args.nibp_every
            sys_ = round(random.uniform(105, 140))
            dia = round(random.uniform(60, 90))
            self.nibp = (sys_, dia, round(dia + (sys_ - dia) / 3), round(self.hr))

    def records(self) -> list[tuple[int, float]]:
        off = NO_READING
        spo2_on, temp_on, nibp_on = not self.args.no_spo2, not self.args.no_temp, not self.args.no_nibp
        sys_, dia, mean, pulse = self.nibp
        return [
            (0, round(self.hr)),
            (3, round(self.st, 2)),
            (14, round(self.rr)),
            (15, sys_ if nibp_on else off), (16, dia if nibp_on else off),
            (17, mean if nibp_on else off), (18, pulse if nibp_on else off),
            (19, round(self.spo2) if spo2_on else off),
            (20, round(self.hr) if spo2_on else off),
            (53, round(self.t1, 1) if temp_on else off),
            (54, round(self.t2, 1) if temp_on else off),
        ]


def vitals_frame(records: list[tuple[int, float]], position: int) -> bytes:
    count = len(records)
    header = struct.pack("<6H", 12 + count * 6, FRAME_TYPE, position & 0xFFFF, 0, count, 0)
    return header + b"".join(struct.pack("<Hf", record_id, float(value)) for record_id, value in records)


def noise_frame() -> bytes:
    """A message of another type (like a waveform block) that the parser skips by length."""
    payload = bytes(random.randrange(256) for _ in range(60))
    return struct.pack("<2H", 4 + len(payload), 0x23) + payload


def log(text: str) -> None:
    print(f"{datetime.now():%H:%M:%S}", text, flush=True)


def describe(records) -> str:
    names = {0: "HR", 14: "RR", 15: "NIBPs", 16: "NIBPd", 17: "NIBPm", 19: "SpO2", 20: "PR", 53: "T1"}
    return " ".join(f"{names[i]}={'--' if v == NO_READING else v}" for i, v in records if i in names)


def run(args) -> None:
    patient = Patient(args)
    position = 0
    while True:
        try:
            log(f"connecting to {args.host}:{args.port} ...")
            with socket.create_connection((args.host, args.port), timeout=5) as sock:
                sock.settimeout(2)
                try:
                    greeting = sock.recv(64)
                    status = "matches the CMS greeting" if greeting == GREETING else "differs from the default"
                    log(f"connected; greeting {greeting.hex()} ({len(greeting)} bytes, {status})")
                except socket.timeout:
                    log("connected; no greeting within 2 s (parser not running, or greeting_hex is empty)")
                sock.settimeout(None)
                while True:
                    patient.step()
                    records = patient.records()
                    payload = vitals_frame(records, position)
                    position += 1
                    if args.noise:
                        payload = noise_frame() + payload
                    sock.sendall(payload)
                    log(f"TX {len(payload):4d} B  {describe(records)}")
                    time.sleep(args.interval)
        except KeyboardInterrupt:
            return
        except OSError as error:
            log(f"{type(error).__name__}: {error}; retrying in 3 s")
            time.sleep(3)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--host", default="127.0.0.1", help="gateway host, e.g. 172.22.1.233")
    parser.add_argument("--port", type=int, default=9500, help="raw socket pod port on the host (socket.vista: 9500)")
    parser.add_argument("--interval", type=float, default=1.0, help="seconds between vitals frames")
    parser.add_argument("--nibp-every", type=float, default=60.0, help="seconds between NIBP readings")
    parser.add_argument("--noise", action="store_true", help="also send a non-vitals message before each frame")
    parser.add_argument("--no-spo2", action="store_true", help="SpO2 sensor unplugged (-1000.0)")
    parser.add_argument("--no-temp", action="store_true", help="temperature probes unplugged")
    parser.add_argument("--no-nibp", action="store_true", help="no NIBP reading")
    parser.add_argument("--print", action="store_true", help="print one frame as hex and exit")
    args = parser.parse_args()
    if args.print:
        patient = Patient(args)
        patient.step()
        frame = vitals_frame(patient.records(), 0)
        print(describe(patient.records()))
        print(frame.hex(" "))
        return
    run(args)


if __name__ == "__main__":
    main()
