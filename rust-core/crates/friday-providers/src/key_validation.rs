//! R7 — provider key-validation abstraction (the call-free seam + typed result).
//!
//! ## The gap this closes (and how it differs from `detect`)
//! [`crate::detect`] / [`crate::CliProbe`] answer a LOCAL question: does the
//! provider CLI report itself logged-in? That is NOT proof the credential actually
//! works against the provider — a stale/revoked token, a wrong key, or an account
//! with no quota can all still read "logged in" locally. R7 adds the orthogonal
//! LIVE signal: a minimal authenticated round-trip to the provider that confirms
//! the credential is accepted. The roadmap states it plainly: this is "distinct
//! from CLI reports logged-in."
//!
//! ## Taxonomy: this is a DIFFERENT provider notion than the CLI [`crate::Provider`]
//! The CLI providers are `{Codex, Claude}` (local CLI logins). The credentials that
//! have a live HTTP key-validation path are `{DeepSeek, Anthropic}` — the
//! secret-bearing Hub route keys (`FRIDAY_DEEPSEEK_API_KEY` /
//! `FRIDAY_ANTHROPIC_API_KEY`). These sets barely intersect:
//! - `Codex` has a CLI login but NO HTTP client → no key-validation path exists.
//! - `DeepSeek` has an HTTP key but is not a CLI provider → no `detect`.
//! - `Claude` (CLI subscription login) and `Anthropic` (API key) are DISTINCT
//!   credentials and must never be collapsed into one "Claude ready" verdict.
//!
//! So key-validation has its own [`KeyProvider`] enum (the API-key identity), kept
//! separate from [`crate::Provider`] (the CLI identity). The composite
//! capability-doctor (in `friday-hub`) reports BOTH signals side-by-side,
//! truth-labeled, never merged.
//!
//! ## Where the abstraction lives vs the real impl
//! This crate is the CLI-control crate: its own contract is "runs ONLY each
//! provider's read-only status command — never a prompt/send — so no model call
//! occurs and nothing is charged." A live key-validation round-trip would BREAK
//! that contract, so this module ships ONLY the call-free seam: the
//! [`KeyValidationProbe`] trait + the provider-agnostic typed [`KeyValidationOutcome`]
//! + a [`MockKeyValidationProbe`] for tests. The REAL, secret-bearing,
//! quota-touching impl (driving `friday-anthropic`/`friday-deepseek`) lives in
//! `friday-hub`, where provider secrets already live — mirroring how R6's
//! `ProviderDoctor` lives in the hub and composes this crate's `detect`.
//!
//! ## No-fallback / truth-labeled (Friday invariant `04` §2/§4.5)
//! A failed validation is an EXPLICIT typed [`KeyValidationOutcome`] — never
//! substituted by a different provider's key, never silently treated as valid. The
//! outcome partitions transient failures from a genuinely-bad credential: a `5xx` /
//! `429` / network error is [`KeyValidationOutcome::Unavailable`] (the key may be
//! fine; we could not tell), and ONLY an auth rejection is
//! [`KeyValidationOutcome::Invalid`]. Reporting a transient error as a bad key would
//! be a dishonesty bug, so the mapping guards against it.
//!
//! ## Secret hygiene
//! [`KeyValidationOutcome`] carries NO key, NO request/response body, and NO account
//! identifier — at most a coarse HTTP status code (a useful, non-secret label). The
//! real impl maps the already-coarse `ClaudeError`/`DeepSeekError` (status-code only)
//! into these variants, so no body/secret can reach the outcome.

/// The credential identity for live key-validation — the secret-bearing Hub route
/// keys. DISTINCT from the CLI [`crate::Provider`] (`Codex`/`Claude`): these are the
/// providers that have an actual HTTP client + API key to validate.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum KeyProvider {
    /// DeepSeek route key (`FRIDAY_DEEPSEEK_API_KEY`). Validated by an authenticated
    /// `GET /models` — spends NO completion quota.
    DeepSeek,
    /// Anthropic/Claude API route key (`FRIDAY_ANTHROPIC_API_KEY`). Validated by a
    /// minimal `POST /v1/messages` (`max_tokens=1`) — spends a tiny amount of quota.
    /// NOTE: this is a DIFFERENT credential than the `claude` CLI login that
    /// [`crate::detect`] checks for [`crate::Provider::Claude`].
    Anthropic,
}

impl KeyProvider {
    /// Stable, secret-safe label.
    pub fn as_str(&self) -> &'static str {
        match self {
            KeyProvider::DeepSeek => "deepseek",
            KeyProvider::Anthropic => "anthropic",
        }
    }

    /// The Hub-only environment variable that holds this provider's API key.
    /// (The value is never read here — this is only the var NAME, for evidence.)
    pub fn env_key(&self) -> &'static str {
        match self {
            KeyProvider::DeepSeek => "FRIDAY_DEEPSEEK_API_KEY",
            KeyProvider::Anthropic => "FRIDAY_ANTHROPIC_API_KEY",
        }
    }

    /// The canonical, ordered set of every credential that has a key-validation
    /// path. The composite capability-doctor iterates this. Order is stable
    /// (`deepseek`, `anthropic`) so a doctor result is deterministic.
    pub fn all() -> &'static [KeyProvider] {
        &[KeyProvider::DeepSeek, KeyProvider::Anthropic]
    }
}

/// The typed result of a live key-validation round-trip. No-fallback + truth-labeled:
/// every distinct real-world state is its OWN variant, and a transient failure is
/// NEVER conflated with a bad credential.
///
/// Secret-safe: carries only an `Invalid`/`Unavailable` HTTP status code at most —
/// never the key, the request, or the response body.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum KeyValidationOutcome {
    /// The credential was ACCEPTED by the provider (authenticated round-trip
    /// succeeded). The key works.
    Valid,
    /// The credential was REJECTED by the provider (HTTP 401/403). The key is bad —
    /// a genuine, terminal validation failure (carries the coarse status code).
    Invalid { status: u16 },
    /// The credential env var is unset / empty. Distinct from `Invalid`: there is no
    /// key to validate (a setup blocker, never a fallback to another provider).
    CredentialMissing,
    /// Could NOT determine validity: a TRANSIENT failure (server 5xx / 408 / 529,
    /// rate-limit 429, or a network/transport error). The key may well be fine — we
    /// simply could not tell. This MUST NEVER be reported as `Invalid` (that would
    /// dishonestly brand a good key bad on a server hiccup). `detail` is a coarse,
    /// secret-free label (e.g. `"HTTP 503"` / `"transport"`).
    Unavailable { detail: &'static str },
}

impl KeyValidationOutcome {
    /// True ONLY for [`KeyValidationOutcome::Valid`]. An `Unavailable` is NOT valid
    /// (we could not confirm) and NOT invalid (we did not see a rejection) — callers
    /// must read the variant, not coerce to a bool. This helper exists only for the
    /// narrow "is this credential confirmed usable" question.
    pub fn is_confirmed_valid(&self) -> bool {
        matches!(self, KeyValidationOutcome::Valid)
    }

    /// A stable, secret-safe label for the outcome (for reports / evidence). Carries
    /// the coarse status / detail where present, never a body or key.
    pub fn label(&self) -> &'static str {
        match self {
            KeyValidationOutcome::Valid => "valid",
            KeyValidationOutcome::Invalid { .. } => "invalid",
            KeyValidationOutcome::CredentialMissing => "credential_missing",
            KeyValidationOutcome::Unavailable { .. } => "unavailable",
        }
    }
}

/// The call-free seam for a live key-validation round-trip. The REAL impl lives in
/// `friday-hub` (it is secret-bearing + makes a network call); tests inject
/// [`MockKeyValidationProbe`] so the result-shaping / no-fallback / secret-safety
/// logic is provable here WITHOUT a network call or any quota spend.
///
/// This is a NEW trait, distinct from [`crate::ProviderProbe`] (which returns CLI
/// `ProbeOutput` for a LOCAL status check). A key-validation probe answers the LIVE
/// question and returns a typed [`KeyValidationOutcome`].
pub trait KeyValidationProbe {
    /// Validate the given provider's credential via a minimal live round-trip.
    /// Returns a typed outcome; NEVER substitutes another provider, NEVER returns a
    /// fabricated `Valid`.
    fn validate(&self, provider: KeyProvider) -> KeyValidationOutcome;
}

/// A canned key-validation probe for tests: returns a preset outcome per provider
/// (or [`KeyValidationOutcome::CredentialMissing`] for an unset one). Makes ZERO
/// network calls, so the composite-report composition + no-fallback logic is
/// provable without spending quota.
#[derive(Debug, Default, Clone)]
pub struct MockKeyValidationProbe {
    deepseek: Option<KeyValidationOutcome>,
    anthropic: Option<KeyValidationOutcome>,
}

impl MockKeyValidationProbe {
    pub fn new() -> Self {
        Self::default()
    }

    /// Preset the outcome a given provider will report.
    pub fn with(mut self, provider: KeyProvider, outcome: KeyValidationOutcome) -> Self {
        match provider {
            KeyProvider::DeepSeek => self.deepseek = Some(outcome),
            KeyProvider::Anthropic => self.anthropic = Some(outcome),
        }
        self
    }
}

impl KeyValidationProbe for MockKeyValidationProbe {
    fn validate(&self, provider: KeyProvider) -> KeyValidationOutcome {
        // An UNSET provider reports CredentialMissing — never a fallback to another
        // provider's preset outcome.
        match provider {
            KeyProvider::DeepSeek => self.deepseek,
            KeyProvider::Anthropic => self.anthropic,
        }
        .unwrap_or(KeyValidationOutcome::CredentialMissing)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn key_provider_all_is_stable_complete_and_labeled() {
        assert_eq!(
            KeyProvider::all(),
            &[KeyProvider::DeepSeek, KeyProvider::Anthropic]
        );
        assert_eq!(KeyProvider::DeepSeek.as_str(), "deepseek");
        assert_eq!(KeyProvider::Anthropic.as_str(), "anthropic");
        assert_eq!(KeyProvider::DeepSeek.env_key(), "FRIDAY_DEEPSEEK_API_KEY");
        assert_eq!(KeyProvider::Anthropic.env_key(), "FRIDAY_ANTHROPIC_API_KEY");
        // Every variant the match in `as_str` knows about is present in `all()`.
        for p in [KeyProvider::DeepSeek, KeyProvider::Anthropic] {
            assert!(KeyProvider::all().contains(&p));
        }
    }

    #[test]
    fn is_confirmed_valid_is_true_only_for_valid_never_for_unavailable() {
        // The honesty core: only Valid is "confirmed usable". Unavailable is NEITHER
        // valid NOR invalid — it must NOT coerce to valid (that would pass a key we
        // could not confirm).
        assert!(KeyValidationOutcome::Valid.is_confirmed_valid());
        assert!(!KeyValidationOutcome::Invalid { status: 401 }.is_confirmed_valid());
        assert!(!KeyValidationOutcome::CredentialMissing.is_confirmed_valid());
        assert!(!KeyValidationOutcome::Unavailable { detail: "HTTP 503" }.is_confirmed_valid());
    }

    #[test]
    fn labels_are_coarse_and_carry_no_secret() {
        assert_eq!(KeyValidationOutcome::Valid.label(), "valid");
        assert_eq!(
            KeyValidationOutcome::Invalid { status: 403 }.label(),
            "invalid"
        );
        assert_eq!(
            KeyValidationOutcome::CredentialMissing.label(),
            "credential_missing"
        );
        assert_eq!(
            KeyValidationOutcome::Unavailable {
                detail: "transport"
            }
            .label(),
            "unavailable"
        );
    }

    #[test]
    fn mock_returns_preset_per_provider_and_missing_for_unset_no_fallback() {
        // DeepSeek preset Valid, Anthropic UNSET. Validating anthropic must report
        // CredentialMissing — NEVER fall back to deepseek's Valid.
        let probe =
            MockKeyValidationProbe::new().with(KeyProvider::DeepSeek, KeyValidationOutcome::Valid);
        assert_eq!(
            probe.validate(KeyProvider::DeepSeek),
            KeyValidationOutcome::Valid
        );
        assert_eq!(
            probe.validate(KeyProvider::Anthropic),
            KeyValidationOutcome::CredentialMissing,
            "an unset provider must NOT inherit another provider's Valid"
        );
    }
}
