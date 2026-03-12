#!/usr/bin/env bash
set -Eeuo pipefail

REPO_DIR="${1:-}"
if [[ -z "${REPO_DIR}" ]]; then
  REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
fi
REPO_DIR="$(cd "${REPO_DIR}" && pwd)"

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "[friday-companion-notarize] macOS is required." >&2
  exit 78
fi

PROFILE="${FRIDAY_MACOS_NOTARY_PROFILE:-}"
if [[ -z "${PROFILE}" ]]; then
  echo "[friday-companion-notarize] FRIDAY_MACOS_NOTARY_PROFILE is required." >&2
  exit 78
fi

XCRUN_BIN="$(command -v xcrun || true)"
if [[ -z "${XCRUN_BIN}" ]]; then
  echo "[friday-companion-notarize] xcrun not found in PATH." >&2
  exit 78
fi

APP_DIR="${FRIDAY_SYSTEM_COMPANION_APP_DIR:-${REPO_DIR}/dist/macos/FridayCompanion.app}"
if [[ ! -d "${APP_DIR}" ]]; then
  APP_DIR="$(bash "${REPO_DIR}/scripts/ops/build-friday-companion-app.sh" "${REPO_DIR}")"
fi

ARCHIVE_PATH="${FRIDAY_SYSTEM_COMPANION_ARCHIVE_PATH:-${REPO_DIR}/dist/macos/FridayCompanion.zip}"
NOTARY_RESULT_PATH="${FRIDAY_SYSTEM_COMPANION_NOTARY_RESULT_PATH:-${REPO_DIR}/dist/macos/FridayCompanion.notary.json}"
rm -f "${ARCHIVE_PATH}"
/usr/bin/ditto -c -k --keepParent "${APP_DIR}" "${ARCHIVE_PATH}"

NOTARY_ARGS=(notarytool submit "${ARCHIVE_PATH}" --keychain-profile "${PROFILE}" --wait --output-format json)
if [[ -n "${FRIDAY_MACOS_TEAM_ID:-}" ]]; then
  NOTARY_ARGS+=(--team-id "${FRIDAY_MACOS_TEAM_ID}")
fi

echo "[friday-companion-notarize] submitting ${ARCHIVE_PATH}" >&2
"${XCRUN_BIN}" "${NOTARY_ARGS[@]}" > "${NOTARY_RESULT_PATH}"

echo "[friday-companion-notarize] stapling ${APP_DIR}" >&2
"${XCRUN_BIN}" stapler staple "${APP_DIR}"

FRIDAY_SYSTEM_COMPANION_APP_DIR="${APP_DIR}" \
FRIDAY_MACOS_VERIFY_MODE=notarized \
  bash "${REPO_DIR}/scripts/ops/verify-friday-companion-app.sh" "${REPO_DIR}" >/dev/null

echo "${APP_DIR}"
