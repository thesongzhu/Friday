#!/usr/bin/env bash
set -Eeuo pipefail

REPO_DIR="${1:-}"
if [[ -z "${REPO_DIR}" ]]; then
  REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
fi
REPO_DIR="$(cd "${REPO_DIR}" && pwd)"

CHECKLIST_PATH="${FRIDAY_CROSS_PLATFORM_CHECKLIST_PATH:-${REPO_DIR}/docs/ops/friday-cross-platform-agent-os-completion-checklist.md}"
EVIDENCE_ROOT="${FRIDAY_CROSS_PLATFORM_EVIDENCE_ROOT:-${REPO_DIR}/docs/reports/ops/cross-platform-agent-os-beta-evidence}"
MACOS_EVIDENCE_PATH="${FRIDAY_CROSS_PLATFORM_MACOS_EVIDENCE_PATH:-${EVIDENCE_ROOT}/macos-15-clean-machine.md}"
IOS_EVIDENCE_PATH="${FRIDAY_CROSS_PLATFORM_IOS_EVIDENCE_PATH:-${EVIDENCE_ROOT}/ios-latest-device-smoke.md}"
ANDROID_EVIDENCE_PATH="${FRIDAY_CROSS_PLATFORM_ANDROID_EVIDENCE_PATH:-${EVIDENCE_ROOT}/android-latest-device-smoke.md}"
WINDOWS_EVIDENCE_PATH="${FRIDAY_CROSS_PLATFORM_WINDOWS_EVIDENCE_PATH:-${EVIDENCE_ROOT}/windows-11-clean-machine.md}"

failures=0

pass() {
  echo "[friday-cross-platform-release-inputs] OK: $1" >&2
}

fail() {
  echo "[friday-cross-platform-release-inputs] MISSING: $1" >&2
  failures=$((failures + 1))
}

require_file() {
  local file_path="$1"
  local label="$2"
  if [[ -f "${file_path}" ]]; then
    pass "${label}"
  else
    fail "${label} (${file_path})"
  fi
}

require_command() {
  local command_name="$1"
  local label="$2"
  if command -v "${command_name}" >/dev/null 2>&1; then
    pass "${label}"
  else
    fail "${label}"
  fi
}

require_env() {
  local variable_name="$1"
  local label="$2"
  local value="${!variable_name:-}"
  if [[ -n "${value}" ]]; then
    pass "${label}"
  else
    fail "${label}"
  fi
}

require_env_or_file() {
  local variable_name="$1"
  local label="$2"
  local value="${!variable_name:-}"
  if [[ -n "${value}" ]]; then
    if [[ -f "${value}" ]]; then
      pass "${label}"
    else
      fail "${label} (${value})"
    fi
  else
    fail "${label}"
  fi
}

require_one_of() {
  local first_name="$1"
  local second_name="$2"
  local label="$3"
  if [[ -n "${!first_name:-}" || -n "${!second_name:-}" ]]; then
    pass "${label}"
  else
    fail "${label}"
  fi
}

require_complete_evidence() {
  local file_path="$1"
  local label="$2"
  if [[ ! -f "${file_path}" ]]; then
    fail "${label} (${file_path})"
    return
  fi
  if grep -Fq "Status: complete" "${file_path}"; then
    pass "${label}"
  else
    fail "${label} (${file_path} is not marked complete)"
  fi
}

require_file "${CHECKLIST_PATH}" "cross-platform completion checklist exists"
require_file "${MACOS_EVIDENCE_PATH}" "macOS evidence template exists"
require_file "${IOS_EVIDENCE_PATH}" "iOS evidence template exists"
require_file "${ANDROID_EVIDENCE_PATH}" "Android evidence template exists"
require_file "${WINDOWS_EVIDENCE_PATH}" "Windows evidence template exists"

require_command node "node runtime available"
require_command npm "npm runtime available"

if [[ "$(uname -s)" == "Darwin" ]]; then
  if FRIDAY_MACOS_RELEASE_MODE=local bash "${REPO_DIR}/scripts/ops/check-friday-companion-release-env.sh" "${REPO_DIR}" >/dev/null 2>&1; then
    pass "macOS local companion release environment"
  else
    fail "macOS local companion release environment"
  fi
else
  fail "macOS local companion release environment"
fi

require_env "FRIDAY_MACOS_CODESIGN_IDENTITY" "Apple Developer ID signing identity configured"
require_env "FRIDAY_MACOS_NOTARY_PROFILE" "Apple notary profile configured"
require_env "FRIDAY_MACOS_SPARKLE_PRIVATE_KEY" "Sparkle private key configured"
require_env "FRIDAY_MACOS_SPARKLE_PUBLIC_KEY" "Sparkle public key configured"
require_env "FRIDAY_MACOS_APPCAST_BASE_URL" "Sparkle appcast base URL configured"
require_env "FRIDAY_HOMEBREW_TAP_REPO" "Homebrew tap repository configured"
require_env "FRIDAY_HOMEBREW_TAP_GITHUB_TOKEN" "Homebrew tap publication token configured"

require_env "FRIDAY_IOS_APPLE_TEAM_ID" "iOS Apple team ID configured"
require_env "FRIDAY_IOS_BUNDLE_ID" "iOS bundle identifier configured"
require_env "FRIDAY_IOS_APP_STORE_CONNECT_KEY_ID" "iOS App Store Connect key ID configured"
require_env "FRIDAY_IOS_APP_STORE_CONNECT_ISSUER_ID" "iOS App Store Connect issuer ID configured"
require_env_or_file "FRIDAY_IOS_APP_STORE_CONNECT_PRIVATE_KEY_PATH" "iOS App Store Connect private key path"

require_env "FRIDAY_ANDROID_APPLICATION_ID" "Android application ID configured"
require_env_or_file "FRIDAY_ANDROID_KEYSTORE_PATH" "Android keystore path"
require_env "FRIDAY_ANDROID_KEYSTORE_PASSWORD" "Android keystore password configured"
require_env "FRIDAY_ANDROID_KEY_ALIAS" "Android key alias configured"
require_env "FRIDAY_ANDROID_KEY_PASSWORD" "Android key password configured"
require_env_or_file "FRIDAY_ANDROID_PLAY_SERVICE_ACCOUNT_JSON" "Android Play service account JSON"

require_command dotnet "Windows native companion toolchain (dotnet)"
require_env_or_file "FRIDAY_WINDOWS_CODESIGN_PFX_PATH" "Windows code-signing PFX path"
require_env "FRIDAY_WINDOWS_CODESIGN_PFX_PASSWORD" "Windows code-signing PFX password"

require_env "FRIDAY_CROSS_PLATFORM_MACOS_SMOKE_TARGET" "macOS clean-machine target recorded"
require_env "FRIDAY_CROSS_PLATFORM_IOS_SMOKE_TARGET" "iOS smoke target recorded"
require_env "FRIDAY_CROSS_PLATFORM_ANDROID_SMOKE_TARGET" "Android smoke target recorded"
require_env "FRIDAY_CROSS_PLATFORM_WINDOWS_SMOKE_TARGET" "Windows clean-machine target recorded"

require_complete_evidence "${MACOS_EVIDENCE_PATH}" "macOS clean-machine evidence archived"
require_complete_evidence "${IOS_EVIDENCE_PATH}" "iOS smoke evidence archived"
require_complete_evidence "${ANDROID_EVIDENCE_PATH}" "Android smoke evidence archived"
require_complete_evidence "${WINDOWS_EVIDENCE_PATH}" "Windows clean-machine evidence archived"

if [[ "${failures}" -gt 0 ]]; then
  echo "[friday-cross-platform-release-inputs] ${failures} required inputs or evidence items are still missing." >&2
  exit 78
fi

echo "[friday-cross-platform-release-inputs] all cross-platform release inputs are present" >&2
