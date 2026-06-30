#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root"

mode="${1:---live}"
case "$mode" in
  --live|--wrap-existing)
    ;;
  -h|--help)
    cat >&2 <<'EOF'
usage:
  scripts/mission-spine-channel-live-gate.sh [--live]
  TELEGRAM_PROOF_OUT=/abs/raw-telegram-proof.json scripts/mission-spine-channel-live-gate.sh --wrap-existing

--live is the default and runs the ignored real Telegram live test.
--wrap-existing only converts an already-captured raw Telegram proof into the redacted
mission_spine_channel_live_proof wrapper; it does not contact Telegram and does not make raw
evidence fresh.
EOF
    exit 0
    ;;
  *)
    echo "usage: $0 [--live|--wrap-existing]" >&2
    exit 64
    ;;
esac

generated_at="$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
git_head="$(git rev-parse HEAD 2>/dev/null || printf 'unknown')"
git_head_short="${git_head:0:12}"
channel_live_proof_out="${MISSION_SPINE_CHANNEL_LIVE_PROOF_OUT:-/tmp/friday-mission-spine-channel-live-proof.json}"

export TELEGRAM_LISTEN_SECONDS="${TELEGRAM_LISTEN_SECONDS:-300}"
export TELEGRAM_PROOF_OUT="${TELEGRAM_PROOF_OUT:-/tmp/friday-telegram-live-proof.json}"

if [[ "$mode" == "--live" ]]; then
  if [[ -z "${FRIDAY_TELEGRAM_BOT_TOKEN:-}" ]]; then
    echo "BLOCKER: FRIDAY_TELEGRAM_BOT_TOKEN not set - cannot run real Telegram/channel inbound proof" >&2
    exit 2
  fi

  if [[ -z "${FRIDAY_TELEGRAM_ALLOWED_USER_ID:-}" ]]; then
    echo "BLOCKER: FRIDAY_TELEGRAM_ALLOWED_USER_ID not set - cannot run allowlisted Telegram/channel inbound proof" >&2
    exit 2
  fi

  echo "[mission-spine-channel] live Telegram/channel inbound proof"
  echo "[mission-spine-channel] waiting up to ${TELEGRAM_LISTEN_SECONDS}s for one real message from the allowlisted user"
  live_status=0
  set +e
  cargo test -p friday-hub --test telegram_live \
    telegram_inbound_through_rust_channels_pipeline \
    -- --ignored --nocapture
  live_status=$?
  set -e
else
  echo "[mission-spine-channel] wrapping existing Telegram proof artifact: ${TELEGRAM_PROOF_OUT}"
  live_status=0
fi

if [[ ! -s "$TELEGRAM_PROOF_OUT" ]]; then
  echo "BLOCKER: Telegram live test did not write proof artifact at ${TELEGRAM_PROOF_OUT}" >&2
  exit 3
fi

if jq -e '
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
  jq \
    --arg generated_at "$generated_at" \
    --arg worktree "$root" \
    --arg git_head "$git_head" \
    --arg git_head_short "$git_head_short" \
    --arg github_sha "${GITHUB_SHA:-}" \
    --arg github_run_id "${GITHUB_RUN_ID:-}" \
    --arg github_ref_name "${GITHUB_REF_NAME:-}" \
    --arg raw_artifact "$TELEGRAM_PROOF_OUT" \
    --arg mode "$mode" \
    '{
    proof: "mission_spine_channel_live_proof",
    generated_at_utc: $generated_at,
    worktree: $worktree,
    head: $git_head,
    head_short: $git_head_short,
    github: {
      sha: (if ($github_sha | length) > 0 then $github_sha else null end),
      run_id: (if ($github_run_id | length) > 0 then $github_run_id else null end),
      ref_name: (if ($github_ref_name | length) > 0 then $github_ref_name else null end)
    },
    status: "passed",
    capture_mode: $mode,
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
  exit "$live_status"
fi

if jq -e '
  .proof == "telegram_inbound_through_rust_channels_pipeline"
  and .status == "failed_timeout"
  and .bot_identity_verified == true
  and .sender_id_present == false
  and .sender_allowlisted == false
  and (.failure_reason | type == "string" and length > 0)
' "$TELEGRAM_PROOF_OUT" >/dev/null; then
  jq \
    --arg generated_at "$generated_at" \
    --arg worktree "$root" \
    --arg git_head "$git_head" \
    --arg git_head_short "$git_head_short" \
    --arg github_sha "${GITHUB_SHA:-}" \
    --arg github_run_id "${GITHUB_RUN_ID:-}" \
    --arg github_ref_name "${GITHUB_REF_NAME:-}" \
    --arg raw_artifact "$TELEGRAM_PROOF_OUT" \
    --arg mode "$mode" \
    '{
      proof: "mission_spine_channel_live_proof",
      generated_at_utc: $generated_at,
      worktree: $worktree,
      head: $git_head,
      head_short: $git_head_short,
      github: {
        sha: (if ($github_sha | length) > 0 then $github_sha else null end),
        run_id: (if ($github_run_id | length) > 0 then $github_run_id else null end),
        ref_name: (if ($github_ref_name | length) > 0 then $github_ref_name else null end)
      },
      status: "failed_timeout",
      capture_mode: $mode,
      scope: "diagnostic only: Telegram bot identity was verified but no trusted allowlisted text message arrived during the live proof window",
      raw_artifact: $raw_artifact,
      telegram_live: {
        status: "failed_timeout",
        proof: .proof,
        bot_identity_verified: .bot_identity_verified,
        channel_binding_created: .channel_binding_created,
        sender_id_present: .sender_id_present,
        sender_allowlisted: .sender_allowlisted,
        bearer_auth_accepted_correct: .bearer_auth_accepted_correct,
        forged_bearer_rejected: .forged_bearer_rejected,
        non_allowlisted_sender_rejected: .non_allowlisted_sender_rejected,
        pii_kinds_redacted: .pii_kinds_redacted,
        raw_text_chars: .raw_text_chars,
        failure_reason: .failure_reason
      },
      secret_policy: {
        token_logged: false,
        token_written_to_artifact: false,
        provider_or_channel_id_written: false,
        raw_sender_id_written: false,
        artifact_contains_redacted_text_only: true
      },
      remaining_requirement: "real allowlisted Telegram message plus real mobile/desktop/channel UI/device consumption evidence must still pass"
    }' "$TELEGRAM_PROOF_OUT" >"$channel_live_proof_out"

  echo "BLOCKER: Telegram live proof timed out without a trusted text message" >&2
  echo "[mission-spine-channel] timeout diagnostic wrapper written: ${channel_live_proof_out}" >&2
  exit 4
fi

echo "BLOCKER: Telegram live proof artifact failed schema validation: ${TELEGRAM_PROOF_OUT}" >&2
exit 4
