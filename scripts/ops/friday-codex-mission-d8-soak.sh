#!/usr/bin/env bash
#
# friday-codex-mission-d8-soak.sh
# --------------------------------
# Operator-run high-pressure Codex mission proof harness.
#
# This script prompts locally for the Friday passphrase once, then runs the
# hardened Codex mission proof script N consecutive times. After the run window,
# it invokes the read-only D8 audit with the captured start timestamp.
#
# Truth boundary:
#   This script can CREATE real operator-triggered Codex traffic if you provide
#   the local passphrase. It spends real provider quota. Do not run it casually.
#   It still does not prove D8 unless every proof run succeeds and the D8 audit
#   exits 0 for the same scoped window.
#
# Secret hygiene:
#   The passphrase is read hidden by default, or from stdin only when a local
#   wrapper sets FRIDAY_CODEX_MISSION_D8_SOAK_PASSPHRASE_STDIN=1. It is never
#   passed in argv. Each proof child receives it over stdin.
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly SCRIPT_DIR
readonly PROOF_SCRIPT="${FRIDAY_CODEX_MISSION_PROOF_SCRIPT:-${SCRIPT_DIR}/friday-codex-mission-proof-of-life.sh}"
readonly D8_AUDIT_SCRIPT="${FRIDAY_D8_AUDIT_SCRIPT:-${SCRIPT_DIR}/../diagnostics/friday-observe-wrapper-d8-audit.sh}"
readonly REQUIRED_SESSIONS="${FRIDAY_CODEX_MISSION_D8_REQUIRED_SESSIONS:-20}"
readonly BETWEEN_RUN_SLEEP_SEC="${FRIDAY_CODEX_MISSION_D8_BETWEEN_RUN_SLEEP_SEC:-2}"
readonly PASSPHRASE_STDIN="${FRIDAY_CODEX_MISSION_D8_SOAK_PASSPHRASE_STDIN:-0}"
readonly ACCEPT_PARTIAL="${FRIDAY_CODEX_MISSION_D8_ACCEPT_PARTIAL:-0}"
readonly PREFLIGHT_ONLY="${FRIDAY_CODEX_MISSION_D8_PREFLIGHT_ONLY:-0}"

require_nonnegative_int() {
  local name="$1"
  local value="$2"
  if [[ ! "${value}" =~ ^[0-9]+$ ]]; then
    echo "FATAL: ${name} must be a non-negative integer; got '${value}'." >&2
    exit 3
  fi
}

require_positive_int() {
  local name="$1"
  local value="$2"
  if [[ ! "${value}" =~ ^[1-9][0-9]*$ ]]; then
    echo "FATAL: ${name} must be a positive integer; got '${value}'." >&2
    exit 3
  fi
}

now_ms() {
  node -e 'process.stdout.write(String(Date.now()))'
}

require_positive_int "FRIDAY_CODEX_MISSION_D8_REQUIRED_SESSIONS" "${REQUIRED_SESSIONS}"
require_nonnegative_int "FRIDAY_CODEX_MISSION_D8_BETWEEN_RUN_SLEEP_SEC" "${BETWEEN_RUN_SLEEP_SEC}"
if [ "${PASSPHRASE_STDIN}" != "0" ] && [ "${PASSPHRASE_STDIN}" != "1" ]; then
  echo "FATAL: FRIDAY_CODEX_MISSION_D8_SOAK_PASSPHRASE_STDIN must be 0 or 1; got '${PASSPHRASE_STDIN}'." >&2
  exit 3
fi
if [ "${ACCEPT_PARTIAL}" != "0" ] && [ "${ACCEPT_PARTIAL}" != "1" ]; then
  echo "FATAL: FRIDAY_CODEX_MISSION_D8_ACCEPT_PARTIAL must be 0 or 1; got '${ACCEPT_PARTIAL}'." >&2
  exit 3
fi
if [ "${PREFLIGHT_ONLY}" != "0" ] && [ "${PREFLIGHT_ONLY}" != "1" ]; then
  echo "FATAL: FRIDAY_CODEX_MISSION_D8_PREFLIGHT_ONLY must be 0 or 1; got '${PREFLIGHT_ONLY}'." >&2
  exit 3
fi
if ! command -v node >/dev/null 2>&1; then
  echo "FATAL: node is required to capture a millisecond start timestamp." >&2
  exit 3
fi
if [ ! -x "${PROOF_SCRIPT}" ]; then
  echo "FATAL: proof script is not executable: ${PROOF_SCRIPT}" >&2
  exit 3
fi
if [ ! -x "${D8_AUDIT_SCRIPT}" ]; then
  echo "FATAL: D8 audit script is not executable: ${D8_AUDIT_SCRIPT}" >&2
  exit 3
fi

echo "Friday Codex mission D8 soak"
echo "----------------------------"
echo "proof_script: ${PROOF_SCRIPT}"
echo "d8_audit_script: ${D8_AUDIT_SCRIPT}"
echo "required_sessions: ${REQUIRED_SESSIONS}"
echo "between_run_sleep_sec: ${BETWEEN_RUN_SLEEP_SEC}"
echo "accept_partial: ${ACCEPT_PARTIAL}"
echo

echo "Running Codex mission proof preflight (no passphrase, no traffic)..."
FRIDAY_CODEX_MISSION_PROOF_PREFLIGHT_ONLY=1 "${PROOF_SCRIPT}"
echo

if [ "${PREFLIGHT_ONLY}" = "1" ]; then
  echo "Codex mission D8 soak preflight OK."
  echo "Truth: preflight creates no traffic and proves only local readiness, not Codex proof / D8 / GO."
  exit 0
fi

if [ "${PASSPHRASE_STDIN}" = "1" ]; then
  if ! IFS= read -r PASSPHRASE; then
    echo "FATAL: failed to read passphrase from stdin." >&2
    exit 4
  fi
else
  printf 'Enter Friday local passphrase for the D8 soak (input hidden): ' >&2
  read -rs PASSPHRASE
  printf '\n' >&2
fi
trap 'unset PASSPHRASE' EXIT
if [ -z "${PASSPHRASE}" ]; then
  echo "FATAL: empty passphrase." >&2
  exit 4
fi

readonly STARTED_AT_MS="$(now_ms)"
echo "D8 scoped start_ms: ${STARTED_AT_MS}"
echo

completed=0
for run_index in $(seq 1 "${REQUIRED_SESSIONS}"); do
  echo "===== Codex mission proof ${run_index}/${REQUIRED_SESSIONS} ====="
  set +e
  proof_output="$(
    printf '%s\n' "${PASSPHRASE}" \
      | FRIDAY_CODEX_MISSION_PROOF_PASSPHRASE_STDIN=1 "${PROOF_SCRIPT}" 2>&1
  )"
  proof_status=$?
  set -e
  printf '%s\n' "${proof_output}"

  if [ "${proof_status}" -eq 0 ]; then
    completed=$((completed + 1))
  elif [ "${proof_status}" -eq 2 ] && [ "${ACCEPT_PARTIAL}" = "1" ]; then
    completed=$((completed + 1))
    echo "WARN: accepted partial proof ${run_index}/${REQUIRED_SESSIONS}; D8 audit must still decide."
  else
    echo "FAIL: proof ${run_index}/${REQUIRED_SESSIONS} exited ${proof_status}; stopping consecutive soak." >&2
    echo "completed_before_failure=${completed}"
    exit "${proof_status}"
  fi

  if [ "${run_index}" -lt "${REQUIRED_SESSIONS}" ] && [ "${BETWEEN_RUN_SLEEP_SEC}" -gt 0 ]; then
    sleep "${BETWEEN_RUN_SLEEP_SEC}"
  fi
done

unset PASSPHRASE

echo
echo "===== Running scoped D8 audit ====="
FRIDAY_D8_AUDIT_REQUIRED_SESSIONS="${REQUIRED_SESSIONS}" \
FRIDAY_D8_AUDIT_SINCE_MS="${STARTED_AT_MS}" \
  "${D8_AUDIT_SCRIPT}"
