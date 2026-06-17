#!/usr/bin/env bash
#
# macOS hidden-input wrapper for friday-codex-mission-d8-soak.sh.
#
# Prompts locally with a hidden-answer dialog, then feeds the passphrase to the
# D8 soak script through stdin. This keeps the passphrase out of chat and argv.
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly SCRIPT_DIR
readonly SOAK_SCRIPT="${SCRIPT_DIR}/friday-codex-mission-d8-soak.sh"

if ! command -v osascript >/dev/null 2>&1; then
  echo "FATAL: osascript is required for the macOS hidden-input prompt." >&2
  exit 3
fi
if [ ! -x "${SOAK_SCRIPT}" ]; then
  echo "FATAL: soak script is not executable: ${SOAK_SCRIPT}" >&2
  exit 3
fi

echo "Running Codex mission D8 soak preflight (no passphrase, no traffic)..."
FRIDAY_CODEX_MISSION_D8_PREFLIGHT_ONLY=1 "${SOAK_SCRIPT}"
echo

PASSPHRASE="$(
  osascript <<'APPLESCRIPT'
try
  set dialogResult to display dialog "Enter the Friday local passphrase. This will run the Codex mission D8 soak locally and may spend real provider quota." default answer "" with hidden answer buttons {"Cancel", "Run D8 Soak"} default button "Run D8 Soak" cancel button "Cancel" with title "Friday Codex D8 Soak"
  return text returned of dialogResult
on error number -128
  error number -128
end try
APPLESCRIPT
)" || {
  echo "Cancelled."
  exit 130
}
trap 'unset PASSPHRASE' EXIT

if [ -z "${PASSPHRASE}" ]; then
  echo "FATAL: empty passphrase." >&2
  exit 4
fi

printf '%s\n' "${PASSPHRASE}" \
  | FRIDAY_CODEX_MISSION_D8_SOAK_PASSPHRASE_STDIN=1 "${SOAK_SCRIPT}"
