#!/usr/bin/env bash
#
# One-command readiness wrapper for the END-BAR UI/device proof chain.
#
# Truth boundary:
#   With no evidence inputs this is report-only and explicitly NOT a UI/device proof.
#   With all real evidence inputs it delegates to the existing assembler + final gate.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
RUST_SCRIPTS_DIR="${REPO_ROOT}/rust-core/scripts"

MODE="report-only"
RUN_LIVE_READINESS=0
RUN_SNAPSHOT_CONTRACT=0

usage() {
  cat <<'EOF'
usage:
  scripts/ops/friday-ui-device-proof-readiness.sh [--live-readiness] [--snapshot-contract] [--require-proof]

optional env for live/snapshot checks:
  FRIDAY_MISSION_WORKBENCH_URL=http://127.0.0.1:5173/mission-workbench
  MISSION_ID=mission_...
  FRIDAY_WORKBENCH_SNAPSHOT_FILE=/abs/workbench-response.json
  FRIDAY_WORKBENCH_SNAPSHOT_URL=http://127.0.0.1:3141/v1/mission-spine/workbench

real proof env, all required to assemble:
  MOBILE_EVIDENCE=/abs/mobile.trace
  DESKTOP_EVIDENCE=/abs/desktop.trace
  CHANNEL_EVIDENCE=/abs/channel.trace
  TIMELINE_EVIDENCE=/abs/timeline.trace
  OBSERVATIONS_MANIFEST=/abs/ui-observations-manifest.json
  OUT=/tmp/mission-spine-ui-device-proof.json

truth:
  Default report-only mode never writes MISSION_SPINE_UI_DEVICE_PROOF and is not END-BAR proof.
  When every evidence env is present, this delegates to the existing assembler and final gate.
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --live-readiness)
      RUN_LIVE_READINESS=1
      ;;
    --snapshot-contract)
      RUN_SNAPSHOT_CONTRACT=1
      ;;
    --require-proof)
      MODE="require-proof"
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "FATAL: unknown argument: $1" >&2
      usage >&2
      exit 64
      ;;
  esac
  shift
done

json_escape() {
  python3 -c 'import json,sys; print(json.dumps(sys.stdin.read().rstrip("\n")))' 2>/dev/null || {
    sed 's/\\/\\\\/g; s/"/\\"/g; s/^/"/; s/$/"/'
  }
}

have_all_evidence=1
for name in MISSION_ID MOBILE_EVIDENCE DESKTOP_EVIDENCE CHANNEL_EVIDENCE TIMELINE_EVIDENCE OBSERVATIONS_MANIFEST; do
  if [ -z "${!name:-}" ]; then
    have_all_evidence=0
  fi
done

blockers=()
notes=()

run_step() {
  local label="$1"
  shift
  if "$@"; then
    notes+=("${label}:pass")
  else
    local rc=$?
    blockers+=("${label}:exit_${rc}")
    return 0
  fi
}

run_step "ui_device_gate_self_test" bash "${RUST_SCRIPTS_DIR}/mission-spine-ui-device-proof-gate-self-test.sh"

if [ "${RUN_LIVE_READINESS}" = "1" ]; then
  run_step "mission_workbench_live_readiness" \
    node "${REPO_ROOT}/scripts/qa/check-mission-workbench-live-readiness.mjs" --expect-not-ready
fi

if [ "${RUN_SNAPSHOT_CONTRACT}" = "1" ]; then
  if [ -n "${FRIDAY_WORKBENCH_SNAPSHOT_FILE:-}" ]; then
    run_step "mission_workbench_snapshot_contract_file" \
      node "${REPO_ROOT}/scripts/qa/check-mission-workbench-snapshot-contract.mjs" \
        "--file=${FRIDAY_WORKBENCH_SNAPSHOT_FILE}" --expect-not-ready
  elif [ -n "${FRIDAY_WORKBENCH_SNAPSHOT_URL:-}" ]; then
    run_step "mission_workbench_snapshot_contract_url" \
      node "${REPO_ROOT}/scripts/qa/check-mission-workbench-snapshot-contract.mjs" \
        "--url=${FRIDAY_WORKBENCH_SNAPSHOT_URL}" --expect-not-ready
  else
    blockers+=("mission_workbench_snapshot_contract:missing_FRIDAY_WORKBENCH_SNAPSHOT_FILE_or_URL")
  fi
fi

if [ "${have_all_evidence}" = "1" ]; then
  run_step "ui_proof_inputs_preflight" \
    node "${REPO_ROOT}/scripts/qa/check-mission-spine-ui-proof-inputs.mjs" \
      "--mission-id=${MISSION_ID}" \
      "--mobile=${MOBILE_EVIDENCE}" \
      "--desktop=${DESKTOP_EVIDENCE}" \
      "--channel=${CHANNEL_EVIDENCE}" \
      "--timeline=${TIMELINE_EVIDENCE}" \
      "--manifest=${OBSERVATIONS_MANIFEST}"
  if [ "${#blockers[@]}" -eq 0 ]; then
    (cd "${REPO_ROOT}/rust-core" && scripts/mission-spine-ui-device-proof-assemble.sh)
    echo '{"truth":"assembled_real_ui_device_proof","status":"pass"}'
    exit 0
  fi
else
  blockers+=("ui_device_proof_evidence:missing_required_real_evidence_env")
fi

if [ "${MODE}" = "require-proof" ]; then
  printf 'FATAL: UI/device proof not assembled. blockers=%s\n' "${blockers[*]}" >&2
  exit 2
fi

printf '{\n'
printf '  "truth": "report_only_not_ui_device_proof",\n'
printf '  "status": "blocked",\n'
printf '  "notes": ['
for i in "${!notes[@]}"; do
  [ "$i" -gt 0 ] && printf ', '
  printf '%s' "$(printf '%s' "${notes[$i]}" | json_escape)"
done
printf '],\n'
printf '  "blockers": ['
for i in "${!blockers[@]}"; do
  [ "$i" -gt 0 ] && printf ', '
  printf '%s' "$(printf '%s' "${blockers[$i]}" | json_escape)"
done
printf ']\n'
printf '}\n'
