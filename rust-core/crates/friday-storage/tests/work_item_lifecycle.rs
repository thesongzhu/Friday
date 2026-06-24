//! WorkItem transition-primitive KATs (loop closure, commit 1).
//!
//! `transition_work_item_status` is the WorkItem parity of
//! `transition_mission_status`: it enforces the domain's legal transition graph at
//! the persistence boundary (an illegal hop errors instead of silently upserting),
//! REQUIRES a proof_receipt for a `CompletedWithProof` transition (so completion can
//! never be fake-claimed), and records the hop in the hash-chained audit ledger.
//! Real SQLite; no creds.

mod common;

use common::temp_db_path;
use friday_core::{
    ApprovalState, FridayConversation, HandoffJudgmentMemory, Mission, MissionStatus, Risk,
    RouteDecisionCard, TruthStatus, WorkItem, WorkItemStatus, WorkLane,
};
use friday_storage::{mission::DeferredRouteFollowUpRequest, Db, StorageError};
use std::sync::{Mutex, MutexGuard};

static ENV_LOCK: Mutex<()> = Mutex::new(());

struct EnvGuard {
    key: &'static str,
    previous: Option<String>,
    _lock: MutexGuard<'static, ()>,
}

impl EnvGuard {
    fn set(key: &'static str, value: &str) -> Self {
        let lock = ENV_LOCK.lock().unwrap_or_else(|poison| poison.into_inner());
        let previous = std::env::var(key).ok();
        std::env::set_var(key, value);
        Self {
            key,
            previous,
            _lock: lock,
        }
    }
}

impl Drop for EnvGuard {
    fn drop(&mut self) {
        match &self.previous {
            Some(value) => std::env::set_var(self.key, value),
            None => std::env::remove_var(self.key),
        }
    }
}

fn conversation() -> FridayConversation {
    FridayConversation {
        friday_conversation_id: "fconv_wi_lifecycle".into(),
        owner_principal: "owner-1".into(),
        title: "WorkItem lifecycle".into(),
        current_focus_summary: "transition primitive".into(),
        active_mission_ids: vec!["mission-wi".into()],
        surface_thread_ids: Vec::new(),
        memory_scope_ref: None,
        truth_status: TruthStatus::WiredRegistry,
        proof_refs: vec!["proof://wi".into()],
        created_at_ms: 1,
        updated_at_ms: 1,
    }
}

fn mission() -> Mission {
    Mission {
        mission_id: "mission-wi".into(),
        friday_conversation_id: "fconv_wi_lifecycle".into(),
        title: "WorkItem lifecycle mission".into(),
        intent: "exercise the WorkItem transition primitive".into(),
        status: MissionStatus::Active,
        why_now: "loop closure".into(),
        decision_path_summary: "enforce transitions at persistence".into(),
        considered_options: vec!["validate-only".into()],
        deferred_options: vec!["ui".into()],
        known_pitfalls: vec!["ack is not completion".into()],
        handoff_inheritance: vec!["carry judgment".into()],
        work_item_ids: vec!["work-wi".into()],
        memory_candidate_refs: Vec::new(),
        context_passport_refs: Vec::new(),
        proof_refs: vec!["proof://wi".into()],
        created_at_ms: 1,
        updated_at_ms: 1,
    }
}

fn judgment() -> HandoffJudgmentMemory {
    HandoffJudgmentMemory {
        task: "drive a WorkItem to completion".into(),
        current_blocker: None,
        target_lane_thread_agent_provider: "codex/backend".into(),
        read_first_files: vec!["rust-core/crates/friday-storage/src/mission.rs".into()],
        required_output: "transition KATs".into(),
        done_criteria: vec!["legal chain advances".into()],
        red_lines: vec!["no fake completion".into()],
        why_this_route: "Hub owns lifecycle truth".into(),
        considered_options: vec!["validate-only".into()],
        deferred_options: vec!["native ui".into()],
        previous_pitfalls: vec!["completed without proof".into()],
        inheritable_context: vec!["proof receipts are the only completion evidence".into()],
        proof_requirements: vec!["cargo test -p friday-storage work_item_lifecycle".into()],
        ownership_claim_ids: vec!["own-wi".into()],
    }
}

/// A read-only-shaped WorkItem (no workspace refs) so ownership is not required and
/// the test focuses purely on the lifecycle transition rules.
fn work_item(status: WorkItemStatus) -> WorkItem {
    WorkItem {
        work_item_id: "work-wi".into(),
        mission_id: "mission-wi".into(),
        lane: WorkLane::Codex,
        target_provider_or_agent: Some("codex".into()),
        status,
        owner_claim_ids: Vec::new(),
        workspace_refs: Vec::new(),
        capability_id: Some("provider.codex.turn".into()),
        risk_level: Risk::Medium,
        approval_state: ApprovalState::NotRequired,
        blocking_reason: None,
        input_refs: vec!["input://handoff".into()],
        output_refs: Vec::new(),
        proof_requirements: vec!["provider completion receipt".into()],
        proof_receipts: Vec::new(),
        judgment_memory: judgment(),
        created_at_ms: 1,
        updated_at_ms: 1,
    }
}

fn seed(db: &Db, status: WorkItemStatus) {
    db.upsert_friday_conversation(&conversation()).unwrap();
    db.upsert_mission(&mission()).unwrap();
    db.upsert_work_item(&work_item(status)).unwrap();
}

fn seed_extra_work_item(db: &Db, work_item_id: &str, status: WorkItemStatus) {
    let mut item = work_item(status);
    item.work_item_id = work_item_id.into();
    item.judgment_memory.task = format!("extra WorkItem {work_item_id}");
    db.upsert_work_item(&item).unwrap();

    let mut mission = db.get_mission("mission-wi").unwrap().unwrap();
    if !mission.work_item_ids.contains(&item.work_item_id) {
        mission.work_item_ids.push(item.work_item_id);
    }
    db.upsert_mission(&mission).unwrap();
}

fn seed_route_decision(db: &Db) {
    let item = db.get_work_item("work-wi").unwrap().unwrap();
    let card = RouteDecisionCard::from_work_item(
        "route-decision-work-wi".into(),
        &item,
        vec!["friday://trace/route-decision-work-wi".into()],
        2,
        None,
    );
    db.upsert_route_decision(&card).unwrap();
}

fn seed_hybrid_route_decision(db: &Db) {
    let mut item = db.get_work_item("work-wi").unwrap().unwrap();
    item.judgment_memory.why_this_route =
        "Codex first for workspace execution; Claude synthesis follow-up deferred".into();
    item.judgment_memory.considered_options = vec![
        "combination: Codex first, Claude synthesis after proof".into(),
        "claude: writing only".into(),
    ];
    item.judgment_memory.deferred_options = vec!["Claude synthesis follow-up".into()];
    db.upsert_work_item(&item).unwrap();
    let card = RouteDecisionCard::from_work_item(
        "route-decision-work-wi".into(),
        &item,
        vec!["friday://trace/hybrid-route".into()],
        2,
        None,
    );
    db.upsert_route_decision(&card).unwrap();
}

#[test]
fn legal_chain_advances_to_completed_with_proof() {
    let db = Db::open_hub(&temp_db_path("wi-legal")).unwrap();
    seed(&db, WorkItemStatus::Draft);

    // Draft -> ReadyToDispatch -> Dispatched -> HubAccepted -> ProviderRouted ->
    // ProviderWaiting -> CompletedWithProof. Each hop is a legal edge.
    let chain = [
        (WorkItemStatus::ReadyToDispatch, None),
        (WorkItemStatus::Dispatched, None),
        (WorkItemStatus::HubAccepted, None),
        (WorkItemStatus::ProviderRouted, None),
        (WorkItemStatus::ProviderWaiting, None),
        (
            WorkItemStatus::CompletedWithProof,
            Some("proof://provider-completed"),
        ),
    ];
    for (now, (next, receipt)) in (10..).zip(chain) {
        let (item, _prev) = db
            .transition_work_item_status("work-wi", next, "agent:friday", "advance", receipt, now)
            .unwrap();
        assert_eq!(item.status, next);
    }

    let stored = db.get_work_item("work-wi").unwrap().unwrap();
    assert_eq!(stored.status, WorkItemStatus::CompletedWithProof);
    assert!(
        stored.completion_is_proven(),
        "completed WorkItem carries the proof receipt"
    );
    assert!(stored
        .proof_receipts
        .contains(&"proof://provider-completed".to_string()));
}

#[test]
fn illegal_hop_is_rejected_at_persistence_boundary() {
    let db = Db::open_hub(&temp_db_path("wi-illegal")).unwrap();
    seed(&db, WorkItemStatus::Draft);

    // Draft -> Dispatched is NOT a legal edge (Draft can only go to PreflightBlocked /
    // WaitingForUser / ReadyToDispatch / Merged).
    let err = db
        .transition_work_item_status(
            "work-wi",
            WorkItemStatus::Dispatched,
            "agent:friday",
            "skip the queue",
            None,
            10,
        )
        .unwrap_err();
    assert!(matches!(err, StorageError::Unsupported(_)));

    // The illegal hop persisted nothing: the WorkItem is still Draft.
    assert_eq!(
        db.get_work_item("work-wi").unwrap().unwrap().status,
        WorkItemStatus::Draft
    );
}

#[test]
fn completed_with_proof_without_a_receipt_is_rejected() {
    let db = Db::open_hub(&temp_db_path("wi-fake-done")).unwrap();
    seed(&db, WorkItemStatus::ProviderWaiting);

    // ProviderWaiting -> CompletedWithProof is a LEGAL edge, but completion without a
    // proof receipt is a fake-ready completion and must be rejected.
    let err = db
        .transition_work_item_status(
            "work-wi",
            WorkItemStatus::CompletedWithProof,
            "agent:friday",
            "claim done",
            None,
            10,
        )
        .unwrap_err();
    assert!(matches!(err, StorageError::Unsupported(_)));

    // Nothing advanced: the WorkItem is still ProviderWaiting (not fake-completed).
    let stored = db.get_work_item("work-wi").unwrap().unwrap();
    assert_eq!(stored.status, WorkItemStatus::ProviderWaiting);
    assert!(!stored.completion_is_proven());

    // The SAME transition WITH a receipt now succeeds (proven completion).
    let (item, prev) = db
        .transition_work_item_status(
            "work-wi",
            WorkItemStatus::CompletedWithProof,
            "agent:friday",
            "claim done with proof",
            Some("proof://real-receipt"),
            11,
        )
        .unwrap();
    assert_eq!(prev, WorkItemStatus::ProviderWaiting);
    assert_eq!(item.status, WorkItemStatus::CompletedWithProof);
    assert!(item.completion_is_proven());
}

#[test]
fn final_completed_work_item_closes_active_mission_with_audit_proof() {
    let db = Db::open_hub(&temp_db_path("wi-final-closes-mission")).unwrap();
    seed(&db, WorkItemStatus::ProviderWaiting);

    let (item, prev) = db
        .transition_work_item_status(
            "work-wi",
            WorkItemStatus::CompletedWithProof,
            "agent:friday",
            "claim done with proof",
            Some("proof://provider-completed"),
            10,
        )
        .unwrap();
    assert_eq!(prev, WorkItemStatus::ProviderWaiting);
    assert_eq!(item.status, WorkItemStatus::CompletedWithProof);

    let mission = db.get_mission("mission-wi").unwrap().unwrap();
    assert_eq!(mission.status, MissionStatus::Done);
    assert!(mission
        .proof_refs
        .contains(&"audit://workitem_lifecycle:work-wi:10".to_string()));
    assert!(mission
        .decision_path_summary
        .contains("auto-close after WorkItem 'work-wi' completed_with_proof"));

    // M2 (audit-coverage hardening): the auto-close is itself a Mission status hop (active->done),
    // so it leaves its OWN hash-chained receipt (distinct `mission_autoclose:` id) inside the SAME
    // txn as the triggering WorkItem completion — not only the WorkItem's `workitem_lifecycle:` row.
    let autoclose_action: String = db
        .conn()
        .query_row(
            "SELECT action FROM audit_ledger WHERE audit_id = 'mission_autoclose:mission-wi:10'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(
        autoclose_action,
        "mission.lifecycle:active->done:auto_close_after_work_item:work-wi"
    );
    assert!(
        friday_storage::audit::verify_audit_chain(db.conn()).is_ok(),
        "WorkItem lifecycle row + auto-close mission row both verify in the chain"
    );

    let conversation = db
        .get_friday_conversation("fconv_wi_lifecycle")
        .unwrap()
        .unwrap();
    assert!(
        !conversation
            .active_mission_ids
            .contains(&"mission-wi".to_string()),
        "closed Mission is removed from the active conversation set"
    );
}

#[test]
fn completed_work_item_does_not_close_mission_while_sibling_is_unfinished() {
    let db = Db::open_hub(&temp_db_path("wi-sibling-open")).unwrap();
    seed(&db, WorkItemStatus::ProviderWaiting);
    seed_extra_work_item(&db, "work-wi-sibling", WorkItemStatus::ReadyToDispatch);

    db.transition_work_item_status(
        "work-wi",
        WorkItemStatus::CompletedWithProof,
        "agent:friday",
        "first leg done",
        Some("proof://provider-completed"),
        10,
    )
    .unwrap();

    assert_eq!(
        db.get_mission("mission-wi").unwrap().unwrap().status,
        MissionStatus::Active,
        "Mission remains active until every WorkItem is completed_with_proof"
    );
}

#[test]
fn outcome_checked_flag_rejects_free_text_completion_for_outcome_requirement() {
    let _guard = EnvGuard::set("FRIDAY_OUTCOME_CHECKED_PROOF", "1");
    let db = Db::open_hub(&temp_db_path("wi-outcome-free-text")).unwrap();
    seed(&db, WorkItemStatus::ProviderWaiting);
    let mut item = db.get_work_item("work-wi").unwrap().unwrap();
    item.proof_requirements = vec!["outcome:ToolsExecuted:>=1".into()];
    db.upsert_work_item(&item).unwrap();

    let err = db
        .transition_work_item_status(
            "work-wi",
            WorkItemStatus::CompletedWithProof,
            "agent:friday",
            "claim done with free-text proof",
            Some("proof://provider-completed"),
            10,
        )
        .unwrap_err();
    assert!(matches!(err, StorageError::Unsupported(_)));

    let stored = db.get_work_item("work-wi").unwrap().unwrap();
    assert_eq!(stored.status, WorkItemStatus::ProviderWaiting);
    assert!(stored.proof_receipts.is_empty());
}

#[test]
fn outcome_checked_flag_accepts_matching_typed_outcome_receipt() {
    let _guard = EnvGuard::set("FRIDAY_OUTCOME_CHECKED_PROOF", "1");
    let db = Db::open_hub(&temp_db_path("wi-outcome-typed")).unwrap();
    seed(&db, WorkItemStatus::ProviderWaiting);
    let mut item = db.get_work_item("work-wi").unwrap().unwrap();
    item.proof_requirements = vec!["outcome:ToolsExecuted:>=1".into()];
    db.upsert_work_item(&item).unwrap();

    let (item, prev) = db
        .transition_work_item_status(
            "work-wi",
            WorkItemStatus::CompletedWithProof,
            "agent:friday",
            "claim done with typed outcome",
            Some("proof://outcome/ToolsExecuted/run-1?signal=executed_tools=1"),
            10,
        )
        .unwrap();
    assert_eq!(prev, WorkItemStatus::ProviderWaiting);
    assert_eq!(item.status, WorkItemStatus::CompletedWithProof);
    assert!(item.completion_outcome_is_proven());
}

#[test]
fn outcome_checked_flag_rejects_direct_upsert_with_untyped_outcome_receipt() {
    let _guard = EnvGuard::set("FRIDAY_OUTCOME_CHECKED_PROOF", "1");
    let db = Db::open_hub(&temp_db_path("wi-outcome-direct-upsert")).unwrap();
    seed(&db, WorkItemStatus::ProviderWaiting);

    let mut item = db.get_work_item("work-wi").unwrap().unwrap();
    item.status = WorkItemStatus::CompletedWithProof;
    item.proof_requirements = vec!["outcome:ToolsExecuted:>=1".into()];
    item.proof_receipts = vec!["proof://provider-completed".into()];

    let err = db.upsert_work_item(&item).unwrap_err();
    assert!(matches!(err, StorageError::Unsupported(_)));

    let stored = db.get_work_item("work-wi").unwrap().unwrap();
    assert_eq!(stored.status, WorkItemStatus::ProviderWaiting);
    assert!(stored.proof_receipts.is_empty());
}

#[test]
fn proof_receipt_on_a_non_completion_transition_is_rejected() {
    let db = Db::open_hub(&temp_db_path("wi-stray-receipt")).unwrap();
    seed(&db, WorkItemStatus::Draft);

    // A receipt presented for a non-completion hop would be silently dropped and
    // misrepresent the transition — reject it.
    let err = db
        .transition_work_item_status(
            "work-wi",
            WorkItemStatus::ReadyToDispatch,
            "agent:friday",
            "advance with a stray receipt",
            Some("proof://stray"),
            10,
        )
        .unwrap_err();
    assert!(matches!(err, StorageError::Unsupported(_)));
    assert_eq!(
        db.get_work_item("work-wi").unwrap().unwrap().status,
        WorkItemStatus::Draft
    );
}

#[test]
fn route_decision_veto_blocks_ready_to_dispatched_lifecycle_hop() {
    let db = Db::open_hub(&temp_db_path("wi-route-veto")).unwrap();
    seed(&db, WorkItemStatus::ReadyToDispatch);
    seed_route_decision(&db);

    db.veto_route_decision(
        "route-decision-work-wi",
        "operator:jarvis",
        "operator vetoed the proposed Codex route",
        20,
    )
    .unwrap();

    let err = db
        .transition_work_item_status(
            "work-wi",
            WorkItemStatus::Dispatched,
            "agent:friday",
            "dispatch proposed route",
            None,
            21,
        )
        .unwrap_err();
    assert!(
        matches!(err, StorageError::Unsupported(ref message) if message.contains("route_decision_veto_active:route-decision-work-wi")),
        "veto must fail closed at the dispatch lifecycle edge, got {err:?}"
    );
    let stored = db.get_work_item("work-wi").unwrap().unwrap();
    assert_eq!(stored.status, WorkItemStatus::ReadyToDispatch);
    assert_eq!(stored.lane, WorkLane::Codex);
    assert_eq!(stored.target_provider_or_agent.as_deref(), Some("codex"));
}

#[test]
fn route_decision_override_reassigns_before_dispatch_in_same_lifecycle_hop() {
    let db = Db::open_hub(&temp_db_path("wi-route-override")).unwrap();
    seed(&db, WorkItemStatus::ReadyToDispatch);
    seed_route_decision(&db);

    db.override_route_decision(
        "route-decision-work-wi",
        WorkLane::Claude,
        Some("claude"),
        "operator:jarvis",
        "operator reassigned review-heavy work to Claude",
        20,
    )
    .unwrap();

    let (item, prev) = db
        .transition_work_item_status(
            "work-wi",
            WorkItemStatus::Dispatched,
            "agent:friday",
            "dispatch with operator route override",
            None,
            21,
        )
        .unwrap();

    assert_eq!(prev, WorkItemStatus::ReadyToDispatch);
    assert_eq!(item.status, WorkItemStatus::Dispatched);
    assert_eq!(item.lane, WorkLane::Claude);
    assert_eq!(item.target_provider_or_agent.as_deref(), Some("claude"));

    let override_audits: i64 = db
        .conn()
        .query_row(
            "SELECT COUNT(*) FROM audit_ledger WHERE action LIKE 'route_decision.override_applied:%'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(
        override_audits, 1,
        "override must be applied as a real audited pre-dispatch lifecycle control"
    );
}

#[test]
fn completed_hybrid_source_materializes_deferred_claude_follow_up_work_item() {
    let db = Db::open_hub(&temp_db_path("wi-deferred-followup")).unwrap();
    seed(&db, WorkItemStatus::ProviderWaiting);
    seed_hybrid_route_decision(&db);
    let (source, _) = db
        .transition_work_item_status(
            "work-wi",
            WorkItemStatus::CompletedWithProof,
            "agent:codex",
            "codex first leg completed",
            Some("friday://agent-run/run-codex-first"),
            10,
        )
        .unwrap();
    assert_eq!(source.status, WorkItemStatus::CompletedWithProof);
    assert_eq!(
        db.get_mission("mission-wi").unwrap().unwrap().status,
        MissionStatus::Active,
        "unmaterialized deferred follow-up keeps Mission open"
    );

    let follow = db
        .materialize_deferred_route_follow_up(DeferredRouteFollowUpRequest {
            decision_id: "route-decision-work-wi",
            source_work_item_id: "work-wi",
            follow_up_work_item_id: "work-wi-claude-followup",
            follow_up_lane: WorkLane::Claude,
            follow_up_provider_or_agent: Some("claude"),
            actor_ref: "agent:friday",
            reason: "create tracked Claude synthesis leg after Codex proof",
            now_ms: 20,
        })
        .unwrap();

    assert_eq!(follow.status, WorkItemStatus::ReadyToDispatch);
    assert_eq!(follow.lane, WorkLane::Claude);
    assert_eq!(follow.target_provider_or_agent.as_deref(), Some("claude"));
    assert_eq!(
        follow.input_refs,
        vec!["friday://agent-run/run-codex-first".to_string()],
        "the Claude follow-up inherits the proven Codex first-leg receipt as input"
    );
    assert!(follow
        .judgment_memory
        .why_this_route
        .contains("Materialized deferred route option"));
    assert!(follow
        .judgment_memory
        .deferred_options
        .iter()
        .any(|option| option.contains("automatic follow-up execution is separate")));

    let mission = db.get_mission("mission-wi").unwrap().unwrap();
    assert!(mission
        .work_item_ids
        .contains(&"work-wi-claude-followup".to_string()));
    assert!(mission
        .handoff_inheritance
        .contains(&"deferred_follow_up:work-wi-claude-followup".to_string()));

    let route = db
        .list_route_decisions_for_mission("mission-wi")
        .unwrap()
        .into_iter()
        .find(|route| route.work_item_id == "work-wi-claude-followup")
        .expect("follow-up route decision");
    assert_eq!(route.selected_lane, WorkLane::Claude);
    assert_eq!(route.selected_provider_or_agent.as_deref(), Some("claude"));
    assert!(route
        .trace_refs
        .contains(&"friday://route-decision/route-decision-work-wi".to_string()));

    let audits: i64 = db
        .conn()
        .query_row(
            "SELECT COUNT(*) FROM audit_ledger WHERE action LIKE 'route_decision.deferred_follow_up_materialized:%'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(audits, 1);
}

#[test]
fn mission_closes_after_materialized_deferred_follow_up_completes() {
    let db = Db::open_hub(&temp_db_path("wi-deferred-followup-close")).unwrap();
    seed(&db, WorkItemStatus::ProviderWaiting);
    seed_hybrid_route_decision(&db);

    db.transition_work_item_status(
        "work-wi",
        WorkItemStatus::CompletedWithProof,
        "agent:codex",
        "codex first leg completed",
        Some("proof://outcome/AnswerProduced/run-codex-first?signal=answer_len=12"),
        10,
    )
    .unwrap();

    db.materialize_deferred_route_follow_up(DeferredRouteFollowUpRequest {
        decision_id: "route-decision-work-wi",
        source_work_item_id: "work-wi",
        follow_up_work_item_id: "work-wi-claude-followup",
        follow_up_lane: WorkLane::Claude,
        follow_up_provider_or_agent: Some("claude"),
        actor_ref: "agent:friday",
        reason: "create tracked Claude synthesis leg after Codex proof",
        now_ms: 20,
    })
    .unwrap();

    for (now, next) in [
        (21, WorkItemStatus::Dispatched),
        (22, WorkItemStatus::HubAccepted),
        (23, WorkItemStatus::ProviderRouted),
        (24, WorkItemStatus::ProviderWaiting),
    ] {
        db.transition_work_item_status(
            "work-wi-claude-followup",
            next,
            "agent:friday",
            "advance follow-up",
            None,
            now,
        )
        .unwrap();
    }
    db.transition_work_item_status(
        "work-wi-claude-followup",
        WorkItemStatus::CompletedWithProof,
        "agent:claude",
        "claude follow-up completed",
        Some("proof://outcome/AnswerProduced/run-claude-followup?signal=answer_len=18"),
        25,
    )
    .unwrap();

    let mission = db.get_mission("mission-wi").unwrap().unwrap();
    assert_eq!(mission.status, MissionStatus::Done);
    assert!(mission
        .proof_refs
        .contains(&"audit://workitem_lifecycle:work-wi-claude-followup:25".to_string()));
}

#[test]
fn mission_closes_when_run_bound_deferred_decision_materializes_intake_twin() {
    let db = Db::open_hub(&temp_db_path("wi-deferred-followup-intake-twin-close")).unwrap();
    seed(&db, WorkItemStatus::ProviderWaiting);
    seed_hybrid_route_decision(&db);

    db.transition_work_item_status(
        "work-wi",
        WorkItemStatus::CompletedWithProof,
        "agent:codex",
        "codex first leg completed",
        Some("friday://agent-run/run-codex-first"),
        10,
    )
    .unwrap();

    let mut source = db.get_work_item("work-wi").unwrap().unwrap();
    source.judgment_memory.why_this_route =
        "Codex first for workspace execution; Claude synthesis follow-up deferred".into();
    source.judgment_memory.considered_options = vec![
        "combination: Codex first, Claude synthesis after proof".into(),
        "claude: writing only".into(),
    ];
    source.judgment_memory.deferred_options = vec!["Claude synthesis follow-up".into()];
    db.upsert_route_decision(&RouteDecisionCard::from_work_item(
        "route-decision:agent-loop:run-codex-first".into(),
        &source,
        vec![
            "agent-run:run-codex-first".into(),
            "friday://agent-run/run-codex-first".into(),
        ],
        11,
        None,
    ))
    .unwrap();

    db.materialize_deferred_route_follow_up(DeferredRouteFollowUpRequest {
        decision_id: "route-decision:agent-loop:run-codex-first",
        source_work_item_id: "work-wi",
        follow_up_work_item_id: "work-wi-claude-followup",
        follow_up_lane: WorkLane::Claude,
        follow_up_provider_or_agent: Some("claude"),
        actor_ref: "agent:friday",
        reason: "create tracked Claude synthesis leg after Codex proof",
        now_ms: 12,
    })
    .unwrap();

    for (now, next) in [
        (13, WorkItemStatus::Dispatched),
        (14, WorkItemStatus::HubAccepted),
        (15, WorkItemStatus::ProviderRouted),
        (16, WorkItemStatus::ProviderWaiting),
    ] {
        db.transition_work_item_status(
            "work-wi-claude-followup",
            next,
            "agent:friday",
            "advance follow-up",
            None,
            now,
        )
        .unwrap();
    }
    db.transition_work_item_status(
        "work-wi-claude-followup",
        WorkItemStatus::CompletedWithProof,
        "agent:claude",
        "claude follow-up completed",
        Some("proof://outcome/AnswerProduced/run-claude-followup?signal=answer_len=18"),
        17,
    )
    .unwrap();

    let mission = db.get_mission("mission-wi").unwrap().unwrap();
    assert_eq!(
        mission.status,
        MissionStatus::Done,
        "a stale intake-time deferred decision must not keep the Mission active after the same source WorkItem's run-bound decision materialized and completed its follow-up"
    );
    assert!(mission
        .proof_refs
        .contains(&"audit://workitem_lifecycle:work-wi-claude-followup:17".to_string()));
}

#[test]
fn deferred_follow_up_requires_proven_source_and_unused_follow_up_id() {
    let db = Db::open_hub(&temp_db_path("wi-deferred-followup-gates")).unwrap();
    seed(&db, WorkItemStatus::ReadyToDispatch);
    seed_route_decision(&db);

    let unproven = db
        .materialize_deferred_route_follow_up(DeferredRouteFollowUpRequest {
            decision_id: "route-decision-work-wi",
            source_work_item_id: "work-wi",
            follow_up_work_item_id: "work-wi-claude-followup",
            follow_up_lane: WorkLane::Claude,
            follow_up_provider_or_agent: Some("claude"),
            actor_ref: "agent:friday",
            reason: "should fail",
            now_ms: 20,
        })
        .unwrap_err();
    assert!(
        matches!(unproven, StorageError::Unsupported(ref message) if message.contains("must be completed_with_proof")),
        "unproven source must fail closed, got {unproven:?}"
    );

    for (now, next) in [
        (21, WorkItemStatus::Dispatched),
        (22, WorkItemStatus::HubAccepted),
        (23, WorkItemStatus::ProviderRouted),
        (24, WorkItemStatus::ProviderWaiting),
    ] {
        db.transition_work_item_status("work-wi", next, "agent:friday", "advance", None, now)
            .unwrap();
    }
    db.transition_work_item_status(
        "work-wi",
        WorkItemStatus::CompletedWithProof,
        "agent:friday",
        "advance",
        Some("friday://agent-run/run-codex-first"),
        25,
    )
    .unwrap();

    let follow = db
        .materialize_deferred_route_follow_up(DeferredRouteFollowUpRequest {
            decision_id: "route-decision-work-wi",
            source_work_item_id: "work-wi",
            follow_up_work_item_id: "work-wi-claude-followup",
            follow_up_lane: WorkLane::Claude,
            follow_up_provider_or_agent: Some("claude"),
            actor_ref: "agent:friday",
            reason: "create tracked Claude synthesis leg after Codex proof",
            now_ms: 26,
        })
        .unwrap();
    assert_eq!(follow.status, WorkItemStatus::ReadyToDispatch);

    let duplicate_follow_up = db
        .materialize_deferred_route_follow_up(DeferredRouteFollowUpRequest {
            decision_id: "route-decision-work-wi",
            source_work_item_id: "work-wi",
            follow_up_work_item_id: "work-wi-claude-followup",
            follow_up_lane: WorkLane::Claude,
            follow_up_provider_or_agent: Some("claude"),
            actor_ref: "agent:friday",
            reason: "should fail",
            now_ms: 27,
        })
        .unwrap_err();
    assert!(
        matches!(duplicate_follow_up, StorageError::Unsupported(ref message) if message.contains("already exists")),
        "duplicate follow-up id must fail closed, got {duplicate_follow_up:?}"
    );
}

// ───────────────────────── #24b durable execution-state helpers ─────────────────────────

#[test]
fn execution_state_default_is_not_executing_and_null_heartbeat() {
    // A freshly-seeded (migrated) WorkItem reads back the fail-closed at-rest value: NOT executing,
    // NULL heartbeat — so boot crash-recovery PASS-2 never mis-classifies a never-touched row.
    let db = Db::open_hub(&temp_db_path("wi-exec-default")).unwrap();
    seed(&db, WorkItemStatus::ProviderWaiting);

    let state = db
        .get_work_item_execution_state("work-wi")
        .unwrap()
        .unwrap();
    assert!(!state.executing, "default executing == false");
    assert_eq!(state.last_heartbeat_ms, None, "default heartbeat == NULL");
}

#[test]
fn set_work_item_executing_round_trips_set_and_clear() {
    let db = Db::open_hub(&temp_db_path("wi-exec-rt")).unwrap();
    seed(&db, WorkItemStatus::ProviderWaiting);

    // SET (model call in flight).
    db.set_work_item_executing("work-wi", true, 5_000).unwrap();
    let s = db
        .get_work_item_execution_state("work-wi")
        .unwrap()
        .unwrap();
    assert!(s.executing);
    assert_eq!(s.last_heartbeat_ms, Some(5_000));

    // CLEAR (loop exit).
    db.set_work_item_executing("work-wi", false, 6_000).unwrap();
    let s = db
        .get_work_item_execution_state("work-wi")
        .unwrap()
        .unwrap();
    assert!(!s.executing, "cleared at loop exit");
    assert_eq!(s.last_heartbeat_ms, Some(6_000));
}

#[test]
fn set_work_item_executing_on_missing_row_is_a_no_op_not_an_error() {
    // A sessionless / missing work_item is a 0-row UPDATE no-op (fail-safe): the loop's best-effort
    // heartbeat must never error on a run with no bound WorkItem.
    let db = Db::open_hub(&temp_db_path("wi-exec-missing")).unwrap();
    db.set_work_item_executing("no-such-work-item", true, 1_000)
        .expect("missing-row set is a no-op Ok");
    assert!(db
        .get_work_item_execution_state("no-such-work-item")
        .unwrap()
        .is_none());
}

#[test]
fn upsert_work_item_does_not_clobber_the_execution_marker() {
    // THE no-degrade invariant the crash-recovery `blocking_reason` re-upsert relies on:
    // `upsert_work_item` does NOT write `executing`/`last_heartbeat_ms`, so a status-preserving
    // re-upsert (which clones the WorkItem) leaves the durable execution marker intact.
    let db = Db::open_hub(&temp_db_path("wi-exec-noclobber")).unwrap();
    seed(&db, WorkItemStatus::ProviderWaiting);
    db.set_work_item_executing("work-wi", true, 9_000).unwrap();

    // Re-upsert the WorkItem (the marker write path the reconcile uses to stamp blocking_reason).
    let mut item = db.get_work_item("work-wi").unwrap().unwrap();
    item.blocking_reason = Some("crash_recovery_abort".into());
    item.updated_at_ms = 12_345;
    db.upsert_work_item(&item).unwrap();

    // The execution marker survived the re-upsert untouched.
    let s = db
        .get_work_item_execution_state("work-wi")
        .unwrap()
        .unwrap();
    assert!(s.executing, "upsert must not clobber executing");
    assert_eq!(
        s.last_heartbeat_ms,
        Some(9_000),
        "upsert must not clobber the heartbeat"
    );
    assert_eq!(
        db.get_work_item("work-wi")
            .unwrap()
            .unwrap()
            .blocking_reason,
        Some("crash_recovery_abort".into())
    );
}

#[test]
fn transition_clearing_executing_lands_status_and_clear_in_one_write() {
    // DEGRADE-3 atomicity KAT (guarded path): the clearing transition variant lands the status hop
    // AND `executing = 0` together. A run that reaches its rest state can therefore never be left
    // `executing == 1` by a swallowed best-effort tail clear.
    let db = Db::open_hub(&temp_db_path("wi-exec-clear-guarded")).unwrap();
    seed(&db, WorkItemStatus::ReadyToDispatch);
    db.set_work_item_executing("work-wi", true, 9_000).unwrap();

    // ReadyToDispatch -> Dispatched, clearing executing in the SAME tx.
    let (_item, prev) = db
        .transition_work_item_status_clearing_executing(
            "work-wi",
            WorkItemStatus::Dispatched,
            "agent:friday",
            "advance",
            None,
            10_000,
        )
        .unwrap();
    assert_eq!(prev, WorkItemStatus::ReadyToDispatch);
    assert_eq!(
        db.get_work_item("work-wi").unwrap().unwrap().status,
        WorkItemStatus::Dispatched
    );
    let s = db
        .get_work_item_execution_state("work-wi")
        .unwrap()
        .unwrap();
    assert!(
        !s.executing,
        "executing cleared atomically with the status hop"
    );
    assert_eq!(
        s.last_heartbeat_ms,
        Some(9_000),
        "the clear preserves last_heartbeat_ms (PASS-2 ignores it on executing==0 rows)"
    );
}

#[test]
fn upsert_clearing_executing_lands_status_and_clear_in_one_write() {
    // DEGRADE-3 atomicity KAT (OFF / inline path): the clearing upsert variant lands the row write
    // AND `executing = 0` together — the un-guarded parity of the clearing transition above.
    let db = Db::open_hub(&temp_db_path("wi-exec-clear-off")).unwrap();
    seed(&db, WorkItemStatus::ProviderRouted);
    db.set_work_item_executing("work-wi", true, 9_000).unwrap();

    let mut item = db.get_work_item("work-wi").unwrap().unwrap();
    item.updated_at_ms = 11_000;
    db.upsert_work_item_clearing_executing(&item).unwrap();

    let s = db
        .get_work_item_execution_state("work-wi")
        .unwrap()
        .unwrap();
    assert!(!s.executing, "executing cleared atomically with the upsert");
    assert_eq!(s.last_heartbeat_ms, Some(9_000));
}
