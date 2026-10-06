"""flora-updater: keeps one compose project on the release the hospital approved in Haber.

Runs as a sidecar in every Canopy, Leaf and Gateway compose project with the Docker
socket and the repository (the compose project's parent directory) mounted at /host.

Every cycle it:
1. asks Haber which release is approved for this component,
2. verifies the release against Flora Root's Ed25519 signature (Haber only chooses
   among releases Root signed; it cannot invent images),
3. waits for the safety gate (Leaf: no active case) and the maintenance window,
4. writes <compose dir>/.release/<project>.env with FLORA_IMAGE_<SERVICE>=<haber registry>/<repo>@<digest>
   and runs `docker compose up -d --no-build`, which recreates only the changed services,
5. rolls back to the previous env file when a service fails its health check,
6. reports its state to Haber.
"""
from __future__ import annotations

import base64
import datetime as dt
import json
import logging
import os
import subprocess
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any

from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey

log = logging.getLogger("flora-updater")
COMPONENT = os.environ["FLORA_COMPONENT"]                       # canopy | leaf | gateway
NODE_ID = os.environ["FLORA_NODE_ID"]
HABER_URL = os.getenv("HABER_URL", "http://host.docker.internal:7204").rstrip("/")
HABER_TOKEN = os.getenv("HABER_NODE_TOKEN", "")
INTERVAL = int(os.getenv("FLORA_UPDATER_INTERVAL_SEC", "30"))
HEALTH_TIMEOUT = int(os.getenv("FLORA_UPDATER_HEALTH_TIMEOUT_SEC", "180"))
# Optional safety gate: GET returns {"status": ...}; anything but ACTIVE lets the update through.
GATE_URL = os.getenv("FLORA_UPDATER_GATE_URL", "")
GATE_HEADER = os.getenv("FLORA_UPDATER_GATE_HEADER", "")          # "name: value"
WINDOW = os.getenv("FLORA_UPDATER_WINDOW", "")                    # "02:00-05:00" local time, empty = any time
PINNED_KEY = os.getenv("FLORA_ROOT_PUBLIC_KEY", "").strip()
HOST_ROOT = Path(os.getenv("FLORA_UPDATER_HOST_ROOT", "/host"))
STATE_DIR = Path(os.getenv("FLORA_UPDATER_STATE_DIR", "/state"))
LABEL = "com.docker.compose."


# ------------------------------------------------------------------ helpers

def canonical(value: Any) -> bytes:
    return json.dumps(value, sort_keys=True, separators=(",", ":")).encode()


def http_json(url: str, headers: dict[str, str] | None = None, body: Any = None, timeout: float = 10) -> Any:
    data = json.dumps(body).encode() if body is not None else None
    request = urllib.request.Request(url, data=data, method="POST" if data else "GET",
                                     headers={"content-type": "application/json", **(headers or {})})
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return json.load(response)


def haber(path: str, body: Any = None) -> Any:
    return http_json(f"{HABER_URL}{path}", {"authorization": f"Bearer {HABER_TOKEN}"}, body)


def sh(*args: str, check: bool = True) -> str:
    result = subprocess.run(args, text=True, capture_output=True)
    if check and result.returncode != 0:
        raise RuntimeError(f"{' '.join(args[:4])}… failed: {(result.stderr or result.stdout).strip()[-600:]}")
    return result.stdout


# ------------------------------------------------------------------ the compose project we belong to

class Project:
    """Discovered from the compose labels on our own container, so one image fits every tier."""

    def __init__(self) -> None:
        labels = json.loads(sh("docker", "inspect", "--format", "{{json .Config.Labels}}", os.environ["HOSTNAME"]))
        self.name = labels[LABEL + "project"]
        self.working_dir = labels[LABEL + "project.working_dir"]
        self.config_files = [f for f in labels.get(LABEL + "project.config_files", "").split(",") if f]
        self.env_files = [f for f in labels.get(LABEL + "project.environment_file", "").split(",") if f]
        self.self_service = labels[LABEL + "service"]
        # Compose resolves bind mounts to host paths, so the files must sit at their host path here too.
        host_parent = Path(self.working_dir).parent
        if not host_parent.exists():
            host_parent.parent.mkdir(parents=True, exist_ok=True)
            host_parent.symlink_to(HOST_ROOT)
        if not self.env_files and (Path(self.working_dir) / ".env").exists():
            self.env_files = [str(Path(self.working_dir) / ".env")]
        self.release_env = Path(self.working_dir) / ".release" / f"{self.name}.env"

    def compose(self, *args: str, release_env: bool = True, check: bool = True) -> str:
        command = ["docker", "compose", "-p", self.name, "--project-directory", self.working_dir]
        for file in self.config_files:
            command += ["-f", file]
        for file in self.env_files:
            command += ["--env-file", file]
        if release_env and self.release_env.exists():
            command += ["--env-file", str(self.release_env)]
        return sh(*command, *args, check=check)

    def services(self) -> list[str]:
        return [s for s in self.compose("config", "--services").split() if s != self.self_service]


# ------------------------------------------------------------------ release env file

def read_release_env(path: Path) -> tuple[str | None, dict[str, str]]:
    if not path.exists():
        return None, {}
    release_id, images = None, {}
    for line in path.read_text().splitlines():
        if line.startswith("# release_id="):
            release_id = line.split("=", 1)[1].strip()
        elif "=" in line and not line.startswith("#"):
            key, value = line.split("=", 1)
            images[key] = value
    return release_id, images


def write_release_env(path: Path, release_id: str, images: dict[str, str]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    lines = [f"# Written by flora-updater; approved in Haber, signed by Flora Root.",
             f"# release_id={release_id}", *(f"{key}={value}" for key, value in sorted(images.items()))]
    tmp = path.with_suffix(".tmp")
    tmp.write_text("\n".join(lines) + "\n")
    tmp.replace(path)


# ------------------------------------------------------------------ trust

def root_keys() -> dict[str, str]:
    if PINNED_KEY:
        return {"pinned": PINNED_KEY}
    cache = STATE_DIR / "root-keys.json"
    if cache.exists():
        return json.loads(cache.read_text())
    # Trust on first use (demo). Pin FLORA_ROOT_PUBLIC_KEY in production.
    keys = {item["key_id"]: item["public_key"] for item in haber("/api/haber/v1/root-keys")["keys"]}
    STATE_DIR.mkdir(parents=True, exist_ok=True)
    cache.write_text(json.dumps(keys))
    return keys


def verified_release(envelope: dict[str, Any], release_id: str) -> dict[str, Any]:
    keys = root_keys()
    public = keys.get(envelope.get("key_id", "")) or keys.get("pinned")
    if not public:
        raise ValueError(f"unknown Root signing key {envelope.get('key_id')}")
    try:
        Ed25519PublicKey.from_public_bytes(base64.b64decode(public)).verify(
            base64.b64decode(envelope["signature"]), canonical(envelope["bundle"]))
    except InvalidSignature:
        raise ValueError("release manifest signature is invalid") from None
    for release in envelope["bundle"]["releases"]:
        if release["release_id"] == release_id and release["component"] == COMPONENT:
            return release
    raise ValueError(f"{release_id} is not a signed {COMPONENT} release")


# ------------------------------------------------------------------ gates

def blocked() -> str | None:
    if WINDOW:
        start, end = (dt.time.fromisoformat(part) for part in WINDOW.split("-"))
        now = dt.datetime.now().time()
        inside = start <= now < end if start <= end else (now >= start or now < end)
        if not inside:
            return f"outside maintenance window {WINDOW}"
    if GATE_URL:
        headers = {}
        if ":" in GATE_HEADER:
            name, value = GATE_HEADER.split(":", 1)
            headers[name.strip()] = value.strip()
        try:
            status = http_json(GATE_URL, headers, timeout=5)
        except Exception as error:  # fail safe: never update a node we cannot ask
            return f"safety gate unreachable: {error}"
        if str(status.get("status", "")).upper() == "ACTIVE":
            return f"active case {status.get('hn') or status.get('case_id') or ''}".strip()
    return None


# ------------------------------------------------------------------ apply

def healthy(project: Project) -> tuple[bool, str]:
    started = time.time()
    while True:
        rows = [json.loads(line) for line in project.compose("ps", "-a", "--format", "json").splitlines() if line.strip()]
        rows = [row for row in rows if row.get("Service") != project.self_service]
        bad = sorted({row["Service"] for row in rows
                      if row.get("Health") == "unhealthy" or row.get("State") == "restarting"
                      or (row.get("State") == "exited" and row.get("ExitCode", 0) != 0)})
        starting = sorted({row["Service"] for row in rows if row.get("Health") == "starting"})
        waited = time.time() - started
        if not bad and not starting:
            return True, ""
        if bad and waited > 20:  # give a restarting service a moment before judging it
            return False, "unhealthy: " + ", ".join(bad)
        if waited > HEALTH_TIMEOUT:
            return False, "not healthy in time: " + ", ".join(bad + starting)
        time.sleep(5)


def apply(project: Project, release_id: str, images: dict[str, str]) -> None:
    previous = project.release_env.read_text() if project.release_env.exists() else None
    write_release_env(project.release_env, release_id, images)
    try:
        for image in images.values():  # pull everything from Haber before touching a running service
            sh("docker", "pull", "--quiet", image)
        project.compose("up", "-d", "--no-build", "--pull", "never", *project.services())
        ok, reason = healthy(project)
    except RuntimeError as error:
        ok, reason = False, str(error)
    if ok:
        return
    log.error("release %s failed (%s); rolling back", release_id, reason)
    if previous is None:
        project.release_env.unlink(missing_ok=True)
    else:
        project.release_env.write_text(previous)
    project.compose("up", "-d", "--no-build", *project.services(), check=False)
    raise RuntimeError(f"rolled back: {reason}")


def running_images(project: Project) -> dict[str, str]:
    rows = [json.loads(line) for line in project.compose("ps", "--format", "json", check=False).splitlines() if line.strip()]
    return {row["Service"]: row.get("Image", "") for row in rows}


def cycle(project: Project, failed: dict[str, str]) -> dict[str, Any]:
    desired = haber(f"/api/haber/v1/nodes/{NODE_ID}/desired?component={COMPONENT}")
    current_id, current_images = read_release_env(project.release_env)
    report: dict[str, Any] = {"component": COMPONENT, "project": project.name, "release_id": current_id}
    target = desired.get("release_id")
    if not target:
        return {**report, "state": "current" if current_id else "unmanaged", "detail": "no release approved in Haber"}
    release = verified_release(desired["envelope"], target)
    registry = desired["registry"]
    images = {f"FLORA_IMAGE_{key.upper()}": f"{registry}/{image['repository']}@{image['digest']}"
              for key, image in release["services"].items()}
    if current_id == target and current_images == images:
        return {**report, "state": "current", "detail": None}
    if failed.get(target):
        return {**report, "state": "failed", "target": target, "detail": failed[target]}
    reason = blocked()
    if reason:
        return {**report, "state": "waiting", "target": target, "detail": reason}
    haber(f"/api/haber/v1/nodes/{NODE_ID}/report", {**report, "state": "applying", "target": target, "detail": None})
    log.info("applying %s (was %s)", target, current_id)
    try:
        apply(project, target, images)
    except RuntimeError as error:
        failed[target] = str(error)  # do not retry the same release in a loop; a new approval resets it
        return {**report, "state": "failed", "target": target, "detail": str(error)}
    log.info("now on %s", target)
    return {**report, "release_id": target, "state": "current", "detail": None}


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    project = Project()
    log.info("managing %s (%s) as %s/%s via %s", project.name, project.working_dir, COMPONENT, NODE_ID, HABER_URL)
    failed: dict[str, str] = {}
    approved_seen = None
    while True:
        try:
            report = cycle(project, failed)
            if report.get("target") != approved_seen:  # a new approval gets a fresh attempt
                approved_seen = report.get("target")
                failed = {k: v for k, v in failed.items() if k == approved_seen}
            report["images"] = running_images(project)
            haber(f"/api/haber/v1/nodes/{NODE_ID}/report", report)
        except (urllib.error.URLError, TimeoutError) as error:
            log.warning("haber unreachable: %s", error)  # keep running what we have
        except Exception as error:
            log.exception("update cycle failed")
            try:
                haber(f"/api/haber/v1/nodes/{NODE_ID}/report",
                      {"component": COMPONENT, "project": project.name, "state": "error", "detail": str(error)})
            except Exception:
                pass
        time.sleep(INTERVAL)


if __name__ == "__main__":
    main()
