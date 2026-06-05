#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root"

proof="${MISSION_SPINE_UI_DEVICE_PROOF:-}"

if [[ -z "$proof" ]]; then
  echo "BLOCKER: MISSION_SPINE_UI_DEVICE_PROOF not set - cannot verify real UI/device consumption" >&2
  exit 2
fi

if [[ ! -s "$proof" ]]; then
  echo "BLOCKER: UI/device proof artifact missing or empty: $proof" >&2
  exit 2
fi

if ! jq -e . "$proof" >/dev/null; then
  echo "BLOCKER: UI/device proof artifact is not valid JSON: $proof" >&2
  exit 3
fi

reject_secret_leaks() {
  local target="$1"
  local label="$2"

  for forbidden in \
    "sk-" \
    "Authorization" \
    "Bearer" \
    "provider-token" \
    "raw-chat" \
    "raw transcript" \
    "/Users/jarvis/private"
  do
    if rg -q --fixed-strings --text "$forbidden" "$target"; then
      echo "BLOCKER: UI/device ${label} leaked forbidden marker: $forbidden" >&2
      exit 4
    fi
  done

  local secret_value
  local secret_name
  for secret_name in \
    FRIDAY_DEEPSEEK_API_KEY \
    FRIDAY_TELEGRAM_BOT_TOKEN \
    FRIDAY_TELEGRAM_ALLOWED_USER_ID
  do
    secret_value="${!secret_name:-}"
    if [[ -n "$secret_value" && ${#secret_value} -ge 8 ]]; then
      if LC_ALL=C grep -Fq -- "$secret_value" "$target"; then
        echo "BLOCKER: UI/device ${label} leaked ${secret_name} value" >&2
        exit 4
      fi
    fi
  done
}

reject_placeholder_markers() {
  local target="$1"
  local label="$2"

  for marker in \
    "TODO_FILL_AFTER_REAL_CAPTURE" \
    "REPLACE_WITH_REAL_CAPTURE" \
    "__MISSION_ID__" \
    "\"template\": true" \
    "\"not_real_proof\": true"
  do
    if rg -q --fixed-strings --text "$marker" "$target"; then
      echo "BLOCKER: UI/device ${label} still contains proof-template placeholder marker: $marker" >&2
      exit 5
    fi
  done
}

reject_placeholder_markers "$proof" "proof artifact"
reject_secret_leaks "$proof" "proof artifact"

if jq -e '
  (.fixture // false) == true
  or (.synthetic // false) == true
  or (.sample // false) == true
  or (.dry_run // false) == true
  or ((.proof_source // "") | test("fixture|sample|dry"; "i"))
' "$proof" >/dev/null; then
  echo "BLOCKER: UI/device proof artifact is marked as fixture/sample/synthetic/dry-run: $proof" >&2
  exit 5
fi

jq -e '
  def nonempty_string: type == "string" and length > 0;
  def safe_kind: type == "string" and test("^(screenshot|video|trace|log|json)$");
  def not_fake_string: type == "string" and (test("fixture|sample|synthetic|dry"; "i") | not);
  def sha256_hex: type == "string" and test("^[0-9a-f]{64}$");
  def ok_bool($path): getpath($path) == true;
  def has_status_label($needle): (.status_labels // []) | index($needle) != null;
  def evidence_file_ok($role; $mission_id):
    .role == $role
    and (.path | nonempty_string)
    and (.kind | safe_kind)
    and (.sha256 | sha256_hex)
    and ((.bytes // 0) > 0)
    and (.real_consumption == true)
    and (.capture_method | nonempty_string and not_fake_string)
    and (.captured_at_utc | nonempty_string)
    and (.observed_mission_id == $mission_id)
    and ((.fixture // false) != true)
    and ((.synthetic // false) != true)
    and ((.sample // false) != true)
    and ((.dry_run // false) != true);
  def evidence_any_ok($mission_id):
    (.path | nonempty_string)
    and (.kind | safe_kind)
    and (.sha256 | sha256_hex)
    and ((.bytes // 0) > 0)
    and (.real_consumption == true)
    and (.capture_method | nonempty_string and not_fake_string)
    and (.captured_at_utc | nonempty_string)
    and (.observed_mission_id == $mission_id)
    and ((.fixture // false) != true)
    and ((.synthetic // false) != true)
    and ((.sample // false) != true)
    and ((.dry_run // false) != true);
  def has_evidence_role($role; $mission_id): (.evidence_files // []) | any(evidence_file_ok($role; $mission_id));
  def evidence_ref_matches($role; $ref; $mission_id): (.evidence_files // []) | any(evidence_file_ok($role; $mission_id) and .path == $ref);
  def evidence_ref_known($root; $ref): ($root.evidence_files // []) | any(evidence_any_ok($root.mission_id) and .path == $ref);
  def observation($surface; $event; $root):
    ($root.observations // [])
    | any(
        .surface == $surface
        and .event == $event
        and .mission_id == $root.mission_id
        and (.evidence_ref | nonempty_string)
        and evidence_ref_known($root; .evidence_ref)
      );
  def observation_any($event; $root):
    ($root.observations // [])
    | any(
        .event == $event
        and .mission_id == $root.mission_id
        and (.evidence_ref | nonempty_string)
        and evidence_ref_known($root; .evidence_ref)
      );
  def event_before($a; $b; $root):
    (($root.event_order // []) | index($a)) as $ia
    | (($root.event_order // []) | index($b)) as $ib
    | ($ia != null and $ib != null and $ia < $ib);
  def stress_ok($root):
    (.stress | type == "object")
    and ((.stress.mission_bound_ask_count // 0) >= 20)
    and ((.stress.mission_bound_ask_count // 0) <= 50)
    and (.stress.consecutive == true)
    and ((.stress.duplicate_surface_count // 0) >= 2)
    and (.stress.provider_ack_not_done == true)
    and (.stress.invalid_key_error_visible == true)
    and (.stress.quota_error_visible == true)
    and (.stress.network_error_visible == true)
    and (.stress.long_timeline_pagination_visible == true)
    and ((.stress.long_timeline_page_count // 0) >= 2)
    and (.stress.reconnect_stale_verified == true)
    and (.stress.channel_replay_blocked == true)
    and (.stress.no_secret_leak == true)
    and (.stress.no_hidden_fallback == true)
    and (.stress.evidence_ref | nonempty_string)
    and evidence_ref_known($root; .stress.evidence_ref);
  .proof == "mission_spine_ui_device_consumption"
  and .proof_source == "real_ui_device_consumption"
  and (.captured_at_utc | nonempty_string)
  and (.capture_run_id | nonempty_string)
  and (.mission_id | nonempty_string)
  and (.surfaces.mobile.mission_id == .mission_id)
  and (.surfaces.desktop.mission_id == .mission_id)
  and (.surfaces.channel.mission_id == .mission_id)
  and .surfaces.mobile.device_class == "mobile"
  and .surfaces.desktop.device_class == "desktop"
  and .surfaces.channel.device_class == "channel"
  and (.surfaces.mobile.evidence_ref | nonempty_string)
  and (.surfaces.desktop.evidence_ref | nonempty_string)
  and (.surfaces.channel.evidence_ref | nonempty_string)
  and ((.evidence_files // []) | length >= 4)
  and (. as $root | has_evidence_role("mobile"; $root.mission_id))
  and (. as $root | has_evidence_role("desktop"; $root.mission_id))
  and (. as $root | has_evidence_role("channel"; $root.mission_id))
  and (. as $root | has_evidence_role("timeline"; $root.mission_id))
  and (. as $root | evidence_ref_matches("mobile"; $root.surfaces.mobile.evidence_ref; $root.mission_id))
  and (. as $root | evidence_ref_matches("desktop"; $root.surfaces.desktop.evidence_ref; $root.mission_id))
  and (. as $root | evidence_ref_matches("channel"; $root.surfaces.channel.evidence_ref; $root.mission_id))
  and ok_bool(["checks", "same_mission_id_mobile_desktop"])
  and ok_bool(["checks", "same_mission_id_channel"])
  and ok_bool(["checks", "duplicate_blocked_opens_existing"])
  and ok_bool(["checks", "mission_bound_provider_action_visible"])
  and ok_bool(["checks", "proof_receipt_visible_before_done"])
  and ok_bool(["checks", "provider_ack_not_done"])
  and ok_bool(["checks", "pressure_20_50_consecutive_asks"])
  and ok_bool(["checks", "invalid_key_error_visible"])
  and ok_bool(["checks", "quota_error_visible"])
  and ok_bool(["checks", "network_error_visible"])
  and ok_bool(["checks", "channel_replay_blocked"])
  and ok_bool(["checks", "reconnect_stale_verified"])
  and ok_bool(["checks", "memory_candidate_not_confirmed"])
  and ok_bool(["checks", "no_secret_leak"])
  and ok_bool(["checks", "no_hidden_fallback"])
  and (. as $root | stress_ok($root))
  and (.timeline.bounded == true)
  and ((.timeline.page_count // 0) >= 2)
  and (.timeline.cursor_verified == true)
  and (.timeline.evidence_ref | nonempty_string)
  and (. as $root | evidence_ref_matches("timeline"; $root.timeline.evidence_ref; $root.mission_id))
  and (. as $root | (($root.observations // []) | length >= 18))
  and (. as $root | (($root.observations // []) | all(
    (.surface | nonempty_string)
    and (.event | nonempty_string)
    and (.mission_id == $root.mission_id)
    and (.evidence_ref | nonempty_string)
    and evidence_ref_known($root; .evidence_ref)
  )))
  and (. as $root | (($root.event_order // []) | length >= 10))
  and (. as $root | event_before("mission_intake_submitted"; "mission_resolve_or_create"; $root))
  and (. as $root | event_before("mission_resolve_or_create"; "duplicate_preflight"; $root))
  and (. as $root | event_before("duplicate_preflight"; "mission_bound_provider_action"; $root))
  and (. as $root | event_before("mission_bound_provider_action"; "real_provider_execution"; $root))
  and (. as $root | event_before("real_provider_execution"; "proof_receipt"; $root))
  and (. as $root | event_before("proof_receipt"; "timeline_page_1"; $root))
  and (. as $root | event_before("timeline_page_1"; "timeline_page_2"; $root))
  and (. as $root | event_before("timeline_page_2"; "same_mission_mobile_desktop_channel"; $root))
  and (. as $root | event_before("same_mission_mobile_desktop_channel"; "memory_candidate_review_only"; $root))
  and (. as $root | event_before("memory_candidate_review_only"; "stale_offline_error_labels_verified"; $root))
  and (. as $root | observation("mobile"; "mission_intake_submitted"; $root))
  and (. as $root | observation("mobile"; "mission_intake_ready"; $root))
  and (. as $root | observation_any("mission_resolve_or_create_visible"; $root))
  and (. as $root | observation_any("duplicate_preflight_visible"; $root))
  and (. as $root | observation("mobile"; "mission_bound_provider_action_visible"; $root))
  and (. as $root | observation_any("real_provider_execution_visible"; $root))
  and (. as $root | observation("mobile"; "proof_receipt_visible_before_done"; $root))
  and (. as $root | observation("desktop"; "same_mission_projection_visible"; $root))
  and (. as $root | observation("desktop"; "duplicate_blocked_opens_existing"; $root))
  and (. as $root | observation("channel"; "same_mission_projection_visible"; $root))
  and (. as $root | observation_any("same_mission_mobile_desktop_channel_visible"; $root))
  and (. as $root | observation("timeline"; "bounded_page_1_visible"; $root))
  and (. as $root | observation("timeline"; "bounded_page_2_visible"; $root))
  and (. as $root | observation("timeline"; "memory_candidate_review_only"; $root))
  and (. as $root | observation_any("provider_ack_not_done_visible"; $root))
  and (. as $root | observation_any("pressure_20_50_consecutive_asks_visible"; $root))
  and (. as $root | observation_any("invalid_key_error_visible"; $root))
  and (. as $root | observation_any("quota_error_visible"; $root))
  and (. as $root | observation_any("network_error_visible"; $root))
  and (. as $root | observation_any("channel_replay_blocked_visible"; $root))
  and (. as $root | observation_any("reconnect_stale_verified"; $root))
  and (. as $root | observation_any("real_provider_execution_receipt_visible"; $root))
  and (. as $root | observation_any("stale_label_visible"; $root))
  and (. as $root | observation_any("offline_label_visible"; $root))
  and (. as $root | observation_any("error_label_visible"; $root))
  and (. as $root | observation_any("no_hidden_fallback_verified"; $root))
  and has_status_label("stale")
  and has_status_label("offline")
  and has_status_label("error")
  and ((.memory_candidates // []) | length >= 1)
  and ((.memory_candidates // []) | all((.confirmed == false) and (.grants_memory_authority == false)))
' "$proof" >/dev/null || {
  echo "BLOCKER: UI/device proof artifact does not satisfy Mission Spine closure schema: $proof" >&2
  exit 6
}

while IFS=$'\t' read -r evidence_file expected_sha256 expected_bytes; do
  if [[ -z "$evidence_file" ]]; then
    continue
  fi
  if [[ ! -s "$evidence_file" ]]; then
    echo "BLOCKER: UI/device evidence file missing or empty: $evidence_file" >&2
    exit 7
  fi
  actual_sha256="$(shasum -a 256 "$evidence_file" | awk '{print $1}')"
  if [[ "$actual_sha256" != "$expected_sha256" ]]; then
    echo "BLOCKER: UI/device evidence file sha256 mismatch: $evidence_file" >&2
    exit 8
  fi
  actual_bytes="$(wc -c <"$evidence_file" | tr -d '[:space:]')"
  if [[ "$actual_bytes" != "$expected_bytes" ]]; then
    echo "BLOCKER: UI/device evidence file byte count mismatch: $evidence_file" >&2
    exit 9
  fi
  reject_placeholder_markers "$evidence_file" "evidence file"
  reject_secret_leaks "$evidence_file" "evidence file"
done < <(jq -r '.evidence_files[]? | [.path, .sha256, (.bytes | tostring)] | @tsv' "$proof")

echo "[mission-spine-ui] UI/DEVICE PROOF PASSED"
echo "[mission-spine-ui] verified artifact: $proof"
