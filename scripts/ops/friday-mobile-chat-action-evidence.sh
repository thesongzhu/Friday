#!/usr/bin/env bash
#
# Mobile Friday Chat action evidence wrapper.
#
# Truth boundary:
#   Runs iOS Swift product ViewModel tests and exports explicit action-runtime evidence for
#   Friday Chat send, approval-card render, approve relay, reject relay, and local context-card
#   affordances. This proves the product ViewModel delegates to governed write/sign/reject seams
#   and renders refs-only results. It does not start or mutate prod Hub, use the operator's true
#   signing key, prove live Hub audit receipts, drive a real simulator tap, claim END-BAR, or
#   prove adoption.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"

OUT_DIR="${FRIDAY_MOBILE_CHAT_ACTION_EVIDENCE_DIR:-${TMPDIR:-/tmp}/friday-mobile-chat-action-evidence}"
ACTION_RUNTIME_OUT="${FRIDAY_MOBILE_CHAT_ACTION_RUNTIME_OUT:-${OUT_DIR}/action-runtime-evidence.json}"

mkdir -p "${OUT_DIR}"
chmod 700 "${OUT_DIR}"

echo "Friday mobile Chat action evidence starting."
echo "truth_label=mobile_chat_action_swift_viewmodel_runtime_not_live_hub_not_endbar"
echo "out_dir=${OUT_DIR}"

log="${OUT_DIR}/swift-test-mobile-chat-action-evidence.log"
FRIDAY_MOBILE_CHAT_ACTION_EVIDENCE_DIR="${OUT_DIR}" \
  swift test \
    --package-path "${REPO_ROOT}/apps/friday-ios" \
    --filter "FridayChatViewModelTests/testMobileChatActionEvidenceCoversSendApprovalCardAndControls" \
    2>&1 | tee "${log}"

if ! grep -Eq "Executed [1-9][0-9]* test|Test run with [1-9][0-9]* test" "${log}"; then
  echo "FATAL: Swift test filter ran zero tests" >&2
  exit 2
fi

node - "${ACTION_RUNTIME_OUT}" <<'NODE'
const fs = require("node:fs");
const [actionRuntimeOut] = process.argv.slice(2);

if (!fs.existsSync(actionRuntimeOut)) {
  console.error(`FATAL: missing action runtime evidence: ${actionRuntimeOut}`);
  process.exit(2);
}

let parsed;
try {
  parsed = JSON.parse(fs.readFileSync(actionRuntimeOut, "utf8"));
} catch (error) {
  console.error(`FATAL: invalid action runtime evidence JSON: ${error.message}`);
  process.exit(2);
}

const blockers = [];
if (parsed.truth !== "mobile_chat_action_swift_viewmodel_runtime_not_live_hub_not_endbar") {
  blockers.push({ code: "unexpected_truth", detail: parsed.truth || "<missing>" });
}
if (parsed.status !== "ready") {
  blockers.push({ code: "evidence_not_ready", detail: parsed.status || "<missing>" });
}
const actions = Array.isArray(parsed.actions) ? parsed.actions : [];
for (const expected of [
  ["mobile", "fridayChat", "chat:typing", "ask_friday_chat"],
  ["mobile", "fridayChat", "chat:approveCard", "ask_friday_chat"],
  ["mobile", "fridayChat", "check", "security_approval_bound_principal_gate_cat10_netnew"],
  ["mobile", "fridayChat", "act", "security_approval_bound_principal_gate_cat10_netnew"],
  ["mobile", "fridayChat", "chat:handoffCard", "ask_friday_chat"],
  ["mobile", "fridayChat", "chat:memoryCard", "ask_friday_chat"],
]) {
  const found = actions.some((row) =>
    row.surface === expected[0]
    && row.screen === expected[1]
    && row.action_id === expected[2]
    && row.capability_id === expected[3]
    && row.status === "pass");
  if (!found) blockers.push({ code: "missing_action_row", detail: expected.join("/") });
}

console.log(JSON.stringify({
  status: blockers.length === 0 ? "ready" : "blocked",
  actionCount: actions.length,
  out: actionRuntimeOut,
  blockers,
}, null, 2));
process.exit(blockers.length === 0 ? 0 : 2);
NODE

echo "Action runtime evidence: ${ACTION_RUNTIME_OUT}"
echo "Truth: partial mobile Chat action evidence only; live Hub audit, simulator tap, and true operator signature proof remain required."
