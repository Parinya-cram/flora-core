"""Workflow Studio, Leaf side: the ward's workflows (cached from Canopy, offline) and the
workflow forms filled per case. See docs/workflow-studio.md.
"""
from __future__ import annotations

import copy
import json
from typing import Any, Literal

from fastapi import APIRouter, Body, Depends, HTTPException, Request
from fastapi.responses import JSONResponse, Response
from psycopg import Connection
from psycopg.types.json import Jsonb
from pydantic import BaseModel, Field

from .. import case_forms, form_sync
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


# ---------------------------------------------------------------- case forms <-> Canopy (sync worker; app/case_forms.py)

@router.get("/workflow-forms-sync/outbox")
def case_forms_outbox(_: dict = Depends(service_only), database: Connection = Depends(connection)) -> dict[str, Any]:
    """Forms Canopy has not acknowledged as they are now (paged: `more`), and the open cases with their workflow forms."""
    return case_forms.leaf_outbox(database, now_ms())


@router.put("/workflow-forms-sync/inbox")
def case_forms_inbox(payload: dict[str, Any] = Body(...), _: dict = Depends(service_only),
                     database: Connection = Depends(connection)) -> dict[str, Any]:
    """Canopy's receipts and changes (amendments, forms filled for the admission); returns acks for the next exchange."""
    return case_forms.leaf_inbox(database, payload, now_ms())


@router.get("/workflow-forms-sync/files/{sha256}")
def case_forms_file(sha256: str, _: dict = Depends(service_only), database: Connection = Depends(connection)) -> Response:
    stored = case_forms.formdev_services(database).records.attachments.get(sha256) if case_forms_sha(sha256) else None
    if stored is None:
        raise HTTPException(404, "file not stored on this Leaf")
    meta, content = stored
    return Response(content=content, media_type=meta["media_type"])


def case_forms_sha(value: str) -> bool:
    from ..formdev.attachments import SHA

    return bool(SHA.match(value))


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
    row = database.execute("SELECT id, status, workflow FROM cases WHERE id=%s" + (" FOR UPDATE" if lock else ""),
                           (case_id,)).fetchone()
    if row is None:
        raise HTTPException(404, "case not found")
    return row


def form_entry(workflow: dict[str, Any] | None, form_id: str) -> dict[str, Any]:
    """The workflow entry of a case form key: a form of the workflow, or a further copy ("<form_id>~2"...) of a
    repeatable one (case_forms.workflow_entry)."""
    entry = case_forms.workflow_entry(workflow, form_id)
    if entry is not None:
        return entry
    if case_forms.instance_of(form_id) > 1 and case_forms.workflow_entry(workflow, case_forms.form_of(form_id)) is not None:
        raise HTTPException(404, f"form '{case_forms.form_of(form_id)}' cannot have copy {case_forms.instance_of(form_id)} in this workflow")
    raise HTTPException(404, f"form '{form_id}' is not part of this case's workflow")


def copies(saved: dict[str, Any], form_id: str) -> list[str]:
    """The further copies ("<form_id>~2"...) of a repeatable form filled on the case, in order."""
    return sorted((key for key in saved if case_forms.form_of(key) == form_id and case_forms.instance_of(key) > 1),
                  key=case_forms.instance_of)


def definition_for(database: Connection, workflow: dict[str, Any], entry: dict[str, Any],
                   forms: dict[str, Any] | None = None) -> dict[str, Any] | None:
    """The pinned definition of a workflow form. In a loop, pass `forms` (cached_items) read once: the cached payload
    holds every workflow and form definition of the ward and is not small."""
    if forms is None:
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
            "formVersion": row["form_version"], "updatedBy": row.get("updated_by"),
            "createdAt": row.get("created_at"), "createdBy": row.get("created_by"), "authors": row.get("field_authors") or {},
            # Canopy's receipt for the copy it last took (case_forms.leaf_inbox); "pending" until the first one.
            "sync": {"state": row.get("sync_state") or "pending", "issues": row.get("sync_issues") or [],
                     "at": row.get("synced_at"), "recordId": row.get("canopy_record_id"),
                     "current": row.get("sent_digest") is not None and row.get("sent_digest") == case_forms.digest(case_forms.leaf_copy(row))}}


def records(database: Connection, case_id: int) -> dict[str, dict[str, Any]]:
    rows = database.execute("SELECT * FROM case_form_record WHERE case_id=%s", (case_id,)).fetchall()
    return {row["form_id"]: row for row in rows}


def strip_bundle(workflow: dict[str, Any] | None) -> dict[str, Any] | None:
    if workflow is None:
        return None
    return {key: value for key, value in workflow.items() if key not in {"bundled_forms", "bundled_scores"}}


@router.get("/{case_id}/workflow")
def case_workflow(case_id: int, _: dict = Depends(require_permission("case.read")),
                  database: Connection = Depends(connection)) -> dict[str, Any]:
    case = case_row(database, case_id)
    workflow = case["workflow"]
    if workflow is None:
        return {"workflow": None, "forms": {}}
    saved = records(database, case_id)
    _, cached, _ = cached_items(database)
    forms = {}
    for entry in workflow.get("forms") or []:
        if isinstance(entry, dict) and entry.get("form_id"):
            definition = definition_for(database, workflow, entry, cached)
            forms[entry["form_id"]] = {"definition": definition, "record": public_record(saved.get(entry["form_id"]))}
            # A repeatable form: its further copies, each under its own key ("<form_id>~2"...).
            for key in copies(saved, entry["form_id"]) if entry.get("repeatable") else []:
                forms[key] = {"definition": definition, "record": public_record(saved[key]),
                              "of": entry["form_id"], "instance": case_forms.instance_of(key)}
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
    items, forms, synced_at = cached_items(database)  # read once for the whole list
    templates: list[dict[str, Any]] = []
    seen: set[str] = set()
    for entry in workflow.get("forms") or []:
        if not isinstance(entry, dict) or not entry.get("form_id") or entry["form_id"] in seen:
            continue
        definition = definition_for(database, workflow, entry, forms)
        if definition is None:
            continue
        seen.add(entry["form_id"])
        title = entry.get("title") or definition.get("title") or entry["form_id"]
        templates.append({"form_id": entry["form_id"], "version": entry["version"], "title": title,
                          "display": entry.get("display") or "tab", "source": "case", "workflow": workflow.get("name") or "",
                          "definition": definition, "record": public_record(saved.get(entry["form_id"]))})
        for key in copies(saved, entry["form_id"]) if entry.get("repeatable") else []:
            templates.append({"form_id": key, "version": entry["version"], "title": f"{title} ({case_forms.instance_of(key)})",
                              "display": entry.get("display") or "tab", "source": "case", "workflow": workflow.get("name") or "",
                              "definition": definition, "record": public_record(saved[key])})
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
                      "updatedAt": row["updated_at"], "updatedBy": row.get("updated_by")}
            for form_id, row in records(database, case_id).items()}


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
    # Why a completed form is changed or reopened (an amendment); required then, kept with each changed field.
    reason: str | None = Field(default=None, max_length=500)


@router.patch("/{case_id}/workflow-forms/{form_id}")
def patch_workflow_form(case_id: int, form_id: str, payload: FormPatch, actor: dict = Depends(require_permission("case.chart")),
                        database: Connection = Depends(connection)) -> Any:
    """Save the changed fields (each stamped with time and author, so Canopy merges field by field). Completing the
    form checks it with Form Studio's rules first: a form Canopy would refuse is not marked complete (422 + issues)."""
    return _save_form(database, case_id, form_id, payload.patch, payload.status, payload.reason, actor)


def signature_keys(definition: dict[str, Any] | None) -> set[str]:
    """Keys of the form's signature fields outside repeats (the ones signed with a PIN)."""
    out: set[str] = set()

    def walk(fields: list[Any]) -> None:
        for field in fields or []:
            if not isinstance(field, dict) or field.get("type") == "repeat":
                continue
            if field.get("type") == "signature":
                out.add(field.get("key") or field["id"])
            walk(field.get("fields") or [])

    for section in (definition or {}).get("sections") or []:
        walk(section.get("fields") or [])
        for category in section.get("categories") or []:
            walk(category.get("fields") or [])
    return out


def _confirmed(value: Any) -> bool:
    return isinstance(value, dict) and value.get("verified") == "pin"


def _save_form(database: Connection, case_id: int, form_id: str, patch: dict[str, Any], status_in: str | None,
               reason_in: str | None, actor: dict[str, Any], signed: frozenset[str] = frozenset()) -> Any:
    """The one way a Leaf form is changed. A completed form, or a signature confirmed with a PIN, changes only as an
    amendment with a reason; a confirmed signature is made only by signing (`signed`: the keys signed just now)."""
    with database.transaction():
        case = case_row(database, case_id, lock=True)
        if case["status"] == "archived":
            raise HTTPException(409, "archived case is read-only")
        entry = form_entry(case["workflow"], form_id)
        definition = definition_for(database, case["workflow"], entry)
        row = database.execute("SELECT * FROM case_form_record WHERE case_id=%s AND form_id=%s FOR UPDATE",
                               (case_id, form_id)).fetchone()
        copy = case_forms.leaf_copy(row) if row else case_forms.copy_of({}, {}, {}, "draft")
        signatures = signature_keys(definition)
        for key in set(patch) & signatures:
            if key not in signed and _confirmed(patch[key]) and patch[key] != copy["data"].get(key):
                return JSONResponse(status_code=422, content={
                    "code": "sign_with_pin", "error": "A signature confirmed with a PIN is made with “Sign with PIN”"})
        merged = {**copy["data"], **patch}
        current = now_ms()
        status = status_in or copy["status"]
        resigned = [key for key in set(patch) & signatures if _confirmed(copy["data"].get(key)) and merged.get(key) != copy["data"].get(key)]
        # A completed form is part of the record, and so is a confirmed signature: changing either is an amendment.
        amending = (copy["status"] == "completed" and (status != "completed" or merged != copy["data"])) or bool(resigned)
        reason = (reason_in or "").strip()
        if amending and not case_forms.REASON_MIN <= len(reason) <= case_forms.REASON_MAX:
            what = "This signature was confirmed with a PIN" if resigned and copy["status"] != "completed" else "This form is completed"
            return JSONResponse(status_code=422, content={
                "code": "amendment_reason_required",
                "error": f"{what}: give a reason for the change ({case_forms.REASON_MIN}-{case_forms.REASON_MAX} characters)"})
        if status == "completed" and (status_in == "completed" or patch):
            issues = case_forms.leaf_issues(database, definition, merged) if definition else []
            if issues:
                return JSONResponse(status_code=422, content={
                    "error": f"{len(issues)} field(s) need attention before the form is complete", "issues": issues})
        author = {"by": actor["username"], "at": current, "via": "leaf", **({"reason": reason} if amending else {})}
        updated = case_forms.stamp(copy, merged, status, current, author, set(patch))
        saved = database.execute(
            """INSERT INTO case_form_record (case_id, form_id, form_version, data, field_versions, field_authors, status,
                 updated_at, updated_by, created_at, created_by)
               VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
               ON CONFLICT (case_id, form_id) DO UPDATE SET data=excluded.data, field_versions=excluded.field_versions,
                 field_authors=excluded.field_authors, status=excluded.status, updated_at=excluded.updated_at,
                 updated_by=excluded.updated_by
               RETURNING *""",
            (case_id, form_id, int((row or {}).get("form_version") or entry["version"]), Jsonb(updated["data"]),
             Jsonb(updated["versions"]), Jsonb(updated["authors"]), status, current, actor["username"], current,
             actor["username"])).fetchone()
        action = "sign" if signed else "amend" if amending else "patch"
        case_audit(database, case_id, f"workflow_form.{action}:{form_id}",
                   {"data": copy["data"], "status": copy["status"]},
                   {"data": updated["data"], "status": status, **({"reason": reason} if amending else {}),
                    **({"signed": sorted(signed)} if signed else {})}, actor)
    return {"ok": True, "case_id": case_id, "form_id": form_id, "record": public_record(saved)}


class SignPayload(BaseModel):
    field: str = Field(min_length=1, max_length=64)
    data: str = Field(min_length=20, max_length=600_000)
    pin: str = Field(min_length=4, max_length=8)
    reason: str | None = Field(default=None, max_length=500)


SIGN_ATTEMPTS: dict[int, list[int]] = {}  # failed signing PINs per user (ms), this process
SIGN_LOCK_FAILS, SIGN_LOCK_MS = 5, 15 * 60 * 1000


@router.post("/{case_id}/workflow-forms/{form_id}/sign")
def sign_workflow_form(case_id: int, form_id: str, payload: SignPayload, actor: dict = Depends(require_permission("case.chart")),
                       database: Connection = Depends(connection)) -> Any:
    """Sign a signature field with the drawing and your signing PIN: the value names you, is marked confirmed and is
    then locked (changing it is an amendment with a reason). Five wrong PINs in 15 minutes lock signing for a while."""
    from datetime import datetime
    from zoneinfo import ZoneInfo

    from .. import directory

    current = now_ms()
    recent = [at for at in SIGN_ATTEMPTS.get(actor["id"], []) if current - at < SIGN_LOCK_MS]
    if len(recent) >= SIGN_LOCK_FAILS:
        raise HTTPException(429, "too many wrong PINs: try again in 15 minutes")
    case = case_row(database, case_id)
    definition = definition_for(database, case["workflow"], form_entry(case["workflow"], form_id))
    if payload.field not in signature_keys(definition):
        raise HTTPException(404, "no such signature field on this form")
    has_pin = database.execute("SELECT sign_pin_hash FROM auth_user WHERE id=%s", (actor["id"],)).fetchone()
    if not has_pin or not has_pin["sign_pin_hash"]:
        raise HTTPException(409, "set your signing PIN first (Account → Signing PIN)")
    if not directory.verify_sign_pin(database, actor["id"], payload.pin):
        SIGN_ATTEMPTS[actor["id"]] = recent + [current]
        case_audit(database, case_id, f"workflow_form.sign_refused:{form_id}", None, {"field": payload.field}, actor)
        raise HTTPException(403, "wrong signing PIN")
    SIGN_ATTEMPTS.pop(actor["id"], None)
    value = {"data": payload.data, "signed_at": datetime.now(ZoneInfo("Asia/Bangkok")).isoformat(timespec="seconds"),
             "signer": actor["username"], "signer_name": str(actor.get("name") or actor["username"])[:200], "verified": "pin"}
    return _save_form(database, case_id, form_id, {payload.field: value}, None, payload.reason, actor, frozenset({payload.field}))


# ---------------------------------------------------------------- workflow of an open case

class AttachWorkflow(BaseModel):
    workflow_id: str = Field(min_length=1, max_length=64)


def _kept_entry(old: dict[str, Any] | None, form_id: str, version: int) -> tuple[dict[str, Any], dict[str, Any] | None]:
    """A form already filled under the old workflow: its entry and definition at the version it was filled with."""
    entry = next((dict(item) for item in (old or {}).get("forms") or [] if isinstance(item, dict) and item.get("form_id") == form_id),
                 {"form_id": form_id, "title": form_id, "display": "tab"})
    entry["version"] = version
    bundled = ((old or {}).get("bundled_forms") or {}).get(form_id) or {}
    return entry, (bundled if bundled.get("version") == version else None)


@router.put("/{case_id}/workflow")
def attach_workflow(case_id: int, payload: AttachWorkflow, actor: dict = Depends(require_permission("case.chart")),
                    database: Connection = Depends(connection)) -> dict[str, Any]:
    """Attach a workflow to an open case, or change it. Forms already filled keep the version they were filled with
    (and stay on the case even when the new workflow does not list them); the change is in the case's audit trail."""
    with database.transaction():
        case = case_row(database, case_id, lock=True)
        if case["status"] == "archived":
            raise HTTPException(409, "archived case is read-only")
        workflow = find_workflow(database, payload.workflow_id)
        if workflow is None:
            raise HTTPException(409, f"workflow '{payload.workflow_id}' is not available on this Leaf")
        old = case["workflow"]
        saved = records(database, case_id)
        forms, bundled = [], dict(workflow.get("bundled_forms") or {})
        for entry in workflow.get("forms") or []:
            record = saved.get(entry.get("form_id")) if isinstance(entry, dict) else None
            if record is not None and int(record["form_version"]) != int(entry.get("version") or 0):
                kept, definition = _kept_entry(old, entry["form_id"], int(record["form_version"]))
                entry = {**entry, "version": kept["version"]}
                if definition is not None:
                    bundled[entry["form_id"]] = definition
                else:
                    bundled.pop(entry["form_id"], None)
            forms.append(entry)
        listed = {entry.get("form_id") for entry in forms if isinstance(entry, dict)}
        for key, record in sorted(saved.items(), key=lambda item: case_forms.instance_of(item[0])):
            form_id = case_forms.form_of(key)
            if form_id not in listed:
                kept, definition = _kept_entry(old, form_id, int(record["form_version"]))
                forms.append({**kept, "kept_from_previous_workflow": True})
                listed.add(form_id)
                if definition is not None:
                    bundled[form_id] = definition
        # Copies of a repeatable form already filled stay reachable, even where the new workflow lists it once.
        highest: dict[str, int] = {}
        for key in saved:
            if case_forms.instance_of(key) > 1:
                highest[case_forms.form_of(key)] = max(highest.get(case_forms.form_of(key), 1), case_forms.instance_of(key))
        for index, entry in enumerate(forms):
            filled = highest.get(entry.get("form_id")) if isinstance(entry, dict) else None
            limit = entry.get("max_instances") if filled else None
            if filled and (not entry.get("repeatable") or (isinstance(limit, int) and limit < filled)):
                forms[index] = {**entry, "repeatable": True, "max_instances": max(filled, limit if isinstance(limit, int) else 0)}
        snapshot = {**workflow, "forms": forms, "bundled_forms": bundled}
        if old and old.get("bundled_billing_template") and database.execute(
                "SELECT 1 FROM case_billing_order WHERE case_id=%s LIMIT 1", (case_id,)).fetchone():
            snapshot["bundled_billing_template"] = old["bundled_billing_template"]  # the itemize sheet already in use
        apply_on_start(database, case_id, snapshot, now_ms())
        case_audit(database, case_id, "workflow.attach", strip_bundle(old), strip_bundle(snapshot), actor)
    return case_workflow(case_id, actor, database)


# ---------------------------------------------------------------- files of file / image fields

@router.put("/{case_id}/workflow-forms-files/{sha256}")
async def put_form_file(case_id: int, sha256: str, request: Request, actor: dict = Depends(require_permission("case.chart")),
                        database: Connection = Depends(connection)) -> dict[str, Any]:
    """A file chosen in a workflow form, stored on this Leaf (content-addressed, as Form Studio) before the form refers
    to it; the sync worker sends it on to Canopy when Canopy asks for it."""
    from ..formdev.errors import FormDevError

    case = case_row(database, case_id)
    if case["status"] == "archived":
        raise HTTPException(409, "archived case is read-only")
    content = await request.body()
    media_type = (request.headers.get("content-type") or "application/octet-stream").split(";")[0].strip().lower()
    try:
        meta = case_forms.formdev_services(database).records.attachments.put(sha256, media_type, content, actor["username"])
    except FormDevError as error:
        raise HTTPException(error.status, error.message) from None
    return {"ok": True, "sha256": sha256, "size": meta["size"], "created": meta.get("created", False)}


@router.get("/{case_id}/workflow-forms-files/{sha256}")
def get_form_file(case_id: int, sha256: str, _: dict = Depends(require_permission("case.read")),
                  database: Connection = Depends(connection)) -> Response:
    """A file of this case's forms (only files its forms refer to)."""
    from ..formdev.attachments import INLINE_TYPES, refs

    case_row(database, case_id)
    used = any(sha == sha256 for row in records(database, case_id).values() for _, sha, _ in refs(row["data"] or {}))
    stored = case_forms.formdev_services(database).records.attachments.get(sha256) if used else None
    if stored is None:
        raise HTTPException(404, "file not found for this case")
    meta, content = stored
    disposition = "inline" if meta["media_type"] in INLINE_TYPES else "attachment"
    return Response(content=content, media_type=meta["media_type"], headers={
        "Content-Disposition": disposition, "X-Content-Type-Options": "nosniff", "Cache-Control": "private, max-age=3600"})
