#!/usr/bin/env bash
#
# Operator-only T3 provisioning wrapper.
#
# Truth boundary:
#   This is a local operator ceremony wrapper around the existing
#   friday-operator-approve CLI. It can mint trust_grant/context_passport rows only
#   when the operator supplies an explicit ACK and explicit boundaries. It does not
#   read an operator signing key, sign anything, flip flags, expose a Hub/app/agent
#   mint endpoint, or insert fake organic evidence.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"

ACK="${FRIDAY_T3_OPERATOR_PROVISION_ACK:-}"
DB_PATH="${FRIDAY_T3_DB_PATH:-${HOME}/Library/Application Support/Friday/state/rust-hub.sqlite}"
STEP="${FRIDAY_T3_STEP:-both}"

GRANT_ID="${FRIDAY_T3_GRANT_ID:-}"
AGENT_ID="${FRIDAY_T3_AGENT_ID:-}"
RISK_CEILING="${FRIDAY_T3_RISK_CEILING:-}"
EXPIRES_AT="${FRIDAY_T3_EXPIRES_AT:-}"
WORKSPACE="${FRIDAY_T3_WORKSPACE:-}"
TOKEN_CEILING="${FRIDAY_T3_TOKEN_CEILING:-}"
MAX_RUNS="${FRIDAY_T3_MAX_RUNS:-}"
AUTO_ALLOW_REVERSIBLE_CEILING="${FRIDAY_T3_AUTO_ALLOW_REVERSIBLE_CEILING:-}"
TOOLS="${FRIDAY_T3_TOOLS:-}"
PROVIDERS="${FRIDAY_T3_PROVIDERS:-}"
CHANNELS="${FRIDAY_T3_CHANNELS:-}"
WORKFLOW_FAMILIES="${FRIDAY_T3_WORKFLOW_FAMILIES:-}"
SKILL_FAMILIES="${FRIDAY_T3_SKILL_FAMILIES:-}"

PASSPORT_ID="${FRIDAY_T3_PASSPORT_ID:-}"
MISSION_ID="${FRIDAY_T3_MISSION_ID:-}"
WORK_ITEM_ID="${FRIDAY_T3_WORK_ITEM_ID:-}"
DESTINATION_LANE="${FRIDAY_T3_DESTINATION_LANE:-}"
DESTINATION_TARGET="${FRIDAY_T3_DESTINATION_TARGET:-}"
ITEMS_JSON="${FRIDAY_T3_ITEMS_JSON:-}"
APPROVED_SENSITIVE="${FRIDAY_T3_APPROVED_SENSITIVE:-0}"

fail() {
  echo "FATAL: $*" >&2
  exit 3
}

need() {
  local name="$1"
  local value="$2"
  if [[ -z "${value}" ]]; then
    fail "${name} is required."
  fi
}

if [[ "${ACK}" != "operator-runs-t3-provisioning" ]]; then
  fail "set FRIDAY_T3_OPERATOR_PROVISION_ACK=operator-runs-t3-provisioning to run this operator ceremony."
fi

case "${STEP}" in
  grant|passport|both) ;;
  *) fail "FRIDAY_T3_STEP must be grant, passport, or both." ;;
esac

run_operator_cli() {
  cargo run --quiet --manifest-path "${REPO_ROOT}/rust-core/Cargo.toml" \
    -p friday-operator-cli --bin friday-operator-approve -- "$@"
}

run_grant() {
  need "FRIDAY_T3_GRANT_ID" "${GRANT_ID}"
  need "FRIDAY_T3_AGENT_ID" "${AGENT_ID}"
  need "FRIDAY_T3_RISK_CEILING" "${RISK_CEILING}"

  if [[ -z "${TOOLS}${PROVIDERS}${CHANNELS}${WORKFLOW_FAMILIES}${SKILL_FAMILIES}${WORKSPACE}" ]]; then
    fail "at least one explicit grant boundary is required (tools/providers/channels/workflow families/skill families/workspace)."
  fi

  local args=(
    grant
    --db "${DB_PATH}"
    --grant-id "${GRANT_ID}"
    --agent "${AGENT_ID}"
    --risk-ceiling "${RISK_CEILING}"
  )
  if [[ -n "${EXPIRES_AT}" ]]; then args+=(--expires-at "${EXPIRES_AT}"); fi
  if [[ -n "${WORKSPACE}" ]]; then args+=(--workspace "${WORKSPACE}"); fi
  if [[ -n "${TOKEN_CEILING}" ]]; then args+=(--token-ceiling "${TOKEN_CEILING}"); fi
  if [[ -n "${MAX_RUNS}" ]]; then args+=(--max-runs "${MAX_RUNS}"); fi
  if [[ -n "${AUTO_ALLOW_REVERSIBLE_CEILING}" ]]; then args+=(--auto-allow-reversible-ceiling "${AUTO_ALLOW_REVERSIBLE_CEILING}"); fi
  if [[ -n "${TOOLS}" ]]; then args+=(--tools "${TOOLS}"); fi
  if [[ -n "${PROVIDERS}" ]]; then args+=(--providers "${PROVIDERS}"); fi
  if [[ -n "${CHANNELS}" ]]; then args+=(--channels "${CHANNELS}"); fi
  if [[ -n "${WORKFLOW_FAMILIES}" ]]; then args+=(--workflow-families "${WORKFLOW_FAMILIES}"); fi
  if [[ -n "${SKILL_FAMILIES}" ]]; then args+=(--skill-families "${SKILL_FAMILIES}"); fi

  echo "Running operator trust_grant ceremony."
  echo "truth_label=operator_cli_trust_grant_ceremony_not_app_or_agent_mint"
  run_operator_cli "${args[@]}"
}

run_passport() {
  need "FRIDAY_T3_PASSPORT_ID" "${PASSPORT_ID}"
  need "FRIDAY_T3_MISSION_ID" "${MISSION_ID}"
  need "FRIDAY_T3_DESTINATION_LANE" "${DESTINATION_LANE}"
  need "FRIDAY_T3_ITEMS_JSON" "${ITEMS_JSON}"
  if [[ ! -f "${ITEMS_JSON}" ]]; then
    fail "FRIDAY_T3_ITEMS_JSON must point to an existing JSON file."
  fi

  local args=(
    passport-mint
    --db "${DB_PATH}"
    --passport-id "${PASSPORT_ID}"
    --mission-id "${MISSION_ID}"
    --destination-lane "${DESTINATION_LANE}"
    --items "${ITEMS_JSON}"
  )
  if [[ -n "${WORK_ITEM_ID}" ]]; then args+=(--work-item-id "${WORK_ITEM_ID}"); fi
  if [[ -n "${DESTINATION_TARGET}" ]]; then args+=(--destination-target "${DESTINATION_TARGET}"); fi
  if [[ "${APPROVED_SENSITIVE}" = "1" ]]; then
    args+=(--approved-sensitive)
  fi

  echo "Running operator context_passport ceremony."
  echo "truth_label=operator_cli_context_passport_ceremony_not_app_or_agent_mint"
  run_operator_cli "${args[@]}"
}

cat >&2 <<EOF
Friday T3 operator provisioning starting.
DB: ${DB_PATH}
Step: ${STEP}
Truth: operator ACK required; no signing key read; no flags flipped; no app/agent mint endpoint.
EOF

if [[ "${STEP}" = "grant" || "${STEP}" = "both" ]]; then
  run_grant
fi
if [[ "${STEP}" = "passport" || "${STEP}" = "both" ]]; then
  run_passport
fi
