#!/usr/bin/env python3
"""Build the Windows runtime the Flora iCIS installer carries, on Linux (CI), with no Windows machine:

    runtime/python/      embeddable CPython 3.13 for Windows + every library as win_amd64 wheels (site-packages)
    runtime/apps/        Flora's Python services as bytecode only (.pyc, no source) + their data files
    runtime/pgsql/       PostgreSQL 17 for Windows (bin, lib, share only)
    runtime/db/          the database init scripts in Dockerfile.postgres.dev order
    runtime/ocr/         the Thai OCR models (checked by SHA256)
    runtime/web/<tier>/  the built Leaf and Canopy screens (copied in by build-installer.sh)
    runtime/java, runtime/kafka   (gateway) Temurin JRE 21 and Kafka 3.9.1 for the gateway's broker

Run in python:3.13 (CI: nerdctl run). Downloads are cached in /cache between builds.
    python3 scripts/windows/build_runtime.py <repo> <out>/runtime
"""
from __future__ import annotations

import compileall
import hashlib
import re
import shutil
import subprocess
import sys
import tarfile
import urllib.request
import zipfile
from pathlib import Path

PYTHON = "3.13.7"
DOWNLOADS = {
    "python.zip": f"https://www.python.org/ftp/python/{PYTHON}/python-{PYTHON}-embed-amd64.zip",
    "pgsql.zip": "https://get.enterprisedb.com/postgresql/postgresql-17.6-1-windows-x64-binaries.zip",
    "jre.zip": "https://api.adoptium.net/v3/binary/latest/21/ga/windows/x64/jre/hotspot/normal/eclipse",
    # Same Kafka as the Linux gateway (apache/kafka:3.9.1); only the Apache archive still keeps 3.9.x (slow, cached).
    "kafka.tgz": "https://archive.apache.org/dist/kafka/3.9.1/kafka_2.13-3.9.1.tgz",
}
FALLBACKS: dict[str, str] = {}
# Windows has no uvloop; uvicorn[standard] minus it. Same pins as the services' requirements.txt.
WINDOWS_EXTRAS = ["uvicorn==0.35.0", "httptools", "websockets", "python-dotenv", "pyyaml", "colorama", "watchfiles"]
CACHE = Path("/cache")


def fetch(name: str) -> Path:
    CACHE.mkdir(parents=True, exist_ok=True)
    target = CACHE / name
    if not target.exists():
        print(f"download {DOWNLOADS[name]}", flush=True)
        tmp = target.with_suffix(".part")
        for url in (DOWNLOADS[name], FALLBACKS.get(name)):
            if not url:
                continue
            try:
                request = urllib.request.Request(url, headers={"User-Agent": "flora-icis-build/1.0 (curl compatible)"})
                with urllib.request.urlopen(request, timeout=600) as response, open(tmp, "wb") as out:  # noqa: S310
                    shutil.copyfileobj(response, out)
                break
            except OSError as error:
                print(f"  {url} failed: {error}", flush=True)
        else:
            raise SystemExit(f"cannot download {name}")
        tmp.replace(target)
    return target


def requirements(repo: Path) -> list[str]:
    lines: list[str] = []
    for path in ("services/flora-api/requirements.txt", "services/flora-sync-worker/requirements.txt",
                 "flora-canopy/haber/requirements.txt", "flora-gateway/python/gateway-service/requirements.txt",
                 "flora-gateway/python/device-medical-service/requirements.txt"):
        for line in (repo / path).read_text().splitlines():
            line = line.strip()
            if not line or line.startswith("#") or line.startswith("uvicorn") or line.startswith("docker=="):
                continue
            lines.append(line)
    # One version per package (the API's pins win: it is listed first).
    seen: dict[str, str] = {}
    for line in lines:
        name = re.split(r"[\[=<>~ ]", line, 1)[0].lower()
        seen.setdefault(name, line)
    return list(seen.values()) + WINDOWS_EXTRAS


def python_runtime(repo: Path, out: Path) -> None:
    target = out / "python"
    with zipfile.ZipFile(fetch("python.zip")) as archive:
        archive.extractall(target)
    site = target / "Lib" / "site-packages"
    req = out.parent / "win-requirements.txt"
    req.write_text("\n".join(requirements(repo)) + "\n")
    subprocess.run([sys.executable, "-m", "pip", "install", "--quiet", "--no-compile", "--only-binary=:all:",
                    "--platform", "win_amd64", "--python-version", "3.13", "--implementation", "cp",
                    "--target", str(site), "-r", str(req)], check=True)
    # The embeddable distribution ignores PYTHONPATH and site-packages unless its ._pth file says so.
    pth = next(target.glob("python3*._pth"))
    pth.write_text(f"python313.zip\n.\nLib\\site-packages\n..\\apps\nimport site\n")
    compileall.compile_dir(str(site), quiet=1, legacy=False, workers=0)


def bytecode(src: Path, dst: Path) -> None:
    """Copy a service as .pyc only (sources removed) plus its data files."""
    shutil.copytree(src, dst, ignore=shutil.ignore_patterns("__pycache__", "tests", "*.pyc", ".pytest_cache"))
    compileall.compile_dir(str(dst), quiet=1, legacy=True, workers=0)
    for py in dst.rglob("*.py"):
        py.unlink()


def apps(repo: Path, out: Path) -> None:
    apps = out / "apps"
    bytecode(repo / "services/flora-api/app", apps / "flora_api" / "app")
    (apps / "flora_sync_worker").mkdir(parents=True)
    shutil.copy(repo / "services/flora-sync-worker/sync_worker.py", apps / "flora_sync_worker" / "sync_worker.py")
    compileall.compile_dir(str(apps / "flora_sync_worker"), quiet=1, legacy=True)
    (apps / "flora_sync_worker" / "sync_worker.py").unlink()
    bytecode(repo / "flora-canopy/haber/app", apps / "haber" / "app")
    bytecode(repo / "flora-gateway/python/gateway-service/app", apps / "gateway_service" / "app")
    bytecode(repo / "flora-gateway/python/device-medical-service/device_medical_service",
             apps / "device_medical" / "device_medical_service")


def postgres(out: Path) -> None:
    keep = ("pgsql/bin/", "pgsql/lib/", "pgsql/share/")
    skip = ("pgAdmin", "/doc/", "/include/", "/symbols/", "/StackBuilder")
    with zipfile.ZipFile(fetch("pgsql.zip")) as archive:
        for member in archive.namelist():
            if member.startswith(keep) and not any(s in member for s in skip):
                archive.extract(member, out)


def db_scripts(repo: Path, out: Path) -> None:
    target = out / "db"
    target.mkdir(parents=True)
    order = []
    for line in (repo / "Dockerfile.postgres.dev").read_text().splitlines():
        match = re.match(r"COPY (\S+\.sql) /docker-entrypoint-initdb\.d/(\S+\.sql)", line.strip())
        if match:
            shutil.copy(repo / match.group(1), target / match.group(2))
            order.append(match.group(2))
    (target / "order.txt").write_text("\n".join(order) + "\n")


def ocr(repo: Path, out: Path) -> None:
    subprocess.run([sys.executable, str(repo / "services/flora-api/scripts/fetch_ocr_models.py"), str(out / "ocr")], check=True)


def gateway_broker(out: Path) -> None:
    with zipfile.ZipFile(fetch("jre.zip")) as archive:
        archive.extractall(out / "java-tmp")
    shutil.move(str(next((out / "java-tmp").iterdir())), out / "java")
    shutil.rmtree(out / "java-tmp")
    with tarfile.open(fetch("kafka.tgz")) as archive:
        archive.extractall(out / "kafka-tmp", filter="data")
    kafka = next((out / "kafka-tmp").iterdir())
    (out / "kafka").mkdir()
    for part in ("libs", "config", "bin"):
        shutil.copytree(kafka / part, out / "kafka" / part)
    shutil.rmtree(out / "kafka-tmp")


def main() -> None:
    repo, out = Path(sys.argv[1]).resolve(), Path(sys.argv[2]).resolve()
    if out.exists():
        shutil.rmtree(out)
    out.mkdir(parents=True)
    for step in (python_runtime, apps, db_scripts, ocr):
        print(f"== {step.__name__}", flush=True)
        step(repo, out)
    print("== postgres", flush=True); postgres(out)
    print("== gateway broker (java + kafka)", flush=True); gateway_broker(out)
    size = sum(f.stat().st_size for f in out.rglob("*") if f.is_file())
    print(f"runtime ready: {size // (1024 * 1024)} MB", flush=True)


if __name__ == "__main__":
    main()
