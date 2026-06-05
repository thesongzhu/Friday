#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat >&2 <<'EOF'
usage:
  MISSION_ID=mission_... \
  MOBILE_EVIDENCE_REF=/abs/mobile-evidence \
  DESKTOP_EVIDENCE_REF=/abs/desktop-evidence \
  CHANNEL_EVIDENCE_REF=/abs/channel-evidence \
  TIMELINE_EVIDENCE_REF=/abs/timeline-evidence \
  OUT=/abs/ui-observations-manifest.json \
    scripts/mission-spine-ui-observations-manifest-template.sh

Writes a non-passing observations manifest template for the UI/wire proof
harness. It is intentionally marked as a template and must be filled from a
real capture run before using mission-spine-ui-device-proof-assemble.sh.
EOF
}

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  usage
  exit 0
fi

mission_id="${MISSION_ID:-TODO_FILL_AFTER_REAL_CAPTURE_MISSION_ID}"
mobile_ref="${MOBILE_EVIDENCE_REF:-TODO_FILL_AFTER_REAL_CAPTURE_MOBILE_EVIDENCE_REF}"
desktop_ref="${DESKTOP_EVIDENCE_REF:-TODO_FILL_AFTER_REAL_CAPTURE_DESKTOP_EVIDENCE_REF}"
channel_ref="${CHANNEL_EVIDENCE_REF:-TODO_FILL_AFTER_REAL_CAPTURE_CHANNEL_EVIDENCE_REF}"
timeline_ref="${TIMELINE_EVIDENCE_REF:-TODO_FILL_AFTER_REAL_CAPTURE_TIMELINE_EVIDENCE_REF}"
out="${OUT:-}"

write_template() {
  jq -n \
    --arg mission_id "$mission_id" \
    --arg mobile "$mobile_ref" \
    --arg desktop "$desktop_ref" \
    --arg channel "$channel_ref" \
    --arg timeline "$timeline_ref" \
    '{
      template: true,
      not_real_proof: true,
      fill_rule: "TODO_FILL_AFTER_REAL_CAPTURE: replace every placeholder and every false/zero proof value with facts from the same real UI/device capture run",
      checks: {
        same_mission_id_mobile_desktop: false,
        same_mission_id_channel: false,
        duplicate_blocked_opens_existing: false,
        mission_bound_provider_action_visible: false,
        proof_receipt_visible_before_done: false,
        provider_ack_not_done: false,
        pressure_20_50_consecutive_asks: false,
        invalid_key_error_visible: false,
        quota_error_visible: false,
        network_error_visible: false,
        channel_replay_blocked: false,
        reconnect_stale_verified: false,
        memory_candidate_not_confirmed: false,
        no_secret_leak: false,
        no_hidden_fallback: false
      },
      stress: {
        mission_bound_ask_count: 0,
        consecutive: false,
        duplicate_surface_count: 0,
        provider_ack_not_done: false,
        invalid_key_error_visible: false,
        quota_error_visible: false,
        network_error_visible: false,
        long_timeline_pagination_visible: false,
        long_timeline_page_count: 2,
        reconnect_stale_verified: false,
        channel_replay_blocked: false,
        no_secret_leak: false,
        no_hidden_fallback: false,
        evidence_ref: $timeline
      },
      timeline: {
        bounded: false,
        page_count: 2,
        cursor_verified: false
      },
      status_labels: ["stale", "offline", "error"],
      memory_candidates: [
        {
          id: "TODO_FILL_AFTER_REAL_CAPTURE_MEMORY_CANDIDATE_ID",
          confirmed: false,
          grants_memory_authority: false
        }
      ],
      event_order: [
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
      observations: [
        {surface: "mobile", event: "mission_intake_submitted", mission_id: $mission_id, evidence_ref: $mobile},
        {surface: "mobile", event: "mission_intake_ready", mission_id: $mission_id, evidence_ref: $mobile},
        {surface: "mobile", event: "mission_resolve_or_create_visible", mission_id: $mission_id, evidence_ref: $mobile},
        {surface: "desktop", event: "duplicate_preflight_visible", mission_id: $mission_id, evidence_ref: $desktop},
        {surface: "mobile", event: "mission_bound_provider_action_visible", mission_id: $mission_id, evidence_ref: $mobile},
        {surface: "desktop", event: "real_provider_execution_visible", mission_id: $mission_id, evidence_ref: $desktop},
        {surface: "mobile", event: "proof_receipt_visible_before_done", mission_id: $mission_id, evidence_ref: $mobile},
        {surface: "desktop", event: "same_mission_projection_visible", mission_id: $mission_id, evidence_ref: $desktop},
        {surface: "desktop", event: "duplicate_blocked_opens_existing", mission_id: $mission_id, evidence_ref: $desktop},
        {surface: "channel", event: "same_mission_projection_visible", mission_id: $mission_id, evidence_ref: $channel},
        {surface: "timeline", event: "same_mission_mobile_desktop_channel_visible", mission_id: $mission_id, evidence_ref: $timeline},
        {surface: "timeline", event: "bounded_page_1_visible", mission_id: $mission_id, evidence_ref: $timeline},
        {surface: "timeline", event: "bounded_page_2_visible", mission_id: $mission_id, evidence_ref: $timeline},
        {surface: "timeline", event: "memory_candidate_review_only", mission_id: $mission_id, evidence_ref: $timeline},
        {surface: "mobile", event: "provider_ack_not_done_visible", mission_id: $mission_id, evidence_ref: $mobile},
        {surface: "timeline", event: "pressure_20_50_consecutive_asks_visible", mission_id: $mission_id, evidence_ref: $timeline},
        {surface: "mobile", event: "invalid_key_error_visible", mission_id: $mission_id, evidence_ref: $mobile},
        {surface: "desktop", event: "quota_error_visible", mission_id: $mission_id, evidence_ref: $desktop},
        {surface: "desktop", event: "network_error_visible", mission_id: $mission_id, evidence_ref: $desktop},
        {surface: "channel", event: "channel_replay_blocked_visible", mission_id: $mission_id, evidence_ref: $channel},
        {surface: "timeline", event: "reconnect_stale_verified", mission_id: $mission_id, evidence_ref: $timeline},
        {surface: "desktop", event: "real_provider_execution_receipt_visible", mission_id: $mission_id, evidence_ref: $desktop},
        {surface: "mobile", event: "stale_label_visible", mission_id: $mission_id, evidence_ref: $mobile},
        {surface: "mobile", event: "offline_label_visible", mission_id: $mission_id, evidence_ref: $mobile},
        {surface: "desktop", event: "error_label_visible", mission_id: $mission_id, evidence_ref: $desktop},
        {surface: "timeline", event: "no_hidden_fallback_verified", mission_id: $mission_id, evidence_ref: $timeline}
      ]
    }'
}

if [[ -n "$out" ]]; then
  mkdir -p "$(dirname "$out")"
  write_template >"$out"
  echo "[mission-spine-ui-template] non-passing observations manifest template written: $out"
  echo "[mission-spine-ui-template] fill it from a real capture run; the proof gate rejects TODO/template markers"
else
  write_template
fi
