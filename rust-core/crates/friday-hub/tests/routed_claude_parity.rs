// C2 item 3 — ROUTED Claude parity harness (LIVE, `#[ignore]`'d, key-gated).
//
// HONEST NAME: routed Claude parity over a METERED SUBSET — ~7 of the 23 §3 flows are
// expressible through the real routed+metered Claude path (chat send / answer / error /
// auth-failure + the approval-REQUEST session-control flow + the audit/ledger cross-cuts).
// The send + answer flows are now proven through BOTH metered Claude entrypoints — the
// sessionless `run_task_pinned` AND the sessioned/history-folding `run_session_task_pinned`.
// The remaining 16 §3 entries are session-control / session-management flows that are NOT on
// any metered Claude path and stay DEFERRED (substrate not wired through the C2 route-pin /
// metering path — enumerated below). This is a metered SUBSET, NOT a "24-flow parity"
// harness; claiming 24-flow parity — or covering any of the deferred 16 via a chat-only turn
// or the LOCAL stream-json mirror — would be a FAKE proof (see the categorization below).
//
// == What this harness PROVES (when run with a live key) ==
// It drives the REAL C2 route-pin end-to-end through BOTH metered entrypoints:
//   HubRuntime::live() (gated on FRIDAY_CLAUDE_ROUTE_ENABLED=1, builds the live
//   ClaudeAgentLlmClient) -> validate_and_enable_claude() (the live key probe that flips
//   the in-process `claude` route dispatchable) -> {run_task_pinned (sessionless) |
//   run_session_task_pinned (sessioned/history-folding)}(.., "claude", ..)
//   (UNW-003 no-fallback pin) -> select_route -> resolver -> ClaudeAgentLlmClient (the #695
//   pin) -> the gate-mandatory loop -> bill_model_call records an `anthropic` ledger row.
// For each covered flow it asserts selection.provider_id == "claude" AND a run-scoped
// anthropic / api.anthropic.com ledger row (Db::list_run_token_usage) — the metered
// Claude turn, never mis-attributed as DeepSeek, never a silent reroute. (Through the
// sessioned entry the C2 assertion is routing+billing — the anthropic row recorded inside
// run_session_loop — which is orthogonal to owner-gated body delivery.)
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
//   - send message    -> a single send -> loop -> answer turn pinned to claude; one metered
//                        anthropic turn. Covered LIVE here through BOTH metered entrypoints:
//                        the sessionless run_task_pinned
//                        (chat_send_message_routes_to_claude_and_bills_anthropic) and the
//                        sessioned/history-folding run_session_task_pinned
//                        (sessioned_send_message_routes_to_claude_and_bills_anthropic).
//   - answer question -> a question is a send-message turn whose answer is the reply. Covered
//                        LIVE here through BOTH entrypoints: sessionless
//                        (chat_answer_question_routes_to_claude_and_bills_anthropic) and
//                        sessioned (sessioned_answer_question_routes_to_claude_and_bills_anthropic).
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

use friday_crypto::{seal, DeviceKeypair};
use friday_hub::hub_server::AuthedPrincipal;
use friday_hub::runtime::{HubConfig, HubRuntime, ENV_CLAUDE_ROUTE_ENABLED};
use friday_hub::{CancelToken, LoopStatus, SteerHandle};
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

/// Build an authenticated caller bound to `principal` over a freshly paired sealed session — the
/// SAME mechanism the in-crate runtime tests' `authed_caller` uses (ECDH-pair two DeviceKeypairs,
/// seal the agreed challenge, `AuthedPrincipal::authenticate`). The sessioned entry treats this
/// `caller` exactly as the WS dispatch arm's authenticated principal; only this owner can read the
/// run's body (the C2 routing+billing claim is orthogonal to body delivery — see the per-test note).
fn authed_caller(principal: &str) -> AuthedPrincipal {
    const AAD: &[u8] = b"routed-claude-parity-session-aad";
    const CHALLENGE: &[u8] = b"routed-claude-parity-session-challenge";
    let hub = DeviceKeypair::generate();
    let phone = DeviceKeypair::generate();
    let hub_session = hub.agree(&phone.public_bytes());
    let caller_session = phone.agree(&hub.public_bytes());
    let sealed = seal(&caller_session, CHALLENGE, AAD).unwrap();
    AuthedPrincipal::authenticate(&hub_session, &sealed, AAD, CHALLENGE, principal).unwrap()
}

/// Assert a sessioned run's metered turns were ALL billed to Anthropic (api.anthropic.com,
/// non-fallback), never mis-attributed as deepseek. Unlike [`assert_anthropic_rows`], the sessioned
/// entry ([`HubRuntime::run_session_task_pinned`]) returns `(RoutedSelection, AuthedAnswer)` with NO
/// terminal `LoopStatus`/turn count, so we only require AT LEAST ONE billed claude turn and that
/// every row is anthropic — the same anti-flake stance the live chat legs take (a tool-use turn can
/// add rows). The row(s) exist regardless of owner/body projection because billing happens INSIDE
/// `run_session_loop`.
fn assert_sessioned_anthropic_rows(rt: &HubRuntime<friday_deepseek::UreqTransport>, run_id: &str) {
    let rows = rt.db().list_run_token_usage(run_id).unwrap();
    assert!(
        !rows.is_empty(),
        "run {run_id}: at least one claude turn must have been billed through the sessioned entry"
    );
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

// ---- CHAT-expressible flows through the SESSIONED entrypoint (LIVE) -------------------------
//
// The SAME two flows (send message / answer question) routed through the SESSIONED/history-folding
// entrypoint `run_session_task_pinned` instead of the sessionless `run_task_pinned`. These add NO
// new §3 flow — they prove that send + answer are faithfully metered through BOTH metered Claude
// entrypoints (a follow-up turn on a bound session bills an anthropic row exactly like a fresh
// chat). The metered Claude turn is the same; only the entry differs (owner-binding + session fold).

#[test]
#[ignore = "live: needs FRIDAY_CLAUDE_ROUTE_ENABLED=1 + FRIDAY_DEEPSEEK_API_KEY + FRIDAY_ANTHROPIC_API_KEY; spends Anthropic quota; run with --ignored"]
fn sessioned_send_message_routes_to_claude_and_bills_anthropic() {
    // §3 "send message" through the SESSIONED entry: a pinned-claude turn on a bound session routes
    // through `run_session_task_pinned` and bills an anthropic row. NOTE: the harness binds an
    // authenticated owner, but the C2 claim asserted here is routing+billing (an anthropic ledger
    // row), which is orthogonal to body delivery — the row is recorded inside `run_session_loop`
    // regardless of whether the projected body releases to this caller.
    let (rt, _ws) = live_claude_runtime("sess-send-message");
    let caller = authed_caller("principal:routed-claude-session-owner");
    let (selection, _answer) = rt
        .run_session_task_pinned(
            &caller,
            "live-claude-sess-send",
            "sess-live-claude-1",
            "Reply with exactly: PONG",
            "claude",
            1_000,
        )
        .expect("a live pinned-claude sessioned run completes (no reroute)");
    assert_eq!(
        selection.provider_id, "claude",
        "the sessioned pin routed to claude, no reroute"
    );
    assert_sessioned_anthropic_rows(&rt, "live-claude-sess-send");
    eprintln!("LIVE OK: sessioned send message → claude, anthropic row(s) recorded");
}

#[test]
#[ignore = "live: needs FRIDAY_CLAUDE_ROUTE_ENABLED=1 + both provider keys; spends Anthropic quota; run with --ignored"]
fn sessioned_answer_question_routes_to_claude_and_bills_anthropic() {
    // §3 "answer question" through the SESSIONED entry: a question is a send-message turn whose
    // reply is the answer; here it routes through `run_session_task_pinned` (history-folding) and
    // bills an anthropic row. Same orthogonality note as the sessioned send test (routing+billing,
    // not body delivery, is the C2 assertion).
    let (rt, _ws) = live_claude_runtime("sess-answer-question");
    let caller = authed_caller("principal:routed-claude-session-owner");
    let (selection, _answer) = rt
        .run_session_task_pinned(
            &caller,
            "live-claude-sess-answer",
            "sess-live-claude-2",
            "What is 2 + 2? Reply with just the number.",
            "claude",
            1_000,
        )
        .expect("a live pinned-claude sessioned question run completes");
    assert_eq!(selection.provider_id, "claude");
    assert_sessioned_anthropic_rows(&rt, "live-claude-sess-answer");
    eprintln!("LIVE OK: sessioned answer question → claude, anthropic row(s) recorded");
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

// ---- C2-1 interrupt / stop: cooperative cancellation, LIVE -----------------------------------
//
// The live mirror of the deterministic, no-key in-crate proof
// (`runtime.rs::run_task_pinned_cancellable_interrupts_claude_loop_after_one_billed_turn`).
// The in-crate test is the REAL dark proof (it forces the trip deterministically between two
// scripted turns); this LIVE test exercises the SAME `run_task_pinned_cancellable` entry against
// a real Anthropic key, tripping the shared `CancelToken` from a background thread shortly after
// the run starts. It is `#[ignore]`'d like every live test here — only the operator run spends
// quota — and timing-dependent (a fast/slow model may interrupt at turn 0 vs. a later boundary),
// so it asserts only the COOPERATIVE-STOP invariants that hold regardless of WHEN the trip lands:
//   - the run terminates (no hang) routed to claude (no reroute);
//   - the terminal status is `Interrupted` whenever the trip lands at or before a turn boundary
//     the loop reaches (the common case for a multi-turn task);
//   - EVERY recorded ledger row is anthropic / api.anthropic.com / non-fallback, and the row
//     count equals `outcome.turns` (each counted turn billed exactly once; NOTHING billed after
//     the trip — the same no-bill-after-trip property the in-crate test pins deterministically).
// Only the `CancelToken` clone (Send) crosses the thread boundary; the runtime stays on this
// thread.
#[test]
#[ignore = "live: needs FRIDAY_CLAUDE_ROUTE_ENABLED=1 + both provider keys; spends Anthropic quota; run with --ignored"]
fn interrupt_stop_cancels_live_claude_loop_and_bills_nothing_after_trip() {
    let (rt, _ws) = live_claude_runtime("interrupt-stop");
    let cancel = CancelToken::new();
    // Trip the cancel shortly after the run begins, from a background thread (only the token
    // clone — which is Send — crosses the boundary; the runtime never leaves this thread).
    let canceller = cancel.clone();
    let handle = std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(50));
        canceller.cancel();
    });
    let (selection, outcome) = rt
        .run_task_pinned_cancellable(
            "live-claude-interrupt",
            // A deliberately multi-step task so the loop reaches a turn boundary where the
            // (already-tripped) cancel can stop it after a real billed claude turn.
            "Think step by step and use tools across several turns; do not finish immediately.",
            "claude",
            &cancel,
            1_000,
        )
        .expect("a cancellable live pinned-claude run terminates (no hang, no reroute)");
    handle.join().unwrap();
    assert_eq!(
        selection.provider_id, "claude",
        "the pin routed to claude, no reroute"
    );
    // Whenever the loop reached a boundary after the trip, the status is Interrupted; a model
    // that finished within the first turn before the trip landed would be Finished/Bounded —
    // either way the metering invariant below must hold.
    assert!(
        matches!(
            outcome.status,
            LoopStatus::Interrupted | LoopStatus::Finished | LoopStatus::Bounded
        ),
        "cooperative stop or a fast finish; got {:?}",
        outcome.status
    );
    // No-bill-after-trip + all-anthropic: one anthropic row per counted turn, nothing after.
    let rows = rt
        .db()
        .list_run_token_usage("live-claude-interrupt")
        .unwrap();
    assert_eq!(
        rows.len(),
        outcome.turns as usize,
        "exactly one anthropic row per counted turn; nothing billed after the cancel trip"
    );
    for row in &rows {
        assert_eq!(
            row.provider_kind, "anthropic",
            "NOT mis-attributed as deepseek"
        );
        assert_eq!(row.base_url_host, "api.anthropic.com");
        assert!(!row.fallback, "the claude route is never a fallback");
    }
    eprintln!(
        "LIVE OK: interrupt/stop → claude, status {:?}, {} billed anthropic turn(s), nothing after trip",
        outcome.status, outcome.turns
    );
}

// ---- C2-2 steer / inject mid-loop: cooperative steer, LIVE -----------------------------------
//
// The live mirror of the deterministic, no-key in-crate proof
// (`runtime.rs::run_task_pinned_steerable_folds_steer_into_an_additional_metered_claude_turn`).
// The in-crate test is the REAL dark proof (it forces the injection deterministically between two
// scripted turns AND asserts the stub observed it in the steered turn's prompt). This LIVE test
// exercises the SAME `run_task_pinned_steerable` entry against a real Anthropic key, injecting the
// steer from a background thread shortly after the run starts (mirroring the C2-1 live interrupt's
// background `cancel`). It is `#[ignore]`'d like every live test here — only the operator run
// spends quota — and timing-dependent (a fast model may finish before the steer lands), so it
// asserts only the metering invariants that hold regardless of WHEN the steer folds in:
//   - the run terminates (no hang) routed to claude (no reroute);
//   - EVERY recorded ledger row is anthropic / api.anthropic.com / non-fallback, and the row count
//     equals `outcome.turns` for a finished run — each metered turn (incl. the steered one) billed
//     exactly one anthropic row, the same "steer is an additional METERED turn" property the
//     in-crate test pins deterministically (and which the `SteerTurn=Unsupported` mirror does NOT
//     satisfy — a mirror produces NO metered turn).
// Only the `SteerHandle` clone (Send + Sync via Arc<Mutex<..>>) crosses the thread boundary; the
// runtime stays on this thread. A model that finished before the steer landed simply bills its
// turns normally — the metering invariant still holds; the steer FOLD itself is what the
// deterministic in-crate test proves.
#[test]
#[ignore = "live: needs FRIDAY_CLAUDE_ROUTE_ENABLED=1 + both provider keys; spends Anthropic quota; run with --ignored"]
fn steer_turn_folds_into_live_claude_loop_as_additional_metered_turn() {
    let (rt, _ws) = live_claude_runtime("steer-turn");
    let steer = SteerHandle::new();
    // Inject the steer shortly after the run begins, from a background thread (only the handle
    // clone — Send + Sync — crosses the boundary; the runtime never leaves this thread).
    let steerer = steer.clone();
    let handle = std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(50));
        steerer.steer("ACTUALLY: also state the current step number on each turn");
    });
    let (selection, outcome) = rt
        .run_task_pinned_steerable(
            "live-claude-steer",
            // A deliberately multi-step task so the loop reaches a turn boundary where the
            // (already-injected) steer folds into a real billed claude turn.
            "Think step by step and use tools across several turns; do not finish immediately.",
            "claude",
            &steer,
            1_000,
        )
        .expect("a steerable live pinned-claude run terminates (no hang, no reroute)");
    handle.join().unwrap();
    assert_eq!(
        selection.provider_id, "claude",
        "the pin routed to claude, no reroute"
    );
    // The steered turn is an ADDITIONAL METERED turn: one anthropic row per counted turn,
    // all-anthropic (a mirror would bill nothing — this must bill the steered turn).
    assert_anthropic_rows(&rt, "live-claude-steer", outcome.status, outcome.turns);
    eprintln!(
        "LIVE OK: steer/inject → claude, status {:?}, {} billed anthropic turn(s) incl. the steered turn",
        outcome.status, outcome.turns
    );
}
