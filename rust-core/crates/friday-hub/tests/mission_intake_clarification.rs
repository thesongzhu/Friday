//! FRIDAY_MISSION_INTAKE_CLARIFY — the Mission-intake clarification arm, proven at the
//! producer boundary (`hub_server::mission_intake_result_for_db_flagged`).
//!
//! Closes registry path #5: today a VAGUE/under-specified mission intent silently becomes an
//! Active Mission (Mission + WorkItem(Draft) + SurfaceThread + route_decision) with no clarifying
//! questions. With the flag ON, an under-specified, CLASSIFIED intent is asked-first instead:
//! the producer returns a `needs_clarification` result carrying the specific questions and writes
//! ZERO rows. With the flag OFF the producer is BYTE-IDENTICAL to today.
//!
//! ## Why the injected bool (NOT `std::env::set_var`)
//! This binary mixes flag-ON arms (a)(b) AND a flag-OFF arm (c). Rust runs `#[test]`s on parallel
//! threads sharing ONE process env, so a `set_var("1")` in one arm would race an unset/`set_var`
//! in another. The producer splits the env read (in the public `mission_intake_result_for_db`)
//! from the pure body (`mission_intake_result_for_db_flagged`), so each arm injects its
//! `clarify_enabled` bool DIRECTLY — no env, no race. The env-string semantics
//! ("1"/" 1 "/""/None/"true") are covered race-free by the in-crate
//! `mission_intake_clarify_from_*` pure-matcher unit test.

use friday_hub::hub_server::mission_intake_result_for_db_flagged;
use friday_protocol::{Message, MissionIntakeRequestWire};
use friday_storage::audit::verify_audit_chain;
use friday_storage::Db;

/// The auto-dispatch trigger predicate, an EXACT mirror of
/// `friday_ffi::mission_intake_allows_new_work` (`friday-ffi/src/lib.rs`:
/// `status.trim() == "ready" && created_or_ready`) — which the TS auto-dispatch driver
/// also mirrors (`status === "ready" && createdOrReady === true`). Mirrored inline here
/// rather than importing `friday-ffi` (a heavy uniffi crate friday-hub does not depend on)
/// so this binary stays light; the AUTHORITATIVE interaction-guard test lives in the TS
/// driver test (the real consumer). A clarification result MUST make this false.
fn auto_dispatch_allows_new_work(status: &str, created_or_ready: bool) -> bool {
    status.trim() == "ready" && created_or_ready
}

fn temp_db(tag: &str) -> String {
    std::env::temp_dir()
        .join(format!(
            "friday-mintake-clar-{}-{}-{}.sqlite",
            std::process::id(),
            tag,
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ))
        .to_string_lossy()
        .into_owned()
}

const FCONV: &str = "fconv_mintake_clar";
const OWNER: &str = "owner-mintake-clar";
const SURFACE_THREAD: &str = "surface-mintake-clar";
const MISSION: &str = "mission-mintake-clar";
const WORK_ITEM: &str = "work-mintake-clar";

/// A valid Mission-intake request with the given `intent` — every required field present so the
/// validation block passes and ONLY the clarification arm decides the outcome.
fn intake_request(intent: &str) -> MissionIntakeRequestWire {
    MissionIntakeRequestWire {
        friday_conversation_id: FCONV.into(),
        owner_principal: OWNER.into(),
        surface_thread_id: SURFACE_THREAD.into(),
        surface_kind: "mobile".into(),
        delivery_route: "mobile://local/thread/clar".into(),
        visibility_policy: "compact".into(),
        mission_id: MISSION.into(),
        work_item_id: WORK_ITEM.into(),
        title: "Mission intake clarification".into(),
        intent: intent.into(),
        lane: "deepseek".into(),
        target_provider_or_agent: Some("deepseek".into()),
        capability_id: Some("ask_friday.deepseek".into()),
        body_ref: Some("friday://body/mobile/clar".into()),
        includes_sensitive_context: false,
    }
}

/// Extract the `MissionIntakeResultWire` from a reply envelope, or panic with the actual message.
fn intake_result(env: friday_protocol::Envelope) -> friday_protocol::MissionIntakeResultWire {
    match env.message {
        Message::MissionIntakeResult { result } => result,
        other => panic!("expected a MissionIntakeResult, got {other:?}"),
    }
}

// A VAGUE deliverable intent: classifies (VAGUE_DELIVERABLE -> MajorDecision) but is short with no
// CONSTRAINT hint ⇒ NOT detailed ⇒ the clarification arm fires. Used by arms (a) AND (c) so (c) is
// the byte-identical-off proof for the SAME vague intent.
const VAGUE_INTENT: &str = "build me a tool";

// A DETAILED, CLASSIFIED intent: classifies GenerateWorkflow, clears the 110-char threshold AND
// carries DETAIL hints ("trigger"/"output"/"destination") ⇒ is_task_detailed_enough == TRUE ⇒ the
// detail-check's true-branch is EXERCISED and the producer falls through to birth the Mission. This
// is the load-bearing NO-DEGRADE arm: flag ON must NOT over-clarify a well-specified planning task.
// (Verbatim the proven `detailed_workflow_task_is_detailed_enough` fixture from planning.rs.)
const DETAILED_INTENT: &str = "create a workflow that triggers every morning at 9am, reads my \
                               calendar, and posts a daily summary to the team Slack channel as \
                               its output destination";

// A non-planning intent that classifies None ⇒ the clarification arm is a no-op even ON (the
// detail-check is never reached) ⇒ the Mission is born exactly as today.
const UNCLASSIFIED_INTENT: &str = "resolve the organic surface intake into a Mission";

#[test]
fn arm_a_flag_on_vague_intent_clarifies_and_writes_zero_rows() {
    let db = Db::open_hub(&temp_db("arm-a")).unwrap();
    // Flag ON (injected bool) + a vague, classified intent ⇒ needs_clarification.
    let env = mission_intake_result_for_db_flagged(
        &db,
        "req-arm-a",
        intake_request(VAGUE_INTENT),
        1000,
        true,
    );
    let result = intake_result(env);

    // (1) status is the distinct needs_clarification value — NOT "ready" — carrying ≥1 question.
    assert_eq!(
        result.status, "needs_clarification",
        "an under-specified intent is asked-first, not silently birthed"
    );
    assert!(
        !result.clarification_questions.is_empty(),
        "the clarification carries the specific questions: {:?}",
        result.clarification_questions
    );
    assert!(!result.created_or_ready, "no Mission was created/readied");
    assert!(
        result.work_item_id.is_none(),
        "no WorkItem id (no row written)"
    );
    // The wire still echoes mission_id / surface_thread_id (the client's PROPOSED ids — no row was
    // written for either) so the TS result parser's required-ref check passes and the clarification
    // is delivered, not buried under a fail-closed 503.
    assert_eq!(result.mission_id, MISSION);
    assert_eq!(result.surface_thread_id, SURFACE_THREAD);

    // (2) ZERO rows: the Mission and WorkItem the request proposed do NOT exist.
    assert!(
        db.get_mission(MISSION).unwrap().is_none(),
        "no Mission row was written for an under-specified intent"
    );
    assert!(
        db.get_work_item(WORK_ITEM).unwrap().is_none(),
        "no WorkItem row was written for an under-specified intent"
    );

    // (3) INTERACTION GUARD: the auto-dispatch predicate MUST be false for a clarification result —
    // we must NEVER auto-dispatch an under-specified mission. This is the exact predicate the TS
    // driver mirrors (`status === "ready" && createdOrReady === true`).
    assert!(
        !auto_dispatch_allows_new_work(&result.status, result.created_or_ready),
        "a needs_clarification result must NOT trigger auto-dispatch"
    );

    // (4) the audit chain is clean (no partial write left the ledger inconsistent).
    verify_audit_chain(db.conn()).expect("audit chain clean after a clarification (no rows)");
}

#[test]
fn arm_b_flag_on_detailed_classified_intent_births_a_mission_as_today() {
    let db = Db::open_hub(&temp_db("arm-b")).unwrap();
    // Flag ON + a DETAILED, CLASSIFIED intent ⇒ the detail-check's true-branch fires
    // (is_task_detailed_enough == true) ⇒ the producer falls through and births the Mission exactly
    // as today. This is the no-degrade guarantee: a well-specified planning task is NOT over-clarified.
    let env = mission_intake_result_for_db_flagged(
        &db,
        "req-arm-b",
        intake_request(DETAILED_INTENT),
        2000,
        true,
    );
    let result = intake_result(env);

    assert_eq!(
        result.status, "ready",
        "a sufficiently-specified intent births a ready Mission"
    );
    assert!(result.created_or_ready, "the WorkItem was created");
    assert_eq!(result.work_item_id.as_deref(), Some(WORK_ITEM));
    assert!(
        result.clarification_questions.is_empty(),
        "the ready path carries NO clarification questions"
    );
    // The rows exist (Mission born Active, WorkItem in Draft).
    let mission = db
        .get_mission(MISSION)
        .unwrap()
        .expect("Mission row written");
    assert_eq!(mission.status, friday_core::MissionStatus::Active);
    assert!(
        db.get_work_item(WORK_ITEM).unwrap().is_some(),
        "WorkItem row written"
    );
    // This IS a ready intake ⇒ the auto-dispatch predicate is TRUE (the binding may fire).
    assert!(
        auto_dispatch_allows_new_work(&result.status, result.created_or_ready),
        "a ready intake qualifies for auto-dispatch"
    );
    verify_audit_chain(db.conn()).expect("audit chain clean after a ready Mission birth");
}

#[test]
fn arm_c_flag_off_vague_intent_births_a_mission_byte_identical() {
    let db = Db::open_hub(&temp_db("arm-c")).unwrap();
    // Flag OFF + the SAME vague intent as arm (a). Flag-OFF skips the whole clarification block ⇒
    // BYTE-IDENTICAL to today: the Mission is born ready, no clarification.
    let env = mission_intake_result_for_db_flagged(
        &db,
        "req-arm-c",
        intake_request(VAGUE_INTENT),
        3000,
        false,
    );
    let result = intake_result(env);

    assert_eq!(
        result.status, "ready",
        "flag-OFF: the vague intent births a ready Mission exactly as today (no clarification)"
    );
    assert!(
        result.created_or_ready,
        "flag-OFF: the WorkItem was created"
    );
    assert_eq!(result.work_item_id.as_deref(), Some(WORK_ITEM));
    assert!(
        result.clarification_questions.is_empty(),
        "flag-OFF: NO clarification questions (the field stays empty / serializes away)"
    );
    // The rows exist — flag-OFF behavior is unchanged from today.
    assert!(
        db.get_mission(MISSION).unwrap().is_some(),
        "flag-OFF: Mission row written"
    );
    assert!(
        db.get_work_item(WORK_ITEM).unwrap().is_some(),
        "flag-OFF: WorkItem row written"
    );
    verify_audit_chain(db.conn()).expect("audit chain clean (flag-OFF baseline)");
}

#[test]
fn arm_d_flag_on_unclassified_intent_births_a_mission() {
    let db = Db::open_hub(&temp_db("arm-d")).unwrap();
    // Flag ON + an intent that classifies None (no planning verb) ⇒ classify_kind returns None ⇒
    // the whole detail-check block is skipped ⇒ the Mission is born exactly as today. This covers
    // the `classify_kind == None` skip path (distinct from arm (b)'s classified-AND-detailed path),
    // so neither the "unclassified" nor the "detailed" fall-through can silently start clarifying.
    let env = mission_intake_result_for_db_flagged(
        &db,
        "req-arm-d",
        intake_request(UNCLASSIFIED_INTENT),
        4000,
        true,
    );
    let result = intake_result(env);

    assert_eq!(
        result.status, "ready",
        "an unclassified intent (classify_kind None) births a ready Mission, never clarifies"
    );
    assert!(result.created_or_ready, "the WorkItem was created");
    assert!(
        result.clarification_questions.is_empty(),
        "the None-classified path carries NO clarification questions"
    );
    assert!(
        db.get_mission(MISSION).unwrap().is_some(),
        "Mission row written for an unclassified intent"
    );
    verify_audit_chain(db.conn()).expect("audit chain clean after an unclassified Mission birth");
}
