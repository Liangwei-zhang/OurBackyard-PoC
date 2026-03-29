#!/usr/bin/env bash
set -euo pipefail

# Build a distributable offline package for single-machine install.
# - Includes only runtime assets (no node_modules/tests/dev files)
# - Produces: releases/<name>/ and releases/<name>.zip

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RELEASES_DIR="${ROOT_DIR}/releases"
STAMP="$(date +%Y%m%d-%H%M%S)"
VERSION="$(grep -oE '"version"\s*:\s*"[^"]+"' "${ROOT_DIR}/package.json" | head -n1 | sed -E 's/.*"([^"]+)".*/\1/' || true)"
if [[ -z "${VERSION}" ]]; then
  VERSION="dev"
fi

PKG_NAME="ourbackyard-offline-v${VERSION}-${STAMP}"
STAGE_DIR="${RELEASES_DIR}/${PKG_NAME}"
ZIP_PATH="${RELEASES_DIR}/${PKG_NAME}.zip"

mkdir -p "${STAGE_DIR}"

copy_file() {
  local rel="$1"
  if [[ ! -f "${ROOT_DIR}/${rel}" ]]; then
    echo "[WARN] Missing file: ${rel}"
    return 0
  fi
  mkdir -p "${STAGE_DIR}/$(dirname "${rel}")"
  cp -a "${ROOT_DIR}/${rel}" "${STAGE_DIR}/${rel}"
}

copy_dir() {
  local rel="$1"
  if [[ ! -d "${ROOT_DIR}/${rel}" ]]; then
    echo "[WARN] Missing dir: ${rel}"
    return 0
  fi
  mkdir -p "${STAGE_DIR}"
  cp -a "${ROOT_DIR}/${rel}" "${STAGE_DIR}/${rel}"
}

echo "[INFO] Packaging from: ${ROOT_DIR}"
echo "[INFO] Staging to:     ${STAGE_DIR}"

# Runtime files directly loaded by index.html / PWA shell.
RUNTIME_FILES=(
  "index.html"
  "manifest.json"
  "sw.js"
  "ice-servers.json"
  "icon-192.png"
  "icon-512.png"
  "ob-utils.js"
  "publish-guard.js"
  "p1p2-features.js"
  "legal.html"
  "keygen.html"
  "README.md"
)

# Runtime directories used by the app.
RUNTIME_DIRS=(
  "native"
  "js"
  "src"
  "public"
)

for f in "${RUNTIME_FILES[@]}"; do
  copy_file "${f}"
done

for d in "${RUNTIME_DIRS[@]}"; do
  copy_dir "${d}"
done

# Add local launchers for recipients.
cat > "${STAGE_DIR}/start-local.sh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
PORT="${1:-8080}"
echo "OurBackyard offline package"
echo "Serving: http://localhost:${PORT}"
echo "Press Ctrl+C to stop"
python3 -m http.server "${PORT}"
EOF
chmod +x "${STAGE_DIR}/start-local.sh"

cat > "${STAGE_DIR}/start-local.bat" <<'EOF'
@echo off
setlocal
cd /d "%~dp0"
set PORT=%1
if "%PORT%"=="" set PORT=8080
echo OurBackyard offline package
echo Serving: http://localhost:%PORT%
echo Press Ctrl+C to stop
py -3 -m http.server %PORT%
if errorlevel 1 python -m http.server %PORT%
endlocal
EOF

cat > "${STAGE_DIR}/OFFLINE_INSTALL.md" <<EOF
# OurBackyard Offline Package

This package is self-contained and does not require \`node_modules\`.

## Windows
1. Double-click \`start-local.bat\`
2. Open [http://localhost:8080](http://localhost:8080)

## Linux / macOS
1. Run \`./start-local.sh\`
2. Open [http://localhost:8080](http://localhost:8080)

## Notes
- This is a decentralized client runtime package.
- No central backend is required for core P2P flow.
- Optional TURN config is in \`ice-servers.json\`.
EOF

# Build zip output.
rm -f "${ZIP_PATH}"
(
  cd "${RELEASES_DIR}"
  zip -r -q "${ZIP_PATH##*/}" "${PKG_NAME}"
)

echo "[OK] Offline package folder:"
echo "     ${STAGE_DIR}"
echo "[OK] Offline package zip:"
echo "     ${ZIP_PATH}"
