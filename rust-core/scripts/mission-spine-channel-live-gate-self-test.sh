#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root"

tmp="$(mktemp -d "${TMPDIR:-/tmp}/friday-channel-live-self-test.XXXXXX")"
cleanup() {
  rm -rf "$tmp"
}
trap cleanup EXIT

raw="$tmp/raw-telegram-proof.json"
wrapped="$tmp/channel-live-proof.json"
failed_raw="$tmp/raw-telegram-timeout.json"
failed_wrapped="$tmp/channel-live-timeout.json"
fixture_token="fixture-telegram-token-not-real" # pragma: allowlist secret
raw_text="hello from raw telegram message"
raw_sender="987654321"

cat >"$raw" <<EOF
{
  "proof": "telegram_inbound_through_rust_channels_pipeline",
  "sender_id_present": true,
  "sender_allowlisted": true,
  "bearer_auth_accepted_correct": true,
  "forged_bearer_rejected": true,
  "non_allowlisted_sender_rejected": true,
  "bot_identity_verified": true,
  "channel_binding_created": true,
  "redacted_text": "[redacted-message]",
  "raw_text_chars": 31,
  "pii_kinds_redacted": ["telegram_sender_id", "message_text"],
  "raw_sender_id": "$raw_sender",
  "raw_text": "$raw_text",
  "bot_token": "$fixture_token"
}
EOF

TELEGRAM_PROOF_OUT="$raw" \
MISSION_SPINE_CHANNEL_LIVE_PROOF_OUT="$wrapped" \
  scripts/mission-spine-channel-live-gate.sh --wrap-existing >/tmp/friday-channel-live-self-test.out

jq -e '
  .proof == "mission_spine_channel_live_proof"
  and .status == "passed"
  and .capture_mode == "--wrap-existing"
  and .telegram_live.proof == "telegram_inbound_through_rust_channels_pipeline"
  and .telegram_live.sender_allowlisted == true
  and .secret_policy.artifact_contains_redacted_text_only == true
  and .remaining_requirement == "real mobile/desktop/channel UI/device consumption evidence must still pass scripts/mission-spine-ui-device-proof-gate.sh"
' "$wrapped" >/dev/null

if grep -q "$fixture_token\\|$raw_sender\\|$raw_text" "$wrapped"; then
  echo "BLOCKER: wrapped channel proof leaked raw Telegram secret/sender/text" >&2
  exit 2
fi

cat >"$failed_raw" <<EOF
{
  "proof": "telegram_inbound_through_rust_channels_pipeline",
  "status": "failed_timeout",
  "bot_identity_verified": true,
  "channel_binding_created": false,
  "sender_id_present": false,
  "sender_allowlisted": false,
  "bound_principal_id": "owner",
  "bearer_auth_accepted_correct": false,
  "forged_bearer_rejected": false,
  "non_allowlisted_sender_rejected": false,
  "pii_kinds_redacted": "[]",
  "redacted_text": "",
  "raw_text_chars": 0,
  "failure_reason": "timed out waiting for one text message from the trusted user within the live proof window",
  "bot_token": "$fixture_token"
}
EOF

set +e
TELEGRAM_PROOF_OUT="$failed_raw" \
MISSION_SPINE_CHANNEL_LIVE_PROOF_OUT="$failed_wrapped" \
  scripts/mission-spine-channel-live-gate.sh --wrap-existing >/tmp/friday-channel-live-timeout-self-test.out 2>&1
status=$?
set -e

if [[ "$status" -eq 0 ]]; then
  echo "BLOCKER: timeout diagnostic wrapper path must remain fail-closed" >&2
  exit 3
fi

jq -e '
  .proof == "mission_spine_channel_live_proof"
  and .status == "failed_timeout"
  and .capture_mode == "--wrap-existing"
  and .telegram_live.status == "failed_timeout"
  and .telegram_live.bot_identity_verified == true
  and .secret_policy.artifact_contains_redacted_text_only == true
' "$failed_wrapped" >/dev/null

if grep -q "$fixture_token" "$failed_wrapped"; then
  echo "BLOCKER: timeout diagnostic wrapper leaked fixture token" >&2
  exit 4
fi

echo "[mission-spine-channel-self-test] PASS"
