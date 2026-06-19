#!/usr/bin/env bash
#
# Thin operator-facing launcher for OG9: use Friday to start a real Codex task.
#
# This reuses friday-codex-mission-proof-of-life.sh's proven login -> mission intake ->
# auto-dispatch -> sealed WS -> Codex app-server -> observe-wrapper path, but requires
# operator-provided task text instead of the fixed proof prompt.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly SCRIPT_DIR
readonly PROOF_SCRIPT="${SCRIPT_DIR}/friday-codex-mission-proof-of-life.sh"

if [ ! -x "${PROOF_SCRIPT}" ]; then
  echo "FATAL: Codex mission launcher backend is not executable: ${PROOF_SCRIPT}" >&2
  exit 3
fi

TASK_TEXT="${FRIDAY_CODEX_ORGANIC_TASK:-}"
if [ -z "${TASK_TEXT}" ] && [ "$#" -gt 0 ]; then
  TASK_TEXT="$*"
fi
if [ -z "${TASK_TEXT}" ]; then
  echo "Usage: $0 '<operator task for Codex>'" >&2
  echo "Or set FRIDAY_CODEX_ORGANIC_TASK." >&2
  exit 3
fi

ORGANIC_BODY_REF_ID="$(node -e 'process.stdout.write((globalThis.crypto?.randomUUID?.() ?? (`id-${Date.now()}-${Math.random().toString(16).slice(2)}`)).toLowerCase())')"

export FRIDAY_CODEX_MISSION_PROOF_RUN_KIND="organic"
export FRIDAY_CODEX_MISSION_PROOF_SURFACE_KIND="${FRIDAY_CODEX_ORGANIC_SURFACE_KIND:-desktop}"
export FRIDAY_CODEX_MISSION_PROOF_DELIVERY_ROUTE="ops://codex-organic-spawn"
export FRIDAY_CODEX_MISSION_PROOF_TITLE="${FRIDAY_CODEX_ORGANIC_TITLE:-Codex organic operator task}"
export FRIDAY_CODEX_MISSION_PROOF_INTENT="${TASK_TEXT}"
export FRIDAY_CODEX_MISSION_PROOF_CAPABILITY_ID="observe-wrapper.codex.organic"
export FRIDAY_CODEX_MISSION_PROOF_BODY_REF="${FRIDAY_CODEX_MISSION_PROOF_BODY_REF:-friday://body/ops/codex-organic-spawn/${ORGANIC_BODY_REF_ID}}"

exec "${PROOF_SCRIPT}"
