# FormDev deployment: intranet and standalone (Phase 3.10)

FormDev needs no Internet access. Verified items:

| Item | How it works offline from the Internet | Evidence |
| --- | --- | --- |
| API URL | The client calls `BACKEND_BASE` (same origin as the page, or the Electron-configured backend); no hard-coded hosts | `frontend/src/api/backendBase.ts`, `RestApiAdapter` |
| Local database | Server: PostgreSQL on the LAN, or SQLite (`FORMDEV_STORAGE=sqlite:/data/formdev.db`). Client: IndexedDB | contract tests on both vendors; HTTP smoke test on both |
| Asset loading | Assets live in the database and are served by `/api/formdev/forms/{id}/assets/...` | formpack tests, `curl` of `header.svg` |
| Font loading | Fonts are bundled through `@fontsource-variable/*`; registry entries only reference those packages | `check_intranet.py` on the production bundle: 10 bundled font files, 0 external references |
| Authentication | Existing Canopy HMAC session, issued by the Canopy API on the LAN; no external identity provider | `auth_canopy.py` |
| Sync | Same-origin `POST /api/formdev/sync`; queue survives restarts | sync tests, offline browser test |

## Check a bundle

```bash
cd frontend && VITE_FLORA_SURFACE=canopy npx vite build --outDir /tmp/canopy-dist
python3 ../formdev/scripts/check_intranet.py /tmp/canopy-dist
```

The script exits non-zero if any stylesheet, script, font, image or fetch targets a non-local host.

## Run the API in standalone mode (no PostgreSQL for FormDev)

```bash
FLORA_API_MODE=canopy FORMDEV_STORAGE=sqlite:/data/formdev.db \
  uvicorn app.main:app --host 0.0.0.0 --port 8000
```

The SQLite schema and the default style/font registry are created on first start. Install forms with a
`.formpack` (`POST /api/formdev/packages` or the Design panel). Other Canopy features still use
`FLORA_DATABASE_URL`.

## PostgreSQL

New installs run `infrastructure/postgres/0060-formdev.sql` automatically (mounted in
`compose/postgres.yaml`). Existing databases need it applied once:

```bash
docker exec -i <postgres-container> psql -v ON_ERROR_STOP=1 -U flora_admin -d flora < infrastructure/postgres/0060-formdev.sql
```

The migration is idempotent (`IF NOT EXISTS`, `ON CONFLICT DO NOTHING`).

## Phase 4 (queries and jobs)

Apply `0061-formdev-query.sql` (transactional) and then `0061b-formdev-query-indexes.sql` (runs
`CREATE INDEX CONCURRENTLY`, so it must not be wrapped in a transaction) to existing databases; new
installs run both automatically. SQLite standalone files are upgraded on open (`PRAGMA user_version`).

| Setting | Default | Meaning |
| --- | --- | --- |
| `FORMDEV_JOB_DIR` | `/var/lib/flora/formdev-jobs` | Job results (0700 directory, 0600 files). Mounted on the `flora_formdev_jobs` volume in compose so results survive rebuilds |
| `FORMDEV_JOB_POOL_SIZE` | `2` | Dedicated PostgreSQL connections for job workers and statistics |
| `FORMDEV_POOL_TIMEOUT_S` | `2` | Wait for a pooled connection before answering 503 `database_busy` |
| `FORMDEV_CURSOR_SECRET` | `FLORA_CANOPY_SESSION_SECRET` | Key for signed page cursors |
| `FORMDEV_TEST_HOOKS` | unset | `1` enables the timeout test hook; never set it in production |

Connection budget per Canopy API process: main pool 10 + job pool 2. Interactive queries are limited to
4 at a time per process (2 per user), so at least 6 connections stay free for other Canopy routes.
Rate and concurrency counters are per process and reset on restart; the job queue limits are enforced
in the database.

## Known limitation

Inside Canopy, the Form Dev page stays usable while the server is unreachable for a signed-in user who is
already on the page. Reloading the page while the server is down returns to the Canopy sign-in screen
(the shell's start-up health gate); queued data is kept and syncs after the next sign-in.
