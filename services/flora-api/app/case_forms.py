"""Workflow (Form Studio) forms of a case between Flora Leaf and Canopy, field by field in both directions.

A form copy is {data, versions, authors, status}. `versions` holds the epoch ms of the last change of every field (and
of the status, under STATUS_KEY); `authors` who made it: {by, at, via: "leaf" | "canopy", leaf_id?, reason?}. Merging
keeps the newest version of every field (form_sync.merge: a field with a version but no value was removed).

Canopy keeps one copy of every case form (canopy_case_form), keyed by the global case id, or by 'admission:<uuid>'
for a form filled for a Canopy admission before its case started. The Leaf sends the forms that changed; Canopy merges
them, writes Form Studio's record from the result and answers with a receipt per form (stored, kept as draft, not
stored and why, waiting for files) and with what changed in Canopy (amendments with a reason, admission forms) for the
Leaf to merge. Nothing is dropped with only a log line. See formdev/docs/CANOPY-LEAF-FORM-WORKFLOW.md §10.
"""
from __future__ import annotations

import hashlib
import json
import logging
import re
import uuid
from typing import Any

from psycopg import Connection
from psycopg.types.json import Jsonb

from . import form_sync

LOG = logging.getLogger("flora.case_forms")

STATUS_KEY = "__status"
STATUSES = ("draft", "completed")
REASON_MIN, REASON_MAX = 3, 500
ADMISSION_PREFIX = "admission:"

# A repeatable form (workflow entry "repeatable": true, at most "max_instances") has several copies per case: the first
# keeps the form's id, the next are "<form_id>~2", "<form_id>~3"... That key is the form_id of the copy wherever a case
# form is stored or exchanged; the form (definition, Form Studio record's form) is the part before "~".
INSTANCE_KEY = re.compile(r"^([a-z][a-z0-9_]{1,63})~([2-9]|[1-9][0-9])\Z")
MAX_INSTANCES = 99


def form_of(key: str) -> str:
    match = INSTANCE_KEY.match(key or "")
    return match.group(1) if match else key


def instance_of(key: str) -> int:
    match = INSTANCE_KEY.match(key or "")
    return int(match.group(2)) if match else 1


def workflow_entry(workflow: dict[str, Any] | None, key: str) -> dict[str, Any] | None:
    """The workflow entry of a case form key, or None: the workflow does not list the form, or the key is a further copy
    of a form that is not repeatable (or beyond its max_instances)."""
    base, number = form_of(key), instance_of(key)
    entry = next((item for item in (workflow or {}).get("forms") or []
                  if isinstance(item, dict) and item.get("form_id") == base), None)
    if entry is None or number == 1:
        return entry
    if not entry.get("repeatable"):
        return None
    limit = entry.get("max_instances")
    return entry if not isinstance(limit, int) or number <= limit else None


# ---------------------------------------------------------------- form copies (both sides)

def copy_of(data: Any, versions: Any, authors: Any, status: Any) -> dict[str, Any]:
    return {"data": dict(data or {}), "versions": {key: int(value) for key, value in (versions or {}).items()
                                                  if isinstance(value, (int, float))},
            "authors": dict(authors or {}), "status": status if status in STATUSES else "draft"}


def digest(copy: dict[str, Any]) -> str:
    """Identifies a copy (values, versions, status): a receipt for it says Canopy has this exact copy."""
    canonical = json.dumps([copy["data"], copy["versions"], copy["status"]], sort_keys=True, separators=(",", ":"), default=str)
    return hashlib.sha256(canonical.encode()).hexdigest()[:32]


def stamp(copy: dict[str, Any], data: dict[str, Any], status: str, now: int, author: dict[str, Any],
          keys: set[str] | None = None) -> dict[str, Any]:
    """The copy after a local edit: changed fields (and a changed status) get `now` and `author`."""
    versions = form_sync.stamp_changes(copy["data"], data, copy["versions"], now, keys)
    authors = dict(copy["authors"])
    for key, version in versions.items():
        if version == now and copy["versions"].get(key) != now:
            authors[key] = author
    if status != copy["status"]:
        versions[STATUS_KEY] = now
        authors[STATUS_KEY] = author
    return {"data": data, "versions": versions, "authors": authors, "status": status}


def merge(local: dict[str, Any], remote: dict[str, Any]) -> tuple[dict[str, Any], bool]:
    """The newest of every field of two copies, with its author. Returns (copy, local values changed)."""
    data_versions = {key: value for key, value in local["versions"].items() if key != STATUS_KEY}
    remote_versions = {key: value for key, value in remote["versions"].items() if key != STATUS_KEY}
    data, versions, changed = form_sync.merge(local["data"], data_versions, remote["data"], remote_versions)
    authors = dict(local["authors"])
    for key, version in remote_versions.items():
        if version > int(data_versions.get(key) or 0) and versions.get(key) == version and key in remote["authors"]:
            authors[key] = remote["authors"][key]
    status = local["status"]
    local_status, remote_status = int(local["versions"].get(STATUS_KEY) or 0), int(remote["versions"].get(STATUS_KEY) or 0)
    if remote_status > local_status:
        changed = changed or remote["status"] != status
        status = remote["status"]
        if STATUS_KEY in remote["authors"]:
            authors[STATUS_KEY] = remote["authors"][STATUS_KEY]
    if max(local_status, remote_status):
        versions[STATUS_KEY] = max(local_status, remote_status)
    return {"data": data, "versions": versions, "authors": authors, "status": status}, changed


def newest_author(copy: dict[str, Any]) -> dict[str, Any] | None:
    dated = [(int(copy["versions"].get(key) or 0), author) for key, author in copy["authors"].items() if isinstance(author, dict)]
    return max(dated, key=lambda item: item[0])[1] if dated else None


def global_case_id(hospital_id: str, leaf_id: str, case_id: Any) -> str:
    """As sync_ingest._global_case_id: the id Canopy gives a Leaf case."""
    return str(uuid.uuid5(uuid.NAMESPACE_URL, f"flora:{hospital_id}:{leaf_id}:case:{case_id}"))


# ---------------------------------------------------------------- Canopy: the copy and Form Studio's record

def _row(database: Connection, case_key: str, form_id: str) -> dict[str, Any] | None:
    return database.execute("SELECT * FROM canopy_case_form WHERE case_key=%s AND form_id=%s FOR UPDATE",
                            (case_key, form_id)).fetchone()


def _copy(row: dict[str, Any]) -> dict[str, Any]:
    return copy_of(row["data"], row["field_versions"], row["field_authors"], row["status"])


def record_id(case_key: str, form_id: str) -> str:
    """Form Studio record id: `<global_case_id>-<form-id>` as before (records written by the old snapshot ingest keep
    their id), `adm-<admission uuid>-<form-id>` before the case starts; over 64 characters a UUIDv5 of the same."""
    from .workflows import record_id_for

    base = f"adm-{case_key[len(ADMISSION_PREFIX):]}" if case_key.startswith(ADMISSION_PREFIX) else case_key
    number = instance_of(form_id)
    if number == 1:
        return record_id_for(base, form_id)
    # A further copy of a repeatable form ends in "-C<n>": capitals never come from a form id, so no other form's id.
    candidate = f"{record_id_for(base, form_of(form_id))}-C{number}"
    return candidate if len(candidate) <= 64 else str(uuid.uuid5(uuid.NAMESPACE_URL, f"flora:workflow-form:{base}:{form_id}"))


def _save(database: Connection, case_key: str, form_id: str, copy: dict[str, Any], now: int, **columns: Any) -> dict[str, Any]:
    """Insert or update the copy (and the given columns) and return the row."""
    values = {"data": Jsonb(copy["data"]), "field_versions": Jsonb(copy["versions"]), "field_authors": Jsonb(copy["authors"]),
              "status": copy["status"], "updated_at": now, **columns}
    existing = database.execute("SELECT 1 FROM canopy_case_form WHERE case_key=%s AND form_id=%s", (case_key, form_id)).fetchone()
    if existing:
        sets = ", ".join(f"{name}=%s" for name in values)
        return database.execute(f"UPDATE canopy_case_form SET {sets} WHERE case_key=%s AND form_id=%s RETURNING *",
                                (*values.values(), case_key, form_id)).fetchone()
    values.setdefault("record_id", record_id(case_key, form_id))
    values["created_at"] = now
    names = ", ".join(["case_key", "form_id", *values])
    marks = ", ".join(["%s"] * (len(values) + 2))
    return database.execute(f"INSERT INTO canopy_case_form ({names}) VALUES ({marks}) RETURNING *",
                            (case_key, form_id, *values.values())).fetchone()


def formdev_services(database: Connection) -> Any:
    from .formdev import services_for
    from .formdev.adapters.postgres import PostgreSQLAdapter

    return services_for(PostgreSQLAdapter(database))


def _issue(code: str, message: str, path: str = "$") -> dict[str, Any]:
    return {"path": path, "code": code, "message": message}


def project(database: Connection, row: dict[str, Any]) -> dict[str, Any]:
    """Write Form Studio's record from the copy. A completed form becomes a submitted record; one Form Studio would not
    accept as submitted is kept as a draft, and one it cannot accept at all is not stored: the copy stays here either
    way and the reason goes back to the Leaf. Returns {state, issues, missing_files} (also stored on the row)."""
    from .formdev.attachments import refs
    from .formdev.errors import FormDevError

    services = formdev_services(database)
    copy = _copy(row)
    author = newest_author(copy) or {}
    user = (f"{author.get('by')}@{author['leaf_id']}" if author.get("leaf_id") else str(author.get("by") or "flora"))[:120]
    updated_at = max(copy["versions"].values(), default=int(row["updated_at"]))
    missing = sorted({sha for _, sha, _ in refs(copy["data"]) if not services.records.attachments.exists(sha)})
    state, issues = "stored", []
    if missing:
        state, issues = "waiting_files", [_issue("attachment_missing", f"{len(missing)} file(s) not uploaded yet")]
    else:
        try:
            with database.transaction():  # a savepoint: a failed write leaves the exchange's transaction usable
                state, issues = _write_record(services, row, copy, user, updated_at)
        except FormDevError as error:
            state = "not_stored"
            issues = list(error.details) if error.code == "invalid_record" and error.details else [_issue(error.code, error.message)]
        except Exception as error:  # a broken definition must not stop the exchange: report it instead
            LOG.warning("case form %s/%s not written to Form Studio: %s: %s", row["case_key"], row["form_id"], type(error).__name__, error)
            state, issues = "not_stored", [_issue("internal_error", f"{type(error).__name__}: {error}")]
    database.execute("UPDATE canopy_case_form SET record_state=%s, record_issues=%s WHERE case_key=%s AND form_id=%s",
                     (state, Jsonb(issues[:50]), row["case_key"], row["form_id"]))
    return {"state": state, "issues": issues[:50], "missing_files": missing}


def _write_record(services: Any, row: dict[str, Any], copy: dict[str, Any], user: str, updated_at: int) -> tuple[str, list[Any]]:
    from .formdev.errors import FormDevError

    version = services.schemas.get_version(form_of(row["form_id"]), int(row["form_version"]))
    if version["status"] == "draft":
        raise FormDevError("form_not_published", "This form version is not published in Form Studio")
    current = services.records.get_raw(row["record_id"])
    if current is not None and current["status"] == "deleted":
        raise FormDevError("record_deleted", "The record was deleted in Form Studio")
    target = "submitted" if copy["status"] == "completed" else "draft"
    if current is not None and current["status"] == "submitted":
        target = "submitted"  # Form Studio does not reopen submitted records
    reopenable = current is None or current["status"] == "draft"
    attempts = [target, "draft"] if target == "submitted" and reopenable else [target]
    issues: list[Any] = []
    for index, attempt in enumerate(attempts):
        try:
            if current is not None and current["data"] == copy["data"] and current["status"] == attempt:
                pass
            elif current is None:
                services.records.create(form_of(row["form_id"]), copy["data"], user, status=attempt, record_id=row["record_id"],
                                        schema_version=int(row["form_version"]), updated_at=updated_at)
            else:
                services.records.update(row["record_id"], copy["data"], int(current["version"]), user,
                                        status=attempt, updated_at=updated_at)
            return ("kept_as_draft" if index else "stored"), issues
        except FormDevError as error:
            if error.code != "invalid_record" or index == len(attempts) - 1:
                raise
            issues = list(error.details or [])
    return "stored", issues


# ---------------------------------------------------------------- Canopy: the Leaf exchange (sync API)

def _case_key(item: dict[str, Any], leaf_id: str, hospital_id: str) -> str:
    handed_over = str(item.get("global_case_id") or "").strip()
    return handed_over or global_case_id(hospital_id, leaf_id, item["case_id"])


def _relink(database: Connection, admission_id: str, case_key: str, leaf_id: str, case_id: str, hn: Any, now: int) -> None:
    """Forms filled for an admission continue as the forms of the case started from it."""
    for row in database.execute("SELECT * FROM canopy_case_form WHERE case_key=%s FOR UPDATE",
                                (f"{ADMISSION_PREFIX}{admission_id}",)).fetchall():
        target = _row(database, case_key, row["form_id"])
        if target is None:
            database.execute("""UPDATE canopy_case_form SET case_key=%s, leaf_id=%s, source_case_id=%s, hn=coalesce(%s, hn),
                                  updated_at=%s WHERE case_key=%s AND form_id=%s""",
                             (case_key, leaf_id, case_id, hn, now, row["case_key"], row["form_id"]))
            continue
        merged, _ = merge(_copy(target), _copy(row))
        _save(database, case_key, row["form_id"], merged, now, canopy_rev=max(target["canopy_rev"], row["canopy_rev"]),
              admission_id=row["admission_id"])
        database.execute("DELETE FROM canopy_case_form WHERE case_key=%s AND form_id=%s", (row["case_key"], row["form_id"]))
        _retire_record(database, row["record_id"], "merged into the case's form")


def _retire_record(database: Connection, record: str, why: str) -> None:
    services = formdev_services(database)
    current = services.records.get_raw(record)
    if current is not None and current["status"] != "deleted":
        try:
            services.records.delete(record, int(current["version"]), f"flora ({why})"[:120])
        except Exception as error:
            LOG.warning("record %s not retired: %s", record, error)


def exchange(database: Connection, leaf_id: str, hospital_id: str, payload: dict[str, Any], now: int) -> dict[str, Any]:
    """One exchange with a Leaf. payload: {forms: [{case_id, global_case_id?, hn, form_id, form_version, data,
    versions, authors, status, digest}], cases: [{case_id, global_case_id?, admission_id?, hn, wants: [form_id],
    have: [form_id]}], acks: [{case_key, form_id, rev, state}]}. Returns {receipts, inbound, need_files}."""
    receipts: list[dict[str, Any]] = []
    need_files: set[str] = set()
    cases = [case for case in payload.get("cases") or [] if isinstance(case, dict) and case.get("case_id") is not None]
    with database.transaction():
        for case in cases:
            if case.get("admission_id"):
                _relink(database, str(case["admission_id"]), _case_key(case, leaf_id, hospital_id), leaf_id,
                        str(case["case_id"]), case.get("hn"), now)
        for ack in payload.get("acks") or []:
            if isinstance(ack, dict) and ack.get("case_key") and ack.get("form_id"):
                database.execute("""UPDATE canopy_case_form SET leaf_rev=greatest(leaf_rev, %s), leaf_state=%s
                                    WHERE case_key=%s AND form_id=%s""",
                                 (int(ack.get("rev") or 0), str(ack.get("state") or "applied")[:40], ack["case_key"], ack["form_id"]))
    for item in payload.get("forms") or []:
        if not isinstance(item, dict) or item.get("case_id") is None or not item.get("form_id"):
            continue
        case_key = _case_key(item, leaf_id, hospital_id)
        try:
            with database.transaction():
                row = _row(database, case_key, str(item["form_id"]))
                leaf_copy = copy_of(item.get("data"), item.get("versions"), item.get("authors"), item.get("status"))
                leaf_copy["authors"] = {key: ({**author, "leaf_id": leaf_id} if isinstance(author, dict) and author.get("via") == "leaf"
                                              and not author.get("leaf_id") else author) for key, author in leaf_copy["authors"].items()}
                merged = merge(_copy(row), leaf_copy)[0] if row else leaf_copy
                row = _save(database, case_key, str(item["form_id"]), merged, now, form_version=int(item.get("form_version") or 0),
                            hn=item.get("hn") or (row or {}).get("hn"), leaf_id=leaf_id, source_case_id=str(item["case_id"]))
                result = project(database, row)
        except Exception as error:
            LOG.warning("case form %s/%s from %s not taken: %s: %s", case_key, item.get("form_id"), leaf_id, type(error).__name__, error)
            receipts.append({"case_id": item["case_id"], "form_id": item["form_id"], "digest": None, "state": "not_stored",
                             "issues": [_issue("internal_error", f"{type(error).__name__}: {error}")]})
            continue
        need_files.update(result["missing_files"])
        receipts.append({"case_id": item["case_id"], "form_id": item["form_id"], "digest": item.get("digest"),
                         "state": result["state"], "issues": result["issues"], "record_id": row["record_id"]})
    # Forms waiting for files: the files may have arrived since (the worker uploads them right after an exchange).
    with database.transaction():
        for row in database.execute("SELECT * FROM canopy_case_form WHERE leaf_id=%s AND record_state='waiting_files' FOR UPDATE",
                                    (leaf_id,)).fetchall():
            result = project(database, row)
            need_files.update(result["missing_files"])
    return {"receipts": receipts, "inbound": inbound(database, leaf_id, hospital_id, cases), "need_files": sorted(need_files)}


def inbound(database: Connection, leaf_id: str, hospital_id: str, cases: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Canopy's copies the Leaf has to merge: changed in Canopy since the Leaf last confirmed, or forms of the case's
    workflow the Leaf has no record of yet (e.g. filled for the admission, or after a workflow was attached)."""
    out = []
    for case in cases:
        case_key = _case_key(case, leaf_id, hospital_id)
        wants, have = set(case.get("wants") or []), set(case.get("have") or [])
        for row in database.execute("SELECT * FROM canopy_case_form WHERE case_key=%s ORDER BY form_id", (case_key,)).fetchall():
            missing_here = row["form_id"] in wants and row["form_id"] not in have and bool(row["data"])
            if row["canopy_rev"] > row["leaf_rev"] or missing_here:
                out.append({"case_id": case["case_id"], "case_key": case_key, "form_id": row["form_id"],
                            "form_version": row["form_version"], "data": row["data"], "versions": row["field_versions"],
                            "authors": row["field_authors"], "status": row["status"], "rev": row["canopy_rev"]})
    return out


# ---------------------------------------------------------------- Canopy: changes made in Canopy

def _check_reason(reason: Any) -> str:
    from .formdev.errors import FormDevError

    text = str(reason or "").strip()
    if not REASON_MIN <= len(text) <= REASON_MAX:
        raise FormDevError("amendment_reason_required",
                           f"This form was filled on Flora Leaf: give a reason for the change ({REASON_MIN}-{REASON_MAX} characters)", 422)
    return text


def amend(database: Connection, op: dict[str, Any], user: str, now: int, current: dict[str, Any] | None = None) -> dict[str, Any] | None:
    """A Form Studio change to a record that is a Leaf case form (SyncService hook): an amendment with a reason, merged
    field by field and sent back to the Leaf. None when the record is not a case form (Form Studio handles it).

    The change is what the user edited: the fields where the operation differs from the record version it was based on
    (`current`, or its revision `base_version`). Only those fields are applied to Canopy's copy, so editing a record
    that is behind the Leaf never puts older values back."""
    from .formdev.errors import FormDevError
    from .formdev.logic.evaluate import evaluate_record

    row = database.execute("SELECT * FROM canopy_case_form WHERE record_id=%s FOR UPDATE", (op["record_id"],)).fetchone()
    if row is None:
        return None
    if op["kind"] != "update":
        raise FormDevError("leaf_form", "Forms filled on Flora Leaf are completed or removed on the Leaf; Canopy can amend values", 409)
    reason = _check_reason(op.get("reason"))
    edited = op.get("data") if isinstance(op.get("data"), dict) else {}
    copy = _copy(row)
    services = formdev_services(database)
    base = current or services.records.get_raw(row["record_id"]) or {}
    if op.get("base_version") and base.get("version") != op["base_version"]:
        base = services.adapter.get_revision(row["record_id"], int(op["base_version"])) or base
    seen = base.get("data") or {}
    touched = {key for key in set(edited) | set(seen) if edited.get(key) != seen.get(key) or (key in edited) != (key in seen)}
    signed = sorted(key for key in touched if isinstance(copy["data"].get(key), dict) and copy["data"][key].get("verified") == "pin")
    if signed:
        raise FormDevError("signature_locked", f"Signed on the Leaf with a PIN, so it cannot be changed here: {', '.join(signed)}", 409)
    data = {key: value for key, value in copy["data"].items() if key not in touched}
    data.update({key: edited[key] for key in touched if key in edited})
    definition = services.schemas.get_version(form_of(row["form_id"]), int(row["form_version"]))["definition"]
    result = evaluate_record(definition, data, "draft", lookups=services.lookups.tables(_lookup_ids(definition)))
    if result.issues:
        raise FormDevError("invalid_record", "Record data is not valid", 422, [issue.as_dict() for issue in result.issues])
    # Only what the user changed is the amendment (with its checked value). Values the rules derive from it
    # (calculations, hidden fields cleared) are not the reviewer's: Form Studio's record and the Leaf derive them.
    data = dict(copy["data"])
    for key in touched:
        if key in result.data:
            data[key] = result.data[key]
        else:
            data.pop(key, None)
    changed = {key: {"from": copy["data"].get(key), "to": data.get(key)} for key in touched
               if copy["data"].get(key) != data.get(key) or (key in copy["data"]) != (key in data)}
    if changed:
        author = {"by": user, "at": now, "via": "canopy", "reason": reason}
        updated = stamp(copy, data, copy["status"], now, author, set(changed))
        row = _save(database, row["case_key"], row["form_id"], updated, now, canopy_rev=now)
        database.execute("""INSERT INTO canopy_case_form_amendment (case_key, form_id, record_id, changes, reason, amended_by, amended_at)
                            VALUES (%s,%s,%s,%s,%s,%s,%s)""",
                         (row["case_key"], row["form_id"], row["record_id"], Jsonb(changed), reason, user, now))
    projected = project(database, row)
    if projected["state"] == "not_stored":
        raise FormDevError("invalid_record", "Form Studio cannot store the amended form", 422, projected["issues"])
    record = services.records.get_raw(row["record_id"])
    return {"op_id": op["op_id"], "record_id": row["record_id"], "status": "applied", "record": record,
            "amended_fields": sorted(changed)}


def _lookup_ids(definition: dict[str, Any]) -> set[str]:
    from .formdev.logic.lookup import lookup_ids

    return lookup_ids(definition)


def available(connection: Any) -> bool:
    """Whether this Form Studio connection holds Leaf case forms (Canopy's PostgreSQL; not another storage)."""
    if not isinstance(connection, Connection):
        return False
    try:
        return connection.execute("SELECT to_regclass('canopy_case_form') AS t").fetchone()["t"] is not None
    except Exception:
        return False


def amendments(database: Connection, row: dict[str, Any]) -> list[dict[str, Any]]:
    rows = database.execute(
        """SELECT changes, reason, amended_by, amended_at FROM canopy_case_form_amendment
           WHERE case_key=%s AND form_id=%s ORDER BY amended_at DESC, id DESC LIMIT 200""", (row["case_key"], row["form_id"])).fetchall()
    return [{"changes": item["changes"], "reason": item["reason"], "by": item["amended_by"], "at": item["amended_at"]} for item in rows]


def amender(connection: Any) -> Any:
    """The SyncService hook for a Form Studio connection, or None where there are no Leaf case forms (another storage)."""
    if not available(connection):
        return None
    from .directory import now_ms

    def hook(op: dict[str, Any], user: str, current: dict[str, Any]) -> dict[str, Any] | None:
        return amend(connection, op, user, now_ms(), current)

    return hook


def admission_forms(database: Connection, admission_id: str) -> dict[str, dict[str, Any]]:
    rows = database.execute("SELECT * FROM canopy_case_form WHERE admission_id=%s", (admission_id,)).fetchall()
    return {row["form_id"]: public(row) for row in rows}


def patch_admission_form(database: Connection, admission: dict[str, Any], form_id: str, form_version: int,
                         patch: dict[str, Any], user: str, now: int, reason: str | None = None) -> dict[str, Any]:
    """Fill a workflow form for an admission, before (or after) its case started on a Leaf: changed fields only, each
    stamped, so the Leaf merges them field by field. Changing a field last filled on the Leaf is an amendment: it needs
    a reason and is recorded with it."""
    row = database.execute("SELECT * FROM canopy_case_form WHERE admission_id=%s AND form_id=%s FOR UPDATE",
                           (admission["id"], form_id)).fetchone()
    case_key = row["case_key"] if row else f"{ADMISSION_PREFIX}{admission['id']}"
    copy = _copy(row) if row else copy_of({}, {}, {}, "draft")
    data = {**copy["data"], **patch}
    changed = {key: {"from": copy["data"].get(key), "to": data.get(key)} for key in patch
               if copy["data"].get(key) != data.get(key) or (key in copy["data"]) != (key in data)}
    from_leaf = sorted(key for key in changed if (copy["authors"].get(key) or {}).get("via") == "leaf")
    author: dict[str, Any] = {"by": user, "at": now, "via": "canopy"}
    if from_leaf:
        author["reason"] = _check_reason(reason)
    updated = stamp(copy, data, copy["status"], now, author, set(patch))
    row = _save(database, case_key, form_id, updated, now, canopy_rev=now if changed else (row or {}).get("canopy_rev", 0),
                admission_id=admission["id"], hn=admission.get("hn"), form_version=int((row or {}).get("form_version") or form_version))
    if from_leaf:
        database.execute("""INSERT INTO canopy_case_form_amendment (case_key, form_id, record_id, changes, reason, amended_by, amended_at)
                            VALUES (%s,%s,%s,%s,%s,%s,%s)""",
                         (case_key, form_id, row["record_id"], Jsonb({key: changed[key] for key in from_leaf}), author["reason"], user, now))
    project(database, row)
    return public(database.execute("SELECT * FROM canopy_case_form WHERE case_key=%s AND form_id=%s",
                                   (case_key, form_id)).fetchone())


# ---------------------------------------------------------------- Canopy: review (Reviewed → Approved)

REVIEW_ACTIONS = ("reviewed", "approved")


def review_status(row: dict[str, Any]) -> dict[str, Any]:
    """The review as it stands: a review holds for the copy reviewed; any change since makes it changed_since_review."""
    state = row.get("review_state") or "none"
    if state != "none" and row.get("review_digest") != digest(_copy(row)):
        state = "changed_since_review"
    return {"state": state, "reviewedBy": row.get("reviewed_by"), "reviewedAt": row.get("reviewed_at"),
            "approvedBy": row.get("approved_by"), "approvedAt": row.get("approved_at")}


def review(database: Connection, case_key: str, form_id: str, action: str, user: str, note: str | None, now: int) -> dict[str, Any]:
    """Mark a case form reviewed, or approve a reviewed one. Only a form completed on the Leaf is reviewed; only a
    reviewed form not changed since is approved. Each action is kept (canopy_case_form_review)."""
    from .formdev.errors import FormDevError

    row = _row(database, case_key, form_id)
    if row is None:
        raise FormDevError("form_not_found", "This case has no such form", 404)
    if action not in REVIEW_ACTIONS:
        raise FormDevError("invalid_action", "action is reviewed or approved")
    if row["status"] != "completed":
        raise FormDevError("form_not_completed", "The form is still being filled on the Leaf: review it once it is completed", 409)
    current = digest(_copy(row))
    if action == "approved" and review_status(row)["state"] != "reviewed":
        raise FormDevError("not_reviewed", "Only a reviewed form, unchanged since its review, can be approved", 409)
    if action == "reviewed":
        database.execute("""UPDATE canopy_case_form SET review_state='reviewed', review_digest=%s, reviewed_by=%s, reviewed_at=%s,
                              approved_by=NULL, approved_at=NULL WHERE case_key=%s AND form_id=%s""",
                         (current, user, now, case_key, form_id))
    else:
        database.execute("""UPDATE canopy_case_form SET review_state='approved', approved_by=%s, approved_at=%s
                            WHERE case_key=%s AND form_id=%s""", (user, now, case_key, form_id))
    database.execute("""INSERT INTO canopy_case_form_review (case_key, form_id, action, digest, note, acted_by, acted_at)
                        VALUES (%s,%s,%s,%s,%s,%s,%s)""",
                     (case_key, form_id, action, current, (note or "").strip()[:500] or None, user, now))
    return database.execute("SELECT * FROM canopy_case_form WHERE case_key=%s AND form_id=%s", (case_key, form_id)).fetchone()


def history(database: Connection, row: dict[str, Any]) -> list[dict[str, Any]]:
    """What happened to a case form, newest first: every version of its Form Studio record (who, when, which fields
    changed from what to what), the amendments with their reasons and the review actions."""
    out: list[dict[str, Any]] = []
    services = formdev_services(database)
    try:
        revisions = sorted(services.adapter.list_revisions(row["record_id"]), key=lambda item: int(item["version"]))
    except Exception:
        revisions = []
    previous: dict[str, Any] = {}
    for revision in revisions:
        data = revision.get("data") or {}
        changes = {key: {"from": previous.get(key), "to": data.get(key)} for key in sorted(set(previous) | set(data))
                   if previous.get(key) != data.get(key)}
        out.append({"kind": "version", "at": revision["updated_at"], "by": revision["updated_by"], "version": revision["version"],
                    "status": revision["status"], "changes": changes})
        previous = data
    for item in amendments(database, row):
        out.append({"kind": "amendment", "at": item["at"], "by": item["by"], "reason": item["reason"], "changes": item["changes"]})
    for item in database.execute("""SELECT action, note, acted_by, acted_at FROM canopy_case_form_review
                                    WHERE case_key=%s AND form_id=%s ORDER BY acted_at""", (row["case_key"], row["form_id"])).fetchall():
        out.append({"kind": item["action"], "at": item["acted_at"], "by": item["acted_by"], "note": item["note"]})
    return sorted(out, key=lambda item: int(item["at"] or 0), reverse=True)


def public(row: dict[str, Any]) -> dict[str, Any]:
    return {"caseKey": row["case_key"], "formId": row["form_id"], "form": form_of(row["form_id"]), "instance": instance_of(row["form_id"]),
            "formVersion": row["form_version"], "hn": row["hn"],
            "admissionId": str(row["admission_id"]) if row["admission_id"] else None, "leafId": row["leaf_id"],
            "sourceCaseId": row["source_case_id"], "data": row["data"], "status": row["status"], "authors": row["field_authors"],
            "recordId": row["record_id"], "recordState": row["record_state"], "recordIssues": row["record_issues"],
            "leafState": row["leaf_state"], "pendingToLeaf": row["canopy_rev"] > row["leaf_rev"], "updatedAt": row["updated_at"],
            "review": review_status(row)}


def links(database: Connection, form_id: str) -> dict[str, dict[str, Any]]:
    """Form Studio records of a form that are Leaf case forms: {record_id: link} (Records sheet, record editor)."""
    rows = database.execute("SELECT * FROM canopy_case_form WHERE split_part(form_id, '~', 1) = %s", (form_id,)).fetchall()
    out = {}
    for row in rows:
        link = public(row)
        link.pop("data")
        out[row["record_id"]] = link
    return out


# ---------------------------------------------------------------- Leaf: case_form_record

def leaf_copy(row: dict[str, Any]) -> dict[str, Any]:
    copy = copy_of(row["data"], row["field_versions"], row.get("field_authors"), row["status"])
    if STATUS_KEY not in copy["versions"] and copy["status"] == "completed":
        copy["versions"][STATUS_KEY] = int(row["updated_at"])  # completed before statuses carried a version
    return copy


def leaf_issues(database: Connection, definition: dict[str, Any], data: dict[str, Any]) -> list[dict[str, Any]]:
    """What Form Studio would refuse in a completed form (the same rules Canopy applies), and files not stored here."""
    from .formdev.logic.evaluate import evaluate_record

    result = evaluate_record(definition, data, "submitted")
    issues = list(result.issues) + formdev_services(database).records.attachments.missing(result.data)
    return [issue.as_dict() for issue in issues]


OUTBOX_FORMS = 200   # per exchange; the worker repeats while `more` (Canopy takes at most 500)
OUTBOX_CASES = 400


def leaf_outbox(database: Connection, now: int, limit_forms: int = OUTBOX_FORMS, limit_cases: int = OUTBOX_CASES) -> dict[str, Any]:
    """The case forms Canopy has not acknowledged as they are now (however old the case: an archived case's forms are
    sent until Canopy has them), at most `limit_forms` (`more` when there are others), and the open cases with the forms
    their workflow lists (at most `limit_cases`, active first), so Canopy can send forms filled there."""
    cases = database.execute(
        """SELECT c.id, c.hn, c.status, c.workflow, c.canopy_admission_id, c.handover_global_case_id FROM cases c
           WHERE c.status <> 'archived'
              OR EXISTS (SELECT 1 FROM case_form_record f WHERE f.case_id = c.id
                         AND (f.synced_at IS NULL OR f.updated_at > f.synced_at OR f.sync_state = 'waiting_files'))
           ORDER BY (c.status = 'active') DESC, c.id DESC""").fetchall()
    forms, listed, more = [], [], False
    for case in cases:
        rows = database.execute("SELECT * FROM case_form_record WHERE case_id=%s ORDER BY form_id", (case["id"],)).fetchall()
        wants = [entry["form_id"] for entry in ((case["workflow"] or {}).get("forms") or [])
                 if isinstance(entry, dict) and entry.get("form_id")]
        global_id = str(case["handover_global_case_id"]) if case.get("handover_global_case_id") else None
        if case["status"] != "archived" and (rows or wants) and len(listed) < limit_cases:
            listed.append({"case_id": case["id"], "global_case_id": global_id, "hn": case["hn"],
                           "admission_id": str(case["canopy_admission_id"]) if case.get("canopy_admission_id") else None,
                           "wants": wants, "have": [row["form_id"] for row in rows]})
        for row in rows:
            copy = leaf_copy(row)
            current = digest(copy)
            if row.get("sent_digest") == current and row.get("sync_state") != "waiting_files":
                continue
            if len(forms) >= limit_forms:
                more = True
                break
            forms.append({"case_id": case["id"], "global_case_id": global_id, "hn": case["hn"], "form_id": row["form_id"],
                          "form_version": row["form_version"], **copy, "digest": current})
    return {"forms": forms, "cases": listed, "more": more}


def leaf_inbox(database: Connection, payload: dict[str, Any], now: int) -> dict[str, Any]:
    """Receipts for what the Leaf sent, then Canopy's changes merged field by field. Returns the acks for Canopy."""
    from .clinical import case_audit

    received, applied, acks = 0, 0, []
    with database.transaction():
        for receipt in payload.get("receipts") or []:
            if not isinstance(receipt, dict) or receipt.get("state") not in {"stored", "kept_as_draft", "not_stored", "waiting_files"}:
                continue
            row = database.execute("SELECT * FROM case_form_record WHERE case_id=%s AND form_id=%s FOR UPDATE",
                                   (receipt.get("case_id"), receipt.get("form_id"))).fetchone()
            if row is None:
                continue
            # The receipt is for the copy sent; if the form changed since, it stays to be sent (synced_at not moved).
            current = receipt.get("digest") is not None and receipt["digest"] == digest(leaf_copy(row))
            done = current and receipt["state"] != "waiting_files"
            database.execute(
                """UPDATE case_form_record SET sync_state=%s, sync_issues=%s, canopy_record_id=coalesce(%s, canopy_record_id),
                     synced_at=CASE WHEN %s THEN %s ELSE synced_at END, sent_digest=CASE WHEN %s THEN %s ELSE sent_digest END
                   WHERE case_id=%s AND form_id=%s""",
                (receipt["state"], Jsonb((receipt.get("issues") or [])[:50]), receipt.get("record_id"),
                 done, now, done, receipt.get("digest"), row["case_id"], row["form_id"]))
            received += 1
    for item in payload.get("inbound") or []:
        if not isinstance(item, dict) or item.get("case_id") is None or not item.get("form_id"):
            continue
        ack = {"case_key": item.get("case_key"), "form_id": item["form_id"], "rev": int(item.get("rev") or 0)}
        with database.transaction():
            case = database.execute("SELECT id, status, workflow FROM cases WHERE id=%s FOR UPDATE", (item["case_id"],)).fetchone()
            entry = workflow_entry((case or {}).get("workflow"), str(item["form_id"]))
            if case is None or case["status"] == "archived":
                acks.append({**ack, "state": "case_closed"})
                continue
            if entry is None:
                acks.append({**ack, "state": "not_in_workflow"})
                continue
            row = database.execute("SELECT * FROM case_form_record WHERE case_id=%s AND form_id=%s FOR UPDATE",
                                   (case["id"], item["form_id"])).fetchone()
            remote = copy_of(item.get("data"), item.get("versions"), item.get("authors"), item.get("status"))
            local = leaf_copy(row) if row else copy_of({}, {}, {}, "draft")
            merged, changed = merge(local, remote)
            echo = digest(merged) if digest(merged) == digest(remote) else None  # Canopy holds exactly this copy
            first = newest_author(remote) or {}
            database.execute(
                """INSERT INTO case_form_record (case_id, form_id, form_version, data, field_versions, field_authors, status,
                     updated_at, updated_by, created_at, created_by, sent_digest)
                   VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
                   ON CONFLICT (case_id, form_id) DO UPDATE SET data=excluded.data, field_versions=excluded.field_versions,
                     field_authors=excluded.field_authors, status=excluded.status, updated_at=excluded.updated_at,
                     updated_by=excluded.updated_by, sent_digest=coalesce(excluded.sent_digest, case_form_record.sent_digest)""",
                (case["id"], item["form_id"], int((row or {}).get("form_version") or entry["version"]), Jsonb(merged["data"]),
                 Jsonb(merged["versions"]), Jsonb(merged["authors"]), merged["status"], now,
                 (row or {}).get("updated_by") if not changed else f"canopy:{first.get('by') or 'sync'}"[:120],
                 now, str(first.get("by") or "canopy")[:120], echo))
            if changed:
                case_audit(database, case["id"], f"workflow_form.canopy:{item['form_id']}",
                           {"data": local["data"], "status": local["status"]}, {"data": merged["data"], "status": merged["status"]},
                           {"username": f"canopy:{first.get('by') or 'sync'}"[:120], "role": "integration"})
                applied += 1
            acks.append({**ack, "state": "applied"})
    return {"ok": True, "receipts": received, "applied": applied, "acks": acks}
