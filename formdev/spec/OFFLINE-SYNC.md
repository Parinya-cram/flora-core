# Offline storage and sync (Phase 3.5 – 3.8)

```
UI → RecordRepository → IndexedDB (records + sync_queue, one transaction)
                              ↓ SyncEngine (ordered, retry/backoff)
                        POST /api/formdev/sync  →  SyncService (one transaction per op)
                              ↑ acknowledgement (applied / conflict / rejected)
```

## Local storage (3.5)

| Environment | Store | Notes |
| --- | --- | --- |
| Browser / Electron renderer | IndexedDB `flora-formdev:<username>` | One database per signed-in user |
| Standalone server (desktop, LAN, no PostgreSQL) | SQLite file via `FORMDEV_STORAGE=sqlite:/path/formdev.db` | Same API, WAL journal |
| Existing MySQL server (8.0.19+ / 8.4) | `FORMDEV_STORAGE=mysql://user:password@host:3306/database` (needs `PyMySQL[rsa]`) | Same API and query engine; schema created on first start (`mysql_schema.sql`, utf8mb4_bin) |
| Simplest standalone (small, readable files) | Folder of JSON files via `FORMDEV_STORAGE=json:/path/folder` | Same API; one JSON file per table, written atomically after each commit; whole data set in memory; one process |

**Attachments.** Picking a file keeps its bytes in IndexedDB (`attachments` store) and puts `{name, mime, size,
ref: "att:<sha256>"}` in the record. Before pushing ops, sync uploads every referenced file the server has not
received (`PUT /attachments/{sha256}`); if an upload fails the ops wait, so the server never sees a record whose
file is missing (it would refuse it with `attachment_missing`). Files of records pulled from the server are read
through the record (`GET /attachments/{sha256}?record_id=`).

Offline operations: create, read, update, delete (soft), search (indexed fields, keyset pagination),
save draft, submit. Every write validates with the same rules as the server
(`frontend/src/formdev/core/validate.ts`, fixture-tested against the Python validator).
Published forms, the style and font registry are cached locally by `pullCatalog`, so forms can be filled
after the first successful load even when the server is unreachable.

## Sync queue (3.6)

Each local change is written **in the same IndexedDB transaction** as its queue item, so a saved change
always has a queued operation, and both survive closing the application.

| State | Meaning |
| --- | --- |
| `pending` | Waiting to be sent (`next_attempt_at` honours backoff) |
| `processing` | Sent, waiting for the acknowledgement. Reset to `pending` on start-up (crash recovery) |
| `success` | Acknowledged as applied (including duplicates) |
| `failed` | Rejected by the server (final) or retries exhausted (can be requeued with "Retry failed") |
| `conflict` | Server copy won; the local change is kept in the queue item for review |

## Operation and acknowledgement

```json
{ "op_id": "uuid", "kind": "create|update|submit|delete", "record_id": "uuid", "form_id": "patient_assessment",
  "schema_version": 1, "base_version": 2, "data": { }, "status": "draft", "client_updated_at": 1791204280000 }
```

```json
{ "op_id": "uuid", "record_id": "uuid", "status": "applied|conflict|rejected", "duplicate": true,
  "record": { "...server copy..." }, "conflict": { "strategy": "last-write-wins", "resolution": "local_wins" },
  "error": { "code": "invalid_record", "message": "..." } }
```

## Sync rules (3.7)

- **Order**: ops are sent in queue order and at most one op per record per round, so changes to a record
  arrive in the order they were made. Other records are not blocked by one record's backoff.
- **Rebase**: when an op is acknowledged, the next queued op of that record is rebased onto the server's
  version, so a chain of offline edits does not conflict with itself.
- **Retry + backoff**: network errors, timeouts, 401, 408, 429 and 5xx keep the op `pending` with
  `delay = min(maxDelay, base · 2^(attempt-1)) · (0.5…1.0 jitter)` (defaults 2 s base, 5 min cap, 8 attempts).
  "Sync now" forces an immediate attempt. Other 4xx are final.
- **Idempotency**: an op keeps its `op_id` forever. The server stores the acknowledgement in
  `formdev_sync_receipt` in the same transaction that applies the op; a resent op returns the stored ack
  (`duplicate: true`) and changes nothing.
- **Failure recovery**: a crash before the server commits stores nothing, so the retry applies normally;
  a crash after commit but before the client saw the ack is resolved by the receipt. Ops left in
  `processing` are reset to `pending` on start-up. Validation problems are acknowledged as `rejected`
  once and never retried.

## Conflict resolution (3.8)

A conflict is any op whose `base_version` differs from the server's current version. Every conflict is
logged in `formdev_conflict` with both sides' data.

- **last-write-wins** (enabled): the later *edit time* wins (`client_updated_at` vs the server copy's
  `updated_at`); ties keep the server copy. Client times more than 5 minutes ahead of the server are clamped.
  - local wins → applied on top of the server version (`conflict.resolution = local_wins`)
  - server wins → `status = conflict`; the device replaces its copy with the server record,
    marks it `conflict`, and marks later queued ops of that record as superseded.
- **field-level merge** (designed, not enabled): resolvers receive `base` (the revision the client edited,
  read from `formdev_record_revision`), `local` and `remote`, which is everything a 3-way per-field merge needs.
  Implement `resolve()` and register it in `RESOLVERS` ([`conflict.py`](../../services/flora-api/app/formdev/conflict.py));
  storage, protocol and client need no change.

Clock skew between devices affects last-write-wins; Flora workstations are expected to use NTP.
