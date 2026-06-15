//! Registry gap #26 — provider FAILOVER (deepseek → claude) on the LIVE agent loop,
//! proven END-TO-END through the real `friday_hub::run_loop` against a real Hub `Db`.
//!
//! This is the loop-closing e2e the prod-flag gate (#27) maps `FRIDAY_PROVIDER_FAILOVER`
//! to. RGG CI is DeepSeek-ONLY, so BOTH provider legs are MOCKED (no key, no network):
//! the wrapper's primary leg returns a FAILOVER-WORTHY DeepSeek route error, and its
//! fallback leg returns a finishing Claude turn with Anthropic-tagged usage. Driving the
//! wrapper THROUGH the real loop proves the WHOLE chain: a 402/429/5xx on the primary
//! fails over to the fallback, the loop FINISHES on the fallback's answer, and the call is
//! BILLED to `anthropic` (api.anthropic.com) — never mis-attributed as DeepSeek, never
//! double-billed.
//!
//! The complementary deterministic proofs live in-crate:
//!   - src/provider_failover.rs tests — the wrapper/classifier behavior per case
//!     (402/429/5xx→failover; parse/400/auth→no-failover; double-bill guard).
//!   - src/runtime.rs tests — the wiring DECISION (flag-off byte-identical; flag-on +
//!     no-Claude hard boot error; the pure flag matcher).

use std::sync::atomic::{AtomicU64, Ordering};

use friday_core::gate::MutatingActionRequest;
use friday_hub::provider_failover::ProviderFailoverWrapper;
use friday_hub::{
    run_loop, AgentError, AgentLlmClient, AgentStep, BilledUsage, FsToolExecutor, LoopStatus,
    MeteredStep, RawToolCall, TurnTrace,
};
use friday_storage::Db;

static C: AtomicU64 = AtomicU64::new(0);
const NOW: i64 = 1_700_000_000_000;
const SECRET: &[u8] = b"failover-e2e-secret-0123456789012345";

fn temp_db(tag: &str) -> String {
    std::env::temp_dir()
        .join(format!(
            "friday-failover-{}-{}-{}.sqlite",
            std::process::id(),
            tag,
            C.fetch_add(1, Ordering::Relaxed)
        ))
        .to_string_lossy()
        .into_owned()
}

fn temp_ws(tag: &str) -> std::path::PathBuf {
    let p = std::env::temp_dir().join(format!(
        "friday-failover-ws-{}-{}-{}",
        std::process::id(),
        tag,
        C.fetch_add(1, Ordering::Relaxed)
    ));
    std::fs::create_dir_all(&p).unwrap();
    p
}

/// The PRIMARY (deepseek) leg: every metered step returns the configured OUTER route
/// error (a failover-worthy DeepSeek failure). That the loop nonetheless FINISHES on the
/// fallback's answer (billed `anthropic`) is the proof the primary was tried + failed over.
struct FailingPrimary {
    err: friday_deepseek::DeepSeekError,
}
impl FailingPrimary {
    fn new(err: friday_deepseek::DeepSeekError) -> Self {
        Self { err }
    }
}
impl AgentLlmClient for FailingPrimary {
    fn propose_tool_call(&self, _task: &str) -> Result<RawToolCall, AgentError> {
        unreachable!("the loop drives next_step_metered")
    }
    fn next_step_metered(
        &self,
        _task: &str,
        _history: &[TurnTrace],
    ) -> Result<MeteredStep, AgentError> {
        Err(AgentError::Route(self.err.clone()))
    }
}

/// The FALLBACK (claude) leg: finishes with the given answer and surfaces Anthropic-tagged
/// usage exactly as the live `ClaudeAgentLlmClient::next_step_metered` would after a real
/// chat.
struct FinishingFallback {
    answer: String,
}
impl FinishingFallback {
    fn new(answer: &str) -> Self {
        Self {
            answer: answer.to_string(),
        }
    }
}
impl AgentLlmClient for FinishingFallback {
    fn propose_tool_call(&self, _task: &str) -> Result<RawToolCall, AgentError> {
        unreachable!("the loop drives next_step_metered")
    }
    fn next_step_metered(
        &self,
        _task: &str,
        _history: &[TurnTrace],
    ) -> Result<MeteredStep, AgentError> {
        Ok((
            Ok(AgentStep::Finish {
                message: self.answer.clone(),
            }),
            Some(BilledUsage {
                provider_kind: friday_core::ProviderKind::Anthropic,
                model: "claude-opus-4-8".to_string(),
                prompt_tokens: 11,
                completion_tokens: 8,
            }),
        ))
    }
}

/// Run the wrapper through the REAL loop and return (outcome, the run's billed rows). The
/// OBSERVABLE loop effect — `Finished` on the fallback's answer + a single `anthropic`
/// billed row — is the proof the primary failed over to the fallback exactly once.
fn run_failover_loop(
    tag: &str,
    primary_err: friday_deepseek::DeepSeekError,
) -> (
    friday_hub::LoopOutcome,
    Vec<friday_storage::RunTokenUsageRow>,
) {
    let db = Db::open_hub(&temp_db(tag)).unwrap();
    let ws = temp_ws(tag);
    let executor = FsToolExecutor::new(ws);
    friday_storage::agent_run::create_run(db.conn(), "run-f", "say pong", NOW).unwrap();

    let primary = FailingPrimary::new(primary_err);
    let fallback = FinishingFallback::new("PONG");
    let wrapper = ProviderFailoverWrapper::new(primary, fallback);

    // No approval fn fires (the fallback Finishes — no mutating tool), `_secret` unused.
    let no_approve = |_req: &MutatingActionRequest| None;
    let outcome = run_loop(
        &wrapper,
        &executor,
        db.conn(),
        "run-f",
        "say pong",
        "", // no recall preamble
        SECRET,
        &no_approve,
        4,
        NOW,
    )
    .unwrap();

    let rows = db.list_run_token_usage("run-f").unwrap();
    (outcome, rows)
}

/// Assert the loop FINISHED on the fallback's answer and billed EXACTLY ONE row, to
/// Anthropic (api.anthropic.com) — billing-truth across failover, no double-bill, never
/// mis-attributed as DeepSeek.
fn assert_failover_finished_billed_anthropic(
    outcome: &friday_hub::LoopOutcome,
    rows: &[friday_storage::RunTokenUsageRow],
) {
    assert_eq!(
        outcome.status,
        LoopStatus::Finished,
        "the loop must FINISH on the fallback's answer after failover"
    );
    assert_eq!(
        outcome.final_message.as_deref(),
        Some("PONG"),
        "the fallback's answer is delivered"
    );
    assert_eq!(
        rows.len(),
        1,
        "EXACTLY one billed row — the fallback turn; the failed primary attempt bills nothing (no double-bill)"
    );
    let row = &rows[0];
    assert_eq!(
        row.provider_kind, "anthropic",
        "the failover call is billed as Anthropic — never mis-attributed as DeepSeek"
    );
    assert_eq!(row.base_url_host, "api.anthropic.com");
    assert!(
        !row.fallback,
        "the chat itself is a non-fallback Anthropic call"
    );
    assert_eq!(row.prompt_tokens, 11);
    assert_eq!(row.completion_tokens, 8);
    assert_eq!(row.total_tokens, 19);
}

/// THE loop-closing e2e the #27 gate maps to: a DeepSeek 402 (quota) on the live loop
/// FAILS OVER to Claude, the loop FINISHES on Claude's answer, and the turn is BILLED to
/// Anthropic (one row, never DeepSeek, never double-billed).
#[test]
fn quota_402_fails_over_to_claude_finishes_and_bills_anthropic() {
    let (outcome, rows) = run_failover_loop(
        "402",
        friday_deepseek::DeepSeekError::ClientError { status: 402 },
    );
    assert_failover_finished_billed_anthropic(&outcome, &rows);
}

/// A DeepSeek 429 (rate-limit) likewise fails over to Claude and bills Anthropic.
#[test]
fn rate_limit_429_fails_over_to_claude_finishes_and_bills_anthropic() {
    let (outcome, rows) = run_failover_loop(
        "429",
        friday_deepseek::DeepSeekError::ClientError { status: 429 },
    );
    assert_failover_finished_billed_anthropic(&outcome, &rows);
}

/// A DeepSeek 5xx (ProviderUnavailable) likewise fails over to Claude and bills Anthropic.
#[test]
fn provider_unavailable_5xx_fails_over_to_claude_finishes_and_bills_anthropic() {
    let (outcome, rows) = run_failover_loop(
        "5xx",
        friday_deepseek::DeepSeekError::ProviderUnavailable("HTTP 503".into()),
    );
    assert_failover_finished_billed_anthropic(&outcome, &rows);
}

/// NO-FAILOVER through the real loop: a DeepSeek 400 (malformed) does NOT fail over — the
/// loop ERRORS closed on the primary's error, the fallback is never reached, and NOTHING
/// is billed (a route error produces no usage). The double-bill / silent-substitute guard,
/// proven end-to-end.
#[test]
fn malformed_400_does_not_fail_over_loop_errors_no_bill() {
    let db = Db::open_hub(&temp_db("400")).unwrap();
    let ws = temp_ws("400");
    let executor = FsToolExecutor::new(ws);
    friday_storage::agent_run::create_run(db.conn(), "run-f", "say pong", NOW).unwrap();

    let primary = FailingPrimary::new(friday_deepseek::DeepSeekError::ClientError { status: 400 });
    let fallback = FinishingFallback::new("PONG");
    let wrapper = ProviderFailoverWrapper::new(primary, fallback);
    let no_approve = |_req: &MutatingActionRequest| None;

    let outcome = run_loop(
        &wrapper,
        &executor,
        db.conn(),
        "run-f",
        "say pong",
        "",
        SECRET,
        &no_approve,
        4,
        NOW,
    )
    .unwrap();

    assert_eq!(
        outcome.status,
        LoopStatus::Errored,
        "a malformed (400) primary error is surfaced — never failed over"
    );
    assert_eq!(
        db.list_run_token_usage("run-f").unwrap().len(),
        0,
        "a route error produces no usage — NOTHING billed (no half-bill, no double-bill)"
    );
}
