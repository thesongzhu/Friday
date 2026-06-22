//! Registry gap #26 — provider FAILOVER on the live agent loop (deepseek → claude).
//!
//! This is the ONLY missing piece of multi-provider failover: both the
//! [`crate::DeepSeekAgentLlmClient`] (primary) and the [`crate::ClaudeAgentLlmClient`]
//! (fallback) already exist + are wired selectable; this wraps them so that a
//! FAILOVER-WORTHY route failure on the primary is retried ONCE on the fallback —
//! transparently, behind the [`crate::AgentLlmClient`] seam, so the live loop's single
//! model call-site (`run_loop_with_policy_flagged` → `client.next_step_metered`) gets
//! failover with NO loop change.
//!
//! ## Default-OFF, explicit substitution (UNW-003 routing-truth)
//! "No-fallback" was a DELIBERATE invariant: never silently substitute a provider the
//! operator did not ask for (see `crate::retry`'s module doc + the per-adapter
//! no-fallback contracts). This wrapper makes the substitution EXPLICIT and opt-in: it
//! is constructed ONLY behind the default-OFF `FRIDAY_PROVIDER_FAILOVER` gate
//! (see [`crate::runtime::HubRuntime`]). Flag-OFF ⇒ the wrapper is never constructed ⇒
//! the deepseek route dispatches the bare primary, byte-identical to today. The wrapper
//! lives INSIDE the loop's execution (it IS the resolved `&dyn AgentLlmClient`), NOT in
//! the route-selection layer — selection still honestly reports `provider_id="deepseek"`
//! (the requested provider); the failover is an execution-layer resilience step, not a
//! reroute the registry would mis-report.
//!
//! ## The trigger set (own classifier — NOT [`crate::retry::RetryDisposition`])
//! Failover fires on the OUTER [`crate::AgentError`] from the primary ONLY, and only for:
//!   - [`friday_deepseek::DeepSeekError::ProviderUnavailable`] — 5xx / 408 / transport.
//!   - [`friday_deepseek::DeepSeekError::ClientError`] with status **402** (quota) or
//!     **429** (rate-limit).
//! It NEVER fires on:
//!   - [`friday_deepseek::DeepSeekError::ClientError`] with any OTHER 4xx (400 / 404 /
//!     422 …) — a malformed/not-found request Claude would reject too.
//!   - [`friday_deepseek::DeepSeekError::Auth`] / [`friday_deepseek::DeepSeekError::CredentialMissing`]
//!     — a broken credential is operator-actionable, not a transient outage.
//!   - [`friday_deepseek::DeepSeekError::NoModels`] / `BadResponse` / `Core` — discovery /
//!     contract / Hub-internal failures, not a provider outage the fallback fixes.
//!   - [`crate::AgentError::Model`] — "no model available" (discovery selection): a config
//!     issue, not a transient outage; fallback would not help.
//!   - [`crate::AgentError::Parse`] — the model REPLIED, the parse failed: never failover.
//!
//! ## The double-bill guard (billing-truth)
//! The metered seam's success shape is `Ok((Err(Parse), Some(usage)))` — a chat that
//! SUCCEEDED (spent + billed tokens) but whose content failed the tool-call contract.
//! That is an OUTER `Ok`, so the wrapper returns it UNTOUCHED: no second (fallback) call,
//! no double-bill. Failover triggers on the OUTER `Err(AgentError)` (a route failure that
//! produced NO usage) ONLY — so a primary attempt that bills is NEVER also failed over,
//! and a primary attempt that fails over bills NOTHING extra (the route error carries no
//! usage). The fallback call is billed by the loop EXACTLY as a normal Claude turn would
//! be — `provider_kind = Anthropic` (the fallback adapter's own
//! [`crate::BilledUsage::from_anthropic`]) — so attribution stays truthful across failover.
//!
//! ## No overlap with the loop's same-route retry (`crate::retry`)
//! The loop's bounded same-route retry only re-attempts a `Retryable`
//! `AgentError::Route(ProviderUnavailable)` on the SAME client. When the wrapper IS that
//! client, the wrapper's failover runs INSIDE each `next_step_metered` call — so a
//! 402/429 (terminal-for-retry) fails over immediately, and a 5xx fails over within the
//! call (the loop's outer retry then re-runs the WRAPPER, i.e. primary→fallback again,
//! still bounded). There is no unbounded interaction: each wrapper call makes at most TWO
//! provider attempts (one primary, one fallback), and the loop's retry bound caps the
//! number of wrapper calls.

use crate::{AgentError, AgentLlmClient, AgentStep, MeteredStep, RawToolCall, TurnTrace};
use friday_anthropic::ClaudeError;
use friday_deepseek::DeepSeekError;

/// Is `err` — the OUTER error from the PRIMARY provider's call — a FAILOVER-worthy
/// failure that should be retried once on the fallback provider? See the module doc for
/// the exact trigger set. This is a PURE function of the error (no I/O, no state), and is
/// DELIBERATELY distinct from [`crate::retry::RetryDisposition::classify_deepseek`]: the
/// same-route retry classifier treats 402/429 as `Terminal` (no backoff ⇒ do not hammer
/// the SAME route), whereas failover treats them as worth trying a DIFFERENT provider.
pub fn is_failover_worthy(err: &AgentError) -> bool {
    match err {
        // Route failures carry the structured DeepSeek error — inspect the variant/status.
        AgentError::Route(e) => match e {
            // Transient outage: 5xx / 408 / transport. Worth a different provider.
            DeepSeekError::ProviderUnavailable(_) => true,
            // Quota (402) and rate-limit (429): the PRIMARY can't serve THIS call, but a
            // DIFFERENT provider can. Every other client error (400/404/422 malformed,
            // any other 4xx) is a bad request the fallback would also reject — do NOT
            // failover.
            DeepSeekError::ClientError { status } => *status == 402 || *status == 429,
            // Broken credential / discovery / contract / Hub-internal: not a transient
            // outage a fallback fixes.
            DeepSeekError::Auth(_)
            | DeepSeekError::CredentialMissing
            | DeepSeekError::NoModels
            | DeepSeekError::BadResponse(_)
            | DeepSeekError::Core(_) => false,
        },
        AgentError::ClaudeRoute(_) => false,
        // "no model available" (discovery selection) — a config issue, not an outage.
        AgentError::Model(_) => false,
        // The model REPLIED but the parse failed — NEVER failover (the double-bill trap is
        // the metered `Ok((Err(Parse), ..))` path, but a direct `propose_tool_call` parse
        // error is likewise not a route failure).
        AgentError::Parse(_) => false,
    }
}

/// Is a structured Claude route error worth retrying once on a different provider? This mirrors
/// [`is_failover_worthy`] without collapsing Claude's error into a string:
/// transient provider unavailable, quota (402), and rate-limit (429) may use a different provider;
/// auth, missing credentials, malformed/ordinary 4xx, and bad response fail closed unchanged.
pub fn is_claude_failover_worthy(err: &AgentError) -> bool {
    match err {
        AgentError::ClaudeRoute(e) => match e {
            ClaudeError::ProviderUnavailable(_) => true,
            ClaudeError::ClientError { status } => *status == 402 || *status == 429,
            ClaudeError::Auth(_) | ClaudeError::CredentialMissing | ClaudeError::BadResponse(_) => {
                false
            }
        },
        AgentError::Route(_) | AgentError::Model(_) | AgentError::Parse(_) => false,
    }
}

/// Wraps a `primary` (deepseek) and a `fallback` (claude) [`AgentLlmClient`]: dispatches
/// each call to the primary, and on a [`is_failover_worthy`] OUTER error retries the SAME
/// call ONCE on the fallback. Impls [`AgentLlmClient`], so it slots in as the resolved
/// `&dyn AgentLlmClient` the loop drives — failover is invisible to the loop.
///
/// Generic over both clients so the deterministic test can inject mocks for BOTH legs; in
/// production `P = DeepSeekAgentLlmClient<UreqTransport>` and `F = Box<dyn AgentLlmClient>`
/// (the Claude client, boxed). See the module doc for the trigger set + billing-truth.
pub struct ProviderFailoverWrapper<P: AgentLlmClient, F: AgentLlmClient> {
    primary: P,
    fallback: F,
}

impl<P: AgentLlmClient, F: AgentLlmClient> ProviderFailoverWrapper<P, F> {
    /// Construct the wrapper. `primary` is the deepseek leg, `fallback` the claude leg.
    pub fn new(primary: P, fallback: F) -> Self {
        Self { primary, fallback }
    }
}

impl<P: AgentLlmClient, F: AgentLlmClient> AgentLlmClient for ProviderFailoverWrapper<P, F> {
    /// Single-turn proposal. Tries the primary; on a failover-worthy error, retries on the
    /// fallback ONCE. (Not on the live loop path — the loop uses `next_step_metered` — but
    /// kept consistent so every trait method honors the same failover contract.)
    fn propose_tool_call(&self, task: &str) -> Result<RawToolCall, AgentError> {
        match self.primary.propose_tool_call(task) {
            Ok(call) => Ok(call),
            Err(e) if is_failover_worthy(&e) => self.fallback.propose_tool_call(task),
            Err(e) => Err(e),
        }
    }

    /// History-aware multi-turn step. Routed THROUGH [`Self::next_step_metered`] so there
    /// is exactly ONE failover decision point (mirrors the DeepSeek/Claude adapters); the
    /// usage is discarded here, the parse result surfaced.
    fn next_step(&self, task: &str, history: &[TurnTrace]) -> Result<AgentStep, AgentError> {
        self.next_step_metered(task, history)?.0
    }

    /// The live loop's metered step — the ONE call-site failover applies to.
    ///
    /// FAILOVER triggers on the OUTER `Err(AgentError)` ONLY (a route failure that
    /// produced NO usage). A successful chat — including the `Ok((Err(Parse), Some(usage)))`
    /// double-bill-trap shape (the primary answered + billed, the parse failed) — is an
    /// OUTER `Ok` and is returned UNTOUCHED: no fallback call, no double-bill. When failover
    /// does fire, the fallback's metered result is returned verbatim, so its
    /// Anthropic-tagged [`crate::BilledUsage`] reaches the loop's biller and the call is
    /// attributed to Anthropic — the failed primary attempt billed nothing.
    fn next_step_metered(
        &self,
        task: &str,
        history: &[TurnTrace],
    ) -> Result<MeteredStep, AgentError> {
        match self.primary.next_step_metered(task, history) {
            // OUTER Ok: a chat that ran (and is billed by the loop). This INCLUDES the
            // inner-parse-error shape `(Err(Parse), Some(usage))` — never failover it.
            ok @ Ok(_) => ok,
            // OUTER Err: the primary's route call failed (no usage). Failover iff worthy.
            Err(e) if is_failover_worthy(&e) => self.fallback.next_step_metered(task, history),
            // A non-failover-worthy route failure (auth / malformed / no-model / parse):
            // surface the PRIMARY's error unchanged — never a silent substitute.
            Err(e) => Err(e),
        }
    }
}

/// The reverse, gated resilience wrapper: Claude primary, DeepSeek fallback. Kept as a distinct
/// type so each direction has an explicit classifier and billing expectations; it still slots into
/// the same [`AgentLlmClient`] seam and makes at most one fallback attempt per provider call.
pub struct ClaudeToDeepSeekFailoverWrapper<P: AgentLlmClient, F: AgentLlmClient> {
    primary: P,
    fallback: F,
}

impl<P: AgentLlmClient, F: AgentLlmClient> ClaudeToDeepSeekFailoverWrapper<P, F> {
    pub fn new(primary: P, fallback: F) -> Self {
        Self { primary, fallback }
    }
}

impl<P: AgentLlmClient, F: AgentLlmClient> AgentLlmClient
    for ClaudeToDeepSeekFailoverWrapper<P, F>
{
    fn propose_tool_call(&self, task: &str) -> Result<RawToolCall, AgentError> {
        match self.primary.propose_tool_call(task) {
            Ok(call) => Ok(call),
            Err(e) if is_claude_failover_worthy(&e) => self.fallback.propose_tool_call(task),
            Err(e) => Err(e),
        }
    }

    fn next_step(&self, task: &str, history: &[TurnTrace]) -> Result<AgentStep, AgentError> {
        self.next_step_metered(task, history)?.0
    }

    fn next_step_metered(
        &self,
        task: &str,
        history: &[TurnTrace],
    ) -> Result<MeteredStep, AgentError> {
        match self.primary.next_step_metered(task, history) {
            ok @ Ok(_) => ok,
            Err(e) if is_claude_failover_worthy(&e) => {
                self.fallback.next_step_metered(task, history)
            }
            Err(e) => Err(e),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::BilledUsage;
    use std::cell::Cell;

    /// A scripted metered client: returns the configured OUTER result, and counts calls
    /// (so a test can assert the fallback was / was not invoked). Each leg of the wrapper
    /// gets its own instance.
    struct ScriptedClient {
        // The OUTER result this leg returns for `next_step_metered`.
        result: Box<dyn Fn() -> Result<MeteredStep, AgentError>>,
        calls: Cell<usize>,
    }
    impl ScriptedClient {
        fn new(result: impl Fn() -> Result<MeteredStep, AgentError> + 'static) -> Self {
            Self {
                result: Box::new(result),
                calls: Cell::new(0),
            }
        }
        fn calls(&self) -> usize {
            self.calls.get()
        }
    }
    impl AgentLlmClient for ScriptedClient {
        fn propose_tool_call(&self, _task: &str) -> Result<RawToolCall, AgentError> {
            unreachable!("tests drive next_step_metered")
        }
        fn next_step_metered(
            &self,
            _task: &str,
            _history: &[TurnTrace],
        ) -> Result<MeteredStep, AgentError> {
            self.calls.set(self.calls.get() + 1);
            (self.result)()
        }
    }

    fn deepseek_route(e: DeepSeekError) -> AgentError {
        AgentError::Route(e)
    }

    fn claude_finish_with_anthropic_usage() -> Result<MeteredStep, AgentError> {
        Ok((
            Ok(AgentStep::Finish {
                message: "PONG".to_string(),
            }),
            Some(BilledUsage {
                provider_kind: friday_core::ProviderKind::Anthropic,
                model: "claude-opus-4-8".to_string(),
                prompt_tokens: 11,
                completion_tokens: 8,
            }),
        ))
    }

    fn deepseek_finish_with_deepseek_usage() -> Result<MeteredStep, AgentError> {
        Ok((
            Ok(AgentStep::Finish {
                message: "PONG".to_string(),
            }),
            Some(BilledUsage {
                provider_kind: friday_core::ProviderKind::DeepSeek,
                model: "deepseek-v4-flash".to_string(),
                prompt_tokens: 7,
                completion_tokens: 5,
            }),
        ))
    }

    // ---- the classifier: exact trigger set --------------------------------------------

    #[test]
    fn classifier_failover_triggers() {
        // ProviderUnavailable (5xx / 408 / transport).
        assert!(is_failover_worthy(&deepseek_route(
            DeepSeekError::ProviderUnavailable("HTTP 503".into())
        )));
        assert!(is_failover_worthy(&deepseek_route(
            DeepSeekError::ProviderUnavailable("transport: ConnectionFailed".into())
        )));
        // 402 quota.
        assert!(is_failover_worthy(&deepseek_route(
            DeepSeekError::ClientError { status: 402 }
        )));
        // 429 rate-limit.
        assert!(is_failover_worthy(&deepseek_route(
            DeepSeekError::ClientError { status: 429 }
        )));
    }

    #[test]
    fn classifier_failover_never_triggers() {
        // Other 4xx malformed — Claude would reject too.
        for status in [400u16, 404, 413, 422] {
            assert!(
                !is_failover_worthy(&deepseek_route(DeepSeekError::ClientError { status })),
                "client error {status} must NOT failover"
            );
        }
        // Auth / credential — broken credential, operator-actionable.
        assert!(!is_failover_worthy(&deepseek_route(DeepSeekError::Auth(
            401
        ))));
        assert!(!is_failover_worthy(&deepseek_route(DeepSeekError::Auth(
            403
        ))));
        assert!(!is_failover_worthy(&deepseek_route(
            DeepSeekError::CredentialMissing
        )));
        // Discovery / contract / Hub-internal.
        assert!(!is_failover_worthy(&deepseek_route(
            DeepSeekError::NoModels
        )));
        assert!(!is_failover_worthy(&deepseek_route(
            DeepSeekError::BadResponse("garbage".into())
        )));
        assert!(!is_failover_worthy(&deepseek_route(DeepSeekError::Core(
            friday_core::CoreError::BlockedTransfer("x".into())
        ))));
        // The non-Route AgentError variants.
        assert!(!is_failover_worthy(&AgentError::Model(
            "no model available".into()
        )));
        assert!(!is_failover_worthy(&AgentError::ClaudeRoute(
            ClaudeError::ProviderUnavailable("HTTP 503".into())
        )));
        assert!(!is_failover_worthy(&AgentError::Parse("not json".into())));
    }

    #[test]
    fn claude_classifier_failover_triggers() {
        assert!(is_claude_failover_worthy(&AgentError::ClaudeRoute(
            ClaudeError::ProviderUnavailable("HTTP 503".into())
        )));
        assert!(is_claude_failover_worthy(&AgentError::ClaudeRoute(
            ClaudeError::ClientError { status: 402 }
        )));
        assert!(is_claude_failover_worthy(&AgentError::ClaudeRoute(
            ClaudeError::ClientError { status: 429 }
        )));
    }

    #[test]
    fn claude_classifier_failover_never_triggers() {
        for status in [400u16, 404, 413, 422] {
            assert!(!is_claude_failover_worthy(&AgentError::ClaudeRoute(
                ClaudeError::ClientError { status }
            )));
        }
        assert!(!is_claude_failover_worthy(&AgentError::ClaudeRoute(
            ClaudeError::Auth(401)
        )));
        assert!(!is_claude_failover_worthy(&AgentError::ClaudeRoute(
            ClaudeError::CredentialMissing
        )));
        assert!(!is_claude_failover_worthy(&AgentError::ClaudeRoute(
            ClaudeError::BadResponse("garbage".into())
        )));
        assert!(!is_claude_failover_worthy(&AgentError::Route(
            DeepSeekError::ProviderUnavailable("HTTP 503".into())
        )));
        assert!(!is_claude_failover_worthy(&AgentError::Parse(
            "not json".into()
        )));
    }

    // ---- the wrapper: behavior per case -----------------------------------------------

    #[test]
    fn quota_402_fails_over_to_claude_with_anthropic_billing() {
        let primary =
            ScriptedClient::new(|| Err(deepseek_route(DeepSeekError::ClientError { status: 402 })));
        let fallback = ScriptedClient::new(claude_finish_with_anthropic_usage);
        let wrapper = ProviderFailoverWrapper::new(primary, fallback);
        let (step, usage) = wrapper.next_step_metered("task", &[]).unwrap();
        assert_eq!(
            step.unwrap(),
            AgentStep::Finish {
                message: "PONG".into()
            },
            "the fallback's answer is surfaced"
        );
        let usage = usage.expect("the fallback chat surfaces usage to bill");
        assert_eq!(
            usage.provider_kind,
            friday_core::ProviderKind::Anthropic,
            "the failover call bills as Anthropic — never mis-attributed as DeepSeek"
        );
        assert_eq!(wrapper.primary.calls(), 1, "primary tried once");
        assert_eq!(wrapper.fallback.calls(), 1, "fallback tried once");
    }

    #[test]
    fn rate_limit_429_fails_over() {
        let primary =
            ScriptedClient::new(|| Err(deepseek_route(DeepSeekError::ClientError { status: 429 })));
        let fallback = ScriptedClient::new(claude_finish_with_anthropic_usage);
        let wrapper = ProviderFailoverWrapper::new(primary, fallback);
        let (step, usage) = wrapper.next_step_metered("task", &[]).unwrap();
        assert!(matches!(step, Ok(AgentStep::Finish { .. })));
        assert_eq!(
            usage.unwrap().provider_kind,
            friday_core::ProviderKind::Anthropic
        );
        assert_eq!(wrapper.fallback.calls(), 1);
    }

    #[test]
    fn provider_unavailable_5xx_fails_over() {
        let primary = ScriptedClient::new(|| {
            Err(deepseek_route(DeepSeekError::ProviderUnavailable(
                "HTTP 503".into(),
            )))
        });
        let fallback = ScriptedClient::new(claude_finish_with_anthropic_usage);
        let wrapper = ProviderFailoverWrapper::new(primary, fallback);
        let (step, usage) = wrapper.next_step_metered("task", &[]).unwrap();
        assert!(matches!(step, Ok(AgentStep::Finish { .. })));
        assert_eq!(
            usage.unwrap().provider_kind,
            friday_core::ProviderKind::Anthropic
        );
        assert_eq!(wrapper.fallback.calls(), 1);
    }

    #[test]
    fn inner_parse_error_never_fails_over_no_double_bill() {
        // The double-bill trap: a chat that SUCCEEDED (billed DeepSeek usage) but whose
        // content failed to parse is the OUTER `Ok((Err(Parse), Some(usage)))` shape. The
        // wrapper must return it UNTOUCHED — no fallback call, billed ONCE on DeepSeek.
        let primary = ScriptedClient::new(|| {
            Ok((
                Err(AgentError::Parse("not a tool-call object".into())),
                Some(BilledUsage {
                    provider_kind: friday_core::ProviderKind::DeepSeek,
                    model: "deepseek-v4-flash".to_string(),
                    prompt_tokens: 10,
                    completion_tokens: 5,
                }),
            ))
        });
        let fallback = ScriptedClient::new(claude_finish_with_anthropic_usage);
        let wrapper = ProviderFailoverWrapper::new(primary, fallback);
        let (step, usage) = wrapper.next_step_metered("task", &[]).unwrap();
        assert!(
            matches!(step, Err(AgentError::Parse(_))),
            "the parse error is surfaced (the run fails closed) — NOT failed over"
        );
        assert_eq!(
            usage.unwrap().provider_kind,
            friday_core::ProviderKind::DeepSeek,
            "billed ONCE on DeepSeek — the successful-but-unparseable chat"
        );
        assert_eq!(
            wrapper.fallback.calls(),
            0,
            "NO second call — the double-bill guard holds"
        );
        assert_eq!(wrapper.primary.calls(), 1);
    }

    #[test]
    fn malformed_400_never_fails_over() {
        let primary =
            ScriptedClient::new(|| Err(deepseek_route(DeepSeekError::ClientError { status: 400 })));
        let fallback = ScriptedClient::new(claude_finish_with_anthropic_usage);
        let wrapper = ProviderFailoverWrapper::new(primary, fallback);
        let err = wrapper.next_step_metered("task", &[]).unwrap_err();
        assert!(
            matches!(
                err,
                AgentError::Route(DeepSeekError::ClientError { status: 400 })
            ),
            "the primary's 400 is surfaced unchanged"
        );
        assert_eq!(
            wrapper.fallback.calls(),
            0,
            "a malformed request is not failed over"
        );
    }

    #[test]
    fn auth_error_never_fails_over() {
        let primary = ScriptedClient::new(|| Err(deepseek_route(DeepSeekError::Auth(401))));
        let fallback = ScriptedClient::new(claude_finish_with_anthropic_usage);
        let wrapper = ProviderFailoverWrapper::new(primary, fallback);
        let err = wrapper.next_step_metered("task", &[]).unwrap_err();
        assert!(matches!(err, AgentError::Route(DeepSeekError::Auth(401))));
        assert_eq!(
            wrapper.fallback.calls(),
            0,
            "a broken credential is operator-actionable, not failed over"
        );
    }

    #[test]
    fn claude_provider_unavailable_fails_over_to_deepseek_with_deepseek_billing() {
        let primary = ScriptedClient::new(|| {
            Err(AgentError::ClaudeRoute(ClaudeError::ProviderUnavailable(
                "HTTP 503".into(),
            )))
        });
        let fallback = ScriptedClient::new(deepseek_finish_with_deepseek_usage);
        let wrapper = ClaudeToDeepSeekFailoverWrapper::new(primary, fallback);
        let (step, usage) = wrapper.next_step_metered("task", &[]).unwrap();
        assert_eq!(
            step.unwrap(),
            AgentStep::Finish {
                message: "PONG".into()
            }
        );
        assert_eq!(
            usage.unwrap().provider_kind,
            friday_core::ProviderKind::DeepSeek
        );
        assert_eq!(wrapper.primary.calls(), 1);
        assert_eq!(wrapper.fallback.calls(), 1);
    }

    #[test]
    fn claude_auth_error_never_fails_over() {
        let primary = ScriptedClient::new(|| Err(AgentError::ClaudeRoute(ClaudeError::Auth(401))));
        let fallback = ScriptedClient::new(deepseek_finish_with_deepseek_usage);
        let wrapper = ClaudeToDeepSeekFailoverWrapper::new(primary, fallback);
        let err = wrapper.next_step_metered("task", &[]).unwrap_err();
        assert!(matches!(
            err,
            AgentError::ClaudeRoute(ClaudeError::Auth(401))
        ));
        assert_eq!(wrapper.fallback.calls(), 0);
    }

    #[test]
    fn primary_success_never_calls_fallback() {
        // The happy path: primary 200s + parses. The fallback must never be touched.
        let primary = ScriptedClient::new(|| {
            Ok((
                Ok(AgentStep::Finish {
                    message: "deepseek answer".into(),
                }),
                Some(BilledUsage {
                    provider_kind: friday_core::ProviderKind::DeepSeek,
                    model: "deepseek-v4-flash".to_string(),
                    prompt_tokens: 10,
                    completion_tokens: 5,
                }),
            ))
        });
        let fallback = ScriptedClient::new(claude_finish_with_anthropic_usage);
        let wrapper = ProviderFailoverWrapper::new(primary, fallback);
        let (step, usage) = wrapper.next_step_metered("task", &[]).unwrap();
        assert_eq!(
            step.unwrap(),
            AgentStep::Finish {
                message: "deepseek answer".into()
            }
        );
        assert_eq!(
            usage.unwrap().provider_kind,
            friday_core::ProviderKind::DeepSeek
        );
        assert_eq!(
            wrapper.fallback.calls(),
            0,
            "primary succeeded — no failover"
        );
    }
}
