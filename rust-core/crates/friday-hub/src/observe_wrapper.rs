//! Observe-via-wrapper wiring for provider-owned CLI/app-server sessions.
//!
//! This module is deliberately small: provider crates surface JSON-RPC metadata, and the Hub
//! persists only existing refs-only rows. It adds no new schema and does not run any model call.

use friday_core::{
    ClaimState, OwnershipStatus, ProcessKind, ProcessObservation, ProviderSessionLink, SyncMode,
    WorkspaceClaimKind,
};
use friday_providers::codex_appserver::{
    map_server_message_to_provider_event, JsonRpcServerMessage, ProviderMirrorContext,
};
use rusqlite::Connection;
use sha2::{Digest, Sha256};
use std::fmt::Write as _;

pub const ENV_FRIDAY_OBSERVE_WRAPPER_ENABLED: &str = "FRIDAY_OBSERVE_WRAPPER_ENABLED";

pub fn observe_wrapper_enabled_from(value: Option<String>) -> bool {
    value.as_deref().map(str::trim) == Some("1")
}

pub fn observe_wrapper_enabled() -> bool {
    observe_wrapper_enabled_from(std::env::var(ENV_FRIDAY_OBSERVE_WRAPPER_ENABLED).ok())
}

pub fn codex_friday_session_id(run_id: &str) -> String {
    format!("codex-observe-{}", id_part(run_id))
}

pub fn codex_process_observation_id(run_id: &str) -> String {
    format!("codex-observe-process-{}", id_part(run_id))
}

pub fn codex_provider_session_ref(friday_session_id: &str) -> String {
    format!("friday://provider-session/{friday_session_id}")
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CodexObserveMissionContext {
    pub mission_id: String,
    pub work_item_id: String,
    pub owner_claim_ids: Vec<String>,
}

pub fn upsert_codex_session_link(
    conn: &Connection,
    friday_session_id: &str,
    thread_id: &str,
    model: &str,
    cwd: Option<&str>,
    observed_at: i64,
) -> friday_storage::Result<()> {
    let workspace_id = cwd
        .filter(|v| !v.trim().is_empty())
        .unwrap_or("codex-app-server-default-cwd");
    let link = ProviderSessionLink {
        friday_session_id: friday_session_id.to_string(),
        provider: "codex".to_string(),
        account_key_hash: "sha256:codex-cli-local-account-unresolved".to_string(), // pragma: allowlist secret
        workspace_id: workspace_id.to_string(),
        cwd: cwd.map(ToString::to_string),
        external_session_id: None,
        external_thread_id: Some(thread_id.to_string()),
        external_url: None,
        sync_mode: SyncMode::ProviderAppServerLocal,
        capability_snapshot: format!("codex_app_server_observe_wrapper:v1;model={model}"),
        last_provider_seen_at: Some(observed_at),
        last_friday_event_id: None,
        truth_label: "codex_app_server_local_observed_metadata_only".to_string(),
    };
    friday_storage::provider_session::upsert_link(conn, &link)
}

pub fn append_codex_provider_event(
    conn: &Connection,
    friday_session_id: &str,
    message: &JsonRpcServerMessage,
    observed_at: i64,
    mirror_seq: u64,
    token_ledger_ref: Option<&str>,
) -> friday_storage::Result<Option<String>> {
    let context = ProviderMirrorContext::codex(friday_session_id);
    let Some(mut event) =
        map_server_message_to_provider_event(&context, message, observed_at, mirror_seq)
            .map_err(|e| friday_storage::StorageError::Unsupported(e.to_string()))?
    else {
        return Ok(None);
    };
    event.token_ledger_ref = token_ledger_ref.map(ToString::to_string);
    let provider_event_id = event.provider_event_id.clone();
    friday_storage::provider_session::append_event(conn, &event)?;
    Ok(Some(provider_event_id))
}

pub fn attach_token_ledger_ref(
    conn: &Connection,
    friday_session_id: &str,
    ledger_id: &str,
) -> friday_storage::Result<usize> {
    let updated = conn.execute(
        "UPDATE provider_session_event
         SET token_ledger_ref = ?1
         WHERE friday_session_id = ?2
           AND (token_ledger_ref IS NULL OR token_ledger_ref = '')",
        rusqlite::params![ledger_id, friday_session_id],
    )?;
    Ok(updated)
}

pub fn upsert_claimed_codex_process_observation(
    conn: &Connection,
    observation_id: &str,
    pid: i64,
    matched_claim_id: &str,
    cwd_ref: &str,
    observed_at: i64,
) -> friday_storage::Result<()> {
    upsert_claimed_codex_process_observation_with_provider_session_ref(
        conn,
        observation_id,
        pid,
        matched_claim_id,
        cwd_ref,
        observed_at,
        None,
    )
}

fn upsert_claimed_codex_process_observation_with_provider_session_ref(
    conn: &Connection,
    observation_id: &str,
    pid: i64,
    matched_claim_id: &str,
    cwd_ref: &str,
    observed_at: i64,
    provider_session_ref: Option<&str>,
) -> friday_storage::Result<()> {
    let mut port_bindings = vec!["stdio://codex-app-server".to_string()];
    if let Some(provider_session_ref) =
        provider_session_ref.filter(|value| !value.trim().is_empty())
    {
        port_bindings.push(provider_session_ref.to_string());
    }
    let observation = ProcessObservation {
        observation_id: observation_id.to_string(),
        pid,
        ppid: None,
        process_kind: ProcessKind::CodexAppServer,
        cwd_ref: cwd_ref.to_string(),
        port_bindings,
        command_hash: None,
        observed_at_ms: observed_at,
        matched_claim_id: Some(matched_claim_id.to_string()),
        ownership_status: OwnershipStatus::FridayOwnedClaimed,
    };
    friday_storage::process_registry::upsert_process_observation(conn, &observation)
}

#[derive(Clone, Copy, Debug)]
pub struct ClaimedCodexProcessObservation<'a> {
    pub observation_id: &'a str,
    pub pid: i64,
    pub matched_claim_id: &'a str,
    pub expected_mission_id: &'a str,
    pub expected_work_item_id: Option<&'a str>,
    pub cwd_ref: &'a str,
    pub observed_at: i64,
    pub provider_session_ref: Option<&'a str>,
}

pub fn upsert_claimed_codex_process_observation_for_claim(
    conn: &Connection,
    request: ClaimedCodexProcessObservation<'_>,
) -> friday_storage::Result<bool> {
    let Some(claim) =
        friday_storage::process_registry::get_workspace_claim(conn, request.matched_claim_id)?
    else {
        return Ok(false);
    };
    if claim.state != ClaimState::Active
        || claim.mission_id != request.expected_mission_id
        || !codex_process_claim_kind_allows_control(claim.claim_kind)
    {
        return Ok(false);
    }
    if let Some(expected) = request.expected_work_item_id {
        if claim.work_item_id.as_deref() != Some(expected) {
            return Ok(false);
        }
    }

    upsert_claimed_codex_process_observation_with_provider_session_ref(
        conn,
        request.observation_id,
        request.pid,
        request.matched_claim_id,
        request.cwd_ref,
        request.observed_at,
        request.provider_session_ref,
    )?;
    Ok(true)
}

pub fn upsert_claimed_codex_process_observation_for_context(
    conn: &Connection,
    observation_id: &str,
    friday_session_id: &str,
    pid: i64,
    context: &CodexObserveMissionContext,
    cwd_ref: &str,
    observed_at: i64,
) -> friday_storage::Result<Option<String>> {
    let provider_session_ref = codex_provider_session_ref(friday_session_id);
    for claim_id in &context.owner_claim_ids {
        let wrote = upsert_claimed_codex_process_observation_for_claim(
            conn,
            ClaimedCodexProcessObservation {
                observation_id,
                pid,
                matched_claim_id: claim_id,
                expected_mission_id: &context.mission_id,
                expected_work_item_id: Some(&context.work_item_id),
                cwd_ref,
                observed_at,
                provider_session_ref: Some(provider_session_ref.as_str()),
            },
        )?;
        if wrote {
            return Ok(Some(claim_id.clone()));
        }
    }
    Ok(None)
}

fn codex_process_claim_kind_allows_control(kind: WorkspaceClaimKind) -> bool {
    matches!(
        kind,
        WorkspaceClaimKind::Process | WorkspaceClaimKind::ProviderSession
    )
}

fn id_part(value: &str) -> String {
    let mut out = String::with_capacity(57);
    for ch in value.chars().take(40) {
        if ch.is_ascii_alphanumeric() || ch == '-' || ch == '_' {
            out.push(ch);
        } else {
            out.push('_');
        }
    }
    if out.is_empty() {
        out.push_str("unknown");
    }
    out.push('-');

    let digest = Sha256::digest(value.as_bytes());
    for byte in digest.iter().take(8) {
        let _ = write!(&mut out, "{byte:02x}");
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use friday_core::{
        ApprovalState, FridayConversation, HandoffJudgmentMemory, Mission, MissionStatus, Risk,
        TruthStatus, WorkItem, WorkItemStatus, WorkLane, WorkspaceClaim,
    };
    use serde_json::json;

    fn temp_db_path(tag: &str) -> String {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        std::env::temp_dir()
            .join(format!("friday-observe-wrapper-{tag}-{nanos}.sqlite"))
            .to_string_lossy()
            .to_string()
    }

    fn open_hub_conn(tag: &str) -> rusqlite::Connection {
        let path = temp_db_path(tag);
        let mut conn = rusqlite::Connection::open(&path).unwrap();
        friday_storage::apply_migrations(
            &mut conn,
            &path,
            &friday_storage::hub_migrations(),
            "observe-wrapper-test",
        )
        .unwrap();
        conn
    }

    fn seed_claimed_mission(conn: &rusqlite::Connection, claim: WorkspaceClaim) {
        friday_storage::mission::upsert_conversation(
            conn,
            &FridayConversation {
                friday_conversation_id: "fconv_observe".into(),
                owner_principal: "operator:jarvis".into(),
                title: "Observe wrapper".into(),
                current_focus_summary: "Claim Codex app-server observation".into(),
                active_mission_ids: vec!["mission-observe".into()],
                surface_thread_ids: Vec::new(),
                memory_scope_ref: None,
                truth_status: TruthStatus::WiredRegistry,
                proof_refs: vec!["proof://observe-wrapper-test".into()],
                created_at_ms: 1,
                updated_at_ms: 1,
            },
        )
        .unwrap();
        friday_storage::mission::upsert_mission(
            conn,
            &Mission {
                mission_id: "mission-observe".into(),
                friday_conversation_id: "fconv_observe".into(),
                title: "Observe Codex".into(),
                intent: "Persist ownership-safe Codex observe-wrapper metadata".into(),
                status: MissionStatus::Active,
                why_now: "P0 observe-wrapper needs real process ownership evidence".into(),
                decision_path_summary: "Use existing WorkspaceClaim before upgrading ownership".into(),
                considered_options: vec!["unclaimed process observation".into()],
                deferred_options: vec!["live supervisor daemon".into()],
                known_pitfalls: vec!["do not mark unclaimed provider processes controllable".into()],
                handoff_inheritance: vec!["P0 requires real workspace_claim FK".into()],
                work_item_ids: vec!["work-observe".into()],
                memory_candidate_refs: Vec::new(),
                context_passport_refs: Vec::new(),
                proof_refs: vec!["proof://observe-wrapper-test".into()],
                created_at_ms: 2,
                updated_at_ms: 2,
            },
        )
        .unwrap();
        friday_storage::mission::upsert_work_item(
            conn,
            &WorkItem {
                work_item_id: "work-observe".into(),
                mission_id: "mission-observe".into(),
                lane: WorkLane::Codex,
                target_provider_or_agent: Some("codex".into()),
                status: WorkItemStatus::ReadyToDispatch,
                owner_claim_ids: vec![claim.claim_id.clone()],
                workspace_refs: vec![claim.workspace_ref.clone()],
                capability_id: Some("observe-wrapper".into()),
                risk_level: Risk::Medium,
                approval_state: ApprovalState::NotRequired,
                blocking_reason: None,
                input_refs: vec!["input://observe-wrapper".into()],
                output_refs: Vec::new(),
                proof_requirements: vec!["cargo test -p friday-hub observe_wrapper".into()],
                proof_receipts: Vec::new(),
                judgment_memory: HandoffJudgmentMemory {
                    task: "Observe Codex app server".into(),
                    current_blocker: None,
                    target_lane_thread_agent_provider: "codex".into(),
                    read_first_files: vec![
                        "rust-core/crates/friday-hub/src/observe_wrapper.rs".into()
                    ],
                    required_output: "refs-only observed provider events".into(),
                    done_criteria: vec!["claim-backed process observation persists".into()],
                    red_lines: vec!["never claim unowned provider processes".into()],
                    why_this_route: "P0 starts with Codex observe-wrapper".into(),
                    considered_options: vec!["observe without process ownership".into()],
                    deferred_options: vec!["Claude mirror".into()],
                    previous_pitfalls: vec!["fake mission claim would overstate truth".into()],
                    inheritable_context: vec!["use real WorkspaceClaim FK".into()],
                    proof_requirements: vec!["observe_wrapper helper tests".into()],
                    ownership_claim_ids: vec![claim.claim_id.clone()],
                },
                created_at_ms: 3,
                updated_at_ms: 3,
            },
        )
        .unwrap();
        friday_storage::process_registry::upsert_workspace_claim(conn, &claim).unwrap();
    }

    fn codex_claim(
        claim_id: &str,
        state: ClaimState,
        kind: WorkspaceClaimKind,
        work_item_id: Option<&str>,
    ) -> WorkspaceClaim {
        WorkspaceClaim {
            claim_id: claim_id.into(),
            mission_id: "mission-observe".into(),
            work_item_id: work_item_id.map(ToString::to_string),
            owner_principal: "operator:jarvis".into(),
            owner_agent: "codex".into(),
            workspace_ref: "friday://provider-session/codex-observe".into(),
            claim_kind: kind,
            state,
            reason: "observe-wrapper owns the Codex app-server session".into(),
            safe_release_policy: "release after observe proof and clean handoff".into(),
            proof_requirements: vec!["process observation proof".into()],
            proof_refs: if state == ClaimState::Released {
                vec!["proof://claim-released".into()]
            } else {
                Vec::new()
            },
            created_at_ms: 4,
            updated_at_ms: 5,
            released_at_ms: if state == ClaimState::Released {
                Some(6)
            } else {
                None
            },
        }
    }

    #[test]
    fn observe_wrapper_flag_is_exact_literal_one() {
        assert!(observe_wrapper_enabled_from(Some("1".into())));
        assert!(!observe_wrapper_enabled_from(Some("true".into())));
        assert!(!observe_wrapper_enabled_from(Some("0".into())));
        assert!(!observe_wrapper_enabled_from(None));
    }

    #[test]
    fn codex_observe_ids_do_not_collide_when_long_run_ids_share_a_prefix() {
        let shared_prefix = "run-".to_string() + &"a".repeat(64);
        let first = format!("{shared_prefix}-first");
        let second = format!("{shared_prefix}-second");

        assert_ne!(
            codex_friday_session_id(&first),
            codex_friday_session_id(&second)
        );
        assert_ne!(
            codex_process_observation_id(&first),
            codex_process_observation_id(&second)
        );
        assert!(codex_friday_session_id("run/1").starts_with("codex-observe-run_1-"));
    }

    #[test]
    fn codex_event_persistence_is_refs_only_metadata() {
        let conn = open_hub_conn("event");
        let session_id = codex_friday_session_id("run/1");
        upsert_codex_session_link(
            &conn,
            &session_id,
            "thread/1",
            "gpt-5.5",
            Some("/Users/jarvis/Projects/Friday"),
            10,
        )
        .unwrap();
        let message = JsonRpcServerMessage {
            id: None,
            method: "item/completed".to_string(),
            params: json!({
                "threadId": "thread/1",
                "turnId": "turn/1",
                "item": {
                    "id": "item/1",
                    "type": "agentMessage",
                    "text": "RAW_TRANSCRIPT_SENTINEL"
                }
            }),
        };

        let event_id =
            append_codex_provider_event(&conn, &session_id, &message, 11, 1, None).unwrap();
        assert!(event_id.is_some());

        let events = friday_storage::provider_session::list_events(&conn, &session_id).unwrap();
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].event_kind, "item_completed");
        assert_eq!(events[0].redaction_level, "metadata_only");
        assert!(!events[0].body_ref.contains("RAW_TRANSCRIPT_SENTINEL"));
        assert!(!events[0]
            .provider_event_id
            .contains("RAW_TRANSCRIPT_SENTINEL"));
    }

    #[test]
    fn attach_token_ledger_ref_backfills_existing_session_events_only_after_billing() {
        let conn = open_hub_conn("ledger-ref");
        let session_id = codex_friday_session_id("run-ledger");
        upsert_codex_session_link(&conn, &session_id, "thread-1", "gpt-5.5", None, 10).unwrap();
        let message = JsonRpcServerMessage {
            id: None,
            method: "turn/completed".to_string(),
            params: json!({
                "threadId": "thread-1",
                "turn": {"id": "turn-1", "status": "completed", "items": []}
            }),
        };
        append_codex_provider_event(&conn, &session_id, &message, 11, 1, None).unwrap();

        let before = friday_storage::provider_session::list_events(&conn, &session_id).unwrap();
        assert_eq!(before[0].token_ledger_ref, None);

        let updated = attach_token_ledger_ref(&conn, &session_id, "run-ledger:t0:ledger").unwrap();
        assert_eq!(updated, 1);

        let after = friday_storage::provider_session::list_events(&conn, &session_id).unwrap();
        assert_eq!(
            after[0].token_ledger_ref.as_deref(),
            Some("run-ledger:t0:ledger")
        );
    }

    #[test]
    fn claimed_codex_process_observation_requires_real_active_matching_process_claim() {
        let conn = open_hub_conn("claimed-process");
        seed_claimed_mission(
            &conn,
            codex_claim(
                "claim-codex-provider-session",
                ClaimState::Active,
                WorkspaceClaimKind::ProviderSession,
                Some("work-observe"),
            ),
        );

        let wrote = upsert_claimed_codex_process_observation_for_claim(
            &conn,
            ClaimedCodexProcessObservation {
                observation_id: "obs-codex-claimed",
                pid: 42_424,
                matched_claim_id: "claim-codex-provider-session",
                expected_mission_id: "mission-observe",
                expected_work_item_id: Some("work-observe"),
                cwd_ref: "/Users/jarvis/Projects/Friday",
                observed_at: 20,
                provider_session_ref: Some("friday://provider-session/codex-observe-test"),
            },
        )
        .unwrap();
        assert!(wrote);

        let observed =
            friday_storage::process_registry::get_process_observation(&conn, "obs-codex-claimed")
                .unwrap()
                .expect("claimed observation was persisted");
        assert_eq!(
            observed.matched_claim_id.as_deref(),
            Some("claim-codex-provider-session")
        );
        assert_eq!(
            observed.ownership_status,
            OwnershipStatus::FridayOwnedClaimed
        );
        assert!(observed.is_control_allowed_without_adoption());
        assert!(observed
            .port_bindings
            .contains(&"friday://provider-session/codex-observe-test".to_string()));
    }

    #[test]
    fn claimed_codex_process_observation_context_selects_first_valid_claim() {
        let conn = open_hub_conn("claimed-process-context");
        seed_claimed_mission(
            &conn,
            codex_claim(
                "claim-codex-provider-session",
                ClaimState::Active,
                WorkspaceClaimKind::ProviderSession,
                Some("work-observe"),
            ),
        );
        friday_storage::process_registry::upsert_workspace_claim(
            &conn,
            &codex_claim(
                "claim-codex-workspace-only",
                ClaimState::Active,
                WorkspaceClaimKind::Workspace,
                Some("work-observe"),
            ),
        )
        .unwrap();

        let selected = upsert_claimed_codex_process_observation_for_context(
            &conn,
            "obs-codex-context",
            "codex-observe-context-session",
            42_425,
            &CodexObserveMissionContext {
                mission_id: "mission-observe".into(),
                work_item_id: "work-observe".into(),
                owner_claim_ids: vec![
                    "claim-codex-workspace-only".into(),
                    "claim-codex-provider-session".into(),
                ],
            },
            "/Users/jarvis/Projects/Friday",
            22,
        )
        .unwrap();
        assert_eq!(selected.as_deref(), Some("claim-codex-provider-session"));

        let observed =
            friday_storage::process_registry::get_process_observation(&conn, "obs-codex-context")
                .unwrap()
                .expect("context helper persisted the claimed observation");
        assert_eq!(
            observed.matched_claim_id.as_deref(),
            Some("claim-codex-provider-session")
        );
        assert_eq!(
            observed.ownership_status,
            OwnershipStatus::FridayOwnedClaimed
        );
        assert!(observed
            .port_bindings
            .contains(&"friday://provider-session/codex-observe-context-session".to_string()));
    }

    #[test]
    fn claimed_codex_process_observation_refuses_missing_inactive_wrong_kind_or_mismatched_claim() {
        let conn = open_hub_conn("claimed-process-refuse");
        seed_claimed_mission(
            &conn,
            codex_claim(
                "claim-codex-released",
                ClaimState::Released,
                WorkspaceClaimKind::ProviderSession,
                Some("work-observe"),
            ),
        );
        friday_storage::process_registry::upsert_workspace_claim(
            &conn,
            &codex_claim(
                "claim-codex-workspace-only",
                ClaimState::Active,
                WorkspaceClaimKind::Workspace,
                Some("work-observe"),
            ),
        )
        .unwrap();
        friday_storage::process_registry::upsert_workspace_claim(
            &conn,
            &codex_claim(
                "claim-codex-active-provider",
                ClaimState::Active,
                WorkspaceClaimKind::ProviderSession,
                Some("work-observe"),
            ),
        )
        .unwrap();

        for (claim_id, expected_work_item_id) in [
            ("claim-does-not-exist", Some("work-observe")),
            ("claim-codex-released", Some("work-observe")),
            ("claim-codex-workspace-only", Some("work-observe")),
            ("claim-codex-active-provider", Some("work-other")),
        ] {
            let wrote = upsert_claimed_codex_process_observation_for_claim(
                &conn,
                ClaimedCodexProcessObservation {
                    observation_id: &format!("obs-{claim_id}"),
                    pid: 52_525,
                    matched_claim_id: claim_id,
                    expected_mission_id: "mission-observe",
                    expected_work_item_id,
                    cwd_ref: "/Users/jarvis/Projects/Friday",
                    observed_at: 21,
                    provider_session_ref: None,
                },
            )
            .unwrap();
            assert!(!wrote, "{claim_id} must not produce a claimed observation");
            assert!(friday_storage::process_registry::get_process_observation(
                &conn,
                &format!("obs-{claim_id}")
            )
            .unwrap()
            .is_none());
        }
    }
}
