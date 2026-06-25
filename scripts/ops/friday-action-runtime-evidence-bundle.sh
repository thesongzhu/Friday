#!/usr/bin/env bash
#
# Friday native action-runtime evidence bundle.
#
# Truth boundary:
#   Runs existing Swift/ViewModel action evidence wrappers and aggregates their
#   action-runtime-evidence.json files through the operator-confirmed design action checker. This is
#   partial runtime evidence only. It does not start or mutate prod Hub, drive a real GUI/simulator
#   tap, read signing keys, sign approvals, claim END-BAR, or prove adoption.
set -euo pipefail

usage() {
  cat >&2 <<'EOF'
usage:
  scripts/ops/friday-action-runtime-evidence-bundle.sh [--out-dir /abs/out]
    [--extra-action-runtime-evidence /abs/action-runtime-evidence.json ...]
    [--require-complete]

Runs non-live action evidence wrappers, then writes:
  /abs/out/runtime-evidence-paths.txt
  /abs/out/design-action-runtime-gap.json
  /abs/out/action-runtime-evidence-bundle-index.json

Use --extra-action-runtime-evidence for explicitly supplied live proofs such as
mobile approval reject/approve. The script never signs or fabricates those rows.
EOF
}

die() {
  echo "FATAL: $*" >&2
  exit 2
}

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"

OUT_DIR="${FRIDAY_ACTION_RUNTIME_EVIDENCE_BUNDLE_OUT:-${TMPDIR:-/tmp}/friday-action-runtime-evidence-bundle}"
REQUIRE_COMPLETE=0
EXTRA_ACTION_EVIDENCE=()

while [ "$#" -gt 0 ]; do
  case "$1" in
    --out-dir)
      [ "$#" -ge 2 ] || die "--out-dir requires a value"
      OUT_DIR="$2"
      shift 2
      ;;
    --out-dir=*)
      OUT_DIR="${1#--out-dir=}"
      shift
      ;;
    --extra-action-runtime-evidence)
      [ "$#" -ge 2 ] || die "--extra-action-runtime-evidence requires a value"
      EXTRA_ACTION_EVIDENCE+=("$2")
      shift 2
      ;;
    --extra-action-runtime-evidence=*)
      EXTRA_ACTION_EVIDENCE+=("${1#--extra-action-runtime-evidence=}")
      shift
      ;;
    --require-complete)
      REQUIRE_COMPLETE=1
      shift
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      die "unknown argument: $1"
      ;;
  esac
done

case "${OUT_DIR}" in
  /*) ;;
  *) die "--out-dir must be absolute: ${OUT_DIR}" ;;
esac

set +u
for extra in "${EXTRA_ACTION_EVIDENCE[@]}"; do
  case "${extra}" in
    /*) ;;
    *) die "--extra-action-runtime-evidence must be absolute: ${extra}" ;;
  esac
  [ -s "${extra}" ] || die "--extra-action-runtime-evidence must exist and be non-empty: ${extra}"
done
set -u

mkdir -p "${OUT_DIR}"
chmod 700 "${OUT_DIR}"

echo "Friday action-runtime evidence bundle starting."
echo "truth_label=action_runtime_evidence_bundle_partial_not_live_hub_not_endbar"
echo "out_dir=${OUT_DIR}"

RUNTIME_EVIDENCE_PATHS=()

run_wrapper() {
  local label="$1"
  local script="$2"
  local out_env="$3"
  local runtime_env="$4"
  local subdir="$5"
  local wrapper_out="${OUT_DIR}/${subdir}"
  local runtime_out="${wrapper_out}/action-runtime-evidence.json"

  mkdir -p "${wrapper_out}"
  echo
  echo "[action-runtime-bundle] running ${label}"
  env "${out_env}=${wrapper_out}" "${runtime_env}=${runtime_out}" bash "${REPO_ROOT}/${script}"
  [ -s "${runtime_out}" ] || die "${label} did not write ${runtime_out}"
  RUNTIME_EVIDENCE_PATHS+=("${runtime_out}")
}

run_wrapper \
  "mobile chat" \
  "scripts/ops/friday-mobile-chat-action-evidence.sh" \
  "FRIDAY_MOBILE_CHAT_ACTION_EVIDENCE_DIR" \
  "FRIDAY_MOBILE_CHAT_ACTION_RUNTIME_OUT" \
  "mobile-chat"

run_wrapper \
  "mobile memory/home" \
  "scripts/ops/friday-mobile-memory-action-evidence.sh" \
  "FRIDAY_MOBILE_MEMORY_ACTION_EVIDENCE_DIR" \
  "FRIDAY_MOBILE_MEMORY_ACTION_RUNTIME_OUT" \
  "mobile-memory"

run_wrapper \
  "mobile new session" \
  "scripts/ops/friday-mobile-new-session-action-evidence.sh" \
  "FRIDAY_MOBILE_NEW_SESSION_ACTION_EVIDENCE_DIR" \
  "FRIDAY_MOBILE_NEW_SESSION_ACTION_RUNTIME_OUT" \
  "mobile-new-session"

run_wrapper \
  "mobile passport transfer" \
  "scripts/ops/friday-mobile-passport-transfer-action-evidence.sh" \
  "FRIDAY_MOBILE_PASSPORT_TRANSFER_ACTION_EVIDENCE_DIR" \
  "FRIDAY_MOBILE_PASSPORT_TRANSFER_ACTION_RUNTIME_OUT" \
  "mobile-passport-transfer"

run_wrapper \
  "mobile firstLaunch pairing" \
  "scripts/ops/friday-mobile-firstlaunch-action-evidence.sh" \
  "FRIDAY_MOBILE_FIRSTLAUNCH_ACTION_EVIDENCE_DIR" \
  "FRIDAY_MOBILE_FIRSTLAUNCH_ACTION_RUNTIME_OUT" \
  "mobile-firstlaunch"

run_wrapper \
  "mobile session sidecar" \
  "scripts/ops/friday-mobile-session-sidecar-action-evidence.sh" \
  "FRIDAY_MOBILE_SESSION_SIDECAR_ACTION_EVIDENCE_DIR" \
  "FRIDAY_MOBILE_SESSION_SIDECAR_ACTION_RUNTIME_OUT" \
  "mobile-session-sidecar"

run_wrapper \
  "mobile workflow" \
  "scripts/ops/friday-mobile-workflow-action-evidence.sh" \
  "FRIDAY_MOBILE_WORKFLOW_ACTION_EVIDENCE_DIR" \
  "FRIDAY_MOBILE_WORKFLOW_ACTION_RUNTIME_OUT" \
  "mobile-workflow"

run_wrapper \
  "mobile share intake" \
  "scripts/ops/friday-mobile-share-intake-action-evidence.sh" \
  "FRIDAY_MOBILE_SHARE_INTAKE_ACTION_EVIDENCE_DIR" \
  "FRIDAY_MOBILE_SHARE_INTAKE_ACTION_RUNTIME_OUT" \
  "mobile-share-intake"

run_wrapper \
  "desktop chat/memory" \
  "scripts/ops/friday-desktop-chat-memory-action-evidence.sh" \
  "FRIDAY_DESKTOP_CHAT_MEMORY_ACTION_EVIDENCE_DIR" \
  "FRIDAY_DESKTOP_CHAT_MEMORY_ACTION_RUNTIME_OUT" \
  "desktop-chat-memory"

set +u
for extra in "${EXTRA_ACTION_EVIDENCE[@]}"; do
  RUNTIME_EVIDENCE_PATHS+=("${extra}")
done
set -u

paths_file="${OUT_DIR}/runtime-evidence-paths.txt"
printf '%s\n' "${RUNTIME_EVIDENCE_PATHS[@]}" >"${paths_file}"

design_report="${OUT_DIR}/design-action-runtime-gap.json"
checker_args=(
  "${REPO_ROOT}/scripts/ops/check-friday-design-action-runtime-evidence.mjs"
  "--out=${design_report}"
)
for evidence in "${RUNTIME_EVIDENCE_PATHS[@]}"; do
  checker_args+=("--runtime-evidence=${evidence}")
done
if [ "${REQUIRE_COMPLETE}" = "1" ]; then
  checker_args+=("--require-complete")
fi

set +e
node "${checker_args[@]}" >"${OUT_DIR}/design-action-runtime-gap.stdout.json"
checker_exit=$?
set -e
if [ "${checker_exit}" -ne 0 ] && [ "${REQUIRE_COMPLETE}" != "1" ]; then
  die "design action runtime checker failed with blockers; see ${design_report}"
fi

node - "${OUT_DIR}" "${design_report}" "${paths_file}" "${checker_exit}" <<'NODE'
const fs = require("node:fs");
const path = require("node:path");

const [outDir, designReportPath, pathsFile, checkerExitRaw] = process.argv.slice(2);
const report = JSON.parse(fs.readFileSync(designReportPath, "utf8"));
const paths = fs.readFileSync(pathsFile, "utf8").split(/\r?\n/).filter(Boolean);
const checkerExit = Number(checkerExitRaw);
const index = {
  truth: "action_runtime_evidence_bundle_partial_not_live_hub_not_endbar",
  status: checkerExit === 0 ? "ready" : "blocked",
  generated_at_utc: new Date().toISOString(),
  evidence_count: paths.length,
  runtime_evidence_paths: paths,
  design_action_runtime_report: designReportPath,
  checker_status: report.status,
  counts: report.counts,
  capture_plan: report.capturePlan,
  blockers: report.blockers || [],
  caveat:
    "Partial runtime evidence bundle only. It does not prove real GUI/simulator taps, live Hub audit for every action, operator-signed approve, END-BAR, release, or adoption.",
};
const out = path.join(outDir, "action-runtime-evidence-bundle-index.json");
fs.writeFileSync(out, `${JSON.stringify(index, null, 2)}\n`);
console.log(JSON.stringify({
  status: index.status,
  checker_status: index.checker_status,
  counts: index.counts,
  capture_plan: index.capture_plan,
  index: out,
}, null, 2));
NODE

if [ "${checker_exit}" -ne 0 ]; then
  exit "${checker_exit}"
fi

echo "Action-runtime evidence bundle: ${OUT_DIR}/action-runtime-evidence-bundle-index.json"
echo "Truth: partial bundle only; remaining gaps still require real runtime/live evidence."
