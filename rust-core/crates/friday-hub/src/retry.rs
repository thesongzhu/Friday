//! UNW-011 — the SINGLE canonical retry classifier (workflow/skills substrate).
//!
//! For a failed provider/route operation it decides ONE thing: is the failure
//! transient (**Retryable** — the SAME route may be retried, bounded) or
//! **Terminal** (surface it; do not retry)? There is exactly ONE disposition
//! taxonomy ([`RetryDisposition`]) classified from the REAL error types
//! ([`friday_deepseek::DeepSeekError`] / [`crate::routing::RoutedLoopError`]) — no
//! parallel taxonomy.
//!
//! ## No silent fallback (UNW-003, do not regress)
//! `Retryable` means "retry the SAME provider/route", NEVER "try a different
//! provider". This module exposes NO API that returns an alternate provider, so
//! classification cannot become a reroute by construction. In particular
//! [`RouteError::RequestedProviderUnavailable`] — the explicit no-fallback path —
//! is **Terminal**: a specifically-requested-but-unavailable provider is surfaced,
//! never silently retried into a different one.
//!
//! ## Bounded
//! [`should_retry`] caps retries at `max_attempts` even for a `Retryable` failure,
//! so a persistently-transient provider cannot drive an unbounded retry / runaway
//! spend. This is the classifier + bound only; wiring it into an execution retry
//! loop is part of the (deferred) workflow EXECUTION engine.

use crate::routing::RoutedLoopError;
use friday_deepseek::DeepSeekError;

/// What to do with a failed provider/route operation. The only two honest answers:
/// retry the same route (transient), or stop and surface (everything else).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RetryDisposition {
    /// Transient — the SAME route may be retried (bounded by [`should_retry`]).
    /// NEVER a reroute to a different provider.
    Retryable,
    /// Do not retry — surface the failure (auth / credential / protocol / no-model /
    /// selection / wiring / storage). Retrying cannot fix it, and must not fall back.
    Terminal,
}

impl RetryDisposition {
    pub fn is_retryable(self) -> bool {
        matches!(self, RetryDisposition::Retryable)
    }

    /// Classify a DeepSeek provider error. ONLY a transient
    /// [`DeepSeekError::ProviderUnavailable`] (network/transport, request-timeout 408,
    /// or server-side 5xx) is `Retryable`; everything else is `Terminal` — retrying
    /// cannot fix it, and (per the crate's own variant docs) none is ever a fallback
    /// trigger.
    ///
    /// In particular [`DeepSeekError::ClientError`] — a terminal client-side 4xx
    /// (400/404/422) and **429 rate-limit** — is `Terminal`, NOT retried. A 4xx will
    /// not become valid on a bare retry, and 429-as-terminal is deliberate: there is
    /// no backoff mechanism here (the run_loop retry has no injected clock / no sleep),
    /// so retrying a 429 would only HAMMER a rate-limited provider with no delay. A
    /// future backoff slice could reclassify 429 as retryable-with-delay; until then,
    /// fail closed.
    pub fn classify_deepseek(err: &DeepSeekError) -> Self {
        match err {
            DeepSeekError::ProviderUnavailable(_) => RetryDisposition::Retryable,
            DeepSeekError::CredentialMissing
            | DeepSeekError::Auth(_)
            | DeepSeekError::ClientError { .. }
            | DeepSeekError::BadResponse(_)
            | DeepSeekError::NoModels
            | DeepSeekError::Core(_) => RetryDisposition::Terminal,
        }
    }

    /// Classify a routed-loop error. All variants are `Terminal`:
    /// - [`RoutedLoopError::Route`] is a SELECTION failure (no route / requested
    ///   provider unavailable) — the no-fallback path; never retried into another.
    /// - [`RoutedLoopError::NoClientForProvider`] is a deployment-wiring gap — a
    ///   retry cannot conjure a client (fail-closed, no reroute).
    /// - [`RoutedLoopError::Storage`] is a Hub-internal write failure — surfaced,
    ///   not blindly retried.
    pub fn classify_routed(err: &RoutedLoopError) -> Self {
        match err {
            RoutedLoopError::Route(_)
            | RoutedLoopError::NoClientForProvider(_)
            | RoutedLoopError::Storage(_) => RetryDisposition::Terminal,
        }
    }
}

/// Whether to retry, given the disposition, attempts ALREADY made, and a cap.
/// Bounded: a `Retryable` failure is retried only while `attempts_made <
/// max_attempts`; a `Terminal` failure is NEVER retried. `max_attempts == 0` ⇒
/// never retry (degenerate bound). The decision is "retry the SAME route" — there
/// is no reroute here.
pub fn should_retry(disposition: RetryDisposition, attempts_made: u32, max_attempts: u32) -> bool {
    disposition.is_retryable() && attempts_made < max_attempts
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::routing::RouteError;

    #[test]
    fn only_provider_unavailable_is_retryable() {
        assert_eq!(
            RetryDisposition::classify_deepseek(&DeepSeekError::ProviderUnavailable("503".into())),
            RetryDisposition::Retryable
        );
        // Everything else is Terminal — retrying cannot fix it. (All non-transient
        // variants pinned, incl. Core and the new client-4xx/429 ClientError —
        // exhaustive coverage of the mapping.)
        for terminal in [
            DeepSeekError::CredentialMissing,
            DeepSeekError::Auth(401),
            // Terminal client errors: malformed/not-found 4xx AND 429 rate-limit (no
            // backoff ⇒ terminal, not a hammering retry).
            DeepSeekError::ClientError { status: 400 },
            DeepSeekError::ClientError { status: 422 },
            DeepSeekError::ClientError { status: 429 },
            DeepSeekError::BadResponse("garbage".into()),
            DeepSeekError::NoModels,
            DeepSeekError::Core(friday_core::CoreError::BlockedTransfer("x".into())),
        ] {
            assert_eq!(
                RetryDisposition::classify_deepseek(&terminal),
                RetryDisposition::Terminal,
                "{terminal:?} must be terminal"
            );
        }
        // And a transient 5xx-style ProviderUnavailable IS retryable (boundary partner
        // to the 4xx terminal cases above).
        assert_eq!(
            RetryDisposition::classify_deepseek(&DeepSeekError::ProviderUnavailable(
                "HTTP 503".into()
            )),
            RetryDisposition::Retryable
        );
    }

    #[test]
    fn routed_errors_are_all_terminal_no_fallback() {
        // The no-fallback path: a requested-but-unavailable provider is surfaced,
        // NEVER retried into a different provider.
        assert_eq!(
            RetryDisposition::classify_routed(&RoutedLoopError::Route(
                RouteError::RequestedProviderUnavailable("codex".into())
            )),
            RetryDisposition::Terminal
        );
        assert_eq!(
            RetryDisposition::classify_routed(&RoutedLoopError::Route(RouteError::EmptyRegistry)),
            RetryDisposition::Terminal
        );
        assert_eq!(
            RetryDisposition::classify_routed(&RoutedLoopError::NoClientForProvider(
                "deepseek".into()
            )),
            RetryDisposition::Terminal
        );
        // The remaining two variants pinned too (no-route selection + Hub-internal storage).
        assert_eq!(
            RetryDisposition::classify_routed(&RoutedLoopError::Route(
                RouteError::NoEligibleRoute {
                    required_capabilities: vec![],
                    model_size: None,
                }
            )),
            RetryDisposition::Terminal
        );
        assert_eq!(
            RetryDisposition::classify_routed(&RoutedLoopError::Storage(
                friday_storage::StorageError::Unsupported("x".into())
            )),
            RetryDisposition::Terminal
        );
    }

    #[test]
    fn should_retry_is_bounded_and_terminal_never_retries() {
        // Retryable: retried only under the cap.
        assert!(should_retry(RetryDisposition::Retryable, 0, 3));
        assert!(should_retry(RetryDisposition::Retryable, 2, 3));
        assert!(!should_retry(RetryDisposition::Retryable, 3, 3)); // bounded
        assert!(!should_retry(RetryDisposition::Retryable, 9, 3));
        // max_attempts == 0 ⇒ never retry.
        assert!(!should_retry(RetryDisposition::Retryable, 0, 0));
        // Terminal: never retried, at any attempt count.
        assert!(!should_retry(RetryDisposition::Terminal, 0, 3));
        assert!(!should_retry(RetryDisposition::Terminal, 1, 99));
    }
}
