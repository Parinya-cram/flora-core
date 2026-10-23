"""leaf-live database work (blocking; called through asyncio.to_thread)."""
import base64
import json
import os
import time
from typing import Any

from psycopg.types.json import Jsonb

from ..case_bindings import case_uuid
from ..database import pool
from .rollup import rollup

UNBIND_REASONS = {"discharged", "archived", "edited", "case_inactive"}


def now_ms() -> int:
    return int(time.time() * 1000)


def stream_links() -> list[dict[str, Any]]:
    with pool.connection() as database:
        return database.execute(
            "SELECT id, stream_url, token FROM leaf_gateway_link WHERE stream_url IS NOT NULL AND token IS NOT NULL ORDER BY id"
        ).fetchall()


def release_inactive() -> int:
    """Bindings left open on a case that is no longer active (any path that ends a case)."""
    with pool.connection() as database:
        return database.execute(
            """UPDATE case_device_binding b SET released_at=%s, release_reason='case_inactive'
               FROM cases c WHERE c.id=b.case_id AND b.released_at IS NULL AND c.status <> 'active'""",
            (now_ms(),)).rowcount


def targets(link_id: int) -> list[dict[str, Any]]:
    """Open bindings of active cases on one link, with where their stream starts and resumes.

    origin_seq: the case's capture start for a device bound at the start, else when it was bound.
    resume_seq: the second after the last one stored, or origin_seq."""
    with pool.connection() as database:
        rows = database.execute(
            """SELECT b.id::text AS binding_id, b.case_id, b.device_id, b.mode,
                      (CASE WHEN b.bound_at <= c.created_at + 60000 THEN coalesce(c.device_capture_start_time, c.start_time)
                            ELSE b.bound_at END) / 1000 AS origin_seq,
                      (SELECT max(seq) FROM stream_second s WHERE s.case_id=b.case_id AND s.device_id=b.device_id) AS last_seq
               FROM case_device_binding b JOIN cases c ON c.id=b.case_id
               WHERE b.gateway_link_id=%s AND b.released_at IS NULL AND c.status='active'
               ORDER BY b.bound_at""", (link_id,)).fetchall()
    for row in rows:
        row["case_uuid"] = case_uuid(row["case_id"])
        row["resume_seq"] = max(row["origin_seq"], row["last_seq"] + 1) if row["last_seq"] is not None else row["origin_seq"]
    return rows


def release_reasons(binding_ids: list[str]) -> dict[str, str]:
    if not binding_ids:
        return {}
    with pool.connection() as database:
        rows = database.execute(
            "SELECT id::text AS id, release_reason FROM case_device_binding WHERE id::text = ANY(%s)", (binding_ids,)
        ).fetchall()
    return {row["id"]: row["release_reason"] if row["release_reason"] in UNBIND_REASONS else "edited" for row in rows}


def set_state(binding_ids: list[str], state: str, detail: str | None) -> None:
    if not binding_ids:
        return
    with pool.connection() as database:
        database.execute(
            "UPDATE case_device_binding SET gateway_state=%s, gateway_detail=%s WHERE id::text = ANY(%s) AND released_at IS NULL",
            (state, (detail or "")[:500] or None, binding_ids))


SECOND_UPSERT = """INSERT INTO stream_second (case_id, device_id, seq, rev, numerics, received_at)
    VALUES (%s, %s, %s, %s, %s, %s)
    ON CONFLICT (case_id, device_id, seq) DO UPDATE
    SET rev=excluded.rev, numerics=excluded.numerics, received_at=excluded.received_at
    WHERE excluded.rev >= stream_second.rev"""
WAVE_UPSERT = """INSERT INTO stream_wave (case_id, device_id, channel, t0, rate_hz, samples, received_at)
    VALUES (%s, %s, %s, %s, %s, %s, %s)
    ON CONFLICT (case_id, device_id, channel, t0) DO UPDATE
    SET rate_hz=excluded.rate_hz, samples=excluded.samples, received_at=excluded.received_at"""


def store_chunk(chunk: dict[str, Any], cases: list[tuple[int, list[int]]]) -> None:
    """One chunk for every case bound to its device, and the minutes it closed; one transaction."""
    store_chunks([(chunk, cases)])


def store_chunks(work: list[tuple[dict[str, Any], list[tuple[int, list[int]]]]]) -> None:
    """Chunks in arrival order, each with (case_id, minutes it closed) for the cases bound to its device.

    One transaction: batched upserts, then each closed minute rolled once."""
    received = now_ms()
    seconds, waves, minutes = [], [], set()
    for chunk, cases in work:
        device_id, seq, rev = chunk["device_id"], int(chunk["seq"]), int(chunk.get("rev") or 0)
        for case_id, closed in cases:
            seconds.append((case_id, device_id, seq, rev, Jsonb(chunk.get("numerics") or []), received))
            for wave in chunk.get("waves") or []:
                waves.append((case_id, device_id, str(wave.get("channel") or ""), int(wave.get("t0") or seq * 1000),
                              float(wave.get("rate_hz") or 0), base64.b64decode(wave.get("samples_b64") or ""), received))
            minutes.update((case_id, minute) for minute in closed)
    if not seconds:
        return
    with pool.connection() as database, database.transaction():
        with database.cursor() as cursor:
            cursor.executemany(SECOND_UPSERT, seconds)
            if waves:
                cursor.executemany(WAVE_UPSERT, waves)
        for case_id, minute in sorted(minutes):
            roll_minute(database, case_id, minute)


def roll_minute(database, case_id: int, minute: int) -> dict:
    """vital_minutes (ivy_source 'vector') for one minute from every device's stored seconds."""
    seconds = [row["numerics"] for row in database.execute(
        "SELECT numerics FROM stream_second WHERE case_id=%s AND seq >= %s AND seq < %s ORDER BY seq, device_id",
        (case_id, minute, minute + 60)).fetchall()]
    payload = rollup(seconds)
    if payload:
        database.execute(
            """INSERT INTO vital_minutes (case_id, ivy_source, ts_minute, payload, created_at)
               VALUES (%s, 'vector', %s, %s, %s) ON CONFLICT (case_id, ivy_source, ts_minute)
               DO UPDATE SET payload=excluded.payload, created_at=excluded.created_at""",
            (case_id, minute * 1000, json.dumps(payload), now_ms()))
    return payload


def case_exists(case_id: int) -> bool:
    with pool.connection() as database:
        return database.execute("SELECT 1 FROM cases WHERE id=%s", (case_id,)).fetchone() is not None


WAVE_RETENTION_DAYS = float(os.getenv("FLORA_STREAM_WAVE_RETENTION_DAYS", "7"))
SECOND_RETENTION_DAYS = float(os.getenv("FLORA_STREAM_SECOND_RETENTION_DAYS", "30"))
PRUNE_BATCH = 5000


def prune_streams(wave_days: float | None = None, second_days: float | None = None, now: int | None = None,
                  batch: int = PRUNE_BATCH) -> dict[str, int]:
    """Delete stream_wave / stream_second older than their retention, for cases that are not active.

    Age is the data's own time (t0 / seq). An active case keeps everything. Batched deletes, each
    its own short transaction (the pool is autocommit). Returns the rows deleted per table."""
    now = now_ms() if now is None else now
    wave_days = WAVE_RETENTION_DAYS if wave_days is None else wave_days
    second_days = SECOND_RETENTION_DAYS if second_days is None else second_days
    plans = (("stream_wave", "t0", now - int(wave_days * 86_400_000)),
             ("stream_second", "seq", (now - int(second_days * 86_400_000)) // 1000))
    deleted = {}
    with pool.connection() as database:
        for table, column, cutoff in plans:
            deleted[table] = 0
            # The (case_id, ...) primary key finds each case's old rows.
            cases = [row["id"] for row in database.execute(
                f"""SELECT c.id FROM cases c WHERE c.status <> 'active'
                    AND EXISTS (SELECT 1 FROM {table} s WHERE s.case_id=c.id AND s.{column} < %s)""", (cutoff,)).fetchall()]
            for case_id in cases:
                while True:
                    count = database.execute(
                        f"""DELETE FROM {table} WHERE ctid = ANY(ARRAY(
                              SELECT ctid FROM {table} WHERE case_id=%s AND {column} < %s LIMIT %s))
                           AND NOT EXISTS (SELECT 1 FROM cases WHERE id=%s AND status='active')""",
                        (case_id, cutoff, batch, case_id)).rowcount
                    deleted[table] += count
                    if count < batch:
                        break
    return deleted
