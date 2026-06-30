#!/usr/bin/env bash
set -euo pipefail

# G1 first workflow receipt driver.
#
# Default mode uses a scratch hub DB and scratch workspace. To target an existing
# operator DB, set FRIDAY_G1_DB_PATH and FRIDAY_G1_PROD_ACK to the exact ack below.
# The workflow is read-only at the filesystem layer; its first step carries
# evidence_required=true so the Rust engine records a workflow_step_effect receipt
# without mutating the workspace.

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
RUST_DIR="${ROOT_DIR}/rust-core"
ACK_VALUE="operator-approves-g1-first-workflow-receipt"

TMP_ROOT="${FRIDAY_G1_TMP_ROOT:-$(mktemp -d "${TMPDIR:-/tmp}/friday-g1-first-receipt.XXXXXX")}"
WORKSPACE="${FRIDAY_G1_WORKSPACE:-${TMP_ROOT}/workspace}"
DB_PATH="${FRIDAY_G1_DB_PATH:-${TMP_ROOT}/rust-hub.sqlite}"
WORKFLOW_ID="${FRIDAY_G1_WORKFLOW_ID:-g1-first-workflow-receipt}"
RUN_ID="${FRIDAY_G1_RUN_ID:-g1-first-workflow-receipt-$(date -u +%Y%m%dT%H%M%SZ)}"
NOW_MS="${FRIDAY_G1_NOW_MS:-$(($(date +%s) * 1000))}"

if [[ -n "${FRIDAY_G1_DB_PATH:-}" && "${FRIDAY_G1_PROD_ACK:-}" != "${ACK_VALUE}" ]]; then
  echo "FATAL: refusing non-scratch DB without FRIDAY_G1_PROD_ACK=${ACK_VALUE}" >&2
  exit 2
fi

mkdir -p "${WORKSPACE}"
printf '%s\n' "Friday G1 first workflow receipt input" > "${WORKSPACE}/notes.txt"
mkdir -p "$(dirname "${DB_PATH}")"
if [[ ! -e "${DB_PATH}" ]]; then
  : > "${DB_PATH}"
fi

DEF_JSON="${TMP_ROOT}/g1-def.json"
cat > "${DEF_JSON}" <<'JSON'
{
  "schema_version": 1,
  "name": "G1 First Workflow Receipt",
  "steps": [
    {
      "id": "read",
      "action": "read_file",
      "params": [["path", "notes.txt"]],
      "evidence_required": true
    },
    {
      "id": "list",
      "action": "list_dir",
      "params": [["path", "."]]
    }
  ]
}
JSON

run_catalog() {
  (cd "${RUST_DIR}" && cargo run -q -p friday-hub --bin hub_workflow_catalog -- "$@")
}

run_workflow() {
  (cd "${RUST_DIR}" && cargo run -q -p friday-hub --bin hub_workflow_run -- "$@")
}

run_readback() {
  (cd "${RUST_DIR}" && cargo run -q -p friday-hub --bin hub_workflow_run_readback -- "$@")
}

CREATE_OUT="$(run_catalog \
  --db "${DB_PATH}" \
  --op create \
  --workflow-id "${WORKFLOW_ID}" \
  --slug "g1-first-receipt" \
  --name "G1 First Workflow Receipt" \
  --def-json "$(tr -d '\n' < "${DEF_JSON}")" \
  --now-ms "${NOW_MS}")"

PUBLISH_OUT="$(run_catalog \
  --db "${DB_PATH}" \
  --op publish \
  --workflow-id "${WORKFLOW_ID}" \
  --version 1)"

RUN_OUT="$(run_workflow \
  --db "${DB_PATH}" \
  --workspace "${WORKSPACE}" \
  --workflow-id "${WORKFLOW_ID}" \
  --run-id "${RUN_ID}" \
  --now-ms "${NOW_MS}")"

READBACK_OUT="$(run_readback \
  --db "${DB_PATH}" \
  --run-id "${RUN_ID}")"

node - "${DB_PATH}" "${CREATE_OUT}" "${PUBLISH_OUT}" "${RUN_OUT}" "${READBACK_OUT}" <<'NODE'
const [dbPath, createRaw, publishRaw, runRaw, readbackRaw] = process.argv.slice(2);
const create = JSON.parse(createRaw);
const publish = JSON.parse(publishRaw);
const run = JSON.parse(runRaw);
const readback = JSON.parse(readbackRaw);

function requireOk(label, payload) {
  if (payload.ok !== true) {
    throw new Error(`${label} failed: ${JSON.stringify(payload)}`);
  }
}
requireOk("create", create);
requireOk("publish", publish);
requireOk("run", run);
requireOk("readback", readback);

if (run.status !== "completed" || run.run_state !== "done") {
  throw new Error(`workflow run did not complete: ${JSON.stringify(run)}`);
}
if (run.side_effect_step_count < 1 || run.verified_count < 2) {
  throw new Error(`workflow receipt did not include expected verified/evidence rows: ${JSON.stringify(run)}`);
}
if (readback.side_effect_step_count < 1 || !Array.isArray(readback.steps) || readback.steps.length < 2) {
  throw new Error(`workflow readback missing side-effect/evidence projection: ${JSON.stringify(readback)}`);
}

const Database = require("better-sqlite3");
const db = new Database(dbPath, { readonly: true, fileMustExist: true });
try {
  const counts = db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM workflow_run) AS workflow_run,
      (SELECT COUNT(*) FROM workflow_step) AS workflow_step,
      (SELECT COUNT(*) FROM workflow_step_effect) AS workflow_step_effect
  `).get();
  if (counts.workflow_run < 1 || counts.workflow_step < 2 || counts.workflow_step_effect < 1) {
    throw new Error(`DB counts did not prove G1 receipt: ${JSON.stringify(counts)}`);
  }
  console.log(JSON.stringify({
    status: "g1_first_workflow_receipt_ready",
    truth_label: process.env.FRIDAY_G1_DB_PATH
      ? "operator_ack_real_db_workflow_receipt"
      : "scratch_db_workflow_receipt",
    dbPath,
    workflowId: run.workflow_id,
    runId: run.run_id,
    runStatus: run.status,
    runState: run.run_state,
    executedSteps: run.executed_steps,
    sideEffectStepCount: run.side_effect_step_count,
    verifiedCount: run.verified_count,
    workflowRunRows: counts.workflow_run,
    workflowStepRows: counts.workflow_step,
    workflowStepEffectRows: counts.workflow_step_effect,
    readbackStepCount: readback.step_count,
    caveat: "This proves the Rust workflow receipt path. It is not organic adoption, not scheduler/trigger deployment, and not release GO."
  }));
} finally {
  db.close();
}
NODE
