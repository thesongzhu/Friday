//! R7 — composite capability-doctor (the `capabilities.doctor` aggregate). DARK.
//!
//! ## What this composes (and the taxonomy reality)
//! R6's [`crate::provider_doctor::ProviderDoctor`] answers the LOCAL onboarding
//! question (does each CLI report logged-in?) over the CLI providers
//! `{Codex, Claude}`. R7 adds the orthogonal LIVE signal — does each API credential
//! actually work? — over the key providers `{DeepSeek, Anthropic}`. This module
//! composes BOTH into one truth-labeled readiness report, as TWO clearly-separate
//! per-provider sections.
//!
//! The two signals do NOT line up one-to-one (the taxonomy is genuinely different),
//! so they are kept as DISTINCT sections rather than fused per provider:
//! - `Codex` has a CLI login but NO HTTP key-validation path → it appears ONLY in the
//!   CLI-detect section (no synthesized key verdict — there is nothing to validate).
//! - `DeepSeek` / `OpenAI` have API keys but are NOT CLI providers → they appear
//!   ONLY in the key-validation section (no CLI-detect signal).
//! - `Claude` (CLI subscription login) and `Anthropic` (API key) are DISTINCT
//!   credentials. They are reported SEPARATELY — the CLI signal in the CLI-detect
//!   section, the key signal in the key-validation section — and are NEVER folded into
//!   one "Claude ready" verdict (that would be a false collapse).
//!
//! ## No-fallback / no opaque collapse (Friday invariant `04` §2/§4.5)
//! Every signal is carried VERBATIM and labeled with WHICH provider it belongs to. A
//! down/absent provider is surfaced as its own honest state, NEVER substituted by a
//! ready one and NEVER hidden inside a single aggregate bool. The within-taxonomy
//! readiness helpers ([`CapabilityDoctor::cli_logged_in`] /
//! [`CapabilityDoctor::confirmed_valid_keys`]) are DERIVED from the per-provider truth
//! and never hide which signal is down — and a transient `Unavailable` key-validation
//! is NOT counted as a confirmed valid key (you cannot route to a credential you could
//! not confirm). There is deliberately NO cross-taxonomy aggregate bool: the two enums
//! are disjoint, so any AND/OR across them would mis-state readiness (a no-key-needed
//! CLI provider like Codex would be under-reported). Callers read each section.
//!
//! ## DARK — built ready, NOT routed (library-only)
//! Registers NO production route, is NOT in [`crate::capability`]'s route table, does
//! NOT flip the live TS `capabilities.doctor`/`providers.validate`/`providers.doctor`
//! paths. Unlike R6's `hub_providers_detect` bin, this composite has NO entrypoint bin
//! — it is library-only, reachable today only by future Rust callers + its unit tests.
//! Generic over both probes so production injects the real
//! [`friday_providers::CliProbe`] + [`crate::provider_key_validation::LiveKeyValidationProbe`]
//! and tests inject mocks through the IDENTICAL path. Confers no v1 GO.
//!
//! ## Secret hygiene
//! Carries ONLY the secret-safe parsed [`friday_providers::ProviderAuthStatus`]
//! fields + the coarse [`friday_providers::KeyValidationOutcome`] (status code / static
//! label at most). It never touches a raw CLI `ProbeOutput`, request, response body,
//! or key.

use friday_providers::{
    detect, KeyProvider, KeyValidationProbe, Provider, ProviderAuthStatus, ProviderProbe,
};

/// The per-credential live key-validation signal in the composite report. Distinct
/// from a CLI-detect status: it answers "does the API credential actually work?".
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct KeyValidationSignal {
    /// Which API credential this signal is about (`deepseek` / `anthropic`).
    pub provider: KeyProvider,
    /// The typed live-validation outcome (valid / invalid / missing / unavailable).
    pub outcome: friday_providers::KeyValidationOutcome,
}

/// The composite `capabilities.doctor` result: the R6 CLI-detect statuses PLUS the
/// R7 per-credential live key-validation signals, as TWO separate sections — composed
/// without collapse.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CapabilityDoctor {
    /// Per-CLI-provider local auth-readiness (`codex`, `claude`), in `Provider::all()`
    /// order — the R6 `detect` signal, carried verbatim.
    pub cli_statuses: Vec<ProviderAuthStatus>,
    /// Per-API-credential live key-validation signals (`deepseek`, `anthropic`), in
    /// `KeyProvider::all()` order — the R7 signal. Standalone, since these credentials
    /// are not CLI providers and share no identity with the CLI section.
    pub key_signals: Vec<KeyValidationSignal>,
}

impl CapabilityDoctor {
    /// Run the composite doctor over the canonical full sets (`Provider::all()` for
    /// CLI detect + `KeyProvider::all()` for key-validation) — the onboarding
    /// default. Generic over both probes so production injects the real probes and
    /// tests inject mocks through the identical path.
    pub fn run<P: ProviderProbe + ?Sized, K: KeyValidationProbe + ?Sized>(
        cli_probe: &P,
        key_probe: &K,
    ) -> Self {
        let cli_statuses = Provider::all()
            .iter()
            .map(|&p| detect(cli_probe, p))
            .collect();

        let key_signals = KeyProvider::all()
            .iter()
            .map(|&kp| KeyValidationSignal {
                provider: kp,
                outcome: key_probe.validate(kp),
            })
            .collect();

        Self {
            cli_statuses,
            key_signals,
        }
    }

    /// Look up one CLI provider's auth-readiness, if it was probed.
    pub fn cli_status_for(&self, provider: Provider) -> Option<&ProviderAuthStatus> {
        self.cli_statuses.iter().find(|s| s.provider == provider)
    }

    /// Look up one API credential's key-validation signal, if it was probed.
    pub fn key_signal_for(&self, provider: KeyProvider) -> Option<&KeyValidationSignal> {
        self.key_signals.iter().find(|s| s.provider == provider)
    }

    /// The CLI providers whose CLI reports logged-in. Truth-labeled: a provider
    /// absent here is genuinely not CLI-authenticated (its full status stays in
    /// [`Self::cli_statuses`]); never substituted.
    pub fn cli_logged_in(&self) -> Vec<Provider> {
        self.cli_statuses
            .iter()
            .filter(|s| s.authenticated)
            .map(|s| s.provider)
            .collect()
    }

    /// The API credentials CONFIRMED valid by a live round-trip — ONLY
    /// [`friday_providers::KeyValidationOutcome::Valid`]. An `Unavailable`
    /// (could-not-confirm) is NOT counted: you cannot route to a credential you could
    /// not confirm. Truth-labeled: a credential absent here is not confirmed-valid (its
    /// exact outcome stays in [`Self::key_signals`]); never substituted.
    pub fn confirmed_valid_keys(&self) -> Vec<KeyProvider> {
        self.key_signals
            .iter()
            .filter(|s| s.outcome.is_confirmed_valid())
            .map(|s| s.provider)
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use friday_providers::{
        KeyValidationOutcome, MockKeyValidationProbe, ProbeOutput, ProviderError,
    };
    use std::collections::HashMap;

    /// CLI probe mock (mirrors the R6 doctor's mock).
    struct MockCliProbe {
        out: HashMap<&'static str, Result<ProbeOutput, ()>>,
    }
    impl MockCliProbe {
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
    impl ProviderProbe for MockCliProbe {
        fn status(&self, provider: Provider) -> Result<ProbeOutput, ProviderError> {
            match self.out.get(provider.as_str()) {
                Some(Ok(o)) => Ok(o.clone()),
                _ => Err(ProviderError::NotInstalled("mock".into())),
            }
        }
    }

    #[test]
    fn composite_covers_both_taxonomies_in_canonical_order_no_collapse() {
        // CLI: codex logged-in, claude logged-out. Keys: deepseek valid, anthropic
        // invalid, openai valid. The composite must carry BOTH sets, each per-provider, side by
        // side — never merging claude-CLI with anthropic-key.
        let cli = MockCliProbe::new()
            .set(Provider::Codex, "Logged in using ChatGPT")
            .set(Provider::Claude, "{\n  \"loggedIn\": false\n}");
        let keys = MockKeyValidationProbe::new()
            .with(KeyProvider::DeepSeek, KeyValidationOutcome::Valid)
            .with(
                KeyProvider::Anthropic,
                KeyValidationOutcome::Invalid { status: 401 },
            )
            .with(KeyProvider::OpenAi, KeyValidationOutcome::Valid);

        let doc = CapabilityDoctor::run(&cli, &keys);

        // CLI section: 2 providers in Provider::all() order, carried verbatim.
        assert_eq!(doc.cli_statuses.len(), 2);
        assert_eq!(doc.cli_statuses[0].provider, Provider::Codex);
        assert!(doc.cli_statuses[0].authenticated);
        assert_eq!(doc.cli_statuses[1].provider, Provider::Claude);
        assert!(!doc.cli_statuses[1].authenticated);

        // Key section: 3 credentials in KeyProvider::all() order, each its own outcome.
        assert_eq!(doc.key_signals.len(), 3);
        assert_eq!(doc.key_signals[0].provider, KeyProvider::DeepSeek);
        assert_eq!(doc.key_signals[0].outcome, KeyValidationOutcome::Valid);
        assert_eq!(doc.key_signals[1].provider, KeyProvider::Anthropic);
        assert_eq!(
            doc.key_signals[1].outcome,
            KeyValidationOutcome::Invalid { status: 401 }
        );
        assert_eq!(doc.key_signals[2].provider, KeyProvider::OpenAi);
        assert_eq!(doc.key_signals[2].outcome, KeyValidationOutcome::Valid);
        assert_eq!(
            doc.confirmed_valid_keys(),
            vec![KeyProvider::DeepSeek, KeyProvider::OpenAi]
        );
    }

    #[test]
    fn claude_cli_and_anthropic_key_are_reported_separately_never_merged() {
        // The false-collapse guard: claude CLI logged-IN but the anthropic API key is
        // INVALID. A naive "Claude ready" bool would hide one of these. The composite
        // keeps them distinct: claude CLI shows authenticated, anthropic key shows
        // Invalid — and there is NO single field that merges them.
        let cli = MockCliProbe::new()
            .set(Provider::Codex, "Not logged in")
            .set(Provider::Claude, "{\n  \"loggedIn\": true\n}");
        let keys = MockKeyValidationProbe::new()
            .with(KeyProvider::DeepSeek, KeyValidationOutcome::Valid)
            .with(
                KeyProvider::Anthropic,
                KeyValidationOutcome::Invalid { status: 403 },
            );
        let doc = CapabilityDoctor::run(&cli, &keys);

        let claude_cli = doc.cli_status_for(Provider::Claude).unwrap();
        assert!(claude_cli.authenticated, "claude CLI is logged in");

        let anthropic_key = doc.key_signal_for(KeyProvider::Anthropic).unwrap();
        assert_eq!(
            anthropic_key.outcome,
            KeyValidationOutcome::Invalid { status: 403 },
            "the anthropic API key is independently INVALID — not hidden by the CLI login"
        );
    }

    #[test]
    fn unavailable_key_is_not_counted_as_confirmed_valid() {
        // THE honesty core at the aggregate level: a transient Unavailable must NOT be
        // counted as a confirmed-valid key. deepseek Unavailable + anthropic Valid →
        // only anthropic is confirmed valid.
        let cli = MockCliProbe::new()
            .set(Provider::Codex, "Logged in using ChatGPT")
            .set(Provider::Claude, "{\n  \"loggedIn\": false\n}");
        let keys = MockKeyValidationProbe::new()
            .with(
                KeyProvider::DeepSeek,
                KeyValidationOutcome::Unavailable { detail: "HTTP 503" },
            )
            .with(KeyProvider::Anthropic, KeyValidationOutcome::Valid);
        let doc = CapabilityDoctor::run(&cli, &keys);

        assert_eq!(
            doc.confirmed_valid_keys(),
            vec![KeyProvider::Anthropic],
            "an Unavailable deepseek must NOT count as confirmed valid"
        );
        // But its exact outcome is still queryable (truth preserved, never dropped).
        assert_eq!(
            doc.key_signal_for(KeyProvider::DeepSeek).unwrap().outcome,
            KeyValidationOutcome::Unavailable { detail: "HTTP 503" }
        );
    }

    #[test]
    fn cli_login_alone_needs_no_key_and_a_valid_key_alone_needs_no_cli() {
        // The within-taxonomy aggregates are independent and honest: a CLI provider
        // that needs no API key (codex) reads logged-in on the CLI axis regardless of
        // any key state; and a valid key reads confirmed-valid regardless of any CLI
        // login. There is deliberately NO cross-taxonomy bool that would AND these and
        // thereby under-report a usable-but-single-axis provider.
        let cli = MockCliProbe::new()
            .set(Provider::Codex, "Logged in using ChatGPT")
            .set_missing(Provider::Claude);
        // No keys valid (deepseek unavailable, anthropic unset).
        let keys = MockKeyValidationProbe::new().with(
            KeyProvider::DeepSeek,
            KeyValidationOutcome::Unavailable {
                detail: "transport",
            },
        );
        let doc = CapabilityDoctor::run(&cli, &keys);

        // codex is logged in on the CLI axis even though NO key is confirmed valid.
        assert_eq!(doc.cli_logged_in(), vec![Provider::Codex]);
        assert!(doc.confirmed_valid_keys().is_empty());

        // Mirror: a valid key with no CLI login reads confirmed-valid on the key axis.
        let cli_none = MockCliProbe::new()
            .set_missing(Provider::Codex)
            .set(Provider::Claude, "{\n  \"loggedIn\": false\n}");
        let keys_ok =
            MockKeyValidationProbe::new().with(KeyProvider::DeepSeek, KeyValidationOutcome::Valid);
        let doc2 = CapabilityDoctor::run(&cli_none, &keys_ok);
        assert!(doc2.cli_logged_in().is_empty());
        assert_eq!(doc2.confirmed_valid_keys(), vec![KeyProvider::DeepSeek]);
    }

    #[test]
    fn fully_logged_out_and_no_keys_is_honest_not_ready() {
        // Everything down: no CLI login, both keys missing. The doctor must read NOT
        // ready everywhere — never a fabricated ready.
        let cli = MockCliProbe::new()
            .set_missing(Provider::Codex)
            .set(Provider::Claude, "{\n  \"loggedIn\": false\n}");
        let keys = MockKeyValidationProbe::new(); // both unset → CredentialMissing
        let doc = CapabilityDoctor::run(&cli, &keys);

        assert!(doc.cli_logged_in().is_empty());
        assert!(doc.confirmed_valid_keys().is_empty());
        // Truth-labeled: each absent key is CredentialMissing (distinct from Invalid).
        for kp in KeyProvider::all() {
            assert_eq!(
                doc.key_signal_for(*kp).unwrap().outcome,
                KeyValidationOutcome::CredentialMissing
            );
        }
        // And codex is not_installed, claude is not_logged_in (distinct, never folded).
        assert_eq!(
            doc.cli_status_for(Provider::Codex).unwrap().detail,
            "not_installed"
        );
        assert_eq!(
            doc.cli_status_for(Provider::Claude).unwrap().detail,
            "not_logged_in"
        );
    }
}
