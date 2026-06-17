#!/usr/bin/env bash
#
# macOS local hidden-input wrapper for friday-codex-mission-proof-of-life.sh.
#
# This keeps the Friday local passphrase out of chat and out of shell argv:
# osascript shows a local hidden-answer dialog, then the passphrase is piped to
# the proof script on stdin. The proof script still owns login, mission intake,
# and DB evidence polling.
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly SCRIPT_DIR
readonly PROOF_SCRIPT="${SCRIPT_DIR}/friday-codex-mission-proof-of-life.sh"

if ! command -v osascript >/dev/null 2>&1; then
  echo "FATAL: osascript is required for the macOS hidden-input prompt." >&2
  exit 3
fi
if [ ! -x "${PROOF_SCRIPT}" ]; then
  echo "FATAL: proof script is not executable: ${PROOF_SCRIPT}" >&2
  exit 3
fi

echo "Running Codex mission proof preflight (no passphrase, no traffic)..."
FRIDAY_CODEX_MISSION_PROOF_PREFLIGHT_ONLY=1 "${PROOF_SCRIPT}"
echo

PASSPHRASE="$(
  osascript <<'APPLESCRIPT'
try
  set dialogResult to display dialog "Enter the Friday local passphrase. It will stay local and will not be printed." default answer "" with hidden answer buttons {"Cancel", "Run Proof"} default button "Run Proof" cancel button "Cancel" with title "Friday Codex Mission Proof"
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
  | FRIDAY_CODEX_MISSION_PROOF_PASSPHRASE_STDIN=1 "${PROOF_SCRIPT}"
