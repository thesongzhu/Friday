#!/usr/bin/env bash
#
# Mobile Share Intake action evidence wrapper.
#
# Truth boundary:
#   Runs the iOS Swift product ViewModel test for the Share Intake "send" action. This proves the
#   product action delegates to the governed Mission Intake write seam with owner/surface/work refs.
#   It does not start or mutate prod Hub, prove a live Hub audit receipt, drive a real simulator tap,
#   claim END-BAR, or prove adoption.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"

OUT_DIR="${FRIDAY_MOBILE_SHARE_INTAKE_ACTION_EVIDENCE_DIR:-${TMPDIR:-/tmp}/friday-mobile-share-intake-action-evidence}"
ACTION_RUNTIME_OUT="${FRIDAY_MOBILE_SHARE_INTAKE_ACTION_RUNTIME_OUT:-${OUT_DIR}/action-runtime-evidence.json}"

mkdir -p "${OUT_DIR}"
chmod 700 "${OUT_DIR}"

echo "Friday mobile Share Intake action evidence starting."
echo "truth_label=mobile_share_intake_swift_viewmodel_runtime_not_live_hub_not_endbar"
echo "out_dir=${OUT_DIR}"

log="${OUT_DIR}/swift-test-mobile-share-intake-action-evidence.log"
FRIDAY_MOBILE_SHARE_INTAKE_ACTION_EVIDENCE_DIR="${OUT_DIR}" \
  swift test \
    --package-path "${REPO_ROOT}/apps/friday-ios" \
    --filter "ShareIntakeViewModelTests/testSubmitCreatesMobileShareMissionIntake" \
    2>&1 | tee "${log}"

if ! grep -Eq "Executed [1-9][0-9]* test|Test run with [1-9][0-9]* test" "${log}"; then
  echo "FATAL: Swift test filter ran zero tests" >&2
  exit 2
fi

node - "${OUT_DIR}" "${ACTION_RUNTIME_OUT}" <<'NODE'
const fs = require("node:fs");
const path = require("node:path");

const [outDir, actionRuntimeOut] = process.argv.slice(2);
const source = path.join(outDir, "mobile-share-intake-action-evidence.json");
const blockers = [];
let actions = [];

if (!fs.existsSync(source)) {
  blockers.push({ code: "missing_swift_evidence", detail: source });
} else {
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(source, "utf8"));
  } catch {
    blockers.push({ code: "invalid_swift_evidence_json", detail: source });
  }
  if (parsed) {
    if (parsed.truth !== "mobile_share_intake_swift_viewmodel_runtime_not_live_hub_not_endbar") {
      blockers.push({ code: "unexpected_truth", detail: parsed.truth || "<missing>" });
    }
    if (parsed.status !== "ready") {
      blockers.push({ code: "evidence_not_ready", detail: parsed.status || "<missing>" });
    }
    actions = Array.isArray(parsed.actions) ? parsed.actions.map((row) => ({ ...row, source_proof: source })) : [];
    const found = actions.some((row) =>
      row.surface === "mobile"
      && row.screen === "shareIntake"
      && row.action_id === "mobile/share/send"
      && row.capability_id === "ask_friday_chat"
      && row.status === "pass");
    if (!found) blockers.push({ code: "missing_share_intake_send_action", detail: source });
  }
}

const report = {
  truth: "mobile_share_intake_action_runtime_evidence_partial_not_live_hub_not_endbar",
  status: blockers.length === 0 ? "ready" : "blocked",
  actionCount: actions.length,
  actions,
  blockers,
  caveat:
    "Partial runtime evidence only: Swift product ViewModel Share Intake delegates to the governed Mission Intake write seam. Later live Hub audit and simulator/device tap must land before END-BAR coverage.",
};

fs.mkdirSync(path.dirname(actionRuntimeOut), { recursive: true });
fs.writeFileSync(actionRuntimeOut, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify({ status: report.status, actionCount: actions.length, out: actionRuntimeOut, blockers }, null, 2));
process.exit(blockers.length === 0 ? 0 : 2);
NODE

echo "Action runtime evidence: ${ACTION_RUNTIME_OUT}"
echo "Truth: partial mobile Share Intake action evidence only; live Hub audit and simulator/device tap remain required."
