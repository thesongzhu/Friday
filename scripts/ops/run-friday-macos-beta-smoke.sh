#!/usr/bin/env bash
set -Eeuo pipefail

REPO_DIR="${1:-}"
if [[ -z "${REPO_DIR}" ]]; then
  REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
fi
REPO_DIR="$(cd "${REPO_DIR}" && pwd)"

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "[friday-macos-beta-smoke] macOS is required." >&2
  exit 78
fi

NODE_BIN="${FRIDAY_NODE_BIN:-$(command -v node || true)}"
if [[ -z "${NODE_BIN}" ]]; then
  echo "[friday-macos-beta-smoke] node not found in PATH." >&2
  exit 78
fi

RELEASE_MODE="${FRIDAY_MACOS_RELEASE_MODE:-local}"
INSTALL_LAUNCHD="${FRIDAY_MACOS_SMOKE_INSTALL_LAUNCHD:-false}"
UNINSTALL_AFTER="${FRIDAY_MACOS_SMOKE_UNINSTALL_AFTER:-false}"
EVIDENCE_STATUS="${FRIDAY_MACOS_SMOKE_STATUS:-pending}"
STATUS_LOG_PATH="${FRIDAY_MACOS_SMOKE_STATUS_LOG_PATH:-${REPO_DIR}/dist/macos/FridayCompanion.launchagent-status.txt}"
RELEASE_RECORD_PATH="${FRIDAY_MACOS_SMOKE_RELEASE_RECORD_PATH:-${REPO_DIR}/dist/macos/FridayCompanion.release.json}"
EVIDENCE_PATH="${FRIDAY_CROSS_PLATFORM_MACOS_EVIDENCE_PATH:-${REPO_DIR}/dist/macos/FridayCompanion.clean-machine-smoke.md}"

APP_DIR="$(
  FRIDAY_MACOS_RELEASE_MODE="${RELEASE_MODE}" \
    bash "${REPO_DIR}/scripts/ops/release-friday-companion-app.sh" "${REPO_DIR}"
)"

ARTIFACT_PATH="$("${NODE_BIN}" --input-type=commonjs -e 'const fs=require("node:fs");const record=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));process.stdout.write(record.dmgReleasePath ?? record.archivePath ?? record.appDir);' "${RELEASE_RECORD_PATH}")"
LAUNCHD_STATUS="${FRIDAY_MACOS_SMOKE_LAUNCHD_STATUS:-not recorded}"
UNINSTALL_STATUS="${FRIDAY_MACOS_SMOKE_UNINSTALL_STATUS:-not recorded}"

if [[ "${INSTALL_LAUNCHD}" == "true" ]]; then
  npm run build:api >/dev/null
  bash "${REPO_DIR}/scripts/ops/install-friday-launchagent.sh" "${REPO_DIR}" >/dev/null
  mkdir -p "$(dirname "${STATUS_LOG_PATH}")"
  bash "${REPO_DIR}/scripts/ops/friday-launchagent-status.sh" "${REPO_DIR}" > "${STATUS_LOG_PATH}"
  if grep -q "socket:" "${STATUS_LOG_PATH}" && grep -q "installed: yes" "${STATUS_LOG_PATH}"; then
    LAUNCHD_STATUS="healthy"
  else
    LAUNCHD_STATUS="degraded"
  fi
fi

if [[ "${UNINSTALL_AFTER}" == "true" ]]; then
  bash "${REPO_DIR}/scripts/ops/uninstall-friday-launchagent.sh" "${REPO_DIR}" >/dev/null
  UNINSTALL_STATUS="completed"
fi

FRIDAY_MACOS_SMOKE_RELEASE_RECORD_PATH="${RELEASE_RECORD_PATH}" \
FRIDAY_MACOS_SMOKE_ARTIFACT_PATH="${ARTIFACT_PATH}" \
FRIDAY_MACOS_SMOKE_INSTALLED_AT="${APP_DIR}" \
FRIDAY_MACOS_SMOKE_LAUNCHD_STATUS="${LAUNCHD_STATUS}" \
FRIDAY_MACOS_SMOKE_UNINSTALL_STATUS="${UNINSTALL_STATUS}" \
FRIDAY_MACOS_SMOKE_STATUS="${EVIDENCE_STATUS}" \
FRIDAY_CROSS_PLATFORM_MACOS_EVIDENCE_PATH="${EVIDENCE_PATH}" \
  bash "${REPO_DIR}/scripts/ops/write-friday-macos-clean-machine-evidence.sh" "${REPO_DIR}"
