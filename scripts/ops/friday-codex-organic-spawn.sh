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
readonly ATTESTATION_VERIFY_SCRIPT="${SCRIPT_DIR}/friday-operator-organic-attestation-verify.mjs"

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

if [ ! -f "${ATTESTATION_VERIFY_SCRIPT}" ]; then
  echo "FATAL: Codex organic attestation verifier is missing: ${ATTESTATION_VERIFY_SCRIPT}" >&2
  exit 3
fi

if [ -z "${FRIDAY_CODEX_ORGANIC_ATTESTATION:-}" ] || [ -z "${FRIDAY_CODEX_ORGANIC_ATTESTATION_VERIFY_KEY:-}" ]; then
  echo "FATAL: strict Codex organic launch requires FRIDAY_CODEX_ORGANIC_ATTESTATION and FRIDAY_CODEX_ORGANIC_ATTESTATION_VERIFY_KEY." >&2
  echo "These must point to an operator signature attestation and its verify key; env acknowledgements do not mark organic." >&2
  exit 4
fi

TASK_SHA256="$(printf '%s' "${TASK_TEXT}" | shasum -a 256 | awk '{print tolower($1)}')"
ORGANIC_PROVENANCE_JSON="$(
  node "${ATTESTATION_VERIFY_SCRIPT}" \
    --attestation "${FRIDAY_CODEX_ORGANIC_ATTESTATION}" \
    --public-key "${FRIDAY_CODEX_ORGANIC_ATTESTATION_VERIFY_KEY}" \
    --route "ops://codex-organic-spawn" \
    --task-sha256 "${TASK_SHA256}"
)"

ORGANIC_BODY_REF_ID="$(node -e 'process.stdout.write((globalThis.crypto?.randomUUID?.() ?? (`id-${Date.now()}-${Math.random().toString(16).slice(2)}`)).toLowerCase())')"

export FRIDAY_CODEX_MISSION_PROOF_RUN_KIND="organic"
export FRIDAY_CODEX_MISSION_PROOF_SURFACE_KIND="${FRIDAY_CODEX_ORGANIC_SURFACE_KIND:-desktop}"
export FRIDAY_CODEX_MISSION_PROOF_DELIVERY_ROUTE="ops://codex-organic-spawn"
export FRIDAY_CODEX_MISSION_PROOF_TITLE="${FRIDAY_CODEX_ORGANIC_TITLE:-Codex organic operator task}"
export FRIDAY_CODEX_MISSION_PROOF_INTENT="${TASK_TEXT}"
export FRIDAY_CODEX_MISSION_PROOF_CAPABILITY_ID="observe-wrapper.codex.organic"
export FRIDAY_CODEX_MISSION_PROOF_BODY_REF="${FRIDAY_CODEX_MISSION_PROOF_BODY_REF:-friday://body/ops/codex-organic-spawn/${ORGANIC_BODY_REF_ID}}"
export FRIDAY_CODEX_MISSION_PROOF_ORGANIC_PROVENANCE="${ORGANIC_PROVENANCE_JSON}"

exec "${PROOF_SCRIPT}"
