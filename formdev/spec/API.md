# FormDev HTTP API (`/api/formdev`)

Served by the Canopy API (`FLORA_API_MODE=canopy`). All routes need a Canopy session
(`X-FLORA-Session`); routes marked **admin** need role `admin`/`system_admin`.
Errors are `{"error": message, "code": "...", "message": "...", "details": ...}`.

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/registry` | Styles, fonts and the active storage vendor |
| PUT | `/styles/{style_id}` **admin** | Add or change a style `{definition: {name, category, inherit?, tokens, components?}}`; validated (tokens, fonts, parent present, no cycle → 422 `invalid_style`), version + 1 |
| PUT | `/fonts/{font_id}` **admin** | Add or change a font `{metadata: {family, ...}, assets?, fallback}`; metadata only, no font files |
| PUT | `/attachments/{sha256}` | Upload a file of a file / image field: the raw bytes, `Content-Type` its media type. Idempotent; 422 `attachment_checksum` when the bytes do not hash to the id, 413 over `FORMDEV_ATTACHMENT_MAX_BYTES`. Records referencing `att:<sha256>` are refused until it is uploaded (`attachment_missing`) |
| GET | `/attachments/{sha256}?record_id=` | A file of a record the caller may read, only if the record references it in a field the caller may view (else 404). PNG / JPEG / GIF / WebP / PDF inline, anything else as a download; `nosniff`, sandboxing CSP |
| GET | `/lookups` | Lookup tables without their entries (`lookup_id`, `version`, `metadata`, `updated_at`, `updated_by`) |
| GET | `/lookups/{lookup_id}` | One lookup table with its entries; 404 `lookup_not_found` |
| PUT | `/lookups/{lookup_id}` **admin** | Add or replace a lookup `{metadata: {title, columns: [{name, label}], authoritative?, notice?, source?}, entries: [{column: text}]}` (≤ 50 000 rows, ≤ 16 MB, no repeated JSON keys); 422 `invalid_lookup`; version + 1. `formdev/scripts/import_lookup.py` builds one from CSV |
| GET | `/forms` | Form headers |
| POST | `/validate` | Validate `{definition}` against rules and the registry; issues carry a readable `location`, duplicate JSON keys are reported (`duplicate_json_key`) |
| POST | `/forms` **admin** | Create a form from a v1 `{definition}` (draft); a body that repeats a JSON key is refused (422) |
| GET | `/forms/{form_id}` | Header, all versions, asset list |
| POST | `/forms/{form_id}/versions` **admin** | Start the next draft from the latest version |
| GET | `/forms/{form_id}/versions/{v}` | One version |
| PUT | `/forms/{form_id}/versions/{v}` **admin** | Save a draft (published versions → 409 `version_immutable`) |
| POST | `/forms/{form_id}/versions/{v}/publish` **admin** | Publish (checks migration completeness) |
| GET | `/forms/{form_id}/assets/{path}` | Asset bytes |
| GET | `/forms/{form_id}/package?version=` **admin** | Download a `.formpack` |
| POST | `/packages` **admin** | Install a `.formpack` (raw body) |
| GET | `/records?form_id=&status=&filter=field:op:value&cursor=&limit=` | Indexed search, keyset pagination (≤ 200) |
| GET | `/records/{id}?as_version=` | One record, optionally as a migrated view |
| GET | `/records/{id}/revisions` | Every stored version |
| GET | `/records/{id}/conflicts` | Conflict log |
| POST | `/records/{id}/upgrade` **admin** | Persist a migration `{expected_version, to_version?}` |
| POST | `/sync` | Apply up to 100 sync operations; returns one ack per op |

Filter ops: `eq`, `prefix` (text), `gte`, `lte`. Only fields marked `indexed` can be filtered.
Record writes go through `/sync` (one idempotent write path for online and offline clients).

## Phase 4 — queries, jobs and administration

Query endpoints check, in this order: session token → rate limit → concurrency slot → pooled
connection (2 s) → the caller's current roles and permissions (`auth_user` + RBAC, cached 30 s;
inactive users and pending password changes get 401). Bodies are read before the rate limit, slot and
connection are taken: they must arrive within 10 s (408 `body_timeout`), are limited to 64 KB and duplicate
JSON keys are refused. Spec: [QUERY.md](QUERY.md).

| Method | Path | Permission | Purpose |
| --- | --- | --- | --- |
| GET | `/query/sources` | `formdev.query` | Sources the caller may query |
| GET | `/query/catalog/{source_id}` | `formdev.query` | Readable fields, metadata, relations, index state, effective limits |
| POST | `/query/validate` | `formdev.query` | `{query}` → `{issues}` (never runs the query) |
| POST | `/query?refresh=1&explain=1` | `formdev.query` (+ `formdev.diagnostics` for explain) | Run a query |
| GET | `/queries` | `formdev.query` | Saved queries the caller owns, or whose source the caller may query |
| GET / PUT / DELETE | `/queries/{query_id}` | `formdev.query` to read; owner or admin to change | Saved query (validated on save). Others' queries come with filter values and cursors removed (`redacted: true`) |
| POST | `/queries/{query_id}/run` | `formdev.query` | Run a saved query as the caller (`{cursor}` optional; a top-level `limit` becomes the page size) |
| POST | `/jobs` | `formdev.query`; export/search/report also `formdev.export` | `{kind, format?, body: {query}}`; 2 GB of kept results per user |
| GET | `/jobs`, `/jobs/{job_id}` | owner or admin | Status and progress |
| POST | `/jobs/{job_id}/cancel` | owner or admin | Cancel (queued: immediately; running: at the next batch) |
| GET | `/jobs/{job_id}/download` | owner or admin, still allowed to query (and export) the source | Stream the result (session header; never a token in the URL) |
| GET / PUT | `/policies/{form_id}` | `formdev.manage` | Form access policy `{query, export, fields}` |
| PUT / DELETE | `/sources/{source_id}` | `formdev.manage` | Named source `{form_id, config: {relations, query, export, fields, hidden}}` |
| GET | `/index-config/{form_id}` | `formdev.manage` | Indexed fields with origin and state |
| POST / DELETE | `/index-config/{form_id}/{field_id}` | `formdev.manage` | Add or remove a server-side indexed field (reindexes) |
| GET | `/query/advice?source_id=` | `formdev.manage` | Index advisor recommendations with evidence and trade-offs |
| GET | `/query/stats` | `formdev.manage` | Usage by query shape, cache and concurrency counters |
| GET | `/query/audit` | `formdev.manage` | Audit of job creation/download, denials and sensitive-field queries |

Phase 3 endpoints now resolve the caller's permissions too: `GET /records`, `/records/{id}`,
`/revisions` and `/conflicts` remove fields the caller may not read (filters on them are refused),
`GET /records` runs under the query statement timeout and rate limits, and `POST /sync` keeps the
stored values of fields the writer may not read and removes them from acknowledgements. Response
shapes are unchanged.

## Phase 2.8 — definition permissions

Every record route also applies the published definition's `permission` objects for the caller's role and
permission codes (see [LOGIC.md](LOGIC.md#28-permission)): fields the caller may not view are removed from
records, revisions, conflicts and sync acknowledgements; a form the caller may not view answers 403
`forbidden`; sync operations the caller may not make are acknowledged `rejected` with `forbidden`, and fields
they may not edit keep their stored values.

