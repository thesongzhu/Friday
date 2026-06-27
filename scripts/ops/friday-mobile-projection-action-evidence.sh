#!/usr/bin/env bash
#
# Mobile projection product action evidence wrapper.
#
# Truth boundary:
#   Runs iOS Swift ViewModel tests and exports action-runtime evidence for selected projection
#   product destinations that already have native surfaces. This is partial runtime evidence only:
#   it does not start or mutate prod Hub, drive a simulator/device tap, claim END-BAR, or prove
#   adoption.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"

OUT_DIR="${FRIDAY_MOBILE_PROJECTION_ACTION_EVIDENCE_DIR:-${TMPDIR:-/tmp}/friday-mobile-projection-action-evidence}"
ACTION_RUNTIME_OUT="${FRIDAY_MOBILE_PROJECTION_ACTION_RUNTIME_OUT:-${OUT_DIR}/action-runtime-evidence.json}"

mkdir -p "${OUT_DIR}"
chmod 700 "${OUT_DIR}"

echo "Friday mobile projection action evidence starting."
echo "truth_label=mobile_projection_swift_viewmodel_runtime_not_live_hub_not_endbar"
echo "out_dir=${OUT_DIR}"

run_swift_test() {
  local filter="$1"
  local safe_filter="${filter//\//_}"
  local log="${OUT_DIR}/swift-test-${safe_filter}.log"
  FRIDAY_MOBILE_PROJECTION_ACTION_EVIDENCE_DIR="${OUT_DIR}" \
    swift test \
      --package-path "${REPO_ROOT}/apps/friday-ios" \
      --filter "${filter}" 2>&1 | tee "${log}"
  if ! grep -Eq "Executed [1-9][0-9]* test|Test run with [1-9][0-9]* test" "${log}"; then
    echo "FATAL: Swift test filter ran zero tests: ${filter}" >&2
    exit 2
  fi
}

run_swift_test "HomeViewModelTests/testRefresh_liftsConsumerSurfaceProjectionRefs"
run_swift_test "FridayMobileShellCoreTests.pushReadinessViewModelRefreshesAndRequestsPermission"

node - "${OUT_DIR}" "${ACTION_RUNTIME_OUT}" <<'NODE'
const fs = require("node:fs");
const path = require("node:path");

const [outDir, actionRuntimeOut] = process.argv.slice(2);
const files = [
  path.join(outDir, "mobile-projection-action-evidence.json"),
  path.join(outDir, "mobile-settings-action-evidence.json"),
];
const requiredActions = [
  "mobile/missions/read",
  "mobile/platform/capability-matrix",
  "mobile/pet/state-mapping",
  "mobile/proof/viewer-open",
  "mobile/entrypoints/readiness",
  "mobile/settings/push-permission",
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
  if (parsed.status !== "ready") {
    blockers.push({ code: "evidence_not_ready", detail: `${file}:${parsed.status || "<missing>"}` });
  }
  const rows = Array.isArray(parsed.actions) ? parsed.actions : [];
  if (rows.length === 0) blockers.push({ code: "missing_actions", detail: file });
  for (const row of rows) actions.push({ ...row, source_proof: file });
}

for (const actionId of requiredActions) {
  const found = actions.some((row) => row.surface === "mobile" && row.action_id === actionId && row.status === "pass");
  if (!found) blockers.push({ code: "missing_mobile_projection_action", detail: actionId });
}

const report = {
  truth: "mobile_projection_action_runtime_evidence_partial_not_live_hub_not_endbar",
  status: blockers.length === 0 ? "ready" : "blocked",
  actionCount: actions.length,
  actions,
  blockers,
  caveat:
    "Partial runtime evidence only: iOS ViewModel projection actions render refs/readiness through native surfaces. Later live Hub proof, simulator/device tap, END-BAR, release, and adoption proof remain required.",
};

fs.mkdirSync(path.dirname(actionRuntimeOut), { recursive: true });
fs.writeFileSync(actionRuntimeOut, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify({ status: report.status, actionCount: actions.length, out: actionRuntimeOut, blockers }, null, 2));
process.exit(blockers.length === 0 ? 0 : 2);
NODE

echo "Action runtime evidence: ${ACTION_RUNTIME_OUT}"
echo "Truth: partial mobile projection evidence only; live Hub proof and simulator/device tap remain required."
