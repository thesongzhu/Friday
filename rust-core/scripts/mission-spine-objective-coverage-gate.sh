#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root"

report_out="${MISSION_SPINE_OBJECTIVE_COVERAGE_OUT:-/tmp/friday-mission-spine-objective-coverage.json}"
backend_live_proof_out="${MISSION_SPINE_BACKEND_LIVE_PROOF_OUT:-/tmp/friday-mission-spine-backend-live-proof.json}"
generated_at="$(date -u '+%Y-%m-%dT%H:%M:%SZ')"

run_test() {
  local package="$1"
  local filter="$2"
  shift 2
  echo "[mission-spine-objective] $package :: $filter"
  cargo test -p "$package" "$filter" "$@" -- --nocapture
}

echo "[mission-spine-objective] cross-surface Mission input/create/duplicate/projection"
run_test friday-hub headless_e2e_mission_intake_mobile_create_desktop_channel_duplicate_bind_same_mission

echo "[mission-spine-objective] Mission-bound provider action/proof/timeline/cross-surface read"
run_test friday-hub headless_e2e_intake_then_mission_bound_ask_then_duplicate_projection_timeline

echo "[mission-spine-objective] 20-50 ask pressure analogue, long timeline, memory boundary, no hidden fallback"
run_test friday-hub mission_bound_ask_pressure_loop_paginates_and_preserves_memory_boundary

echo "[mission-spine-objective] provider failure surfaces: provider down, quota, network"
run_test friday-hub mission_bound_ask_provider_error_is_explicit_no_fallback_no_ledger
run_test friday-hub mission_bound_ask_quota_post_error_is_no_fallback_no_ledger_or_secret_leak
run_test friday-hub mission_bound_ask_network_discovery_error_is_no_fallback_no_ledger_or_completion

echo "[mission-spine-objective] channel auth/replay/idempotency"
run_test friday-hub authenticated_channel_ingress_records_redacted_receipt_and_mission_trace
run_test friday-hub authenticated_channel_replay_does_not_duplicate_event_audit_or_mission_trace

echo "[mission-spine-objective] global work graph / adoption / advisor truth labels"
run_test friday-core mechanism_matrix
run_test friday-hub global_work_graph
run_test friday-hub skill_catalog

echo "[mission-spine-objective] stale/offline/error labels, ack-not-done, reconnect replay"
run_test friday-hub presentation_never_labels_stale_as_connected_or_queued_as_completed
run_test friday-hub surface_status_labels_are_stable_and_only_executed_means_done
run_test friday-hub queued_is_not_executed_and_ack_is_not_completion
run_test friday-transport reconnect_resumes_missed_stream_frames

echo "[mission-spine-objective] native wire helpers for UI semantics"
run_test friday-ffi ffi_status_semantics_keep_ack_blocked_and_candidates_out_of_done
run_test friday-ffi ffi_sample_mission_spine_responses_cover_wire_ui_contracts
run_test friday-protocol provider_timeline_reconnect_wire_round_trips_delta_and_snapshot
run_test friday-protocol mission_timeline_snapshot_wire_is_refs_only_and_does_not_complete_work

cat >"$report_out" <<EOF
{
  "proof": "mission_spine_objective_backend_wire_coverage",
  "generated_at_utc": "$generated_at",
  "worktree": "$root",
  "scope": "backend/wire/channel/runtime coverage for the active Mission Spine objective; not real UI/device consumption proof",
  "status": "passed",
  "backend_live_proof_artifact": "$backend_live_proof_out",
  "executed_tests": [
    {
      "package": "friday-hub",
      "filter": "headless_e2e_mission_intake_mobile_create_desktop_channel_duplicate_bind_same_mission",
      "proves": ["mobile_desktop_channel_intake", "mission_resolve_create", "duplicate_preflight", "same_mission_projection", "no_provider_call_on_intake_or_duplicate"]
    },
    {
      "package": "friday-hub",
      "filter": "headless_e2e_intake_then_mission_bound_ask_then_duplicate_projection_timeline",
      "proves": ["mission_bound_provider_action", "proof_receipt", "bounded_timeline_read", "same_mission_mobile_desktop_channel", "no_secret_leak"]
    },
    {
      "package": "friday-hub",
      "filter": "mission_bound_ask_pressure_loop_paginates_and_preserves_memory_boundary",
      "proves": ["twenty_to_fifty_mission_bound_asks", "long_timeline_pagination", "memory_candidate_not_confirmed", "no_hidden_fallback", "no_secret_leak"]
    },
    {
      "package": "friday-hub",
      "filter": "mission_bound_ask_provider_error_is_explicit_no_fallback_no_ledger",
      "proves": ["provider_unavailable_error", "no_hidden_fallback", "no_ledger_or_completion_on_provider_failure"]
    },
    {
      "package": "friday-hub",
      "filter": "mission_bound_ask_quota_post_error_is_no_fallback_no_ledger_or_secret_leak",
      "proves": ["quota_error", "no_hidden_fallback", "no_ledger_or_completion_on_quota_failure", "no_secret_leak"]
    },
    {
      "package": "friday-hub",
      "filter": "mission_bound_ask_network_discovery_error_is_no_fallback_no_ledger_or_completion",
      "proves": ["network_failure", "no_hidden_fallback", "no_ledger_or_completion_on_network_failure", "no_secret_leak"]
    },
    {
      "package": "friday-hub",
      "filter": "authenticated_channel_ingress_records_redacted_receipt_and_mission_trace",
      "proves": ["channel_ingress", "channel_redaction", "mission_trace_attachment", "no_secret_leak"]
    },
    {
      "package": "friday-hub",
      "filter": "authenticated_channel_replay_does_not_duplicate_event_audit_or_mission_trace",
      "proves": ["channel_replay_idempotency", "no_duplicate_activity", "no_duplicate_audit", "no_duplicate_mission_trace"]
    },
    {
      "package": "friday-hub",
      "filter": "global_work_graph",
      "proves": ["global_work_graph_truth_labels", "read_only_redacted_discovery", "operator_gated_adoption", "adoption_does_not_grant_control", "advisor_preflight_duplicate_conflict_context_passport"]
    },
    {
      "package": "friday-core",
      "filter": "mechanism_matrix",
      "proves": ["canonical_mechanism_matrix", "ui_and_legacy_do_not_own_product_logic", "v1_no_go_until_product_logic_is_rust_proven"]
    },
    {
      "package": "friday-hub",
      "filter": "skill_catalog",
      "proves": ["skill_capability_catalog", "observed_skill_is_not_owned", "operator_adopted_skill_changes_advisor_behavior", "skill_catalog_does_not_grant_execution_control"]
    },
    {
      "package": "friday-hub",
      "filter": "presentation_never_labels_stale_as_connected_or_queued_as_completed",
      "proves": ["stale_label", "offline_label", "provider_ack_not_done"]
    },
    {
      "package": "friday-hub",
      "filter": "surface_status_labels_are_stable_and_only_executed_means_done",
      "proves": ["stale_offline_error_label_stability", "only_executed_means_done"]
    },
    {
      "package": "friday-hub",
      "filter": "queued_is_not_executed_and_ack_is_not_completion",
      "proves": ["hub_ack_not_done", "queued_not_executed"]
    },
    {
      "package": "friday-transport",
      "filter": "reconnect_resumes_missed_stream_frames",
      "proves": ["reconnect_replays_only_missed_frames"]
    },
    {
      "package": "friday-ffi",
      "filter": "ffi_status_semantics_keep_ack_blocked_and_candidates_out_of_done",
      "proves": ["native_ui_status_helpers", "provider_ack_not_done", "memory_candidate_not_confirmed", "duplicate_open_existing_helper"]
    },
    {
      "package": "friday-ffi",
      "filter": "ffi_sample_mission_spine_responses_cover_wire_ui_contracts",
      "proves": ["native_wire_contract_shape", "bounded_timeline_shape", "status_labels_visible_to_native_ui"]
    },
    {
      "package": "friday-protocol",
      "filter": "provider_timeline_reconnect_wire_round_trips_delta_and_snapshot",
      "proves": ["provider_timeline_reconnect_contract", "provider_ack_not_done"]
    },
    {
      "package": "friday-protocol",
      "filter": "mission_timeline_snapshot_wire_is_refs_only_and_does_not_complete_work",
      "proves": ["timeline_read_not_completion", "refs_only_timeline", "no_secret_leak"]
    }
  ],
  "requirement_evidence": [
    {
      "requirement": "mobile/desktop/channel input -> Mission resolve/create",
      "status": "passed_backend_wire",
      "evidence_tests": ["headless_e2e_mission_intake_mobile_create_desktop_channel_duplicate_bind_same_mission"]
    },
    {
      "requirement": "duplicate/conflict preflight",
      "status": "passed_backend_wire",
      "evidence_tests": ["headless_e2e_mission_intake_mobile_create_desktop_channel_duplicate_bind_same_mission", "headless_e2e_intake_then_mission_bound_ask_then_duplicate_projection_timeline"]
    },
    {
      "requirement": "Mission-bound provider action -> proof receipt -> bounded timeline",
      "status": "passed_backend_wire",
      "evidence_tests": ["headless_e2e_intake_then_mission_bound_ask_then_duplicate_projection_timeline", "mission_bound_ask_pressure_loop_paginates_and_preserves_memory_boundary"]
    },
    {
      "requirement": "real API/provider execution",
      "status": "passed_live_deepseek_previously; report mode does not rerun live positive gates",
      "evidence_tests": ["live_mission_bound_deepseek_pressure_asks_write_proof_and_bounded_timeline via scripts/mission-spine-proof-gate.sh --full"],
      "evidence_artifact": "$backend_live_proof_out"
    },
    {
      "requirement": "mobile/desktop same mission_id sees result",
      "status": "passed_backend_wire",
      "evidence_tests": ["headless_e2e_intake_then_mission_bound_ask_then_duplicate_projection_timeline"]
    },
    {
      "requirement": "memory candidate does not auto-confirm",
      "status": "passed_backend_wire",
      "evidence_tests": ["mission_bound_ask_pressure_loop_paginates_and_preserves_memory_boundary", "ffi_status_semantics_keep_ack_blocked_and_candidates_out_of_done"]
    },
    {
      "requirement": "stale/offline/error labels are correctly surfaced",
      "status": "passed_backend_wire",
      "evidence_tests": ["presentation_never_labels_stale_as_connected_or_queued_as_completed", "surface_status_labels_are_stable_and_only_executed_means_done", "ffi_sample_mission_spine_responses_cover_wire_ui_contracts"]
    },
    {
      "requirement": "20-50 consecutive Mission-bound asks",
      "status": "passed_backend_wire_and_live_deepseek_previously",
      "evidence_tests": ["mission_bound_ask_pressure_loop_paginates_and_preserves_memory_boundary", "mission_bound_ask_real_ureq_transport_pressure_loop_paginates_and_redacts", "live_mission_bound_deepseek_pressure_asks_write_proof_and_bounded_timeline"],
      "evidence_artifact": "$backend_live_proof_out"
    },
    {
      "requirement": "multi-surface duplicate input blocks duplicate work",
      "status": "passed_backend_wire",
      "evidence_tests": ["headless_e2e_mission_intake_mobile_create_desktop_channel_duplicate_bind_same_mission", "headless_e2e_intake_then_mission_bound_ask_then_duplicate_projection_timeline"]
    },
    {
      "requirement": "provider ack must not become done",
      "status": "passed_backend_wire",
      "evidence_tests": ["ffi_status_semantics_keep_ack_blocked_and_candidates_out_of_done", "provider_timeline_reconnect_wire_round_trips_delta_and_snapshot", "mission_timeline_snapshot_wire_is_refs_only_and_does_not_complete_work"]
    },
    {
      "requirement": "API key invalid / quota / network fail",
      "status": "passed_backend_wire; live invalid-key negative runs only in scripts/mission-spine-proof-gate.sh --full",
      "evidence_tests": ["mission_bound_ask_provider_error_is_explicit_no_fallback_no_ledger", "mission_bound_ask_quota_post_error_is_no_fallback_no_ledger_or_secret_leak", "mission_bound_ask_network_discovery_error_is_no_fallback_no_ledger_or_completion"]
    },
    {
      "requirement": "long timeline pagination",
      "status": "passed_backend_wire",
      "evidence_tests": ["mission_bound_ask_pressure_loop_paginates_and_preserves_memory_boundary", "mission_timeline_snapshot_wire_is_refs_only_and_does_not_complete_work"]
    },
    {
      "requirement": "reconnect / stale",
      "status": "passed_backend_wire",
      "evidence_tests": ["reconnect_resumes_missed_stream_frames", "presentation_never_labels_stale_as_connected_or_queued_as_completed"]
    },
    {
      "requirement": "channel replay",
      "status": "passed_backend_wire",
      "evidence_tests": ["authenticated_channel_replay_does_not_duplicate_event_audit_or_mission_trace"]
    },
    {
      "requirement": "global work graph truth labels and operator-gated adoption",
      "status": "passed_backend_wire",
      "evidence_tests": ["global_work_graph"]
    },
    {
      "requirement": "canonical mechanism matrix blocks UI/legacy-owned product logic",
      "status": "passed_backend_wire",
      "evidence_tests": ["mechanism_matrix"]
    },
    {
      "requirement": "skill/capability advisor bridge makes approved skills available without hidden execution",
      "status": "passed_backend_wire",
      "evidence_tests": ["skill_catalog"]
    },
    {
      "requirement": "no secret leak",
      "status": "passed_backend_wire",
      "evidence_tests": ["headless_e2e_intake_then_mission_bound_ask_then_duplicate_projection_timeline", "mission_bound_ask_quota_post_error_is_no_fallback_no_ledger_or_secret_leak", "mission_timeline_snapshot_wire_is_refs_only_and_does_not_complete_work"]
    },
    {
      "requirement": "no hidden fallback",
      "status": "passed_backend_wire; live invalid-key negative runs only in scripts/mission-spine-proof-gate.sh --full",
      "evidence_tests": ["mission_bound_ask_pressure_loop_paginates_and_preserves_memory_boundary", "mission_bound_ask_provider_error_is_explicit_no_fallback_no_ledger", "mission_bound_ask_quota_post_error_is_no_fallback_no_ledger_or_secret_leak", "mission_bound_ask_network_discovery_error_is_no_fallback_no_ledger_or_completion"]
    },
    {
      "requirement": "real mobile/desktop/channel UI/device consumption",
      "status": "not_proven",
      "evidence_tests": [],
      "required_gate": "scripts/mission-spine-ui-device-proof-gate.sh"
    }
  ],
  "covered_requirements": [
    "mobile/desktop/channel input reaches Mission resolve/create",
    "duplicate/conflict preflight binds later surfaces to the existing Mission",
    "Mission-bound provider action records proof receipt and completed_with_proof only after provider completion proof",
    "bounded timeline pages and same mission_id projects to mobile/desktop/channel",
    "memory candidate links do not grant confirmed memory authority",
    "provider ack/hub ack does not imply done",
    "invalid/quota/network provider failures write no ledger/completion and surface no hidden fallback",
    "long timeline pagination is cursor-bounded",
    "reconnect replays only missed frames",
    "channel replay does not duplicate activity/audit/Mission traces",
    "global work graph distinguishes owned/adopted/observed/link-only/unknown and keeps discovery read-only/redacted",
    "operator-gated adoption links observed work to an existing Mission/WorkItem without granting control",
    "canonical mechanism matrix prevents UI/legacy from owning user-triggerable product logic",
    "skill/capability catalog distinguishes observed/adopted/runnable and changes advisor behavior only after approval",
    "advisor preflight blocks duplicate/conflicting work and requires Context Passport/operator approval before dispatch",
    "secret-bearing values and raw transcripts do not project through wire snapshots",
    "stale/offline/error labels are stable for native UI consumption"
  ],
  "remaining_requirement": "real mobile/desktop/channel UI or device consumption evidence must still pass scripts/mission-spine-ui-device-proof-gate.sh"
}
EOF

echo "[mission-spine-objective] report written to $report_out"
echo "[mission-spine-objective] BACKEND/WIRE OBJECTIVE COVERAGE PASSED"
