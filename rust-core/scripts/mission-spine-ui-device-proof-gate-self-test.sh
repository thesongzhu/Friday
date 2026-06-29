#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root"

gate="scripts/mission-spine-ui-device-proof-gate.sh"
tmpdir="$(mktemp -d "${TMPDIR:-/tmp}/friday-ui-proof-gate-self-test.XXXXXX")"
selftest_out="$tmpdir/expect.out"
selftest_err="$tmpdir/expect.err"

expect_exit() {
  local expected="$1"
  shift
  set +e
  "$@" >"$selftest_out" 2>"$selftest_err"
  local code=$?
  set -e
  if [[ "$code" != "$expected" ]]; then
    echo "expected exit ${expected}, got ${code}: $*" >&2
    echo "--- stdout ---" >&2
    sed -n '1,80p' "$selftest_out" >&2 || true
    echo "--- stderr ---" >&2
    sed -n '1,80p' "$selftest_err" >&2 || true
    exit 1
  fi
}

write_evidence() {
  local path="$1"
  local label="$2"
  printf 'self-test evidence for %s\n' "$label" >"$path"
}

file_sha256() {
  local path="$1"
  if [[ -s "$path" ]]; then
    shasum -a 256 "$path" | awk '{print $1}'
  else
    printf '0000000000000000000000000000000000000000000000000000000000000000\n'
  fi
}

file_bytes() {
  local path="$1"
  if [[ -s "$path" ]]; then
    wc -c <"$path" | tr -d '[:space:]'
  else
    printf '1\n'
  fi
}

write_proof() {
  local path="$1"
  local mobile="$2"
  local desktop="$3"
  local channel="$4"
  local timeline="$5"
  local source="${6:-real_ui_device_consumption}"
  local fixture="${7:-false}"
  local mobile_sha desktop_sha channel_sha timeline_sha
  local mobile_bytes desktop_bytes channel_bytes timeline_bytes
  mobile_sha="$(file_sha256 "$mobile")"
  desktop_sha="$(file_sha256 "$desktop")"
  channel_sha="$(file_sha256 "$channel")"
  timeline_sha="$(file_sha256 "$timeline")"
  mobile_bytes="$(file_bytes "$mobile")"
  desktop_bytes="$(file_bytes "$desktop")"
  channel_bytes="$(file_bytes "$channel")"
  timeline_bytes="$(file_bytes "$timeline")"
  cat >"$path" <<EOF
{
  "proof": "mission_spine_ui_device_consumption",
  "proof_source": "$source",
  "fixture": $fixture,
  "captured_at_utc": "2026-06-04T21:00:00Z",
  "capture_run_id": "ui-proof-gate-self-test-run",
  "mission_id": "mission_ui_gate_self_test",
  "surfaces": {
    "mobile": {
      "mission_id": "mission_ui_gate_self_test",
      "device_class": "mobile",
      "evidence_ref": "$mobile"
    },
    "desktop": {
      "mission_id": "mission_ui_gate_self_test",
      "device_class": "desktop",
      "evidence_ref": "$desktop"
    },
    "channel": {
      "mission_id": "mission_ui_gate_self_test",
      "device_class": "channel",
      "evidence_ref": "$channel"
    }
  },
  "evidence_files": [
    {
      "role": "mobile",
      "path": "$mobile",
      "kind": "trace",
      "sha256": "$mobile_sha",
      "bytes": $mobile_bytes,
      "real_consumption": true,
      "capture_method": "self_test_real_shape_trace",
      "captured_at_utc": "2026-06-04T21:00:00Z",
      "observed_mission_id": "mission_ui_gate_self_test"
    },
    {
      "role": "desktop",
      "path": "$desktop",
      "kind": "trace",
      "sha256": "$desktop_sha",
      "bytes": $desktop_bytes,
      "real_consumption": true,
      "capture_method": "self_test_real_shape_trace",
      "captured_at_utc": "2026-06-04T21:00:00Z",
      "observed_mission_id": "mission_ui_gate_self_test"
    },
    {
      "role": "channel",
      "path": "$channel",
      "kind": "trace",
      "sha256": "$channel_sha",
      "bytes": $channel_bytes,
      "real_consumption": true,
      "capture_method": "self_test_real_shape_trace",
      "captured_at_utc": "2026-06-04T21:00:00Z",
      "observed_mission_id": "mission_ui_gate_self_test"
    },
    {
      "role": "timeline",
      "path": "$timeline",
      "kind": "trace",
      "sha256": "$timeline_sha",
      "bytes": $timeline_bytes,
      "real_consumption": true,
      "capture_method": "self_test_real_shape_trace",
      "captured_at_utc": "2026-06-04T21:00:00Z",
      "observed_mission_id": "mission_ui_gate_self_test"
    }
  ],
  "checks": {
    "same_mission_id_mobile_desktop": true,
    "same_mission_id_channel": true,
    "duplicate_blocked_opens_existing": true,
    "mission_bound_provider_action_visible": true,
    "proof_receipt_visible_before_done": true,
    "provider_ack_not_done": true,
    "pressure_20_50_consecutive_asks": true,
    "invalid_key_error_visible": true,
    "quota_error_visible": true,
    "network_error_visible": true,
    "channel_replay_blocked": true,
    "reconnect_stale_verified": true,
    "memory_candidate_not_confirmed": true,
    "no_secret_leak": true,
    "no_hidden_fallback": true
  },
  "stress": {
    "mission_bound_ask_count": 20,
    "consecutive": true,
    "duplicate_surface_count": 3,
    "provider_ack_not_done": true,
    "invalid_key_error_visible": true,
    "quota_error_visible": true,
    "network_error_visible": true,
    "long_timeline_pagination_visible": true,
    "long_timeline_page_count": 2,
    "reconnect_stale_verified": true,
    "channel_replay_blocked": true,
    "no_secret_leak": true,
    "no_hidden_fallback": true,
    "evidence_ref": "$timeline"
  },
  "timeline": {
    "bounded": true,
    "page_count": 2,
    "cursor_verified": true,
    "evidence_ref": "$timeline"
  },
  "status_labels": ["stale", "offline", "error"],
  "memory_candidates": [
    {
      "id": "memory_candidate_ui_gate_self_test",
      "confirmed": false,
      "grants_memory_authority": false
    }
  ],
  "mission_workbench": {
    "visible": true,
    "same_mission_projection_visible": true,
    "provider_ack_not_done_visible": true,
    "memory_candidate_review_only_visible": true,
    "evidence_ref": "$desktop"
  },
  "transcript_browser": {
    "visible": true,
    "collapsed_by_default": true,
    "redacted": true,
    "bounded_timeline_linked": true,
    "evidence_ref": "$desktop",
    "search_facets": [
      "mission",
      "work_item",
      "surface",
      "provider",
      "skill",
      "channel",
      "status",
      "proof_receipt",
      "time"
    ],
    "evidence_facets": [
      "providerRef",
      "skillRunRef",
      "channelRef",
      "workflowRef",
      "surfaceThreadRef",
      "timelineRef",
      "proofReceiptRef"
    ]
  },
  "event_order": [
    "mission_intake_submitted",
    "mission_resolve_or_create",
    "duplicate_preflight",
    "mission_bound_provider_action",
    "real_provider_execution",
    "proof_receipt",
    "timeline_page_1",
    "timeline_page_2",
    "same_mission_mobile_desktop_channel",
    "memory_candidate_review_only",
    "stale_offline_error_labels_verified"
  ],
  "observations": [
    {
      "surface": "mobile",
      "event": "mission_intake_submitted",
      "mission_id": "mission_ui_gate_self_test",
      "evidence_ref": "$mobile"
    },
    {
      "surface": "mobile",
      "event": "mission_intake_ready",
      "mission_id": "mission_ui_gate_self_test",
      "evidence_ref": "$mobile"
    },
    {
      "surface": "mobile",
      "event": "mission_resolve_or_create_visible",
      "mission_id": "mission_ui_gate_self_test",
      "evidence_ref": "$mobile"
    },
    {
      "surface": "desktop",
      "event": "duplicate_preflight_visible",
      "mission_id": "mission_ui_gate_self_test",
      "evidence_ref": "$desktop"
    },
    {
      "surface": "mobile",
      "event": "mission_bound_provider_action_visible",
      "mission_id": "mission_ui_gate_self_test",
      "evidence_ref": "$mobile"
    },
    {
      "surface": "desktop",
      "event": "real_provider_execution_visible",
      "mission_id": "mission_ui_gate_self_test",
      "evidence_ref": "$desktop"
    },
    {
      "surface": "mobile",
      "event": "proof_receipt_visible_before_done",
      "mission_id": "mission_ui_gate_self_test",
      "evidence_ref": "$mobile"
    },
    {
      "surface": "desktop",
      "event": "same_mission_projection_visible",
      "mission_id": "mission_ui_gate_self_test",
      "evidence_ref": "$desktop"
    },
    {
      "surface": "desktop",
      "event": "mission_workbench_visible",
      "mission_id": "mission_ui_gate_self_test",
      "evidence_ref": "$desktop"
    },
    {
      "surface": "desktop",
      "event": "transcript_browser_visible",
      "mission_id": "mission_ui_gate_self_test",
      "evidence_ref": "$desktop"
    },
    {
      "surface": "desktop",
      "event": "duplicate_blocked_opens_existing",
      "mission_id": "mission_ui_gate_self_test",
      "evidence_ref": "$desktop"
    },
    {
      "surface": "channel",
      "event": "same_mission_projection_visible",
      "mission_id": "mission_ui_gate_self_test",
      "evidence_ref": "$channel"
    },
    {
      "surface": "timeline",
      "event": "same_mission_mobile_desktop_channel_visible",
      "mission_id": "mission_ui_gate_self_test",
      "evidence_ref": "$timeline"
    },
    {
      "surface": "timeline",
      "event": "bounded_page_1_visible",
      "mission_id": "mission_ui_gate_self_test",
      "evidence_ref": "$timeline"
    },
    {
      "surface": "timeline",
      "event": "bounded_page_2_visible",
      "mission_id": "mission_ui_gate_self_test",
      "evidence_ref": "$timeline"
    },
    {
      "surface": "timeline",
      "event": "memory_candidate_review_only",
      "mission_id": "mission_ui_gate_self_test",
      "evidence_ref": "$timeline"
    },
    {
      "surface": "mobile",
      "event": "provider_ack_not_done_visible",
      "mission_id": "mission_ui_gate_self_test",
      "evidence_ref": "$mobile"
    },
    {
      "surface": "timeline",
      "event": "pressure_20_50_consecutive_asks_visible",
      "mission_id": "mission_ui_gate_self_test",
      "evidence_ref": "$timeline"
    },
    {
      "surface": "mobile",
      "event": "invalid_key_error_visible",
      "mission_id": "mission_ui_gate_self_test",
      "evidence_ref": "$mobile"
    },
    {
      "surface": "desktop",
      "event": "quota_error_visible",
      "mission_id": "mission_ui_gate_self_test",
      "evidence_ref": "$desktop"
    },
    {
      "surface": "desktop",
      "event": "network_error_visible",
      "mission_id": "mission_ui_gate_self_test",
      "evidence_ref": "$desktop"
    },
    {
      "surface": "channel",
      "event": "channel_replay_blocked_visible",
      "mission_id": "mission_ui_gate_self_test",
      "evidence_ref": "$channel"
    },
    {
      "surface": "timeline",
      "event": "reconnect_stale_verified",
      "mission_id": "mission_ui_gate_self_test",
      "evidence_ref": "$timeline"
    },
    {
      "surface": "desktop",
      "event": "real_provider_execution_receipt_visible",
      "mission_id": "mission_ui_gate_self_test",
      "evidence_ref": "$desktop"
    },
    {
      "surface": "mobile",
      "event": "stale_label_visible",
      "mission_id": "mission_ui_gate_self_test",
      "evidence_ref": "$mobile"
    },
    {
      "surface": "mobile",
      "event": "offline_label_visible",
      "mission_id": "mission_ui_gate_self_test",
      "evidence_ref": "$mobile"
    },
    {
      "surface": "desktop",
      "event": "error_label_visible",
      "mission_id": "mission_ui_gate_self_test",
      "evidence_ref": "$desktop"
    },
    {
      "surface": "timeline",
      "event": "no_hidden_fallback_verified",
      "mission_id": "mission_ui_gate_self_test",
      "evidence_ref": "$timeline"
    }
  ]
}
EOF
}

echo "[mission-spine-ui-self-test] missing env blocks"
expect_exit 2 env -u MISSION_SPINE_UI_DEVICE_PROOF "$gate"

mobile="$tmpdir/mobile.trace"
desktop="$tmpdir/desktop.trace"
channel="$tmpdir/channel.trace"
timeline="$tmpdir/timeline.trace"
negative="$tmpdir/negative-control.trace"
valid="$tmpdir/valid.json"
segmented_valid="$tmpdir/segmented-valid.json"
segmented_missing_main="$tmpdir/segmented-missing-main.json"
assembled="$tmpdir/assembled.json"
observations_manifest="$tmpdir/observations-manifest.json"
template_manifest="$tmpdir/template-observations-manifest.json"
fixture="$tmpdir/fixture.json"
organic="$tmpdir/organic.json"
placeholder="$tmpdir/placeholder.json"
pending_marker="$tmpdir/pending-marker.json"
missing_evidence="$tmpdir/missing-evidence.json"
missing_metadata="$tmpdir/missing-metadata.json"
missing_observations="$tmpdir/missing-observations.json"
missing_stress="$tmpdir/missing-stress.json"
missing_workbench="$tmpdir/missing-workbench.json"
hash_mismatch="$tmpdir/hash-mismatch.json"
bytes_mismatch="$tmpdir/bytes-mismatch.json"
secret_evidence="$tmpdir/secret-evidence.json"
template_assembled="$tmpdir/template-assembled.json"
secret_mobile="$tmpdir/secret-mobile.trace"

write_evidence "$mobile" mobile
write_evidence "$desktop" desktop
write_evidence "$channel" channel
write_evidence "$timeline" timeline
write_evidence "$negative" negative-control
write_evidence "$secret_mobile" mobile

echo "[mission-spine-ui-self-test] fixture/sample proof is rejected"
write_proof "$fixture" "$mobile" "$desktop" "$channel" "$timeline" "fixture_sample" true
expect_exit 5 env MISSION_SPINE_UI_DEVICE_PROOF="$fixture" "$gate"

echo "[mission-spine-ui-self-test] organic proof claim is rejected"
write_proof "$organic" "$mobile" "$desktop" "$channel" "$timeline"
jq '.organic = true' "$organic" >"$organic.tmp"
mv "$organic.tmp" "$organic"
expect_exit 5 env MISSION_SPINE_UI_DEVICE_PROOF="$organic" "$gate"

echo "[mission-spine-ui-self-test] placeholder/template proof is rejected"
write_proof "$placeholder" "$mobile" "$desktop" "$channel" "$timeline"
jq '.capture_run_id = "TODO_FILL_AFTER_REAL_CAPTURE_RUN"' "$placeholder" >"$placeholder.tmp"
mv "$placeholder.tmp" "$placeholder"
expect_exit 5 env MISSION_SPINE_UI_DEVICE_PROOF="$placeholder" "$gate"

echo "[mission-spine-ui-self-test] pending real-capture marker is rejected"
write_proof "$pending_marker" "$mobile" "$desktop" "$channel" "$timeline"
jq '.capture_run_id = "pending-real-capture"' "$pending_marker" >"$pending_marker.tmp"
mv "$pending_marker.tmp" "$pending_marker"
expect_exit 5 env MISSION_SPINE_UI_DEVICE_PROOF="$pending_marker" "$gate"

echo "[mission-spine-ui-self-test] missing evidence file is rejected"
write_proof "$missing_evidence" "$mobile" "$desktop" "$channel" "$tmpdir/absent-timeline.trace"
expect_exit 7 env MISSION_SPINE_UI_DEVICE_PROOF="$missing_evidence" "$gate"

echo "[mission-spine-ui-self-test] missing evidence metadata is rejected"
write_proof "$missing_metadata" "$mobile" "$desktop" "$channel" "$timeline"
jq 'del(.evidence_files[0].observed_mission_id)' "$missing_metadata" >"$missing_metadata.tmp"
mv "$missing_metadata.tmp" "$missing_metadata"
expect_exit 6 env MISSION_SPINE_UI_DEVICE_PROOF="$missing_metadata" "$gate"

echo "[mission-spine-ui-self-test] missing observation/event proof is rejected"
write_proof "$missing_observations" "$mobile" "$desktop" "$channel" "$timeline"
jq 'del(.observations)' "$missing_observations" >"$missing_observations.tmp"
mv "$missing_observations.tmp" "$missing_observations"
expect_exit 6 env MISSION_SPINE_UI_DEVICE_PROOF="$missing_observations" "$gate"

echo "[mission-spine-ui-self-test] missing pressure/failure stress proof is rejected"
write_proof "$missing_stress" "$mobile" "$desktop" "$channel" "$timeline"
jq 'del(.stress)' "$missing_stress" >"$missing_stress.tmp"
mv "$missing_stress.tmp" "$missing_stress"
expect_exit 6 env MISSION_SPINE_UI_DEVICE_PROOF="$missing_stress" "$gate"

echo "[mission-spine-ui-self-test] missing workbench/transcript desktop proof is rejected"
write_proof "$missing_workbench" "$mobile" "$desktop" "$channel" "$timeline"
jq 'del(.mission_workbench) | .transcript_browser.evidence_ref = .surfaces.mobile.evidence_ref' "$missing_workbench" >"$missing_workbench.tmp"
mv "$missing_workbench.tmp" "$missing_workbench"
expect_exit 6 env MISSION_SPINE_UI_DEVICE_PROOF="$missing_workbench" "$gate"

echo "[mission-spine-ui-self-test] evidence hash mismatch is rejected"
write_proof "$hash_mismatch" "$mobile" "$desktop" "$channel" "$timeline"
jq '.evidence_files[0].sha256 = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"' "$hash_mismatch" >"$hash_mismatch.tmp"
mv "$hash_mismatch.tmp" "$hash_mismatch"
expect_exit 8 env MISSION_SPINE_UI_DEVICE_PROOF="$hash_mismatch" "$gate"

echo "[mission-spine-ui-self-test] evidence byte count mismatch is rejected"
write_proof "$bytes_mismatch" "$mobile" "$desktop" "$channel" "$timeline"
jq '.evidence_files[0].bytes = 999999' "$bytes_mismatch" >"$bytes_mismatch.tmp"
mv "$bytes_mismatch.tmp" "$bytes_mismatch"
expect_exit 9 env MISSION_SPINE_UI_DEVICE_PROOF="$bytes_mismatch" "$gate"

echo "[mission-spine-ui-self-test] secret-bearing evidence file is rejected"
selftest_secret="PROOF_SELFTEST_SECRET_VALUE" # pragma: allowlist secret
printf '%s\n' "$selftest_secret" >>"$secret_mobile"
write_proof "$secret_evidence" "$secret_mobile" "$desktop" "$channel" "$timeline"
expect_exit 4 env \
  FRIDAY_DEEPSEEK_API_KEY="$selftest_secret" \
  MISSION_SPINE_UI_DEVICE_PROOF="$secret_evidence" \
  "$gate"

echo "[mission-spine-ui-self-test] valid real-consumption-shaped proof passes"
write_proof "$valid" "$mobile" "$desktop" "$channel" "$timeline"
env MISSION_SPINE_UI_DEVICE_PROOF="$valid" "$gate" >"$selftest_out"

echo "[mission-spine-ui-self-test] negative-control segment proof passes without polluting happy path"
negative_sha="$(file_sha256 "$negative")"
negative_bytes="$(file_bytes "$negative")"
jq \
  --arg negative "$negative" \
  --arg negative_sha "$negative_sha" \
  --argjson negative_bytes "$negative_bytes" \
  --arg negative_mission "mission_ui_gate_negative_self_test" \
  --arg captured_at "2026-06-04T21:00:00Z" \
  '
    def negative_event:
      . == "provider_ack_not_done_visible"
      or . == "pressure_20_50_consecutive_asks_visible"
      or . == "invalid_key_error_visible"
      or . == "quota_error_visible"
      or . == "network_error_visible"
      or . == "channel_replay_blocked_visible"
      or . == "reconnect_stale_verified"
      or . == "stale_label_visible"
      or . == "offline_label_visible"
      or . == "error_label_visible"
      or . == "no_hidden_fallback_verified";
    . as $proof
    | .evidence_files += [{
        role: "negative_control",
        path: $negative,
        kind: "trace",
        sha256: $negative_sha,
        bytes: $negative_bytes,
        real_consumption: true,
        capture_method: "self_test_real_negative_control_trace",
        captured_at_utc: $captured_at,
        observed_mission_id: $negative_mission
      }]
    | .negative_control_segments = [{
        segment_id: "negative-status-error-stress-self-test",
        mission_id: $negative_mission,
        truth_label: "real_ui_negative_control_segment_not_happy_path",
        happy_path: false,
        evidence_refs: [$negative],
        event_order: ["provider_ack_not_done_visible", "invalid_key_error_visible", "quota_error_visible", "network_error_visible", "stale_offline_error_labels_verified", "no_hidden_fallback_verified"],
        observations: ($proof.observations
          | map(select(.event | negative_event))
          | map(.mission_id = $negative_mission | .evidence_ref = $negative | .surface = "desktop"))
      }]
    | .observations = (
        .observations
        | map(select((.event | negative_event) | not))
        + [{
            surface: "timeline",
            event: "bounded_page_2_visible",
            mission_id: "mission_ui_gate_self_test",
            evidence_ref: $proof.timeline.evidence_ref
          }]
      )
    | .event_order = [
        "mission_intake_submitted",
        "mission_resolve_or_create",
        "duplicate_preflight",
        "mission_bound_provider_action",
        "real_provider_execution",
        "proof_receipt",
        "timeline_page_1",
        "timeline_page_2",
        "same_mission_mobile_desktop_channel",
        "memory_candidate_review_only"
      ]
    | .stress.evidence_ref = $negative
    | .mission_workbench.provider_ack_not_done_visible = false
  ' "$valid" >"$segmented_valid"
env MISSION_SPINE_UI_DEVICE_PROOF="$segmented_valid" "$gate" >"$selftest_out"

echo "[mission-spine-ui-self-test] happy-path events cannot be satisfied by negative-control segments"
jq \
  --arg negative "$negative" \
  --arg negative_mission "mission_ui_gate_negative_self_test" \
  '
    .negative_control_segments[0].observations += [{
      surface: "desktop",
      event: "mission_intake_submitted",
      mission_id: $negative_mission,
      evidence_ref: $negative
    }]
    | .observations = (.observations | map(select(.event != "mission_intake_submitted")))
  ' "$segmented_valid" >"$segmented_missing_main"
expect_exit 6 env MISSION_SPINE_UI_DEVICE_PROOF="$segmented_missing_main" "$gate"

echo "[mission-spine-ui-self-test] assembler output passes current gate"
jq '{checks, stress, timeline, mission_workbench, transcript_browser, status_labels, memory_candidates, event_order, observations}' "$valid" >"$observations_manifest"
MISSION_ID="mission_ui_gate_self_test" \
  MOBILE_EVIDENCE="$mobile" \
  DESKTOP_EVIDENCE="$desktop" \
  CHANNEL_EVIDENCE="$channel" \
  TIMELINE_EVIDENCE="$timeline" \
  OBSERVATIONS_MANIFEST="$observations_manifest" \
  OUT="$assembled" \
  scripts/mission-spine-ui-device-proof-assemble.sh >"$tmpdir/assembler.out"

echo "[mission-spine-ui-self-test] template manifest cannot assemble into accepted proof"
MISSION_ID="mission_ui_gate_self_test" \
  MOBILE_EVIDENCE_REF="$mobile" \
  DESKTOP_EVIDENCE_REF="$desktop" \
  CHANNEL_EVIDENCE_REF="$channel" \
  TIMELINE_EVIDENCE_REF="$timeline" \
  OUT="$template_manifest" \
  scripts/mission-spine-ui-observations-manifest-template.sh >"$tmpdir/template.out"
expect_exit 6 env \
  MISSION_ID="mission_ui_gate_self_test" \
  MOBILE_EVIDENCE="$mobile" \
  DESKTOP_EVIDENCE="$desktop" \
  CHANNEL_EVIDENCE="$channel" \
  TIMELINE_EVIDENCE="$timeline" \
  OBSERVATIONS_MANIFEST="$template_manifest" \
  OUT="$template_assembled" \
  scripts/mission-spine-ui-device-proof-assemble.sh

echo "[mission-spine-ui-self-test] assembler without observation manifest is rejected"
expect_exit 64 env \
  MISSION_ID="mission_ui_gate_self_test" \
  MOBILE_EVIDENCE="$mobile" \
  DESKTOP_EVIDENCE="$desktop" \
  CHANNEL_EVIDENCE="$channel" \
  TIMELINE_EVIDENCE="$timeline" \
  OUT="$assembled" \
  scripts/mission-spine-ui-device-proof-assemble.sh

rm -f "$valid" "$segmented_valid" "$segmented_missing_main" "$assembled" "$observations_manifest" "$template_manifest" "$fixture" "$organic" "$placeholder" "$pending_marker" "$missing_evidence" "$missing_metadata" "$missing_observations" "$missing_stress" "$missing_workbench" "$hash_mismatch" "$bytes_mismatch" "$secret_evidence" "$template_assembled" "$mobile" "$desktop" "$channel" "$timeline" "$negative" "$secret_mobile" "$selftest_out" "$selftest_err" "$tmpdir/assembler.out" "$tmpdir/template.out"
rmdir "$tmpdir"

echo "[mission-spine-ui-self-test] PASS"
echo "[mission-spine-ui-self-test] temp artifacts removed"
