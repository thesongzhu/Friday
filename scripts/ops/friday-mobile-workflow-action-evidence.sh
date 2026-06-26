#!/usr/bin/env bash
#
# Mobile Workflow run-control action evidence wrapper.
#
# Truth boundary:
#   Runs iOS Swift product ViewModel tests for workflow/session run-control. This proves the
#   visible workflow run-control action delegates to the governed cancel seam and renders a
#   refs-only receipt. It does not start or mutate prod Hub, prove a live Hub audit receipt,
#   drive a real simulator tap, claim END-BAR, or prove adoption.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"

OUT_DIR="${FRIDAY_MOBILE_WORKFLOW_ACTION_EVIDENCE_DIR:-${TMPDIR:-/tmp}/friday-mobile-workflow-action-evidence}"
ACTION_RUNTIME_OUT="${FRIDAY_MOBILE_WORKFLOW_ACTION_RUNTIME_OUT:-${OUT_DIR}/action-runtime-evidence.json}"

mkdir -p "${OUT_DIR}"
chmod 700 "${OUT_DIR}"

echo "Friday mobile Workflow action evidence starting."
echo "truth_label=mobile_workflow_action_swift_viewmodel_runtime_not_live_hub_not_endbar"
echo "out_dir=${OUT_DIR}"

log="${OUT_DIR}/swift-test-mobile-workflow-action-evidence.log"
FRIDAY_MOBILE_WORKFLOW_ACTION_EVIDENCE_DIR="${OUT_DIR}" \
  swift test \
    --package-path "${REPO_ROOT}/apps/friday-ios" \
    --filter "SessionContinuationViewModelTests/testStopUsesGovernedCancelRunAndSurfacesReceipt" \
    2>&1 | tee "${log}"

if ! grep -Eq "Executed [1-9][0-9]* test|Test run with [1-9][0-9]* test" "${log}"; then
  echo "FATAL: Swift test filter ran zero tests" >&2
  exit 2
fi

run_swift_test() {
  local filter="$1"
  local safe_filter="${filter//\//_}"
  local log="${OUT_DIR}/swift-test-${safe_filter}.log"
  FRIDAY_MOBILE_WORKFLOW_ACTION_EVIDENCE_DIR="${OUT_DIR}" \
    swift test \
      --package-path "${REPO_ROOT}/apps/friday-ios" \
      --filter "${filter}" 2>&1 | tee "${log}"
  if ! grep -Eq "Executed [1-9][0-9]* test|Test run with [1-9][0-9]* test" "${log}"; then
    echo "FATAL: Swift test filter ran zero tests: ${filter}" >&2
    exit 2
  fi
}

run_swift_test "HomeViewModelTests/testRetryWorkItemSendsLifecycleWriteAndRefreshes"
run_swift_test "HomeViewModelTests/testCancelWorkItemSendsLifecycleWriteAndRefreshes"

node - "${OUT_DIR}" "${ACTION_RUNTIME_OUT}" <<'NODE'
const fs = require("node:fs");
const path = require("node:path");

const [outDir, actionRuntimeOut] = process.argv.slice(2);
const sources = [
  path.join(outDir, "mobile-workflow-action-evidence.json"),
  path.join(outDir, "mobile-workflow-retry-action-evidence.json"),
  path.join(outDir, "mobile-workflow-cancel-action-evidence.json"),
];
const blockers = [];
let actions = [];

for (const source of sources) {
  if (!fs.existsSync(source)) {
    blockers.push({ code: "missing_swift_evidence", detail: source });
    continue;
  }
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(source, "utf8"));
  } catch {
    blockers.push({ code: "invalid_swift_evidence_json", detail: source });
    continue;
  }
  if (![
    "mobile_workflow_action_swift_viewmodel_runtime_not_live_hub_not_endbar",
    "mobile_workflow_lifecycle_swift_viewmodel_runtime_not_live_hub_not_endbar",
  ].includes(parsed.truth)) {
    blockers.push({ code: "unexpected_truth", detail: `${source}:${parsed.truth || "<missing>"}` });
  }
  if (parsed.status !== "ready") {
    blockers.push({ code: "evidence_not_ready", detail: `${source}:${parsed.status || "<missing>"}` });
  }
  actions.push(...(Array.isArray(parsed.actions) ? parsed.actions.map((row) => ({ ...row, source_proof: source })) : []));
}

for (const actionId of ["workflow_run_control", "mobile/workflow/cancel", "mobile/workflow/retry"]) {
  const found = actions.some((row) => row.surface === "mobile" && row.action_id === actionId && row.status === "pass");
  if (!found) blockers.push({ code: "missing_workflow_action", detail: actionId });
}

const report = {
  truth: "mobile_workflow_action_runtime_evidence_partial_not_live_hub_not_endbar",
  status: blockers.length === 0 ? "ready" : "blocked",
  actionCount: actions.length,
  actions,
  blockers,
  caveat:
    "Partial runtime evidence only: Swift product ViewModel workflow run-control delegates to the governed write seam and renders refs-only result. Later live Hub audit and real simulator/device tap must land before END-BAR coverage.",
};

fs.mkdirSync(path.dirname(actionRuntimeOut), { recursive: true });
fs.writeFileSync(actionRuntimeOut, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify({ status: report.status, actionCount: actions.length, out: actionRuntimeOut, blockers }, null, 2));
process.exit(blockers.length === 0 ? 0 : 2);
NODE

echo "Action runtime evidence: ${ACTION_RUNTIME_OUT}"
echo "Truth: partial Workflow action evidence only; live Hub audit and simulator/device tap remain required."
