# FormDev

Form engine for Flora: versioned form definitions, offline-capable data entry and a vendor-neutral data
engine. This folder holds the vendor-neutral artifacts; the code lives next to the rest of Flora.

Status (2026-10-06):

- **Phase 1 (form schema core + design system): complete**, acceptance below.
- **Phase 2 (form logic engine): complete**, acceptance below. Twin Python / TypeScript engines held to
  shared fixtures: validation, visibility, dependency (lookups), formulas and calculators, Answer + Other,
  repeat sections, permissions, versioning, logic graph ([spec/LOGIC.md](spec/LOGIC.md)).
- **Form designer (drag & drop, no code) and PDF output: available** in Canopy → สร้างฟอร์ม → "ออกแบบฟอร์ม" (administrators);
  user guide in [docs/DESIGNER.md](docs/DESIGNER.md). Works on branch `floraXesm`; FormDev's PostgreSQL migrations
  are numbered 0060-0064 so they follow upstream's 0038-0051.
- **Phase 3 (data engine + offline + standalone): complete.**
- **Phase 4 (query engine): implemented, not yet accepted.** An adversarial review confirmed 47 defects
  (access control on Phase 3 endpoints, job lifecycle, reindex races, among others) that are fixed after
  Phase 2, and the large-data benchmark has 100k and 300k results but no 1M run (the host ran out of disk) and
  no report yet. No performance claim is made until both are done.
- Phase 5 (DSL / AI generator): not started.

## Layout

```
formdev/                                   vendor-neutral artifacts
  spec/form-definition.schema.json         JSON Schema of flora.form/1 (tested with a JSON Schema validator)
  spec/FORM-SCHEMA.md                      Phase 1 format: ids, field types, display, layout, A4, styles, fonts, validator
  spec/LOGIC.md                            Phase 2 logic: formulas, calculators, validation, visibility, dependency, Other, repeat, permission
  spec/field-types.json, style-tokens.json field type registry and style tokens (both runtimes must equal them)
  spec/DATA-MODEL.md                       3.1 data model, 3.2 hybrid storage, 3.11 migration
  spec/OFFLINE-SYNC.md                     3.5 local storage, 3.6 queue, 3.7 sync, 3.8 conflicts
  spec/FORMPACK.md                         3.9 standalone bundle
  spec/API.md                              HTTP API
  spec/QUERY.md                            Phase 4 query format, plans, limits, jobs, error codes
  spec/query.schema.json                   JSON Schema of flora.query/1 requests
  spec/query-policy.json                   default limits (equal to the server defaults; tested)
  spec/fixtures/*.json                     cases shared by the Python and TypeScript test suites
  registry/styles.json, fonts.json         style registry (inheritance, tokens) and font registry (13+1 Thai official fonts, metadata only)
  registry/calculators.json                calculator templates with checked examples (Phase 2.5)
  registry/lookups/*.json                  lookup tables (Phase 2.3); thai_address is a 13-row SAMPLE
  examples/patient-assessment/             v1, v2 (with migration), seed record, asset
  examples/phase2-logic/, phase2-dependency/ Phase 2 examples (formulas, rules, Other, repeat section; lookups, option conditions)
  examples/phase1-showcase/                every field type, nested sections, layout, A4, styles, display policy
  packs/*.formpack                         built example packages
  docs/DEPLOYMENT-INTRANET.md              3.10 intranet / standalone deployment, Phase 4 settings
  docs/PERFORMANCE-REPORT.md               4.13 large-dataset benchmark (100k / 1M records) with plans
  scripts/                                 smoke tests, pack builder, registry copies, fixture builders, intranet check
  scripts/perf/                            dataset loader, churn and benchmark harness

services/flora-api/app/formdev/            server engine (Python)
  field_types.py (registry)  definition.py (validator)  styles.py (style/font registries)
  migration.py  conflict.py  sync.py  formpack.py  repositories.py
  indexing.py  adapters/base.py (DataAdapter)  sql.py  postgres.py  sqlite.py  sql_query.py (query compiler)
  query/ policy access catalog validator plan cursor cache limits stats engine jobs advisor
services/flora-api/app/routes/formdev.py   HTTP routes (Canopy API); formdev_query.py, formdev_runtime.py (Phase 4)
services/flora-api/tests/formdev/          Python tests
infrastructure/postgres/0060-formdev.sql   PostgreSQL schema + registry seed
infrastructure/postgres/0061-formdev-query.sql, 0061b-formdev-query-indexes.sql   Phase 4 tables and indexes

frontend/src/formdev/                      client engine (TypeScript)
  core/ (types, fieldTypes, validate, styles, fonts, layout, migrate, cursor)  registry/defaults.ts (generated)
  data/ (DataAdapter, IndexedDbAdapter, RestApiAdapter)
  query/ (types, validate, builder)  repositories.ts  offline/ (SyncEngine, FormSync)
  ui/ (FormRenderer screen, FormPrint A4, FormPreview, fieldInputs + inputRegistry, FormDevWorkspace, QueryPanel, JobsPanel)
frontend/tests/formdev/                    TypeScript tests (vitest + fake-indexeddb)
```

## Architecture in one picture

```
Canopy Form Dev page ─→ client repositories ─→ IndexedDB (records + sync queue, atomic)
                                                   │ SyncEngine: ordered, retry/backoff, idempotent op_id
                                                   ▼
                       /api/formdev routes ─→ server repositories ─→ DataAdapter
                                                                       ├─ PostgreSQLAdapter (Flora PostgreSQL)
                                                                       ├─ SQLiteAdapter (standalone)
                                                                       └─ (MySQL: add a SqlDataAdapter subclass)
```

Neither the definition format nor the repositories know which database is used. The UI never talks to a
database: it calls client repositories, which write locally and sync through the API.

## Run the tests

```bash
# Python: SQLite always; PostgreSQL when FORMDEV_PG_TEST_URL points at a *_test database with 0060, 0061, 0061b, 0062, 0063, 0064 applied
# MySQL when FORMDEV_MYSQL_TEST_URL=mysql://user:pass@host:3306/<name>_test (each test recreates the schema; needs PyMySQL[rsa])
cd services/flora-api && FORMDEV_PG_TEST_URL=postgresql://flora_admin:...@127.0.0.1:6892/flora_formdev_test \
  python -m unittest discover -s tests/formdev -p 'test_*.py'

# TypeScript
cd frontend && npm run test:formdev

# HTTP end-to-end against a running Canopy API
FORMDEV_API=http://127.0.0.1:7895 FORMDEV_USER=admin FORMDEV_PASSWORD=... python3 formdev/scripts/smoke_api.py
FORMDEV_API=... FORMDEV_USER=... FORMDEV_PASSWORD=... python3 formdev/scripts/smoke_query_api.py   # Phase 4 (29 checks)

# Query fixtures shared by both validators: regenerate (refuses to write if a case disagrees with its expectation)
PYTHONPATH=services/flora-api python3 formdev/scripts/build_query_fixtures.py

# Registry copies (seeds, upgrade migrations, frontend defaults) match registry/*.json
python3 formdev/scripts/sync_registry_seed.py --check

# Phase 1 shared fixtures: regenerate (refuses to write if a case disagrees with its expectation)
PYTHONPATH=services/flora-api python3 formdev/scripts/build_definition_fixtures.py

# Phase 2 shared fixtures (same rule): formulas and records, dependency (lookups), permissions
PYTHONPATH=services/flora-api python3 formdev/scripts/build_logic_fixtures.py
PYTHONPATH=services/flora-api python3 formdev/scripts/build_dependency_fixtures.py
PYTHONPATH=services/flora-api python3 formdev/scripts/build_permission_fixtures.py

# Lookup table from your own CSV (for example the official Thai address list); see the script's --help
PYTHONPATH=services/flora-api python3 formdev/scripts/import_lookup.py thai_address addresses.csv --title ... --map province=... --out ...
```

## Phase 1 acceptance

| Criterion | Result | Evidence |
| --- | --- | --- |
| JSON Schema works | ✅ | `schema.test.ts` runs a real JSON Schema validator (ajv): accepts every example and valid fixture, rejects 38 structural cases; its type and property lists equal the registry (both runtimes) |
| Field registry works | ✅ | 19 types in `field-types.json`; Python and TS tables equal it (tested); one value validator and one input per type; Phase 4 families derived from it |
| Style registry works | ✅ | 11 styles incl. the required examples; registry check (unknown parent, cycles, tokens, fonts); cascade base → form → section → field → override tested in TS; legacy rows normalised (twin test) |
| Font registry works | ✅ | 16 fonts, 14 Thai official (13 national + TH Sarabun New) as metadata only; registry/metadata/assets/fallback kept apart; test fails if a font file is committed |
| A4 preview works | ✅ | Browser: two 210 × 297 mm sheets split at `page_break`, bands with title, Thai date and `หน้า 1/2`; `@page { size: A4 portrait; margin: 18mm 12mm 16mm 15mm }` |
| Print layout works | ✅ | Separate renderer (`FormPrint`): paper rendering of values, blank lines, repeat tables, page breaks, `@page` margin boxes; render tests |
| Hidden field works | ✅ | `visible`/`hidden`/`display.form` hide on screen and paper (browser: `user_id` absent in both); `display.query`/`export` honoured by the query catalog and export jobs |
| Responsive layout works | ✅ | Browser: desktop spans 3/6/3, mobile 12/12/12 with weight and height 6/6, as the rules say; layout unit tests for each mode, row/column sections, defaults |
| Validation works | ✅ | 79 Phase 1 definition cases + 25 record cases in shared fixtures, identical results in Python and TS; readable locations (13 path cases); strict JSON (duplicate keys) over HTTP |
| Unit tests pass | ✅ | Python 183 (SQLite and PostgreSQL, 0 skipped on PostgreSQL), TypeScript 407 |
| Existing project build passes | ✅ | `tsc -b`, `vite build` (Canopy surface), `check_intranet.py` on the bundle (no external requests) |
| Existing tests do not break | ✅ | All Phase 3/4 suites green, Phase 4 HTTP smoke 29/29; the two whole-project ESLint errors exist unchanged in the committed code (outside FormDev); `tests/test_leaf_writes.py` runs on a disposable database built by `scripts/test-leaf-writes.sh` (13/13) |

## Phase 2 acceptance

| Criterion | Result | Evidence |
| --- | --- | --- |
| Validation works | ✅ | required, min, max, min/max length, pattern, email, numeric, date ranges (incl. `today±Nd`), field and form rules; errors bound to `$.data.<key>` / `$.data.<repeat>[i].<key>`; 16 record cases identical in Python and TS; server refuses invalid writes (Thai rule messages kept) |
| Conditional visibility works | ✅ | 10 operators with and/or; hidden fields skipped by validation, values kept unless `clear_when_hidden`; section and category conditions; record fixtures + browser |
| Dependency works | ✅ | Option `when`, lookup options with filters, `derive`; dependants cleared in graph order; 11 dependency cases identical in both engines; server derives the postcode and clears stale choices (SQLite and PostgreSQL); browser: province → district → sub-district → postcode, switching back keeps them cleared, submitted record stored with the derived postcode |
| Formula engine works | ✅ | Tokenizer → parser → AST → evaluator; 58 formula cases identical in both engines (precedence, null rules, ROUND half away from zero, repeat columns, limits, error positions) |
| No eval / new Function | ✅ | `NoDynamicCode` scans both engines' sources; the evaluator walks AST tuples only |
| Calculator works | ✅ | Calculators are definitions; 9 registry templates (BMI, BMI class, MAP, BSA, age, percentage, total score, Morse fall risk level, sub-score) with examples checked in Python; server recomputes and overwrites client values |
| Answer + Other works | ✅ | `has_input` / `input_required`; text in `data._other.<key>` (items: `item._other.<key>`); dropped when the option is unselected; printed with its answer |
| Repeatable group works | ✅ | Repeat fields and repeat sections/categories; add, remove, reorder in the renderer; item-first scoping; `min_items` / `max_items`; nested groups |
| Permission works | ✅ | Form, section, category, group, field; innermost list wins; 7 role cases identical in both engines; server masks reads (incl. repeat children and Other text), refuses forbidden create/edit/delete, keeps fields a role may not edit; query catalog and export honour view/export; renderer hides and locks, print leaves out |
| Circular dependency detected | ✅ | Logic graph over formulas, visibility, option conditions, lookup filters, derivations and rules; `circular_dependency` with the cycle path (fixtures) |
| Versioning works | ✅ | Records carry `schema_version`; a v1 record is re-evaluated with v1's calculator after v2 is published, while new records use v2 (`Versioning` test) |
| Tests pass | ✅ | Python 216 on SQLite (59 PostgreSQL-only skipped) and 216 on a fresh PostgreSQL database (0 skipped); TypeScript 574 |
| Existing app build passes | ✅ | `tsc -b`, `vite build`, `check_intranet.py` on the bundle (no external requests), API imports; whole-project ESLint has the same 2 pre-existing errors outside FormDev (FormDev lint clean) |

## Phase 3 acceptance

| Criterion | Result | Evidence |
| --- | --- | --- |
| SQLite works | ✅ | `SQLiteContract` (22 tests), standalone API smoke test, data survives container restart |
| Server adapter works | ✅ | `PostgreSQLContract` (same 21 contract tests), smoke test on PostgreSQL storage |
| Form not tied to DB vendor | ✅ | One contract suite passes on both vendors; repositories only use `DataAdapter` |
| CRUD works | ✅ | Contract tests, offline tests, HTTP smoke test |
| Offline works | ✅ | IndexedDB tests; browser test: record submitted with the API stopped, synced after restart |
| Sync queue works | ✅ | Atomic write+enqueue, states, persistence across close/reopen |
| Retry works | ✅ | Backoff timing, max attempts, forced sync, per-record ordering tests |
| Conflict detected | ✅ | Both LWW directions on server (both vendors) and client; conflict log |
| Standalone form package works | ✅ | Deterministic build, tamper/traversal rejection, install into empty SQLite, upgrade pack |
| Intranet works | ✅ | `check_intranet.py` on the production bundle; local assets, fonts, auth, sync |
| Migration works | ✅ | Shared fixtures (Python = TypeScript), read-time view, persisted upgrade keeps old revision, publish guard |
| Tests pass | ✅ | Python 62, TypeScript 79, HTTP smoke 13 checks × 2 storage modes; Python suite repeated 6× without flakes |

Mutation checks confirmed the suites catch regressions (removing the server receipt check or the client
rebase step makes tests fail).


## Known limitations

- Thai addresses: the bundled `thai_address` table is a 13-row sample (`authoritative: false`). Import the
  official list with `scripts/import_lookup.py` before production use; FormDev downloads nothing.
- Permissions are checked against the latest published version's definition (not the record's own version).
  A repeat that contains a child a role may not edit is locked for that role as a whole.
- The permission UI was checked in the browser only with an administrator (who passes everything); non-admin
  roles are covered by render tests and server tests, not by a logged-in browser session.

- MySQL is not implemented (not part of the Flora stack); add a `SqlDataAdapter` subclass with its dialect.
- Field-level merge is designed (3-way inputs available) but only last-write-wins is enabled.
- File and image values hold a reference; uploading the bytes is up to the host (new files are marked `pending:`).
- A4 page numbers in print rely on CSS `@page` margin boxes (Chrome 131+, current Electron); the on-screen sheets split only at explicit page breaks.
- Thai official font files are not shipped; workstations need them installed, otherwise Noto Sans Thai is used.
- Reloading Canopy while its server is down returns to sign-in (see the intranet guide).
