#!/usr/bin/env bash
set -Eeuo pipefail

REPO_DIR="${1:-}"
if [[ -z "${REPO_DIR}" ]]; then
  REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
fi
REPO_DIR="$(cd "${REPO_DIR}" && pwd)"
LOCK_DIR="${FRIDAY_MACOS_RELEASE_LOCK_DIR:-${REPO_DIR}/.friday/locks/macos-release.lock}"
CHANNELS_DIR="${FRIDAY_RELEASE_CHANNELS_DIR:-${REPO_DIR}/dist/releases/channels}"
SPARKLE_APPCAST_PATH="${FRIDAY_SYSTEM_COMPANION_SPARKLE_APPCAST_PATH:-${REPO_DIR}/dist/releases/macos/appcast.xml}"
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
      echo "[friday-companion-release] timed out waiting for release lock at ${LOCK_DIR}" >&2
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

if [[ -z "${FRIDAY_MACOS_SPARKLE_PRIVATE_KEY:-}" || -z "${FRIDAY_MACOS_APPCAST_BASE_URL:-}" ]]; then
  rm -f "${SPARKLE_APPCAST_PATH}" "${SPARKLE_APPCAST_PATH}.artifact.json" "${CHANNELS_DIR}/sparkle.json"
fi

if [[ -z "${FRIDAY_HOMEBREW_TAP_REPO:-}" || -z "${FRIDAY_HOMEBREW_TAP_GITHUB_TOKEN:-}" ]]; then
  rm -f "${CHANNELS_DIR}/homebrew.json"
fi

RELEASE_MODE="${FRIDAY_MACOS_RELEASE_MODE:-local}"
if [[ "${RELEASE_MODE}" != "local" && "${RELEASE_MODE}" != "notarize" ]]; then
  echo "[friday-companion-release] invalid FRIDAY_MACOS_RELEASE_MODE=${RELEASE_MODE}; expected local|notarize." >&2
  exit 78
fi

bash "${REPO_DIR}/scripts/ops/check-friday-companion-release-env.sh" "${REPO_DIR}"

if [[ "${RELEASE_MODE}" == "notarize" ]]; then
  export FRIDAY_MACOS_CODESIGN_MODE="${FRIDAY_MACOS_CODESIGN_MODE:-identity}"
else
  export FRIDAY_MACOS_CODESIGN_MODE="${FRIDAY_MACOS_CODESIGN_MODE:-adhoc}"
fi

if [[ -z "${FRIDAY_SYSTEM_COMPANION_DIST_DIR:-}" ]]; then
  BUILD_ROOT_ID="$(printf '%s' "${REPO_DIR}" | cksum | awk '{print $1}')"
  export FRIDAY_SYSTEM_COMPANION_DIST_DIR="${TMPDIR:-/tmp}/friday-companion-build/${BUILD_ROOT_ID}/macos"
fi

echo "[friday-companion-release] building app bundle (${RELEASE_MODE})" >&2
APP_DIR="$(bash "${REPO_DIR}/scripts/ops/build-friday-companion-app.sh" "${REPO_DIR}")"

echo "[friday-companion-release] running local verification" >&2
FRIDAY_SYSTEM_COMPANION_APP_DIR="${APP_DIR}" \
FRIDAY_MACOS_VERIFY_MODE=local \
  bash "${REPO_DIR}/scripts/ops/verify-friday-companion-app.sh" "${REPO_DIR}" >/dev/null

NOTARIZATION_STATUS="not_requested"

if [[ "${RELEASE_MODE}" == "notarize" ]]; then
  echo "[friday-companion-release] notarizing app bundle" >&2
  FRIDAY_SYSTEM_COMPANION_APP_DIR="${APP_DIR}" \
    bash "${REPO_DIR}/scripts/ops/notarize-friday-companion-app.sh" "${REPO_DIR}" >/dev/null

  echo "[friday-companion-release] running notarized verification" >&2
  FRIDAY_SYSTEM_COMPANION_APP_DIR="${APP_DIR}" \
  FRIDAY_MACOS_VERIFY_MODE=notarized \
    bash "${REPO_DIR}/scripts/ops/verify-friday-companion-app.sh" "${REPO_DIR}" >/dev/null

  NOTARIZATION_STATUS="completed"
fi

echo "[friday-companion-release] writing release record" >&2
FRIDAY_SYSTEM_COMPANION_APP_DIR="${APP_DIR}" \
FRIDAY_SYSTEM_COMPANION_NOTARIZATION_STATUS="${NOTARIZATION_STATUS}" \
  bash "${REPO_DIR}/scripts/ops/write-friday-companion-release-record.sh" "${REPO_DIR}" >/dev/null

echo "[friday-companion-release] building npm/source artifact" >&2
bash "${REPO_DIR}/scripts/ops/build-friday-source-distribution.sh" "${REPO_DIR}" >/dev/null

echo "[friday-companion-release] building release artifacts" >&2
FRIDAY_SYSTEM_COMPANION_APP_DIR="${APP_DIR}" \
  bash "${REPO_DIR}/scripts/ops/build-friday-companion-dmg.sh" "${REPO_DIR}" >/dev/null

if [[ -x /usr/bin/xattr ]]; then
  /usr/bin/xattr -cr "${APP_DIR}"
  while IFS= read -r -d '' bundle_path; do
    /usr/bin/xattr -d com.apple.FinderInfo "${bundle_path}" >/dev/null 2>&1 || true
    /usr/bin/xattr -d 'com.apple.fileprovider.fpfs#P' "${bundle_path}" >/dev/null 2>&1 || true
  done < <(find "${APP_DIR}" -print0)
fi

if [[ -n "${FRIDAY_MACOS_SPARKLE_PRIVATE_KEY:-}" && -n "${FRIDAY_MACOS_APPCAST_BASE_URL:-}" ]]; then
  echo "[friday-companion-release] generating Sparkle appcast" >&2
  FRIDAY_SYSTEM_COMPANION_APP_DIR="${APP_DIR}" \
    bash "${REPO_DIR}/scripts/ops/build-friday-sparkle-appcast.sh" "${REPO_DIR}" >/dev/null
fi

echo "[friday-companion-release] writing release manifest" >&2
node "${REPO_DIR}/scripts/ops/write-friday-release-manifest.mjs" >/dev/null

if [[ -n "${FRIDAY_HOMEBREW_TAP_REPO:-}" && -n "${FRIDAY_HOMEBREW_TAP_GITHUB_TOKEN:-}" ]]; then
  echo "[friday-companion-release] publishing Homebrew cask" >&2
  if bash "${REPO_DIR}/scripts/ops/publish-friday-homebrew-cask.sh" "${REPO_DIR}" >/dev/null; then
    echo "[friday-companion-release] refreshing release manifest after Homebrew publication" >&2
  else
    echo "[friday-companion-release] Homebrew cask publication failed; continuing with generated cask only" >&2
    rm -f "${CHANNELS_DIR}/homebrew.json"
    echo "[friday-companion-release] refreshing release manifest after Homebrew publication fallback" >&2
  fi
  node "${REPO_DIR}/scripts/ops/write-friday-release-manifest.mjs" >/dev/null
fi

echo "[friday-companion-release] refreshing release record with artifact paths" >&2
FRIDAY_SYSTEM_COMPANION_APP_DIR="${APP_DIR}" \
FRIDAY_SYSTEM_COMPANION_NOTARIZATION_STATUS="${NOTARIZATION_STATUS}" \
  bash "${REPO_DIR}/scripts/ops/write-friday-companion-release-record.sh" "${REPO_DIR}" >/dev/null

echo "${APP_DIR}"
