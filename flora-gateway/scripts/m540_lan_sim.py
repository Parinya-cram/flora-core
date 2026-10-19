#!/usr/bin/env python3
"""Simulate a Dräger M540 on the LAN, the way the real monitor talks IACS.

Tests the whole M540 path without a monitor:

    this script (pretend M540) --UDP multicast--> flora-iacs-relay --TCP 2051--> gateway

Like a real M540 it
  1. announces itself on the discovery group 224.127.1.254:2000 every second
     (the relay learns the monitor IP from the sender address of these packets), and
  2. sends a numeric IACS datagram to its data group 224.0.1.<last octet of its IP>:2050.

The "monitor IP" is therefore the IPv4 of the machine running this script on the
--interface you choose. Put that IP in the device's options.source_ip.
The datagram is the recorded M540 numeric frame used by the gateway's parser tests
(HR, SpO2, NIBP, ...), so the values stay constant.

Requirements: Python 3, no extra packages. Run it on a machine in the same LAN/subnet
as the gateway's relay (multicast does not cross routers), or on the gateway itself.

  python m540_lan_sim.py --interface 172.22.1.50        # Windows/Linux PC on the LAN
  python m540_lan_sim.py --interface 172.22.1.233       # on the gateway host itself
  python m540_lan_sim.py --interface 172.22.1.50 --interval 1 --count 60
"""
from __future__ import annotations

import argparse
import socket
import struct
import time
from datetime import datetime

DISCOVERY = ("224.127.1.254", 2000)
DATA_PORT = 2050
DATA_GROUP_BASE = "224.0.1."
# Recorded M540 numeric datagram (flora-gateway tests/fixtures/iacs-m540-numeric.hex).
DATAGRAM = bytes.fromhex(
    "0000000000000000000000000000000000000000000000000000000000000000"
    "0000000000000000000000000000010100011a00000000000000000000000048"
    "000000000000000000000000000000000000190e00001c000000000000000000"
    "000000620000000000000000000000000000000000001e080000090000000000"
    "00000000000004ba0000000000000000000000000000000000001e0700000900"
    "0000000000000000000002f80000000000000000000000000000000000001e09"
    "0000090000000000000000000000038e00000000000000000000000000000000"
    "00001a0b0001110000000000000000000000016d000000000000000000000000"
    "000000000000020600011b0000000000000000000000000e00000000"
)


def sender(interface: str, ttl: int) -> socket.socket:
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM, socket.IPPROTO_UDP)
    sock.setsockopt(socket.IPPROTO_IP, socket.IP_MULTICAST_TTL, struct.pack("b", ttl))
    sock.setsockopt(socket.IPPROTO_IP, socket.IP_MULTICAST_IF, socket.inet_aton(interface))
    # Loopback on, so a relay on this same machine also receives the packets.
    sock.setsockopt(socket.IPPROTO_IP, socket.IP_MULTICAST_LOOP, 1)
    sock.bind((interface, 0))
    return sock


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--interface", required=True,
                        help="this machine's IPv4 on the LAN; becomes the pretend monitor IP (= source_ip)")
    parser.add_argument("--interval", type=float, default=1.0, help="seconds between data datagrams")
    parser.add_argument("--count", type=int, default=0, help="stop after N datagrams (0 = until Ctrl+C)")
    parser.add_argument("--ttl", type=int, default=1, help="multicast TTL (1 = stay in this subnet)")
    args = parser.parse_args()

    group = DATA_GROUP_BASE + args.interface.split(".")[-1]
    sock = sender(args.interface, args.ttl)
    print(f"pretend M540 {args.interface}: discovery -> {DISCOVERY[0]}:{DISCOVERY[1]}, "
          f"data -> {group}:{DATA_PORT} ({len(DATAGRAM)} B). Set source_ip = {args.interface}. Ctrl+C to stop.",
          flush=True)
    sent = 0
    try:
        while not args.count or sent < args.count:
            sock.sendto(b"\x00" * 16, DISCOVERY)          # announce: the relay only needs our address
            sock.sendto(DATAGRAM, (group, DATA_PORT))     # numeric data
            sent += 1
            print(f"{datetime.now():%H:%M:%S} TX #{sent} announce + {len(DATAGRAM)} B data", flush=True)
            time.sleep(args.interval)
    except KeyboardInterrupt:
        pass
    finally:
        sock.close()


if __name__ == "__main__":
    main()
