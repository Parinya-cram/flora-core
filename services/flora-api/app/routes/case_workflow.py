"""Workflow Studio, Leaf side: the ward's workflows (cached from Canopy, offline) and the
workflow forms filled per case. See docs/workflow-studio.md.
"""
from __future__ import annotations

import copy
import json
import uuid
from typing import Any, Literal

from fastapi import APIRouter, Body, Depends, HTTPException
from psycopg import Connection
from psycopg.types.json import Jsonb
from pydantic import BaseModel

from .. import form_schedule, form_sync
from ..clinical import case_audit
from ..database import connection
from .auth_leaf import now_ms, require_permission, service_only

router = APIRouter(prefix="/api/case", tags=["case workflow"])


# ---------------------------------------------------------------- cache

def workflow_state(database: Connection) -> dict[str, Any]:
    row = database.execute("SELECT version, payload, synced_at FROM leaf_workflow_state WHERE id=1").fetchone()
    return {"version": (row or {}).get("version") or 0, "payload": (row or {}).get("payload") or {},
            "synced_at": (row or {}).get("synced_at")}


def cached_billing_template(database: Connection, template_id: str | None) -> dict[str, Any] | None:
    """The newest published itemize template this Leaf holds (works offline)."""
    if not template_id:
        return None
    templates = workflow_state(database)["payload"].get("billing_templates") or {}
    template = templates.get(template_id)
    return template if isinstance(template, dict) else None


def cached_items(database: Connection) -> tuple[list[dict[str, Any]], dict[str, Any], int | None]:
    state = workflow_state(database)
    payload = state["payload"]
    items = sorted((item for item in payload.get("items") or [] if isinstance(item.get("definition"), dict)),
                   key=lambda item: (int(item.get("sortOrder") or 0), str(item["definition"].get("name") or "")))
    return items, payload.get("forms") or {}, state["synced_at"]


def find_workflow(database: Connection, workflow_id: str) -> dict[str, Any] | None:
    """The cached workflow with its pinned form definitions bundled (the case's snapshot)."""
    items, forms, _ = cached_items(database)
    for item in items:
        definition = item["definition"]
        if definition.get("id") == workflow_id:
            snapshot = copy.deepcopy(definition)
            snapshot["bundled_forms"] = {
                entry["form_id"]: {"version": entry["version"], "definition": forms[f"{entry['form_id']}@{entry['version']}"]}
                for entry in definition.get("forms") or []
                if isinstance(entry, dict) and f"{entry.get('form_id')}@{entry.get('version')}" in forms
            }
            template_id = (definition.get("billing") or {}).get("template_id") if isinstance(definition.get("billing"), dict) else None
            template = cached_billing_template(database, template_id)
            if template is not None:
                snapshot["bundled_billing_template"] = template
            scores = workflow_state(database)["payload"].get("scores") or {}
            bundled_scores = {sid: scores[sid] for sid in definition.get("scores") or []
                              if isinstance(sid, str) and isinstance(scores.get(sid), dict)}
            if bundled_scores:
                snapshot["bundled_scores"] = bundled_scores
            return snapshot
    return None


@router.put("/workflows/state")
def put_workflow_state(payload: dict[str, Any] = Body(...), _: dict = Depends(service_only),
                       database: Connection = Depends(connection)) -> dict[str, Any]:
    """Called by the sync worker with the `workflows` of the ward exchange; unchanged sets are skipped."""
    version = int(payload.get("version") or 0)
    stored = database.execute(
        """INSERT INTO leaf_workflow_state (id, version, payload, synced_at) VALUES (1, %s, %s, %s)
           ON CONFLICT (id) DO UPDATE SET version=excluded.version, payload=excluded.payload, synced_at=excluded.synced_at
           WHERE leaf_workflow_state.version IS DISTINCT FROM excluded.version
              OR leaf_workflow_state.payload IS DISTINCT FROM excluded.payload
           RETURNING 1""",
        (version, Jsonb(payload), now_ms())).fetchone()
    if not stored:
        database.execute("UPDATE leaf_workflow_state SET synced_at=%s WHERE id=1", (now_ms(),))
    return {"ok": True, "changed": bool(stored), "version": version, "items": len(payload.get("items") or [])}


@router.get("/workflows")
def list_workflows(_: dict = Depends(require_permission("case.read")), database: Connection = Depends(connection)) -> dict[str, Any]:
    items, _forms, synced_at = cached_items(database)
    rows = []
    for item in items:
        definition = item["definition"]
        record = definition.get("anesthesia_record") or {}
        rows.append({
            "id": definition.get("id"), "name": definition.get("name"), "description": definition.get("description"),
            "isDefault": bool(item.get("isDefault")),
            "sections": list(record.get("sections") or []) if record.get("enabled", True) else [],
            "forms": definition.get("forms") or [],
            # Extras for the case view and the packet.
            "anesthesiaRecord": record, "packet": definition.get("packet") or [], "definition": definition,
        })
    return {"rows": rows, "syncedAt": synced_at}


# ---------------------------------------------------------------- case start (called by cases_lifecycle)

def resolve(database: Connection, workflow_id: str | None, explicit: bool) -> dict[str, Any] | None:
    """The workflow snapshot for a new case. An unknown explicit id is a 409; an unknown
    admission preset is ignored (the case starts without a workflow)."""
    if not workflow_id:
        return None
    workflow = find_workflow(database, workflow_id)
    if workflow is None and explicit:
        raise HTTPException(409, f"workflow '{workflow_id}' is not available on this Leaf")
    return workflow


def apply_on_start(database: Connection, case_id: int, workflow: dict[str, Any] | None, current: int) -> None:
    """Store the snapshot on the case and switch on its built-in record sections."""
    if workflow is None:
        return
    database.execute("UPDATE cases SET workflow=%s WHERE id=%s", (Jsonb(workflow), case_id))
    record = workflow.get("anesthesia_record") or {}
    sections = list(record.get("sections") or []) if record.get("enabled", True) else []
    if not sections:
        return
    row = database.execute("SELECT form_draft_json, field_versions FROM case_detail WHERE case_id=%s FOR UPDATE",
                           (case_id,)).fetchone()
    draft = form_sync.parse(row["form_draft_json"]) if row else {}
    previous = draft.get("enabledForms") if isinstance(draft.get("enabledForms"), list) else []
    # Sections already chosen (e.g. on a Canopy tablet before the start) stay on.
    enabled = sections + [section for section in previous if section not in sections]
    updated = {**draft, "enabledForms": enabled}
    versions = form_sync.stamp_changes(draft, updated, (row or {}).get("field_versions") or {}, current, {"enabledForms"})
    database.execute(
        """INSERT INTO case_detail(case_id,created_at,updated_at,form_draft_json,field_versions) VALUES (%s,%s,%s,%s,%s)
           ON CONFLICT(case_id) DO UPDATE SET updated_at=excluded.updated_at,form_draft_json=excluded.form_draft_json,
             field_versions=excluded.field_versions""",
        (case_id, current, current, json.dumps(updated), Jsonb(versions)))


# ---------------------------------------------------------------- case forms

def case_row(database: Connection, case_id: int, lock: bool = False) -> dict[str, Any]:
    row = database.execute("SELECT id, status, workflow, start_time, discharge_time, created_at FROM cases WHERE id=%s"
                           + (" FOR UPDATE" if lock else ""),
                           (case_id,)).fetchone()
    if row is None:
        raise HTTPException(404, "case not found")
    return row


def form_entry(workflow: dict[str, Any] | None, form_id: str) -> dict[str, Any]:
    for entry in (workflow or {}).get("forms") or []:
        if isinstance(entry, dict) and entry.get("form_id") == form_id:
            return entry
    raise HTTPException(404, f"form '{form_id}' is not part of this case's workflow")


def definition_for(database: Connection, workflow: dict[str, Any], entry: dict[str, Any]) -> dict[str, Any] | None:
    _, forms, _ = cached_items(database)
    cached = forms.get(f"{entry['form_id']}@{entry['version']}")
    if cached is not None:
        return cached
    bundled = ((workflow.get("bundled_forms") or {}).get(entry["form_id"]) or {})
    return bundled.get("definition") if bundled.get("version") == entry["version"] else None


def public_record(row: dict[str, Any] | None) -> dict[str, Any] | None:
    if row is None:
        return None
    return {"data": row["data"] or {}, "status": row["status"], "updatedAt": row["updated_at"],
            "formVersion": row["form_version"], "updatedBy": row.get("updated_by")}


def records(database: Connection, case_id: int) -> dict[str, dict[str, Any]]:
    rows = database.execute("SELECT * FROM case_form_record WHERE case_id=%s", (case_id,)).fetchall()
    return {row["form_id"]: row for row in rows}


def strip_bundle(workflow: dict[str, Any] | None) -> dict[str, Any] | None:
    if workflow is None:
        return None
    return {key: value for key, value in workflow.items() if key not in {"bundled_forms", "bundled_scores"}}


# ---------------------------------------------------------------- scheduled forms (ICU rounds, docs/ICU-ROUNDS.md)

def schedule_of(entry: dict[str, Any]) -> dict[str, Any] | None:
    schedule = entry.get("schedule")
    return schedule if isinstance(schedule, dict) and schedule.get("kind") in form_schedule.KINDS else None


def entry_rows(database: Connection, case_id: int, form_id: str | None = None) -> list[dict[str, Any]]:
    if form_id is None:
        return database.execute("SELECT * FROM case_form_entry WHERE case_id=%s ORDER BY form_id, slot_ts NULLS LAST, created_at",
                                (case_id,)).fetchall()
    return database.execute("SELECT * FROM case_form_entry WHERE case_id=%s AND form_id=%s ORDER BY slot_ts NULLS LAST, created_at",
                            (case_id, form_id)).fetchall()


def public_entry(row: dict[str, Any]) -> dict[str, Any]:
    return {"id": str(row["id"]), "slot_ts": row["slot_ts"], "status": row["status"], "data": row["data"] or {},
            "formVersion": row["form_version"], "updatedAt": row["updated_at"], "updatedBy": row.get("updated_by"),
            "completedAt": row.get("completed_at"), "completedBy": row.get("completed_by"),
            "skipReason": row.get("skip_reason")}


def case_start(case: dict[str, Any]) -> int:
    return int(case.get("start_time") or case.get("created_at") or now_ms())


def case_end(case: dict[str, Any]) -> int | None:
    """No new slots after discharge (late documentation of earlier slots is still allowed)."""
    if case.get("status") in ("discharged", "archived"):
        return int(case.get("discharge_time") or now_ms())
    return int(case["discharge_time"]) if case.get("discharge_time") else None


def form_slots(case: dict[str, Any], entry: dict[str, Any], rows: list[dict[str, Any]], current: int,
               timezone: str) -> list[dict[str, Any]]:
    schedule = schedule_of(entry)
    if schedule is None:
        return []
    workflow = case.get("workflow") or {}
    return form_schedule.slots(schedule, case_start(case), case_end(case), current, timezone,
                               form_schedule.workflow_day_start(workflow), form_schedule.workflow_shifts(workflow),
                               [row for row in rows if row["slot_ts"] is not None])


def form_title(database: Connection, workflow: dict[str, Any], entry: dict[str, Any]) -> str:
    if entry.get("title"):
        return str(entry["title"])
    definition = definition_for(database, workflow, entry) or {}
    return str(definition.get("title") or entry["form_id"])


@router.get("/worklist")
def worklist(_: dict = Depends(require_permission("case.read")), database: Connection = Depends(connection)) -> dict[str, Any]:
    """Due / overdue scheduled forms of every active case (Ward page, case switcher)."""
    timezone = form_schedule.timezone_of(database)
    current = now_ms()
    cases = database.execute(
        "SELECT id, status, workflow, start_time, discharge_time, created_at FROM cases WHERE status='active' ORDER BY id").fetchall()
    out = []
    for case in cases:
        workflow = case["workflow"] or {}
        forms = []
        scheduled = [entry for entry in workflow.get("forms") or [] if isinstance(entry, dict) and schedule_of(entry)]
        rows = entry_rows(database, case["id"]) if scheduled else []
        for entry in scheduled:
            slot_list = form_slots(case, entry, [row for row in rows if row["form_id"] == entry["form_id"]], current, timezone)
            counts = form_schedule.summary(slot_list)
            forms.append({"form_id": entry["form_id"], "title": form_title(database, workflow, entry), "due": counts["due"],
                          "overdue": counts["overdue"], "next_slot_ts": form_schedule.next_slot_ts(slot_list)})
        out.append({"case_id": case["id"], "due": sum(form["due"] for form in forms),
                    "overdue": sum(form["overdue"] for form in forms), "forms": forms})
    return {"cases": out}


@router.get("/{case_id}/workflow")
def case_workflow(case_id: int, _: dict = Depends(require_permission("case.read")),
                  database: Connection = Depends(connection)) -> dict[str, Any]:
    case = case_row(database, case_id)
    workflow = case["workflow"]
    if workflow is None:
        return {"workflow": None, "forms": {}}
    saved = records(database, case_id)
    timezone = form_schedule.timezone_of(database)
    forms = {}
    for entry in workflow.get("forms") or []:
        if isinstance(entry, dict) and entry.get("form_id"):
            schedule = schedule_of(entry)
            forms[entry["form_id"]] = {"definition": definition_for(database, workflow, entry),
                                       "record": None if schedule else public_record(saved.get(entry["form_id"])),
                                       "schedule": schedule}
            if schedule:
                rows = entry_rows(database, case_id, entry["form_id"])
                forms[entry["form_id"]]["summary"] = form_schedule.summary(form_slots(case, entry, rows, now_ms(), timezone))
    return {"workflow": strip_bundle(workflow), "forms": forms}


@router.get("/{case_id}/report-templates")
def report_templates(case_id: int, _: dict = Depends(require_permission("case.read")),
                     database: Connection = Depends(connection)) -> dict[str, Any]:
    """Form Studio templates this case can print from Reports: the forms of the case's workflow (pinned version, with
    what was filled in), then the forms of the ward's current workflows (so cases started before a template was added
    can print it too). Nothing is changed: listing and printing never write the case."""
    case = case_row(database, case_id)
    workflow = case["workflow"] or {}
    saved = records(database, case_id)
    templates: list[dict[str, Any]] = []
    seen: set[str] = set()
    for entry in workflow.get("forms") or []:
        if not isinstance(entry, dict) or not entry.get("form_id") or entry["form_id"] in seen:
            continue
        definition = definition_for(database, workflow, entry)
        if definition is None:
            continue
        seen.add(entry["form_id"])
        templates.append({"form_id": entry["form_id"], "version": entry["version"], "title": entry.get("title") or definition.get("title") or entry["form_id"],
                          "display": entry.get("display") or "tab", "source": "case", "workflow": workflow.get("name") or "",
                          "definition": definition, "record": public_record(saved.get(entry["form_id"]))})
    items, forms, synced_at = cached_items(database)
    for item in items:
        definition_of = item["definition"]
        for entry in definition_of.get("forms") or []:
            if not isinstance(entry, dict) or not entry.get("form_id") or entry["form_id"] in seen:
                continue
            definition = forms.get(f"{entry['form_id']}@{entry.get('version')}")
            if definition is None:
                continue
            seen.add(entry["form_id"])
            templates.append({"form_id": entry["form_id"], "version": entry["version"], "title": entry.get("title") or definition.get("title") or entry["form_id"],
                              "display": entry.get("display") or "tab", "source": "ward", "workflow": definition_of.get("name") or "",
                              "definition": definition, "record": public_record(saved.get(entry["form_id"]))})
    return {"templates": templates, "syncedAt": synced_at}


@router.get("/{case_id}/workflow-snapshot")
def workflow_snapshot(case_id: int, _: dict = Depends(require_permission("case.read")),
                      database: Connection = Depends(connection)) -> dict[str, Any] | None:
    """The case's workflow without bundled form definitions (sync worker snapshot `workflow`)."""
    return strip_bundle(case_row(database, case_id)["workflow"])


@router.get("/{case_id}/workflow-forms")
def workflow_forms(case_id: int, _: dict = Depends(require_permission("case.read")),
                   database: Connection = Depends(connection)) -> dict[str, Any]:
    """{form_id: {form_version, data, status, updatedAt}} (sync worker snapshot `workflow_forms`)."""
    case_row(database, case_id)
    return {form_id: {"form_version": row["form_version"], "data": row["data"] or {}, "status": row["status"],
                      "updatedAt": row["updated_at"]} for form_id, row in records(database, case_id).items()}


@router.get("/{case_id}/workflow-forms/{form_id}")
def workflow_form(case_id: int, form_id: str, _: dict = Depends(require_permission("case.read")),
                  database: Connection = Depends(connection)) -> dict[str, Any]:
    case = case_row(database, case_id)
    entry = form_entry(case["workflow"], form_id)
    row = records(database, case_id).get(form_id)
    return {"definition": definition_for(database, case["workflow"], entry), "record": public_record(row)}


class FormPatch(BaseModel):
    patch: dict[str, Any]
    status: Literal["draft", "completed"] | None = None


@router.patch("/{case_id}/workflow-forms/{form_id}")
def patch_workflow_form(case_id: int, form_id: str, payload: FormPatch, actor: dict = Depends(require_permission("case.chart")),
                        database: Connection = Depends(connection)) -> dict[str, Any]:
    with database.transaction():
        case = case_row(database, case_id, lock=True)
        if case["status"] == "archived":
            raise HTTPException(409, "archived case is read-only")
        entry = form_entry(case["workflow"], form_id)
        row = database.execute("SELECT * FROM case_form_record WHERE case_id=%s AND form_id=%s FOR UPDATE",
                               (case_id, form_id)).fetchone()
        old = dict((row or {}).get("data") or {})
        merged = {**old, **payload.patch}
        current = now_ms()
        versions = form_sync.stamp_changes(old, merged, (row or {}).get("field_versions") or {}, current, set(payload.patch))
        status = payload.status or (row or {}).get("status") or "draft"
        saved = database.execute(
            """INSERT INTO case_form_record (case_id, form_id, form_version, data, field_versions, status, updated_at, updated_by)
               VALUES (%s,%s,%s,%s,%s,%s,%s,%s)
               ON CONFLICT (case_id, form_id) DO UPDATE SET data=excluded.data, field_versions=excluded.field_versions,
                 status=excluded.status, updated_at=excluded.updated_at, updated_by=excluded.updated_by
               RETURNING *""",
            (case_id, form_id, int((row or {}).get("form_version") or entry["version"]), Jsonb(merged), Jsonb(versions),
             status, current, actor["username"])).fetchone()
        case_audit(database, case_id, f"workflow_form.patch:{form_id}", {"data": old, "status": (row or {}).get("status")},
                   {"data": merged, "status": status}, actor)
    return {"ok": True, "case_id": case_id, "form_id": form_id, "record": public_record(saved)}


# ---------------------------------------------------------------- scheduled form entries

@router.get("/{case_id}/workflow-entries")
def workflow_entries(case_id: int, _: dict = Depends(require_permission("case.read")),
                     database: Connection = Depends(connection)) -> list[dict[str, Any]]:
    """Every scheduled-form entry of the case, [Entry + form_id] (sync worker snapshot `workflow_entries`)."""
    case_row(database, case_id)
    if database.execute("SELECT to_regclass('case_form_entry') AS t").fetchone()["t"] is None:
        return []  # Leaf database without migration 0097 yet
    return [{**public_entry(row), "form_id": row["form_id"]} for row in entry_rows(database, case_id)]


def scheduled_entry(case: dict[str, Any], form_id: str) -> tuple[dict[str, Any], dict[str, Any]]:
    entry = form_entry(case["workflow"], form_id)
    schedule = schedule_of(entry)
    if schedule is None:
        raise HTTPException(400, f"form '{form_id}' is not scheduled in this case's workflow")
    return entry, schedule


def writable(case: dict[str, Any]) -> None:
    if case["status"] == "archived":
        raise HTTPException(409, "archived case is read-only")


def entry_row(database: Connection, case_id: int, form_id: str, entry_id: uuid.UUID, lock: bool = False) -> dict[str, Any]:
    row = database.execute("SELECT * FROM case_form_entry WHERE id=%s AND case_id=%s AND form_id=%s"
                           + (" FOR UPDATE" if lock else ""), (entry_id, case_id, form_id)).fetchone()
    if row is None:
        raise HTTPException(404, "entry not found")
    return row


@router.get("/{case_id}/workflow-forms/{form_id}/entries")
def list_entries(case_id: int, form_id: str, _: dict = Depends(require_permission("case.read")),
                 database: Connection = Depends(connection)) -> dict[str, Any]:
    case = case_row(database, case_id)
    entry = form_entry(case["workflow"], form_id)
    timezone = form_schedule.timezone_of(database)
    rows = entry_rows(database, case_id, form_id)
    slot_list = form_slots(case, entry, rows, now_ms(), timezone)
    return {"form_id": form_id, "schedule": schedule_of(entry), "timezone": timezone, "slots": slot_list,
            "unscheduled": [public_entry(row) for row in rows if row["slot_ts"] is None],
            "summary": form_schedule.summary(slot_list)}


class EntryCreate(BaseModel):
    slot_ts: int | None = None


@router.post("/{case_id}/workflow-forms/{form_id}/entries")
def create_entry(case_id: int, form_id: str, payload: EntryCreate, actor: dict = Depends(require_permission("case.chart")),
                 database: Connection = Depends(connection)) -> dict[str, Any]:
    """A new entry for a slot (idempotent: the slot's existing entry is returned) or an unscheduled one (slot_ts null)."""
    with database.transaction():
        case = case_row(database, case_id, lock=True)
        writable(case)
        entry, _schedule = scheduled_entry(case, form_id)
        current = now_ms()
        if payload.slot_ts is not None:
            slot_list = form_slots(case, entry, [], current, form_schedule.timezone_of(database))
            if payload.slot_ts not in {slot["slot_ts"] for slot in slot_list}:
                raise HTTPException(400, f"{payload.slot_ts} is not a slot of form '{form_id}'")
            existing = database.execute("SELECT * FROM case_form_entry WHERE case_id=%s AND form_id=%s AND slot_ts=%s",
                                        (case_id, form_id, payload.slot_ts)).fetchone()
            if existing is not None:
                return {"entry": public_entry(existing)}
        row = database.execute(
            """INSERT INTO case_form_entry (id, case_id, form_id, form_version, slot_ts, status, created_at, created_by,
                                            updated_at, updated_by)
               VALUES (%s,%s,%s,%s,%s,'draft',%s,%s,%s,%s)
               ON CONFLICT (case_id, form_id, slot_ts) WHERE slot_ts IS NOT NULL DO NOTHING RETURNING *""",
            (uuid.uuid4(), case_id, form_id, int(entry["version"]), payload.slot_ts, current, actor["username"],
             current, actor["username"])).fetchone()
        if row is None:  # created concurrently for the same slot
            row = database.execute("SELECT * FROM case_form_entry WHERE case_id=%s AND form_id=%s AND slot_ts=%s",
                                   (case_id, form_id, payload.slot_ts)).fetchone()
        else:
            case_audit(database, case_id, f"workflow_form_entry.create:{form_id}", None,
                       {"entry_id": str(row["id"]), "slot_ts": payload.slot_ts}, actor)
    return {"entry": public_entry(row)}


@router.get("/{case_id}/workflow-forms/{form_id}/entries/{entry_id}")
def get_entry(case_id: int, form_id: str, entry_id: uuid.UUID, _: dict = Depends(require_permission("case.read")),
              database: Connection = Depends(connection)) -> dict[str, Any]:
    case = case_row(database, case_id)
    entry = form_entry(case["workflow"], form_id)
    row = entry_row(database, case_id, form_id, entry_id)
    return {"definition": definition_for(database, case["workflow"], {**entry, "version": row["form_version"]})
            or definition_for(database, case["workflow"], entry), "entry": public_entry(row)}


@router.patch("/{case_id}/workflow-forms/{form_id}/entries/{entry_id}")
def patch_entry(case_id: int, form_id: str, entry_id: uuid.UUID, payload: FormPatch,
                actor: dict = Depends(require_permission("case.chart")),
                database: Connection = Depends(connection)) -> dict[str, Any]:
    with database.transaction():
        case = case_row(database, case_id, lock=True)
        writable(case)
        form_entry(case["workflow"], form_id)
        row = entry_row(database, case_id, form_id, entry_id, lock=True)
        old = dict(row["data"] or {})
        merged = {**old, **payload.patch}
        current = now_ms()
        versions = form_sync.stamp_changes(old, merged, row["field_versions"] or {}, current, set(payload.patch))
        status = payload.status or row["status"]
        completed_at, completed_by = row["completed_at"], row["completed_by"]
        if payload.status == "completed" and row["status"] != "completed":
            completed_at, completed_by = current, actor["username"]
        elif payload.status == "draft":
            completed_at = completed_by = None
        skip_reason = row["skip_reason"] if status == "skipped" else None
        saved = database.execute(
            """UPDATE case_form_entry SET data=%s, field_versions=%s, status=%s, skip_reason=%s, updated_at=%s,
                 updated_by=%s, completed_at=%s, completed_by=%s WHERE id=%s RETURNING *""",
            (Jsonb(merged), Jsonb(versions), status, skip_reason, current, actor["username"], completed_at, completed_by,
             entry_id)).fetchone()
        case_audit(database, case_id, f"workflow_form_entry.patch:{form_id}",
                   {"entry_id": str(entry_id), "data": old, "status": row["status"]},
                   {"entry_id": str(entry_id), "data": merged, "status": status}, actor)
    return {"entry": public_entry(saved)}


class EntrySkip(BaseModel):
    reason: str = ""


@router.post("/{case_id}/workflow-forms/{form_id}/entries/{entry_id}/skip")
def skip_entry(case_id: int, form_id: str, entry_id: uuid.UUID, payload: EntrySkip,
               actor: dict = Depends(require_permission("case.chart")),
               database: Connection = Depends(connection)) -> dict[str, Any]:
    with database.transaction():
        case = case_row(database, case_id, lock=True)
        writable(case)
        form_entry(case["workflow"], form_id)
        row = entry_row(database, case_id, form_id, entry_id, lock=True)
        reason = payload.reason.strip()[:500]
        current = now_ms()
        saved = database.execute(
            """UPDATE case_form_entry SET status='skipped', skip_reason=%s, updated_at=%s, updated_by=%s,
                 completed_at=NULL, completed_by=NULL WHERE id=%s RETURNING *""",
            (reason or None, current, actor["username"], entry_id)).fetchone()
        case_audit(database, case_id, f"workflow_form_entry.skip:{form_id}",
                   {"entry_id": str(entry_id), "status": row["status"]},
                   {"entry_id": str(entry_id), "status": "skipped", "reason": reason}, actor)
    return {"entry": public_entry(saved)}
