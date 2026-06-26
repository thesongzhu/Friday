#!/usr/bin/env bash
#
# Mobile Token Ledger action evidence wrapper.
#
# Truth boundary:
#   Runs the iOS Swift HomeProjection test that exposes a run ref for the Token Ledger surface.
#   This proves the product UI can route from the current projection to token-ledger readback
#   actions. It does not start or mutate prod Hub, query a live token ledger, drive a simulator
#   tap, claim END-BAR, or prove adoption.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"

OUT_DIR="${FRIDAY_MOBILE_TOKEN_LEDGER_ACTION_EVIDENCE_DIR:-${TMPDIR:-/tmp}/friday-mobile-token-ledger-action-evidence}"
ACTION_RUNTIME_OUT="${FRIDAY_MOBILE_TOKEN_LEDGER_ACTION_RUNTIME_OUT:-${OUT_DIR}/action-runtime-evidence.json}"

mkdir -p "${OUT_DIR}"
chmod 700 "${OUT_DIR}"

echo "Friday mobile Token Ledger action evidence starting."
echo "truth_label=mobile_token_ledger_swift_projection_runtime_not_live_hub_not_endbar"
echo "out_dir=${OUT_DIR}"

log="${OUT_DIR}/swift-test-mobile-token-ledger-action-evidence.log"
FRIDAY_MOBILE_TOKEN_LEDGER_ACTION_EVIDENCE_DIR="${OUT_DIR}" \
  swift test \
    --package-path "${REPO_ROOT}/apps/friday-ios" \
    --filter "HomeViewModelTests/testRefresh_liftsConsumerSurfaceProjectionRefs" \
    2>&1 | tee "${log}"

if ! grep -Eq "Executed [1-9][0-9]* test|Test run with [1-9][0-9]* test" "${log}"; then
  echo "FATAL: Swift test filter ran zero tests" >&2
  exit 2
fi

node - "${OUT_DIR}" "${ACTION_RUNTIME_OUT}" <<'NODE'
const fs = require("node:fs");
const path = require("node:path");

const [outDir, actionRuntimeOut] = process.argv.slice(2);
const source = path.join(outDir, "mobile-token-ledger-action-evidence.json");
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
    if (parsed.truth !== "mobile_token_ledger_swift_projection_runtime_not_live_hub_not_endbar") {
      blockers.push({ code: "unexpected_truth", detail: parsed.truth || "<missing>" });
    }
    if (parsed.status !== "ready") {
      blockers.push({ code: "evidence_not_ready", detail: parsed.status || "<missing>" });
    }
    actions = Array.isArray(parsed.actions) ? parsed.actions.map((row) => ({ ...row, source_proof: source })) : [];
    for (const actionId of ["mobile/tokenLedger/refresh", "mobile/tokenLedger/run-readback"]) {
      const found = actions.some((row) =>
        row.surface === "mobile" && row.screen === "tokenLedger" && row.action_id === actionId && row.status === "pass");
      if (!found) blockers.push({ code: "missing_token_ledger_action", detail: actionId });
    }
  }
}

const report = {
  truth: "mobile_token_ledger_action_runtime_evidence_partial_not_live_hub_not_endbar",
  status: blockers.length === 0 ? "ready" : "blocked",
  actionCount: actions.length,
  actions,
  blockers,
  caveat:
    "Partial runtime evidence only: Swift HomeProjection exposes Token Ledger run-ref routing. Later live Hub token-ledger readback and real simulator/device tap must land before END-BAR coverage.",
};

fs.mkdirSync(path.dirname(actionRuntimeOut), { recursive: true });
fs.writeFileSync(actionRuntimeOut, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify({ status: report.status, actionCount: actions.length, out: actionRuntimeOut, blockers }, null, 2));
process.exit(blockers.length === 0 ? 0 : 2);
NODE

echo "Action runtime evidence: ${ACTION_RUNTIME_OUT}"
echo "Truth: partial mobile Token Ledger action evidence only; live Hub readback and simulator/device tap remain required."
