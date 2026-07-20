#!/usr/bin/env bash
set -Eeuo pipefail

REPO_DIR="${1:-}"
if [[ -z "${REPO_DIR}" ]]; then
  REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
fi
REPO_DIR="$(cd "${REPO_DIR}" && pwd)"
LOCK_DIR="${FRIDAY_MACOS_RELEASE_LOCK_DIR:-${REPO_DIR}/.friday/locks/macos-release.lock}"
LOCK_OWNER_FILE="${LOCK_DIR}/owner.pid"

lock_mtime_epoch() {
  if stat -f %m "${LOCK_DIR}" >/dev/null 2>&1; then
    stat -f %m "${LOCK_DIR}"
    return
  fi
  stat -c %Y "${LOCK_DIR}"
}

cleanup_stale_release_lock() {
  if [[ ! -d "${LOCK_DIR}" ]]; then
    return 1
  fi

  if [[ -f "${LOCK_OWNER_FILE}" ]]; then
    local owner_pid
    owner_pid="$(tr -d '[:space:]' < "${LOCK_OWNER_FILE}")"
    if [[ -n "${owner_pid}" ]] && kill -0 "${owner_pid}" >/dev/null 2>&1; then
      return 1
    fi
    rm -rf "${LOCK_DIR}"
    return 0
  fi

  local now_epoch
  now_epoch="$(date +%s)"
  local mtime_epoch
  mtime_epoch="$(lock_mtime_epoch 2>/dev/null || echo 0)"
  if [[ "${mtime_epoch}" =~ ^[0-9]+$ ]] && (( now_epoch - mtime_epoch >= 30 )); then
    rm -rf "${LOCK_DIR}"
    return 0
  fi

  return 1
}

acquire_release_lock() {
  if [[ "${FRIDAY_MACOS_RELEASE_LOCK_HELD:-false}" == "true" ]]; then
    return
  fi

  mkdir -p "$(dirname "${LOCK_DIR}")"
  local attempts=0
  until mkdir "${LOCK_DIR}" >/dev/null 2>&1; do
    cleanup_stale_release_lock >/dev/null 2>&1 && continue
    attempts="$((attempts + 1))"
    if (( attempts >= 120 )); then
      echo "[friday-companion-dmg] timed out waiting for release lock at ${LOCK_DIR}" >&2
      exit 75
    fi
    sleep 1
  done

  printf '%s\n' "$$" > "${LOCK_OWNER_FILE}"
  export FRIDAY_MACOS_RELEASE_LOCK_HELD="true"
  export FRIDAY_MACOS_RELEASE_LOCK_OWNER="true"
  trap 'if [[ "${FRIDAY_MACOS_RELEASE_LOCK_OWNER:-false}" == "true" ]]; then rm -rf "${LOCK_DIR}"; fi' EXIT
}

acquire_release_lock

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "[friday-companion-dmg] macOS is required." >&2
  exit 78
fi

NODE_BIN="${FRIDAY_NODE_BIN:-$(command -v node || true)}"
if [[ -z "${NODE_BIN}" ]]; then
  echo "[friday-companion-dmg] node not found in PATH." >&2
  exit 78
fi

if ! command -v hdiutil >/dev/null 2>&1; then
  echo "[friday-companion-dmg] hdiutil not found in PATH." >&2
  exit 78
fi

APP_DIR="${FRIDAY_SYSTEM_COMPANION_APP_DIR:-${REPO_DIR}/dist/macos/FridayCompanion.app}"
if [[ ! -x "${APP_DIR}/Contents/MacOS/FridayCompanion" ]]; then
  echo "[friday-companion-dmg] packaged app missing; building local release first." >&2
  APP_DIR="$(bash "${REPO_DIR}/scripts/ops/release-friday-companion-app.sh" "${REPO_DIR}")"
fi

APP_PLIST="${APP_DIR}/Contents/Info.plist"
if [[ ! -f "${APP_PLIST}" ]]; then
  echo "[friday-companion-dmg] missing Info.plist at ${APP_PLIST}." >&2
  exit 78
fi

VERSION="$(/usr/bin/plutil -extract CFBundleShortVersionString raw -o - "${APP_PLIST}")"
ARCH="$(uname -m)"
case "${ARCH}" in
  x86_64) ARCH="x64" ;;
  arm64) ARCH="arm64" ;;
esac

OUTPUT_DIR="${FRIDAY_MACOS_RELEASE_OUTPUT_DIR:-${REPO_DIR}/dist/releases/macos}"
STAGING_DIR="$(mktemp -d "${TMPDIR:-/tmp}/friday-companion-dmg.XXXXXX")"
trap 'rm -rf "${STAGING_DIR}"' EXIT

ZIP_PATH="${OUTPUT_DIR}/FridayCompanion-${VERSION}-macos-${ARCH}.zip"
DMG_PATH="${OUTPUT_DIR}/FridayCompanion-${VERSION}-macos-${ARCH}.dmg"
mkdir -p "${OUTPUT_DIR}"

cp -R "${APP_DIR}" "${STAGING_DIR}/FridayCompanion.app"
ln -s /Applications "${STAGING_DIR}/Applications"

# CORE-A round-3 Lane C (finding #4): stage the Rust agent-run WS server payload —
# both bins (hub_agent_run_server + hub_agent_run_enroll), the launchd plist TEMPLATE,
# the fill/enroll/launch cutover tool, and a payload-manifest.json — into the DMG (a
# top-level rust-agent-run/ folder; kept OUT of the signed .app bundle so it does not
# invalidate the app signature). The release runtime routes a qualifying agent-run /
# session create+append to this loopback sealed-WS server; TS startRun is retired to a
# fail-closed 503 with NO silent fallback. Before this, the DMG carried ZERO Rust
# server, so a clean install hit 503 on every run. install-friday-launchagent.sh
# consumes the staged payload to install + enroll + launch the 4th launch agent.
bash "${REPO_DIR}/scripts/ops/launchd/stage-rust-agent-run-ws-server-payload.sh" \
  --repo-dir "${REPO_DIR}" --dest-dir "${STAGING_DIR}" >/dev/null

/usr/bin/ditto -c -k --sequesterRsrc --keepParent "${APP_DIR}" "${ZIP_PATH}"
/usr/bin/hdiutil create \
  -quiet \
  -volname "Friday Companion" \
  -srcfolder "${STAGING_DIR}" \
  -ov \
  -format UDZO \
  "${DMG_PATH}"

RELEASE_RECORD_PATH="${REPO_DIR}/dist/macos/FridayCompanion.release.json"
SIGNING_STATUS="$(
  RELEASE_RECORD_PATH="${RELEASE_RECORD_PATH}" \
    "${NODE_BIN}" --input-type=commonjs -e '
      const fs = require("node:fs");
      const path = process.env.RELEASE_RECORD_PATH;
      if (!path || !fs.existsSync(path)) {
        process.stdout.write("adhoc");
        process.exit(0);
      }
      const record = JSON.parse(fs.readFileSync(path, "utf8"));
      if (record.notarizationStatus === "completed") {
        process.stdout.write("notarized");
      } else if (record.codesignMode === "identity") {
        process.stdout.write("signed");
      } else {
        process.stdout.write("adhoc");
      }
    '
)"

NOTARIZATION_STATUS="$(
  RELEASE_RECORD_PATH="${RELEASE_RECORD_PATH}" \
    "${NODE_BIN}" --input-type=commonjs -e '
      const fs = require("node:fs");
      const path = process.env.RELEASE_RECORD_PATH;
      if (!path || !fs.existsSync(path)) {
        process.stdout.write("not_requested");
        process.exit(0);
      }
      const record = JSON.parse(fs.readFileSync(path, "utf8"));
      process.stdout.write(record.notarizationStatus ?? "not_requested");
    '
)"

DOWNLOAD_BASE_URL="${FRIDAY_RELEASE_DOWNLOAD_BASE_URL:-https://github.com/thesongzhu/Friday/releases/download/v${VERSION}}"
COMMON_NOTES='["Native macOS companion artifact.","Launch the Friday hub separately or through launchd after installing the companion."]'

FRIDAY_ARTIFACT_REPO_ROOT="${REPO_DIR}" \
FRIDAY_ARTIFACT_PATH="${ZIP_PATH}" \
FRIDAY_ARTIFACT_METADATA_PATH="${ZIP_PATH}.artifact.json" \
FRIDAY_ARTIFACT_ID="macos-swift-app-zip" \
FRIDAY_ARTIFACT_PLATFORM="macos" \
FRIDAY_ARTIFACT_KIND="zip" \
FRIDAY_ARTIFACT_ARCH="${ARCH}" \
FRIDAY_ARTIFACT_DISPLAY_NAME="Friday Companion macOS zip" \
FRIDAY_ARTIFACT_AVAILABILITY="available" \
FRIDAY_ARTIFACT_INSTALL_SUMMARY="Unzip FridayCompanion.app and move it into Applications, then install launchd agents." \
FRIDAY_ARTIFACT_SIGNING_STATUS="${SIGNING_STATUS}" \
FRIDAY_ARTIFACT_NOTARIZATION_STATUS="${NOTARIZATION_STATUS}" \
FRIDAY_ARTIFACT_RUNTIME_KIND="swift_app" \
FRIDAY_ARTIFACT_DOWNLOAD_BASE_URL="${DOWNLOAD_BASE_URL}" \
FRIDAY_ARTIFACT_NOTES="${COMMON_NOTES}" \
  "${NODE_BIN}" "${REPO_DIR}/scripts/ops/write-friday-artifact-metadata.mjs" >/dev/null

FRIDAY_ARTIFACT_REPO_ROOT="${REPO_DIR}" \
FRIDAY_ARTIFACT_PATH="${DMG_PATH}" \
FRIDAY_ARTIFACT_METADATA_PATH="${DMG_PATH}.artifact.json" \
FRIDAY_ARTIFACT_ID="macos-swift-app-dmg" \
FRIDAY_ARTIFACT_PLATFORM="macos" \
FRIDAY_ARTIFACT_KIND="dmg" \
FRIDAY_ARTIFACT_ARCH="${ARCH}" \
FRIDAY_ARTIFACT_DISPLAY_NAME="Friday Companion macOS DMG" \
FRIDAY_ARTIFACT_AVAILABILITY="available" \
FRIDAY_ARTIFACT_INSTALL_SUMMARY="Open the DMG, drag FridayCompanion.app into Applications, then install launchd agents." \
FRIDAY_ARTIFACT_SIGNING_STATUS="${SIGNING_STATUS}" \
FRIDAY_ARTIFACT_NOTARIZATION_STATUS="${NOTARIZATION_STATUS}" \
FRIDAY_ARTIFACT_RUNTIME_KIND="swift_app" \
FRIDAY_ARTIFACT_DOWNLOAD_BASE_URL="${DOWNLOAD_BASE_URL}" \
FRIDAY_ARTIFACT_NOTES='["Primary macOS GitHub Releases artifact.","Homebrew Cask generation uses this DMG when a tagged release is cut."]' \
  "${NODE_BIN}" "${REPO_DIR}/scripts/ops/write-friday-artifact-metadata.mjs" >/dev/null

echo "${DMG_PATH}"
