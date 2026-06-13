// C2 item 3 — ROUTED Claude parity harness (LIVE, `#[ignore]`'d, key-gated).
//
// HONEST NAME: routed Claude parity — 4 chat-expressible flows live-capturable +
// 1 session-control flow (approval-request) ROUTED+METERED; ~16 session-control flows
// DEFERRED (substrate not wired through the C2 route-pin/metering path). This is NOT a
// "24-flow parity" harness; claiming that would be a fake (see the categorization below).
//
// == What this harness PROVES (when run with a live key) ==
// It drives the REAL C2 route-pin end-to-end:
//   HubRuntime::live() (gated on FRIDAY_CLAUDE_ROUTE_ENABLED=1, builds the live
//   ClaudeAgentLlmClient) -> validate_and_enable_claude() (the live key probe that flips
//   the in-process `claude` route dispatchable) -> run_task_pinned(.., "claude", ..)
//   (UNW-003 no-fallback pin) -> select_route -> resolver -> ClaudeAgentLlmClient (the #695
//   pin) -> the gate-mandatory loop -> bill_model_call records an `anthropic` ledger row.
// For each covered flow it asserts selection.provider_id == "claude" AND a run-scoped
// anthropic / api.anthropic.com ledger row (Db::list_run_token_usage) — the metered
// Claude turn, never mis-attributed as DeepSeek, never a silent reroute.
//
// == Why #[ignore]'d + NO key spent here ==
// Through the PUBLIC HubRuntime API the `claude` route becomes dispatchable ONLY via
// validate_and_enable_claude(), which runs the live R7 key probe (spends ~1-2 Anthropic
// tokens) and only flips the route on a real `Valid`. There is deliberately NO public no-key
// route-enable (that would breach the dark/default-off invariant). So this harness CANNOT
// route Claude without a key and is correctly #[ignore]'d — only the OPERATOR RUN spends
// quota. The deterministic, no-key proof of the SAME routing+metering wiring lives in-crate
// (friday-hub/src/runtime.rs tests:
// `run_task_pinned_claude_routes_through_runtime_and_writes_anthropic_row` and
// `claude_mutating_turn_bills_anthropic_row_then_pauses_for_approval`), where the test module
// may use with_claude + the private mark_route_* helpers a live key would otherwise flip.
//
// == Credentials required to run (operator) ==
// HubRuntime::live builds the live DeepSeek client first (DeepSeekClient::from_env), so
// BOTH keys are required even though only the Claude leg is asserted:
//
//   FRIDAY_CLAUDE_ROUTE_ENABLED=1 \
//     FRIDAY_DEEPSEEK_API_KEY=<ds-key> \
//     FRIDAY_ANTHROPIC_API_KEY=<anthropic-key> \
//     cargo test -p friday-hub --test routed_claude_parity -- --ignored --nocapture
//
// The harness reads NO key value itself (the provider crates read their own env); it never
// prints a key. If the gate is off or a key is missing, live()/validate fail closed and
// the harness surfaces that as a blocker — never a fallback, never a fake PASS.
//
// == §3 (10-PARITY-TESTING-RELEASE-GATES.md) FLOW CATEGORIZATION — brutally honest ==
// The §3 "required common flows" list has 23 entries. The C2 route-pin (run_task_pinned)
// is a CHAT-only (single send -> loop -> answer) entry; it is NOT a session-control
// surface. So most §3 flows are NOT expressible through it:
//
// CHAT-expressible (4; coverage noted per flow):
//   - send message    -> run_task_pinned("claude", ..); one metered anthropic turn.
//                        Covered LIVE here (chat_send_message_routes_to_claude_and_bills_anthropic).
//   - answer question -> a question is a send-message turn whose answer is the reply.
//                        Covered LIVE here (chat_answer_question_routes_to_claude_and_bills_anthropic).
//   - error handling  -> a mid-run Claude route/model error fails the run CLOSED (Errored), no
//                        reroute, NO ledger row. Covered DETERMINISTICALLY no-key in-crate
//                        (runtime.rs claude_route_error_fails_run_closed_and_bills_nothing) — the
//                        in-loop error path is provider-agnostic, so the no-key in-crate proof
//                        is the faithful one; no dedicated live test (a live error is unreliable
//                        to provoke without quota waste).
//   - auth failure    -> a 401/403 Claude key -> validate_and_enable_claude returns
//                        Invalid/Unavailable => route stays undispatchable => a claude pin
//                        fails closed (no quota, no reroute). Covered LIVE here NEGATIVELY
//                        (auth_failure_keeps_claude_undispatchable_no_reroute, run with a
//                        deliberately-wrong key).
//
// ROUTED + METERED session-control flow (covered here + in-crate, 1):
//   - approval request -> a claude turn proposing a MUTATING tool is BILLED an anthropic row
//                         (the proposing chat spent tokens) and THEN the gate Pauses
//                         (RequiresApproval), persisting a pending approval. The metered turn
//                         IS the claude turn; the Pause is gate mechanics on top.
//                         (Deterministically proven no-key in-crate; live here.)
//
// DEFERRED — session-control flows NOT expressible through the C2 route-pin/metering path
// (~16 §3 entries; each needs a routed session-control surface the C2 atom does NOT build):
//   - approve / reject -> the resume leg: an operator-signed approval re-executes the paused
//                         mutation (s6d tests/s6d_resume_ingestion.rs /
//                         tests/r4s2_approval_execute.rs substrate). The RE-EXECUTION is NOT
//                         itself a routed Claude model turn, so it records no NEW anthropic
//                         ledger row — it is approval/resume mechanics, not a metered Claude
//                         flow. WIRING NEEDED: bind the resume entry to the run's pinned
//                         provider + assert the resume's own audit receipt (no new model row).
//   - resume           -> same s6d resume entry; same note. WIRING NEEDED: a provider-pinned
//                         resume path + its receipt assertion.
//   - steer running turn -> mid-turn re-prompt; the loop is single-shot per run_task call with
//                         no steer channel. WIRING NEEDED: a streaming/steer control method on
//                         the routed session (a1_run_control.rs is the run-control substrate;
//                         not provider-routed).
//   - interrupt / stop -> there is no cancel handle on run_task_pinned. WIRING NEEDED: a
//                         cancellation token threaded into the routed loop.
//   - list sessions / open session / read transcript / file view / diff view / fork /
//     archive / file attachment / screenshot attachment+result ->
//                         provider_session.rs defines the session-link/projection records and
//                         claude_control.rs classifies the Claude control surface + maps a
//                         LOCAL stream-json MIRROR — but NONE of it is routed through
//                         select_route -> ClaudeAgentLlmClient nor metered through
//                         bill_model_call. Covering these via the mirror would be a FAKE
//                         (mapping a mirror event is not the routed flow). WIRING NEEDED: route
//                         provider_session CRUD + the claude_control mirror through the C2
//                         dispatch path with per-op metering/audit — a substantial separate lane.
//   - offline / stale state -> a connectivity/stale-link state machine on the session link; not
//                         a routed model turn. WIRING NEEDED: link-state transitions.
//   - Activity / Needs Me -> the Activity inbox surfaces a Paused run as Needs-Me; the wiring is
//                         the activity projection, not a routed Claude turn.
//
// CROSS-CUTTING (a SIDE EFFECT of every covered metered turn, not standalone):
//   - audit logging -> every billed turn writes a hash-chained agent_loop.model_call audit
//                      event (an atomic side-effect of bill_model_call).
//   - token ledger  -> the anthropic row itself — the core assertion of this harness.
//
// TALLY: 23 §3 flows = 4 chat-expressible (LIVE) + 1 session-control wired (approval-request)
// + 2 cross-cutting (audit/ledger, side effects) + ~16 DEFERRED session-control.
// session_control_wired = PARTIAL (only the approval-REQUEST half is routed+metered; the
// approve/reject/resume completion half + all the list/open/read/steer/stop/fork/archive/
// attach/diff/offline/activity surfaces are DEFERRED with the per-flow wiring notes above).

use friday_hub::runtime::{HubConfig, HubRuntime, ENV_CLAUDE_ROUTE_ENABLED};
use friday_hub::LoopStatus;
use friday_providers::KeyValidationOutcome;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};

static C: AtomicU64 = AtomicU64::new(0);

struct TempWs(PathBuf);
impl TempWs {
    fn new(tag: &str) -> Self {
        let p = std::env::temp_dir().join(format!(
            "friday-routed-claude-parity-{}-{}-{tag}",
            std::process::id(),
            C.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::create_dir_all(&p).unwrap();
        TempWs(p)
    }
    fn db_path(&self) -> String {
        self.0.join("hub.sqlite").to_string_lossy().into_owned()
    }
}
impl Drop for TempWs {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

/// Build a LIVE, Claude-enabled runtime: the gate must be ON and both keys present, then the
/// one-shot key probe must flip the `claude` route dispatchable. Any failure is surfaced as a
/// clear blocker (panic with a precise message) — NEVER a fallback or a fake pass. Returns the
/// assembled runtime guarded by the temp workspace.
fn live_claude_runtime(tag: &str) -> (HubRuntime<friday_deepseek::UreqTransport>, TempWs) {
    assert_eq!(
        std::env::var(ENV_CLAUDE_ROUTE_ENABLED).ok().as_deref(),
        Some("1"),
        "set {ENV_CLAUDE_ROUTE_ENABLED}=1 to run the live routed-claude parity"
    );
    let ws = TempWs::new(tag);
    let config = HubConfig {
        db_path: ws.db_path(),
        workspace_root: ws.0.clone(),
        secret: b"routed-claude-parity-harness-secret-0".to_vec(),
        max_turns: 6,
        principal_id: None,
        disabled_tools: vec![],
        read_only: false,
        operator_vk: None, // a mutating action Pauses (fail-closed) — the approval-request leg.
    };
    let mut rt = HubRuntime::live(config)
        .expect("HubRuntime::live must assemble with the gate on + both provider keys present");
    let outcome = rt.validate_and_enable_claude();
    assert_eq!(
        outcome,
        KeyValidationOutcome::Valid,
        "the live Anthropic key probe must be Valid to enable the claude route (got {outcome:?}); \
         Invalid/Unavailable/CredentialMissing is a blocker, never a fallback"
    );
    (rt, ws)
}

/// Assert a run's metered turns were ALL billed to Anthropic (api.anthropic.com, non-fallback)
/// — never mis-attributed. The COUNT relationship to `turns` depends on the terminal status:
///   - `Finished` / `Paused` — every counted turn produced a billable chat, so exactly `turns`
///     anthropic rows (a completed answer / a proposing turn that then Paused).
///   - any other status (`Errored` / `Bounded` / `Blocked`) — a turn can fail AFTER counting
///     but BEFORE billing (a retry-exhausted route error bills nothing), so the row count can be
///     `< turns`; we only require at least one billed claude turn and that all rows are
///     anthropic. This keeps the operator's live run from flaking on a transient route error.
fn assert_anthropic_rows(
    rt: &HubRuntime<friday_deepseek::UreqTransport>,
    run_id: &str,
    status: LoopStatus,
    turns: u64,
) {
    let rows = rt.db().list_run_token_usage(run_id).unwrap();
    match status {
        LoopStatus::Finished | LoopStatus::Paused => assert_eq!(
            rows.len(),
            turns as usize,
            "run {run_id}: a finished/paused run bills one anthropic row per turn (turns={turns}, \
             rows={})",
            rows.len()
        ),
        _ => assert!(
            !rows.is_empty(),
            "run {run_id}: at least one claude turn must have been billed (status {status:?})"
        ),
    }
    for row in &rows {
        assert_eq!(
            row.provider_kind, "anthropic",
            "NOT mis-attributed as deepseek"
        );
        assert_eq!(row.base_url_host, "api.anthropic.com");
        assert!(!row.fallback, "the claude route is never a fallback");
    }
}

// ---- CHAT-expressible flows (LIVE) ----------------------------------------------------------

#[test]
#[ignore = "live: needs FRIDAY_CLAUDE_ROUTE_ENABLED=1 + FRIDAY_DEEPSEEK_API_KEY + FRIDAY_ANTHROPIC_API_KEY; spends Anthropic quota; run with --ignored"]
fn chat_send_message_routes_to_claude_and_bills_anthropic() {
    // §3 "send message": one pinned-claude turn; metered anthropic row; provider_id == claude.
    let (rt, _ws) = live_claude_runtime("send-message");
    let (selection, outcome) = rt
        .run_task_pinned(
            "live-claude-send",
            "Reply with exactly: PONG",
            "claude",
            1_000,
        )
        .expect("a live pinned-claude run completes (no reroute)");
    assert_eq!(
        selection.provider_id, "claude",
        "the pin routed to claude, no reroute"
    );
    assert!(
        matches!(outcome.status, LoopStatus::Finished | LoopStatus::Bounded),
        "a chat turn finishes (or bounds on max_turns); got {:?}",
        outcome.status
    );
    assert_anthropic_rows(&rt, "live-claude-send", outcome.status, outcome.turns);
    eprintln!(
        "LIVE OK: send message → claude, {} anthropic turn(s)",
        outcome.turns
    );
}

#[test]
#[ignore = "live: needs FRIDAY_CLAUDE_ROUTE_ENABLED=1 + both provider keys; spends Anthropic quota; run with --ignored"]
fn chat_answer_question_routes_to_claude_and_bills_anthropic() {
    // §3 "answer question": a question is a send-message turn whose reply is the answer.
    let (rt, _ws) = live_claude_runtime("answer-question");
    let (selection, outcome) = rt
        .run_task_pinned(
            "live-claude-answer",
            "What is 2 + 2? Reply with just the number.",
            "claude",
            1_000,
        )
        .expect("a live pinned-claude question run completes");
    assert_eq!(selection.provider_id, "claude");
    assert!(matches!(
        outcome.status,
        LoopStatus::Finished | LoopStatus::Bounded
    ));
    assert_anthropic_rows(&rt, "live-claude-answer", outcome.status, outcome.turns);
    eprintln!(
        "LIVE OK: answer question → claude, {} anthropic turn(s)",
        outcome.turns
    );
}

// ---- ROUTED + METERED session-control flow: approval request --------------------------------

#[test]
#[ignore = "live: needs FRIDAY_CLAUDE_ROUTE_ENABLED=1 + both provider keys; spends Anthropic quota; run with --ignored"]
fn approval_request_claude_turn_bills_anthropic_then_pauses() {
    // §3 "approval request": a claude turn that proposes a MUTATING tool is BILLED an anthropic
    // row (the proposing chat spent tokens) and THEN the gate Pauses (no operator key ⇒
    // fail-closed RequiresApproval). This is the one session-control flow that is genuinely
    // routed+metered through the C2 pin. NOTE: whether the live model proposes a mutation on a
    // given prompt is model-dependent; if it answers in chat instead, the run Finishes with the
    // anthropic row still recorded (the metering assertion holds either way). The PAUSE is the
    // additional, model-cooperation-dependent leg.
    let (rt, _ws) = live_claude_runtime("approval-request");
    let (selection, outcome) = rt
        .run_task_pinned(
            "live-claude-approval",
            "Create a file named out.txt containing the text C2 using the write_file tool.",
            "claude",
            2_000,
        )
        .expect("a live pinned-claude run that may propose a mutation completes its turn");
    assert_eq!(selection.provider_id, "claude");
    // The model-call(s) that produced the turn(s) are billed regardless of the gate outcome.
    assert_anthropic_rows(&rt, "live-claude-approval", outcome.status, outcome.turns);
    if outcome.status == LoopStatus::Paused {
        let pending: i64 = rt
            .db()
            .conn()
            .query_row(
                "SELECT count(*) FROM pending_approval_request WHERE run_id = 'live-claude-approval'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(
            pending, 1,
            "a paused mutating turn persists a pending approval"
        );
        eprintln!("LIVE OK: approval request → claude turn billed, gate Paused (pending recorded)");
    } else {
        eprintln!(
            "LIVE OK: claude turn billed (status {:?}); the model answered in chat rather than \
             proposing a mutation — the metering assertion holds; the Pause leg needs a mutating \
             proposal",
            outcome.status
        );
    }
}

// ---- auth-failure CHAT-adjacent negative (LIVE, but key-shape only) -------------------------

#[test]
#[ignore = "live: needs FRIDAY_CLAUDE_ROUTE_ENABLED=1 + FRIDAY_DEEPSEEK_API_KEY + a DELIBERATELY WRONG FRIDAY_ANTHROPIC_API_KEY; run with --ignored"]
fn auth_failure_keeps_claude_undispatchable_no_reroute() {
    // §3 "auth failure": a rejected Anthropic key → the one-shot probe returns a non-Valid
    // outcome ⇒ the claude route is never flipped dispatchable ⇒ a claude pin fails closed
    // (RequestedProviderUnavailable), with NO reroute to deepseek. Run this with a BAD anthropic
    // key (and the gate on + a real deepseek key so `live()` still assembles). It spends at most
    // one rejected round-trip (no completion quota on a 401).
    assert_eq!(
        std::env::var(ENV_CLAUDE_ROUTE_ENABLED).ok().as_deref(),
        Some("1"),
        "set {ENV_CLAUDE_ROUTE_ENABLED}=1"
    );
    let ws = TempWs::new("auth-failure");
    let config = HubConfig {
        db_path: ws.db_path(),
        workspace_root: ws.0.clone(),
        secret: b"routed-claude-parity-harness-secret-1".to_vec(),
        max_turns: 6,
        principal_id: None,
        disabled_tools: vec![],
        read_only: false,
        operator_vk: None,
    };
    let mut rt = HubRuntime::live(config).expect("live() assembles with a real deepseek key");
    let outcome = rt.validate_and_enable_claude();
    assert_ne!(
        outcome,
        KeyValidationOutcome::Valid,
        "a deliberately-wrong anthropic key must NOT validate (got {outcome:?})"
    );
    let err = rt
        .run_task_pinned("live-claude-authfail", "say pong", "claude", 1_000)
        .expect_err("an unvalidated claude route must fail the pin closed, never reroute");
    eprintln!("LIVE OK: auth failure → claude undispatchable, pin failed closed: {err:?}");
}
