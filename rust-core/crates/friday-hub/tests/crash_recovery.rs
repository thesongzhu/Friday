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
//!       `WaitingForUser`) WITH `executing == 0` ⇒ UNTOUCHED;
//!   (c) a terminal WorkItem (`CompletedWithProof`) ⇒ UNTOUCHED;
//!   flag-OFF ⇒ all untouched (byte-identical: the server never calls reconcile when OFF);
//!   idempotency ⇒ a second reconcile is a no-op (0 aborted).
//!
//! #24b PASS-2 arms (durable execution-state crash recovery — the COMMON mid-call crash):
//!   * `pass2_aborts_stale_executing_provider_waiting`: `ProviderWaiting` + `executing=1` + a STALE
//!     heartbeat ⇒ reconciled to `FailedTerminal` + the `crash_recovery_abort` marker (the crash a
//!     process died mid-model-call leaves behind).
//!   * `pass2_leaves_fresh_executing_provider_waiting_untouched`: `ProviderWaiting` + `executing=1`
//!     with a FRESH heartbeat ⇒ UNTOUCHED — the slow-but-LIVE model-call guard (the cardinal sin to
//!     break: aborting a live run).
//!   * `pass2_leaves_legit_paused_provider_routed_untouched`: `ProviderRouted` + `executing=0`
//!     (legit-paused, awaiting approval) + a STALE timestamp ⇒ UNTOUCHED (executing==0 is never
//!     reconciled, regardless of age).
//!   * `pass2_disabled_when_flag_off`: even a stale-executing crash row stays untouched when the
//!     flag is OFF (the server never calls reconcile).
//!   * `loop_clears_executing_at_every_exit` (in lib.rs): a run through the real loop ends with
//!     `executing == 0` for Finished / Paused / Blocked — proving the wrapper's tail clear.
//!   * `loop_sets_executing_during_the_call_and_re_entry_re_sets_it` (in lib.rs): executing==1 is
//!     observed mid-model-call, and a SECOND loop entry on the SAME work_item re-SETs it (the
//!     re-entry re-set). NOTE: the signed-approval resume (`resume_with_approval`) does NOT re-enter
//!     this loop — it runs ONE `executor.execute` — so the re-set is a property of any loop
//!     RE-ENTRY (a continued/redriven run), not of the approval-resume path specifically.
//!   * `forward_path_during_call_status_is_provider_routed_and_pass2_reconciles_a_mid_call_crash`
//!     (in lib.rs): the REACHABILITY proof — the real pre-dispatch binding makes the during-call
//!     status `ProviderRouted`, and PASS-2 reconciles a simulated mid-call crash there.

use std::sync::atomic::{AtomicU64, Ordering};

use friday_core::{
    ApprovalState, FridayConversation, HandoffJudgmentMemory, Mission, MissionStatus, Risk,
    TruthStatus, WorkItem, WorkItemStatus, WorkLane,
};
use friday_hub::crash_recovery::{
    crash_recovery_enabled_from, reconcile_orphaned_work_items, CRASH_RECOVERY_MARKER,
    EXECUTION_STATE_STALE_THRESHOLD_MS,
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

/// (#24b) SET a seeded WorkItem's durable execution marker + heartbeat directly (the SAME
/// status-preserving helper the agent loop uses), so a PASS-2 arm can reproduce a crashed-mid-call
/// row (`executing=1` + a stale/fresh heartbeat) or a legit-paused row (`executing=0`).
fn set_executing(db: &Db, work_item_id: &str, executing: bool, heartbeat_ms: i64) {
    db.set_work_item_executing(work_item_id, executing, heartbeat_ms)
        .unwrap();
}

/// (#24b) Read back a WorkItem's durable execution state for an assertion.
fn execution_state_of(db: &Db, work_item_id: &str) -> (bool, Option<i64>) {
    let s = db
        .get_work_item_execution_state(work_item_id)
        .unwrap()
        .unwrap();
    (s.executing, s.last_heartbeat_ms)
}

// A heartbeat older than the threshold = a crashed process; a recent one = a slow-but-live call.
// RECONCILE_AT - STALE_HEARTBEAT == 600s > 300s threshold (stale); RECONCILE_AT - FRESH == 1s (fresh).
const STALE_HEARTBEAT: i64 = RECONCILE_AT - 600_000;
const FRESH_HEARTBEAT: i64 = RECONCILE_AT - 1_000;

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

// ───────────────────────────── #24b PASS-2 (durable execution state) ─────────────────────────────

#[test]
fn pass2_aborts_stale_executing_provider_waiting() {
    // The COMMON mid-call crash: a `ProviderWaiting` run whose process DIED mid-model-call, so its
    // durable `executing` marker is still 1 and the heartbeat is STALE. PASS-2 reconciles it.
    let db = Db::open_hub(&temp_db("p2-stale")).unwrap();
    let mission = format!("mission-{}", unique("p2-stale"));
    seed_mission(&db, &mission);

    // A ProviderWaiting row + a ProviderRouted row, BOTH executing=1 with a stale heartbeat (a
    // crash mid-call). No operator-approval row exists — exactly the case #767 could not handle.
    seed_work_item(
        &db,
        &mission,
        "wi-waiting-crashed",
        WorkItemStatus::ProviderWaiting,
    );
    set_executing(&db, "wi-waiting-crashed", true, STALE_HEARTBEAT);
    seed_work_item(
        &db,
        &mission,
        "wi-routed-crashed",
        WorkItemStatus::ProviderRouted,
    );
    set_executing(&db, "wi-routed-crashed", true, STALE_HEARTBEAT);

    let audit_before = verify_audit_chain(db.conn()).unwrap();
    let outcome = reconcile_orphaned_work_items(&db, RECONCILE_AT).unwrap();

    assert_eq!(
        outcome.aborted, 2,
        "both stale-executing provider rows aborted"
    );
    assert_eq!(outcome.skipped, 0);
    for wi in ["wi-waiting-crashed", "wi-routed-crashed"] {
        assert_eq!(
            status_of(&db, wi),
            WorkItemStatus::FailedTerminal,
            "{wi} stale-executing crash row reconciled"
        );
        assert_eq!(
            blocking_reason_of(&db, wi).as_deref(),
            Some(CRASH_RECOVERY_MARKER),
            "{wi} carries the crash_recovery_abort marker"
        );
    }
    // Exactly one hash-chained lifecycle row per abort; the chain still verifies.
    assert_eq!(
        verify_audit_chain(db.conn()).unwrap(),
        audit_before + 2,
        "one legal lifecycle audit row per PASS-2 abort"
    );
}

#[test]
fn pass2_leaves_fresh_executing_provider_waiting_untouched() {
    // THE slow-but-LIVE guard (the cardinal sin to break): a `ProviderWaiting` run that is
    // executing=1 with a FRESH heartbeat is a live model call still in flight — NEVER reconcile it.
    let db = Db::open_hub(&temp_db("p2-fresh")).unwrap();
    let mission = format!("mission-{}", unique("p2-fresh"));
    seed_mission(&db, &mission);

    seed_work_item(&db, &mission, "wi-live", WorkItemStatus::ProviderWaiting);
    set_executing(&db, "wi-live", true, FRESH_HEARTBEAT);

    let audit_before = verify_audit_chain(db.conn()).unwrap();
    let outcome = reconcile_orphaned_work_items(&db, RECONCILE_AT).unwrap();

    assert_eq!(outcome.aborted, 0, "a slow-but-live row is NEVER aborted");
    assert_eq!(outcome.skipped, 0);
    assert_eq!(
        status_of(&db, "wi-live"),
        WorkItemStatus::ProviderWaiting,
        "the live run is untouched"
    );
    assert_eq!(blocking_reason_of(&db, "wi-live"), None, "not marked");
    // The execution marker is left exactly as seeded (PASS-2 never wrote it).
    assert_eq!(
        execution_state_of(&db, "wi-live"),
        (true, Some(FRESH_HEARTBEAT))
    );
    assert_eq!(verify_audit_chain(db.conn()).unwrap(), audit_before);
}

#[test]
fn pass2_leaves_legit_paused_provider_routed_untouched() {
    // A legitimately-PAUSED run (awaiting operator approval) sits at `ProviderRouted` with
    // executing=0 — the resume path (resume_agent_loop_for_mission) will pick it up. Even with a
    // STALE timestamp it must be UNTOUCHED: executing==0 is never a crash candidate. This is the
    // discriminator that makes PASS-2 safe — without it, aborting this row would BREAK resume.
    let db = Db::open_hub(&temp_db("p2-paused")).unwrap();
    let mission = format!("mission-{}", unique("p2-paused"));
    seed_mission(&db, &mission);

    seed_work_item(&db, &mission, "wi-paused", WorkItemStatus::ProviderRouted);
    // executing=0 with an OLD timestamp (e.g. it was executing long ago, then cleared on Pause).
    set_executing(&db, "wi-paused", false, STALE_HEARTBEAT);
    // Also a never-touched ProviderWaiting row (the migration default: executing=0, heartbeat NULL).
    seed_work_item(&db, &mission, "wi-default", WorkItemStatus::ProviderWaiting);

    let outcome = reconcile_orphaned_work_items(&db, RECONCILE_AT).unwrap();

    assert_eq!(outcome.aborted, 0, "executing==0 rows are never reconciled");
    assert_eq!(
        status_of(&db, "wi-paused"),
        WorkItemStatus::ProviderRouted,
        "the legit-paused run is untouched (resume must still pick it up)"
    );
    assert_eq!(blocking_reason_of(&db, "wi-paused"), None);
    // The never-touched default row reads back executing=0, heartbeat NULL (the fail-closed at-rest
    // value) and is untouched.
    assert_eq!(execution_state_of(&db, "wi-default"), (false, None));
    assert_eq!(
        status_of(&db, "wi-default"),
        WorkItemStatus::ProviderWaiting
    );
}

#[test]
fn pass2_disabled_when_flag_off() {
    // Flag-OFF is byte-identical: the server never calls reconcile. A stale-executing crash row
    // stays exactly as seeded (this arm proves the matcher gates the PASS-2 path too).
    assert!(!crash_recovery_enabled_from(None));

    let db = Db::open_hub(&temp_db("p2-off")).unwrap();
    let mission = format!("mission-{}", unique("p2-off"));
    seed_mission(&db, &mission);
    seed_work_item(
        &db,
        &mission,
        "wi-crashed-off",
        WorkItemStatus::ProviderWaiting,
    );
    set_executing(&db, "wi-crashed-off", true, STALE_HEARTBEAT);
    let audit_before = verify_audit_chain(db.conn()).unwrap();

    // Flag OFF ⇒ no reconcile is invoked. The crash row stays ProviderWaiting + executing=1.
    assert_eq!(
        status_of(&db, "wi-crashed-off"),
        WorkItemStatus::ProviderWaiting
    );
    assert_eq!(blocking_reason_of(&db, "wi-crashed-off"), None);
    assert_eq!(
        execution_state_of(&db, "wi-crashed-off"),
        (true, Some(STALE_HEARTBEAT))
    );
    assert_eq!(verify_audit_chain(db.conn()).unwrap(), audit_before);
}

#[test]
fn pass2_exactly_at_threshold_is_stale_and_reconciled() {
    // Boundary: a heartbeat EXACTLY `EXECUTION_STATE_STALE_THRESHOLD_MS` old is treated as stale
    // (the `>=` boundary), so the reconcile fires. Documents the inclusive boundary so a future
    // edit that flips it to `>` fails here.
    let db = Db::open_hub(&temp_db("p2-edge")).unwrap();
    let mission = format!("mission-{}", unique("p2-edge"));
    seed_mission(&db, &mission);
    seed_work_item(&db, &mission, "wi-edge", WorkItemStatus::ProviderWaiting);
    set_executing(
        &db,
        "wi-edge",
        true,
        RECONCILE_AT - EXECUTION_STATE_STALE_THRESHOLD_MS,
    );

    let outcome = reconcile_orphaned_work_items(&db, RECONCILE_AT).unwrap();
    assert_eq!(
        outcome.aborted, 1,
        "a heartbeat exactly at the threshold is stale"
    );
    assert_eq!(status_of(&db, "wi-edge"), WorkItemStatus::FailedTerminal);

    // And ONE millisecond fresher (threshold - 1) is NOT stale ⇒ untouched.
    let db2 = Db::open_hub(&temp_db("p2-edge2")).unwrap();
    let mission2 = format!("mission-{}", unique("p2-edge2"));
    seed_mission(&db2, &mission2);
    seed_work_item(&db2, &mission2, "wi-edge2", WorkItemStatus::ProviderWaiting);
    set_executing(
        &db2,
        "wi-edge2",
        true,
        RECONCILE_AT - EXECUTION_STATE_STALE_THRESHOLD_MS + 1,
    );
    let outcome2 = reconcile_orphaned_work_items(&db2, RECONCILE_AT).unwrap();
    assert_eq!(
        outcome2.aborted, 0,
        "one ms under the threshold is still live"
    );
    assert_eq!(status_of(&db2, "wi-edge2"), WorkItemStatus::ProviderWaiting);
}

// ── #784(b): boot reconcile of orphaned SCHEDULED workflow runs ───────────────────────────────
// A scheduled run executes synchronously inside one tick, so a `Pending`/`Running` `sched:` run at
// boot is a daemon that DIED mid-tick. Left non-terminal it permanently WEDGES its schedule (the
// tick's serialization guard refuses to fire while a prior fire is non-terminal). The boot sweep
// (run BEFORE the tick thread is spawned, so this daemon owns no live tick) advances such a run to
// `Failed` UNCONDITIONALLY on age — so a FAST-restart orphan (`updated_at` seconds old, the common
// crash-loop case) is unwedged too — without ever touching a legit pause (`AwaitingCheckpoint`) or a
// non-scheduler run.

use friday_core::WorkflowRunState;
use friday_hub::crash_recovery::reconcile_orphaned_scheduled_runs;

/// Seed a workflow run at `run_id` in `state`, with `updated_at` stamped at `updated_at_ms`. Used to
/// stand up a crash orphan (the daemon died mid-tick, leaving the run non-terminal).
fn seed_run_at(db: &Db, run_id: &str, state: WorkflowRunState, updated_at_ms: i64) {
    friday_storage::workflow::create_run(db.conn(), run_id, "wf-sched", updated_at_ms).unwrap();
    // Walk to the requested non-terminal state via legal edges, keeping `updated_at` at the stamp.
    match state {
        WorkflowRunState::Pending => {}
        WorkflowRunState::Running => {
            friday_storage::workflow::set_run_state(
                db.conn(),
                run_id,
                WorkflowRunState::Running,
                updated_at_ms,
            )
            .unwrap();
        }
        WorkflowRunState::AwaitingCheckpoint => {
            friday_storage::workflow::set_run_state(
                db.conn(),
                run_id,
                WorkflowRunState::Running,
                updated_at_ms,
            )
            .unwrap();
            friday_storage::workflow::set_run_state(
                db.conn(),
                run_id,
                WorkflowRunState::AwaitingCheckpoint,
                updated_at_ms,
            )
            .unwrap();
        }
        other => panic!("seed_run_at only seeds non-terminal states, got {other:?}"),
    }
}

/// Seed a crash orphan whose `updated_at` is OLD (a daemon down for a while). `RECONCILE_AT` is the
/// boot time; the orphan is stamped well before it.
fn seed_stale_run(db: &Db, run_id: &str, state: WorkflowRunState) {
    seed_run_at(
        db,
        run_id,
        state,
        RECONCILE_AT - EXECUTION_STATE_STALE_THRESHOLD_MS - 10_000,
    );
}

fn run_state_of(db: &Db, run_id: &str) -> WorkflowRunState {
    friday_storage::workflow::run_state(db.conn(), run_id)
        .unwrap()
        .unwrap()
}

#[test]
fn scheduled_reconcile_aborts_stale_pending_and_running_sched_runs_to_failed() {
    let db = Db::open_hub(&temp_db("sched-orphan")).unwrap();
    seed_stale_run(&db, "sched:s1:600000", WorkflowRunState::Pending);
    seed_stale_run(&db, "sched:s2:600000", WorkflowRunState::Running);

    let outcome = reconcile_orphaned_scheduled_runs(&db, RECONCILE_AT).unwrap();
    assert_eq!(outcome.scanned, 2);
    assert_eq!(outcome.aborted, 2, "both stale orphans are reconciled");
    assert_eq!(outcome.skipped, 0);
    // Both are now terminal `Failed` ⇒ the schedule's serialization guard unblocks.
    assert_eq!(
        run_state_of(&db, "sched:s1:600000"),
        WorkflowRunState::Failed
    );
    assert_eq!(
        run_state_of(&db, "sched:s2:600000"),
        WorkflowRunState::Failed
    );
}

#[test]
fn scheduled_reconcile_leaves_awaiting_checkpoint_untouched() {
    // A deny-all-paused mutating step rests at `AwaitingCheckpoint` — a LEGITIMATE pause, NOT a
    // crash artifact. Reconciling it would kill a live paused run (a degrade). It must survive.
    let db = Db::open_hub(&temp_db("sched-pause")).unwrap();
    seed_stale_run(&db, "sched:s1:600000", WorkflowRunState::AwaitingCheckpoint);

    let outcome = reconcile_orphaned_scheduled_runs(&db, RECONCILE_AT).unwrap();
    assert_eq!(
        outcome.scanned, 0,
        "awaiting_checkpoint is not a scan candidate"
    );
    assert_eq!(outcome.aborted, 0);
    assert_eq!(
        run_state_of(&db, "sched:s1:600000"),
        WorkflowRunState::AwaitingCheckpoint,
        "a legit pause is left byte-for-byte untouched"
    );
}

#[test]
fn scheduled_reconcile_leaves_non_scheduler_runs_untouched() {
    // A manually-dispatched workflow run (no `sched:` prefix) has no scheduler-tick owner and must
    // never be touched by the scheduled-run sweep.
    let db = Db::open_hub(&temp_db("sched-manual")).unwrap();
    seed_stale_run(&db, "manual-run-1", WorkflowRunState::Running);

    let outcome = reconcile_orphaned_scheduled_runs(&db, RECONCILE_AT).unwrap();
    assert_eq!(
        outcome.scanned, 0,
        "a non-sched run is not a scan candidate"
    );
    assert_eq!(outcome.aborted, 0);
    assert_eq!(run_state_of(&db, "manual-run-1"), WorkflowRunState::Running);
}

#[test]
fn scheduled_reconcile_reconciles_a_fresh_orphan_from_a_fast_restart() {
    // THE regression guard for the staleness-cutoff bug: the COMMON crash is a FAST launchd restart
    // (the SQLITE_BUSY / init_failed crash-loop restarts in seconds), so the orphan's `updated_at` is
    // only ~60s old at boot. Because boot recovery runs BEFORE the tick spawns, this daemon owns no
    // live tick — the fresh `Running` run is a DEAD orphan, NOT a live run to spare. It MUST be
    // reconciled, or the schedule re-wedges exactly when this fix should unwedge it. (An age-threshold
    // skip here would be the bug.)
    let db = Db::open_hub(&temp_db("sched-fast-restart")).unwrap();
    // Orphaned ~60s before this boot — far inside any plausible staleness window.
    seed_run_at(
        &db,
        "sched:s1:600000",
        WorkflowRunState::Running,
        RECONCILE_AT - 60_000,
    );

    let outcome = reconcile_orphaned_scheduled_runs(&db, RECONCILE_AT).unwrap();
    assert_eq!(outcome.scanned, 1);
    assert_eq!(
        outcome.aborted, 1,
        "a fast-restart orphan IS reconciled (no age gate at boot)"
    );
    assert_eq!(
        run_state_of(&db, "sched:s1:600000"),
        WorkflowRunState::Failed,
        "the freshly-orphaned run is unwedged ⇒ the next tick can fire"
    );
}

#[test]
fn scheduled_reconcile_is_idempotent_second_sweep_is_a_noop() {
    let db = Db::open_hub(&temp_db("sched-idem")).unwrap();
    seed_stale_run(&db, "sched:s1:600000", WorkflowRunState::Pending);

    let first = reconcile_orphaned_scheduled_runs(&db, RECONCILE_AT).unwrap();
    assert_eq!(first.aborted, 1);
    assert_eq!(
        run_state_of(&db, "sched:s1:600000"),
        WorkflowRunState::Failed
    );

    // The run is now terminal `Failed` ⇒ excluded from the in-flight scan ⇒ a second sweep is a no-op.
    let second = reconcile_orphaned_scheduled_runs(&db, RECONCILE_AT).unwrap();
    assert_eq!(second.scanned, 0);
    assert_eq!(second.aborted, 0);
    assert!(second.is_empty());
}
