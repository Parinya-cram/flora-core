#!/bin/sh
# Every Flora test in one run, in the order CI runs them, on the dev stack's images (nothing is downloaded):
#
#   compose   docker compose files are valid               (CI: compose-config)
#   compile   Python of the API and the sync worker compiles (CI: python-compile)
#   tsc       frontend type check                           (CI: frontend-build, first half)
#   lint      frontend eslint
#   vitest    frontend tests (Form Studio, Leaf, Canopy)    (CI: test-frontend)
#   build     frontend production build (vite)              (CI: frontend-build)   -- only with --full
#   api       API tests without a database (Form Studio, AI builder, reading documents, access log, case forms merge)
#                                                           (CI: test-api)
#   worker    sync worker rules                             (CI: test-worker)
#   db        API tests on PostgreSQL: Leaf writes, case forms, Leaf sync, hospital profile, case documents, retention
#                                                           (CI: test-db)
#   e2e       the whole form loop Form Studio → Workflow Studio → Leaf → Canopy on disposable databases
#
# Usage:
#   scripts/test-all.sh                  everything except the production build
#   scripts/test-all.sh --quick          no database: compose compile tsc lint vitest api worker
#   scripts/test-all.sh --full           everything, the production build included
#   scripts/test-all.sh --only vitest,api
#   scripts/test-all.sh --skip e2e
#   scripts/test-all.sh --ci             db on a throwaway PostgreSQL server (scripts/ci-test-db.sh) instead of the dev one
#   scripts/test-all.sh --list           the steps, without running them
#
# Needs Docker and the dev stack's images (docker compose -f compose.dev.yaml build). db and e2e use the dev stack's
# PostgreSQL container, but only databases whose names end in _test, built and dropped by the scripts they call;
# with --ci, db uses a throwaway server instead. Nothing here changes the dev data.
# The output of each step goes to its own log in $LOG_DIR (default: a new folder in /tmp); a failed step prints its
# last lines. The exit status is 0 only when every step that ran passed.
#
# Images and volumes can be changed: API_IMAGE, WORKER_IMAGE, FRONTEND_IMAGE, FRONTEND_MODULES, PG_CONTAINER.
set -u
REPO="$(cd "$(dirname "$0")/.." && pwd)"
API_IMAGE="${API_IMAGE:-flora-core-flora-canopy-api}"
WORKER_IMAGE="${WORKER_IMAGE:-flora-core-flora-leaf-sync}"
FRONTEND_IMAGE="${FRONTEND_IMAGE:-flora-core-flora-leaf}"
FRONTEND_MODULES="${FRONTEND_MODULES:-flora-core_flora_frontend_modules}"
PG_CONTAINER="${PG_CONTAINER:-flora-core-postgres-1}"
LOG_DIR="${LOG_DIR:-${TMPDIR:-/tmp}/flora-tests-$(date +%Y%m%d-%H%M%S)}"

ALL="compose compile tsc lint vitest build api worker db e2e"
STEPS="compose compile tsc lint vitest api worker db e2e"
SKIP=""
CI_DB=0
LIST=0
while [ $# -gt 0 ]; do
  case "$1" in
    --quick) STEPS="compose compile tsc lint vitest api worker" ;;
    --full) STEPS="$ALL" ;;
    --only) shift; STEPS="$(printf '%s' "${1:-}" | tr ',' ' ')" ;;
    --only=*) STEPS="$(printf '%s' "${1#--only=}" | tr ',' ' ')" ;;
    --skip) shift; SKIP="$SKIP $(printf '%s' "${1:-}" | tr ',' ' ')" ;;
    --skip=*) SKIP="$SKIP $(printf '%s' "${1#--skip=}" | tr ',' ' ')" ;;
    --ci) CI_DB=1 ;;
    --list) LIST=1 ;;
    -h|--help) sed -n '2,32p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown option: $1 (see --help)" >&2; exit 2 ;;
  esac
  shift
done
for step in $STEPS; do
  case " $ALL " in *" $step "*) ;; *) echo "unknown step: $step (steps: $ALL)" >&2; exit 2 ;; esac
done

if [ -t 1 ]; then GREEN="$(printf '\033[32m')"; RED="$(printf '\033[31m')"; YELLOW="$(printf '\033[33m')"; BOLD="$(printf '\033[1m')"; RESET="$(printf '\033[0m')"
else GREEN=""; RED=""; YELLOW=""; BOLD=""; RESET=""; fi

if [ "$LIST" = 1 ]; then
  for step in $STEPS; do case " $SKIP " in *" $step "*) echo "$step (skipped)" ;; *) echo "$step" ;; esac; done
  exit 0
fi

command -v docker >/dev/null 2>&1 || { echo "docker is needed" >&2; exit 2; }
docker info >/dev/null 2>&1 || { echo "Docker is not running" >&2; exit 2; }
mkdir -p "$LOG_DIR"
SUMMARY="$LOG_DIR/summary.txt"
: > "$SUMMARY"
FAILED=0

have_image() { docker image inspect "$1" >/dev/null 2>&1; }
have_volume() { docker volume inspect "$1" >/dev/null 2>&1; }
pg_running() { [ "$(docker inspect -f '{{.State.Running}}' "$PG_CONTAINER" 2>/dev/null)" = "true" ]; }

# Commands in the dev images, the repository mounted (Python never writes .pyc files into it).
api() { docker run --rm -v "$REPO:/repo" -w /repo/services/flora-api -e PYTHONPATH=/repo/services/flora-api -e PYTHONDONTWRITEBYTECODE=1 "$API_IMAGE" "$@"; }
front() { docker run --rm -v "$REPO:/app" -v "$FRONTEND_MODULES:/app/frontend/node_modules" -w /app/frontend "$FRONTEND_IMAGE" "$@"; }

# Why a step cannot run here (empty: it can).
missing() {
  case "$1" in
    tsc|lint|vitest|build)
      have_image "$FRONTEND_IMAGE" || { echo "image $FRONTEND_IMAGE not built"; return; }
      have_volume "$FRONTEND_MODULES" || echo "volume $FRONTEND_MODULES missing (start the dev stack once)" ;;
    compile|api) have_image "$API_IMAGE" || echo "image $API_IMAGE not built" ;;
    worker) have_image "$WORKER_IMAGE" || echo "image $WORKER_IMAGE not built" ;;
    db)
      if [ "$CI_DB" = 1 ]; then return; fi
      have_image "$API_IMAGE" || { echo "image $API_IMAGE not built"; return; }
      pg_running || echo "PostgreSQL container $PG_CONTAINER is not running (or use --ci)" ;;
    e2e)
      have_image "$API_IMAGE" || { echo "image $API_IMAGE not built"; return; }
      have_image "$WORKER_IMAGE" || { echo "image $WORKER_IMAGE not built"; return; }
      pg_running || { echo "PostgreSQL container $PG_CONTAINER is not running"; return; }
      [ -f "$REPO/.env" ] || echo "no .env (the dev stack's database admin)" ;;
  esac
}

run_step() {
  case "$1" in
    compose)
      docker compose -f "$REPO/compose.dev.yaml" --profile canopy --profile multi-leaf config >/dev/null \
        && docker compose -f "$REPO/flora-gateway/compose.yaml" config >/dev/null && echo "compose files are valid" ;;
    compile)
      # compile() only: compileall would write .pyc files into the mounted repository.
      api python -c "import pathlib, sys
files = [path for root in sys.argv[1:] for path in pathlib.Path(root).rglob('*.py')]
for path in files: compile(path.read_text(encoding='utf-8'), str(path), 'exec')
print(len(files), 'files compiled')" /repo/services/flora-api/app /repo/services/flora-sync-worker ;;
    tsc) front node_modules/.bin/tsc -b --noEmit && echo "no type errors" ;;
    lint) front node_modules/.bin/eslint . && echo "no lint errors" ;;
    vitest) front node_modules/.bin/vitest run tests ;;
    build) front node_modules/.bin/vite build ;;
    api)
      # tests/formdev (and the AI builder, reading documents) plus the API tests that need no database. Tests that need
      # PostgreSQL or MySQL skip here and run in the db step.
      api python -m unittest discover -s tests/formdev -p 'test_*.py' \
        && api python -m unittest tests.test_access_log tests.test_case_forms_merge ;;
    worker) docker run --rm -v "$REPO/services/flora-sync-worker:/w" -w /w -e PYTHONDONTWRITEBYTECODE=1 "$WORKER_IMAGE" python -m unittest discover -s tests ;;
    db)
      if [ "$CI_DB" = 1 ]; then API_IMAGE="$API_IMAGE" sh "$REPO/scripts/ci-test-db.sh"
      else PG_CONTAINER="$PG_CONTAINER" API_IMAGE="$API_IMAGE" sh "$REPO/scripts/test-leaf-writes.sh"; fi ;;
    e2e) REPORT_DIR="$LOG_DIR" PG_CONTAINER="$PG_CONTAINER" WORKER_IMAGE="$WORKER_IMAGE" API_IMAGE="$API_IMAGE" sh "$REPO/scripts/test-form-flow.sh" ;;
  esac
}

# A one-line result from a step's log: "Ran 519 tests … OK", vitest's "Tests 832 passed".
result_of() {
  ran="$(grep -E '^Ran [0-9]+ tests?' "$1" | awk '{n += $2} END {if (n) print n}')"
  [ -n "$ran" ] && { echo "$ran tests"; return; }
  grep -E '^ +Tests +' "$1" | tail -1 | sed -E 's/^ +Tests +//; s/\x1b\[[0-9;]*m//g'
}

echo "${BOLD}Flora tests${RESET} — steps: $STEPS${SKIP:+ (skip:$SKIP)} — logs: $LOG_DIR"
START_ALL="$(date +%s)"
for step in $STEPS; do
  case " $SKIP " in *" $step "*) printf '%-8s %s\n' "$step" "SKIP (asked)" >> "$SUMMARY"; continue ;; esac
  why="$(missing "$step")"
  if [ -n "$why" ]; then
    echo "${YELLOW}── $step: skipped — $why${RESET}"
    printf '%-8s %s\n' "$step" "SKIP ($why)" >> "$SUMMARY"
    continue
  fi
  log="$LOG_DIR/$step.log"
  printf '%s── %s …%s ' "$BOLD" "$step" "$RESET"
  start="$(date +%s)"
  run_step "$step" > "$log" 2>&1
  status=$?
  took=$(( $(date +%s) - start ))
  result="$(result_of "$log")"
  if [ "$status" -eq 0 ]; then
    echo "${GREEN}PASS${RESET} (${took}s)${result:+ — $result}"
    printf '%-8s %s\n' "$step" "PASS ${took}s${result:+ — $result}" >> "$SUMMARY"
  else
    FAILED=$((FAILED + 1))
    echo "${RED}FAIL${RESET} (${took}s, exit $status)${result:+ — $result}"
    printf '%-8s %s\n' "$step" "FAIL ${took}s exit $status${result:+ — $result} — $log" >> "$SUMMARY"
    echo "   last lines of $log:"
    grep -vE '^INFO:' "$log" | tail -25 | sed 's/^/   │ /'
  fi
done

echo
echo "${BOLD}Summary${RESET} ($(( $(date +%s) - START_ALL ))s)"
sed -e "s/ PASS / ${GREEN}PASS${RESET} /" -e "s/ FAIL / ${RED}FAIL${RESET} /" -e "s/ SKIP / ${YELLOW}SKIP${RESET} /" "$SUMMARY"
echo "logs: $LOG_DIR"
if [ "$FAILED" -gt 0 ]; then echo "${RED}${FAILED} step(s) failed${RESET}"; exit 1; fi
echo "${GREEN}all steps that ran passed${RESET}"
