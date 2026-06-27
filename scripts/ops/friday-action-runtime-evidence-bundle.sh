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
    [--extra-action-runtime-evidence-dir /abs/evidence-dir ...]
    [--require-complete]

Runs non-live action evidence wrappers, then writes:
  /abs/out/runtime-evidence-paths.txt
  /abs/out/design-action-runtime-gap.json
  /abs/out/action-runtime-evidence-bundle-index.json

Use --extra-action-runtime-evidence for explicitly supplied live proofs such as
mobile approval reject/approve. Use --extra-action-runtime-evidence-dir for an
artifact directory containing action-runtime-evidence.json, runtime-evidence-paths.txt,
or an action-runtime-evidence-bundle-index.json. The script never signs or fabricates
those rows.
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
EXTRA_ACTION_EVIDENCE_DIRS=()
if [ -n "${FRIDAY_EXTRA_ACTION_RUNTIME_EVIDENCE_DIRS:-}" ]; then
  IFS=':' read -r -a EXTRA_ACTION_EVIDENCE_DIRS <<<"${FRIDAY_EXTRA_ACTION_RUNTIME_EVIDENCE_DIRS}"
fi

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
    --extra-action-runtime-evidence-dir)
      [ "$#" -ge 2 ] || die "--extra-action-runtime-evidence-dir requires a value"
      EXTRA_ACTION_EVIDENCE_DIRS+=("$2")
      shift 2
      ;;
    --extra-action-runtime-evidence-dir=*)
      EXTRA_ACTION_EVIDENCE_DIRS+=("${1#--extra-action-runtime-evidence-dir=}")
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
for extra_dir in "${EXTRA_ACTION_EVIDENCE_DIRS[@]}"; do
  [ -n "${extra_dir}" ] || continue
  case "${extra_dir}" in
    /*) ;;
    *) die "--extra-action-runtime-evidence-dir must be absolute: ${extra_dir}" ;;
  esac
  [ -d "${extra_dir}" ] || die "--extra-action-runtime-evidence-dir must exist: ${extra_dir}"
done
set -u

mkdir -p "${OUT_DIR}"
chmod 700 "${OUT_DIR}"

echo "Friday action-runtime evidence bundle starting."
echo "truth_label=action_runtime_evidence_bundle_partial_not_live_hub_not_endbar"
echo "out_dir=${OUT_DIR}"

RUNTIME_EVIDENCE_PATHS=()
DISCOVERED_EXTRA_ACTION_EVIDENCE=()

if [ "${#EXTRA_ACTION_EVIDENCE_DIRS[@]}" -gt 0 ]; then
  while IFS= read -r discovered_extra; do
    [ -n "${discovered_extra}" ] && DISCOVERED_EXTRA_ACTION_EVIDENCE+=("${discovered_extra}")
  done < <(node - "${EXTRA_ACTION_EVIDENCE_DIRS[@]}" <<'NODE'
const fs = require("node:fs");
const path = require("node:path");

function existingFile(candidate) {
  try {
    const stats = fs.statSync(candidate);
    return stats.isFile() && stats.size > 0;
  } catch {
    return false;
  }
}

function readJson(candidate) {
  if (!existingFile(candidate)) return null;
  try {
    return JSON.parse(fs.readFileSync(candidate, "utf8"));
  } catch {
    return null;
  }
}

function pathsFromIndex(indexPath) {
  const value = readJson(indexPath);
  if (!value || typeof value !== "object") return [];
  const indexDir = path.dirname(indexPath);
  const arrays = [
    value.runtime_evidence_paths,
    value.runtimeEvidencePaths,
    value.evidence_paths,
  ].filter(Array.isArray).flat();
  const singles = [
    value.action_runtime_evidence,
    value.actionRuntimeEvidence,
    value.combined_action_runtime_evidence,
    value.combinedActionRuntimeEvidence,
  ].filter((candidate) => typeof candidate === "string" && candidate.trim());
  return [...arrays, ...singles]
    .filter((candidate) => typeof candidate === "string" && candidate.trim())
    .map((candidate) => path.isAbsolute(candidate) ? candidate : path.resolve(indexDir, candidate));
}

function pathsFromList(listPath) {
  if (!existingFile(listPath)) return [];
  const listDir = path.dirname(listPath);
  return fs.readFileSync(listPath, "utf8")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"))
    .map((candidate) => path.isAbsolute(candidate) ? candidate : path.resolve(listDir, candidate));
}

const found = [];
for (const rawDir of process.argv.slice(2)) {
  if (!rawDir) continue;
  const dir = path.resolve(rawDir);
  found.push(
    path.join(dir, "action-runtime-evidence.json"),
    path.join(dir, "design-action-runtime-evidence.json"),
    ...pathsFromList(path.join(dir, "runtime-evidence-paths.txt")),
    ...pathsFromIndex(path.join(dir, "action-runtime-evidence-bundle-index.json")),
    ...pathsFromIndex(path.join(dir, "live-write-read-bundle-index.json")),
    ...pathsFromIndex(path.join(dir, "capture-index.json")),
  );
}

for (const candidate of [...new Set(found.map((item) => path.resolve(item)))]) {
  if (existingFile(candidate)) console.log(candidate);
}
NODE
  )
fi

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
  "mobile voice" \
  "scripts/ops/friday-mobile-voice-action-evidence.sh" \
  "FRIDAY_MOBILE_VOICE_ACTION_EVIDENCE_DIR" \
  "FRIDAY_MOBILE_VOICE_ACTION_RUNTIME_OUT" \
  "mobile-voice"

run_wrapper \
  "mobile token ledger" \
  "scripts/ops/friday-mobile-token-ledger-action-evidence.sh" \
  "FRIDAY_MOBILE_TOKEN_LEDGER_ACTION_EVIDENCE_DIR" \
  "FRIDAY_MOBILE_TOKEN_LEDGER_ACTION_RUNTIME_OUT" \
  "mobile-token-ledger"

run_wrapper \
  "mobile provider auth" \
  "scripts/ops/friday-mobile-provider-auth-action-evidence.sh" \
  "FRIDAY_MOBILE_PROVIDER_AUTH_ACTION_EVIDENCE_DIR" \
  "FRIDAY_MOBILE_PROVIDER_AUTH_ACTION_RUNTIME_OUT" \
  "mobile-provider-auth"

run_wrapper \
  "mobile activity" \
  "scripts/ops/friday-mobile-activity-action-evidence.sh" \
  "FRIDAY_MOBILE_ACTIVITY_ACTION_EVIDENCE_DIR" \
  "FRIDAY_MOBILE_ACTIVITY_ACTION_RUNTIME_OUT" \
  "mobile-activity"

run_wrapper \
  "mobile projection" \
  "scripts/ops/friday-mobile-projection-action-evidence.sh" \
  "FRIDAY_MOBILE_PROJECTION_ACTION_EVIDENCE_DIR" \
  "FRIDAY_MOBILE_PROJECTION_ACTION_RUNTIME_OUT" \
  "mobile-projection"

run_wrapper \
  "desktop chat/memory" \
  "scripts/ops/friday-desktop-chat-memory-action-evidence.sh" \
  "FRIDAY_DESKTOP_CHAT_MEMORY_ACTION_EVIDENCE_DIR" \
  "FRIDAY_DESKTOP_CHAT_MEMORY_ACTION_RUNTIME_OUT" \
  "desktop-chat-memory"

run_wrapper \
  "desktop pairing" \
  "scripts/ops/friday-desktop-pairing-action-evidence.sh" \
  "FRIDAY_DESKTOP_PAIRING_ACTION_EVIDENCE_DIR" \
  "FRIDAY_DESKTOP_PAIRING_ACTION_RUNTIME_OUT" \
  "desktop-pairing"

run_wrapper \
  "desktop projection" \
  "scripts/ops/friday-desktop-projection-action-evidence.sh" \
  "FRIDAY_DESKTOP_PROJECTION_ACTION_EVIDENCE_DIR" \
  "FRIDAY_DESKTOP_PROJECTION_ACTION_RUNTIME_OUT" \
  "desktop-projection"

set +u
for extra in "${EXTRA_ACTION_EVIDENCE[@]}"; do
  RUNTIME_EVIDENCE_PATHS+=("${extra}")
done
for extra in "${DISCOVERED_EXTRA_ACTION_EVIDENCE[@]}"; do
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

extra_evidence_dir_args=()
set +u
for extra_dir in "${EXTRA_ACTION_EVIDENCE_DIRS[@]}"; do
  extra_evidence_dir_args+=("${extra_dir}")
done
set -u

set +u
node - "${OUT_DIR}" "${design_report}" "${paths_file}" "${checker_exit}" "${extra_evidence_dir_args[@]}" <<'NODE'
const fs = require("node:fs");
const path = require("node:path");

const [outDir, designReportPath, pathsFile, checkerExitRaw, ...extraEvidenceDirs] = process.argv.slice(2);
const report = JSON.parse(fs.readFileSync(designReportPath, "utf8"));
const paths = fs.readFileSync(pathsFile, "utf8").split(/\r?\n/).filter(Boolean);
const checkerExit = Number(checkerExitRaw);
const index = {
  truth: "action_runtime_evidence_bundle_partial_not_live_hub_not_endbar",
  status: checkerExit === 0 ? "ready" : "blocked",
  generated_at_utc: new Date().toISOString(),
  evidence_count: paths.length,
  runtime_evidence_paths: paths,
  extra_action_runtime_evidence_dirs: extraEvidenceDirs,
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
set -u

if [ "${checker_exit}" -ne 0 ]; then
  exit "${checker_exit}"
fi

echo "Action-runtime evidence bundle: ${OUT_DIR}/action-runtime-evidence-bundle-index.json"
echo "Truth: partial bundle only; remaining gaps still require real runtime/live evidence."
