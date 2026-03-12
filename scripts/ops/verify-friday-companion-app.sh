#!/usr/bin/env bash
set -Eeuo pipefail

REPO_DIR="${1:-}"
if [[ -z "${REPO_DIR}" ]]; then
  REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
fi
REPO_DIR="$(cd "${REPO_DIR}" && pwd)"

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "[friday-companion-verify] macOS is required." >&2
  exit 78
fi

VERIFY_MODE="${FRIDAY_MACOS_VERIFY_MODE:-local}"
if [[ "${VERIFY_MODE}" != "local" && "${VERIFY_MODE}" != "notarized" ]]; then
  echo "[friday-companion-verify] invalid FRIDAY_MACOS_VERIFY_MODE=${VERIFY_MODE}; expected local|notarized." >&2
  exit 78
fi

APP_DIR="${FRIDAY_SYSTEM_COMPANION_APP_DIR:-${REPO_DIR}/dist/macos/FridayCompanion.app}"
if [[ ! -d "${APP_DIR}" ]]; then
  APP_DIR="$(bash "${REPO_DIR}/scripts/ops/build-friday-companion-app.sh" "${REPO_DIR}")"
fi

APP_BINARY="${APP_DIR}/Contents/MacOS/FridayCompanion"
APP_PLIST="${APP_DIR}/Contents/Info.plist"

if [[ ! -x "${APP_BINARY}" ]]; then
  echo "[friday-companion-verify] missing app binary at ${APP_BINARY}" >&2
  exit 78
fi

if [[ ! -f "${APP_PLIST}" ]]; then
  echo "[friday-companion-verify] missing Info.plist at ${APP_PLIST}" >&2
  exit 78
fi

echo "[friday-companion-verify] verifying bundle structure" >&2
/usr/bin/plutil -lint "${APP_PLIST}" >/dev/null

echo "[friday-companion-verify] verifying executable signature" >&2
/usr/bin/codesign --verify --deep --strict --verbose=2 "${APP_DIR}"

if [[ "${VERIFY_MODE}" == "notarized" ]]; then
  if ! command -v xcrun >/dev/null 2>&1; then
    echo "[friday-companion-verify] xcrun is required for notarized verification." >&2
    exit 78
  fi
  echo "[friday-companion-verify] validating stapled ticket" >&2
  /usr/bin/xcrun stapler validate "${APP_DIR}"

  echo "[friday-companion-verify] running Gatekeeper assessment" >&2
  /usr/sbin/spctl --assess --type execute --verbose=4 "${APP_DIR}"
fi

echo "${APP_DIR}"
