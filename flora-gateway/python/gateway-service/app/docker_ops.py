"""Starts one device-medical-service container per device instance (or one per pod for
device types flagged `demux`) and restarts gateway controllers. Needs the Docker socket
mounted into the container.
On a native Windows gateway (FLORA_GATEWAY_RUNTIME=native, no Docker) the same functions come from process_ops."""
import json
import os
import re
from typing import Any

NATIVE = os.getenv("FLORA_GATEWAY_RUNTIME", "docker") == "native"
if not NATIVE:
    import docker
    from docker.errors import DockerException, ImageNotFound, NotFound

from . import settings

_client = None


def client():
    global _client
    if _client is None:
        _client = docker.from_env()
    return _client


def parser_name(device_id: str) -> str:
    return "flora-gw-parser-" + re.sub(r"[^a-zA-Z0-9_.-]", "-", device_id)


def pod_parser_name(pod: str) -> str:
    return "flora-gw-parser-pod-" + re.sub(r"[^a-zA-Z0-9_.-]", "-", pod)


def ensure_image(image: str) -> None:
    try:
        client().images.get(image)
    except ImageNotFound:  # pull (from Haber) before the running parser is stopped
        client().images.pull(image)


def start_parser(instance: dict[str, Any], device_type: dict[str, Any]) -> str:
    options = {**(device_type.get("default_options") or {}), **(instance.get("options") or {})}
    name = parser_name(instance["device_id"])
    ensure_image(device_type["image"])
    stop_parser(instance["device_id"])
    container = client().containers.run(
        device_type["image"],
        name=name,
        detach=True,
        network=settings.DOCKER_NETWORK,
        restart_policy={"Name": "unless-stopped"},
        environment={
            "FLORA_KAFKA_BROKERS": settings.KAFKA_BROKERS,
            "DEVICE_ID": instance["device_id"],
            "POD": instance["pod"],
            "PARSER": device_type["parser"],
            "PARSER_OPTIONS": json.dumps(options),
        },
        labels={
            "flora.gateway.role": "parser",
            "flora.gateway.id": settings.GATEWAY_ID,
            "flora.gateway.device_id": instance["device_id"],
            "com.docker.compose.project": settings.COMPOSE_PROJECT,
        },
    )
    return container.id


def start_pod_parser(pod: str, image: str, device_map: list[dict[str, Any]], config_hash: str) -> str:
    """One container parses every instance on `pod` (POD_DEMUX mode), routing frames by source_ip.
    `config_hash` (label) tells reconcile when the pod's instances or options changed."""
    ensure_image(image)
    stop_pod_parser(pod)
    container = client().containers.run(
        image,
        name=pod_parser_name(pod),
        detach=True,
        network=settings.DOCKER_NETWORK,
        restart_policy={"Name": "unless-stopped"},
        environment={
            "FLORA_KAFKA_BROKERS": settings.KAFKA_BROKERS,
            "POD_DEMUX": "1",
            "POD": pod,
            "DEVICE_MAP": json.dumps(device_map),
        },
        labels={
            "flora.gateway.role": "parser-pod",
            "flora.gateway.id": settings.GATEWAY_ID,
            "flora.gateway.pod": pod,
            "flora.gateway.device_ids": ",".join(item["device_id"] for item in device_map),
            "flora.gateway.config_hash": config_hash,
            "com.docker.compose.project": settings.COMPOSE_PROJECT,
        },
    )
    return container.id


def stop_pod_parser(pod: str) -> None:
    try:
        container = client().containers.get(pod_parser_name(pod))
    except NotFound:
        return
    container.remove(force=True)


def stop_parser(device_id: str) -> None:
    try:
        container = client().containers.get(parser_name(device_id))
    except NotFound:
        return
    container.remove(force=True)


def _parser_containers() -> list:
    return client().containers.list(all=True, filters={"label": f"flora.gateway.id={settings.GATEWAY_ID}"})


def image_tags(container) -> list[str]:
    """Tags of the image a container was created from; none when that image was since rebuilt or removed."""
    try:
        return container.image.tags[:1]
    except (ImageNotFound, NotFound):
        return []


def _state(container) -> dict[str, Any]:
    return {"container": container.name, "status": container.status, "image": image_tags(container),
            "image_ref": container.attrs["Config"]["Image"]}


def parser_states() -> dict[str, dict[str, Any]]:
    """By device_id. A device parsed by a pod container reports that container, with `pod` set."""
    try:
        containers = _parser_containers()
    except DockerException as error:
        return {"_error": {"status": str(error)}}
    states: dict[str, dict[str, Any]] = {}
    for container in containers:
        if container.labels.get("flora.gateway.role") == "parser-pod":
            pod = container.labels.get("flora.gateway.pod")
            for device_id in filter(None, container.labels.get("flora.gateway.device_ids", "").split(",")):
                states.setdefault(device_id, {**_state(container), "pod": pod})
        else:
            # A per-device container wins, so reconcile can see (and stop) one left from before demux.
            states[container.labels.get("flora.gateway.device_id", container.name)] = _state(container)
    return states


def pod_parser_states() -> dict[str, dict[str, Any]]:
    try:
        containers = client().containers.list(all=True, filters={"label": [
            f"flora.gateway.id={settings.GATEWAY_ID}", "flora.gateway.role=parser-pod"]})
    except DockerException:
        return {}
    return {container.labels.get("flora.gateway.pod"): {
                **_state(container), "config_hash": container.labels.get("flora.gateway.config_hash"),
                "device_ids": [d for d in container.labels.get("flora.gateway.device_ids", "").split(",") if d]}
            for container in containers}


def service_containers(service: str) -> list:
    containers = client().containers.list(all=True, filters={"label": [
        f"com.docker.compose.project={settings.COMPOSE_PROJECT}", f"com.docker.compose.service={service}"]})
    if not containers:
        raise LookupError(f"no container for service {service}")
    return containers


def restart_service(service: str) -> str:
    containers = service_containers(service)
    for container in containers:
        container.restart(timeout=10)
    return containers[0].name


def stop_service(service: str) -> str:
    """Stopped containers stay down across Docker restarts (unless-stopped) until started again."""
    containers = service_containers(service)
    for container in containers:
        container.stop(timeout=10)
    return containers[0].name


def start_service(service: str) -> str:
    containers = service_containers(service)
    for container in containers:
        container.start()
    return containers[0].name


def service_wiring(service: str) -> dict[str, Any]:
    """Host side of a compose service: published ports (container port/proto -> host ports) and mapped devices."""
    try:
        containers = client().containers.list(all=True, filters={"label": [
            f"com.docker.compose.project={settings.COMPOSE_PROJECT}", f"com.docker.compose.service={service}"]})
    except DockerException:
        return {"ports": {}, "devices": {}}
    if not containers:
        return {"ports": {}, "devices": {}}
    attrs = containers[0].attrs
    ports = {key: sorted({binding["HostPort"] for binding in bindings or []})
             for key, bindings in (attrs.get("NetworkSettings", {}).get("Ports") or {}).items()}
    devices = {d["PathInContainer"]: d["PathOnHost"] for d in attrs.get("HostConfig", {}).get("Devices") or []}
    return {"ports": ports, "devices": devices}


def service_states() -> dict[str, str]:
    try:
        containers = client().containers.list(all=True, filters={"label": f"com.docker.compose.project={settings.COMPOSE_PROJECT}"})
    except DockerException:
        return {}
    return {c.labels.get("com.docker.compose.service", c.name): c.status for c in containers}


__all__ = ["start_parser", "stop_parser", "parser_states", "start_pod_parser", "stop_pod_parser", "pod_parser_states",
           "pod_parser_name", "restart_service", "stop_service", "start_service",
           "service_states", "service_wiring", "ImageNotFound", "DockerException"]

if NATIVE:   # the same names, run as processes (replaces every definition above)
    from .process_ops import *  # noqa: E402,F401,F403
