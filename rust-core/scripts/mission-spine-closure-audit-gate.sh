#!/usr/bin/env bash
set -euo pipefail

mode="${1:---report}"

case "$mode" in
  --report|--strict)
    ;;
  *)
    echo "usage: $0 [--report|--strict]" >&2
    exit 64
    ;;
esac

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root"

report_out="${MISSION_SPINE_CLOSURE_REPORT_OUT:-/tmp/friday-mission-spine-closure-status.json}"
backend_live_proof_out="${MISSION_SPINE_BACKEND_LIVE_PROOF_OUT:-/tmp/friday-mission-spine-backend-live-proof.json}"
channel_live_proof_out="${MISSION_SPINE_CHANNEL_LIVE_PROOF_OUT:-/tmp/friday-mission-spine-channel-live-proof.json}"
telegram_raw_proof_out="${TELEGRAM_PROOF_OUT:-/tmp/friday-telegram-live-proof.json}"
uiux_closure_report_in="${MISSION_SPINE_UIUX_CLOSURE_REPORT:-}"
generated_at="$(date -u '+%Y-%m-%dT%H:%M:%SZ')"

deepseek_status="blocked_missing_key"
telegram_status="blocked_missing_token"
ui_device_gate_self_test_status="not_run"
ui_device_status="not_proven"
objective_coverage_status="not_run"
backend_live_proof_available="false"
backend_live_proof_status="missing"
backend_live_proof_generated_at=""
channel_live_proof_available="false"
channel_live_proof_status="missing"
channel_live_proof_generated_at=""
channel_live_proof_artifact="$channel_live_proof_out"
channel_live_proof_source="standard"
full_goal_complete="false"
strict_exit=0
deepseek_env_present="false"
deepseek_live_gate_executed="false"
telegram_token_present="false"
telegram_allowed_user_present="false"
telegram_live_gate_executed="false"
ui_device_proof_present="false"
ui_device_gate_executed="false"
uiux_closure_report_present="false"
uiux_closure_report_status="not_provided"
uiux_non_channel_status="not_provided"
uiux_non_channel_inputs_resolved="false"
uiux_channel_deferred_strict_assembly="false"
uiux_report_notes_json="[]"
uiux_report_blockers_json="[]"

echo "[mission-spine-closure] local backend + native/wire proof"
scripts/mission-spine-proof-gate.sh --local
local_status="passed"
objective_coverage_status="passed"

echo "[mission-spine-closure] UI/device proof gate self-test"
if scripts/mission-spine-ui-device-proof-gate-self-test.sh; then
  ui_device_gate_self_test_status="passed"
else
  ui_device_gate_self_test_status="failed"
  strict_exit=2
fi

if [[ -n "${FRIDAY_DEEPSEEK_API_KEY:-}" ]]; then
  deepseek_env_present="true"
  deepseek_status="not_run_key_present"
  if [[ "$mode" == "--strict" ]]; then
    echo "[mission-spine-closure] strict DeepSeek live API pressure"
    deepseek_live_gate_executed="true"
    scripts/mission-spine-proof-gate.sh --full
    deepseek_status="passed"
  fi
elif [[ "$mode" == "--strict" ]]; then
  strict_exit=2
fi

if [[ -n "${FRIDAY_TELEGRAM_BOT_TOKEN:-}" ]]; then
  telegram_token_present="true"
fi

if [[ -n "${FRIDAY_TELEGRAM_ALLOWED_USER_ID:-}" ]]; then
  telegram_allowed_user_present="true"
fi

if [[ -z "${FRIDAY_TELEGRAM_BOT_TOKEN:-}" ]]; then
  telegram_status="blocked_missing_token"
  if [[ "$mode" == "--strict" ]]; then
    strict_exit=2
  fi
elif [[ -z "${FRIDAY_TELEGRAM_ALLOWED_USER_ID:-}" ]]; then
  telegram_status="blocked_missing_allowed_user"
  if [[ "$mode" == "--strict" ]]; then
    strict_exit=2
  fi
else
  telegram_status="not_run_env_present"
  if [[ "$mode" == "--strict" ]]; then
    echo "[mission-spine-closure] strict Telegram/channel live proof"
    telegram_live_gate_executed="true"
    scripts/mission-spine-channel-live-gate.sh
    telegram_status="passed"
  fi
fi

if [[ -n "${MISSION_SPINE_UI_DEVICE_PROOF:-}" ]]; then
  ui_device_proof_present="true"
  ui_device_gate_executed="true"
  if scripts/mission-spine-ui-device-proof-gate.sh; then
    ui_device_status="passed"
  else
    ui_device_status="proof_invalid"
    if [[ "$mode" == "--strict" ]]; then
      strict_exit=2
    fi
  fi
else
  ui_device_status="not_proven"
  if [[ "$mode" == "--strict" ]]; then
    strict_exit=2
  fi
fi

if [[ -s "$backend_live_proof_out" ]] \
  && jq -e '.proof == "mission_spine_backend_api_live_pressure" and .status == "passed"' "$backend_live_proof_out" >/dev/null; then
  backend_live_proof_available="true"
  backend_live_proof_status="passed"
  backend_live_proof_generated_at="$(jq -r '.generated_at_utc // ""' "$backend_live_proof_out")"
fi

if [[ "$mode" == "--report" && "$backend_live_proof_status" == "passed" && "$deepseek_status" != "passed" ]]; then
  deepseek_status="satisfied_by_last_backend_live_proof"
fi

if [[ -n "$uiux_closure_report_in" ]]; then
  uiux_closure_report_present="true"
  if [[ ! -s "$uiux_closure_report_in" ]]; then
    uiux_closure_report_status="artifact_missing_or_empty"
  elif ! jq -e . "$uiux_closure_report_in" >/dev/null; then
    uiux_closure_report_status="artifact_invalid_json"
  else
    uiux_closure_report_status="$(jq -r '.status // "unknown"' "$uiux_closure_report_in")"
    uiux_non_channel_status="$(jq -r '.stages.nonChannelClosure.status // "missing"' "$uiux_closure_report_in")"
    uiux_non_channel_inputs_resolved="$(jq -r 'if .stages.nonChannelClosure.nonChannelInputsResolved == true then "true" else "false" end' "$uiux_closure_report_in")"
    uiux_channel_deferred_strict_assembly="$(jq -r 'if .stages.nonChannelClosure.channelDeferredStrictAssembly == true then "true" else "false" end' "$uiux_closure_report_in")"
    uiux_report_notes_json="$(jq -c '(.notes // [])' "$uiux_closure_report_in")"
    uiux_report_blockers_json="$(jq -c '(.blockers // [])' "$uiux_closure_report_in")"
  fi
fi

if [[ -s "$channel_live_proof_out" ]] \
  && jq -e '.proof == "mission_spine_channel_live_proof" and .status == "passed"' "$channel_live_proof_out" >/dev/null; then
  channel_live_proof_available="true"
  channel_live_proof_status="passed"
  channel_live_proof_generated_at="$(jq -r '.generated_at_utc // ""' "$channel_live_proof_out")"
elif [[ -s "$telegram_raw_proof_out" ]] \
  && jq -e '
    .proof == "telegram_inbound_through_rust_channels_pipeline"
    and .sender_id_present == true
    and .sender_allowlisted == true
    and .bearer_auth_accepted_correct == true
    and .forged_bearer_rejected == true
    and .non_allowlisted_sender_rejected == true
  ' "$telegram_raw_proof_out" >/dev/null; then
  channel_live_proof_available="false"
  channel_live_proof_status="blocked_legacy_raw_artifact_requires_redacted_wrapper"
  channel_live_proof_artifact="$telegram_raw_proof_out"
  channel_live_proof_source="legacy_raw_rejected"
fi

if [[ "$local_status" == "passed" \
  && "$ui_device_gate_self_test_status" == "passed" \
  && "$deepseek_status" == "passed" \
  && "$telegram_status" == "passed" \
  && "$ui_device_status" == "passed" ]]; then
  full_goal_complete="true"
fi

cat > "$report_out" <<EOF
{
  "generated_at_utc": "$generated_at",
  "worktree": "$root",
  "mode": "$mode",
  "local_backend_native_wire": {
    "status": "$local_status",
    "gate": "scripts/mission-spine-proof-gate.sh --local"
  },
  "objective_backend_wire_coverage": {
    "status": "$objective_coverage_status",
    "gate": "scripts/mission-spine-objective-coverage-gate.sh",
    "artifact": "${MISSION_SPINE_OBJECTIVE_COVERAGE_OUT:-/tmp/friday-mission-spine-objective-coverage.json}",
    "scope": "explicit coverage for mobile/desktop/channel input, Mission duplicate preflight, Mission-bound provider action, bounded timeline, memory boundary, stale/offline/error labels, reconnect, channel replay, no secret leak, and no hidden fallback; not real UI/device proof"
  },
  "last_backend_live_proof": {
    "status": "$backend_live_proof_status",
    "available": $backend_live_proof_available,
    "artifact": "$backend_live_proof_out",
    "generated_at_utc": "$backend_live_proof_generated_at",
    "scope": "machine-readable artifact written by scripts/mission-spine-proof-gate.sh --full after real DeepSeek API pressure passes; report mode does not rerun live positive gates"
  },
  "ui_device_gate_self_test": {
    "status": "$ui_device_gate_self_test_status",
    "gate": "scripts/mission-spine-ui-device-proof-gate-self-test.sh",
    "scope": "regression-tests the UI/device proof gate; not real UI/device proof"
  },
  "deepseek_live_api_pressure": {
    "status": "$deepseek_status",
    "gate": "scripts/mission-spine-proof-gate.sh --full",
    "env_present": $deepseek_env_present,
    "live_gate_executed": $deepseek_live_gate_executed,
    "required_env": ["FRIDAY_DEEPSEEK_API_KEY"],
    "required_scope": "20-50 real Mission-bound asks against the external DeepSeek account"
  },
  "telegram_channel_live": {
    "status": "$telegram_status",
    "gate": "scripts/mission-spine-channel-live-gate.sh",
    "token_env_present": $telegram_token_present,
    "allowed_user_env_present": $telegram_allowed_user_present,
    "live_gate_executed": $telegram_live_gate_executed,
    "required_env": ["FRIDAY_TELEGRAM_BOT_TOKEN", "FRIDAY_TELEGRAM_ALLOWED_USER_ID"],
    "required_scope": "one real allowlisted Telegram message through the inbound channel pipeline"
  },
  "last_channel_live_proof": {
    "status": "$channel_live_proof_status",
    "available": $channel_live_proof_available,
    "artifact": "$channel_live_proof_artifact",
    "source": "$channel_live_proof_source",
    "generated_at_utc": "$channel_live_proof_generated_at",
    "scope": "machine-readable redacted wrapper artifact written by scripts/mission-spine-channel-live-gate.sh after real Telegram/channel proof passes; legacy raw artifacts are not accepted because they can contain provider/channel identifiers"
  },
  "ui_device_consumption": {
    "status": "$ui_device_status",
    "gate": "scripts/mission-spine-ui-device-proof-gate.sh",
    "proof_env_present": $ui_device_proof_present,
    "proof_gate_executed": $ui_device_gate_executed,
    "required_proof_env": "MISSION_SPINE_UI_DEVICE_PROOF",
    "required_scope": "real mobile/desktop/channel UI or device consumption evidence"
  },
  "uiux_product_closure_report": {
    "status": "$uiux_closure_report_status",
    "artifact": "$uiux_closure_report_in",
    "report_env_present": $uiux_closure_report_present,
    "non_channel_status": "$uiux_non_channel_status",
    "non_channel_inputs_resolved": $uiux_non_channel_inputs_resolved,
    "channel_deferred_strict_assembly": $uiux_channel_deferred_strict_assembly,
    "notes": $uiux_report_notes_json,
    "blockers": $uiux_report_blockers_json,
    "scope": "Optional report-mode bridge to scripts/ops/friday-uiux-product-closure-readiness.mjs output; never satisfies strict MISSION_SPINE_UI_DEVICE_PROOF or full END-BAR while channel proof is deferred"
  },
  "next_required_closure": {
    "primary_missing_evidence": "real mobile/desktop/channel UI/device consumption proof",
    "required_artifact_env": "MISSION_SPINE_UI_DEVICE_PROOF",
    "required_gate": "scripts/mission-spine-ui-device-proof-gate.sh",
    "final_gate": "scripts/mission-spine-closure-audit-gate.sh --strict",
    "plain_language": "Backend/API proof is available, but full closure still needs a redacted live channel wrapper proof plus real UI/device evidence showing the same mission_id across mobile, desktop, channel, bounded timeline, memory candidate, stale/offline/error, and stress/failure cases."
  },
  "report_semantics": {
    "report_mode_runs_live_positive_gates": false,
    "strict_mode_runs_live_positive_gates": true,
    "missing_env_in_report_mode_is_not_a_regression_of_prior_strict_live_proof": true,
    "report_mode_can_satisfy_deepseek_from_last_backend_live_proof": true,
    "uiux_non_channel_report_never_satisfies_strict_ui_device_proof": true
  },
  "full_goal_complete": $full_goal_complete
}
EOF

echo "[mission-spine-closure] report written to $report_out"

if [[ "$full_goal_complete" == "true" ]]; then
  echo "[mission-spine-closure] FULL GOAL CLOSURE PROVEN"
  exit 0
fi

echo "[mission-spine-closure] NOT FULL CLOSURE: inspect $report_out"
exit "$strict_exit"
