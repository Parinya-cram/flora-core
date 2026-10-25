#!/usr/bin/env bash
# Builds install/windows/dist/FloraGatewaySetup-<version>.exe (Windows setup) on Linux, with NSIS in Docker.
#
#   install/windows/build-setup.sh [version]          version defaults to today's date, e.g. 2026.10.22
#
# The setup holds everything a Windows site needs and NO source code:
#   - compose.windows.yaml, db/, edge/ and the Windows scripts (installer, start, autostart, COM check)
#   - windows/bin/serial-controller.exe, ready-made (cross-compiled here when missing)
#   - images/flora-gateway-images.tar.gz: every image of compose.windows.yaml, saved from this
#     machine's Docker (build them first: docker compose -p flora-gateway -f compose.production.yaml build)
# and no site data: no .env, certificates, keys or site configs (the installer writes them).
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
GW=$(cd "$HERE/../.." && pwd)
VERSION=${1:-$(date +%Y.%-m.%-d)}
[[ $VERSION =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "version must look like 2026.10.22"; exit 2; }
DIST="$HERE/dist"
WORK=$(mktemp -d)
trap 'docker run --rm -v "$WORK":/w alpine:3.20 rm -rf /w/stage >/dev/null 2>&1; rm -rf "$WORK"' EXIT
STAGE="$WORK/stage"
mkdir -p "$DIST" "$STAGE"/{config,kong,certs,images,windows/bin,install/windows,scripts/windows}
cd "$GW"

# 1. serial-controller.exe: ready-made, cross-compiled for Windows here when missing.
EXE=windows/bin/serial-controller.exe
if [ ! -f "$EXE" ]; then
  echo "cross-compiling $EXE (x86_64-pc-windows-gnu, about 10 minutes)"
  mkdir -p windows/bin
  docker run --rm -v "$GW/rust":/src:ro -v "$GW/windows/bin":/out rust:1-bookworm sh -c '
    set -e
    apt-get update -qq >/dev/null && apt-get install -y -qq mingw-w64 cmake >/dev/null 2>&1
    rustup target add x86_64-pc-windows-gnu >/dev/null 2>&1
    cp -r /src /build && cd /build && rm -rf target
    CARGO_TARGET_X86_64_PC_WINDOWS_GNU_LINKER=x86_64-w64-mingw32-gcc \
    CC_x86_64_pc_windows_gnu=x86_64-w64-mingw32-gcc CXX_x86_64_pc_windows_gnu=x86_64-w64-mingw32-g++ \
      cargo build --release --locked -p serial-controller --target x86_64-pc-windows-gnu
    cp target/x86_64-pc-windows-gnu/release/serial-controller.exe /out/
    chown '"$(id -u):$(id -g)"' /out/serial-controller.exe'
fi
file "$EXE" | grep -q 'PE32+ executable' || { echo "$EXE is not a 64-bit Windows program"; exit 1; }

# 2. Files (explicit list: no source code, no site data).
cp -p compose.windows.yaml "$STAGE/"
cp -rp db edge "$STAGE/"
cp -p install/windows/Install-FloraGateway.ps1 install/windows/Install-FloraGateway.cmd "$STAGE/install/windows/"
cp -p install/README.md "$STAGE/install/"
cp -p windows/*.ps1 "$STAGE/windows/"
cp -p "$EXE" "$STAGE/windows/bin/"
cp -p scripts/windows/* "$STAGE/scripts/windows/" 2>/dev/null || true
# Windows PowerShell 5.1 reads a .ps1 without BOM in the system code page: make sure every one has it.
find "$STAGE" -name '*.ps1' -print0 | while IFS= read -r -d '' f; do
  head -c3 "$f" | cmp -s - <(printf '\xef\xbb\xbf') || { printf '\xef\xbb\xbf' | cat - "$f" > "$f.bom" && mv "$f.bom" "$f"; }
done

# 3. Images: everything compose.windows.yaml runs, from this machine's Docker.
mapfile -t IMAGES < <(docker compose -f compose.windows.yaml config --images | sort -u)
for i in "${IMAGES[@]}"; do
  docker image inspect "$i" >/dev/null 2>&1 || { echo "image $i is not on this machine (build or pull it first)"; exit 1; }
  printf '  %-34s %s  %s\n' "$i" "$(docker image inspect -f '{{.Id}}' "$i" | cut -c8-19)" "$(docker image inspect -f '{{.Created}}' "$i" | cut -c1-16)"
done
echo "saving ${#IMAGES[@]} images (about a minute)"
docker save "${IMAGES[@]}" | gzip -6 > "$STAGE/images/flora-gateway-images.tar.gz"
printf '%s\n' "${IMAGES[@]}" > "$STAGE/images/images.txt"

# 4. Checks.
[ -z "$(find "$STAGE" \( -name '*.py' -o -name '*.rs' -o -name 'Cargo.toml' -o -name 'Dockerfile' \) -print -quit)" ] || { echo "source code in the package - stopping"; exit 1; }
if grep -rlE '^(GATEWAY_ADMIN_PASSWORD|FLORA_GATEWAY_DB_PASSWORD|HABER_GATEWAY_TOKEN)=[^$[:space:]]' "$STAGE" --exclude='*.tar.gz' 2>/dev/null; then
  echo "a file with secrets is in the package - stopping"; exit 1
fi
echo "package: $(find "$STAGE" -type f | wc -l) files, $(du -sh "$STAGE" | cut -f1)"

# 5. Setup .exe.
cp "$HERE/flora-gateway-setup.nsi" "$WORK/"
docker run --rm -v "$WORK":/w -v "$DIST":/out debian:bookworm-slim sh -c "
  apt-get update -qq >/dev/null && apt-get install -y -qq nsis >/dev/null 2>&1 &&
  makensis -V2 -DVERSION=$VERSION -DSTAGE=/w/stage -DOUTFILE=/out/FloraGatewaySetup-$VERSION.exe /w/flora-gateway-setup.nsi &&
  chown $(id -u):$(id -g) /out/FloraGatewaySetup-$VERSION.exe"
ls -l "$DIST/FloraGatewaySetup-$VERSION.exe"
(cd "$DIST" && sha256sum "FloraGatewaySetup-$VERSION.exe" | tee "FloraGatewaySetup-$VERSION.exe.sha256")
