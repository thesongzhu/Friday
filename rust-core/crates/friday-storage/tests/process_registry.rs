//! Process Registry persistence tests.
//!
//! These tests prove the Hub-owned process/workspace substrate behind Mission
//! Spine: phone surfaces do not get ownership tables, active claims/leases expose
//! conflicts before duplicate work starts, and unowned observations remain
//! inspect-only until a claim/lease exists.

mod common;

use common::temp_db_path;
use friday_core::Risk;
use friday_core::{
    ApprovalState, ClaimState, FridayConversation, HandoffJudgmentMemory, LeaseState, Mission,
    MissionStatus, OwnershipStatus, ProcessKind, ProcessLease, ProcessObservation, TruthStatus,
    WorkItem, WorkItemStatus, WorkLane, WorkspaceClaim, WorkspaceClaimKind,
};
use friday_storage::{hub_migrations, Db, Profile, StorageError, HUB_ONLY_TABLES};

fn hub_max_version() -> i64 {
    hub_migrations().iter().map(|m| m.version).max().unwrap()
}

fn conversation() -> FridayConversation {
    FridayConversation {
        friday_conversation_id: "fconv_process_registry".into(),
        owner_principal: "operator:jarvis".into(),
        title: "Friday process truth".into(),
        current_focus_summary: "Prevent duplicate live work".into(),
        active_mission_ids: vec!["mission-process".into()],
        surface_thread_ids: Vec::new(),
        memory_scope_ref: None,
        truth_status: TruthStatus::WiredRegistry,
        proof_refs: vec!["proof://process-registry-test".into()],
        created_at_ms: 1,
        updated_at_ms: 1,
    }
}

fn mission() -> Mission {
    Mission {
        mission_id: "mission-process".into(),
        friday_conversation_id: "fconv_process_registry".into(),
        title: "Own process registry".into(),
        intent: "make Friday aware of live workspace and process ownership".into(),
        status: MissionStatus::Active,
        why_now: "unowned agents and dev servers can create duplicate work".into(),
        decision_path_summary: "Hub-owned registry gates control; observations do not".into(),
        considered_options: vec!["shell-only ps scan".into()],
        deferred_options: vec!["live supervisor daemon".into()],
        known_pitfalls: vec!["do not kill unowned processes".into()],
        handoff_inheritance: vec!["carry safe-stop proof requirement".into()],
        work_item_ids: vec!["work-process".into()],
        memory_candidate_refs: Vec::new(),
        context_passport_refs: Vec::new(),
        proof_refs: vec!["proof://process-registry-test".into()],
        created_at_ms: 2,
        updated_at_ms: 2,
    }
}

fn judgment() -> HandoffJudgmentMemory {
    HandoffJudgmentMemory {
        task: "Persist process registry".into(),
        current_blocker: None,
        target_lane_thread_agent_provider: "friday-storage".into(),
        read_first_files: vec!["rust-core/crates/friday-storage/src/schema.rs".into()],
        required_output: "Hub-only process registry storage".into(),
        done_criteria: vec!["active conflicts detected".into()],
        red_lines: vec!["do not control unowned processes".into()],
        why_this_route: "storage boundary must enforce ownership before UI polish".into(),
        considered_options: vec!["documentation-only registry".into()],
        deferred_options: vec!["runtime process supervisor".into()],
        previous_pitfalls: vec!["ack is not completion".into()],
        inheritable_context: vec!["MissionLink already has workspace_claim kind".into()],
        proof_requirements: vec!["cargo test -p friday-storage --test process_registry".into()],
        ownership_claim_ids: vec!["claim-workspace".into()],
    }
}

fn work_item() -> WorkItem {
    WorkItem {
        work_item_id: "work-process".into(),
        mission_id: "mission-process".into(),
        lane: WorkLane::Codex,
        target_provider_or_agent: Some("codex".into()),
        status: WorkItemStatus::Draft,
        owner_claim_ids: vec!["claim-workspace".into()],
        workspace_refs: vec!["/tmp/friday-live".into()],
        capability_id: Some("process.registry".into()),
        risk_level: Risk::Medium,
        approval_state: ApprovalState::NotRequired,
        blocking_reason: None,
        input_refs: vec!["input://process-scan".into()],
        output_refs: Vec::new(),
        proof_requirements: vec!["release and stop proof".into()],
        proof_receipts: Vec::new(),
        judgment_memory: judgment(),
        created_at_ms: 3,
        updated_at_ms: 3,
    }
}

fn seed_mission(db: &Db) {
    db.upsert_friday_conversation(&conversation()).unwrap();
    db.upsert_mission(&mission()).unwrap();
    db.upsert_work_item(&work_item()).unwrap();
}

fn claim(state: ClaimState) -> WorkspaceClaim {
    WorkspaceClaim {
        claim_id: "claim-workspace".into(),
        mission_id: "mission-process".into(),
        work_item_id: Some("work-process".into()),
        owner_principal: "operator:jarvis".into(),
        owner_agent: "codex".into(),
        workspace_ref: "/tmp/friday-live".into(),
        claim_kind: WorkspaceClaimKind::Workspace,
        state,
        reason: "exclusive workspace editing during process registry slice".into(),
        safe_release_policy: "release only after test proof and clean handoff".into(),
        proof_requirements: vec!["release proof".into()],
        proof_refs: if state == ClaimState::Released {
            vec!["proof://workspace-released".into()]
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

fn lease(state: LeaseState) -> ProcessLease {
    ProcessLease {
        lease_id: "lease-dev-server".into(),
        claim_id: "claim-workspace".into(),
        mission_id: "mission-process".into(),
        work_item_id: Some("work-process".into()),
        pid: Some(12_345),
        process_group_id: Some(12_345),
        process_kind: ProcessKind::DevServer,
        command_ref: Some("friday://command/dev-server".into()),
        command_hash: Some("sha256:dev-server-command".into()),
        cwd_ref: "/tmp/friday-live".into(),
        port_bindings: vec!["127.0.0.1:3142".into()],
        started_by_surface_thread_id: None,
        started_by_provider_session_id: None,
        health_check_ref: Some("http://127.0.0.1:3142/health".into()),
        safe_stop_ref: Some("friday://safe-stop/dev-server".into()),
        last_observed_at_ms: Some(7),
        stale_after_ms: Some(60_000),
        state,
        proof_refs: if state == LeaseState::StoppedWithProof {
            vec!["proof://process-stopped".into()]
        } else {
            Vec::new()
        },
        created_at_ms: 7,
        updated_at_ms: 8,
    }
}

fn observation() -> ProcessObservation {
    ProcessObservation {
        observation_id: "obs-unowned-codex".into(),
        pid: 54_321,
        ppid: Some(1),
        process_kind: ProcessKind::CodexCli,
        cwd_ref: "/Users/jarvis".into(),
        port_bindings: Vec::new(),
        command_hash: Some("sha256:redacted-command".into()),
        observed_at_ms: 9,
        matched_claim_id: None,
        ownership_status: OwnershipStatus::UnownedAgentProcess,
    }
}

#[test]
fn process_registry_tables_are_hub_only_and_forward_migrated() {
    for table in ["workspace_claim", "process_lease", "process_observation"] {
        assert!(HUB_ONLY_TABLES.contains(&table));
    }

    let p = temp_db_path("process-registry-mig");
    {
        let mut migs = hub_migrations();
        migs.truncate(9);
        let db = Db::open(&p, Profile::Hub, &migs, "v9").unwrap();
        assert_eq!(db.version().unwrap(), 9);
        assert!(!db
            .table_names()
            .unwrap()
            .iter()
            .any(|t| t == "workspace_claim"));
    }

    let db = Db::open_hub(&p).unwrap();
    assert_eq!(db.version().unwrap(), hub_max_version());
    let tables = db.table_names().unwrap();
    for table in ["workspace_claim", "process_lease", "process_observation"] {
        assert!(tables.iter().any(|t| t == table));
    }

    let phone = Db::open_phone(&temp_db_path("process-registry-phone")).unwrap();
    let phone_tables = phone.table_names().unwrap();
    assert!(!phone_tables.iter().any(|t| t == "workspace_claim"));
    assert!(matches!(
        phone.upsert_workspace_claim(&claim(ClaimState::Active)),
        Err(StorageError::Unsupported(_))
    ));
    assert!(matches!(
        phone.upsert_process_observation(&observation()),
        Err(StorageError::Unsupported(_))
    ));
}

#[test]
fn workspace_claim_and_process_lease_round_trip_and_conflicts() {
    let db = Db::open_hub(&temp_db_path("process-registry-conflict")).unwrap();
    seed_mission(&db);

    let active_claim = claim(ClaimState::Active);
    db.upsert_workspace_claim(&active_claim).unwrap();
    assert_eq!(
        db.get_workspace_claim("claim-workspace").unwrap(),
        Some(active_claim.clone())
    );
    assert_eq!(db.list_active_workspace_claims().unwrap().len(), 1);
    assert_eq!(
        db.find_active_workspace_conflict("/tmp/friday-live")
            .unwrap()
            .map(|c| c.claim_id),
        Some("claim-workspace".into())
    );

    let running_lease = lease(LeaseState::Running);
    db.upsert_process_lease(&running_lease).unwrap();
    assert_eq!(
        db.get_process_lease("lease-dev-server").unwrap(),
        Some(running_lease)
    );
    assert_eq!(
        db.find_active_port_conflict("127.0.0.1:3142")
            .unwrap()
            .map(|l| l.lease_id),
        Some("lease-dev-server".into())
    );

    db.upsert_process_lease(&lease(LeaseState::StoppedWithProof))
        .unwrap();
    assert!(db
        .find_active_port_conflict("127.0.0.1:3142")
        .unwrap()
        .is_none());

    db.upsert_workspace_claim(&claim(ClaimState::Released))
        .unwrap();
    assert!(db
        .find_active_workspace_conflict("/tmp/friday-live")
        .unwrap()
        .is_none());
}

#[test]
fn observations_are_inspect_only_and_stopped_requires_proof() {
    let db = Db::open_hub(&temp_db_path("process-registry-observation")).unwrap();
    seed_mission(&db);
    db.upsert_workspace_claim(&claim(ClaimState::Active))
        .unwrap();

    let observed = observation();
    db.upsert_process_observation(&observed).unwrap();
    let rows = db.list_process_observations().unwrap();
    assert_eq!(rows, vec![observed.clone()]);
    assert!(!rows[0].is_control_allowed_without_adoption());
    assert_eq!(
        db.get_process_observation("obs-unowned-codex").unwrap(),
        Some(observed)
    );

    let mut fake_stop = lease(LeaseState::StoppedWithProof);
    fake_stop.proof_refs.clear();
    assert!(db.upsert_process_lease(&fake_stop).is_err());
}
