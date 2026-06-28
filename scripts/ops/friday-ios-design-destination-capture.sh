#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat >&2 <<'EOF'
usage:
  scripts/ops/friday-ios-design-destination-capture.sh --out-dir /abs/capture-dir
    [--mode design-proof-sample|live-loopback|offline-truth]
    [--destinations home,session,...]
    [--skip-initial-build]

Builds or reuses the current Friday iOS simulator app, launches the selected
mobile design destinations, captures one screenshot per destination, and writes
a manifest with truth labels.

Truth: this is a design/device capture runner. It does not claim END-BAR,
GO-LIVE, adoption, operator signing, or live workflow closure.
`offline-truth` is a negative-control lane only and is rejected by selected
visual proof gates; use `design-proof-sample` or `live-loopback` for visual proof.
EOF
}

die() {
  echo "FATAL: $*" >&2
  exit 2
}

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
out_dir=""
mode="design-proof-sample"
skip_initial_build=0
destinations_csv="home,missions,session,contextPassport,tokenLedger,shareIntake,voice,pairing,needsMe,memory,platform,providerAuth,activity,workflows,onboarding,settings,petEditor,proofViewer,entrypoints"
settle_seconds="${FRIDAY_IOS_DESIGN_CAPTURE_SETTLE_SECONDS:-6}"

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
    --mode)
      [ "$#" -ge 2 ] || die "--mode requires a value"
      mode="$2"
      shift 2
      ;;
    --mode=*)
      mode="${1#--mode=}"
      shift
      ;;
    --destinations)
      [ "$#" -ge 2 ] || die "--destinations requires a value"
      destinations_csv="$2"
      shift 2
      ;;
    --destinations=*)
      destinations_csv="${1#--destinations=}"
      shift
      ;;
    --skip-initial-build)
      skip_initial_build=1
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
case "${mode}" in
  offline|offline-truth) mode="offline-truth" ;;
  live|live-loopback) mode="live-loopback" ;;
  design|design-proof|design-proof-sample) mode="design-proof-sample" ;;
  *) die "unsupported --mode '${mode}'" ;;
esac
[ -n "${destinations_csv}" ] || die "--destinations must not be empty"
[[ "${settle_seconds}" =~ ^[0-9]+([.][0-9]+)?$ ]] || die "FRIDAY_IOS_DESIGN_CAPTURE_SETTLE_SECONDS must be numeric"

IFS=',' read -r -a destinations <<< "${destinations_csv}"
for destination in "${destinations[@]}"; do
  [[ "${destination}" =~ ^[A-Za-z][A-Za-z0-9]*$ ]] || die "invalid destination '${destination}'"
done

mkdir -p "${out_dir}/screenshots"
manifest_path="${out_dir}/ios-design-destination-capture-manifest.json"
initial_destination="${destinations[0]}"
initial_shot="${out_dir}/screenshots/${initial_destination}.png"
initial_metadata="${initial_shot}.metadata.json"

echo "Friday iOS design destination capture starting."
echo "out_dir=${out_dir}"
echo "mode=${mode}"
echo "destinations=${destinations_csv}"
echo "truth=ios_design_destination_capture_device_screenshots_not_live_closure"

if [ "${skip_initial_build}" -eq 0 ]; then
  (
    cd "${repo_root}"
    bash apps/friday-ios/build-sim.sh \
      --mode "${mode}" \
      --destination "${initial_destination}" \
      --shot "${initial_shot}"
  )
else
  echo "Skipping initial build; reusing installed com.friday.shell on a booted simulator."
fi

udid="$(xcrun simctl list devices available | grep -Eo '\(([0-9A-F-]{36})\) \(Booted\)' | grep -Eo '[0-9A-F-]{36}' | head -1 || true)"
[ -n "${udid}" ] || die "no booted simulator after build/reuse"

capture_rows=()
for destination in "${destinations[@]}"; do
  shot="${out_dir}/screenshots/${destination}.png"
  launch_log="${out_dir}/screenshots/${destination}.launch.txt"
  screenshot_log="${out_dir}/screenshots/${destination}.screenshot.txt"

  if [ "${skip_initial_build}" -eq 0 ] && [ "${destination}" = "${initial_destination}" ] && [ -s "${shot}" ]; then
    printf 'reused initial build screenshot\n' > "${launch_log}"
    printf 'reused initial build screenshot\n' > "${screenshot_log}"
  else
    launch_cmd=(xcrun simctl launch --terminate-running-process "${udid}" com.friday.shell)
    launch_args=("--initial-destination=${destination}")
    launch_env=("SIMCTL_CHILD_FRIDAY_MOBILE_INITIAL_DESTINATION=${destination}")
    if [ "${mode}" = "live-loopback" ]; then
      launch_args=(
        --live-read
        --live-write
        --live-pairing
        --live-device-keypair
        --simulator-file-device-keypair
        "${launch_args[@]}"
      )
      launch_env=(
        SIMCTL_CHILD_FRIDAY_MOBILE_LIVE_READ=1
        SIMCTL_CHILD_FRIDAY_MOBILE_LIVE_WRITE=1
        SIMCTL_CHILD_FRIDAY_MOBILE_LIVE_PAIRING=1
        SIMCTL_CHILD_FRIDAY_MOBILE_LIVE_DEVICE_KEYPAIR=1
        SIMCTL_CHILD_FRIDAY_MOBILE_SIMULATOR_FILE_DEVICE_KEYPAIR=1
        "${launch_env[@]}"
      )
      if [[ -n "${FRIDAY_MOBILE_LIVE_READ_HOST:-}" ]]; then
        launch_env+=(SIMCTL_CHILD_FRIDAY_MOBILE_LIVE_READ_HOST="${FRIDAY_MOBILE_LIVE_READ_HOST}")
      fi
      if [[ -n "${FRIDAY_MOBILE_LIVE_READ_PORT:-}" ]]; then
        launch_env+=(SIMCTL_CHILD_FRIDAY_MOBILE_LIVE_READ_PORT="${FRIDAY_MOBILE_LIVE_READ_PORT}")
      fi
      if [[ -n "${FRIDAY_MOBILE_LIVE_WRITE_HOST:-}" ]]; then
        launch_env+=(SIMCTL_CHILD_FRIDAY_MOBILE_LIVE_WRITE_HOST="${FRIDAY_MOBILE_LIVE_WRITE_HOST}")
      fi
      if [[ -n "${FRIDAY_MOBILE_LIVE_WRITE_PORT:-}" ]]; then
        launch_env+=(SIMCTL_CHILD_FRIDAY_MOBILE_LIVE_WRITE_PORT="${FRIDAY_MOBILE_LIVE_WRITE_PORT}")
      fi
    elif [ "${mode}" = "design-proof-sample" ]; then
      launch_args=(
        --design-proof-sample
        "${launch_args[@]}"
      )
      launch_env=(
        SIMCTL_CHILD_FRIDAY_MOBILE_DESIGN_PROOF_SAMPLE=1
        "${launch_env[@]}"
      )
    fi
    env "${launch_env[@]}" "${launch_cmd[@]}" "${launch_args[@]}" >"${launch_log}" 2>&1
    sleep "${settle_seconds}"
    xcrun simctl io "${udid}" screenshot "${shot}" >"${screenshot_log}" 2>&1
  fi

  [ -s "${shot}" ] || die "screenshot was not created for ${destination}: ${shot}"
  capture_rows+=("${destination}|${shot}|${launch_log}|${screenshot_log}")
done

node - "${manifest_path}" "${mode}" "${destinations_csv}" "${udid}" "${initial_metadata}" "${capture_rows[@]}" <<'NODE'
const { createHash } = require("node:crypto");
const { existsSync, readFileSync, writeFileSync } = require("node:fs");

const [manifestPath, mode, destinationsCsv, simulatorUdid, initialMetadataPath, ...rows] = process.argv.slice(2);
const sha256 = (target) => createHash("sha256").update(readFileSync(target)).digest("hex");
const captures = rows.map((row) => {
  const [destination, screenshot, launchLog, screenshotLog] = row.split("|");
  return {
    destination,
    screenshot,
    screenshot_sha256: sha256(screenshot),
    launch_log: launchLog,
    screenshot_log: screenshotLog,
    status: "captured",
  };
});
const requiredDestinations = destinationsCsv.split(",").filter(Boolean);
const seenDestinations = new Set();
const duplicateDestinations = [];
for (const destination of requiredDestinations) {
  if (seenDestinations.has(destination)) {
    duplicateDestinations.push(destination);
  }
  seenDestinations.add(destination);
}
const capturedDestinations = new Set(captures.map((capture) => capture.destination));
const missingCaptures = requiredDestinations.filter((destination) => !capturedDestinations.has(destination));
const extraCaptures = captures
  .map((capture) => capture.destination)
  .filter((destination) => !requiredDestinations.includes(destination));
const emptyScreenshots = captures
  .filter((capture) => !existsSync(capture.screenshot) || readFileSync(capture.screenshot).length === 0)
  .map((capture) => capture.destination);
const nonReadyCaptures = captures
  .filter((capture) => capture.status !== "captured")
  .map((capture) => capture.destination);
const validationErrors = [
  ...duplicateDestinations.map((destination) => `duplicate destination: ${destination}`),
  ...missingCaptures.map((destination) => `missing capture: ${destination}`),
  ...extraCaptures.map((destination) => `unexpected capture: ${destination}`),
  ...emptyScreenshots.map((destination) => `empty screenshot: ${destination}`),
  ...nonReadyCaptures.map((destination) => `non-ready capture: ${destination}`),
];

const initialMetadata = existsSync(initialMetadataPath)
  ? JSON.parse(readFileSync(initialMetadataPath, "utf8"))
  : null;

const manifest = {
  truth_label: "ios_selected_design_destination_capture_not_live_closure",
  status: validationErrors.length === 0 ? "ready" : "failed",
  generated_at_utc: new Date().toISOString(),
  mode,
  bundle_id: "com.friday.shell",
  simulator_udid: simulatorUdid,
  selected_design_source: "friday-design-handoff-20260602/saved/mobile-selection.json",
  selected_mobile_design: {
    selection_kind: "mobile-final (operator-confirmed 2026-06-04)",
    variant: "claudeCalm",
    palette: "cyanCoral",
    theme: "light",
    background: "warmOffWhite",
    form: "glassNative",
    motion: "richRestrained",
    menu_model: "commandSheet",
    platform_layout: "cardsQueues",
    token_visibility: "anomalyFirst",
    capability_truth: "matrixTruth",
    session_control_set: "fullNativeControl",
  },
  required_destinations: requiredDestinations,
  relaunch_contract: mode === "live-loopback"
    ? "each non-initial destination relaunch propagates the same live-loopback read/write/pairing/device-keypair gates as the initial build launch"
    : mode === "design-proof-sample"
      ? "each destination relaunch propagates the explicit design-proof sample gate; this is selected visual comparison only and not runtime proof"
      : "each destination relaunch keeps mobile live gates off and captures honest-unavailable truth; this negative-control lane is not selected visual proof",
  captures,
  validation: {
    missing_captures: missingCaptures,
    extra_captures: extraCaptures,
    duplicate_destinations: duplicateDestinations,
    empty_screenshots: emptyScreenshots,
    non_ready_captures: nonReadyCaptures,
  },
  initial_build_metadata: initialMetadata,
  caveat: "Device screenshots prove selected destinations launch and render truth-labeled UI states only; design-proof-sample is visual comparison only, offline-truth is negative control only, and enabled actions still require separate Hub/DB/ledger/proof closure before END-BAR.",
};

writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
if (validationErrors.length > 0) {
  console.error(`iOS destination capture manifest validation failed: ${validationErrors.join("; ")}`);
  process.exit(2);
}
NODE

echo "PASS - selected iOS design destinations captured."
echo "manifest=${manifest_path}"
echo "Truth: device screenshot manifest only; not END-BAR / not GO-LIVE / not adoption."
