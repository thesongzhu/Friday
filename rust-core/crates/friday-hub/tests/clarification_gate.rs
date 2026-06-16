//! FRIDAY_CLARIFICATION_GATE — the clarification gate, proven end-to-end on the LIVE
//! AUTHED path (`HubRuntime::run_session_task`), persist + owner-projection included.
//!
//! This is the PERSIST + DELIVERY half of the methodology gate (the loop-level bool-injected
//! behavioral proofs live in-crate in `friday-hub/src/lib.rs` tests — `run_loop_with_policy_flagged`
//! is `pub(crate)`, so a `tests/` binary cannot call it; and our env-race-free idiom forbids
//! `std::env::set_var` inside a SHARED test binary). Here EVERY test wants the flag ON, so each
//! sets `FRIDAY_CLARIFICATION_GATE="1"` as its first line and there is NO flag-OFF test in this
//! binary (the byte-identical-when-off proof is `clarification_gate_off_*` in-crate).
//!
//! What this proves through the real `run_session_task` → `run_session_loop` →
//! `run_loop_with_policy` (reads the env flag) → `run_loop_with_policy_flagged` (the gate) →
//! step-5b persist arm → `project_answer_for_authed` chain:
//!   1. A VAGUE, classified planning task is delivered to the owner as
//!      `AuthedAnswer::Delivered{ status == "awaiting_clarification", answer == the 2 SPECIFIC
//!      workflow questions }` — AND a PanicTransport proves NO model call was made (bills nothing).
//!   2. A RESUME turn (same session, a plain answer that classifies None) runs the loop normally
//!      and Finishes — the gate does NOT re-fire.

use std::cell::Cell;
use std::rc::Rc;

use friday_crypto::{seal, DeviceKeypair};
use friday_deepseek::{DeepSeekClient, DeepSeekError, Transport};
use friday_hub::hub_server::{AuthedAnswer, AuthedPrincipal};
use friday_hub::runtime::{DenyAllApprovals, HubConfig, HubRuntime};
use friday_hub::DeepSeekAgentLlmClient;
use serde_json::Value;

const SECRET: &[u8] = b"clarification-gate-test-secret-0123"; // pragma: allowlist secret

struct TempDir(std::path::PathBuf);
impl TempDir {
    fn new(tag: &str) -> Self {
        let p = std::env::temp_dir().join(format!(
            "friday-clar-ws-{}-{}-{}",
            std::process::id(),
            tag,
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&p).unwrap();
        TempDir(p)
    }
}
impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn tmp_db(tag: &str) -> String {
    std::env::temp_dir()
        .join(format!(
            "friday-clar-{}-{}-{}.sqlite",
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

/// A transport that PANICS if the model is ever contacted — proves the clarification gate
/// stopped the run BEFORE any model call (bills nothing).
struct PanicTransport;
impl Transport for PanicTransport {
    fn get_json(&self, _u: &str, _b: &str) -> Result<Value, DeepSeekError> {
        panic!("clarification gate must make NO model call (discover)");
    }
    fn post_json(&self, _u: &str, _b: &str, _body: &Value) -> Result<Value, DeepSeekError> {
        panic!("clarification gate must make NO model call (chat)");
    }
}

/// A scripted DeepSeek transport: GET /models → one flash model; POST /chat → the next scripted
/// assistant `content` (a tool-call JSON the strict parser reads). Counts POST calls.
struct ScriptTransport {
    contents: Vec<String>,
    post_calls: Rc<Cell<usize>>,
}
impl ScriptTransport {
    fn new(contents: &[&str]) -> Self {
        Self {
            contents: contents.iter().map(|s| s.to_string()).collect(),
            post_calls: Rc::new(Cell::new(0)),
        }
    }
}
impl Transport for ScriptTransport {
    fn get_json(&self, _u: &str, _b: &str) -> Result<Value, DeepSeekError> {
        Ok(serde_json::json!({"data":[{"id":"deepseek-v4-flash"}]}))
    }
    fn post_json(&self, _u: &str, _b: &str, _body: &Value) -> Result<Value, DeepSeekError> {
        let n = self.post_calls.get();
        self.post_calls.set(n + 1);
        let content = self
            .contents
            .get(n)
            .cloned()
            .unwrap_or_else(|| "{\"tool\":\"none\",\"answer\":\"done\"}".to_string());
        Ok(serde_json::json!({
            "model":"deepseek-v4-flash",
            "choices":[{"message":{"content":content},"finish_reason":"stop"}],
            "usage":{"prompt_tokens":10,"completion_tokens":5,"total_tokens":15}
        }))
    }
}

fn runtime_with<T: Transport>(tag: &str, owner: &str, transport: T) -> (HubRuntime<T>, TempDir) {
    let ws = TempDir::new(tag);
    let client = DeepSeekClient::with_transport(transport, "k".into());
    let agent = DeepSeekAgentLlmClient::new(client);
    let rt = HubRuntime::new(
        HubConfig {
            db_path: tmp_db(tag),
            workspace_root: ws.0.clone(),
            secret: SECRET.to_vec(),
            max_turns: 6,
            principal_id: Some(owner.to_string()),
            disabled_tools: vec![],
            read_only: false,
            operator_vk: None,
        },
        agent,
        Box::new(DenyAllApprovals),
    )
    .unwrap();
    (rt, ws)
}

/// Build an AuthedPrincipal bound to `principal` (same construction the in-crate tests use).
fn authed_caller(principal: &str) -> AuthedPrincipal {
    const AAD: &[u8] = b"clarification-gate-test-aad";
    const CHALLENGE: &[u8] = b"clarification-gate-test-challenge";
    let hub = DeviceKeypair::generate();
    let phone = DeviceKeypair::generate();
    let hub_session = hub.agree(&phone.public_bytes());
    let caller_session = phone.agree(&hub.public_bytes());
    let sealed = seal(&caller_session, CHALLENGE, AAD).unwrap();
    AuthedPrincipal::authenticate(&hub_session, &sealed, AAD, CHALLENGE, principal).unwrap()
}

/// The two SPECIFIC workflow clarification questions (the oracle's verbatim wording).
const WORKFLOW_Q1: &str = "What should trigger this workflow, and what output should it produce?";
const WORKFLOW_Q2: &str = "Where should it run and what constraints or integrations matter?";

#[test]
fn vague_planning_task_delivers_specific_questions_with_no_model_call() {
    std::env::set_var(friday_hub::FRIDAY_CLARIFICATION_GATE, "1");
    // The vague workflow task classifies GenerateWorkflow, is < 110 chars with no DETAIL hint
    // ⇒ NOT detailed ⇒ the gate clarifies. The PanicTransport proves NO model call is made.
    let owner = "owner-clar-vague";
    let (rt, _ws) = runtime_with("clar-vague", owner, PanicTransport);
    let caller = authed_caller(owner);
    let answer = rt.run_session_task(
        &caller,
        "run-clar-vague",
        "sess-clar",
        "create a workflow that posts a daily summary",
        5_000,
    );
    match answer {
        AuthedAnswer::Delivered { status, answer, .. } => {
            assert_eq!(
                status, "awaiting_clarification",
                "the under-specified planning task is delivered as a clarification, not a guess"
            );
            // The 2 SPECIFIC workflow questions, numbered — NOT a generic confirm.
            assert!(
                answer.contains(WORKFLOW_Q1),
                "first specific workflow question present: {answer}"
            );
            assert!(
                answer.contains(WORKFLOW_Q2),
                "second specific workflow question present: {answer}"
            );
            assert!(
                answer.contains("Question 1/2") && answer.contains("Question 2/2"),
                "numbered clarifying questions, not a generic confirm: {answer}"
            );
        }
        other => panic!("expected a Delivered clarification, got {other:?}"),
    }
    // (If the model had been called, PanicTransport would have panicked — so reaching here is the
    // "no model call / bills nothing" proof.)
}

#[test]
fn resume_with_plain_answer_runs_the_loop_and_finishes_gate_does_not_refire() {
    std::env::set_var(friday_hub::FRIDAY_CLARIFICATION_GATE, "1");
    // SAME session as a prior (clarified) turn: a follow-up that is a PLAIN answer with no planning
    // verb classifies None ⇒ the gate does NOT fire ⇒ the loop runs normally and Finishes
    // (scripted mock client returns a finish object). Drive on a scripted transport so the loop
    // really runs (no panic). A fresh run_id, same session_id.
    let owner = "owner-clar-resume";
    let (rt, _ws) = runtime_with(
        "clar-resume",
        owner,
        ScriptTransport::new(&["{\"tool\":\"none\",\"answer\":\"Got it, scheduling it now.\"}"]),
    );
    let caller = authed_caller(owner);
    // First turn: the vague planning task → clarification (gate fires; this transport's first POST
    // is never reached because the gate stops before any model call).
    let first = rt.run_session_task(
        &caller,
        "run-clar-resume-1",
        "sess-clar-resume",
        "create a workflow that posts a daily summary",
        5_000,
    );
    match &first {
        AuthedAnswer::Delivered { status, .. } => {
            assert_eq!(status, "awaiting_clarification", "first turn clarifies")
        }
        other => panic!("expected a clarification on the first turn, got {other:?}"),
    }
    // Resume turn: a PLAIN answer (no planning verb) on the SAME session, a NEW run_id.
    let resume = rt.run_session_task(
        &caller,
        "run-clar-resume-2",
        "sess-clar-resume",
        "Post it to the team Slack channel every morning at 9am please",
        6_000,
    );
    match resume {
        AuthedAnswer::Delivered { status, answer, .. } => {
            assert_eq!(
                status, "finished",
                "a plain answer classifies None ⇒ the loop runs to Finished; the gate does NOT re-fire"
            );
            assert!(
                !answer.contains("Question 1/2"),
                "the resume answer is the model's reply, NOT another clarification: {answer}"
            );
        }
        other => panic!("expected a Finished delivery on resume, got {other:?}"),
    }
}

// --- stuck-`awaiting_clarification` lifecycle fix (runtime integration) ----------
//
// The storage-level chokepoint is proven in `friday-storage::run_result` tests; these
// lock that the LIVE RUNTIME actually routes a terminal run through it, so the
// readback `agent_run.state` is coherent with the result instead of stuck at the
// `create_run` entry value — AND that a genuine gate hold is NOT moved.

/// INTEGRATION REPRO: a run that FINISHES through the real `run_session_task` →
/// `run_session_loop` → step-5 `persist_run_result` chain must leave the persisted
/// `agent_run.state` at the terminal `"finished"` — NOT stuck at the `create_run`
/// `"awaiting_clarification"` value (the live-DB defect: 120 finished runs stuck).
#[test]
fn finished_run_through_runtime_persists_terminal_agent_run_state() {
    std::env::set_var(friday_hub::FRIDAY_CLARIFICATION_GATE, "1");
    let owner = "owner-state-finished";
    // A PLAIN task (no planning verb) classifies None ⇒ the gate does not fire ⇒ the
    // loop runs to Finished on the scripted transport.
    let (rt, _ws) = runtime_with(
        "state-finished",
        owner,
        ScriptTransport::new(&["{\"tool\":\"none\",\"answer\":\"All done.\"}"]),
    );
    let caller = authed_caller(owner);
    let answer = rt.run_session_task(
        &caller,
        "run-state-finished",
        "sess-state-finished",
        "Tell me the current time in UTC",
        5_000,
    );
    match &answer {
        AuthedAnswer::Delivered { status, .. } => assert_eq!(status, "finished"),
        other => panic!("expected a Finished delivery, got {other:?}"),
    }
    // THE FIX: the persisted run-state (what the refs-only readback surfaces as
    // `run_state`) is now the terminal status, not the stuck entry value.
    let summary =
        friday_storage::agent_run_read::get_run_summary(rt.db().conn(), "run-state-finished")
            .unwrap()
            .expect("the finished run has an agent_run row");
    assert_eq!(
        summary.state, "finished",
        "a finished run's agent_run.state must be terminal, not stuck at awaiting_clarification"
    );
    // The terminal transition stamps `updated_at` with the run's clock. This single-turn
    // dispatch threads ONE `now_ms` through create + persist, so the two timestamps coincide
    // (a real run that spans wall-clock time between create and finish strictly advances it —
    // the storage-level test exercises that with distinct timestamps).
    assert!(
        summary.updated_at >= summary.created_at,
        "the terminal transition must (re)stamp updated_at"
    );
}

/// NO-DEGRADE (runtime): a genuine clarification HOLD — an under-specified, classified
/// planning task — STILL persists `agent_run.state == "awaiting_clarification"` AND makes
/// ZERO model calls (PanicTransport). The fix must never move a genuine hold to a terminal
/// state; the gate is structurally preserved end-to-end.
#[test]
fn genuine_clarification_hold_keeps_awaiting_state_with_no_model_call() {
    std::env::set_var(friday_hub::FRIDAY_CLARIFICATION_GATE, "1");
    let owner = "owner-state-hold";
    let (rt, _ws) = runtime_with("state-hold", owner, PanicTransport);
    let caller = authed_caller(owner);
    let answer = rt.run_session_task(
        &caller,
        "run-state-hold",
        "sess-state-hold",
        "create a workflow that posts a daily summary",
        5_000,
    );
    match &answer {
        AuthedAnswer::Delivered { status, .. } => assert_eq!(
            status, "awaiting_clarification",
            "the under-specified task is held at the gate (PanicTransport proves 0 model calls)"
        ),
        other => panic!("expected a clarification Delivered, got {other:?}"),
    }
    // THE GATE-PRESERVING INVARIANT: the persisted run-state stays at the gate's hold
    // value — the fix's chokepoint is a no-op for the `awaiting_clarification` status.
    let summary = friday_storage::agent_run_read::get_run_summary(rt.db().conn(), "run-state-hold")
        .unwrap()
        .expect("the held run has an agent_run row");
    assert_eq!(
        summary.state, "awaiting_clarification",
        "a genuine clarification hold must remain awaiting_clarification (gate not weakened)"
    );
}

/// INTEGRATION REPRO on the SESSIONLESS path that actually produced the stuck rows.
/// The live-DB stuck rows ("Read-only self-probe: confirm the repository is reachable")
/// flowed through `HubRuntime::run_task` → `run_with_request` (persist at the routed-loop
/// tail), NOT the sessioned chat entry the tests above exercise. Both share the same
/// `persist_run_result` chokepoint, but this mirrors the path of the actual defect: a
/// finished sessionless run's `agent_run.state` must be terminal, not stuck.
#[test]
fn finished_sessionless_run_task_persists_terminal_agent_run_state() {
    let owner = "owner-sessionless-finished";
    let (rt, _ws) = runtime_with(
        "sessionless-finished",
        owner,
        ScriptTransport::new(&["{\"tool\":\"none\",\"answer\":\"repo reachable\"}"]),
    );
    let (_selection, outcome) = rt
        .run_task(
            "run-sessionless-finished",
            "Read-only self-probe: confirm the repository is reachable",
            5_000,
        )
        .expect("the sessionless run drives to a terminal LoopOutcome");
    assert_eq!(
        outcome.status,
        friday_hub::LoopStatus::Finished,
        "the scripted finish must produce a Finished outcome"
    );
    let summary =
        friday_storage::agent_run_read::get_run_summary(rt.db().conn(), "run-sessionless-finished")
            .unwrap()
            .expect("the finished sessionless run has an agent_run row");
    assert_eq!(
        summary.state, "finished",
        "the sessionless path (which produced the live stuck rows) must also persist a \
         terminal agent_run.state"
    );
}

// ── CLARIFICATION LOOP CLOSURE: the answer-consumer seam + over-fire guard ──────────────
//
// The marquee proof. Before this fix the clarification gate PARKED a vague planning task but
// nothing CONSUMED the user's answers: a follow-up turn worked only INCIDENTALLY (when the answer
// happened to classify `None`). A planning-SHAPED answer (e.g. "trigger daily and build a
// dashboard") re-classified as a planning kind and RE-FIRED the gate — re-parking forever (an
// infinite clarification loop, confirmed against the pre-fix tree). These tests lock the closure:
// the resume turn is gate-SUPPRESSED (consumes the answer → terminal), the questions are folded
// into the resumed history, and the gate is owner-scoped (a different owner's session is unaffected).

/// THE CLOSURE PROOF. A real under-detailed task PARKS at `awaiting_clarification` (with the
/// specific questions); then a PLANNING-SHAPED answer on the SAME session RESUMES — the gate is
/// suppressed for the answering turn, so the loop runs and reaches a TERMINAL `finished` state
/// (NOT re-parked). This exact answer RE-FIRED the gate before the fix.
#[test]
fn parked_run_resumes_to_terminal_when_answer_is_supplied_even_if_answer_looks_like_planning() {
    std::env::set_var(friday_hub::FRIDAY_CLARIFICATION_GATE, "1");
    let owner = "owner-clar-close";
    // Two scripted finishes: the FIRST POST is the resume turn (turn 1's gate makes NO model call).
    let (rt, _ws) = runtime_with(
        "clar-close",
        owner,
        ScriptTransport::new(&[
            "{\"tool\":\"none\",\"answer\":\"Scheduled: a daily 9am summary to #team.\"}",
        ]),
    );
    let caller = authed_caller(owner);

    // Turn 1: a vague workflow task → the gate PARKS (NO model call; the questions are delivered).
    let first = rt.run_session_task(
        &caller,
        "run-clar-close-1",
        "sess-clar-close",
        "create a workflow that posts a daily summary",
        5_000,
    );
    match &first {
        AuthedAnswer::Delivered { status, .. } => assert_eq!(
            status, "awaiting_clarification",
            "turn 1 is an under-specified planning task ⇒ the gate parks it"
        ),
        other => panic!("expected a clarification on turn 1, got {other:?}"),
    }
    // The parked run's state is correctly held (the genuine hold is preserved).
    let held = friday_storage::agent_run_read::get_run_summary(rt.db().conn(), "run-clar-close-1")
        .unwrap()
        .expect("the parked run has an agent_run row");
    assert_eq!(
        held.state, "awaiting_clarification",
        "turn 1 is a genuine hold"
    );

    // Turn 2: the ANSWER. It deliberately CONTAINS planning verbs ("trigger"/"build a dashboard")
    // so that WITHOUT the resume-suppression it would re-classify as a planning kind and RE-PARK
    // (the pre-fix infinite-loop bug). With the fix the gate is suppressed for this answering turn
    // (the session's last run parked), so the loop RUNS to a terminal `finished`.
    let resume = rt.run_session_task(
        &caller,
        "run-clar-close-2",
        "sess-clar-close",
        "Trigger it daily at 9am and build a dashboard summary for the team",
        6_000,
    );
    match resume {
        AuthedAnswer::Delivered { status, answer, .. } => {
            assert_eq!(
                status, "finished",
                "THE CLOSURE: the answer is CONSUMED (gate suppressed) ⇒ the run reaches a \
                 terminal state, NOT re-parked at awaiting_clarification"
            );
            assert!(
                !answer.contains("Question 1/2"),
                "the resume delivers the model's reply, NOT another clarification: {answer}"
            );
        }
        other => panic!("expected a Finished delivery on resume, got {other:?}"),
    }
    // The resumed run's persisted state is terminal too.
    let done = friday_storage::agent_run_read::get_run_summary(rt.db().conn(), "run-clar-close-2")
        .unwrap()
        .expect("the resumed run has an agent_run row");
    assert_eq!(
        done.state, "finished",
        "the resumed run's agent_run.state is terminal (the loop closed)"
    );
}

/// GAP-(a) PROOF: the asked questions are PERSISTED into the session as an `assistant` turn, so the
/// resume turn's model sees `[task][questions]` in its history and can answer THEM (before the fix
/// only the user task was persisted — the resume turn had to guess what it was answering).
#[test]
fn parked_run_persists_the_questions_into_session_history_for_the_resume_turn() {
    std::env::set_var(friday_hub::FRIDAY_CLARIFICATION_GATE, "1");
    let owner = "owner-clar-fold";
    let (rt, _ws) = runtime_with("clar-fold", owner, PanicTransport);
    let caller = authed_caller(owner);
    let _ = rt.run_session_task(
        &caller,
        "run-clar-fold-1",
        "sess-clar-fold",
        "create a workflow that posts a daily summary",
        5_000,
    );
    let msgs = friday_storage::load_session_messages(rt.db().conn(), "sess-clar-fold").unwrap();
    // The user task is present (as before) AND the questions are now present as an assistant turn.
    assert!(
        msgs.iter().any(|m| m.role == "user"
            && m.content
                .contains("create a workflow that posts a daily summary")),
        "the user's under-specified task is recorded"
    );
    let q_msg = msgs
        .iter()
        .find(|m| m.role == "assistant" && m.content.contains("Question 1/2"))
        .expect("THE FOLD: the asked questions are persisted as an assistant turn");
    assert!(
        q_msg.content.contains(WORKFLOW_Q1) && q_msg.content.contains(WORKFLOW_Q2),
        "the folded assistant turn carries the SPECIFIC questions: {}",
        q_msg.content
    );
}

/// OVER-FIRE GUARD: a clear, actionable directive ("reply with exactly PONG") must NOT park — it
/// classifies as ordinary (non-planning) work and runs to `finished`. Documents that the gate is
/// correctly calibrated (NOT loosened) — the "even PONG parked" live-DB symptom was the stuck
/// `agent_run.state` column (the #783 lifecycle fix), NOT the gate mis-firing.
#[test]
fn clear_actionable_task_does_not_park_over_fire_guard() {
    std::env::set_var(friday_hub::FRIDAY_CLARIFICATION_GATE, "1");
    let owner = "owner-clar-pong";
    let (rt, _ws) = runtime_with(
        "clar-pong",
        owner,
        ScriptTransport::new(&["{\"tool\":\"none\",\"answer\":\"PONG\"}"]),
    );
    let caller = authed_caller(owner);
    let answer = rt.run_session_task(
        &caller,
        "run-clar-pong",
        "sess-clar-pong",
        "reply with exactly PONG",
        5_000,
    );
    match answer {
        AuthedAnswer::Delivered { status, .. } => assert_eq!(
            status, "finished",
            "a clear actionable directive must NOT park at the clarification gate (no over-fire)"
        ),
        other => panic!("expected a Finished delivery, got {other:?}"),
    }
}

/// SESSION-SCOPING: the resume-suppression is keyed on the SESSION's own prior runs. A FRESH
/// session (here a distinct owner+DB) whose first turn is a vague planning task still PARKS — an
/// unrelated session's outstanding hold can never suppress this session's gate. (The DIFFERENT-owner
/// /SAME-session-id leak is locked at the unit level by the `session_is_in_clarification_hold`
/// owner-binding tests in `lib.rs`, since this in-process runtime's policy principal is fixed at
/// config and cannot vary per-caller.)
#[test]
fn fresh_session_still_parks_resume_suppression_does_not_leak_across_sessions() {
    std::env::set_var(friday_hub::FRIDAY_CLARIFICATION_GATE, "1");
    // Owner A parks a hold.
    let owner_a = "owner-iso-a";
    let (rt_a, _ws_a) = runtime_with("clar-iso-a", owner_a, PanicTransport);
    let caller_a = authed_caller(owner_a);
    let a = rt_a.run_session_task(
        &caller_a,
        "run-iso-a-1",
        "sess-iso-a",
        "create a workflow that posts a daily summary",
        5_000,
    );
    match &a {
        AuthedAnswer::Delivered { status, .. } => assert_eq!(status, "awaiting_clarification"),
        other => panic!("{other:?}"),
    }
    // Owner B, a DIFFERENT runtime/db + a fresh session: a vague planning task STILL parks (B's
    // session has no prior hold of its own; A's hold cannot suppress B's gate).
    let owner_b = "owner-iso-b";
    let (rt_b, _ws_b) = runtime_with("clar-iso-b", owner_b, PanicTransport);
    let caller_b = authed_caller(owner_b);
    let b = rt_b.run_session_task(
        &caller_b,
        "run-iso-b-1",
        "sess-iso-b",
        "create a workflow that posts a daily summary",
        5_000,
    );
    match b {
        AuthedAnswer::Delivered { status, .. } => assert_eq!(
            status, "awaiting_clarification",
            "a fresh session with no prior hold of its own must still park (no cross-session leak)"
        ),
        other => panic!("expected a clarification (no leak), got {other:?}"),
    }
}
