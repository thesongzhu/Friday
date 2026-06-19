#!/usr/bin/env bash
#
# Thin operator-facing launcher for OG9: use Friday to start a real Claude task.
#
# This reuses friday-claude-mission-proof-of-life.sh's proven login -> mission
# intake -> auto-dispatch -> sealed WS -> Claude route path, but requires
# operator-provided task text instead of the fixed proof prompt.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly SCRIPT_DIR
readonly PROOF_SCRIPT="${SCRIPT_DIR}/friday-claude-mission-proof-of-life.sh"

if [ ! -x "${PROOF_SCRIPT}" ]; then
  echo "FATAL: Claude mission launcher backend is not executable: ${PROOF_SCRIPT}" >&2
  exit 3
fi

TASK_TEXT="${FRIDAY_CLAUDE_ORGANIC_TASK:-}"
if [ -z "${TASK_TEXT}" ] && [ "$#" -gt 0 ]; then
  TASK_TEXT="$*"
fi
if [ -z "${TASK_TEXT}" ]; then
  echo "Usage: $0 '<operator task for Claude>'" >&2
  echo "Or set FRIDAY_CLAUDE_ORGANIC_TASK." >&2
  exit 3
fi

export FRIDAY_CLAUDE_MISSION_PROOF_RUN_KIND="organic"
export FRIDAY_CLAUDE_MISSION_PROOF_SURFACE_KIND="${FRIDAY_CLAUDE_ORGANIC_SURFACE_KIND:-desktop}"
export FRIDAY_CLAUDE_MISSION_PROOF_DELIVERY_ROUTE="ops://claude-organic-spawn"
export FRIDAY_CLAUDE_MISSION_PROOF_TITLE="${FRIDAY_CLAUDE_ORGANIC_TITLE:-Claude organic operator task}"
export FRIDAY_CLAUDE_MISSION_PROOF_INTENT="${TASK_TEXT}"
export FRIDAY_CLAUDE_MISSION_PROOF_CAPABILITY_ID="observe-wrapper.claude.organic"
export FRIDAY_CLAUDE_MISSION_PROOF_BODY_REF="friday://body/ops/claude-organic-spawn"

exec "${PROOF_SCRIPT}"
