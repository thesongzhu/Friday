#!/usr/bin/env bash
set -euo pipefail

mode="${1:---full}"

case "$mode" in
  --full|--local)
    ;;
  *)
    echo "usage: $0 [--full|--local]" >&2
    exit 64
    ;;
esac

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root"

generated_at="$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
backend_live_proof_out="${MISSION_SPINE_BACKEND_LIVE_PROOF_OUT:-/tmp/friday-mission-spine-backend-live-proof.json}"
objective_coverage_out="${MISSION_SPINE_OBJECTIVE_COVERAGE_OUT:-/tmp/friday-mission-spine-objective-coverage.json}"

if [[ "$mode" == "--full" && -z "${FRIDAY_DEEPSEEK_API_KEY:-}" ]]; then
  echo "BLOCKER: FRIDAY_DEEPSEEK_API_KEY not set - cannot run full real Mission-bound provider pressure proof" >&2
  exit 2
fi

echo "[mission-spine] fmt check"
cargo fmt --all -- --check

echo "[mission-spine] tracked + untracked secret scan"
scripts/mission-spine-secret-scan-gate.sh

echo "[mission-spine] local real-HTTP pressure: 50 Mission-bound asks"
cargo test -p friday-hub \
  mission_bound_ask_real_ureq_transport_pressure_loop_paginates_and_redacts \
  -- --nocapture

echo "[mission-spine] explicit objective coverage for backend/wire/channel runtime"
scripts/mission-spine-objective-coverage-gate.sh

if [[ "$mode" == "--full" ]]; then
  echo "[mission-spine] live negative: invalid DeepSeek key has no fallback/no ledger/no done"
  cargo test -p friday-hub \
    live_invalid_deepseek_key_is_no_fallback_no_ledger_or_completion \
    -- --ignored --nocapture
else
  echo "[mission-spine] LOCAL ONLY: live invalid-key negative gate was not run."
fi

echo "[mission-spine] broad regression for mission/core/protocol/ffi/deepseek/storage"
cargo test -p friday-core -p friday-storage -p friday-hub -p friday-protocol -p friday-ffi -p friday-deepseek \
  -- --test-threads=1

echo "[mission-spine] native/wire FFI contract gate"
scripts/mission-spine-native-wire-gate.sh

if [[ "$mode" == "--local" ]]; then
  echo "[mission-spine] LOCAL ONLY: external positive DeepSeek pressure was not run."
  echo "[mission-spine] LOCAL ONLY is not a full real API/device/UI closure."
  exit 0
fi

live_asks="${FRIDAY_MISSION_LIVE_ASKS:-20}"
if [[ ! "$live_asks" =~ ^[0-9]+$ ]]; then
  live_asks="20"
fi
echo "[mission-spine] full live pressure: ${live_asks} real DeepSeek Mission-bound asks"
FRIDAY_MISSION_LIVE_ASKS="$live_asks" cargo test -p friday-hub \
  live_mission_bound_deepseek_pressure_asks_write_proof_and_bounded_timeline \
  -- --ignored --nocapture

cat >"$backend_live_proof_out" <<EOF
{
  "proof": "mission_spine_backend_api_live_pressure",
  "generated_at_utc": "$generated_at",
  "worktree": "$root",
  "status": "passed",
  "scope": "backend/API/channel runtime proof for Mission-bound asks; not real UI/device consumption proof",
  "deepseek_live_api_pressure": {
    "status": "passed",
    "real_external_api": true,
    "mission_bound_ask_count": $live_asks,
    "ask_count_contract": "20-50",
    "test_filter": "live_mission_bound_deepseek_pressure_asks_write_proof_and_bounded_timeline",
    "gate": "scripts/mission-spine-proof-gate.sh --full"
  },
  "local_real_http_pressure": {
    "status": "passed",
    "mission_bound_ask_count": 50,
    "test_filter": "mission_bound_ask_real_ureq_transport_pressure_loop_paginates_and_redacts"
  },
  "invalid_key_negative": {
    "status": "passed",
    "test_filter": "live_invalid_deepseek_key_is_no_fallback_no_ledger_or_completion",
    "asserts": ["no_hidden_fallback", "no_ledger", "no_completion"]
  },
  "objective_backend_wire_coverage": {
    "status": "passed",
    "artifact": "$objective_coverage_out"
  },
  "remaining_requirement": "real mobile/desktop/channel UI/device consumption evidence must still pass scripts/mission-spine-ui-device-proof-gate.sh"
}
EOF

echo "[mission-spine] backend live proof report written: $backend_live_proof_out"
echo "[mission-spine] FULL BACKEND/API PROOF PASSED"
