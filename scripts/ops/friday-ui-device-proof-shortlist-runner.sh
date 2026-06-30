#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat >&2 <<'EOF'
usage:
  scripts/ops/friday-ui-device-proof-shortlist-runner.sh --out-dir /abs/run-dir
    [--shared-id mission_ui_device_...]
    [--mission-id codex-organic-mission-...]
    [--backend-live-proof /abs/backend-proof.json]
    [--objective-coverage /abs/objective-coverage.json]
    [--channel-live-proof /abs/channel-live-proof.json]
    [--channel-capture /abs/channel-capture.json]
    [--timeline-capture /abs/timeline-capture.json]
    [--workbench-db /abs/rust-hub.sqlite]
    [--accessibility-capture /abs/real-accessibility-capture.json ...]
    [--stress-capture /abs/real-same-run-stress-capture.json ...]
    [--harvest-dir /abs/artifact-dir ...]
    [--same-run-events /abs/events.jsonl ...]
    [--selected-visual-evidence-dir /abs/served-or-visual-evidence ...]
    [--runtime-evidence-dir /abs/evidence-dir ...]
    [--extra-action-runtime-evidence /abs/action-runtime-evidence.json ...]
    [--defer-channel-proof]

Runs the already-proven mobile+desktop live write/read capture bundle, then
assembles the strongest honest UI/device readiness report possible from supplied
real evidence. It never invents channel, timeline, stress, or negative-control
observations.

Truth:
  - mobile+desktop live write/read capture is real same-mission runtime evidence.
  - channel/timeline/stress proof is only counted when explicit real artifacts
    are supplied.
  - without the full evidence set, output remains partial and not END-BAR.
EOF
}

die() {
  echo "FATAL: $*" >&2
  exit 2
}

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
out_dir=""
shared_id="${FRIDAY_MISSION_SPINE_UI_PROOF_SHARED_ID:-}"
mission_id_arg="${FRIDAY_MISSION_SPINE_UI_PROOF_MISSION_ID:-}"
backend_live_proof="${FRIDAY_UI_DEVICE_BACKEND_LIVE_PROOF:-}"
objective_coverage="${FRIDAY_UI_DEVICE_OBJECTIVE_COVERAGE:-}"
channel_live_proof="${FRIDAY_UI_DEVICE_CHANNEL_LIVE_PROOF:-}"
channel_capture=""
timeline_capture=""
workbench_db="${FRIDAY_WORKBENCH_DB_PATH:-}"
defer_channel_proof="${FRIDAY_UI_DEVICE_DEFER_CHANNEL_PROOF:-0}"
accessibility_captures=()
stress_captures=()
harvest_dirs=()
same_run_events=()
runtime_evidence_dirs=()
selected_visual_evidence_dirs=()
extra_action_runtime_evidence=()
shared_extra_evidence=()

if [ -n "${FRIDAY_DESIGN_ACTION_RUNTIME_EVIDENCE_DIRS:-}" ]; then
  IFS=':' read -r -a runtime_evidence_dirs <<<"${FRIDAY_DESIGN_ACTION_RUNTIME_EVIDENCE_DIRS}"
fi
if [ -n "${FRIDAY_EXTRA_ACTION_RUNTIME_EVIDENCE:-}" ]; then
  IFS=':' read -r -a extra_action_runtime_evidence <<<"${FRIDAY_EXTRA_ACTION_RUNTIME_EVIDENCE}"
fi

while [ "$#" -gt 0 ]; do
  case "$1" in
    --out-dir)
      [ "$#" -ge 2 ] || die "--out-dir requires a value"
      out_dir="$2"
      shift 2
      ;;
    --out-dir=*)
      out_dir="${1#--out-dir=}"
      shift
      ;;
    --shared-id)
      [ "$#" -ge 2 ] || die "--shared-id requires a value"
      shared_id="$2"
      shift 2
      ;;
    --shared-id=*)
      shared_id="${1#--shared-id=}"
      shift
      ;;
    --mission-id)
      [ "$#" -ge 2 ] || die "--mission-id requires a value"
      mission_id_arg="$2"
      shift 2
      ;;
    --mission-id=*)
      mission_id_arg="${1#--mission-id=}"
      shift
      ;;
    --backend-live-proof)
      [ "$#" -ge 2 ] || die "--backend-live-proof requires a value"
      backend_live_proof="$2"
      shift 2
      ;;
    --backend-live-proof=*)
      backend_live_proof="${1#--backend-live-proof=}"
      shift
      ;;
    --objective-coverage)
      [ "$#" -ge 2 ] || die "--objective-coverage requires a value"
      objective_coverage="$2"
      shift 2
      ;;
    --objective-coverage=*)
      objective_coverage="${1#--objective-coverage=}"
      shift
      ;;
    --channel-live-proof)
      [ "$#" -ge 2 ] || die "--channel-live-proof requires a value"
      channel_live_proof="$2"
      shift 2
      ;;
    --channel-live-proof=*)
      channel_live_proof="${1#--channel-live-proof=}"
      shift
      ;;
    --channel-capture)
      [ "$#" -ge 2 ] || die "--channel-capture requires a value"
      channel_capture="$2"
      shift 2
      ;;
    --channel-capture=*)
      channel_capture="${1#--channel-capture=}"
      shift
      ;;
    --timeline-capture)
      [ "$#" -ge 2 ] || die "--timeline-capture requires a value"
      timeline_capture="$2"
      shift 2
      ;;
    --timeline-capture=*)
      timeline_capture="${1#--timeline-capture=}"
      shift
      ;;
    --workbench-db)
      [ "$#" -ge 2 ] || die "--workbench-db requires a value"
      workbench_db="$2"
      shift 2
      ;;
    --workbench-db=*)
      workbench_db="${1#--workbench-db=}"
      shift
      ;;
    --accessibility-capture)
      [ "$#" -ge 2 ] || die "--accessibility-capture requires a value"
      accessibility_captures+=("$2")
      shift 2
      ;;
    --accessibility-capture=*)
      accessibility_captures+=("${1#--accessibility-capture=}")
      shift
      ;;
    --stress-capture)
      [ "$#" -ge 2 ] || die "--stress-capture requires a value"
      stress_captures+=("$2")
      shift 2
      ;;
    --stress-capture=*)
      stress_captures+=("${1#--stress-capture=}")
      shift
      ;;
    --harvest-dir)
      [ "$#" -ge 2 ] || die "--harvest-dir requires a value"
      harvest_dirs+=("$2")
      shift 2
      ;;
    --harvest-dir=*)
      harvest_dirs+=("${1#--harvest-dir=}")
      shift
      ;;
    --same-run-events)
      [ "$#" -ge 2 ] || die "--same-run-events requires a value"
      same_run_events+=("$2")
      shift 2
      ;;
    --same-run-events=*)
      same_run_events+=("${1#--same-run-events=}")
      shift
      ;;
    --runtime-evidence-dir)
      [ "$#" -ge 2 ] || die "--runtime-evidence-dir requires a value"
      runtime_evidence_dirs+=("$2")
      shift 2
      ;;
    --runtime-evidence-dir=*)
      runtime_evidence_dirs+=("${1#--runtime-evidence-dir=}")
      shift
      ;;
    --selected-visual-evidence-dir)
      [ "$#" -ge 2 ] || die "--selected-visual-evidence-dir requires a value"
      selected_visual_evidence_dirs+=("$2")
      shift 2
      ;;
    --selected-visual-evidence-dir=*)
      selected_visual_evidence_dirs+=("${1#--selected-visual-evidence-dir=}")
      shift
      ;;
    --extra-action-runtime-evidence)
      [ "$#" -ge 2 ] || die "--extra-action-runtime-evidence requires a value"
      extra_action_runtime_evidence+=("$2")
      shift 2
      ;;
    --extra-action-runtime-evidence=*)
      extra_action_runtime_evidence+=("${1#--extra-action-runtime-evidence=}")
      shift
      ;;
    --defer-channel-proof)
      defer_channel_proof=1
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

[ -n "${out_dir}" ] || die "missing --out-dir"
case "${out_dir}" in
  /*) ;;
  *) die "--out-dir must be absolute" ;;
esac
case "${shared_id}" in (*[[:space:]]*) die "--shared-id must not contain whitespace" ;; esac
case "${mission_id_arg}" in (*[[:space:]]*) die "--mission-id must not contain whitespace" ;; esac
if [ -n "${shared_id}" ] && [ -n "${mission_id_arg}" ]; then
  die "--shared-id and --mission-id are mutually exclusive"
fi
if [ -n "${mission_id_arg}" ]; then
  case "${mission_id_arg}" in (*mission*) ;; *) die "--mission-id must contain mission" ;; esac
fi

require_abs_if_set() {
  local label="$1"
  local value="$2"
  if [ -n "${value}" ]; then
    case "${value}" in
      /*) ;;
      *) die "${label} must be absolute: ${value}" ;;
    esac
  fi
}

require_file_if_set() {
  local label="$1"
  local value="$2"
  require_abs_if_set "${label}" "${value}"
  if [ -n "${value}" ] && [ ! -s "${value}" ]; then
    die "${label} missing or empty: ${value}"
  fi
}

set +u
for path in "${accessibility_captures[@]}" "${stress_captures[@]}" "${harvest_dirs[@]}" "${same_run_events[@]}" "${runtime_evidence_dirs[@]}" "${selected_visual_evidence_dirs[@]}" "${extra_action_runtime_evidence[@]}"; do
  require_abs_if_set "input path" "${path}"
done
set -u

mkdir -p "${out_dir}"
capture_root="${out_dir}/live-write-read"
evidence_dir="${out_dir}/evidence"
summary_out="${out_dir}/ui-device-shortlist-summary.json"
product_closure_out="${out_dir}/product-closure-readiness.json"
readiness_out="${out_dir}/ui-device-proof-readiness.json"
readiness_stdout="${readiness_out}.stdout"
gap_out="${out_dir}/ui-device-proof-gap-report.json"

capture_args=(
  "${repo_root}/scripts/ops/friday-ui-device-live-write-read-capture-bundle.sh"
  "--out-dir" "${capture_root}"
)
if [ -n "${shared_id}" ]; then
  capture_args+=("--shared-id" "${shared_id}")
fi
if [ -n "${mission_id_arg}" ]; then
  capture_args+=("--mission-id" "${mission_id_arg}")
fi
set +u
for path in "${extra_action_runtime_evidence[@]}"; do
  [ -n "${path}" ] || continue
  capture_args+=("--extra-action-runtime-evidence" "${path}")
done
set -u

echo "Friday UI/device proof shortlist runner starting."
echo "out_dir=${out_dir}"
echo "truth=ui_device_shortlist_runner_partial_until_full_real_evidence"
bash "${capture_args[@]}"

bundle_dir="${capture_root}/bundle"
bundle_index="${bundle_dir}/live-write-read-bundle-index.json"
mobile_capture="${bundle_dir}/mobile/ios-live-write-read-proof.json"
desktop_capture="${bundle_dir}/desktop/macos-live-write-read-proof.json"
combined_events="${bundle_dir}/mobile-desktop-live-write-read-events.jsonl"
mission_id="$(node -e 'const fs=require("fs"); const j=JSON.parse(fs.readFileSync(process.argv[1],"utf8")); console.log(j.missionId || "")' "${bundle_index}")"

accessibility_capture_status="skipped"
set +u
if [ "${#accessibility_captures[@]}" -gt 0 ]; then
  accessibility_capture_dir="${out_dir}/accessibility-click-capture"
  accessibility_args=(
    "${repo_root}/scripts/ops/friday-ui-device-accessibility-click-capture.mjs"
    "--mission-id=${mission_id}"
    "--out-dir=${accessibility_capture_dir}"
    "--require-ready"
  )
  for capture in "${accessibility_captures[@]}"; do
    [ -n "${capture}" ] || continue
    accessibility_args+=("--capture=${capture}")
  done
  node "${accessibility_args[@]}"
  same_run_events+=("${accessibility_capture_dir}/accessibility-click-events.jsonl")
  runtime_evidence_dirs+=("${accessibility_capture_dir}")
  while IFS= read -r accessibility_evidence_ref; do
    [ -n "${accessibility_evidence_ref}" ] || continue
    require_file_if_set "accessibility evidence_ref" "${accessibility_evidence_ref}"
    shared_extra_evidence+=("${accessibility_evidence_ref}")
  done < <(node - "${accessibility_captures[@]}" <<'NODE'
const fs = require("node:fs");
const seen = new Set();
for (const path of process.argv.slice(2)) {
  const raw = JSON.parse(fs.readFileSync(path, "utf8"));
  const captures = Array.isArray(raw?.captures) ? raw.captures : [raw];
  for (const capture of captures) {
    const refs = [
      capture?.evidence_ref,
      capture?.evidenceRef,
      ...(Array.isArray(capture?.ui_actions) ? capture.ui_actions : []),
      ...(Array.isArray(capture?.uiActions) ? capture.uiActions : []),
    ];
    for (const value of refs) {
      const ref = typeof value === "string"
        ? value
        : typeof value?.evidence_ref === "string"
          ? value.evidence_ref
          : typeof value?.evidenceRef === "string"
            ? value.evidenceRef
            : "";
      if (ref && !seen.has(ref)) {
        seen.add(ref);
        console.log(ref);
      }
    }
  }
}
NODE
)
  accessibility_capture_status="ready"
fi
set -u

stress_capture_status="skipped"
set +u
if [ "${#stress_captures[@]}" -gt 0 ]; then
  stress_capture_dir="${out_dir}/stress-capture-events"
  mkdir -p "${stress_capture_dir}"
  stress_index=0
  for stress_capture in "${stress_captures[@]}"; do
    [ -n "${stress_capture}" ] || continue
    stress_index=$((stress_index + 1))
    stress_events="${stress_capture_dir}/stress-events-${stress_index}.jsonl"
    node "${repo_root}/scripts/ops/friday-ui-device-stress-events.mjs" \
      "--mission-id=${mission_id}" \
      "--stress-capture=${stress_capture}" \
      "--out=${stress_events}" \
      --require-ready
    same_run_events+=("${stress_events}")
    stress_evidence_ref="$(node -e 'const fs=require("fs"); const j=JSON.parse(fs.readFileSync(process.argv[1],"utf8")); const value=j.evidence_ref || j.evidenceRef || ""; if (typeof value === "string" && value.trim()) console.log(value.trim());' "${stress_capture}")"
    if [ -n "${stress_evidence_ref}" ]; then
      require_file_if_set "stress evidence_ref" "${stress_evidence_ref}"
      shared_extra_evidence+=("${stress_evidence_ref}")
    fi
  done
  stress_capture_status="ready"
fi
set -u

set +u
if [ "${#harvest_dirs[@]}" -gt 0 ]; then
  harvest_out="${out_dir}/ui-device-proof-evidence-harvest.json"
  harvest_args=(
    "${repo_root}/scripts/ops/friday-ui-device-proof-evidence-harvest.mjs"
    "--mission-id=${mission_id}"
    "--out=${harvest_out}"
  )
  for dir in "${harvest_dirs[@]}"; do
    [ -n "${dir}" ] || continue
    harvest_args+=("--search-dir=${dir}")
  done
  if [ "${defer_channel_proof}" = "1" ]; then
    harvest_args+=("--defer-channel-proof")
  fi
  node "${harvest_args[@]}"
  fill_from_harvest() {
    local field="$1"
    node -e 'const fs=require("fs"); const j=JSON.parse(fs.readFileSync(process.argv[1],"utf8")); const value=j.selected?.[process.argv[2]]; if (typeof value === "string") console.log(value);' "${harvest_out}" "${field}"
  }
  [ -n "${backend_live_proof}" ] || backend_live_proof="$(fill_from_harvest backendLiveProof)"
  [ -n "${objective_coverage}" ] || objective_coverage="$(fill_from_harvest objectiveCoverage)"
  [ -n "${channel_live_proof}" ] || channel_live_proof="$(fill_from_harvest channelLiveProof)"
  [ -n "${channel_capture}" ] || channel_capture="$(fill_from_harvest channel)"
  [ -n "${timeline_capture}" ] || timeline_capture="$(fill_from_harvest timeline)"
  while IFS= read -r event_path; do
    [ -n "${event_path}" ] || continue
    same_run_events+=("${event_path}")
  done < <(node -e 'const fs=require("fs"); const j=JSON.parse(fs.readFileSync(process.argv[1],"utf8")); for (const value of j.selected?.events || []) console.log(value);' "${harvest_out}")
fi
set -u

require_file_if_set "--backend-live-proof" "${backend_live_proof}"
require_file_if_set "--objective-coverage" "${objective_coverage}"
require_file_if_set "--channel-live-proof" "${channel_live_proof}"
require_file_if_set "--channel-capture" "${channel_capture}"
require_file_if_set "--timeline-capture" "${timeline_capture}"
require_file_if_set "--workbench-db" "${workbench_db}"

event_inputs=("${combined_events}")
workbench_timeline_status="skipped"
if [ -z "${timeline_capture}" ] && [ -n "${workbench_db}" ]; then
  workbench_snapshot="${out_dir}/workbench-timeline-capture.json"
  workbench_snapshot_stdout="${workbench_snapshot}.stdout"
  workbench_snapshot_stderr="${workbench_snapshot}.stderr"
  if (cd "${repo_root}/rust-core" && cargo run -p friday-hub --bin mission_workbench_projection -- \
    --db "${workbench_db}" \
    --mission-id "${mission_id}" >"${workbench_snapshot}") >"${workbench_snapshot_stdout}" 2>"${workbench_snapshot_stderr}"; then
    timeline_capture="${workbench_snapshot}"
    workbench_timeline_status="snapshot_ready"
  else
    workbench_timeline_status="snapshot_failed"
  fi
fi
if [ -n "${timeline_capture}" ] && [ "${workbench_timeline_status}" != "snapshot_failed" ]; then
  workbench_events="${out_dir}/workbench-derived-events.jsonl"
  workbench_events_args=(
    "${repo_root}/scripts/ops/friday-workbench-snapshot-events.mjs"
    "--mission-id=${mission_id}"
    "--file=${timeline_capture}"
    "--mobile=${mobile_capture}"
    "--desktop=${desktop_capture}"
    "--timeline=${timeline_capture}"
    "--out=${workbench_events}"
  )
  if [ -n "${channel_capture}" ]; then
    workbench_events_args+=("--channel=${channel_capture}")
  fi
  if [ "${defer_channel_proof}" = "1" ]; then
    workbench_events_args+=("--defer-channel-proof")
  fi
  if node "${workbench_events_args[@]}" --require-ready >"${workbench_events}.stdout"; then
    same_run_events+=("${workbench_events}")
    if [ "${workbench_timeline_status}" = "skipped" ]; then
      workbench_timeline_status="events_ready"
    else
      workbench_timeline_status="${workbench_timeline_status}_events_ready"
    fi
  else
    if [ "${workbench_timeline_status}" = "skipped" ]; then
      workbench_timeline_status="events_failed"
    else
      workbench_timeline_status="${workbench_timeline_status}_events_failed"
    fi
  fi
fi
channel_events=""
if [ -n "${channel_live_proof}" ] || [ -n "${channel_capture}" ]; then
  [ -n "${channel_live_proof}" ] || die "--channel-live-proof is required with --channel-capture"
  [ -n "${channel_capture}" ] || die "--channel-capture is required with --channel-live-proof"
  channel_events="${out_dir}/channel-events.jsonl"
  node "${repo_root}/scripts/ops/friday-channel-proof-events.mjs" \
    "--mission-id=${mission_id}" \
    "--channel-live-proof=${channel_live_proof}" \
    "--channel-capture=${channel_capture}" \
    "--out=${channel_events}" \
    --require-ready
  event_inputs+=("${channel_events}")
fi
set +u
for path in "${same_run_events[@]}"; do
  [ -n "${path}" ] || continue
  event_inputs+=("${path}")
done
set -u

capture_dir_status="skipped_missing_channel_or_timeline"
if [ -n "${timeline_capture}" ] && { [ -n "${channel_capture}" ] || [ "${defer_channel_proof}" = "1" ]; }; then
  capture_dir_args=(
    "${repo_root}/scripts/ops/friday-ui-device-capture-dir.mjs"
    "--mission-id=${mission_id}"
    "--out-dir=${evidence_dir}"
    "--mobile=${mobile_capture}"
    "--desktop=${desktop_capture}"
    "--timeline=${timeline_capture}"
    "--require-ready"
  )
  if [ -n "${channel_capture}" ]; then
    capture_dir_args+=("--channel=${channel_capture}")
  fi
  if [ "${defer_channel_proof}" = "1" ]; then
    capture_dir_args+=("--defer-channel-proof")
  fi
  for path in "${event_inputs[@]}"; do
    capture_dir_args+=("--events=${path}")
  done
  set +u
  for path in "${shared_extra_evidence[@]}"; do
    [ -n "${path}" ] || continue
    capture_dir_args+=("--shared-extra-evidence=${path}")
  done
  set -u
  if node "${capture_dir_args[@]}"; then
    if [ "${defer_channel_proof}" = "1" ]; then
      capture_dir_status="ready_channel_deferred_non_strict"
    else
      capture_dir_status="ready"
    fi
  else
    capture_dir_status="blocked"
  fi
else
  echo "capture_dir=skipped_missing_channel_or_timeline"
fi

closure_args=(
  "${repo_root}/scripts/ops/friday-uiux-product-closure-readiness.mjs"
  "--runtime-evidence-dir=${bundle_dir}"
  "--out=${product_closure_out}"
)
set +u
for dir in "${runtime_evidence_dirs[@]}"; do
  [ -n "${dir}" ] || continue
  closure_args+=("--runtime-evidence-dir=${dir}")
done
for dir in "${selected_visual_evidence_dirs[@]}"; do
  [ -n "${dir}" ] || continue
  closure_args+=("--selected-visual-evidence-dir=${dir}")
done
for path in "${extra_action_runtime_evidence[@]}"; do
  [ -n "${path}" ] || continue
  closure_args+=("--runtime-evidence=${path}")
done
set -u
if [[ "${capture_dir_status}" == ready* ]]; then
  closure_args+=("--evidence-dir=${evidence_dir}")
fi
if [ "${defer_channel_proof}" = "1" ]; then
  closure_args+=("--defer-channel-proof")
fi
node "${closure_args[@]}"

readiness_args=("${repo_root}/scripts/ops/friday-ui-device-proof-readiness.sh")
if [[ "${capture_dir_status}" == ready* ]]; then
  readiness_args+=("--evidence-dir" "${evidence_dir}")
fi
if [ -n "${backend_live_proof}" ]; then
  readiness_args+=("--backend-live-proof" "${backend_live_proof}")
fi
if [ -n "${channel_live_proof}" ]; then
  readiness_args+=("--channel-live-proof" "${channel_live_proof}")
fi
if [ -n "${objective_coverage}" ]; then
  readiness_args+=("--objective-coverage" "${objective_coverage}")
fi
if [ -n "${workbench_db}" ]; then
  readiness_args+=("--workbench-db" "${workbench_db}")
fi
set +u
for dir in "${runtime_evidence_dirs[@]}"; do
  [ -n "${dir}" ] || continue
  readiness_args+=("--design-action-runtime-evidence-dir" "${dir}")
done
for path in "${extra_action_runtime_evidence[@]}"; do
  [ -n "${path}" ] || continue
  readiness_args+=("--design-action-runtime-evidence" "${path}")
done
set -u
if [ "${defer_channel_proof}" = "1" ]; then
  readiness_args+=("--defer-channel-proof")
fi
MISSION_ID="${mission_id}" FRIDAY_DESIGN_ACTION_RUNTIME_EVIDENCE_DIRS="${bundle_dir}" bash "${readiness_args[@]}" >"${readiness_stdout}"
node - "${readiness_stdout}" "${readiness_out}" <<'NODE'
const fs = require("node:fs");
const [stdoutPath, outPath] = process.argv.slice(2);

function parseJsonSuffix(text) {
  const trimmed = String(text || "").trim();
  if (!trimmed) throw new Error("empty readiness output");
  try {
    return JSON.parse(trimmed);
  } catch {
    // The readiness wrapper prints self-test lines before its final JSON object.
  }
  const starts = [];
  for (let index = 0; index < trimmed.length; index += 1) {
    if (trimmed[index] === "{") starts.push(index);
  }
  for (const start of starts.reverse()) {
    try {
      return JSON.parse(trimmed.slice(start));
    } catch {
      // Try the next earlier object start.
    }
  }
  throw new Error("no parseable readiness JSON object suffix");
}

const readiness = parseJsonSuffix(fs.readFileSync(stdoutPath, "utf8"));
fs.writeFileSync(outPath, `${JSON.stringify(readiness, null, 2)}\n`);
NODE

gap_status="skipped_missing_channel_or_timeline"
gap_event_status="skipped"
if [ -n "${timeline_capture}" ] && { [ -n "${channel_capture}" ] || [ "${defer_channel_proof}" = "1" ]; }; then
  gap_events="${evidence_dir}/same-run-events.normalized.jsonl"
  gap_mobile="${mobile_capture}"
  gap_desktop="${desktop_capture}"
  gap_timeline="${timeline_capture}"
  gap_manifest="${evidence_dir}/observations-manifest.json"
  if [ ! -s "${gap_events}" ]; then
    gap_events="${out_dir}/gap-report-events.jsonl"
    gap_merge_args=(
      "${repo_root}/scripts/ops/friday-ui-device-events-merge.mjs"
      "--mission-id=${mission_id}"
      "--out=${gap_events}"
      "--require-ready"
    )
    for path in "${event_inputs[@]}"; do
      gap_merge_args+=("--events=${path}")
    done
    if node "${gap_merge_args[@]}" >"${gap_events}.stdout"; then
      gap_event_status="report_only_events_ready"
    else
      gap_event_status="report_only_events_blocked"
    fi
  else
    gap_event_status="strict_capture_dir_events_ready"
    gap_mobile="${evidence_dir}/mobile.json"
    gap_desktop="${evidence_dir}/desktop.json"
    gap_timeline="${evidence_dir}/timeline.json"
  fi
  gap_args=(
    "${repo_root}/scripts/ops/friday-ui-device-proof-gap-report.mjs"
    "--mission-id=${mission_id}"
    "--events=${gap_events}"
    "--mobile=${gap_mobile}"
    "--desktop=${gap_desktop}"
    "--timeline=${gap_timeline}"
    "--out=${gap_out}"
  )
  if [ -n "${channel_capture}" ]; then
    gap_channel="${evidence_dir}/channel.json"
    if [ ! -s "${gap_channel}" ]; then
      gap_channel="${channel_capture}"
    fi
    gap_args+=("--channel=${gap_channel}")
  fi
  if [ -s "${gap_manifest}" ]; then
    gap_args+=("--manifest=${gap_manifest}")
  fi
  if [ -n "${backend_live_proof}" ]; then
    gap_args+=("--backend-live-proof=${backend_live_proof}")
  fi
  if [ -n "${channel_live_proof}" ]; then
    gap_args+=("--channel-live-proof=${channel_live_proof}")
  fi
  if [ -n "${objective_coverage}" ]; then
    gap_args+=("--objective-coverage=${objective_coverage}")
  fi
  if [ "${defer_channel_proof}" = "1" ]; then
    gap_args+=("--defer-channel-proof")
  fi
  node "${gap_args[@]}" || true
  gap_status="written"
fi

node - "${summary_out}" "${bundle_index}" "${product_closure_out}" "${readiness_out}" "${gap_out}" "${capture_dir_status}" "${gap_status}" "${gap_event_status}" "${accessibility_capture_status}" "${stress_capture_status}" "${workbench_timeline_status}" <<'NODE'
const fs = require("node:fs");
const [summaryOut, bundleIndexPath, productClosurePath, readinessPath, gapReportPath, captureDirStatus, gapStatus, gapEventStatus, accessibilityCaptureStatus, stressCaptureStatus, workbenchTimelineStatus] = process.argv.slice(2);
function parseJsonSuffix(text) {
  const trimmed = String(text || "").trim();
  if (!trimmed) throw new Error("empty JSON input");
  try {
    return JSON.parse(trimmed);
  } catch {
    // The readiness wrapper prints self-test lines before its final JSON object.
  }
  const starts = [];
  for (let index = 0; index < trimmed.length; index += 1) {
    if (trimmed[index] === "{") starts.push(index);
  }
  for (const start of starts.reverse()) {
    try {
      return JSON.parse(trimmed.slice(start));
    } catch {
      // Try the next earlier object start.
    }
  }
  throw new Error("no parseable JSON object suffix");
}
const readJson = (path) => parseJsonSuffix(fs.readFileSync(path, "utf8"));
const readOptionalJson = (path) => {
  if (!path || !fs.existsSync(path)) return null;
  return readJson(path);
};
const add = (set, value) => {
  if (value) set.add(value);
};
function isChannelDeferredOnly(gapReport) {
  const gaps = gapReport?.gaps || {};
  const blockers = Array.isArray(gapReport?.blockers) ? gapReport.blockers : [];
  const missing = [
    ...(Array.isArray(gaps.missingObservations) ? gaps.missingObservations : []),
    ...(Array.isArray(gaps.missingOrderEvents) ? gaps.missingOrderEvents : []),
    ...(Array.isArray(gaps.missingChecks) ? gaps.missingChecks : []),
  ];
  const deferredCount = [
    ...(Array.isArray(gaps.deferredObservations) ? gaps.deferredObservations : []),
    ...(Array.isArray(gaps.deferredOrderEvents) ? gaps.deferredOrderEvents : []),
    ...(Array.isArray(gaps.deferredChecks) ? gaps.deferredChecks : []),
  ].length;
  return blockers.length === 0 && missing.length === 0 && deferredCount > 0;
}
function gapNameFor(value) {
  const text = typeof value === "string" ? value : JSON.stringify(value || {});
  if (text.includes("channel")) return "same_mission_mobile_desktop_channel_capture";
  if (text.includes("bounded_page") || text.includes("timeline")) return "bounded_timeline_capture";
  if (text.includes("pressure_20_50")) return "pressure_20_50_consecutive_asks";
  if (text.includes("invalid_key") || text.includes("quota") || text.includes("network") || text.includes("reconnect")) {
    return "error_quota_network_replay_reconnect_observations";
  }
  if (text.includes("secret") || text.includes("hidden_fallback") || text.includes("fallback")) {
    return "secret_leak_and_hidden_fallback_negative_controls";
  }
  return "strict_observations_manifest_from_same_run_events";
}
function deriveFullProofGaps(bundle, gapReport) {
  const fallback = Array.isArray(bundle?.fullProofGaps) ? bundle.fullProofGaps : [];
  if (!gapReport || typeof gapReport !== "object") return fallback;
  if (gapReport.status === "complete_inputs_observed") return [];
  if (isChannelDeferredOnly(gapReport)) return ["same_mission_mobile_desktop_channel_capture"];

  const gaps = gapReport.gaps || {};
  const result = new Set();
  for (const row of Array.isArray(gaps.missingObservations) ? gaps.missingObservations : []) add(result, gapNameFor(row));
  for (const row of Array.isArray(gaps.missingOrderEvents) ? gaps.missingOrderEvents : []) add(result, gapNameFor(row));
  for (const row of Array.isArray(gaps.missingChecks) ? gaps.missingChecks : []) add(result, gapNameFor(row));
  const stress = gaps.stress || {};
  if (stress.pressureAskCountOk === false) add(result, "pressure_20_50_consecutive_asks");
  if (stress.timelinePageCountOk === false) add(result, "bounded_timeline_capture");
  if (Array.isArray(gapReport.supplementalEvidenceRefs) && gapReport.supplementalEvidenceRefs.length > 0) {
    add(result, "strict_observations_manifest_from_same_run_events");
  }
  return [...result].sort();
}
const bundle = readJson(bundleIndexPath);
const closure = readJson(productClosurePath);
const readiness = readJson(readinessPath);
const gapReport = readOptionalJson(gapReportPath);
const fullProofGaps = deriveFullProofGaps(bundle, gapReport);
const summary = {
  truth: "ui_device_shortlist_runner_summary_not_endbar_not_adoption",
  status: readiness.status === "pass" ? "strict_ui_device_ready" : "partial_ready",
  missionId: bundle.missionId || null,
  captures: bundle.captures || {},
  captureDirStatus,
  gapStatus,
  gapEventStatus,
  accessibilityCaptureStatus,
  stressCaptureStatus,
  workbenchTimelineStatus,
  productClosureStatus: closure.status,
  selectedVisualProofStatus: closure.stages?.selectedVisualProof?.status || null,
  uiDeviceProofReadiness: closure.stages?.uiDeviceProofReadiness || null,
  readinessStatus: readiness.status,
  readinessBlockers: readiness.blockers || [],
  gapReportStatus: gapReport?.status || null,
  gapReportPath: gapReportPath || null,
  initialFullProofGaps: bundle.fullProofGaps || [],
  fullProofGaps,
  caveat: "Runner output is END-BAR only if strict UI/device readiness passes with real channel, timeline, stress, and negative-control evidence. Partial mobile+desktop live write/read capture is not enough.",
};
fs.writeFileSync(summaryOut, `${JSON.stringify(summary, null, 2)}\n`);
console.log(JSON.stringify(summary, null, 2));
NODE

echo "summary=${summary_out}"
