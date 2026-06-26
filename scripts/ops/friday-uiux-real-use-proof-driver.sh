#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat >&2 <<'USAGE'
usage:
  scripts/ops/friday-uiux-real-use-proof-driver.sh --out-dir /abs/run-dir
    [--shared-id mission_ui_device_...]
    [--accessibility-capture /abs/real-accessibility-capture.json ...]
    [--backend-live-proof /abs/backend-proof.json]
    [--objective-coverage /abs/objective-coverage.json]
    [--channel-live-proof /abs/channel-live-proof.json]
    [--channel-capture /abs/channel-capture.json]
    [--timeline-capture /abs/timeline-capture.json]
    [--harvest-dir /abs/artifact-dir ...]
    [--same-run-events /abs/events.jsonl ...]
    [--runtime-evidence-dir /abs/evidence-dir ...]
    [--extra-action-runtime-evidence /abs/action-runtime-evidence.json ...]
    [--defer-channel-proof]
    [--skip-action-bundle]
    [--plan-only]

Runs the current fastest honest UI/UX real-use proof chain:
  1. selected-design native linkage gate
  2. optional action-runtime evidence bundle
  3. mobile+desktop live write/read capture bundle
  4. optional real accessibility click capture normalization
  5. strict UI/device readiness and product-closure reports

Truth:
  This is an orchestration driver only. It never fabricates accessibility clicks,
  channel/timeline events, organic adoption, screenshots-as-proof, or END-BAR.
USAGE
}

die() {
  echo "FATAL: $*" >&2
  exit 2
}

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
out_dir=""
shared_id="${FRIDAY_MISSION_SPINE_UI_PROOF_SHARED_ID:-}"
backend_live_proof="${FRIDAY_UI_DEVICE_BACKEND_LIVE_PROOF:-}"
objective_coverage="${FRIDAY_UI_DEVICE_OBJECTIVE_COVERAGE:-}"
channel_live_proof="${FRIDAY_UI_DEVICE_CHANNEL_LIVE_PROOF:-}"
channel_capture="${FRIDAY_UI_DEVICE_CHANNEL_CAPTURE:-}"
timeline_capture="${FRIDAY_UI_DEVICE_TIMELINE_CAPTURE:-}"
defer_channel_proof="${FRIDAY_UI_DEVICE_DEFER_CHANNEL_PROOF:-0}"
plan_only=0
skip_action_bundle=0
accessibility_captures=()
harvest_dirs=()
same_run_events=()
runtime_evidence_dirs=()
extra_action_runtime_evidence=()

if [ -n "${FRIDAY_DESIGN_ACTION_RUNTIME_EVIDENCE_DIRS:-}" ]; then
  IFS=':' read -r -a runtime_evidence_dirs <<<"${FRIDAY_DESIGN_ACTION_RUNTIME_EVIDENCE_DIRS}"
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
    --accessibility-capture)
      [ "$#" -ge 2 ] || die "--accessibility-capture requires a value"
      accessibility_captures+=("$2")
      shift 2
      ;;
    --accessibility-capture=*)
      accessibility_captures+=("${1#--accessibility-capture=}")
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
    --skip-action-bundle)
      skip_action_bundle=1
      shift
      ;;
    --plan-only)
      plan_only=1
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
for path in "${accessibility_captures[@]}" "${harvest_dirs[@]}" "${same_run_events[@]}" "${runtime_evidence_dirs[@]}" "${extra_action_runtime_evidence[@]}"; do
  require_abs_if_set "input path" "${path}"
done
set -u
require_file_if_set "--backend-live-proof" "${backend_live_proof}"
require_file_if_set "--objective-coverage" "${objective_coverage}"
require_file_if_set "--channel-live-proof" "${channel_live_proof}"
require_file_if_set "--channel-capture" "${channel_capture}"
require_file_if_set "--timeline-capture" "${timeline_capture}"

mkdir -p "${out_dir}"
native_linkage_out="${out_dir}/uiux-native-linkage.json"
action_bundle_dir="${out_dir}/action-runtime-bundle"
shortlist_dir="${out_dir}/ui-device-shortlist"
driver_summary="${out_dir}/uiux-real-use-proof-driver-summary.json"

echo "Friday UI/UX real-use proof driver starting."
echo "out_dir=${out_dir}"
echo "truth=uiux_real_use_proof_driver_not_endbar_not_adoption"

node "${repo_root}/scripts/ops/check-friday-uiux-native-linkage.mjs" \
  "--repo-root=${repo_root}" \
  "--out=${native_linkage_out}" \
  --require-complete >/dev/null

if [ "${plan_only}" -eq 1 ]; then
  node - "${driver_summary}" "${native_linkage_out}" <<'NODE'
const fs = require("node:fs");
const [summaryPath, nativePath] = process.argv.slice(2);
const native = JSON.parse(fs.readFileSync(nativePath, "utf8"));
const summary = {
  truth: "uiux_real_use_proof_driver_plan_only_not_runtime_proof",
  status: "plan_ready",
  nativeLinkageStatus: native.status,
  nextCommand: "rerun without --plan-only and supply real accessibility/channel/timeline evidence when available",
  caveat: "Plan-only mode performs no live UI/device capture and is not END-BAR.",
};
fs.writeFileSync(summaryPath, `${JSON.stringify(summary, null, 2)}\n`);
console.log(JSON.stringify(summary, null, 2));
NODE
  exit 0
fi

if [ "${skip_action_bundle}" -eq 0 ]; then
  action_bundle_args=(
    "${repo_root}/scripts/ops/friday-action-runtime-evidence-bundle.sh"
    "--out-dir" "${action_bundle_dir}"
  )
  set +u
  for path in "${extra_action_runtime_evidence[@]}"; do
    [ -n "${path}" ] || continue
    action_bundle_args+=("--extra-action-runtime-evidence" "${path}")
  done
  for dir in "${runtime_evidence_dirs[@]}"; do
    [ -n "${dir}" ] || continue
    action_bundle_args+=("--extra-action-runtime-evidence-dir" "${dir}")
  done
  set -u
  bash "${action_bundle_args[@]}"
  runtime_evidence_dirs+=("${action_bundle_dir}")
fi

shortlist_args=(
  "${repo_root}/scripts/ops/friday-ui-device-proof-shortlist-runner.sh"
  "--out-dir" "${shortlist_dir}"
)
if [ -n "${shared_id}" ]; then
  shortlist_args+=("--shared-id" "${shared_id}")
fi
if [ -n "${backend_live_proof}" ]; then
  shortlist_args+=("--backend-live-proof" "${backend_live_proof}")
fi
if [ -n "${objective_coverage}" ]; then
  shortlist_args+=("--objective-coverage" "${objective_coverage}")
fi
if [ -n "${channel_live_proof}" ]; then
  shortlist_args+=("--channel-live-proof" "${channel_live_proof}")
fi
if [ -n "${channel_capture}" ]; then
  shortlist_args+=("--channel-capture" "${channel_capture}")
fi
if [ -n "${timeline_capture}" ]; then
  shortlist_args+=("--timeline-capture" "${timeline_capture}")
fi
if [ "${defer_channel_proof}" = "1" ]; then
  shortlist_args+=("--defer-channel-proof")
fi
set +u
for path in "${accessibility_captures[@]}"; do
  [ -n "${path}" ] || continue
  shortlist_args+=("--accessibility-capture" "${path}")
done
for dir in "${harvest_dirs[@]}"; do
  [ -n "${dir}" ] || continue
  shortlist_args+=("--harvest-dir" "${dir}")
done
for path in "${same_run_events[@]}"; do
  [ -n "${path}" ] || continue
  shortlist_args+=("--same-run-events" "${path}")
done
for dir in "${runtime_evidence_dirs[@]}"; do
  [ -n "${dir}" ] || continue
  shortlist_args+=("--runtime-evidence-dir" "${dir}")
done
for path in "${extra_action_runtime_evidence[@]}"; do
  [ -n "${path}" ] || continue
  shortlist_args+=("--extra-action-runtime-evidence" "${path}")
done
set -u

bash "${shortlist_args[@]}"

node - "${driver_summary}" "${native_linkage_out}" "${shortlist_dir}/ui-device-shortlist-summary.json" "${action_bundle_dir}/action-runtime-evidence-bundle-index.json" <<'NODE'
const fs = require("node:fs");
const [summaryPath, nativePath, shortlistPath, actionBundlePath] = process.argv.slice(2);
function readJson(path) {
  try {
    return JSON.parse(fs.readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}
const native = readJson(nativePath);
const shortlist = readJson(shortlistPath);
const actionBundle = readJson(actionBundlePath);
const strictReady = shortlist?.status === "strict_ui_device_ready";
const summary = {
  truth: "uiux_real_use_proof_driver_summary_not_endbar_not_adoption",
  status: strictReady ? "strict_uiux_real_use_ready" : "partial_ready",
  nativeLinkageStatus: native?.status || "unknown",
  actionRuntimeBundleStatus: actionBundle?.status || "skipped_or_unavailable",
  missionId: shortlist?.missionId || null,
  uiDeviceShortlistStatus: shortlist?.status || "unknown",
  readinessBlockers: shortlist?.readinessBlockers || [],
  outputs: {
    nativeLinkage: nativePath,
    actionRuntimeBundle: fs.existsSync(actionBundlePath) ? actionBundlePath : null,
    uiDeviceShortlist: shortlistPath,
  },
  caveat: "END-BAR requires strict UI/device readiness with real mobile, desktop, channel, timeline, stress, and negative-control evidence. This driver does not fabricate missing evidence or claim adoption.",
};
fs.writeFileSync(summaryPath, `${JSON.stringify(summary, null, 2)}\n`);
console.log(JSON.stringify(summary, null, 2));
NODE

echo "summary=${driver_summary}"
