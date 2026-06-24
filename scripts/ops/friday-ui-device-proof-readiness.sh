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
EVIDENCE_DIR="${FRIDAY_UI_DEVICE_PROOF_EVIDENCE_DIR:-}"

usage() {
  cat <<'EOF'
usage:
  scripts/ops/friday-ui-device-proof-readiness.sh [--live-readiness] [--snapshot-contract] [--require-proof] [--evidence-dir /abs/capture-dir]

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

evidence-dir auto-discovery:
  FRIDAY_UI_DEVICE_PROOF_EVIDENCE_DIR=/abs/capture-dir
  or --evidence-dir /abs/capture-dir

  Looks for mission-id.txt or manifest mission_id plus:
    mobile.{json,trace,log,png}
    desktop.{json,trace,log,png}
    channel.{json,trace,log,png}
    timeline.{json,trace,log,png}
    observations-manifest.json or ui-observations-manifest.json

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
    --evidence-dir)
      if [ "$#" -lt 2 ]; then
        echo "FATAL: --evidence-dir requires a value" >&2
        usage >&2
        exit 64
      fi
      EVIDENCE_DIR="$2"
      shift
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

abs_path() {
  local input="$1"
  local dir
  local base
  if [[ "$input" == /* ]]; then
    printf '%s\n' "$input"
    return
  fi
  dir="$(dirname "$input")"
  base="$(basename "$input")"
  (cd "$dir" && printf '%s/%s\n' "$(pwd -P)" "$base")
}

first_existing() {
  local candidate
  for candidate in "$@"; do
    if [ -s "$candidate" ]; then
      abs_path "$candidate"
      return 0
    fi
  done
  return 1
}

infer_mission_id_from_manifest() {
  local manifest="$1"
  jq -r '
    .mission_id
    // (.observations // [] | map(.mission_id // empty) | map(select(type == "string" and length > 0)) | first)
    // empty
  ' "$manifest" 2>/dev/null || true
}

discover_evidence_dir() {
  local dir="$1"
  local manifest
  if [ -z "$dir" ]; then
    return 0
  fi
  if [ ! -d "$dir" ]; then
    echo "FATAL: evidence dir does not exist: $dir" >&2
    exit 64
  fi
  dir="$(abs_path "$dir")"

  if [ -z "${OBSERVATIONS_MANIFEST:-}" ]; then
    OBSERVATIONS_MANIFEST="$(first_existing \
      "$dir/observations-manifest.json" \
      "$dir/ui-observations-manifest.json" \
      "$dir/mission-spine-ui-observations-manifest.json" || true)"
  fi
  manifest="${OBSERVATIONS_MANIFEST:-}"

  if [ -z "${MISSION_ID:-}" ]; then
    if [ -s "$dir/mission-id.txt" ]; then
      MISSION_ID="$(tr -d '[:space:]' <"$dir/mission-id.txt")"
    elif [ -n "$manifest" ] && [ -s "$manifest" ]; then
      MISSION_ID="$(infer_mission_id_from_manifest "$manifest")"
    fi
  fi

  if [ -z "${MOBILE_EVIDENCE:-}" ]; then
    MOBILE_EVIDENCE="$(first_existing "$dir/mobile.json" "$dir/mobile.trace" "$dir/mobile.log" "$dir/mobile.png" || true)"
  fi
  if [ -z "${DESKTOP_EVIDENCE:-}" ]; then
    DESKTOP_EVIDENCE="$(first_existing "$dir/desktop.json" "$dir/desktop.trace" "$dir/desktop.log" "$dir/desktop.png" || true)"
  fi
  if [ -z "${CHANNEL_EVIDENCE:-}" ]; then
    CHANNEL_EVIDENCE="$(first_existing "$dir/channel.json" "$dir/channel.trace" "$dir/channel.log" "$dir/channel.png" || true)"
  fi
  if [ -z "${TIMELINE_EVIDENCE:-}" ]; then
    TIMELINE_EVIDENCE="$(first_existing "$dir/timeline.json" "$dir/timeline.trace" "$dir/timeline.log" "$dir/timeline.png" || true)"
  fi
}

json_escape() {
  python3 -c 'import json,sys; print(json.dumps(sys.stdin.read().rstrip("\n")))' 2>/dev/null || {
    sed 's/\\/\\\\/g; s/"/\\"/g; s/^/"/; s/$/"/'
  }
}

discover_evidence_dir "$EVIDENCE_DIR"
export MISSION_ID="${MISSION_ID:-}"
export MOBILE_EVIDENCE="${MOBILE_EVIDENCE:-}"
export DESKTOP_EVIDENCE="${DESKTOP_EVIDENCE:-}"
export CHANNEL_EVIDENCE="${CHANNEL_EVIDENCE:-}"
export TIMELINE_EVIDENCE="${TIMELINE_EVIDENCE:-}"
export OBSERVATIONS_MANIFEST="${OBSERVATIONS_MANIFEST:-}"

have_all_evidence=1
for name in MISSION_ID MOBILE_EVIDENCE DESKTOP_EVIDENCE CHANNEL_EVIDENCE TIMELINE_EVIDENCE OBSERVATIONS_MANIFEST; do
  if [ -z "${!name:-}" ]; then
    have_all_evidence=0
  fi
done

blockers=()
notes=()

if [ -n "$EVIDENCE_DIR" ]; then
  notes+=("evidence_dir:$(abs_path "$EVIDENCE_DIR")")
fi
for name in MISSION_ID MOBILE_EVIDENCE DESKTOP_EVIDENCE CHANNEL_EVIDENCE TIMELINE_EVIDENCE OBSERVATIONS_MANIFEST; do
  if [ -n "${!name:-}" ]; then
    notes+=("resolved_${name}:${!name}")
  fi
done

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

run_step "ui_device_gate_self_test" env \
  -u MISSION_ID \
  -u MOBILE_EVIDENCE \
  -u DESKTOP_EVIDENCE \
  -u CHANNEL_EVIDENCE \
  -u TIMELINE_EVIDENCE \
  -u OBSERVATIONS_MANIFEST \
  -u MISSION_SPINE_UI_DEVICE_PROOF \
  bash "${RUST_SCRIPTS_DIR}/mission-spine-ui-device-proof-gate-self-test.sh"

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
