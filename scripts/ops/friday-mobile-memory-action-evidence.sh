#!/usr/bin/env bash
#
# Mobile Home/Memory action evidence wrapper.
#
# Truth boundary:
#   Runs the iOS Swift product Home ViewModel tests and exports explicit action-runtime evidence
#   for Home refresh plus Memory screen confirm/reject actions. This proves the product ViewModel
#   paths delegate to their read/write seams and render refs-only results. It does not start or
#   mutate prod Hub, seed live memory candidates, prove Hub audit receipts, run a simulator tap,
#   claim END-BAR, or prove adoption.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"

OUT_DIR="${FRIDAY_MOBILE_MEMORY_ACTION_EVIDENCE_DIR:-${TMPDIR:-/tmp}/friday-mobile-memory-action-evidence}"
ACTION_RUNTIME_OUT="${FRIDAY_MOBILE_MEMORY_ACTION_RUNTIME_OUT:-${OUT_DIR}/action-runtime-evidence.json}"

mkdir -p "${OUT_DIR}"
chmod 700 "${OUT_DIR}"

echo "Friday mobile memory action evidence starting."
echo "truth_label=mobile_home_memory_action_swift_viewmodel_runtime_not_live_hub_not_endbar"
echo "out_dir=${OUT_DIR}"

FRIDAY_MOBILE_MEMORY_ACTION_EVIDENCE_DIR="${OUT_DIR}" \
  swift test \
    --package-path "${REPO_ROOT}/apps/friday-ios" \
    --filter HomeViewModelTests/testRefresh_loadsRefsOnlyProjection

FRIDAY_MOBILE_MEMORY_ACTION_EVIDENCE_DIR="${OUT_DIR}" \
  swift test \
    --package-path "${REPO_ROOT}/apps/friday-ios" \
    --filter HomeViewModelTests/testDecideMemoryConfirmRendersConfirmedAndRefreshes

FRIDAY_MOBILE_MEMORY_ACTION_EVIDENCE_DIR="${OUT_DIR}" \
  swift test \
    --package-path "${REPO_ROOT}/apps/friday-ios" \
    --filter HomeViewModelTests/testDecideMemoryRejectRendersRejectedAndRefreshes

node - "${OUT_DIR}" "${ACTION_RUNTIME_OUT}" <<'NODE'
const fs = require("node:fs");
const path = require("node:path");

const [outDir, actionRuntimeOut] = process.argv.slice(2);
const files = [
  path.join(outDir, "mobile-home-refresh-action-evidence.json"),
  path.join(outDir, "mobile-memory-confirm-action-evidence.json"),
  path.join(outDir, "mobile-memory-reject-action-evidence.json"),
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
  const allowedTruth = new Set([
    "mobile_home_refresh_swift_viewmodel_runtime_not_live_hub_not_endbar",
    "mobile_memory_action_swift_viewmodel_runtime_not_live_hub_not_endbar",
  ]);
  if (!allowedTruth.has(parsed.truth)) {
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
  truth: "mobile_home_memory_action_runtime_evidence_partial_not_live_hub_not_endbar",
  status: blockers.length === 0 ? "ready" : "blocked",
  actionCount: actions.length,
  actions,
  blockers,
  caveat:
    "Partial runtime evidence only: Swift product ViewModel Home refresh re-reads refs and Memory confirm/reject delegates to the write seam and renders refs-only results. Later live Hub read/write and memory-spine audit/recall proof must land before this counts as full END-BAR coverage.",
};

fs.mkdirSync(path.dirname(actionRuntimeOut), { recursive: true });
fs.writeFileSync(actionRuntimeOut, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify({ status: report.status, actionCount: actions.length, out: actionRuntimeOut }, null, 2));
process.exit(blockers.length === 0 ? 0 : 2);
NODE

echo "Action runtime evidence: ${ACTION_RUNTIME_OUT}"
echo "Truth: partial mobile Home/Memory action evidence only; live Hub read/write plus memory-spine audit/recall proof is still required."
