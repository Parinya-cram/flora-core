#!/usr/bin/env python3
"""Simulate a Dräger MEDIBUS.X device (device type draeger-medibus) on a real RS-232 port.

The gateway's medibus parser is the MEDIBUS master; this script is the device side:

  gateway -> ESC 'Q' cs CR          initialize communication   -> SOH 'Q' cs CR
  gateway -> ESC 'R' cs CR          device identification      -> SOH 'R' <id> cs CR
  gateway -> ESC '$' cs CR          current measured data      -> SOH '$' (code + 4 chars)... cs CR
  gateway -> ESC '+' cs CR          measured data, page 2      -> SOH '+' (code + 4 chars)... cs CR
  gateway -> ESC ')' cs CR          current device settings    -> SOH ')' (code + 5 chars)... cs CR
  gateway -> ESC '0' / ESC 'U'      NOP / stop                 -> SOH '0' / SOH 'U'

cs is two uppercase hex digits: the sum of every byte from ESC/SOH up to cs, modulo 256.
Codes and units follow the gateway's flora_mapping.json (pressures in mbar, VT setting in L).

Port settings match the template: 19200 baud, 8 data bits, even parity, 1 stop bit,
no flow control, RTS and DTR asserted. Use a null-modem cable to the gateway's port.

  pip install pyserial
  python medibus_sim.py --port COM3              # Windows
  python medibus_sim.py --port /dev/ttyUSB0      # Linux
  python medibus_sim.py --port COM3 --quiet      # one line per request instead of hex dumps
  python medibus_sim.py --list                   # list serial ports
  python medibus_sim.py --print                  # print sample frames, no serial port

MEDIBUS.X over LAN (device type draeger-p2500-lan): --listen makes this script the device's
TCP port. Point the gateway's socket pod remote_host/port at it.

  python medibus_sim.py --listen 0.0.0.0:6000
"""
from __future__ import annotations

import argparse
import random
import socket
import sys
import time
from datetime import datetime

ESC, SOH, CR = 0x1B, 0x01, 0x0D
NAMES = {0x51: "ICC", 0x52: "ID", 0x24: "MEASURED", 0x2B: "MEASURED-2", 0x29: "SETTINGS", 0x30: "NOP", 0x55: "STOP"}

# code -> (start, low, high, step, decimals); 4-char fields on 0x24/0x2B, 5-char on 0x29.
MEASURED = {
    "D6": (14, 10, 20, 1, 0),        # RR /min
    "F0": (40, 30, 60, 1, 0),        # FiO2 %
    "EF": (36, 25, 55, 1, 0),        # etO2 %
    "E6": (38, 32, 45, 1, 0),        # etCO2 mmHg
    "E5": (0, 0, 2, 1, 0),           # FiCO2 mmHg
    "7D": (20.0, 15, 30, 0.5, 1),    # Ppeak mbar
    "74": (17.0, 12, 25, 0.5, 1),    # Pplat mbar
    "73": (10.0, 6, 15, 0.5, 1),     # Pmean mbar
    "78": (5.0, 4, 8, 0.2, 1),       # PEEP mbar
    "03": (6.3, 4, 9, 0.1, 1),       # MVe L/min
    "07": (45, 30, 70, 1, 0),        # Compliance L/bar
    "EB": (98, 94, 100, 1, 0),       # SpO2 %
    "E1": (72, 60, 95, 1, 0),        # PR /min
    "DC": (72, 60, 95, 1, 0),        # HR /min
    "E2": (1000, 500, 2000, 50, 0),  # O2 flow mL/min
    "DE": (1000, 500, 2000, 50, 0),  # Air flow mL/min
    "DD": (0, 0, 0, 0, 0),           # N2O flow mL/min
    "E9": (2.0, 1.5, 2.5, 0.1, 1),   # Fi agent %
    "EA": (1.8, 1.3, 2.3, 0.1, 1),   # Et agent %
}
MEASURED_2 = {
    "21": (450, 380, 520, 5, 0),     # VTe mL
}
SETTINGS = {
    "01": "   40",                   # FiO2 %
    "04": " 0.45",                   # VT L
    "09": "   12",                   # RR /min
    "0B": "  5.0",                   # PEEP mbar
}
DEVICE_ID = b"0161'Flora MEDIBUS sim'01.00"


def packet(code: int, data: bytes = b"", *, response: bool = True) -> bytes:
    body = bytes((SOH if response else ESC, code)) + data
    return body + f"{sum(body) & 0xff:02X}".encode("ascii") + bytes((CR,))


class Device:
    def __init__(self, fixed: bool):
        self.fixed = fixed
        self.values = {code: spec[0] for code, spec in {**MEASURED, **MEASURED_2}.items()}

    def step(self) -> None:
        if self.fixed:
            return
        for code, (_, low, high, step, decimals) in {**MEASURED, **MEASURED_2}.items():
            value = self.values[code] + random.choice((-step, 0, 0, step))
            self.values[code] = round(min(high, max(low, value)), decimals)

    def fields(self, codes: dict, width: int) -> bytes:
        out = b""
        for code, spec in codes.items():
            decimals = spec[4]
            value = f"{self.values[code]:.{decimals}f}"
            out += code.encode("ascii") + value.rjust(width)[:width].encode("ascii")
        return out

    def answer(self, code: int) -> bytes | None:
        if code == 0x51 or code == 0x30 or code == 0x55:
            return packet(code)
        if code == 0x52:
            return packet(code, DEVICE_ID)
        if code == 0x24:
            self.step()
            return packet(code, self.fields(MEASURED, 4))
        if code == 0x2B:
            return packet(code, self.fields(MEASURED_2, 4))
        if code == 0x29:
            return packet(code, b"".join(k.encode("ascii") + v.encode("ascii") for k, v in SETTINGS.items()))
        return None


class Reader:
    """Collects ESC/SOH ... CR messages from the byte stream and checks their checksum."""

    def __init__(self):
        self.buffer = bytearray()

    def feed(self, data: bytes) -> list[bytes]:
        messages = []
        for byte in data:
            if byte >= 0x80:
                continue
            if byte in (ESC, SOH):
                self.buffer = bytearray((byte,))
            elif not self.buffer:
                continue
            elif byte == CR:
                message, self.buffer = bytes(self.buffer), bytearray()
                if len(message) >= 4 and message[-2:] == f"{sum(message[:-2]) & 0xff:02X}".encode():
                    messages.append(message[:-2])
                else:
                    log("!!", f"bad checksum {message!r}")
            elif len(self.buffer) > 1024:
                self.buffer.clear()
            else:
                self.buffer.append(byte)
        return messages


def log(direction: str, text: str) -> None:
    print(f"{datetime.now():%H:%M:%S.%f}"[:-3], direction, text, flush=True)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--port", help="serial port, e.g. COM3 or /dev/ttyUSB0")
    parser.add_argument("--listen", metavar="HOST:PORT", help="serve MEDIBUS.X over TCP (LAN) instead of serial")
    parser.add_argument("--baud", type=int, default=19200)
    parser.add_argument("--parity", choices=("none", "even", "odd"), default="even")
    parser.add_argument("--fixed", action="store_true", help="keep values constant instead of drifting")
    parser.add_argument("--quiet", action="store_true", help="log request names only, not raw bytes")
    parser.add_argument("--list", action="store_true", help="list serial ports and exit")
    parser.add_argument("--print", action="store_true", help="print sample response frames and exit")
    args = parser.parse_args()

    device = Device(args.fixed)
    if args.print:
        for code in (0x51, 0x52, 0x24, 0x2B, 0x29):
            print(f"{NAMES[code]:<10} request {packet(code, response=False)!r}\n{'':<10} answer  {device.answer(code)!r}")
        return

    if args.listen:
        host, _, number = args.listen.rpartition(":")
        server = socket.create_server((host or "0.0.0.0", int(number)))
        print(f"MEDIBUS.X device simulator on TCP {args.listen}. Ctrl+C to stop.")
        try:
            while True:
                print("Waiting for the gateway to connect ...")
                conn, peer = server.accept()
                log("--", f"gateway connected from {peer[0]}:{peer[1]}")
                conn.settimeout(0.1)

                def read(conn=conn):
                    try:
                        data = conn.recv(256)
                    except socket.timeout:
                        return b""
                    if not data:
                        raise ConnectionError("gateway closed the connection")
                    return data
                try:
                    serve(device, read, conn.sendall, args.quiet)
                except (ConnectionError, OSError) as error:
                    log("--", f"disconnected: {error}")
                finally:
                    conn.close()
        except KeyboardInterrupt:
            pass
        finally:
            server.close()
        return

    try:
        import serial
        from serial.tools import list_ports
    except ImportError:
        sys.exit("pyserial is required: pip install pyserial")
    if args.list:
        for port in list_ports.comports():
            print(f"{port.device}\t{port.description}")
        return
    if not args.port:
        parser.error("--port is required (use --list to see ports)")

    parity = {"none": serial.PARITY_NONE, "even": serial.PARITY_EVEN, "odd": serial.PARITY_ODD}[args.parity]
    port = serial.Serial(args.port, args.baud, bytesize=serial.EIGHTBITS, parity=parity,
                         stopbits=serial.STOPBITS_ONE, timeout=0.1)
    port.rts = True
    port.dtr = True
    print(f"{args.port} {args.baud} 8{args.parity[0].upper()}1, MEDIBUS.X device simulator. Ctrl+C to stop.")
    print("Waiting for the gateway's ESC 'Q' (initialize) ...")
    try:
        serve(device, lambda: port.read(256), port.write, args.quiet)
    except KeyboardInterrupt:
        pass
    finally:
        port.close()


def serve(device: "Device", read, write, quiet: bool) -> None:
    """Answers gateway requests until read() or write() raises."""
    reader = Reader()
    counts: dict[str, int] = {}
    last_summary = time.monotonic()
    while True:
        for message in reader.feed(read()):
            start, code = message[0], message[1]
            name = NAMES.get(code, f"0x{code:02X}")
            if start == SOH:  # The gateway answering something we sent; nothing to do.
                log("RX", f"response {name}")
                continue
            reply = device.answer(code)
            if quiet:
                log("RX", f"{name} -> {'answered' if reply else 'ignored'}")
            else:
                log("RX", f"{name:<10} {message!r}")
                if reply:
                    log("TX", f"{name:<10} {reply!r}")
            if reply:
                write(reply)
                counts[name] = counts.get(name, 0) + 1
        if time.monotonic() - last_summary >= 30:
            last_summary = time.monotonic()
            log("--", "answered " + (", ".join(f"{k}={v}" for k, v in counts.items()) or "nothing yet (check cable/port)"))


if __name__ == "__main__":
    main()
