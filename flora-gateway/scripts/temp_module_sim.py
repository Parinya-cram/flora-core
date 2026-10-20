#!/usr/bin/env python3
"""Simulate a Temperature / CVP module (device type serial-temp-module) on a real RS-232 port.

The gateway's ascii_kv parser polls with "?<CR><LF>" every 5 s; this script answers
each poll with one line:

    TEMP=36.8;CVP=12<CR><LF>

Port settings match the template defaults: 9600 baud, 8 data bits, no parity, 1 stop bit,
no flow control. Connect this PC to the gateway's COM port with a null-modem cable
(or two USB-RS232 adapters crossed TX/RX).

  pip install pyserial
  # answer the gateway's polls (default)
  python temp_module_sim.py --port COM3              # Windows
  python temp_module_sim.py --port /dev/ttyUSB0      # Linux
  # send a line every 5 s without waiting for a poll
  python temp_module_sim.py --port COM3 --push --interval 5
  # fixed values instead of a random walk
  python temp_module_sim.py --port COM3 --temp 37.2 --cvp 10
  # list serial ports on this machine
  python temp_module_sim.py --list
"""
from __future__ import annotations

import argparse
import random
import sys
import time
from datetime import datetime

try:
    import serial
    from serial.tools import list_ports
except ImportError:
    sys.exit("pyserial is required: pip install pyserial")

PARITY = {"none": serial.PARITY_NONE, "even": serial.PARITY_EVEN, "odd": serial.PARITY_ODD}


class Vitals:
    """A slow random walk around realistic values, or fixed values when given."""

    def __init__(self, temp: float | None, cvp: float | None):
        self.fixed_temp, self.fixed_cvp = temp, cvp
        self.temp, self.cvp = temp or 36.8, cvp or 8.0

    def next(self) -> tuple[float, float]:
        if self.fixed_temp is None:
            self.temp = min(39.5, max(35.0, self.temp + random.uniform(-0.1, 0.1)))
        if self.fixed_cvp is None:
            self.cvp = min(15.0, max(2.0, self.cvp + random.uniform(-0.5, 0.5)))
        return round(self.temp, 1), round(self.cvp)


def line(temp: float, cvp: float, separator: str) -> bytes:
    return f"TEMP={temp}{separator}CVP={cvp}\r\n".encode("ascii")


def log(direction: str, data: bytes) -> None:
    print(f"{datetime.now():%H:%M:%S} {direction} {data!r}", flush=True)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--port", help="serial port, e.g. COM3 or /dev/ttyUSB0")
    parser.add_argument("--baud", type=int, default=9600)
    parser.add_argument("--data-bits", type=int, choices=(7, 8), default=8)
    parser.add_argument("--parity", choices=PARITY, default="none")
    parser.add_argument("--stop-bits", type=int, choices=(1, 2), default=1)
    parser.add_argument("--rtscts", action="store_true", help="hardware flow control (template default: none)")
    parser.add_argument("--push", action="store_true", help="send every --interval seconds without waiting for a poll")
    parser.add_argument("--interval", type=float, default=5.0)
    parser.add_argument("--poll", default="?", help="poll command the gateway sends, without CR/LF (default: ?)")
    parser.add_argument("--separator", default=";", help="pair separator (ascii_kv accepts ; or ,)")
    parser.add_argument("--temp", type=float, help="fixed temperature in Cel")
    parser.add_argument("--cvp", type=float, help="fixed CVP in mmHg")
    parser.add_argument("--list", action="store_true", help="list serial ports and exit")
    args = parser.parse_args()

    if args.list:
        for port in list_ports.comports():
            print(f"{port.device}\t{port.description}")
        return
    if not args.port:
        parser.error("--port is required (use --list to see ports)")

    port = serial.Serial(
        args.port, args.baud,
        bytesize=serial.EIGHTBITS if args.data_bits == 8 else serial.SEVENBITS,
        parity=PARITY[args.parity],
        stopbits=serial.STOPBITS_ONE if args.stop_bits == 1 else serial.STOPBITS_TWO,
        rtscts=args.rtscts, timeout=0.2,
    )
    port.dtr = True
    if not args.rtscts:
        port.rts = True
    mode = f"push every {args.interval}s" if args.push else f"answering poll {args.poll!r}"
    print(f"{args.port} {args.baud} {args.data_bits}{args.parity[0].upper()}{args.stop_bits}, {mode}. Ctrl+C to stop.")

    vitals = Vitals(args.temp, args.cvp)
    poll = args.poll.encode("ascii")
    buffer = b""
    next_push = time.monotonic()
    try:
        while True:
            if args.push:
                if time.monotonic() >= next_push:
                    data = line(*vitals.next(), args.separator)
                    port.write(data)
                    log("TX", data)
                    next_push += args.interval
                port.reset_input_buffer()
                time.sleep(0.05)
                continue
            chunk = port.read(64)
            if not chunk:
                continue
            buffer += chunk
            *requests, buffer = buffer.replace(b"\r\n", b"\n").replace(b"\r", b"\n").split(b"\n")
            for request in requests:
                log("RX", request)
                if request.strip() == poll:
                    data = line(*vitals.next(), args.separator)
                    port.write(data)
                    log("TX", data)
            buffer = buffer[-256:]
    except KeyboardInterrupt:
        pass
    finally:
        port.close()


if __name__ == "__main__":
    main()
