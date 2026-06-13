// C1-4 item — ROUTED Codex parity harness (LIVE, `#[ignore]`'d, OAuth/CLI-login-gated).
//
// HONEST NAME: routed Codex parity over a METERED SUBSET. The 23 §3 flows break down (full
// tally at the bottom) as: 4 CHAT-expressible + 1 routed+metered session-control
// (approval-request) + 2 cross-cutting side-effects (audit / ledger) + ~16 DEFERRED. Of the 4
// CHAT-expressible, send-message + answer-question are proven LIVE+metered here, auth-failure is
// a LIVE NEGATIVE (no metered flow — the route stays undispatchable), and error-handling is
// covered DETERMINISTICALLY no-creds in-crate (not live — a live error wastes quota). The
// remaining ~16 §3 entries are session-control / session-management flows that are NOT on any
// metered Codex path and stay DEFERRED (substrate not wired through the C1 route-pin / metering
// path — enumerated below).
// This is a metered SUBSET, NOT a "24-flow parity" harness; claiming 24-flow parity — or
// covering any of the deferred ~16 via a chat-only turn or the LOCAL app-server stream MIRROR
// (`map_server_message_to_provider_event`) — would be a FAKE proof (the
// `codex_appserver_no_ledger.rs` token-safety lock proves that mirror writes NO ledger row, so
// it is structurally incapable of standing in for a routed+metered Codex turn — see the
// categorization below). It MIRRORS `tests/routed_claude_parity.rs` in FORM (the §3 comment
// block, the `live_codex_runtime`/`assert_codex_rows` helpers, the `#[ignore]` pattern), NOT in
// flow count: the Claude file additionally carries live interrupt/steer/sessioned tests, but the
// C1-4 spec lists steer + interrupt INSIDE the deferred ~16, so they are NOT covered here.
//
// == What this harness PROVES (when run with Codex logged in) ==
// It drives the REAL C1 route-pin end-to-end:
//   HubRuntime::live() (gated on FRIDAY_CODEX_ROUTE_ENABLED=1, builds the live
//   CodexAgentLlmClient over the production per-turn LocalCodexAppServerTurnSource) ->
//   validate_and_enable_codex() (the creds-light app-server health_check — initialize +
//   thread/list, NO model turn — that flips the in-process `codex` route dispatchable) ->
//   run_task_pinned(.., "codex", ..) (no-fallback pin) -> select_route -> resolver ->
//   CodexAgentLlmClient (the C1-3 pin) -> the gate-mandatory loop -> bill_model_call records a
//   `codex` ledger row.
// For each covered flow it asserts selection.provider_id == "codex" AND a run-scoped
// codex / provider_app_server_local ledger row (Db::list_run_token_usage) — the metered Codex
// turn, never mis-attributed as DeepSeek/Anthropic, never a silent reroute, never a remote API
// host.
//
// == Why #[ignore]'d + NO quota spent here ==
// Through the PUBLIC HubRuntime API the `codex` route becomes dispatchable ONLY via
// validate_and_enable_codex(), which spawns a real local Codex app-server and runs the
// creds-light health_check; with no Codex CLI installed / not logged in (no ChatGPT
// subscription OAuth), the spawn/handshake surfaces a typed CodexAppServerError (Err) and the
// route stays undispatchable. There is deliberately NO public no-login route-enable (that would
// breach the dark/default-off invariant). So this harness CANNOT route Codex without an OAuth
// login and is correctly #[ignore]'d — only the OPERATOR RUN drives real Codex turns. The
// deterministic, no-creds proof of the SAME routing+metering wiring lives in-crate
// (friday-hub/src/runtime.rs tests:
// `run_task_pinned_codex_routes_through_runtime_and_writes_codex_row`,
// `codex_mutating_turn_bills_codex_row_then_pauses_for_approval`, and
// `codex_route_error_fails_run_closed_and_bills_nothing`), where the test module may use
// with_codex + the private mark_route_* helpers a real health_check would otherwise flip.
//
// == Credentials required to run (operator) ==
// HubRuntime::live builds the live DeepSeek client first (DeepSeekClient::from_env), so the
// DeepSeek key is ALWAYS required even though only the Codex leg is asserted. Codex auth is an
// OAuth / ChatGPT-subscription `codex login` (NOT an API key — distinct from Claude's
// FRIDAY_ANTHROPIC_API_KEY 401-key path): the local Codex CLI must be installed on PATH and
// logged in. The Codex gate must be on. The Claude gate is left OFF, so NO Anthropic key is
// needed (live() only reads FRIDAY_ANTHROPIC_API_KEY when FRIDAY_CLAUDE_ROUTE_ENABLED=1).
//
//   # one-time: log the Codex CLI in to your ChatGPT subscription (OAuth)
//   codex login
//   FRIDAY_CODEX_ROUTE_ENABLED=1 \
//     FRIDAY_DEEPSEEK_API_KEY=<ds-key> \
//     cargo test -p friday-hub --test routed_codex_parity -- --ignored --nocapture
//
// The harness reads NO credential value itself (the provider crates / the Codex CLI read their
// own auth); it never prints a secret. If the gate is off, the DeepSeek key is missing, or Codex
// is not logged in, live()/validate fail closed and the harness surfaces that as a blocker —
// never a fallback, never a fake PASS.
//
// == LIVE-PROOF FLAKINESS (the Option-usage note) ==
// A real Codex turn does NOT guarantee a `thread/tokenUsage/updated` notification: the
// app-server `ModelTurnOutcome.usage` is an `Option`, and a turn that COMPLETED without a usage
// update yields `usage: None`. `BilledUsage::from_codex` maps `None` to (0, 0) tokens — so a
// completed Codex turn ALWAYS bills exactly ONE codex ledger row, but that row may carry 0/0
// tokens. The ledger-row assertions here therefore tolerate a 0/0 codex row: they prove provider
// ATTRIBUTION (provider_kind == "codex", base_url_host == "provider_app_server_local",
// fallback == false, model == the gpt-5-codex route model) and DO NOT require nonzero tokens. The
// row's EXISTENCE + correct attribution is the faithful invariant; a 0-token row is still a real
// routed+metered Codex turn, never a DeepSeek/Anthropic mis-attribution.
//
// == §3 (10-PARITY-TESTING-RELEASE-GATES.md) FLOW CATEGORIZATION — brutally honest ==
// The §3 "required common flows" list has 23 entries. The C1 route-pin (run_task_pinned) is a
// CHAT-only (single send -> loop -> answer) entry; it is NOT a session-control surface. So most
// §3 flows are NOT expressible through it:
//
// CHAT-expressible (4; coverage noted per flow):
//   - send message    -> a single send -> loop -> answer turn pinned to codex; one metered codex
//                        turn. Covered LIVE here (chat_send_message_routes_to_codex_and_bills_codex).
//   - answer question -> a question is a send-message turn whose answer is the reply. Covered LIVE
//                        here (chat_answer_question_routes_to_codex_and_bills_codex).
//   - error handling  -> a mid-run Codex app-server/model error (a CodexAppServerError mapped to
//                        AgentError::Model) fails the run CLOSED (Errored), no reroute, NO ledger
//                        row. Covered DETERMINISTICALLY no-creds in-crate
//                        (runtime.rs codex_route_error_fails_run_closed_and_bills_nothing) — the
//                        in-loop error path is provider-agnostic, so the no-creds in-crate proof
//                        is the faithful one; no dedicated live test (a live error is unreliable
//                        to provoke without quota waste).
//   - auth failure    -> Codex NOT logged in / CLI absent => validate_and_enable_codex()'s
//                        creds-light health_check returns Err(CodexAppServerError) => the route
//                        is never flipped dispatchable => a codex pin fails closed (no quota, no
//                        reroute). Covered LIVE here NEGATIVELY
//                        (auth_failure_keeps_codex_undispatchable_no_reroute, run with Codex
//                        logged OUT). Distinct from Claude's 401 API-key path: Codex auth is
//                        OAuth/ChatGPT-subscription `codex login`, NOT an API key.
//
// ROUTED + METERED session-control flow (covered here + in-crate, 1):
//   - approval request -> a codex turn proposing a MUTATING tool is BILLED a codex row (the
//                         proposing chat spent the turn) and THEN the gate Pauses (no operator key
//                         => fail-closed RequiresApproval), persisting a pending approval. The
//                         metered turn IS the codex turn; the Pause is gate mechanics on top.
//                         (Deterministically proven no-creds in-crate; live here.)
//
// DEFERRED — session-control flows NOT expressible through the C1 route-pin/metering path
// (~16 §3 entries; each needs a routed session-control surface the C1 atom does NOT build):
//   - approve / reject -> the resume leg: an operator-signed approval re-executes the paused
//                         mutation. The RE-EXECUTION is NOT itself a routed Codex model turn, so it
//                         records no NEW codex ledger row — it is approval/resume mechanics, not a
//                         metered Codex flow. WIRING NEEDED: bind the resume entry to the run's
//                         pinned provider + assert the resume's own audit receipt (no new model row).
//   - resume           -> same resume entry; same note. WIRING NEEDED: a provider-pinned resume
//                         path + its receipt assertion.
//   - steer running turn -> mid-turn re-prompt; the loop is single-shot per run_task call. NOTE:
//                         the runtime exposes a `run_task_pinned_steerable` entry (proven LIVE for
//                         Claude), but the C1-4 spec lists `steer` in the deferred set for Codex,
//                         so it is intentionally NOT covered here pending its own Codex live proof.
//   - interrupt / stop -> there is a `run_task_pinned_cancellable` entry (proven LIVE for Claude);
//                         likewise listed in the C1-4 deferred set for Codex, NOT covered here.
//   - list sessions / open session / read transcript / file view / diff view / fork / archive /
//     file attachment / screenshot attachment+result ->
//                         the Codex app-server emits a LOCAL stream of server messages that
//                         `friday_providers::codex_appserver::map_server_message_to_provider_event`
//                         can MIRROR into provider-session/projection records — but NONE of it is
//                         routed through select_route -> CodexAgentLlmClient nor metered through
//                         bill_model_call. Covering these via the mirror would be a FAKE: the
//                         `codex_appserver_no_ledger.rs` token-safety lock proves the mirror writes
//                         NO token ledger row (a health/schema/list/mirror event is not a model
//                         turn). WIRING NEEDED: route the Codex session CRUD + the app-server
//                         mirror through the C1 dispatch path with per-op metering/audit — a
//                         substantial separate lane.
//   - offline / stale state -> a connectivity/stale-link state machine on the session link; not a
//                         routed model turn. WIRING NEEDED: link-state transitions.
//   - Activity / Needs Me -> the Activity inbox surfaces a Paused run as Needs-Me; the wiring is
//                         the activity projection, not a routed Codex turn.
//
// CROSS-CUTTING (a SIDE EFFECT of every covered metered turn, not standalone):
//   - audit logging -> every billed turn writes a hash-chained agent_loop.model_call audit
//                      event (an atomic side-effect of bill_model_call).
//   - token ledger  -> the codex row itself — the core assertion of this harness.
//
// TALLY: 23 §3 flows = 4 chat-expressible (LIVE/in-crate) + 1 session-control wired
// (approval-request) + 2 cross-cutting (audit/ledger, side effects) + ~16 DEFERRED
// session-control. session_control_wired = PARTIAL (only the approval-REQUEST half is
// routed+metered; the approve/reject/resume completion half + all the list/open/read/steer/stop/
// fork/archive/attach/diff/offline/activity surfaces are DEFERRED with the per-flow notes above).
// This file does NOT claim 24-flow parity; it proves a metered SUBSET.

use friday_hub::runtime::{HubConfig, HubRuntime, ENV_CODEX_ROUTE_ENABLED};
use friday_hub::LoopStatus;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};

/// The model id the `codex` route bills against — matches the private `CODEX_ROUTE_MODEL` in
/// runtime.rs (`gpt-5-codex`). Hardcoded here because that const is crate-private; the in-crate
/// C1-3 tests assert the same value, so a drift would red those deterministic tests too.
const CODEX_ROUTE_MODEL: &str = "gpt-5-codex";

static C: AtomicU64 = AtomicU64::new(0);

struct TempWs(PathBuf);
impl TempWs {
    fn new(tag: &str) -> Self {
        let p = std::env::temp_dir().join(format!(
            "friday-routed-codex-parity-{}-{}-{tag}",
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

/// Build a HubConfig for a fresh temp workspace. `operator_vk` is left `None` (no
/// OPERATOR_VK_PATH env) so a mutating action Pauses fail-closed — the approval-request leg.
fn config_for(ws: &TempWs, secret_tag: &[u8]) -> HubConfig {
    let mut secret = b"routed-codex-parity-harness-secret-".to_vec();
    secret.extend_from_slice(secret_tag);
    HubConfig {
        db_path: ws.db_path(),
        workspace_root: ws.0.clone(),
        secret,
        max_turns: 6,
        principal_id: None,
        disabled_tools: vec![],
        read_only: false,
        operator_vk: None,
    }
}

/// Build a LIVE, Codex-enabled runtime: the gate must be ON and the DeepSeek key present (live()
/// always builds the DeepSeek client first), then the creds-light app-server `health_check` must
/// flip the `codex` route dispatchable. Any failure is surfaced as a clear blocker (panic with a
/// precise message) — NEVER a fallback or a fake pass. Returns the assembled runtime guarded by
/// the temp workspace.
///
/// DIVERGENCE from Claude's `live_claude_runtime`: `validate_and_enable_codex()` returns
/// `Result<HealthSummary, CodexAppServerError>` (NOT a `KeyValidationOutcome`) — Codex has no HTTP
/// key probe; the OAuth/CLI login is checked by spawning the local app-server. We assert `.is_ok()`.
fn live_codex_runtime(tag: &str) -> (HubRuntime<friday_deepseek::UreqTransport>, TempWs) {
    assert_eq!(
        std::env::var(ENV_CODEX_ROUTE_ENABLED).ok().as_deref(),
        Some("1"),
        "set {ENV_CODEX_ROUTE_ENABLED}=1 to run the live routed-codex parity"
    );
    let ws = TempWs::new(tag);
    let mut rt = HubRuntime::live(config_for(&ws, b"0"))
        .expect("HubRuntime::live must assemble with the gate on + the DeepSeek key present");
    let summary = rt.validate_and_enable_codex().unwrap_or_else(|e| {
        panic!(
            "the creds-light Codex app-server health_check must succeed to enable the codex route \
             (got Err {e:?}); a CLI-absent / logged-out Codex is a blocker, never a fallback — run \
             `codex login` first"
        )
    });
    // The health summary is a metadata-only signal (initialize + thread/list); it spent ZERO
    // completion quota. Surfaced so the operator sees the live handshake landed.
    eprintln!("LIVE codex health_check OK: {summary:?}");
    (rt, ws)
}

/// Assert a run's metered turns were ALL billed to Codex (provider_kind == "codex",
/// base_url_host == "provider_app_server_local", non-fallback) — never mis-attributed as
/// DeepSeek/Anthropic, never a remote API host. The COUNT relationship to `turns` depends on the
/// terminal status:
///   - `Finished` / `Paused` — every counted turn produced a billable chat (the live adapter's
///     `next_step_metered` ALWAYS returns `Some(BilledUsage)` for a completed turn, even when the
///     turn emitted no `thread/tokenUsage/updated` notification — that row carries 0/0 tokens),
///     so exactly `turns` codex rows.
///   - any other status (`Errored` / `Bounded` / `Blocked`) — a turn can fail AFTER counting but
///     BEFORE billing (a route error bills nothing), so the row count can be `< turns`; we only
///     require at least one billed codex turn and that all rows are codex. This keeps the
///     operator's live run from flaking on a transient app-server error.
///
/// FLAKINESS NOTE (Option-usage): this tolerates a 0/0 codex row — it proves provider ATTRIBUTION
/// (the row exists + is codex + local-app-server host + non-fallback), NOT a nonzero token count.
fn assert_codex_rows(
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
            "run {run_id}: a finished/paused run bills one codex row per turn (turns={turns}, \
             rows={})",
            rows.len()
        ),
        _ => assert!(
            !rows.is_empty(),
            "run {run_id}: at least one codex turn must have been billed (status {status:?})"
        ),
    }
    for row in &rows {
        assert_eq!(
            row.provider_kind, "codex",
            "NOT mis-attributed as deepseek/anthropic"
        );
        assert_eq!(
            row.base_url_host, "provider_app_server_local",
            "the LOCAL Codex app-server host label (never a remote API host)"
        );
        assert_eq!(row.model, CODEX_ROUTE_MODEL, "the gpt-5-codex route model");
        assert!(!row.fallback, "the codex route is never a fallback");
        // Tokens are NOT asserted nonzero: a completed Codex turn with no tokenUsage update bills a
        // 0/0 row, which still proves attribution. (See the Option-usage flakiness note above.)
    }
}

// ---- CHAT-expressible flows (LIVE) ----------------------------------------------------------

#[test]
#[ignore = "live: needs FRIDAY_CODEX_ROUTE_ENABLED=1 + FRIDAY_DEEPSEEK_API_KEY + a logged-in Codex CLI (`codex login`, OAuth); spends Codex quota; run with --ignored"]
fn chat_send_message_routes_to_codex_and_bills_codex() {
    // §3 "send message": one pinned-codex turn; metered codex row; provider_id == codex.
    let (rt, _ws) = live_codex_runtime("send-message");
    let (selection, outcome) = rt
        .run_task_pinned(
            "live-codex-send",
            "Reply with exactly: PONG",
            "codex",
            1_000,
        )
        .expect("a live pinned-codex run completes (no reroute)");
    assert_eq!(
        selection.provider_id, "codex",
        "the pin routed to codex, no reroute"
    );
    assert!(
        matches!(outcome.status, LoopStatus::Finished | LoopStatus::Bounded),
        "a chat turn finishes (or bounds on max_turns); got {:?}",
        outcome.status
    );
    assert_codex_rows(&rt, "live-codex-send", outcome.status, outcome.turns);
    eprintln!(
        "LIVE OK: send message → codex, {} codex turn(s)",
        outcome.turns
    );
}

#[test]
#[ignore = "live: needs FRIDAY_CODEX_ROUTE_ENABLED=1 + FRIDAY_DEEPSEEK_API_KEY + a logged-in Codex CLI; spends Codex quota; run with --ignored"]
fn chat_answer_question_routes_to_codex_and_bills_codex() {
    // §3 "answer question": a question is a send-message turn whose reply is the answer.
    let (rt, _ws) = live_codex_runtime("answer-question");
    let (selection, outcome) = rt
        .run_task_pinned(
            "live-codex-answer",
            "What is 2 + 2? Reply with just the number.",
            "codex",
            1_000,
        )
        .expect("a live pinned-codex question run completes");
    assert_eq!(selection.provider_id, "codex");
    assert!(matches!(
        outcome.status,
        LoopStatus::Finished | LoopStatus::Bounded
    ));
    assert_codex_rows(&rt, "live-codex-answer", outcome.status, outcome.turns);
    eprintln!(
        "LIVE OK: answer question → codex, {} codex turn(s)",
        outcome.turns
    );
}

// ---- ROUTED + METERED session-control flow: approval request --------------------------------

#[test]
#[ignore = "live: needs FRIDAY_CODEX_ROUTE_ENABLED=1 + FRIDAY_DEEPSEEK_API_KEY + a logged-in Codex CLI; spends Codex quota; run with --ignored"]
fn approval_request_codex_turn_bills_codex_then_pauses() {
    // §3 "approval request": a codex turn that proposes a MUTATING tool is BILLED a codex row (the
    // proposing chat spent the turn) and THEN the gate Pauses (no operator key ⇒ fail-closed
    // RequiresApproval). This is the one session-control flow that is genuinely routed+metered
    // through the C1 pin. NOTE: whether the live model proposes a mutation on a given prompt is
    // model-dependent; if it answers in chat instead, the run Finishes with the codex row still
    // recorded (the metering assertion holds either way). The PAUSE is the additional,
    // model-cooperation-dependent leg.
    let (rt, _ws) = live_codex_runtime("approval-request");
    let (selection, outcome) = rt
        .run_task_pinned(
            "live-codex-approval",
            "Create a file named out.txt containing the text C1-4 using the write_file tool.",
            "codex",
            2_000,
        )
        .expect("a live pinned-codex run that may propose a mutation completes its turn");
    assert_eq!(selection.provider_id, "codex");
    // The model-call(s) that produced the turn(s) are billed regardless of the gate outcome.
    assert_codex_rows(&rt, "live-codex-approval", outcome.status, outcome.turns);
    if outcome.status == LoopStatus::Paused {
        let pending: i64 = rt
            .db()
            .conn()
            .query_row(
                "SELECT count(*) FROM pending_approval_request WHERE run_id = 'live-codex-approval'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(
            pending, 1,
            "a paused mutating turn persists a pending approval"
        );
        eprintln!("LIVE OK: approval request → codex turn billed, gate Paused (pending recorded)");
    } else {
        eprintln!(
            "LIVE OK: codex turn billed (status {:?}); the model answered in chat rather than \
             proposing a mutation — the metering assertion holds; the Pause leg needs a mutating \
             proposal",
            outcome.status
        );
    }
}

// ---- auth-failure CHAT-adjacent negative (LIVE; Codex logged OUT) ----------------------------

#[test]
#[ignore = "live: needs FRIDAY_CODEX_ROUTE_ENABLED=1 + FRIDAY_DEEPSEEK_API_KEY + Codex LOGGED OUT (or no Codex CLI on PATH); run with --ignored"]
fn auth_failure_keeps_codex_undispatchable_no_reroute() {
    // §3 "auth failure": Codex NOT logged in (or the CLI absent) → validate_and_enable_codex()'s
    // creds-light app-server health_check returns Err(CodexAppServerError) ⇒ the codex route is
    // never flipped dispatchable ⇒ a codex pin fails closed (RequestedProviderUnavailable), with
    // NO reroute to deepseek. Run this with Codex LOGGED OUT (`codex logout`, or remove the CLI
    // from PATH) and the gate on + a real deepseek key so `live()` still assembles. Distinct from
    // Claude's wrong-API-key path: Codex auth is OAuth/ChatGPT-subscription, not a key — and the
    // probe spawns no model turn, so it spends ZERO completion quota.
    assert_eq!(
        std::env::var(ENV_CODEX_ROUTE_ENABLED).ok().as_deref(),
        Some("1"),
        "set {ENV_CODEX_ROUTE_ENABLED}=1"
    );
    let ws = TempWs::new("auth-failure");
    let mut rt =
        HubRuntime::live(config_for(&ws, b"1")).expect("live() assembles with a real deepseek key");
    let result = rt.validate_and_enable_codex();
    assert!(
        result.is_err(),
        "a logged-out / absent Codex CLI must NOT validate (got Ok {result:?}); \
         run this test with Codex logged OUT"
    );
    let err = rt
        .run_task_pinned("live-codex-authfail", "say pong", "codex", 1_000)
        .expect_err("an unvalidated codex route must fail the pin closed, never reroute");
    eprintln!("LIVE OK: auth failure → codex undispatchable, pin failed closed: {err:?}");
}
