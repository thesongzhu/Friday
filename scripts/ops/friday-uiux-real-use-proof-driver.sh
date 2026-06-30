#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat >&2 <<'USAGE'
usage:
  scripts/ops/friday-uiux-real-use-proof-driver.sh --out-dir /abs/run-dir
    [--shared-id mission_ui_device_...]
    [--mission-id mission_...]
    [--accessibility-capture /abs/real-accessibility-capture.json ...]
    [--run-desktop-ax-capture]
    [--desktop-ax-destinations operations,chat,...]
    [--desktop-ax-app-dir /abs/FridayHubConsole.app]
    [--desktop-ax-workbench-mission-id mission_...]
    [--desktop-ax-timeout-seconds 20]
    [--skip-ios-design-capture]
    [--backend-live-proof /abs/backend-proof.json]
    [--objective-coverage /abs/objective-coverage.json]
    [--channel-live-proof /abs/channel-live-proof.json]
    [--channel-capture /abs/channel-capture.json]
    [--timeline-capture /abs/timeline-capture.json]
    [--workbench-db /abs/rust-hub.sqlite]
    [--harvest-dir /abs/artifact-dir ...]
    [--same-run-events /abs/events.jsonl ...]
    [--selected-visual-evidence-dir /abs/served-or-visual-evidence ...]
    [--runtime-evidence-dir /abs/evidence-dir ...]
    [--extra-action-runtime-evidence /abs/action-runtime-evidence.json ...]
    [--defer-channel-proof]
    [--skip-action-bundle]
    [--plan-only]

Runs the current fastest honest UI/UX real-use proof chain:
  1. selected-design native linkage gate
  2. optional action-runtime evidence bundle
  3. mobile+desktop live write/read capture bundle
  4. optional real desktop Accessibility capture and real accessibility click capture normalization
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
mission_id_arg="${FRIDAY_MISSION_SPINE_UI_PROOF_MISSION_ID:-}"
backend_live_proof="${FRIDAY_UI_DEVICE_BACKEND_LIVE_PROOF:-}"
objective_coverage="${FRIDAY_UI_DEVICE_OBJECTIVE_COVERAGE:-}"
channel_live_proof="${FRIDAY_UI_DEVICE_CHANNEL_LIVE_PROOF:-}"
channel_capture="${FRIDAY_UI_DEVICE_CHANNEL_CAPTURE:-}"
timeline_capture="${FRIDAY_UI_DEVICE_TIMELINE_CAPTURE:-}"
workbench_db="${FRIDAY_WORKBENCH_DB_PATH:-}"
defer_channel_proof="${FRIDAY_UI_DEVICE_DEFER_CHANNEL_PROOF:-0}"
run_desktop_ax_capture="${FRIDAY_UIUX_RUN_DESKTOP_AX_CAPTURE:-0}"
run_ios_design_capture="${FRIDAY_UIUX_RUN_IOS_DESIGN_CAPTURE:-1}"
desktop_ax_destinations="${FRIDAY_DESKTOP_AX_CAPTURE_DESTINATIONS:-}"
desktop_ax_app_dir="${FRIDAY_DESKTOP_AX_APP_DIR:-}"
desktop_ax_workbench_mission_id="${FRIDAY_DESKTOP_AX_WORKBENCH_MISSION_ID:-}"
desktop_ax_timeout_seconds="${FRIDAY_DESKTOP_AX_CAPTURE_TIMEOUT_SECONDS:-20}"
plan_only=0
skip_action_bundle=0
accessibility_captures=()
harvest_dirs=()
same_run_events=()
runtime_evidence_dirs=()
selected_visual_evidence_dirs=()
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
    --mission-id)
      [ "$#" -ge 2 ] || die "--mission-id requires a value"
      mission_id_arg="$2"
      shift 2
      ;;
    --mission-id=*)
      mission_id_arg="${1#--mission-id=}"
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
    --run-desktop-ax-capture)
      run_desktop_ax_capture=1
      shift
      ;;
    --desktop-ax-destinations)
      [ "$#" -ge 2 ] || die "--desktop-ax-destinations requires a value"
      desktop_ax_destinations="$2"
      shift 2
      ;;
    --desktop-ax-destinations=*)
      desktop_ax_destinations="${1#--desktop-ax-destinations=}"
      shift
      ;;
    --desktop-ax-app-dir)
      [ "$#" -ge 2 ] || die "--desktop-ax-app-dir requires a value"
      desktop_ax_app_dir="$2"
      shift 2
      ;;
    --desktop-ax-app-dir=*)
      desktop_ax_app_dir="${1#--desktop-ax-app-dir=}"
      shift
      ;;
    --desktop-ax-workbench-mission-id)
      [ "$#" -ge 2 ] || die "--desktop-ax-workbench-mission-id requires a value"
      desktop_ax_workbench_mission_id="$2"
      shift 2
      ;;
    --desktop-ax-workbench-mission-id=*)
      desktop_ax_workbench_mission_id="${1#--desktop-ax-workbench-mission-id=}"
      shift
      ;;
    --desktop-ax-timeout-seconds)
      [ "$#" -ge 2 ] || die "--desktop-ax-timeout-seconds requires a value"
      desktop_ax_timeout_seconds="$2"
      shift 2
      ;;
    --desktop-ax-timeout-seconds=*)
      desktop_ax_timeout_seconds="${1#--desktop-ax-timeout-seconds=}"
      shift
      ;;
    --skip-ios-design-capture)
      run_ios_design_capture=0
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
case "${mission_id_arg}" in (*[[:space:]]*) die "--mission-id must not contain whitespace" ;; esac
if [ -n "${shared_id}" ] && [ -n "${mission_id_arg}" ]; then
  die "--shared-id and --mission-id are mutually exclusive"
fi
if [ -n "${mission_id_arg}" ]; then
  case "${mission_id_arg}" in (*mission*) ;; *) die "--mission-id must contain mission" ;; esac
fi
case "${run_desktop_ax_capture}" in
  0|1|false|true) ;;
  *) die "FRIDAY_UIUX_RUN_DESKTOP_AX_CAPTURE must be 0/1/false/true" ;;
esac
case "${run_ios_design_capture}" in
  0|1|false|true) ;;
  *) die "FRIDAY_UIUX_RUN_IOS_DESIGN_CAPTURE must be 0/1/false/true" ;;
esac
if ! [[ "${desktop_ax_timeout_seconds}" =~ ^[0-9]+$ ]] || [[ "${desktop_ax_timeout_seconds}" -lt 5 ]]; then
  die "--desktop-ax-timeout-seconds must be an integer >= 5"
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
for path in "${accessibility_captures[@]}" "${harvest_dirs[@]}" "${same_run_events[@]}" "${runtime_evidence_dirs[@]}" "${selected_visual_evidence_dirs[@]}" "${extra_action_runtime_evidence[@]}"; do
  require_abs_if_set "input path" "${path}"
done
set -u
require_file_if_set "--backend-live-proof" "${backend_live_proof}"
require_file_if_set "--objective-coverage" "${objective_coverage}"
require_file_if_set "--channel-live-proof" "${channel_live_proof}"
require_file_if_set "--channel-capture" "${channel_capture}"
require_file_if_set "--timeline-capture" "${timeline_capture}"
require_file_if_set "--workbench-db" "${workbench_db}"
if [ -n "${desktop_ax_app_dir}" ]; then
  require_abs_if_set "--desktop-ax-app-dir" "${desktop_ax_app_dir}"
fi

if [ -z "${shared_id}" ] && [ -z "${mission_id_arg}" ]; then
  shared_id="mission-uiux-real-use-$(date -u +%Y%m%dT%H%M%SZ)-$(uuidgen | tr '[:upper:]' '[:lower:]')"
fi
if [ -n "${mission_id_arg}" ]; then
  canonical_mission_id="${mission_id_arg}"
else
  case "${shared_id}" in
    mission_*) canonical_mission_id="${shared_id}" ;;
    *) canonical_mission_id="mission_${shared_id}" ;;
  esac
fi

mkdir -p "${out_dir}"
native_linkage_out="${out_dir}/uiux-native-linkage.json"
served_ui_dir="${out_dir}/served-ui"
served_ui_fidelity_out="${served_ui_dir}/served-ui-design-fidelity.json"
ios_design_capture_dir="${out_dir}/ios-design-destination-capture"
ios_design_manifest_out="${ios_design_capture_dir}/ios-design-destination-capture-manifest.json"
action_bundle_dir="${out_dir}/action-runtime-bundle"
desktop_ax_dir="${out_dir}/desktop-ax-accessibility"
desktop_ax_capture_out="${desktop_ax_dir}/desktop-ax-accessibility-capture.json"
shortlist_dir="${out_dir}/ui-device-shortlist"
driver_summary="${out_dir}/uiux-real-use-proof-driver-summary.json"
desktop_ax_exit_code=0
shortlist_exit_code=0

echo "Friday UI/UX real-use proof driver starting."
echo "out_dir=${out_dir}"
echo "truth=uiux_real_use_proof_driver_not_endbar_not_adoption"

if [ "${plan_only}" -eq 1 ]; then
  node - "${driver_summary}" <<'NODE'
const fs = require("node:fs");
const [summaryPath] = process.argv.slice(2);
const summary = {
  truth: "uiux_real_use_proof_driver_plan_only_not_runtime_proof",
  status: "plan_ready",
  nativeLinkageStatus: "not_run_plan_only",
  servedUiDesignFidelityStatus: "not_run_plan_only",
  nextCommand: "rerun without --plan-only and supply real accessibility/channel/timeline evidence when available",
  caveat: "Plan-only mode performs no live UI/device capture and is not END-BAR.",
};
fs.writeFileSync(summaryPath, `${JSON.stringify(summary, null, 2)}\n`);
console.log(JSON.stringify(summary, null, 2));
NODE
  exit 0
fi

node "${repo_root}/scripts/ops/check-friday-uiux-native-linkage.mjs" \
  "--repo-root=${repo_root}" \
  "--out=${native_linkage_out}" \
  --require-complete >/dev/null

node "${repo_root}/scripts/ops/check-friday-served-ui-design-fidelity.mjs" \
  "--out=${served_ui_fidelity_out}" >/dev/null
selected_visual_evidence_dirs+=("${served_ui_dir}")

case "${run_ios_design_capture}" in
  1|true)
    ios_design_capture_args=(
      "${repo_root}/scripts/ops/friday-ios-design-destination-capture.sh"
      "--out-dir" "${ios_design_capture_dir}"
      "--mode" "live-loopback"
    )
    if [ -n "${canonical_mission_id}" ]; then
      ios_design_capture_args+=("--mission-id" "${canonical_mission_id}")
    fi
    bash "${ios_design_capture_args[@]}"
    selected_visual_evidence_dirs+=("${ios_design_capture_dir}")
    ;;
esac

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

case "${run_desktop_ax_capture}" in
  1|true)
    desktop_ax_args=(
      "${repo_root}/scripts/ops/friday-desktop-ax-accessibility-capture.mjs"
      "--mission-id=${canonical_mission_id}"
      "--out-dir=${desktop_ax_dir}"
      "--timeout-seconds=${desktop_ax_timeout_seconds}"
      "--require-observed"
    )
    if [ -n "${desktop_ax_destinations}" ]; then
      desktop_ax_args+=("--destinations=${desktop_ax_destinations}")
    fi
    if [ -n "${desktop_ax_app_dir}" ]; then
      desktop_ax_args+=("--app-dir=${desktop_ax_app_dir}")
    fi
    if [ -n "${desktop_ax_workbench_mission_id}" ]; then
      desktop_ax_args+=("--workbench-mission-id=${desktop_ax_workbench_mission_id}")
    fi
    set +e
    node "${desktop_ax_args[@]}"
    desktop_ax_exit_code=$?
    set -e
    if [ -s "${desktop_ax_capture_out}" ]; then
      accessibility_captures+=("${desktop_ax_capture_out}")
    fi
    if [ "${desktop_ax_exit_code}" -ne 0 ]; then
      echo "WARN: desktop AX capture exited ${desktop_ax_exit_code}; keeping partial artifact summary instead of dropping prior evidence." >&2
    fi
    ;;
esac

shortlist_args=(
  "${repo_root}/scripts/ops/friday-ui-device-proof-shortlist-runner.sh"
  "--out-dir" "${shortlist_dir}"
)
if [ -n "${shared_id}" ]; then
  shortlist_args+=("--shared-id" "${shared_id}")
fi
if [ -n "${mission_id_arg}" ]; then
  shortlist_args+=("--mission-id" "${mission_id_arg}")
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
if [ -n "${workbench_db}" ]; then
  shortlist_args+=("--workbench-db" "${workbench_db}")
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
for dir in "${selected_visual_evidence_dirs[@]}"; do
  [ -n "${dir}" ] || continue
  shortlist_args+=("--selected-visual-evidence-dir" "${dir}")
done
for path in "${extra_action_runtime_evidence[@]}"; do
  [ -n "${path}" ] || continue
  shortlist_args+=("--extra-action-runtime-evidence" "${path}")
done
set -u

set +e
bash "${shortlist_args[@]}"
shortlist_exit_code=$?
set -e
if [ "${shortlist_exit_code}" -ne 0 ]; then
  echo "WARN: UI device shortlist exited ${shortlist_exit_code}; writing partial driver summary with blockers." >&2
fi

node - "${driver_summary}" "${native_linkage_out}" "${served_ui_fidelity_out}" "${ios_design_manifest_out}" "${shortlist_dir}/ui-device-shortlist-summary.json" "${action_bundle_dir}/action-runtime-evidence-bundle-index.json" "${desktop_ax_capture_out}" "${desktop_ax_exit_code}" "${shortlist_exit_code}" <<'NODE'
const fs = require("node:fs");
const [
  summaryPath,
  nativePath,
  servedUiFidelityPath,
  iosDesignManifestPath,
  shortlistPath,
  actionBundlePath,
  desktopAxCapturePath,
  desktopAxExitCodeRaw,
  shortlistExitCodeRaw,
] = process.argv.slice(2);
function readJson(path) {
  try {
    return JSON.parse(fs.readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}
const native = readJson(nativePath);
const servedUiFidelity = readJson(servedUiFidelityPath);
const iosDesignManifest = readJson(iosDesignManifestPath);
const shortlist = readJson(shortlistPath);
const actionBundle = readJson(actionBundlePath);
const desktopAxCapture = readJson(desktopAxCapturePath);
const desktopAxExitCode = Number(desktopAxExitCodeRaw || 0);
const shortlistExitCode = Number(shortlistExitCodeRaw || 0);
const strictReady = shortlist?.status === "strict_ui_device_ready";
const partialBlockers = [
  ...(Array.isArray(shortlist?.readinessBlockers) ? shortlist.readinessBlockers : []),
  ...(Array.isArray(shortlist?.blockers) ? shortlist.blockers : []),
];
if (desktopAxExitCode !== 0) {
  partialBlockers.push({
    code: "desktop_ax_capture_failed_or_partial",
    detail: `exit=${desktopAxExitCode}`,
  });
}
if (shortlistExitCode !== 0) {
  partialBlockers.push({
    code: "ui_device_shortlist_failed_or_partial",
    detail: `exit=${shortlistExitCode}`,
  });
}
const summary = {
  truth: "uiux_real_use_proof_driver_summary_not_endbar_not_adoption",
  status: strictReady ? "strict_uiux_real_use_ready" : "partial_ready",
  exitCodes: {
    desktopAx: desktopAxExitCode,
    uiDeviceShortlist: shortlistExitCode,
  },
  nativeLinkageStatus: native?.status || "unknown",
  servedUiDesignFidelityStatus: servedUiFidelity?.status || "unknown",
  iosDesignDestinationCaptureStatus: iosDesignManifest?.status || "skipped_or_unavailable",
  actionRuntimeBundleStatus: actionBundle?.status || "skipped_or_unavailable",
  desktopAccessibilityCaptureStatus: desktopAxCapture?.status || "skipped_or_unavailable",
  missionId: shortlist?.missionId || null,
  uiDeviceShortlistStatus: shortlist?.status || "unknown",
  readinessBlockers: partialBlockers,
  outputs: {
    nativeLinkage: nativePath,
    servedUiDesignFidelity: fs.existsSync(servedUiFidelityPath) ? servedUiFidelityPath : null,
    iosDesignDestinationCapture: fs.existsSync(iosDesignManifestPath) ? iosDesignManifestPath : null,
    actionRuntimeBundle: fs.existsSync(actionBundlePath) ? actionBundlePath : null,
    desktopAccessibilityCapture: fs.existsSync(desktopAxCapturePath) ? desktopAxCapturePath : null,
    uiDeviceShortlist: shortlistPath,
  },
  caveat: "END-BAR requires strict UI/device readiness with real mobile, desktop, channel, timeline, stress, and negative-control evidence. This driver does not fabricate missing evidence or claim adoption.",
};
fs.writeFileSync(summaryPath, `${JSON.stringify(summary, null, 2)}\n`);
console.log(JSON.stringify(summary, null, 2));
NODE

echo "summary=${driver_summary}"
if [ "${desktop_ax_exit_code}" -ne 0 ] || [ "${shortlist_exit_code}" -ne 0 ]; then
  exit 2
fi
