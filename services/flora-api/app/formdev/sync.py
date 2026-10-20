"""Server side of the offline sync protocol (Local -> Sync Queue -> Server -> Acknowledge).

Every queued change is an *operation* with a client-generated ``op_id``. Applying an
operation and storing its acknowledgement happen in one transaction, so:

- resending an op (lost ack, retry after crash) returns the stored ack: idempotent;
- a failure before commit stores nothing, so the client simply retries;
- validation problems are acknowledged as ``rejected`` and never retried.
"""
from __future__ import annotations

import uuid
from typing import Any, Callable

from .adapters.base import DataAdapter
from .conflict import ConflictResolver, LastWriteWins
from .errors import FormDevError
from .logic.permission import OTHER_KEY, mask
from .repositories import MAX_CLOCK_SKEW_MS, RecordRepository, now_ms

OP_KINDS = ("create", "update", "submit", "delete")
MAX_BATCH = 100


def _public(record: dict[str, Any] | None) -> dict[str, Any] | None:
    if record is None:
        return None
    keys = ("record_id", "form_id", "schema_version", "status", "data", "created_at", "created_by", "updated_at", "updated_by", "sync_id", "version")
    return {key: record.get(key) for key in keys}


def _check_op(op: Any) -> None:
    if not isinstance(op, dict):
        raise FormDevError("invalid_op", "Operation must be an object")
    if not isinstance(op.get("op_id"), str) or not 8 <= len(op["op_id"]) <= 64:
        raise FormDevError("invalid_op", "op_id must be a string of 8-64 characters")
    if op.get("kind") not in OP_KINDS:
        raise FormDevError("invalid_op", f"kind must be one of {', '.join(OP_KINDS)}")
    if not isinstance(op.get("record_id"), str):
        raise FormDevError("invalid_op", "record_id is required")
    if op["kind"] != "create" and not isinstance(op.get("base_version"), int):
        raise FormDevError("invalid_op", "base_version is required for update, submit and delete")
    if op["kind"] in ("create", "update", "submit") and not isinstance(op.get("data"), dict):
        raise FormDevError("invalid_op", "data is required")


def _keep(incoming: dict[str, Any], stored: dict[str, Any], fixed: set[str]) -> dict[str, Any]:
    """`incoming` with the `fixed` keys (and their Other text) taken from `stored`."""
    if not fixed:
        return incoming
    out = {k: v for k, v in incoming.items() if k not in fixed and k != OTHER_KEY}
    out.update({k: v for k, v in stored.items() if k in fixed and k != OTHER_KEY})
    other = {k: v for k, v in (incoming.get(OTHER_KEY) or {}).items() if k not in fixed} if isinstance(incoming.get(OTHER_KEY), dict) else {}
    other.update({k: v for k, v in (stored.get(OTHER_KEY) or {}).items() if k in fixed} if isinstance(stored.get(OTHER_KEY), dict) else {})
    if other:
        out[OTHER_KEY] = other
    return out


class SyncService:
    def __init__(self, adapter: DataAdapter, records: RecordRepository, resolver: ConflictResolver | None = None):
        self.adapter = adapter
        self.records = records
        self.resolver = resolver or LastWriteWins()

    def apply(self, ops: list[Any], user: str, protected: Callable[[str], set[str]] | None = None,
              locked: Callable[[str], set[str]] | None = None, allows: Callable[..., bool] | None = None,
              present: Callable[[dict[str, Any]], dict[str, Any]] | None = None,
              linked: Callable[[dict[str, Any], str, dict[str, Any]], dict[str, Any] | None] | None = None) -> list[dict[str, Any]]:
        """protected(form_id) -> fields the writer may not read; they are removed from acknowledgements.
        locked(form_id) -> fields the writer may not change (defaults to protected): their stored values are kept
        on update and they are dropped on create. allows(form_id, action) gates create / edit / delete; a refused
        operation is acknowledged as rejected with ``forbidden``; it is called as allows(form_id, action, current)
        with the stored record for edit / delete. present(record) -> the record as the caller may see it in an
        acknowledgement (masked, or without data when the caller may not read it); it replaces masking by protected.
        linked(op, user, current) handles a change to a record kept elsewhere (a Flora Leaf case form: an amendment with
        a reason, app/case_forms.py) after the access checks; it returns the acknowledgement, or None for an ordinary
        record, and raises FormDevError to reject the operation."""
        if not isinstance(ops, list) or len(ops) > MAX_BATCH:
            raise FormDevError("invalid_batch", f"Send between 1 and {MAX_BATCH} operations")
        self._protected, self._locked, self._allows, self._linked = protected, locked, allows, linked
        try:
            acks = [self.apply_one(op, user) for op in ops]
        finally:
            self._protected = self._locked = self._allows = self._linked = None
        if present is not None:
            return [{**ack, "record": present(ack["record"])} if ack.get("record") else ack for ack in acks]
        return [self._mask_ack(ack, protected) for ack in acks] if protected else acks

    _protected: Callable[[str], set[str]] | None = None
    _locked: Callable[[str], set[str]] | None = None
    _allows: Callable[[str, str], bool] | None = None
    _linked: Callable[[dict[str, Any], str, dict[str, Any]], dict[str, Any] | None] | None = None

    def _hidden(self, form_id: str | None) -> set[str]:
        return self._protected(form_id) if self._protected and form_id else set()

    def _fixed(self, form_id: str | None) -> set[str]:
        if self._locked and form_id:
            return self._locked(form_id)
        return self._hidden(form_id)

    def _require(self, form_id: str, action: str, current: dict[str, Any] | None = None) -> None:
        if self._allows and not self._allows(form_id, action, current):
            raise FormDevError("forbidden", f"You may not {action} records of this form", 403)

    @staticmethod
    def _mask_ack(ack: dict[str, Any], protected: Callable[[str], set[str]]) -> dict[str, Any]:
        record = ack.get("record")
        hidden = protected(record["form_id"]) if record and record.get("form_id") else set()
        if not hidden:
            return ack
        return {**ack, "record": {**record, "data": mask(record.get("data") or {}, hidden)}}

    def apply_one(self, op: Any, user: str) -> dict[str, Any]:
        try:
            _check_op(op)
        except FormDevError as error:
            return {"op_id": op.get("op_id") if isinstance(op, dict) else None, "status": "rejected", "error": error.as_dict()}
        receipt = self.adapter.get_sync_receipt(op["op_id"])
        if receipt is not None:
            return {**receipt["result"], "duplicate": True}
        with self.adapter.transaction():
            try:
                with self.adapter.transaction():
                    ack = self._apply(op, user)
            except FormDevError as error:
                ack = {"op_id": op["op_id"], "record_id": op["record_id"], "status": "rejected", "error": error.as_dict()}
            self.adapter.insert_sync_receipt({"op_id": op["op_id"], "record_id": op["record_id"], "result": ack, "processed_at": now_ms()})
        return ack

    def _write(self, op: dict[str, Any], user: str, expected_version: int, edited_at: int) -> dict[str, Any]:
        common = {"updated_at": edited_at, "sync_id": op["op_id"]}
        current = self.records.get_raw(op["record_id"])
        if op["kind"] == "delete":
            return self.records.delete(op["record_id"], expected_version, user, **common)
        status = "submitted" if op["kind"] == "submit" else op.get("status")
        data = op["data"]
        fixed = self._fixed(current["form_id"])
        if fixed:
            data = _keep(data, current["data"], fixed)
        return self.records.update(op["record_id"], data, expected_version, user, status=status, **common)

    def _apply(self, op: dict[str, Any], user: str) -> dict[str, Any]:
        # Client edit time drives last-write-wins; clamp it so a fast client clock cannot always win.
        edited_at = min(int(op.get("client_updated_at") or now_ms()), now_ms() + MAX_CLOCK_SKEW_MS)
        current = self.records.get_raw(op["record_id"])
        if current is None:
            if op["kind"] != "create":
                raise FormDevError("record_not_found", f"Record '{op['record_id']}' does not exist on the server", 404)
            self._require(op["form_id"], "create")
            fixed = self._fixed(op["form_id"])
            record = self.records.create(
                op["form_id"], _keep(op["data"], {}, fixed), user, status=op.get("status") or "draft", record_id=op["record_id"],
                schema_version=op.get("schema_version"), updated_at=edited_at, sync_id=op["op_id"],
            )
            return {"op_id": op["op_id"], "record_id": record["record_id"], "status": "applied", "record": _public(record)}

        # Before any version comparison: a caller who may not change this record learns nothing about it.
        self._require(current["form_id"], "delete" if op["kind"] == "delete" else "edit", current)
        if self._linked is not None:
            fixed = self._fixed(current["form_id"])
            guarded = {**op, "data": _keep(op["data"], current["data"], fixed)} if isinstance(op.get("data"), dict) else op
            handled = self._linked(guarded, user, current)
            if handled is not None:
                return {**handled, "record": _public(handled.get("record"))}
        base_version = int(op.get("base_version") or 0)
        if current["version"] == base_version:
            record = self._write(op, user, base_version, edited_at)
            return {"op_id": op["op_id"], "record_id": record["record_id"], "status": "applied", "record": _public(record)}

        base = self.adapter.get_revision(op["record_id"], base_version) if base_version else None
        local = {"data": op.get("data"), "status": op.get("status"), "updated_at": edited_at, "kind": op["kind"]}
        resolution = self.resolver.resolve(base, local, current)
        self.adapter.insert_conflict({
            "conflict_id": str(uuid.uuid4()), "record_id": op["record_id"], "op_id": op["op_id"],
            "strategy": self.resolver.name, "resolution": f"{resolution.winner}_wins",
            "base_version": base_version, "server_version": current["version"],
            "local_data": op.get("data"), "server_data": current["data"], "created_at": now_ms(),
        })
        conflict = {"strategy": self.resolver.name, "resolution": f"{resolution.winner}_wins", "base_version": base_version, "server_version": current["version"], "reason": resolution.reason}
        if resolution.winner == "local":
            record = self._write(op, user, current["version"], edited_at)
            return {"op_id": op["op_id"], "record_id": record["record_id"], "status": "applied", "record": _public(record), "conflict": conflict}
        return {"op_id": op["op_id"], "record_id": op["record_id"], "status": "conflict", "record": _public(current), "conflict": conflict}
