#!/usr/bin/env bash
# Host setup for the dream3d headless render harness (src/render/headless.ts).
#
# Provisions everything needed to render a three.js scene to a PNG in headless
# Chromium with software WebGL, WITHOUT root/sudo. This is the executable form of
# the steps documented in docs/headless-render.md. It is idempotent.
#
# What it installs (all under ~/tools, per the repo "deps live in ~/tools" rule):
#   1. an importable `playwright` npm package         -> ~/tools/playwright
#   2. the matching Chromium browser binary           -> ~/.cache/ms-playwright
#   3. Chromium's system libraries (extracted .debs)  -> ~/tools/playwright-libs
#
# Usage:  bash scripts/setup-headless-render.sh
set -euo pipefail

PLAYWRIGHT_VERSION="1.60.0"
PW_DIR="$HOME/tools/playwright"
LIBS_PREFIX="$HOME/tools/playwright-libs/ubuntu2204"

# Ubuntu 22.04 (jammy) packages providing Chromium's shared libraries. libnssutil3
# and libsmime3 are bundled inside libnss3, so they are intentionally not listed.
PACKAGES=(
  libnspr4 libnss3 libasound2 libatk1.0-0 libatk-bridge2.0-0 libatspi2.0-0
  libcups2 libdbus-1-3 libdrm2 libgbm1 libexpat1 libglib2.0-0
  libpango-1.0-0 libcairo2 libx11-6 libxcb1 libxcomposite1 libxdamage1
  libxext6 libxfixes3 libxkbcommon0 libxrandr2 libxshmfence1
)

echo ">> 1/3 Installing importable playwright@${PLAYWRIGHT_VERSION} into ${PW_DIR}"
mkdir -p "$PW_DIR"
( cd "$PW_DIR"
  [ -f package.json ] || npm init -y >/dev/null
  npm install "playwright@${PLAYWRIGHT_VERSION}" >/dev/null )

echo ">> 2/3 Installing the Chromium browser binary (into ~/.cache/ms-playwright)"
"$PW_DIR/node_modules/.bin/playwright" install chromium

echo ">> 3/3 Downloading + extracting Chromium system libraries into ${LIBS_PREFIX}"
rm -rf "$LIBS_PREFIX"
mkdir -p "$LIBS_PREFIX"
TMP_DEBS="$(mktemp -d)"
trap 'rm -rf "$TMP_DEBS"' EXIT
( cd "$TMP_DEBS"
  for pkg in "${PACKAGES[@]}"; do
    apt-get download "$pkg" >/dev/null 2>&1 || { echo "   WARNING: could not download $pkg"; }
  done
  for deb in *.deb; do dpkg-deb -x "$deb" "$LIBS_PREFIX"; done )

# Verify the headless-shell binary has no unresolved libraries.
SHELL_BIN="$(find "$HOME/.cache/ms-playwright" -name chrome-headless-shell -type f | head -n1)"
export LD_LIBRARY_PATH="$LIBS_PREFIX/usr/lib/x86_64-linux-gnu:$LIBS_PREFIX/lib/x86_64-linux-gnu:${LD_LIBRARY_PATH:-}"
MISSING="$(ldd "$SHELL_BIN" 2>/dev/null | grep -c 'not found' || true)"

echo ""
if [ "$MISSING" -eq 0 ]; then
  echo "OK: Chromium headless-shell resolves all system libraries."
  echo "Now run:  node scripts/render-smoke.mjs"
else
  echo "ERROR: $MISSING libraries still unresolved for $SHELL_BIN:"
  ldd "$SHELL_BIN" 2>/dev/null | grep 'not found' || true
  exit 1
fi
