#!/usr/bin/env python3
"""Root CI: build a component's images, push them to the Root registry, publish the release.

    flora-root/scripts/publish_release.py gateway 0.2.0 --notes "MEDIBUS fixes"
    flora-root/scripts/publish_release.py leaf 1.3.0 --channel beta

Images are pushed as <registry>/flora/<component>/<service>:<version>; the release
pins each one by digest, so what a hospital runs is exactly what CI built.
"""
from __future__ import annotations

import argparse
import base64
import json
import os
import subprocess
import sys
import urllib.error
import urllib.request
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]

# Release service key -> compose service that builds it. Keys become FLORA_IMAGE_<KEY>
# in that component's compose file.
COMPONENTS = {
    "leaf": {"compose": "flora-leaf/compose.yaml", "services": {"api": "leaf-api", "sync": "leaf-sync"}},
    "canopy": {"compose": "flora-canopy/compose.yaml", "services": {"api": "canopy-api", "haber": "haber"}},
    "gateway": {
        "compose": "flora-gateway/compose.yaml",
        "services": {"rust": "serial-controller", "service": "gateway-service", "parser": "parser-image"},
        "device_types": "flora-gateway/device-types.json",
    },
}


def run(*args: str, capture: bool = False) -> str:
    print("+", " ".join(args), file=sys.stderr)
    # Build the default (dev) image names, never a previously applied release.
    env = {key: value for key, value in os.environ.items() if not key.startswith("FLORA_IMAGE_")}
    result = subprocess.run(args, cwd=REPO, env=env, check=True, text=True,
                            stdout=subprocess.PIPE if capture else None)
    return result.stdout if capture else ""


def compose_images(compose: str) -> dict[str, str]:
    config = json.loads(run("docker", "compose", "-f", compose, "config", "--format", "json", capture=True))
    return {name: service.get("image", "") for name, service in config["services"].items()}


def pushed_digest(image: str, repository: str) -> str:
    digests = json.loads(run("docker", "image", "inspect", "--format", "{{json .RepoDigests}}", image, capture=True))
    for entry in digests:
        name, _, digest = entry.partition("@")
        if name == repository:
            return digest
    raise SystemExit(f"no digest for {repository} after push")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("component", choices=sorted(COMPONENTS))
    parser.add_argument("version")
    parser.add_argument("--channel", default="stable")
    parser.add_argument("--notes")
    parser.add_argument("--no-build", action="store_true", help="push the images already built locally")
    parser.add_argument("--registry", default=os.getenv("ROOT_REGISTRY_PUSH", "localhost:7105"),
                        help="registry host CI pushes to (default localhost:7105)")
    parser.add_argument("--root-url", default=os.getenv("FLORA_ROOT_URL", "http://localhost:7100"))
    args = parser.parse_args()

    spec = COMPONENTS[args.component]
    if not args.no_build:
        run("docker", "compose", "-f", spec["compose"], "build", *spec["services"].values())
    images = compose_images(spec["compose"])

    services = {}
    for key, compose_service in spec["services"].items():
        local = images[compose_service]
        repository = f"flora/{args.component}/{key}"
        remote = f"{args.registry}/{repository}"
        run("docker", "tag", local, f"{remote}:{args.version}")
        run("docker", "push", f"{remote}:{args.version}")
        services[key] = {"repository": repository, "digest": pushed_digest(f"{remote}:{args.version}", remote),
                         "tag": args.version}

    release = {"component": args.component, "version": args.version, "channel": args.channel,
               "services": services, "notes": args.notes}
    if spec.get("device_types"):
        release["device_types"] = json.loads((REPO / spec["device_types"]).read_text())

    user = os.getenv("ROOT_ADMIN_USERNAME", "admin")
    password = os.getenv("ROOT_ADMIN_PASSWORD", "admin")
    request = urllib.request.Request(
        f"{args.root_url.rstrip('/')}/api/v1/releases", data=json.dumps(release).encode(), method="POST",
        headers={"content-type": "application/json", "x-root-key": os.getenv("ROOT_ADMIN_KEY", ""),
                 "authorization": "Basic " + base64.b64encode(f"{user}:{password}".encode()).decode()})
    try:
        with urllib.request.urlopen(request, timeout=15) as response:
            print(json.dumps({**json.load(response), "services": services}, indent=2))
    except urllib.error.HTTPError as error:
        raise SystemExit(f"Root rejected the release: {error.code} {error.read().decode()}") from None


if __name__ == "__main__":
    main()
