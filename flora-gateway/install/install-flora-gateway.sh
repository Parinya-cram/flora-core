#!/usr/bin/env bash
# =============================================================================================
# Flora Gateway installer for Ubuntu (22.04 / 24.04, x86-64) - also inside a VM on Windows.
#
#   sudo ./install-flora-gateway.sh                      guided install (menus, no commands to type)
#   sudo ./install-flora-gateway.sh --answers site.env   unattended: settings from a file (see --help)
#   ./install-flora-gateway.sh --dry-run                 walk through the menus, change nothing
#
# What it does
#   1. checks the machine (Ubuntu, x86-64, RAM, disk, internet)
#   2. installs what is missing: Docker Engine + Compose (official Docker repository), whiptail,
#      curl, openssl, python3; Docker log rotation
#   3. asks the site settings: gateway ID, Canopy/Haber link, admin account, real RS-232 ports
#      (detected), LAN inputs, Leaf workstations, data retention, image source, extras
#   4. writes .env, config/gateway.site.toml, config/instances.site.json, kong/kong.yaml and an
#      HTTPS certificate (existing files are backed up first)
#   5. starts the gateway with compose.production.yaml (real serial ports only) and checks it
#   6. optional: nightly database backup, start on boot (Docker restarts every service itself)
# Every answer is saved (passwords excluded) to install/last-answers.env for the next run.
# =============================================================================================
set -uo pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
GW_DIR=${FLORA_GATEWAY_DIR:-$(cd "$SCRIPT_DIR/.." && pwd)}   # the flora-gateway folder
# Test switches: FLORA_INSTALL_SKIP_SOFTWARE=1 skips step 2, FLORA_INSTALL_STOP_AFTER=files stops after step 4.
PROJECT=flora-gateway
COMPOSE=(docker compose -p "$PROJECT" -f "$GW_DIR/compose.production.yaml")
STAMP=$(date +%Y%m%d-%H%M%S)
LOG=/var/log/flora-gateway-install-$STAMP.log
DRY_RUN=0 ASSUME_YES=0 ANSWERS="" UI=whiptail
TITLE="Flora Gateway installer"

usage() {
  cat <<EOF
Usage: sudo $0 [--answers FILE] [--yes] [--dry-run] [--text]

  --answers FILE  read settings from FILE (KEY=VALUE lines); the menus only ask what is missing.
                  Keys: GATEWAY_ID HOST_IP HABER_URL HABER_GATEWAY_TOKEN HABER_NODE_TOKEN
                        ROOT_PUBLIC_KEY ADMIN_USER ADMIN_PASSWORD ADMIN_ON_LAN(yes|no)
                        HTTPS_PORT SERIAL_PORTS("/dev/ttyS0 /dev/ttyUSB0") LAN_INPUTS("hl7 vista m540")
                        LEAF_IDS("leaf-or-01 leaf-icu-01") RETENTION_DAYS IMAGE_SOURCE(build|release)
                        IMAGE_RUST IMAGE_SERVICE IMAGE_PARSER IMAGE_UPDATER BACKUP(yes|no)
  --yes           do not ask for the final confirmation (with --answers: fully unattended)
  --dry-run       ask everything and show what would happen; install and change nothing
  --text          plain text questions instead of menus
EOF
}

while [ $# -gt 0 ]; do
  case $1 in
    --answers) ANSWERS=$2; shift ;;
    --yes) ASSUME_YES=1 ;;
    --dry-run) DRY_RUN=1 ;;
    --text) UI=text ;;
    -h|--help) usage; exit 0 ;;
    *) echo "unknown option $1"; usage; exit 2 ;;
  esac
  shift
done
[ "$DRY_RUN" = 1 ] && LOG=/tmp/flora-gateway-install-dryrun-$STAMP.log
command -v whiptail >/dev/null || UI=text
[ -t 0 ] || UI=text

# ------------------------------------------------------------------ output helpers
say()  { echo -e "$*" | tee -a "$LOG"; }
step() { say "\n==== $* ===="; }
die()  { say "ERROR: $*"; [ "$UI" = whiptail ] && whiptail --title "$TITLE" --msgbox "Installation stopped:\n\n$*\n\nLog: $LOG" 14 74; exit 1; }
run()  { # run a command (or only show it in a dry run); output goes to the log
  if [ "$DRY_RUN" = 1 ]; then say "  [dry-run] $*"; return 0; fi
  say "  \$ $*"; "$@" >>"$LOG" 2>&1
}

# ------------------------------------------------------------------ questions (menus or text)
# Values already set (from --answers) are used as they are and not asked again.
declare -A A
if [ -n "$ANSWERS" ]; then
  [ -f "$ANSWERS" ] || die "answers file $ANSWERS not found"
  while IFS='=' read -r key value; do
    [[ $key =~ ^[A-Z_]+$ ]] || continue
    value=${value%\"}; value=${value#\"}
    A[$key]=$value
  done < "$ANSWERS"
fi
have() { [ -n "${A[$1]+x}" ]; }

ask_input() { # ask_input KEY "question" default [password]
  have "$1" && return
  local value
  if [ "$UI" = whiptail ]; then
    if [ "${4:-}" = password ]; then
      value=$(whiptail --title "$TITLE" --passwordbox "$2\n\n(empty = generate a random one)" 12 74 3>&1 1>&2 2>&3) || die "cancelled"
    else
      value=$(whiptail --title "$TITLE" --inputbox "$2" 12 74 "$3" 3>&1 1>&2 2>&3) || die "cancelled"
    fi
  else
    if [ "${4:-}" = password ]; then read -r -s -p "$2 (empty = random): " value; echo
    else read -r -p "$2 [$3]: " value; fi
  fi
  A[$1]=${value:-$3}
}
ask_yesno() { # ask_yesno KEY "question" default(yes|no)
  have "$1" && return
  if [ "$UI" = whiptail ]; then
    local defno=(); [ "$3" = no ] && defno=(--defaultno)
    if whiptail --title "$TITLE" "${defno[@]}" --yesno "$2" 12 74; then A[$1]=yes; else A[$1]=no; fi
  else
    local value; read -r -p "$2 [$3]: " value; value=${value:-$3}
    [[ ${value,,} == y* ]] && A[$1]=yes || A[$1]=no
  fi
}
ask_menu() { # ask_menu KEY "question" default tag1 item1 tag2 item2 ...
  have "$1" && return
  local key=$1 question=$2 def=$3; shift 3
  if [ "$UI" = whiptail ]; then
    A[$key]=$(whiptail --title "$TITLE" --default-item "$def" --menu "$question" 18 78 8 "$@" 3>&1 1>&2 2>&3) || die "cancelled"
  else
    say "$question"; while [ $# -gt 0 ]; do say "  $1  $2"; shift 2; done
    local value; read -r -p "choice [$def]: " value; A[$key]=${value:-$def}
  fi
}
ask_checklist() { # ask_checklist KEY "question" tag1 item1 on|off ...  -> space separated tags
  have "$1" && return
  local key=$1 question=$2; shift 2
  if [ "$UI" = whiptail ]; then
    local out; out=$(whiptail --title "$TITLE" --checklist "$question\n\n(space = select, Enter = OK)" 20 78 10 "$@" 3>&1 1>&2 2>&3) || die "cancelled"
    A[$key]=$(tr -d '"' <<<"$out")
  else
    say "$question"; local defaults=()
    while [ $# -gt 0 ]; do say "  $1  $2"; [ "$3" = ON ] && defaults+=("$1"); shift 3; done
    local value; read -r -p "choose (space separated) [${defaults[*]}]: " value; A[$key]=${value:-${defaults[*]}}
  fi
}
random_secret() { openssl rand -base64 "${1:-18}" | tr -d '/+=\n' | cut -c1-"${2:-20}"; }

# ------------------------------------------------------------------ 1. machine check
preflight() {
  step "1/6 Checking this machine"
  local test_mode=0   # file-writing test into another folder: no root needed, nothing is installed or started
  [ "${FLORA_INSTALL_SKIP_SOFTWARE:-0}" = 1 ] && [ "${FLORA_INSTALL_STOP_AFTER:-}" = files ] && test_mode=1
  [ "$DRY_RUN" = 1 ] || [ "$test_mode" = 1 ] || [ "$(id -u)" = 0 ] || die "run with sudo: sudo $0"
  . /etc/os-release 2>/dev/null || true
  [[ "${ID:-}" == ubuntu || "${ID_LIKE:-}" == *ubuntu* || "${ID:-}" == debian ]] || die "Ubuntu (or Debian) is required; this is ${PRETTY_NAME:-unknown}"
  [ "$(uname -m)" = x86_64 ] || die "x86-64 is required (found $(uname -m))"
  local ram_gb disk_gb
  ram_gb=$(awk '/MemTotal/ {printf "%d", $2/1024/1024 + 0.5}' /proc/meminfo)
  disk_gb=$(df -BG --output=avail "$GW_DIR" | tail -1 | tr -dc 0-9)
  say "  OS ${PRETTY_NAME:-?}, RAM ${ram_gb} GB, free disk ${disk_gb} GB, folder $GW_DIR"
  [ "$ram_gb" -ge 4 ] || die "at least 4 GB RAM is needed (found ${ram_gb} GB)"
  [ "$disk_gb" -ge 20 ] || die "at least 20 GB free disk is needed (found ${disk_gb} GB)"
  [ -f "$GW_DIR/compose.production.yaml" ] || die "compose.production.yaml not found in $GW_DIR"
  if ! curl -fsS -m 10 -o /dev/null https://download.docker.com; then
    command -v docker >/dev/null && docker compose version >/dev/null 2>&1 \
      && say "  no internet, but Docker is already installed: continuing" \
      || die "no internet access (needed to install Docker and the base images)"
  fi
}

# ------------------------------------------------------------------ 2. software
install_software() {
  step "2/6 Installing what is missing"
  [ "${FLORA_INSTALL_SKIP_SOFTWARE:-0}" = 1 ] && { say "  skipped (FLORA_INSTALL_SKIP_SOFTWARE=1)"; return; }
  local pkgs=() p
  for p in whiptail curl ca-certificates openssl python3 gnupg; do
    dpkg -s "$p" >/dev/null 2>&1 || pkgs+=("$p")
  done
  if [ ${#pkgs[@]} -gt 0 ]; then
    run apt-get update -qq || die "apt-get update failed (see $LOG)"
    run env DEBIAN_FRONTEND=noninteractive apt-get install -y -qq "${pkgs[@]}" || die "cannot install ${pkgs[*]}"
  else
    say "  base tools present"
  fi
  if command -v docker >/dev/null && docker compose version >/dev/null 2>&1; then
    say "  Docker $(docker --version | cut -d' ' -f3 | tr -d ,) with Compose $(docker compose version --short) already installed"
  else
    say "  installing Docker Engine + Compose from the official Docker repository"
    . /etc/os-release
    local distro=${ID}; [[ "${ID_LIKE:-}" == *ubuntu* ]] && distro=ubuntu
    local codename=${UBUNTU_CODENAME:-$VERSION_CODENAME}
    run install -m 0755 -d /etc/apt/keyrings
    run sh -c "curl -fsSL https://download.docker.com/linux/$distro/gpg -o /etc/apt/keyrings/docker.asc && chmod a+r /etc/apt/keyrings/docker.asc" \
      || die "cannot download Docker's signing key"
    run sh -c "echo 'deb [arch=amd64 signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/$distro $codename stable' > /etc/apt/sources.list.d/docker.list"
    run apt-get update -qq || die "apt-get update failed (see $LOG)"
    run env DEBIAN_FRONTEND=noninteractive apt-get install -y -qq docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin \
      || die "Docker installation failed (see $LOG)"
  fi
  run systemctl enable --now docker containerd || die "cannot enable the Docker service"
  # Log rotation for every container (compose sets it per service too; this covers anything else).
  if [ "$DRY_RUN" = 1 ]; then
    say "  [dry-run] would set Docker log rotation (10 MB x 3) in /etc/docker/daemon.json"
  else
    local changed
    changed=$(python3 - <<'PY'
import json, os
path = "/etc/docker/daemon.json"
data = json.load(open(path)) if os.path.exists(path) and os.path.getsize(path) else {}
want = {"log-driver": "json-file", "log-opts": {"max-size": "10m", "max-file": "3"}}
if all(data.get(k) == v for k, v in want.items()):
    print("no")
else:
    data.update(want)
    os.makedirs("/etc/docker", exist_ok=True)
    json.dump(data, open(path, "w"), indent=2)
    print("yes")
PY
)
    if [ "$changed" = yes ]; then
      say "  Docker log rotation set in /etc/docker/daemon.json (applies to containers created from now on)"
      if [ -z "$(docker ps -q 2>/dev/null)" ]; then run systemctl restart docker; fi
    fi
  fi
  local user=${SUDO_USER:-}
  if [ -n "$user" ] && [ "$user" != root ] && ! id -nG "$user" | grep -qw docker; then
    run usermod -aG docker "$user" && say "  $user can now use docker without sudo (after signing in again)"
  fi
}

# ------------------------------------------------------------------ 3. settings
detect_serial_ports() { # prints "device|description" for real RS-232 ports
  local dev name type
  for dev in /dev/ttyS*; do
    [ -c "$dev" ] || continue
    name=${dev#/dev/}
    type=$(cat "/sys/class/tty/$name/type" 2>/dev/null || echo 0)
    [ "$type" != 0 ] || continue                       # no UART behind it (unused ttyS slot)
    echo "$dev|on-board COM$(( ${name#ttyS} + 1 )) (UART type $type, $(cat /sys/class/tty/$name/port 2>/dev/null))"
  done
  for dev in /dev/ttyUSB* /dev/ttyACM*; do
    [ -c "$dev" ] || continue
    local by_id; by_id=$(find /dev/serial/by-id -lname "*${dev#/dev/}" 2>/dev/null | head -1)
    echo "$dev|USB serial ${by_id:+$(basename "$by_id")}"
  done
}

primary_ip() { ip -4 route get 1.1.1.1 2>/dev/null | awk '{for (i=1;i<=NF;i++) if ($i=="src") {print $(i+1); exit}}'; }

ask_settings() {
  step "3/6 Site settings"
  if [ "$UI" = whiptail ] && ! have GATEWAY_ID; then
    whiptail --title "$TITLE" --msgbox "This installs Flora Gateway on this machine:\n\n  - Docker Engine and the tools it needs (if missing)\n  - your site settings (next screens)\n  - real RS-232 ports only, no simulators\n\nExisting settings are backed up first. Folder:\n$GW_DIR" 16 74
  fi
  local current_id="" default_ip
  [ -f "$GW_DIR/.env" ] && current_id=$(grep -E '^FLORA_GATEWAY_ID=' "$GW_DIR/.env" | cut -d= -f2-)
  ask_input GATEWAY_ID "Gateway ID (the name Canopy knows this gateway by; letters, digits, '-')" "${current_id:-gateway-$(hostname -s | tr 'A-Z_' 'a-z-')}"
  [[ ${A[GATEWAY_ID]} =~ ^[A-Za-z0-9._-]{1,64}$ ]] || die "invalid gateway ID '${A[GATEWAY_ID]}'"
  default_ip=$(primary_ip)
  ask_input HOST_IP "IP address of this machine on the hospital LAN (Leaf and devices reach the gateway here)" "${default_ip:-127.0.0.1}"

  ask_input HABER_URL "Canopy / Haber URL (e.g. http://172.22.19.81:7204 or https://canopy.hospital:9443)\nEmpty = install now, connect to Canopy later in the admin page" ""
  if [ -n "${A[HABER_URL]}" ]; then
    ask_input HABER_GATEWAY_TOKEN "Haber gateway token (from Canopy: HABER_GATEWAY_TOKEN)" ""
    ask_input HABER_NODE_TOKEN "Haber node token for automatic updates (HABER_NODE_TOKEN; empty = no auto-update)" ""
    ask_input ROOT_PUBLIC_KEY "Flora Root public key to verify releases (empty = trust the first key Haber shows)" ""
  else
    A[HABER_GATEWAY_TOKEN]=${A[HABER_GATEWAY_TOKEN]:-} A[HABER_NODE_TOKEN]=${A[HABER_NODE_TOKEN]:-} A[ROOT_PUBLIC_KEY]=${A[ROOT_PUBLIC_KEY]:-}
  fi

  ask_input ADMIN_USER "Admin username for the gateway web page" "admin"
  ask_input ADMIN_PASSWORD "Admin password (at least 8 characters)" "" password
  [ -n "${A[ADMIN_PASSWORD]}" ] || { A[ADMIN_PASSWORD]=$(random_secret); A[ADMIN_PASSWORD_GENERATED]=yes; }
  [ ${#A[ADMIN_PASSWORD]} -ge 8 ] || die "the admin password needs at least 8 characters"
  ask_yesno ADMIN_ON_LAN "Open the admin web page to the LAN (port 7400)?\nNo = only from this machine (HTTPS on 443 is always on the LAN)" yes
  ask_input HTTPS_PORT "HTTPS port of the gateway web page" "443"

  # Real serial ports: detected, the user ticks the ones that have devices on them.
  local ports=() line
  while IFS= read -r line; do [ -n "$line" ] && ports+=("$line"); done < <(detect_serial_ports)
  if [ ${#ports[@]} -eq 0 ]; then
    say "  no real RS-232 port found: serial input stays off (network devices still work)"
    A[SERIAL_PORTS]=${A[SERIAL_PORTS]:-}
  else
    local items=() p
    for p in "${ports[@]}"; do items+=("${p%%|*}" "${p#*|}" ON); done
    ask_checklist SERIAL_PORTS "Real RS-232 ports to use for medical devices (at most 2):" "${items[@]}"
  fi
  read -r -a picked <<<"${A[SERIAL_PORTS]}"
  [ ${#picked[@]} -le 2 ] || die "at most 2 serial ports (picked ${#picked[@]}); add more later in compose.production.yaml"
  for p in "${picked[@]}"; do [ -c "$p" ] || [ "$DRY_RUN" = 1 ] || die "$p is not a serial device on this machine"; done

  ask_checklist LAN_INPUTS "Network inputs to open for medical devices:" \
    hl7   "HL7 v2 monitors, TCP/MLLP on port 7421 (Philips, GE, Mindray, ...)" ON \
    vista "Draeger Vista 120 S, TCP on port 7422" ON \
    m540  "Draeger M540 via the IACS relay, TCP on port 2051" OFF
  ask_input LEAF_IDS "Leaf workstations that read devices from this gateway (space separated, e.g. leaf-or-01 leaf-icu-01)\nEmpty = add them later" ""
  ask_input RETENTION_DAYS "Keep stored device values for how many days? (0 = forever; Leaf and Canopy keep the record)" "30"
  [[ ${A[RETENTION_DAYS]} =~ ^[0-9]+$ ]] || die "retention must be a number of days"

  ask_menu IMAGE_SOURCE "Where do the Flora images come from?" build \
    build   "Build here from this folder (needs internet, ~10 min the first time)" \
    release "Download a release from the Haber / Root registry (enter image names)"
  if [ "${A[IMAGE_SOURCE]}" = release ]; then
    ask_input IMAGE_RUST "Rust services image (e.g. registry:7105/flora/gateway-rust@sha256:...)" ""
    ask_input IMAGE_SERVICE "gateway-service image" ""
    ask_input IMAGE_PARSER "parser image" ""
    ask_input IMAGE_UPDATER "updater image" ""
  fi
  ask_yesno BACKUP "Back up the gateway database every night at 02:30 (keeps 7 days in /var/backups/flora-gateway)?" yes
}

summary() {
  local lan=${A[ADMIN_ON_LAN]} pw="(you entered one)"
  [ "${A[ADMIN_PASSWORD_GENERATED]:-}" = yes ] && pw="(random, shown at the end)"
  cat <<EOF
Gateway ID       ${A[GATEWAY_ID]}
This machine     ${A[HOST_IP]}
Canopy / Haber   ${A[HABER_URL]:-not connected yet}
Admin account    ${A[ADMIN_USER]} / password $pw
Admin page       http://${A[HOST_IP]}:7400 $([ "$lan" = yes ] && echo "(LAN)" || echo "(this machine only)") ; https://${A[HOST_IP]}:${A[HTTPS_PORT]}
Serial ports     ${A[SERIAL_PORTS]:-none}
Network inputs   ${A[LAN_INPUTS]:-none}
Leaf routes      ${A[LEAF_IDS]:-none yet}
Keep values      $([ "${A[RETENTION_DAYS]}" = 0 ] && echo forever || echo "${A[RETENTION_DAYS]} days")
Images           ${A[IMAGE_SOURCE]}
Nightly backup   ${A[BACKUP]}
EOF
}

# ------------------------------------------------------------------ 4. files
toml_pods() {
  local i=1 p
  for p in ${A[SERIAL_PORTS]}; do
    cat <<EOF

[[serial.pods]]
id = "COM$i"
# $p - line settings follow the device type of the device on this port (set in the admin page).
path = "$p"
baud = 9600
data_bits = 8
parity = "none"
EOF
    i=$((i + 1))
  done
}

write_files() {
  step "4/6 Writing the site files"
  local backup="$GW_DIR/install/backups/$STAMP" f
  run mkdir -p "$backup"
  for f in .env config/gateway.site.toml config/instances.site.json kong/kong.yaml certs/server.crt certs/server.key; do
    [ -f "$GW_DIR/$f" ] && run cp -p "$GW_DIR/$f" "$backup/$(echo "$f" | tr / _)"
  done
  say "  previous files $([ "$DRY_RUN" = 1 ] && echo "would be backed up" || echo "backed up") to $backup"

  read -r -a picked <<<"${A[SERIAL_PORTS]}"
  local db_password
  db_password=$(grep -E '^FLORA_GATEWAY_DB_PASSWORD=' "$GW_DIR/.env" 2>/dev/null | cut -d= -f2-)
  # The database keeps the password it was created with: reuse it when the database already exists.
  [ -n "$db_password" ] || { docker volume inspect "${PROJECT}_gateway_db_data" >/dev/null 2>&1 && db_password=flora-gateway-local-only; }
  [ -n "$db_password" ] || db_password=$(random_secret 24 32)
  local canopy_ip=""
  [[ ${A[HABER_URL]} =~ ://([0-9.]+) ]] && canopy_ip=${BASH_REMATCH[1]}

  local env_content
  env_content=$(cat <<EOF
# Flora Gateway site settings - written by install/install-flora-gateway.sh on $(date '+%Y-%m-%d %H:%M')
# Used by: docker compose -p $PROJECT -f compose.production.yaml up -d
FLORA_GATEWAY_ID=${A[GATEWAY_ID]}
FLORA_GATEWAY_CONFIG_FILE=gateway.site.toml
FLORA_GATEWAY_SEED_FILE=instances.site.json

# Canopy / Haber
HABER_URL=${A[HABER_URL]}
HABER_GATEWAY_TOKEN=${A[HABER_GATEWAY_TOKEN]}
HABER_NODE_TOKEN=${A[HABER_NODE_TOKEN]}
FLORA_ROOT_PUBLIC_KEY=${A[ROOT_PUBLIC_KEY]}
FLORA_CANOPY_IP=${canopy_ip:-127.0.0.1}
GATEWAY_LICENSE_REQUIRED=true

# Leaf workstations read devices here
GATEWAY_DATA_API_URL=http://${A[HOST_IP]}:7410/data-api
FLORA_GATEWAY_DATA_API_PORT=7410
FLORA_GATEWAY_DATA_API_BIND=0.0.0.0

# Admin page and accounts
GATEWAY_ADMIN_USERNAME=${A[ADMIN_USER]}
GATEWAY_ADMIN_PASSWORD=${A[ADMIN_PASSWORD]}
FLORA_GATEWAY_ADMIN_BIND=$([ "${A[ADMIN_ON_LAN]}" = yes ] && echo 0.0.0.0 || echo 127.0.0.1)
GATEWAY_HTTPS_PORT=${A[HTTPS_PORT]}
FLORA_GATEWAY_DB_PASSWORD=$db_password

# Real RS-232 ports mapped into the serial controller (/dev/null = slot not used)
FLORA_SERIAL_PORT_1=${picked[0]:-/dev/null}
FLORA_SERIAL_PORT_2=${picked[1]:-/dev/null}

# Stored device values are deleted after this many days (0 = keep everything)
GATEWAY_DATA_RETENTION_DAYS=${A[RETENTION_DAYS]}
EOF
)
  if [ "${A[IMAGE_SOURCE]}" = release ]; then
    env_content+=$'\n\n# Release images (from Haber / Root)\n'
    env_content+="FLORA_IMAGE_RUST=${A[IMAGE_RUST]}"$'\n'"FLORA_IMAGE_SERVICE=${A[IMAGE_SERVICE]}"$'\n'
    env_content+="FLORA_IMAGE_PARSER=${A[IMAGE_PARSER]}"$'\n'"FLORA_IMAGE_UPDATER=${A[IMAGE_UPDATER]}"
  fi

  local hl7="" vista="" m540=""
  [[ " ${A[LAN_INPUTS]} " == *" hl7 "* ]] && hl7=1
  [[ " ${A[LAN_INPUTS]} " == *" vista "* ]] && vista=1
  [[ " ${A[LAN_INPUTS]} " == *" m540 "* ]] && m540=1
  local toml
  toml=$(cat <<EOF
# Flora Gateway site configuration - written by install/install-flora-gateway.sh on $(date '+%Y-%m-%d %H:%M')
# Real ports only. The gateway rewrites a pod's line settings to match the device type of its device.
gateway_id = "${A[GATEWAY_ID]}"

[kafka]
brokers = "kafka:9092"

[serial]
admin_port = 5001
$(toml_pods)

[feeder]
admin_port = 5002

[webhook]
admin_port = 5003

[socket]
admin_port = 5004
$([ -n "$hl7" ] && printf '\n[[socket.pods]]\nid = "or-monitor"\n# HL7 v2 monitors: TCP/MLLP, LAN port 7421\nport = 9001\nframing = "mllp"\nauto_ack = true\n')
$([ -n "$vista" ] && printf '\n[[socket.pods]]\nid = "icu-monitor"\n# Draeger Vista 120 S (CMS link): TCP, LAN port 7422\nport = 9002\nframing = "raw"\nauto_ack = false\n')
$([ -n "$m540" ] && printf '\n[[socket.pods]]\nid = "m540-relay"\n# Draeger M540 via the IACS relay: TCP, LAN port 2051\nport = 2051\nframing = "udp_relay"\nauto_ack = false\nmax_frame_bytes = 6096\n')

[collector]
admin_port = 5005
batch_size = 500
flush_ms = 500

[server]
listen = "0.0.0.0:8080"

[publisher]
admin_port = 5006
targets = []
EOF
)
  local kong leaf
  kong=$'# Kong (DB-less) - written by install/install-flora-gateway.sh. A Leaf reads its devices at\n'
  kong+=$'#   http://<gateway>:7410/data-api/<leaf-id>/...   (only devices assigned to that Leaf)\n'
  kong+=$'_format_version: "3.0"\n\nservices:\n  - name: data-api\n    url: http://server:8080\n    routes:\n      - name: data-api-all\n        paths: ["/data-api"]\n        strip_path: true\n'
  for leaf in ${A[LEAF_IDS]}; do
    [[ $leaf =~ ^[A-Za-z0-9._-]+$ ]] || die "invalid Leaf ID '$leaf'"
    kong+="  - name: data-api-$leaf
    url: http://server:8080
    routes:
      - name: data-api-$leaf
        paths: [\"/data-api/$leaf\"]
        strip_path: true
    plugins:
      - name: request-transformer
        config:
          add:
            querystring: [\"leaf_id:$leaf\"]
"
  done

  if [ "$DRY_RUN" = 1 ]; then
    local out=/tmp/flora-gateway-install-dryrun-$STAMP
    mkdir -p "$out/config" "$out/kong"
    sed -E 's/^(GATEWAY_ADMIN_PASSWORD|FLORA_GATEWAY_DB_PASSWORD|HABER_GATEWAY_TOKEN|HABER_NODE_TOKEN)=.+/\1=********/' <<<"$env_content" > "$out/.env"
    echo "$toml" > "$out/config/gateway.site.toml"; echo "$kong" > "$out/kong/kong.yaml"
    say "  [dry-run] files that would be written are in $out (secrets masked)"
    return
  fi
  umask 077; echo "$env_content" > "$GW_DIR/.env"; umask 022
  chmod 600 "$GW_DIR/.env"                               # holds passwords and tokens
  echo "$toml" > "$GW_DIR/config/gateway.site.toml"
  [ -f "$GW_DIR/config/instances.site.json" ] || echo "[]" > "$GW_DIR/config/instances.site.json"
  echo "$kong" > "$GW_DIR/kong/kong.yaml"
  say "  wrote .env, config/gateway.site.toml, config/instances.site.json, kong/kong.yaml"

  # HTTPS certificate for this machine (self-signed; replace with the hospital's own when available).
  mkdir -p "$GW_DIR/certs"
  openssl req -x509 -newkey rsa:2048 -nodes -days 1095 -subj "/CN=${A[GATEWAY_ID]}" \
    -addext "subjectAltName=IP:${A[HOST_IP]},IP:127.0.0.1,DNS:localhost,DNS:${A[GATEWAY_ID]}" \
    -keyout "$GW_DIR/certs/server.key" -out "$GW_DIR/certs/server.crt" >>"$LOG" 2>&1 || die "cannot create the HTTPS certificate"
  chmod 600 "$GW_DIR/certs/server.key"
  say "  HTTPS certificate for ${A[HOST_IP]} (valid 3 years)"
  local owner=${SUDO_USER:-root}
  chown -R "$owner": "$GW_DIR/.env" "$GW_DIR/config" "$GW_DIR/kong" "$GW_DIR/certs" "$GW_DIR/install" 2>/dev/null || true
}

# ------------------------------------------------------------------ 5. start
start_gateway() {
  step "5/6 Starting Flora Gateway (compose.production.yaml)"
  cd "$GW_DIR" || die "cannot enter $GW_DIR"
  if [ "${A[IMAGE_SOURCE]}" = release ]; then
    run "${COMPOSE[@]}" pull || die "cannot download the release images (see $LOG)"
    run "${COMPOSE[@]}" up -d --no-build --remove-orphans || die "start failed (see $LOG)"
  else
    say "  building the images: the first time takes about 10 minutes"
    run "${COMPOSE[@]}" up -d --build --remove-orphans || die "build/start failed (see $LOG)"
  fi
  [ "$DRY_RUN" = 1 ] && return
  local guard; guard=$(docker logs "${PROJECT}-port-guard-1" 2>&1 | tail -3)
  say "  $guard"
  docker logs "${PROJECT}-port-guard-1" 2>&1 | grep -q "real serial ports only" || die "port check failed: $guard"
  say "  waiting for the admin page"
  local i
  for i in $(seq 1 60); do
    curl -fsS -o /dev/null "http://127.0.0.1:7400/login" && break
    sleep 5
  done
  curl -fsS -o /dev/null "http://127.0.0.1:7400/login" || die "the admin page did not come up (see: docker compose -p $PROJECT -f compose.production.yaml logs gateway-service)"
  say "  admin page is up"
}

# ------------------------------------------------------------------ 6. extras + report
install_extras() {
  step "6/6 Extras"
  if [ "${A[BACKUP]}" = yes ]; then
    local unit=/etc/systemd/system/flora-gateway-backup
    if [ "$DRY_RUN" = 1 ]; then
      say "  [dry-run] would add $unit.service/.timer (pg_dump every night at 02:30, keep 7 days)"
    else
      cat > "$unit.service" <<EOF
[Unit]
Description=Flora Gateway database backup
After=docker.service
[Service]
Type=oneshot
ExecStart=/bin/sh -c 'mkdir -p /var/backups/flora-gateway && docker exec ${PROJECT}-gateway-db-1 pg_dump -U flora_gateway -Fc flora_gateway > /var/backups/flora-gateway/flora_gateway-\$(date +%%Y%%m%%d-%%H%%M).dump && find /var/backups/flora-gateway -name "flora_gateway-*.dump" -mtime +7 -delete'
EOF
      cat > "$unit.timer" <<EOF
[Unit]
Description=Nightly Flora Gateway database backup
[Timer]
OnCalendar=*-*-* 02:30:00
Persistent=true
[Install]
WantedBy=timers.target
EOF
      run systemctl daemon-reload
      run systemctl enable --now flora-gateway-backup.timer
      say "  nightly backup at 02:30 -> /var/backups/flora-gateway (7 days)"
    fi
  fi
  say "  start on boot: Docker starts with the machine and restarts every Flora service itself"
}

report() {
  local file=/root/flora-gateway-install-$STAMP.txt
  local text
  text=$(cat <<EOF
Flora Gateway is installed.

$(summary)

Admin page   http://${A[HOST_IP]}:7400   (or https://${A[HOST_IP]}:${A[HTTPS_PORT]})
Username     ${A[ADMIN_USER]}
Password     ${A[ADMIN_PASSWORD]}
Leaf reads   http://${A[HOST_IP]}:7410/data-api/<leaf-id>

Next steps
  1. Sign in and change the password if it was generated. On a machine that already had a gateway
     database, the existing admin account and its password are kept (the new one applies to new installs).
  2. Canopy: register this gateway (ID ${A[GATEWAY_ID]}) so its license and device types arrive.
  3. Add devices in the admin page (Installed devices -> Add device).
Restart / rebuild later:
  cd $GW_DIR && sudo docker compose -p $PROJECT -f compose.production.yaml up -d --build
EOF
)
  if [ "$DRY_RUN" = 1 ]; then
    say "\nDry run finished: nothing was installed or changed. Log: $LOG"
    return
  fi
  umask 077; echo "$text" > "$file"
  say "\n$text\n\n(saved to $file, readable by root only; install log $LOG)"
  [ "$UI" = whiptail ] && whiptail --title "$TITLE" --msgbox "$text" 30 90
}

save_answers() { # every answer except secrets, for the next run (--answers install/last-answers.env)
  local file="$SCRIPT_DIR/last-answers.env" key
  [ "$DRY_RUN" = 1 ] && file=/tmp/flora-gateway-last-answers-$STAMP.env
  { echo "# Flora Gateway installer answers ($(date '+%Y-%m-%d %H:%M')); secrets are not stored"
    for key in GATEWAY_ID HOST_IP HABER_URL ADMIN_USER ADMIN_ON_LAN HTTPS_PORT SERIAL_PORTS LAN_INPUTS LEAF_IDS RETENTION_DAYS IMAGE_SOURCE IMAGE_RUST IMAGE_SERVICE IMAGE_PARSER IMAGE_UPDATER BACKUP; do
      have "$key" && echo "$key=\"${A[$key]}\""
    done; } > "$file"
}

# ------------------------------------------------------------------ main
: > "$LOG" 2>/dev/null || { LOG=/tmp/flora-gateway-install-$STAMP.log; : > "$LOG"; }
say "$TITLE - $(date '+%Y-%m-%d %H:%M')$([ "$DRY_RUN" = 1 ] && echo '  (DRY RUN: nothing will be changed)')"
preflight
install_software
ask_settings
step "Summary"
say "$(summary)"
if [ "$ASSUME_YES" != 1 ]; then
  if [ "$UI" = whiptail ]; then
    whiptail --title "$TITLE" --yesno "Install with these settings?\n\n$(summary)" 24 90 || die "cancelled before any change to the gateway"
  else
    read -r -p "Install with these settings? [y/N]: " ok; [[ ${ok,,} == y* ]] || die "cancelled before any change to the gateway"
  fi
fi
save_answers
write_files
[ "${FLORA_INSTALL_STOP_AFTER:-}" = files ] && { say "\nStopped after writing the files (FLORA_INSTALL_STOP_AFTER=files)."; exit 0; }
start_gateway
install_extras
report
