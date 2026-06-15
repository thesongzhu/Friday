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
