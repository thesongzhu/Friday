#!/usr/bin/env bash
#
# Desktop approval relay live proof wrapper.
#
# Truth boundary:
#   This wraps the existing S6 sealed-WS driver into a desktop-product proof entrypoint. It does not read signing keys,
#   mint signatures, kill/restart prod Hub, flip flags, or fabricate organic traffic. `dispatch`
#   creates a real paused mutating run and a signable pending-request artifact;
#   `resume` relays an operator-signed JSON artifact verbatim through the shipped write seam;
#   `reject` owner-auth rejects the pending approval without signing or executing the mutation.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"

STEP="${FRIDAY_DESKTOP_APPROVAL_RELAY_STEP:-dispatch}"
LIVE="${FRIDAY_DESKTOP_APPROVAL_RELAY_LIVE:-0}"
ARTIFACT_DIR="${FRIDAY_DESKTOP_APPROVAL_RELAY_ARTIFACT_DIR:-${TMPDIR:-/tmp}/friday-desktop-approval-relay}"
PROOF_FILE="${FRIDAY_DESKTOP_APPROVAL_RELAY_PROOF_FILE:-desktop-approval-relay-proof.txt}"
SIGNED_APPROVAL="${FRIDAY_DESKTOP_APPROVAL_SIGNED_APPROVAL:-}"
RUN_ID="${FRIDAY_DESKTOP_APPROVAL_RUN_ID:-}"
APPROVAL_ID="${FRIDAY_DESKTOP_APPROVAL_APPROVAL_ID:-}"
ACTION_RUNTIME_OUT="${FRIDAY_DESKTOP_APPROVAL_ACTION_RUNTIME_OUT:-}"

fail() {
  echo "FATAL: $*" >&2
  exit 3
}

need_live() {
  if [[ "${LIVE}" != "1" ]]; then
    fail "set FRIDAY_DESKTOP_APPROVAL_RELAY_LIVE=1 to run this live proof."
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
  echo "${ARTIFACT_DIR}/desktop-approval-relay-metadata.env"
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
FRIDAY_DESKTOP_APPROVAL_RUN_ID=${run_id}
FRIDAY_DESKTOP_APPROVAL_APPROVAL_ID=${approval_id}
FRIDAY_DESKTOP_APPROVAL_ACTION_DIGEST=${action_digest}
FRIDAY_DESKTOP_APPROVAL_PENDING_REQUEST=${pending_request}
FRIDAY_DESKTOP_APPROVAL_SIGNED_APPROVAL=${signed_default}
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
    fail "FRIDAY_DESKTOP_APPROVAL_RUN_ID is required when ${meta} is absent."
  fi
  # shellcheck disable=SC1090
  source "${meta}"
  if [[ -z "${FRIDAY_DESKTOP_APPROVAL_RUN_ID:-}" ]]; then
    fail "${meta} does not contain FRIDAY_DESKTOP_APPROVAL_RUN_ID."
  fi
  echo "${FRIDAY_DESKTOP_APPROVAL_RUN_ID}"
}

load_approval_id() {
  if [[ -n "${APPROVAL_ID}" ]]; then
    echo "${APPROVAL_ID}"
    return
  fi
  local meta
  meta="$(metadata_path)"
  if [[ ! -f "${meta}" ]]; then
    fail "FRIDAY_DESKTOP_APPROVAL_APPROVAL_ID is required when ${meta} is absent."
  fi
  # shellcheck disable=SC1090
  source "${meta}"
  if [[ -z "${FRIDAY_DESKTOP_APPROVAL_APPROVAL_ID:-}" ]]; then
    fail "${meta} does not contain FRIDAY_DESKTOP_APPROVAL_APPROVAL_ID."
  fi
  echo "${FRIDAY_DESKTOP_APPROVAL_APPROVAL_ID}"
}

write_action_runtime_evidence() {
  local out="$1"
  local run_id="$2"
  local approval_id="$3"
  if [[ -z "${out}" ]]; then
    return
  fi
  mkdir -p "$(dirname "${out}")"
  node - "${out}" "${run_id}" "${approval_id}" <<'NODE'
const fs = require("node:fs");
const [out, runId, approvalId] = process.argv.slice(2);
const evidence = {
  truth: "desktop_approval_reject_action_runtime_evidence_not_endbar_not_signature",
  status: "ready",
  actions: [
    {
      surface: "desktop",
      screen: "fridayChat",
      action_id: "act",
      status: "pass",
      evidence_ref: `proof://desktop/approval-reject/${runId}`,
      run_id: runId,
      approval_id: approvalId,
    },
  ],
  caveat: "Reject action evidence only: owner-auth refusal of a paused mutation. It does not prove operator-signed approve, END-BAR, release, or adoption.",
};
fs.writeFileSync(out, `${JSON.stringify(evidence, null, 2)}\n`);
NODE
}

write_approve_action_runtime_evidence() {
  local out="$1"
  local run_id="$2"
  if [[ -z "${out}" ]]; then
    return
  fi
  mkdir -p "$(dirname "${out}")"
  node - "${out}" "${run_id}" <<'NODE'
const fs = require("node:fs");
const [out, runId] = process.argv.slice(2);
const evidence = {
  truth: "desktop_approval_approve_action_runtime_evidence_operator_signed_not_endbar",
  status: "ready",
  actions: [
    {
      surface: "desktop",
      screen: "fridayChat",
      action_id: "check",
      status: "pass",
      evidence_ref: `proof://desktop/approval-approve/${runId}`,
      run_id: runId,
    },
  ],
  caveat: "Approve action evidence only: relayed an operator-signed artifact. It does not prove END-BAR, release, adoption, or key custody.",
};
fs.writeFileSync(out, `${JSON.stringify(evidence, null, 2)}\n`);
NODE
}

run_dispatch() {
  need_live
  mkdir -p "${ARTIFACT_DIR}"
  chmod 700 "${ARTIFACT_DIR}"
  local log_file="${ARTIFACT_DIR}/dispatch.log"
  echo "Friday desktop approval relay proof: dispatch"
  echo "truth_label=desktop_approval_relay_dispatch_paused_real_run_not_signature_not_go"
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

run_resume() {
  need_live
  need_file "FRIDAY_DESKTOP_APPROVAL_SIGNED_APPROVAL" "${SIGNED_APPROVAL}"
  local run_id log_file
  run_id="$(load_run_id)"
  log_file="${ARTIFACT_DIR}/resume.log"
  echo "Friday desktop approval relay proof: resume"
  echo "truth_label=desktop_approval_relay_resume_operator_signed_artifact_verbatim"
  echo "run_id=${run_id}"
  echo "signed_approval=${SIGNED_APPROVAL}"
  driver --mode resume --run-id "${run_id}" --approval "${SIGNED_APPROVAL}" | tee "${log_file}"
  if ! grep -q "\\[resume\\] op=resume accepted=true" "${log_file}"; then
    fail "resume proof did not report accepted=true."
  fi
  write_approve_action_runtime_evidence "${ACTION_RUNTIME_OUT}" "${run_id}"
  if [[ -n "${ACTION_RUNTIME_OUT}" ]]; then
    echo "Action runtime evidence: ${ACTION_RUNTIME_OUT}"
  fi
  echo "Truth: resume relayed the supplied signed artifact; inspect the driver output for accepted/status."
}

run_reject() {
  need_live
  local run_id approval_id log_file
  run_id="$(load_run_id)"
  approval_id="$(load_approval_id)"
  log_file="${ARTIFACT_DIR}/reject.log"
  echo "Friday desktop approval relay proof: reject"
  echo "truth_label=desktop_approval_relay_reject_owner_authed_no_signature_no_mutation"
  echo "run_id=${run_id}"
  echo "approval_id=${approval_id}"
  driver --mode reject --run-id "${run_id}" --approval-id "${approval_id}" | tee "${log_file}"
  if ! grep -q "\\[reject\\] PASS" "${log_file}"; then
    fail "reject proof did not report PASS."
  fi
  write_action_runtime_evidence "${ACTION_RUNTIME_OUT}" "${run_id}" "${approval_id}"
  if [[ -n "${ACTION_RUNTIME_OUT}" ]]; then
    echo "Action runtime evidence: ${ACTION_RUNTIME_OUT}"
  fi
  echo "Truth: reject refused the pending approval through run-control; it did not sign, resume, release, GO, or prove adoption."
}

case "${STEP}" in
  dispatch) run_dispatch ;;
  resume) run_resume ;;
  reject) run_reject ;;
  *)
    fail "FRIDAY_DESKTOP_APPROVAL_RELAY_STEP must be dispatch, resume, or reject."
    ;;
esac
