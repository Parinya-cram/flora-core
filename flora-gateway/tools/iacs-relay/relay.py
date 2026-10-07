#!/usr/bin/env python3
"""Relays Dräger IACS (M540) UDP multicast to a Flora Gateway over TCP.

Run it on a machine in the monitor network when the gateway cannot receive the
multicast itself (different subnet, Docker, no multicast routing). It does what a
central station does to receive data, then forwards every datagram:

  1. joins the discovery group (224.127.1.254:2000) and learns each monitor's IP;
  2. joins that monitor's data group, 224.0.1.<last octet of its IP>, on the data port (2050);
  3. sends each data datagram to the gateway socket pod (framing = "udp_relay") as
     [u16 big-endian length][4-byte monitor IPv4][datagram], length covering IP + datagram.

The gateway sets each frame's source_ip to the monitor, so device instances select their
monitor exactly as with direct UDP. Standard library only. Example:

    python relay.py --gateway gateway.hospital.local:2051 --interface 192.168.10.5
"""
from __future__ import annotations

import argparse
import collections
import ipaddress
import logging
import socket
import struct
import threading
import time

log = logging.getLogger("iacs-relay")


def frame(monitor_ip: str, datagram: bytes) -> bytes:
    """One relay frame; see the module docstring."""
    body = socket.inet_aton(monitor_ip) + datagram
    if len(body) > 0xFFFF:
        raise ValueError("datagram too large for a relay frame")
    return struct.pack(">H", len(body)) + body


def data_group(monitor_ip: str, base: str = "224.0.1.0") -> str:
    """The IACS data group of a monitor: base with the monitor's last octet."""
    return ".".join(base.split(".")[:3] + [monitor_ip.split(".")[-1]])


def membership(group: str, interface: str) -> bytes:
    return socket.inet_aton(group) + socket.inet_aton(interface)


class Relay:
    def __init__(self, args):
        self.args = args
        self.queue: collections.deque[bytes] = collections.deque(maxlen=args.max_queue)
        self.ready = threading.Condition()
        self.joined: set[str] = set()
        self.allowed = {str(ipaddress.ip_address(ip)) for ip in args.monitor} if args.monitor else None
        self.dropped = 0
        self.data = socket.socket(socket.AF_INET, socket.SOCK_DGRAM, socket.IPPROTO_UDP)
        self.data.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        self.data.bind(("", args.data_port))
        for group in args.group:
            self.join(group)

    def join(self, group: str) -> None:
        if group in self.joined:
            return
        self.data.setsockopt(socket.IPPROTO_IP, socket.IP_ADD_MEMBERSHIP, membership(group, self.args.interface))
        self.joined.add(group)
        log.info("joined data group %s on %s", group, self.args.interface)

    def discover(self) -> None:
        group, port = self.args.discovery.split(":")
        while True:
            try:
                sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM, socket.IPPROTO_UDP)
                sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
                sock.bind(("", int(port)))
                sock.setsockopt(socket.IPPROTO_IP, socket.IP_ADD_MEMBERSHIP, membership(group, self.args.interface))
                log.info("listening for monitors on %s:%s", group, port)
                while True:
                    _, (monitor, _) = sock.recvfrom(65536)
                    if self.allowed is not None and monitor not in self.allowed:
                        continue
                    target = data_group(monitor, self.args.data_group_base)
                    if target not in self.joined:
                        log.info("monitor %s discovered", monitor)
                        self.join(target)
            except OSError as error:
                log.warning("discovery stopped (%s); retrying in 5 s", error)
                time.sleep(5)

    def receive(self) -> None:
        while True:
            datagram, (monitor, _) = self.data.recvfrom(65536)
            if self.allowed is not None and monitor not in self.allowed:
                continue
            with self.ready:
                if len(self.queue) == self.queue.maxlen:
                    self.dropped += 1   # gateway unreachable for long: keep the newest data
                self.queue.append(frame(monitor, datagram))
                self.ready.notify()

    def send(self) -> None:
        host, port = self.args.gateway.rsplit(":", 1)
        delay = 1.0
        while True:
            try:
                with socket.create_connection((host, int(port)), timeout=10) as conn:
                    conn.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
                    log.info("connected to gateway %s:%s", host, port)
                    delay = 1.0
                    while True:
                        with self.ready:
                            while not self.queue:
                                self.ready.wait()
                            pending = self.queue.popleft()
                        try:
                            conn.sendall(pending)
                        except OSError:
                            with self.ready:
                                self.queue.appendleft(pending)   # resend after reconnecting
                            raise
            except OSError as error:
                log.warning("gateway %s:%s unavailable (%s); retrying in %.0f s (queued %d, dropped %d)",
                            host, port, error, delay, len(self.queue), self.dropped)
                time.sleep(delay)
                delay = min(delay * 2, 30)

    def run(self) -> None:
        threading.Thread(target=self.discover, daemon=True, name="discover").start()
        threading.Thread(target=self.send, daemon=True, name="send").start()
        self.receive()


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--gateway", required=True, help="gateway host:port of the udp_relay socket pod")
    parser.add_argument("--interface", required=True, help="this machine's IPv4 on the monitor network")
    parser.add_argument("--data-port", type=int, default=2050, help="IACS data port (default 2050)")
    parser.add_argument("--discovery", default="224.127.1.254:2000", help="discovery group:port, default 224.127.1.254:2000")
    parser.add_argument("--data-group-base", default="224.0.1.0", help="data group = this with the monitor's last octet")
    parser.add_argument("--group", action="append", default=[], help="also join this data group (repeatable)")
    parser.add_argument("--monitor", action="append", default=[], help="only relay these monitor IPs (repeatable)")
    parser.add_argument("--max-queue", type=int, default=20000, help="datagrams held while the gateway is unreachable")
    args = parser.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    Relay(args).run()


if __name__ == "__main__":
    main()
