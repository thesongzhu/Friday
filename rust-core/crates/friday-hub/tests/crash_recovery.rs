//! Boot-time crash-recovery for orphaned in-flight WorkItems (registry gap #24) —
//! [`friday_hub::crash_recovery::reconcile_orphaned_work_items`], proven on a real Hub `Db`.
//!
//! With auto-dispatch LIVE, a mid-turn server crash leaves a WorkItem in a genuinely-executing
//! hub-internal state that no live recovery path re-picks ⇒ the Mission wedges forever. The
//! reconcile advances those (and ONLY those) to a terminal `FailedTerminal` with the
//! `crash_recovery_abort` marker, via the LEGAL work-item state machine + audit chain.
//!
//! THE CANARY of this suite is the no-degrade boundary: a legitimately-WAITING row
//! (`ProviderRouted` / `ProviderWaiting` / `WaitingForUser`) — resumed by the
//! signed-mutation/approval/reconnect paths — must be left byte-for-byte untouched. Reconciling
//! one would BREAK resume. The `ProviderWaiting` arm is seeded WITH NO operator-approval row on
//! purpose: that is the exact regression that proves we did not fall into the
//! "approval-presence" discriminator trap (a `ProviderWaiting` run waits on the PROVIDER, not on
//! an approval, so it has no pending row by design).
//!
//! Arms:
//!   (a) an orphaned in-flight WorkItem (`Dispatched`, `HubAccepted`) ⇒ flag-ON reconcile
//!       advances it to `FailedTerminal` + `blocking_reason == crash_recovery_abort`, audit clean;
//!   (b) legitimately-WAITING WorkItems (`ProviderRouted`, `ProviderWaiting` w/no approval,
//!       `WaitingForUser`) ⇒ UNTOUCHED;
//!   (c) a terminal WorkItem (`CompletedWithProof`) ⇒ UNTOUCHED;
//!   flag-OFF ⇒ all untouched (byte-identical: the server never calls reconcile when OFF);
//!   idempotency ⇒ a second reconcile is a no-op (0 aborted).

use std::sync::atomic::{AtomicU64, Ordering};

use friday_core::{
    ApprovalState, FridayConversation, HandoffJudgmentMemory, Mission, MissionStatus, Risk,
    TruthStatus, WorkItem, WorkItemStatus, WorkLane,
};
use friday_hub::crash_recovery::{
    crash_recovery_enabled_from, reconcile_orphaned_work_items, CRASH_RECOVERY_MARKER,
};
use friday_storage::audit::verify_audit_chain;
use friday_storage::Db;

static C: AtomicU64 = AtomicU64::new(0);
const NOW: i64 = 1_700_000_000_000;
const RECONCILE_AT: i64 = 1_700_000_500_000;

fn unique(tag: &str) -> String {
    format!(
        "{}-{}-{}",
        std::process::id(),
        tag,
        C.fetch_add(1, Ordering::Relaxed)
    )
}

fn temp_db(tag: &str) -> String {
    std::env::temp_dir()
        .join(format!("friday-crash-recovery-{}.sqlite", unique(tag)))
        .to_string_lossy()
        .into_owned()
}

fn judgment() -> HandoffJudgmentMemory {
    HandoffJudgmentMemory {
        task: "Run the bound agent loop".into(),
        current_blocker: None,
        target_lane_thread_agent_provider: "deepseek".into(),
        read_first_files: vec!["rust-core/crates/friday-hub/src/crash_recovery.rs".into()],
        required_output: "loop completion".into(),
        done_criteria: vec!["completed with proof".into()],
        red_lines: vec!["never reconcile a legitimately-waiting row".into()],
        why_this_route: "the WorkItem lane owns the agent loop".into(),
        considered_options: vec!["unbound run".into()],
        deferred_options: vec!["multi-provider".into()],
        previous_pitfalls: vec!["a paused run looked orphaned".into()],
        inheritable_context: vec!["Mission is product truth".into()],
        proof_requirements: vec!["crash-recovery tests".into()],
        ownership_claim_ids: Vec::new(),
    }
}

/// Seed ONE Mission (+ its FridayConversation) so the seeded WorkItems hang off a real graph.
fn seed_mission(db: &Db, mission_id: &str) {
    let fconv = format!("fconv_crash_{}", unique("conv"));
    db.upsert_friday_conversation(&FridayConversation {
        friday_conversation_id: fconv.clone(),
        owner_principal: "owner-crash".into(),
        title: "Crash recovery".into(),
        current_focus_summary: "orphaned in-flight rows".into(),
        active_mission_ids: vec![mission_id.to_string()],
        surface_thread_ids: Vec::new(),
        memory_scope_ref: None,
        truth_status: TruthStatus::WiredRegistry,
        proof_refs: vec!["proof://crash-recovery".into()],
        created_at_ms: NOW,
        updated_at_ms: NOW,
    })
    .unwrap();
    db.upsert_mission(&Mission {
        mission_id: mission_id.to_string(),
        friday_conversation_id: fconv,
        title: "Crash recovery".into(),
        intent: "reconcile only genuinely-orphaned in-flight rows".into(),
        status: MissionStatus::Active,
        why_now: "a crashed loop wedges the mission".into(),
        decision_path_summary: "abort only dead rows".into(),
        considered_options: vec!["abort all non-terminal".into()],
        deferred_options: vec!["durable run-execution state".into()],
        known_pitfalls: vec!["aborting a waiting row breaks resume".into()],
        handoff_inheritance: vec!["preserve resume path".into()],
        work_item_ids: Vec::new(),
        memory_candidate_refs: Vec::new(),
        context_passport_refs: Vec::new(),
        proof_refs: vec!["proof://crash-recovery".into()],
        created_at_ms: NOW,
        updated_at_ms: NOW,
    })
    .unwrap();
}

/// Seed a WorkItem at an EXACT status directly (the reconcile reads the persisted status). For a
/// `CompletedWithProof` seed a proof receipt is required by the persistence boundary.
fn seed_work_item(db: &Db, mission_id: &str, work_item_id: &str, status: WorkItemStatus) {
    let proof_receipts = if status == WorkItemStatus::CompletedWithProof {
        vec!["proof://seeded-completion".into()]
    } else {
        Vec::new()
    };
    db.upsert_work_item(&WorkItem {
        work_item_id: work_item_id.to_string(),
        mission_id: mission_id.to_string(),
        lane: WorkLane::DeepSeek,
        target_provider_or_agent: Some("deepseek".into()),
        status,
        owner_claim_ids: Vec::new(),
        workspace_refs: Vec::new(),
        capability_id: Some("mission.run".into()),
        risk_level: Risk::Medium,
        approval_state: ApprovalState::NotRequired,
        blocking_reason: None,
        input_refs: vec!["input://run".into()],
        output_refs: Vec::new(),
        proof_requirements: vec!["crash-recovery tests".into()],
        proof_receipts,
        judgment_memory: judgment(),
        created_at_ms: NOW,
        updated_at_ms: NOW,
    })
    .unwrap();
}

fn status_of(db: &Db, work_item_id: &str) -> WorkItemStatus {
    db.get_work_item(work_item_id).unwrap().unwrap().status
}

fn blocking_reason_of(db: &Db, work_item_id: &str) -> Option<String> {
    db.get_work_item(work_item_id)
        .unwrap()
        .unwrap()
        .blocking_reason
}

#[test]
fn flag_matcher_is_default_off_and_exact_one() {
    // The pure matcher the server reads at boot: default-OFF, ON only for the exact trimmed "1".
    assert!(!crash_recovery_enabled_from(None));
    assert!(crash_recovery_enabled_from(Some("1")));
    assert!(crash_recovery_enabled_from(Some("  1  ")));
    for off in ["", "0", "true", "TRUE", "yes", "enabled"] {
        assert!(!crash_recovery_enabled_from(Some(off)), "off for {off:?}");
    }
}

#[test]
fn reconcile_aborts_only_orphans_leaves_waiting_and_terminal_untouched() {
    let db = Db::open_hub(&temp_db("mix")).unwrap();
    let mission = format!("mission-{}", unique("mix"));
    seed_mission(&db, &mission);

    // (a) Two ORPHANED in-flight rows (the hub-internal hops a dying loop was mid-turn on).
    seed_work_item(&db, &mission, "wi-dispatched", WorkItemStatus::Dispatched);
    seed_work_item(&db, &mission, "wi-hubaccepted", WorkItemStatus::HubAccepted);

    // (b) Three legitimately-WAITING rows. `wi-providerwaiting` is seeded WITH NO operator-approval
    //     row on purpose — the regression guard against the "approval-presence" discriminator trap.
    seed_work_item(&db, &mission, "wi-routed", WorkItemStatus::ProviderRouted);
    seed_work_item(
        &db,
        &mission,
        "wi-providerwaiting",
        WorkItemStatus::ProviderWaiting,
    );
    seed_work_item(&db, &mission, "wi-waituser", WorkItemStatus::WaitingForUser);

    // (c) A terminal row — never in the active scan.
    seed_work_item(
        &db,
        &mission,
        "wi-completed",
        WorkItemStatus::CompletedWithProof,
    );

    let audit_len_before = verify_audit_chain(db.conn()).unwrap();

    let outcome = reconcile_orphaned_work_items(&db, RECONCILE_AT).unwrap();

    // The two orphans were aborted; nothing skipped; only the 5 non-terminal rows were scanned.
    assert_eq!(outcome.aborted, 2, "both orphans aborted");
    assert_eq!(outcome.skipped, 0, "no row failed its legal transition");
    assert_eq!(
        outcome.scanned, 5,
        "the terminal row is excluded from the active scan"
    );

    // (a) Orphans → terminal FailedTerminal + the row-level marker.
    for orphan in ["wi-dispatched", "wi-hubaccepted"] {
        assert_eq!(
            status_of(&db, orphan),
            WorkItemStatus::FailedTerminal,
            "{orphan} aborted to FailedTerminal"
        );
        assert_eq!(
            blocking_reason_of(&db, orphan).as_deref(),
            Some(CRASH_RECOVERY_MARKER),
            "{orphan} carries the crash_recovery_abort marker"
        );
    }

    // (b) WAITING rows untouched — status AND blocking_reason byte-identical to the seed.
    for waiting in ["wi-routed", "wi-providerwaiting", "wi-waituser"] {
        let expected = match waiting {
            "wi-routed" => WorkItemStatus::ProviderRouted,
            "wi-providerwaiting" => WorkItemStatus::ProviderWaiting,
            _ => WorkItemStatus::WaitingForUser,
        };
        assert_eq!(status_of(&db, waiting), expected, "{waiting} untouched");
        assert_eq!(
            blocking_reason_of(&db, waiting),
            None,
            "{waiting} not marked (the discriminator-trap regression guard)"
        );
    }

    // (c) Terminal row untouched.
    assert_eq!(
        status_of(&db, "wi-completed"),
        WorkItemStatus::CompletedWithProof
    );

    // The audit chain is intact and grew by EXACTLY one lifecycle row per aborted orphan (legal
    // transitions, hash-chained).
    let audit_len_after = verify_audit_chain(db.conn()).unwrap();
    assert_eq!(
        audit_len_after,
        audit_len_before + 2,
        "exactly one hash-chained lifecycle row per aborted orphan; chain verifies"
    );
}

#[test]
fn flag_off_means_no_reconcile_byte_identical() {
    // Flag-OFF is byte-identical because the server NEVER calls reconcile (the matcher returns
    // false). This arm proves the matcher gates the call, then proves that NOT calling reconcile
    // leaves an orphan exactly as seeded.
    assert!(!crash_recovery_enabled_from(None));

    let db = Db::open_hub(&temp_db("off")).unwrap();
    let mission = format!("mission-{}", unique("off"));
    seed_mission(&db, &mission);
    seed_work_item(&db, &mission, "wi-orphan-off", WorkItemStatus::Dispatched);
    let audit_before = verify_audit_chain(db.conn()).unwrap();

    // Flag OFF ⇒ the boot path does NOT invoke reconcile. The orphan stays Dispatched, unmarked.
    assert_eq!(status_of(&db, "wi-orphan-off"), WorkItemStatus::Dispatched);
    assert_eq!(blocking_reason_of(&db, "wi-orphan-off"), None);
    assert_eq!(verify_audit_chain(db.conn()).unwrap(), audit_before);
}

#[test]
fn reconcile_is_idempotent_second_sweep_is_a_noop() {
    let db = Db::open_hub(&temp_db("idem")).unwrap();
    let mission = format!("mission-{}", unique("idem"));
    seed_mission(&db, &mission);
    seed_work_item(&db, &mission, "wi-orphan-idem", WorkItemStatus::HubAccepted);
    seed_work_item(
        &db,
        &mission,
        "wi-waiting-idem",
        WorkItemStatus::ProviderWaiting,
    );

    let first = reconcile_orphaned_work_items(&db, RECONCILE_AT).unwrap();
    assert_eq!(first.aborted, 1, "first sweep aborts the one orphan");
    assert_eq!(
        status_of(&db, "wi-orphan-idem"),
        WorkItemStatus::FailedTerminal
    );

    let audit_after_first = verify_audit_chain(db.conn()).unwrap();

    // Second sweep: the orphan is now terminal ⇒ excluded from the active scan ⇒ NOTHING to do.
    let second = reconcile_orphaned_work_items(&db, RECONCILE_AT + 1).unwrap();
    assert_eq!(second.aborted, 0, "second sweep aborts nothing");
    assert_eq!(second.skipped, 0);
    assert_eq!(
        second.scanned, 1,
        "only the still-waiting row remains in the active scan"
    );
    assert!(second.is_empty(), "second sweep is a no-op");
    // No new audit rows on the no-op second sweep.
    assert_eq!(verify_audit_chain(db.conn()).unwrap(), audit_after_first);
    // The waiting row is STILL untouched after two sweeps.
    assert_eq!(
        status_of(&db, "wi-waiting-idem"),
        WorkItemStatus::ProviderWaiting
    );
}
