//! friday-anthropic — the Claude/Anthropic Friday-provider route (Hub-only,
//! secret-bearing). **Friday's SECOND live LLM provider**, mirroring the proven
//! `friday-deepseek` crate behind the same `friday_hub::AgentLlmClient` seam.
//!
//! **DARK / default-off.** This crate is reachable only behind an explicit,
//! default-OFF selection (see `friday_hub::HubRuntime::live`, env gate
//! `FRIDAY_CLAUDE_ROUTE_ENABLED`, default off) AND a `claude`-kind route that the
//! autonomous baseline registers as `available: false`. Prod default behavior is
//! UNCHANGED; the DeepSeek path is untouched.
//!
//! The route:
//! 1. reads `FRIDAY_ANTHROPIC_API_KEY` from the environment — **on the Hub only**
//!    (the value is never printed/logged/committed);
//! 2. calls `POST /v1/messages` (the Anthropic Messages API — no `/models`
//!    discovery step; the model id comes from the route, e.g. `claude-opus-4-8`);
//! 3. parses the assistant text from the `content[]` blocks + `stop_reason` +
//!    `usage` (`input_tokens` / `output_tokens` — NOT OpenAI's
//!    `prompt_tokens`/`completion_tokens`).
//!
//! **No fallback.** A failed route is a [`ClaudeError`] (`ProviderUnavailable` /
//! `Auth` / `ClientError` / …) — never a silent substitute provider, local model,
//! or canned answer. The only call-making method is [`ClaudeClient::chat`];
//! everything else is pure and makes no network call.
//!
//! **Ledger/metering DEFERRED.** Unlike DeepSeek, this crate does NOT build a
//! `friday_core::LedgerEntry`: `LedgerEntry::friday_route` hard-wires
//! `ProviderKind::DeepSeek` + `api.deepseek.com`, so reusing it would
//! mis-attribute a Claude call as DeepSeek (a latent honesty bug). The adapter in
//! `friday-hub` therefore uses the trait's DEFAULT (no-usage ⇒ no ledger row)
//! metering. A proper Claude ledger needs `ProviderKind::Anthropic` + a
//! `MeteredStep` generalization — both out of this dark slice's scope.
//!
//! Trust boundary: this crate is provider-secret-bearing and must stay OUT of
//! `friday-ffi`'s dependency graph (asserted by `friday-arch-tests`, mirroring
//! the friday-deepseek assertion).

use serde_json::{json, Value};
use std::time::Duration;
use thiserror::Error;

/// Anthropic API base URL (the Messages API root).
pub const BASE_URL: &str = "https://api.anthropic.com";
/// The host the route talks to (for evidence / leak-lens assertions).
pub const BASE_URL_HOST: &str = "api.anthropic.com";
/// Required Anthropic API version header value (pinned; see the Messages API contract).
pub const ANTHROPIC_VERSION: &str = "2023-06-01";
/// Default Claude model id when the route does not pin one. Current Claude model
/// (`claude-opus-4-8`). The route registry pins the model explicitly; this is the
/// crate-level fallback default only.
pub const DEFAULT_MODEL: &str = "claude-opus-4-8";
/// Hub-only environment variable holding the Anthropic API key.
pub const ENV_KEY: &str = "FRIDAY_ANTHROPIC_API_KEY";

/// (#24b degrade-4, hardening) The wall-clock ceiling on a SINGLE Claude HTTP call (overall
/// request: DNS + connect + send + read body). The bare `ureq::post().send_json()` this transport
/// used had NO timeout, so one hung call (a server that ACCEPTS but never replies) could exceed the
/// crash-recovery staleness threshold (`EXECUTION_STATE_STALE_THRESHOLD_MS` = 5 min) and let a
/// concurrent boot reconcile ABORT a still-LIVE run. This bound bites BOTH the failover fallback
/// (`ClaudeClient::chat`) AND vision (`friday_vision::ClaudeVisionClient`, which reuses this
/// transport). 60s mirrors [`friday_deepseek::DEEPSEEK_REQUEST_TIMEOUT_MS`] exactly: with
/// `FRIDAY_PROVIDER_FAILOVER=1` the worst-case gap is primary 60s + fallback 60s = 120s, still WELL
/// under the 300s threshold (≈2.5x margin), and the agent loop re-sets its durable heartbeat before
/// EACH attempt. It is generous for a real Claude completion (seconds to low tens-of-seconds). A
/// timed-out call surfaces as a `ureq::Error::Transport` ⇒ [`ClaudeError::ProviderUnavailable`]
/// (transient) ⇒ [`crate`-external `is_failover_worthy`] treats it as a transient outage — the run
/// is never silently wedged.
pub const ANTHROPIC_REQUEST_TIMEOUT_MS: u64 = 60_000;
/// Bounded same-provider 429 retry budget. This gives Anthropic a short,
/// Retry-After-aware recovery window before surfacing the unchanged terminal
/// `ClientError { status: 429 }` to Friday's failover layer.
pub const ANTHROPIC_RATE_LIMIT_MAX_RETRIES: u32 = 2;
pub const ANTHROPIC_RATE_LIMIT_BASE_BACKOFF_MS: u64 = 250;
pub const ANTHROPIC_RATE_LIMIT_MAX_BACKOFF_MS: u64 = 1_000;
pub const ANTHROPIC_RATE_LIMIT_MAX_TOTAL_BACKOFF_MS: u64 = 2_000;

// `Clone + PartialEq + Eq` mirrors `DeepSeekError` so the structured error could be
// carried (not stringified) if a future slice adds an `AgentError::ClaudeRoute`
// variant + classifier arm. In THIS dark slice the friday-hub adapter maps a
// `ClaudeError` into the existing string-bearing `AgentError::Model(_)` (never
// retried), so Claude-route retry-classification is DEFERRED — acceptable for a
// never-selected default-off path. Error messages stay coarse + secret-free
// (status code / kind only — see `map_ureq_err`).
#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum ClaudeError {
    /// Env var unset/empty. Adverse path: surfaces as a blocker, never a fallback.
    #[error("Anthropic credential missing or empty (env {ENV_KEY})")]
    CredentialMissing,
    /// Authentication rejected (HTTP 401/403). Never a fallback.
    #[error("Anthropic authentication failed (HTTP {0})")]
    Auth(u16),
    /// Route unavailable: a TRANSIENT failure that retrying the SAME route may
    /// fix — network/transport error, request-timeout (HTTP 408), a server-side
    /// 5xx, or Anthropic's 529 `overloaded_error`. Never a fallback.
    #[error("Anthropic provider unavailable: {0}")]
    ProviderUnavailable(String),
    /// A TERMINAL client-side HTTP error: other 4xx (400 bad-request / 404 /
    /// 413 request-too-large / 422) and 429 rate-limit after the bounded
    /// Retry-After-aware backoff budget is exhausted. Never a fallback. Display
    /// is COARSE: status code only, never the body.
    #[error("Anthropic client error (HTTP {status})")]
    ClientError { status: u16 },
    /// Response did not match the documented Messages API shape.
    #[error("Anthropic response shape unexpected: {0}")]
    BadResponse(String),
}

/// HTTP transport seam. The real impl is [`UreqTransport`]; tests inject a mock
/// so the no-hidden-call and no-fallback logic can be proven without network.
///
/// Anthropic auth differs from DeepSeek's `Authorization: Bearer`: it uses the
/// `x-api-key` header + a required `anthropic-version` header. The transport owns
/// those headers so the `ClaudeClient` never formats the secret into a request it
/// might later log.
pub trait Transport {
    fn post_json(&self, url: &str, api_key: &str, body: &Value) -> Result<Value, ClaudeError>;
}

/// Real blocking HTTP transport (ureq + rustls). Maps errors to controlled
/// [`ClaudeError`] messages — it never formats the request (which carries the
/// `x-api-key` header) into an error string. Built on a shared [`ureq::Agent`] carrying the
/// [`ANTHROPIC_REQUEST_TIMEOUT_MS`] overall-request timeout (#24b degrade-4, hardening) so no
/// single Claude call (chat OR vision) can hang past the crash-recovery staleness threshold.
pub struct UreqTransport {
    agent: ureq::Agent,
}

impl UreqTransport {
    pub fn new() -> Self {
        Self::with_timeout_ms(ANTHROPIC_REQUEST_TIMEOUT_MS)
    }

    /// (#24b degrade-4, hardening) Build the transport with an explicit overall-request timeout
    /// (ms). Used by [`Self::new`] with the production [`ANTHROPIC_REQUEST_TIMEOUT_MS`] ceiling, and
    /// by tests with a short timeout to prove a hung server is bounded rather than wedging the run
    /// forever. `pub` so the `friday-vision` tests can inject a short timeout into a
    /// `ClaudeVisionClient` too (they construct the transport directly).
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

fn parse_retry_after_ms(raw: Option<&str>) -> Option<u64> {
    raw.and_then(|v| v.trim().parse::<u64>().ok())
        .map(|secs| secs.saturating_mul(1_000))
}

fn bounded_429_backoff_ms(
    attempt: u32,
    retry_after_ms: Option<u64>,
    total_backoff_ms: u64,
) -> Option<u64> {
    if total_backoff_ms >= ANTHROPIC_RATE_LIMIT_MAX_TOTAL_BACKOFF_MS {
        return None;
    }
    let remaining = ANTHROPIC_RATE_LIMIT_MAX_TOTAL_BACKOFF_MS - total_backoff_ms;
    let exponential =
        ANTHROPIC_RATE_LIMIT_BASE_BACKOFF_MS.saturating_mul(2u64.saturating_pow(attempt));
    // Deterministic jitter keeps tests stable while avoiding perfectly aligned retries.
    let jitter = ((attempt as u64 + 1) * 37) % 101;
    let requested = retry_after_ms.unwrap_or_else(|| exponential.saturating_add(jitter));
    Some(
        requested
            .min(ANTHROPIC_RATE_LIMIT_MAX_BACKOFF_MS)
            .min(remaining),
    )
}

fn map_ureq_err(e: ureq::Error) -> ClaudeError {
    match e {
        ureq::Error::Status(code, _resp) => {
            // Do not read/echo the response body; classify by status code ONLY.
            if code == 401 || code == 403 {
                ClaudeError::Auth(code)
            } else if code == 408 || code == 529 || (500..=599).contains(&code) {
                // Transient: request-timeout (408), Anthropic's 529 overloaded_error,
                // or any server-side 5xx — retrying the SAME route may succeed.
                ClaudeError::ProviderUnavailable(format!("HTTP {code}"))
            } else {
                // Terminal client error: other 4xx (400/404/413/422) and 429 rate-limit
                // after the bounded same-provider backoff budget is exhausted.
                ClaudeError::ClientError { status: code }
            }
        }
        // Transport error (DNS/TLS/timeout). Its Display carries host/kind, not
        // our x-api-key header, but keep the message terse and controlled.
        ureq::Error::Transport(t) => {
            ClaudeError::ProviderUnavailable(format!("transport: {}", t.kind()))
        }
    }
}

impl Transport for UreqTransport {
    fn post_json(&self, url: &str, api_key: &str, body: &Value) -> Result<Value, ClaudeError> {
        // (#24b degrade-4, hardening) Route through the timeout-bounded shared agent (see
        // UreqTransport) — never a bare `ureq::post()` (which has no timeout).
        let mut total_backoff_ms = 0u64;
        let mut retry_count = 0u32;
        let resp = loop {
            match self
                .agent
                .post(url)
                .set("x-api-key", api_key)
                .set("anthropic-version", ANTHROPIC_VERSION)
                .set("content-type", "application/json")
                .set("accept", "application/json")
                .send_json(body.clone())
            {
                Ok(resp) => break resp,
                Err(ureq::Error::Status(429, resp)) => {
                    if retry_count >= ANTHROPIC_RATE_LIMIT_MAX_RETRIES {
                        return Err(ClaudeError::ClientError { status: 429 });
                    }
                    let retry_after_ms = parse_retry_after_ms(resp.header("Retry-After"));
                    let Some(delay_ms) =
                        bounded_429_backoff_ms(retry_count, retry_after_ms, total_backoff_ms)
                    else {
                        return Err(ClaudeError::ClientError { status: 429 });
                    };
                    std::thread::sleep(Duration::from_millis(delay_ms));
                    total_backoff_ms = total_backoff_ms.saturating_add(delay_ms);
                    retry_count += 1;
                }
                Err(e) => return Err(map_ureq_err(e)),
            }
        };
        resp.into_json::<Value>()
            .map_err(|e| ClaudeError::BadResponse(format!("invalid JSON: {e}")))
    }
}

/// One model call's result (the bits Friday would show / later ledger). Mirrors
/// `friday_deepseek::ModelCallOutcome` but uses Anthropic's usage field names so a
/// Claude call is never mis-shaped into the DeepSeek outcome.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ModelCallOutcome {
    /// The model id the response reported (report the *reported* model, not the
    /// requested one, to avoid stale-model claims).
    pub model: String,
    /// Anthropic `usage.input_tokens` (the prompt-token equivalent).
    pub input_tokens: i64,
    /// Anthropic `usage.output_tokens` (the completion-token equivalent).
    pub output_tokens: i64,
    /// Checked sum of input + output (Anthropic returns no `total_tokens`).
    pub total_tokens: i64,
    /// Concatenated text from every `content[]` block whose `type == "text"`.
    pub content: String,
    /// Anthropic `stop_reason` (`end_turn` / `max_tokens` / `tool_use` / `refusal` / …).
    pub stop_reason: String,
}

/// Read the API key from a specific env var (Hub-only). Empty/whitespace = missing.
pub fn api_key_from_env_var(var: &str) -> Result<String, ClaudeError> {
    match std::env::var(var) {
        Ok(v) if !v.trim().is_empty() => Ok(v),
        _ => Err(ClaudeError::CredentialMissing),
    }
}

pub struct ClaudeClient<T: Transport> {
    transport: T,
    api_key: String,
    base_url: String,
}

impl ClaudeClient<UreqTransport> {
    /// Construct from the Hub environment (`FRIDAY_ANTHROPIC_API_KEY`). FAILS
    /// CLOSED if the key is absent/empty — never a fallback. Mirrors
    /// `DeepSeekClient::from_env`.
    pub fn from_env() -> Result<Self, ClaudeError> {
        let api_key = api_key_from_env_var(ENV_KEY)?;
        Ok(ClaudeClient {
            transport: UreqTransport::new(),
            api_key,
            base_url: BASE_URL.to_string(),
        })
    }
}

impl<T: Transport> ClaudeClient<T> {
    /// For tests / alternate transports. (`api_key` is never logged.)
    pub fn with_transport(transport: T, api_key: String) -> Self {
        ClaudeClient {
            transport,
            api_key,
            base_url: BASE_URL.to_string(),
        }
    }

    /// For tests that need the real transport against a local HTTP endpoint.
    /// Production construction uses [`ClaudeClient::from_env`] and the fixed
    /// Anthropic base URL above.
    pub fn with_transport_and_base_url(
        transport: T,
        api_key: String,
        base_url: impl Into<String>,
    ) -> Self {
        ClaudeClient {
            transport,
            api_key,
            base_url: base_url.into().trim_end_matches('/').to_string(),
        }
    }

    fn endpoint(&self, path: &str) -> String {
        format!("{}{}", self.base_url, path)
    }

    /// `POST /v1/messages` — a single non-streaming completion. `max_tokens` is
    /// REQUIRED by the Anthropic Messages API; the caller always supplies it.
    pub fn chat(
        &self,
        model: &str,
        prompt: &str,
        max_tokens: u32,
    ) -> Result<ModelCallOutcome, ClaudeError> {
        let body = json!({
            "model": model,
            "max_tokens": max_tokens,
            "messages": [{"role": "user", "content": prompt}],
        });
        let v = self
            .transport
            .post_json(&self.endpoint("/v1/messages"), &self.api_key, &body)?;

        let usage = v
            .get("usage")
            .ok_or_else(|| ClaudeError::BadResponse("missing `usage`".into()))?;
        let input_tokens = usage
            .get("input_tokens")
            .and_then(Value::as_i64)
            .ok_or_else(|| ClaudeError::BadResponse("usage.input_tokens".into()))?;
        let output_tokens = usage
            .get("output_tokens")
            .and_then(Value::as_i64)
            .ok_or_else(|| ClaudeError::BadResponse("usage.output_tokens".into()))?;
        // Anthropic returns no `total_tokens`; sum the parts with a CHECKED add so a
        // hostile/buggy `usage` yields a clean BadResponse, never an overflow panic.
        let total_tokens = input_tokens
            .checked_add(output_tokens)
            .ok_or_else(|| ClaudeError::BadResponse("usage token total overflow".into()))?;

        // Report the model id the response reports (avoids stale-model claims).
        let reported_model = v
            .get("model")
            .and_then(Value::as_str)
            .unwrap_or(model)
            .to_string();

        // The assistant reply is `content[]` — concatenate every `type == "text"`
        // block (never index `content[0]`; a leading non-text block or an empty
        // array must not panic).
        let content = v
            .get("content")
            .and_then(Value::as_array)
            .map(|blocks| {
                blocks
                    .iter()
                    .filter(|b| b.get("type").and_then(Value::as_str) == Some("text"))
                    .filter_map(|b| b.get("text").and_then(Value::as_str))
                    .collect::<Vec<_>>()
                    .join("")
            })
            .unwrap_or_default();

        let stop_reason = v
            .get("stop_reason")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();

        Ok(ModelCallOutcome {
            model: reported_model,
            input_tokens,
            output_tokens,
            total_tokens,
            content,
            stop_reason,
        })
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
        post_calls: Cell<u32>,
        post_result: Result<Value, ()>,
        post_err: Option<ClaudeErrorKind>,
    }

    #[derive(Clone, Copy)]
    enum ClaudeErrorKind {
        Auth401,
        Unavailable,
    }

    impl MockTransport {
        fn new(post_result: Result<Value, ()>) -> Self {
            MockTransport {
                post_calls: Cell::new(0),
                post_result,
                post_err: None,
            }
        }
        fn with_post_error(mut self, kind: ClaudeErrorKind) -> Self {
            self.post_err = Some(kind);
            self
        }
    }

    impl Transport for MockTransport {
        fn post_json(&self, _url: &str, _key: &str, _body: &Value) -> Result<Value, ClaudeError> {
            self.post_calls.set(self.post_calls.get() + 1);
            if let Some(kind) = self.post_err {
                return Err(match kind {
                    ClaudeErrorKind::Auth401 => ClaudeError::Auth(401),
                    ClaudeErrorKind::Unavailable => {
                        ClaudeError::ProviderUnavailable("HTTP 503".into())
                    }
                });
            }
            self.post_result
                .clone()
                .map_err(|_| ClaudeError::ProviderUnavailable("mock post error".into()))
        }
    }

    /// A canonical Anthropic Messages API success response.
    fn messages_json() -> Value {
        json!({
            "id": "msg_x",
            "type": "message",
            "role": "assistant",
            "model": "claude-opus-4-8",
            "content": [{"type": "text", "text": "PONG"}],
            "stop_reason": "end_turn",
            "stop_sequence": null,
            "usage": {"input_tokens": 11, "output_tokens": 8}
        })
    }

    fn client(mock: MockTransport) -> ClaudeClient<MockTransport> {
        ClaudeClient::with_transport(mock, "test-key-not-real".to_string())
    }

    /// Serve exactly one HTTP response on an ephemeral localhost port. The thread
    /// returns the raw request bytes it captured off the wire (as a lossy String)
    /// so a header KAT can assert what actually reached the socket. Callers that
    /// only care about the response simply `handle.join().unwrap();` and discard
    /// the returned String.
    fn read_full_http_request(stream: &mut std::net::TcpStream) -> Vec<u8> {
        let _ = stream.set_read_timeout(Some(std::time::Duration::from_secs(2)));
        let mut captured: Vec<u8> = Vec::new();
        let mut tmp = [0u8; 1024];
        loop {
            match stream.read(&mut tmp) {
                Ok(0) => break,
                Ok(n) => {
                    captured.extend_from_slice(&tmp[..n]);
                    let Some(header_end) = captured.windows(4).position(|w| w == b"\r\n\r\n")
                    else {
                        continue;
                    };
                    let headers = String::from_utf8_lossy(&captured[..header_end + 4]);
                    let content_length = headers
                        .lines()
                        .find_map(|line| {
                            let (name, value) = line.split_once(':')?;
                            name.eq_ignore_ascii_case("content-length")
                                .then(|| value.trim().parse::<usize>().ok())
                                .flatten()
                        })
                        .unwrap_or(0);
                    let body_read = captured.len().saturating_sub(header_end + 4);
                    if body_read >= content_length {
                        break;
                    }
                }
                Err(_) => break,
            }
        }
        captured
    }

    fn serve_http_once(
        status: u16,
        reason: &'static str,
        body: &'static str,
    ) -> (String, thread::JoinHandle<String>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        let handle = thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let captured = read_full_http_request(&mut stream);
            let response = format!(
                "HTTP/1.1 {status} {reason}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            );
            stream.write_all(response.as_bytes()).unwrap();
            stream.flush().unwrap();
            // Deliver the response, then a CLEAN close (FIN, not RST): half-close the write side
            // and drain whatever the client still sends. A short read timeout keeps the drain
            // bounded so a keep-alive client (Content-Length set ⇒ ureq pools the conn) cannot
            // block `handle.join()` forever.
            let _ = stream.shutdown(std::net::Shutdown::Write);
            let _ = stream.set_read_timeout(Some(std::time::Duration::from_millis(200)));
            let mut sink = [0u8; 1024];
            while let Ok(n) = stream.read(&mut sink) {
                if n == 0 {
                    break;
                }
            }
            String::from_utf8_lossy(&captured).into_owned()
        });
        (format!("http://{addr}"), handle)
    }

    type HttpResponseSpec = (
        u16,
        &'static str,
        Vec<(&'static str, &'static str)>,
        &'static str,
    );

    fn serve_http_sequence(
        responses: Vec<HttpResponseSpec>,
    ) -> (String, thread::JoinHandle<Vec<String>>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        let handle = thread::spawn(move || {
            let mut captured_requests = Vec::new();
            for (status, reason, headers, body) in responses {
                let (mut stream, _) = listener.accept().unwrap();
                let captured = read_full_http_request(&mut stream);
                let mut response = format!(
                    "HTTP/1.1 {status} {reason}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n",
                    body.len()
                );
                for (name, value) in headers {
                    response.push_str(name);
                    response.push_str(": ");
                    response.push_str(value);
                    response.push_str("\r\n");
                }
                response.push_str("\r\n");
                response.push_str(body);
                stream.write_all(response.as_bytes()).unwrap();
                stream.flush().unwrap();
                let _ = stream.shutdown(std::net::Shutdown::Write);
                let _ = stream.set_read_timeout(Some(std::time::Duration::from_millis(200)));
                let mut sink = [0u8; 1024];
                while let Ok(n) = stream.read(&mut sink) {
                    if n == 0 {
                        break;
                    }
                }
                captured_requests.push(String::from_utf8_lossy(&captured).into_owned());
            }
            captured_requests
        });
        (format!("http://{addr}"), handle)
    }

    // ---- from_env fail-closed ----

    #[test]
    fn missing_credential_is_an_error_not_a_fallback() {
        // Use a var name guaranteed unset, regardless of any sourced real key,
        // and without mutating the process-global environment.
        let err =
            api_key_from_env_var("FRIDAY_ANTHROPIC_API_KEY_DEFINITELY_UNSET_a1b2c3").unwrap_err();
        assert!(matches!(err, ClaudeError::CredentialMissing));
    }

    #[test]
    fn empty_or_whitespace_credential_fails_closed_no_client() {
        // A var that is SET but empty / whitespace-only must FAIL CLOSED exactly
        // like an absent var — never yielding a (blank-key) client. Use a unique
        // bespoke var name so the (single) env-mutating test in this suite has no
        // concurrent-mutation partner regardless of cargo's test parallelism, and
        // never touches the real `FRIDAY_ANTHROPIC_API_KEY`.
        let var = "FRIDAY_ANTHROPIC_API_KEY_EMPTY_WS_TEST_d4e5f6";

        std::env::set_var(var, "");
        assert!(
            matches!(
                api_key_from_env_var(var).unwrap_err(),
                ClaudeError::CredentialMissing
            ),
            "empty key must fail closed"
        );

        std::env::set_var(var, "  \t\n ");
        assert!(
            matches!(
                api_key_from_env_var(var).unwrap_err(),
                ClaudeError::CredentialMissing
            ),
            "whitespace-only key must fail closed"
        );

        // A non-empty value IS accepted (positive control: the validator is not
        // just always-Err) — and is returned verbatim, not trimmed.
        std::env::set_var(var, " sk-real ");
        assert_eq!(api_key_from_env_var(var).unwrap(), " sk-real ");

        std::env::remove_var(var);
    }

    // ---- request shaping (golden request JSON) ----

    #[test]
    fn chat_builds_the_messages_request_with_required_max_tokens() {
        // Capture the exact body the client posts and assert the golden shape:
        // model + max_tokens (REQUIRED) + messages[{role:"user", content}].
        struct CapturingTransport {
            seen: std::cell::RefCell<Option<Value>>,
        }
        impl Transport for CapturingTransport {
            fn post_json(&self, url: &str, _key: &str, body: &Value) -> Result<Value, ClaudeError> {
                assert!(url.ends_with("/v1/messages"), "wrong endpoint: {url}");
                *self.seen.borrow_mut() = Some(body.clone());
                Ok(messages_json())
            }
        }
        let c = ClaudeClient::with_transport(
            CapturingTransport {
                seen: std::cell::RefCell::new(None),
            },
            "test-key-not-real".to_string(),
        );
        let _ = c.chat("claude-opus-4-8", "ping", 64).unwrap();
        let body = c.transport.seen.borrow().clone().unwrap();
        assert_eq!(body["model"], "claude-opus-4-8");
        assert_eq!(body["max_tokens"], 64);
        assert_eq!(body["messages"][0]["role"], "user");
        assert_eq!(body["messages"][0]["content"], "ping");
        // No streaming, no thinking — kept simple.
        assert!(body.get("stream").is_none());
    }

    #[test]
    fn real_transport_sends_x_api_key_and_anthropic_version_headers_on_the_wire() {
        // The Anthropic auth headers are set by the REAL transport (UreqTransport),
        // not by ClaudeClient — so prove them where they're actually written: parse
        // the raw request bytes captured off the socket and assert the request line
        // + that the CONFIGURED x-api-key value and the pinned anthropic-version
        // VALUE reach the wire. Dropping `.set("x-api-key", ..)` or changing
        // ANTHROPIC_VERSION must turn this RED.
        let (base_url, handle) = serve_http_once(
            200,
            "OK",
            r#"{"model":"claude-opus-4-8","content":[{"type":"text","text":"PONG"}],"stop_reason":"end_turn","usage":{"input_tokens":1,"output_tokens":1}}"#,
        );
        let c = ClaudeClient::with_transport_and_base_url(
            UreqTransport::new(),
            "test-key-not-real".to_string(),
            base_url,
        );
        let out = c.chat("claude-opus-4-8", "ping", 16).unwrap();
        assert_eq!(out.content, "PONG"); // sanity: the round-trip completed

        // ureq does not guarantee header-NAME casing on the wire; lowercase the
        // haystack. The two asserted VALUES are case-stable.
        let captured = handle.join().unwrap().to_ascii_lowercase();
        assert!(
            captured.contains("post /v1/messages"),
            "request line missing POST /v1/messages: {captured}"
        );
        assert!(
            captured.contains("x-api-key: test-key-not-real"),
            "configured x-api-key did not reach the wire: {captured}"
        );
        assert!(
            captured.contains("anthropic-version: 2023-06-01"),
            "anthropic-version value did not reach the wire: {captured}"
        );
    }

    // ---- response parsing (golden response → expected text/usage) ----

    #[test]
    fn chat_maps_usage_and_reported_model_and_text() {
        let c = client(MockTransport::new(Ok(messages_json())));
        let out = c.chat("claude-opus-4-8", "ping", 64).unwrap();
        assert_eq!(out.model, "claude-opus-4-8");
        assert_eq!(out.input_tokens, 11);
        assert_eq!(out.output_tokens, 8);
        assert_eq!(out.total_tokens, 19);
        assert_eq!(out.content, "PONG");
        assert_eq!(out.stop_reason, "end_turn");
    }

    #[test]
    fn chat_concatenates_multiple_text_blocks_and_skips_non_text() {
        // The reply is `content[]`; a leading non-text block (e.g. a tool_use) must
        // be skipped and multiple text blocks concatenated — never index content[0].
        let multi = json!({
            "model": "claude-opus-4-8",
            "content": [
                {"type": "tool_use", "id": "tu_1", "name": "x", "input": {}},
                {"type": "text", "text": "Hello "},
                {"type": "text", "text": "world"}
            ],
            "stop_reason": "end_turn",
            "usage": {"input_tokens": 5, "output_tokens": 3}
        });
        let c = client(MockTransport::new(Ok(multi)));
        let out = c.chat("claude-opus-4-8", "hi", 64).unwrap();
        assert_eq!(out.content, "Hello world");
        assert_eq!(out.total_tokens, 8);
    }

    #[test]
    fn chat_empty_content_array_is_empty_string_not_panic() {
        let empty = json!({
            "model": "claude-opus-4-8",
            "content": [],
            "stop_reason": "end_turn",
            "usage": {"input_tokens": 5, "output_tokens": 0}
        });
        let c = client(MockTransport::new(Ok(empty)));
        let out = c.chat("claude-opus-4-8", "hi", 64).unwrap();
        assert_eq!(out.content, "");
        assert_eq!(out.stop_reason, "end_turn");
    }

    #[test]
    fn chat_missing_usage_is_bad_response() {
        let no_usage = json!({
            "model": "claude-opus-4-8",
            "content": [{"type": "text", "text": "hi"}],
            "stop_reason": "end_turn"
        });
        let c = client(MockTransport::new(Ok(no_usage)));
        assert!(matches!(
            c.chat("claude-opus-4-8", "hi", 64).unwrap_err(),
            ClaudeError::BadResponse(_)
        ));
    }

    #[test]
    fn chat_missing_usage_field_is_bad_response() {
        let partial = json!({
            "model": "claude-opus-4-8",
            "content": [{"type": "text", "text": "hi"}],
            "stop_reason": "end_turn",
            "usage": {"input_tokens": 5}  // missing output_tokens
        });
        let c = client(MockTransport::new(Ok(partial)));
        assert!(matches!(
            c.chat("claude-opus-4-8", "hi", 64).unwrap_err(),
            ClaudeError::BadResponse(_)
        ));
    }

    #[test]
    fn chat_overflow_usage_total_is_bad_response_not_panic() {
        // Hostile/buggy usage: parts sum past i64::MAX → checked sum yields
        // BadResponse (never a panic / overflow).
        let overflow = json!({
            "model": "claude-opus-4-8",
            "content": [{"type": "text", "text": "x"}],
            "stop_reason": "end_turn",
            "usage": {"input_tokens": i64::MAX, "output_tokens": 1}
        });
        let c = client(MockTransport::new(Ok(overflow)));
        assert!(matches!(
            c.chat("claude-opus-4-8", "hi", 16).unwrap_err(),
            ClaudeError::BadResponse(_)
        ));
    }

    // ---- no-fallback / error mapping ----

    #[test]
    fn provider_error_does_not_fallback() {
        // A failed chat returns an error after exactly one POST — there is no
        // second provider/local/mock attempt.
        let c = client(
            MockTransport::new(Ok(messages_json())).with_post_error(ClaudeErrorKind::Unavailable),
        );
        let err = c.chat("claude-opus-4-8", "hi", 64).unwrap_err();
        assert!(matches!(err, ClaudeError::ProviderUnavailable(_)));
        assert_eq!(c.transport.post_calls.get(), 1, "must not retry/fallback");
    }

    #[test]
    fn auth_failure_maps_to_auth_error() {
        let c = client(
            MockTransport::new(Ok(messages_json())).with_post_error(ClaudeErrorKind::Auth401),
        );
        assert!(matches!(
            c.chat("claude-opus-4-8", "hi", 64).unwrap_err(),
            ClaudeError::Auth(401)
        ));
    }

    #[test]
    fn map_ureq_status_partitions_transient_vs_terminal() {
        // Synthetic ureq::Error::Status values drive map_ureq_err directly (no
        // network), proving the exact partition: 5xx + 408 + 529 + transport ⇒
        // transient ProviderUnavailable; other 4xx + 429 ⇒ terminal ClientError;
        // 401/403 ⇒ Auth.
        let status_err = |code: u16, reason: &str| {
            let resp = ureq::Response::new(code, reason, "{}").unwrap();
            map_ureq_err(ureq::Error::Status(code, resp))
        };

        // Transient — including Anthropic's 529 overloaded_error.
        for code in [500u16, 502, 503, 504, 529, 408] {
            assert!(
                matches!(
                    status_err(code, "x"),
                    ClaudeError::ProviderUnavailable(ref r) if r == &format!("HTTP {code}")
                ),
                "HTTP {code} must be transient ProviderUnavailable"
            );
        }
        // Terminal client error — 413 request-too-large + 429 rate-limit included.
        for code in [400u16, 404, 413, 422, 429] {
            assert!(
                matches!(status_err(code, "x"), ClaudeError::ClientError { status } if status == code),
                "HTTP {code} must be terminal ClientError"
            );
        }
        // 401/403 stay Auth.
        assert!(matches!(status_err(401, "x"), ClaudeError::Auth(401)));
        assert!(matches!(status_err(403, "x"), ClaudeError::Auth(403)));
    }

    #[test]
    fn real_transport_retries_rate_limit_then_succeeds() {
        let (base_url, handle) = serve_http_sequence(vec![
            (
                429,
                "Too Many Requests",
                vec![("Retry-After", "0")],
                r#"{"type":"error","error":{"type":"rate_limit_error","message":"SECRET-QUOTA-BODY"}}"#,
            ),
            (
                200,
                "OK",
                vec![],
                r#"{"model":"claude-opus-4-8","content":[{"type":"text","text":"PONG"}],"stop_reason":"end_turn","usage":{"input_tokens":1,"output_tokens":1}}"#,
            ),
        ]);
        let c = ClaudeClient::with_transport_and_base_url(
            UreqTransport::new(),
            "test-key-not-real".to_string(),
            base_url,
        );
        let out = c.chat("claude-opus-4-8", "hi", 16).unwrap();
        let requests = handle.join().unwrap();
        assert_eq!(out.content, "PONG");
        assert_eq!(
            requests.len(),
            2,
            "429 should be retried once before success"
        );
    }

    #[test]
    fn real_transport_maps_rate_limit_to_terminal_client_error_without_body_or_secret() {
        // After the bounded backoff budget is exhausted, 429 remains the SAME terminal
        // ClientError so Friday's failover layer still matches `status == 429`.
        // Display/Debug stays COARSE: the status code only — never the response body nor
        // the x-api-key. Leak-lens.
        let quota_body =
            r#"{"type":"error","error":{"type":"rate_limit_error","message":"SECRET-QUOTA-BODY"}}"#;
        let (base_url, handle) = serve_http_sequence(vec![
            (
                429,
                "Too Many Requests",
                vec![("Retry-After", "0")],
                quota_body,
            ),
            (
                429,
                "Too Many Requests",
                vec![("Retry-After", "0")],
                quota_body,
            ),
            (
                429,
                "Too Many Requests",
                vec![("Retry-After", "0")],
                quota_body,
            ),
        ]);
        let c = ClaudeClient::with_transport_and_base_url(
            UreqTransport::new(),
            "test-key-not-real".to_string(),
            base_url,
        );
        let err = c.chat("claude-opus-4-8", "hi", 16).unwrap_err();
        let requests = handle.join().unwrap();
        assert_eq!(
            requests.len(),
            (ANTHROPIC_RATE_LIMIT_MAX_RETRIES + 1) as usize
        );
        assert!(matches!(err, ClaudeError::ClientError { status: 429 }));
        // Both Debug and Display must be coarse and secret-free.
        for rendered in [format!("{err:?}"), format!("{err}")] {
            for forbidden in ["SECRET-QUOTA-BODY", "test-key-not-real", "x-api-key"] {
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
    fn retry_after_backoff_is_bounded() {
        assert_eq!(parse_retry_after_ms(Some("2")), Some(2_000));
        assert_eq!(parse_retry_after_ms(Some("not-a-number")), None);
        assert_eq!(
            bounded_429_backoff_ms(0, Some(999_000), 0),
            Some(ANTHROPIC_RATE_LIMIT_MAX_BACKOFF_MS)
        );
        assert_eq!(
            bounded_429_backoff_ms(0, Some(999_000), ANTHROPIC_RATE_LIMIT_MAX_TOTAL_BACKOFF_MS),
            None
        );
    }

    #[test]
    fn real_transport_maps_overloaded_529_to_transient_without_secret() {
        let (base_url, handle) = serve_http_once(
            529,
            "Overloaded",
            r#"{"type":"error","error":{"type":"overloaded_error","message":"SECRET-OVERLOAD"}}"#,
        );
        let c = ClaudeClient::with_transport_and_base_url(
            UreqTransport::new(),
            "test-key-not-real".to_string(),
            base_url,
        );
        let err = c.chat("claude-opus-4-8", "hi", 16).unwrap_err();
        handle.join().unwrap();
        assert!(
            matches!(err, ClaudeError::ProviderUnavailable(ref r) if r == "HTTP 529"),
            "got {err:?}"
        );
        let rendered = format!("{err:?}");
        for forbidden in ["SECRET-OVERLOAD", "test-key-not-real", "x-api-key"] {
            assert!(
                !rendered.contains(forbidden),
                "leaked {forbidden}: {rendered}"
            );
        }
    }

    #[test]
    fn real_transport_maps_tcp_network_fail_without_secret() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        drop(listener);
        let c = ClaudeClient::with_transport_and_base_url(
            UreqTransport::new(),
            "test-key-not-real".to_string(),
            format!("http://{addr}"),
        );
        let err = c.chat("claude-opus-4-8", "hi", 16).unwrap_err();
        assert!(matches!(
            err,
            ClaudeError::ProviderUnavailable(ref reason) if reason.starts_with("transport:")
        ));
        let rendered = format!("{err:?}");
        for forbidden in ["test-key-not-real", "x-api-key"] {
            assert!(
                !rendered.contains(forbidden),
                "network-fail error leaked {forbidden}: {rendered}"
            );
        }
    }

    #[test]
    fn real_transport_bounds_a_hung_request_with_a_wall_clock_timeout() {
        // (#24b degrade-4, hardening) A server that ACCEPTS the connection but never replies must
        // NOT wedge the Claude call forever — the overall-request timeout fires and surfaces a
        // TRANSIENT ProviderUnavailable (so the loop's bounded transient retry / the failover
        // classifier handles it; the run is never silently hung past the crash-recovery staleness
        // threshold). A SHORT (250ms) timeout keeps the test fast; production uses
        // ANTHROPIC_REQUEST_TIMEOUT_MS. This proves the CHAT (failover-fallback) path.
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        let handle = thread::spawn(move || {
            // Accept then HANG: read the request but never write a response, holding the socket
            // open until the client times out and drops it. The sleep need only OUTLAST the
            // client's 250ms timeout — keeping it SHORT (and dropping the stream/listener promptly
            // after) avoids holding sockets long enough to contend with the other parallel
            // real-transport tests in this binary.
            if let Ok((mut stream, _)) = listener.accept() {
                let mut req = [0u8; 2048];
                let _ = stream.read(&mut req);
                std::thread::sleep(std::time::Duration::from_millis(500));
            }
        });
        let c = ClaudeClient::with_transport_and_base_url(
            UreqTransport::with_timeout_ms(250),
            "test-key-not-real".to_string(),
            format!("http://{addr}"),
        );
        let start = std::time::Instant::now();
        let err = c.chat("claude-opus-4-8", "hi", 16).unwrap_err();
        let elapsed = start.elapsed();
        let _ = handle.join();
        // It returned (did not hang) well within a second, classified as transient.
        assert!(
            elapsed < std::time::Duration::from_millis(1_500),
            "the timeout must bound the call; took {elapsed:?}"
        );
        assert!(
            matches!(err, ClaudeError::ProviderUnavailable(_)),
            "a timed-out call is a transient ProviderUnavailable, got {err:?}"
        );
    }

    // The production per-call ceiling MUST be well under the crash-recovery staleness threshold
    // (300_000ms / 5 min), so a slow-but-live Claude call can never be mistaken for a crash. A
    // compile-time assert (clippy rejects a runtime assert on a constant), mirroring DeepSeek.
    const _: () = assert!(
        ANTHROPIC_REQUEST_TIMEOUT_MS < 300_000,
        "the per-call timeout must be under the 5-min crash-recovery staleness threshold"
    );

    #[test]
    fn malformed_json_body_is_bad_response() {
        // A 200 with a non-JSON body must be a clean BadResponse, not a panic.
        let (base_url, handle) = serve_http_once(200, "OK", "this is not json");
        let c = ClaudeClient::with_transport_and_base_url(
            UreqTransport::new(),
            "test-key-not-real".to_string(),
            base_url,
        );
        let err = c.chat("claude-opus-4-8", "hi", 16).unwrap_err();
        handle.join().unwrap();
        assert!(matches!(err, ClaudeError::BadResponse(_)), "got {err:?}");
    }

    #[test]
    fn only_explicit_chat_hits_the_transport() {
        // Constructing the client makes ZERO transport calls; only chat() does,
        // and exactly one POST per call (no hidden retry/fallback).
        let c = client(MockTransport::new(Ok(messages_json())));
        assert_eq!(c.transport.post_calls.get(), 0);
        let _ = c.chat("claude-opus-4-8", "hi", 64).unwrap();
        assert_eq!(c.transport.post_calls.get(), 1);
    }
}
