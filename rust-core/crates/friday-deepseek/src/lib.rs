//! friday-deepseek — the DeepSeek Friday-provider route (Hub-only, secret-bearing).
//!
//! This is Friday's mandatory live model/token path (`15` §4, gate `21` §6). The
//! route:
//! 1. reads `FRIDAY_DEEPSEEK_API_KEY` from the environment — **on the Hub only**
//!    (the locked source is `/private/tmp/friday-closure-20260530/.deepseek-env`,
//!    sourced per-command; the value is never printed/logged/committed);
//! 2. discovers models at runtime via `GET /models` (no hardcoded stale model);
//! 3. calls `POST /chat/completions`;
//! 4. maps usage into a `friday_core::LedgerEntry` with **`fallback = false`**.
//!
//! **No fallback.** A failed route is a [`DeepSeekError`] (`ProviderUnavailable`/
//! `Auth`/…) — never a silent substitute provider, local model, or mock
//! (`15` §4, `01` §1). The only call-making methods are [`DeepSeekClient::discover_models`]
//! and [`DeepSeekClient::chat`]; everything else is pure and makes no network call.
//!
//! Trust boundary: this crate is provider-secret-bearing and must stay OUT of
//! `friday-ffi`'s dependency graph (asserted by `friday-arch-tests`).
//!
//! Scope honesty: this unit proves at the *library* level that only an explicit
//! ask triggers a model call. The full app/Hub lifecycle no-hidden-call sweep
//! (open-Friday / tab-switch / reconnect / status-poll → zero calls) and the
//! `10` §4 token-safety gate require the Hub/app loop and are deferred to
//! Units 4/5 — NOT claimed closed here.

use friday_core::{LedgerEntry, ProviderKind};
use serde_json::{json, Value};
use thiserror::Error;

pub const BASE_URL: &str = "https://api.deepseek.com";
pub const BASE_URL_HOST: &str = "api.deepseek.com";
pub const PROVIDER: ProviderKind = ProviderKind::DeepSeek;
/// Hub-only environment variable holding the DeepSeek API key.
pub const ENV_KEY: &str = "FRIDAY_DEEPSEEK_API_KEY";

#[derive(Debug, Error)]
pub enum DeepSeekError {
    /// Env var unset/empty. Adverse path: surfaces as a blocker, never a fallback.
    #[error("DeepSeek credential missing or empty (env {ENV_KEY})")]
    CredentialMissing,
    /// Authentication rejected (HTTP 401/403). Never a fallback.
    #[error("DeepSeek authentication failed (HTTP {0})")]
    Auth(u16),
    /// Route unavailable (network error, 5xx, rate limit, …). Never a fallback.
    #[error("DeepSeek provider unavailable: {0}")]
    ProviderUnavailable(String),
    /// Response did not match the documented shape.
    #[error("DeepSeek response shape unexpected: {0}")]
    BadResponse(String),
    /// `/models` returned no usable model ids.
    #[error("DeepSeek model discovery returned no models")]
    NoModels,
    #[error("core error: {0}")]
    Core(#[from] friday_core::CoreError),
}

/// HTTP transport seam. The real impl is [`UreqTransport`]; tests inject a mock
/// so the no-hidden-call and no-fallback logic can be proven without network.
pub trait Transport {
    fn get_json(&self, url: &str, bearer: &str) -> Result<Value, DeepSeekError>;
    fn post_json(&self, url: &str, bearer: &str, body: &Value) -> Result<Value, DeepSeekError>;
}

/// Real blocking HTTP transport (ureq + rustls). Maps errors to controlled
/// [`DeepSeekError`] messages — it never formats the request (which carries the
/// `Authorization` header) into an error string.
pub struct UreqTransport;

impl UreqTransport {
    pub fn new() -> Self {
        UreqTransport
    }
}

impl Default for UreqTransport {
    fn default() -> Self {
        Self::new()
    }
}

fn map_ureq_err(e: ureq::Error) -> DeepSeekError {
    match e {
        ureq::Error::Status(code, _resp) => {
            // Do not read/echo the response body; classify by status only.
            if code == 401 || code == 403 {
                DeepSeekError::Auth(code)
            } else {
                DeepSeekError::ProviderUnavailable(format!("HTTP {code}"))
            }
        }
        // Transport error (DNS/TLS/timeout). Its Display carries host/kind, not
        // our Authorization header, but keep the message terse and controlled.
        ureq::Error::Transport(t) => {
            DeepSeekError::ProviderUnavailable(format!("transport: {}", t.kind()))
        }
    }
}

impl Transport for UreqTransport {
    fn get_json(&self, url: &str, bearer: &str) -> Result<Value, DeepSeekError> {
        let resp = ureq::get(url)
            .set("Authorization", &format!("Bearer {bearer}"))
            .set("Accept", "application/json")
            .call()
            .map_err(map_ureq_err)?;
        resp.into_json::<Value>()
            .map_err(|e| DeepSeekError::BadResponse(format!("invalid JSON: {e}")))
    }

    fn post_json(&self, url: &str, bearer: &str, body: &Value) -> Result<Value, DeepSeekError> {
        let resp = ureq::post(url)
            .set("Authorization", &format!("Bearer {bearer}"))
            .set("Accept", "application/json")
            .send_json(body.clone())
            .map_err(map_ureq_err)?;
        resp.into_json::<Value>()
            .map_err(|e| DeepSeekError::BadResponse(format!("invalid JSON: {e}")))
    }
}

/// One model call's result (the bits Friday ledgers + shows).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ModelCallOutcome {
    /// The model id the response reported (ledger the *reported* model, not the
    /// requested one, to avoid stale-model claims).
    pub model: String,
    pub prompt_tokens: i64,
    pub completion_tokens: i64,
    pub total_tokens: i64,
    pub content: String,
    pub finish_reason: String,
}

impl ModelCallOutcome {
    /// Build a Friday-route ledger entry. `fallback` is hard-wired to `false`
    /// via [`LedgerEntry::friday_route`].
    pub fn to_ledger_entry(
        &self,
        ledger_id: impl Into<String>,
        session_id: impl Into<String>,
        activity_id: impl Into<String>,
        cost_estimate: Option<f64>,
        result_link: Option<String>,
        created_at: i64,
    ) -> Result<LedgerEntry, DeepSeekError> {
        Ok(LedgerEntry::friday_route(
            ledger_id,
            session_id,
            activity_id,
            &self.model,
            self.prompt_tokens,
            self.completion_tokens,
            cost_estimate,
            result_link,
            created_at,
        )?)
    }
}

/// Read the API key from a specific env var (Hub-only). Empty/whitespace = missing.
pub fn api_key_from_env_var(var: &str) -> Result<String, DeepSeekError> {
    match std::env::var(var) {
        Ok(v) if !v.trim().is_empty() => Ok(v),
        _ => Err(DeepSeekError::CredentialMissing),
    }
}

/// Pick a model: prefer `deepseek-v4-flash` when the live list actually contains
/// it, else fall back to the first discovered id. Never invents a model id.
pub fn select_model(available: &[String]) -> Option<String> {
    if available.iter().any(|m| m == "deepseek-v4-flash") {
        Some("deepseek-v4-flash".to_string())
    } else {
        available.first().cloned()
    }
}

pub struct DeepSeekClient<T: Transport> {
    transport: T,
    api_key: String,
}

impl DeepSeekClient<UreqTransport> {
    /// Construct from the Hub environment (`FRIDAY_DEEPSEEK_API_KEY`).
    pub fn from_env() -> Result<Self, DeepSeekError> {
        let api_key = api_key_from_env_var(ENV_KEY)?;
        Ok(DeepSeekClient {
            transport: UreqTransport::new(),
            api_key,
        })
    }
}

impl<T: Transport> DeepSeekClient<T> {
    /// For tests / alternate transports. (`api_key` is never logged.)
    pub fn with_transport(transport: T, api_key: String) -> Self {
        DeepSeekClient { transport, api_key }
    }

    /// `GET /models` — discover available model ids at runtime.
    pub fn discover_models(&self) -> Result<Vec<String>, DeepSeekError> {
        let v = self
            .transport
            .get_json(&format!("{BASE_URL}/models"), &self.api_key)?;
        let data = v
            .get("data")
            .and_then(Value::as_array)
            .ok_or_else(|| DeepSeekError::BadResponse("missing `data` array".into()))?;
        let ids: Vec<String> = data
            .iter()
            .filter_map(|m| m.get("id").and_then(Value::as_str).map(str::to_string))
            .collect();
        if ids.is_empty() {
            return Err(DeepSeekError::NoModels);
        }
        Ok(ids)
    }

    /// `POST /chat/completions` — a single non-streaming completion.
    pub fn chat(
        &self,
        model: &str,
        prompt: &str,
        max_tokens: u32,
    ) -> Result<ModelCallOutcome, DeepSeekError> {
        let body = json!({
            "model": model,
            "messages": [{"role": "user", "content": prompt}],
            "max_tokens": max_tokens,
            "stream": false,
        });
        let v = self.transport.post_json(
            &format!("{BASE_URL}/chat/completions"),
            &self.api_key,
            &body,
        )?;

        let usage = v
            .get("usage")
            .ok_or_else(|| DeepSeekError::BadResponse("missing `usage`".into()))?;
        let prompt_tokens = usage
            .get("prompt_tokens")
            .and_then(Value::as_i64)
            .ok_or_else(|| DeepSeekError::BadResponse("usage.prompt_tokens".into()))?;
        let completion_tokens = usage
            .get("completion_tokens")
            .and_then(Value::as_i64)
            .ok_or_else(|| DeepSeekError::BadResponse("usage.completion_tokens".into()))?;
        // Use the reported total if present; otherwise sum the parts with a CHECKED add.
        // (The eager `unwrap_or(prompt + completion)` form computed the sum even when a
        // total WAS present, panicking on overflow in a checked build for a hostile/buggy
        // `usage`; a malformed provider response must be a clean `BadResponse`, never a
        // panic — every other malformed usage field already is. Reviewer-B audit-10A.)
        let total_tokens = match usage.get("total_tokens").and_then(Value::as_i64) {
            Some(t) => t,
            None => prompt_tokens
                .checked_add(completion_tokens)
                .ok_or_else(|| DeepSeekError::BadResponse("usage token total overflow".into()))?,
        };

        // Ledger the model id the response reports (avoids stale-model claims).
        let reported_model = v
            .get("model")
            .and_then(Value::as_str)
            .unwrap_or(model)
            .to_string();

        let choice0 = v
            .get("choices")
            .and_then(Value::as_array)
            .and_then(|a| a.first());
        let content = choice0
            .and_then(|c| c.get("message"))
            .and_then(|m| m.get("content"))
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        let finish_reason = choice0
            .and_then(|c| c.get("finish_reason"))
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();

        Ok(ModelCallOutcome {
            model: reported_model,
            prompt_tokens,
            completion_tokens,
            total_tokens,
            content,
            finish_reason,
        })
    }

    /// The Friday-provider route: discover → select → chat → build ledger entry
    /// (`fallback = false`). Returns the entry; the caller persists it (the live
    /// test persists it to `friday-storage` to prove the end-to-end path).
    #[allow(clippy::too_many_arguments)]
    pub fn run_friday_ask(
        &self,
        ledger_id: impl Into<String>,
        session_id: impl Into<String>,
        activity_id: impl Into<String>,
        prompt: &str,
        max_tokens: u32,
        created_at: i64,
    ) -> Result<(ModelCallOutcome, LedgerEntry), DeepSeekError> {
        let models = self.discover_models()?;
        let model = select_model(&models).ok_or(DeepSeekError::NoModels)?;
        let outcome = self.chat(&model, prompt, max_tokens)?;
        let entry =
            outcome.to_ledger_entry(ledger_id, session_id, activity_id, None, None, created_at)?;
        Ok((outcome, entry))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;

    /// Mock transport that counts calls and returns canned results. Lets us
    /// prove (offline) the call discipline and no-fallback behavior.
    struct MockTransport {
        get_calls: Cell<u32>,
        post_calls: Cell<u32>,
        get_result: Result<Value, ()>,
        post_result: Result<Value, ()>,
        post_err: Option<DeepSeekErrorKind>,
    }

    #[derive(Clone, Copy)]
    enum DeepSeekErrorKind {
        Auth401,
        Unavailable,
    }

    impl MockTransport {
        fn new(get_result: Result<Value, ()>, post_result: Result<Value, ()>) -> Self {
            MockTransport {
                get_calls: Cell::new(0),
                post_calls: Cell::new(0),
                get_result,
                post_result,
                post_err: None,
            }
        }
        fn with_post_error(mut self, kind: DeepSeekErrorKind) -> Self {
            self.post_err = Some(kind);
            self
        }
    }

    impl Transport for MockTransport {
        fn get_json(&self, _url: &str, _bearer: &str) -> Result<Value, DeepSeekError> {
            self.get_calls.set(self.get_calls.get() + 1);
            self.get_result
                .clone()
                .map_err(|_| DeepSeekError::ProviderUnavailable("mock get error".into()))
        }
        fn post_json(
            &self,
            _url: &str,
            _bearer: &str,
            _body: &Value,
        ) -> Result<Value, DeepSeekError> {
            self.post_calls.set(self.post_calls.get() + 1);
            if let Some(kind) = self.post_err {
                return Err(match kind {
                    DeepSeekErrorKind::Auth401 => DeepSeekError::Auth(401),
                    DeepSeekErrorKind::Unavailable => {
                        DeepSeekError::ProviderUnavailable("HTTP 503".into())
                    }
                });
            }
            self.post_result
                .clone()
                .map_err(|_| DeepSeekError::ProviderUnavailable("mock post error".into()))
        }
    }

    fn models_json() -> Value {
        json!({"object":"list","data":[
            {"id":"deepseek-v4-flash","object":"model","owned_by":"deepseek"},
            {"id":"deepseek-v4-pro","object":"model","owned_by":"deepseek"}
        ]})
    }

    fn chat_json() -> Value {
        json!({
            "id":"chatcmpl-x","object":"chat.completion","created":1,"model":"deepseek-v4-flash",
            "choices":[{"index":0,"message":{"role":"assistant","content":"hi"},"finish_reason":"stop"}],
            "usage":{"prompt_tokens":11,"completion_tokens":8,"total_tokens":19}
        })
    }

    fn client(mock: MockTransport) -> DeepSeekClient<MockTransport> {
        DeepSeekClient::with_transport(mock, "test-key-not-real".to_string())
    }

    #[test]
    fn missing_credential_is_an_error_not_a_fallback() {
        // Use a var name guaranteed unset, regardless of any sourced real key,
        // and without mutating the process-global environment.
        let err =
            api_key_from_env_var("FRIDAY_DEEPSEEK_API_KEY_DEFINITELY_UNSET_a1b2c3").unwrap_err();
        assert!(matches!(err, DeepSeekError::CredentialMissing));
    }

    #[test]
    fn discover_models_parses_ids() {
        let c = client(MockTransport::new(Ok(models_json()), Ok(chat_json())));
        let ids = c.discover_models().unwrap();
        assert_eq!(ids, vec!["deepseek-v4-flash", "deepseek-v4-pro"]);
    }

    #[test]
    fn discover_models_empty_is_no_models() {
        let c = client(MockTransport::new(
            Ok(json!({"object":"list","data":[]})),
            Ok(chat_json()),
        ));
        assert!(matches!(
            c.discover_models().unwrap_err(),
            DeepSeekError::NoModels
        ));
    }

    #[test]
    fn chat_maps_usage_and_reported_model() {
        let c = client(MockTransport::new(Ok(models_json()), Ok(chat_json())));
        let out = c.chat("deepseek-v4-flash", "hello", 64).unwrap();
        assert_eq!(out.model, "deepseek-v4-flash");
        assert_eq!(out.prompt_tokens, 11);
        assert_eq!(out.completion_tokens, 8);
        assert_eq!(out.total_tokens, 19);
        assert_eq!(out.finish_reason, "stop");
    }

    #[test]
    fn chat_overflow_usage_total_is_bad_response_not_panic() {
        // Hostile/buggy usage: parts sum past i64::MAX. With NO reported total, the
        // checked sum must yield BadResponse (never a panic / overflow). Reviewer-B 10A.
        let no_total = json!({
            "model":"deepseek-v4-flash",
            "choices":[{"message":{"content":"x"},"finish_reason":"stop"}],
            "usage":{"prompt_tokens": i64::MAX, "completion_tokens": 1}
        });
        let c = client(MockTransport::new(Ok(models_json()), Ok(no_total)));
        let err = c.chat("deepseek-v4-flash", "hi", 16).unwrap_err();
        assert!(matches!(err, DeepSeekError::BadResponse(_)), "got {err:?}");

        // With a reported total present, the sum is NOT computed (lazy) — no panic even
        // though the parts would overflow; the reported total is used.
        let with_total = json!({
            "model":"deepseek-v4-flash",
            "choices":[{"message":{"content":"x"},"finish_reason":"stop"}],
            "usage":{"prompt_tokens": i64::MAX, "completion_tokens": 1, "total_tokens": 42}
        });
        let c2 = client(MockTransport::new(Ok(models_json()), Ok(with_total)));
        let out = c2.chat("deepseek-v4-flash", "hi", 16).unwrap();
        assert_eq!(out.total_tokens, 42);
    }

    #[test]
    fn outcome_to_ledger_is_fallback_false_and_deepseek() {
        let out = ModelCallOutcome {
            model: "deepseek-v4-flash".into(),
            prompt_tokens: 11,
            completion_tokens: 8,
            total_tokens: 19,
            content: String::new(),
            finish_reason: "length".into(),
        };
        let e = out
            .to_ledger_entry("l1", "s1", "a1", None, None, 100)
            .unwrap();
        assert!(!e.fallback);
        assert_eq!(e.provider_kind.as_str(), "deepseek");
        assert_eq!(e.base_url_host, "api.deepseek.com");
        assert_eq!(e.total_tokens, 19);
    }

    #[test]
    fn select_model_prefers_flash_only_when_present() {
        assert_eq!(
            select_model(&["deepseek-v4-pro".into(), "deepseek-v4-flash".into()]).as_deref(),
            Some("deepseek-v4-flash")
        );
        assert_eq!(
            select_model(&["some-other-model".into()]).as_deref(),
            Some("some-other-model")
        );
        assert_eq!(select_model(&[]), None);
    }

    #[test]
    fn only_explicit_calls_hit_the_transport() {
        // Library-level no-hidden-call proof: constructing the client, selecting
        // a model, and building a ledger entry make ZERO transport calls. Only
        // discover_models()/chat() do. (Full app/Hub lifecycle sweep is Unit 4/5.)
        let c = client(MockTransport::new(Ok(models_json()), Ok(chat_json())));
        let _ = select_model(&["deepseek-v4-flash".into()]);
        let _ = ModelCallOutcome {
            model: "deepseek-v4-flash".into(),
            prompt_tokens: 1,
            completion_tokens: 1,
            total_tokens: 2,
            content: String::new(),
            finish_reason: "stop".into(),
        }
        .to_ledger_entry("l", "s", "a", None, None, 1)
        .unwrap();
        assert_eq!(c.transport.get_calls.get(), 0);
        assert_eq!(c.transport.post_calls.get(), 0);

        // One explicit ask = exactly one GET (discover) + one POST (chat).
        let _ = c.run_friday_ask("l", "s", "a", "hi", 64, 1).unwrap();
        assert_eq!(c.transport.get_calls.get(), 1);
        assert_eq!(c.transport.post_calls.get(), 1);
    }

    #[test]
    fn provider_error_does_not_fallback() {
        // A failed chat returns an error after exactly one POST — there is no
        // second provider/local/mock attempt.
        let c = client(
            MockTransport::new(Ok(models_json()), Ok(chat_json()))
                .with_post_error(DeepSeekErrorKind::Unavailable),
        );
        let err = c.chat("deepseek-v4-flash", "hi", 64).unwrap_err();
        assert!(matches!(err, DeepSeekError::ProviderUnavailable(_)));
        assert_eq!(c.transport.post_calls.get(), 1, "must not retry/fallback");
    }

    #[test]
    fn auth_failure_maps_to_auth_error() {
        let c = client(
            MockTransport::new(Ok(models_json()), Ok(chat_json()))
                .with_post_error(DeepSeekErrorKind::Auth401),
        );
        assert!(matches!(
            c.chat("deepseek-v4-flash", "hi", 64).unwrap_err(),
            DeepSeekError::Auth(401)
        ));
    }

    #[test]
    fn discover_models_missing_data_is_bad_response() {
        let c = client(MockTransport::new(
            Ok(json!({"object": "list"})),
            Ok(chat_json()),
        ));
        assert!(matches!(
            c.discover_models().unwrap_err(),
            DeepSeekError::BadResponse(_)
        ));
    }

    #[test]
    fn chat_missing_usage_is_bad_response() {
        let no_usage = json!({
            "id": "x", "object": "chat.completion", "model": "deepseek-v4-flash",
            "choices": [{"index": 0, "message": {"role": "assistant", "content": "hi"}, "finish_reason": "stop"}]
        });
        let c = client(MockTransport::new(Ok(models_json()), Ok(no_usage)));
        assert!(matches!(
            c.chat("deepseek-v4-flash", "hi", 64).unwrap_err(),
            DeepSeekError::BadResponse(_)
        ));
    }
}
