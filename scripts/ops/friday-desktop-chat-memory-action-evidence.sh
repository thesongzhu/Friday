#!/usr/bin/env bash
#
# Desktop Chat/Memory action evidence wrapper.
#
# Truth boundary:
#   Runs macOS Swift product ViewModel tests and exports explicit action-runtime evidence for
#   desktop Chat approval approve/reject plus desktop Memory confirm/reject actions. This proves
#   the product ViewModel delegates to its signer/write seams and renders refs-only results. It
#   does not start or mutate prod Hub, use the operator's true signing key, prove live Hub audit
#   receipts, drive a real GUI tap, claim END-BAR, or prove adoption.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"

OUT_DIR="${FRIDAY_DESKTOP_CHAT_MEMORY_ACTION_EVIDENCE_DIR:-${TMPDIR:-/tmp}/friday-desktop-chat-memory-action-evidence}"
ACTION_RUNTIME_OUT="${FRIDAY_DESKTOP_CHAT_MEMORY_ACTION_RUNTIME_OUT:-${OUT_DIR}/action-runtime-evidence.json}"

mkdir -p "${OUT_DIR}"
chmod 700 "${OUT_DIR}"

echo "Friday desktop Chat/Memory action evidence starting."
echo "truth_label=desktop_chat_memory_action_swift_viewmodel_runtime_not_live_hub_not_endbar"
echo "out_dir=${OUT_DIR}"

run_swift_test() {
  local filter="$1"
  local log="${OUT_DIR}/swift-test-${filter}.log"
  FRIDAY_DESKTOP_CHAT_MEMORY_ACTION_EVIDENCE_DIR="${OUT_DIR}" \
    swift test \
      --package-path "${REPO_ROOT}/apps/macos/FridayHubConsole" \
      --filter "${filter}" 2>&1 | tee "${log}"
  if ! grep -Eq "Test run with [1-9][0-9]* test" "${log}"; then
    echo "FATAL: Swift test filter ran zero tests: ${filter}" >&2
    exit 2
  fi
}

run_swift_test approveNeedsMeItemSignsRefsAndRelaysOpaqueBlob
run_swift_test rejectNeedsMeApprovalUsesRunControlWithoutSigner
run_swift_test decideMemoryConfirmRendersConfirmedRecallable
run_swift_test decideMemoryRejectRendersRejectedNotRecallable
run_swift_test refreshLoadsRepresentativeSnapshot
run_swift_test loadDetailCallsSessionAndRunFileReadArms
run_swift_test retryWorkItemSendsLifecycleWriteAndRefreshes
run_swift_test cancelWorkItemSendsLifecycleWriteAndRefreshes

node - "${OUT_DIR}" "${ACTION_RUNTIME_OUT}" <<'NODE'
const fs = require("node:fs");
const path = require("node:path");

const [outDir, actionRuntimeOut] = process.argv.slice(2);
const files = [
  path.join(outDir, "desktop-approval-approve-action-evidence.json"),
  path.join(outDir, "desktop-approval-reject-action-evidence.json"),
  path.join(outDir, "desktop-memory-confirm-action-evidence.json"),
  path.join(outDir, "desktop-memory-reject-action-evidence.json"),
  path.join(outDir, "desktop-operations-refresh-action-evidence.json"),
  path.join(outDir, "desktop-channels-receipts-action-evidence.json"),
  path.join(outDir, "desktop-channels-surface-events-action-evidence.json"),
  path.join(outDir, "desktop-session-list-action-evidence.json"),
  path.join(outDir, "desktop-session-open-action-evidence.json"),
  path.join(outDir, "desktop-session-link-action-evidence.json"),
  path.join(outDir, "desktop-workflow-retry-action-evidence.json"),
  path.join(outDir, "desktop-recovery-retry-action-evidence.json"),
  path.join(outDir, "desktop-workflow-cancel-action-evidence.json"),
  path.join(outDir, "desktop-recovery-cancel-action-evidence.json"),
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
  if (parsed.truth !== "desktop_chat_memory_action_swift_viewmodel_runtime_not_live_hub_not_endbar") {
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

for (const actionId of [
  "desktop/operations/refresh",
  "desktop/session/list",
  "desktop/session/open",
  "desktop/session/link",
  "desktop/workflow/retry",
  "desktop/workflow/cancel",
  "desktop/channels/receipts",
  "desktop/channels/surface-events",
  "desktop/recovery/retry",
  "desktop/recovery/cancel",
]) {
  const found = actions.some((row) => row.surface === "desktop" && row.action_id === actionId && row.status === "pass");
  if (!found) blockers.push({ code: "missing_desktop_product_action", detail: actionId });
}

const report = {
  truth: "desktop_chat_memory_action_runtime_evidence_partial_not_live_hub_not_endbar",
  status: blockers.length === 0 ? "ready" : "blocked",
  actionCount: actions.length,
  actions,
  blockers,
  caveat:
    "Partial runtime evidence only: macOS product ViewModel actions delegate to signer/write seams and render refs-only results. Later live Hub audit, true operator signature, GUI tap, and adoption proof must land before END-BAR coverage.",
};

fs.mkdirSync(path.dirname(actionRuntimeOut), { recursive: true });
fs.writeFileSync(actionRuntimeOut, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify({ status: report.status, actionCount: actions.length, out: actionRuntimeOut }, null, 2));
process.exit(blockers.length === 0 ? 0 : 2);
NODE

echo "Action runtime evidence: ${ACTION_RUNTIME_OUT}"
echo "Truth: partial desktop Chat/Memory action evidence only; live Hub audit, GUI tap, and true operator signature proof remain required."
