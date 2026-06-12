//! R6 — onboarding provider capability-doctor (the hub-library aggregate).
//!
//! ## Why this module exists (the R6 gap)
//! The single-provider [`crate::provider_auth`] (a thin generic wrapper over
//! [`friday_providers::detect`]) and the `hub_providers_detect` proof bin both
//! already RUN the real detect engine — that part of the substrate was already
//! complete. What was MISSING was a **hub-library** aggregate entrypoint: the
//! multi-provider orchestration + onboarding-readiness verdict was INLINED inside
//! the bin's private `render_detect`, callable by nothing else. That asymmetry is
//! the diagnostics analog: `diagnostics.rs` has a library
//! [`crate::diagnostics::DiagnosticsSnapshot::collect`] and a thin
//! `diagnostics_snapshot` bin over it; detect had only the bin.
//!
//! This module lifts that aggregate to the library — [`ProviderDoctor::run`] —
//! mirroring `DiagnosticsSnapshot::collect`: it is generic over the
//! [`friday_providers::ProviderProbe`] so production ships a real
//! [`friday_providers::CliProbe`] and tests inject a mock through the IDENTICAL
//! path, and it composes the EXISTING parsed [`friday_providers::ProviderAuthStatus`]
//! statuses (it adds NO new probing, NO model call, NO network beyond the CLI's own
//! local auth check that `detect` already performs).
//!
//! ## DARK — built ready, NOT routed (no production-path flip)
//! This is the Rust-owned replacement for the (now-503) `providers/detect`
//! onboarding surface, built ready-but-not-wired. It registers NO production route,
//! is NOT added to [`crate::capability`]'s route table, and does NOT flip the live
//! TS `providers.detect` path (which stays the production onboarding surface). It is
//! reachable today only by the `hub_providers_detect` proof bin (which now delegates
//! here) and by future Rust callers; it confers no v1 GO.
//!
//! ## No-fallback / truth-labeled (Friday invariant `04` §2/§4.5)
//! Every provider is reported with its OWN truth-labeled status — a failed/absent
//! provider is surfaced as `not_installed`/`not_logged_in`, NEVER substituted by a
//! different provider and NEVER collapsed into a single opaque `ready` bool that
//! would hide which provider is down. The onboarding verdict carries the per-provider
//! detail plus aggregate readiness signals ([`ProviderDoctor::ready_providers`],
//! [`ProviderDoctor::any_authenticated`], [`ProviderDoctor::all_authenticated`]) so a
//! caller can both list what is usable and see exactly what is not.
//!
//! ## Secret hygiene
//! Carries ONLY the secret-safe [`friday_providers::ProviderAuthStatus`] fields
//! (provider label, `installed`/`authenticated` booleans, coarse static `detail`).
//! It NEVER touches the raw [`friday_providers::ProbeOutput`] (CLI stdout/stderr,
//! which can hold `authMethod`/`subscriptionType`/account ids) — `detect` discards
//! that before this aggregate ever sees a status.

use friday_providers::{detect, Provider, ProviderAuthStatus, ProviderProbe};

/// The onboarding capability-doctor result: every requested provider's
/// truth-labeled auth-readiness, composed into one aggregate. Mirrors the role of
/// [`crate::diagnostics::DiagnosticsSnapshot`] for the providers surface.
///
/// No-fallback: each provider's status is carried verbatim (per-provider truth);
/// the aggregate readiness helpers are DERIVED from those statuses and never hide
/// which provider is down.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ProviderDoctor {
    /// Per-provider truth-labeled auth-readiness, in the order requested. Each entry
    /// carries booleans + a coarse static `detail`; never an account identifier.
    pub statuses: Vec<ProviderAuthStatus>,
}

impl ProviderDoctor {
    /// Run the capability-doctor over the canonical full provider set
    /// ([`Provider::all`]) — the onboarding default. Generic over the probe so
    /// production ships [`friday_providers::CliProbe`] and tests inject a mock
    /// through the identical path.
    pub fn run<P: ProviderProbe + ?Sized>(probe: &P) -> Self {
        Self::run_for(probe, Provider::all())
    }

    /// Run the capability-doctor over an EXPLICIT provider selection (e.g. the bin's
    /// `--probe codex|claude|both`). Composes the existing parsed
    /// [`friday_providers::ProviderAuthStatus`] for each — no new probing beyond the
    /// `detect` the substrate already performs, no model call, no fallback.
    pub fn run_for<P: ProviderProbe + ?Sized>(probe: &P, providers: &[Provider]) -> Self {
        let statuses = providers.iter().map(|&p| detect(probe, p)).collect();
        Self { statuses }
    }

    /// The providers that are installed AND authenticated — i.e. usable right now.
    /// Truth-labeled: a provider absent from this list is genuinely not ready (its
    /// full status, with the exact `detail`, is still in [`Self::statuses`]); it is
    /// never substituted by a ready one.
    pub fn ready_providers(&self) -> Vec<Provider> {
        self.statuses
            .iter()
            .filter(|s| s.authenticated)
            .map(|s| s.provider)
            .collect()
    }

    /// True iff AT LEAST ONE requested provider is authenticated — the onboarding
    /// gate's minimum "you can use Friday with a provider" signal. This does NOT
    /// say WHICH (callers read [`Self::ready_providers`] / [`Self::statuses`] for
    /// per-provider truth); it never implies a fallback between providers.
    pub fn any_authenticated(&self) -> bool {
        self.statuses.iter().any(|s| s.authenticated)
    }

    /// True iff EVERY requested provider is authenticated (and at least one was
    /// requested). The stricter onboarding signal for a multi-provider setup.
    pub fn all_authenticated(&self) -> bool {
        !self.statuses.is_empty() && self.statuses.iter().all(|s| s.authenticated)
    }

    /// Look up one provider's truth-labeled status in this doctor result, if it was
    /// among the requested set.
    pub fn status_for(&self, provider: Provider) -> Option<&ProviderAuthStatus> {
        self.statuses.iter().find(|s| s.provider == provider)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use friday_providers::{ProbeOutput, ProviderError};
    use std::collections::HashMap;

    /// A mock probe returning canned raw CLI output (or a missing-CLI error) so the
    /// doctor's detect-aggregate path is provable without the CLIs and without
    /// spending quota. Crucially it can return raw stdout laden with account fields
    /// to prove the aggregate (via `detect`/`parse_status`) carries only the safe
    /// parsed surface.
    struct MockProbe {
        out: HashMap<&'static str, Result<ProbeOutput, ()>>,
    }
    impl MockProbe {
        fn new() -> Self {
            Self {
                out: HashMap::new(),
            }
        }
        fn set(mut self, p: Provider, stdout: &str) -> Self {
            self.out.insert(
                p.as_str(),
                Ok(ProbeOutput {
                    stdout: stdout.to_string(),
                    stderr: String::new(),
                }),
            );
            self
        }
        fn set_missing(mut self, p: Provider) -> Self {
            self.out.insert(p.as_str(), Err(()));
            self
        }
    }
    impl ProviderProbe for MockProbe {
        fn status(&self, provider: Provider) -> Result<ProbeOutput, ProviderError> {
            match self.out.get(provider.as_str()) {
                Some(Ok(o)) => Ok(o.clone()),
                _ => Err(ProviderError::NotInstalled("mock".into())),
            }
        }
    }

    #[test]
    fn run_covers_every_provider_in_canonical_order() {
        // The onboarding default (`run`) detects EVERY provider in `Provider::all()`
        // order — so a doctor result is complete + deterministic.
        let probe = MockProbe::new()
            .set(Provider::Codex, "Logged in using ChatGPT")
            .set(Provider::Claude, "{\n  \"loggedIn\": false\n}");
        let doc = ProviderDoctor::run(&probe);
        let order: Vec<_> = doc.statuses.iter().map(|s| s.provider).collect();
        assert_eq!(order, vec![Provider::Codex, Provider::Claude]);
    }

    #[test]
    fn run_for_respects_the_explicit_selection_and_order() {
        // The bin's `--probe claude` path: only the requested provider is detected.
        let probe = MockProbe::new().set(Provider::Claude, "{\n  \"loggedIn\": true\n}");
        let doc = ProviderDoctor::run_for(&probe, &[Provider::Claude]);
        assert_eq!(doc.statuses.len(), 1);
        assert_eq!(doc.statuses[0].provider, Provider::Claude);
        assert!(doc.statuses[0].authenticated);
    }

    #[test]
    fn aggregate_readiness_is_derived_per_provider_no_fallback() {
        // Codex authenticated, Claude NOT. The aggregate must report codex ready and
        // claude NOT-ready (its full status preserved) — never substitute claude with
        // codex, never collapse to one opaque bool that hides the down provider.
        let probe = MockProbe::new()
            .set(Provider::Codex, "Logged in using ChatGPT")
            .set(Provider::Claude, "{\n  \"loggedIn\": false\n}");
        let doc = ProviderDoctor::run(&probe);

        assert_eq!(doc.ready_providers(), vec![Provider::Codex]);
        assert!(doc.any_authenticated(), "one provider is ready");
        assert!(
            !doc.all_authenticated(),
            "claude is down, so NOT all authenticated"
        );

        // Per-provider truth is preserved — claude's exact not-ready status is still
        // queryable, never overwritten by codex's ready status.
        let claude = doc
            .status_for(Provider::Claude)
            .expect("claude was requested");
        assert!(claude.installed);
        assert!(!claude.authenticated);
        assert_eq!(claude.detail, "not_logged_in");
        let codex = doc
            .status_for(Provider::Codex)
            .expect("codex was requested");
        assert!(codex.authenticated);
        assert_eq!(codex.detail, "logged_in");
    }

    #[test]
    fn no_provider_authenticated_is_an_honest_not_ready_not_a_fabricated_ready() {
        // Both providers logged out (one missing, one present-but-logged-out): the
        // onboarding gate must read NOT ready — never a fabricated ready.
        let probe = MockProbe::new()
            .set_missing(Provider::Codex)
            .set(Provider::Claude, "{\n  \"loggedIn\": false\n}");
        let doc = ProviderDoctor::run(&probe);

        assert!(doc.ready_providers().is_empty());
        assert!(!doc.any_authenticated(), "nothing is ready (honest false)");
        assert!(!doc.all_authenticated());

        // Truth-labeled: the missing CLI is `not_installed`, the logged-out one is
        // `not_logged_in` — distinct, never a fallback.
        assert_eq!(
            doc.status_for(Provider::Codex).unwrap().detail,
            "not_installed"
        );
        assert_eq!(
            doc.status_for(Provider::Claude).unwrap().detail,
            "not_logged_in"
        );
    }

    #[test]
    fn all_authenticated_requires_a_non_empty_selection() {
        // Vacuous-truth guard: an EMPTY selection must NOT read as `all_authenticated`
        // (that would be a fabricated ready over zero providers).
        let probe = MockProbe::new();
        let doc = ProviderDoctor::run_for(&probe, &[]);
        assert!(doc.statuses.is_empty());
        assert!(
            !doc.all_authenticated(),
            "empty set is not all-authenticated"
        );
        assert!(!doc.any_authenticated());
    }

    #[test]
    fn aggregate_carries_only_safe_parsed_fields_never_raw_account_ids() {
        // Even when the mock returns raw stdout laden with account identifiers,
        // `detect`/`parse_status` discard the raw ProbeOutput before the aggregate
        // ever sees it — the doctor's statuses carry only booleans + a static label.
        let probe = MockProbe::new().set(
            Provider::Claude,
            "{\n  \"loggedIn\": true,\n  \"authMethod\": \"claude.ai\",\n  \"subscriptionType\": \"max\",\n  \"email\": \"someone@example.com\"\n}",
        );
        let doc = ProviderDoctor::run_for(&probe, &[Provider::Claude]);
        let s = &doc.statuses[0];
        // The safe surface reports authenticated=true via the parsed label...
        assert!(s.authenticated);
        assert_eq!(s.detail, "logged_in");
        // ...and the Debug rendering (the only string projection of a status) carries
        // none of the raw account identifiers (ProviderAuthStatus has no field for
        // them — this is a belt-and-suspenders check on the type's shape).
        let dbg = format!("{s:?}");
        assert!(!dbg.contains("authMethod"));
        assert!(!dbg.contains("subscriptionType"));
        assert!(!dbg.contains("example.com"));
    }
}
