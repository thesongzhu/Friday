//! Friday F11 / L2-3 vision (`image_analysis`) capability — the model-call seam.
//!
//! This crate carries the [`VisionModelClient`] DI trait (the seam the friday-hub
//! `VisionExecutor` delegates to after it has VALIDATED + ACQUIRED the image bytes), real
//! Claude/Anthropic and OpenAI-compatible vision impls ([`ClaudeVisionClient`] and
//! [`OpenAiCompatibleVisionClient`]), and a deterministic test stub ([`StubVisionClient`]).
//! The image ACQUISITION + VALIDATION (workspace-root scoping, SSRF on
//! URL images, data-uri caps, count/size bounds) lives in the friday-hub `VisionExecutor` —
//! NOT here. This crate receives ALREADY-VALIDATED, already-base64 image payloads + a prompt
//! and turns them into ONE provider call.
//!
//! ## Why Claude (and the DeepSeek gap)
//! Image input is a native capability of the Anthropic Messages API: a `user` message whose
//! `content` is an array of `{"type":"image","source":{"type":"base64","media_type":..,"data":..}}`
//! block(s) followed by a `{"type":"text","text":..}` block. Friday already wires the
//! Claude/Anthropic route (`friday-anthropic`, S7) with an audited ureq transport + the
//! `FRIDAY_ANTHROPIC_API_KEY` reader — so the real vision client REUSES that transport surface
//! (one audited Claude egress path) and just shapes the image-bearing request itself.
//!
//! DeepSeek (`friday-deepseek`, the default brain) exposes a TEXT chat-completions route only;
//! the Friday DeepSeek crate has NO image-input message shape, and the public DeepSeek
//! chat-completions API Friday targets is not a vision endpoint. Friday therefore keeps Claude as
//! the default runtime path, while B5 adds an OpenAI-compatible Responses-API vision seam that can
//! be selected explicitly by the Hub. The tool is still DARK (flipping `FRIDAY_VISION_ENABLED`
//! live is operator-gated on provider + token cost).
//!
//! ## The `detail` field — TS-parity, forwarded only by OpenAI-compatible vision
//! The TS oracle's `image_analysis` tool has a `detail` param ("low"/"high"/"auto"), which is an
//! OpenAI-vision concept. The Anthropic Messages API image block has NO `detail` field. So the
//! detail value is carried through [`VisionRequest::detail`] for schema parity + surfaced in the
//! request (and the executor validates it). The Claude impl does NOT send it to the API (sending
//! an unknown field would 400); the OpenAI-compatible impl forwards it on each `input_image`.

use base64::Engine as _;
use friday_anthropic::{api_key_from_env_var, Transport, UreqTransport};
use serde_json::{json, Value};
use std::collections::BTreeMap;

/// Hub env var for the OpenAI-compatible vision key. The value is read only by the Hub-side
/// runtime client and is never logged or exposed.
pub const OPENAI_VISION_ENV_KEY: &str = "OPENAI_API_KEY";

/// Optional provider selector consumed by friday-hub's runtime vision client. Absent/anything
/// else keeps the existing Claude default; exactly `openai` selects the OpenAI-compatible seam.
pub const VISION_PROVIDER_ENV_KEY: &str = "FRIDAY_VISION_PROVIDER";

/// Default OpenAI-compatible base URL.
pub const DEFAULT_OPENAI_BASE_URL: &str = "https://api.openai.com";

/// Optional OpenAI-compatible base URL override for tests/self-hosted compatible endpoints.
pub const OPENAI_BASE_URL_ENV_KEY: &str = "FRIDAY_OPENAI_BASE_URL";

/// Default OpenAI-compatible vision model when the caller pins none.
pub const DEFAULT_OPENAI_VISION_MODEL: &str = "gpt-5.5";

/// Default Claude vision model when the caller pins none. Current Claude model
/// (`claude-opus-4-8`) — vision-capable. The route/caller may override via [`VisionRequest::model`].
pub const DEFAULT_VISION_MODEL: &str = "claude-opus-4-8";

/// Default max output tokens for a vision completion when the caller pins none. The Anthropic
/// Messages API REQUIRES `max_tokens`; this is the analysis-sized default.
pub const DEFAULT_MAX_TOKENS: u32 = 1024;

/// The allowed image media types (parity with the Anthropic Messages API's documented image
/// formats). The friday-hub `VisionExecutor` validates against this set BEFORE constructing a
/// [`VisionImage`]; the client re-checks nothing (it trusts validated input) but the set is
/// `pub` so the executor and the client agree on one source of truth.
pub const ALLOWED_MEDIA_TYPES: &[&str] = &["image/jpeg", "image/png", "image/gif", "image/webp"];

/// One validated, ready-to-send image: a base64-encoded payload + its media type. The bytes
/// have ALREADY passed the friday-hub `VisionExecutor`'s acquisition + validation (workspace
/// scope / SSRF / data-uri caps / size bound) — this type is the post-validation hand-off.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct VisionImage {
    /// One of [`ALLOWED_MEDIA_TYPES`] (validated by the executor).
    pub media_type: String,
    /// The image payload, base64-encoded (the exact string sent as the Messages-API
    /// `source.data`). For a caller data-uri this is the original base64 (validated, not
    /// re-encoded); for a workspace/URL image it is base64 of the validated bytes.
    pub base64_data: String,
}

/// A validated vision request: the prompt + the validated images + the optional model / detail /
/// max_tokens. Built by the friday-hub `VisionExecutor` and handed to a [`VisionModelClient`].
#[derive(Clone, Debug)]
pub struct VisionRequest {
    /// The analysis prompt (required upstream; never empty by the time it reaches here).
    pub prompt: String,
    /// 1+ validated images (the executor bounds the count + total size).
    pub images: Vec<VisionImage>,
    /// Optional model override; `None` ⇒ [`DEFAULT_VISION_MODEL`].
    pub model: Option<String>,
    /// Optional OpenAI-style detail ("low"/"high"/"auto"). The Claude impl does NOT forward it
    /// (Anthropic has no image `detail` field); OpenAI-compatible vision forwards it.
    pub detail: Option<String>,
    /// Optional max output tokens; `None` ⇒ [`DEFAULT_MAX_TOKENS`].
    pub max_tokens: Option<u32>,
}

/// The result of a vision completion (the bits the tool surfaces / a later ledger records).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct VisionOutcome {
    /// The model's analysis text (concatenated `content[]` text blocks).
    pub analysis: String,
    /// The model id the response reported (avoid stale-model claims).
    pub model: String,
    /// Number of images analyzed (echoed for the tool receipt / TS-parity `imageCount`).
    pub image_count: usize,
    /// Prompt-token equivalent (`usage.input_tokens`), when the provider reports it.
    pub input_tokens: Option<i64>,
    /// Completion-token equivalent (`usage.output_tokens`), when the provider reports it.
    pub output_tokens: Option<i64>,
}

/// Why a vision model call failed. A missing credential is a fail-closed BLOCKER (never a silent
/// substitute provider) — the executor surfaces it as a model-visible warning, parity with the
/// TS oracle's "no vision model configured" path.
#[derive(Debug, thiserror::Error)]
pub enum VisionError {
    /// The provider credential is unset/empty (`FRIDAY_ANTHROPIC_API_KEY`). Fail-closed.
    #[error("vision credential missing (env {0})")]
    CredentialMissing(&'static str),
    /// The provider rejected/failed the call (auth, transport, bad-response). Kind only — never
    /// a secret, never the raw body.
    #[error("vision provider error: {0}")]
    Provider(String),
    /// The request carried no images (defensive; the executor enforces >=1 upstream).
    #[error("vision request had no images")]
    NoImages,
}

/// The DI seam the friday-hub `VisionExecutor` delegates to. Takes a VALIDATED [`VisionRequest`]
/// (images already acquired + scoped + SSRF-checked + capped upstream) and returns the analysis
/// — or a fail-closed [`VisionError`] (NEVER a silent fallback to a different provider/model).
pub trait VisionModelClient {
    fn analyze(&self, request: &VisionRequest) -> Result<VisionOutcome, VisionError>;
}

// ── Real OpenAI-compatible Responses vision client ──

#[derive(Clone, Debug, PartialEq)]
pub struct OpenAiVisionHttpRequest {
    pub url: String,
    pub headers: BTreeMap<String, String>,
    pub body: Value,
}

#[derive(Clone, Debug, PartialEq)]
pub struct OpenAiVisionHttpResponse {
    pub status: u16,
    pub body: Value,
}

pub trait OpenAiVisionTransport {
    fn post_json(
        &self,
        request: &OpenAiVisionHttpRequest,
    ) -> Result<OpenAiVisionHttpResponse, VisionError>;
}

pub struct UreqOpenAiVisionTransport {
    agent: ureq::Agent,
}

impl UreqOpenAiVisionTransport {
    pub fn new() -> Self {
        Self {
            agent: ureq::AgentBuilder::new()
                .timeout(std::time::Duration::from_millis(
                    friday_anthropic::ANTHROPIC_REQUEST_TIMEOUT_MS,
                ))
                .build(),
        }
    }
}

impl Default for UreqOpenAiVisionTransport {
    fn default() -> Self {
        Self::new()
    }
}

impl OpenAiVisionTransport for UreqOpenAiVisionTransport {
    fn post_json(
        &self,
        request: &OpenAiVisionHttpRequest,
    ) -> Result<OpenAiVisionHttpResponse, VisionError> {
        let mut req = self.agent.post(&request.url);
        for (key, value) in &request.headers {
            req = req.set(key, value);
        }
        let resp = req
            .send_json(request.body.clone())
            .map_err(map_openai_ureq_err)?;
        let status = resp.status();
        let body = resp
            .into_json::<Value>()
            .map_err(|e| VisionError::Provider(format!("invalid JSON: {e}")))?;
        Ok(OpenAiVisionHttpResponse { status, body })
    }
}

fn map_openai_ureq_err(e: ureq::Error) -> VisionError {
    match e {
        ureq::Error::Status(code, _resp) => VisionError::Provider(format!("http status {code}")),
        ureq::Error::Transport(t) => VisionError::Provider(format!("transport: {}", t.kind())),
    }
}

/// OpenAI-compatible Responses-API vision client. It uses the same validated [`VisionRequest`]
/// seam as Claude, but shapes the body as `input_text` + one `input_image` per validated image.
pub struct OpenAiCompatibleVisionClient<T: OpenAiVisionTransport> {
    transport: T,
    api_key: Option<String>,
    base_url: String,
    default_model: String,
}

impl OpenAiCompatibleVisionClient<UreqOpenAiVisionTransport> {
    pub fn from_env() -> Result<Self, VisionError> {
        let api_key = std::env::var(OPENAI_VISION_ENV_KEY)
            .ok()
            .filter(|s| !s.trim().is_empty())
            .ok_or(VisionError::CredentialMissing(OPENAI_VISION_ENV_KEY))?;
        let base_url = std::env::var(OPENAI_BASE_URL_ENV_KEY)
            .ok()
            .filter(|s| !s.trim().is_empty())
            .unwrap_or_else(|| DEFAULT_OPENAI_BASE_URL.to_string());
        Ok(Self::new(
            UreqOpenAiVisionTransport::new(),
            base_url,
            Some(api_key),
        ))
    }
}

impl<T: OpenAiVisionTransport> OpenAiCompatibleVisionClient<T> {
    pub fn new(transport: T, base_url: impl Into<String>, api_key: Option<String>) -> Self {
        Self {
            transport,
            api_key,
            base_url: base_url.into().trim_end_matches('/').to_string(),
            default_model: DEFAULT_OPENAI_VISION_MODEL.to_string(),
        }
    }

    pub fn with_default_model(
        transport: T,
        base_url: impl Into<String>,
        api_key: Option<String>,
        default_model: impl Into<String>,
    ) -> Self {
        Self {
            transport,
            api_key,
            base_url: base_url.into().trim_end_matches('/').to_string(),
            default_model: default_model.into(),
        }
    }

    pub fn build_http_request(
        &self,
        request: &VisionRequest,
    ) -> Result<OpenAiVisionHttpRequest, VisionError> {
        if request.images.is_empty() {
            return Err(VisionError::NoImages);
        }
        let api_key = self
            .api_key
            .as_deref()
            .filter(|s| !s.trim().is_empty())
            .ok_or(VisionError::CredentialMissing(OPENAI_VISION_ENV_KEY))?;
        let model = request.model.as_deref().unwrap_or(&self.default_model);
        let max_output_tokens = request.max_tokens.unwrap_or(DEFAULT_MAX_TOKENS);
        let mut content = vec![json!({ "type": "input_text", "text": request.prompt })];
        for image in &request.images {
            let data_url = format!("data:{};base64,{}", image.media_type, image.base64_data);
            let mut image_obj = json!({ "type": "input_image", "image_url": data_url });
            if let Some(detail) = request.detail.as_deref().filter(|s| !s.trim().is_empty()) {
                image_obj["detail"] = json!(detail);
            }
            content.push(image_obj);
        }

        let mut headers = BTreeMap::new();
        headers.insert("Content-Type".to_string(), "application/json".to_string());
        headers.insert("Accept".to_string(), "application/json".to_string());
        headers.insert("Authorization".to_string(), format!("Bearer {api_key}"));
        Ok(OpenAiVisionHttpRequest {
            url: format!("{}/v1/responses", self.base_url),
            headers,
            body: json!({
                "model": model,
                "max_output_tokens": max_output_tokens,
                "input": [{
                    "role": "user",
                    "content": content
                }]
            }),
        })
    }
}

impl<T: OpenAiVisionTransport> VisionModelClient for OpenAiCompatibleVisionClient<T> {
    fn analyze(&self, request: &VisionRequest) -> Result<VisionOutcome, VisionError> {
        let model = request
            .model
            .as_deref()
            .unwrap_or(&self.default_model)
            .to_string();
        let http = self.build_http_request(request)?;
        let response = self.transport.post_json(&http)?;
        if !(200..=299).contains(&response.status) {
            return Err(VisionError::Provider(format!(
                "http status {}",
                response.status
            )));
        }
        let analysis = extract_openai_output_text(&response.body)?;
        let usage = response.body.get("usage");
        Ok(VisionOutcome {
            analysis,
            model: response
                .body
                .get("model")
                .and_then(Value::as_str)
                .unwrap_or(&model)
                .to_string(),
            image_count: request.images.len(),
            input_tokens: usage
                .and_then(|u| u.get("input_tokens"))
                .and_then(Value::as_i64),
            output_tokens: usage
                .and_then(|u| u.get("output_tokens"))
                .and_then(Value::as_i64),
        })
    }
}

fn extract_openai_output_text(body: &Value) -> Result<String, VisionError> {
    let text = body
        .get("output_text")
        .and_then(Value::as_str)
        .or_else(|| {
            body.pointer("/choices/0/message/content")
                .and_then(Value::as_str)
        })
        .or_else(|| {
            body.get("output")
                .and_then(Value::as_array)
                .and_then(|items| {
                    items.iter().find_map(|item| {
                        item.get("content")
                            .and_then(Value::as_array)
                            .and_then(|content| {
                                content.iter().find_map(|block| {
                                    block.get("text").and_then(Value::as_str).or_else(|| {
                                        block
                                            .get("type")
                                            .and_then(Value::as_str)
                                            .filter(|t| *t == "output_text")
                                            .and_then(|_| block.get("text").and_then(Value::as_str))
                                    })
                                })
                            })
                    })
                })
        })
        .map(str::trim)
        .filter(|text| !text.is_empty())
        .ok_or_else(|| VisionError::Provider("empty OpenAI vision output".to_string()))?;
    Ok(text.to_string())
}

// ── Real Claude/Anthropic vision client ──

/// A real Claude vision client over the shared friday-anthropic [`Transport`] seam. Constructed
/// from the Hub environment (`FRIDAY_ANTHROPIC_API_KEY`) and FAILS CLOSED if the key is
/// absent/empty (never a fallback). Builds a `POST /v1/messages` with an image-bearing user
/// message and parses the assistant text — the same endpoint + parsing shape as
/// `friday_anthropic::ClaudeClient::chat`, but with image content blocks the text-only `chat`
/// does not carry.
pub struct ClaudeVisionClient<T: Transport> {
    transport: T,
    api_key: String,
    base_url: String,
}

impl ClaudeVisionClient<UreqTransport> {
    /// Production constructor: real ureq transport + key from `FRIDAY_ANTHROPIC_API_KEY` + the
    /// fixed Anthropic base URL. FAILS CLOSED on a missing/empty key (no fallback).
    pub fn from_env() -> Result<Self, VisionError> {
        let api_key = api_key_from_env_var(friday_anthropic::ENV_KEY)
            .map_err(|_| VisionError::CredentialMissing(friday_anthropic::ENV_KEY))?;
        Ok(Self {
            transport: UreqTransport::new(),
            api_key,
            base_url: friday_anthropic::BASE_URL.to_string(),
        })
    }
}

impl<T: Transport> ClaudeVisionClient<T> {
    /// For tests / alternate transports (a mock that asserts the request shape without network).
    pub fn with_transport(transport: T, api_key: impl Into<String>) -> Self {
        Self {
            transport,
            api_key: api_key.into(),
            base_url: friday_anthropic::BASE_URL.to_string(),
        }
    }

    /// For tests that need the real transport against a local HTTP endpoint.
    pub fn with_transport_and_base_url(
        transport: T,
        api_key: impl Into<String>,
        base_url: impl Into<String>,
    ) -> Self {
        Self {
            transport,
            api_key: api_key.into(),
            base_url: base_url.into().trim_end_matches('/').to_string(),
        }
    }

    /// Build the Messages-API request body: a single `user` message whose `content` is the image
    /// block(s) followed by the prompt text block. `detail` is DELIBERATELY not included (no
    /// Anthropic image `detail` field — see the crate docs).
    fn build_body(&self, request: &VisionRequest) -> Value {
        let model = request.model.as_deref().unwrap_or(DEFAULT_VISION_MODEL);
        let max_tokens = request.max_tokens.unwrap_or(DEFAULT_MAX_TOKENS);
        let mut content: Vec<Value> = request
            .images
            .iter()
            .map(|img| {
                json!({
                    "type": "image",
                    "source": {
                        "type": "base64",
                        "media_type": img.media_type,
                        "data": img.base64_data,
                    }
                })
            })
            .collect();
        content.push(json!({ "type": "text", "text": request.prompt }));
        json!({
            "model": model,
            "max_tokens": max_tokens,
            "messages": [{ "role": "user", "content": content }],
        })
    }
}

impl<T: Transport> VisionModelClient for ClaudeVisionClient<T> {
    fn analyze(&self, request: &VisionRequest) -> Result<VisionOutcome, VisionError> {
        if request.images.is_empty() {
            return Err(VisionError::NoImages);
        }
        let body = self.build_body(request);
        let url = format!("{}/v1/messages", self.base_url);
        let v = self
            .transport
            .post_json(&url, &self.api_key, &body)
            .map_err(|e| VisionError::Provider(e.to_string()))?;

        // Concatenate every `type == "text"` content block (never index content[0]; a leading
        // non-text block or empty array must not panic). Mirrors friday_anthropic::chat parsing.
        let analysis = v
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
        let model = v
            .get("model")
            .and_then(Value::as_str)
            .unwrap_or_else(|| request.model.as_deref().unwrap_or(DEFAULT_VISION_MODEL))
            .to_string();
        let usage = v.get("usage");
        let input_tokens = usage
            .and_then(|u| u.get("input_tokens"))
            .and_then(Value::as_i64);
        let output_tokens = usage
            .and_then(|u| u.get("output_tokens"))
            .and_then(Value::as_i64);

        Ok(VisionOutcome {
            analysis,
            model,
            image_count: request.images.len(),
            input_tokens,
            output_tokens,
        })
    }
}

// ── Deterministic test stub ──

/// A deterministic, offline [`VisionModelClient`] for tests (and a no-network fallback if a
/// future caller wants a "vision unavailable" stub). NEVER hits the network. Returns a fixed
/// analysis string that echoes the prompt + image count, so an e2e test can assert the executor
/// validated + delegated without any real model/provider.
pub struct StubVisionClient {
    /// The model id to report (so a test can assert the reported model).
    pub model: String,
}

impl Default for StubVisionClient {
    fn default() -> Self {
        Self {
            model: "stub-vision-1".to_string(),
        }
    }
}

impl VisionModelClient for StubVisionClient {
    fn analyze(&self, request: &VisionRequest) -> Result<VisionOutcome, VisionError> {
        if request.images.is_empty() {
            return Err(VisionError::NoImages);
        }
        Ok(VisionOutcome {
            analysis: format!(
                "STUB-VISION: analyzed {} image(s) for prompt {:?}",
                request.images.len(),
                request.prompt
            ),
            model: self.model.clone(),
            image_count: request.images.len(),
            input_tokens: Some(0),
            output_tokens: Some(0),
        })
    }
}

/// Base64-encode raw image bytes into the Messages-API `source.data` string. The friday-hub
/// `VisionExecutor` uses this for workspace-path + URL images (a data-uri's base64 is passed
/// through unchanged). Standard base64 (no URL-safe alphabet) with padding — the alphabet
/// Anthropic's API expects.
pub fn encode_image_base64(bytes: &[u8]) -> String {
    base64::engine::general_purpose::STANDARD.encode(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;

    /// A mock transport that records the last request body and returns a canned response — proves
    /// (offline) the image-block request shape + the parsing, with NO network.
    struct MockTransport {
        last_body: RefCell<Option<Value>>,
        response: Value,
    }

    impl MockTransport {
        fn new(response: Value) -> Self {
            Self {
                last_body: RefCell::new(None),
                response,
            }
        }
    }

    impl Transport for MockTransport {
        fn post_json(
            &self,
            _url: &str,
            _key: &str,
            body: &Value,
        ) -> Result<Value, friday_anthropic::ClaudeError> {
            *self.last_body.borrow_mut() = Some(body.clone());
            Ok(self.response.clone())
        }
    }

    struct MockOpenAiTransport {
        last_request: RefCell<Option<OpenAiVisionHttpRequest>>,
        response: OpenAiVisionHttpResponse,
    }

    impl MockOpenAiTransport {
        fn new(response: OpenAiVisionHttpResponse) -> Self {
            Self {
                last_request: RefCell::new(None),
                response,
            }
        }
    }

    impl OpenAiVisionTransport for MockOpenAiTransport {
        fn post_json(
            &self,
            request: &OpenAiVisionHttpRequest,
        ) -> Result<OpenAiVisionHttpResponse, VisionError> {
            *self.last_request.borrow_mut() = Some(request.clone());
            Ok(self.response.clone())
        }
    }

    fn sample_request() -> VisionRequest {
        VisionRequest {
            prompt: "What is in this image?".to_string(),
            images: vec![VisionImage {
                media_type: "image/png".to_string(),
                base64_data: "aGVsbG8=".to_string(), // "hello"
            }],
            model: None,
            detail: Some("high".to_string()),
            max_tokens: None,
        }
    }

    fn messages_response() -> Value {
        json!({
            "id": "msg_x",
            "type": "message",
            "role": "assistant",
            "model": "claude-opus-4-8",
            "content": [{"type": "text", "text": "A cat."}],
            "stop_reason": "end_turn",
            "usage": {"input_tokens": 42, "output_tokens": 5}
        })
    }

    fn openai_response() -> OpenAiVisionHttpResponse {
        OpenAiVisionHttpResponse {
            status: 200,
            body: json!({
                "id": "resp_x",
                "model": "gpt-5.5",
                "output_text": "A blue chart.",
                "usage": {"input_tokens": 31, "output_tokens": 7}
            }),
        }
    }

    #[test]
    fn claude_client_builds_image_then_text_content_and_parses_analysis() {
        let mock = MockTransport::new(messages_response());
        let client = ClaudeVisionClient::with_transport(mock, "test-key-not-real");
        let out = client.analyze(&sample_request()).unwrap();

        assert_eq!(out.analysis, "A cat.");
        assert_eq!(out.model, "claude-opus-4-8");
        assert_eq!(out.image_count, 1);
        assert_eq!(out.input_tokens, Some(42));
        assert_eq!(out.output_tokens, Some(5));

        // Inspect the request body the transport saw: ONE user message whose content is an image
        // block (base64 source + media_type) THEN a text block; default model + max_tokens.
        let body = client.transport.last_body.borrow().clone().unwrap();
        assert_eq!(body["model"], DEFAULT_VISION_MODEL);
        assert_eq!(body["max_tokens"], DEFAULT_MAX_TOKENS);
        let content = body["messages"][0]["content"].as_array().unwrap();
        assert_eq!(content.len(), 2, "image block + text block");
        assert_eq!(content[0]["type"], "image");
        assert_eq!(content[0]["source"]["type"], "base64");
        assert_eq!(content[0]["source"]["media_type"], "image/png");
        assert_eq!(content[0]["source"]["data"], "aGVsbG8=");
        assert_eq!(content[1]["type"], "text");
        assert_eq!(content[1]["text"], "What is in this image?");
        // detail is TS-parity only — it MUST NOT appear in the Anthropic request (no such field).
        assert!(
            !body.to_string().contains("detail"),
            "detail must not be sent to the Anthropic API (no-op for Claude): {body}"
        );
    }

    #[test]
    fn openai_client_builds_responses_input_images_with_detail_and_parses_usage() {
        let mock = MockOpenAiTransport::new(openai_response());
        let client = OpenAiCompatibleVisionClient::new(
            mock,
            "https://openai.example",
            Some("sk-test".into()),
        );
        let out = client.analyze(&sample_request()).unwrap();

        assert_eq!(out.analysis, "A blue chart.");
        assert_eq!(out.model, "gpt-5.5");
        assert_eq!(out.image_count, 1);
        assert_eq!(out.input_tokens, Some(31));
        assert_eq!(out.output_tokens, Some(7));

        let req = client.transport.last_request.borrow().clone().unwrap();
        assert_eq!(req.url, "https://openai.example/v1/responses");
        assert_eq!(
            req.headers.get("Authorization").map(String::as_str),
            Some("Bearer sk-test")
        );
        assert_eq!(req.body["model"], DEFAULT_OPENAI_VISION_MODEL);
        assert_eq!(req.body["max_output_tokens"], DEFAULT_MAX_TOKENS);
        let content = req.body["input"][0]["content"].as_array().unwrap();
        assert_eq!(content.len(), 2, "input_text + input_image");
        assert_eq!(content[0]["type"], "input_text");
        assert_eq!(content[0]["text"], "What is in this image?");
        assert_eq!(content[1]["type"], "input_image");
        assert_eq!(content[1]["image_url"], "data:image/png;base64,aGVsbG8=");
        assert_eq!(content[1]["detail"], "high");
    }

    #[test]
    fn openai_client_multiple_images_each_get_data_url_and_detail() {
        let mock = MockOpenAiTransport::new(openai_response());
        let client = OpenAiCompatibleVisionClient::with_default_model(
            mock,
            "https://openai.example/",
            Some("sk-test".into()),
            "gpt-vision-test",
        );
        let mut req = sample_request();
        req.images.push(VisionImage {
            media_type: "image/jpeg".to_string(),
            base64_data: "d29ybGQ=".to_string(),
        });
        req.max_tokens = Some(256);
        let _ = client.analyze(&req).unwrap();
        let http = client.transport.last_request.borrow().clone().unwrap();
        assert_eq!(http.body["model"], "gpt-vision-test");
        assert_eq!(http.body["max_output_tokens"], 256);
        let content = http.body["input"][0]["content"].as_array().unwrap();
        assert_eq!(content.len(), 3, "input_text + 2 input_image blocks");
        assert_eq!(content[1]["image_url"], "data:image/png;base64,aGVsbG8=");
        assert_eq!(content[1]["detail"], "high");
        assert_eq!(content[2]["image_url"], "data:image/jpeg;base64,d29ybGQ=");
        assert_eq!(content[2]["detail"], "high");
    }

    #[test]
    fn openai_client_missing_key_fails_closed_before_transport() {
        let mock = MockOpenAiTransport::new(openai_response());
        let client = OpenAiCompatibleVisionClient::new(mock, "https://openai.example", None);
        let err = client.analyze(&sample_request()).unwrap_err();
        assert!(matches!(
            err,
            VisionError::CredentialMissing(OPENAI_VISION_ENV_KEY)
        ));
        assert!(client.transport.last_request.borrow().is_none());
    }

    #[test]
    fn openai_client_parses_nested_responses_output_text_shape() {
        let mock = MockOpenAiTransport::new(OpenAiVisionHttpResponse {
            status: 200,
            body: json!({
                "output": [{
                    "type": "message",
                    "content": [{"type": "output_text", "text": " nested text "}]
                }]
            }),
        });
        let client = OpenAiCompatibleVisionClient::new(
            mock,
            "https://openai.example",
            Some("sk-test".into()),
        );
        let out = client.analyze(&sample_request()).unwrap();
        assert_eq!(out.analysis, "nested text");
    }

    #[test]
    fn claude_client_honors_model_and_max_tokens_overrides() {
        let mock = MockTransport::new(messages_response());
        let client = ClaudeVisionClient::with_transport(mock, "k");
        let mut req = sample_request();
        req.model = Some("claude-sonnet-4-6".to_string());
        req.max_tokens = Some(256);
        let _ = client.analyze(&req).unwrap();
        let body = client.transport.last_body.borrow().clone().unwrap();
        assert_eq!(body["model"], "claude-sonnet-4-6");
        assert_eq!(body["max_tokens"], 256);
    }

    #[test]
    fn claude_client_multiple_images_all_precede_the_text_block() {
        let mock = MockTransport::new(messages_response());
        let client = ClaudeVisionClient::with_transport(mock, "k");
        let mut req = sample_request();
        req.images.push(VisionImage {
            media_type: "image/jpeg".to_string(),
            base64_data: "d29ybGQ=".to_string(),
        });
        let out = client.analyze(&req).unwrap();
        assert_eq!(out.image_count, 2);
        let body = client.transport.last_body.borrow().clone().unwrap();
        let content = body["messages"][0]["content"].as_array().unwrap();
        assert_eq!(content.len(), 3, "2 image blocks + 1 text block");
        assert_eq!(content[0]["type"], "image");
        assert_eq!(content[1]["type"], "image");
        assert_eq!(content[2]["type"], "text");
    }

    #[test]
    fn claude_client_no_images_is_an_error_not_an_empty_call() {
        let mock = MockTransport::new(messages_response());
        let client = ClaudeVisionClient::with_transport(mock, "k");
        let mut req = sample_request();
        req.images.clear();
        let err = client.analyze(&req).unwrap_err();
        assert!(matches!(err, VisionError::NoImages));
        // The transport must NOT have been called.
        assert!(client.transport.last_body.borrow().is_none());
    }

    #[test]
    fn from_env_reads_the_anthropic_key_and_fails_closed_when_absent() {
        // api_key_from_env_var (which from_env uses) maps an unset/empty var to an error, never a
        // fallback. Probe a guaranteed-unset var name so this is independent of the ambient env.
        let err = api_key_from_env_var("FRIDAY_ANTHROPIC_API_KEY_VISION_UNSET_zz9");
        assert!(
            err.is_err(),
            "an unset key must be an error, never a fallback"
        );
    }

    #[test]
    fn stub_client_is_deterministic_and_offline() {
        let stub = StubVisionClient::default();
        let out = stub.analyze(&sample_request()).unwrap();
        assert!(out.analysis.contains("STUB-VISION"));
        assert!(out.analysis.contains("1 image"));
        assert_eq!(out.model, "stub-vision-1");
        assert_eq!(out.image_count, 1);
    }

    #[test]
    fn stub_client_no_images_errors() {
        let stub = StubVisionClient::default();
        let mut req = sample_request();
        req.images.clear();
        assert!(matches!(
            stub.analyze(&req).unwrap_err(),
            VisionError::NoImages
        ));
    }

    #[test]
    fn claude_vision_real_transport_bounds_a_hung_request_with_a_wall_clock_timeout() {
        // (#24b degrade-4, hardening) The vision client REUSES the friday-anthropic UreqTransport,
        // so the same wall-clock bound that protects `ClaudeClient::chat` protects vision: a server
        // that ACCEPTS but never replies must NOT wedge the call forever. We point the REAL
        // transport (short 250ms timeout) at a hung localhost server and assert the call returns a
        // VisionError::Provider (the mapped transient ProviderUnavailable) well within a second —
        // never hanging past the crash-recovery staleness threshold.
        use std::io::Read as _;
        use std::net::TcpListener;
        use std::thread;

        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        let handle = thread::spawn(move || {
            if let Ok((mut stream, _)) = listener.accept() {
                let mut req = [0u8; 2048];
                let _ = stream.read(&mut req);
                std::thread::sleep(std::time::Duration::from_millis(2_000));
            }
        });
        let client = ClaudeVisionClient::with_transport_and_base_url(
            UreqTransport::with_timeout_ms(250),
            "test-key-not-real",
            format!("http://{addr}"),
        );
        let start = std::time::Instant::now();
        let err = client.analyze(&sample_request()).unwrap_err();
        let elapsed = start.elapsed();
        let _ = handle.join();
        assert!(
            elapsed < std::time::Duration::from_millis(1_500),
            "the timeout must bound the vision call; took {elapsed:?}"
        );
        assert!(
            matches!(err, VisionError::Provider(_)),
            "a timed-out vision call maps to a provider error, got {err:?}"
        );
    }

    #[test]
    fn encode_image_base64_round_trips_standard_alphabet() {
        let bytes = b"\x00\x01\x02\xff\xfe binary image bytes";
        let encoded = encode_image_base64(bytes);
        let decoded = base64::engine::general_purpose::STANDARD
            .decode(&encoded)
            .unwrap();
        assert_eq!(decoded, bytes);
    }
}
