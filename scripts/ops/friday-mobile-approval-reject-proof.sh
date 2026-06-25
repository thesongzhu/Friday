#!/usr/bin/env bash
#
# Mobile approval reject live proof wrapper.
#
# Truth boundary:
#   `dispatch` creates a real paused mutating run through the existing governed S6 diagnostic
#   driver. `reject` then runs the mobile Swift live write-client test against that exact pending
#   approval. This does not read signing keys, mint signatures, resume the mutation, kill/restart
#   prod Hub, flip flags, or fabricate organic traffic. It is mobile Swift write-client evidence,
#   not a simulator tap, not END-BAR, and not release/adoption.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"

STEP="${FRIDAY_MOBILE_APPROVAL_REJECT_STEP:-both}"
LIVE="${FRIDAY_MOBILE_APPROVAL_REJECT_LIVE:-0}"
ARTIFACT_DIR="${FRIDAY_MOBILE_APPROVAL_REJECT_ARTIFACT_DIR:-${TMPDIR:-/tmp}/friday-mobile-approval-reject}"
PROOF_FILE="${FRIDAY_MOBILE_APPROVAL_REJECT_DRIVER_PROOF_FILE:-mobile-approval-reject-proof.txt}"
RUN_ID="${FRIDAY_MOBILE_APPROVAL_REJECT_RUN_ID:-}"
APPROVAL_ID="${FRIDAY_MOBILE_APPROVAL_REJECT_APPROVAL_ID:-}"
ACTION_DIGEST="${FRIDAY_MOBILE_APPROVAL_REJECT_ACTION_DIGEST:-}"
SWIFT_PROOF_OUT="${FRIDAY_MOBILE_APPROVAL_REJECT_SWIFT_PROOF_OUT:-${ARTIFACT_DIR}/mobile-approval-reject-proof.json}"
ACTION_RUNTIME_OUT="${FRIDAY_MOBILE_APPROVAL_REJECT_ACTION_RUNTIME_OUT:-${ARTIFACT_DIR}/action-runtime-evidence.json}"

fail() {
  echo "FATAL: $*" >&2
  exit 3
}

need_live() {
  if [[ "${LIVE}" != "1" ]]; then
    fail "set FRIDAY_MOBILE_APPROVAL_REJECT_LIVE=1 to run this live proof."
  fi
}

driver() {
  node "${REPO_ROOT}/scripts/diagnostics/friday-s6-transport-a-driver.mjs" "$@"
}

metadata_path() {
  echo "${ARTIFACT_DIR}/mobile-approval-reject-metadata.env"
}

save_metadata() {
  local log_file="$1"
  local run_id approval_id action_digest
  run_id="$(awk -F'= ' '/^[[:space:]]+runId[[:space:]]*=/{gsub(/[[:space:]]/, "", $2); print $2; exit}' "${log_file}")"
  approval_id="$(awk -F'= ' '/^[[:space:]]+approvalId[[:space:]]*=/{gsub(/[[:space:]]/, "", $2); print $2; exit}' "${log_file}")"
  action_digest="$(awk -F'= ' '/^[[:space:]]+actionDigest[[:space:]]*=/{gsub(/[[:space:]]/, "", $2); print $2; exit}' "${log_file}")"
  if [[ -z "${run_id}" || -z "${approval_id}" || -z "${action_digest}" ]]; then
    fail "could not parse runId/approvalId/actionDigest from ${log_file}."
  fi
  cat >"$(metadata_path)" <<EOF
FRIDAY_MOBILE_APPROVAL_REJECT_RUN_ID=${run_id}
FRIDAY_MOBILE_APPROVAL_REJECT_APPROVAL_ID=${approval_id}
FRIDAY_MOBILE_APPROVAL_REJECT_ACTION_DIGEST=${action_digest}
EOF
}

load_run_id() {
  if [[ -n "${RUN_ID}" ]]; then
    echo "${RUN_ID}"
    return
  fi
  local meta
  meta="$(metadata_path)"
  if [[ ! -f "${meta}" ]]; then
    fail "FRIDAY_MOBILE_APPROVAL_REJECT_RUN_ID is required when ${meta} is absent."
  fi
  # shellcheck disable=SC1090
  source "${meta}"
  if [[ -z "${FRIDAY_MOBILE_APPROVAL_REJECT_RUN_ID:-}" ]]; then
    fail "${meta} does not contain FRIDAY_MOBILE_APPROVAL_REJECT_RUN_ID."
  fi
  echo "${FRIDAY_MOBILE_APPROVAL_REJECT_RUN_ID}"
}

load_approval_id() {
  if [[ -n "${APPROVAL_ID}" ]]; then
    echo "${APPROVAL_ID}"
    return
  fi
  local meta
  meta="$(metadata_path)"
  if [[ ! -f "${meta}" ]]; then
    fail "FRIDAY_MOBILE_APPROVAL_REJECT_APPROVAL_ID is required when ${meta} is absent."
  fi
  # shellcheck disable=SC1090
  source "${meta}"
  if [[ -z "${FRIDAY_MOBILE_APPROVAL_REJECT_APPROVAL_ID:-}" ]]; then
    fail "${meta} does not contain FRIDAY_MOBILE_APPROVAL_REJECT_APPROVAL_ID."
  fi
  echo "${FRIDAY_MOBILE_APPROVAL_REJECT_APPROVAL_ID}"
}

load_action_digest() {
  if [[ -n "${ACTION_DIGEST}" ]]; then
    echo "${ACTION_DIGEST}"
    return
  fi
  local meta
  meta="$(metadata_path)"
  if [[ ! -f "${meta}" ]]; then
    echo ""
    return
  fi
  # shellcheck disable=SC1090
  source "${meta}"
  echo "${FRIDAY_MOBILE_APPROVAL_REJECT_ACTION_DIGEST:-}"
}

write_action_runtime_evidence() {
  local swift_proof="$1"
  local out="$2"
  if [[ -z "${out}" ]]; then
    return
  fi
  node - "${swift_proof}" "${out}" <<'NODE'
const fs = require("node:fs");
const path = require("node:path");
const [swiftProofPath, outPath] = process.argv.slice(2);
const swiftProof = JSON.parse(fs.readFileSync(swiftProofPath, "utf8"));
const actionRows = Array.isArray(swiftProof.ui_actions) ? swiftProof.ui_actions : [];
const evidence = {
  truth: "mobile_approval_reject_action_runtime_evidence_not_sim_tap_not_endbar_not_signature",
  status: actionRows.length > 0 ? "ready" : "blocked",
  actions: actionRows,
  source_proof: swiftProofPath,
  run_id: swiftProof.run_id,
  approval_id: swiftProof.approval_id,
  caveat:
    "Reject action evidence only: mobile Swift write-client owner-auth refusal of a paused mutation. It does not prove simulator tap, operator-signed approve, END-BAR, release, or adoption.",
};
fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, `${JSON.stringify(evidence, null, 2)}\n`);
console.log(JSON.stringify({ status: evidence.status, actionCount: evidence.actions.length, out: outPath }, null, 2));
NODE
}

run_dispatch() {
  need_live
  mkdir -p "${ARTIFACT_DIR}"
  chmod 700 "${ARTIFACT_DIR}"
  local log_file="${ARTIFACT_DIR}/dispatch.log"
  echo "Friday mobile approval reject proof: dispatch"
  echo "truth_label=mobile_approval_reject_dispatch_paused_real_run_not_signature_not_go"
  echo "artifact_dir=${ARTIFACT_DIR}"
  driver \
    --mode dispatch-mutating \
    --artifact-dir "${ARTIFACT_DIR}" \
    --proof-file "${PROOF_FILE}" | tee "${log_file}"
  save_metadata "${log_file}"
  echo
  echo "Metadata written: $(metadata_path)"
  echo "Truth: dispatch paused a real mutating run; it did not sign, resume, release, GO, or prove adoption."
}

run_reject() {
  need_live
  local run_id approval_id action_digest
  run_id="$(load_run_id)"
  approval_id="$(load_approval_id)"
  action_digest="$(load_action_digest)"
  mkdir -p "${ARTIFACT_DIR}"
  echo "Friday mobile approval reject proof: reject"
  echo "truth_label=mobile_approval_reject_swift_live_write_client_no_signature_no_mutation"
  echo "run_id=${run_id}"
  echo "approval_id=${approval_id}"
  FRIDAY_MOBILE_LIVE_APPROVAL_REJECT_TEST=1 \
  FRIDAY_MOBILE_APPROVAL_REJECT_RUN_ID="${run_id}" \
  FRIDAY_MOBILE_APPROVAL_REJECT_APPROVAL_ID="${approval_id}" \
  FRIDAY_MOBILE_APPROVAL_REJECT_ACTION_DIGEST="${action_digest}" \
  FRIDAY_MOBILE_APPROVAL_REJECT_PROOF_OUT="${SWIFT_PROOF_OUT}" \
    swift test \
      --package-path "${REPO_ROOT}/apps/friday-ios" \
      --filter liveMobile
  if [[ ! -s "${SWIFT_PROOF_OUT}" ]]; then
    fail "Swift live proof did not write ${SWIFT_PROOF_OUT}."
  fi
  write_action_runtime_evidence "${SWIFT_PROOF_OUT}" "${ACTION_RUNTIME_OUT}"
  echo "Swift proof: ${SWIFT_PROOF_OUT}"
  echo "Action runtime evidence: ${ACTION_RUNTIME_OUT}"
  echo "Truth: mobile reject refused the pending approval through run-control; it did not sign, resume, release, GO, or prove adoption."
}

case "${STEP}" in
  dispatch) run_dispatch ;;
  reject) run_reject ;;
  both)
    run_dispatch
    run_reject
    ;;
  *)
    fail "FRIDAY_MOBILE_APPROVAL_REJECT_STEP must be dispatch, reject, or both."
    ;;
esac
