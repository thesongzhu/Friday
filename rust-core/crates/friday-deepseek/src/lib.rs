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

// `Clone + PartialEq + Eq` so the structured error can be carried (not stringified)
// into `friday_hub::AgentError::Route` and classified by the retry classifier at the
// run_loop error site. All variants are trivially Clone/Eq (unit / `u16` / `String` /
// `CoreError`, which already derives `Clone, PartialEq, Eq`). The error messages stay
// coarse and secret-free (status code / kind only — see `map_ureq_err`), so carrying
// the variant leaks no more than the prior `format!("{e:?}")` did.
#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum DeepSeekError {
    /// Env var unset/empty. Adverse path: surfaces as a blocker, never a fallback.
    #[error("DeepSeek credential missing or empty (env {ENV_KEY})")]
    CredentialMissing,
    /// Authentication rejected (HTTP 401/403). Never a fallback.
    #[error("DeepSeek authentication failed (HTTP {0})")]
    Auth(u16),
    /// Route unavailable: a TRANSIENT failure that retrying the SAME route may
    /// fix — network/transport error, request-timeout (HTTP 408), or a server-side
    /// 5xx. Classified `Retryable` (bounded). Never a fallback.
    #[error("DeepSeek provider unavailable: {0}")]
    ProviderUnavailable(String),
    /// A TERMINAL client-side HTTP error (other 4xx: 400 bad-request / 404 / 422,
    /// and 429 rate-limit). Retrying cannot fix a malformed/unauthorized/not-found
    /// request, and — absent any backoff mechanism — retrying a 429 would only
    /// hammer a rate-limited provider, so 429 is treated as terminal here (a future
    /// backoff slice could make 429 retryable-with-delay). Classified `Terminal`.
    /// Never a fallback. Display is COARSE: status code only, never the response body.
    #[error("DeepSeek client error (HTTP {status})")]
    ClientError { status: u16 },
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

/// (#24b degrade-4) The wall-clock ceiling on a SINGLE model HTTP call (overall request: DNS +
/// connect + send + read body). Bare `ureq::post().send_json()` had NO timeout, so one hung call
/// could exceed the crash-recovery staleness threshold (`EXECUTION_STATE_STALE_THRESHOLD_MS` = 5
/// min) and let a concurrent boot reconcile abort a still-LIVE run. 60s is chosen WELL UNDER that
/// threshold: the agent loop re-sets the durable heartbeat before EACH of its ≤3 attempts, so the
/// longest gap a model-call group introduces is one attempt ≈ 60s (a ~5x margin vs 300s). It is
/// also generous for a real DeepSeek/Claude completion (seconds to low tens-of-seconds). A timed-out
/// call surfaces as a `ureq::Error::Transport` ⇒ [`DeepSeekError::ProviderUnavailable`] (transient),
/// so the loop's bounded transient-route retry handles it exactly like any other transient failure
/// — the run is never silently wedged.
pub const DEEPSEEK_REQUEST_TIMEOUT_MS: u64 = 60_000;

/// Real blocking HTTP transport (ureq + rustls). Maps errors to controlled
/// [`DeepSeekError`] messages — it never formats the request (which carries the
/// `Authorization` header) into an error string. Built on a shared [`ureq::Agent`] carrying the
/// [`DEEPSEEK_REQUEST_TIMEOUT_MS`] overall-request timeout (#24b degrade-4) so no single model call
/// can hang past the crash-recovery staleness threshold.
pub struct UreqTransport {
    agent: ureq::Agent,
}

impl UreqTransport {
    pub fn new() -> Self {
        Self::with_timeout_ms(DEEPSEEK_REQUEST_TIMEOUT_MS)
    }

    /// (#24b degrade-4) Build the transport with an explicit overall-request timeout (ms). Used by
    /// [`Self::new`] with the production [`DEEPSEEK_REQUEST_TIMEOUT_MS`] ceiling, and by tests with
    /// a short timeout to prove a hung server is bounded rather than wedging the run forever.
    pub fn with_timeout_ms(timeout_ms: u64) -> Self {
        UreqTransport {
            agent: ureq::AgentBuilder::new()
                .timeout(std::time::Duration::from_millis(timeout_ms))
                .build(),
        }
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
            // Do not read/echo the response body; classify by status code ONLY.
            if code == 401 || code == 403 {
                DeepSeekError::Auth(code)
            } else if code == 408 || (500..=599).contains(&code) {
                // Transient: request-timeout (408) or any server-side 5xx — retrying
                // the SAME route may succeed.
                DeepSeekError::ProviderUnavailable(format!("HTTP {code}"))
            } else {
                // Terminal client error: other 4xx (400/404/422) and 429 rate-limit.
                // Retrying cannot fix the request, and (no backoff) retrying a 429 only
                // hammers a rate-limited provider — so it fails closed, not retried.
                DeepSeekError::ClientError { status: code }
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
        // (#24b degrade-4) Route through the timeout-bounded shared agent (see UreqTransport).
        let resp = self
            .agent
            .get(url)
            .set("Authorization", &format!("Bearer {bearer}"))
            .set("Accept", "application/json")
            .call()
            .map_err(map_ureq_err)?;
        resp.into_json::<Value>()
            .map_err(|e| DeepSeekError::BadResponse(format!("invalid JSON: {e}")))
    }

    fn post_json(&self, url: &str, bearer: &str, body: &Value) -> Result<Value, DeepSeekError> {
        // (#24b degrade-4) Route through the timeout-bounded shared agent (see UreqTransport).
        let resp = self
            .agent
            .post(url)
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
    base_url: String,
}

impl DeepSeekClient<UreqTransport> {
    /// Construct from the Hub environment (`FRIDAY_DEEPSEEK_API_KEY`).
    pub fn from_env() -> Result<Self, DeepSeekError> {
        let api_key = api_key_from_env_var(ENV_KEY)?;
        Ok(DeepSeekClient {
            transport: UreqTransport::new(),
            api_key,
            base_url: BASE_URL.to_string(),
        })
    }
}

impl<T: Transport> DeepSeekClient<T> {
    /// For tests / alternate transports. (`api_key` is never logged.)
    pub fn with_transport(transport: T, api_key: String) -> Self {
        DeepSeekClient {
            transport,
            api_key,
            base_url: BASE_URL.to_string(),
        }
    }

    /// For tests that need the real transport against a local HTTP endpoint.
    /// Production construction uses [`DeepSeekClient::from_env`] and the fixed
    /// DeepSeek base URL above.
    pub fn with_transport_and_base_url(
        transport: T,
        api_key: String,
        base_url: impl Into<String>,
    ) -> Self {
        DeepSeekClient {
            transport,
            api_key,
            base_url: base_url.into().trim_end_matches('/').to_string(),
        }
    }

    fn endpoint(&self, path: &str) -> String {
        format!("{}{}", self.base_url, path)
    }

    /// `GET /models` — discover available model ids at runtime.
    pub fn discover_models(&self) -> Result<Vec<String>, DeepSeekError> {
        let v = self
            .transport
            .get_json(&self.endpoint("/models"), &self.api_key)?;
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
        let v =
            self.transport
                .post_json(&self.endpoint("/chat/completions"), &self.api_key, &body)?;

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
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::thread;

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

    fn serve_http_once(
        status: u16,
        reason: &'static str,
        body: &'static str,
    ) -> (String, thread::JoinHandle<()>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        let handle = thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut req = [0u8; 2048];
            let _ = stream.read(&mut req);
            let response = format!(
                "HTTP/1.1 {status} {reason}\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{body}",
                body.len()
            );
            stream.write_all(response.as_bytes()).unwrap();
        });
        (format!("http://{addr}"), handle)
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
    fn real_transport_maps_rate_limit_to_terminal_client_error_without_body_or_secret() {
        // 429 is now a TERMINAL ClientError (no backoff mechanism ⇒ treat as terminal
        // rather than hammer a rate-limited provider). Display/Debug stays COARSE: the
        // status code only — never the response body (which carries SECRET-QUOTA-BODY)
        // nor the API key / Authorization header. This doubles as the leak-lens assertion
        // for the new ClientError variant (#593 leak-lens LOW).
        let (base_url, handle) = serve_http_once(
            429,
            "Too Many Requests",
            r#"{"error":"quota hit for SECRET-QUOTA-BODY"}"#,
        );
        let c = DeepSeekClient::with_transport_and_base_url(
            UreqTransport::new(),
            "test-key-not-real".to_string(),
            base_url,
        );
        let err = c.discover_models().unwrap_err();
        handle.join().unwrap();
        assert!(matches!(err, DeepSeekError::ClientError { status: 429 }));
        // Both Debug and Display must be coarse and secret-free.
        for rendered in [format!("{err:?}"), format!("{err}")] {
            for forbidden in [
                "SECRET-QUOTA-BODY",
                "test-key-not-real",
                "Authorization",
                "Bearer",
            ] {
                assert!(
                    !rendered.contains(forbidden),
                    "client-error render leaked {forbidden}: {rendered}"
                );
            }
            // Positively: the status code IS present (a coarse, useful label).
            assert!(rendered.contains("429"), "status code missing: {rendered}");
        }
    }

    #[test]
    fn real_transport_bounds_a_hung_request_with_a_wall_clock_timeout() {
        // (#24b degrade-4) A server that ACCEPTS the connection but never replies must NOT wedge the
        // call forever — the overall-request timeout fires and surfaces a TRANSIENT
        // ProviderUnavailable (so the loop's bounded transient retry handles it; the run is never
        // silently hung past the crash-recovery staleness threshold). We use a SHORT (250ms) timeout
        // to keep the test fast; production uses DEEPSEEK_REQUEST_TIMEOUT_MS.
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        let handle = thread::spawn(move || {
            // Accept then HANG: read the request but never write a response, holding the socket open
            // until the client times out and drops it.
            if let Ok((mut stream, _)) = listener.accept() {
                let mut req = [0u8; 2048];
                let _ = stream.read(&mut req);
                std::thread::sleep(std::time::Duration::from_millis(2_000));
            }
        });
        let c = DeepSeekClient::with_transport_and_base_url(
            UreqTransport::with_timeout_ms(250),
            "test-key-not-real".to_string(),
            format!("http://{addr}"),
        );
        let start = std::time::Instant::now();
        let err = c.discover_models().unwrap_err();
        let elapsed = start.elapsed();
        let _ = handle.join();
        // It returned (did not hang) well within a second, classified as transient.
        assert!(
            elapsed < std::time::Duration::from_millis(1_500),
            "the timeout must bound the call; took {elapsed:?}"
        );
        assert!(
            matches!(err, DeepSeekError::ProviderUnavailable(_)),
            "a timed-out call is a transient ProviderUnavailable, got {err:?}"
        );
    }

    // The production per-call ceiling MUST be well under the crash-recovery staleness threshold
    // (300_000ms / 5 min), so a slow-but-live model call can never be mistaken for a crash. A
    // compile-time assert (clippy rejects a runtime assert on a constant).
    const _: () = assert!(
        DEEPSEEK_REQUEST_TIMEOUT_MS < 300_000,
        "the per-call timeout must be under the 5-min crash-recovery staleness threshold"
    );

    #[test]
    fn map_ureq_status_partitions_transient_5xx_408_vs_terminal_4xx() {
        // Synthetic ureq::Error::Status values drive map_ureq_err directly (no network),
        // proving the exact partition: 5xx + 408 + transport ⇒ transient ProviderUnavailable
        // (Retryable); other 4xx + 429 ⇒ terminal ClientError. ureq::Error::Status carries a
        // Response; we synthesize one with the desired status line.
        let status_err = |code: u16, reason: &str| {
            let resp = ureq::Response::new(code, reason, "{}").unwrap();
            map_ureq_err(ureq::Error::Status(code, resp))
        };

        // Transient — stays ProviderUnavailable (Retryable downstream).
        for code in [500u16, 502, 503, 504, 599, 408] {
            assert!(
                matches!(
                    status_err(code, "x"),
                    DeepSeekError::ProviderUnavailable(ref r) if r == &format!("HTTP {code}")
                ),
                "HTTP {code} must be transient ProviderUnavailable"
            );
        }
        // Terminal client error — ClientError (Terminal downstream). 429 included.
        for code in [400u16, 404, 409, 422, 429] {
            assert!(
                matches!(status_err(code, "x"), DeepSeekError::ClientError { status } if status == code),
                "HTTP {code} must be terminal ClientError"
            );
        }
        // 401/403 stay Auth (unchanged).
        assert!(matches!(status_err(401, "x"), DeepSeekError::Auth(401)));
        assert!(matches!(status_err(403, "x"), DeepSeekError::Auth(403)));
    }

    #[test]
    fn real_transport_maps_tcp_network_fail_without_secret() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        drop(listener);
        let c = DeepSeekClient::with_transport_and_base_url(
            UreqTransport::new(),
            "test-key-not-real".to_string(),
            format!("http://{addr}"),
        );
        let err = c.discover_models().unwrap_err();
        assert!(matches!(
            err,
            DeepSeekError::ProviderUnavailable(ref reason) if reason.starts_with("transport:")
        ));
        let rendered = format!("{err:?}");
        for forbidden in ["test-key-not-real", "Authorization", "Bearer"] {
            assert!(
                !rendered.contains(forbidden),
                "network-fail error leaked {forbidden}: {rendered}"
            );
        }
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
