#!/usr/bin/env bash
#
# Mobile approval approve/resume live proof wrapper.
#
# Truth boundary:
#   `dispatch` creates two real paused mutating runs. The operator must sign the two pending
#   requests out-of-band. `resume` then runs the mobile Swift live test: one direct Swift write-client
#   resume for the mobile approval screen row, and one FridayChat view-model approve path that relays
#   the supplied signed artifact verbatim to the live write client.
#
#   This wrapper does not read signing keys, mint signatures, kill/restart prod Hub, flip flags, or
#   fabricate organic traffic. It is mobile Swift write-client/view-model evidence, not a simulator
#   tap, not END-BAR, and not release/adoption.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"

STEP="${FRIDAY_MOBILE_APPROVAL_APPROVE_STEP:-dispatch}"
LIVE="${FRIDAY_MOBILE_APPROVAL_APPROVE_LIVE:-0}"
ARTIFACT_DIR="${FRIDAY_MOBILE_APPROVAL_APPROVE_ARTIFACT_DIR:-${TMPDIR:-/tmp}/friday-mobile-approval-approve}"
DIRECT_PROOF_FILE="${FRIDAY_MOBILE_APPROVAL_APPROVE_DIRECT_PROOF_FILE:-mobile-approval-approve-direct-proof.txt}"
CHAT_PROOF_FILE="${FRIDAY_MOBILE_APPROVAL_APPROVE_CHAT_PROOF_FILE:-mobile-approval-approve-chat-proof.txt}"
DIRECT_SIGNED_APPROVAL="${FRIDAY_MOBILE_APPROVAL_APPROVE_DIRECT_SIGNED_APPROVAL:-}"
CHAT_SIGNED_APPROVAL="${FRIDAY_MOBILE_APPROVAL_APPROVE_CHAT_SIGNED_APPROVAL:-}"
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
  local label="$1"
  echo "${ARTIFACT_DIR}/${label}/mobile-approval-approve-${label}.env"
}

proof_file_for_label() {
  local label="$1"
  if [[ "${label}" == "direct" ]]; then
    echo "${DIRECT_PROOF_FILE}"
  else
    echo "${CHAT_PROOF_FILE}"
  fi
}

save_metadata() {
  local label="$1"
  local log_file="$2"
  local run_id approval_id action_digest pending_request signed_default upper
  upper="$(printf '%s' "${label}" | tr '[:lower:]' '[:upper:]')"
  run_id="$(awk -F'= ' '/^[[:space:]]+runId[[:space:]]*=/{gsub(/[[:space:]]/, "", $2); print $2; exit}' "${log_file}")"
  approval_id="$(awk -F'= ' '/^[[:space:]]+approvalId[[:space:]]*=/{gsub(/[[:space:]]/, "", $2); print $2; exit}' "${log_file}")"
  action_digest="$(awk -F'= ' '/^[[:space:]]+actionDigest[[:space:]]*=/{gsub(/[[:space:]]/, "", $2); print $2; exit}' "${log_file}")"
  pending_request="${ARTIFACT_DIR}/${label}/pending-request.json"
  signed_default="${ARTIFACT_DIR}/${label}/signed-approval.json"
  if [[ -z "${run_id}" || -z "${approval_id}" || -z "${action_digest}" ]]; then
    fail "could not parse runId/approvalId/actionDigest from ${log_file}."
  fi
  cat >"$(metadata_path "${label}")" <<EOF
FRIDAY_MOBILE_APPROVAL_APPROVE_${upper}_RUN_ID=${run_id}
FRIDAY_MOBILE_APPROVAL_APPROVE_${upper}_APPROVAL_ID=${approval_id}
FRIDAY_MOBILE_APPROVAL_APPROVE_${upper}_ACTION_DIGEST=${action_digest}
FRIDAY_MOBILE_APPROVAL_APPROVE_${upper}_PENDING_REQUEST=${pending_request}
FRIDAY_MOBILE_APPROVAL_APPROVE_${upper}_SIGNED_APPROVAL=${signed_default}
EOF
}

load_metadata() {
  local label="$1"
  local meta
  meta="$(metadata_path "${label}")"
  if [[ ! -f "${meta}" ]]; then
    fail "metadata missing for ${label}: ${meta}. Run dispatch first."
  fi
  # shellcheck disable=SC1090
  source "${meta}"
}

write_signing_script() {
  local script_path="${ARTIFACT_DIR}/sign-mobile-approval-approve.sh"
  mkdir -p "${ARTIFACT_DIR}"
  cat >"${script_path}" <<EOF
#!/usr/bin/env bash
set -euo pipefail
cd "${REPO_ROOT}"
cargo run -p friday-operator-cli --bin friday-operator-approve -- sign --key "\${FRIDAY_OPERATOR_APPROVE_KEY:-\$HOME/.friday/operator-approve.key}" --request "${ARTIFACT_DIR}/direct/pending-request.json" > "${ARTIFACT_DIR}/direct/signed-approval.json"
cargo run -p friday-operator-cli --bin friday-operator-approve -- sign --key "\${FRIDAY_OPERATOR_APPROVE_KEY:-\$HOME/.friday/operator-approve.key}" --request "${ARTIFACT_DIR}/chat/pending-request.json" > "${ARTIFACT_DIR}/chat/signed-approval.json"
echo "signed artifacts ready:"
echo "  ${ARTIFACT_DIR}/direct/signed-approval.json"
echo "  ${ARTIFACT_DIR}/chat/signed-approval.json"
EOF
  chmod 700 "${script_path}"
  echo "${script_path}"
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
  truth: "mobile_approval_approve_action_runtime_evidence_operator_signed_not_sim_tap_not_endbar",
  status: actionRows.length > 0 ? "ready" : "blocked",
  actions: actionRows,
  source_proof: swiftProofPath,
  caveat:
    "Approve action evidence only: mobile Swift write-client/view-model relayed operator-signed artifacts. It does not prove simulator tap, END-BAR, release, or adoption.",
};
fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, `${JSON.stringify(evidence, null, 2)}\n`);
console.log(JSON.stringify({ status: evidence.status, actionCount: evidence.actions.length, out: outPath }, null, 2));
NODE
}

run_dispatch_one() {
  local label="$1"
  local proof_file
  proof_file="$(proof_file_for_label "${label}")"
  local subdir="${ARTIFACT_DIR}/${label}"
  mkdir -p "${subdir}"
  chmod 700 "${subdir}"
  local log_file="${subdir}/dispatch.log"
  echo "Friday mobile approval approve proof: dispatch ${label}"
  echo "truth_label=mobile_approval_approve_${label}_dispatch_paused_real_run_not_signature_not_go"
  echo "artifact_dir=${subdir}"
  driver \
    --mode dispatch-mutating \
    --artifact-dir "${subdir}" \
    --proof-file "${proof_file}" | tee "${log_file}"
  save_metadata "${label}" "${log_file}"
}

run_dispatch() {
  need_live
  run_dispatch_one direct
  run_dispatch_one chat
  local signer
  signer="$(write_signing_script)"
  echo
  echo "Operator signing script: ${signer}"
  echo "Run this exact command in a trusted terminal, then rerun resume:"
  echo "  bash ${signer}"
  echo
  echo "Then:"
  echo "  FRIDAY_MOBILE_APPROVAL_APPROVE_LIVE=1 FRIDAY_MOBILE_APPROVAL_APPROVE_ARTIFACT_DIR=${ARTIFACT_DIR} FRIDAY_MOBILE_APPROVAL_APPROVE_STEP=resume bash scripts/ops/friday-mobile-approval-approve-proof.sh"
  echo "Truth: dispatch paused two real mutating runs; it did not sign, resume, release, GO, or prove adoption."
}

run_resume() {
  need_live
  load_metadata direct
  load_metadata chat
  local direct_signed="${DIRECT_SIGNED_APPROVAL:-${FRIDAY_MOBILE_APPROVAL_APPROVE_DIRECT_SIGNED_APPROVAL:-}}"
  local chat_signed="${CHAT_SIGNED_APPROVAL:-${FRIDAY_MOBILE_APPROVAL_APPROVE_CHAT_SIGNED_APPROVAL:-}}"
  need_file "FRIDAY_MOBILE_APPROVAL_APPROVE_DIRECT_SIGNED_APPROVAL" "${direct_signed}"
  need_file "FRIDAY_MOBILE_APPROVAL_APPROVE_CHAT_SIGNED_APPROVAL" "${chat_signed}"
  echo "Friday mobile approval approve proof: resume"
  echo "truth_label=mobile_approval_approve_swift_live_operator_signed_no_key_custody"
  echo "direct_run_id=${FRIDAY_MOBILE_APPROVAL_APPROVE_DIRECT_RUN_ID}"
  echo "chat_run_id=${FRIDAY_MOBILE_APPROVAL_APPROVE_CHAT_RUN_ID}"
  FRIDAY_MOBILE_LIVE_APPROVAL_APPROVE_TEST=1 \
  FRIDAY_MOBILE_APPROVAL_APPROVE_DIRECT_RUN_ID="${FRIDAY_MOBILE_APPROVAL_APPROVE_DIRECT_RUN_ID}" \
  FRIDAY_MOBILE_APPROVAL_APPROVE_DIRECT_SIGNED_APPROVAL="${direct_signed}" \
  FRIDAY_MOBILE_APPROVAL_APPROVE_CHAT_RUN_ID="${FRIDAY_MOBILE_APPROVAL_APPROVE_CHAT_RUN_ID}" \
  FRIDAY_MOBILE_APPROVAL_APPROVE_CHAT_APPROVAL_ID="${FRIDAY_MOBILE_APPROVAL_APPROVE_CHAT_APPROVAL_ID}" \
  FRIDAY_MOBILE_APPROVAL_APPROVE_CHAT_ACTION_DIGEST="${FRIDAY_MOBILE_APPROVAL_APPROVE_CHAT_ACTION_DIGEST}" \
  FRIDAY_MOBILE_APPROVAL_APPROVE_CHAT_SIGNED_APPROVAL="${chat_signed}" \
  FRIDAY_MOBILE_APPROVAL_APPROVE_PROOF_OUT="${SWIFT_PROOF_OUT}" \
    swift test \
      --package-path "${REPO_ROOT}/apps/friday-ios" \
      --filter liveMobileApprovalApproveRelaysOperatorSignedArtifactsWithoutMinting
  if [[ ! -s "${SWIFT_PROOF_OUT}" ]]; then
    fail "Swift live proof did not write ${SWIFT_PROOF_OUT}."
  fi
  write_action_runtime_evidence "${SWIFT_PROOF_OUT}" "${ACTION_RUNTIME_OUT}"
  echo "Swift proof: ${SWIFT_PROOF_OUT}"
  echo "Action runtime evidence: ${ACTION_RUNTIME_OUT}"
  echo "Truth: mobile approve relayed operator-signed artifacts; it did not read or mint signing keys, release, GO, or prove adoption."
}

case "${STEP}" in
  dispatch) run_dispatch ;;
  resume) run_resume ;;
  *)
    fail "FRIDAY_MOBILE_APPROVAL_APPROVE_STEP must be dispatch or resume."
    ;;
esac
