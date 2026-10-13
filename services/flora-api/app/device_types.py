"""The hospital's own gateway device types (Canopy → Devices → Device types).

Flora Root releases deliver the standard catalog; a hospital adds types for devices the
catalog lacks (another model on an existing protocol, other connection defaults…). Haber adds
the enabled ones to every gateway's check-in with origin "canopy" and the release's parser
image, so `parser` must be one that image contains.

Connection defaults follow the gateway's own rules (flora-gateway gateway-service
app/connection.py, from rust/crates/gateway-core/src/config.rs): unknown keys are refused.
"""
from __future__ import annotations

import re
from typing import Any, Literal

from psycopg import Connection
from pydantic import BaseModel, ConfigDict, Field, ValidationError

CODE = re.compile(r"^[a-z0-9][a-z0-9_.-]{0,63}$")
CONTROLLERS = ("serial", "socket", "feeder", "webhook")


class _Strict(BaseModel):
    model_config = ConfigDict(extra="forbid")


class SerialDefaults(_Strict):
    baud: Literal[300, 600, 1200, 2400, 4800, 9600, 14400, 19200, 38400, 57600, 115200, 230400] | None = None
    data_bits: Literal[5, 6, 7, 8] | None = None
    parity: Literal["none", "even", "odd"] | None = None
    stop_bits: Literal[1, 2] | None = None
    flow_control: Literal["none", "hardware", "software"] | None = None
    rts: bool | None = None
    dtr: bool | None = None
    idle_ms: int | None = Field(default=None, ge=1, le=60000)
    max_frame_bytes: int | None = Field(default=None, ge=64, le=1048576)


class SocketDefaults(_Strict):
    transport: Literal["tcp", "udp"] | None = None
    framing: Literal["mllp", "line", "idle", "raw", "udp_relay"] | None = None
    auto_ack: bool | None = None
    idle_ms: int | None = Field(default=None, ge=1, le=60000)
    connect_timeout_ms: int | None = Field(default=None, ge=100, le=600000)
    read_timeout_ms: int | None = Field(default=None, ge=0, le=3600000)
    reconnect_ms: int | None = Field(default=None, ge=100, le=600000)
    max_frame_bytes: int | None = Field(default=None, ge=64, le=1048576)


class FeederDefaults(_Strict):
    interval_ms: int | None = Field(default=None, ge=100, le=3600000)
    timeout_ms: int | None = Field(default=None, ge=100, le=600000)


class WebhookDefaults(_Strict):
    max_body_bytes: int | None = Field(default=None, ge=64, le=16777216)


MODELS: dict[str, type[_Strict]] = {"serial": SerialDefaults, "socket": SocketDefaults,
                                    "feeder": FeederDefaults, "webhook": WebhookDefaults}


def clean_connection_defaults(controller: str, values: dict[str, Any]) -> dict[str, Any]:
    """The defaults with unset fields dropped; ValueError with a readable message otherwise."""
    model = MODELS.get(controller)
    if model is None:
        raise ValueError(f"unknown controller {controller}")
    try:
        return model(**(values or {})).model_dump(exclude_none=True)
    except ValidationError as error:
        problems = "; ".join(f"{'.'.join(str(p) for p in e['loc']) or 'value'}: {e['msg']}" for e in error.errors())
        raise ValueError(f"connection defaults for {controller}: {problems}") from None


def manufacturer_code(name: str | None) -> str | None:
    """Gateways key manufacturers by a short code; derive one from the name."""
    if not name:
        return None
    return re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")[:40] or None


def list_types(database: Connection) -> list[dict[str, Any]]:
    return database.execute("SELECT * FROM canopy_device_type ORDER BY label, code").fetchall()


def for_gateways(database: Connection) -> list[dict[str, Any]]:
    """Enabled hospital types in the catalog shape Haber hands to gateways (image added by Haber)."""
    return [{
        "code": row["code"], "label": row["label"], "category": row["category"], "protocol": row["protocol"],
        "controller": row["controller"], "parser": row["parser"], "default_options": row["default_options"] or {},
        "connection_defaults": row["connection_defaults"] or {},
        "manufacturer": manufacturer_code(row["manufacturer"]), "manufacturer_name": row["manufacturer"],
        "model": row["model"], "description": row["description"], "version": str(row["updated_at"]),
        "origin": "canopy",
    } for row in database.execute("SELECT * FROM canopy_device_type WHERE enabled ORDER BY code").fetchall()]
