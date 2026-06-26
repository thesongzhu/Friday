#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
OUT_DIR="${FRIDAY_MOBILE_PROVIDER_AUTH_ACTION_EVIDENCE_DIR:-${TMPDIR:-/tmp}/friday-mobile-provider-auth-action-evidence}"
ACTION_RUNTIME_OUT="${FRIDAY_MOBILE_PROVIDER_AUTH_ACTION_RUNTIME_OUT:-${OUT_DIR}/action-runtime-evidence.json}"
mkdir -p "${OUT_DIR}"
chmod 700 "${OUT_DIR}"

echo "Friday mobile Provider Auth action evidence starting."
echo "truth_label=mobile_provider_auth_swift_viewmodel_runtime_not_live_hub_not_endbar"
echo "out_dir=${OUT_DIR}"

log="${OUT_DIR}/swift-test-mobile-provider-auth-action-evidence.log"
FRIDAY_MOBILE_PROVIDER_AUTH_ACTION_EVIDENCE_DIR="${OUT_DIR}" \
  swift test --package-path "${REPO_ROOT}/apps/friday-ios" \
    --filter "HomeViewModelTests/testLoadDetail_callsProviderDoctorReadArm" 2>&1 | tee "${log}"
if ! grep -Eq "Executed [1-9][0-9]* test|Test run with [1-9][0-9]* test" "${log}"; then
  echo "FATAL: Swift test filter ran zero tests" >&2
  exit 2
fi

node - "${OUT_DIR}" "${ACTION_RUNTIME_OUT}" <<'NODE'
const fs = require("node:fs");
const path = require("node:path");
const [outDir, actionRuntimeOut] = process.argv.slice(2);
const source = path.join(outDir, "mobile-provider-auth-action-evidence.json");
const blockers = [];
let actions = [];
if (!fs.existsSync(source)) blockers.push({ code: "missing_swift_evidence", detail: source });
else {
  const parsed = JSON.parse(fs.readFileSync(source, "utf8"));
  if (parsed.truth !== "mobile_provider_auth_swift_viewmodel_runtime_not_live_hub_not_endbar") blockers.push({ code: "unexpected_truth", detail: parsed.truth || "<missing>" });
  if (parsed.status !== "ready") blockers.push({ code: "evidence_not_ready", detail: parsed.status || "<missing>" });
  actions = Array.isArray(parsed.actions) ? parsed.actions.map((row) => ({ ...row, source_proof: source })) : [];
  for (const actionId of ["mobile/providerAuth/check", "mobile/providerAuth/provider-workspace"]) {
    if (!actions.some((row) => row.surface === "mobile" && row.action_id === actionId && row.status === "pass")) {
      blockers.push({ code: "missing_provider_auth_action", detail: actionId });
    }
  }
}
const report = {
  truth: "mobile_provider_auth_action_runtime_evidence_partial_not_live_hub_not_endbar",
  status: blockers.length === 0 ? "ready" : "blocked",
  actionCount: actions.length,
  actions,
  blockers,
  caveat: "Partial runtime evidence only: iOS Provider Workspace read-arm evidence. Not provider credential custody, not live provider auth ceremony, not simulator/device tap, not END-BAR.",
};
fs.mkdirSync(path.dirname(actionRuntimeOut), { recursive: true });
fs.writeFileSync(actionRuntimeOut, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify({ status: report.status, actionCount: actions.length, out: actionRuntimeOut, blockers }, null, 2));
process.exit(blockers.length === 0 ? 0 : 2);
NODE
