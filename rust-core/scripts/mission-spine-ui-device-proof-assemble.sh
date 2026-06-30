#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root"

usage() {
  cat >&2 <<'EOF'
usage:
  MISSION_ID=mission_... \
  MOBILE_EVIDENCE=/abs/mobile.trace \
  DESKTOP_EVIDENCE=/abs/desktop.trace \
  CHANNEL_EVIDENCE=/abs/channel.trace \
  TIMELINE_EVIDENCE=/abs/timeline.trace \
  MOBILE_EXTRA_EVIDENCE=/abs/mobile-extra.trace[:/abs/another-mobile-extra.trace] \
  DESKTOP_EXTRA_EVIDENCE=/abs/desktop-extra.trace[:/abs/another-desktop-extra.trace] \
  CHANNEL_EXTRA_EVIDENCE=/abs/channel-extra.trace[:/abs/another-channel-extra.trace] \
  TIMELINE_EXTRA_EVIDENCE=/abs/timeline-extra.trace[:/abs/another-timeline-extra.trace] \
  SHARED_EXTRA_EVIDENCE=/abs/shared-extra.trace[:/abs/another-shared-extra.trace] \
  NEGATIVE_CONTROL_EVIDENCE_FILES=/abs/negative.trace[:/abs/another-negative.trace] \
  OBSERVATIONS_MANIFEST=/abs/ui-observations-manifest.json \
  OUT=/tmp/mission-spine-ui-device-proof.json \
  scripts/mission-spine-ui-device-proof-assemble.sh

This assembles and verifies a Mission Spine UI/device proof artifact from
already-captured evidence files. It does not make evidence real; it only binds
the supplied files with hashes, byte counts, the explicit observation manifest,
and the stress/failure manifest produced by the UI/wire proof harness. It does
not invent observations or stress results.

Use scripts/mission-spine-ui-observations-manifest-template.sh for a non-passing
template of the required manifest shape, then fill it only from the same real
UI/device capture run.
EOF
}

require_env() {
  local name="$1"
  if [[ -z "${!name:-}" ]]; then
    echo "BLOCKER: ${name} is required" >&2
    usage
    exit 64
  fi
}

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

file_sha256() {
  shasum -a 256 "$1" | awk '{print $1}'
}

file_bytes() {
  wc -c <"$1" | tr -d '[:space:]'
}

require_file() {
  local path="$1"
  local label="$2"
  if [[ ! -s "$path" ]]; then
    echo "BLOCKER: ${label} evidence file missing or empty: ${path}" >&2
    exit 2
  fi
}

require_env MISSION_ID
require_env MOBILE_EVIDENCE
require_env DESKTOP_EVIDENCE
require_env CHANNEL_EVIDENCE
require_env TIMELINE_EVIDENCE
require_env OBSERVATIONS_MANIFEST

out="${OUT:-/tmp/friday-mission-spine-ui-device-proof.json}"
captured_at="${CAPTURED_AT_UTC:-$(date -u '+%Y-%m-%dT%H:%M:%SZ')}"
capture_run_id="${CAPTURE_RUN_ID:-ui-proof-$(date -u '+%Y%m%dT%H%M%SZ')}"

mobile="$(abs_path "$MOBILE_EVIDENCE")"
desktop="$(abs_path "$DESKTOP_EVIDENCE")"
channel="$(abs_path "$CHANNEL_EVIDENCE")"
timeline="$(abs_path "$TIMELINE_EVIDENCE")"
observations_manifest="$(abs_path "$OBSERVATIONS_MANIFEST")"

require_file "$mobile" mobile
require_file "$desktop" desktop
require_file "$channel" channel
require_file "$timeline" timeline
require_file "$observations_manifest" observations_manifest

if ! jq -e . "$observations_manifest" >/dev/null; then
  echo "BLOCKER: observations manifest is not valid JSON: $observations_manifest" >&2
  exit 3
fi

if ! jq -e '
  (.checks | type == "object")
  and (.stress | type == "object")
  and (.event_order | type == "array" and length >= 10)
  and (.observations | type == "array" and length >= 18)
  and (.timeline.bounded | type == "boolean")
  and ((.timeline.page_count // 0) >= 2)
  and (.timeline.cursor_verified | type == "boolean")
  and (.status_labels | type == "array")
  and (.memory_candidates | type == "array" and length >= 1)
  and (.mission_workbench | type == "object")
  and (.mission_workbench.visible == true)
  and (.mission_workbench.same_mission_projection_visible == true)
  and (.mission_workbench.memory_candidate_review_only_visible == true)
  and (.mission_workbench.evidence_ref | type == "string" and length > 0)
  and (.transcript_browser | type == "object")
  and (.transcript_browser.visible == true)
  and (.transcript_browser.collapsed_by_default == true)
  and (.transcript_browser.redacted == true)
  and (.transcript_browser.bounded_timeline_linked == true)
  and (.transcript_browser.evidence_ref | type == "string" and length > 0)
  and (.transcript_browser.search_facets | type == "array" and length >= 9)
  and (.transcript_browser.evidence_facets | type == "array" and length >= 7)
' "$observations_manifest" >/dev/null; then
  echo "BLOCKER: observations manifest is missing required checks/timeline/status/memory/workbench/transcript/observation shape: $observations_manifest" >&2
  exit 6
fi

mobile_kind="${MOBILE_KIND:-trace}"
desktop_kind="${DESKTOP_KIND:-trace}"
channel_kind="${CHANNEL_KIND:-trace}"
timeline_kind="${TIMELINE_KIND:-trace}"

mobile_capture_method="${MOBILE_CAPTURE_METHOD:-real_device_capture}"
desktop_capture_method="${DESKTOP_CAPTURE_METHOD:-desktop_app_capture}"
channel_capture_method="${CHANNEL_CAPTURE_METHOD:-channel_live_capture}"
timeline_capture_method="${TIMELINE_CAPTURE_METHOD:-bounded_timeline_ui_capture}"

mobile_sha="$(file_sha256 "$mobile")"
desktop_sha="$(file_sha256 "$desktop")"
channel_sha="$(file_sha256 "$channel")"
timeline_sha="$(file_sha256 "$timeline")"

mobile_bytes="$(file_bytes "$mobile")"
desktop_bytes="$(file_bytes "$desktop")"
channel_bytes="$(file_bytes "$channel")"
timeline_bytes="$(file_bytes "$timeline")"

negative_evidence_json="$(mktemp "${TMPDIR:-/tmp}/friday-ui-negative-evidence.XXXXXX.json")"
extra_evidence_json="$(mktemp "${TMPDIR:-/tmp}/friday-ui-extra-evidence.XXXXXX.json")"
printf '[]\n' >"$negative_evidence_json"
printf '[]\n' >"$extra_evidence_json"
cleanup_evidence_json() {
  rm -f "$negative_evidence_json" "$extra_evidence_json"
}
trap cleanup_evidence_json EXIT

append_extra_evidence_files() {
  local surface="$1"
  local colon_list="$2"
  local kind="${3:-trace}"
  local capture_method="${4:-${surface}_extra_ui_capture}"
  local index=0
  local extra_input
  [ -n "$colon_list" ] || return 0
  IFS=':' read -r -a extra_inputs <<<"$colon_list"
  for extra_input in "${extra_inputs[@]}"; do
    if [[ -z "$extra_input" ]]; then
      continue
    fi
    index=$((index + 1))
    extra_path="$(abs_path "$extra_input")"
    require_file "$extra_path" "${surface}_extra"
    extra_sha="$(file_sha256 "$extra_path")"
    extra_bytes="$(file_bytes "$extra_path")"
    tmp_extra_evidence_json="${extra_evidence_json}.tmp"
    jq \
      --arg role "${surface}-extra-${index}" \
      --arg path "$extra_path" \
      --arg kind "$kind" \
      --arg sha "$extra_sha" \
      --argjson bytes "$extra_bytes" \
      --arg capture_method "$capture_method" \
      --arg captured_at "$captured_at" \
      --arg observed_mission_id "$MISSION_ID" \
      '. + [{
        role: $role,
        path: $path,
        kind: $kind,
        sha256: $sha,
        bytes: $bytes,
        real_consumption: true,
        capture_method: $capture_method,
        captured_at_utc: $captured_at,
        observed_mission_id: $observed_mission_id
      }]' "$extra_evidence_json" >"$tmp_extra_evidence_json"
    mv "$tmp_extra_evidence_json" "$extra_evidence_json"
  done
}

append_extra_evidence_files "mobile" "${MOBILE_EXTRA_EVIDENCE:-}" "${MOBILE_EXTRA_KIND:-trace}" "${MOBILE_EXTRA_CAPTURE_METHOD:-mobile_extra_ui_capture}"
append_extra_evidence_files "desktop" "${DESKTOP_EXTRA_EVIDENCE:-}" "${DESKTOP_EXTRA_KIND:-trace}" "${DESKTOP_EXTRA_CAPTURE_METHOD:-desktop_extra_ui_capture}"
append_extra_evidence_files "channel" "${CHANNEL_EXTRA_EVIDENCE:-}" "${CHANNEL_EXTRA_KIND:-trace}" "${CHANNEL_EXTRA_CAPTURE_METHOD:-channel_extra_ui_capture}"
append_extra_evidence_files "timeline" "${TIMELINE_EXTRA_EVIDENCE:-}" "${TIMELINE_EXTRA_KIND:-trace}" "${TIMELINE_EXTRA_CAPTURE_METHOD:-timeline_extra_ui_capture}"
append_extra_evidence_files "shared" "${SHARED_EXTRA_EVIDENCE:-}" "${SHARED_EXTRA_KIND:-trace}" "${SHARED_EXTRA_CAPTURE_METHOD:-shared_extra_ui_capture}"

if [[ -n "${NEGATIVE_CONTROL_EVIDENCE_FILES:-}" ]]; then
  IFS=':' read -r -a negative_control_evidence_files <<<"${NEGATIVE_CONTROL_EVIDENCE_FILES}"
  for negative_input in "${negative_control_evidence_files[@]}"; do
    if [[ -z "$negative_input" ]]; then
      continue
    fi
    negative_path="$(abs_path "$negative_input")"
    require_file "$negative_path" negative_control
    negative_mission_id="$(jq -r --arg path "$negative_path" '
      (.negative_control_segments // [])
      | map(select((.evidence_refs // []) | index($path)))
      | .[0].mission_id // empty
    ' "$observations_manifest")"
    if [[ -z "$negative_mission_id" ]]; then
      echo "BLOCKER: negative-control evidence is not referenced by any manifest negative_control_segments entry: $negative_path" >&2
      exit 6
    fi
    negative_sha="$(file_sha256 "$negative_path")"
    negative_bytes="$(file_bytes "$negative_path")"
    tmp_negative_evidence_json="${negative_evidence_json}.tmp"
    jq \
      --arg path "$negative_path" \
      --arg kind "${NEGATIVE_CONTROL_KIND:-trace}" \
      --arg sha "$negative_sha" \
      --argjson bytes "$negative_bytes" \
      --arg capture_method "${NEGATIVE_CONTROL_CAPTURE_METHOD:-negative_control_ui_capture}" \
      --arg captured_at "$captured_at" \
      --arg observed_mission_id "$negative_mission_id" \
      '. + [{
        role: "negative_control",
        path: $path,
        kind: $kind,
        sha256: $sha,
        bytes: $bytes,
        real_consumption: true,
        capture_method: $capture_method,
        captured_at_utc: $captured_at,
        observed_mission_id: $observed_mission_id
      }]' "$negative_evidence_json" >"$tmp_negative_evidence_json"
    mv "$tmp_negative_evidence_json" "$negative_evidence_json"
  done
fi

mkdir -p "$(dirname "$out")"

jq -n \
  --arg proof "mission_spine_ui_device_consumption" \
  --arg proof_source "real_ui_device_consumption" \
  --arg captured_at "$captured_at" \
  --arg capture_run_id "$capture_run_id" \
  --arg mission_id "$MISSION_ID" \
  --arg mobile "$mobile" \
  --arg desktop "$desktop" \
  --arg channel "$channel" \
  --arg timeline "$timeline" \
  --arg mobile_kind "$mobile_kind" \
  --arg desktop_kind "$desktop_kind" \
  --arg channel_kind "$channel_kind" \
  --arg timeline_kind "$timeline_kind" \
  --arg mobile_sha "$mobile_sha" \
  --arg desktop_sha "$desktop_sha" \
  --arg channel_sha "$channel_sha" \
  --arg timeline_sha "$timeline_sha" \
  --argjson mobile_bytes "$mobile_bytes" \
  --argjson desktop_bytes "$desktop_bytes" \
  --argjson channel_bytes "$channel_bytes" \
  --argjson timeline_bytes "$timeline_bytes" \
  --arg mobile_capture_method "$mobile_capture_method" \
  --arg desktop_capture_method "$desktop_capture_method" \
  --arg channel_capture_method "$channel_capture_method" \
  --arg timeline_capture_method "$timeline_capture_method" \
  --slurpfile manifest "$observations_manifest" \
  --slurpfile negative_evidence "$negative_evidence_json" \
  --slurpfile extra_evidence "$extra_evidence_json" \
  '($manifest[0]) as $manifest |
    {
      proof: $proof,
      proof_source: $proof_source,
      captured_at_utc: $captured_at,
      capture_run_id: $capture_run_id,
      mission_id: $mission_id,
      surfaces: {
        mobile: {
          mission_id: $mission_id,
          device_class: "mobile",
          evidence_ref: $mobile
        },
        desktop: {
          mission_id: $mission_id,
          device_class: "desktop",
          evidence_ref: $desktop
        },
        channel: {
          mission_id: $mission_id,
          device_class: "channel",
          evidence_ref: $channel
        }
      },
      evidence_files: ([
        {
          role: "mobile",
          path: $mobile,
          kind: $mobile_kind,
          sha256: $mobile_sha,
          bytes: $mobile_bytes,
          real_consumption: true,
          capture_method: $mobile_capture_method,
          captured_at_utc: $captured_at,
          observed_mission_id: $mission_id
        },
        {
          role: "desktop",
          path: $desktop,
          kind: $desktop_kind,
          sha256: $desktop_sha,
          bytes: $desktop_bytes,
          real_consumption: true,
          capture_method: $desktop_capture_method,
          captured_at_utc: $captured_at,
          observed_mission_id: $mission_id
        },
        {
          role: "channel",
          path: $channel,
          kind: $channel_kind,
          sha256: $channel_sha,
          bytes: $channel_bytes,
          real_consumption: true,
          capture_method: $channel_capture_method,
          captured_at_utc: $captured_at,
          observed_mission_id: $mission_id
        },
        {
          role: "timeline",
          path: $timeline,
          kind: $timeline_kind,
          sha256: $timeline_sha,
          bytes: $timeline_bytes,
          real_consumption: true,
          capture_method: $timeline_capture_method,
          captured_at_utc: $captured_at,
          observed_mission_id: $mission_id
        }
      ] + ($extra_evidence[0] // []) + ($negative_evidence[0] // [])),
      event_order: $manifest.event_order,
      observations: $manifest.observations,
      negative_control_segments: ($manifest.negative_control_segments // []),
      checks: $manifest.checks,
      stress: $manifest.stress,
      timeline: {
        bounded: $manifest.timeline.bounded,
        page_count: $manifest.timeline.page_count,
        cursor_verified: $manifest.timeline.cursor_verified,
        evidence_ref: $timeline
      },
      mission_workbench: $manifest.mission_workbench,
      transcript_browser: $manifest.transcript_browser,
      status_labels: $manifest.status_labels,
      memory_candidates: $manifest.memory_candidates
    }' >"$out"

echo "[mission-spine-ui-assemble] artifact written: $out"
MISSION_SPINE_UI_DEVICE_PROOF="$out" scripts/mission-spine-ui-device-proof-gate.sh
