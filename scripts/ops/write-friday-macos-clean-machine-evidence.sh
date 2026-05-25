#!/usr/bin/env bash
set -Eeuo pipefail

REPO_DIR="${1:-}"
if [[ -z "${REPO_DIR}" ]]; then
  REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
fi
REPO_DIR="$(cd "${REPO_DIR}" && pwd)"

EVIDENCE_PATH="${FRIDAY_CROSS_PLATFORM_MACOS_EVIDENCE_PATH:-${REPO_DIR}/.friday/evidence/cross-platform-agent-os-beta/macos-15-clean-machine.md}"
RELEASE_RECORD_PATH="${FRIDAY_MACOS_SMOKE_RELEASE_RECORD_PATH:-${REPO_DIR}/dist/macos/FridayCompanion.release.json}"
SMOKE_STATUS="${FRIDAY_MACOS_SMOKE_STATUS:-pending}"
TARGET="${FRIDAY_CROSS_PLATFORM_MACOS_SMOKE_TARGET:-not recorded}"
ARTIFACT_PATH="${FRIDAY_MACOS_SMOKE_ARTIFACT_PATH:-not recorded}"
INSTALLED_AT="${FRIDAY_MACOS_SMOKE_INSTALLED_AT:-/Applications/FridayCompanion.app}"
OPERATOR_CONSOLE_HEALTH="${FRIDAY_MACOS_SMOKE_OPERATOR_CONSOLE_HEALTH:-not recorded}"
LAUNCHD_STATUS="${FRIDAY_MACOS_SMOKE_LAUNCHD_STATUS:-not recorded}"
PERMISSION_STATUS="${FRIDAY_MACOS_SMOKE_PERMISSION_STATUS:-not recorded}"
PASSKEY_STATUS="${FRIDAY_MACOS_SMOKE_PASSKEY_STATUS:-not recorded}"
REMOTE_STATUS="${FRIDAY_MACOS_SMOKE_REMOTE_STATUS:-not recorded}"
RECOVERY_STATUS="${FRIDAY_MACOS_SMOKE_RECOVERY_STATUS:-not recorded}"
UNINSTALL_STATUS="${FRIDAY_MACOS_SMOKE_UNINSTALL_STATUS:-not recorded}"
NOTES="${FRIDAY_MACOS_SMOKE_NOTES:-pending packaged beta smoke run}"
GENERATED_AT="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"

if [[ "${SMOKE_STATUS}" != "pending" && "${SMOKE_STATUS}" != "complete" ]]; then
  echo "[friday-macos-clean-machine-evidence] invalid FRIDAY_MACOS_SMOKE_STATUS=${SMOKE_STATUS}; expected pending|complete." >&2
  exit 78
fi

mkdir -p "$(dirname "${EVIDENCE_PATH}")"

RELEASE_MODE="not recorded"
APP_VERSION="not recorded"
DMG_RELEASE_PATH="not recorded"
MANIFEST_JSON_PATH="not recorded"
HOMEBREW_CASK_PATH="not recorded"

if [[ -f "${RELEASE_RECORD_PATH}" ]]; then
  RELEASE_MODE="$(node --input-type=commonjs -e 'const fs=require("node:fs");const record=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));process.stdout.write(record.releaseMode ?? "not recorded");' "${RELEASE_RECORD_PATH}")"
  APP_VERSION="$(node --input-type=commonjs -e 'const fs=require("node:fs");const record=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));process.stdout.write(record.appVersion ?? "not recorded");' "${RELEASE_RECORD_PATH}")"
  if [[ "${ARTIFACT_PATH}" == "not recorded" ]]; then
    ARTIFACT_PATH="$(node --input-type=commonjs -e 'const fs=require("node:fs");const record=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));process.stdout.write(record.dmgReleasePath ?? record.archivePath ?? record.appDir ?? "not recorded");' "${RELEASE_RECORD_PATH}")"
  fi
  DMG_RELEASE_PATH="$(node --input-type=commonjs -e 'const fs=require("node:fs");const record=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));process.stdout.write(record.dmgReleasePath ?? "not recorded");' "${RELEASE_RECORD_PATH}")"
  MANIFEST_JSON_PATH="$(node --input-type=commonjs -e 'const fs=require("node:fs");const record=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));process.stdout.write(record.manifestJsonPath ?? "not recorded");' "${RELEASE_RECORD_PATH}")"
  HOMEBREW_CASK_PATH="$(node --input-type=commonjs -e 'const fs=require("node:fs");const record=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));process.stdout.write(record.homebrewCaskPath ?? "not recorded");' "${RELEASE_RECORD_PATH}")"
fi

cat > "${EVIDENCE_PATH}" <<EOF
# macOS 15+ Clean-Machine Smoke

- Generated at: ${GENERATED_AT}
- Target: ${TARGET}
- Release mode: ${RELEASE_MODE}
- App version: ${APP_VERSION}
- Release artifact: ${ARTIFACT_PATH}
- DMG release path: ${DMG_RELEASE_PATH}
- Installed at: ${INSTALLED_AT}
- Operator Console health: ${OPERATOR_CONSOLE_HEALTH}
- Launchd status: ${LAUNCHD_STATUS}
- Permissions: ${PERMISSION_STATUS}
- Passkey enrollment: ${PASSKEY_STATUS}
- Remote session: ${REMOTE_STATUS}
- Restart recovery: ${RECOVERY_STATUS}
- Uninstall path: ${UNINSTALL_STATUS}
- Release manifest: ${MANIFEST_JSON_PATH}
- Homebrew Cask: ${HOMEBREW_CASK_PATH}
- Notes: ${NOTES}

Status: ${SMOKE_STATUS}
EOF

echo "${EVIDENCE_PATH}"
