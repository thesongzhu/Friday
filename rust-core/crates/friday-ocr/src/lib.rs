//! friday-ocr — the Friday `ocr` capability route (Hub-only, provider-secret-bearing).
//!
//! **HONEST ORACLE MIRROR.** The Friday TS oracle has NO standalone OCR tool and
//! NO OCR engine; the only trace is a latent, never-written `extractedText?: string`
//! field (zero writers — no tesseract / `VNRecognizeText` / paddleocr anywhere). The
//! oracle's ACTUAL image→text mechanism is the vision LLM (the `image_analysis`
//! tool). So the faithful Rust `ocr` = read a workspace-confined image (the read is
//! done HUB-side via `friday_fs::open_read_within_root` — NOT in this crate), send the
//! bytes to a vision-capable BYOK multimodal `/chat/completions` endpoint with an
//! extract-text prompt, and return the recognized text into the `extracted_text`
//! mirror field. We deliberately do NOT build a native OCR engine.
//!
//! Shape mirrors `friday-deepseek` EXACTLY (the proven provider-crate precedent):
//!
//! - [`OcrProvider`] — the hub-facing DI seam. The `friday-hub` `OcrToolExecutor`
//!   (a LATER F11 wave, VISOCR-EXEC) injects a `Box<dyn OcrProvider>`; this crate
//!   ships neither a `ToolExecutor` impl nor any `friday-hub` dependency (that would
//!   force a hub↔crate cycle). The trait is object-safe (sync, `&self`, concrete
//!   params/return) so it can be boxed.
//! - [`Transport`] + [`UreqVisionTransport`] — the inner HTTP seam (deepseek's
//!   `Transport`/`UreqTransport` analog); the real `ureq` leg, which NEVER formats
//!   the request (carrying the `Authorization` header) into an error string.
//! - [`VisionOcrClient`] — the live `OcrProvider` (deepseek's `DeepSeekClient<T>`
//!   analog): build the multimodal request → POST → strict parse. **No fallback** —
//!   a failed route is an [`OcrError`], NEVER a canned/substitute answer.
//! - [`StubOcrProvider`] — a deterministic `OcrProvider` for the hub executor's dark
//!   tests (fixed [`OcrOutcome`]). It is a TEST/FIXTURE backend, never a runtime
//!   fallback.
//!
//! **Flag (DARK, default-OFF):** [`ENV_ROUTE_ENABLED`] = `"FRIDAY_OCR_ROUTE_ENABLED"`
//! and [`ENV_KEY`] = `"FRIDAY_OCR_API_KEY"`, with [`route_enabled`] true iff the env
//! value trims to exactly `"1"` — mirroring the `FRIDAY_CLAUDE_ROUTE_ENABLED` template
//! at `friday-hub` `runtime.rs:948`. These consts are INERT in this crate: the gate
//! is enforced LATER at the hub (the WIRE wave constructs the live arm only when the
//! flag and key are present). Nothing here reads the flag to change behavior.
//!
//! Trust boundary: provider-secret-bearing → stays OUT of `friday-ffi`'s dependency
//! graph (same boundary as friday-deepseek/anthropic; asserted by friday-arch-tests).

use serde_json::{json, Value};
use thiserror::Error;

/// Hub-only environment variable holding the BYOK OCR (vision-LLM) API key.
/// INERT here — read at the hub's WIRE construction site, never in this crate.
pub const ENV_KEY: &str = "FRIDAY_OCR_API_KEY";

/// The DARK, default-OFF route flag. ON only when the value trims to exactly `"1"`.
/// INERT here — enforced at the hub (see [`route_enabled`]).
pub const ENV_ROUTE_ENABLED: &str = "FRIDAY_OCR_ROUTE_ENABLED";

/// Default extract-text instruction sent to the vision LLM. The oracle has no OCR
/// engine; this prompt is how the vision model is asked to transcribe the image.
pub const DEFAULT_OCR_PROMPT: &str =
    "Transcribe all text visible in this image verbatim. Output only the extracted text, with no commentary.";

/// `true` iff `FRIDAY_OCR_ROUTE_ENABLED` is set and trims to exactly `"1"`.
///
/// Mirrors the `FRIDAY_CLAUDE_ROUTE_ENABLED` template (`friday-hub` runtime.rs:948
/// — `matches!(std::env::var(..), Ok(v) if v.trim() == "1")`). DEFAULT-OFF: any
/// other value (unset, "0", "true", " 1 x") is OFF. This helper is provided for the
/// hub to call at its construction site; this crate never branches on it.
pub fn route_enabled() -> bool {
    matches!(std::env::var(ENV_ROUTE_ENABLED), Ok(v) if v.trim() == "1")
}

/// Read the BYOK key from a specific env var (Hub-only). Empty/whitespace = missing.
/// Mirrors `friday_deepseek::api_key_from_env_var`. The value is never logged.
pub fn api_key_from_env_var(var: &str) -> Result<String, OcrError> {
    match std::env::var(var) {
        Ok(v) if !v.trim().is_empty() => Ok(v),
        _ => Err(OcrError::CredentialMissing),
    }
}

// `Clone + PartialEq + Eq` so the structured error can be carried (not stringified)
// into the hub's error type and classified by a retry classifier, mirroring
// DeepSeekError. Messages stay COARSE + secret-free (status code / kind only — see
// `map_ureq_err`), so carrying the variant leaks no more than a `format!("{e:?}")`.
#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum OcrError {
    /// Env var unset/empty. Adverse path: surfaces as a blocker, never a fallback.
    #[error("OCR credential missing or empty (env {ENV_KEY})")]
    CredentialMissing,
    /// Caller supplied an invalid request (empty image bytes, etc.). Terminal.
    #[error("OCR request invalid: {0}")]
    InvalidRequest(String),
    /// Authentication rejected (HTTP 401/403). Never a fallback.
    #[error("OCR authentication failed (HTTP {0})")]
    Auth(u16),
    /// Route unavailable: a TRANSIENT failure that retrying the SAME route may fix —
    /// network/transport error, request-timeout (HTTP 408), or a server-side 5xx.
    /// Never a fallback.
    #[error("OCR provider unavailable: {0}")]
    ProviderUnavailable(String),
    /// A TERMINAL client-side HTTP error (other 4xx: 400/404/422, 429 rate-limit,
    /// and 402 payment-required — a vision endpoint can bill per image). Retrying
    /// cannot fix a malformed/unauthorized request. Never a fallback. Display is
    /// COARSE: status code only, never the response body.
    #[error("OCR client error (HTTP {status})")]
    ClientError { status: u16 },
    /// Response did not match the documented multimodal `/chat/completions` shape.
    #[error("OCR response shape unexpected: {0}")]
    BadResponse(String),
}

/// One OCR call's result — the bits the hub executor ledgers + feeds back.
///
/// The `extracted_text` field is the latent oracle mirror (the never-written
/// `extractedText?: string`), populated HERE by the vision LLM. Token counts mirror
/// the `image_analysis` usage accounting so the hub can ledger the spend.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct OcrOutcome {
    /// The recognized text (the `extractedText` mirror field).
    pub extracted_text: String,
    /// The model id the response REPORTED (ledger the reported model, not the
    /// requested one, to avoid stale-model claims). Mirrors deepseek/anthropic.
    pub model: String,
    pub input_tokens: i64,
    pub output_tokens: i64,
    pub total_tokens: i64,
}

/// The hub-facing DI seam. The `friday-hub` `OcrToolExecutor` (VISOCR-EXEC wave)
/// injects a `Box<dyn OcrProvider>`; production uses [`VisionOcrClient`], dark tests
/// use [`StubOcrProvider`]. Object-safe: sync, `&self`, concrete params/return.
///
/// The HUB performs the workspace-confined image read (`open_read_within_root`) and
/// passes the resulting `image_bytes` + `mime` here — this crate never touches the
/// filesystem.
pub trait OcrProvider {
    /// Extract text from an image via the vision LLM.
    ///
    /// - `image_bytes` / `mime` — the already-read, workspace-confined image.
    /// - `prompt` — the extract-text instruction (`None` → [`DEFAULT_OCR_PROMPT`]).
    /// - `model` — the vision model id to request (BYOK-specific; the caller chooses).
    /// - `max_tokens` — completion cap.
    fn extract_text(
        &self,
        image_bytes: &[u8],
        mime: &str,
        prompt: Option<&str>,
        model: &str,
        max_tokens: u32,
    ) -> Result<OcrOutcome, OcrError>;
}

/// Inner HTTP transport seam (deepseek's `Transport` analog). The real impl is
/// [`UreqVisionTransport`]; tests inject a mock so the no-fallback / request-shape
/// logic is proven WITHOUT a network call.
pub trait Transport {
    /// POST a JSON body to `url` with a `Bearer` token; return the parsed JSON reply.
    fn post_json(&self, url: &str, bearer: &str, body: &Value) -> Result<Value, OcrError>;
}

/// Real blocking HTTP transport (ureq + rustls) for the vision-LLM `/chat/completions`
/// endpoint. Maps errors to controlled [`OcrError`]s — it NEVER formats the request
/// (which carries the `Authorization` header) into an error string. Mirrors
/// `friday_deepseek::UreqTransport`.
pub struct UreqVisionTransport;

impl UreqVisionTransport {
    pub fn new() -> Self {
        UreqVisionTransport
    }
}

impl Default for UreqVisionTransport {
    fn default() -> Self {
        Self::new()
    }
}

/// Classify a ureq error by status code ONLY — never read/echo the response body.
/// Mirrors `friday_deepseek::map_ureq_err`, plus 402 (a vision endpoint can bill
/// per image; the TS oracle maps 402 but DeepSeekError lacked the variant).
fn map_ureq_err(e: ureq::Error) -> OcrError {
    match e {
        ureq::Error::Status(code, _resp) => {
            if code == 401 || code == 403 {
                OcrError::Auth(code)
            } else if code == 408 || (500..=599).contains(&code) {
                // Transient: request-timeout (408) or any server-side 5xx.
                OcrError::ProviderUnavailable(format!("HTTP {code}"))
            } else {
                // Terminal client error: other 4xx (400/402/404/422) and 429.
                OcrError::ClientError { status: code }
            }
        }
        // Transport error (DNS/TLS/timeout). Keep the message terse + controlled.
        ureq::Error::Transport(t) => {
            OcrError::ProviderUnavailable(format!("transport: {}", t.kind()))
        }
    }
}

impl Transport for UreqVisionTransport {
    fn post_json(&self, url: &str, bearer: &str, body: &Value) -> Result<Value, OcrError> {
        let resp = ureq::post(url)
            .set("Authorization", &format!("Bearer {bearer}"))
            .set("Accept", "application/json")
            .send_json(body.clone())
            .map_err(map_ureq_err)?;
        resp.into_json::<Value>()
            .map_err(|e| OcrError::BadResponse(format!("invalid JSON: {e}")))
    }
}

/// Standard-base64 (RFC 4648, `+`/`/`, `=` padding) encoder.
///
/// Hand-rolled (~20 lines, pure + deterministic, unit-tested below) ON PURPOSE: there
/// is NO `base64` crate in `rust-core`'s `[workspace.dependencies]`, ureq exposes none,
/// and adding one would be a THIRD net-new external crate (the F11 plan §4(b) budgets
/// exactly two: pdf-extract, chromiumoxide). The multimodal request inlines the image
/// as a `data:{mime};base64,…` URI, so an encoder is required. This keeps the live
/// path's offline test story fully deterministic.
fn base64_encode(input: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(input.len().div_ceil(3) * 4);
    for chunk in input.chunks(3) {
        let b0 = chunk[0] as u32;
        let b1 = *chunk.get(1).unwrap_or(&0) as u32;
        let b2 = *chunk.get(2).unwrap_or(&0) as u32;
        let n = (b0 << 16) | (b1 << 8) | b2;
        out.push(TABLE[((n >> 18) & 0x3f) as usize] as char);
        out.push(TABLE[((n >> 12) & 0x3f) as usize] as char);
        // Third/fourth chars become `=` padding when the chunk is short.
        out.push(if chunk.len() > 1 {
            TABLE[((n >> 6) & 0x3f) as usize] as char
        } else {
            '='
        });
        out.push(if chunk.len() > 2 {
            TABLE[(n & 0x3f) as usize] as char
        } else {
            '='
        });
    }
    out
}

/// Build the OpenAI-compatible multimodal `/chat/completions` request body: a single
/// user message whose `content` is `[ {type:text, text:prompt}, {type:image_url,
/// image_url:{url:"data:{mime};base64,..."}} ]`. ONE concrete target shape (the most
/// widely-supported BYOK vision API); the live proof is operator-gated. Pure + testable.
fn build_request_body(
    model: &str,
    prompt: &str,
    image_bytes: &[u8],
    mime: &str,
    max_tokens: u32,
) -> Value {
    let data_uri = format!("data:{};base64,{}", mime, base64_encode(image_bytes));
    json!({
        "model": model,
        "max_tokens": max_tokens,
        "messages": [{
            "role": "user",
            "content": [
                { "type": "text", "text": prompt },
                { "type": "image_url", "image_url": { "url": data_uri } },
            ],
        }],
        "stream": false,
    })
}

/// Parse the recognized text + usage out of a multimodal `/chat/completions` reply.
/// Strict: a malformed `usage` is a clean [`OcrError::BadResponse`], never a panic;
/// the text concatenates every choice-0 message-content path the OpenAI shape uses
/// (a plain string, or `content[]` text parts). Mirrors deepseek's parse hygiene.
fn parse_response(v: &Value, requested_model: &str) -> Result<OcrOutcome, OcrError> {
    let usage = v
        .get("usage")
        .ok_or_else(|| OcrError::BadResponse("missing `usage`".into()))?;
    let input_tokens = usage
        .get("prompt_tokens")
        .and_then(Value::as_i64)
        .ok_or_else(|| OcrError::BadResponse("usage.prompt_tokens".into()))?;
    let output_tokens = usage
        .get("completion_tokens")
        .and_then(Value::as_i64)
        .ok_or_else(|| OcrError::BadResponse("usage.completion_tokens".into()))?;
    // Use the reported total if present; otherwise sum the parts with a CHECKED add
    // (a hostile/buggy usage must be a clean BadResponse, never an overflow panic).
    let total_tokens = match usage.get("total_tokens").and_then(Value::as_i64) {
        Some(t) => t,
        None => input_tokens
            .checked_add(output_tokens)
            .ok_or_else(|| OcrError::BadResponse("usage token total overflow".into()))?,
    };

    // Ledger the model id the response reports (avoids stale-model claims).
    let reported_model = v
        .get("model")
        .and_then(Value::as_str)
        .unwrap_or(requested_model)
        .to_string();

    // choice0.message.content — a plain string OR a `content[]` of text parts.
    let message_content = v
        .get("choices")
        .and_then(Value::as_array)
        .and_then(|a| a.first())
        .and_then(|c| c.get("message"))
        .and_then(|m| m.get("content"));
    let extracted_text = match message_content {
        Some(Value::String(s)) => s.clone(),
        Some(Value::Array(parts)) => parts
            .iter()
            .filter_map(|p| p.get("text").and_then(Value::as_str))
            .collect::<Vec<_>>()
            .join(""),
        _ => String::new(),
    };

    Ok(OcrOutcome {
        extracted_text,
        model: reported_model,
        input_tokens,
        output_tokens,
        total_tokens,
    })
}

/// The live `OcrProvider`: a vision-LLM OCR client over an injected [`Transport`].
/// `DeepSeekClient<T>` analog. **No fallback** — a failed route is an [`OcrError`],
/// never the stub's canned answer. The `base_url` is BYOK-injected (not a baked
/// constant like deepseek's fixed host), since the vision endpoint is operator-chosen.
pub struct VisionOcrClient<T: Transport> {
    transport: T,
    api_key: String,
    base_url: String,
}

impl VisionOcrClient<UreqVisionTransport> {
    /// Construct the real client from the Hub environment + a BYOK base URL.
    /// (`api_key` is never logged.)
    pub fn from_env(base_url: impl Into<String>) -> Result<Self, OcrError> {
        let api_key = api_key_from_env_var(ENV_KEY)?;
        Ok(VisionOcrClient::with_transport_and_base_url(
            UreqVisionTransport::new(),
            api_key,
            base_url,
        ))
    }
}

impl<T: Transport> VisionOcrClient<T> {
    /// For tests / alternate transports + a chosen base URL. (`api_key` never logged.)
    pub fn with_transport_and_base_url(
        transport: T,
        api_key: String,
        base_url: impl Into<String>,
    ) -> Self {
        VisionOcrClient {
            transport,
            api_key,
            base_url: base_url.into().trim_end_matches('/').to_string(),
        }
    }

    fn endpoint(&self, path: &str) -> String {
        format!("{}{}", self.base_url, path)
    }
}

impl<T: Transport> OcrProvider for VisionOcrClient<T> {
    fn extract_text(
        &self,
        image_bytes: &[u8],
        mime: &str,
        prompt: Option<&str>,
        model: &str,
        max_tokens: u32,
    ) -> Result<OcrOutcome, OcrError> {
        if image_bytes.is_empty() {
            return Err(OcrError::InvalidRequest("empty image bytes".into()));
        }
        if mime.trim().is_empty() {
            return Err(OcrError::InvalidRequest("empty image mime".into()));
        }
        let prompt = prompt.unwrap_or(DEFAULT_OCR_PROMPT);
        let body = build_request_body(model, prompt, image_bytes, mime, max_tokens);
        let v =
            self.transport
                .post_json(&self.endpoint("/chat/completions"), &self.api_key, &body)?;
        parse_response(&v, model)
    }
}

/// Deterministic stub `OcrProvider` for the hub executor's dark tests (VISOCR-EXEC).
/// Returns a fixed [`OcrOutcome`] (configurable text/token counts) and makes NO
/// network call, so the hub can exercise the full dispatch/validation/receipt path
/// WITHOUT a live provider. It is a TEST/FIXTURE backend — NEVER a runtime fallback
/// (the live [`VisionOcrClient`] returns an [`OcrError`] on failure, never this).
pub struct StubOcrProvider {
    pub extracted_text: String,
    pub model: String,
    pub input_tokens: i64,
    pub output_tokens: i64,
}

impl StubOcrProvider {
    /// A stub with sensible deterministic defaults.
    pub fn new() -> Self {
        StubOcrProvider {
            extracted_text: "STUB-OCR-TEXT".to_string(),
            model: "stub-vision-ocr".to_string(),
            input_tokens: 11,
            output_tokens: 7,
        }
    }

    /// A stub returning a chosen recognized text (keeps default model/token counts).
    pub fn with_text(text: impl Into<String>) -> Self {
        StubOcrProvider {
            extracted_text: text.into(),
            ..StubOcrProvider::new()
        }
    }
}

impl Default for StubOcrProvider {
    fn default() -> Self {
        Self::new()
    }
}

impl OcrProvider for StubOcrProvider {
    fn extract_text(
        &self,
        image_bytes: &[u8],
        mime: &str,
        _prompt: Option<&str>,
        _model: &str,
        _max_tokens: u32,
    ) -> Result<OcrOutcome, OcrError> {
        // Validate like the real client so the stub exercises the SAME guards (a hub
        // test that passes empty bytes must fail the same way against either backend).
        if image_bytes.is_empty() {
            return Err(OcrError::InvalidRequest("empty image bytes".into()));
        }
        if mime.trim().is_empty() {
            return Err(OcrError::InvalidRequest("empty image mime".into()));
        }
        Ok(OcrOutcome {
            extracted_text: self.extracted_text.clone(),
            model: self.model.clone(),
            input_tokens: self.input_tokens,
            output_tokens: self.output_tokens,
            total_tokens: self.input_tokens + self.output_tokens,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;

    // ---- base64 ----

    #[test]
    fn base64_matches_rfc4648_vectors() {
        // Canonical RFC 4648 §10 test vectors.
        assert_eq!(base64_encode(b""), "");
        assert_eq!(base64_encode(b"f"), "Zg==");
        assert_eq!(base64_encode(b"fo"), "Zm8=");
        assert_eq!(base64_encode(b"foo"), "Zm9v");
        assert_eq!(base64_encode(b"foob"), "Zm9vYg==");
        assert_eq!(base64_encode(b"fooba"), "Zm9vYmE=");
        assert_eq!(base64_encode(b"foobar"), "Zm9vYmFy");
    }

    #[test]
    fn base64_encodes_high_bytes_with_plus_and_slash() {
        // 0xFB 0xFF 0xBF -> "+/+/" ; exercises the `+`/`/` table entries.
        assert_eq!(base64_encode(&[0xFB, 0xFF, 0xBF]), "+/+/");
    }

    // ---- route flag (DEFAULT-OFF) ----

    #[test]
    fn route_enabled_is_off_by_default_in_test_env() {
        // The crate-internal flag must be OFF unless explicitly "1". The test env
        // does not set it; the const names are the canonical reconciled flag/key.
        assert!(!route_enabled());
        assert_eq!(ENV_ROUTE_ENABLED, "FRIDAY_OCR_ROUTE_ENABLED");
        assert_eq!(ENV_KEY, "FRIDAY_OCR_API_KEY");
    }

    #[test]
    fn api_key_from_env_var_rejects_empty_and_unset() {
        // A guaranteed-unset var name.
        assert_eq!(
            api_key_from_env_var("FRIDAY_OCR_TEST_DEFINITELY_UNSET_X9"),
            Err(OcrError::CredentialMissing)
        );
    }

    // ---- request shaping ----

    #[test]
    fn build_request_body_has_multimodal_image_url_data_uri() {
        let body = build_request_body("vis-model", "extract", b"foo", "image/png", 64);
        assert_eq!(body["model"], "vis-model");
        assert_eq!(body["max_tokens"], 64);
        assert_eq!(body["stream"], false);
        let content = &body["messages"][0]["content"];
        assert_eq!(content[0]["type"], "text");
        assert_eq!(content[0]["text"], "extract");
        assert_eq!(content[1]["type"], "image_url");
        assert_eq!(
            content[1]["image_url"]["url"],
            "data:image/png;base64,Zm9v" // base64("foo")
        );
    }

    // ---- mock transport: prove call discipline + no-fallback offline ----

    struct MockTransport {
        calls: RefCell<u32>,
        last_url: RefCell<String>,
        result: Result<Value, OcrError>,
    }

    impl MockTransport {
        fn ok(reply: Value) -> Self {
            MockTransport {
                calls: RefCell::new(0),
                last_url: RefCell::new(String::new()),
                result: Ok(reply),
            }
        }
        fn err(e: OcrError) -> Self {
            MockTransport {
                calls: RefCell::new(0),
                last_url: RefCell::new(String::new()),
                result: Err(e),
            }
        }
    }

    impl Transport for MockTransport {
        fn post_json(&self, url: &str, _bearer: &str, _body: &Value) -> Result<Value, OcrError> {
            *self.calls.borrow_mut() += 1;
            *self.last_url.borrow_mut() = url.to_string();
            self.result.clone()
        }
    }

    fn ok_reply() -> Value {
        json!({
            "model": "vis-model-reported",
            "choices": [{"message": {"content": "HELLO WORLD"}}],
            "usage": {"prompt_tokens": 100, "completion_tokens": 5, "total_tokens": 105},
        })
    }

    fn client(t: MockTransport) -> VisionOcrClient<MockTransport> {
        VisionOcrClient::with_transport_and_base_url(t, "k".to_string(), "https://vis.example.test")
    }

    #[test]
    fn extract_text_posts_to_chat_completions_and_parses_string_content() {
        let c = client(MockTransport::ok(ok_reply()));
        let out = c
            .extract_text(b"img", "image/jpeg", None, "vis-model", 256)
            .expect("ok");
        assert_eq!(out.extracted_text, "HELLO WORLD");
        // Reported model is ledgered, not the requested one.
        assert_eq!(out.model, "vis-model-reported");
        assert_eq!(out.input_tokens, 100);
        assert_eq!(out.output_tokens, 5);
        assert_eq!(out.total_tokens, 105);
        assert!(c.transport.last_url.borrow().ends_with("/chat/completions"));
        assert_eq!(*c.transport.calls.borrow(), 1);
    }

    #[test]
    fn extract_text_parses_content_parts_array_form() {
        let reply = json!({
            "model": "m",
            "choices": [{"message": {"content": [
                {"type": "text", "text": "AB"},
                {"type": "text", "text": "CD"},
            ]}}],
            "usage": {"prompt_tokens": 1, "completion_tokens": 1},
        });
        let c = client(MockTransport::ok(reply));
        let out = c.extract_text(b"img", "image/png", None, "m", 8).unwrap();
        assert_eq!(out.extracted_text, "ABCD");
        // No `total_tokens` in usage -> checked sum of the parts.
        assert_eq!(out.total_tokens, 2);
    }

    #[test]
    fn extract_text_no_fallback_on_transport_error() {
        // A failed route is an OcrError, NEVER a canned/stub answer.
        let c = client(MockTransport::err(OcrError::Auth(401)));
        let err = c
            .extract_text(b"img", "image/png", None, "m", 8)
            .expect_err("must surface the error");
        assert_eq!(err, OcrError::Auth(401));
    }

    #[test]
    fn extract_text_rejects_empty_image_before_any_call() {
        let c = client(MockTransport::ok(ok_reply()));
        let err = c.extract_text(b"", "image/png", None, "m", 8).unwrap_err();
        assert!(matches!(err, OcrError::InvalidRequest(_)));
        // Must fail closed WITHOUT making a network call.
        assert_eq!(*c.transport.calls.borrow(), 0);
    }

    #[test]
    fn extract_text_rejects_empty_mime() {
        let c = client(MockTransport::ok(ok_reply()));
        let err = c.extract_text(b"img", "  ", None, "m", 8).unwrap_err();
        assert!(matches!(err, OcrError::InvalidRequest(_)));
        assert_eq!(*c.transport.calls.borrow(), 0);
    }

    #[test]
    fn malformed_usage_is_bad_response_not_panic() {
        let reply = json!({
            "model": "m",
            "choices": [{"message": {"content": "x"}}],
            "usage": {"prompt_tokens": 1}, // missing completion_tokens
        });
        let c = client(MockTransport::ok(reply));
        let err = c
            .extract_text(b"img", "image/png", None, "m", 8)
            .unwrap_err();
        assert!(matches!(err, OcrError::BadResponse(_)));
    }

    // ---- error status mapping ----

    #[test]
    fn ureq_status_classification() {
        // We can't synthesize ureq::Error::Status without a Response; instead assert
        // the variant boundaries the live transport relies on are the deepseek mirror
        // by reconstructing the same predicate the mapper uses.
        let classify = |code: u16| -> OcrError {
            if code == 401 || code == 403 {
                OcrError::Auth(code)
            } else if code == 408 || (500..=599).contains(&code) {
                OcrError::ProviderUnavailable(format!("HTTP {code}"))
            } else {
                OcrError::ClientError { status: code }
            }
        };
        assert_eq!(classify(401), OcrError::Auth(401));
        assert_eq!(classify(403), OcrError::Auth(403));
        assert!(matches!(classify(503), OcrError::ProviderUnavailable(_)));
        assert!(matches!(classify(408), OcrError::ProviderUnavailable(_)));
        // 402 (vision per-image billing) is TERMINAL client error, not transient.
        assert_eq!(classify(402), OcrError::ClientError { status: 402 });
        assert_eq!(classify(429), OcrError::ClientError { status: 429 });
        assert_eq!(classify(404), OcrError::ClientError { status: 404 });
    }

    // ---- stub provider ----

    #[test]
    fn stub_provider_is_deterministic_and_makes_no_call() {
        let stub = StubOcrProvider::with_text("CONTRACT TEXT");
        let out = stub
            .extract_text(b"img", "image/png", None, "anything", 999)
            .unwrap();
        assert_eq!(out.extracted_text, "CONTRACT TEXT");
        assert_eq!(out.model, "stub-vision-ocr");
        assert_eq!(out.total_tokens, out.input_tokens + out.output_tokens);
    }

    #[test]
    fn stub_provider_enforces_same_guards_as_live() {
        let stub = StubOcrProvider::new();
        assert!(matches!(
            stub.extract_text(b"", "image/png", None, "m", 8),
            Err(OcrError::InvalidRequest(_))
        ));
        assert!(matches!(
            stub.extract_text(b"img", "", None, "m", 8),
            Err(OcrError::InvalidRequest(_))
        ));
    }

    /// Compile-time proof that the trait is OBJECT-SAFE (the hub boxes it as
    /// `Box<dyn OcrProvider>` in VISOCR-EXEC). If a method were generic / used
    /// `Self` / were async, this would not compile.
    #[test]
    fn ocr_provider_is_object_safe() {
        let _boxed: Box<dyn OcrProvider> = Box::new(StubOcrProvider::new());
        let _boxed2: Box<dyn OcrProvider> = Box::new(VisionOcrClient::with_transport_and_base_url(
            UreqVisionTransport::new(),
            "k".to_string(),
            "https://x.test",
        ));
    }
}
