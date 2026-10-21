#!/bin/sh
# Build the Windows installer "Flora iCIS Setup" (Electron + first-run setup) on the Linux CI runner, without
# Windows: serial-controller.exe is cross-compiled for COM ports, electron-builder runs under wine. The .exe is
# then wrapped in a tiny image (flora-windows-setup:<TAG>) so it travels Root -> appliance with the Leaf release
# and hospital PCs download it from the appliance on the LAN. Runs as gitlab-runner (sudo nerdctl only).
set -eu
TAG="$1"; VERSION="1.0.${CI_PIPELINE_IID:-0}"
ROOT_DIR=$(pwd); UID_GID="$(id -u):$(id -g)"
mkdir -p build-win

echo "== serial-controller.exe (COM ports on Windows)"
sudo -n nerdctl run --rm -v "$ROOT_DIR/flora-gateway/rust:/src:ro" -v "$ROOT_DIR/build-win:/out" \
  -v flora-cargo-registry:/usr/local/cargo/registry -v flora-cargo-target-win:/target docker.io/library/rust:1-bookworm sh -c "
    set -e; apt-get update -qq >/dev/null; apt-get install -y -qq gcc-mingw-w64-x86-64 g++-mingw-w64-x86-64 cmake >/dev/null
    rustup target add x86_64-pc-windows-gnu >/dev/null
    cd /src && CARGO_TARGET_DIR=/target cargo build --release --locked -p serial-controller --target x86_64-pc-windows-gnu
    cp /target/x86_64-pc-windows-gnu/release/serial-controller.exe /out/ && chown $UID_GID /out/serial-controller.exe"

echo "== Leaf screens + Electron installer (wine)"
sudo -n nerdctl run --rm -v "$ROOT_DIR:/project" -w /project \
  -v flora-electron-cache:/root/.cache docker.io/electronuserland/builder:wine sh -c "
    set -e; npm ci --no-audit --no-fund >/dev/null
    cd frontend && npm ci --no-audit --no-fund >/dev/null && VITE_FLORA_SURFACE=leaf npm run build >/dev/null && cd ..
    npx electron-builder --win --x64 --publish never -c.extraMetadata.version=$VERSION
    chown -R $UID_GID dist-electron node_modules frontend/node_modules frontend/dist build-win"

EXE=$(ls dist-electron/Flora-iCIS-Setup-*.exe | head -1); ls -la "$EXE"
echo "== image flora-windows-setup:$TAG"
CTX=$(mktemp -d); cp "$EXE" "$CTX/Flora-iCIS-Setup.exe"
printf 'FROM scratch\nCOPY Flora-iCIS-Setup.exe /Flora-iCIS-Setup.exe\n' > "$CTX/Dockerfile"
sudo -n nerdctl -n k8s.io build -q -t "flora-windows-setup:$TAG" "$CTX" >/dev/null; rm -rf "$CTX"
echo "built flora-windows-setup:$TAG ($VERSION)"
