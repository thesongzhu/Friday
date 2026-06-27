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
BACKEND_LIVE_PROOF="${FRIDAY_UI_DEVICE_BACKEND_LIVE_PROOF:-}"
CHANNEL_LIVE_PROOF="${FRIDAY_UI_DEVICE_CHANNEL_LIVE_PROOF:-}"
OBJECTIVE_COVERAGE="${FRIDAY_UI_DEVICE_OBJECTIVE_COVERAGE:-}"
WORKBENCH_DB="${FRIDAY_WORKBENCH_DB_PATH:-}"
DESIGN_ACTION_CONTRACT="${FRIDAY_DESIGN_ACTION_CONTRACT:-}"
DESIGN_ACTION_RUNTIME_EVIDENCE="${FRIDAY_DESIGN_ACTION_RUNTIME_EVIDENCE:-}"
DEFER_CHANNEL_PROOF="${FRIDAY_UI_DEVICE_DEFER_CHANNEL_PROOF:-0}"
DESIGN_ACTION_RUNTIME_EVIDENCE_DIRS=()
if [ -n "${FRIDAY_DESIGN_ACTION_RUNTIME_EVIDENCE_DIRS:-}" ]; then
  IFS=':' read -r -a DESIGN_ACTION_RUNTIME_EVIDENCE_DIRS <<<"${FRIDAY_DESIGN_ACTION_RUNTIME_EVIDENCE_DIRS}"
fi

usage() {
  cat <<'EOF'
usage:
  scripts/ops/friday-ui-device-proof-readiness.sh [--live-readiness] [--snapshot-contract] [--require-proof] [--evidence-dir /abs/capture-dir]
    [--backend-live-proof /abs/backend-proof.json]
    [--channel-live-proof /abs/channel-proof.json]
    [--objective-coverage /abs/objective-coverage.json]
    [--defer-channel-proof]
    [--workbench-db /abs/rust-hub.sqlite]
    [--design-action-contract /abs/ACTION-CONTRACT.md]
    [--design-action-runtime-evidence /abs/action-runtime-evidence.json]
    [--design-action-runtime-evidence-dir /abs/evidence-dir]

optional env for live/snapshot checks:
  FRIDAY_MISSION_WORKBENCH_URL=http://127.0.0.1:5173/mission-workbench
  MISSION_ID=mission_...
  FRIDAY_WORKBENCH_SNAPSHOT_FILE=/abs/workbench-response.json
  FRIDAY_WORKBENCH_SNAPSHOT_URL=http://127.0.0.1:3141/v1/mission-spine/workbench
  FRIDAY_WORKBENCH_DB_PATH=/abs/rust-hub.sqlite

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
  FRIDAY_UI_DEVICE_BACKEND_LIVE_PROOF=/abs/backend-proof.json
  FRIDAY_UI_DEVICE_CHANNEL_LIVE_PROOF=/abs/channel-proof.json
  FRIDAY_UI_DEVICE_OBJECTIVE_COVERAGE=/abs/objective-coverage.json
  FRIDAY_UI_DEVICE_DEFER_CHANNEL_PROOF=1
  FRIDAY_WORKBENCH_DB_PATH=/abs/rust-hub.sqlite
  FRIDAY_DESIGN_ACTION_CONTRACT=/abs/ACTION-CONTRACT.md
  FRIDAY_DESIGN_ACTION_RUNTIME_EVIDENCE=/abs/action-runtime-evidence.json
  FRIDAY_DESIGN_ACTION_RUNTIME_EVIDENCE_DIRS=/abs/evidence-dir:/abs/other-dir

  Looks for mission-id.txt or manifest mission_id plus:
    mobile.{json,trace,log,png}
    desktop.{json,trace,log,png}
    channel.{json,trace,log,png}
    timeline.{json,trace,log,png}
    observations-manifest.json or ui-observations-manifest.json
    same-run-events.normalized.jsonl or same-run-events.jsonl for gap reporting
    workbench-snapshot.json or mission-workbench-snapshot.json for diagnostic event bridging
    design action runtime evidence from action-runtime-evidence.json,
      runtime-evidence-paths.txt, action-runtime-evidence-bundle-index.json,
      live-write-read-bundle-index.json, or capture-index.json.

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
    --backend-live-proof)
      if [ "$#" -lt 2 ]; then
        echo "FATAL: --backend-live-proof requires a value" >&2
        usage >&2
        exit 64
      fi
      BACKEND_LIVE_PROOF="$2"
      shift
      ;;
    --channel-live-proof)
      if [ "$#" -lt 2 ]; then
        echo "FATAL: --channel-live-proof requires a value" >&2
        usage >&2
        exit 64
      fi
      CHANNEL_LIVE_PROOF="$2"
      shift
      ;;
    --objective-coverage)
      if [ "$#" -lt 2 ]; then
        echo "FATAL: --objective-coverage requires a value" >&2
        usage >&2
        exit 64
      fi
      OBJECTIVE_COVERAGE="$2"
      shift
      ;;
    --defer-channel-proof)
      DEFER_CHANNEL_PROOF=1
      ;;
    --workbench-db)
      if [ "$#" -lt 2 ]; then
        echo "FATAL: --workbench-db requires a value" >&2
        usage >&2
        exit 64
      fi
      WORKBENCH_DB="$2"
      shift
      ;;
    --design-action-contract)
      if [ "$#" -lt 2 ]; then
        echo "FATAL: --design-action-contract requires a value" >&2
        usage >&2
        exit 64
      fi
      DESIGN_ACTION_CONTRACT="$2"
      shift
      ;;
    --design-action-runtime-evidence)
      if [ "$#" -lt 2 ]; then
        echo "FATAL: --design-action-runtime-evidence requires a value" >&2
        usage >&2
        exit 64
      fi
      DESIGN_ACTION_RUNTIME_EVIDENCE="$2"
      shift
      ;;
    --design-action-runtime-evidence-dir)
      if [ "$#" -lt 2 ]; then
        echo "FATAL: --design-action-runtime-evidence-dir requires a value" >&2
        usage >&2
        exit 64
      fi
      DESIGN_ACTION_RUNTIME_EVIDENCE_DIRS+=("$2")
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

discover_action_runtime_evidence_paths() {
  node - "$@" <<'NODE'
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

function pathsFromList(listPath) {
  if (!existingFile(listPath)) return [];
  const listDir = path.dirname(listPath);
  return fs.readFileSync(listPath, "utf8")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"))
    .map((candidate) => path.isAbsolute(candidate) ? candidate : path.resolve(listDir, candidate));
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

const found = [];
for (const rawDir of process.argv.slice(2)) {
  if (!rawDir) continue;
  const dir = path.resolve(rawDir);
  found.push(
    path.join(dir, "action-runtime-evidence.json"),
    path.join(dir, "design-action-runtime-evidence.json"),
    path.join(dir, "bundle", "action-runtime-evidence.json"),
    path.join(dir, "bundle", "design-action-runtime-evidence.json"),
    ...pathsFromList(path.join(dir, "runtime-evidence-paths.txt")),
    ...pathsFromList(path.join(dir, "bundle", "runtime-evidence-paths.txt")),
    ...pathsFromIndex(path.join(dir, "action-runtime-evidence-bundle-index.json")),
    ...pathsFromIndex(path.join(dir, "live-write-read-bundle-index.json")),
    ...pathsFromIndex(path.join(dir, "bundle", "live-write-read-bundle-index.json")),
    ...pathsFromIndex(path.join(dir, "capture-index.json")),
    ...pathsFromIndex(path.join(dir, "desktop", "capture-index.json")),
    ...pathsFromIndex(path.join(dir, "mobile", "capture-index.json")),
  );
}

for (const candidate of [...new Set(found.map((item) => path.resolve(item)))]) {
  if (existingFile(candidate)) console.log(candidate);
}
NODE
}

infer_mission_id_from_manifest() {
  local manifest="$1"
  jq -r '
    .mission_id
    // (.observations // [] | map(.mission_id // empty) | map(select(type == "string" and length > 0)) | first)
    // empty
  ' "$manifest" 2>/dev/null || true
}

infer_mission_id_from_capture_index() {
  local index="$1"
  jq -r '.mission_id // .missionId // empty' "$index" 2>/dev/null || true
}

infer_capture_index_path() {
  local index="$1"
  local query="$2"
  jq -r "$query // empty" "$index" 2>/dev/null || true
}

discover_evidence_dir() {
  local dir="$1"
  local manifest
  local capture_index
  if [ -z "$dir" ]; then
    return 0
  fi
  if [ ! -d "$dir" ]; then
    echo "FATAL: evidence dir does not exist: $dir" >&2
    exit 64
  fi
  dir="$(abs_path "$dir")"
  capture_index="$(first_existing \
    "$dir/capture-index.json" \
    "$dir/live-write-read-bundle-index.json" \
    "$dir/bundle/live-write-read-bundle-index.json" \
    "$dir/desktop/capture-index.json" \
    "$dir/mobile/capture-index.json" || true)"

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
    else
      if [ -n "$capture_index" ]; then
        MISSION_ID="$(infer_mission_id_from_capture_index "$capture_index")"
      fi
    fi
  fi

  if [ -z "${MOBILE_EVIDENCE:-}" ]; then
    MOBILE_EVIDENCE="$(first_existing \
      "$dir/mobile.json" \
      "$dir/mobile.trace" \
      "$dir/mobile.log" \
      "$dir/mobile.png" \
      "$dir/ios-live-write-read-proof.json" \
      "$dir/mobile/ios-live-write-read-proof.json" \
      "$(infer_capture_index_path "$capture_index" '.captures.mobile.proof')" || true)"
  fi
  if [ -z "${DESKTOP_EVIDENCE:-}" ]; then
    DESKTOP_EVIDENCE="$(first_existing \
      "$dir/desktop.json" \
      "$dir/desktop.trace" \
      "$dir/desktop.log" \
      "$dir/desktop.png" \
      "$dir/macos-live-write-read-proof.json" \
      "$dir/desktop/macos-live-write-read-proof.json" \
      "$(infer_capture_index_path "$capture_index" '.captures.desktop.proof')" || true)"
  fi
  if [ -z "${CHANNEL_EVIDENCE:-}" ]; then
    CHANNEL_EVIDENCE="$(first_existing \
      "$dir/channel.json" \
      "$dir/channel.trace" \
      "$dir/channel.log" \
      "$dir/channel.png" \
      "$dir/channel/channel.json" \
      "$dir/channel/channel.trace" \
      "$dir/channel/channel.log" \
      "$dir/channel/channel.png" \
      "$(infer_capture_index_path "$capture_index" '.captures.channel.proof')" \
      "$(infer_capture_index_path "$capture_index" '.captures.channel.capture')" \
      "$(infer_capture_index_path "$capture_index" '.channel.proof')" \
      "$(infer_capture_index_path "$capture_index" '.channel.capture')" || true)"
  fi
  if [ -z "${TIMELINE_EVIDENCE:-}" ]; then
    TIMELINE_EVIDENCE="$(first_existing \
      "$dir/timeline.json" \
      "$dir/timeline.trace" \
      "$dir/timeline.log" \
      "$dir/timeline.png" \
      "$dir/timeline/timeline.json" \
      "$dir/timeline/timeline.trace" \
      "$dir/timeline/timeline.log" \
      "$dir/timeline/timeline.png" \
      "$(infer_capture_index_path "$capture_index" '.captures.timeline.proof')" \
      "$(infer_capture_index_path "$capture_index" '.captures.timeline.capture')" \
      "$(infer_capture_index_path "$capture_index" '.timeline.proof')" \
      "$(infer_capture_index_path "$capture_index" '.timeline.capture')" || true)"
  fi
  if [ -z "${SAME_RUN_EVENTS:-}" ]; then
    SAME_RUN_EVENTS="$(first_existing \
      "$dir/same-run-events.normalized.jsonl" \
      "$dir/same-run-events.jsonl" \
      "$dir/events.jsonl" \
      "$dir/mobile-desktop-live-write-read-events.jsonl" \
      "$dir/bundle/mobile-desktop-live-write-read-events.jsonl" \
      "$(infer_capture_index_path "$capture_index" '.combinedEvents')" \
      "$dir/ios-live-write-read-events.jsonl" \
      "$dir/macos-live-write-read-events.jsonl" \
      "$dir/mobile/ios-live-write-read-events.jsonl" \
      "$dir/desktop/macos-live-write-read-events.jsonl" || true)"
  fi
  if [ -z "${FRIDAY_WORKBENCH_SNAPSHOT_FILE:-}" ]; then
    FRIDAY_WORKBENCH_SNAPSHOT_FILE="$(first_existing \
      "$dir/workbench-snapshot.json" \
      "$dir/mission-workbench-snapshot.json" \
      "$dir/workbench-response.json" || true)"
  fi
  if [ -z "${BACKEND_LIVE_PROOF:-}" ]; then
    BACKEND_LIVE_PROOF="$(first_existing \
      "$dir/backend-live-proof.json" \
      "$dir/backend-proof.json" \
      "$dir/mission-spine-backend-live-proof.json" || true)"
  fi
  if [ -z "${CHANNEL_LIVE_PROOF:-}" ]; then
    CHANNEL_LIVE_PROOF="$(first_existing \
      "$dir/channel-live-proof.json" \
      "$dir/channel-proof.json" \
      "$dir/mission-spine-channel-live-proof.json" || true)"
  fi
  if [ -z "${OBJECTIVE_COVERAGE:-}" ]; then
    OBJECTIVE_COVERAGE="$(first_existing \
      "$dir/objective-coverage.json" \
      "$dir/mission-spine-objective-coverage.json" \
      "$dir/mission-spine-objective-coverage-gate.json" || true)"
  fi
  if [ -z "${DESIGN_ACTION_RUNTIME_EVIDENCE:-}" ]; then
    DESIGN_ACTION_RUNTIME_EVIDENCE="$(first_existing \
      "$dir/action-runtime-evidence.json" \
      "$dir/design-action-runtime-evidence.json" \
      "$dir/bundle/action-runtime-evidence.json" \
      "$dir/bundle/design-action-runtime-evidence.json" || true)"
  fi
}

json_escape() {
  python3 -c 'import json,sys; print(json.dumps(sys.stdin.read().rstrip("\n")))' 2>/dev/null || {
    sed 's/\\/\\\\/g; s/"/\\"/g; s/^/"/; s/$/"/'
  }
}

emit_blocked_report() {
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
}

discover_evidence_dir "$EVIDENCE_DIR"
export MISSION_ID="${MISSION_ID:-}"
export MOBILE_EVIDENCE="${MOBILE_EVIDENCE:-}"
export DESKTOP_EVIDENCE="${DESKTOP_EVIDENCE:-}"
export CHANNEL_EVIDENCE="${CHANNEL_EVIDENCE:-}"
export TIMELINE_EVIDENCE="${TIMELINE_EVIDENCE:-}"
export OBSERVATIONS_MANIFEST="${OBSERVATIONS_MANIFEST:-}"
export SAME_RUN_EVENTS="${SAME_RUN_EVENTS:-}"
export FRIDAY_WORKBENCH_SNAPSHOT_FILE="${FRIDAY_WORKBENCH_SNAPSHOT_FILE:-}"
export WORKBENCH_DB="${WORKBENCH_DB:-}"
export DESIGN_ACTION_CONTRACT="${DESIGN_ACTION_CONTRACT:-}"
export DESIGN_ACTION_RUNTIME_EVIDENCE="${DESIGN_ACTION_RUNTIME_EVIDENCE:-}"

blockers=()
notes=()

derive_workbench_snapshot_if_possible() {
  if [ -n "${FRIDAY_WORKBENCH_SNAPSHOT_FILE:-}" ] || [ -n "${FRIDAY_WORKBENCH_SNAPSHOT_URL:-}" ]; then
    return 0
  fi
  if [ -z "${WORKBENCH_DB:-}" ]; then
    return 0
  fi
  if [ -z "${MISSION_ID:-}" ]; then
    blockers+=("workbench_snapshot_cli:missing_MISSION_ID")
    return 0
  fi
  if [ ! -s "${WORKBENCH_DB}" ]; then
    blockers+=("workbench_snapshot_cli:db_missing_or_empty")
    return 0
  fi

  local snapshot_out
  local stdout_out
  local stderr_out
  if [ -n "$EVIDENCE_DIR" ]; then
    snapshot_out="$(abs_path "$EVIDENCE_DIR")/workbench-snapshot.json"
  else
    snapshot_out="/tmp/friday-workbench-snapshot-${MISSION_ID}.json"
  fi
  stdout_out="${snapshot_out}.stdout"
  stderr_out="${snapshot_out}.stderr"
  mkdir -p "$(dirname "$snapshot_out")"

  if (cd "${REPO_ROOT}/rust-core" && cargo run -p friday-hub --bin mission_workbench_projection -- \
    --db "$(abs_path "$WORKBENCH_DB")" \
    --mission-id "${MISSION_ID}" >"$snapshot_out") >"$stdout_out" 2>"$stderr_out"; then
    FRIDAY_WORKBENCH_SNAPSHOT_FILE="$snapshot_out"
    export FRIDAY_WORKBENCH_SNAPSHOT_FILE
    notes+=("workbench_snapshot_cli:ready:${snapshot_out}")
  else
    local rc=$?
    blockers+=("workbench_snapshot_cli:exit_${rc}")
  fi
}

derive_workbench_events_if_possible() {
  if [ -z "${FRIDAY_WORKBENCH_SNAPSHOT_FILE:-}" ]; then
    return 0
  fi
  if [ -z "${MISSION_ID:-}" ] || [ -z "${MOBILE_EVIDENCE:-}" ] || [ -z "${DESKTOP_EVIDENCE:-}" ] || [ -z "${TIMELINE_EVIDENCE:-}" ]; then
    return 0
  fi
  if [ -z "${CHANNEL_EVIDENCE:-}" ] && [ "${DEFER_CHANNEL_PROOF}" != "1" ]; then
    return 0
  fi

  local derived_out
  local existing_events
  local merged_out
  local stdout_out
  if [ -n "$EVIDENCE_DIR" ]; then
    derived_out="$(abs_path "$EVIDENCE_DIR")/workbench-derived-events.jsonl"
    merged_out="$(abs_path "$EVIDENCE_DIR")/same-run-events.merged.jsonl"
  else
    derived_out="/tmp/friday-workbench-derived-events-${MISSION_ID}.jsonl"
    merged_out="/tmp/friday-same-run-events-merged-${MISSION_ID}.jsonl"
  fi
  stdout_out="${derived_out}.stdout"
  mkdir -p "$(dirname "$derived_out")"
  existing_events="${SAME_RUN_EVENTS:-}"

  local args=(
    "${REPO_ROOT}/scripts/ops/friday-workbench-snapshot-events.mjs"
    "--mission-id=${MISSION_ID}"
    "--file=${FRIDAY_WORKBENCH_SNAPSHOT_FILE}"
    "--mobile=${MOBILE_EVIDENCE}"
    "--desktop=${DESKTOP_EVIDENCE}"
    "--timeline=${TIMELINE_EVIDENCE}"
    "--out=${derived_out}"
  )
  if [ -n "${CHANNEL_EVIDENCE:-}" ]; then
    args+=("--channel=${CHANNEL_EVIDENCE}")
  fi
  if [ "${DEFER_CHANNEL_PROOF}" = "1" ]; then
    args+=("--defer-channel-proof")
  fi

  if node "${args[@]}" >"$stdout_out"; then
    if [ -n "$existing_events" ]; then
      awk '!seen[$0]++' "$existing_events" "$derived_out" >"$merged_out"
      SAME_RUN_EVENTS="$merged_out"
      notes+=("workbench_snapshot_events_merge:ready:${merged_out}")
    else
      SAME_RUN_EVENTS="$derived_out"
    fi
    export SAME_RUN_EVENTS
    notes+=("workbench_snapshot_events_bridge:ready:${derived_out}")
  else
    local rc=$?
    blockers+=("workbench_snapshot_events_bridge:exit_${rc}")
  fi
}

derive_channel_events_if_possible() {
  if [ -z "${CHANNEL_LIVE_PROOF:-}" ] || [ -z "${CHANNEL_EVIDENCE:-}" ] || [ -z "${MISSION_ID:-}" ]; then
    return 0
  fi

  local derived_out
  local existing_events
  local merged_out
  local stdout_out
  if [ -n "$EVIDENCE_DIR" ]; then
    derived_out="$(abs_path "$EVIDENCE_DIR")/channel-derived-events.jsonl"
    merged_out="$(abs_path "$EVIDENCE_DIR")/same-run-events.with-channel.jsonl"
  else
    derived_out="/tmp/friday-channel-derived-events-${MISSION_ID}.jsonl"
    merged_out="/tmp/friday-same-run-events-with-channel-${MISSION_ID}.jsonl"
  fi
  stdout_out="${derived_out}.stdout"
  mkdir -p "$(dirname "$derived_out")"
  existing_events="${SAME_RUN_EVENTS:-}"

  if node "${REPO_ROOT}/scripts/ops/friday-channel-proof-events.mjs" \
    "--mission-id=${MISSION_ID}" \
    "--channel-live-proof=${CHANNEL_LIVE_PROOF}" \
    "--channel-capture=${CHANNEL_EVIDENCE}" \
    "--out=${derived_out}" >"$stdout_out"; then
    if [ ! -s "$derived_out" ]; then
      notes+=("channel_proof_events_bridge:no_events")
      return 0
    fi
    if [ -n "$existing_events" ]; then
      awk '!seen[$0]++' "$existing_events" "$derived_out" >"$merged_out"
      SAME_RUN_EVENTS="$merged_out"
      notes+=("channel_proof_events_merge:ready:${merged_out}")
    else
      SAME_RUN_EVENTS="$derived_out"
    fi
    export SAME_RUN_EVENTS
    notes+=("channel_proof_events_bridge:ready:${derived_out}")
  else
    local rc=$?
    notes+=("channel_proof_events_bridge:exit_${rc}")
  fi
}

derive_workbench_snapshot_if_possible
derive_channel_events_if_possible
derive_workbench_events_if_possible

have_all_evidence=1
missing_evidence_env=()
for name in MISSION_ID MOBILE_EVIDENCE DESKTOP_EVIDENCE CHANNEL_EVIDENCE TIMELINE_EVIDENCE OBSERVATIONS_MANIFEST; do
  if [ -z "${!name:-}" ]; then
    have_all_evidence=0
    missing_evidence_env+=("$name")
  fi
done

if [ -n "$EVIDENCE_DIR" ]; then
  notes+=("evidence_dir:$(abs_path "$EVIDENCE_DIR")")
fi
for name in MISSION_ID MOBILE_EVIDENCE DESKTOP_EVIDENCE CHANNEL_EVIDENCE TIMELINE_EVIDENCE OBSERVATIONS_MANIFEST FRIDAY_WORKBENCH_SNAPSHOT_FILE WORKBENCH_DB BACKEND_LIVE_PROOF CHANNEL_LIVE_PROOF OBJECTIVE_COVERAGE; do
  if [ -n "${!name:-}" ]; then
    notes+=("resolved_${name}:${!name}")
  fi
done
if [ -n "${SAME_RUN_EVENTS:-}" ]; then
  notes+=("resolved_SAME_RUN_EVENTS:${SAME_RUN_EVENTS}")
fi
if [ -n "${DESIGN_ACTION_CONTRACT:-}" ]; then
  notes+=("resolved_DESIGN_ACTION_CONTRACT:${DESIGN_ACTION_CONTRACT}")
fi
if [ -n "${DESIGN_ACTION_RUNTIME_EVIDENCE:-}" ]; then
  notes+=("resolved_DESIGN_ACTION_RUNTIME_EVIDENCE:${DESIGN_ACTION_RUNTIME_EVIDENCE}")
fi

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

run_note_step() {
  local label="$1"
  shift
  if "$@"; then
    notes+=("${label}:pass")
  else
    local rc=$?
    notes+=("${label}:exit_${rc}")
    return 0
  fi
}

run_gap_report_if_possible() {
  if [ -z "${MISSION_ID:-}" ] || [ -z "${MOBILE_EVIDENCE:-}" ] || [ -z "${DESKTOP_EVIDENCE:-}" ] || [ -z "${TIMELINE_EVIDENCE:-}" ] || [ -z "${SAME_RUN_EVENTS:-}" ]; then
    return 0
  fi
  if [ -z "${CHANNEL_EVIDENCE:-}" ] && [ "${DEFER_CHANNEL_PROOF}" != "1" ]; then
    return 0
  fi

  local gap_out
  local stdout_out
  local status
  if [ -n "$EVIDENCE_DIR" ]; then
    gap_out="$(abs_path "$EVIDENCE_DIR")/gap-report.json"
  else
    gap_out="/tmp/friday-ui-device-proof-gap-report-${MISSION_ID}.json"
  fi
  stdout_out="${gap_out}.stdout"

  local args=(
    "${REPO_ROOT}/scripts/ops/friday-ui-device-proof-gap-report.mjs"
    "--mission-id=${MISSION_ID}"
    "--events=${SAME_RUN_EVENTS}"
    "--mobile=${MOBILE_EVIDENCE}"
    "--desktop=${DESKTOP_EVIDENCE}"
    "--timeline=${TIMELINE_EVIDENCE}"
    "--out=${gap_out}"
  )
  if [ -n "${CHANNEL_EVIDENCE:-}" ]; then
    args+=("--channel=${CHANNEL_EVIDENCE}")
  fi
  if [ "${DEFER_CHANNEL_PROOF}" = "1" ]; then
    args+=("--defer-channel-proof")
  fi
  if [ -n "${OBSERVATIONS_MANIFEST:-}" ]; then
    args+=("--manifest=${OBSERVATIONS_MANIFEST}")
  fi
  if [ -n "${BACKEND_LIVE_PROOF:-}" ]; then
    args+=("--backend-live-proof=$(abs_path "$BACKEND_LIVE_PROOF")")
  fi
  if [ -n "${CHANNEL_LIVE_PROOF:-}" ]; then
    args+=("--channel-live-proof=$(abs_path "$CHANNEL_LIVE_PROOF")")
  fi
  if [ -n "${OBJECTIVE_COVERAGE:-}" ]; then
    args+=("--objective-coverage=$(abs_path "$OBJECTIVE_COVERAGE")")
  fi

  mkdir -p "$(dirname "$gap_out")"
  if node "${args[@]}" >"$stdout_out"; then
    status="$(jq -r '.status // "unknown"' "$gap_out" 2>/dev/null || printf 'unknown')"
    notes+=("ui_device_gap_report:${status}:${gap_out}")
    local channel_deferred_only=0
    if [ "${DEFER_CHANNEL_PROOF}" = "1" ]; then
      channel_deferred_only="$(jq -r '
        (.blockers // []) as $blockers |
        (.gaps // {}) as $gaps |
        if
          ($blockers | length) == 0 and
          (($gaps.missingObservations // []) | length) == 0 and
          (($gaps.missingOrderEvents // []) | length) == 0 and
          (($gaps.missingChecks // []) | length) == 0 and
          (
            (($gaps.deferredObservations // []) | length) +
            (($gaps.deferredOrderEvents // []) | length) +
            (($gaps.deferredChecks // []) | length)
          ) > 0
        then 1 else 0 end
      ' "$gap_out" 2>/dev/null || printf '0')"
    fi
    if [ "$status" != "complete_inputs_observed" ] && [ "${MODE}" = "require-proof" ] && [ "$channel_deferred_only" != "1" ]; then
      blockers+=("ui_device_gap_report:${status}")
    fi
  else
    local rc=$?
    blockers+=("ui_device_gap_report:exit_${rc}")
  fi
}

run_design_action_gap_if_possible() {
  local contract="${DESIGN_ACTION_CONTRACT:-}"
  if [ -z "$contract" ] && [ -s "$HOME/Desktop/friday-design-handoff-20260602/ACTION-CONTRACT.md" ]; then
    contract="$HOME/Desktop/friday-design-handoff-20260602/ACTION-CONTRACT.md"
  fi
  if [ -z "$contract" ]; then
    return 0
  fi

  local design_gap_out
  local stdout_out
  local status
  local -a runtime_evidence_paths=()
  if [ -n "$EVIDENCE_DIR" ]; then
    design_gap_out="$(abs_path "$EVIDENCE_DIR")/design-action-runtime-gap.json"
  else
    design_gap_out="/tmp/friday-design-action-runtime-gap.json"
  fi
  stdout_out="${design_gap_out}.stdout"

  local args=(
    "${REPO_ROOT}/scripts/ops/check-friday-design-action-runtime-evidence.mjs"
    "--repo-root=${REPO_ROOT}"
    "--contract=$(abs_path "$contract")"
    "--out=${design_gap_out}"
  )
  if [ -n "${EVIDENCE_DIR:-}" ]; then
    args+=("--evidence-dir=$(abs_path "$EVIDENCE_DIR")")
  fi
  if [ -n "${DESIGN_ACTION_RUNTIME_EVIDENCE:-}" ]; then
    IFS=':' read -r -a runtime_evidence_paths <<<"${DESIGN_ACTION_RUNTIME_EVIDENCE}"
  fi
  set +u
  local -a discovery_dirs=()
  if [ -n "${EVIDENCE_DIR:-}" ]; then
    discovery_dirs+=("$(abs_path "$EVIDENCE_DIR")")
  fi
  for dir in "${DESIGN_ACTION_RUNTIME_EVIDENCE_DIRS[@]}"; do
    [ -n "$dir" ] || continue
    discovery_dirs+=("$(abs_path "$dir")")
  done
  if [ "${#discovery_dirs[@]}" -gt 0 ]; then
    while IFS= read -r discovered_runtime_evidence; do
      [ -n "$discovered_runtime_evidence" ] && runtime_evidence_paths+=("$discovered_runtime_evidence")
    done < <(discover_action_runtime_evidence_paths "${discovery_dirs[@]}")
  fi
  set -u
  set +u
  for runtime_evidence in "${runtime_evidence_paths[@]}"; do
    [ -n "$runtime_evidence" ] || continue
    args+=("--runtime-evidence=$(abs_path "$runtime_evidence")")
  done
  set -u

  mkdir -p "$(dirname "$design_gap_out")"
  if node "${args[@]}" >"$stdout_out"; then
    status="$(jq -r '.status // "unknown"' "$design_gap_out" 2>/dev/null || printf 'unknown')"
    notes+=("design_action_runtime_gap:${status}:${design_gap_out}")
    if [ "$status" != "runtime_actions_covered" ] && [ "${MODE}" = "require-proof" ]; then
      blockers+=("design_action_runtime_gap:${status}")
    fi
  else
    local rc=$?
    blockers+=("design_action_runtime_gap:exit_${rc}")
  fi
}

EXPECT_NOT_READY_ARGS=(--expect-not-ready)
if [ "${MODE}" = "require-proof" ]; then
  EXPECT_NOT_READY_ARGS=()
fi

run_note_step "ui_device_gate_self_test" env \
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
    node "${REPO_ROOT}/scripts/qa/check-mission-workbench-live-readiness.mjs" "${EXPECT_NOT_READY_ARGS[@]}"
fi

if [ "${RUN_SNAPSHOT_CONTRACT}" = "1" ]; then
  if [ -n "${FRIDAY_WORKBENCH_SNAPSHOT_FILE:-}" ]; then
    run_step "mission_workbench_snapshot_contract_file" \
      node "${REPO_ROOT}/scripts/qa/check-mission-workbench-snapshot-contract.mjs" \
        "--file=${FRIDAY_WORKBENCH_SNAPSHOT_FILE}" "${EXPECT_NOT_READY_ARGS[@]}"
  elif [ -n "${FRIDAY_WORKBENCH_SNAPSHOT_URL:-}" ]; then
    run_step "mission_workbench_snapshot_contract_url" \
      node "${REPO_ROOT}/scripts/qa/check-mission-workbench-snapshot-contract.mjs" \
        "--url=${FRIDAY_WORKBENCH_SNAPSHOT_URL}" "${EXPECT_NOT_READY_ARGS[@]}"
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
  if [ "${DEFER_CHANNEL_PROOF}" = "1" ] && [ "${#missing_evidence_env[@]}" -eq 1 ] && [ "${missing_evidence_env[0]}" = "CHANNEL_EVIDENCE" ]; then
    blockers+=("ui_device_proof_evidence:channel_deferred_strict_assembly_blocked")
  else
    blockers+=("ui_device_proof_evidence:missing_required_real_evidence_env")
  fi
fi

run_gap_report_if_possible
run_design_action_gap_if_possible

if [ "${MODE}" = "require-proof" ]; then
  printf 'FATAL: UI/device proof not assembled. blockers=%s\n' "${blockers[*]}" >&2
  emit_blocked_report
  exit 2
fi

emit_blocked_report
