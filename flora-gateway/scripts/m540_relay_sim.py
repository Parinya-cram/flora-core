#!/usr/bin/env python3
"""Simulate tools/iacs-relay for a Dräger M540, without a monitor or multicast.

Sends a recorded M540 numeric datagram (tests/fixtures/iacs-m540-numeric.hex) to the
gateway's m540-relay pod over TCP, framed exactly as relay.py does:

    [u16 big-endian length][4-byte monitor IPv4][datagram]

The monitor IP must equal the device's options.source_ip, or its parser drops the frame.

  python m540_relay_sim.py --gateway 172.22.1.233:2051 --monitor-ip 172.22.1.121
  python m540_relay_sim.py --gateway 172.22.1.233:2051 --monitor-ip 172.22.1.121 --interval 1 --count 30
"""
from __future__ import annotations

import argparse
import ipaddress
import socket
import struct
import time
from datetime import datetime
from pathlib import Path

FIXTURE = Path(__file__).resolve().parents[1] / "python/device-medical-service/tests/fixtures/iacs-m540-numeric.hex"


def frame(monitor_ip: str, datagram: bytes) -> bytes:
    body = ipaddress.IPv4Address(monitor_ip).packed + datagram
    return struct.pack(">H", len(body)) + body


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--gateway", default="127.0.0.1:2051", help="host:port of the m540-relay pod")
    parser.add_argument("--monitor-ip", required=True, help="pretend monitor IPv4 (= device options.source_ip)")
    parser.add_argument("--interval", type=float, default=1.0, help="seconds between datagrams")
    parser.add_argument("--count", type=int, default=0, help="stop after N datagrams (0 = run until Ctrl+C)")
    parser.add_argument("--hex", type=Path, default=FIXTURE, help="datagram hex file")
    args = parser.parse_args()

    datagram = bytes.fromhex(args.hex.read_text())
    host, _, port = args.gateway.rpartition(":")
    sent = 0
    while True:
        try:
            with socket.create_connection((host, int(port)), timeout=5) as sock:
                print(f"{datetime.now():%H:%M:%S} connected to {args.gateway}, monitor {args.monitor_ip}", flush=True)
                while not args.count or sent < args.count:
                    sock.sendall(frame(args.monitor_ip, datagram))
                    sent += 1
                    print(f"{datetime.now():%H:%M:%S} TX #{sent} {len(datagram)} B", flush=True)
                    time.sleep(args.interval)
                return
        except KeyboardInterrupt:
            return
        except OSError as error:
            print(f"{datetime.now():%H:%M:%S} {type(error).__name__}: {error}; retrying in 3 s", flush=True)
            time.sleep(3)


if __name__ == "__main__":
    main()
