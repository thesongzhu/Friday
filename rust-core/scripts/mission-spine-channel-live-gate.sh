#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root"

generated_at="$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
channel_live_proof_out="${MISSION_SPINE_CHANNEL_LIVE_PROOF_OUT:-/tmp/friday-mission-spine-channel-live-proof.json}"

if [[ -z "${FRIDAY_TELEGRAM_BOT_TOKEN:-}" ]]; then
  echo "BLOCKER: FRIDAY_TELEGRAM_BOT_TOKEN not set - cannot run real Telegram/channel inbound proof" >&2
  exit 2
fi

if [[ -z "${FRIDAY_TELEGRAM_ALLOWED_USER_ID:-}" ]]; then
  echo "BLOCKER: FRIDAY_TELEGRAM_ALLOWED_USER_ID not set - cannot run allowlisted Telegram/channel inbound proof" >&2
  exit 2
fi

export TELEGRAM_LISTEN_SECONDS="${TELEGRAM_LISTEN_SECONDS:-300}"
export TELEGRAM_PROOF_OUT="${TELEGRAM_PROOF_OUT:-/tmp/friday-telegram-live-proof.json}"

echo "[mission-spine-channel] live Telegram/channel inbound proof"
echo "[mission-spine-channel] waiting up to ${TELEGRAM_LISTEN_SECONDS}s for one real message from the allowlisted user"
cargo test -p friday-hub --test telegram_live \
  telegram_inbound_through_rust_channels_pipeline \
  -- --ignored --nocapture

if [[ ! -s "$TELEGRAM_PROOF_OUT" ]]; then
  echo "BLOCKER: Telegram live test did not write proof artifact at ${TELEGRAM_PROOF_OUT}" >&2
  exit 3
fi

if ! jq -e '
  .proof == "telegram_inbound_through_rust_channels_pipeline"
  and .sender_id_present == true
  and .sender_allowlisted == true
  and .bearer_auth_accepted_correct == true
  and .forged_bearer_rejected == true
  and .non_allowlisted_sender_rejected == true
  and .bot_identity_verified == true
  and .channel_binding_created == true
  and (.redacted_text | type == "string")
  and (.raw_text_chars | type == "number" and . > 0)
' "$TELEGRAM_PROOF_OUT" >/dev/null; then
  echo "BLOCKER: Telegram live proof artifact failed schema validation: ${TELEGRAM_PROOF_OUT}" >&2
  exit 4
fi

jq \
  --arg generated_at "$generated_at" \
  --arg worktree "$root" \
  --arg raw_artifact "$TELEGRAM_PROOF_OUT" \
  '{
    proof: "mission_spine_channel_live_proof",
    generated_at_utc: $generated_at,
    worktree: $worktree,
    status: "passed",
    scope: "real Telegram/channel inbound proof through Rust channel auth and redaction pipeline; not real UI/device consumption proof",
    raw_artifact: $raw_artifact,
	    telegram_live: {
	      status: "passed",
	      proof: .proof,
	      bot_identity_verified: .bot_identity_verified,
	      channel_binding_created: .channel_binding_created,
	      sender_id_present: .sender_id_present,
	      sender_allowlisted: .sender_allowlisted,
	      bearer_auth_accepted_correct: .bearer_auth_accepted_correct,
      forged_bearer_rejected: .forged_bearer_rejected,
      non_allowlisted_sender_rejected: .non_allowlisted_sender_rejected,
      pii_kinds_redacted: .pii_kinds_redacted,
      raw_text_chars: .raw_text_chars
    },
    secret_policy: {
	      token_logged: false,
	      token_written_to_artifact: false,
	      provider_or_channel_id_written: false,
	      raw_sender_id_written: false,
	      artifact_contains_redacted_text_only: true
	    },
    remaining_requirement: "real mobile/desktop/channel UI/device consumption evidence must still pass scripts/mission-spine-ui-device-proof-gate.sh"
  }' "$TELEGRAM_PROOF_OUT" >"$channel_live_proof_out"

echo "[mission-spine-channel] CHANNEL LIVE PROOF PASSED"
echo "[mission-spine-channel] redacted proof artifact: ${TELEGRAM_PROOF_OUT}"
echo "[mission-spine-channel] channel live proof report written: ${channel_live_proof_out}"
