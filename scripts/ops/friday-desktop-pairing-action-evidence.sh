#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
OUT_DIR="${FRIDAY_DESKTOP_PAIRING_ACTION_EVIDENCE_DIR:-${TMPDIR:-/tmp}/friday-desktop-pairing-action-evidence}"
ACTION_RUNTIME_OUT="${FRIDAY_DESKTOP_PAIRING_ACTION_RUNTIME_OUT:-${OUT_DIR}/action-runtime-evidence.json}"
mkdir -p "${OUT_DIR}"
chmod 700 "${OUT_DIR}"

echo "Friday desktop Pairing action evidence starting."
echo "truth_label=desktop_pairing_manifest_swift_viewmodel_runtime_not_live_hub_not_endbar"
echo "out_dir=${OUT_DIR}"

log="${OUT_DIR}/swift-test-desktop-pairing-action-evidence.log"
FRIDAY_DESKTOP_PAIRING_ACTION_EVIDENCE_DIR="${OUT_DIR}" \
  swift test --package-path "${REPO_ROOT}/apps/macos/FridayHubConsole" \
    --filter "pairingProvisioningStartsLauncherAndLoadsQrManifestWithoutDisplayingSecret" 2>&1 | tee "${log}"
if ! grep -Eq "Test run with [1-9][0-9]* test" "${log}"; then
  echo "FATAL: Swift test filter ran zero tests" >&2
  exit 2
fi

node - "${OUT_DIR}" "${ACTION_RUNTIME_OUT}" <<'NODE'
const fs = require("node:fs");
const path = require("node:path");
const [outDir, actionRuntimeOut] = process.argv.slice(2);
const source = path.join(outDir, "desktop-pairing-action-evidence.json");
const blockers = [];
let actions = [];
if (!fs.existsSync(source)) blockers.push({ code: "missing_swift_evidence", detail: source });
else {
  const parsed = JSON.parse(fs.readFileSync(source, "utf8"));
  if (parsed.truth !== "desktop_pairing_manifest_swift_viewmodel_runtime_not_live_hub_not_endbar") blockers.push({ code: "unexpected_truth", detail: parsed.truth || "<missing>" });
  if (parsed.status !== "ready") blockers.push({ code: "evidence_not_ready", detail: parsed.status || "<missing>" });
  actions = Array.isArray(parsed.actions) ? parsed.actions.map((row) => ({ ...row, source_proof: source })) : [];
  if (!actions.some((row) => row.surface === "desktop" && row.action_id === "desktop/pairing/manifest" && row.status === "pass")) {
    blockers.push({ code: "missing_desktop_pairing_manifest_action", detail: source });
  }
}
const report = {
  truth: "desktop_pairing_action_runtime_evidence_partial_not_live_hub_not_endbar",
  status: blockers.length === 0 ? "ready" : "blocked",
  actionCount: actions.length,
  actions,
  blockers,
  caveat: "Partial runtime evidence only: macOS PairingProvisioning ViewModel manifest readiness. Not live PairAck, not trust grant minting, not GUI tap, not END-BAR.",
};
fs.mkdirSync(path.dirname(actionRuntimeOut), { recursive: true });
fs.writeFileSync(actionRuntimeOut, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify({ status: report.status, actionCount: actions.length, out: actionRuntimeOut, blockers }, null, 2));
process.exit(blockers.length === 0 ? 0 : 2);
NODE
