"""Starts one device-medical-service container per device instance and restarts
gateway controllers. Needs the Docker socket mounted into the container."""
import json
import re
from typing import Any

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


def start_parser(instance: dict[str, Any], device_type: dict[str, Any]) -> str:
    options = {**(device_type.get("default_options") or {}), **(instance.get("options") or {})}
    name = parser_name(instance["device_id"])
    try:
        client().images.get(device_type["image"])
    except ImageNotFound:  # pull (from Haber) before the running parser is stopped
        client().images.pull(device_type["image"])
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


def stop_parser(device_id: str) -> None:
    try:
        container = client().containers.get(parser_name(device_id))
    except NotFound:
        return
    container.remove(force=True)


def parser_states() -> dict[str, dict[str, Any]]:
    try:
        containers = client().containers.list(all=True, filters={"label": f"flora.gateway.id={settings.GATEWAY_ID}"})
    except DockerException as error:
        return {"_error": {"status": str(error)}}
    return {
        container.labels.get("flora.gateway.device_id", container.name): {
            "container": container.name, "status": container.status, "image": container.image.tags[:1],
            "image_ref": container.attrs["Config"]["Image"],
        }
        for container in containers
    }


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


def service_states() -> dict[str, str]:
    try:
        containers = client().containers.list(all=True, filters={"label": f"com.docker.compose.project={settings.COMPOSE_PROJECT}"})
    except DockerException:
        return {}
    return {c.labels.get("com.docker.compose.service", c.name): c.status for c in containers}


__all__ = ["start_parser", "stop_parser", "parser_states", "restart_service", "stop_service", "start_service",
           "service_states", "ImageNotFound", "DockerException"]
