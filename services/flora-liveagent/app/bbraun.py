"""Synthetic BCC-shaped readings. No sockets, pump commands, or drug dosing."""
import json
import math
from pathlib import Path


def load_pumps():
    pumps = json.loads(Path(__file__).with_name("bbraun_pumps.json").read_text(encoding="utf-8"))
    ids = set()
    for pump in pumps:
        if not pump["device_id"] or pump["device_id"] in ids:
            raise ValueError("pump device IDs must be nonempty and unique")
        ids.add(pump["device_id"])
        for key in ("rate_ml_h", "volume_ml"):
            if not math.isfinite(pump[key]) or pump[key] <= 0:
                raise ValueError(f"{key} must be positive and finite")
        start, end = pump["pause_minutes"]
        if not (math.isfinite(start) and math.isfinite(end) and 0 <= start <= end):
            raise ValueError("invalid pause interval")
    return pumps


PUMPS = load_pumps()


def fields(pump, elapsed_minutes):
    """Original BCC codes and mapped keys/units; values are synthetic examples."""
    elapsed = max(0, elapsed_minutes)
    pause_start, pause_end = pump["pause_minutes"]
    paused_minutes = min(max(elapsed - pause_start, 0), pause_end - pause_start)
    delivered = min(pump["volume_ml"], (elapsed - paused_minutes) * pump["rate_ml_h"] / 60)
    complete = delivered >= pump["volume_ml"]
    paused = pause_start <= elapsed < pause_end
    running = not complete and not paused
    state = "completed" if complete else "paused" if paused else "running"
    return [
        ("GNNEW", "pump_name", pump["label"], ""),
        ("GNMODEL", "pump_model", "B. Braun Space — SIMULATED", ""),
        ("INSOL", "drug_name", "DEMO FLUID — NOT A PRESCRIPTION", ""),
        ("INRT", "infusion_rate", pump["rate_ml_h"] if running else 0, "mL/h"),
        ("INVTB", "vtbi", round(pump["volume_ml"] - delivered, 4), "mL"),
        ("INVI", "infused_volume", round(delivered, 4), "mL"),
        ("INM1", "ready_for_infusion", int(not complete), ""),
        ("INM2", "bolus_active", 0, ""),
        ("INM3", "active_pumping", int(running), ""),
        ("INA7", "end_of_volume_alarm", int(complete), ""),
        # Human-readable demo state, not a claim about real BCC status encoding.
        ("RUNSTATE", "run_state", state, ""),
    ]
