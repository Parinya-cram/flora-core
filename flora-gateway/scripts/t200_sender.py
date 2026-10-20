#!/usr/bin/env python3
"""Send Acme T-200 frames to the gateway, over the virtual COM port or a real serial port.

Frame:  $T200,TEMP=36.8,CVP=12*3F<CR><LF>
The two hex digits after "*" are the XOR of every byte between "$" and "*".

The gateway polls with "R<CR>" and the device answers one frame (default mode).
--push sends a frame every --interval seconds without waiting for a poll.

  # virtual COM2 (serial-controller bridges /dev/ttyV1 to 127.0.0.1:7431)
  python3 scripts/t200_sender.py --temp 36.8 --cvp 12
  # real RS-232 port, e.g. through a null-modem cable to the gateway (needs pyserial)
  python3 scripts/t200_sender.py --serial /dev/ttyUSB0 --baud 9600
  # print the frame only
  python3 scripts/t200_sender.py --print
"""
from __future__ import annotations

import argparse
import random
import socket
import sys
import time


def checksum(body: str) -> str:
    value = 0
    for byte in body.encode():
        value ^= byte
    return f"{value:02X}"


def frame(temp: str, cvp: str) -> bytes:
    body = f"T200,TEMP={temp},CVP={cvp}"
    return f"${body}*{checksum(body)}\r\n".encode()


class TcpPort:
    def __init__(self, host: str, port: int):
        self.sock = socket.create_connection((host, port), timeout=5)
        self.sock.settimeout(0.2)

    def read(self) -> bytes:
        try:
            data = self.sock.recv(256)
        except socket.timeout:
            return b""
        if not data:
            raise ConnectionError("gateway closed the connection")
        return data

    def write(self, data: bytes) -> None:
        self.sock.sendall(data)


class SerialPort:
    def __init__(self, path: str, baud: int):
        try:
            import serial
        except ImportError:
            sys.exit("pyserial is required for --serial: pip install pyserial")
        self.port = serial.Serial(path, baud, timeout=0.2)

    def read(self) -> bytes:
        return self.port.read(256)

    def write(self, data: bytes) -> None:
        self.port.write(data)
        self.port.flush()


def values(args: argparse.Namespace) -> tuple[str, str]:
    if not args.random:
        return args.temp, args.cvp
    return f"{random.uniform(36.2, 37.8):.1f}", str(random.randint(6, 14))


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=7431, help="TCP bridge of the virtual port (7431 = COM2)")
    parser.add_argument("--serial", help="real serial device instead of the TCP bridge, e.g. /dev/ttyUSB0 or COM3")
    parser.add_argument("--baud", type=int, default=9600)
    parser.add_argument("--temp", default="36.8", help='temperature; "---" means no value')
    parser.add_argument("--cvp", default="12", help='CVP; "---" means no value')
    parser.add_argument("--random", action="store_true", help="random TEMP/CVP on every frame")
    parser.add_argument("--bad-checksum", action="store_true", help="send *00 so the parser must drop the frame")
    parser.add_argument("--push", action="store_true", help="send without waiting for the R poll")
    parser.add_argument("--interval", type=float, default=2.0, help="seconds between frames with --push")
    parser.add_argument("--count", type=int, default=0, help="stop after N frames (0 = run until Ctrl+C)")
    parser.add_argument("--print", action="store_true", help="print one frame and exit")
    args = parser.parse_args()

    def next_frame() -> bytes:
        data = frame(*values(args))
        return data[: data.index(b"*") + 1] + b"00\r\n" if args.bad_checksum else data

    if args.print:
        print(repr(next_frame().decode()))
        return

    port = SerialPort(args.serial, args.baud) if args.serial else TcpPort(args.host, args.port)
    print(f"connected to {args.serial or f'{args.host}:{args.port}'}; "
          f"{'push every %.1fs' % args.interval if args.push else 'answering R polls'}", flush=True)
    sent, buffer, last = 0, b"", 0.0
    try:
        while not args.count or sent < args.count:
            buffer += port.read()
            due = False
            if args.push:
                buffer = b""
                due = time.monotonic() - last >= args.interval
            elif b"\r" in buffer:
                request, _, buffer = buffer.partition(b"\r")
                due = request.strip() == b"R"
            if due:
                data = next_frame()
                port.write(data)
                sent, last = sent + 1, time.monotonic()
                print(f"{time.strftime('%H:%M:%S')} -> {data!r}", flush=True)
    except KeyboardInterrupt:
        pass
    print(f"sent {sent} frame(s)")


if __name__ == "__main__":
    main()
