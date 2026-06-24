#!/usr/bin/env bash
#
# One-command product auto-followup live proof for the native clients.
#
# Truth boundary:
#   Runs the existing iOS + macOS product view-model live tests that drive the real mission-spine
#   write server, auto-dispatch Codex first, then require the generated Claude follow-up result to
#   appear and produce pending A1 run-outcome learning candidates. The read side uses a scratch
#   read-projection server on a non-prod port so the proof never restarts or kills prod read hub.
#
#   This writes real mission/run rows and spends real provider turns only when explicitly opted in
#   with FRIDAY_PRODUCT_AUTO_FOLLOWUP_LIVE=1. It never signs, never reads operator key material,
#   never mints trust grants/passports, never binds prod read/TS ports, and does not claim END-BAR,
#   GO-LIVE, adoption, or organic traffic.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"

READ_PORT="${FRIDAY_PRODUCT_AUTO_FOLLOWUP_READ_PORT:-59153}"
WRITE_PORT="${FRIDAY_PRODUCT_AUTO_FOLLOWUP_WRITE_PORT:-48750}"
OWNER="${FRIDAY_PRODUCT_AUTO_FOLLOWUP_OWNER:-admin-001}"
DB_PATH="${FRIDAY_PRODUCT_AUTO_FOLLOWUP_DB_PATH:-${HOME}/Library/Application Support/Friday/state/rust-hub.sqlite}"
STORE_DIR="${FRIDAY_PRODUCT_AUTO_FOLLOWUP_STORE_DIR:-${HOME}/.friday/agent-run-securestore}"
OUT_DIR="${FRIDAY_PRODUCT_AUTO_FOLLOWUP_OUT_DIR:-${REPO_ROOT}/.friday-proof/product-auto-followup}"
RUN_MOBILE=1
RUN_DESKTOP=1
SERVER_PID=""

usage() {
  cat <<'USAGE'
usage:
  FRIDAY_PRODUCT_AUTO_FOLLOWUP_LIVE=1 scripts/ops/friday-product-auto-followup-proof.sh [options]

options:
  --read-port <port>     Scratch read-projection port, never 3141/48750/48751.
  --write-port <port>    Existing live agent-run WRITE port. Defaults to 48750.
  --ios-only             Run only the iOS product auto-followup proof.
  --desktop-only         Run only the macOS product auto-followup proof.
  --out-dir <dir>        Proof artifact directory.

truth:
  Requires explicit opt-in because it writes real mission/run rows and spends real provider turns.
  Does not restart/kill prod hub, does not sign, does not mint grant/passport, and does not claim
  END-BAR, GO-LIVE, adoption, or organic traffic.
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
    --read-port)
      [[ $# -ge 2 ]] || fail "--read-port requires a value"
      READ_PORT="$2"
      shift 2
      ;;
    --write-port)
      [[ $# -ge 2 ]] || fail "--write-port requires a value"
      WRITE_PORT="$2"
      shift 2
      ;;
    --ios-only)
      RUN_MOBILE=1
      RUN_DESKTOP=0
      shift
      ;;
    --desktop-only)
      RUN_MOBILE=0
      RUN_DESKTOP=1
      shift
      ;;
    --out-dir)
      [[ $# -ge 2 ]] || fail "--out-dir requires a value"
      OUT_DIR="$2"
      shift 2
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

[[ "${FRIDAY_PRODUCT_AUTO_FOLLOWUP_LIVE:-}" == "1" ]] || {
  usage >&2
  fail "set FRIDAY_PRODUCT_AUTO_FOLLOWUP_LIVE=1 to acknowledge real provider spend and real DB writes"
}
[[ "$READ_PORT" =~ ^[0-9]+$ ]] || fail "--read-port must be numeric"
[[ "$WRITE_PORT" =~ ^[0-9]+$ ]] || fail "--write-port must be numeric"
case "$READ_PORT" in
  3141|48750|48751)
    fail "refusing to bind prod Friday port $READ_PORT for scratch read proof"
    ;;
esac
[[ -f "$DB_PATH" ]] || fail "Rust hub DB not found: $DB_PATH"

if ! nc -z 127.0.0.1 "$WRITE_PORT" >/dev/null 2>&1; then
  fail "agent-run WRITE server is not listening on 127.0.0.1:${WRITE_PORT}"
fi

mkdir -p "$OUT_DIR"
SERVER_LOG="${OUT_DIR}/hub-read-projection-server.log"
DESKTOP_LOG="${OUT_DIR}/desktop-product-auto-followup.log"
IOS_LOG="${OUT_DIR}/ios-product-auto-followup.log"
REPORT="${OUT_DIR}/proof-report.json"

echo "== 1. start scratch read-projection server on 127.0.0.1:${READ_PORT} =="
cargo build --release --manifest-path "${REPO_ROOT}/rust-core/Cargo.toml" --bin hub_read_projection_server
"${REPO_ROOT}/rust-core/target/release/hub_read_projection_server" \
  --db "$DB_PATH" \
  --port "$READ_PORT" \
  --owner "$OWNER" \
  --store-dir "$STORE_DIR" \
  >"$SERVER_LOG" 2>&1 &
SERVER_PID="$!"

for _ in {1..50}; do
  if nc -z 127.0.0.1 "$READ_PORT" >/dev/null 2>&1; then
    break
  fi
  sleep 0.2
done
nc -z 127.0.0.1 "$READ_PORT" >/dev/null 2>&1 || {
  tail -n 80 "$SERVER_LOG" >&2 || true
  fail "scratch read-projection server did not bind 127.0.0.1:${READ_PORT}"
}

if [[ "$RUN_DESKTOP" == "1" ]]; then
  echo "== 2. run desktop product auto-followup live proof =="
  FRIDAY_CONSOLE_LIVE_PRODUCT_AUTO_FOLLOWUP_RUN_TEST=1 \
  FRIDAY_CONSOLE_LIVE_PRODUCT_AUTO_FOLLOWUP_READ_PORT="$READ_PORT" \
  FRIDAY_CONSOLE_LIVE_HYBRID_FOLLOWUP_WRITE_PORT="$WRITE_PORT" \
    swift test --package-path "${REPO_ROOT}/apps/macos/FridayHubConsole" \
      --filter liveOperationsOverviewSubmitIntakeAutoDispatchesHybridClaudeFollowUp \
      2>&1 | tee "$DESKTOP_LOG"
fi

if [[ "$RUN_MOBILE" == "1" ]]; then
  echo "== 3. run iOS product auto-followup live proof =="
  FRIDAY_MOBILE_LIVE_PRODUCT_AUTO_FOLLOWUP_RUN_TEST=1 \
  FRIDAY_MOBILE_LIVE_PRODUCT_AUTO_FOLLOWUP_READ_PORT="$READ_PORT" \
  FRIDAY_MOBILE_LIVE_PRODUCT_AUTO_FOLLOWUP_WRITE_PORT="$WRITE_PORT" \
    swift test --package-path "${REPO_ROOT}/apps/friday-ios" \
      --filter liveMobileChatSendAutoDispatchesHybridClaudeFollowUp \
      2>&1 | tee "$IOS_LOG"
fi

node - "$REPORT" "$READ_PORT" "$WRITE_PORT" "$RUN_DESKTOP" "$RUN_MOBILE" "$DESKTOP_LOG" "$IOS_LOG" "$SERVER_LOG" <<'NODE'
const fs = require("fs");

const [reportPath, readPort, writePort, runDesktop, runMobile, desktopLog, iosLog, serverLog] = process.argv.slice(2);
function readMaybe(path) {
  return fs.existsSync(path) ? fs.readFileSync(path, "utf8") : "";
}
const desktopText = readMaybe(desktopLog);
const iosText = readMaybe(iosLog);
if (runDesktop === "1" && !desktopText.includes("Test liveOperationsOverviewSubmitIntakeAutoDispatchesHybridClaudeFollowUp() passed")) {
  throw new Error("desktop product auto-followup test pass line missing");
}
if (runMobile === "1" && !iosText.includes("Test liveMobileChatSendAutoDispatchesHybridClaudeFollowUp() passed")) {
  throw new Error("iOS product auto-followup test pass line missing");
}

const report = {
  truth_label: "friday_product_auto_followup_live_client_proof",
  status: "pass",
  generated_at_utc: new Date().toISOString(),
  scratch_read_port: Number(readPort),
  live_write_port: Number(writePort),
  desktop_ran: runDesktop === "1",
  ios_ran: runMobile === "1",
  desktop_log: runDesktop === "1" ? desktopLog : null,
  ios_log: runMobile === "1" ? iosLog : null,
  server_log: serverLog,
  caveat:
    "Agent-driven product proof only. Writes real mission/run rows and spends real provider turns when opted in. Does not restart/kill prod hub, sign, mint grant/passport, prove real-device use, prove END-BAR, prove GO-LIVE, prove adoption, or prove organic traffic.",
};
fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
console.log(JSON.stringify(report, null, 2));
NODE

echo "proof report: $REPORT"
