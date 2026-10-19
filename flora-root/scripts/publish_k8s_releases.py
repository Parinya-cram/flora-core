#!/usr/bin/env python3
"""Publish the k8s-built component images as real Root releases.

The k8s pilot builds images straight into containerd (deploy-k8s, nerdctl) and
never pushes them to a registry, so root-registry is empty and Haber's mirror
404s. This pushes the current canopy/leaf images into root-registry (hostPort
7105) and registers a release per component with the pushed digests, so the
mirror -> approve -> node-pull chain works. Run by CI (needs sudo nerdctl).

    sudo python3 flora-root/scripts/publish_k8s_releases.py <TAG>

Gateway images live on the gateway box, not in k8s, so the gateway release is
published from there with flora-root/scripts/publish_release.py instead.
"""
from __future__ import annotations

import base64
import json
import os
import ssl
import subprocess
import sys
import urllib.request

TAG = (sys.argv[1] if len(sys.argv) > 1 else os.getenv("TAG", "")).strip()
if not TAG:
    raise SystemExit("usage: publish_k8s_releases.py <TAG>")

REGISTRY = os.getenv("ROOT_REGISTRY_PUSH", "172.22.19.81:7105")          # root-registry hostPort (http)
ROOT_URL = os.getenv("FLORA_ROOT_PUBLISH_URL", "https://172.22.19.81:8443")  # Root edge
VERSION = os.getenv("RELEASE_VERSION", f"k8s-{TAG}")
CHANNEL = os.getenv("RELEASE_CHANNEL", "stable")
USER = os.getenv("ROOT_ADMIN_USERNAME", "admin")
PASSWORD = os.getenv("ROOT_ADMIN_PASSWORD", "admin")

# component -> {release service key: containerd image built by deploy-k8s}
PUBLISH = {
    "canopy": {"api": f"flora-canopy-canopy-api:{TAG}", "haber": f"flora-canopy-haber:{TAG}"},
    "leaf": {"api": f"flora-canopy-canopy-api:{TAG}", "sync": f"flora-leaf-sync-worker:{TAG}"},
}
DEVICE_TYPES_FILE = os.path.join(os.path.dirname(__file__), "..", "..", "flora-gateway", "device-types.json")

_MANIFEST_ACCEPT = ", ".join([
    "application/vnd.oci.image.index.v1+json",
    "application/vnd.docker.distribution.manifest.list.v2+json",
    "application/vnd.oci.image.manifest.v1+json",
    "application/vnd.docker.distribution.manifest.v2+json",
])


def sh(*args: str) -> None:
    print("+", " ".join(args), file=sys.stderr)
    subprocess.run(args, check=True)


def pushed_digest(repo: str, tag: str) -> str:
    req = urllib.request.Request(f"http://{REGISTRY}/v2/{repo}/manifests/{tag}", method="HEAD",
                                 headers={"Accept": _MANIFEST_ACCEPT})
    with urllib.request.urlopen(req, timeout=20) as response:
        digest = response.headers.get("Docker-Content-Digest")
    if not digest:
        raise SystemExit(f"no Docker-Content-Digest for {repo}:{tag}")
    return digest


def post_release(release: dict) -> None:
    data = json.dumps(release).encode()
    req = urllib.request.Request(f"{ROOT_URL.rstrip('/')}/api/v1/releases", data=data, method="POST",
                                 headers={"content-type": "application/json",
                                          "authorization": "Basic " + base64.b64encode(f"{USER}:{PASSWORD}".encode()).decode()})
    ctx = ssl.create_default_context()
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE
    try:
        with urllib.request.urlopen(req, timeout=20, context=ctx) as response:
            print("published", release["component"], release["version"], "->", json.load(response).get("release_id"))
    except urllib.error.HTTPError as error:
        raise SystemExit(f"Root rejected {release['component']} {release['version']}: {error.code} {error.read().decode()}")


def main() -> None:
    device_types = []
    try:
        device_types = json.loads(open(DEVICE_TYPES_FILE).read())
    except OSError:
        pass
    for component, services in PUBLISH.items():
        pinned = {}
        for key, image in services.items():
            repo = f"flora/{component}/{key}"
            remote = f"{REGISTRY}/{repo}:{VERSION}"
            sh("sudo", "nerdctl", "-n", "k8s.io", "tag", image, remote)
            sh("sudo", "nerdctl", "-n", "k8s.io", "push", "--insecure-registry", remote)
            pinned[key] = {"repository": repo, "digest": pushed_digest(repo, VERSION), "tag": VERSION}
        release = {"component": component, "version": VERSION, "channel": CHANNEL,
                   "services": pinned, "notes": f"k8s build {TAG}"}
        if component == "gateway":
            release["device_types"] = device_types
        post_release(release)


if __name__ == "__main__":
    main()
