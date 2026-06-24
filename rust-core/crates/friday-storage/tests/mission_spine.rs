//! Mission Spine persistence/projection tests.
//!
//! These tests prove the first storage slice of Friday's global-secretary graph:
//! same Mission projects to mobile + desktop from Hub-owned state, provider/channel
//! ids are not canonical conversation ids, duplicate work is detectable before
//! dispatch, and ack/completion/proof boundaries are enforced at persistence.

mod common;

use common::temp_db_path;
use friday_core::Risk;
use friday_core::{
    ApprovalState, FridayConversation, HandoffJudgmentMemory, Mission, MissionLink,
    MissionLinkKind, MissionStatus, RouteDecisionCard, SurfaceEvent, SurfaceEventKind, SurfaceKind,
    SurfaceThread, TruthStatus, VisibilityPolicy, WorkItem, WorkItemStatus, WorkLane,
};
use friday_storage::{hub_migrations, Db, Profile, StorageError, HUB_ONLY_TABLES};

fn hub_max_version() -> i64 {
    hub_migrations().iter().map(|m| m.version).max().unwrap()
}

fn conversation() -> FridayConversation {
    FridayConversation {
        friday_conversation_id: "fconv_20260604_global".into(),
        owner_principal: "operator:jarvis".into(),
        title: "Friday global secretary".into(),
        current_focus_summary: "Build Mission Spine so surfaces do not fork truth".into(),
        active_mission_ids: vec!["mission-spine".into()],
        surface_thread_ids: vec!["surface-mobile".into(), "surface-desktop".into()],
        memory_scope_ref: Some("memory-scope-project-friday".into()),
        truth_status: TruthStatus::NoGo,
        proof_refs: vec!["closed-loop-15-15".into()],
        created_at_ms: 1,
        updated_at_ms: 10,
    }
}

fn mission(id: &str, status: MissionStatus, intent: &str) -> Mission {
    Mission {
        mission_id: id.into(),
        friday_conversation_id: "fconv_20260604_global".into(),
        title: "Rust canonical mission graph".into(),
        intent: intent.into(),
        status,
        why_now: "avoid pinned chat debt and duplicate agent work".into(),
        decision_path_summary: "Rust Hub owns Mission, provider timelines attach as evidence"
            .into(),
        considered_options: vec!["provider-thread-as-product-id".into()],
        deferred_options: vec!["final UI wiring".into()],
        known_pitfalls: vec!["Hub ack is not provider completion".into()],
        handoff_inheritance: vec!["carry why route and previous pitfalls".into()],
        work_item_ids: vec!["work-codex".into()],
        memory_candidate_refs: vec!["mem-candidate".into()],
        context_passport_refs: vec!["passport-required-before-provider".into()],
        proof_refs: vec!["proof-mission-domain-tests".into()],
        created_at_ms: 2,
        updated_at_ms: 11,
    }
}

fn judgment() -> HandoffJudgmentMemory {
    HandoffJudgmentMemory {
        task: "Wire Mission Spine storage".into(),
        current_blocker: Some("storage/projection missing".into()),
        target_lane_thread_agent_provider: "friday-storage".into(),
        read_first_files: vec!["rust-core/crates/friday-storage/src/schema.rs".into()],
        required_output: "Hub-only mission storage and projection tests".into(),
        done_criteria: vec!["same mission projects to mobile and desktop".into()],
        red_lines: vec!["do not key UI on provider thread ids".into()],
        why_this_route: "storage/projection must exist before UI wiring".into(),
        considered_options: vec!["frontend-only projection".into()],
        deferred_options: vec!["provider-native sync claim".into()],
        previous_pitfalls: vec!["candidate memory is not authority".into()],
        inheritable_context: vec!["slice1 core invariants already exist".into()],
        proof_requirements: vec!["cargo test -p friday-storage --test mission_spine".into()],
        ownership_claim_ids: vec!["own-mission-spine".into()],
    }
}

fn work_item(id: &str, status: WorkItemStatus) -> WorkItem {
    WorkItem {
        work_item_id: id.into(),
        mission_id: "mission-spine".into(),
        lane: WorkLane::Codex,
        target_provider_or_agent: Some("codex-app-server-local".into()),
        status,
        owner_claim_ids: vec!["own-mission-spine".into()],
        workspace_refs: vec!["/tmp/friday-mission-spine".into()],
        capability_id: Some("provider.codex.turn".into()),
        risk_level: Risk::Medium,
        approval_state: ApprovalState::Required,
        blocking_reason: None,
        input_refs: vec!["input-context-passport".into()],
        output_refs: vec![],
        proof_requirements: vec!["provider completion receipt".into()],
        proof_receipts: if status == WorkItemStatus::CompletedWithProof {
            vec!["proof-provider-completed".into()]
        } else {
            vec![]
        },
        judgment_memory: judgment(),
        created_at_ms: 3,
        updated_at_ms: 12,
    }
}

fn surface(id: &str, kind: SurfaceKind, policy: VisibilityPolicy) -> SurfaceThread {
    SurfaceThread {
        surface_thread_id: id.into(),
        friday_conversation_id: "fconv_20260604_global".into(),
        mission_id: Some("mission-spine".into()),
        surface_kind: kind,
        channel_binding_id: None,
        delivery_route: format!("route:{id}"),
        visibility_policy: policy,
        allowed_actions: vec!["open_mission".into(), "inspect_proof".into()],
        last_seen_at_ms: Some(20),
        last_delivered_event_seq: Some(7),
        created_at_ms: 4,
        updated_at_ms: 13,
    }
}

fn surface_event(id: &str) -> SurfaceEvent {
    SurfaceEvent {
        surface_event_id: id.into(),
        friday_conversation_id: "fconv_20260604_global".into(),
        mission_id: "mission-spine".into(),
        work_item_id: Some("work-codex".into()),
        surface_thread_id: "surface-mobile".into(),
        source_surface: SurfaceKind::Mobile,
        event_kind: SurfaceEventKind::UserMessage,
        body_ref: Some("friday://body/mobile-message/1".into()),
        visibility_policy: VisibilityPolicy::Compact,
        proof_ref: Some("audit://surface-event-redacted".into()),
        created_at_ms: 21,
    }
}

#[test]
fn mission_spine_tables_are_hub_only_and_forward_migrated() {
    for table in [
        "friday_conversation",
        "mission",
        "work_item",
        "surface_thread",
        "surface_event",
        "mission_link",
        "route_decision",
    ] {
        assert!(HUB_ONLY_TABLES.contains(&table));
    }

    let p = temp_db_path("mission-spine-mig");
    {
        let mut migs = hub_migrations();
        migs.truncate(8);
        let db = Db::open(&p, Profile::Hub, &migs, "v8").unwrap();
        assert_eq!(db.version().unwrap(), 8);
        assert!(!db
            .table_names()
            .unwrap()
            .iter()
            .any(|t| t == "friday_conversation"));
    }

    let db = Db::open_hub(&p).unwrap();
    assert_eq!(db.version().unwrap(), hub_max_version());
    let tables = db.table_names().unwrap();
    for table in [
        "friday_conversation",
        "mission",
        "work_item",
        "surface_thread",
        "surface_event",
        "mission_link",
        "route_decision",
    ] {
        assert!(tables.iter().any(|t| t == table));
    }

    let phone = Db::open_phone(&temp_db_path("mission-spine-phone")).unwrap();
    let phone_tables = phone.table_names().unwrap();
    assert!(!phone_tables.iter().any(|t| t == "friday_conversation"));
    assert!(matches!(
        phone.list_mission_surface_projections("fconv_20260604_global"),
        Err(StorageError::Unsupported(_))
    ));
    assert!(matches!(
        phone.list_route_decision_projections_for_mission("mission-spine"),
        Err(StorageError::Unsupported(_))
    ));
    assert!(matches!(
        phone.list_surface_events_for_mission("mission-spine"),
        Err(StorageError::Unsupported(_))
    ));
}

#[test]
fn same_mission_projects_to_mobile_and_desktop_without_provider_raw_ids() {
    let db = Db::open_hub(&temp_db_path("mission-spine-projection")).unwrap();
    db.upsert_friday_conversation(&conversation()).unwrap();
    db.upsert_mission(&mission(
        "mission-spine",
        MissionStatus::Active,
        "mission-spine-storage",
    ))
    .unwrap();
    db.upsert_work_item(&work_item("work-codex", WorkItemStatus::HubAccepted))
        .unwrap();
    db.upsert_surface_thread(&surface(
        "surface-mobile",
        SurfaceKind::Mobile,
        VisibilityPolicy::Compact,
    ))
    .unwrap();
    db.upsert_surface_thread(&surface(
        "surface-desktop",
        SurfaceKind::Desktop,
        VisibilityPolicy::RichProof,
    ))
    .unwrap();
    db.upsert_mission_link(&MissionLink {
        link_id: "link-provider-thread".into(),
        mission_id: "mission-spine".into(),
        work_item_id: Some("work-codex".into()),
        link_kind: MissionLinkKind::ProviderSession,
        target_ref: "provider-thread-id-that-must-not-project".into(),
        proof_ref: Some("proof-provider-link".into()),
        created_at_ms: 14,
    })
    .unwrap();

    let projections = db
        .list_mission_surface_projections("fconv_20260604_global")
        .unwrap();
    assert_eq!(projections.len(), 2);
    assert!(projections
        .iter()
        .all(|p| p.mission_id == "mission-spine" && p.status == MissionStatus::Active));
    assert!(projections
        .iter()
        .any(|p| p.surface_kind == SurfaceKind::Mobile
            && p.visibility_policy == VisibilityPolicy::Compact));
    assert!(projections
        .iter()
        .any(|p| p.surface_kind == SurfaceKind::Desktop
            && p.visibility_policy == VisibilityPolicy::RichProof));

    let rendered = format!("{projections:?}");
    assert!(!rendered.contains("provider-thread-id-that-must-not-project"));
    assert!(!rendered.contains("codex-app-server-local"));

    let mut updated = mission(
        "mission-spine",
        MissionStatus::WaitingForUser,
        "mission-spine-storage",
    );
    updated.updated_at_ms = 30;
    db.upsert_mission(&updated).unwrap();
    let updated_projection = db
        .list_mission_surface_projections("fconv_20260604_global")
        .unwrap();
    assert!(updated_projection
        .iter()
        .all(|p| p.status == MissionStatus::WaitingForUser));
}

#[test]
fn mission_lifecycle_transition_updates_status_and_active_mission_list() {
    let db = Db::open_hub(&temp_db_path("mission-spine-lifecycle")).unwrap();
    db.upsert_friday_conversation(&conversation()).unwrap();
    db.upsert_mission(&mission(
        "mission-spine",
        MissionStatus::Active,
        "mission-spine-storage",
    ))
    .unwrap();

    let (paused, previous, active_ids) = db
        .transition_mission_status(
            "fconv_20260604_global",
            "mission-spine",
            MissionStatus::Paused,
            "operator:jarvis",
            "pause before Friday design handoff review",
            Some("audit://mission-lifecycle/pause"),
            None,
            40,
        )
        .unwrap();
    assert_eq!(previous, MissionStatus::Active);
    assert_eq!(paused.status, MissionStatus::Paused);
    assert_eq!(paused.updated_at_ms, 40);
    assert!(paused
        .proof_refs
        .contains(&"audit://mission-lifecycle/pause".to_string()));
    assert!(paused
        .decision_path_summary
        .contains("lifecycle:mission-spine:active->paused"));
    assert!(active_ids.contains(&"mission-spine".to_string()));

    let (active, previous, active_ids) = db
        .transition_mission_status(
            "fconv_20260604_global",
            "mission-spine",
            MissionStatus::Active,
            "operator:jarvis",
            "resume after operator review",
            None,
            None,
            50,
        )
        .unwrap();
    assert_eq!(previous, MissionStatus::Paused);
    assert_eq!(active.status, MissionStatus::Active);
    assert!(active_ids.contains(&"mission-spine".to_string()));

    let (archived, previous, active_ids) = db
        .transition_mission_status(
            "fconv_20260604_global",
            "mission-spine",
            MissionStatus::Archived,
            "operator:jarvis",
            "archive after replacement Mission exists",
            Some("proof://mission-lifecycle/archive"),
            None,
            60,
        )
        .unwrap();
    assert_eq!(previous, MissionStatus::Active);
    assert_eq!(archived.status, MissionStatus::Archived);
    assert!(!active_ids.contains(&"mission-spine".to_string()));
    let conversation = db
        .get_friday_conversation("fconv_20260604_global")
        .unwrap()
        .unwrap();
    assert!(!conversation
        .active_mission_ids
        .contains(&"mission-spine".to_string()));
}

#[test]
fn mission_lifecycle_transition_is_recorded_in_hash_chained_audit() {
    // M2 (audit-coverage hardening): a Mission status hop must leave a tamper-evident,
    // hash-chained audit receipt — the WorkItem sibling already does, but a Mission transition
    // used to live ONLY in the mutable free-text decision_path_summary. Assert the chained row is
    // appended per transition AND the chain still verifies, WITHOUT losing the summary (no-degrade).
    let db = Db::open_hub(&temp_db_path("mission-spine-lifecycle-audit")).unwrap();
    db.upsert_friday_conversation(&conversation()).unwrap();
    db.upsert_mission(&mission(
        "mission-spine",
        MissionStatus::Active,
        "mission-spine-audit",
    ))
    .unwrap();

    db.transition_mission_status(
        "fconv_20260604_global",
        "mission-spine",
        MissionStatus::Paused,
        "operator:jarvis",
        "pause for review",
        Some("audit://mission-lifecycle/pause"),
        None,
        40,
    )
    .unwrap();
    db.transition_mission_status(
        "fconv_20260604_global",
        "mission-spine",
        MissionStatus::Active,
        "operator:jarvis",
        "resume",
        None,
        None,
        50,
    )
    .unwrap();

    // One chained row per transition, carrying the from->to:reason action.
    let rows: i64 = db
        .conn()
        .query_row(
            "SELECT COUNT(*) FROM audit_ledger WHERE audit_id LIKE 'mission_lifecycle:mission-spine:%'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(
        rows, 2,
        "each mission transition appends exactly one chained audit row"
    );

    let paused_action: String = db
        .conn()
        .query_row(
            "SELECT action FROM audit_ledger WHERE audit_id = 'mission_lifecycle:mission-spine:40'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(
        paused_action,
        "mission.lifecycle:active->paused:pause for review"
    );

    // The new rows participate in the hash chain — it verifies end-to-end.
    assert!(friday_storage::audit::verify_audit_chain(db.conn()).is_ok());

    // No-degrade: the free-text decision_path_summary entry is still written alongside the chain.
    let stored = db.get_mission("mission-spine").unwrap().unwrap();
    assert!(stored
        .decision_path_summary
        .contains("lifecycle:mission-spine:active->paused"));
}

#[test]
fn mission_lifecycle_blocks_fake_done_and_bad_merge_targets() {
    let db = Db::open_hub(&temp_db_path("mission-spine-lifecycle-blocks")).unwrap();
    let mut convo = conversation();
    convo.active_mission_ids = vec!["mission-spine".into(), "mission-main".into()];
    db.upsert_friday_conversation(&convo).unwrap();
    db.upsert_mission(&mission(
        "mission-spine",
        MissionStatus::Active,
        "mission-spine-storage",
    ))
    .unwrap();
    db.upsert_mission(&mission(
        "mission-main",
        MissionStatus::Active,
        "mission-spine-storage",
    ))
    .unwrap();

    let fake_done = db.transition_mission_status(
        "fconv_20260604_global",
        "mission-spine",
        MissionStatus::Done,
        "operator:jarvis",
        "done without proof would be fake-ready",
        None,
        None,
        70,
    );
    assert!(matches!(fake_done, Err(StorageError::Unsupported(_))));
    assert_eq!(
        db.get_mission("mission-spine").unwrap().unwrap().status,
        MissionStatus::Active
    );

    let self_merge = db.transition_mission_status(
        "fconv_20260604_global",
        "mission-spine",
        MissionStatus::Merged,
        "operator:jarvis",
        "self merge should fail",
        Some("audit://mission-lifecycle/self-merge"),
        Some("mission-spine"),
        80,
    );
    assert!(matches!(self_merge, Err(StorageError::Unsupported(_))));

    let (merged, previous, active_ids) = db
        .transition_mission_status(
            "fconv_20260604_global",
            "mission-spine",
            MissionStatus::Merged,
            "operator:jarvis",
            "merge duplicate Mission into canonical Mission",
            Some("audit://mission-lifecycle/merge"),
            Some("mission-main"),
            90,
        )
        .unwrap();
    assert_eq!(previous, MissionStatus::Active);
    assert_eq!(merged.status, MissionStatus::Merged);
    assert!(!active_ids.contains(&"mission-spine".to_string()));
    assert!(active_ids.contains(&"mission-main".to_string()));
    assert!(merged
        .handoff_inheritance
        .contains(&"merged_into_mission_id:mission-main".to_string()));
}

#[test]
fn surface_events_share_mobile_message_with_mission_without_raw_channel_or_provider_ids() {
    let db = Db::open_hub(&temp_db_path("mission-spine-surface-event")).unwrap();
    db.upsert_friday_conversation(&conversation()).unwrap();
    db.upsert_mission(&mission(
        "mission-spine",
        MissionStatus::Active,
        "mission-spine-storage",
    ))
    .unwrap();
    db.upsert_work_item(&work_item("work-codex", WorkItemStatus::HubAccepted))
        .unwrap();
    db.upsert_surface_thread(&surface(
        "surface-mobile",
        SurfaceKind::Mobile,
        VisibilityPolicy::Compact,
    ))
    .unwrap();
    db.upsert_surface_thread(&surface(
        "surface-desktop",
        SurfaceKind::Desktop,
        VisibilityPolicy::RichProof,
    ))
    .unwrap();
    db.upsert_mission_link(&MissionLink {
        link_id: "link-raw-provider-event".into(),
        mission_id: "mission-spine".into(),
        work_item_id: Some("work-codex".into()),
        link_kind: MissionLinkKind::ChannelInbound,
        target_ref: "telegram:raw-chat-123:message-99".into(),
        proof_ref: Some("audit://channel-redacted".into()),
        created_at_ms: 20,
    })
    .unwrap();

    db.upsert_surface_event(&surface_event("surf-event-mobile-1"))
        .unwrap();
    let events = db.list_surface_events_for_mission("mission-spine").unwrap();
    assert_eq!(events.len(), 1);
    let event = &events[0];
    assert_eq!(event.friday_conversation_id, "fconv_20260604_global");
    assert_eq!(event.mission_id, "mission-spine");
    assert_eq!(event.work_item_id.as_deref(), Some("work-codex"));
    assert_eq!(event.surface_thread_id, "surface-mobile");
    assert_eq!(event.source_surface, SurfaceKind::Mobile);
    assert_eq!(event.event_kind, SurfaceEventKind::UserMessage);
    assert_eq!(
        event.body_ref.as_deref(),
        Some("friday://body/mobile-message/1")
    );

    let projections = db
        .list_mission_surface_projections("fconv_20260604_global")
        .unwrap();
    assert!(projections.iter().any(|projection| {
        projection.mission_id == "mission-spine"
            && projection.surface_kind == SurfaceKind::Desktop
            && projection.visibility_policy == VisibilityPolicy::RichProof
    }));

    let debug = format!("{events:?}{projections:?}");
    for forbidden in [
        "telegram:raw-chat-123",
        "message-99",
        "provider-thread",
        "external-thread",
        "raw transcript",
        "raw user prompt",
        "sk-",
    ] {
        assert!(
            !debug.contains(forbidden),
            "surface event projection leaked {forbidden}: {debug}"
        );
    }
}

#[test]
fn surface_event_rejects_raw_body_refs_and_mismatched_surface_mission() {
    let db = Db::open_hub(&temp_db_path("mission-spine-surface-event-rejects")).unwrap();
    db.upsert_friday_conversation(&conversation()).unwrap();
    db.upsert_mission(&mission(
        "mission-spine",
        MissionStatus::Active,
        "mission-spine-storage",
    ))
    .unwrap();
    db.upsert_work_item(&work_item("work-codex", WorkItemStatus::HubAccepted))
        .unwrap();
    db.upsert_surface_thread(&surface(
        "surface-mobile",
        SurfaceKind::Mobile,
        VisibilityPolicy::Compact,
    ))
    .unwrap();

    let mut raw = surface_event("surf-event-raw-body");
    raw.body_ref = Some("telegram:raw-chat-123".into());
    assert!(db.upsert_surface_event(&raw).is_err());
    assert_eq!(db.count("surface_event").unwrap(), 0);

    db.upsert_mission(&mission(
        "mission-other",
        MissionStatus::Active,
        "other-mission-storage",
    ))
    .unwrap();
    let mut other_surface = surface(
        "surface-other",
        SurfaceKind::Desktop,
        VisibilityPolicy::RichProof,
    );
    other_surface.mission_id = Some("mission-other".into());
    db.upsert_surface_thread(&other_surface).unwrap();

    let mut mismatched = surface_event("surf-event-mismatched-surface");
    mismatched.surface_thread_id = "surface-other".into();
    mismatched.source_surface = SurfaceKind::Desktop;
    mismatched.body_ref = Some("friday://body/desktop-message/1".into());
    assert!(db.upsert_surface_event(&mismatched).is_err());
    assert_eq!(db.count("surface_event").unwrap(), 0);
}

#[test]
fn duplicate_active_mission_and_work_item_are_detected_before_dispatch() {
    let db = Db::open_hub(&temp_db_path("mission-spine-duplicates")).unwrap();
    db.upsert_friday_conversation(&conversation()).unwrap();
    db.upsert_mission(&mission(
        "mission-spine",
        MissionStatus::Active,
        "shared-intent",
    ))
    .unwrap();
    db.upsert_mission(&mission(
        "mission-done",
        MissionStatus::Done,
        "shared-intent",
    ))
    .unwrap();

    let candidate_mission = mission("mission-new", MissionStatus::Active, "shared-intent");
    assert_eq!(
        db.find_duplicate_mission(&candidate_mission)
            .unwrap()
            .map(|m| m.mission_id),
        Some("mission-spine".into())
    );

    db.upsert_work_item(&work_item("work-codex", WorkItemStatus::ProviderWaiting))
        .unwrap();
    db.upsert_work_item(&work_item("work-done", WorkItemStatus::CompletedWithProof))
        .unwrap();
    let candidate_work = work_item("work-new", WorkItemStatus::Draft);
    assert_eq!(
        db.find_duplicate_work_item(&candidate_work)
            .unwrap()
            .map(|w| w.work_item_id),
        Some("work-codex".into())
    );
}

#[test]
fn route_decision_persists_as_trace_without_memory_authority_or_raw_surface_ids() {
    let db = Db::open_hub(&temp_db_path("mission-spine-route-decision")).unwrap();
    db.upsert_friday_conversation(&conversation()).unwrap();
    db.upsert_mission(&mission(
        "mission-spine",
        MissionStatus::Active,
        "mission-spine-storage",
    ))
    .unwrap();
    let mut channel_work = work_item("work-channel", WorkItemStatus::ReadyToDispatch);
    channel_work.lane = WorkLane::Channel;
    channel_work.target_provider_or_agent = Some("tg:room-1".into());
    db.upsert_work_item(&channel_work).unwrap();

    let card = RouteDecisionCard::from_work_item(
        "route-decision:channel:tg:room-1:m-1".into(),
        &channel_work,
        vec![
            "channel:tg:room-1:m-1".into(),
            "friday://activity/chan:tg:room-1:m-1".into(),
        ],
        42,
        None,
    )
    .with_action_items(vec![RouteDecisionCard::action_item_from_work_item(
        &channel_work,
    )]);
    db.upsert_route_decision(&card).unwrap();

    let stored = db
        .get_route_decision("route-decision:channel:tg:room-1:m-1")
        .unwrap()
        .unwrap();
    assert_eq!(stored.selected_lane, WorkLane::Channel);
    assert_eq!(
        stored.selected_provider_or_agent.as_deref(),
        Some("tg:room-1")
    );
    assert!(stored
        .trace_refs
        .iter()
        .any(|trace| trace.contains("tg:room-1")));
    assert_eq!(stored.action_items, card.action_items);

    let links = db.list_mission_links("mission-spine").unwrap();
    let route_link = links
        .iter()
        .find(|link| link.link_kind == MissionLinkKind::RouteDecision)
        .unwrap();
    assert_eq!(
        route_link.target_ref,
        "friday://route-decision/route-decision:channel:tg:room-1:m-1"
    );
    assert!(!route_link.link_kind.grants_memory_authority());

    let projections = db
        .list_route_decision_projections_for_mission("mission-spine")
        .unwrap();
    assert_eq!(projections.len(), 1);
    let projection = &projections[0];
    assert_eq!(
        projection.selected_target_label.as_deref(),
        Some("bound_channel")
    );
    assert_eq!(projection.trace_ref_count, 2);
    assert_eq!(projection.why_this_route, judgment().why_this_route);
    assert_eq!(projection.action_items.len(), 1);
    assert_eq!(
        projection.action_items[0]
            .assigned_provider_or_agent
            .as_deref(),
        Some("bound_channel")
    );
    assert_eq!(
        projection.action_items[0].target_ref,
        "file://redacted/schema.rs"
    );
    let rendered_projection = format!("{projection:?}");
    assert!(!rendered_projection.contains("tg:room-1"));
    assert!(!rendered_projection.contains("chan:tg"));
    assert!(!rendered_projection.contains("friday-storage/src"));
}

#[test]
fn route_decision_rejects_work_item_mission_mismatch() {
    let db = Db::open_hub(&temp_db_path("mission-spine-route-decision-mismatch")).unwrap();
    db.upsert_friday_conversation(&conversation()).unwrap();
    db.upsert_mission(&mission(
        "mission-spine",
        MissionStatus::Active,
        "mission-spine-storage",
    ))
    .unwrap();
    let item = work_item("work-codex", WorkItemStatus::ReadyToDispatch);
    db.upsert_work_item(&item).unwrap();

    let mut mismatched = RouteDecisionCard::from_work_item(
        "route-decision:mismatch".into(),
        &item,
        vec!["friday://trace/mismatch".into()],
        43,
        None,
    );
    mismatched.mission_id = "mission-other".into();
    assert!(db.upsert_route_decision(&mismatched).is_err());
    assert_eq!(
        db.list_route_decisions_for_mission("mission-spine")
            .unwrap()
            .len(),
        0
    );
}

#[test]
fn storage_rejects_non_canonical_ids_missing_judgment_and_fake_completion() {
    let db = Db::open_hub(&temp_db_path("mission-spine-rejects")).unwrap();
    let mut bad_conversation = conversation();
    bad_conversation.friday_conversation_id = "provider-thread-id".into();
    assert!(db.upsert_friday_conversation(&bad_conversation).is_err());

    db.upsert_friday_conversation(&conversation()).unwrap();
    db.upsert_mission(&mission(
        "mission-spine",
        MissionStatus::Active,
        "mission-spine-storage",
    ))
    .unwrap();

    let mut no_owner = work_item("work-no-owner", WorkItemStatus::ReadyToDispatch);
    no_owner.owner_claim_ids.clear();
    assert!(db.upsert_work_item(&no_owner).is_err());

    let mut fake_done = work_item("work-fake-done", WorkItemStatus::CompletedWithProof);
    fake_done.proof_receipts.clear();
    assert!(db.upsert_work_item(&fake_done).is_err());

    let mut missing_judgment = work_item("work-missing-judgment", WorkItemStatus::Draft);
    missing_judgment.judgment_memory.previous_pitfalls.clear();
    assert!(db.upsert_work_item(&missing_judgment).is_err());
}
