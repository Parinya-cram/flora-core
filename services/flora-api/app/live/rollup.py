"""Pure stream bookkeeping for leaf-live: sequence gaps, minute closing, chunk decoding."""
import array
import base64
import sys

from ..vitals_mapping import latest_values, minute_payload


def minute_of(seq: int) -> int:
    """First epoch second of the minute holding `seq`."""
    return seq - seq % 60


class GapTracker:
    """Seconds missing from one (case, device) stream since leaf-live started."""

    def __init__(self, last: int | None = None):
        self.last, self.gaps, self.ranges = last, 0, []

    def add(self, seq: int) -> None:
        if self.last is not None and seq > self.last + 1:
            self.gaps += seq - self.last - 1
            self.ranges = (self.ranges + [(self.last + 1, seq - 1)])[-20:]
        if self.last is None or seq > self.last:
            self.last = seq


class MinuteCloser:
    """Which minutes to roll up into vital_minutes after a chunk of one (case, device).

    A minute closes when that device's stream moves past it; a late revision of a closed minute
    rolls it again at once. Each roll reads every device of the case, so a lagging device rolls
    the minute again when it catches up."""

    def __init__(self):
        self.dirty: set[int] = set()
        self.latest: int | None = None

    def add(self, seq: int) -> list[int]:
        self.latest = seq if self.latest is None else max(self.latest, seq)
        self.dirty.add(minute_of(seq))
        closed = sorted(minute for minute in self.dirty if minute + 60 <= self.latest)
        self.dirty.difference_update(closed)
        return closed


def minute_rows(seconds: list[list[dict]]) -> list[dict]:
    """Numerics of a minute's stored seconds (any device), in time order like the data-api."""
    rows = [row for numerics in seconds for row in numerics or []]
    return sorted(rows, key=lambda row: row.get("system_ts") or 0)


def rollup(seconds: list[list[dict]]) -> dict:
    return minute_payload(minute_rows(seconds))


def decode_samples(samples_b64: str) -> list[int]:
    data = base64.b64decode(samples_b64 or "")
    values = array.array("h")
    values.frombytes(data[: len(data) - len(data) % 2])
    if sys.byteorder == "big":
        values.byteswap()
    return values.tolist()


def browser_chunk(case_id: int, chunk: dict) -> dict:
    numerics = chunk.get("numerics") or []
    return {
        "type": "chunk", "case_id": case_id, "device_id": chunk["device_id"], "seq": chunk["seq"],
        "rev": chunk.get("rev", 0), "t0": chunk.get("t0", chunk["seq"] * 1000),
        "numerics": latest_values(numerics), "raw": numerics,
        "waves": [{"channel": wave.get("channel"), "rate_hz": wave.get("rate_hz"), "t0": wave.get("t0"),
                   "samples": decode_samples(wave.get("samples_b64"))} for wave in chunk.get("waves") or []],
    }
