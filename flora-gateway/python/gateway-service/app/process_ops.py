"""Native (Windows, no Docker) counterpart of docker_ops: each device parser is a Python process instead of a
container, and the gateway's own services are run by the Flora iCIS app, which this module asks to restart / stop /
start through request files and reads their state from services.json (FLORA_NATIVE_STATE). Same functions and
results as docker_ops, so main.py does not change."""
import json
import os
import subprocess
import sys
import threading
import time
from pathlib import Path
from typing import Any

from . import settings

STATE_DIR = Path(os.getenv("FLORA_NATIVE_STATE", "native-state"))
PARSER_HOME = os.getenv("FLORA_PARSER_HOME", "")          # folder holding the device_medical_service package
LOG_DIR = STATE_DIR / "logs"
# Host ports of each service on this machine (the compose file's published ports, fixed in native mode).
PORTS = {"kafka": {"9094/tcp": ["7414"]}, "gateway-db": {"5432/tcp": ["7412"]}, "server": {"8080/tcp": ["8080"]},
         "socket-controller": {"9001/tcp": ["9001"], "9002/tcp": ["9002"], "9500/tcp": ["9500"], "2051/tcp": ["2051"]},
         "webhook-controller": {"9003/tcp": ["9003"]}, "gateway-service": {"8000/tcp": ["7400"]}, "kong": {"8000/tcp": ["7410"]}}

_parsers: dict[str, dict[str, Any]] = {}   # device_id -> {process, spec, wanted}
_lock = threading.Lock()


class ImageNotFound(Exception):
    pass


class DockerException(Exception):
    pass


def _launch(device_id: str, spec: dict[str, Any]) -> subprocess.Popen:
    LOG_DIR.mkdir(parents=True, exist_ok=True)
    log = open(LOG_DIR / f"parser-{device_id}.log", "ab")
    env = {**os.environ, "FLORA_KAFKA_BROKERS": settings.KAFKA_BROKERS, "DEVICE_ID": device_id, "POD": spec["pod"],
           "PARSER": spec["parser"], "PARSER_OPTIONS": json.dumps(spec["options"]), "PYTHONUNBUFFERED": "1"}
    code = f"import sys, runpy; sys.path.insert(0, r'{PARSER_HOME}'); runpy.run_module('device_medical_service', run_name='__main__')"
    flags = subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0
    return subprocess.Popen([sys.executable, "-c", code], env=env, stdout=log, stderr=log, creationflags=flags)


def _watch() -> None:
    """Keep wanted parsers running (the containers' restart: unless-stopped)."""
    while True:
        time.sleep(5)
        with _lock:
            for device_id, entry in _parsers.items():
                if entry["wanted"] and entry["process"].poll() is not None:
                    entry["process"] = _launch(device_id, entry["spec"])
                    entry["restarts"] = entry.get("restarts", 0) + 1


threading.Thread(target=_watch, name="parser-watch", daemon=True).start()


def start_parser(instance: dict[str, Any], device_type: dict[str, Any]) -> str:
    options = {**(device_type.get("default_options") or {}), **(instance.get("options") or {})}
    spec = {"pod": instance["pod"], "parser": device_type["parser"], "options": options}
    stop_parser(instance["device_id"])
    with _lock:
        process = _launch(instance["device_id"], spec)
        _parsers[instance["device_id"]] = {"process": process, "spec": spec, "wanted": True}
    return f"pid-{process.pid}"


def stop_parser(device_id: str) -> None:
    with _lock:
        entry = _parsers.pop(device_id, None)
    if entry and entry["process"].poll() is None:
        entry["process"].terminate()
        try:
            entry["process"].wait(timeout=10)
        except subprocess.TimeoutExpired:
            entry["process"].kill()


def parser_states() -> dict[str, dict[str, Any]]:
    with _lock:
        return {device_id: {"container": f"parser-{device_id}", "status": "running" if entry["process"].poll() is None else "exited",
                            "image": [f"native:{entry['spec']['parser']}"], "image_ref": "native"}
                for device_id, entry in _parsers.items()}


def _services() -> dict[str, str]:
    try:
        return json.loads((STATE_DIR / "services.json").read_text())
    except (OSError, ValueError):
        return {}


def _request(service: str, action: str) -> str:
    if service not in _services():
        raise LookupError(f"no process for service {service}")
    control = STATE_DIR / "control"
    control.mkdir(parents=True, exist_ok=True)
    (control / f"{service}.{action}").write_text(str(time.time()))
    return service


def restart_service(service: str) -> str:
    return _request(service, "restart")


def stop_service(service: str) -> str:
    return _request(service, "stop")


def start_service(service: str) -> str:
    return _request(service, "start")


def service_wiring(service: str) -> dict[str, Any]:
    return {"ports": PORTS.get(service, {}), "devices": {}}


def service_states() -> dict[str, str]:
    return _services()


__all__ = ["start_parser", "stop_parser", "parser_states", "restart_service", "stop_service", "start_service",
           "service_states", "service_wiring", "ImageNotFound", "DockerException"]
