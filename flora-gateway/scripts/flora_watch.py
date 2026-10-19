#!/usr/bin/env python3
"""Uptime log for this gateway host: when it was off, when containers stopped or restarted,
and when the gateway's web endpoints went down and came back.

One line per event, in daily files under ~/.local/state/flora/uptime/ (kept 90 days):

  2026-10-14 09:00:01  MONITOR  start            host off/monitor stopped since 2026-10-13 18:02:10 (14h57m)
  2026-10-14 09:00:41  CONTAINER start           flora-gateway-kong-1
  2026-10-14 10:12:03  CONTAINER die             flora-gateway-server-1 exit=137
  2026-10-14 10:12:04  CONTAINER restart         flora-gateway-server-1
  2026-10-14 10:12:05  CONTAINER health          flora-gateway-server-1 unhealthy
  2026-10-14 10:12:30  ENDPOINT down             data-api (http://127.0.0.1:7410/...) HTTP 502
  2026-10-14 10:13:00  ENDPOINT up               data-api after 30s down

Sources:
  * docker events (start, die, restart, oom, kill, stop, health) for every container
  * HTTP probes of the admin page, data-api and serial-controller every PROBE_SEC
  * a heartbeat file, so the next start can report how long the host or monitor was off

Runs as the flora-watch user service; see the unit in ~/.config/systemd/user/.

  python3 scripts/flora_watch.py                 # run in the foreground
  python3 scripts/flora_watch.py --summary 7     # last 7 days: off/on, starts, restarts, outages
  python3 scripts/flora_watch.py --summary 1 --all   # also routine healthy checks
"""
from __future__ import annotations

import argparse
import json
import signal
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
from datetime import datetime, timedelta
from pathlib import Path

LOG_DIR = Path.home() / ".local/state/flora/uptime"
HEARTBEAT = LOG_DIR / "heartbeat"
KEEP_DAYS = 90
PROBE_SEC = 30
HEARTBEAT_SEC = 30
PROBES = {
    "admin": "http://127.0.0.1:7400/health",
    "data-api": "http://127.0.0.1:7410/data-api/leaf-or-01/health",
    "serial-controller": "http://127.0.0.1:7401/status",
}
EVENTS = ("start", "die", "restart", "oom", "kill", "stop", "health_status")

_lock = threading.Lock()
_stop = threading.Event()


def stamp(ts: float | None = None) -> str:
    return datetime.fromtimestamp(ts or time.time()).strftime("%Y-%m-%d %H:%M:%S")


def span(seconds: float) -> str:
    seconds = int(seconds)
    days, rest = divmod(seconds, 86400)
    hours, rest = divmod(rest, 3600)
    minutes, secs = divmod(rest, 60)
    if days:
        return f"{days}d{hours}h{minutes}m"
    if hours:
        return f"{hours}h{minutes}m"
    return f"{minutes}m{secs}s" if minutes else f"{secs}s"


def write(source: str, event: str, detail: str = "", ts: float | None = None) -> None:
    line = f"{stamp(ts)}  {source:<9} {event:<15} {detail}".rstrip()
    with _lock:
        LOG_DIR.mkdir(parents=True, exist_ok=True)
        day = datetime.fromtimestamp(ts or time.time()).strftime("%Y-%m-%d")
        with open(LOG_DIR / f"{day}.log", "a", encoding="utf-8") as handle:
            handle.write(line + "\n")
    print(line, flush=True)


def prune() -> None:
    cutoff = datetime.now() - timedelta(days=KEEP_DAYS)
    for path in LOG_DIR.glob("*.log"):
        try:
            if datetime.strptime(path.stem, "%Y-%m-%d") < cutoff:
                path.unlink()
        except ValueError:
            pass


def boot_time() -> float:
    with open("/proc/stat") as handle:
        for line in handle:
            if line.startswith("btime"):
                return float(line.split()[1])
    return 0.0


def heartbeat_loop() -> None:
    while not _stop.wait(HEARTBEAT_SEC):
        HEARTBEAT.write_text(str(time.time()))


def report_gap() -> None:
    booted = boot_time()
    try:
        last = float(HEARTBEAT.read_text())
    except (OSError, ValueError):
        write("MONITOR", "start", f"first run; host booted {stamp(booted)}")
        return
    if booted > last:
        write("MONITOR", "start", f"host was off/rebooted: last alive {stamp(last)}, booted {stamp(booted)} "
                                  f"(off {span(booted - last)})")
    else:
        write("MONITOR", "start", f"monitor was stopped since {stamp(last)} ({span(time.time() - last)}); "
                                  f"host up since {stamp(booted)}")


def events_loop() -> None:
    """Follow docker events; reconnect while Docker is starting or restarting."""
    docker_up = None
    while not _stop.is_set():
        command = ["docker", "events", "--format", "{{json .}}", "--filter", "type=container"]
        for name in EVENTS:
            command += ["--filter", f"event={name}"]
        try:
            process = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        except FileNotFoundError:
            write("DOCKER", "error", "docker CLI not found")
            return
        first = True
        for raw in process.stdout:
            if first:
                first = False
                if docker_up is not True:
                    write("DOCKER", "up", "receiving container events")
                    docker_up = True
            try:
                event = json.loads(raw)
            except json.JSONDecodeError:
                continue
            attributes = event.get("Actor", {}).get("Attributes", {})
            name = attributes.get("name", event.get("id", "")[:12])
            action = event.get("Action", event.get("status", ""))
            ts = event.get("timeNano", 0) / 1e9 or None
            if action.startswith("health_status"):
                write("CONTAINER", "health", f"{name} {action.split(':', 1)[-1].strip()}", ts)
            elif action == "die":
                write("CONTAINER", "die", f"{name} exit={attributes.get('exitCode', '?')}", ts)
            elif action == "kill":
                write("CONTAINER", "kill", f"{name} signal={attributes.get('signal', '?')}", ts)
            else:
                write("CONTAINER", action, name, ts)
        process.wait()
        if _stop.is_set():
            return
        error = (process.stderr.read() or "").strip().splitlines()
        if docker_up is not False:
            write("DOCKER", "down", (error[-1] if error else f"docker events exited {process.returncode}")[:200])
            docker_up = False
        _stop.wait(10)


def probe(url: str) -> str | None:
    """None when healthy, else a short reason."""
    try:
        with urllib.request.urlopen(url, timeout=5) as response:
            return None if response.status < 400 else f"HTTP {response.status}"
    except urllib.error.HTTPError as error:
        return f"HTTP {error.code}"
    except Exception as error:
        return type(error).__name__ + (f": {error.reason}" if hasattr(error, "reason") else "")


def probe_loop() -> None:
    down_since: dict[str, float] = {}
    first = True
    while not _stop.is_set():
        for name, url in PROBES.items():
            problem = probe(url)
            if problem and name not in down_since:
                down_since[name] = time.time()
                write("ENDPOINT", "down", f"{name} ({url}) {problem}")
            elif not problem and name in down_since:
                write("ENDPOINT", "up", f"{name} after {span(time.time() - down_since.pop(name))} down")
            elif not problem and first:
                write("ENDPOINT", "up", f"{name}")
        first = False
        _stop.wait(PROBE_SEC)


def summary(days: int, everything: bool) -> None:
    since = datetime.now() - timedelta(days=days)
    for path in sorted(LOG_DIR.glob("*.log")):
        try:
            if datetime.strptime(path.stem, "%Y-%m-%d").date() < since.date():
                continue
        except ValueError:
            continue
        for line in path.read_text(encoding="utf-8").splitlines():
            routine = (" health " in line and line.endswith(" healthy")) or \
                      (line[21:].startswith("ENDPOINT  up") and " after " not in line)
            if everything or not routine:
                print(line)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--summary", type=int, metavar="DAYS", help="print outages of the last DAYS days and exit")
    parser.add_argument("--all", action="store_true", help="with --summary: every event, not only outages")
    args = parser.parse_args()
    if args.summary is not None:
        summary(args.summary, args.all)
        return

    LOG_DIR.mkdir(parents=True, exist_ok=True)
    prune()
    report_gap()
    HEARTBEAT.write_text(str(time.time()))

    def stop(signum, _frame):
        write("MONITOR", "stop", f"signal {signal.Signals(signum).name} (shutdown, logout or service stop)")
        HEARTBEAT.write_text(str(time.time()))
        _stop.set()

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    threads = [threading.Thread(target=target, daemon=True) for target in (heartbeat_loop, events_loop, probe_loop)]
    for thread in threads:
        thread.start()
    while not _stop.wait(3600):
        prune()
    sys.exit(0)


if __name__ == "__main__":
    main()
