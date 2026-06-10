//! Codex/Claude provider adapters — Hub-only provider control surfaces.
//!
//! This is the first required provider capability: detect whether each provider
//! CLI is installed and authenticated. It runs ONLY each provider's official,
//! read-only **status** command (`codex login status`, `claude auth status`) —
//! never a prompt/send — so **no model call** occurs and nothing is charged.
//! Provider credentials live in the CLIs' own Hub-side config; this crate reads
//! only boolean auth signals and never surfaces account email/org/tokens.
//!
//! Scope: auth-readiness detection, Codex app-server contract plumbing, and
//! Claude control-surface truth labels. Live model turns and post-login Friday
//! smoke consume the account and remain separately gated. No fallback: a failed
//! or absent provider is truth-labeled, never substituted.
//!
//! Hub-only: must stay OUT of `friday-ffi`'s (phone) dependency graph
//! (asserted by `friday-arch-tests`).

use std::process::Command;
use thiserror::Error;

pub mod claude_control;
pub mod codex_appserver;
/// R7 — the call-free key-validation seam: the [`key_validation::KeyValidationProbe`]
/// trait + provider-agnostic typed [`key_validation::KeyValidationOutcome`] +
/// a mock. The LIVE round-trip impl lives in `friday-hub` (secret-bearing); this
/// crate keeps its "no model call, nothing charged" contract intact.
pub mod key_validation;
pub mod session;
pub mod unified;
pub use key_validation::{
    KeyProvider, KeyValidationOutcome, KeyValidationProbe, MockKeyValidationProbe,
};
pub use session::{send_to_provider, CliSession, MockSession, SessionOutcome, SessionRunner};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Provider {
    Codex,
    Claude,
}

impl Provider {
    pub fn as_str(&self) -> &'static str {
        match self {
            Provider::Codex => "codex",
            Provider::Claude => "claude",
        }
    }

    /// The canonical, ordered set of every provider Friday can detect. The
    /// onboarding capability-doctor iterates this so a newly-added provider is
    /// detected automatically (no second hand-maintained list to drift). Order is
    /// stable (`codex`, `claude`) so a doctor result is deterministic.
    pub fn all() -> &'static [Provider] {
        &[Provider::Codex, Provider::Claude]
    }
}

#[derive(Debug, Error)]
pub enum ProviderError {
    #[error("provider CLI not found or not runnable: {0}")]
    NotInstalled(String),

    /// A send was requested for a provider that is not authenticated. Refused —
    /// never silently routed to a different provider (no fallback, `04` §2/§4.5).
    #[error("provider {0} is not authenticated; refusing to send (no fallback)")]
    NotAuthenticated(&'static str),

    /// The provider CLI ran but exited non-zero. Carries only the provider label
    /// and exit code — never the CLI's stdout/stderr (which may hold account info).
    #[error("provider {provider} send failed (exit code {code:?})")]
    SendFailed {
        provider: &'static str,
        code: Option<i32>,
    },

    /// The provider CLI did not finish within the send timeout and was killed.
    #[error("provider {provider} send timed out after {secs}s")]
    Timeout { provider: &'static str, secs: u64 },
}

/// Output of a provider's read-only status command.
///
/// Secret hygiene: `stdout`/`stderr` hold the CLI's RAW status output, which can
/// include account identifiers (e.g. claude's `authMethod`/`subscriptionType`).
/// Callers must NOT surface these raw fields in logs/evidence/UI — go through
/// [`parse_status`], whose [`ProviderAuthStatus`] carries only booleans + a
/// coarse, secret-safe label.
#[derive(Debug, Clone)]
pub struct ProbeOutput {
    pub stdout: String,
    pub stderr: String,
}

/// Runs a provider's read-only auth-status command. Real impl is [`CliProbe`];
/// tests inject a mock so parsing/no-fallback logic is provable without the CLIs.
pub trait ProviderProbe {
    fn status(&self, provider: Provider) -> Result<ProbeOutput, ProviderError>;
}

/// Real probe: invokes each CLI's official read-only status subcommand by
/// ABSOLUTE path (so PATH shadowing can't pick a wrong/broken binary). It runs
/// ONLY a status command — never a prompt/send — so no model call occurs.
pub struct CliProbe {
    pub codex_bin: String,
    pub claude_bin: String,
}

impl Default for CliProbe {
    fn default() -> Self {
        let home = std::env::var("HOME").unwrap_or_default();
        CliProbe {
            codex_bin: format!("{home}/.local/bin/codex"),
            claude_bin: format!("{home}/.local/bin/claude"),
        }
    }
}

impl CliProbe {
    fn run(bin: &str, args: &[&str]) -> Result<ProbeOutput, ProviderError> {
        match Command::new(bin).args(args).output() {
            Ok(out) => Ok(ProbeOutput {
                stdout: String::from_utf8_lossy(&out.stdout).to_string(),
                stderr: String::from_utf8_lossy(&out.stderr).to_string(),
            }),
            Err(e) => Err(ProviderError::NotInstalled(format!("{bin}: {e}"))),
        }
    }
}

impl ProviderProbe for CliProbe {
    fn status(&self, provider: Provider) -> Result<ProbeOutput, ProviderError> {
        match provider {
            Provider::Codex => Self::run(&self.codex_bin, &["login", "status"]),
            Provider::Claude => Self::run(&self.claude_bin, &["auth", "status"]),
        }
    }
}

/// Auth-readiness for a provider. Carries booleans + a coarse, secret-safe label
/// only — never account email/org/tokens.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProviderAuthStatus {
    pub provider: Provider,
    pub installed: bool,
    pub authenticated: bool,
    /// `"logged_in" | "not_logged_in" | "not_installed"`.
    pub detail: &'static str,
}

/// Parse a provider's status output into auth-readiness. Reads only boolean
/// signals; does NOT surface account identifiers.
pub fn parse_status(
    provider: Provider,
    probe: Result<ProbeOutput, ProviderError>,
) -> ProviderAuthStatus {
    match probe {
        Err(_) => ProviderAuthStatus {
            provider,
            installed: false,
            authenticated: false,
            detail: "not_installed",
        },
        Ok(out) => {
            // Some CLIs print auth status to stderr (codex) and some to stdout
            // (claude `auth status` JSON), so consider BOTH streams.
            let hay = format!("{}\n{}", out.stdout, out.stderr).to_lowercase();
            let authenticated = match provider {
                // codex: "Logged in using ChatGPT" (guard against "Not logged in").
                Provider::Codex => hay.contains("logged in") && !hay.contains("not logged in"),
                // claude `auth status`: JSON `"loggedIn": true`.
                Provider::Claude => {
                    hay.contains("\"loggedin\": true") || hay.contains("loggedin: true")
                }
            };
            ProviderAuthStatus {
                provider,
                installed: true,
                authenticated,
                detail: if authenticated {
                    "logged_in"
                } else {
                    "not_logged_in"
                },
            }
        }
    }
}

/// Detect a provider's auth readiness (installed + authenticated) via the probe.
pub fn detect<P: ProviderProbe>(probe: &P, provider: Provider) -> ProviderAuthStatus {
    parse_status(provider, probe.status(provider))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

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
        fn set_streams(mut self, p: Provider, stdout: &str, stderr: &str) -> Self {
            self.out.insert(
                p.as_str(),
                Ok(ProbeOutput {
                    stdout: stdout.to_string(),
                    stderr: stderr.to_string(),
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
    fn codex_logged_in_detected() {
        let p = MockProbe::new().set(Provider::Codex, "Logged in using ChatGPT");
        let s = detect(&p, Provider::Codex);
        assert!(s.installed && s.authenticated);
        assert_eq!(s.detail, "logged_in");
    }

    #[test]
    fn codex_logged_in_on_stderr_detected() {
        // codex prints "Logged in using ChatGPT" to STDERR (stdout empty) — the
        // parser must consider both streams (regression guard for the live bug).
        let p = MockProbe::new().set_streams(Provider::Codex, "", "Logged in using ChatGPT");
        let s = detect(&p, Provider::Codex);
        assert!(s.installed && s.authenticated);
        assert_eq!(s.detail, "logged_in");
    }

    #[test]
    fn codex_not_logged_in_detected() {
        let p = MockProbe::new().set(Provider::Codex, "Not logged in");
        let s = detect(&p, Provider::Codex);
        assert!(s.installed && !s.authenticated);
        assert_eq!(s.detail, "not_logged_in");
    }

    #[test]
    fn claude_logged_in_detected() {
        let p = MockProbe::new().set(
            Provider::Claude,
            "{\n  \"loggedIn\": true,\n  \"authMethod\": \"claude.ai\"\n}",
        );
        let s = detect(&p, Provider::Claude);
        assert!(s.installed && s.authenticated);
    }

    #[test]
    fn claude_not_logged_in_detected() {
        let p = MockProbe::new().set(Provider::Claude, "{\n  \"loggedIn\": false\n}");
        let s = detect(&p, Provider::Claude);
        assert!(s.installed && !s.authenticated);
    }

    #[test]
    fn missing_cli_is_not_installed_never_a_fallback() {
        let p = MockProbe::new().set_missing(Provider::Codex);
        let s = detect(&p, Provider::Codex);
        assert!(!s.installed && !s.authenticated);
        assert_eq!(s.detail, "not_installed");
    }

    #[test]
    fn provider_all_enumerates_every_provider_in_stable_order() {
        // The onboarding capability-doctor iterates `Provider::all()`; its order is
        // stable + complete (every Provider variant appears exactly once). If a new
        // provider variant is added without extending `all()`, this catches it.
        assert_eq!(Provider::all(), &[Provider::Codex, Provider::Claude]);
        // Every variant the match in `as_str` knows about is present in `all()`.
        for p in [Provider::Codex, Provider::Claude] {
            assert!(
                Provider::all().contains(&p),
                "{} missing from Provider::all()",
                p.as_str()
            );
        }
    }
}
