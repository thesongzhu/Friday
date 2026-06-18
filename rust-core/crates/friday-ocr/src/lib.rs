//! Friday F11 / B5 OCR capability — the provider-call seam.
//!
//! This crate is deliberately Hub-side and DARK: it defines the [`OcrProvider`]
//! DI trait, an OpenAI-compatible vision request shaper, a fail-closed
//! [`UnavailableOcrProvider`] default, and a deterministic [`StubOcrProvider`]
//! for functional KATs. It does not register a Hub tool, flip a prod flag, read
//! an operator key, or execute a live provider call by itself.
//!
//! The owning `friday-hub` executor can later validate/govern a tool request and
//! inject a real transport. Until then this crate is a non-live build-DARK seam:
//! flag-OFF behavior is unchanged, while flag-ON tests can prove non-stub
//! request construction and fail-closed behavior without network or secrets.

use serde_json::{json, Value};
use std::collections::BTreeMap;

pub const DEFAULT_OPENAI_OCR_MODEL: &str = "gpt-4o-mini";
pub const DEFAULT_OCR_PROMPT: &str =
    "Extract readable text from this image. Return only the text you can see.";
pub const DEFAULT_MAX_IMAGE_BYTES: usize = 10 * 1024 * 1024;
pub const DEFAULT_MAX_OUTPUT_CHARS: usize = 16 * 1024;
pub const MAX_ALLOWED_OUTPUT_CHARS: usize = 64 * 1024;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum OcrImageFormat {
    Png,
    Jpeg,
    Webp,
}

impl OcrImageFormat {
    pub fn mime_type(self) -> &'static str {
        match self {
            Self::Png => "image/png",
            Self::Jpeg => "image/jpeg",
            Self::Webp => "image/webp",
        }
    }
}

#[derive(Clone, Debug)]
pub struct OcrRequest {
    pub image: Vec<u8>,
    pub format: OcrImageFormat,
    pub prompt: Option<String>,
    pub model: Option<String>,
    pub max_output_chars: Option<usize>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct OcrOutcome {
    pub text: String,
    pub model: String,
}

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum OcrError {
    #[error("ocr image is required")]
    EmptyImage,
    #[error("ocr image exceeds {max} bytes (got {got})")]
    ImageTooLarge { got: usize, max: usize },
    #[error("ocr output character limit must be between 1 and {max} (got {got})")]
    InvalidOutputLimit { got: usize, max: usize },
    #[error("ocr credential missing")]
    CredentialMissing,
    #[error("ocr provider unavailable: {0}")]
    Unavailable(String),
    #[error("ocr provider error: {0}")]
    Provider(String),
    #[error("ocr provider returned no text")]
    EmptyText,
}

pub trait OcrProvider {
    fn extract_text(&self, request: &OcrRequest) -> Result<OcrOutcome, OcrError>;
}

#[derive(Clone, Debug, PartialEq)]
pub struct OcrHttpRequest {
    pub url: String,
    pub headers: BTreeMap<String, String>,
    pub body: Value,
}

#[derive(Clone, Debug, PartialEq)]
pub struct OcrHttpResponse {
    pub status: u16,
    pub body: Value,
}

pub trait OcrTransport {
    fn post_json(&self, request: &OcrHttpRequest) -> Result<OcrHttpResponse, OcrError>;
}

pub struct OpenAiCompatibleOcrProvider<T: OcrTransport> {
    transport: T,
    base_url: String,
    api_key: Option<String>,
    default_model: String,
}

impl<T: OcrTransport> OpenAiCompatibleOcrProvider<T> {
    pub fn new(transport: T, base_url: impl Into<String>, api_key: Option<String>) -> Self {
        Self {
            transport,
            base_url: base_url.into().trim_end_matches('/').to_string(),
            api_key,
            default_model: DEFAULT_OPENAI_OCR_MODEL.to_string(),
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
            base_url: base_url.into().trim_end_matches('/').to_string(),
            api_key,
            default_model: default_model.into(),
        }
    }

    pub fn build_http_request(&self, request: &OcrRequest) -> Result<OcrHttpRequest, OcrError> {
        validate_ocr_image(&request.image)?;
        let max_output_chars =
            validate_output_limit(request.max_output_chars.unwrap_or(DEFAULT_MAX_OUTPUT_CHARS))?;
        let api_key = self
            .api_key
            .as_deref()
            .filter(|s| !s.trim().is_empty())
            .ok_or(OcrError::CredentialMissing)?;
        let model = request.model.as_deref().unwrap_or(&self.default_model);
        let prompt = request.prompt.as_deref().unwrap_or(DEFAULT_OCR_PROMPT);
        let data_url = format!(
            "data:{};base64,{}",
            request.format.mime_type(),
            encode_base64(&request.image)
        );

        let mut headers = BTreeMap::new();
        headers.insert("Content-Type".to_string(), "application/json".to_string());
        headers.insert("Authorization".to_string(), format!("Bearer {api_key}"));
        Ok(OcrHttpRequest {
            url: format!("{}/v1/responses", self.base_url),
            headers,
            body: json!({
                "model": model,
                "max_output_tokens": max_output_chars,
                "input": [{
                    "role": "user",
                    "content": [
                        { "type": "input_text", "text": prompt },
                        { "type": "input_image", "image_url": data_url }
                    ]
                }]
            }),
        })
    }
}

impl<T: OcrTransport> OcrProvider for OpenAiCompatibleOcrProvider<T> {
    fn extract_text(&self, request: &OcrRequest) -> Result<OcrOutcome, OcrError> {
        let model = request
            .model
            .as_deref()
            .unwrap_or(&self.default_model)
            .to_string();
        let http = self.build_http_request(request)?;
        let response = self.transport.post_json(&http)?;
        if !(200..=299).contains(&response.status) {
            return Err(OcrError::Provider(format!(
                "http status {}",
                response.status
            )));
        }
        let text = extract_text_from_provider_response(&response.body)?;
        Ok(OcrOutcome { text, model })
    }
}

#[derive(Default)]
pub struct UnavailableOcrProvider;

impl OcrProvider for UnavailableOcrProvider {
    fn extract_text(&self, _request: &OcrRequest) -> Result<OcrOutcome, OcrError> {
        Err(OcrError::Unavailable(
            "ocr provider is not wired; capability remains DARK".to_string(),
        ))
    }
}

pub struct StubOcrProvider {
    pub text: String,
    pub model: String,
}

impl Default for StubOcrProvider {
    fn default() -> Self {
        Self {
            text: "STUB-OCR: extracted text".to_string(),
            model: "stub-ocr-1".to_string(),
        }
    }
}

impl OcrProvider for StubOcrProvider {
    fn extract_text(&self, request: &OcrRequest) -> Result<OcrOutcome, OcrError> {
        validate_ocr_image(&request.image)?;
        validate_output_limit(request.max_output_chars.unwrap_or(DEFAULT_MAX_OUTPUT_CHARS))?;
        Ok(OcrOutcome {
            text: self.text.clone(),
            model: request.model.clone().unwrap_or_else(|| self.model.clone()),
        })
    }
}

pub fn validate_ocr_image(image: &[u8]) -> Result<(), OcrError> {
    if image.is_empty() {
        return Err(OcrError::EmptyImage);
    }
    if image.len() > DEFAULT_MAX_IMAGE_BYTES {
        return Err(OcrError::ImageTooLarge {
            got: image.len(),
            max: DEFAULT_MAX_IMAGE_BYTES,
        });
    }
    Ok(())
}

pub fn validate_output_limit(max_output_chars: usize) -> Result<usize, OcrError> {
    if max_output_chars == 0 || max_output_chars > MAX_ALLOWED_OUTPUT_CHARS {
        return Err(OcrError::InvalidOutputLimit {
            got: max_output_chars,
            max: MAX_ALLOWED_OUTPUT_CHARS,
        });
    }
    Ok(max_output_chars)
}

fn extract_text_from_provider_response(body: &Value) -> Result<String, OcrError> {
    let text = body
        .get("output_text")
        .and_then(Value::as_str)
        .or_else(|| {
            body.pointer("/choices/0/message/content")
                .and_then(Value::as_str)
        })
        .map(str::trim)
        .filter(|text| !text.is_empty())
        .ok_or(OcrError::EmptyText)?;
    Ok(text.to_string())
}

fn encode_base64(bytes: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    let mut chunks = bytes.chunks_exact(3);
    for chunk in &mut chunks {
        let n = ((chunk[0] as u32) << 16) | ((chunk[1] as u32) << 8) | chunk[2] as u32;
        out.push(TABLE[((n >> 18) & 0x3f) as usize] as char);
        out.push(TABLE[((n >> 12) & 0x3f) as usize] as char);
        out.push(TABLE[((n >> 6) & 0x3f) as usize] as char);
        out.push(TABLE[(n & 0x3f) as usize] as char);
    }
    let rem = chunks.remainder();
    if !rem.is_empty() {
        let b0 = rem[0] as u32;
        let b1 = rem.get(1).copied().unwrap_or(0) as u32;
        let n = (b0 << 16) | (b1 << 8);
        out.push(TABLE[((n >> 18) & 0x3f) as usize] as char);
        out.push(TABLE[((n >> 12) & 0x3f) as usize] as char);
        if rem.len() == 2 {
            out.push(TABLE[((n >> 6) & 0x3f) as usize] as char);
            out.push('=');
        } else {
            out.push('=');
            out.push('=');
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;

    struct MockTransport {
        last_request: RefCell<Option<OcrHttpRequest>>,
        response: OcrHttpResponse,
    }

    impl MockTransport {
        fn new(response: OcrHttpResponse) -> Self {
            Self {
                last_request: RefCell::new(None),
                response,
            }
        }
    }

    impl OcrTransport for MockTransport {
        fn post_json(&self, request: &OcrHttpRequest) -> Result<OcrHttpResponse, OcrError> {
            *self.last_request.borrow_mut() = Some(request.clone());
            Ok(self.response.clone())
        }
    }

    fn sample_request() -> OcrRequest {
        OcrRequest {
            image: b"png".to_vec(),
            format: OcrImageFormat::Png,
            prompt: None,
            model: None,
            max_output_chars: None,
        }
    }

    #[test]
    fn openai_provider_builds_vision_request_shape() {
        let transport = MockTransport::new(OcrHttpResponse {
            status: 200,
            body: json!({ "output_text": "invoice 42" }),
        });
        let provider = OpenAiCompatibleOcrProvider::new(
            transport,
            "https://api.openai.example/",
            Some("k".into()),
        );
        let out = provider.extract_text(&sample_request()).unwrap();
        assert_eq!(out.text, "invoice 42");
        assert_eq!(out.model, DEFAULT_OPENAI_OCR_MODEL);

        let sent = provider.transport.last_request.borrow().clone().unwrap();
        assert_eq!(sent.url, "https://api.openai.example/v1/responses");
        assert_eq!(
            sent.headers.get("Authorization").map(String::as_str),
            Some("Bearer k")
        );
        assert_eq!(sent.body["model"], DEFAULT_OPENAI_OCR_MODEL);
        assert_eq!(sent.body["max_output_tokens"], DEFAULT_MAX_OUTPUT_CHARS);
        assert_eq!(
            sent.body["input"][0]["content"][0]["text"],
            DEFAULT_OCR_PROMPT
        );
        assert_eq!(
            sent.body["input"][0]["content"][1]["image_url"],
            "data:image/png;base64,cG5n"
        );
    }

    #[test]
    fn openai_provider_honors_overrides_and_chat_completion_shape() {
        let transport = MockTransport::new(OcrHttpResponse {
            status: 200,
            body: json!({ "choices": [{ "message": { "content": "  total: $12  " } }] }),
        });
        let provider = OpenAiCompatibleOcrProvider::with_default_model(
            transport,
            "https://vision.example",
            Some("k".into()),
            "default-vision",
        );
        let req = OcrRequest {
            image: b"jpg".to_vec(),
            format: OcrImageFormat::Jpeg,
            prompt: Some("read receipt".to_string()),
            model: Some("gpt-4o".to_string()),
            max_output_chars: Some(128),
        };
        let out = provider.extract_text(&req).unwrap();
        assert_eq!(out.text, "total: $12");
        assert_eq!(out.model, "gpt-4o");

        let sent = provider.transport.last_request.borrow().clone().unwrap();
        assert_eq!(sent.body["model"], "gpt-4o");
        assert_eq!(sent.body["max_output_tokens"], 128);
        assert_eq!(sent.body["input"][0]["content"][0]["text"], "read receipt");
        assert_eq!(
            sent.body["input"][0]["content"][1]["image_url"],
            "data:image/jpeg;base64,anBn"
        );
    }

    #[test]
    fn credential_missing_fails_closed_before_transport_call() {
        let transport = MockTransport::new(OcrHttpResponse {
            status: 200,
            body: json!({ "output_text": "text" }),
        });
        let provider = OpenAiCompatibleOcrProvider::new(transport, "https://vision.example", None);
        assert!(matches!(
            provider.extract_text(&sample_request()).unwrap_err(),
            OcrError::CredentialMissing
        ));
        assert!(provider.transport.last_request.borrow().is_none());
    }

    #[test]
    fn validation_and_provider_errors_fail_closed() {
        assert!(matches!(validate_ocr_image(&[]), Err(OcrError::EmptyImage)));
        assert!(matches!(
            validate_ocr_image(&vec![0; DEFAULT_MAX_IMAGE_BYTES + 1]),
            Err(OcrError::ImageTooLarge { .. })
        ));
        assert!(matches!(
            validate_output_limit(0),
            Err(OcrError::InvalidOutputLimit { .. })
        ));
        assert!(matches!(
            validate_output_limit(MAX_ALLOWED_OUTPUT_CHARS + 1),
            Err(OcrError::InvalidOutputLimit { .. })
        ));

        let http_500 = MockTransport::new(OcrHttpResponse {
            status: 500,
            body: json!({ "error": "nope" }),
        });
        let provider =
            OpenAiCompatibleOcrProvider::new(http_500, "https://vision.example", Some("k".into()));
        assert!(matches!(
            provider.extract_text(&sample_request()).unwrap_err(),
            OcrError::Provider(_)
        ));

        let empty = MockTransport::new(OcrHttpResponse {
            status: 200,
            body: json!({ "output_text": "   " }),
        });
        let provider =
            OpenAiCompatibleOcrProvider::new(empty, "https://vision.example", Some("k".into()));
        assert!(matches!(
            provider.extract_text(&sample_request()).unwrap_err(),
            OcrError::EmptyText
        ));
    }

    #[test]
    fn unavailable_provider_is_the_default_fail_closed_dark_posture() {
        let err = UnavailableOcrProvider
            .extract_text(&sample_request())
            .unwrap_err();
        assert!(matches!(err, OcrError::Unavailable(_)));
    }

    #[test]
    fn stub_provider_is_deterministic_and_offline() {
        let stub = StubOcrProvider::default();
        let mut req = sample_request();
        req.model = Some("stub-override".to_string());
        let out = stub.extract_text(&req).unwrap();
        assert_eq!(out.text, "STUB-OCR: extracted text");
        assert_eq!(out.model, "stub-override");
    }

    #[test]
    fn base64_encoder_handles_padding() {
        assert_eq!(encode_base64(b""), "");
        assert_eq!(encode_base64(b"f"), "Zg==");
        assert_eq!(encode_base64(b"fo"), "Zm8=");
        assert_eq!(encode_base64(b"foo"), "Zm9v");
    }
}
