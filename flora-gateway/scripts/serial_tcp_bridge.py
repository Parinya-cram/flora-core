#!/usr/bin/env python3
"""Relay a physical RS-232 port on the host to a serial-controller virtual port.

Docker Desktop runs containers inside a VM, so a host port such as /dev/ttyS0 cannot be
mapped into serial-controller (inside the VM, /dev/ttyS0 is the VM's own console).
serial-controller instead exposes each virtual port over TCP (FLORA_SERIAL_BRIDGES,
ttyV0 -> 127.0.0.1:7430, ttyV1 -> 127.0.0.1:7431). This script connects the two, so
pod serial.COM1 (path /dev/ttyV0) talks to the real COM1.

The line settings live here, on the physical side; the pod's baud/parity do not reach
the host port.

  python3 scripts/serial_tcp_bridge.py --serial /dev/ttyS0 --tcp 127.0.0.1:7430 --baud 9600
  python3 scripts/serial_tcp_bridge.py --serial /dev/ttyS0 --tcp 127.0.0.1:7430 \\
      --baud 19200 --parity even --rts --dtr          # MEDIBUS.X
"""
from __future__ import annotations

import argparse
import selectors
import socket
import sys
import time
from datetime import datetime

try:
    import serial
except ImportError:
    sys.exit("pyserial is required: pip install pyserial")

PARITY = {"none": serial.PARITY_NONE, "even": serial.PARITY_EVEN, "odd": serial.PARITY_ODD}


def log(message: str) -> None:
    print(f"{datetime.now():%Y-%m-%d %H:%M:%S} {message}", flush=True)


def open_serial(args) -> serial.Serial:
    port = serial.Serial(
        args.serial, args.baud,
        bytesize=serial.EIGHTBITS if args.data_bits == 8 else serial.SEVENBITS,
        parity=PARITY[args.parity],
        stopbits=serial.STOPBITS_ONE if args.stop_bits == 1 else serial.STOPBITS_TWO,
        rtscts=args.flow_control == "hardware", xonxoff=args.flow_control == "software",
        timeout=0, exclusive=True,
    )
    if args.flow_control != "hardware":
        port.rts = args.rts
    port.dtr = args.dtr
    return port


def relay(port: serial.Serial, sock: socket.socket, verbose: bool) -> None:
    counts = {"to_gateway": 0, "to_device": 0}
    selector = selectors.DefaultSelector()
    selector.register(port.fileno(), selectors.EVENT_READ, "serial")
    selector.register(sock, selectors.EVENT_READ, "tcp")
    last_report = time.monotonic()
    while True:
        for key, _ in selector.select(timeout=1):
            if key.data == "serial":
                data = port.read(4096)
                if data:
                    sock.sendall(data)
                    counts["to_gateway"] += len(data)
                    if verbose:
                        log(f"device -> gateway {data!r}")
            else:
                data = sock.recv(4096)
                if not data:
                    raise ConnectionError("serial-controller closed the bridge")
                port.write(data)
                counts["to_device"] += len(data)
                if verbose:
                    log(f"gateway -> device {data!r}")
        if time.monotonic() - last_report >= 60:
            last_report = time.monotonic()
            log(f"bytes device->gateway={counts['to_gateway']} gateway->device={counts['to_device']}")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--serial", default="/dev/ttyS0")
    parser.add_argument("--tcp", default="127.0.0.1:7430", help="serial-controller bridge for the pod's ttyV port")
    parser.add_argument("--baud", type=int, default=9600)
    parser.add_argument("--data-bits", type=int, choices=(7, 8), default=8)
    parser.add_argument("--parity", choices=PARITY, default="none")
    parser.add_argument("--stop-bits", type=int, choices=(1, 2), default=1)
    parser.add_argument("--flow-control", choices=("none", "hardware", "software"), default="none")
    parser.add_argument("--rts", action="store_true", help="assert RTS")
    parser.add_argument("--dtr", action="store_true", help="assert DTR")
    parser.add_argument("--verbose", action="store_true", help="log every chunk")
    args = parser.parse_args()
    host, _, tcp_port = args.tcp.rpartition(":")

    log(f"bridge {args.serial} ({args.baud} {args.data_bits}{args.parity[0].upper()}{args.stop_bits}) <-> {args.tcp}")
    while True:
        port = sock = None
        try:
            port = open_serial(args)
            sock = socket.create_connection((host, int(tcp_port)), timeout=5)
            sock.settimeout(None)
            log("connected")
            relay(port, sock, args.verbose)
        except KeyboardInterrupt:
            return
        except Exception as error:  # Port busy, controller restarting, cable work: retry.
            log(f"{type(error).__name__}: {error}; retrying in 3 s")
            time.sleep(3)
        finally:
            for item in (sock, port):
                try:
                    item and item.close()
                except Exception:
                    pass


if __name__ == "__main__":
    main()
