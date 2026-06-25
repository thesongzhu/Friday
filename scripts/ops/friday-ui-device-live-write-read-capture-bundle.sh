#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat >&2 <<'EOF'
usage:
  scripts/ops/friday-ui-device-live-write-read-capture-bundle.sh --out-dir /abs/capture-root
    [--shared-id mission_ui_device_...]
    [--read-host 127.0.0.1] [--read-port 48751]
    [--write-host 127.0.0.1] [--write-port 48750]
    [--channel-capture /abs/channel-capture]
    [--timeline-capture /abs/timeline-capture]
    [--same-run-events /abs/same-run-events.jsonl]
    [--evidence-dir /abs/evidence-dir]
    [--design-action-contract /abs/ACTION-CONTRACT.md]
    [--extra-action-runtime-evidence /abs/action-runtime-evidence.json ...]

Runs the mobile and desktop live write-read capture runners with one shared
mission id, then indexes the resulting artifacts into a partial bundle.

Truth: this orchestrates real capture runners only. It does not synthesize
proof rows, does not create channel/timeline/stress observations, and does not
claim END-BAR, GO-LIVE, adoption, or operator signing completion.

When channel/timeline captures and same-run events are supplied, the script also
delegates to the existing capture-dir/preflight driver. It still never invents
missing channel, timeline, stress, or negative-control observations.
EOF
}

die() {
  echo "FATAL: $*" >&2
  exit 2
}

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
out_dir=""
read_host="${FRIDAY_MOBILE_LIVE_READ_HOST:-127.0.0.1}"
read_port="${FRIDAY_MOBILE_LIVE_READ_PORT:-48751}"
write_host="${FRIDAY_MOBILE_LIVE_WRITE_HOST:-127.0.0.1}"
write_port="${FRIDAY_MOBILE_LIVE_WRITE_PORT:-48750}"
shared_id="${FRIDAY_MISSION_SPINE_UI_PROOF_SHARED_ID:-}"
channel_capture=""
timeline_capture=""
same_run_events=""
evidence_dir=""
design_action_contract="${FRIDAY_DESIGN_ACTION_CONTRACT:-}"
extra_action_runtime_evidence=()
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
    --read-host)
      [ "$#" -ge 2 ] || die "--read-host requires a value"
      read_host="$2"
      shift 2
      ;;
    --read-host=*)
      read_host="${1#--read-host=}"
      shift
      ;;
    --read-port)
      [ "$#" -ge 2 ] || die "--read-port requires a value"
      read_port="$2"
      shift 2
      ;;
    --read-port=*)
      read_port="${1#--read-port=}"
      shift
      ;;
    --write-host)
      [ "$#" -ge 2 ] || die "--write-host requires a value"
      write_host="$2"
      shift 2
      ;;
    --write-host=*)
      write_host="${1#--write-host=}"
      shift
      ;;
    --write-port)
      [ "$#" -ge 2 ] || die "--write-port requires a value"
      write_port="$2"
      shift 2
      ;;
    --write-port=*)
      write_port="${1#--write-port=}"
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
    --same-run-events)
      [ "$#" -ge 2 ] || die "--same-run-events requires a value"
      same_run_events="$2"
      shift 2
      ;;
    --same-run-events=*)
      same_run_events="${1#--same-run-events=}"
      shift
      ;;
    --evidence-dir)
      [ "$#" -ge 2 ] || die "--evidence-dir requires a value"
      evidence_dir="$2"
      shift 2
      ;;
    --evidence-dir=*)
      evidence_dir="${1#--evidence-dir=}"
      shift
      ;;
    --design-action-contract)
      [ "$#" -ge 2 ] || die "--design-action-contract requires a value"
      design_action_contract="$2"
      shift 2
      ;;
    --design-action-contract=*)
      design_action_contract="${1#--design-action-contract=}"
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
case "${read_port}" in (*[!0-9]*|"") die "--read-port must be numeric" ;; esac
case "${write_port}" in (*[!0-9]*|"") die "--write-port must be numeric" ;; esac
for optional_path in "${channel_capture}" "${timeline_capture}" "${same_run_events}" "${evidence_dir}"; do
  if [ -n "${optional_path}" ]; then
    case "${optional_path}" in
      /*) ;;
      *) die "optional capture/evidence paths must be absolute: ${optional_path}" ;;
    esac
  fi
done
if [ -n "${design_action_contract}" ]; then
  case "${design_action_contract}" in
    /*) ;;
    *) die "--design-action-contract must be absolute: ${design_action_contract}" ;;
  esac
fi
set +u
for extra_action in "${extra_action_runtime_evidence[@]}"; do
  [ -n "${extra_action}" ] || continue
  case "${extra_action}" in
    /*) ;;
    *) die "--extra-action-runtime-evidence must be absolute: ${extra_action}" ;;
  esac
done
set -u

if [ -z "${shared_id}" ]; then
  shared_id="mission-ui-device-live-write-read-$(date -u +%Y%m%dT%H%M%SZ)-$(uuidgen | tr '[:upper:]' '[:lower:]')"
fi
case "${shared_id}" in (*[[:space:]]*) die "--shared-id must not contain whitespace" ;; esac
case "${shared_id}" in (*mission*) ;; *) die "--shared-id must contain mission" ;; esac
case "${shared_id}" in
  mission_*) canonical_shared_mission_id="${shared_id}" ;;
  *) canonical_shared_mission_id="mission_${shared_id}" ;;
esac

mobile_dir="${out_dir}/mobile"
desktop_dir="${out_dir}/desktop"
bundle_dir="${out_dir}/bundle"
if [ -z "${evidence_dir}" ]; then
  evidence_dir="${out_dir}/evidence"
fi

mkdir -p "${out_dir}"

echo "Friday UI/device live write-read capture bundle starting."
echo "out_dir=${out_dir}"
echo "shared_id=${shared_id}"
echo "truth=ui_device_live_write_read_capture_bundle_orchestrator_not_full_proof"

bash "${repo_root}/scripts/ops/friday-ios-live-write-read-capture.sh" \
  --out-dir "${mobile_dir}" \
  --read-host "${read_host}" \
  --read-port "${read_port}" \
  --write-host "${write_host}" \
  --write-port "${write_port}" \
  --shared-id "${shared_id}"

bash "${repo_root}/scripts/ops/friday-macos-live-write-read-capture.sh" \
  --out-dir "${desktop_dir}" \
  --shared-id "${shared_id}"

node "${repo_root}/scripts/ops/friday-ui-device-live-write-read-bundle.mjs" \
  --out-dir="${bundle_dir}" \
  --mobile-capture-dir="${mobile_dir}" \
  --desktop-capture-dir="${desktop_dir}" \
  --mission-id="${canonical_shared_mission_id}" \
  --require-ready

action_runtime_evidence="${bundle_dir}/action-runtime-evidence.json"
design_action_report="${bundle_dir}/design-action-runtime-gap.json"
if [ -z "${design_action_contract}" ] && [ -s "${HOME}/Desktop/friday-design-handoff-20260602/ACTION-CONTRACT.md" ]; then
  design_action_contract="${HOME}/Desktop/friday-design-handoff-20260602/ACTION-CONTRACT.md"
fi
if [ -n "${design_action_contract}" ] && [ -s "${design_action_contract}" ] && [ -s "${action_runtime_evidence}" ]; then
  design_action_args=(
    "${repo_root}/scripts/ops/check-friday-design-action-runtime-evidence.mjs"
    "--contract=${design_action_contract}"
    "--runtime-evidence=${action_runtime_evidence}"
    "--out=${design_action_report}"
  )
  set +u
  for extra_action in "${extra_action_runtime_evidence[@]}"; do
    [ -n "${extra_action}" ] || continue
    design_action_args+=("--runtime-evidence=${extra_action}")
  done
  set -u
  node "${design_action_args[@]}" >/tmp/friday-ui-device-live-write-read-design-action.$$.json
  echo "design_action_runtime=${design_action_report}"
else
  echo "design_action_runtime=skipped(no contract or action runtime evidence)"
fi

if [ -n "${channel_capture}${timeline_capture}${same_run_events}" ]; then
  [ -n "${channel_capture}" ] || die "--channel-capture is required when building an evidence dir"
  [ -n "${timeline_capture}" ] || die "--timeline-capture is required when building an evidence dir"
  [ -n "${same_run_events}" ] || die "--same-run-events is required when building an evidence dir"

  node "${repo_root}/scripts/ops/friday-ui-device-capture-dir.mjs" \
    --mission-id="${canonical_shared_mission_id}" \
    --out-dir="${evidence_dir}" \
    --mobile="${mobile_dir}/ios-live-write-read-proof.json" \
    --desktop="${desktop_dir}/macos-live-write-read-proof.json" \
    --channel="${channel_capture}" \
    --timeline="${timeline_capture}" \
    --events="${same_run_events}" \
    --require-ready

  echo "evidence=${evidence_dir}/capture-index.json"
fi

echo "PASS - same-mission mobile+desktop live write-read capture bundle written."
echo "bundle=${bundle_dir}/live-write-read-bundle-index.json"
echo "Truth: partial UI/device live write-read bundle only; not END-BAR / not GO-LIVE / not adoption."
