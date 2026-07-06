#!/usr/bin/env bash
#
# Mobile approval approve live proof wrapper.
#
# Truth boundary:
#   `dispatch` creates a real paused mutating run through the existing governed S6 diagnostic
#   driver. `approve` then runs the mobile Swift live write-client test against that exact pending
#   approval, relaying an externally supplied operator-signed artifact verbatim. This does not read
#   signing keys, mint signatures, kill/restart prod Hub, flip flags, or fabricate organic traffic.
#   It is mobile Swift write-client evidence, not a simulator tap, not END-BAR, and not adoption.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"

STEP="${FRIDAY_MOBILE_APPROVAL_APPROVE_STEP:-dispatch}"
LIVE="${FRIDAY_MOBILE_APPROVAL_APPROVE_LIVE:-0}"
ARTIFACT_DIR="${FRIDAY_MOBILE_APPROVAL_APPROVE_ARTIFACT_DIR:-${TMPDIR:-/tmp}/friday-mobile-approval-approve}"
PROOF_FILE="${FRIDAY_MOBILE_APPROVAL_APPROVE_DRIVER_PROOF_FILE:-mobile-approval-approve-proof.txt}"
RUN_ID="${FRIDAY_MOBILE_APPROVAL_APPROVE_RUN_ID:-}"
APPROVAL_ID="${FRIDAY_MOBILE_APPROVAL_APPROVE_APPROVAL_ID:-}"
ACTION_DIGEST="${FRIDAY_MOBILE_APPROVAL_APPROVE_ACTION_DIGEST:-}"
SIGNED_APPROVAL="${FRIDAY_MOBILE_APPROVAL_APPROVE_SIGNED_APPROVAL:-}"
SWIFT_PROOF_OUT="${FRIDAY_MOBILE_APPROVAL_APPROVE_SWIFT_PROOF_OUT:-${ARTIFACT_DIR}/mobile-approval-approve-proof.json}"
ACTION_RUNTIME_OUT="${FRIDAY_MOBILE_APPROVAL_APPROVE_ACTION_RUNTIME_OUT:-${ARTIFACT_DIR}/action-runtime-evidence.json}"

fail() {
  echo "FATAL: $*" >&2
  exit 3
}

need_live() {
  if [[ "${LIVE}" != "1" ]]; then
    fail "set FRIDAY_MOBILE_APPROVAL_APPROVE_LIVE=1 to run this live proof."
  fi
}

need_file() {
  local name="$1"
  local path="$2"
  if [[ -z "${path}" || ! -f "${path}" ]]; then
    fail "${name} must point to an existing file."
  fi
}

driver() {
  node "${REPO_ROOT}/scripts/diagnostics/friday-s6-transport-a-driver.mjs" "$@"
}

metadata_path() {
  echo "${ARTIFACT_DIR}/mobile-approval-approve-metadata.env"
}

save_metadata() {
  local log_file="$1"
  local run_id approval_id action_digest pending_request signed_default
  run_id="$(awk -F'= ' '/^[[:space:]]+runId[[:space:]]*=/{gsub(/[[:space:]]/, "", $2); print $2; exit}' "${log_file}")"
  approval_id="$(awk -F'= ' '/^[[:space:]]+approvalId[[:space:]]*=/{gsub(/[[:space:]]/, "", $2); print $2; exit}' "${log_file}")"
  action_digest="$(awk -F'= ' '/^[[:space:]]+actionDigest[[:space:]]*=/{gsub(/[[:space:]]/, "", $2); print $2; exit}' "${log_file}")"
  pending_request="${ARTIFACT_DIR}/pending-request.json"
  signed_default="${ARTIFACT_DIR}/signed-approval.json"
  if [[ -z "${run_id}" || -z "${approval_id}" || -z "${action_digest}" ]]; then
    fail "could not parse runId/approvalId/actionDigest from ${log_file}."
  fi
  cat >"$(metadata_path)" <<EOF
FRIDAY_MOBILE_APPROVAL_APPROVE_RUN_ID=${run_id}
FRIDAY_MOBILE_APPROVAL_APPROVE_APPROVAL_ID=${approval_id}
FRIDAY_MOBILE_APPROVAL_APPROVE_ACTION_DIGEST=${action_digest}
FRIDAY_MOBILE_APPROVAL_APPROVE_PENDING_REQUEST=${pending_request}
FRIDAY_MOBILE_APPROVAL_APPROVE_SIGNED_APPROVAL=${signed_default}
EOF
}

load_metadata_value() {
  local var_name="$1"
  local explicit="$2"
  if [[ -n "${explicit}" ]]; then
    echo "${explicit}"
    return
  fi
  local meta
  meta="$(metadata_path)"
  if [[ ! -f "${meta}" ]]; then
    fail "${var_name} is required when ${meta} is absent."
  fi
  # shellcheck disable=SC1090
  source "${meta}"
  local value="${!var_name:-}"
  if [[ -z "${value}" ]]; then
    fail "${meta} does not contain ${var_name}."
  fi
  echo "${value}"
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
  echo "${FRIDAY_MOBILE_APPROVAL_APPROVE_ACTION_DIGEST:-}"
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
const allActionsPassed = actionRows.length > 0
  && actionRows.every((row) => row && row.status === "pass");
const proofPassed = swiftProof.status === "pass" && allActionsPassed;
const evidence = {
  truth: "mobile_approval_approve_action_runtime_evidence_signed_artifact_relay_not_sim_tap_not_endbar",
  status: proofPassed ? "ready" : "blocked",
  actions: actionRows,
  source_proof: swiftProofPath,
  run_id: swiftProof.run_id,
  approval_id: swiftProof.approval_id,
  failure_reason: proofPassed
    ? null
    : (swiftProof.failure_reason || swiftProof.resume?.status || "mobile_approval_approve_not_passed"),
  caveat:
    "Approve action evidence only: mobile Swift write-client relay of an externally supplied signed artifact. It does not prove simulator tap, END-BAR, release, or adoption.",
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
  echo "Friday mobile approval approve proof: dispatch"
  echo "truth_label=mobile_approval_approve_dispatch_paused_real_run_not_signature_not_go"
  echo "artifact_dir=${ARTIFACT_DIR}"
  driver \
    --mode dispatch-mutating \
    --artifact-dir "${ARTIFACT_DIR}" \
    --proof-file "${PROOF_FILE}" | tee "${log_file}"
  save_metadata "${log_file}"
  echo
  echo "Metadata written: $(metadata_path)"
  echo "Operator-signable request: ${ARTIFACT_DIR}/pending-request.json"
  echo "Default signed artifact path: ${ARTIFACT_DIR}/signed-approval.json"
  echo "Truth: dispatch paused a real mutating run; it did not sign, resume, release, GO, or prove adoption."
}

run_approve() {
  need_live
  local run_id approval_id action_digest signed_approval
  run_id="$(load_metadata_value FRIDAY_MOBILE_APPROVAL_APPROVE_RUN_ID "${RUN_ID}")"
  approval_id="$(load_metadata_value FRIDAY_MOBILE_APPROVAL_APPROVE_APPROVAL_ID "${APPROVAL_ID}")"
  action_digest="$(load_action_digest)"
  signed_approval="$(load_metadata_value FRIDAY_MOBILE_APPROVAL_APPROVE_SIGNED_APPROVAL "${SIGNED_APPROVAL}")"
  need_file "FRIDAY_MOBILE_APPROVAL_APPROVE_SIGNED_APPROVAL" "${signed_approval}"
  mkdir -p "${ARTIFACT_DIR}"
  echo "Friday mobile approval approve proof: approve"
  echo "truth_label=mobile_approval_approve_swift_live_write_client_signed_artifact_relay"
  echo "run_id=${run_id}"
  echo "approval_id=${approval_id}"
  echo "signed_approval=${signed_approval}"
  FRIDAY_MOBILE_LIVE_APPROVAL_APPROVE_TEST=1 \
  FRIDAY_MOBILE_APPROVAL_APPROVE_RUN_ID="${run_id}" \
  FRIDAY_MOBILE_APPROVAL_APPROVE_APPROVAL_ID="${approval_id}" \
  FRIDAY_MOBILE_APPROVAL_APPROVE_ACTION_DIGEST="${action_digest}" \
  FRIDAY_MOBILE_APPROVAL_APPROVE_SIGNED_APPROVAL="${signed_approval}" \
  FRIDAY_MOBILE_APPROVAL_APPROVE_PROOF_OUT="${SWIFT_PROOF_OUT}" \
    swift test \
      --package-path "${REPO_ROOT}/apps/friday-ios" \
      --filter liveMobileApprovalApprove
  if [[ ! -s "${SWIFT_PROOF_OUT}" ]]; then
    fail "Swift live proof did not write ${SWIFT_PROOF_OUT}."
  fi
  write_action_runtime_evidence "${SWIFT_PROOF_OUT}" "${ACTION_RUNTIME_OUT}"
  echo "Swift proof: ${SWIFT_PROOF_OUT}"
  echo "Action runtime evidence: ${ACTION_RUNTIME_OUT}"
  echo "Truth: mobile approve relayed an externally supplied signed artifact; it did not read signing keys, mint signatures, release, GO, or prove adoption."
}

case "${STEP}" in
  dispatch) run_dispatch ;;
  approve) run_approve ;;
  both)
    run_dispatch
    run_approve
    ;;
  *)
    fail "FRIDAY_MOBILE_APPROVAL_APPROVE_STEP must be dispatch, approve, or both."
    ;;
esac
