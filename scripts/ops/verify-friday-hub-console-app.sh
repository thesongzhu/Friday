#!/usr/bin/env bash
set -Eeuo pipefail

REPO_DIR="${1:-}"
if [[ -z "${REPO_DIR}" ]]; then
  REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
fi
REPO_DIR="$(cd "${REPO_DIR}" && pwd)"

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "[friday-hub-console-verify] macOS is required." >&2
  exit 78
fi

APP_DIR="${FRIDAY_HUB_CONSOLE_APP_DIR:-${REPO_DIR}/dist/macos/FridayHubConsole.app}"
if [[ ! -d "${APP_DIR}" ]]; then
  APP_DIR="$(bash "${REPO_DIR}/scripts/ops/build-friday-hub-console-app.sh" "${REPO_DIR}")"
fi

APP_BINARY="${APP_DIR}/Contents/MacOS/FridayHubConsole"
APP_PLIST="${APP_DIR}/Contents/Info.plist"
RESOURCE_BUNDLE="${APP_DIR}/Contents/Resources/FridayHubConsole_FridayHubConsole.bundle"

if [[ ! -x "${APP_BINARY}" ]]; then
  echo "[friday-hub-console-verify] missing app binary at ${APP_BINARY}" >&2
  exit 78
fi
if [[ ! -f "${APP_PLIST}" ]]; then
  echo "[friday-hub-console-verify] missing Info.plist at ${APP_PLIST}" >&2
  exit 78
fi
if [[ ! -d "${RESOURCE_BUNDLE}" ]]; then
  echo "[friday-hub-console-verify] missing resource bundle at ${RESOURCE_BUNDLE}" >&2
  exit 78
fi

echo "[friday-hub-console-verify] verifying bundle structure" >&2
/usr/bin/plutil -lint "${APP_PLIST}" >/dev/null

if [[ -x /usr/bin/xattr ]]; then
  /usr/bin/xattr -cr "${APP_DIR}"
  while IFS= read -r -d '' bundle_path; do
    /usr/bin/xattr -d com.apple.FinderInfo "${bundle_path}" >/dev/null 2>&1 || true
    /usr/bin/xattr -d 'com.apple.fileprovider.fpfs#P' "${bundle_path}" >/dev/null 2>&1 || true
  done < <(find "${APP_DIR}" -print0)
fi

echo "[friday-hub-console-verify] verifying executable signature" >&2
/usr/bin/codesign --verify --deep --strict --verbose=2 "${APP_DIR}"

if [[ "${FRIDAY_HUB_CONSOLE_VERIFY_RENDER:-true}" == "true" ]]; then
  PROOF_DIR="$(mktemp -d "${TMPDIR:-/tmp}/friday-hub-console-render.XXXXXX")"
  trap 'rm -rf "${PROOF_DIR}"' EXIT
  echo "[friday-hub-console-verify] running state render proof" >&2
  "${APP_BINARY}" --state-render-proof "${PROOF_DIR}" >/dev/null
  if ! find "${PROOF_DIR}" -type f -name '*.png' -size +0c | grep -q .; then
    echo "[friday-hub-console-verify] state render proof did not produce a PNG" >&2
    exit 78
  fi
fi

echo "${APP_DIR}"
