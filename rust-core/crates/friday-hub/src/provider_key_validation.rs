//! R7 — the LIVE provider key-validation impl (Hub-only, secret-bearing). DARK.
//!
//! This is the real, network-touching side of the call-free
//! [`friday_providers::key_validation`] seam. It lives in `friday-hub` (not
//! `friday-providers`) for two reasons:
//! 1. `friday-providers`' own contract is "runs ONLY each provider's read-only
//!    status command — never a prompt/send — so no model call occurs and nothing is
//!    charged." A live round-trip would break that. The Hub is where provider
//!    secrets already live (it depends on `friday-anthropic`/`friday-deepseek`,
//!    asserted by `friday-arch-tests` to stay off the phone).
//! 2. It mirrors R6: `ProviderDoctor` lives in the Hub and composes
//!    `friday_providers::detect`; the key-validation impl is the symmetric Hub-side
//!    real impl of a `friday-providers` seam.
//!
//! ## What "validate" means per provider (and the quota asymmetry)
//! - **DeepSeek** — an authenticated `GET /models` ([`friday_deepseek::DeepSeekClient::discover_models`]).
//!   Authenticated but spends NO completion quota — the ideal validation: 401/403 ⇒
//!   bad key, 200 ⇒ key works.
//! - **Anthropic/Claude** — a minimal `POST /v1/messages` with `max_tokens=1`
//!   ([`friday_anthropic::ClaudeClient::chat`]). Anthropic has no `/models` discovery
//!   in-crate, so this spends a tiny amount of quota (~one or two tokens). Documented
//!   in the live harness run-doc.
//! - **OpenAI** — an authenticated `GET /v1/models` against `OPENAI_API_KEY` (or
//!   `FRIDAY_OPENAI_API_KEY`) and `E2E_OPENAI_BASE_URL`/`https://api.openai.com`.
//!   Authenticated but spends no completion quota.
//!
//! ## No-fallback + honesty mapping (the core of this module)
//! The mapping deliberately partitions a genuinely-bad credential from a transient
//! failure — a `5xx`/`429`/network error MUST NEVER read as `Invalid` (that would
//! brand a good key bad on a server hiccup):
//! - `Ok(_)` ⇒ [`KeyValidationOutcome::Valid`]
//! - `Auth(401|403)` ⇒ [`KeyValidationOutcome::Invalid`] (the ONLY bad-key path)
//! - `CredentialMissing` ⇒ [`KeyValidationOutcome::CredentialMissing`]
//! - `ProviderUnavailable` (5xx/408/529/transport), `ClientError` (4xx incl. 429
//!   rate-limit), `BadResponse`, `NoModels` ⇒ [`KeyValidationOutcome::Unavailable`]
//!   (could-not-confirm; the key may be fine).
//!
//! The mapping is exposed as PURE functions ([`map_deepseek_result`] /
//! [`map_claude_result`]) so every arm is unit-tested WITHOUT a network call or any
//! quota spend. The network side ([`LiveKeyValidationProbe::validate`]) is exercised
//! ONLY by the `#[ignore]`'d live harness.
//!
//! ## DARK — built ready, NOT routed
//! Registers NO production route, is NOT in [`crate::capability`]'s route table, and
//! does NOT flip the live TS `providers.validate` path. Reachable today only by
//! future Rust callers + the composite [`crate::capability_doctor`] + the ignored
//! live harness. Confers no v1 GO.
//!
//! ## Secret hygiene
//! The provider errors are already coarse (status code only — never the key, the
//! request, or the response body; see each crate's `map_ureq_err`). The mapping
//! carries through ONLY a coarse status code / static detail, so no secret can reach
//! a [`KeyValidationOutcome`].

use friday_anthropic::{ClaudeClient, ClaudeError, DEFAULT_MODEL as CLAUDE_DEFAULT_MODEL};
use friday_deepseek::{DeepSeekClient, DeepSeekError};
use friday_providers::{KeyProvider, KeyValidationOutcome, KeyValidationProbe};

const OPENAI_ENV_KEY: &str = "OPENAI_API_KEY";
const FRIDAY_OPENAI_ENV_KEY: &str = "FRIDAY_OPENAI_API_KEY";
const OPENAI_BASE_URL_ENV_KEY: &str = "E2E_OPENAI_BASE_URL";
const DEFAULT_OPENAI_BASE_URL: &str = "https://api.openai.com";

fn read_env_non_empty(key: &str) -> Option<String> {
    std::env::var(key)
        .ok()
        .filter(|value| !value.trim().is_empty())
}

/// Map a DeepSeek `discover_models` result into a typed key-validation outcome.
/// PURE (no network) so every arm is unit-tested directly.
///
/// Only `Auth` is `Invalid`. A `ClientError` (incl. 429), `ProviderUnavailable`,
/// `BadResponse`, `NoModels`, or `Core` error is `Unavailable` — we authenticated
/// or could-not-tell, but did NOT see a credential rejection, so we must not brand
/// the key bad.
pub fn map_deepseek_result<T>(result: Result<T, DeepSeekError>) -> KeyValidationOutcome {
    match result {
        Ok(_) => KeyValidationOutcome::Valid,
        Err(DeepSeekError::Auth(status)) => KeyValidationOutcome::Invalid { status },
        Err(DeepSeekError::CredentialMissing) => KeyValidationOutcome::CredentialMissing,
        // 429 means we AUTHENTICATED and got rate-limited — never a bad-key signal.
        Err(DeepSeekError::ClientError { status: 429 }) => KeyValidationOutcome::Unavailable {
            detail: "rate_limited",
        },
        Err(DeepSeekError::ClientError { .. }) => KeyValidationOutcome::Unavailable {
            detail: "client_error",
        },
        Err(DeepSeekError::ProviderUnavailable(_)) => KeyValidationOutcome::Unavailable {
            detail: "provider_unavailable",
        },
        Err(DeepSeekError::BadResponse(_)) => KeyValidationOutcome::Unavailable {
            detail: "bad_response",
        },
        Err(DeepSeekError::NoModels) => KeyValidationOutcome::Unavailable {
            detail: "no_models",
        },
        Err(DeepSeekError::Core(_)) => KeyValidationOutcome::Unavailable {
            detail: "internal_error",
        },
    }
}

/// Map an Anthropic `chat` result into a typed key-validation outcome. PURE (no
/// network). Same partition as DeepSeek: only `Auth` is `Invalid`.
pub fn map_claude_result<T>(result: Result<T, ClaudeError>) -> KeyValidationOutcome {
    match result {
        Ok(_) => KeyValidationOutcome::Valid,
        Err(ClaudeError::Auth(status)) => KeyValidationOutcome::Invalid { status },
        Err(ClaudeError::CredentialMissing) => KeyValidationOutcome::CredentialMissing,
        Err(ClaudeError::ClientError { status: 429 }) => KeyValidationOutcome::Unavailable {
            detail: "rate_limited",
        },
        Err(ClaudeError::ClientError { .. }) => KeyValidationOutcome::Unavailable {
            detail: "client_error",
        },
        Err(ClaudeError::ProviderUnavailable(_)) => KeyValidationOutcome::Unavailable {
            detail: "provider_unavailable",
        },
        Err(ClaudeError::BadResponse(_)) => KeyValidationOutcome::Unavailable {
            detail: "bad_response",
        },
    }
}

/// Map an OpenAI-compatible `/v1/models` HTTP status into a typed
/// key-validation outcome. PURE (no network): only 401/403 are a bad key, 429 and
/// 5xx/408 are unavailable, and other client errors are not confirmed.
pub fn map_openai_status(status: Result<u16, &'static str>) -> KeyValidationOutcome {
    match status {
        Ok(code) if (200..=299).contains(&code) => KeyValidationOutcome::Valid,
        Ok(code @ (401 | 403)) => KeyValidationOutcome::Invalid { status: code },
        Ok(429) => KeyValidationOutcome::Unavailable {
            detail: "rate_limited",
        },
        Ok(408) => KeyValidationOutcome::Unavailable {
            detail: "provider_unavailable",
        },
        Ok(code) if (500..=599).contains(&code) => KeyValidationOutcome::Unavailable {
            detail: "provider_unavailable",
        },
        Ok(_) => KeyValidationOutcome::Unavailable {
            detail: "client_error",
        },
        Err(detail) => KeyValidationOutcome::Unavailable { detail },
    }
}

/// The real, secret-bearing key-validation probe. Constructs the provider client
/// `from_env` (FAILS CLOSED to [`KeyValidationOutcome::CredentialMissing`] if the
/// key is absent — never a fallback) and runs ONE minimal authenticated round-trip,
/// mapping the typed provider error into a [`KeyValidationOutcome`].
///
/// DARK: not registered as a route; reachable only by explicit Rust callers + the
/// ignored live harness. The only methods that touch the network are the per-provider
/// `validate` arms; constructing the probe makes ZERO calls.
#[derive(Debug, Default, Clone, Copy)]
pub struct LiveKeyValidationProbe;

impl LiveKeyValidationProbe {
    pub fn new() -> Self {
        LiveKeyValidationProbe
    }

    /// Validate DeepSeek via an authenticated `GET /models` (no completion quota).
    fn validate_deepseek(&self) -> KeyValidationOutcome {
        match DeepSeekClient::from_env() {
            Err(e) => map_deepseek_result::<()>(Err(e)),
            Ok(client) => map_deepseek_result(client.discover_models()),
        }
    }

    /// Validate Anthropic via a minimal `POST /v1/messages` (`max_tokens=1`). Spends
    /// a tiny amount of quota (Anthropic has no in-crate `/models` discovery).
    fn validate_anthropic(&self) -> KeyValidationOutcome {
        match ClaudeClient::from_env() {
            Err(e) => map_claude_result::<()>(Err(e)),
            Ok(client) => {
                // Minimal validation prompt; max_tokens=1 keeps the spend ~nil. We
                // care only about WHETHER the key was accepted, not the reply text.
                map_claude_result(client.chat(CLAUDE_DEFAULT_MODEL, "ping", 1))
            }
        }
    }

    /// Validate OpenAI via an authenticated `GET /v1/models` (no completion quota).
    fn validate_openai(&self) -> KeyValidationOutcome {
        let Some(api_key) = read_env_non_empty(OPENAI_ENV_KEY)
            .or_else(|| read_env_non_empty(FRIDAY_OPENAI_ENV_KEY))
        else {
            return KeyValidationOutcome::CredentialMissing;
        };
        let base_url = read_env_non_empty(OPENAI_BASE_URL_ENV_KEY)
            .unwrap_or_else(|| DEFAULT_OPENAI_BASE_URL.to_string());
        let url = format!("{}/v1/models", base_url.trim_end_matches('/'));
        let result = ureq::AgentBuilder::new()
            .timeout(std::time::Duration::from_secs(30))
            .build()
            .get(&url)
            .set("Authorization", &format!("Bearer {api_key}"))
            .call();
        match result {
            Ok(response) => map_openai_status(Ok(response.status())),
            Err(ureq::Error::Status(code, _)) => map_openai_status(Ok(code)),
            Err(ureq::Error::Transport(_)) => map_openai_status(Err("transport")),
        }
    }
}

impl KeyValidationProbe for LiveKeyValidationProbe {
    fn validate(&self, provider: KeyProvider) -> KeyValidationOutcome {
        match provider {
            KeyProvider::DeepSeek => self.validate_deepseek(),
            KeyProvider::Anthropic => self.validate_anthropic(),
            KeyProvider::OpenAi => self.validate_openai(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // ---- DeepSeek mapping: every arm, no network ----

    #[test]
    fn deepseek_ok_is_valid() {
        assert_eq!(
            map_deepseek_result(Ok(vec!["m".to_string()])),
            KeyValidationOutcome::Valid
        );
    }

    #[test]
    fn deepseek_auth_is_invalid_with_status() {
        assert_eq!(
            map_deepseek_result::<()>(Err(DeepSeekError::Auth(401))),
            KeyValidationOutcome::Invalid { status: 401 }
        );
        assert_eq!(
            map_deepseek_result::<()>(Err(DeepSeekError::Auth(403))),
            KeyValidationOutcome::Invalid { status: 403 }
        );
    }

    #[test]
    fn deepseek_credential_missing_maps_through() {
        assert_eq!(
            map_deepseek_result::<()>(Err(DeepSeekError::CredentialMissing)),
            KeyValidationOutcome::CredentialMissing
        );
    }

    #[test]
    fn deepseek_transient_failures_are_unavailable_never_invalid() {
        // THE honesty guard: a 5xx / 408 / 529 / transport (ProviderUnavailable), a
        // 429 rate-limit, a non-auth 4xx, a bad response, no-models, AND an internal
        // Core error are ALL Unavailable — never Invalid. A good key must NOT be
        // branded bad on a server hiccup, a rate-limit (a rate-limit means we DID
        // authenticate), or an internal error (which says nothing about the key).
        for (err, expect_detail) in [
            (
                DeepSeekError::ProviderUnavailable("HTTP 503".into()),
                "provider_unavailable",
            ),
            (DeepSeekError::ClientError { status: 429 }, "rate_limited"),
            (DeepSeekError::ClientError { status: 400 }, "client_error"),
            (DeepSeekError::ClientError { status: 404 }, "client_error"),
            (DeepSeekError::BadResponse("x".into()), "bad_response"),
            (DeepSeekError::NoModels, "no_models"),
            // An internal Core error is NOT a credential rejection: it must map to
            // Unavailable("internal_error"), never Invalid. Locks the safe direction
            // so a future `Core => Invalid` edit (dishonestly branding a good key bad
            // on an internal error) turns this test RED.
            (
                DeepSeekError::Core(friday_core::CoreError::InvalidLedger("x".into())),
                "internal_error",
            ),
        ] {
            let outcome = map_deepseek_result::<()>(Err(err));
            assert_eq!(
                outcome,
                KeyValidationOutcome::Unavailable {
                    detail: expect_detail
                },
            );
            assert!(
                !matches!(outcome, KeyValidationOutcome::Invalid { .. }),
                "transient/non-auth must NEVER be Invalid"
            );
        }
    }

    // ---- Anthropic mapping: every arm, no network ----

    #[test]
    fn claude_ok_is_valid() {
        assert_eq!(map_claude_result(Ok(())), KeyValidationOutcome::Valid);
    }

    #[test]
    fn claude_auth_is_invalid_with_status() {
        assert_eq!(
            map_claude_result::<()>(Err(ClaudeError::Auth(401))),
            KeyValidationOutcome::Invalid { status: 401 }
        );
        // Symmetry with DeepSeek: ClaudeError::Auth covers both 401 and 403 (per the
        // enum doc, "HTTP 401/403"), and 403 is likewise a credential rejection ⇒
        // Invalid — never Unavailable.
        assert_eq!(
            map_claude_result::<()>(Err(ClaudeError::Auth(403))),
            KeyValidationOutcome::Invalid { status: 403 }
        );
    }

    #[test]
    fn claude_credential_missing_maps_through() {
        assert_eq!(
            map_claude_result::<()>(Err(ClaudeError::CredentialMissing)),
            KeyValidationOutcome::CredentialMissing
        );
    }

    #[test]
    fn claude_transient_failures_are_unavailable_never_invalid() {
        for (err, expect_detail) in [
            (
                ClaudeError::ProviderUnavailable("HTTP 529".into()),
                "provider_unavailable",
            ),
            (ClaudeError::ClientError { status: 429 }, "rate_limited"),
            (ClaudeError::ClientError { status: 400 }, "client_error"),
            (ClaudeError::BadResponse("x".into()), "bad_response"),
        ] {
            let outcome = map_claude_result::<()>(Err(err));
            assert_eq!(
                outcome,
                KeyValidationOutcome::Unavailable {
                    detail: expect_detail
                },
            );
            assert!(!matches!(outcome, KeyValidationOutcome::Invalid { .. }));
        }
    }

    // ---- secret-safety leak-lens on the outcome shape ----

    #[test]
    fn outcome_debug_renders_carry_no_body_or_secret_markers() {
        // The mapping consumes ALREADY-coarse provider errors (status code only) and
        // carries through only a status / static detail. Even when the SOURCE error
        // carried a (here, synthetic) detail string, the outcome's Debug must hold no
        // body/secret marker — only the coarse status / static label.
        let from_unavailable = map_deepseek_result::<()>(Err(DeepSeekError::ProviderUnavailable(
            "SECRET-BODY-LEAK".into(),
        )));
        let from_bad =
            map_claude_result::<()>(Err(ClaudeError::BadResponse("Bearer sk-SECRET-KEY".into())));
        for outcome in [from_unavailable, from_bad] {
            let rendered = format!("{outcome:?}");
            for forbidden in ["SECRET-BODY-LEAK", "SECRET-KEY", "Bearer", "sk-"] {
                assert!(
                    !rendered.contains(forbidden),
                    "outcome render leaked {forbidden}: {rendered}"
                );
            }
        }
        // Positive control: an Invalid DOES carry the coarse status code (a useful,
        // non-secret label).
        let invalid = map_deepseek_result::<()>(Err(DeepSeekError::Auth(401)));
        assert!(format!("{invalid:?}").contains("401"));
    }

    #[test]
    fn live_probe_construction_is_call_free() {
        // Constructing the probe makes ZERO network calls (no from_env, no request).
        // Only validate() touches the network — proven structurally: this builds a
        // probe and never calls validate.
        let _probe = LiveKeyValidationProbe::new();
        let _probe2 = LiveKeyValidationProbe;
    }

    #[test]
    fn openai_status_mapping_partitions_auth_from_transient_without_network() {
        assert_eq!(map_openai_status(Ok(200)), KeyValidationOutcome::Valid);
        assert_eq!(
            map_openai_status(Ok(401)),
            KeyValidationOutcome::Invalid { status: 401 }
        );
        assert_eq!(
            map_openai_status(Ok(403)),
            KeyValidationOutcome::Invalid { status: 403 }
        );
        for (status, detail) in [
            (408, "provider_unavailable"),
            (429, "rate_limited"),
            (500, "provider_unavailable"),
            (503, "provider_unavailable"),
            (400, "client_error"),
            (404, "client_error"),
        ] {
            let outcome = map_openai_status(Ok(status));
            assert_eq!(outcome, KeyValidationOutcome::Unavailable { detail });
            assert!(
                !matches!(outcome, KeyValidationOutcome::Invalid { .. }),
                "non-auth OpenAI status must never be branded Invalid"
            );
        }
        assert_eq!(
            map_openai_status(Err("transport")),
            KeyValidationOutcome::Unavailable {
                detail: "transport"
            }
        );
    }
}
