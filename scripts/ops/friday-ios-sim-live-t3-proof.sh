#!/usr/bin/env bash
#
# One-command iOS simulator live T3 proof.
#
# Truth boundary:
#   This builds and launches the iOS simulator app in explicit live-loopback mode, optionally
#   enrolls the simulator public read-seam peer through the existing guarded enroll helper, starts
#   a SCRATCH read-projection server on a non-prod port, relaunches the app against that scratch
#   server, captures a screenshot, and records read-only T3 provisioning status.
#
#   It never restarts or kills prod hub processes, never binds prod ports (:48751/:48750/:3141),
#   never grants write access, never mints trust_grant/context_passport, never signs, and never
#   never claims END-BAR / GO-LIVE / adoption / organic.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"

PORT="${FRIDAY_IOS_SIM_LIVE_T3_PORT:-59151}"
OWNER="${FRIDAY_IOS_SIM_LIVE_T3_OWNER:-admin-001}"
DB_PATH="${FRIDAY_IOS_SIM_LIVE_T3_DB_PATH:-${HOME}/Library/Application Support/Friday/state/rust-hub.sqlite}"
STORE_DIR="${FRIDAY_IOS_SIM_LIVE_T3_STORE_DIR:-${HOME}/.friday/agent-run-securestore}"
OUT_DIR="${FRIDAY_IOS_SIM_LIVE_T3_OUT_DIR:-${REPO_ROOT}/apps/friday-ios/.build-sim}"
SHOT="${FRIDAY_IOS_SIM_LIVE_T3_SHOT:-${OUT_DIR}/friday-ios-live-t3-ready.png}"
ENROLL=0
SERVER_PID=""

usage() {
  cat <<'USAGE'
usage:
  scripts/ops/friday-ios-sim-live-t3-proof.sh [--port <scratch-port>] [--shot <png>] [--enroll-read-seam]

truth:
  Starts hub_read_projection_server only on a scratch non-prod port.
  --enroll-read-seam delegates to friday-ios-sim-read-seam-enroll.mjs and still requires:
    FRIDAY_IOS_SIM_READ_SEAM_ENROLL_ACK=operator-approves-ios-sim-read-seam-enroll

outputs:
  <shot>.bootstrap.png
  <shot>.bootstrap.png.metadata.json
  <shot>
  <out-dir>/t3-status.json
  <out-dir>/proof-report.json
USAGE
}

fail() {
  echo "FATAL: $*" >&2
  exit 2
}

cleanup() {
  if [[ -n "${SERVER_PID}" ]]; then
    kill "${SERVER_PID}" >/dev/null 2>&1 || true
    wait "${SERVER_PID}" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

while [[ $# -gt 0 ]]; do
  case "$1" in
    --port)
      [[ $# -ge 2 ]] || fail "--port requires a value"
      PORT="$2"
      shift 2
      ;;
    --shot)
      [[ $# -ge 2 ]] || fail "--shot requires a value"
      SHOT="$2"
      OUT_DIR="$(dirname "$SHOT")"
      shift 2
      ;;
    --enroll-read-seam)
      ENROLL=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      fail "unknown argument: $1"
      ;;
  esac
done

[[ "$PORT" =~ ^[0-9]+$ ]] || fail "--port must be numeric"
case "$PORT" in
  3141|48750|48751)
    fail "refusing to bind prod Friday port $PORT; choose a scratch port"
    ;;
esac
[[ -f "$DB_PATH" ]] || fail "Rust hub DB not found: $DB_PATH"

mkdir -p "$OUT_DIR"
BOOTSTRAP_SHOT="${SHOT}.bootstrap.png"
METADATA="${BOOTSTRAP_SHOT}.metadata.json"
SERVER_LOG="${OUT_DIR}/hub-read-projection-server.log"
T3_STATUS="${OUT_DIR}/t3-status.json"
REPORT="${OUT_DIR}/proof-report.json"
BUILD_SIM_DIR="${REPO_ROOT}/apps/friday-ios/.build-sim"
BOOTSTRAP_PARENT="$(cd "$(dirname "$BOOTSTRAP_SHOT")" && pwd)"
if [[ "${BOOTSTRAP_PARENT}" == "${BUILD_SIM_DIR}/"* ]]; then
  fail "bootstrap shot cannot be nested under ${BUILD_SIM_DIR}; build-sim.sh recreates that tree"
fi

echo "== 1. build + launch iOS simulator app in live-loopback mode to materialize peer metadata =="
FRIDAY_MOBILE_LIVE_READ_HOST=127.0.0.1 \
FRIDAY_MOBILE_LIVE_READ_PORT="$PORT" \
  bash "${REPO_ROOT}/apps/friday-ios/build-sim.sh" --mode live-loopback --shot "$BOOTSTRAP_SHOT"

echo "== 2. validate simulator read-seam metadata =="
ENROLL_ARGS=(--metadata "$METADATA")
if [[ "$ENROLL" == "1" ]]; then
  ENROLL_ARGS+=(--enroll)
fi
node "${SCRIPT_DIR}/friday-ios-sim-read-seam-enroll.mjs" "${ENROLL_ARGS[@]}"

echo "== 3. start scratch read-projection server on 127.0.0.1:${PORT} =="
cargo build --release --manifest-path "${REPO_ROOT}/rust-core/Cargo.toml" --bin hub_read_projection_server
"${REPO_ROOT}/rust-core/target/release/hub_read_projection_server" \
  --db "$DB_PATH" \
  --port "$PORT" \
  --owner "$OWNER" \
  --store-dir "$STORE_DIR" \
  >"$SERVER_LOG" 2>&1 &
SERVER_PID="$!"

for _ in {1..50}; do
  if nc -z 127.0.0.1 "$PORT" >/dev/null 2>&1; then
    break
  fi
  sleep 0.2
done
nc -z 127.0.0.1 "$PORT" >/dev/null 2>&1 || {
  tail -n 80 "$SERVER_LOG" >&2 || true
  fail "scratch read-projection server did not bind 127.0.0.1:${PORT}"
}

echo "== 4. relaunch already-installed app against scratch live read server and capture final screenshot =="
UDID="$(xcrun simctl list devices available | grep -Eo '\(([0-9A-F-]{36})\) \(Booted\)' | grep -Eo '[0-9A-F-]{36}' | head -1 || true)"
if [[ -z "$UDID" ]]; then
  UDID="$(xcrun simctl list devices available | grep -E 'iPhone' | grep -Eo '[0-9A-F-]{36}' | head -1)"
  xcrun simctl boot "$UDID" || true
fi
env \
  SIMCTL_CHILD_FRIDAY_MOBILE_LIVE_READ=1 \
  SIMCTL_CHILD_FRIDAY_MOBILE_LIVE_WRITE=1 \
  SIMCTL_CHILD_FRIDAY_MOBILE_LIVE_PAIRING=1 \
  SIMCTL_CHILD_FRIDAY_MOBILE_LIVE_DEVICE_KEYPAIR=1 \
  SIMCTL_CHILD_FRIDAY_MOBILE_SIMULATOR_FILE_DEVICE_KEYPAIR=1 \
  SIMCTL_CHILD_FRIDAY_MOBILE_LIVE_READ_HOST=127.0.0.1 \
  SIMCTL_CHILD_FRIDAY_MOBILE_LIVE_READ_PORT="$PORT" \
  xcrun simctl launch --terminate-running-process "$UDID" com.friday.shell \
    --live-read --live-write --live-pairing --live-device-keypair --simulator-file-device-keypair
sleep 6
xcrun simctl io "$UDID" screenshot "$SHOT"

echo "== 5. record read-only T3 provisioning status =="
node "${SCRIPT_DIR}/friday-t3-provisioning-status.mjs" --json > "$T3_STATUS"

node - "$METADATA" "$T3_STATUS" "$REPORT" "$SHOT" "$PORT" "$SERVER_LOG" <<'NODE'
const fs = require("fs");

const [metadataPath, t3Path, reportPath, shotPath, port, serverLog] = process.argv.slice(2);
const metadata = JSON.parse(fs.readFileSync(metadataPath, "utf8"));
const t3 = JSON.parse(fs.readFileSync(t3Path, "utf8"));

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

assert(metadata.truth_label === "friday_ios_simulator_live-loopback_proof", "metadata truth label mismatch");
assert(metadata.live_read_requested === true, "live read was not requested");
assert(String(metadata.live_read_port_override) === String(port), "metadata read port override mismatch");
assert(fs.existsSync(shotPath), `final screenshot missing: ${shotPath}`);
assert(t3.t3_provisioned === true, "T3 provisioning status is not ready");
assert(t3.checks?.active_trusted_device === true, "active trusted device missing");
assert(t3.checks?.active_trust_grant === true, "active trust grant missing");
assert(t3.checks?.context_passport === true, "context passport missing");
assert(t3.checks?.context_passport_item === true, "context passport item missing");

const report = {
  truth_label: "friday_ios_simulator_live_t3_projection_proof_scratch_read_server",
  status: "pass",
  generated_at_utc: new Date().toISOString(),
  scratch_read_port: Number(port),
  screenshot: shotPath,
  bootstrap_metadata: metadataPath,
  t3_status: t3Path,
  server_log: serverLog,
  t3_counts: t3.counts,
  latest_device: t3.latest_device ?? null,
  caveat:
    "Simulator live T3 proof only. Uses a scratch read-projection server and read-only T3 status. Does not restart/kill prod hub, grant write access, mint trust_grant/context_passport, sign, prove real device, prove END-BAR, prove GO-LIVE, or prove adoption.",
};
fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
console.log(JSON.stringify(report, null, 2));
NODE

echo "proof report: $REPORT"
