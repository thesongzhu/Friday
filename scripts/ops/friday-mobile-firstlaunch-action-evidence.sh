#!/usr/bin/env bash
#
# Mobile firstLaunch Scan/Pair/Retry/Cancel action evidence wrapper.
#
# Truth boundary:
#   Runs iOS Swift product ViewModel tests for firstLaunch pairing Scan, Pair now, Retry, and
#   Cancel actions. This proves QR preflight, accepted PairAck, retry after unavailable, and
#   cancellation before late PairAck. It does not start or mutate prod Hub, prove a real
#   simulator tap, claim END-BAR, or prove adoption.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"

OUT_DIR="${FRIDAY_MOBILE_FIRSTLAUNCH_ACTION_EVIDENCE_DIR:-${TMPDIR:-/tmp}/friday-mobile-firstlaunch-action-evidence}"
ACTION_RUNTIME_OUT="${FRIDAY_MOBILE_FIRSTLAUNCH_ACTION_RUNTIME_OUT:-${OUT_DIR}/action-runtime-evidence.json}"

mkdir -p "${OUT_DIR}"
chmod 700 "${OUT_DIR}"

echo "Friday mobile firstLaunch action evidence starting."
echo "truth_label=mobile_firstlaunch_pairing_action_swift_viewmodel_runtime_not_live_hub_not_endbar"
echo "out_dir=${OUT_DIR}"

run_swift_test() {
  local filter="$1"
  local log="${OUT_DIR}/swift-test-${filter}.log"
  FRIDAY_MOBILE_FIRSTLAUNCH_ACTION_EVIDENCE_DIR="${OUT_DIR}" \
    swift test \
      --package-path "${REPO_ROOT}/apps/friday-ios" \
      --filter "${filter}" 2>&1 | tee "${log}"
  if ! grep -Eq "Executed [1-9][0-9]* test|Test run with [1-9][0-9]* test" "${log}"; then
    echo "FATAL: Swift test filter ran zero tests: ${filter}" >&2
    exit 2
  fi
}

run_swift_test homeViewModelCarriesPairingPreflightStateAndCanClearIt
run_swift_test homeViewModelPairScannedQrDrivesPairAckAcceptedWithoutLeakingSecret
run_swift_test homeViewModelRetryAfterUnavailableRunsPairingFlowAgain
run_swift_test homeViewModelCancelPairingAttemptPreventsLatePairAckFromWinning

node - "${OUT_DIR}" "${ACTION_RUNTIME_OUT}" <<'NODE'
const fs = require("node:fs");
const path = require("node:path");

const [outDir, actionRuntimeOut] = process.argv.slice(2);
const files = [
  path.join(outDir, "mobile-firstlaunch-scan-action-evidence.json"),
  path.join(outDir, "mobile-firstlaunch-pairnow-action-evidence.json"),
  path.join(outDir, "mobile-firstlaunch-retry-action-evidence.json"),
  path.join(outDir, "mobile-firstlaunch-cancel-action-evidence.json"),
];
const blockers = [];
const actions = [];

for (const file of files) {
  if (!fs.existsSync(file)) {
    blockers.push({ code: "missing_swift_evidence", detail: file });
    continue;
  }
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    blockers.push({ code: "invalid_swift_evidence_json", detail: file });
    continue;
  }
  if (parsed.truth !== "mobile_firstlaunch_pairing_action_swift_viewmodel_runtime_not_live_hub_not_endbar") {
    blockers.push({ code: "unexpected_truth", detail: `${file}:${parsed.truth || "<missing>"}` });
  }
  if (parsed.status !== "ready") {
    blockers.push({ code: "evidence_not_ready", detail: `${file}:${parsed.status || "<missing>"}` });
  }
  const rows = Array.isArray(parsed.actions) ? parsed.actions : [];
  if (rows.length === 0) blockers.push({ code: "missing_actions", detail: file });
  for (const row of rows) {
    actions.push({ ...row, source_proof: file });
  }
}

const report = {
  truth: "mobile_firstlaunch_action_runtime_evidence_partial_not_live_hub_not_endbar",
  status: blockers.length === 0 ? "ready" : "blocked",
  actionCount: actions.length,
  actions,
  blockers,
  caveat:
    "Partial runtime evidence only: Swift product ViewModel/Home firstLaunch Scan, Pair now, Retry, and Cancel semantics. Later real simulator/device tap plus live Hub PairAck proof must land before END-BAR coverage.",
};

fs.mkdirSync(path.dirname(actionRuntimeOut), { recursive: true });
fs.writeFileSync(actionRuntimeOut, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify({ status: report.status, actionCount: actions.length, out: actionRuntimeOut }, null, 2));
process.exit(blockers.length === 0 ? 0 : 2);
NODE

echo "Action runtime evidence: ${ACTION_RUNTIME_OUT}"
echo "Truth: partial firstLaunch Scan/Pair/Retry/Cancel action evidence only; live simulator/device and Hub proof remain required."
