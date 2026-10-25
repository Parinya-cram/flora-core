# Flora live stream: multi-case Leaf + Gateway stream-hub

This file is the contract shared by the Gateway, the Leaf backend and the Leaf UI.
Plan: `~/.claude/plans/rustling-noodling-crab.md`.

## Identity

- **Case UUID:** the Canopy `global_case_id`:
  `uuid5(NAMESPACE_URL, f"flora:{FLORA_HOSPITAL_ID}:{FLORA_LEAF_ID}:case:{cases.id}")`.
  It is the same function as `services/flora-api/app/routes/sync_ingest.py::_global_case_id`.
- **Device:** `gateway_device_instance.device_id`. A virtual device is an ordinary
  instance whose frames are split out of a shared pod by `options.source_ip`.

## Gateway stream-hub

- **Address:** `wss://<gateway>/stream/v1` (edge), which proxies to
  `stream-hub:7407/stream/v1`. On a dev machine it is also published as
  `127.0.0.1:7407`.
- **Messages:** one JSON object per WebSocket text frame, each with a `type` field.

### Leaf → Gateway

| type | fields | notes |
|---|---|---|
| `hello` | `leaf_id`, `token`, `proto: 1` | first frame; otherwise the socket is closed with 4401 |
| `bind` | `case_uuid`, `device_id`, `mode: "exclusive"\|"shared"`, `resume_seq?` (int epoch seconds) | idempotent for the same (case_uuid, device_id) |
| `unbind` | `case_uuid`, `device_id`, `reason: "discharged"\|"archived"\|"edited"\|"case_inactive"` | |
| `ack` | `device_id`, `seq` | cumulative: every seq ≤ `seq` for that device is stored |
| `ping` | — | the Gateway answers `pong` |

### Gateway → Leaf

| type | fields |
|---|---|
| `welcome` | `session_id`, `devices: [{device_id, label, device_type, online}]` (devices this Leaf may bind) |
| `bound` | `case_uuid`, `device_id`, `mode`, `from_seq` |
| `rejected` | `case_uuid`, `device_id`, `code: "exclusive_conflict"\|"unknown_device"\|"forbidden"`, `detail` |
| `chunk` | `device_id`, `seq`, `rev`, `t0`, `t1`, `numerics: [{ivy_param, value, unit, device_ts, system_ts}]`, `waves: [{channel, rate_hz, t0, samples_b64}]` |
| `pong` | — |
| `error` | `code`, `detail` |

### Chunks and sequence numbers

- **seq:** the epoch second of the window, from the Gateway's `system_ts`, so
  `t0 = seq*1000` and `t1 = t0 + 1000` (ms).
- **One chunk every second per bound device**, even an empty one.
  - A Leaf that has stored every seq from `from_seq` to N, with no gaps, holds all the
    data up to N.
  - A device that is offline still sends empty chunks, so a gap means data was lost,
    not that the device was quiet.
- **Window close:** the window closes at wall time `t1 + settle_ms` (default 300).
  - If a frame arrives later for a closed window, the hub sends the same `seq` again with
    `rev + 1` and the complete contents of the window.
  - Leaf upserts on `(case, device, seq)` and keeps the highest `rev`.
- **Flow control:** at most `max_unacked` (default 300) unacked seqs per device. After
  that the hub stops sending that device until it gets an ack. Kafka keeps the data, so
  nothing is lost.
- **Resume:**
  - `bind.resume_seq` asks the hub to replay from that second. It looks the second up
    in Kafka by timestamp (`offsets_for_times`) on `gw.obs` / `gw.wave`.
  - The hub answers `bound.from_seq`: `max(resume_seq, earliest_available)`, and live
    seconds otherwise.
  - Anything before `from_seq` that Leaf still needs comes from the data-api minute pull.
- **Waves:** `samples_b64` is little-endian int16. `rate_hz` is in samples per second.

### Binding rules at the Gateway

- **Exclusive:** refused if the device has any other open binding, on any Leaf.
- **Shared:** refused only if an open exclusive binding exists.
- **Which devices a Leaf may bind:** instances whose `leaf_id` is NULL or equals the
  `hello.leaf_id`.
- **Audit:** every `bind` writes a row to `gateway_case_binding`. It is closed with
  `unbound_at` and an `unbind_reason`:
  - `unbind`'s reason;
  - `disconnect` when the socket closes;
  - `revoked` when the token is revoked.
- **Rebinding after a reconnect** opens a new row.
- **To Canopy:** gateway-service sends rows with `delivered = false` through Haber
  (`POST /api/haber/v1/gateways/{id}/case-bindings` → Canopy
  `POST /api/sync/v1/gateways/{id}/case-bindings`, table `canopy_gateway_case_binding`, migration 0092).
  stream-hub resets `delivered` when it closes a row, so each row goes once open and once closed.
  Canopy reads them with `GET /api/fleet/case-bindings?case_uuid=&leaf_id=&open=`.

### Auth

- **Token:** created in the Gateway admin ("Leaves" tab), or with
  `POST /api/leaf-tokens {leaf_id}` → `{token}`, which is shown once.
- **Storage:** the Gateway keeps `sha256(token)` in `gateway_leaf_token`.

## Leaf

### Tables (migration 0090)

- **`leaf_gateway_link`:**
  - Columns: `id serial`, `gateway_id`, `label`, `data_api_url`, `stream_url`, `token`,
    `is_default`, `created_at`, `updated_at`.
  - A singleton `leaf_device_source` row, if present, is copied in as the default link.
- **`case_device_binding`:**
  - Columns: `id uuid`, `case_id bigint`, `gateway_link_id`, `device_id`,
    `mode ('exclusive'|'shared')`, `bound_at`, `released_at`, `release_reason`,
    `gateway_state ('pending'|'bound'|'rejected')`, `gateway_detail`.
  - Unique while open: `(gateway_link_id, device_id) WHERE released_at IS NULL AND mode='exclusive'`.
- **`cases.bed_label`:** text, nullable.
- **`stream_second`:** `(case_id, device_id, seq)` PK, `rev`, `numerics jsonb`,
  `received_at`.
- **`stream_wave`:** `(case_id, device_id, channel, t0)` PK, `rate_hz`, `samples bytea`,
  `received_at`.

### REST (leaf-api)

- **`GET /api/case/active`** → `{cases: [{case_id, case_uuid, hn, patient_name?, bed_label, status, start_time, devices: [binding]}]}`
- **`GET /api/case/{id}/devices`** → `{devices: [binding]}`
  - `binding` is `{id, gateway_link_id, device_id, mode, bound_at, released_at, gateway_state, gateway_detail, stream: {connected, last_seq, lag_ms}}`.
- **`PUT /api/case/{id}/devices`** with body `{devices: [{gateway_link_id, device_id, mode}]}`:
  - Replaces the open bindings.
  - Returns 409 `{error: "device_in_use", device_id, case_id}` when an exclusive clash
    happens on this Leaf.
- **`POST /api/case/start`:** adds optional `bed_label` and `devices` (same shape). An
  active case on the Leaf no longer blocks a new start. Only a device clash does (409
  `device_in_use`).
- **Gateway links:** `GET` / `POST` `/api/ward/gateway/links`, `PUT` / `DELETE`
  `/api/ward/gateway/links/{id}`, and `GET /api/ward/gateway/links/{id}/devices`, which
  proxies the Gateway `/api/devices/status`. The token is never returned; responses carry
  `has_token` instead.
- **Releasing bindings:** discharge and archive release the case's bindings with reason
  `discharged` / `archived`.
- **Unchanged:** `GET /api/case/status` still returns the newest active case.

### Browser WebSocket (leaf-live)

- **Address:** `ws(s)://<leaf>/api/live/ws`. The leaf-web edge and the Vite proxy both
  route it to `leaf-live:8000`.
- **Browser → Leaf**
  - First frame: `{type: "auth", token}`, the same token as `X-FLORA-Session`. The user
    needs `case.read`.
  - Then `{type: "subscribe", case_id}` / `{type: "unsubscribe", case_id}`.
- **Leaf → browser**
  - `{type: "ready"}`.
  - `{type: "chunk", case_id, device_id, seq, rev, t0, numerics: {<param_key>: value}, raw: [...], waves: [{channel, rate_hz, t0, samples: number[]}]}`.
    Numerics use the `vital_minutes` keys (`hr`, `spo2`, …).
  - `{type: "status", case_id, devices: [{device_id, connected, last_seq, lag_ms, gaps}]}`,
    every 2 s.
- **Order of work for each chunk:** store it, then ack the Gateway, then send it to the
  browser. Chunks already queued on the socket are handled together: one transaction, one
  cumulative ack per device, then the fan-out.

## Running it

- **Opt-in profile:** `stream-hub` (Gateway) and `leaf-live` (Leaf) use the compose
  profile `live` until a signed release includes them. A stack pinned to a release by
  flora-updater would otherwise crash-loop on images that lack the binary.
  - Add `--profile live` to the `docker compose` command to run them from source.
  - Remove the profile once a release ships them.
- **End-to-end test:** `PYTHON=<python with websockets> ./demo/test-live-stream.sh` runs
  it with 3 simulated M540s and the throwaway leaf-test-01.
  - The Gateway runs dev images during the test, then goes back to its release.
  - It checks:
    - 3 active cases with exclusive/shared bindings;
    - the case UUID audit at the Gateway;
    - per-second chunks reaching the browser in ≤1.5 s (p95);
    - ECG at about 200 samples/s;
    - no gaps across a 60 s stream-hub outage;
    - minute roll-up into the chart;
    - the binding closed on discharge.
- **Catch-up:** a case's start is rounded down to the quarter hour, so leaf-live first
  replays up to ~15 min of backlog from Kafka. Batched writes and `max_unacked = 300` make
  that a few seconds (it was ~17 chunks/s with a commit and an ack per chunk). Live chunks
  reach the screen once it has caught up.
- **Retention:** every hour leaf-live deletes, in batches, `stream_wave` older than
  `FLORA_STREAM_WAVE_RETENTION_DAYS` (default 7) and `stream_second` older than
  `FLORA_STREAM_SECOND_RETENTION_DAYS` (default 30), measured by the data's own time.
  - It only touches cases that are not active. An active case keeps everything.
  - `vital_minutes` is not pruned.
- **Server stack:** `flora-leaf/compose.server.yaml` has `leaf-live` under the same `live`
  profile (Portainer: `COMPOSE_PROFILES=live`). Its leaf-web nginx
  (`frontend/nginx.prod.conf.template`) routes `/api/live/` to it.
- **Releases:** `leaf-live` runs the leaf-api image (`FLORA_IMAGE_API`) and `stream-hub`
  runs the gateway rust image (`FLORA_IMAGE_RUST`). A release built from this source
  therefore already carries both. Once one is approved, drop `profiles: ["live"]` from
  `flora-leaf/compose.yaml`, `flora-leaf/compose.server.yaml` and
  `flora-gateway/compose.yaml`. flora-updater only starts services that have no profile.
