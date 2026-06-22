#!/usr/bin/env bash
set -Eeuo pipefail

REPO_DIR="${1:-}"
if [[ -z "${REPO_DIR}" ]]; then
  REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
fi
REPO_DIR="$(cd "${REPO_DIR}" && pwd)"

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "[friday-hub-console-build] macOS is required." >&2
  exit 78
fi

SWIFT_BIN="$(command -v swift || true)"
if [[ -z "${SWIFT_BIN}" ]]; then
  echo "[friday-hub-console-build] swift not found in PATH." >&2
  exit 78
fi

NODE_BIN="${FRIDAY_NODE_BIN:-$(command -v node || true)}"
if [[ -z "${NODE_BIN}" ]]; then
  echo "[friday-hub-console-build] node not found in PATH." >&2
  exit 78
fi

PACKAGE_DIR="${REPO_DIR}/apps/macos/FridayHubConsole"
INFO_TEMPLATE="${PACKAGE_DIR}/Info.plist"
BUILD_CONFIGURATION="${FRIDAY_HUB_CONSOLE_BUILD_CONFIGURATION:-release}"
DIST_DIR="${FRIDAY_HUB_CONSOLE_DIST_DIR:-${REPO_DIR}/dist/macos}"
APP_NAME="FridayHubConsole.app"
APP_DIR="${DIST_DIR}/${APP_NAME}"
APP_BINARY="${APP_DIR}/Contents/MacOS/FridayHubConsole"
APP_PLIST="${APP_DIR}/Contents/Info.plist"
APP_VERSION="${FRIDAY_MACOS_APP_VERSION:-$("${NODE_BIN}" -p "require('./package.json').version")}"
APP_BUILD="${FRIDAY_MACOS_APP_BUILD:-${APP_VERSION}}"
BUNDLE_IDENTIFIER="${FRIDAY_HUB_CONSOLE_BUNDLE_IDENTIFIER:-com.friday.HubConsole}"
SIGN_MODE="${FRIDAY_MACOS_CODESIGN_MODE:-adhoc}"
SIGN_IDENTITY="${FRIDAY_MACOS_CODESIGN_IDENTITY:-}"

if [[ ! -f "${PACKAGE_DIR}/Package.swift" ]]; then
  echo "[friday-hub-console-build] missing Swift package at ${PACKAGE_DIR}" >&2
  exit 78
fi
if [[ ! -f "${INFO_TEMPLATE}" ]]; then
  echo "[friday-hub-console-build] missing Info.plist template at ${INFO_TEMPLATE}" >&2
  exit 78
fi

case "${SIGN_MODE}" in
  adhoc|identity|skip) ;;
  *)
    echo "[friday-hub-console-build] invalid FRIDAY_MACOS_CODESIGN_MODE=${SIGN_MODE}; expected adhoc|identity|skip." >&2
    exit 78
    ;;
esac

echo "[friday-hub-console-build] building Swift Hub Console (${BUILD_CONFIGURATION})" >&2
"${SWIFT_BIN}" build -c "${BUILD_CONFIGURATION}" --package-path "${PACKAGE_DIR}" >&2
SWIFT_BIN_DIR="$("${SWIFT_BIN}" build -c "${BUILD_CONFIGURATION}" --package-path "${PACKAGE_DIR}" --show-bin-path)"
SWIFT_BINARY="${SWIFT_BIN_DIR}/FridayHubConsole"
RESOURCE_BUNDLE="${SWIFT_BIN_DIR}/FridayHubConsole_FridayHubConsole.bundle"

if [[ ! -x "${SWIFT_BINARY}" ]]; then
  echo "[friday-hub-console-build] missing built binary: ${SWIFT_BINARY}" >&2
  exit 78
fi
if [[ ! -d "${RESOURCE_BUNDLE}" ]]; then
  echo "[friday-hub-console-build] missing SwiftPM resource bundle: ${RESOURCE_BUNDLE}" >&2
  exit 78
fi

rm -rf "${APP_DIR}"
mkdir -p "${APP_DIR}/Contents/MacOS" "${APP_DIR}/Contents/Resources"
cp "${SWIFT_BINARY}" "${APP_BINARY}"
cp -R "${RESOURCE_BUNDLE}" "${APP_DIR}/Contents/Resources/"

sed \
  -e "s#__APP_VERSION__#${APP_VERSION}#g" \
  -e "s#__APP_BUILD__#${APP_BUILD}#g" \
  -e "s#__BUNDLE_IDENTIFIER__#${BUNDLE_IDENTIFIER}#g" \
  "${INFO_TEMPLATE}" > "${APP_PLIST}"

printf 'APPL????' > "${APP_DIR}/Contents/PkgInfo"

if [[ -x /usr/bin/xattr ]]; then
  /usr/bin/xattr -cr "${APP_DIR}"
  while IFS= read -r -d '' bundle_path; do
    /usr/bin/xattr -d com.apple.FinderInfo "${bundle_path}" >/dev/null 2>&1 || true
    /usr/bin/xattr -d 'com.apple.fileprovider.fpfs#P' "${bundle_path}" >/dev/null 2>&1 || true
  done < <(find "${APP_DIR}" -print0)
fi

case "${SIGN_MODE}" in
  skip)
    echo "[friday-hub-console-build] leaving app unsigned at ${APP_DIR}" >&2
    ;;
  adhoc)
    echo "[friday-hub-console-build] applying ad-hoc signature" >&2
    /usr/bin/codesign --force --deep --sign - "${APP_DIR}"
    ;;
  identity)
    if [[ -z "${SIGN_IDENTITY}" ]]; then
      echo "[friday-hub-console-build] FRIDAY_MACOS_CODESIGN_IDENTITY is required when SIGN_MODE=identity." >&2
      exit 78
    fi
    echo "[friday-hub-console-build] signing with identity ${SIGN_IDENTITY}" >&2
    /usr/bin/codesign --force --options runtime --timestamp --sign "${SIGN_IDENTITY}" "${APP_DIR}"
    ;;
esac

echo "${APP_DIR}"
