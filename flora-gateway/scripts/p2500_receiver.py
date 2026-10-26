#!/usr/bin/env python3
"""Receive values from a Dräger P2500 (MEDIBUS.X) and print them, without the gateway stack.

This is the device's MEDIBUS master: it sends ICC/ID, then polls measured data (page 1
and 2) and current settings, and decodes them with the gateway's own medibus parser and
flora_mapping.json, so what it prints is what Flora would store.

Line settings of the P2500 interface: 19200 baud, 8 data bits, no parity, 1 stop bit.
Over LAN these are set on the device / serial-to-LAN converter, not here.

  # LAN: connect to the device (or its serial-to-LAN converter) TCP port
  python3 scripts/p2500_receiver.py --connect 192.168.1.50:4001
  # LAN: the device connects to this computer instead
  python3 scripts/p2500_receiver.py --listen 0.0.0.0:4001
  # Direct RS-232 (needs pyserial): 19200 8N1 by default
  python3 scripts/p2500_receiver.py --port COM3
  python3 scripts/p2500_receiver.py --port /dev/ttyUSB0

  --sniff         send nothing; hex-dump whatever the device sends (protocol check)
  --raw           also print every received field, mapped to Flora or not
  --csv FILE      append every decoded field to FILE
  --interval SEC  seconds between polls (default 1)
"""
from __future__ import annotations

import argparse
import csv
import socket
import sys
import time
from datetime import datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "python" / "device-medical-service"))
from device_medical_service.envelope import RawFrame, encode  # noqa: E402
from device_medical_service.parsers.draeger.medibus.parser import MedibusParser  # noqa: E402

POD = "socket.p2500"
PAGES = {"24": "measured", "2B": "measured-2", "29": "settings"}


def log(text: str) -> None:
    print(f"{datetime.now():%H:%M:%S.%f}"[:-3], text, flush=True)


class Tcp:
    def __init__(self, sock: socket.socket, peer: str):
        self.sock, self.peer = sock, peer
        sock.settimeout(0.05)

    def read(self) -> bytes:
        try:
            data = self.sock.recv(4096)
        except socket.timeout:
            return b""
        if not data:
            raise ConnectionError("device closed the connection")
        return data

    def write(self, data: bytes) -> None:
        self.sock.sendall(data)

    def close(self) -> None:
        self.sock.close()


class Serial:
    def __init__(self, args):
        try:
            import serial
        except ImportError:
            sys.exit("pyserial is required for --port: pip install pyserial")
        parity = {"none": serial.PARITY_NONE, "even": serial.PARITY_EVEN, "odd": serial.PARITY_ODD}[args.parity]
        self.port = serial.Serial(args.port, args.baud, bytesize=args.data_bits, parity=parity,
                                  stopbits=args.stop_bits, timeout=0.05)
        self.port.rts = True
        self.port.dtr = True
        self.peer = f"{args.port} {args.baud} {args.data_bits}{args.parity[0].upper()}{args.stop_bits}"

    def read(self) -> bytes:
        return self.port.read(4096)

    def write(self, data: bytes) -> None:
        self.port.write(data)

    def close(self) -> None:
        self.port.close()


def open_link(args, server: socket.socket | None):
    if args.port:
        return Serial(args)
    if server:
        log(f"waiting for the device on TCP {args.listen} ...")
        sock, (ip, port) = server.accept()
        return Tcp(sock, f"{ip}:{port}")
    host, _, port = args.connect.rpartition(":")
    sock = socket.create_connection((host, int(port)), timeout=args.connect_timeout)
    return Tcp(sock, args.connect)


def frame(data: bytes = b"", **meta) -> RawFrame:
    encoding, payload = encode(data)
    return RawFrame(POD, "socket", "p2500-receiver", 0, int(time.time() * 1000), encoding, payload, meta)


def sniff(link) -> None:
    total = 0
    while True:
        data = link.read()
        if data:
            total += len(data)
            text = "".join(chr(b) if 32 <= b < 127 else "." for b in data)
            log(f"RX {len(data):4d} B  {data.hex(' ')}\n{'':13}{text}")


def run(link, args, writer) -> None:
    parser = MedibusParser("p2500", POD, {"poll_interval_sec": args.interval})
    parser.feed(frame(event="connected"))
    next_poll = 0.0
    received = 0
    last_data = time.monotonic()
    while True:
        now = time.monotonic()
        commands = []
        if now >= next_poll:
            commands += parser.poll()
            next_poll = now + parser.poll_interval
        for command in commands + parser.drain_commands():
            link.write(RawFrame.from_dict(command).data)
        data = link.read()
        if not data:
            if now - last_data > 10:
                log("no data for 10 s: check cable/IP/port, and that the device's MEDIBUS.X interface is on")
                last_data = now
            continue
        last_data = now
        received += len(data)
        observations = {row["raw_code"]: row for row in parser.feed(frame(data))}
        for command in parser.drain_commands():
            link.write(RawFrame.from_dict(command).data)
        fields = parser.drain_measurements()
        if not fields:
            continue
        page = PAGES.get(fields[0]["raw_code"][:2], "?")
        lines = []
        for field in fields:
            code, row = field["raw_code"], observations.get(field["raw_code"])
            name = (field["definition"].get("name") or field["definition"].get("description") or "")[:28]
            unit = field["definition"].get("unit") or ""
            if writer:
                writer.writerow([datetime.now().isoformat(timespec="milliseconds"), code, name,
                                 field["raw_value"].strip(), unit, row["ivy_param"] if row else "",
                                 row["value"] if row else "", row["unit"] if row else ""])
            if row:
                lines.append(f"  {code}  {name:<28} {field['raw_value'].strip():>7} {unit:<8} -> "
                             f"{row['ivy_param']} = {row['value']} {row['unit']}")
            elif args.raw:
                lines.append(f"  {code}  {name:<28} {field['raw_value'].strip():>7} {unit}")
        if args.csv_file:
            args.csv_file.flush()
        log(f"{page}: {len(fields)} fields, {len(observations)} mapped to Flora")
        if lines:
            print("\n".join(lines), flush=True)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    where = parser.add_mutually_exclusive_group(required=True)
    where.add_argument("--connect", metavar="HOST:PORT", help="TCP: connect to the device / serial-to-LAN converter")
    where.add_argument("--listen", metavar="HOST:PORT", help="TCP: wait for the device to connect")
    where.add_argument("--port", help="direct RS-232 port, e.g. COM3 or /dev/ttyUSB0")
    parser.add_argument("--baud", type=int, default=19200)
    parser.add_argument("--parity", choices=("none", "even", "odd"), default="none")
    parser.add_argument("--data-bits", type=int, choices=(7, 8), default=8)
    parser.add_argument("--stop-bits", type=int, choices=(1, 2), default=1)
    parser.add_argument("--interval", type=float, default=1.0, help="seconds between polls")
    parser.add_argument("--connect-timeout", type=float, default=5.0)
    parser.add_argument("--sniff", action="store_true", help="send nothing, hex-dump what arrives")
    parser.add_argument("--raw", action="store_true", help="also print fields with no Flora mapping")
    parser.add_argument("--csv", metavar="FILE", help="append decoded fields to a CSV file")
    args = parser.parse_args()

    server = None
    if args.listen:
        host, _, port = args.listen.rpartition(":")
        server = socket.create_server((host or "0.0.0.0", int(port)))
    out = open(args.csv, "a", newline="") if args.csv else None
    writer = csv.writer(out) if out else None
    args.csv_file = out
    if writer and out.tell() == 0:
        writer.writerow(["time", "code", "name", "raw_value", "unit", "flora_param", "flora_value", "flora_unit"])
    try:
        while True:
            try:
                link = open_link(args, server)
            except OSError as error:
                log(f"cannot open {args.connect or args.port}: {error}; retrying in 3 s")
                time.sleep(3)
                continue
            log(f"connected: {link.peer}" + ("  (sniff: sending nothing)" if args.sniff else ""))
            try:
                sniff(link) if args.sniff else run(link, args, writer)
            except (ConnectionError, OSError) as error:
                log(f"disconnected: {error}")
                if args.port:
                    time.sleep(3)
            finally:
                link.close()
                if out:
                    out.flush()
    except KeyboardInterrupt:
        pass
    finally:
        if server:
            server.close()
        if out:
            out.close()


if __name__ == "__main__":
    main()
