"""Synthetic bedside devices for the Flora demo. Every value is fictional.

Each device uses a different gateway ingress path:
  or-monitor        HL7 v2 ORU over MLLP  → socket-controller pod 9001
  icu-monitor       HL7 v2 ORU over MLLP  → socket-controller pod 9002
  or-anesthesia     JSON POST             → webhook-controller pod 9003
  icu-ventilator    JSON served here, polled by feeder-controller
  or-temp-module    RS-232 KEY=VALUE, answers only when polled ("?\\r\\n")
  or-t200           RS-232 Acme T-200 ($T200,…*CS), answers each "R\\r" poll (virtual COM2)
It also receives the publisher's pushed batches at POST /receiver.
"""
from __future__ import annotations

import asyncio
import logging
import math
import os
import time
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from typing import Any

import httpx
from fastapi import FastAPI, Request
from fastapi.responses import HTMLResponse

log = logging.getLogger("simulator")
SOCKET_HOST = os.getenv("SIM_SOCKET_HOST", "socket-controller")
WEBHOOK_URL = os.getenv("SIM_WEBHOOK_URL", "http://webhook-controller:9003/anesthesia")
SERIAL_HOST = os.getenv("SIM_SERIAL_HOST", "serial-controller")
SERIAL_PORT = int(os.getenv("SIM_SERIAL_PORT", "7430"))
T200_PORT = int(os.getenv("SIM_T200_PORT", "7431"))
INTERVAL = float(os.getenv("SIM_INTERVAL_SEC", "5"))

STATS: dict[str, dict[str, Any]] = {}
RECEIVER: dict[str, Any] = {"batches": 0, "observations": 0, "last": []}


def wave(period_min: float, amplitude: float, phase: float = 0.0) -> float:
    minutes = time.time() / 60
    return amplitude * math.sin(2 * math.pi * minutes / period_min + phase)


def bump(device: str, ok: bool, detail: str = "") -> None:
    stat = STATS.setdefault(device, {"sent": 0, "errors": 0, "last_ok": None, "last_error": None})
    if ok:
        stat["sent"] += 1
        stat["last_ok"] = int(time.time() * 1000)
    else:
        stat["errors"] += 1
        stat["last_error"] = detail


# ------------------------------------------------------------------ HL7 monitors

PROFILES = {
    "or-monitor": {"base": {"hr": 72, "spo2": 99, "nibp": (118, 72), "art": (122, 70), "rr": 12, "temp": 36.4, "etco2": 36}, "phase": 0.0},
    "icu-monitor": {"base": {"hr": 96, "spo2": 94, "nibp": (104, 62), "art": (108, 60), "rr": 22, "temp": 37.8, "etco2": 41}, "phase": 1.7},
}


def oru_message(device: str, control_id: int) -> str:
    profile = PROFILES[device]
    base, phase = profile["base"], profile["phase"]
    stamp = datetime.now(timezone.utc).strftime("%Y%m%d%H%M%S+0000")
    sys_, dia = base["art"]
    nsys, ndia = base["nibp"]
    art_sys = round(sys_ + wave(11, 8, phase))
    art_dia = round(dia + wave(13, 5, phase))
    nibp_sys = round(nsys + wave(17, 6, phase))
    nibp_dia = round(ndia + wave(19, 4, phase))
    values = [
        ("147842", "MDC_ECG_HEART_RATE", round(base["hr"] + wave(7, 6, phase)), "264864", "/min"),
        ("149530", "MDC_PULS_OXIM_PULS_RATE", round(base["hr"] + wave(7, 6, phase) + 1), "264864", "/min"),
        ("150456", "MDC_PULS_OXIM_SAT_O2", min(100, round(base["spo2"] + wave(23, 1.2, phase))), "262688", "%"),
        ("150033", "MDC_PRESS_BLD_ART_SYS", art_sys, "266016", "mm[Hg]"),
        ("150034", "MDC_PRESS_BLD_ART_DIA", art_dia, "266016", "mm[Hg]"),
        ("150035", "MDC_PRESS_BLD_ART_MEAN", round((art_sys + 2 * art_dia) / 3), "266016", "mm[Hg]"),
        ("150301", "MDC_PRESS_CUFF_SYS", nibp_sys, "266016", "mm[Hg]"),
        ("150302", "MDC_PRESS_CUFF_DIA", nibp_dia, "266016", "mm[Hg]"),
        ("150303", "MDC_PRESS_CUFF_MEAN", round((nibp_sys + 2 * nibp_dia) / 3), "266016", "mm[Hg]"),
        ("151562", "MDC_RESP_RATE", round(base["rr"] + wave(9, 2, phase)), "264928", "/min"),
        ("150344", "MDC_TEMP", round(base["temp"] + wave(60, 0.2, phase), 1), "268192", "Cel"),
        ("151708", "MDC_AWAY_CO2_ET", round(base["etco2"] + wave(8, 2, phase)), "266016", "mm[Hg]"),
    ]
    segments = [
        f"MSH|^~\\&|SIM-{device.upper()}|DEMO|FLORA|GATEWAY|{stamp}||ORU^R01^ORU_R01|{device}-{control_id}|P|2.6",
        "PID|1||SYNTHETIC^^^DEMO^MR",
        f"OBR|1|||182777000^monitoring of patient^SCT|||{stamp}",
    ]
    for index, (code, name, value, unit_code, unit) in enumerate(values, start=1):
        segments.append(f"OBX|{index}|NM|{code}^{name}^MDC|1.{index}|{value}|{unit_code}^{unit}^MDC|||||F|||{stamp}")
    return "\r".join(segments) + "\r"


async def hl7_monitor(device: str, port: int) -> None:
    control_id = 0
    while True:
        try:
            reader, writer = await asyncio.open_connection(SOCKET_HOST, port)
            log.info("%s connected to %s:%s", device, SOCKET_HOST, port)
            while True:
                control_id += 1
                writer.write(b"\x0b" + oru_message(device, control_id).encode() + b"\x1c\x0d")
                await writer.drain()
                ack = await asyncio.wait_for(reader.readuntil(b"\x1c\x0d"), timeout=10)
                bump(device, b"MSA|AA" in ack)
                await asyncio.sleep(INTERVAL)
        except Exception as error:
            bump(device, False, str(error))
            await asyncio.sleep(3)


# ------------------------------------------------------------------ JSON devices

def anesthesia_values() -> dict[str, Any]:
    agent = round(1.9 + wave(15, 0.3), 2)
    return {
        "set_vent_mode": "VCV", "set_tidal_volume": 450, "set_rr": 12, "set_peep": 5, "set_fio2": 50,
        "fio2": round(50 + wave(20, 2), 1), "et_agent": agent, "fi_agent": round(agent + 0.4, 2),
        "agent_id": "SEV", "mac": round(agent / 2.0, 2), "et_o2": round(45 + wave(20, 2), 1),
        "airway_pressure_peak": round(18 + wave(6, 2), 1), "tidal_volume_exp": round(445 + wave(5, 15)),
        "flow_o2": 1.0, "flow_air": 1.0,
    }


def ventilator_values() -> dict[str, Any]:
    return {
        "device_ts": int(time.time() * 1000),
        "values": {
            "MODE": "PC-AC", "PEEP": 8, "FIO2_SET": 45, "RR_SET": 18, "VT_SET": 420,
            "fio2": round(45 + wave(30, 1), 1), "tidal_volume_exp": round(410 + wave(6, 20)),
            "minute_volume_exp": round(7.4 + wave(6, 0.4), 1), "airway_pressure_peak": round(24 + wave(7, 2), 1),
            "airway_pressure_plateau": round(20 + wave(7, 1.5), 1), "compliance": round(38 + wave(25, 3), 1),
        },
    }


async def anesthesia_machine() -> None:
    async with httpx.AsyncClient(timeout=5) as client:
        while True:
            try:
                response = await client.post(WEBHOOK_URL, json={"device_ts": int(time.time() * 1000), "values": anesthesia_values()})
                bump("or-anesthesia", response.status_code == 202, response.text[:200])
            except Exception as error:
                bump("or-anesthesia", False, str(error))
            await asyncio.sleep(INTERVAL)


# ------------------------------------------------------------------ RS-232 module

async def serial_module() -> None:
    """Connects to the virtual COM port bridge and answers each poll."""
    while True:
        try:
            reader, writer = await asyncio.open_connection(SERIAL_HOST, SERIAL_PORT)
            log.info("serial module attached to %s:%s", SERIAL_HOST, SERIAL_PORT)
            while True:
                request = await reader.readuntil(b"\n")
                if request.strip() != b"?":
                    continue
                reply = f"TEMP={36.6 + wave(45, 0.2):.1f};CVP={round(8 + wave(12, 2))}\r\n"
                writer.write(reply.encode())
                await writer.drain()
                bump("or-temp-module", True)
        except Exception as error:
            bump("or-temp-module", False, str(error))
            await asyncio.sleep(3)


async def acme_t200() -> None:
    """Fictional Acme T-200 on the second virtual COM port: one checksummed line per "R" poll."""
    while True:
        try:
            reader, writer = await asyncio.open_connection(SERIAL_HOST, T200_PORT)
            log.info("acme t-200 attached to %s:%s", SERIAL_HOST, T200_PORT)
            while True:
                request = await reader.readuntil(b"\r")
                if request.strip() != b"R":
                    continue
                body = f"T200,TEMP={37.0 + wave(30, 0.3, 0.8):.1f},CVP={round(10 + wave(10, 2, 1.1))}"
                checksum = 0
                for byte in body.encode():
                    checksum ^= byte
                writer.write(f"${body}*{checksum:02X}\r\n".encode())
                await writer.drain()
                bump("or-t200", True)
        except Exception as error:
            bump("or-t200", False, str(error))
            await asyncio.sleep(3)


# ------------------------------------------------------------------ app

@asynccontextmanager
async def lifespan(_: FastAPI):
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    tasks = [
        asyncio.create_task(hl7_monitor("or-monitor", int(os.getenv("SIM_OR_MONITOR_PORT", "9001")))),
        asyncio.create_task(hl7_monitor("icu-monitor", int(os.getenv("SIM_ICU_MONITOR_PORT", "9002")))),
        asyncio.create_task(anesthesia_machine()),
        asyncio.create_task(serial_module()),
        asyncio.create_task(acme_t200()),
    ]
    yield
    for task in tasks:
        task.cancel()


app = FastAPI(title="Flora Device Simulator", lifespan=lifespan)


@app.get("/health")
def health():
    return {"status": "OK", "component": "device-simulator", "synthetic": True}


@app.get("/devices/icu-ventilator")
def icu_ventilator():
    bump("icu-ventilator", True)
    return ventilator_values()


@app.post("/receiver")
async def receiver(request: Request):
    batch = await request.json()
    RECEIVER["batches"] += 1
    RECEIVER["observations"] += len(batch)
    RECEIVER["last"] = batch[-5:]
    return {"received": len(batch)}


@app.get("/api/stats")
def stats():
    return {"devices": STATS, "receiver": RECEIVER, "synthetic": True}


@app.get("/", response_class=HTMLResponse)
def index():
    rows = "".join(
        f"<tr><td>{name}</td><td>{stat['sent']}</td><td>{stat['errors']}</td><td>{stat['last_error'] or ''}</td></tr>"
        for name, stat in sorted(STATS.items())
    )
    return f"""<!doctype html><html><head><meta charset=utf-8><meta http-equiv=refresh content=5>
<title>Device Simulator</title><style>body{{font:14px system-ui;margin:24px;color:#1f2a24}}
table{{border-collapse:collapse}}td,th{{border-bottom:1px solid #ddd;padding:6px 12px;text-align:left}}</style></head>
<body><h2>Flora device simulator</h2><p>Synthetic data only. Refreshes every 5 s.</p>
<table><tr><th>Device</th><th>Sent</th><th>Errors</th><th>Last error</th></tr>{rows}</table>
<p>Publisher receiver: {RECEIVER['batches']} batches, {RECEIVER['observations']} observations.</p></body></html>"""
