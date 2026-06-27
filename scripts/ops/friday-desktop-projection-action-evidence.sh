#!/usr/bin/env bash
#
# Desktop projection product action evidence wrapper.
#
# Truth boundary:
#   Runs macOS Swift ViewModel tests and exports action-runtime evidence for selected projection
#   product destinations that already have native surfaces. This is partial runtime evidence only:
#   it does not start or mutate prod Hub, drive a real GUI tap, claim END-BAR, or prove adoption.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"

OUT_DIR="${FRIDAY_DESKTOP_PROJECTION_ACTION_EVIDENCE_DIR:-${TMPDIR:-/tmp}/friday-desktop-projection-action-evidence}"
ACTION_RUNTIME_OUT="${FRIDAY_DESKTOP_PROJECTION_ACTION_RUNTIME_OUT:-${OUT_DIR}/action-runtime-evidence.json}"

mkdir -p "${OUT_DIR}"
chmod 700 "${OUT_DIR}"

echo "Friday desktop projection action evidence starting."
echo "truth_label=desktop_projection_swift_viewmodel_runtime_not_live_hub_not_endbar"
echo "out_dir=${OUT_DIR}"

run_swift_test() {
  local filter="$1"
  local log="${OUT_DIR}/swift-test-${filter}.log"
  FRIDAY_DESKTOP_PROJECTION_ACTION_EVIDENCE_DIR="${OUT_DIR}" \
    swift test \
      --package-path "${REPO_ROOT}/apps/macos/FridayHubConsole" \
      --filter "${filter}" 2>&1 | tee "${log}"
  if ! grep -Eq "Test run with [1-9][0-9]* test" "${log}"; then
    echo "FATAL: Swift test filter ran zero tests: ${filter}" >&2
    exit 2
  fi
}

run_swift_test refreshLoadsRepresentativeSnapshot
run_swift_test loadDetailCallsProviderDoctorReadArm
run_swift_test loadDetailCallsRunAndNeedsMeReadArms
run_swift_test providerWorkspaceListSessionsSendsGuardedRequestAndRefreshes

node - "${OUT_DIR}" "${ACTION_RUNTIME_OUT}" <<'NODE'
const fs = require("node:fs");
const path = require("node:path");

const [outDir, actionRuntimeOut] = process.argv.slice(2);
const files = [
  path.join(outDir, "desktop-diagnostics-proof-refs-action-evidence.json"),
  path.join(outDir, "desktop-evidence-index-read-action-evidence.json"),
  path.join(outDir, "desktop-settings-hub-posture-action-evidence.json"),
  path.join(outDir, "desktop-skills-capability-matrix-action-evidence.json"),
  path.join(outDir, "desktop-media-evidence-refs-action-evidence.json"),
  path.join(outDir, "desktop-provider-admin-check-action-evidence.json"),
  path.join(outDir, "desktop-provider-workspace-list-sessions-action-evidence.json"),
  path.join(outDir, "desktop-parity-route-readiness-action-evidence.json"),
  path.join(outDir, "desktop-token-ledger-run-readback-action-evidence.json"),
];
const requiredActions = [
  "desktop/providerAdmin/check",
  "desktop/providerAdmin/provider-workspace-list-sessions",
  "desktop/parity/route-readiness",
  "desktop/diagnostics/proof-refs",
  "desktop/tokenLedger/run-readback",
  "desktop/settings/hub-posture",
  "desktop/evidence/index-read",
  "desktop/skills/capability-matrix",
  "desktop/media/evidence-refs",
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
  const found = actions.some((row) => row.surface === "desktop" && row.action_id === actionId && row.status === "pass");
  if (!found) blockers.push({ code: "missing_desktop_projection_action", detail: actionId });
}

const report = {
  truth: "desktop_projection_action_runtime_evidence_partial_not_live_hub_not_endbar",
  status: blockers.length === 0 ? "ready" : "blocked",
  actionCount: actions.length,
  actions,
  blockers,
  caveat:
    "Partial runtime evidence only: macOS ViewModel projection actions render refs/readiness through native surfaces. Later live Hub proof, GUI tap, END-BAR, release, and adoption proof remain required.",
};

fs.mkdirSync(path.dirname(actionRuntimeOut), { recursive: true });
fs.writeFileSync(actionRuntimeOut, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify({ status: report.status, actionCount: actions.length, out: actionRuntimeOut, blockers }, null, 2));
process.exit(blockers.length === 0 ? 0 : 2);
NODE

echo "Action runtime evidence: ${ACTION_RUNTIME_OUT}"
echo "Truth: partial desktop projection evidence only; live Hub proof and GUI tap remain required."
