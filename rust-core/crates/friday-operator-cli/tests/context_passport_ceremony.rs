//! Operator-only Context Passport ceremony proof.
//!
//! The point is not that a row can be inserted. The proof is that the operator CLI
//! call-site builds a real gated ContextPassport, binds it to the Mission refs/link
//! set, and the existing Hub preflight gate then accepts the same sensitive external
//! transfer that was blocked before the ceremony.

use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use friday_core::{
    ApprovalState, FridayConversation, HandoffJudgmentMemory, Mission, MissionStatus, PassportItem,
    PassportItemKind, Risk, SurfaceKind, SurfaceThread, TruthStatus, VisibilityPolicy, WorkItem,
    WorkItemStatus, WorkLane,
};
use friday_hub::mission_preflight::{
    preflight_and_stage_work_item, MissionPreflightOutcome, MissionPreflightRequest,
};
use friday_operator_cli::context_passport::{self, PassportSpec};
use friday_storage::Db;

static COUNTER: AtomicU64 = AtomicU64::new(0);

fn temp_db_path(tag: &str) -> String {
    let n = COUNTER.fetch_add(1, Ordering::SeqCst);
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let mut dir = std::env::temp_dir();
    dir.push(format!(
        "friday-context-passport-ceremony-{tag}-{}-{nanos}-{n}",
        std::process::id()
    ));
    std::fs::create_dir_all(&dir).unwrap();
    dir.push("hub.sqlite");
    dir.to_string_lossy().to_string()
}

fn conversation(now: i64) -> FridayConversation {
    FridayConversation {
        friday_conversation_id: "fconv_passport_ceremony".into(),
        owner_principal: "owner-1".into(),
        title: "Passport ceremony".into(),
        current_focus_summary: "Prove operator-only passport ceremony.".into(),
        active_mission_ids: vec!["mission-passport".into()],
        surface_thread_ids: vec!["surface-passport".into()],
        memory_scope_ref: None,
        truth_status: TruthStatus::Proven,
        proof_refs: vec![],
        created_at_ms: now,
        updated_at_ms: now,
    }
}

fn mission(context_passport_refs: Vec<String>, now: i64) -> Mission {
    Mission {
        mission_id: "mission-passport".into(),
        friday_conversation_id: "fconv_passport_ceremony".into(),
        title: "Passport ceremony".into(),
        intent: "Send sensitive approved context to Codex.".into(),
        status: MissionStatus::Active,
        why_now: "T3 provisioning must be operator-governed.".into(),
        decision_path_summary: "Use operator CLI ceremony, not app mint.".into(),
        considered_options: vec!["app endpoint".into(), "operator CLI".into()],
        deferred_options: vec![],
        known_pitfalls: vec!["a raw row is not a passport".into()],
        handoff_inheritance: vec![],
        work_item_ids: vec![],
        memory_candidate_refs: vec![],
        context_passport_refs,
        proof_refs: vec![],
        created_at_ms: now,
        updated_at_ms: now,
    }
}

fn surface(now: i64) -> SurfaceThread {
    SurfaceThread {
        surface_thread_id: "surface-passport".into(),
        friday_conversation_id: "fconv_passport_ceremony".into(),
        mission_id: Some("mission-passport".into()),
        surface_kind: SurfaceKind::Desktop,
        channel_binding_id: None,
        delivery_route: "test://desktop".into(),
        visibility_policy: VisibilityPolicy::Compact,
        allowed_actions: vec!["open".into()],
        last_seen_at_ms: Some(now),
        last_delivered_event_seq: None,
        created_at_ms: now,
        updated_at_ms: now,
    }
}

fn judgment() -> HandoffJudgmentMemory {
    HandoffJudgmentMemory {
        task: "Prove context passport ceremony".into(),
        current_blocker: None,
        target_lane_thread_agent_provider: "codex".into(),
        read_first_files: vec![],
        required_output: "preflight Ready after operator ceremony".into(),
        done_criteria: vec!["passport authorizes transfer".into()],
        red_lines: vec!["no app mint endpoint".into()],
        why_this_route: "operator owns context transfer approval".into(),
        considered_options: vec!["operator CLI ceremony".into()],
        deferred_options: vec!["work-item scoped passport after work item exists".into()],
        previous_pitfalls: vec!["row-only passport proof is hollow".into()],
        inheritable_context: vec!["mission refs carry the passport id".into()],
        proof_requirements: vec!["preflight ready after passport".into()],
        ownership_claim_ids: vec![],
    }
}

fn work_item(now: i64) -> WorkItem {
    WorkItem {
        work_item_id: "work-passport".into(),
        mission_id: "mission-passport".into(),
        lane: WorkLane::Codex,
        target_provider_or_agent: Some("codex".into()),
        status: WorkItemStatus::Draft,
        owner_claim_ids: Vec::new(),
        workspace_refs: Vec::new(),
        capability_id: Some("context-passport-proof".into()),
        risk_level: Risk::Medium,
        approval_state: ApprovalState::NotRequired,
        blocking_reason: None,
        input_refs: vec!["input://approved-context".into()],
        output_refs: Vec::new(),
        proof_requirements: vec!["context passport authorizes transfer".into()],
        proof_receipts: Vec::new(),
        judgment_memory: judgment(),
        created_at_ms: now,
        updated_at_ms: now,
    }
}

fn request(mission: Mission, now: i64) -> MissionPreflightRequest {
    MissionPreflightRequest {
        conversation: conversation(now),
        mission,
        surface_thread: Some(surface(now)),
        work_item: work_item(now),
        body_snapshot: None,
        includes_sensitive_context: true,
    }
}

fn passport_spec(items: Vec<PassportItem>, approved_sensitive: bool) -> PassportSpec {
    PassportSpec {
        passport_id: "passport-operator-1".into(),
        mission_id: "mission-passport".into(),
        work_item_id: None,
        destination_lane: WorkLane::Codex,
        destination_target: Some("codex".into()),
        items,
        approved_sensitive,
    }
}

#[test]
fn operator_context_passport_ceremony_satisfies_existing_preflight_gate() {
    let db = Db::open_hub(&temp_db_path("ready")).unwrap();
    let now = 1_780_000_000_000i64;
    db.upsert_friday_conversation(&conversation(now)).unwrap();
    db.upsert_mission(&mission(Vec::new(), now)).unwrap();

    let blocked =
        preflight_and_stage_work_item(&db, request(mission(Vec::new(), now), now)).unwrap();
    match blocked {
        MissionPreflightOutcome::Blocked { blockers, .. } => assert!(blockers
            .contains(&"context_passport_required_before_sensitive_external_transfer".into())),
        other => panic!("expected context-passport blocker before ceremony, got {other:?}"),
    }

    let minted = context_passport::mint(
        &db,
        &passport_spec(
            vec![PassportItem {
                kind: PassportItemKind::Summary,
                label: "approved design summary".into(),
                included: true,
                sensitive: true,
            }],
            true,
        ),
        now + 1,
    )
    .unwrap();
    assert_eq!(minted.shared_item_count, 1);

    let stored_mission = db.get_mission("mission-passport").unwrap().unwrap();
    assert_eq!(
        stored_mission.context_passport_refs,
        vec!["passport-operator-1"]
    );
    assert!(db
        .list_mission_links("mission-passport")
        .unwrap()
        .iter()
        .any(|link| link.proof_ref.as_deref() == Some("passport-operator-1")));

    let ready = preflight_and_stage_work_item(&db, request(stored_mission, now + 2)).unwrap();
    assert!(
        ready.is_ready(),
        "operator-minted passport must satisfy the existing preflight gate, got {ready:?}"
    );
}

#[test]
fn operator_context_passport_ceremony_fails_closed_for_unapproved_sensitive_items() {
    let db = Db::open_hub(&temp_db_path("blocked")).unwrap();
    let now = 1_780_000_001_000i64;
    db.upsert_friday_conversation(&conversation(now)).unwrap();
    db.upsert_mission(&mission(Vec::new(), now)).unwrap();

    let err = context_passport::mint(
        &db,
        &passport_spec(
            vec![PassportItem {
                kind: PassportItemKind::Summary,
                label: "sensitive plan".into(),
                included: true,
                sensitive: true,
            }],
            false,
        ),
        now + 1,
    )
    .unwrap_err();
    assert!(
        err.to_string().contains("context_passport_blocked"),
        "unapproved sensitive context must fail closed"
    );
    assert!(db
        .get_context_passport("passport-operator-1")
        .unwrap()
        .is_none());
    assert!(db
        .get_mission("mission-passport")
        .unwrap()
        .unwrap()
        .context_passport_refs
        .is_empty());
}

#[test]
fn operator_context_passport_ceremony_checks_work_item_scope_before_writing() {
    let db = Db::open_hub(&temp_db_path("missing-work-item")).unwrap();
    let now = 1_780_000_002_000i64;
    db.upsert_friday_conversation(&conversation(now)).unwrap();
    db.upsert_mission(&mission(Vec::new(), now)).unwrap();

    let mut spec = passport_spec(
        vec![PassportItem {
            kind: PassportItemKind::Summary,
            label: "benign summary".into(),
            included: true,
            sensitive: false,
        }],
        false,
    );
    spec.work_item_id = Some("missing-work-item".into());

    let err = context_passport::mint(&db, &spec, now + 1).unwrap_err();
    assert!(
        err.to_string().contains("not found"),
        "missing work-item scope must fail before writing"
    );
    assert!(db
        .get_context_passport("passport-operator-1")
        .unwrap()
        .is_none());
    assert!(db
        .list_mission_links("mission-passport")
        .unwrap()
        .is_empty());
    assert!(db
        .get_mission("mission-passport")
        .unwrap()
        .unwrap()
        .context_passport_refs
        .is_empty());
}
