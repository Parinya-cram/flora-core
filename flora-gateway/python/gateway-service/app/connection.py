"""Default connection settings a device type carries for its controller.

Field names and allowed values follow the pod structs in
rust/crates/gateway-core/src/config.rs. Per-device addressing (serial path,
port, remote host, URL) is not a type default and is rejected here.
"""
from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, ValidationError


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
    framing: Literal["mllp", "line", "idle", "raw"] | None = None
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


def validate(controller: str, values: dict[str, Any]) -> dict[str, Any]:
    """Returns the cleaned defaults (unset fields dropped) or raises ValueError with a readable message."""
    model = MODELS.get(controller)
    if model is None:
        raise ValueError(f"unknown controller {controller}")
    try:
        return model(**(values or {})).model_dump(exclude_none=True)
    except ValidationError as error:
        problems = "; ".join(f"{'.'.join(str(p) for p in e['loc']) or 'value'}: {e['msg']}" for e in error.errors())
        raise ValueError(f"connection defaults for {controller}: {problems}") from None
