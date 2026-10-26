"""Outbound worker: watch synced cases, queue messages for each destination and send what is due.

Every TICK seconds, for each account:
  1. events  - a case whose form was saved, or which was discharged, since the last tick queues a form /
               discharge message for each destination serving its ward. The message is due after the
               destination's delay (a later save restarts it, so a burst of edits sends once) or at its
               daily time. The message is built when it is sent, so it always carries the current record.
  2. vitals  - for each active case, each destination with the vitals feed queues one candle message per
               completed period (interval_minutes, aligned to the clock). Periods with no values are skipped.
  3. send    - due messages are sent; failures retry with backoff, a rejected message stops retrying.
"""
from __future__ import annotations

import json
import logging
import threading
import time
from contextlib import nullcontext
from datetime import datetime, timedelta
from typing import Any

from psycopg import Connection

from .. import phi_mask, tenancy
from ..database import pool
from . import messages, transport

LOG = logging.getLogger("flora.outbound")
TICK = 10.0
LAG_MS = 90_000            # a minute row is complete (and synced) about this long after the minute ends
MAX_ATTEMPTS = 10
BATCH = 20
CATCH_UP = 12              # most vitals periods queued per case and tick after a pause
FINAL = ("DISCHARGED",)

_stop = threading.Event()
_thread: threading.Thread | None = None


def now_ms() -> int:
    return int(time.time() * 1000)


# ------------------------------------------------------------------ destinations

def destinations(database: Connection, enabled_only: bool = True) -> list[dict[str, Any]]:
    sql = "SELECT * FROM canopy_outbound_destination" + (" WHERE enabled" if enabled_only else "") + " ORDER BY name"
    return list(database.execute(sql).fetchall())


def feed(destination: dict[str, Any], kind: str) -> dict[str, Any]:
    feeds = destination.get("feeds") or {}
    return feeds.get(kind) if isinstance(feeds.get(kind), dict) else {}


def serves(destination: dict[str, Any], unit_key: str | None) -> bool:
    keys = destination.get("unit_keys") or ["*"]
    return "*" in keys or (unit_key is not None and str(unit_key) in keys)


def due_time(settings: dict[str, Any], now: int) -> int:
    """When a form / discharge message becomes due: after the delay, or at the next daily time."""
    if settings.get("timing") == "daily":
        try:
            hour, minute = (int(part) for part in str(settings.get("daily_at") or "00:00").split(":")[:2])
        except ValueError:
            hour, minute = 0, 0
        local = datetime.fromtimestamp(now / 1000, messages.TZ)
        at = local.replace(hour=hour % 24, minute=minute % 60, second=0, microsecond=0)
        if at <= local:
            at += timedelta(days=1)
        return int(at.timestamp() * 1000)
    return now + max(0, int(settings.get("delay_seconds") or 0)) * 1000


def queue(database: Connection, destination_id: Any, kind: str, case_id: Any, due: int,
          period: tuple[int, int] | None = None) -> None:
    now = now_ms()
    start, end = period or (None, None)
    if kind in ("form", "discharge"):
        database.execute(
            """INSERT INTO canopy_outbound_message (destination_id, kind, case_id, due_at, next_attempt_at, created_at)
               VALUES (%s,%s,%s,%s,%s,%s)
               ON CONFLICT (destination_id, kind, case_id) WHERE status IN ('pending','error') AND kind IN ('form','discharge')
               DO UPDATE SET due_at=EXCLUDED.due_at, next_attempt_at=EXCLUDED.next_attempt_at, attempts=0,
                             status='pending', error=NULL""",
            (destination_id, kind, case_id, due, due, now))
    else:
        database.execute(
            """INSERT INTO canopy_outbound_message
                 (destination_id, kind, case_id, period_start, period_end, due_at, next_attempt_at, created_at)
               VALUES (%s,%s,%s,%s,%s,%s,%s,%s)""",
            (destination_id, kind, case_id, start, end, due, due, now))


# ------------------------------------------------------------------ 1. events

CASES_SQL = """SELECT c.global_case_id, c.status, c.snapshot->'forms'->>'updated_at' AS form_updated_at,
                      u.unit_key, s.case_id AS seen, s.status AS seen_status, s.form_updated_at AS seen_form
               FROM sync_case_index c
               LEFT JOIN canopy_leaf_unit u ON u.leaf_id=c.leaf_id
               LEFT JOIN canopy_outbound_case_state s ON s.case_id=c.global_case_id
               WHERE s.case_id IS NULL OR s.status IS DISTINCT FROM c.status
                  OR s.form_updated_at IS DISTINCT FROM c.snapshot->'forms'->>'updated_at'"""


def detect_events(database: Connection) -> None:
    # The first run takes the current state as seen: enabling the interface does not resend history.
    baseline = database.execute("SELECT 1 FROM canopy_outbound_case_state LIMIT 1").fetchone() is None
    changed = database.execute(CASES_SQL).fetchall()
    if not changed:
        return
    targets = [] if baseline else destinations(database)
    now = now_ms()
    for row in changed:
        status = str(row["status"] or "").upper()
        events = []
        if row["form_updated_at"] and row["form_updated_at"] != row["seen_form"]:
            events.append("form")
        if status in FINAL and str(row["seen_status"] or "").upper() not in FINAL:
            events.append("discharge")
        for destination in targets:
            if not serves(destination, row["unit_key"]):
                continue
            for kind in events:
                settings = feed(destination, kind)
                if settings.get("enabled"):
                    queue(database, destination["id"], kind, row["global_case_id"], due_time(settings, now))
        database.execute(
            """INSERT INTO canopy_outbound_case_state (case_id, status, form_updated_at, seen_at) VALUES (%s,%s,%s,%s)
               ON CONFLICT (case_id) DO UPDATE SET status=EXCLUDED.status, form_updated_at=EXCLUDED.form_updated_at,
                                                   seen_at=EXCLUDED.seen_at""",
            (row["global_case_id"], row["status"], row["form_updated_at"], now))


# ------------------------------------------------------------------ 2. vitals

def schedule_vitals(database: Connection) -> None:
    targets = [d for d in destinations(database) if feed(d, "vitals").get("enabled")]
    if not targets:
        return
    cases = database.execute(
        """SELECT c.global_case_id, c.snapshot->'vitals' AS vitals, u.unit_key
           FROM sync_case_index c LEFT JOIN canopy_leaf_unit u ON u.leaf_id=c.leaf_id
           WHERE upper(c.status)='ACTIVE'""").fetchall()
    now = now_ms()
    for destination in targets:
        period = max(1, int(feed(destination, "vitals").get("interval_minutes") or 1)) * 60_000
        ready = (now - LAG_MS) // period * period          # end of the last complete period
        state = {str(r["case_id"]): r["sent_until"] for r in database.execute(
            "SELECT case_id, sent_until FROM canopy_outbound_vitals_state WHERE destination_id=%s", (destination["id"],))}
        for case in cases:
            if not serves(destination, case["unit_key"]):
                continue
            case_id = str(case["global_case_id"])
            # A new case starts with the last complete period; after a pause at most CATCH_UP periods are sent.
            start = max(state.get(case_id, ready - period), ready - CATCH_UP * period)
            if start >= ready:
                continue
            snapshot = {"vitals": case["vitals"]}
            while start < ready:
                if messages.candles(snapshot, start, start + period):
                    queue(database, destination["id"], "vitals", case_id, now, (start, start + period))
                start += period
            database.execute(
                """INSERT INTO canopy_outbound_vitals_state (destination_id, case_id, sent_until) VALUES (%s,%s,%s)
                   ON CONFLICT (destination_id, case_id) DO UPDATE SET sent_until=EXCLUDED.sent_until""",
                (destination["id"], case_id, start))
    # Forget cases that are no longer active.
    database.execute(
        """DELETE FROM canopy_outbound_vitals_state v WHERE NOT EXISTS
             (SELECT 1 FROM sync_case_index c WHERE c.global_case_id=v.case_id AND upper(c.status)='ACTIVE')""")


# ------------------------------------------------------------------ 3. build and send

def load_case(database: Connection, case_id: Any) -> dict[str, Any] | None:
    return database.execute(
        """SELECT c.*, coalesce(nullif(l.canopy_display_name,''),l.display_name) AS leaf_name,
                  u.unit_key, u.unit_name
           FROM sync_case_index c
           JOIN sync_leaf_node l ON l.leaf_id=c.leaf_id
           LEFT JOIN canopy_leaf_unit u ON u.leaf_id=c.leaf_id
           WHERE c.global_case_id=%s""", (case_id,)).fetchone()


def _pdf(snapshot: dict[str, Any], masked: bool) -> bytes:
    from ..services.innovian_report import build_innovian_report
    return build_innovian_report(phi_mask.mask(snapshot) if masked else snapshot, ["anes:1"])


def build(destination: dict[str, Any], kind: str, case: dict[str, Any], control_id: str,
          period: tuple[int, int] | None = None) -> tuple[str, Any, str, Any]:
    """(message type, message, note, copy for the log). Vitals use `period`; form / discharge / test send the
    case record. The log copy is the same message built with masked identity, so the message log never holds
    full patient identifiers, whatever the destination receives."""
    snapshot = case.get("snapshot") or {}
    identity = destination.get("identity") or "full"
    now = now_ms()
    fhir = destination.get("format") == "fhir"
    if kind == "vitals":
        start, end = period or (now - 60_000, now)
        items = messages.candles(snapshot, start, end)
        if not items:
            raise transport.SendError("no vital-sign values in this period", retry=False)

        def compose(ctx: dict[str, Any]) -> Any:
            if fhir:
                return messages.fhir_vitals(destination, ctx, items, start, end)
            return messages.hl7_vitals(destination, ctx, items, start, end, control_id, now)
        kind_label, note, pdf = ("Bundle (Observation)" if fhir else "ORU^R01 vitals"), "", None
    else:
        pdf, note = None, ""
        settings = feed(destination, "discharge" if kind == "discharge" else "form")
        if settings.get("pdf", True):
            try:
                pdf = _pdf(snapshot, identity == "masked")
            except Exception as exc:  # noqa: BLE001 - send the record without the PDF rather than not at all
                LOG.warning("outbound PDF failed for case %s", case.get("global_case_id"), exc_info=True)
                note = f"PDF not attached: {exc}"

        def compose(ctx: dict[str, Any]) -> Any:
            if fhir:
                return messages.fhir_document(destination, ctx, kind, pdf, now)
            return messages.hl7_document(destination, ctx, kind, pdf, control_id, now)
        kind_label = "Bundle (DiagnosticReport)" if fhir else "ORU^R01 document"
    message = compose(messages.context(snapshot, case, identity))
    log_copy = message if identity == "masked" else compose(messages.context(snapshot, case, "masked"))
    return kind_label, message, note, log_copy


def deliver(destination: dict[str, Any], message: Any) -> str:
    if destination.get("format") == "fhir":
        return transport.send_fhir(destination, message)
    return transport.send_mllp(destination, message)


def loggable(message: Any) -> str:
    """The message as stored in the log, with embedded PDFs shortened."""
    if isinstance(message, str):
        lines = []
        for segment in message.split("\r"):
            if "^AP^PDF^Base64^" in segment:
                head, data = segment.split("^AP^PDF^Base64^", 1)
                data, _, tail = data.partition("|")
                segment = f"{head}^AP^PDF^Base64^<{len(data) * 3 // 4} bytes>" + (f"|{tail}" if tail else "")
            lines.append(segment)
        return "\n".join(lines).strip()
    text = json.dumps(message, ensure_ascii=False, indent=1)
    for entry in message.get("entry", []):
        for form in entry.get("resource", {}).get("presentedForm", []):
            if form.get("data"):
                text = text.replace(form["data"], f"<{len(form['data']) * 3 // 4} bytes>")
    return text


def send_row(database: Connection, row: dict[str, Any], destination: dict[str, Any]) -> dict[str, Any]:
    """Build and send one queued message, then record the outcome on its row."""
    now = now_ms()
    control_id = f"FL{row['id']}"
    attempts = (row.get("attempts") or 0) + 1
    message_type, payload, note = None, None, ""
    try:
        case = load_case(database, row["case_id"]) if row.get("case_id") else None
        if case is None:
            raise transport.SendError("case not found", retry=False)
        period = (row["period_start"], row["period_end"]) if row.get("period_start") is not None else None
        message_type, message, note, log_copy = build(destination, row["kind"], case, control_id, period)
        payload = loggable(log_copy)
        response = deliver(destination, message)
    except transport.SendError as exc:
        final = not exc.retry or attempts >= MAX_ATTEMPTS
        wait = min(60 * 2 ** (attempts - 1), 3600) * 1000
        database.execute(
            """UPDATE canopy_outbound_message SET status=%s, attempts=%s, next_attempt_at=%s, control_id=%s,
                 message_type=%s, payload=coalesce(%s,payload), response=%s, error=%s WHERE id=%s""",
            ("failed" if final else "error", attempts, now + wait, control_id, message_type, payload,
             exc.response or None, str(exc), row["id"]))
        return {"ok": False, "error": str(exc), "response": exc.response}
    except Exception as exc:  # noqa: BLE001 - a bug building one message must not stop the queue
        LOG.exception("outbound message %s failed", row["id"])
        database.execute(
            "UPDATE canopy_outbound_message SET status='failed', attempts=%s, error=%s WHERE id=%s",
            (attempts, f"{type(exc).__name__}: {exc}", row["id"]))
        return {"ok": False, "error": str(exc)}
    database.execute(
        """UPDATE canopy_outbound_message SET status='sent', attempts=%s, sent_at=%s, control_id=%s, message_type=%s,
             payload=%s, response=%s, error=%s WHERE id=%s""",
        (attempts, now_ms(), control_id, message_type, payload, response[:4000], note or None, row["id"]))
    return {"ok": True, "response": response, "note": note}


def drain(database: Connection) -> int:
    sent = 0
    while not _stop.is_set():
        with database.transaction():
            rows = database.execute(
                """SELECT m.* FROM canopy_outbound_message m
                   JOIN canopy_outbound_destination d ON d.id=m.destination_id AND d.enabled
                   WHERE m.status IN ('pending','error') AND m.next_attempt_at <= %s
                   ORDER BY m.next_attempt_at, m.id LIMIT %s FOR UPDATE OF m SKIP LOCKED""",
                (now_ms(), BATCH)).fetchall()
            if not rows:
                return sent
            by_id = {str(d["id"]): d for d in destinations(database)}
            for row in rows:
                send_row(database, row, by_id[str(row["destination_id"])])
                sent += 1
        if len(rows) < BATCH:
            return sent
    return sent


# ------------------------------------------------------------------ loop

def run_once(database: Connection) -> None:
    if database.execute("SELECT to_regclass('canopy_outbound_destination') AS t").fetchone()["t"] is None:
        return  # account schema not migrated yet
    detect_events(database)
    schedule_vitals(database)
    drain(database)


def _loop() -> None:
    while not _stop.wait(TICK):
        try:
            accounts = tenancy.accounts() if tenancy.MULTI_ACCOUNT else [None]
        except Exception:  # noqa: BLE001
            LOG.warning("outbound: account registry unavailable", exc_info=True)
            continue
        for account in accounts:
            if _stop.is_set():
                return
            try:
                with (tenancy.using(account) if account else nullcontext()), pool.connection(timeout=10) as database:
                    run_once(database)
            except Exception:  # noqa: BLE001
                LOG.exception("outbound tick failed for account %s", getattr(account, "code", "-"))


def start() -> None:
    global _thread
    if _thread is not None and _thread.is_alive():
        return
    _stop.clear()
    _thread = threading.Thread(target=_loop, name="outbound", daemon=True)
    _thread.start()


def stop() -> None:
    global _thread
    _stop.set()
    if _thread is not None:
        _thread.join(timeout=20)
        _thread = None
